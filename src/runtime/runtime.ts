/**
 * src/runtime/runtime.ts — 部署接線工廠(可測試;server.ts 只是薄殼)
 * 組裝:ProvenanceLedger → MassiveQuoteProvider(writer) → QuoteCache
 *      → BotDeps(license/transport/recipients/store)→ handleTelegramUpdate
 */
import { ProvenanceLedger } from "../pipeline/artifactSeal.ts";
import { MassiveQuoteProvider } from "../providers/massiveQuoteProvider.ts";
import { QuoteCache } from "../pipeline/quoteCache.ts";
import { LiveTelegramTransport, type TelegramTransport } from "../providers/telegramTransport.ts";
import { FileRecipientProvider } from "../providers/fileRecipientProvider.ts";
import { MemoryPushStore } from "../pushCore.ts";
import { LicenseRegistry, type LicenseGrant } from "../licenseRegistry.ts";
import { handleCommand, MARKET_SYMBOLS, type BotDeps } from "../bot/commands.ts";

export interface RuntimeEnv { [k: string]: string | undefined; }

export function buildRuntime(env: RuntimeEnv, overrides: { transport?: TelegramTransport } = {}) {
  const ledger = new ProvenanceLedger();
  const massiveKey = env["MASSIVE_API_KEY"] ?? "";
  const upstream = new MassiveQuoteProvider(massiveKey, undefined, "https://api.polygon.io",
    () => new Date(), ledger);
  const cache = new QuoteCache(upstream, MARKET_SYMBOLS, 5);

  const grants: LicenseGrant[] = [];
  // 個人預覽:僅 internal_research 用途;Maggie 本人私訊可預覽,不等於對外 derived_display
  const previewUserId = env["PERSONAL_PREVIEW_ENABLED"] === "true"
    ? (env["PERSONAL_PREVIEW_USER_ID"] ?? null) : null;
  if (previewUserId) {
    grants.push({ supplier: "massive", dataset: "equity_daily_close",
      channels: ["telegram"], jurisdictions: ["*"], uses: ["internal_research"],
      validUntilIso: null, docRef: "PERSONAL-PREVIEW(internal_research;非對外散布)" });
  }
  // 群組/對外 derived_display:唯有取得書面授權旗標才放行(預設 false)
  if (env["MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED"] === "true") {
    grants.push({ supplier: "massive", dataset: "equity_daily_close",
      channels: ["telegram"], jurisdictions: ["*"], uses: ["derived_display"],
      validUntilIso: null, docRef: env["MASSIVE_LICENSE_DOCREF"] ?? "MASSIVE-WRITTEN-LICENSE" });
  }

  const transport = overrides.transport
    ?? new LiveTelegramTransport(env["TELEGRAM_BOT_TOKEN"] ?? "");
  // 雙環境:production(舊帳號新 token)/ staging(測試 Bot);純由環境變數區分
  const botEnv = env["BOT_ENV"] ?? "staging";
  // 預備社群收件人(GROUP_CHAT_ID):僅註冊為 Tier2 收件目標,四節點群發仍受發布管線全部閘門管制
  const recipients = new FileRecipientProvider(env["USERS_FILE"] ?? `/tmp/maggie-users-${botEnv}.json`);
  if (env["GROUP_CHAT_ID"]) {
    void recipients.upsert({ userId: `group:${env["GROUP_CHAT_ID"]}`, chatId: env["GROUP_CHAT_ID"]!,
      tier: 2, lang: (env["GROUP_LANG"] === "en" ? "en" : "zh-TW"),
      jurisdiction: "TW", jurisdictionPaidAllowed: false });
  }
  const deps: BotDeps = {
    recipients,   // 檔案版:同容器跨重啟存活;容器重建仍失。正式換 Postgres。
    quotes: cache,
    transport,
    store: new MemoryPushStore(),                // ⚠️ Memory:去重不跨重啟
    license: new LicenseRegistry(grants),
    provenanceReader: ledger.reader(),
    previewUserId: previewUserId ?? undefined,
    env,
  };
  return { deps, cache, ledger, botEnv };
}

/** Telegram webhook update → 指令處理;純回覆(reply)也經 transport 送出 */
export async function handleTelegramUpdate(update: any, deps: BotDeps): Promise<void> {
  const msg = update?.message;
  const text: string | undefined = msg?.text;
  const chatId = msg?.chat?.id;
  const userId = msg?.from?.id;
  if (!text || chatId == null || userId == null) return;
  if (!text.startsWith("/")) return;             // 非指令不回應(群組雜訊)
  const r = await handleCommand(text, { userId: String(userId), chatId: String(chatId) }, deps);
  if (r.reply) await deps.transport.sendMessage(String(chatId), r.reply);
}
