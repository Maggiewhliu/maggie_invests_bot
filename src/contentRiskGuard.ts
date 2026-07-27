/**
 * src/contentRiskGuard.ts — 輸出措辭風險防護(工程防呆層)
 *
 * ⚠️ 定位聲明:這是降低誤發風險的工程機制,不構成法律核准。
 *    詞表最終版須由台灣執業律師審定後以 LEGAL_WORDLIST_VERSION 標記。
 *
 * 規則:
 *  - BLOCKED:動作指示/獲利承諾/組合建議 → 直接擋下,拋出錯誤,留下日誌
 *  - REVIEW:傾向暗示/絕對化語氣/績效宣稱 → 放行但標記,進人工審核佇列
 *  - 績效宣稱(勝率/報酬率/打敗大盤)一律 REVIEW,禁止自動模板輸出
 */

export const WORDLIST_VERSION = "2026-07-26.pre-legal"; // 律師審定後更新

export const BLOCKED_TERMS: string[] = [
  // 動作指示
  "買進","买进","賣出","卖出","買入","买入","賣掉","卖掉",
  "加碼","加码","減碼","减码","清倉","清仓","空手",
  "布局","卡位","抄底","上車","上车","下車","下车",
  "長線持有","长线持有","短線觀望","短线观望","續抱","续抱",
  "逢低","逢高","低接","追高","真正買點","真正买点",
  "目標價","目标价","停損","止损","停利","止盈",
  "明牌","報明牌","报明牌","飆股","飙股",
  // 獲利承諾
  "穩賺","稳赚","保證獲利","保证获利","包賺","包赚",
  "必漲","必涨","必跌","零風險","零风险","躺賺","躺赚",
  "財富自由","财富自由","怎麼賺錢","怎么赚钱",
  // 組合建議(個人化外觀)
  "投資組合建議","投资组合建议","建議配置","建议配置",
  "均衡配置","你應該","你应该","建議你","建议你",
  // 過度詮釋(v3 新增:機構/造市商行為斷言)
  "磁吸","主力吸籌","主力吸筹","機構正在買","机构正在买","操控",
  // EN
  "buy now","strong buy","sell now","take profit","stop loss",
  "price target","guaranteed","risk-free","load up","dip buy",
  // JA
  "買い推奨","売り推奨","目標株価","損切り","必ず上がる",
];

export const REVIEW_TERMS: string[] = [
  "看多","看空","偏多","偏空","強勢","强势","弱勢","弱势",
  "機會","机会","值得","推薦","推荐","建議","建议",
  "一定","肯定","絕對","绝对",
  // 績效宣稱 → 人工審核,禁自動輸出
  "勝率","胜率","準確率","准确率","命中","打敗大盤","打败大盘",
  "報酬率","回报率","XIRR","穩定獲利","稳定获利",
  "recommend","should","must","opportunity","undervalued","win rate","beat the market",
];

export interface LintResult { ok: boolean; blocked: string[]; review: string[]; wordlistVersion: string; }

/**
 * 已核准固定樣板(免責聲明、時段說明)。
 * 原因:法規要求的免責文字必然含「建議 / advice」等 REVIEW 詞
 *      (例:「非投資建議」),不白名單則所有合規輸出都會被自己的免責聲明誤攔。
 * 影響:僅作用於 lint 的輸入預處理;詞表、三態判定與發送層邏輯不變。
 * 新增樣板必須是「逐字固定、經人工審定」的句子,不接受動態內容。
 */
export const DISCLAIMER = {
  "zh-TW": "本內容為市場資訊與投資教育,非投資建議,不含買賣指示。投資決策與風險由您自行承擔。",
  "zh-CN": "本内容为市场资讯与投资教育,非投资建议,不含买卖指示。投资决策与风险由您自行承担。",
  en: "Market information and education only. Not investment advice; never a buy or sell instruction.",
  ja: "市場情報および投資教育を目的とした内容です。投資助言ではなく、売買の指示も含みません。",
} as const;

export const APPROVED_BOILERPLATE: string[] = [
  ...Object.values(DISCLAIMER),
  "盤前/盤後為美股延長交易時段之泛稱;核心交易時段 09:30–16:00 ET 為三大交易所一致。",
];

/** 掃描前剔除已核准樣板,避免免責聲明觸發自身攔截 */
export function stripApprovedBoilerplate(text: string): string {
  let out = text ?? "";
  for (const b of APPROVED_BOILERPLATE) out = out.split(b).join(" ");
  return out;
}

export function lint(text: string): LintResult {
  const lower = stripApprovedBoilerplate(text).toLowerCase();
  const blocked = BLOCKED_TERMS.filter(t => lower.includes(t.toLowerCase()));
  const review = REVIEW_TERMS.filter(t => lower.includes(t.toLowerCase()));
  return { ok: blocked.length === 0, blocked, review, wordlistVersion: WORDLIST_VERSION };
}

export class ContentRiskError extends Error {
  context: string; blocked: string[];
  constructor(context: string, blocked: string[]) {
    super(`[contentRisk] blocked @${context}: ${blocked.join(", ")}`);
    this.context = context; this.blocked = blocked;
  }
}
export class ApprovalRequiredError extends Error {
  context: string; review: string[];
  constructor(context: string, review: string[]) {
    super(`[contentRisk] human approval required @${context}: ${review.join(", ")}`);
    this.context = context; this.review = review;
  }
}

