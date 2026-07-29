import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { MemoryRecipientProvider } from "../providers/recipientAdapter.ts";
import { LiveTelegramTransport } from "../providers/telegramTransport.ts";
import { MassiveQuoteProvider } from "../providers/massiveQuoteProvider.ts";
import { MemoryPushStore } from "../pushCore.ts";
import { LicenseRegistry, type LicenseGrant } from "../licenseRegistry.ts";
import { ProvenanceLedger } from "../pipeline/artifactSeal.ts";
import { parseAllowedUserIds, processTelegramUpdate, type TelegramUpdate } from "./telegramWebhook.ts";

const required = (name: string, minLength = 1): string => {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < minLength) throw new Error(`${name} missing or too short`);
  return value;
};

const token = required("TELEGRAM_BOT_TOKEN", 20);
const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET", 24);
const artifactSecret = required("ARTIFACT_HMAC_SECRET", 32);
const massiveKey = required("MASSIVE_API_KEY", 8);
const port = Number(process.env.PORT ?? "3000");

const ledger = new ProvenanceLedger();
const recipients = new MemoryRecipientProvider();
const transport = new LiveTelegramTransport(token);
const quotes = new MassiveQuoteProvider(massiveKey, undefined, undefined, undefined, ledger);
const store = new MemoryPushStore();
const grants: LicenseGrant[] = [];
const personalPreviewEnabled = process.env.PERSONAL_PREVIEW_ENABLED === "true";
if (personalPreviewEnabled) {
  const ownerId = required("PERSONAL_PREVIEW_USER_ID", 1);
  if (!/^\d+$/.test(ownerId)) throw new Error("PERSONAL_PREVIEW_USER_ID must be numeric");
  grants.push({
    supplier: "massive",
    dataset: "equity_daily_close",
    channels: ["telegram"],
    jurisdictions: ["TW"],
    uses: ["internal_research"],
    validUntilIso: null,
    docRef: "PERSONAL-PREVIEW-OWNER-ONLY",
  });
}
if (process.env.MASSIVE_TELEGRAM_DERIVED_DISPLAY_GRANTED === "true") {
  grants.push({
    supplier: "massive",
    dataset: "equity_daily_close",
    channels: ["telegram"],
    jurisdictions: ["TW"],
    uses: ["derived_display"],
    validUntilIso: null,
    docRef: required("MASSIVE_LICENSE_DOC_REF", 3),
  });
}
const license = new LicenseRegistry(grants);
const allowedUserIds = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
const bot = {
  recipients, quotes, transport, store, license,
  provenanceReader: ledger.reader(),
  env: { ...process.env, ARTIFACT_HMAC_SECRET: artifactSecret },
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const sameSecret = (provided: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("payload too large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true, service: "maggie-invests-bot", mode: "preview" });
    return;
  }
  if (req.method !== "POST" || req.url !== "/telegram/webhook") {
    json(res, 404, { ok: false });
    return;
  }
  const supplied = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
  if (!sameSecret(supplied)) {
    json(res, 401, { ok: false });
    return;
  }
  try {
    const update = await readJson(req) as TelegramUpdate;
    // Telegram 要求快速 2xx；處理失敗記錄，但不讓它無限重送同一 update。
    await processTelegramUpdate(update, { bot, transport, allowedUserIds });
    json(res, 200, { ok: true });
  } catch (error) {
    console.error("telegram update failed", error);
    json(res, 200, { ok: true });
  }
});

server.listen(port, () => {
  console.log(`maggie-invests-bot preview listening on :${port}`);
});
