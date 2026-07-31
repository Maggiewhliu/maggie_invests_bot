import assert from "node:assert/strict";
import test from "node:test";
import { parseForm4Xml } from "../src/providers/form4Parser.ts";
import { renderForm4Facts } from "../src/reports/form4Report.ts";
import { lint } from "../src/contentRiskGuard.ts";
import { sha256 } from "../src/pipeline/artifactSeal.ts";

/** 貼近 SEC 實際樣式的 fixture:S 出售(10b5-1)+ M 行使,officer 身分 */
const XML = `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0000320193</issuerCik><issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001214156</rptOwnerCik><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer>
      <officerTitle>Chief Financial Officer</officerTitle><isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-16</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType>
        <transactionCode>M</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>25.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>52000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-18</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode><aff10b5One>1</aff10b5One></transactionCoding>
      <transactionAmounts><transactionShares><value>8000</value></transactionShares>
        <transactionPricePerShare><value>431.20</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>44000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

test("解析:issuer/owner 身分/兩筆交易/多日期/10b5-1", () => {
  const p = parseForm4Xml(XML);
  assert.equal(p.quality, "real");
  assert.equal(p.issuerSymbol, "AAPL");
  assert.equal(p.ownerName, "DOE JANE");
  assert.equal(p.isOfficer, true);
  assert.equal(p.officerTitle, "Chief Financial Officer");
  assert.equal(p.transactions.length, 2);
  const [m, s] = p.transactions;
  assert.equal(m.code, "M"); assert.equal(m.acquiredDisposed, "A");
  assert.equal(m.shares, 10000); assert.equal(m.pricePerShare, 25.5);
  assert.equal(m.tenB51, false);
  assert.equal(s.code, "S"); assert.equal(s.acquiredDisposed, "D");
  assert.equal(s.shares, 8000); assert.equal(s.pricePerShare, 431.2);
  assert.equal(s.sharesOwnedAfter, 44000);
  assert.equal(s.tenB51, true);                                  // 10b5-1 註記
  assert.notEqual(m.transactionDate, s.transactionDate);          // 多筆不同日期
  assert.equal(p.rawSha256, sha256(XML));                         // 原文存證
});
test("必要欄位缺失 → 該筆拒收;其餘照收;quality=incomplete", () => {
  const broken = XML.replace("<transactionDate><value>2026-07-18</value></transactionDate>", "");
  const p = parseForm4Xml(broken);
  assert.equal(p.quality, "incomplete");
  assert.equal(p.transactions.length, 1);                         // S 筆被拒,M 筆保留
  assert.match(p.notes.join(","), /tx#2: missing transactionDate, rejected/);
});
test("股數非數值 → 拒收;全部被拒 → invalid", () => {
  const bad = XML.replace(/<transactionShares><value>10000<\/value><\/transactionShares>/, "<transactionShares><value>abc</value></transactionShares>")
                 .replace(/<transactionShares><value>8000<\/value><\/transactionShares>/, "<transactionShares></transactionShares>");
  const p = parseForm4Xml(bad);
  assert.equal(p.quality, "invalid");
  assert.equal(p.transactions.length, 0);
});
test("單價缺席(獎酬)→ null + note,不降級", () => {
  const grant = XML.replace("<transactionPricePerShare><value>25.50</value></transactionPricePerShare>", "");
  const p = parseForm4Xml(grant);
  assert.equal(p.quality, "real");
  assert.equal(p.transactions[0].pricePerShare, null);
  assert.match(p.notes.join(","), /pricePerShare absent/);
});
test("holdings-only 申報 → transactions=[] + holdingsOnly=true,real", () => {
  const h = `<ownershipDocument><documentType>4</documentType>
    <issuer><issuerCik>0000320193</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
    <reportingOwner><reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId></reportingOwner>
    <nonDerivativeTable><nonDerivativeHolding><securityTitle><value>Common Stock</value></securityTitle>
    </nonDerivativeHolding></nonDerivativeTable></ownershipDocument>`;
  const p = parseForm4Xml(h);
  assert.equal(p.quality, "real");
  assert.equal(p.holdingsOnly, true);
  assert.equal(p.transactions.length, 0);
});
test("垃圾輸入 → invalid,不拋出", () => {
  assert.equal(parseForm4Xml("").quality, "invalid");
  assert.equal(parseForm4Xml("<html>not sec</html>").quality, "invalid");
});
test("渲染:中英事實行,含方向/代碼/股數/價格/10b5-1;lint 乾淨零詮釋詞", () => {
  const p = parseForm4Xml(XML);
  for (const lang of ["zh-TW", "en"] as const) {
    const text = renderForm4Facts(p, lang);
    assert.match(text, /DOE JANE/);
    assert.match(text, /Chief Financial Officer/);
    assert.match(text, lang === "zh-TW" ? /處分 8,000 股/ : /Disposed 8,000 sh/);
    assert.match(text, /431\.2/);
    assert.match(text, lang === "zh-TW" ? /依 10b5-1 既定計畫/ : /under a 10b5-1 plan/);
    for (const bad of ["突然", "倒貨", "看空", "dumped", "suddenly", "bearish", "逢低", "買進"])
      assert.equal(text.toLowerCase().includes(bad.toLowerCase()), false, `含詮釋詞 ${bad}`);
    const r = lint(text);
    assert.equal(r.ok, true);
    assert.deepEqual(r.review, [], "事實渲染不得觸發 review");
  }
});
