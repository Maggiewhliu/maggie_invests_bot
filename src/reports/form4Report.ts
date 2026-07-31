/**
 * src/reports/form4Report.ts — Form 4 解析後的事實渲染(zh-TW / en)
 * 措辭:僅法定中性「取得(A)/處分(D)」+ 代碼官方含義;禁止任何詮釋
 * (「突然賣出」「倒貨」「看空」等 → contentRiskGuard 雙保險)。
 */
import type { Form4Parsed } from "../providers/form4Parser.ts";
import { DISCLAIMER } from "../contentRiskGuard.ts";

export type Lang = "zh-TW" | "en";
const L = {
  "zh-TW": { acq: "取得", disp: "處分", shares: "股", at: "每股", priceNA: "單價未載明",
    after: "交易後持股", dir: { D: "直接持有", I: "間接持有" }, tenb: "依 10b5-1 既定計畫",
    officer: "職務", director: "董事", tenPct: "10% 以上股東",
    holdingsOnly: "本次申報僅更新持股狀態,無交易紀錄。",
    note: "以上為 SEC Form 4 申報之逐筆事實;代碼含義依 SEC 官方定義,完整內容以原始文件為準。" },
  en: { acq: "Acquired", disp: "Disposed", shares: "sh", at: "@", priceNA: "price not stated",
    after: "Owned after", dir: { D: "direct", I: "indirect" }, tenb: "under a 10b5-1 plan",
    officer: "Title", director: "Director", tenPct: "10%+ owner",
    holdingsOnly: "This filing updates holdings only; no transactions reported.",
    note: "Per-transaction facts from a SEC Form 4 filing. Code meanings follow SEC definitions; refer to the source document." },
} as const;
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

export function renderForm4Facts(p: Form4Parsed, lang: Lang): string {
  const t = L[lang];
  const lines: string[] = [];
  const roles: string[] = [];
  if (p.isOfficer && p.officerTitle) roles.push(`${t.officer}: ${p.officerTitle}`);
  else if (p.isOfficer) roles.push(t.officer);
  if (p.isDirector) roles.push(t.director);
  if (p.isTenPercentOwner) roles.push(t.tenPct);
  const who = [p.ownerName, roles.length ? `(${roles.join(" / ")})` : ""].filter(Boolean).join(" ");
  const sym = p.issuerSymbol ? ` — ${p.issuerSymbol}` : "";
  lines.push(`👤 ${who}${sym}`);

  if (p.holdingsOnly) lines.push(`   ${t.holdingsOnly}`);
  for (const tx of p.transactions) {
    const dirWord = tx.acquiredDisposed === "A" ? t.acq : t.disp;
    const price = tx.pricePerShare !== null ? `${t.at} $${fmt(tx.pricePerShare)}` : `(${t.priceNA})`;
    const segs = [
      `${tx.transactionDate}`,
      `${tx.codeLabel[lang]} [${tx.code}]`,
      `${dirWord} ${fmt(tx.shares)} ${t.shares} ${price}`,
    ];
    if (tx.sharesOwnedAfter !== null) segs.push(`${t.after}: ${fmt(tx.sharesOwnedAfter)}`);
    if (tx.directOrIndirect) segs.push(t.dir[tx.directOrIndirect]);
    if (tx.tenB51) segs.push(t.tenb);
    lines.push(`   • ${segs.join(" | ")}`);
  }
  lines.push("", t.note, DISCLAIMER[lang === "en" ? "en" : "zh-TW"]);
  return lines.join("\n");
}
