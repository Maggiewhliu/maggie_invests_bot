/**
 * src/tierAccess.ts — 會員分級與功能授權(entitlement 制)
 * 定稿原則:分級是骨架,真正的開關是「功能 × 法域 × 資料授權 × feature flag」四重檢查。
 * VVIP:在授權/成本/shadow驗證/候補人數/毛利門檻全部成立前,整層隱藏(連預告都不出現)。
 */

export type Tier = 0 | 1 | 2 | 3 | 4; // pending/lobby/certified/vip/vvip(隱藏)
export const TIER_NAME: Record<Tier, string> = {
  0:"pending", 1:"lobby", 2:"certified", 3:"vip", 4:"vvip_hidden" };

export interface UserContext {
  tier: Tier;
  jurisdictionPaidAllowed: boolean; // 法域是否已開放付費(pending legal review 預設 false)
}

export interface FeatureDef {
  minTier: Tier;
  needsDerivedLicense: boolean; // 依賴資料商「商用+衍生展示」授權
  flag: string;                 // env feature flag,未設一律關(fail-safe)
  vvipOnly?: boolean;           // 屬 VVIP 層:額外受 VVIP_ENABLED 總開關管制
}

/**
 * 功能表(依 2026-07 第三輪仲裁定案;分層屬設定資料,可調)
 * Max Pain 分級定案:摘要=Certified(tier2)、完整分析=VIP(tier3)、
 * GEX 等高階=VVIP;全部仍受衍生資料授權開通管制。
 */
export const FEATURES: Record<string, FeatureDef> = {
  // Free (tier 1)
  finra_offexchange_delayed: { minTier:1, needsDerivedLicense:false, flag:"F_FINRA_DELAYED" },
  basic_indicators:          { minTier:1, needsDerivedLicense:false, flag:"F_BASIC_TA" },
  event_calendar:            { minTier:1, needsDerivedLicense:false, flag:"F_EVENTS" },
  edu_content:               { minTier:1, needsDerivedLicense:false, flag:"F_EDU" },
  // Certified (tier 2)
  watchlist:                 { minTier:2, needsDerivedLicense:false, flag:"F_WATCHLIST" },
  price_alerts:              { minTier:2, needsDerivedLicense:true,  flag:"F_PRICE_ALERTS" },
  earnings_alerts:           { minTier:2, needsDerivedLicense:false, flag:"F_EARN_ALERTS" },
  mag7_state_reports:        { minTier:2, needsDerivedLicense:false, flag:"F_MAG7" },
  // VIP (tier 3)
  full_judgments:            { minTier:3, needsDerivedLicense:false, flag:"F_JUDGMENTS" },
  congress_search:           { minTier:3, needsDerivedLicense:true,  flag:"F_CONGRESS" },
  judgment_records:          { minTier:3, needsDerivedLicense:false, flag:"F_RECORDS" },
  institutional_13f:         { minTier:3, needsDerivedLicense:false, flag:"F_13F" },
  // Max Pain 三層(仲裁定案)
  max_pain_summary:          { minTier:2, needsDerivedLicense:true, flag:"F_MAXPAIN_SUM" },
  max_pain_full:             { minTier:3, needsDerivedLicense:true, flag:"F_MAXPAIN_FULL" },
  // VVIP (tier 4, 整層隱藏)
  iv_rank:                   { minTier:4, needsDerivedLicense:true, flag:"F_IV",      vvipOnly:true },
  gex:                       { minTier:4, needsDerivedLicense:true, flag:"F_GEX",     vvipOnly:true },
  trf_realtime:              { minTier:4, needsDerivedLicense:true, flag:"F_TRF_RT",  vvipOnly:true },
};

export interface Env { [k: string]: string | undefined }

const flagOn = (env: Env, f: string) => env[f] === "true";
const licenseOK = (env: Env) => env["DATA_DERIVED_DISPLAY_OK"] === "true";
const vvipEnabled = (env: Env) => env["VVIP_ENABLED"] === "true"; // 預設 false=整層隱藏

export type DenyReason =
  | "unknown_feature" | "vvip_hidden" | `need_tier_${number}`
  | "jurisdiction_pending_review" | "data_license_pending" | "feature_disabled";

export function canAccess(user: UserContext, feature: string, env: Env = process.env)
  : { allowed: boolean; reason: DenyReason | "ok" } {
  const f = FEATURES[feature];
  if (!f) return { allowed:false, reason:"unknown_feature" };
  if (f.vvipOnly && !vvipEnabled(env)) return { allowed:false, reason:"vvip_hidden" };
  if (user.tier < f.minTier) return { allowed:false, reason:`need_tier_${f.minTier}` as DenyReason };
  if (f.minTier >= 3 && !user.jurisdictionPaidAllowed)
    return { allowed:false, reason:"jurisdiction_pending_review" };
  if (f.needsDerivedLicense && !licenseOK(env))
    return { allowed:false, reason:"data_license_pending" };
  if (!flagOn(env, f.flag)) return { allowed:false, reason:"feature_disabled" };
  return { allowed:true, reason:"ok" };
}

/** 授權未到位時是否「後台照算、寫shadow log、不對外」 */
export function shouldShadow(feature: string, env: Env = process.env): boolean {
  const f = FEATURES[feature];
  if (!f) return false;
  if (f.vvipOnly && !vvipEnabled(env)) return true;
  return f.needsDerivedLicense && !licenseOK(env);
}

/** VVIP 是否可在任何 UI 出現(含預告/定價頁)——條件未齊一律 false */
export function vvipVisible(env: Env = process.env): boolean { return vvipEnabled(env); }
