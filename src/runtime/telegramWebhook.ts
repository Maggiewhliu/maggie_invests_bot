import type { BotDeps } from "../bot/commands.ts";
import { handleCommand } from "../bot/commands.ts";
import type { TelegramTransport } from "../providers/telegramTransport.ts";

export interface TelegramMessage {
  message_id?: number;
  text?: string;
  from?: { id: number; username?: string };
  chat?: { id: number | string };
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
}

export interface WebhookRuntimeDeps {
  bot: BotDeps;
  transport: TelegramTransport;
  allowedUserIds: Set<string>;
}

const restrictedReply = [
  "目前為 Preview 測試階段。",
  "請先輸入 /whoami 取得你的 Telegram user ID，",
  "再由管理員加入測試白名單。",
].join("\n");

/** 單一 Telegram Update 的純應用層處理；HTTP 驗證留在 server.ts。 */
export async function processTelegramUpdate(update: TelegramUpdate, deps: WebhookRuntimeDeps): Promise<void> {
  const msg = update.message;
  const text = msg?.text?.trim();
  const userId = msg?.from?.id == null ? "" : String(msg.from.id);
  const chatId = msg?.chat?.id == null ? "" : String(msg.chat.id);
  if (!text || !userId || !chatId) return;

  if (text === "/whoami") {
    await deps.transport.sendMessage(chatId, `你的 Telegram user ID：${userId}`);
    return;
  }

  const command = text.split(/\s+/, 1)[0];
  const publicPreviewCommand = command === "/start" || command === "/help";
  if (!publicPreviewCommand && !deps.allowedUserIds.has(userId)) {
    await deps.transport.sendMessage(chatId, restrictedReply);
    return;
  }

  const result = await handleCommand(text, { userId, chatId }, deps.bot);
  if (result.reply) await deps.transport.sendMessage(chatId, result.reply);
}

export function parseAllowedUserIds(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map(v => v.trim()).filter(v => /^\d+$/.test(v)));
}
