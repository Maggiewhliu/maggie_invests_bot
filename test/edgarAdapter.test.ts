import assert from "node:assert/strict";
import test from "node:test";
import { EdgarEventAdapter, RateLimiter, buildUserAgent, normalizeForm,
  type HttpGetJson } from "../src/providers/edgarEventAdapter.ts";
import { ProvenanceLedger, sha256 } from "../src/pipeline/artifactSeal.ts";

const TICKERS = JSON.stringify({ "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
const SUBMISSIONS = (over: any = {}) => JSON.stringify({
  name: "Apple Inc.",
  filings: { recent: {
    accessionNumber: ["0000320193-26-000010","0000320193-26-000011","0000320193-26-000011","0000320193-26-000012","0000320193-26-000013"],
    form:            ["4",                   "8-K",                 "8-K",                 "10-Q",                "SC 13G/A"],
    filingDate:      ["2026-07-20",          "2026-07-21",          "2026-07-21",          "2026-07-22",          "2026-07-23"],
    reportDate:      ["2026-07-18",          "2026-07-21",          "2026-07-21",          "",                    ""],
    primaryDocument: ["xslF345X05/doc4.xml", "d8k.htm",             "d8k.htm",             "q.htm",               "sc13ga.htm"],
    ...over,
  }},
});
const http = (subsBody: string, subsStatus = 200): HttpGetJson => async (url) => {
  if (url.includes("company_tickers")) return { status: 200, text: async () => TICKERS };
  return { status: subsStatus, text: async () => subsBody };
};
const fastLimiter = new RateLimiter(0);

test("監控表單過濾 + CIK↔ticker 對映 + 申報/事件日分離", async () => {
  const a = new EdgarEventAdapter("test@maggie.ai", http(SUBMISSIONS()), null, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.equal(s.quality, "real");
  const forms = s.data!.map(e => e.formType);
  assert.deepEqual(forms, ["4", "8-K", "13G/A"]);             // 10-Q 不在監控;13G/A 為正規化類型
  const f4 = s.data![0];
  assert.equal(f4.ticker, "AAPL");
  assert.equal(f4.filedAt, "2026-07-20");
  assert.equal(f4.eventDate, "2026-07-18");                   // 交易日≠申報日
  assert.equal(s.data![2].eventDate, null);                   // 缺事件日=null,不用申報日冒充
  assert.equal(s.data![2].isAmendment, true);                 // /A 標示
});
test("accession 去重:同號重複列只收一筆並記 notes", async () => {
  const a = new EdgarEventAdapter("test@maggie.ai", http(SUBMISSIONS()), null, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.equal(s.data!.filter(e => e.accessionNumber === "0000320193-26-000011").length, 1);
  assert.match(s.notes!.join(","), /duplicate accession/);
});
test("缺 accession/filingDate 的列拒收 → incomplete", async () => {
  const a = new EdgarEventAdapter("test@maggie.ai",
    http(SUBMISSIONS({ filingDate: ["", "2026-07-21", "2026-07-21", "2026-07-22", "2026-07-23"] })),
    null, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.equal(s.quality, "incomplete");
  assert.match(s.notes!.join(","), /rejected/);
});
test("SEC 429 → invalid + paginationComplete=false,不重試轟炸", async () => {
  const a = new EdgarEventAdapter("test@maggie.ai", http("", 429), null, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.equal(s.quality, "invalid");
  assert.equal(s.paginationComplete, false);
});
test("UA 必含聯絡方式(SEC 政策);無 email 建構即失敗", () => {
  assert.throws(() => buildUserAgent("no-contact"));
  assert.match(buildUserAgent("ops@maggie.ai"), /MaggieStockAI\/1\.0 \(ops@maggie\.ai\)/);
});
test("RateLimiter:間隔不足時等待", async () => {
  let slept = 0;
  const rl = new RateLimiter(200, async (ms) => { slept += ms; });
  let t = 1000;
  await rl.wait(() => t);          // 第一次不等
  t += 50;
  await rl.wait(() => t);          // 差 150ms
  assert.equal(slept, 150);
});
test("Provenance:gateway 對 EDGAR 原始 payload 自算 hash 存證", async () => {
  const ledger = new ProvenanceLedger();
  const body = SUBMISSIONS();
  const a = new EdgarEventAdapter("test@maggie.ai", http(body), ledger, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.ok(s.provenanceId);
  const rec = ledger.get(s.provenanceId!)!;
  assert.equal(rec.rawProvenanceHash, sha256(body));          // 原始逐字
  assert.equal(rec.licenseContext, "sec_edgar/filings_events");
});
test("primaryDocUrl 可追溯回 SEC 原始文件", async () => {
  const a = new EdgarEventAdapter("test@maggie.ai", http(SUBMISSIONS()), null, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.match(s.data![0].primaryDocUrl,
    /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/000032019326000010\/xslF345X05\/doc4\.xml$/);
});

test("P0-1 新式 SCHEDULE 13D/G 不得被漏掉,並正規化統一", async () => {
  const body = SUBMISSIONS({
    accessionNumber: ["0000320193-26-000021","0000320193-26-000022","0000320193-26-000023","0000320193-26-000024"],
    form:            ["SCHEDULE 13G",        "SCHEDULE 13D/A",      "SC 13G/A",            "SCHEDULE 14A"],
    filingDate:      ["2026-07-24",          "2026-07-24",          "2026-07-24",          "2026-07-24"],
    reportDate:      ["",                    "",                    "",                    ""],
    primaryDocument: ["sc13g.htm",           "sc13da.htm",          "leg.htm",             "prx.htm"],
  });
  const a = new EdgarEventAdapter("test@maggie.ai", http(body), null, "https://www.sec.gov", new RateLimiter(0));
  const s = await a.getRecentEvents(320193);
  assert.equal(s.quality, "real");                                  // 不再靜默漏掉
  const types = s.data!.map(e => e.formType);
  assert.deepEqual(types, ["13G", "13D/A", "13G/A"]);               // 新舊制正規化為同一套;14A 不收
  assert.equal(s.data![0].rawFormType, "SCHEDULE 13G");             // 原始字串保留追溯
  assert.equal(s.data![1].isAmendment, true);
  // 純函數對照:兩制映射一致
  assert.equal(normalizeForm("SC 13G"), normalizeForm("SCHEDULE 13G"));
  assert.equal(normalizeForm("SCHEDULE 13D/A"), "13D/A");
  assert.equal(normalizeForm("10-Q"), null);
});
test("P0-2 併發五請求 → 嚴格序列間隔(0,30,60,90,120)", async () => {
  const delays: number[] = [];
  const rl = new RateLimiter(30, async (ms) => { delays.push(ms); });
  await Promise.all([rl.wait(() => 0), rl.wait(() => 0), rl.wait(() => 0), rl.wait(() => 0), rl.wait(() => 0)]);
  assert.deepEqual([0, ...delays], [0, 30, 60, 90, 120]);           // 第一個不等,其後每個 +30
});
test("P0-2 coalescing:50 個併發呼叫只下載一次 ticker map", async () => {
  let tickerDownloads = 0;
  const h: HttpGetJson = async (url) => {
    if (url.includes("company_tickers")) { tickerDownloads++; return { status: 200, text: async () => TICKERS }; }
    return { status: 200, text: async () => SUBMISSIONS() };
  };
  const a = new EdgarEventAdapter("test@maggie.ai", h, null, "https://www.sec.gov", new RateLimiter(0));
  await Promise.all(Array.from({ length: 50 }, () => a.getRecentEvents(320193)));
  assert.equal(tickerDownloads, 1);
});

test("★P0 空集合語義:成功零匹配 = real + data:[] + provenance 保存;null 僅失敗", async () => {
  const onlyTenQ = SUBMISSIONS({
    accessionNumber:["0000320193-26-000090"], form:["10-Q"],
    filingDate:["2026-07-20"], reportDate:["2026-06-30"], primaryDocument:["q.htm"] });
  const ledger = new ProvenanceLedger();
  const a = new EdgarEventAdapter("test@maggie.ai", http(onlyTenQ), ledger, "https://www.sec.gov", fastLimiter);
  const s = await a.getRecentEvents(320193);
  assert.equal(s.quality, "real");                             // 成功查詢
  assert.deepEqual(s.data, []);                                // 空陣列,非 null
  assert.ok(s.provenanceId);                                   // 存證保留(成功的證據)
  // 對照:HTTP 失敗才是 null
  const bad = new EdgarEventAdapter("test@maggie.ai", http("", 500), null, "https://www.sec.gov", fastLimiter);
  const sb = await bad.getRecentEvents(320193);
  assert.equal(sb.data, null);
  assert.equal(sb.quality, "invalid");
});