/* ---------------- 發布決策與人工核准閘門(第四輪 P0) ---------------- */
import { createHash } from "node:crypto";
export const contentSha = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export type PublishDecision =
  | { mode: "auto_ok" }
  | { mode: "requires_approval"; review: string[] }
  | { mode: "blocked"; blocked: string[] };

export function publishDecision(text: string): PublishDecision {
  const r = lint(text);
  if (!r.ok) return { mode: "blocked", blocked: r.blocked };
  if (r.review.length) return { mode: "requires_approval", review: r.review };
  return { mode: "auto_ok" };
}

/** 人工核准紀錄:綁定內容 sha,內容改一字即失效 */
export interface ApprovalRecord { approvedBy: string; approvedAtIso: string; contentSha256: string; }
export function makeApproval(text: string, approvedBy: string): ApprovalRecord {
  return { approvedBy, approvedAtIso: new Date().toISOString(), contentSha256: contentSha(text) };
}
export function approvalValid(text: string, a: ApprovalRecord | undefined): boolean {
  return !!a && a.contentSha256 === contentSha(text) && !!a.approvedBy?.trim();
}

/**
 * 對外送出前必經(自動管線不帶 approval):
 *  - blocked:一律拋錯,人工核准也不能放行
 *  - requires_approval:無有效核准 → 拋 ApprovalRequiredError,自動發送被真正攔下
 */
export function assertPublishable(text: string, context = "", approval?: ApprovalRecord)
  : { text: string; review: string[] } {
  const d = publishDecision(text);
  if (d.mode === "blocked") throw new ContentRiskError(context, d.blocked);
  if (d.mode === "requires_approval") {
    if (!approvalValid(text, approval)) throw new ApprovalRequiredError(context, d.review);
    return { text, review: d.review };
  }
  return { text, review: [] };
}

/** @deprecated 僅偵測不攔 review;自動管線請改用 assertPublishable */
export function assertSafe(text: string, context = ""): { text: string; review: string[] } {
  const r = lint(text);
  if (!r.ok) throw new ContentRiskError(context, r.blocked);
  return { text, review: r.review };
}

/* ---------------- 狀態語言報告(五態定稿版) ---------------- */
export type MaggieState = "WATCHING" | "STRENGTHEN" | "NEUTRAL" | "WEAKENING" | "INVALIDATED";
type Lang = "zh-TW" | "zh-CN" | "en" | "ja";

const STATE_LABEL: Record<MaggieState, Record<Lang, string>> = {
  WATCHING:    { "zh-TW":"🟡 進入觀察", "zh-CN":"🟡 进入观察", en:"🟡 On watch",           ja:"🟡 注視開始" },
  STRENGTHEN:  { "zh-TW":"🟢 狀態增強", "zh-CN":"🟢 状态增强", en:"🟢 Case strengthening", ja:"🟢 条件強化" },
  NEUTRAL:     { "zh-TW":"⚪ 維持中性", "zh-CN":"⚪ 维持中性", en:"⚪ Neutral",            ja:"⚪ 中立維持" },
  WEAKENING:   { "zh-TW":"🟠 動能減弱", "zh-CN":"🟠 动能减弱", en:"🟠 Momentum fading",    ja:"🟠 勢い減衰" },
  INVALIDATED: { "zh-TW":"🔴 原判讀失效", "zh-CN":"🔴 原判读失效", en:"🔴 Thesis invalidated", ja:"🔴 前提無効" },
};
const L10N: Record<Lang, { why: string; watch: string; fail: string; cut: string; disc: string }> = {
  "zh-TW": { why:"為什麼進入觀察", watch:"接下來觀察什麼", fail:"什麼情況代表判讀失效", cut:"資料截至",
    disc:DISCLAIMER["zh-TW"] },
  "zh-CN": { why:"为什么进入观察", watch:"接下来观察什么", fail:"什么情况代表判读失效", cut:"数据截至",
    disc:DISCLAIMER["zh-CN"] },
  en: { why:"Why it is on watch", watch:"What to watch next", fail:"What would invalidate this", cut:"Data as of",
    disc:DISCLAIMER.en },
  ja: { why:"注視する理由", watch:"次に見る点", fail:"前提が崩れる条件", cut:"データ基準時点",
    disc:DISCLAIMER.ja },
};

export interface StateReportInput {
  ticker: string; state: MaggieState; lang: Lang;
  why: string[]; watch: string[]; invalidate: string[];
  dataCutoff: string; engineVersion: string;
}

export function buildStateReport(d: StateReportInput, approval?: ApprovalRecord)
  : { text: string; review: string[] } {
  const t = L10N[d.lang]; const li = (a: string[]) => a.map(s => `• ${s}`).join("\n");
  const body = [
    `${d.ticker} — ${STATE_LABEL[d.state][d.lang]}`, "",
    t.why, li(d.why), "", t.watch, li(d.watch), "", t.fail, li(d.invalidate), "",
    `${t.cut}: ${d.dataCutoff} | v${d.engineVersion} | wordlist ${WORDLIST_VERSION}`,
  ].join("\n");
  // 自動報告:blocked 擋死;review 詞無人工核准也擋死(第四輪 P0)
  const { review } = assertPublishable(body, `report:${d.ticker}`, approval);
  return { text: body + "\n" + t.disc, review };
}
