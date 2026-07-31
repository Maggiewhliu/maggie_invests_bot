/** 垂直切片 Dry Run:一位測試者 /start → 收到合規報告(不呼叫真 Telegram) */
import { handleCommand } from "../src/bot/commands.ts";
import { MemoryRecipientProvider } from "../src/providers/recipientAdapter.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";
import { MemoryPushStore } from "../src/pushCore.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";
import { ProvenanceLedger } from "../src/pipeline/artifactSeal.ts";

const transport = new MockTelegramTransport();
const ledger = new ProvenanceLedger();          // writer 只在 provider gateway
const deps = {
  recipients: new MemoryRecipientProvider(),
  quotes: new MockQuoteProvider(ledger),
  transport, store: new MemoryPushStore(),
  // Dry Run 用測試授權;正式須填入真實 grant
  license: new LicenseRegistry([{ supplier:"mock-fixture", dataset:"equity_daily_close",
    channels:["telegram"], jurisdictions:["TW"], uses:["derived_display"],
    validUntilIso:null, docRef:"DRYRUN-ONLY" }]),
  provenanceReader: ledger.reader(),           // 業務層只讀
  env: { F_BASIC_TA:"true", DATA_DERIVED_DISPLAY_OK:"true", ARTIFACT_HMAC_SECRET:"dryrun-secret" },
};
const who = { userId:"dryrun_user", chatId:"dryrun_chat" };
for (const cmd of ["/start", "/language zh", "/account", "/markets"]) {
  const r = await handleCommand(cmd, who, deps as any);
  console.log(`\n===== ${cmd} =====`);
  if (r.reply) console.log(r.reply);
  if (r.published) console.log("[delivery]", JSON.stringify(r.published));
}
console.log("\n===== Transport 實際送出 =====");
for (const m of transport.sent) console.log(`--- to ${m.chatId} ---\n${m.text}`);
