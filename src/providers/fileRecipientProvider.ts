/**
 * src/providers/fileRecipientProvider.ts — 檔案持久化使用者存儲
 * 目的:Memory 版在行程重啟後歸零,導致語言設定遺失。
 * 本實作把使用者寫入 JSON 檔(同一容器內跨重啟存活)。
 * ⚠️ 仍非正式方案:容器重建即失;正式以 PostgreSQL(users/identities 表)為準。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BotUser, RecipientProvider } from "./recipientAdapter.ts";
import type { Tier } from "../tierAccess.ts";

export class FileRecipientProvider implements RecipientProvider {
  private m = new Map<string, BotUser>();
  private path: string;
  constructor(path: string) {
    this.path = path;
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        if (Array.isArray(raw)) for (const u of raw) if (u?.userId) this.m.set(u.userId, u);
      }
    } catch { /* 壞檔視同空;不炸啟動 */ }
  }
  private persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.m.values()]), "utf8");
    } catch (e) { console.error("[recipients] persist failed:", String(e).slice(0, 120)); }
  }
  async expand(minTier: Tier) {
    return [...this.m.values()].filter(u => u.tier >= minTier && !u.optedOut);
  }
  async get(id: string) { return this.m.get(id); }
  async upsert(u: BotUser) { this.m.set(u.userId, u); this.persist(); }
}
