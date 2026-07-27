import assert from "node:assert/strict";
import test from "node:test";
import { MassiveQuoteProvider, type HttpGet } from "../src/providers/massiveQuoteProvider.ts";

const CLOCK = () => new Date("2026-07-24T21:00:00Z");
const twoBars = (c0: number, c1: number, v0: number | null = 1_000_000) => ({
  status: 200,
  text: async () => JSON.stringify({ results: [
    { c: c0, o: c0 * 0.99, v: v0 ?? undefined, t: 1784923200000 },
    { c: c1, o: c1 * 0.99, v: 900_000, t: 1784836800000 },
  ]}),
});

test("P0-1 changePct=前收盤→最新收盤(兩日收盤重算)", async () => {
  const http: HttpGet = async () => twoBars(231.40, 229.97);
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(s.quality, "real");
  assert.equal(s.data![0].changePct, 0.62);
  assert.equal(s.data![0].prevClose, 229.97);
});
test("P0-1 只有單根 bar → changePct=null 並降 incomplete,不用盤中口徑冒充", async () => {
  const http: HttpGet = async () => ({ status: 200,
    text: async () => JSON.stringify({ results: [{ c: 100, o: 99, v: 1000, t: 1784923200000 }] }) });
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(s.data![0].changePct, null);
  assert.equal(s.quality, "incomplete");
});
test("P0-3 volume 缺值 → null + incomplete,不補 0", async () => {
  const http: HttpGet = async () => twoBars(100, 99, null);
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(s.data![0].volume, null);
  assert.equal(s.quality, "incomplete");
});
test("P0-4 raw 與 normalized 存證分離且皆存在", async () => {
  const http: HttpGet = async () => twoBars(100, 99);
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(s.rawProvenanceHash.length, 64);
  assert.equal(s.normalizedHash.length, 64);
  assert.notEqual(s.rawProvenanceHash, s.normalizedHash);
});
test("P1 key 走 Authorization header,不出現在 URL", async () => {
  let seenUrl = ""; let seenAuth = "";
  const http: HttpGet = async (u, h) => { seenUrl = u; seenAuth = h?.Authorization ?? ""; return twoBars(100, 99); };
  await new MassiveQuoteProvider("secret-key", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(seenUrl.includes("secret-key"), false);
  assert.equal(seenAuth, "Bearer secret-key");
});
test("部分失敗 → incomplete + notes", async () => {
  const http: HttpGet = async (u) => u.includes("AAPL") ? twoBars(231.4, 229.97)
    : ({ status: 500, text: async () => "{}" });
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL","TSLA"]);
  assert.equal(s.quality, "incomplete");
  assert.match(s.notes!.join(","), /TSLA: http 500/);
});
test("429 → paginationComplete=false", async () => {
  const http: HttpGet = async () => ({ status: 429, text: async () => "{}" });
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL"]);
  assert.equal(s.paginationComplete, false);
});
test("缺 key → 建構即失敗", () => { assert.throws(() => new MassiveQuoteProvider("")); });

test("Fix2 七檔中一檔過期 → quality=stale,notes 列出過期標的", async () => {
  const fresh = (c0: number) => ({ status: 200, text: async () => JSON.stringify({ results: [
    { c: c0, o: c0*0.99, v: 1000, t: 1784923200000 },   // 2026-07-24 (expected)
    { c: c0*0.99, o: c0*0.98, v: 900, t: 1784836800000 }] }) });
  const stale = (c0: number) => ({ status: 200, text: async () => JSON.stringify({ results: [
    { c: c0, o: c0*0.99, v: 1000, t: 1784664000000 },   // 2026-07-21 (過期)
    { c: c0*0.99, o: c0*0.98, v: 900, t: 1784577600000 }] }) });
  const http: HttpGet = async (u) => u.includes("TSLA") ? stale(438) : fresh(231);
  const s = await new MassiveQuoteProvider("k", http, "https://x", CLOCK).getQuotes(["AAPL","TSLA"]);
  assert.equal(s.quality, "stale");
  assert.match(s.notes!.join(","), /TSLA: stale/);
  assert.equal(s.data!.find(q => q.symbol==="TSLA")!.asOf.slice(0,10), "2026-07-21");
});

test("P0-2 無 bar 時間戳 → 該列拒收;部分=incomplete,全部=invalid", async () => {
  const noT = { status: 200, text: async () => JSON.stringify({ results: [
    { c: 100, o: 99, v: 1000 },        // 無 t
    { c: 99, o: 98, v: 900, t: 1784836800000 }] }) };
  const ok = { status: 200, text: async () => JSON.stringify({ results: [
    { c: 231.4, o: 230, v: 1000, t: 1784923200000 },
    { c: 229.97, o: 229, v: 900, t: 1784836800000 }] }) };
  const partial: HttpGet = async (u) => u.includes("AAPL") ? ok : noT;
  const s1 = await new MassiveQuoteProvider("k", partial, "https://x", CLOCK).getQuotes(["AAPL","TSLA"]);
  assert.equal(s1.quality, "incomplete");
  assert.match(s1.notes!.join(","), /TSLA: missing bar timestamp/);
  assert.equal(s1.data!.length, 1);
  const all: HttpGet = async () => noT;
  const s2 = await new MassiveQuoteProvider("k", all, "https://x", CLOCK).getQuotes(["TSLA"]);
  assert.equal(s2.quality, "invalid");
  assert.equal(s2.data, null);
});
