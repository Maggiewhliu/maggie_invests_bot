/**
 * src/bot/commands.ts — 第一版指令(垂直切片範圍)
 * /start /language /account /membership /markets /help
 * 每個指令都經過 tierAccess;/markets 走完整 publish 管線。
 */
import type { BotUser, RecipientProvider } from "../providers/recipientAdapter.ts";
import type { QuoteProvider } from "../providers/types.ts";
import type { TelegramTransport } from "../providers/telegramTransport.ts";
import type { PushStore } from "../pushCore.ts";
import { LicenseRegistry } from "../licenseRegistry.ts";
import { buildMarketReport, MARKET_ETFS, type Lang } from "../reports/marketReport.ts";
import { publish } from "../pipeline/publish.ts";
import { TIER_NAME, canAccess } from "../tierAccess.ts";
import { getMarketStatus } from "../marketClock.ts";
import { assertPublishable } from "../contentRiskGuard.ts";
import { sealDecisionArtifact, type ProvenanceReader } from "../pipeline/artifactSeal.ts";

export const MAG7 = ["AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA"];
/** 報告規格定案:大盤溫度計 4 檔 + 七巨頭 7 檔 = 11 檔 */
export const MARKET_SYMBOLS = [...MARKET_ETFS, ...MAG7];

const UI = {
  "zh-TW": {
    welcome: "歡迎使用 Maggie Stock AI。\n\n這裡提供美股市場資訊與投資教育,不提供投資建議、不代操、不報明牌。\n\n請選擇語言:輸入 /language zh 或 /language en",
    langSet: "語言已設定為繁體中文。",
    account: (t: string, tier: number) => `帳號狀態\n層級:${t}(Tier ${tier})\n\n輸入 /markets 查看美股市場狀態。`,
    membership: "會員層級\n\nLobby — 公開內容與市場資訊\nCertified — 七巨頭狀態與事件提醒(需驗證)\nVIP — S&P 500 查詢、完整判讀、事件提醒\nVVIP — 進階市場結構(尚未開放)\n\n付費功能開通中,目前為候補階段。",
    help: "可用指令\n/markets 美股市場狀態\n/account 我的層級\n/membership 會員說明\n/language 切換語言\n/help 說明",
    denied: (r: string) => `此功能目前不可用(${r})。`,
    noData: "市場資料目前不可用,不以估計值替代。",
    collecting: (m7: number, etf: number) =>
      `市場資料收集中。七巨頭資料:${m7}/7|大盤資料:${etf}/4。完整報告將於資料齊備後提供;不以殘缺資料產生正式報告。`,
    alreadySent: "本節點報告已送出且內容未有變化;下次市場狀態更新時會再通知。",
    processing: "報告正在處理中,請稍候再試。",
    tempUnavailable: "此報告暫時無法提供,已記入管理佇列;修復後會於下一節點恢復。",
  },
  en: {
    welcome: "Welcome to Maggie Stock AI.\n\nMarket information and investor education only — no investment advice, no managed accounts, no stock tips.\n\nSet language: /language zh or /language en",
    langSet: "Language set to English.",
    account: (t: string, tier: number) => `Account\nTier: ${t} (Tier ${tier})\n\nSend /markets for the US market state.`,
    membership: "Membership\n\nLobby — public content and market information\nCertified — Magnificent 7 state and event alerts (verification required)\nVIP — S&P 500 lookup, full judgments, event alerts\nVVIP — advanced market structure (not yet available)\n\nPaid tiers are in waitlist stage.",
    help: "Commands\n/markets US market state\n/account my tier\n/membership tiers\n/language switch language\n/help this message",
    denied: (r: string) => `This feature is unavailable (${r}).`,
    noData: "Market data is unavailable; no estimated values are substituted.",
    collecting: (m7: number, etf: number) =>
      `Collecting market data. Magnificent 7: ${m7}/7 | Market ETFs: ${etf}/4. The full report will be issued once data is complete; partial data never becomes an official report.`,
    alreadySent: "This report was already delivered and its content has not changed; you will be notified on the next state update.",
    processing: "Your report is being processed; please try again shortly.",
    tempUnavailable: "This report is temporarily unavailable and has been queued for admin review; it will resume at the next node.",
  },
} as const;

export interface BotDeps {
  recipients: RecipientProvider; quotes: QuoteProvider; transport: TelegramTransport;
  store: PushStore; license: LicenseRegistry;
  provenanceReader: ProvenanceReader;   // 只讀;寫入權在 provider gateway,業務層拿不到
  previewUserId?: string;               // 個人預覽白名單(僅此 user 走 internal_research)
  env?: Record<string, string | undefined>; now?: () => Date;
}

/** 單一真相：只有明確啟用且 user ID 符合的 owner 預覽可使用 internal_research。 */
export function marketLicenseUse(userId: string,
  env: Record<string, string | undefined>,
  previewUserId?: string | null): "internal_research" | "derived_display" {
  const ownerId = previewUserId ?? env["PERSONAL_PREVIEW_USER_ID"] ?? null;
  return env["PERSONAL_PREVIEW_ENABLED"] === "true" && ownerId != null && userId === ownerId
    ? "internal_research" : "derived_display";
}

