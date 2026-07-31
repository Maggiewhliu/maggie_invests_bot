import assert from "node:assert/strict";
import test from "node:test";
import { lint, assertSafe, buildStateReport, ContentRiskError } from "../src/contentRiskGuard.ts";
import { canAccess, shouldShadow, vvipVisible } from "../src/tierAccess.ts";

// ---- contentRiskGuard ----
test("舊版違規文案全數攔截(含新增的過度詮釋詞)", () => {
  const legacy = "長線持有: Apple\n逢低布局 TSLA\n極強磁吸\n機構正在買 NVDA";
  const r = lint(legacy);
  assert.equal(r.ok, false);
  for (const t of ["長線持有","逢低","磁吸","機構正在買"]) assert.ok(r.blocked.includes(t), t);
});
test("績效宣稱 → lint 標記 review(發送層由 assertPublishable 強制攔截)", () => {
  const r = lint("過去一年勝率 68%,XIRR 54%");
  assert.equal(r.ok, true);
  assert.ok(r.review.includes("勝率") && r.review.includes("XIRR"));
});
test("assertSafe 對違規拋 ContentRiskError", () => {
  assert.throws(() => assertSafe("真正買點在 $430", "test"), ContentRiskError);
});
test("五態報告:四語生成且正文過檢", () => {
  for (const lang of ["zh-TW","zh-CN","en","ja"] as const) {
    const { text } = buildStateReport({
      ticker:"TSLA", state:"WEAKENING", lang,
      why:["量能連三日遞減。"], watch:["是否跌破近月區間。"],
      invalidate:["量價同步回升站回區間。"],
      dataCutoff:"2026-07-24 16:00 ET", engineVersion:"3.0",
    });
    assert.ok(text.includes("TSLA"));
  }
});
test("免責聲明不觸發自身攔截(只掃正文)", () => {
  const { text } = buildStateReport({
    ticker:"AAPL", state:"NEUTRAL", lang:"zh-TW",
    why:["區間整理。"], watch:["財報日 8/1。"], invalidate:["跳空離開區間。"],
    dataCutoff:"2026-07-24", engineVersion:"3.0",
  });
  assert.ok(text.includes("非投資建議"));
});

// ---- tierAccess ----
const envOff = {}; // 什麼都沒開:授權未到、flag未設、VVIP隱藏
const envLive = { DATA_DERIVED_DISPLAY_OK:"true", VVIP_ENABLED:"true",
  F_MAXPAIN_SUM:"true", F_MAXPAIN_FULL:"true", F_GEX:"true",
  F_JUDGMENTS:"true", F_MAG7:"true", F_CONGRESS:"true" };

test("預設全關(fail-safe):未設 flag 一律拒絕", () => {
  const r = canAccess({ tier:2, jurisdictionPaidAllowed:true }, "mag7_state_reports", envOff);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "feature_disabled");
});
test("VVIP 整層隱藏:tier 4 用戶也看不到 gex", () => {
  const r = canAccess({ tier:4, jurisdictionPaidAllowed:true }, "gex", envOff);
  assert.equal(r.reason, "vvip_hidden");
  assert.equal(vvipVisible(envOff), false);
});
test("Max Pain 三層定案:摘要=tier2、完整=tier3(僅法域+授權+flag齊備時)", () => {
  const cert = { tier:2 as const, jurisdictionPaidAllowed:true };
  assert.equal(canAccess(cert, "max_pain_summary", envLive).allowed, true);
  assert.equal(canAccess(cert, "max_pain_full", envLive).reason, "need_tier_3");
  const vip = { tier:3 as const, jurisdictionPaidAllowed:true };
  assert.equal(canAccess(vip, "max_pain_full", envLive).allowed, true);
});
test("Max Pain 授權未開 → 摘要層也 shadow", () => {
  assert.equal(shouldShadow("max_pain_summary", envOff), true);
});
test("法域未過 → VIP 功能擋在 jurisdiction", () => {
  const r = canAccess({ tier:3, jurisdictionPaidAllowed:false }, "full_judgments", envLive);
  assert.equal(r.reason, "jurisdiction_pending_review");
});
test("授權到位+VVIP開啟 → gex 對 tier4 放行", () => {
  const r = canAccess({ tier:4, jurisdictionPaidAllowed:true }, "gex", envLive);
  assert.equal(r.allowed, true);
});
test("shadow:VVIP隱藏期間 gex 後台照算", () => {
  assert.equal(shouldShadow("gex", envOff), true);
  assert.equal(shouldShadow("edu_content", envOff), false);
});
test("國會交易:tier2 不夠格 → need_tier_3", () => {
  const r = canAccess({ tier:2, jurisdictionPaidAllowed:true }, "congress_search", envLive);
  assert.equal(r.reason, "need_tier_3");
});

