import assert from "node:assert/strict";
import test from "node:test";
import { windowsFor, NODES } from "../src/pushTrigger.ts";
const at = (iso: string) => new Date(iso);

test("四節點齊備,收盤摘要為唯一固定候選", () => {
  assert.equal(NODES.length, 4);
  assert.deepEqual(NODES.filter(n => n.fixedCandidate).map(n => n.node), ["close_summary"]);
});
test("16:10 ET:close_summary 窗開,其他已過", () => {
  const w = windowsFor(at("2026-07-22T20:10:00Z"));
  assert.equal(w.find(x => x.node === "close_summary")!.phase, "open");
  assert.equal(w.find(x => x.node === "pre_close_check")!.phase, "past");
});
test("08:35 ET:盤前窗開,其餘 before", () => {
  const w = windowsFor(at("2026-07-22T12:35:00Z"));
  assert.equal(w.find(x => x.node === "premarket_outlook")!.phase, "open");
  assert.equal(w.find(x => x.node === "post_open_check")!.phase, "before");
});
test("半日:pre_close 12:30、close 13:05", () => {
  const w = windowsFor(at("2026-11-27T17:35:00Z")); // 12:35 EST
  assert.equal(w.find(x => x.node === "pre_close_check")!.scheduledEt, "12:30");
  assert.equal(w.find(x => x.node === "close_summary")!.scheduledEt, "13:05");
});
test("假日/週末/未涵蓋年份 → 空", () => {
  assert.equal(windowsFor(at("2026-11-26T15:00:00Z")).length, 0);
  assert.equal(windowsFor(at("2026-07-25T15:00:00Z")).length, 0);
  assert.equal(windowsFor(at("2030-01-15T15:00:00Z")).length, 0);
});
test("純函數:不寫任何狀態(同刻重複呼叫結果一致)", () => {
  const a = windowsFor(at("2026-07-22T20:10:00Z"));
  const b = windowsFor(at("2026-07-22T20:10:00Z"));
  assert.deepEqual(a, b);
});
