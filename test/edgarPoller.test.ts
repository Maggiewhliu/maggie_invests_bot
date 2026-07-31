import assert from "node:assert/strict";
import test from "node:test";
import { EdgarEventAdapter, RateLimiter, type HttpGetJson,
  type EdgarEvent } from "../src/providers/edgarEventAdapter.ts";
import { pollOnce, MemoryCursorStore, MemoryEventInbox, IMPORTANCE,
  eventIdOf, type InboxItem } from "../src/pipeline/edgarPoller.ts";
import { renderEventFact, renderEventDigest, delayDays } from "../src/reports/eventReport.ts";
import { lint } from "../src/contentRiskGuard.ts";

const CIK = "0000320193";
const TICKERS = JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
const subs = (rows: { acc: string; form: string; filed: string; report?: string }[]) => JSON.stringify({
  name: "Apple Inc.",
  filings: { recent: {
    accessionNumber: rows.map(r => r.acc), form: rows.map(r => r.form),
    filingDate: rows.map(r => r.filed), reportDate: rows.map(r => r.report ?? ""),
    primaryDocument: rows.map(() => "doc.htm"),
  }},
});
const mkHttp = (bodyRef: { v: string }): HttpGetJson => async (url) => {
  if (url.includes("company_tickers")) return { status: 200, text: async () => TICKERS };
  return { status: 200, text: async () => bodyRef.v };
};
const adapter = (bodyRef: { v: string }) =>
  new EdgarEventAdapter("test@maggie.ai", mkHttp(bodyRef), null, "https://www.sec.gov", new RateLimiter(0));
const HIST = [
  { acc:"H-1", form:"8-K", filed:"2026-07-01", report:"2026-07-01" },
  { acc:"H-2", form:"SC 13D", filed:"2026-07-02", report:"2026-07-01" },
  { acc:"H-3", form:"4", filed:"2026-07-03", report:"2026-07-02" },
];

