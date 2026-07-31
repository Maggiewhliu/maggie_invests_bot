/**
 * src/pipeline/quoteCache.ts — 背景行情快取(解免費方案限流的正解)
 *
 * 問題:Massive 免費方案每分鐘 5 請求;/markets 需要 11 檔,現場連打必被限流。
 * 解法:背景排程每個 tick 抓「一批 ≤5 檔」輪替補滿,/markets 直接讀快取,
 *       永不現場打上游。EOD 資料一天一更,慢慢補完全夠。
 *
 * 紀律(全部沿用封板規範):
 *  - 上游 provider 照常經 ingestion gateway 存證;快取彙整視圖記錄
 *    全部貢獻批次的 provenanceId(真實存證,不合成假 raw)
 *  - 快取未滿 → incomplete 並列缺少檔;絕不補值
 *  - 逐檔 asOf 保留;有過期檔 → stale
 *  - licenseContext 原封傳遞(授權判斷不因快取而改變)
 */
import { createHash } from "node:crypto";
import type { Quote, QuoteProvider, ProviderSnapshot, DelayClass } from "../providers/types.ts";
import { lastCompletedSessionDate } from "../marketClock.ts";

interface Entry {
  quote: Quote;
  fetchedAt: string;
  provenanceId: string | null;
  expectedSessionDate: string | null;
  delayClass: DelayClass;
  licenseContext: string;
}

export interface TickResult {
  batch: string[]; got: number; quality: string; notes: string[];
}

export class QuoteCache implements QuoteProvider {
  id = "quote-cache";
  private upstream: QuoteProvider;
  private symbols: string[];
  private batchSize: number;
  private entries = new Map<string, Entry>();
  private batchIdx = 0;

  constructor(upstream: QuoteProvider, symbols: string[], batchSize = 5) {
    if (batchSize < 1) throw new Error("batchSize >= 1");
    this.upstream = upstream; this.symbols = [...symbols]; this.batchSize = batchSize;
  }

  /** 批次規劃(輪替):每 tick 只碰一批,尊重上游限流 */
  batches(): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < this.symbols.length; i += this.batchSize)
      out.push(this.symbols.slice(i, i + this.batchSize));
    return out;
  }

  /** 同一交易日檢查:EOD 資料一天一更;批內全部檔的 bar 已達最近完成時段 → 本 tick 跳過 */
  private batchFresh(batch: string[], now: Date): boolean {
    const expected = lastCompletedSessionDate(now);
    if (!expected) return false;
    return batch.every(s => {
      const e = this.entries.get(s);
      return !!e && e.quote.asOf.slice(0, 10) >= expected;
    });
  }

  /** 宿主排程每 65 秒呼叫一次;抓下一批並更新快取(已新鮮批次跳過) */
  async refreshTick(now: Date = new Date()): Promise<TickResult> {
    const bs = this.batches();
    const batch = bs[this.batchIdx % bs.length];
    this.batchIdx++;
    if (this.batchFresh(batch, now)) {
      return { batch, got: 0, quality: "fresh_skip", notes: ["batch already at expected session, skipped"] };
    }
    const snap = await this.upstream.getQuotes(batch);
    const notes = [...(snap.notes ?? [])];
    if (snap.data) {
      for (const q of snap.data) {
        this.entries.set(q.symbol, {
          quote: q, fetchedAt: snap.fetchedAt, provenanceId: snap.provenanceId ?? null,
          expectedSessionDate: snap.expectedSessionDate ?? null,
          delayClass: snap.delayClass, licenseContext: snap.licenseContext,
        });
      }
    }
    return { batch, got: snap.data?.length ?? 0, quality: snap.quality, notes };
  }

  /** /markets 讀這裡:純記憶體,零上游請求 */
  async getQuotes(requested: string[]): Promise<ProviderSnapshot<Quote[]>> {
    const now = new Date().toISOString();
    const hits = requested.map(s => this.entries.get(s)).filter(Boolean) as Entry[];
    const rows = hits.map(e => e.quote);
    const missing = requested.filter(s => !this.entries.has(s));
    const notes: string[] = missing.length ? [`cache missing: ${missing.join(", ")}`] : [];

    const expected = hits.map(e => e.expectedSessionDate).filter(Boolean).sort().at(-1) ?? null;
    const staleSyms = expected
      ? rows.filter(q => q.asOf.slice(0, 10) < expected).map(q => q.symbol) : [];
    for (const s of staleSyms) notes.push(`${s}: stale (cached bar < expected session ${expected})`);

    const quality = rows.length === 0 ? "invalid"
      : missing.length ? "incomplete"
      : staleSyms.length ? "stale" : "real";
    const asOfMax = rows.map(q => q.asOf).sort().at(-1) ?? null;
    const provenanceIds = [...new Set(hits.map(e => e.provenanceId).filter(Boolean))] as string[];
    const licenseContext = hits[0]?.licenseContext ?? "massive/equity_daily_close";

    return {
      provider: this.id, datasetId: "equity_daily_close", symbolsRequested: requested,
      asOf: asOfMax, fetchedAt: now, timezone: "America/New_York",
      delayClass: hits[0]?.delayClass ?? "eod",
      quality, paginationComplete: missing.length === 0,
      expectedSessionDate: expected,
      rawProvenanceHash: createHash("sha256")
        .update(provenanceIds.sort().join("|")).digest("hex"),      // 指向真實批次存證的彙整指紋
      normalizedHash: createHash("sha256")
        .update(JSON.stringify(rows) + (asOfMax ?? "")).digest("hex"),
      licenseContext,
      provenanceId: provenanceIds.length === 1 ? provenanceIds[0] : null,
      provenanceIds,                                                 // 多批次:全部列出供密封
      data: rows.length ? rows : null, notes,
    };
  }
}

/** 簡易宿主排程(Railway worker 用);65s > 60s 視窗,保證不貼線觸發限流 */
export function startQuoteCacheLoop(cache: QuoteCache, intervalMs = 65_000): () => void {
  const timer = setInterval(() => { cache.refreshTick().catch(() => {}); }, intervalMs);
  cache.refreshTick().catch(() => {});
  return () => clearInterval(timer);
}
