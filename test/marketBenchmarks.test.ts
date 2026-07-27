import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketReport } from "../src/reports/marketReport.ts";
import type { ProviderSnapshot, Quote } from "../src/providers/types.ts";

const q = (symbol: string, last: number, changePct: number): Quote => ({
  symbol,
  asOf: "2026-07-24T20:00:00Z",
  last,
  changePct,
  prevClose: last / (1 + changePct / 100),
  volume: 1_000_000,
  rsi14: 50,
  macdHist: 0,
});

const snapshot: ProviderSnapshot<Quote[]> = {
  provider: "test",
  datasetId: "equity_daily_close",
  symbolsRequested: ["SPY", "QQQ", "DIA", "IWM", "AAPL"],
  asOf: "2026-07-24T20:00:00Z",
  fetchedAt: "2026-07-24T20:01:00Z",
  timezone: "America/New_York",
  delayClass: "eod",
  quality: "real",
  paginationComplete: true,
  expectedSessionDate: "2026-07-24",
  rawProvenanceHash: "a".repeat(64),
  normalizedHash: "b".repeat(64),
  licenseContext: "test/equity_daily_close",
  provenanceId: null,
  data: [
    q("SPY", 635.34, 0.38),
    q("QQQ", 565.12, 0.76),
    q("DIA", 444.28, 0.14),
    q("IWM", 224.91, -0.54),
    q("AAPL", 231.40, 0.62),
  ],
  notes: [],
};

test("大盤 ETF 與七巨頭分區呈現，不混入個股排行", () => {
  const zh = buildMarketReport(snapshot, "zh-TW", new Date("2026-07-24T20:10:00Z")).text;
  const en = buildMarketReport(snapshot, "en", new Date("2026-07-24T20:10:00Z")).text;

  for (const symbol of ["SPY", "QQQ", "DIA", "IWM"]) {
    assert.match(zh, new RegExp(symbol));
    assert.match(en, new RegExp(symbol));
  }
  assert.match(zh, /美股大盤溫度計/);
  assert.match(en, /US Market Gauge/);
  assert.ok(zh.indexOf("美股大盤溫度計") < zh.indexOf("七巨頭表現"));
  assert.match(zh, /以下以 ETF 作為市場代理/);
  assert.match(en, /Market proxies shown via ETFs/);
});
