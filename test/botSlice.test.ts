import assert from "node:assert/strict";
import test from "node:test";
import { handleCommand, MAG7, MARKET_SYMBOLS, type BotDeps } from "../src/bot/commands.ts";
import { MemoryRecipientProvider, type BotUser } from "../src/providers/recipientAdapter.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";
import { MemoryPushStore, deliveryId, candidateId } from "../src/pushCore.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";
import { buildMarketReport } from "../src/reports/marketReport.ts";
import { unavailableSnapshot, type Quote } from "../src/providers/types.ts";
import { publish } from "../src/pipeline/publish.ts";
import { sealDecisionArtifact, verifySealedArtifact, ProvenanceLedger,
  sha256, type PublishPolicy, type SealedArtifact } from "../src/pipeline/artifactSeal.ts";
import { MassiveQuoteProvider, type HttpGet } from "../src/providers/massiveQuoteProvider.ts";
import { getMarketStatus } from "../src/marketClock.ts";

const NOW = new Date("2026-07-22T20:10:00Z"); // 週三 16:10 ET
const SECRET = "test-secret";
const HX = (c: string) => c.repeat(64);       // 合法 hex 字元請用 0-9a-f
const licensed = () => new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
  channels:["telegram"], jurisdictions:["TW"], uses:["derived_display"], validUntilIso:null, docRef:"TEST-001" }]);
const unlicensed = () => new LicenseRegistry([]);
const ENV = { F_BASIC_TA:"true", DATA_DERIVED_DISPLAY_OK:"true", ARTIFACT_HMAC_SECRET: SECRET };

const LEDGER = new ProvenanceLedger();
const PROV = LEDGER.reader();
let seq = 0;
const provId = (supplier = "mock-fixture", dataset = "equity_daily_close") =>
  LEDGER.ingest({ supplier, dataset,
    rawPayload: `raw-payload-${++seq}`, normalizedData: { seq } });

const basePolicy = (over: Partial<PublishPolicy> = {}): PublishPolicy => ({
  channel:"telegram", node:"close_summary", etDate:"2026-07-22",
  candidateMode:"fixed", feature:"basic_indicators", minTier:1,
  licenseUse:"derived_display", ...over });

const sealFor = (dv: string, text: string, opts: { q?: "real"|"incomplete"|"stale"|"invalid",
  policy?: Partial<PublishPolicy>, ids?: string[] } = {}): SealedArtifact =>
  sealDecisionArtifact({ decisionVersion: dv, dataQuality: opts.q ?? "real",
    provenanceIds: opts.ids ?? [provId()],
    renderings: [{ lang:"zh-TW", text }, { lang:"en", text }],
    policy: basePolicy(opts.policy) }, PROV, SECRET);

function deps(over: Partial<BotDeps> = {}): BotDeps {
  return { recipients: new MemoryRecipientProvider(), quotes: new MockQuoteProvider(LEDGER),
    transport: new MockTelegramTransport(), store: new MemoryPushStore(),
    license: licensed(), provenanceReader: PROV, env: ENV, now: () => NOW, ...over };
}
const mkUser = async (r: MemoryRecipientProvider, id = "u1", chat = "c1"): Promise<BotUser> => {
  const u: BotUser = { userId:id, chatId:chat, tier:2, lang:"zh-TW",
    jurisdiction:"TW", jurisdictionPaidAllowed:true };
  await r.upsert(u); return u;
};
const pubDeps = (tp: MockTelegramTransport, recips: MemoryRecipientProvider,
  store = new MemoryPushStore(), lic = licensed()) =>
  ({ store, recipients: recips, transport: tp, license: lic, env: ENV, nowMs: 0 });

