import assert from "node:assert/strict";
import test from "node:test";
import { processTelegramUpdate, parseAllowedUserIds } from "../src/runtime/telegramWebhook.ts";
import { MockTelegramTransport } from "../src/providers/telegramTransport.ts";

const update = (text: string, userId = 42) => ({
  update_id: 1,
  message: { text, from: { id: userId }, chat: { id: userId } },
});

test("/whoami 回傳自己的 ID，無須白名單", async () => {
  const transport = new MockTelegramTransport();
  await processTelegramUpdate(update("/whoami"), {
    transport,
    allowedUserIds: new Set(),
    bot: {} as any,
  });
  assert.match(transport.sent[0].text, /42/);
});

test("非公開指令未在白名單 → 不進 Bot 核心", async () => {
  const transport = new MockTelegramTransport();
  await processTelegramUpdate(update("/markets"), {
    transport,
    allowedUserIds: new Set(),
    bot: {} as any,
  });
  assert.match(transport.sent[0].text, /Preview/);
});

test("白名單解析只接受數字 ID", () => {
  assert.deepEqual([...parseAllowedUserIds("42, 99, bad, 42")], ["42", "99"]);
});
