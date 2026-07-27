/**
 * src/reports/marketReport.ts — 市場狀態報告(繁中 / 英文)
 * 一份核心判讀 → 多語輸出。措辭只描述狀態與觀察條件,不含動作指示。
 * 資料不可用時明確標示,不以 placeholder 補畫面。
 */
import type { ProviderSnapshot, Quote } from "../providers/types.ts";
import { getMarketStatus } from "../marketClock.ts";
import { createHash } from "node:crypto";
import { DISCLAIMER } from "../contentRiskGuard.ts";

export type Lang = "zh-TW" | "en";

export interface MarketReport {
  text: string; contentHash: string; decisionVersion: string;
  dataQuality: "real" | "incomplete" | "stale" | "invalid"; asOf: string;
}

const T = {
  "zh-TW": {
    title: "美股市場狀態", session: { premarket:"延長時段(盤前)", regular:"盤中",
      afterhours:"延長時段(盤後)", closed:"休市", unknown:"日曆未涵蓋" },
    holiday:"休市", halfDay:"(半日)", ranking:"七巨頭表現", weak:"相對弱勢",
    tech:"技術面觀察", rsiHigh:"RSI 偏高", rsiLow:"RSI 偏低", volSpike:"成交量放大",
    watch:"接下來觀察什麼", invalid:"什麼情況代表判讀失效",
    w1:"量能是否連續,而非單日異常。", w2:"是否有事件改變原有觀察前提。",
    i1:"價格結構回到原區間,或出現足以改變前提的新資訊。",
    unavailable:"⚠️ 行情資料目前不可用,本節不顯示數值。",
    missing:"⚠️ 本次缺少", nochange:"—", dataRange:"資料時間", staleLabel:"⚠️ 資料過期",
    sessionNote:"盤前/盤後為美股延長交易時段之泛稱;核心交易時段 09:30–16:00 ET 為三大交易所一致。",
    footer:"資料截至", note:DISCLAIMER["zh-TW"],
  },
  en: {
    title: "US Market State", session: { premarket:"Extended hours (pre-market)", regular:"Regular session",
      afterhours:"Extended hours (post-market)", closed:"Closed", unknown:"Calendar not covered" },
    holiday:"Market holiday", halfDay:"(half day)", ranking:"Magnificent 7", weak:"Relative laggards",
    tech:"Technical observations", rsiHigh:"RSI elevated", rsiLow:"RSI depressed", volSpike:"Volume expansion",
    watch:"What to watch next", invalid:"What would invalidate this",
    w1:"Whether volume holds across sessions rather than spiking once.",
    w2:"Whether any event changes the premise of this observation.",
    i1:"Price reclaiming its prior range, or new information that changes the premise.",
    unavailable:"⚠️ Quote data unavailable; this section shows no values.",
    missing:"⚠️ Missing this run", nochange:"—", dataRange:"Data span", staleLabel:"⚠️ Stale data",
    sessionNote:"Pre-/post-market refers to consolidated US extended trading hours; the core session 09:30\u201316:00 ET is identical across the three exchanges.",
    footer:"Data as of", note:DISCLAIMER.en,
  },
} as const;

export function buildMarketReport(snap: ProviderSnapshot<Quote[]>, lang: Lang,
  now: Date = new Date(), engineVersion = "0.1.0-rc.1"): MarketReport {
  const t = T[lang]; const st = getMarketStatus(now);
  const lines: string[] = [];

  const sessionLabel = t.session[st.state];
  lines.push(`📊 ${t.title} — ${sessionLabel}${st.isHalfDay ? " " + t.halfDay : ""}`);
  if (st.holidayName) lines.push(`   ${t.holiday}: ${st.holidayName}`);
  lines.push(`   NYSE · Nasdaq · NYSE American | ${st.etDate} ${st.etTime} ET`);
  lines.push("");

  if (!snap.data || snap.quality === "invalid") {
    lines.push(t.unavailable);
  } else {
    const rows = [...snap.data].sort((a,b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
    lines.push(`${t.ranking}`);
    for (const q of rows) {
      const pct = q.changePct;
      const arrow = pct == null ? "·" : pct >= 0 ? "▲" : "▼";
      const pctStr = pct == null ? t.nochange : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
      lines.push(`  ${arrow} ${q.symbol.padEnd(6)} ${q.last.toFixed(2).padStart(8)}  ${pctStr}`);
    }
    // Fix2:資料時間範圍與過期 symbols
    const dates = [...new Set(rows.map(q => q.asOf.slice(0, 10)))].sort();
    if (dates.length > 1) lines.push("", `${t.dataRange}: ${dates[0]} ~ ${dates[dates.length - 1]}`);
    if (snap.expectedSessionDate) {
      const stale = rows.filter(q => q.asOf.slice(0, 10) < snap.expectedSessionDate!).map(q => q.symbol);
      if (stale.length) lines.push("", `${t.staleLabel}: ${stale.join(", ")} (< ${snap.expectedSessionDate})`);
    }
    // P1:incomplete 時明列缺少的 symbols
    if (snap.symbolsRequested) {
      const got = new Set(rows.map(r => r.symbol));
      const miss = snap.symbolsRequested.filter(s => !got.has(s));
      if (miss.length) { lines.push(""); lines.push(`${t.missing}: ${miss.join(", ")}`); }
    }
    const notes: string[] = [];
    for (const q of rows) {
      if (q.rsi14 != null && q.rsi14 >= 70) notes.push(`${q.symbol}: ${t.rsiHigh} (${q.rsi14.toFixed(1)})`);
      if (q.rsi14 != null && q.rsi14 <= 30) notes.push(`${q.symbol}: ${t.rsiLow} (${q.rsi14.toFixed(1)})`);
    }
    if (notes.length) { lines.push(""); lines.push(t.tech); for (const n of notes) lines.push(`  • ${n}`); }
  }

  lines.push("", t.watch, `  • ${t.w1}`, `  • ${t.w2}`);
  lines.push("", t.invalid, `  • ${t.i1}`);
  lines.push("", `${t.footer}: ${snap.asOf ?? "—"} | ${snap.provider} | v${engineVersion}`);
  lines.push(t.sessionNote);
  lines.push(t.note);

  const text = lines.join("\n");
  // decisionVersion 綁「內容決定因子」:市場日 + 節點狀態 + 資料存證
  const decisionVersion = `${st.etDate}.${st.state}.${snap.normalizedHash.slice(0,8) || "na"}`;
  return { text, contentHash: createHash("sha256").update(text).digest("hex"),
    decisionVersion, dataQuality: snap.quality, asOf: snap.asOf ?? "" };
}
