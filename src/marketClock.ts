/**
 * src/marketClock.ts — 美股市場時鐘(單一事實來源)
 * 網站狀態列與 Bot 推播節點共用。NYSE / Nasdaq / NYSE American 共用同一交易日曆。
 *
 * 原則:
 *  - 所有判定以 America/New_York 為準(自動處理夏令時間)
 *  - 假日與半日表為顯式資料,超出涵蓋年份回傳 unknown 並警告,不猜
 *  - 不含任何市場數據,純日曆邏輯,零授權問題
 */

/** 日曆版本管理:每年由官方來源更新,superseded 版本保留稽核 */
export const CALENDAR_META = {
  version: "2026-2027.v1",
  source: "NYSE Hours & Calendars (nyse.com/markets/hours-calendars); Nasdaq trading schedule",
  coveredYears: [2026, 2027],
  updateTask: "每年 Q4 由官方頁面核對次年假日/半日表後發新版",
} as const;

/**
 * Session 命名聲明:premarket/afterhours 指「美股延長交易時段」(consolidated
 * extended hours),非三家交易所各自的正式 session 規則;核心交易時段
 * (09:30–16:00 ET) 三家一致,延長時段以泛稱顯示,不宣稱三家規則完全相同。
 */
export const SESSION_DISPLAY_NOTE =
  "盤前/盤後為美股延長交易時段之泛稱;核心交易時段 09:30–16:00 ET 為三大交易所一致。";

export type SessionState =
  | "premarket"      // 04:00–09:30 ET
  | "regular"        // 09:30–16:00 ET (半日 09:30–13:00)
  | "afterhours"     // 16:00–20:00 ET (半日 13:00–17:00)
  | "closed"         // 其他時間/週末/假日
  | "unknown";       // 超出日曆涵蓋範圍

export interface MarketStatus {
  state: SessionState;
  isTradingDay: boolean;
  isHalfDay: boolean;
  holidayName: string | null;
  etDate: string;          // 'YYYY-MM-DD' (美東)
  etTime: string;          // 'HH:MM' (美東)
  nextEvent: { label: "open" | "close" | "premarket_open"; etDate: string; etTime: string } | null;
  calendarCovered: boolean;
  calendarVersion: string;
  warnings: string[];
}

/** 全市場休市日(NYSE/Nasdaq/AMEX 相同) */
const HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving Day",
  "2026-12-25": "Christmas Day",
  // 2027
  "2027-01-01": "New Year's Day",
  "2027-01-18": "Martin Luther King Jr. Day",
  "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday",
  "2027-05-31": "Memorial Day",
  "2027-06-18": "Juneteenth (observed)",
  "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day",
  "2027-11-25": "Thanksgiving Day",
  "2027-12-24": "Christmas Day (observed)",
};

/** 半日(13:00 ET 收盤) */
const HALF_DAYS: Record<string, string> = {
  "2026-11-27": "Day after Thanksgiving",
  "2026-12-24": "Christmas Eve",
  "2027-11-26": "Day after Thanksgiving",
};

const COVERED_YEARS = new Set([2026, 2027]);

/** 取美東的日期、時間、星期(用 Intl 正確處理 DST) */
function etParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}`,
    minutes: parseInt(hour, 10) * 60 + parseInt(p.minute, 10),
    weekday: p.weekday as "Mon"|"Tue"|"Wed"|"Thu"|"Fri"|"Sat"|"Sun",
    year: parseInt(p.year, 10),
  };
}

function isWeekend(w: string) { return w === "Sat" || w === "Sun"; }

function dayInfo(dateStr: string, weekday: string) {
  const holiday = HOLIDAYS[dateStr] ?? null;
  const halfDay = dateStr in HALF_DAYS;
  const trading = !isWeekend(weekday) && !holiday;
  return { holiday, halfDay, trading };
}

/** 從某時刻起找下一個交易日(往後最多掃 10 天) */
function nextTradingDay(from: Date): { date: string; half: boolean } | null {
  for (let i = 1; i <= 10; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const p = etParts(d);
    if (!COVERED_YEARS.has(p.year)) return null;
    const info = dayInfo(p.date, p.weekday);
    if (info.trading) return { date: p.date, half: info.halfDay };
  }
  return null;
}

export function getMarketStatus(now: Date = new Date()): MarketStatus {
  const p = etParts(now);
  const warnings: string[] = [];
  const covered = COVERED_YEARS.has(p.year);
  if (!covered) warnings.push(`calendar does not cover year ${p.year} — returning unknown`);

  const { holiday, halfDay, trading } = dayInfo(p.date, p.weekday);
  const closeMin = halfDay ? 13 * 60 : 16 * 60;          // 13:00 或 16:00
  const afterEnd = halfDay ? 17 * 60 : 20 * 60;           // 盤後結束
  const base = {
    isTradingDay: trading, isHalfDay: halfDay, holidayName: holiday,
    etDate: p.date, etTime: p.time, calendarCovered: covered,
    calendarVersion: CALENDAR_META.version, warnings,
  };

  if (!covered) return { ...base, state: "unknown", nextEvent: null };

  // 今日為交易日時的節點判定
  if (trading) {
    if (p.minutes >= 240 && p.minutes < 570)
      return { ...base, state: "premarket",
        nextEvent: { label: "open", etDate: p.date, etTime: "09:30" } };
    if (p.minutes >= 570 && p.minutes < closeMin)
      return { ...base, state: "regular",
        nextEvent: { label: "close", etDate: p.date, etTime: halfDay ? "13:00" : "16:00" } };
    if (p.minutes >= closeMin && p.minutes < afterEnd) {
      const nxt = nextTradingDay(now);
      return { ...base, state: "afterhours",
        nextEvent: nxt ? { label: "premarket_open", etDate: nxt.date, etTime: "04:00" } : null };
    }
    if (p.minutes < 240)
      return { ...base, state: "closed",
        nextEvent: { label: "premarket_open", etDate: p.date, etTime: "04:00" } };
  }
  // 收盤/週末/假日 → 指向下一個交易日
  const nxt = nextTradingDay(now);
  return { ...base, state: "closed",
    nextEvent: nxt ? { label: "premarket_open", etDate: nxt.date, etTime: "04:00" } : null };
}

/** 最近一個「已完成」的交易時段日期(ET)。
 *  今天是交易日且已過收盤(半日 13:00 / 全日 16:00)→ 今天;否則回溯前一交易日。 */
export function lastCompletedSessionDate(now: Date = new Date()): string | null {
  for (let d = 0; d <= 10; d++) {
    const probe = new Date(now.getTime() - d * 86_400_000);
    const s = getMarketStatus(probe);
    if (!s.calendarCovered) return null;
    if (!s.isTradingDay) continue;
    if (d === 0) {
      const [h, m] = s.etTime.split(":").map(Number);
      const closeMin = s.isHalfDay ? 13 * 60 : 16 * 60;
      if (h * 60 + m >= closeMin) return s.etDate;
      continue;
    }
    return s.etDate;
  }
  return null;
}