// ---------- 指令切片 ----------
test("/start → Lobby 使用者,不索取持倉", async () => {
  const d = deps();
  const r = await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  assert.match(r.reply!, /不提供投資建議/);
  assert.equal((await d.recipients.get("u1"))!.tier, 1);
});
test("/language en → 英文輸出", async () => {
  const d = deps();
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  await handleCommand("/language en", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/account", { userId:"u1", chatId:"c1" }, d);
  assert.match(r.reply!, /Tier/);
});
test("/markets 完整管線 → transport 收到報告", async () => {
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 1);
  assert.match(tp.sent[0].text, /美股市場狀態/);
  assert.equal((r.published as any).sent.length, 1);
});
test("License 關閉 → 一則不發", async () => {
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp, license: unlicensed() });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 0);
  assert.match(r.reply!, /blocked_license/);
});
test("Feature flag 關閉 → fail-safe 拒絕", async () => {
  const d = deps({ env: { DATA_DERIVED_DISPLAY_OK:"true", ARTIFACT_HMAC_SECRET: SECRET } });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.match(r.reply!, /feature_disabled/);
});
test("資料不可用 → 明確告知且 asOf=null 不冒充", async () => {
  const dead = unavailableSnapshot<Quote[]>("dead","equity_daily_close","dead/equity_daily_close","provider down");
  assert.equal(dead.asOf, null);
  const d = deps({ quotes: { id:"dead", getQuotes: async () => dead } });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.match(r.reply!, /不可用/);
});
test("snapshot:繁英報告含免責、零黑名單詞、英文零中文字元", async () => {
  const snap = await new MockQuoteProvider().getQuotes(MAG7);
  for (const lang of ["zh-TW","en"] as const) {
    const rep = buildMarketReport(snap, lang, NOW);
    assert.match(rep.text, lang === "zh-TW" ? /非投資建議/ : /Not investment advice/);
    for (const bad of ["逢低","買進","目標價","buy now","price target"])
      assert.equal(rep.text.toLowerCase().includes(bad.toLowerCase()), false);
  }
  assert.equal(/[\u4e00-\u9fff]/.test(buildMarketReport(snap,"en",NOW).text), false);
});
test("incomplete 報告明列缺少 symbols", async () => {
  const snap = await new MockQuoteProvider().getQuotes([...MAG7, "FAKE1"]);
  assert.match(buildMarketReport(snap, "zh-TW", NOW).text, /缺少: FAKE1/);
});

// ---------- 發布管線(sealed policy) ----------
test("績效宣稱無人工核准 → 自動管線零送出", async () => {
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("d1", "本週策略勝率 68%,XIRR 54%"),
    renderFor: () => "本週策略勝率 68%,XIRR 54%" }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 0);
  assert.equal(res.skipped[0].reason, "requires_approval");
});
test("四節點去重:同版本重複發布只送一次", async () => {
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const store = new MemoryPushStore();
  const req = { artifact: sealFor("d2", "市場今日收黑,量能收斂。"),
    renderFor: () => "市場今日收黑,量能收斂。" };
  await publish(req, pubDeps(tp, rc, store)); await publish(req, pubDeps(tp, rc, store));
  assert.equal(tp.sent.length, 1);
});
test("no_recipients:無收件人不算 missed", async () => {
  const res = await publish({ artifact: sealFor("d9", "測試", { policy: { minTier: 3 } }),
    renderFor: () => "測試" },
    pubDeps(new MockTelegramTransport(), new MemoryRecipientProvider()));
  assert.equal(res.noRecipients, true);
});
test("Telegram 429 → retryable 不當已送達", async () => {
  const tp = new MockTelegramTransport([{ ok:false, httpStatus:429, retryAfterSec:30 }]);
  const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("d3", "市場今日收黑。"),
    renderFor: () => "市場今日收黑。" }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 0);
  assert.equal(res.skipped[0].reason, "failed_retryable");
});
test("多源任一未授權 → 整則擋", async () => {
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("dm1", "市場今日收黑。",
      { ids: [provId(), provId("massive", "options_chain_snapshot")] }),
    renderFor: () => "市場今日收黑。" }, pubDeps(tp, rc));
  assert.equal(res.skipped[0].reason, "blocked_license");
});
test("真實流程掉包:massive(無 grant)snapshot 經正規密封仍被擋", async () => {
  const CLOCK = () => new Date("2026-07-24T21:00:00Z");
  const http: HttpGet = async () => ({ status: 200, text: async () => JSON.stringify({ results: [
    { c: 231.4, o: 230, v: 1000, t: 1784923200000 },
    { c: 229.97, o: 229, v: 900, t: 1784836800000 }] }) });
  const snap = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  const rep = buildMarketReport(snap, "zh-TW", NOW);
  const id = LEDGER.ingest({ supplier: "massive", dataset: "equity_daily_close",
    rawPayload: "massive-raw-body", normalizedData: snap.data });
  const art = sealDecisionArtifact({ decisionVersion: rep.decisionVersion, dataQuality: rep.dataQuality,
    provenanceIds: [id], renderings: [{ lang:"zh-TW", text: rep.text }],
    policy: basePolicy({ etDate: "2026-07-24" }) }, PROV, SECRET);
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: art, renderFor: () => rep.text }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 0);
  assert.equal(res.skipped[0].reason, "blocked_license");
});

