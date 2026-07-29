/**
 * src/providers/massiveQuoteProvider.ts — 真實行情 adapter v2
 * 修訂:
 *  P0-1 改用兩日收盤重算 changePct(前收盤→最新收盤);單根 bar → changePct null
 *  P0-3 volume 缺值 → null 並降級 incomplete
 *  P0-4 rawProvenanceHash(原始 payload 逐字)與 normalizedHash 分離
 *  P1   API key 走 Authorization: Bearer header,不進 URL/logs
 */
import { createHash } from "node:crypto";
import type { Quote, QuoteProvider, ProviderSnapshot } from "./types.ts";
import { lastCompletedSessionDate } from "../marketClock.ts";
import type { ProvenanceWriter } from "../pipeline/artifactSeal.ts";

export const MASSIVE_API_BASE = "https://api.massive.com";

export type HttpGet = (url: string, headers?: Record<string, string>)
  => Promise<{ status: number; text: () => Promise<string> }>;

const dstr = (d: Date) => d.toISOString().slice(0, 10);

export class MassiveQuoteProvider implements QuoteProvider {
  id = "massive";
  private key: string; private http: HttpGet; private base: string; private clock: () => Date;
  private writer: ProvenanceWriter | null;
  constructor(apiKey: string, http?: HttpGet, base = MASSIVE_API_BASE,
    clock: () => Date = () => new Date(), writer: ProvenanceWriter | null = null) {
    this.writer = writer;
    if (!apiKey) throw new Error("MASSIVE_API_KEY missing");
    this.key = apiKey; this.base = base; this.clock = clock;
    this.http = http ?? (async (u, h) => {
      const r = await fetch(u, { headers: h });
      return { status: r.status, text: () => r.text() };
    });
  }
  async getQuotes(symbols: string[]): Promise<ProviderSnapshot<Quote[]>> {
    const fetchedAt = new Date().toISOString();
    const now = this.clock();
    const from = dstr(new Date(now.getTime() - 14 * 86_400_000));
    const to = dstr(now);
    const rows: Quote[] = []; const notes: string[] = [];
    const rawPieces: string[] = [];
    let asOf = ""; let anyRateLimited = false; let anyFieldMissing = false;
    const expected = lastCompletedSessionDate(now);
    const etDateOf = (ms: number) => new Intl.DateTimeFormat("en-CA",
      { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(ms));
    const staleSymbols: string[] = [];

    for (const sym of symbols) {
      try {
        const url = `${this.base}/v2/aggs/ticker/${encodeURIComponent(sym)}`
          + `/range/1/day/${from}/${to}?adjusted=true&sort=desc&limit=2`;
        const r = await this.http(url, { Authorization: `Bearer ${this.key}` });
        if (r.status === 429) { anyRateLimited = true; notes.push(`${sym}: rate limited`); continue; }
        const rawText = await r.text();
        if (r.status !== 200) { notes.push(`${sym}: http ${r.status}`); continue; }
        rawPieces.push(`${sym}:${rawText}`);            // P0-4 原始逐字存證
        let body: any; try { body = JSON.parse(rawText); } catch { notes.push(`${sym}: bad json`); continue; }
        const bars = body?.results;
        const b0 = bars?.[0];
        if (!b0 || !Number.isFinite(b0.c) || b0.c <= 0) { notes.push(`${sym}: malformed payload`); continue; }
        // P0-2:無市場時間戳的列直接拒收,不得以抓取時間冒充資料時間
        if (!Number.isFinite(b0.t)) { notes.push(`${sym}: missing bar timestamp, row rejected`); continue; }
        const b1 = bars?.[1];
        const prevClose = b1 && Number.isFinite(b1.c) && b1.c > 0 ? b1.c : null;
        if (prevClose === null) { notes.push(`${sym}: prior close unavailable, changePct=null`); anyFieldMissing = true; }
        const volume = Number.isFinite(b0.v) ? b0.v : null;   // P0-3
        if (volume === null) { notes.push(`${sym}: volume missing`); anyFieldMissing = true; }
        const barIsoQ = new Date(b0.t).toISOString();
        if (expected && etDateOf(b0.t) < expected) {
          staleSymbols.push(sym);
          notes.push(`${sym}: stale (bar ${etDateOf(b0.t)} < expected session ${expected})`);
        }
        rows.push({ symbol: sym, asOf: barIsoQ, last: b0.c,
          changePct: prevClose === null ? null
            : Math.round(((b0.c - prevClose) / prevClose) * 10_000) / 100,
          prevClose, volume, rsi14: null, macdHist: null });
        const iso = Number.isFinite(b0.t) ? new Date(b0.t).toISOString() : "";
        if (iso > asOf) asOf = iso;
      } catch (e) { notes.push(`${sym}: ${String(e).slice(0, 60)}`); }
    }

    const quality = rows.length === 0 ? "invalid"
      : staleSymbols.length > 0 ? "stale"
      : (rows.length < symbols.length || anyFieldMissing) ? "incomplete" : "real";
    return {
      provider: this.id, datasetId: "equity_daily_close", symbolsRequested: symbols,
      asOf: rows.length ? asOf : null, fetchedAt, timezone: "America/New_York", delayClass: "eod",
      quality, paginationComplete: !anyRateLimited, expectedSessionDate: expected,
      rawProvenanceHash: createHash("sha256").update(rawPieces.join("\n")).digest("hex"),
      normalizedHash: createHash("sha256").update(JSON.stringify(rows) + asOf).digest("hex"),
      licenseContext: "massive/equity_daily_close",
      provenanceId: this.writer && rows.length
        ? this.writer.ingest({ supplier: this.id, dataset: "equity_daily_close",
            rawPayload: rawPieces.join("\n"), normalizedData: rows })
        : null,
      data: rows.length ? rows : null, notes,
    };
  }
}