test("模板:只有事實與 SEC 連結,零方向詞,lint 乾淨且 review 空", () => {
  const ev: EdgarEvent = { accessionNumber:"X-1", formType:"4", rawFormType:"4",
    cik:CIK, ticker:"AAPL", companyName:"Apple Inc.", filedAt:"2026-07-20",
    eventDate:"2026-07-18", isAmendment:false,
    primaryDocUrl:"https://www.sec.gov/Archives/edgar/data/320193/x/doc.xml" };
  for (const lang of ["zh-TW","en"] as const) {
    const text = renderEventFact(ev, lang);
    for (const bad of ["買進","賣出","高管突然","bought","sold","dumped"])
      assert.equal(text.toLowerCase().includes(bad.toLowerCase()), false);
    const r = lint(renderEventDigest([ev], lang));
    assert.equal(r.ok, true); assert.deepEqual(r.review, []);
  }
  assert.equal(delayDays({ ...ev, eventDate: null }), null);
});
test("P0-1 首次啟動 seed_only:空 cursor 第一輪 newEvents=0 只建 cursor", async () => {
  const body = { v: subs(HIST) };
  const a = adapter(body); const cur = new MemoryCursorStore(); const inbox = new MemoryEventInbox();
  const r1 = await pollOnce(a, [CIK], cur, inbox);            // 預設 seed_only
  assert.equal(r1.newEvents, 0);
  assert.equal(r1.seeded, 1);
  assert.equal(inbox.items.size, 0);                           // 零通知,不洪水
  // 第二輪新增一筆 → 只入箱新增的
  body.v = subs([{ acc:"N-1", form:"SCHEDULE 13D", filed:"2026-07-25", report:"2026-07-24" }, ...HIST]);
  const r2 = await pollOnce(a, [CIK], cur, inbox);
  assert.equal(r2.newEvents, 1);
  assert.equal(inbox.items.size, 1);
  assert.equal([...inbox.items.values()][0].event.accessionNumber, "N-1");
  assert.equal(r2.high, 1);                                    // 13D=high(Live)
});
test("P0-1 backfill_shadow:回填入箱但 shadow=true,零 Live high", async () => {
  const body = { v: subs(HIST) };
  const inbox = new MemoryEventInbox();
  const r = await pollOnce(adapter(body), [CIK], new MemoryCursorStore(), inbox,
    { bootstrapMode: "backfill_shadow" });
  assert.equal(r.shadowBackfilled, 3);
  assert.equal(r.high, 0);                                     // 不產生 Live high candidate
  assert.equal(r.newEvents, 0);
  for (const it of inbox.items.values()) assert.equal(it.shadow, true);
});
test("P0-2 部分失敗:第一筆成功、第二筆失敗、第三筆仍處理;錯誤記載", async () => {
  const body = { v: subs(HIST) };
  const cur = new MemoryCursorStore(); await cur.markSeen(CIK, []);   // 已初始化(非首次)
  class FlakyInbox extends MemoryEventInbox {
    async putIfAbsent(item: InboxItem) {
      if (item.event.accessionNumber === "H-2") throw new Error("inbox unavailable");
      return super.putIfAbsent(item);
    }
  }
  const inbox = new FlakyInbox();
  const r = await pollOnce(adapter(body), [CIK], cur, inbox);
  assert.equal(r.newEvents, 2);                                // H-1、H-3 照常
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].note, /H-2/);
});
test("P0-2 重跑不重複:失敗筆下一輪補入,已入箱筆 exists 不重複", async () => {
  const body = { v: subs(HIST) };
  const cur = new MemoryCursorStore(); await cur.markSeen(CIK, []);
  let failH2 = true;
  class OnceFlaky extends MemoryEventInbox {
    async putIfAbsent(item: InboxItem) {
      if (failH2 && item.event.accessionNumber === "H-2") throw new Error("down");
      return super.putIfAbsent(item);
    }
  }
  const inbox = new OnceFlaky();
  await pollOnce(adapter(body), [CIK], cur, inbox);            // H-2 失敗,cursor 未推進該筆
  failH2 = false;
  const r2 = await pollOnce(adapter(body), [CIK], cur, inbox); // 重跑
  assert.equal(r2.newEvents, 1);                               // 只補 H-2
  assert.equal(inbox.items.size, 3);                           // 無重複
  assert.equal(r2.duplicates, 0);                              // 已推進 cursor 者不再出現
});
test("P0-2 cursor 寫入失敗後重跑:putIfAbsent=exists,單筆僅存一份", async () => {
  const body = { v: subs([HIST[0]]) };
  class FlakyCursor extends MemoryCursorStore {
    fail = true;
    async markSeen(cik: string, accs: string[]) {
      if (this.fail && accs.includes("H-1")) { this.fail = false; throw new Error("cursor db down"); }
      return super.markSeen(cik, accs);
    }
  }
  const cur = new FlakyCursor();
  // 先初始化(繞過 seed):直接標空
  await (MemoryCursorStore.prototype.markSeen as any).call(cur, CIK, []);
  const inbox = new MemoryEventInbox();
  const r1 = await pollOnce(adapter(body), [CIK], cur, inbox); // 入箱成功、cursor 失敗
  assert.equal(r1.errors.length, 1);
  const r2 = await pollOnce(adapter(body), [CIK], cur, inbox); // 重跑
  assert.equal(r2.duplicates, 1);                              // exists,不重複入箱
  assert.equal(inbox.items.size, 1);
});
test("P0-2 CIK 間隔離:A 的 inbox 全滅不影響 B", async () => {
  const bodyA = subs([{ acc:"A-1", form:"8-K", filed:"2026-07-24", report:"2026-07-24" }]);
  const bodyB = JSON.stringify({ name:"Beta Inc.", filings:{ recent:{
    accessionNumber:["B-1"], form:["8-K"], filingDate:["2026-07-24"],
    reportDate:["2026-07-24"], primaryDocument:["b.htm"] }}});
  const h: HttpGetJson = async (url) => {
    if (url.includes("company_tickers")) return { status: 200, text: async () => TICKERS };
    if (url.includes("0000009999")) return { status: 200, text: async () => bodyB };
    return { status: 200, text: async () => bodyA };
  };
  const a = new EdgarEventAdapter("test@maggie.ai", h, null, "https://www.sec.gov", new RateLimiter(0));
  const cur = new MemoryCursorStore();
  await cur.markSeen("0000320193", []); await cur.markSeen("0000009999", []);
  class AOnlyFails extends MemoryEventInbox {
    async putIfAbsent(item: InboxItem) {
      if (item.event.cik === "0000320193") throw new Error("A inbox down");
      return super.putIfAbsent(item);
    }
  }
  const inbox = new AOnlyFails();
  const r = await pollOnce(a, ["0000320193", "0000009999"], cur, inbox);
  assert.equal(r.errors.length, 1);
  assert.equal(r.newEvents, 1);                                // B 照常入箱
  assert.equal([...inbox.items.values()][0].event.accessionNumber, "B-1");
});
test("同一 accession 重送 → inbox 僅一筆(eventId 冪等)", async () => {
  const inbox = new MemoryEventInbox();
  const ev: EdgarEvent = { accessionNumber:"D-1", formType:"8-K", rawFormType:"8-K",
    cik:CIK, ticker:"AAPL", companyName:"Apple", filedAt:"2026-07-24",
    eventDate:"2026-07-24", isAmendment:false, primaryDocUrl:"https://sec.gov/x" };
  const item: InboxItem = { eventId: eventIdOf(ev), event: ev, importance:"high",
    shadow:false, enqueuedAt:"2026-07-24T00:00:00Z" };
  assert.equal(await inbox.putIfAbsent(item), "inserted");
  assert.equal(await inbox.putIfAbsent(item), "exists");
  assert.equal(inbox.items.size, 1);
});
test("重要性路由為設定資料", () => {
  assert.equal(IMPORTANCE["8-K"], "high"); assert.equal(IMPORTANCE["13D/A"], "high");
  assert.equal(IMPORTANCE["4"], "normal"); assert.equal(IMPORTANCE["13G/A"], "normal");
});

// ---- 最終 P0:成功空結果不得吞掉未來第一個事件 ----
test("★P0 首輪只有 10-Q(零匹配)→ cursor 已初始化;次輪新 8-K → newEvents=1 正常入箱", async () => {
  const body = { v: subs([{ acc:"Q-1", form:"10-Q", filed:"2026-07-20", report:"2026-06-30" }]) };
  const a = adapter(body); const cur = new MemoryCursorStore(); const inbox = new MemoryEventInbox();
  const r1 = await pollOnce(a, [CIK], cur, inbox);
  assert.equal(r1.seeded, 1);                                  // 成功空結果仍建 cursor
  assert.equal(await cur.initialized(CIK), true);
  assert.equal(r1.errors.length, 0);                           // 不是錯誤,是「成功、無事件」
  body.v = subs([
    { acc:"E-1", form:"8-K", filed:"2026-07-25", report:"2026-07-25" },
    { acc:"Q-1", form:"10-Q", filed:"2026-07-20", report:"2026-06-30" },
  ]);
  const r2 = await pollOnce(a, [CIK], cur, inbox);
  assert.equal(r2.seeded, 0);                                  // 不再被誤認首次啟動
  assert.equal(r2.newEvents, 1);                               // 8-K 沒有被吞
  assert.equal(r2.high, 1);
  assert.equal([...inbox.items.values()][0].event.accessionNumber, "E-1");
});
