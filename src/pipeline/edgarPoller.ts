/**
 * src/pipeline/edgarPoller.ts — 獨立 EDGAR 事件輪詢器 v2
 *
 * P0-1 Bootstrap:新 CIK 首次輪詢預設 seed_only —— 只建立 cursor、零通知,
 *   杜絕「首次部署/資料庫重建 → 歷史事件洪水」。歷史回填只能 backfill_shadow,
 *   項目帶 shadow=true,永不成為 Live high candidate。
 * P0-2 冪等與故障隔離:EventInbox 改 putIfAbsent(eventId = cik:accession),
 *   每筆 inserted/exists 後「立即」逐筆推進 cursor;單筆 inbox/cursor 失敗
 *   記 errors 並繼續,不中斷其他事件與其他 CIK。
 */
import type { EdgarEventAdapter, EdgarEvent, EdgarFormType } from "../providers/edgarEventAdapter.ts";

export type Importance = "high" | "normal";
export const IMPORTANCE: Record<EdgarFormType, Importance> = {
  "8-K": "high", "8-K/A": "high", "13D": "high", "13D/A": "high",
  "4": "normal", "4/A": "normal", "13G": "normal", "13G/A": "normal",
};

export type BootstrapMode = "seed_only" | "backfill_shadow";

export interface CursorStore {
  /** 是否已為該 CIK 建立過 cursor(區分「從未看過」與「看過但空」) */
  initialized(cik: string): Promise<boolean>;
  seen(cik: string): Promise<Set<string>>;
  markSeen(cik: string, accessions: string[]): Promise<void>;
}
export class MemoryCursorStore implements CursorStore {
  private m = new Map<string, Set<string>>();
  async initialized(cik: string) { return this.m.has(cik); }
  async seen(cik: string) { return new Set(this.m.get(cik) ?? []); }
  async markSeen(cik: string, accs: string[]) {
    const s = this.m.get(cik) ?? new Set<string>();
    for (const a of accs) s.add(a);
    this.m.set(cik, s);
  }
}

export interface InboxItem {
  eventId: string;              // `${cik}:${accessionNumber}` — 冪等鍵(Postgres 加 UNIQUE)
  event: EdgarEvent;
  importance: Importance;
  shadow: boolean;              // backfill 項目=true,永不 Live
  enqueuedAt: string;
}
export interface EventInbox {
  putIfAbsent(item: InboxItem): Promise<"inserted" | "exists">;
}
export class MemoryEventInbox implements EventInbox {
  items = new Map<string, InboxItem>();
  async putIfAbsent(item: InboxItem): Promise<"inserted" | "exists"> {
    if (this.items.has(item.eventId)) return "exists";   // 與 Postgres UNIQUE 相同語義
    this.items.set(item.eventId, item);
    return "inserted";
  }
}

export const eventIdOf = (ev: EdgarEvent) => `${ev.cik}:${ev.accessionNumber}`;

export interface PollResult {
  scanned: number;
  seeded: number;               // 本輪首次建立 cursor 的 CIK 數(seed_only)
  newEvents: number;            // Live 入箱(inserted)
  duplicates: number;           // putIfAbsent 回 exists(重跑復原)
  high: number; normal: number; // 僅計 Live 項目
  shadowBackfilled: number;     // backfill_shadow 入箱數(不計 high/normal)
  errors: { cik: string; note: string }[];
}

export async function pollOnce(adapter: EdgarEventAdapter, watchCiks: string[],
  cursor: CursorStore, inbox: EventInbox,
  opts: { bootstrapMode?: BootstrapMode; now?: () => Date } = {}): Promise<PollResult> {
  const mode: BootstrapMode = opts.bootstrapMode ?? "seed_only";   // 預設不洪水
  const now = opts.now ?? (() => new Date());
  const res: PollResult = { scanned: 0, seeded: 0, newEvents: 0, duplicates: 0,
    high: 0, normal: 0, shadowBackfilled: 0, errors: [] };

  for (const rawCik of watchCiks) {
    res.scanned++;
    try {
      const snap = await adapter.getRecentEvents(rawCik);
      if (snap.data === null) {                  // null 僅代表失敗/不可用
        res.errors.push({ cik: rawCik, note: (snap.notes ?? []).join("; ") || "unavailable" });
        continue;
      }
      // cursor 鍵一律用零填充 CIK(空陣列時也一致),不依賴事件內容
      const cik = snap.symbolsRequested?.[0] ?? rawCik;
      const isNew = !(await cursor.initialized(cik));

      // P0-1:首次看到此 CIK
      if (isNew && mode === "seed_only") {
        await cursor.markSeen(cik, snap.data.map(e => e.accessionNumber));  // 只建 cursor
        res.seeded++;
        continue;                                                            // 零通知
      }

      const seen = await cursor.seen(cik);
      const fresh = snap.data.filter(e => !seen.has(e.accessionNumber));
      const asShadow = isNew && mode === "backfill_shadow";

      // P0-2:逐筆入箱 → 逐筆推進 cursor;單筆失敗記 errors 續行
      for (const ev of fresh) {
        try {
          const item: InboxItem = { eventId: eventIdOf(ev), event: ev,
            importance: IMPORTANCE[ev.formType], shadow: asShadow,
            enqueuedAt: now().toISOString() };
          const outcome = await inbox.putIfAbsent(item);
          if (outcome === "inserted") {
            if (asShadow) res.shadowBackfilled++;
            else { res.newEvents++; item.importance === "high" ? res.high++ : res.normal++; }
          } else res.duplicates++;                 // 已存在=前輪已入箱,cursor 補推進即可
          await cursor.markSeen(cik, [ev.accessionNumber]);   // 立即逐筆推進
        } catch (e) {
          res.errors.push({ cik, note: `${ev.accessionNumber}: ${String(e).slice(0, 60)}` });
          // 不推進此筆 cursor → 下一輪重試;putIfAbsent 冪等保證不重複
        }
      }
    } catch (e) {
      res.errors.push({ cik: rawCik, note: String(e).slice(0, 60) });        // CIK 間隔離
    }
  }
  return res;
}