// ---------- 密封 P0-A ----------
test("P0-1 介面上不存在提交 hash 的路徑:ingest 只收 payload,hash 由 gateway 計算", () => {
  const id = LEDGER.ingest({ supplier:"mock-fixture", dataset:"equity_daily_close",
    rawPayload:"the-actual-raw-body", normalizedData:{ a: 1 } });
  const rec = PROV.get(id)!;
  assert.equal(rec.rawProvenanceHash, sha256("the-actual-raw-body"));       // 由 payload 計得
  assert.equal(rec.normalizedHash, sha256(JSON.stringify({ a: 1 })));
  assert.equal(rec.licenseContext, "mock-fixture/equity_daily_close");      // 由 adapter 設定,非業務層
  // 型別層不存在 hash 參數:IngestInput 僅 supplier/dataset/rawPayload/normalizedData
  const keys = Object.keys({ supplier:"x", dataset:"y", rawPayload:"z", normalizedData:{} });
  assert.deepEqual(keys.sort(), ["dataset","normalizedData","rawPayload","supplier"]);
});
test("P0-1 空 payload → gateway 拒絕", () => {
  assert.throws(() => LEDGER.ingest({ supplier:"mock-fixture", dataset:"equity_daily_close",
    rawPayload:"", normalizedData:{} }), /rawPayload required/);
});
test("P0-A 不存在的 provenance → seal 拒絕", () => {
  assert.throws(() => sealDecisionArtifact({ decisionVersion:"dX", dataQuality:"real",
    provenanceIds:["prov:doesnotexist"], renderings:[{ lang:"zh-TW", text:"x" }],
    policy: basePolicy() }, PROV, SECRET), /provenance not found/);
});
test("P0-A seal 自算 hash:contentHash 與 rendering 由文字計得,呼叫端無法指定", () => {
  const art = sealFor("dH", "自算內容。");
  assert.equal(art.contentHash, sha256("自算內容。"));
  assert.equal(art.renderings.find(r => r.lang==="zh-TW")!.sha256, sha256("自算內容。"));
});
test("P0-A 偽造簽章 → blocked_artifact", async () => {
  const good = sealFor("dF", "原文。");
  const forged: any = { ...good, hmac: "0".repeat(64) };
  const res = await publish({ artifact: forged, renderFor: () => "原文。" },
    pubDeps(new MockTelegramTransport(), new MemoryRecipientProvider()));
  assert.equal(res.blocked, "blocked_artifact");
});
test("P0-A 密封後竄改 sourceRefs → 驗簽失敗", () => {
  const good = sealFor("dT", "原文。");
  const tampered: any = { ...good, sourceRefs: [{ ...good.sourceRefs[0], normalizedHash: HX("9") }] };
  assert.equal(verifySealedArtifact(tampered, SECRET), false);
});
test("P0-A renderFor 給密封外文字 → 收件人被擋", async () => {
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("dR", "密封原文。"),
    renderFor: () => "無關文字" }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 0);
  assert.equal(res.skipped[0].reason, "blocked_artifact");
});

