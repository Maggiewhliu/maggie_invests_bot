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
  PERSONAL_PREVIEW_ENABLED:"true", PERSONAL_PREVIEW_USER_ID:"981883005",
  F_BASIC_TA:"true", DATA_DERIVED_DISPLAY_OK:"true" };

test("runtime 工廠:quotes 是 QuoteCache;DEV 授權僅在旗標開啟時存在", () => {
  const tp = new MockTelegramTransport();
  const rt = buildRuntime(ENV, { transport: tp });
  assert.ok(rt.deps.quotes instanceof QuoteCache);
  assert.equal(rt.cache.batches().map(b => b.length).join(","), "5,5,1");
  // 預設無對外 derived_display 授權(群組推播被擋)
  assert.equal(rt.deps.license.isGranted({ supplier:"massive", dataset:"equity_daily_close",
    channel:"telegram", jurisdiction:"TW", use:"derived_display" }), false);
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
      channels:["telegram"], jurisdictions:["*"], uses:["derived_display"],
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

// ---- 真實部署暴露的 bug:重啟後使用者遺失 → 指令撞 welcome 牆 ----
import { FileRecipientProvider } from "../src/providers/fileRecipientProvider.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

test("★修復:未知使用者打 /markets → 自動建 Lobby 並執行指令,不回 welcome", async () => {
  const tp = new MockTelegramTransport();
  const ledger = new ProvenanceLedger();
  const cache = new QuoteCache(new MockQuoteProvider(ledger), MARKET_SYMBOLS, 11);
  await cache.refreshTick(new Date("2026-07-22T20:10:00Z"));
  const rt = buildRuntime(ENV, { transport: tp });
  const deps = { ...rt.deps, quotes: cache, provenanceReader: ledger.reader(),
    license: new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
      channels:["telegram"], jurisdictions:["*"], uses:["derived_display"],
      validUntilIso:null, docRef:"TEST" }]) };
  // 直接打 /markets(模擬重啟後使用者遺失;從未 /start)
  await handleTelegramUpdate({ message: { text:"/markets", chat:{ id: 9 }, from:{ id: 9 } } }, deps);
  assert.equal(tp.sent.length, 1);
  assert.doesNotMatch(tp.sent[0].text, /歡迎使用|Welcome to/);   // 不是歡迎詞
  assert.match(tp.sent[0].text, /美股大盤溫度計/);               // 是真的報告
  // /language 也不再撞牆
  const tp2 = new MockTelegramTransport();
  const deps2 = { ...deps, transport: tp2 };
  await handleTelegramUpdate({ message: { text:"/language en", chat:{ id: 10 }, from:{ id: 10 } } }, deps2);
  assert.match(tp2.sent[0].text, /Language set to English/);
});
test("★修復:檔案存儲跨『重啟』保留語言設定", async () => {
  const f = join(tmpdir(), `maggie-users-test-${Date.now()}.json`);
  try {
    const p1 = new FileRecipientProvider(f);
    await p1.upsert({ userId:"u1", chatId:"c1", tier:1, lang:"en",
      jurisdiction:"TW", jurisdictionPaidAllowed:false });
    const p2 = new FileRecipientProvider(f);          // 模擬行程重啟:重新載入
    const u = await p2.get("u1");
    assert.equal(u!.lang, "en");                       // 語言黏著
  } finally { rmSync(f, { force: true }); }
});

// ---- 雙環境與熟悉排版(合法版) ----
test("報告含整體統計:平均漲跌/漲跌家數/最強最弱;lint 乾淨零策略詞", async () => {
  const { buildMarketReport } = await import("../src/reports/marketReport.ts");
  const { lint } = await import("../src/contentRiskGuard.ts");
  const snap = await new MockQuoteProvider().getQuotes(MARKET_SYMBOLS);
  const rep = buildMarketReport(snap, "zh-TW", new Date("2026-07-22T20:10:00Z"));
  assert.match(rep.text, /七巨頭整體表現/);
  assert.match(rep.text, /平均漲跌: [-+]\d+\.\d{2}%/);
  assert.match(rep.text, /最強: \w+/);
  assert.match(rep.text, /最弱: TSLA/);
  for (const bad of ["磁吸","逢低","布局","長期看漲","策略提醒","追蹤","上車"])
    assert.equal(rep.text.includes(bad), false, `含舊版違規詞 ${bad}`);
  const r = lint(rep.text);
  assert.equal(r.ok, true); assert.deepEqual(r.review, []);
});
test("GROUP_CHAT_ID → 預備 Tier2 群組收件人(不觸發任何發送)", async () => {
  const tp = new MockTelegramTransport();
  const f = join(tmpdir(), `maggie-grp-${Date.now()}.json`);
  try {
    const rt = buildRuntime({ ...ENV, BOT_ENV:"production", GROUP_CHAT_ID:"-100999", USERS_FILE:f },
      { transport: tp });
    assert.equal(rt.botEnv, "production");
    const g = await rt.deps.recipients.get("group:-100999");
    assert.equal(g!.tier, 2);
    assert.equal(g!.chatId, "-100999");
    assert.equal(tp.sent.length, 0);                       // 只註冊,不發送
  } finally { rmSync(f, { force: true }); }
});

// ---- 授權分離(GPT 規格):個人預覽 internal_research;群組 derived_display 需旗標 ----
test("個人預覽:PERSONAL_PREVIEW 開啟 → 只 internal_research 有授權,derived_display 仍無", () => {
  const rt = buildRuntime(ENV, { transport: new MockTelegramTransport() });
  const q = { supplier:"massive", dataset:"equity_daily_close", channel:"telegram", jurisdiction:"TW" };
  assert.equal(rt.deps.license.isGranted({ ...q, use:"internal_research" }), true);
  assert.equal(rt.deps.license.isGranted({ ...q, use:"derived_display" }), false);
  assert.equal(rt.deps.previewUserId, "981883005");
});
test("群組授權:唯有 MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED=true 才放行 derived_display", () => {
  const off = buildRuntime(ENV, { transport: new MockTelegramTransport() });
  assert.equal(off.deps.license.isGranted({ supplier:"massive", dataset:"equity_daily_close",
    channel:"telegram", jurisdiction:"TW", use:"derived_display" }), false);
  const on = buildRuntime({ ...ENV, MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED:"true",
    MASSIVE_LICENSE_DOCREF:"MSV-2026-001" }, { transport: new MockTelegramTransport() });
  assert.equal(on.deps.license.isGranted({ supplier:"massive", dataset:"equity_daily_close",
    channel:"telegram", jurisdiction:"TW", use:"derived_display" }), true);
});
test("非預覽使用者即使 PREVIEW 開啟,也拿不到 internal_research(uid 不符)", () => {
  const rt = buildRuntime(ENV, { transport: new MockTelegramTransport() });
  assert.notEqual(rt.deps.previewUserId, "999");   // 其他 uid 不是預覽白名單
});
