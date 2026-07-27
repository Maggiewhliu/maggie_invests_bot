import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPushStore, PostgresPushStore, evaluateCandidate, deliverToRecipient,
  deriveOccurrenceOutcome, candidateId, deliveryId, DEFAULT_RETRY,
  type DecisionSnapshot, type Query } from "../src/pushCore.ts";

const snap = (v: string, h: string, q: DecisionSnapshot["dataQuality"] = "real"): DecisionSnapshot =>
  ({ decisionVersion: v, contentHash: h, dataQuality: q });
const okSend = async () => ({ ok: true, httpStatus: 200 });
const tg = (chat: string) => ({ channel: "telegram" as const, recipientKey: chat, lang: "zh-TW" });

test("仲裁BUG:skip 綁決策版本,新版本不被封鎖", async () => {
  const s = new MemoryPushStore();
  // 建立「上次已送達 h1」的事實
  const prev = await evaluateCandidate(s, "post_open_check", "2026-07-21", false, snap("d0","h1"));
  await deliverToRecipient(s, prev.candId, tg("c0"), 0, okSend);
  const c1 = await evaluateCandidate(s, "post_open_check", "2026-07-22", false, snap("d1","h1"));
  assert.equal(c1.status, "skipped_no_change");
  const c2 = await evaluateCandidate(s, "post_open_check", "2026-07-22", false, snap("d2","h2"));
  assert.equal(c2.status, "eligible");
  assert.equal(await deliverToRecipient(s, c2.candId, tg("c1"), 0, okSend), "sent");
});
test("命名修正:閘門通過為 eligible;比對基準=最後送達 hash(未送達不算)", async () => {
  const s = new MemoryPushStore();
  // d1 eligible 但投遞失敗(fatal)→ 未送達
  const c1 = await evaluateCandidate(s, "pre_close_check", "2026-07-22", false, snap("d1","hA"));
  assert.equal(c1.status, "eligible");
  await deliverToRecipient(s, c1.candId, tg("cX"), 0, async () => ({ ok:false, httpStatus:400 }));
  // 內容相同的 d2:因 hA 從未送達,不應被 no_change 略過
  const c2 = await evaluateCandidate(s, "pre_close_check", "2026-07-22", false, snap("d2","hA"));
  assert.equal(c2.status, "eligible");
});
test("P0-1 fencing:接管後,舊 worker 的過期結果寫入被拒(stale)", async () => {
  const s = new MemoryPushStore();
  const { candId } = await evaluateCandidate(s, "close_summary","2026-07-22", true, snap("d1","h1"));
  const id = deliveryId(candId, tg("cF"));
  const w1 = await s.claimDelivery(id, 0, DEFAULT_RETRY);          // worker1 token=1
  assert.equal(w1.outcome, "acquired");
  const w2 = await s.claimDelivery(id, 61_000, DEFAULT_RETRY);     // lease 過期,worker2 接管 token=2
  assert.equal(w2.outcome, "acquired");
  // worker1 慢半拍回來寫「成功」→ 必須被拒
  assert.equal(await s.completeDelivery(id, (w1 as any).fenceToken), "stale");
  // worker2 的結果才算數
  assert.equal(await s.completeDelivery(id, (w2 as any).fenceToken), "applied");
  assert.equal((await s.deliveryRecord(id))!.status, "sent");
});
test("P0-2 耗盡不卡 claimed:lease 過期且 attempts 滿 → failed_fatal", async () => {
  const s = new MemoryPushStore();
  const id = "del:close_summary:2026-07-22:d1:telegram:cZ:zh-TW";
  await s.claimDelivery(id, 0, DEFAULT_RETRY);          // attempts=1
  await s.claimDelivery(id, 61_000, DEFAULT_RETRY);     // 接管 attempts=2
  await s.claimDelivery(id, 122_000, DEFAULT_RETRY);    // 接管 attempts=3(=max)
  const final = await s.claimDelivery(id, 200_000, DEFAULT_RETRY); // 過期+耗盡
  assert.equal(final.outcome, "denied");
  assert.equal((await s.deliveryRecord(id))!.status, "failed_fatal"); // 不卡 claimed
});
test("P0-3 全數合法略過 → skipped,不誤判 missed", async () => {
  const s = new MemoryPushStore();
  const prev = await evaluateCandidate(s, "premarket_outlook","2026-07-21", false, snap("d0","hS"));
  await deliverToRecipient(s, prev.candId, tg("c0"), 0, okSend);
  await evaluateCandidate(s, "premarket_outlook","2026-07-22", false, snap("d1","hS")); // no change
  assert.equal(await deriveOccurrenceOutcome(s, "premarket_outlook","2026-07-22", true), "skipped");
});
test("P0-3 對照:有 eligible 卻無 sent 且過窗 → missed", async () => {
  const s = new MemoryPushStore();
  await evaluateCandidate(s, "premarket_outlook","2026-07-23", false, snap("d1","hNew"));
  assert.equal(await deriveOccurrenceOutcome(s, "premarket_outlook","2026-07-23", true), "missed");
});
test("recipient 各自獨立:A 失敗重試不影響 B", async () => {
  const s = new MemoryPushStore();
  const { candId } = await evaluateCandidate(s, "close_summary","2026-07-22", true, snap("d1","h1"));
  let n = 0;
  const flaky = async () => (++n === 1 ? { ok:false, httpStatus:503 as number|null } : { ok:true, httpStatus:200 as number|null });
  assert.equal(await deliverToRecipient(s, candId, tg("A"), 0, flaky), "failed_retryable");
  assert.equal(await deliverToRecipient(s, candId, tg("B"), 0, okSend), "sent");
  assert.equal(await deliverToRecipient(s, candId, tg("A"), 121_000, flaky), "sent");
});
test("資料品質 invalid → 固定候選也 skipped_data_quality", async () => {
  const s = new MemoryPushStore();
  const c = await evaluateCandidate(s, "close_summary","2026-07-22", true, snap("d1","h1","invalid"));
  assert.equal(c.status, "skipped_data_quality");
});
test("PostgresPushStore:fencing SQL(complete 帶錯 token → stale)", async () => {
  let attempts = 0;
  const fake: Query = async (sql, params) => {
    if (sql.includes("INSERT INTO push_delivery")) { attempts = 1; return { rowCount: 1, rows: [{ attempts: 1 }] }; }
    if (sql.startsWith("UPDATE push_delivery SET status='sent'"))
      return { rowCount: params[1] === attempts ? 1 : 0, rows: [] };  // attempts 即 fence
    return { rowCount: 0, rows: [] };
  };
  const pg = new PostgresPushStore(fake);
  const c = await pg.claimDelivery("del:x", 0, DEFAULT_RETRY);
  assert.equal(c.outcome, "acquired");
  assert.equal(await pg.completeDelivery("del:x", 999), "stale");           // 錯 token
  assert.equal(await pg.completeDelivery("del:x", (c as any).fenceToken), "applied");
});
