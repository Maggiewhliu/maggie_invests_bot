import assert from "node:assert/strict";
import test from "node:test";
import { computeMaxPain, type ChainSnapshotMeta, type OptionContract } from "../src/maxPain.ts";

const meta: ChainSnapshotMeta = {
  source: "licensed-fixture", fetchedAt: "2026-08-14T01:00:00.000Z",
  oiAsOf: "2026-08-13", paginationComplete: true,
};
const chain: OptionContract[] = [
  { contractId: "c90", strike: 90, expiration: "2026-08-14", contractType: "call", openInterest: 2, multiplier: 100 },
  { contractId: "p90", strike: 90, expiration: "2026-08-14", contractType: "put", openInterest: 30, multiplier: 100 },
  { contractId: "c100", strike: 100, expiration: "2026-08-14", contractType: "call", openInterest: 10, multiplier: 100 },
  { contractId: "p100", strike: 100, expiration: "2026-08-14", contractType: "put", openInterest: 30, multiplier: 100 },
  { contractId: "c110", strike: 110, expiration: "2026-08-14", contractType: "call", openInterest: 20, multiplier: 100 },
  { contractId: "p110", strike: 110, expiration: "2026-08-14", contractType: "put", openInterest: 5, multiplier: 100 },
  { contractId: "c120", strike: 120, expiration: "2026-08-14", contractType: "call", openInterest: 30, multiplier: 100 },
  { contractId: "p120", strike: 120, expiration: "2026-08-14", contractType: "put", openInterest: 2, multiplier: 100 },
  { contractId: "c130", strike: 130, expiration: "2026-08-14", contractType: "call", openInterest: 40, multiplier: 100 },
  { contractId: "p130", strike: 130, expiration: "2026-08-14", contractType: "put", openInterest: 1, multiplier: 100 },
];

test("computes a reproducible result from a complete two-sided chain", () => {
  const r = computeMaxPain(chain, 105, "2026-08-14", meta);
  assert.equal(r.maxPainStrike, 100);
  assert.equal(r.dataQuality, "real");
  assert.equal(r.scopedChainHash.length, 64);
});
test("optimized calculation agrees with direct payout calculation", () => {
  const r = computeMaxPain(chain, 105, "2026-08-14", meta);
  const strikes = [...new Set(chain.map(c => c.strike))];
  const direct = strikes.map(pin => ({ pin, payout: chain.reduce((s, c) =>
    c.contractType === "call" ? s + Math.max(0, pin - c.strike) * c.openInterest * c.multiplier
    : s + Math.max(0, c.strike - pin) * c.openInterest * c.multiplier, 0) }));
  const min = Math.min(...direct.map(i => i.payout));
  assert.deepEqual(r.tiedMinimumStrikes, direct.filter(i => i.payout === min).map(i => i.pin));
});
test("hash and result ignore other expirations", () => {
  const base = computeMaxPain(chain, 105, "2026-08-14", meta);
  const w = computeMaxPain([...chain, { contractId: "other", strike: 500, expiration: "2026-09-18", contractType: "call", openInterest: 999, multiplier: 100 }], 105, "2026-08-14", meta);
  assert.equal(w.maxPainStrike, base.maxPainStrike);
  assert.equal(w.scopedChainHash, base.scopedChainHash);
});
test("hash independent of row order", () => {
  assert.equal(computeMaxPain([...chain].reverse(), 105, "2026-08-14", meta).scopedChainHash,
               computeMaxPain(chain, 105, "2026-08-14", meta).scopedChainHash);
});
test("duplicate contracts -> incomplete", () => {
  const r = computeMaxPain([...chain, chain[0]], 105, "2026-08-14", meta);
  assert.equal(r.dataQuality, "incomplete");
  assert.match(r.warnings.join(" "), /duplicate contract id/);
});
test("incomplete pagination not real", () => {
  assert.equal(computeMaxPain(chain, 105, "2026-08-14", { ...meta, paginationComplete: false }).dataQuality, "incomplete");
});
test("rejects non-finite inputs", () => {
  const r = computeMaxPain(chain, Number.POSITIVE_INFINITY, "2026-08-14", meta);
  assert.equal(r.dataQuality, "invalid");
  assert.equal(r.maxPainStrike, null);
});
test("tie separate from data quality", () => {
  const tied: OptionContract[] = [90,100,110,120,130].flatMap(k => [
    { contractId: `c${k}`, strike: k, expiration: "2026-08-14", contractType: "call" as const, openInterest: 1, multiplier: 100 },
    { contractId: `p${k}`, strike: k, expiration: "2026-08-14", contractType: "put" as const, openInterest: 1, multiplier: 100 },
  ]);
  const r = computeMaxPain(tied, 111, "2026-08-14", meta);
  assert.ok(r.tiedMinimumStrikes.length >= 1);
  assert.equal(r.dataQuality, "real");
});
