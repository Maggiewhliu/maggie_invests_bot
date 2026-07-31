import assert from "node:assert/strict";
import test from "node:test";
import { getMarketStatus } from "../src/marketClock.ts";

// 用固定 UTC 時刻測(美東 EDT=UTC-4 夏令 / EST=UTC-5 冬令)
const at = (iso: string) => new Date(iso);

test("平日盤中 → regular(7/22 週三 美東14:00 = UTC 18:00)", () => {
  const s = getMarketStatus(at("2026-07-22T18:00:00Z"));
  assert.equal(s.state, "regular");
  assert.equal(s.nextEvent?.etTime, "16:00");
});
test("台北中午 = 美東凌晨 → closed(修掉舊版『午盤實時』bug)", () => {
  const s = getMarketStatus(at("2026-07-22T04:00:00Z")); // 台北12:00 = 美東00:00
  assert.equal(s.state, "closed");
});
test("感恩節 → 休市且有假日名", () => {
  const s = getMarketStatus(at("2026-11-26T15:00:00Z"));
  assert.equal(s.isTradingDay, false);
  assert.equal(s.holidayName, "Thanksgiving Day");
});
test("感恩節翌日半日 → 13:00 收盤(美東14:00 EST=UTC19:00 已收)", () => {
  const s = getMarketStatus(at("2026-11-27T19:00:00Z"));
  assert.equal(s.isHalfDay, true);
  assert.notEqual(s.state, "regular");
});
test("半日 12:00 ET 仍在盤中", () => {
  const s = getMarketStatus(at("2026-11-27T17:00:00Z")); // 12:00 EST
  assert.equal(s.state, "regular");
  assert.equal(s.nextEvent?.etTime, "13:00");
});
test("週六 → closed 且下一事件指向週一", () => {
  const s = getMarketStatus(at("2026-07-25T18:00:00Z"));
  assert.equal(s.state, "closed");
  assert.equal(s.nextEvent?.etDate, "2026-07-27");
});
test("7/3 國慶補假 → 休市,下一交易日 7/6", () => {
  const s = getMarketStatus(at("2026-07-03T15:00:00Z"));
  assert.equal(s.isTradingDay, false);
  assert.equal(s.nextEvent?.etDate, "2026-07-06");
});
test("超出日曆年份 → unknown 不亂猜", () => {
  const s = getMarketStatus(at("2030-01-15T15:00:00Z"));
  assert.equal(s.state, "unknown");
  assert.equal(s.calendarCovered, false);
});
test("盤前時段判定(美東 08:00 EDT = UTC 12:00)", () => {
  const s = getMarketStatus(at("2026-07-22T12:00:00Z"));
  assert.equal(s.state, "premarket");
  assert.equal(s.nextEvent?.etTime, "09:30");
});
