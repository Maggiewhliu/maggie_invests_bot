/**
 * src/providers/edgarEventAdapter.ts — SEC EDGAR 事件 adapter(Form 4 / 8-K / 13D/G)
 *
 * 原則(沿用封板核心的全部紀律):
 *  - 資料源:SEC EDGAR 官方 API(免費、無授權疑慮;仍須遵守 SEC 存取規範)
 *  - SEC 規範:User-Agent 必須含聯絡方式;速率 ≤ 10 req/s(本 adapter 保守限 5)
 *  - filing date(申報日)與 event date(事件日)嚴格分離,永不混用
 *  - accession number 為唯一鍵,重複申報/修正申報(/A)去重且標示
 *  - 缺欄位 → 該筆拒收並記 notes;絕不補值
 *  - 經 ProvenanceWriter 存證;licenseContext = "sec_edgar/<dataset>"
 */
import { createHash } from "node:crypto";
import type { ProviderSnapshot } from "./types.ts";
import type { ProvenanceWriter } from "../pipeline/artifactSeal.ts";

/** 內部統一類型(正規化後) */
export type EdgarFormType = "4" | "4/A" | "8-K" | "8-K/A" | "13D" | "13D/A" | "13G" | "13G/A";

/**
 * P0-1:SEC 2024-12 起 Schedule 13D/G 改結構化申報,form type 為
 * "SCHEDULE 13D" / "SCHEDULE 13G"(含 /A);legacy "SC 13D/G" 仍存在於歷史申報。
 * 兩制並收,正規化為內部統一類型;無法辨識者回 null(不猜)。
 */
export function normalizeForm(raw: string): EdgarFormType | null {
  const f = raw.trim().toUpperCase();
  switch (f) {
    case "4": return "4";
    case "4/A": return "4/A";
    case "8-K": return "8-K";
    case "8-K/A": return "8-K/A";
    case "SC 13D": case "SCHEDULE 13D": return "13D";
    case "SC 13D/A": case "SCHEDULE 13D/A": return "13D/A";
    case "SC 13G": case "SCHEDULE 13G": return "13G";
    case "SC 13G/A": case "SCHEDULE 13G/A": return "13G/A";
    default: return null;
  }
}

export interface EdgarEvent {
  accessionNumber: string;      // 唯一鍵 e.g. "0001234567-26-000123"
  formType: EdgarFormType;      // 正規化後的內部類型
  rawFormType: string;          // SEC 原始 form 字串(追溯用)
  cik: string;                  // 10 位零填充
  ticker: string | null;        // 由 CIK↔ticker 對映;查不到為 null
  companyName: string;
  filedAt: string;              // 申報日(EDGAR 收件)
  eventDate: string | null;     // 事件日(8-K 的 items 日期 / Form 4 交易日);缺=null
  isAmendment: boolean;         // /A 修正申報
  primaryDocUrl: string;        // 原始文件連結(可追溯)
}

export type HttpGetJson = (url: string, headers: Record<string, string>)
  => Promise<{ status: number; text: () => Promise<string> }>;

/** SEC 要求的 UA;部署時以環境變數提供真實聯絡方式 */
export const buildUserAgent = (contact: string) => {
  if (!contact?.includes("@")) throw new Error("EDGAR contact email required (SEC access policy)");
  return `MaggieStockAI/1.0 (${contact})`;
};

/**
 * 保守速率:每次請求間隔 ≥ 200ms(5 req/s < SEC 上限 10)。
 * P0-2:預約制序列 queue —— 時槽在任何 await 之前「同步」預約,
 * 因此 Promise.all 併發呼叫也會被排成嚴格序列,不會瞬間齊發。
 */
export class RateLimiter {
  private nextAt = 0;
  private minIntervalMs: number;
  private sleep: (ms: number) => Promise<void>;
  constructor(minIntervalMs = 200,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms))) {
    this.minIntervalMs = minIntervalMs; this.sleep = sleep;
  }
  async wait(now: () => number = Date.now): Promise<void> {
    const t = now();
    const scheduled = Math.max(t, this.nextAt);   // 同步預約時槽
    this.nextAt = scheduled + this.minIntervalMs;
    const delay = scheduled - t;
    if (delay > 0) await this.sleep(delay);
  }
}

const CIK10 = (s: string | number) => String(s).replace(/\D/g, "").padStart(10, "0");

export class EdgarEventAdapter {
  readonly id = "sec_edgar";
  private http: HttpGetJson; private ua: string; private writer: ProvenanceWriter | null;
  private limiter: RateLimiter; private base: string;
  private tickerByCik: Map<string, string> | null = null;
  private tickerMapPromise: Promise<void> | null = null;   // P0-2: in-flight coalescing

  constructor(contactEmail: string, http?: HttpGetJson, writer: ProvenanceWriter | null = null,
    base = "https://www.sec.gov", limiter = new RateLimiter()) {
    this.ua = buildUserAgent(contactEmail);
    this.http = http ?? (async (url, headers) => {
      const r = await fetch(url, { headers });
      return { status: r.status, text: () => r.text() };
    });
    this.writer = writer; this.base = base; this.limiter = limiter;
  }

