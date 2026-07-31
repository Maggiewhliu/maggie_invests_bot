import assert from "node:assert/strict";
import test from "node:test";
import { handleCommand, marketLicenseUse, type BotDeps } from "../src/bot/commands.ts";
import { MemoryRecipientProvider } from "../src/providers/recipientAdapter.ts";
import { MockQuoteProvider } from "../src/providers/mockQuoteProvider.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";
import { MemoryPushStore } from "../src/pushCore.ts";
import { LicenseRegistry } from "../src/licenseRegistry.ts";
import { ProvenanceLedger } from "../src/pipeline/artifactSeal.ts";

const SECRET = "personal-preview-test-secret";
const ENV = {
  F_BASIC_TA: "true",
  DATA_DERIVED_DISPLAY_OK: "false",
  ARTIFACT_HMAC_SECRET: SECRET,
  PERSONAL_PREVIEW_ENABLED: "true",
  PERSONAL_PREVIEW_USER_ID: "981883005",
};

const makeDeps = (ledger: ProvenanceLedger, transport: MockTelegramTransport): BotDeps => ({
  recipients: new MemoryRecipientProvider(),
  quotes: new MockQuoteProvider(ledger),
  transport,
  store: new MemoryPushStore(),
  license: new LicenseRegistry([{
    supplier: "mock-fixture",
    dataset: "equity_daily_close",
    channels: ["telegram"],
    jurisdictions: ["TW"],
    uses: ["internal_research"],
    validUntilIso: null,
    docRef: "PERSONAL-PREVIEW-OWNER-ONLY",
  }]),
  provenanceReader: ledger.reader(),
  env: ENV,
  now: () => new Date("2026-07-22T20:10:00Z"),
});

test("個人預覽只對指定 owner 使用 internal_research", async () => {
  assert.equal(marketLicenseUse("981883005", ENV), "internal_research");
  assert.equal(marketLicenseUse("123", ENV), "derived_display");

  const ledger = new ProvenanceLedger();
  const ownerTransport = new MockTelegramTransport();
  const owner = makeDeps(ledger, ownerTransport);
  await handleCommand("/start", { userId: "981883005", chatId: "c-owner" }, owner);
  const ok = await handleCommand("/markets", { userId: "981883005", chatId: "c-owner" }, owner);
  assert.equal((ok.published as any).sent.length, 1);
  assert.equal(ownerTransport.sent.length, 1);

  const otherTransport = new MockTelegramTransport();
  const other = makeDeps(new ProvenanceLedger(), otherTransport);
  await handleCommand("/start", { userId: "123", chatId: "c-other" }, other);
  const blocked = await handleCommand("/markets", { userId: "123", chatId: "c-other" }, other);
  assert.match(blocked.reply ?? "", /blocked_license/);
  assert.equal(otherTransport.sent.length, 0);
});
