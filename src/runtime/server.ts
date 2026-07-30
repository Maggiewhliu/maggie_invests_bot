import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { startQuoteCacheLoop } from "../pipeline/quoteCache.ts";
import { MARKET_SYMBOLS } from "../bot/commands.ts";
import { buildRuntime, handleTelegramUpdate } from "./runtime.ts";

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

const { deps: bot, cache: quotes } = buildRuntime({
  ...process.env, TELEGRAM_BOT_TOKEN: token,
  MASSIVE_API_KEY: massiveKey, ARTIFACT_HMAC_SECRET: artifactSecret,
});
startQuoteCacheLoop(quotes, 65_000);
const allowedUserIds = new Set((process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean));

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
    const snap = await quotes.getQuotes(MARKET_SYMBOLS);
    json(res, 200, {
      ok: true, service: "maggie-invests-bot", mode: "personal-preview",
      quality: snap.quality, cached: snap.data?.length ?? 0,
      want: MARKET_SYMBOLS.length, asOf: snap.asOf, notes: snap.notes,
    });
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
    const update = await readJson(req) as any;
    const userId = String(update?.message?.from?.id ?? "");
    if (allowedUserIds.size === 0 || allowedUserIds.has(userId))
      await handleTelegramUpdate(update, bot);
    json(res, 200, { ok: true });
  } catch (error) {
    console.error("telegram update failed", error);
    json(res, 200, { ok: true });
  }
});

server.listen(port, () => {
  console.log(`maggie-invests-bot preview listening on :${port}; quote cache 65s`);
});
