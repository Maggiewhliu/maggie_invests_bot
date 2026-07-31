import { createHash } from "node:crypto";

export type ContractType = "call" | "put";
export type DataQuality = "real" | "incomplete" | "invalid";

export interface OptionContract {
  contractId: string;
  strike: number;
  expiration: string;
  contractType: ContractType;
  openInterest: number;
  multiplier: number;
}

export interface ChainSnapshotMeta {
  source: string;
  fetchedAt: string;
  oiAsOf: string;
  paginationComplete: boolean;
}

export interface MaxPainResult {
  expiration: string;
  maxPainStrike: number | null;
  tiedMinimumStrikes: number[];
  currentPrice: number;
  distance: number | null;
  distancePct: number | null;
  strikesEvaluated: number;
  contractsEvaluated: number;
  totalOI: number;
  dataQuality: DataQuality;
  source: string;
  fetchedAt: string;
  oiAsOf: string;
  computedAt: string;
  scopedChainHash: string;
  warnings: string[];
  notes: string[];
  interpretation: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateContract(contract: OptionContract): string[] {
  const issues: string[] = [];
  if (!contract.contractId?.trim()) issues.push("missing contract id");
  if (!finitePositive(contract.strike)) issues.push("invalid strike");
  if (!DATE_RE.test(contract.expiration)) issues.push("invalid expiration");
  if (contract.contractType !== "call" && contract.contractType !== "put") {
    issues.push("invalid contract type");
  }
  if (!Number.isFinite(contract.openInterest) || contract.openInterest < 0) {
    issues.push("invalid open interest");
  }
  if (!finitePositive(contract.multiplier)) issues.push("invalid multiplier");
  return issues;
}

function scopedHash(contracts: OptionContract[], meta: ChainSnapshotMeta): string {
  const canonical = contracts
    .map((contract) => [
      contract.contractId,
      contract.expiration,
      contract.strike,
      contract.contractType,
      contract.openInterest,
      contract.multiplier,
    ].join("|"))
    .sort()
    .join(";");

  return createHash("sha256")
    .update(`${canonical}|${meta.source}|${meta.oiAsOf}`)
    .digest("hex");
}

function emptyResult(
  expiration: string,
  currentPrice: number,
  meta: ChainSnapshotMeta,
  hash: string,
  warnings: string[],
): MaxPainResult {
  return {
    expiration,
    maxPainStrike: null,
    tiedMinimumStrikes: [],
    currentPrice,
    distance: null,
    distancePct: null,
    strikesEvaluated: 0,
    contractsEvaluated: 0,
    totalOI: 0,
    dataQuality: "invalid",
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    oiAsOf: meta.oiAsOf,
    computedAt: new Date().toISOString(),
    scopedChainHash: hash,
    warnings,
    notes: [],
    interpretation: "資料不足，未產生 OI 結構參考位置。",
  };
}

export function computeMaxPain(
  contracts: OptionContract[],
  currentPrice: number,
  expiration: string,
  meta: ChainSnapshotMeta,
): MaxPainResult {
  const scoped = contracts.filter((contract) => contract.expiration === expiration);
  const hash = scopedHash(scoped, meta);
  const warnings: string[] = [];
  const notes: string[] = [];

  if (!finitePositive(currentPrice)) {
    return emptyResult(expiration, currentPrice, meta, hash, ["invalid current price"]);
  }
  if (!DATE_RE.test(expiration)) {
    return emptyResult(expiration, currentPrice, meta, hash, ["invalid expiration"]);
  }
  if (!meta.source.trim() || !DATE_RE.test(meta.oiAsOf) || Number.isNaN(Date.parse(meta.fetchedAt))) {
    return emptyResult(expiration, currentPrice, meta, hash, ["invalid snapshot metadata"]);
  }

  const seenIds = new Set<string>();
  const clean: OptionContract[] = [];
  for (const contract of scoped) {
    const issues = validateContract(contract);
    if (seenIds.has(contract.contractId)) issues.push("duplicate contract id");
    seenIds.add(contract.contractId);
    if (issues.length) {
      warnings.push(`${contract.contractId || "unknown"}: ${issues.join(", ")}`);
    } else {
      clean.push(contract);
    }
  }

  if (clean.length === 0) {
    return emptyResult(
      expiration,
      currentPrice,
      meta,
      hash,
      [...warnings, "no valid contracts for expiration"],
    );
  }

  const strikes = [...new Set(clean.map((contract) => contract.strike))]
    .sort((a, b) => a - b);
  const indexByStrike = new Map(strikes.map((strike, index) => [strike, index]));
  const callWeight = Array(strikes.length).fill(0) as number[];
  const putWeight = Array(strikes.length).fill(0) as number[];
  let callCount = 0;
  let putCount = 0;
  let totalOI = 0;

  for (const contract of clean) {
    const index = indexByStrike.get(contract.strike)!;
    const weightedOI = contract.openInterest * contract.multiplier;
    totalOI += contract.openInterest;
    if (contract.contractType === "call") {
      callWeight[index] += weightedOI;
      callCount += 1;
    } else {
      putWeight[index] += weightedOI;
      putCount += 1;
    }
  }

  if (!meta.paginationComplete) warnings.push("provider snapshot pagination is incomplete");
  if (callCount === 0 || putCount === 0) warnings.push("option chain contains only one side");
  if (totalOI === 0) warnings.push("total open interest is zero");
  if (strikes.length < 5) warnings.push(`thin chain: ${strikes.length} strikes`);

  const callWeightBefore = Array(strikes.length).fill(0) as number[];
  const callStrikeWeightBefore = Array(strikes.length).fill(0) as number[];
  let runningCallWeight = 0;
  let runningCallStrikeWeight = 0;
  for (let index = 0; index < strikes.length; index += 1) {
    callWeightBefore[index] = runningCallWeight;
    callStrikeWeightBefore[index] = runningCallStrikeWeight;
    runningCallWeight += callWeight[index];
    runningCallStrikeWeight += callWeight[index] * strikes[index];
  }

  const putWeightAfter = Array(strikes.length).fill(0) as number[];
  const putStrikeWeightAfter = Array(strikes.length).fill(0) as number[];
  let runningPutWeight = 0;
  let runningPutStrikeWeight = 0;
  for (let index = strikes.length - 1; index >= 0; index -= 1) {
    putWeightAfter[index] = runningPutWeight;
    putStrikeWeightAfter[index] = runningPutStrikeWeight;
    runningPutWeight += putWeight[index];
    runningPutStrikeWeight += putWeight[index] * strikes[index];
  }

  const payouts = strikes.map((pin, index) => {
    const callPayout = pin * callWeightBefore[index] - callStrikeWeightBefore[index];
    const putPayout = putStrikeWeightAfter[index] - pin * putWeightAfter[index];
    return callPayout + putPayout;
  });
  const minimumPayout = Math.min(...payouts);
  const tolerance = Math.max(1, Math.abs(minimumPayout)) * 1e-12;
  const tiedMinimumStrikes = strikes.filter(
    (_strike, index) => Math.abs(payouts[index] - minimumPayout) <= tolerance,
  );

  const maxPainStrike = tiedMinimumStrikes.reduce((best, strike) => (
    Math.abs(strike - currentPrice) < Math.abs(best - currentPrice) ? strike : best
  ), tiedMinimumStrikes[0]);
  if (tiedMinimumStrikes.length > 1) {
    notes.push(`multiple payout minima: ${tiedMinimumStrikes.join(", ")}`);
  }

  const quality: DataQuality = (
    meta.paginationComplete
    && warnings.length === 0
    && callCount > 0
    && putCount > 0
    && totalOI > 0
    && strikes.length >= 5
  ) ? "real" : "incomplete";

  return {
    expiration,
    maxPainStrike,
    tiedMinimumStrikes,
    currentPrice,
    distance: Math.round((currentPrice - maxPainStrike) * 100) / 100,
    distancePct: Math.round(((currentPrice - maxPainStrike) / currentPrice) * 10_000) / 100,
    strikesEvaluated: strikes.length,
    contractsEvaluated: clean.length,
    totalOI,
    dataQuality: quality,
    source: meta.source,
    fetchedAt: meta.fetchedAt,
    oiAsOf: meta.oiAsOf,
    computedAt: new Date().toISOString(),
    scopedChainHash: hash,
    warnings,
    notes,
    interpretation: "OI 結構參考位置（該到期日整體未平倉量的到期賠付最小點），不是價格預測。",
  };
}
