import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntime, handleTelegramUpdate } from "../src/runtime/runtime.ts";
import { QuoteCache } from "../src/pipeline/quoteCache.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { ProvenanceLedger } from "../src/pipeline/artifactSeal.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";
import { MARKET_SYMBOLS } from "../src/bot/commands.ts";

const ENV = { MASSIVE_API_KEY:"k", TELEGRAM_BOT_TOKEN:"t", ARTIFACT_HMAC_SECRET:"s",
  PERSONAL_PREVIEW_ENABLED:"true", PERSONAL_PREVIEW_USER_ID:"1",
  F_BASIC_TA:"true", DATA_DERIVED_DISPLAY_OK:"false" };

test("runtime 工廠:quotes 是 QuoteCache;個人預覽只授權 internal_research", () => {
  const tp = new MockTelegramTransport();
  const rt = buildRuntime(ENV, { transport: tp });
  assert.ok(rt.deps.quotes instanceof QuoteCache);
  assert.equal(rt.cache.batches().map(b => b.length).join(","), "5,5,1");
  assert.equal(rt.deps.license.isGranted({ supplier:"massive", dataset:"equity_daily_close",
    channel:"telegram", jurisdiction:"TW", use:"internal_research" }), true);
  const rtNoDev = buildRuntime({ ...ENV, PERSONAL_PREVIEW_ENABLED: "false" }, { transport: tp });
  assert.equal((rtNoDev.deps.license as any) instanceof LicenseRegistry, true);
  assert.equal(rtNoDev.deps.license.isGranted({ supplier:"massive", dataset:"equity_daily_close",
    channel:"telegram", jurisdiction:"TW", use:"internal_research" }), false);
});
test("webhook update → /start 回覆經 transport 送出;非指令靜默", async () => {
  const tp = new MockTelegramTransport();
  const ledger = new ProvenanceLedger();
  const cache = new QuoteCache(new MockQuoteProvider(ledger), MARKET_SYMBOLS, 5);
  const rt = buildRuntime(ENV, { transport: tp });
  const deps = { ...rt.deps, quotes: cache, provenanceReader: ledger.reader() };
  await handleTelegramUpdate({ message: { text:"/start", chat:{ id: 111 }, from:{ id: 222 } } }, deps);
  assert.equal(tp.sent.length, 1);
  assert.match(tp.sent[0].text, /不提供投資建議/);
  await handleTelegramUpdate({ message: { text:"hello", chat:{ id: 111 }, from:{ id: 222 } } }, deps);
  assert.equal(tp.sent.length, 1);                              // 非指令不回
  await handleTelegramUpdate({ edited_message: {} }, deps);     // 畸形 update 不炸
});
test("端到端(runtime 組裝):快取補滿後 /markets 完整報告送達", async () => {
  const tp = new MockTelegramTransport();
  const ledger = new ProvenanceLedger();
  const cache = new QuoteCache(new MockQuoteProvider(ledger), MARKET_SYMBOLS, 5);
  const rt = buildRuntime(ENV, { transport: tp });
  const deps = { ...rt.deps, quotes: cache, provenanceReader: ledger.reader(),
    license: new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
      channels:["telegram"], jurisdictions:["*"], uses:["internal_research"],
      validUntilIso:null, docRef:"TEST" }]) };
  await handleTelegramUpdate({ message: { text:"/start", chat:{ id: 1 }, from:{ id: 1 } } }, deps);
  const NOWD = new Date("2026-07-22T20:10:00Z");
  await cache.refreshTick(NOWD); await cache.refreshTick(NOWD); await cache.refreshTick(NOWD);
  await handleTelegramUpdate({ message: { text:"/markets", chat:{ id: 1 }, from:{ id: 1 } } }, deps);
  const report = tp.sent.at(-1)!.text;
  assert.match(report, /美股大盤溫度計/);
  assert.match(report, /七巨頭表現/);
});
test("同一交易日檢查:批次已達最近完成時段 → tick 跳過不打上游", async () => {
  const NOWD = new Date("2026-07-25T14:00:00Z");   // 週六;最近完成時段 = 07-24(Mock asOf 同日)
  const ledger = new ProvenanceLedger();
  let calls = 0;
  const upstream = { id:"m", getQuotes: async (s: string[]) => { calls++;
    return new MockQuoteProvider(ledger).getQuotes(s); } };
  const cache = new QuoteCache(upstream as any, MARKET_SYMBOLS, 5);
  await cache.refreshTick(NOWD); await cache.refreshTick(NOWD); await cache.refreshTick(NOWD);
  assert.equal(calls, 3);                                       // 補滿
  const r = await cache.refreshTick(NOWD);                      // 第 4 tick:批次 0 已新鮮
  assert.equal(r.quality, "fresh_skip");
  assert.equal(calls, 3);                                       // 配額零消耗
});
