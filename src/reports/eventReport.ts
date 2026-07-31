/**
 * src/reports/eventReport.ts — EDGAR 事件「事實模板」(zh-TW / en)
 *
 * 措辭邊界(封板定案,Form 4 XML Parser 完成前):
 *  只陳述:表單類型、Period of Report、申報日、延遲天數、SEC 原文連結。
 *  禁止:買賣方向、股數、價格、"高管突然賣出" 等任何結論或詮釋。
 */
import type { EdgarEvent } from "../providers/edgarEventAdapter.ts";
import { DISCLAIMER } from "../contentRiskGuard.ts";

export type Lang = "zh-TW" | "en";

const FORM_LABEL: Record<string, Record<Lang, string>> = {
  "4":     { "zh-TW": "內部人持股申報(Form 4)",        en: "Insider filing (Form 4)" },
  "4/A":   { "zh-TW": "內部人持股申報修正(Form 4/A)",   en: "Insider filing amendment (Form 4/A)" },
  "8-K":   { "zh-TW": "重大事件申報(8-K)",              en: "Current report (8-K)" },
  "8-K/A": { "zh-TW": "重大事件申報修正(8-K/A)",        en: "Current report amendment (8-K/A)" },
  "13D":   { "zh-TW": "大額持股申報(Schedule 13D)",     en: "Beneficial ownership (Schedule 13D)" },
  "13D/A": { "zh-TW": "大額持股申報修正(13D/A)",        en: "Beneficial ownership amendment (13D/A)" },
  "13G":   { "zh-TW": "大額持股申報(Schedule 13G)",     en: "Beneficial ownership (Schedule 13G)" },
  "13G/A": { "zh-TW": "大額持股申報修正(13G/A)",        en: "Beneficial ownership amendment (13G/A)" },
};
const L = {
  "zh-TW": { period: "Period of Report", filed: "申報日", delay: "申報延遲",
    days: "天", unknown: "未提供", src: "SEC 原始文件",
    note: "以上為 SEC 公開申報之事實摘要,未解析交易方向與金額;完整內容以原始文件為準。" },
  en: { period: "Period of Report", filed: "Filed", delay: "Filing delay",
    days: "day(s)", unknown: "not provided", src: "SEC source document",
    note: "Factual summary of a public SEC filing. Direction and amounts are not parsed; refer to the source document." },
} as const;

export function delayDays(ev: EdgarEvent): number | null {
  if (!ev.eventDate) return null;
  const ms = Date.parse(ev.filedAt) - Date.parse(ev.eventDate);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86_400_000)) : null;
}

/** 單一事件的事實行(不含免責;彙整層統一附掛) */
export function renderEventFact(ev: EdgarEvent, lang: Lang): string {
  const t = L[lang];
  const label = FORM_LABEL[ev.formType]?.[lang] ?? ev.formType;
  const who = ev.ticker ? `${ev.ticker}(${ev.companyName})` : ev.companyName;
  const d = delayDays(ev);
  const lines = [
    `📄 ${who} — ${label}`,
    `   ${t.period}: ${ev.eventDate ?? t.unknown} | ${t.filed}: ${ev.filedAt}`
      + (d !== null ? ` | ${t.delay}: ${d} ${t.days}` : ""),
    `   ${t.src}: ${ev.primaryDocUrl}`,
  ];
  return lines.join("\n");
}

/** 多事件彙整(進四節點摘要用);附免責與事實聲明 */
export function renderEventDigest(events: EdgarEvent[], lang: Lang): string {
  const t = L[lang];
  const body = events.map(e => renderEventFact(e, lang)).join("\n\n");
  return `${body}\n\n${t.note}\n${DISCLAIMER[lang === "en" ? "en" : "zh-TW"]}`;
}