export async function handleCommand(raw: string, from: { userId: string; chatId: string },
  deps: BotDeps): Promise<{ reply?: string; published?: unknown }> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const [cmd, ...args] = raw.trim().split(/\s+/);
  let user = await deps.recipients.get(from.userId);

  // /start:建立使用者(Tier 1 Lobby),不索取任何持倉資料
  if (cmd === "/start") {
    if (!user) {
      user = { userId: from.userId, chatId: from.chatId, tier: 1, lang: "zh-TW",
        jurisdiction: "TW", jurisdictionPaidAllowed: false };
      await deps.recipients.upsert(user);
    }
    return { reply: UI[user.lang].welcome };
  }
  if (!user) {
    // 自動補建(Memory 存儲重啟遺失 / 使用者未 /start):建 Lobby 後直接執行指令,不擋路
    user = { userId: from.userId, chatId: from.chatId, tier: 1, lang: "zh-TW",
      jurisdiction: "TW", jurisdictionPaidAllowed: false };
    await deps.recipients.upsert(user);
  }
  const t = UI[user.lang];

  switch (cmd) {
    case "/language": {
      const lang: Lang = args[0]?.startsWith("en") ? "en" : "zh-TW";
      await deps.recipients.upsert({ ...user, lang });
      return { reply: UI[lang].langSet };
    }
    case "/account":
      return { reply: t.account(TIER_NAME[user.tier], user.tier) };
    case "/membership":
      return { reply: t.membership };
    case "/help":
      return { reply: t.help };
    case "/markets": {
      const acc = canAccess({ tier: user.tier, jurisdictionPaidAllowed: user.jurisdictionPaidAllowed },
        "basic_indicators", env);
      if (!acc.allowed) return { reply: t.denied(acc.reason) };
      const snap = await deps.quotes.getQuotes(MARKET_SYMBOLS);
      if (!snap.data || snap.quality === "invalid") return { reply: t.noData };
      // 正式 Certified 報告最低完整條件:七巨頭 7/7 且 大盤 ETF 4/4,缺任一組不發布
      const got = new Set(snap.data.map(q => q.symbol));
      const m7 = MAG7.filter(s => got.has(s)).length;
      const etf = MARKET_ETFS.filter(s => got.has(s)).length;
      if (m7 < MAG7.length || etf < MARKET_ETFS.length)
        return { reply: t.collecting(m7, etf) };
      const repZh = buildMarketReport(snap, "zh-TW", now);
      const repEn = buildMarketReport(snap, "en", now);
      const rep = user.lang === "en" ? repEn : repZh;
      const st = getMarketStatus(now);
      const secret = env["ARTIFACT_HMAC_SECRET"] ?? "";
      // 授權用途:個人預覽 = internal_research;其餘 = derived_display(群組需 GRANTED 旗標放行)
      const licenseUse = marketLicenseUse(user.userId, env, deps.previewUserId);
      // 存證已在 provider adapter 的 ingestion gateway 完成;此處只讀。
      // 快取彙整視圖由多個批次組成 → 全部批次的存證一併入簽。
      const provIds = snap.provenanceIds?.length ? snap.provenanceIds
        : snap.provenanceId ? [snap.provenanceId] : [];
      if (!provIds.length) return { reply: t.denied("no_provenance") };
      const artifact = sealDecisionArtifact({
        decisionVersion: rep.decisionVersion, dataQuality: rep.dataQuality,
        provenanceIds: provIds,
        renderings: [ { lang: "zh-TW", text: repZh.text }, { lang: "en", text: repEn.text } ],
        primaryLang: user.lang,
        policy: { channel: "telegram", node: "on_demand_markets", etDate: st.etDate,
          candidateMode: "fixed", feature: "basic_indicators", minTier: 1,
          licenseUse },
      }, deps.provenanceReader, secret);
      // 單人查詢也走完整管線(去重鍵含 recipient,不會與群發衝突)
      const res = await publish({
        artifact,
        renderFor: (u) => (u.lang === "en" ? repEn : repZh).text,
      }, { store: deps.store, recipients: {
            expand: async () => [user!], get: deps.recipients.get.bind(deps.recipients),
            upsert: deps.recipients.upsert.bind(deps.recipients) },
          transport: deps.transport, license: deps.license, env });
      if (res.sent.length === 0) {
        const why = String(res.skipped[0]?.reason ?? res.blocked ?? res.candidateStatus);
        // Fix3:依 denied 具體原因回覆,不能把所有 denied 都說成已送出
        if (why === "denied_already_sent") return { reply: t.alreadySent, published: res };
        if (why === "denied_in_flight" || why === "denied_retry_backoff")
          return { reply: t.processing, published: res };
        if (why === "denied_failed_fatal" || why === "denied_attempts_exhausted") {
          console.error(`[admin-queue] fatal delivery for user=${user.userId} node=on_demand_markets`);
          return { reply: t.tempUnavailable, published: res };
        }
        return { reply: t.denied(why), published: res };
      }
      return { published: res };   // 已由 transport 送出,不重複回覆
    }
    default:
      return { reply: t.help };
  }
}
