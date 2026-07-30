/**
 * src/providers/types.ts — 統一 Provider 介面
 * 修訂(P0-3/P0-4):volume 缺值為 null 不補 0;存證分 raw 與 normalized 兩層。
 */
export type DelayClass = "realtime" | "delayed" | "eod" | "filing";
export type SnapshotQuality = "real" | "incomplete" | "stale" | "invalid";

export interface ProviderSnapshot<T> {
  provider: string;
  datasetId: string;
  symbolsRequested?: string[];
  asOf: string | null;     // 無任何真實資料時為 null,絕不以抓取時間冒充
  fetchedAt: string;
  timezone: string;
  delayClass: DelayClass;
  quality: SnapshotQuality;
  paginationComplete: boolean;
  /** 預期的最近已完成交易日(ET, YYYY-MM-DD);逐檔比對過期 */
  expectedSessionDate?: string | null;
  /** 原始供應商 payload 的存證(逐字,未經轉換) */
  rawProvenanceHash: string;
  /** 正規化後資料的 hash(供 decisionVersion / 去重使用) */
  normalizedHash: string;
  licenseContext: string;   // "supplier/dataset" — 授權推導的唯一依據
  /** Ingestion 存證 ID(由 gateway 計算寫入);無 writer 時為 null,無法密封發布 */
  provenanceId: string | null;
  /** 彙整視圖(如快取)由多個批次組成時,列出全部貢獻批次的存證 ID */
  provenanceIds?: string[];
  data: T | null;
  notes?: string[];
}

export interface Quote {
  symbol: string;
  /** 此檔報價本身的資料時間(bar 時間),用於逐檔新鮮度檢查 */
  asOf: string;
  last: number;
  /** 前收盤 → 最新收盤;取不到前收盤時為 null,不以盤中口徑冒充 */
  changePct: number | null;
  prevClose: number | null;
  /** 缺值為 null,絕不補 0(P0-3) */
  volume: number | null;
  rsi14?: number | null;
  macdHist?: number | null;
}

export interface QuoteProvider {
  id: string;
  getQuotes(symbols: string[]): Promise<ProviderSnapshot<Quote[]>>;
}

export function unavailableSnapshot<T>(provider: string, datasetId: string,
  licenseContext: string, reason: string): ProviderSnapshot<T> {
  const now = new Date().toISOString();
  return { provider, datasetId, asOf: null, fetchedAt: now, timezone: "UTC",
    delayClass: "delayed", quality: "invalid", paginationComplete: false,
    rawProvenanceHash: "", normalizedHash: "", licenseContext, provenanceId: null, data: null, notes: [reason] };
}