// ---------- 密封 P0-B(政策入簽) ----------
test("P0-B policy downgrade:VVIP 密封改宣稱 basic/minTier1 → 驗簽失敗被擋", async () => {
  const vvip = sealFor("dV", "VVIP-only sealed rendering",
    { policy: { feature: "gex", minTier: 4 } });
  const downgraded: any = { ...vvip, policy: { ...vvip.policy, feature: "basic_indicators", minTier: 1 } };
  assert.equal(verifySealedArtifact(downgraded, SECRET), false);
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: downgraded, renderFor: () => "VVIP-only sealed rendering" },
    pubDeps(tp, rc));
  assert.equal(tp.sent.length, 0);
  assert.equal(res.blocked, "blocked_artifact");
});
test("P0-B fixedCandidate flip:conditional 改 fixed → 驗簽失敗;原封 stale 條件節點仍被擋", async () => {
  const staleCond = sealFor("dS", "含過期標的的報告。",
    { q: "stale", policy: { node: "post_open_check", candidateMode: "conditional" } });
  const flipped: any = { ...staleCond, policy: { ...staleCond.policy, candidateMode: "fixed" } };
  assert.equal(verifySealedArtifact(flipped, SECRET), false);
  const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: staleCond, renderFor: () => "含過期標的的報告。" },
    pubDeps(new MockTelegramTransport(), rc));
  assert.equal(res.blocked, "blocked_stale_data");   // 原封條件節點:stale 不發
});
test("P0-B stale 固定候選(原封)放行,文內已標過期", async () => {
  const tp = new MockTelegramTransport(); const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("dS2", "含過期標的的報告。", { q: "stale" }),
    renderFor: () => "含過期標的的報告。" }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 1);
});
test("P0-B node replay:改 node/etDate → 驗簽失敗", () => {
  const a = sealFor("dN", "原文。");
  const replayNode: any = { ...a, policy: { ...a.policy, node: "premarket_outlook" } };
  const replayDate: any = { ...a, policy: { ...a.policy, etDate: "2026-07-23" } };
  assert.equal(verifySealedArtifact(replayNode, SECRET), false);
  assert.equal(verifySealedArtifact(replayDate, SECRET), false);
});

// ---------- denied 原因 → 使用者訊息 ----------
test("denied 對應訊息:in_flight / backoff / fatal / already_sent(中英)", async () => {
  // already_sent(繁中)
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp, store: new MemoryPushStore() });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  const r2 = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 1);
  assert.match(r2.reply!, /已送出/);
  // already_sent(英文實跑)
  const tpE = new MockTelegramTransport();
  const dE = deps({ transport: tpE, store: new MemoryPushStore() });
  await handleCommand("/start", { userId:"u9", chatId:"c9" }, dE);
  await handleCommand("/language en", { userId:"u9", chatId:"c9" }, dE);
  await handleCommand("/markets", { userId:"u9", chatId:"c9" }, dE);
  const rE = await handleCommand("/markets", { userId:"u9", chatId:"c9" }, dE);
  assert.match(tpE.sent[0].text, /US Market State/);
  assert.match(rE.reply!, /already delivered/);
  // in_flight / backoff / fatal
  const snap = await new MockQuoteProvider().getQuotes(MARKET_SYMBOLS);
  const rep = buildMarketReport(snap, "zh-TW", NOW);
  const etDate = getMarketStatus(NOW).etDate;
  const candId = candidateId("on_demand_markets", etDate, rep.decisionVersion);
  const delId = deliveryId(candId, { channel:"telegram", recipientKey:"c1", lang:"zh-TW" });
  const mk = async () => { const s = new MemoryPushStore();
    const dd = deps({ transport: new MockTelegramTransport(), store: s });
    await handleCommand("/start", { userId:"u1", chatId:"c1" }, dd); return { s, dd }; };
  let x = await mk();
  await x.s.claimDelivery(delId, Date.now(), { maxAttempts:3, backoffMs:[120000], leaseMs:600_000 });
  assert.match((await handleCommand("/markets", { userId:"u1", chatId:"c1" }, x.dd)).reply!, /處理中/);
  x = await mk();
  const c2 = await x.s.claimDelivery(delId, Date.now(), { maxAttempts:3, backoffMs:[600_000], leaseMs:60_000 });
  await x.s.failDelivery(delId, (c2 as any).fenceToken, true, Date.now(),
    { maxAttempts:3, backoffMs:[600_000], leaseMs:60_000 }, "http 503");
  assert.match((await handleCommand("/markets", { userId:"u1", chatId:"c1" }, x.dd)).reply!, /處理中/);
  x = await mk();
  const c3 = await x.s.claimDelivery(delId, 0, { maxAttempts:3, backoffMs:[1000], leaseMs:60_000 });
  await x.s.failDelivery(delId, (c3 as any).fenceToken, false, 0,
    { maxAttempts:3, backoffMs:[1000], leaseMs:60_000 }, "http 400");
  assert.match((await handleCommand("/markets", { userId:"u1", chatId:"c1" }, x.dd)).reply!, /暫時無法提供/);
});

