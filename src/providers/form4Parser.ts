/**
 * src/providers/form4Parser.ts — SEC Form 4 (ownershipDocument) XML 解析器
 *
 * 解鎖範圍(封板時的措辭限制到此為止):
 *   交易方向(取得A/處分D)、交易代碼、股數、單價、交易後持股、10b5-1 註記、多筆交易日期。
 * 原則:
 *   - 純函數:輸入 XML 字串,不做網路請求(抓取由既有 adapter/輪詢層負責,封板不動)
 *   - 必要欄位(交易日/代碼/A-D/股數)缺一 → 該筆交易拒收並記 notes
 *   - 單價可合法缺席(如獎酬授予),null + note,不降級
 *   - 措辭:僅法定中性詞「取得/處分」;禁止「突然賣出/倒貨/看空」等詮釋
 */
import { createHash } from "node:crypto";

export type AcqDisp = "A" | "D";
export interface Form4Transaction {
  securityTitle: string;
  transactionDate: string;         // YYYY-MM-DD
  code: string;                    // SEC transaction code (P/S/A/M/F/G/...)
  codeLabel: { "zh-TW": string; en: string };
  acquiredDisposed: AcqDisp;       // A=取得 D=處分
  shares: number;
  pricePerShare: number | null;    // 可合法缺席
  sharesOwnedAfter: number | null;
  directOrIndirect: "D" | "I" | null;
  tenB51: boolean;                 // aff10b5One
}
export interface Form4Parsed {
  quality: "real" | "incomplete" | "invalid";
  issuerCik: string | null;
  issuerSymbol: string | null;
  ownerName: string | null;
  isDirector: boolean; isOfficer: boolean; officerTitle: string | null; isTenPercentOwner: boolean;
  transactions: Form4Transaction[];
  holdingsOnly: boolean;           // 只有持股申報、無交易
  notes: string[];
  rawSha256: string;
}

const CODE_LABELS: Record<string, { "zh-TW": string; en: string }> = {
  P: { "zh-TW": "公開市場買入", en: "Open-market purchase" },
  S: { "zh-TW": "公開市場出售", en: "Open-market sale" },
  A: { "zh-TW": "獎酬/授予取得", en: "Grant or award" },
  M: { "zh-TW": "衍生工具行使", en: "Option exercise" },
  F: { "zh-TW": "稅務扣繳交付", en: "Tax-withholding disposition" },
  G: { "zh-TW": "贈與", en: "Gift" },
  C: { "zh-TW": "轉換", en: "Conversion" },
  D: { "zh-TW": "返還發行人", en: "Disposition to issuer" },
  X: { "zh-TW": "價內選擇權行使", en: "In-the-money exercise" },
  J: { "zh-TW": "其他(見附註)", en: "Other (see footnotes)" },
};
const codeLabel = (c: string) => CODE_LABELS[c] ?? { "zh-TW": `代碼 ${c}`, en: `Code ${c}` };

/* ---- 極簡容錯抽取(僅針對 ownershipDocument 結構;不引入外部依賴) ---- */
const block = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map(m => m[1]);
};
const first = (xml: string, tag: string): string | null => block(xml, tag)[0] ?? null;
/** 取 <tag>value</tag> 或 <tag><value>value</value></tag>,並去空白 */
const val = (xml: string | null, tag: string): string | null => {
  if (xml === null) return null;
  const inner = first(xml, tag);
  if (inner === null) return null;
  const wrapped = first(inner, "value");
  const raw = (wrapped ?? inner).trim();
  return raw === "" ? null : raw;
};
const num = (s: string | null): number | null => {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const bool = (s: string | null): boolean => s === "1" || s?.toLowerCase() === "true";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseForm4Xml(xml: string): Form4Parsed {
  const rawSha256 = createHash("sha256").update(xml ?? "").digest("hex");
  const notes: string[] = [];
  const base = { issuerCik: null as string | null, issuerSymbol: null as string | null,
    ownerName: null as string | null, isDirector: false, isOfficer: false,
    officerTitle: null as string | null, isTenPercentOwner: false, rawSha256 };

  if (!xml || !xml.includes("ownershipDocument"))
    return { ...base, quality: "invalid", transactions: [], holdingsOnly: false,
      notes: ["not an ownershipDocument"], };

  const docType = val(xml, "documentType");
  if (docType && docType !== "4" && docType !== "4/A")
    notes.push(`documentType is ${docType}, expected 4`);

  const issuer = first(xml, "issuer");
  base.issuerCik = val(issuer, "issuerCik");
  base.issuerSymbol = val(issuer, "issuerTradingSymbol");

  const owner = first(xml, "reportingOwner");
  base.ownerName = val(first(owner ?? "", "reportingOwnerId"), "rptOwnerName");
  const rel = first(owner ?? "", "reportingOwnerRelationship");
  base.isDirector = bool(val(rel, "isDirector"));
  base.isOfficer = bool(val(rel, "isOfficer"));
  base.officerTitle = val(rel, "officerTitle");
  base.isTenPercentOwner = bool(val(rel, "isTenPercentOwner"));

  const txBlocks = block(xml, "nonDerivativeTransaction");
  const holdings = block(xml, "nonDerivativeHolding");
  const transactions: Form4Transaction[] = [];

  for (let i = 0; i < txBlocks.length; i++) {
    const t = txBlocks[i];
    const date = val(t, "transactionDate");
    const coding = first(t, "transactionCoding");
    const code = val(coding, "transactionCode") ?? val(t, "transactionCode");
    const amounts = first(t, "transactionAmounts");
    const ad = val(amounts, "transactionAcquiredDisposedCode") as AcqDisp | null;
    const shares = num(val(amounts, "transactionShares"));
    const price = num(val(amounts, "transactionPricePerShare"));
    // 必要欄位:日期/代碼/A-D/股數 —— 缺一整筆拒收
    const missing: string[] = [];
    if (!date || !DATE_RE.test(date)) missing.push("transactionDate");
    if (!code) missing.push("transactionCode");
    if (ad !== "A" && ad !== "D") missing.push("acquiredDisposedCode");
    if (shares === null || shares < 0) missing.push("transactionShares");
    if (missing.length) { notes.push(`tx#${i + 1}: missing ${missing.join("/")}, rejected`); continue; }
    if (price === null) notes.push(`tx#${i + 1}: pricePerShare absent (may be legitimate, e.g. grant)`);

    transactions.push({
      securityTitle: val(t, "securityTitle") ?? "(unspecified)",
      transactionDate: date!, code: code!, codeLabel: codeLabel(code!),
      acquiredDisposed: ad as AcqDisp, shares: shares!, pricePerShare: price,
      sharesOwnedAfter: num(val(first(t, "postTransactionAmounts"), "sharesOwnedFollowingTransaction")),
      directOrIndirect: (val(first(t, "ownershipNature"), "directOrIndirectOwnership") as "D" | "I" | null),
      tenB51: bool(val(coding, "aff10b5One")),   // 僅逐筆 coding;文件級 fallback 會串染其他交易
    });
  }

  const holdingsOnly = txBlocks.length === 0 && holdings.length > 0;
  const rejected = notes.some(n => n.includes("rejected"));
  const quality: Form4Parsed["quality"] =
    txBlocks.length > 0 && transactions.length === 0 ? "invalid"
    : rejected ? "incomplete" : "real";
  return { ...base, quality, transactions, holdingsOnly, notes };
}