  /** CIK↔ticker 官方對映;併發呼叫共享同一個 in-flight promise,只下載一次 */
  private loadTickerMap(): Promise<void> {
    if (!this.tickerMapPromise) this.tickerMapPromise = this.fetchTickerMap();
    return this.tickerMapPromise;
  }
  private async fetchTickerMap(): Promise<void> {
    try {
      await this.limiter.wait();
      const r = await this.http(`${this.base}/files/company_tickers.json`,
        { "User-Agent": this.ua, "Accept-Encoding": "gzip, deflate" });
      if (r.status !== 200) { this.tickerByCik = new Map(); return; }
      const body = JSON.parse(await r.text());
      const m = new Map<string, string>();
      for (const k of Object.keys(body)) {
        const row = body[k];
        if (row?.cik_str != null && row?.ticker) m.set(CIK10(row.cik_str), String(row.ticker));
      }
      this.tickerByCik = m;
    } catch { this.tickerByCik = new Map(); }
  }

  /**
   * 取某公司(CIK)最近的受監控申報。
   * 資料源:data.sec.gov submissions API(recent filings)
   */
  async getRecentEvents(cik: string | number, limit = 20): Promise<ProviderSnapshot<EdgarEvent[]>> {
    const fetchedAt = new Date().toISOString();
    const cik10 = CIK10(cik);
    const notes: string[] = [];
    const events: EdgarEvent[] = [];
    let rawText = ""; let maxFiled = "";

    await this.loadTickerMap();
    try {
      await this.limiter.wait();
      const r = await this.http(`https://data.sec.gov/submissions/CIK${cik10}.json`,
        { "User-Agent": this.ua, "Accept-Encoding": "gzip, deflate" });
      if (r.status === 429) return this.snap(cik10, null, fetchedAt, "invalid", false,
        [], ["rate limited by SEC (429)"], "");
      if (r.status !== 200) return this.snap(cik10, null, fetchedAt, "invalid", true,
        [], [`http ${r.status}`], "");
      rawText = await r.text();
      const body = JSON.parse(rawText);
      const recent = body?.filings?.recent;
      const companyName = String(body?.name ?? "");
      if (!recent?.accessionNumber?.length) {
        return this.snap(cik10, companyName, fetchedAt, "invalid", true, [], ["no recent filings array"], rawText);
      }
      const n = recent.accessionNumber.length;
      const seen = new Set<string>();
      for (let i = 0; i < n && events.length < limit; i++) {
        const rawForm = String(recent.form?.[i] ?? "");
        const form = normalizeForm(rawForm);
        if (!form) continue;
        const acc = String(recent.accessionNumber?.[i] ?? "");
        const filedAt = String(recent.filingDate?.[i] ?? "");
        if (!acc || !filedAt) { notes.push(`row ${i}: missing accession/filingDate, rejected`); continue; }
        if (seen.has(acc)) { notes.push(`${acc}: duplicate accession, deduped`); continue; }
        seen.add(acc);
        // 事件日:reportDate 欄(8-K=items 日期、Form 4=最早交易日);缺=null,絕不用 filedAt 冒充
        const rd = String(recent.reportDate?.[i] ?? "");
        const primaryDoc = String(recent.primaryDocument?.[i] ?? "");
        const accPath = acc.replace(/-/g, "");
        events.push({
          accessionNumber: acc,
          formType: form,
          rawFormType: rawForm,
          cik: cik10,
          ticker: this.tickerByCik?.get(cik10) ?? null,
          companyName,
          filedAt,
          eventDate: rd || null,
          isAmendment: form.endsWith("/A"),   // 以正規化類型判定,兩制一致
          primaryDocUrl: `${this.base}/Archives/edgar/data/${Number(cik10)}/${accPath}/${primaryDoc}`,
        });
        if (filedAt > maxFiled) maxFiled = filedAt;
      }
      // 空集合語義:成功掃描但零匹配 = real + data:[](P0:不得與失敗混用 null)
      const quality = notes.some(x => x.includes("rejected")) ? "incomplete" : "real";
      return this.snap(cik10, companyName, fetchedAt, quality, true, events, notes, rawText, maxFiled || null);
    } catch (e) {
      return this.snap(cik10, null, fetchedAt, "invalid", true, [], [String(e).slice(0, 80)], rawText);
    }
  }

  private snap(cik10: string, _name: string | null, fetchedAt: string,
    quality: "real" | "incomplete" | "invalid", paginationComplete: boolean,
    events: EdgarEvent[], notes: string[], rawText: string,
    asOf: string | null = null): ProviderSnapshot<EdgarEvent[]> {
    const rawHash = rawText ? createHash("sha256").update(rawText).digest("hex") : "";
    const normHash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
    return {
      provider: this.id, datasetId: "filings_events", symbolsRequested: [cik10],
      asOf, fetchedAt, timezone: "America/New_York", delayClass: "filing",
      quality, paginationComplete, rawProvenanceHash: rawHash, normalizedHash: normHash,
      licenseContext: "sec_edgar/filings_events",
      provenanceId: this.writer && rawText && quality !== "invalid"
        ? this.writer.ingest({ supplier: this.id, dataset: "filings_events",
            rawPayload: rawText, normalizedData: events })
        : null,
      // data 語義:陣列(可為空)=成功查詢;null=失敗或資料不可用
      data: quality === "invalid" ? null : events, notes,
    };
  }
}
