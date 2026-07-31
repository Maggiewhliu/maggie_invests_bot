/**
 * src/runtime/server.ts — Railway 進入點(薄殼)
 * 環境變數:TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / MASSIVE_API_KEY /
 *          ARTIFACT_HMAC_SECRET / DEV_LICENSE_MASSIVE / F_BASIC_TA / DATA_DERIVED_DISPLAY_OK / PORT
 * 路由:POST /webhook(驗 X-Telegram-Bot-Api-Secret-Token)· GET /health(快取狀態)
 */
import { createServer } from "node:http";
import { buildRuntime, handleTelegramUpdate } from "./runtime.ts";
import { startQuoteCacheLoop } from "../pipeline/quoteCache.ts";
import { MARKET_SYMBOLS } from "../bot/commands.ts";

const env = process.env;
for (const k of ["TELEGRAM_BOT_TOKEN", "ARTIFACT_HMAC_SECRET", "MASSIVE_API_KEY"]) {
  if (!env[k]) { console.error(`missing env: ${k}`); process.exit(1); }
}
const { deps, cache, botEnv } = buildRuntime(env);
startQuoteCacheLoop(cache, 65_000);            // 65s:貼不到 60s 限流視窗

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const snap = await cache.getQuotes(MARKET_SYMBOLS);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, env: botEnv, quality: snap.quality,
        cached: snap.data?.length ?? 0, want: MARKET_SYMBOLS.length,
        asOf: snap.asOf, notes: snap.notes }));
      return;
    }
    if (req.method === "POST" && req.url === "/webhook") {
      const expect = env["TELEGRAM_WEBHOOK_SECRET"];
      if (expect && req.headers["x-telegram-bot-api-secret-token"] !== expect) {
        res.writeHead(403); res.end(); return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200); res.end("ok");        // 先回 200,處理不阻塞 Telegram 重送
      handleTelegramUpdate(JSON.parse(body), deps).catch(e =>
        console.error("[update]", String(e).slice(0, 200)));
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) { console.error("[server]", String(e).slice(0, 200)); res.writeHead(500); res.end(); }
});
server.listen(Number(env["PORT"] ?? 8080), () =>
  console.log(`maggie-stock-ai [${botEnv}] up :${env["PORT"] ?? 8080}; cache loop 65s, batches ${JSON.stringify(cache.batches().map(b => b.length))}`));
