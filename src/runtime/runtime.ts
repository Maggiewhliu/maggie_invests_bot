/**
 * src/runtime/runtime.ts — 部署接線工廠(可測試;server.ts 只是薄殼)
 * 組裝:ProvenanceLedger → MassiveQuoteProvider(writer) → QuoteCache
 *      → BotDeps(license/transport/recipients/store)→ handleTelegramUpdate
 */
import { ProvenanceLedger } from "../pipeline/artifactSeal.ts";
import { MassiveQuoteProvider } from "../providers/massiveQuoteProvider.ts";
import { QuoteCache } from "../pipeline/quoteCache.ts";
import { LiveTelegramTransport, type TelegramTransport } from "../providers/telegramTransport.ts";
import { MemoryRecipientProvider } from "../providers/recipientAdapter.ts";
import { MemoryPushStore } from "../pushCore.ts";
import { LicenseRegistry, type LicenseGrant } from "../licenseRegistry.ts";
import { handleCommand, MARKET_SYMBOLS, type BotDeps } from "../bot/commands.ts";

export interface RuntimeEnv { [k: string]: string | undefined; }

export function buildRuntime(env: RuntimeEnv, overrides: { transport?: TelegramTransport } = {}) {
  const ledger = new ProvenanceLedger();
  const massiveKey = env["MASSIVE_API_KEY"] ?? "";
  const upstream = new MassiveQuoteProvider(massiveKey, undefined, undefined,
    () => new Date(), ledger);
  const cache = new QuoteCache(upstream, MARKET_SYMBOLS, 5);

  const grants: LicenseGrant[] = [];
  // 個人預覽只授權明確指定的 owner 作 internal_research。
  if (env["PERSONAL_PREVIEW_ENABLED"] === "true") {
    grants.push({ supplier: "massive", dataset: "equity_daily_close",
      channels: ["telegram"], jurisdictions: ["TW"], uses: ["internal_research"],
      validUntilIso: null, docRef: "PERSONAL-PREVIEW-OWNER-ONLY" });
  }
  // 對外衍生顯示必須另有書面授權，不能由開發旗標冒充。
  if (env["MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED"] === "true") {
    grants.push({ supplier: "massive", dataset: "equity_daily_close",
      channels: ["telegram"], jurisdictions: ["TW"], uses: ["derived_display"],
      validUntilIso: null, docRef: env["MASSIVE_LICENSE_DOC_REF"] ?? "" });
  }

  const transport = overrides.transport
    ?? new LiveTelegramTransport(env["TELEGRAM_BOT_TOKEN"] ?? "");
  const deps: BotDeps = {
    recipients: new MemoryRecipientProvider(),   // ⚠️ Memory:重啟即失;正式換 Postgres
    quotes: cache,
    transport,
    store: new MemoryPushStore(),                // ⚠️ Memory:去重不跨重啟
    license: new LicenseRegistry(grants),
    provenanceReader: ledger.reader(),
    env,
  };
  return { deps, cache, ledger };
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
