/**
 * src/providers/recipientAdapter.ts — 收件人展開
 * 依「節點 × 受眾層級」展開成個別收件人;每人帶自己的 tier / 語言 / 法域。
 */
import type { Tier } from "../tierAccess.ts";

export interface BotUser {
  userId: string; chatId: string; tier: Tier;
  lang: "zh-TW" | "en"; jurisdiction: string; jurisdictionPaidAllowed: boolean;
  optedOut?: boolean;
}
export interface RecipientProvider {
  expand(minTier: Tier): Promise<BotUser[]>;
  get(userId: string): Promise<BotUser | undefined>;
  upsert(u: BotUser): Promise<void>;
}

export class MemoryRecipientProvider implements RecipientProvider {
  private m = new Map<string, BotUser>();
  async expand(minTier: Tier) {
    return [...this.m.values()].filter(u => u.tier >= minTier && !u.optedOut);
  }
  async get(id: string) { return this.m.get(id); }
  async upsert(u: BotUser) { this.m.set(u.userId, u); }
}
