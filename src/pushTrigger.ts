/**
 * src/pushTrigger.ts — 節點時間窗計算(v3:純函數,不保存狀態)
 * 發送狀態的唯一真相在 pushCore 的 PushStore;本模組只回答
 * 「此刻各節點的時間窗處於 before / open / past 哪個階段」。
 */
import { getMarketStatus } from "./marketClock.ts";

export type PushNode = "premarket_outlook" | "post_open_check" | "pre_close_check" | "close_summary";

/** 四節點定案:盤前/開盤後/收盤前=條件式;收盤摘要=固定候選(仍過資料品質關)。 */
export const NODES: { node: PushNode; time: (halfDay: boolean) => string; fixedCandidate: boolean }[] = [
  { node: "premarket_outlook", time: () => "08:30",                        fixedCandidate: false },
  { node: "post_open_check",   time: () => "10:00",                        fixedCandidate: false },
  { node: "pre_close_check",   time: (half) => (half ? "12:30" : "15:30"), fixedCandidate: false },
  { node: "close_summary",     time: (half) => (half ? "13:05" : "16:05"), fixedCandidate: true },
];

export const DEFAULT_WINDOW_MIN = 30;

export interface NodeWindow {
  node: PushNode; etDate: string; scheduledEt: string;
  fixedCandidate: boolean; phase: "before" | "open" | "past";
}

const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** 今天(交易日)各節點的時間窗階段;非交易日/未涵蓋年份 → 空陣列 */
export function windowsFor(now: Date = new Date(), windowMinutes = DEFAULT_WINDOW_MIN): NodeWindow[] {
  const s = getMarketStatus(now);
  if (!s.calendarCovered || !s.isTradingDay) return [];
  const nowMin = mins(s.etTime);
  return NODES.map((n) => {
    const scheduledEt = n.time(s.isHalfDay);
    const sm = mins(scheduledEt);
    const phase = nowMin < sm ? "before" : nowMin < sm + windowMinutes ? "open" : "past";
    return { node: n.node, etDate: s.etDate, scheduledEt, fixedCandidate: n.fixedCandidate, phase };
  });
}
