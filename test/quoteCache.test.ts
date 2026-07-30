import assert from "node:assert/strict";
import test from "node:test";
import { QuoteCache } from "../src/pipeline/quoteCache.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { ProvenanceLedger } from "../src/pipeline/artifactSeal.ts";
import { MARKET_SYMBOLS, MAG7, handleCommand, type BotDeps } from "../src/bot/commands.ts";
import { MemoryRecipientProvider } from "../src/providers/recipientAdapter.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";
import { MemoryPushStore } from "../src/pushCore.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";
import type { QuoteProvider } from "../src/providers/types.ts";

const NOW = new Date("2026-07-22T20:10:00Z");
const ENV = { F_BASIC_TA:"true", DATA_DERIVED_DISPLAY_OK:"true", ARTIFACT_HMAC_SECRET:"test-secret" };
const licensed = () => new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
  channels:["telegram"], jurisdictions:["TW"], uses:["derived_display"], validUntilIso:null, docRef:"TEST-001" }]);

/** 上游包裝:記錄每次被要求的批次,轉呼叫 Mock */
class SpyUpstream implements QuoteProvider {
  id = "spy"; calls: string[][] = [];
  private inner: MockQuoteProvider;
  constructor(inner: MockQuoteProvider) { this.inner = inner; }
  async getQuotes(syms: string[]) { this.calls.push([...syms]); return this.inner.getQuotes(syms); }
}

test("批次規劃:11 檔 × 批次5 → [5,5,1],每 tick 只打上游一批", async () => {
  const ledger = new ProvenanceLedger();
  const spy = new SpyUpstream(new MockQuoteProvider(ledger));
  const cache = new QuoteCache(spy, MARKET_SYMBOLS, 5);
  assert.deepEqual(cache.batches().map(b => b.length), [5, 5, 1]);
  await cache.refreshTick();
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].length, 5);                        // 尊重 5/min 限流
  assert.deepEqual(spy.calls[0], ["SPY","QQQ","DIA","IWM","AAPL"]);
});
test("快取未滿 → incomplete + 明列缺少;三 tick 補滿 → real 11 檔", async () => {
  const ledger = new ProvenanceLedger();
  const cache = new QuoteCache(new MockQuoteProvider(ledger), MARKET_SYMBOLS, 5);
  await cache.refreshTick();                                    // 只有第一批
  const s1 = await cache.getQuotes(MARKET_SYMBOLS);
  assert.equal(s1.quality, "incomplete");
  assert.match(s1.notes!.join(","), /cache missing: MSFT/);
  await cache.refreshTick(); await cache.refreshTick();         // 補滿
  const s2 = await cache.getQuotes(MARKET_SYMBOLS);
  assert.equal(s2.quality, "real");
  assert.equal(s2.data!.length, 11);
  assert.ok(s2.provenanceIds!.length >= 2);                     // 多批次存證全列
});
test("getQuotes 零上游請求(讀快取不打 API)", async () => {
  const ledger = new ProvenanceLedger();
  const spy = new SpyUpstream(new MockQuoteProvider(ledger));
  const cache = new QuoteCache(spy, MARKET_SYMBOLS, 5);
  await cache.refreshTick(); await cache.refreshTick(); await cache.refreshTick();
  const before = spy.calls.length;
  await cache.getQuotes(MARKET_SYMBOLS);
  await cache.getQuotes(MARKET_SYMBOLS);
  assert.equal(spy.calls.length, before);                       // 讀取不觸發上游
});
test("輪替持續:第 4 tick 回到第一批刷新", async () => {
  const ledger = new ProvenanceLedger();
  const spy = new SpyUpstream(new MockQuoteProvider(ledger));
  const cache = new QuoteCache(spy, MARKET_SYMBOLS, 5);
  for (let i = 0; i < 4; i++) await cache.refreshTick();
  assert.deepEqual(spy.calls[3], spy.calls[0]);                 // 回到批次 0
});
test("過期檔傳遞:快取內某檔 asOf < expectedSessionDate → stale", async () => {
  const stale: QuoteProvider = { id: "stale-up", getQuotes: async (syms) => {
    const base = await new MockQuoteProvider().getQuotes(syms);
    return { ...base, expectedSessionDate: "2026-07-24",
      data: base.data!.map(q => q.symbol === "TSLA" ? { ...q, asOf: "2026-07-21T20:00:00Z" } : q) };
  }};
  const cache = new QuoteCache(stale, MARKET_SYMBOLS, 11);
  await cache.refreshTick();
  const s = await cache.getQuotes(MARKET_SYMBOLS);
  assert.equal(s.quality, "stale");
  assert.match(s.notes!.join(","), /TSLA: stale/);
});
test("端到端:/markets 走快取 → 快取未滿回收集中;補滿後發完整報告(含溫度計)", async () => {
  const ledger = new ProvenanceLedger();
  const cache = new QuoteCache(new MockQuoteProvider(ledger), MARKET_SYMBOLS, 5);
  const tp = new MockTelegramTransport();
  const d: BotDeps = { recipients: new MemoryRecipientProvider(), quotes: cache,
    transport: tp, store: new MemoryPushStore(), license: licensed(),
    provenanceReader: ledger.reader(), env: ENV, now: () => NOW };
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  await cache.refreshTick();                                    // 只有 SPY..AAPL
  const r1 = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 0);
  assert.match(r1.reply!, /七巨頭資料:1\/7/);
  assert.match(r1.reply!, /大盤資料:4\/4/);
  await cache.refreshTick(); await cache.refreshTick();         // 補滿 11 檔
  await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 1);                              // 多批次 provenance 密封成功
  assert.match(tp.sent[0].text, /美股大盤溫度計/);
  assert.match(tp.sent[0].text, /七巨頭表現/);
  assert.match(tp.sent[0].text, /行情資料: 前一交易日收盤\(EOD\)/);
});