// ---- 第四輪 P0:人工核准閘門 ----
import { publishDecision, assertPublishable, makeApproval,
  ApprovalRequiredError } from "../src/contentRiskGuard.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";

test("P0 發布閘門:review 詞無核准 → 自動發送被真正攔下", () => {
  assert.throws(() => assertPublishable("本策略過去勝率 68%", "auto"), ApprovalRequiredError);
});
test("P0 發布閘門:有效人工核准 → 放行;內容改動即失效", () => {
  const text = "本策略過去勝率 68%";
  const ap = makeApproval(text, "maggie");
  assert.equal(assertPublishable(text, "manual", ap).review.includes("勝率"), true);
  assert.throws(() => assertPublishable(text + "!", "manual", ap), ApprovalRequiredError);
});
test("P0 發布閘門:blocked 詞即使有人工核准也不放行", () => {
  const bad = "建議你逢低買進";
  assert.throws(() => assertPublishable(bad, "x", makeApproval(bad, "maggie")));
});
test("publishDecision 三態正確", () => {
  assert.equal(publishDecision("市場今日收黑。").mode, "auto_ok");
  assert.equal(publishDecision("XIRR 54%").mode, "requires_approval");
  assert.equal(publishDecision("目標價 500").mode, "blocked");
});
test("授權登錄表:維度全中才放行,過期不放行", () => {
  const reg = new LicenseRegistry([{
    supplier:"massive", dataset:"options_chain_snapshot",
    channels:["telegram","web"], jurisdictions:["TW"],
    uses:["derived_display"], validUntilIso:"2027-01-01T00:00:00Z", docRef:"MSV-2026-001",
  }]);
  const base = { supplier:"massive", dataset:"options_chain_snapshot",
    channel:"telegram", jurisdiction:"TW", use:"derived_display" };
  assert.equal(reg.isGranted(base), true);
  assert.equal(reg.isGranted({ ...base, jurisdiction:"JP" }), false);
  assert.equal(reg.isGranted({ ...base, channel:"email" }), false);
  assert.equal(reg.isGranted(base, "2027-06-01T00:00:00Z"), false);
});

// ---- 免責樣板白名單(修正:免責聲明不得觸發自身攔截) ----
import { APPROVED_BOILERPLATE, stripApprovedBoilerplate } from "../src/contentRiskGuard.ts";

test("免責聲明含「建議」但不觸發 review", () => {
  for (const b of APPROVED_BOILERPLATE) {
    const r = lint(`市場今日收黑。\n${b}`);
    assert.equal(r.ok, true);
    assert.deepEqual(r.review, [], `樣板誤攔: ${b.slice(0,20)}`);
  }
});
test("白名單只剔除逐字樣板,不放行真正的違規措辭", () => {
  const r = lint(`建議你逢低買進。\n${APPROVED_BOILERPLATE[0]}`);
  assert.equal(r.ok, false);
  assert.ok(r.blocked.includes("逢低"));
});
