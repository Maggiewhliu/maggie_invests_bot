/**
 * 測試/Dry-Run 專用行情(fixture)。無授權 grant → 管線擋外發。
 */
import { createHash } from "node:crypto";
import type { Quote, QuoteProvider, ProviderSnapshot } from "./types.ts";
import type { ProvenanceWriter } from "../pipeline/artifactSeal.ts";

const F = (symbol: string, last: number, prevClose: number, volume: number,
  rsi14: number, macdHist: number): Quote => ({
  symbol, asOf: "2026-07-24T20:00:00Z", last, prevClose, volume, rsi14, macdHist,
  changePct: Math.round(((last - prevClose) / prevClose) * 10_000) / 100,
});
const FIXTURE: Record<string, Quote> = {
  AAPL:  F("AAPL", 231.40, 229.97, 41_200_000, 54.2, 0.31),
  MSFT:  F("MSFT", 512.80, 514.91, 18_900_000, 48.7, -0.12),
  NVDA:  F("NVDA", 184.20, 181.94, 212_000_000, 61.3, 0.88),
  GOOGL: F("GOOGL",248.10, 247.65, 22_400_000, 52.0, 0.05),
  AMZN:  F("AMZN", 225.60, 227.35, 35_100_000, 45.9, -0.24),
  META:  F("META", 731.90, 724.44, 14_800_000, 58.4, 0.47),
  TSLA:  F("TSLA", 438.70, 451.61, 98_300_000, 71.8, -0.63),
};

export class MockQuoteProvider implements QuoteProvider {
  id = "mock-fixture";
  private writer: ProvenanceWriter | null;
  constructor(writer: ProvenanceWriter | null = null) { this.writer = writer; }
  async getQuotes(symbols: string[]): Promise<ProviderSnapshot<Quote[]>> {
    const rows = symbols.map(s => FIXTURE[s]).filter(Boolean) as Quote[];
    const now = new Date().toISOString();
    const raw = JSON.stringify(symbols.map(s => ({ s, fixture: FIXTURE[s] ?? null })));
    return {
      provider: this.id, datasetId: "equity_daily_close", symbolsRequested: symbols,
      asOf: "2026-07-24T20:00:00Z", fetchedAt: now, timezone: "America/New_York",
      delayClass: "eod",
      quality: rows.length === symbols.length ? "real" : "incomplete",
      paginationComplete: true, expectedSessionDate: "2026-07-24",
      rawProvenanceHash: createHash("sha256").update(raw).digest("hex"),
      normalizedHash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      licenseContext: "mock-fixture/equity_daily_close",
      provenanceId: this.writer && rows.length
        ? this.writer.ingest({ supplier: this.id, dataset: "equity_daily_close",
            rawPayload: raw, normalizedData: rows })
        : null,
      data: rows.length ? rows : null,
      notes: rows.length === symbols.length ? [] : ["some symbols missing from fixture"],
    };
  }
}
