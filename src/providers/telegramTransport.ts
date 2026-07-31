/**
 * src/providers/telegramTransport.ts — Telegram Bot API 薄封裝
 * 只負責「把已核准的訊息送出並回報結果」。不判斷市場節點、不判斷權限、
 * 不判斷措辭、不判斷是否已發過——那些全在 publish pipeline。
 */
export interface SendResult { ok: boolean; httpStatus: number | null; messageId?: number; retryAfterSec?: number; }
export interface TelegramTransport {
  /** P0-2:不可變頻道識別;publish 發送前強制 transport.channel === policy.channel */
  readonly channel: "telegram";
  sendMessage(chatId: string, text: string): Promise<SendResult>;
}

/** 正式實作:token 只從環境變數讀 */
export class LiveTelegramTransport implements TelegramTransport {
  readonly channel = "telegram" as const;
  private token: string;
  private timeoutMs: number;
  constructor(token: string, timeoutMs = 15_000) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");
    this.token = token; this.timeoutMs = timeoutMs;
  }
  async sendMessage(chatId: string, text: string): Promise<SendResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // P1:純文字送出(無 parse_mode)→ 動態內容無 HTML 注入面。
        // 未來若啟用 HTML 格式,動態欄位必須先經 escapeHtml()。
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: ctl.signal,
      });
      const body: any = await r.json().catch(() => ({}));
      if (r.ok) return { ok: true, httpStatus: 200, messageId: body?.result?.message_id };
      return { ok: false, httpStatus: r.status,
        retryAfterSec: body?.parameters?.retry_after };
    } catch {
      return { ok: false, httpStatus: null };   // 網路層 → retryable
    } finally { clearTimeout(timer); }
  }
}

/** 測試/Dry-Run:記錄所有送出內容,可注入失敗 */
export class MockTelegramTransport implements TelegramTransport {
  readonly channel = "telegram" as const;
  sent: { chatId: string; text: string }[] = [];
  private script: SendResult[];
  constructor(script: SendResult[] = []) { this.script = script; }
  async sendMessage(chatId: string, text: string): Promise<SendResult> {
    const next = this.script.shift();
    if (next && !next.ok) return next;              // 失敗不計入 sent
    this.sent.push({ chatId, text });
    return next ?? { ok: true, httpStatus: 200, messageId: this.sent.length };
  }
}

/** 未來啟用 parse_mode:"HTML" 時,所有動態欄位必經此函數 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