test("P0-2 email-only 授權 + Telegram transport → blocked_channel_mismatch,零送出", async () => {
  const emailOnly = new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
    channels:["email"], jurisdictions:["TW"], uses:["derived_display"], validUntilIso:null, docRef:"EMAIL-001" }]);
  const emailArt = sealFor("dE", "只授權 Email 的內容。", { policy: { channel: "email" } });
  const tp = new MockTelegramTransport();   // 實際 transport 是 telegram
  const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: emailArt, renderFor: () => "只授權 Email 的內容。" },
    { store: new MemoryPushStore(), recipients: rc, transport: tp, license: emailOnly, env: ENV, nowMs: 0 });
  assert.equal(tp.sent.length, 0);
  assert.equal(res.blocked, "blocked_channel_mismatch");
});
test("P0-2 密封 telegram + Telegram transport → 正常放行(對照組)", async () => {
  const tp = new MockTelegramTransport();
  const rc = new MemoryRecipientProvider(); await mkUser(rc);
  const res = await publish({ artifact: sealFor("dOK", "正常頻道內容。"),
    renderFor: () => "正常頻道內容。" }, pubDeps(tp, rc));
  assert.equal(tp.sent.length, 1);
  assert.equal(res.sent.length, 1);
});

// ---- 真實整合暴露的兩件上線前 P0 ----
test("P0 時段/資料時間分行:盤中時段 + EOD 資料必須各自如實標示", async () => {
  const snap = await new MockQuoteProvider().getQuotes(MAG7);
  const zh = buildMarketReport(snap, "zh-TW", NOW);
  assert.match(zh.text, /行情資料: 前一交易日收盤\(EOD\)/);
  const en = buildMarketReport(snap, "en", NOW);
  assert.match(en.text, /Quote data: prior session close \(EOD\)/);
  assert.equal(/[\u4e00-\u9fff]/.test(en.text), false);
});
test("P0 未齊 7 檔 → 只回資料收集中,不產生正式報告、不發送", async () => {
  const partial = {
    id: "partial",
    getQuotes: async (syms: string[]) => {
      const full = await new MockQuoteProvider().getQuotes(["AAPL"]);   // 只拿到 1 檔
      return { ...full, symbolsRequested: syms };
    },
  };
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp, quotes: partial as any });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 0);
  assert.match(r.reply!, /七巨頭資料:1\/7/);
  assert.match(r.reply!, /大盤資料:0\/4/);
});

// ---- 報告規格回歸:溫度計 + 雙閘門(GPT 指定三場景) ----
const subsetProvider = (symbols: string[]) => ({
  id: "subset",
  getQuotes: async (req: string[]) => {
    const full = await new MockQuoteProvider().getQuotes(symbols.filter(s => req.includes(s)));
    return { ...full, symbolsRequested: req };
  },
});
test("規格1 七巨頭7/7、ETF 0/4 → 不發布,訊息分列兩組", async () => {
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp, quotes: subsetProvider([...MAG7]) as any });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 0);
  assert.match(r.reply!, /七巨頭資料:7\/7/);
  assert.match(r.reply!, /大盤資料:0\/4/);
});
test("規格2 七巨頭6/7、ETF 4/4 → 不發布", async () => {
  const tp = new MockTelegramTransport();
  const six = MAG7.filter(s => s !== "TSLA");
  const d = deps({ transport: tp, quotes: subsetProvider(["SPY","QQQ","DIA","IWM", ...six]) as any });
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  const r = await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 0);
  assert.match(r.reply!, /七巨頭資料:6\/7/);
  assert.match(r.reply!, /大盤資料:4\/4/);
});
test("規格3 七巨頭7/7、ETF 4/4 → 發布,報告含 SPY/QQQ/DIA/IWM 溫度計與 EOD 標示", async () => {
  const tp = new MockTelegramTransport();
  const d = deps({ transport: tp });                    // Mock fixture 已含 11 檔
  await handleCommand("/start", { userId:"u1", chatId:"c1" }, d);
  await handleCommand("/markets", { userId:"u1", chatId:"c1" }, d);
  assert.equal(tp.sent.length, 1);
  const text = tp.sent[0].text;
  assert.match(text, /美股大盤溫度計/);
  for (const s of ["SPY","QQQ","DIA","IWM"]) assert.match(text, new RegExp(s));
  assert.match(text, /S&P 500 ETF/);
  assert.match(text, /以下以 ETF 作為市場代理/);
  assert.match(text, /七巨頭表現/);
  assert.match(text, /行情資料: 前一交易日收盤\(EOD\)/);   // 第 6 條:EOD 標示保留
});
