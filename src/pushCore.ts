/**
 * src/pushCore.ts — 推播管線核心 v4
 * 第三輪仲裁修正:
 *  P0-1 fencing token:認領回傳 token,結果寫入須驗 token,舊 worker 過期寫入被拒
 *  P0-2 重試耗盡不卡 claimed:lease 過期且 attempts 已滿 → 轉 failed_fatal
 *  P0-3 occurrence 推導含 skipped:全數合法略過 → "skipped",不誤判 missed
 *  命名:published → eligible(閘門通過=有資格發,非已發);
 *        無變化閘門改比對「最後實際送達」的內容 hash(lastDeliveredHash)
 */

export type CandidateStatus = "eligible" | "skipped_no_change" | "skipped_data_quality";
export type DeliveryStatus = "claimed" | "sent" | "failed_retryable" | "failed_fatal";

export const occurrenceId = (node: string, etDate: string) => `occ:${node}:${etDate}`;
export const candidateId = (node: string, etDate: string, decisionVersion: string) =>
  `pub:${node}:${etDate}:${decisionVersion}`;
export interface RecipientRef { channel: "telegram" | "email"; recipientKey: string; lang: string; }
export const deliveryId = (cand: string, r: RecipientRef) =>
  `del:${cand.slice(4)}:${r.channel}:${r.recipientKey}:${r.lang}`;

export interface DecisionSnapshot {
  decisionVersion: string; contentHash: string;
  dataQuality: "real" | "incomplete" | "invalid";
}
export interface RetryPolicy { maxAttempts: number; backoffMs: number[]; leaseMs: number; }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: [120_000, 480_000], leaseMs: 60_000 };
export type ErrorClass = "retryable" | "fatal";
export const classifySendError = (s: number | null): ErrorClass =>
  s === null || s === 429 || s >= 500 ? "retryable" : "fatal";

export interface DeliveryRecord {
  status: DeliveryStatus; attempts: number; fenceToken: number;
  leaseUntilMs: number | null; nextRetryAtMs: number | null; lastError?: string;
}
export type ClaimDenyReason =
  | "already_sent" | "in_flight" | "retry_backoff" | "attempts_exhausted" | "failed_fatal";
export type ClaimResult =
  | { outcome: "acquired"; fenceToken: number }
  | { outcome: "denied"; reason: ClaimDenyReason };

export interface PushStore {
  ensureOccurrence(id: string): Promise<void>;
  /** 無變化閘門比對基準:最後「實際有送達(≥1 sent)」的內容 hash */
  lastDeliveredHash(node: string): Promise<string | null>;
  recordCandidate(id: string, node: string, status: CandidateStatus, contentHash: string): Promise<void>;
  candidateStatus(id: string): Promise<CandidateStatus | undefined>;
  candidatesFor(node: string, etDate: string): Promise<CandidateStatus[]>;
  claimDelivery(id: string, nowMs: number, p: RetryPolicy): Promise<ClaimResult>;
  completeDelivery(id: string, fenceToken: number): Promise<"applied" | "stale">;
  failDelivery(id: string, fenceToken: number, retryable: boolean, nowMs: number,
    p: RetryPolicy, err: string): Promise<DeliveryStatus | "stale">;
  deliveryRecord(id: string): Promise<DeliveryRecord | undefined>;
  hasSentDelivery(candPrefix: string): Promise<boolean>;
}

/* ---------------- 測試專用 In-memory ---------------- */
export class MemoryPushStore implements PushStore {
  private occ = new Set<string>();
  private cand = new Map<string, { node: string; status: CandidateStatus; hash: string; at: number }>();
  private del = new Map<string, DeliveryRecord>();
  private seq = 0;
  async ensureOccurrence(id: string) { this.occ.add(id); }
  async lastDeliveredHash(node: string) {
    let best: { at: number; hash: string } | null = null;
    for (const [id, c] of this.cand) {
      if (c.node !== node || c.status !== "eligible") continue;
      if (await this.hasSentDelivery(`del:${id.slice(4)}:`))
        if (!best || c.at > best.at) best = { at: c.at, hash: c.hash };
    }
    return best?.hash ?? null;
  }
  async recordCandidate(id: string, node: string, status: CandidateStatus, hash: string) {
    if (!this.cand.has(id)) this.cand.set(id, { node, status, hash, at: ++this.seq });
  }
  async candidateStatus(id: string) { return this.cand.get(id)?.status; }
  async candidatesFor(node: string, etDate: string) {
    const out: CandidateStatus[] = [];
    for (const [id, c] of this.cand) if (id.startsWith(`pub:${node}:${etDate}:`)) out.push(c.status);
    return out;
  }
  async claimDelivery(id: string, nowMs: number, p: RetryPolicy): Promise<ClaimResult> {
    const r = this.del.get(id);
    if (!r) {
      const rec: DeliveryRecord = { status: "claimed", attempts: 1, fenceToken: 1,
        leaseUntilMs: nowMs + p.leaseMs, nextRetryAtMs: null };
      this.del.set(id, rec); return { outcome: "acquired", fenceToken: 1 };
    }
    if (r.status === "sent") return { outcome: "denied", reason: "already_sent" };
    if (r.status === "failed_fatal") return { outcome: "denied", reason: "failed_fatal" };
    if (r.status === "claimed" && r.leaseUntilMs !== null && nowMs >= r.leaseUntilMs) {
      if (r.attempts >= p.maxAttempts) {           // 耗盡不卡 claimed
        r.status = "failed_fatal"; r.leaseUntilMs = null;
        r.lastError = "lease expired, attempts exhausted";
        return { outcome: "denied", reason: "attempts_exhausted" };
      }
      r.attempts += 1; r.fenceToken += 1; r.leaseUntilMs = nowMs + p.leaseMs;
      return { outcome: "acquired", fenceToken: r.fenceToken };
    }
    if (r.status === "claimed") return { outcome: "denied", reason: "in_flight" };
    if (r.status === "failed_retryable") {
      if (r.attempts < p.maxAttempts && r.nextRetryAtMs !== null && nowMs >= r.nextRetryAtMs) {
        r.status = "claimed"; r.attempts += 1; r.fenceToken += 1;
        r.leaseUntilMs = nowMs + p.leaseMs; r.nextRetryAtMs = null;
        return { outcome: "acquired", fenceToken: r.fenceToken };
      }
      return { outcome: "denied",
        reason: r.attempts >= p.maxAttempts ? "attempts_exhausted" : "retry_backoff" };
    }
    return { outcome: "denied", reason: "in_flight" };
  }
  async completeDelivery(id: string, token: number) {           // P0-1:fencing
    const r = this.del.get(id);
    if (!r || r.status !== "claimed" || r.fenceToken !== token) return "stale";
    r.status = "sent"; r.leaseUntilMs = null; return "applied";
  }
  async failDelivery(id: string, token: number, retryable: boolean, nowMs: number,
    p: RetryPolicy, err: string) {
    const r = this.del.get(id);
    if (!r || r.status !== "claimed" || r.fenceToken !== token) return "stale";
    r.lastError = err; r.leaseUntilMs = null;
    if (!retryable || r.attempts >= p.maxAttempts) { r.status = "failed_fatal"; return r.status; }
    r.status = "failed_retryable";
    r.nextRetryAtMs = nowMs + p.backoffMs[Math.min(r.attempts - 1, p.backoffMs.length - 1)];
    return r.status;
  }
  async deliveryRecord(id: string) { return this.del.get(id); }
  async hasSentDelivery(prefix: string) {
    for (const [id, r] of this.del) if (id.startsWith(prefix) && r.status === "sent") return true;
    return false;
  }
}

/* ---------------- Postgres 正式實作(注入 query;fence=attempts) ---------------- */
export type Query = (sql: string, params: unknown[]) => Promise<{ rowCount: number; rows: any[] }>;
export const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS push_occurrence (id text PRIMARY KEY, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS push_candidate (
  id text PRIMARY KEY, node text NOT NULL, et_date text NOT NULL,
  status text NOT NULL, content_hash text NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS push_delivery (
  id text PRIMARY KEY, status text NOT NULL, attempts int NOT NULL,
  lease_until timestamptz, next_retry_at timestamptz, last_error text,
  updated_at timestamptz DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_cand_node_date ON push_candidate(node, et_date);
`;
export class PostgresPushStore implements PushStore {
  private q: Query;
  constructor(q: Query) { this.q = q; }
  async ensureOccurrence(id: string) {
    await this.q(`INSERT INTO push_occurrence(id) VALUES($1) ON CONFLICT DO NOTHING`, [id]);
  }
  async lastDeliveredHash(node: string) {
    const r = await this.q(
      `SELECT c.content_hash FROM push_candidate c
       WHERE c.node=$1 AND c.status='eligible'
         AND EXISTS (SELECT 1 FROM push_delivery d
                     WHERE d.id LIKE 'del:' || substr(c.id, 5) || ':%' AND d.status='sent')
       ORDER BY c.created_at DESC LIMIT 1`, [node]);
    return r.rows[0]?.content_hash ?? null;
  }
  async recordCandidate(id: string, node: string, status: CandidateStatus, hash: string) {
    const etDate = id.split(":")[2];
    await this.q(`INSERT INTO push_candidate(id,node,et_date,status,content_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id, node, etDate, status, hash]);
  }
  async candidateStatus(id: string) {
    const r = await this.q(`SELECT status FROM push_candidate WHERE id=$1`, [id]);
    return r.rows[0]?.status;
  }
  async candidatesFor(node: string, etDate: string) {
    const r = await this.q(`SELECT status FROM push_candidate WHERE node=$1 AND et_date=$2`, [node, etDate]);
    return r.rows.map((x: any) => x.status);
  }
  async claimDelivery(id: string, nowMs: number, p: RetryPolicy): Promise<ClaimResult> {
    const now = new Date(nowMs).toISOString();
    const lease = new Date(nowMs + p.leaseMs).toISOString();
    const ins = await this.q(`INSERT INTO push_delivery(id,status,attempts,lease_until)
      VALUES($1,'claimed',1,$2) ON CONFLICT DO NOTHING RETURNING attempts`, [id, lease]);
    if (ins.rowCount === 1) return { outcome: "acquired", fenceToken: 1 };
    // P0-2:過期且耗盡 → failed_fatal(獨立轉換,不留 claimed)
    await this.q(`UPDATE push_delivery SET status='failed_fatal',
        last_error='lease expired, attempts exhausted', lease_until=NULL, updated_at=now()
      WHERE id=$1 AND status='claimed' AND lease_until <= $2 AND attempts >= $3`,
      [id, now, p.maxAttempts]);
    const upd = await this.q(`UPDATE push_delivery SET status='claimed', attempts=attempts+1,
        lease_until=$2, next_retry_at=NULL, updated_at=now()
      WHERE id=$1 AND attempts < $3 AND (
        (status='failed_retryable' AND next_retry_at <= $4) OR
        (status='claimed' AND lease_until <= $4))
      RETURNING attempts`, [id, lease, p.maxAttempts, now]);
    if (upd.rowCount === 1) return { outcome: "acquired", fenceToken: upd.rows[0].attempts };
    const rec = await this.deliveryRecord(id);
    if (!rec) return { outcome: "denied", reason: "in_flight" };
    const reason = rec.status === "sent" ? "already_sent"
      : rec.status === "failed_fatal" ? "failed_fatal"
      : rec.status === "claimed" ? "in_flight"
      : rec.attempts >= p.maxAttempts ? "attempts_exhausted" : "retry_backoff";
    return { outcome: "denied", reason };
  }
  async completeDelivery(id: string, token: number) {
    const r = await this.q(`UPDATE push_delivery SET status='sent', lease_until=NULL, updated_at=now()
      WHERE id=$1 AND status='claimed' AND attempts=$2`, [id, token]);   // fencing
    return r.rowCount === 1 ? "applied" as const : "stale" as const;
  }
  async failDelivery(id: string, token: number, retryable: boolean, nowMs: number, p: RetryPolicy, err: string) {
    if (!retryable) {
      const r = await this.q(`UPDATE push_delivery SET status='failed_fatal', last_error=$3, lease_until=NULL
        WHERE id=$1 AND status='claimed' AND attempts=$2`, [id, token, err]);
      return r.rowCount === 1 ? "failed_fatal" as DeliveryStatus : "stale" as const;
    }
    const nraTerm = `CASE WHEN attempts >= $4 THEN NULL ELSE $3 END`;
    const nra = new Date(nowMs + p.backoffMs[Math.min(token - 1, p.backoffMs.length - 1)]).toISOString();
    const r = await this.q(`UPDATE push_delivery SET
        status = CASE WHEN attempts >= $4 THEN 'failed_fatal' ELSE 'failed_retryable' END,
        next_retry_at = ${nraTerm}, last_error=$5, lease_until=NULL, updated_at=now()
      WHERE id=$1 AND status='claimed' AND attempts=$2 RETURNING status`,
      [id, token, nra, p.maxAttempts, err]);
    return r.rowCount === 1 ? (r.rows[0].status as DeliveryStatus) : "stale" as const;
  }
  async deliveryRecord(id: string) {
    const r = await this.q(`SELECT status,attempts,lease_until,next_retry_at,last_error
      FROM push_delivery WHERE id=$1`, [id]);
    const row = r.rows[0]; if (!row) return undefined;
    return { status: row.status, attempts: row.attempts, fenceToken: row.attempts,
      leaseUntilMs: row.lease_until ? Date.parse(row.lease_until) : null,
      nextRetryAtMs: row.next_retry_at ? Date.parse(row.next_retry_at) : null,
      lastError: row.last_error } as DeliveryRecord;
  }
  async hasSentDelivery(prefix: string) {
    const r = await this.q(`SELECT 1 FROM push_delivery WHERE id LIKE $1 AND status='sent' LIMIT 1`, [prefix + "%"]);
    return r.rowCount > 0;
  }
}

/* ---------------- 管線步驟 ---------------- */
export interface GateInput { fixedCandidate: boolean; current: DecisionSnapshot; lastDeliveredHash: string | null; }
export function publicationGate(g: GateInput): CandidateStatus {
  if (g.current.dataQuality === "invalid") return "skipped_data_quality";
  if (!g.fixedCandidate && g.lastDeliveredHash === g.current.contentHash) return "skipped_no_change";
  return "eligible";
}

export async function evaluateCandidate(store: PushStore, node: string, etDate: string,
  fixedCandidate: boolean, snap: DecisionSnapshot): Promise<{ candId: string; status: CandidateStatus }> {
  await store.ensureOccurrence(occurrenceId(node, etDate));
  const candId = candidateId(node, etDate, snap.decisionVersion);
  const existing = await store.candidateStatus(candId);
  if (existing) return { candId, status: existing };
  const status = publicationGate({ fixedCandidate, current: snap,
    lastDeliveredHash: await store.lastDeliveredHash(node) });
  await store.recordCandidate(candId, node, status, snap.contentHash);
  return { candId, status };
}

export async function deliverToRecipient(store: PushStore, candId: string, r: RecipientRef,
  nowMs: number, send: () => Promise<{ ok: boolean; httpStatus: number | null }>,
  policy: RetryPolicy = DEFAULT_RETRY)
  : Promise<DeliveryStatus | `denied_${ClaimDenyReason}` | "stale"> {
  const id = deliveryId(candId, r);
  const claim = await store.claimDelivery(id, nowMs, policy);
  if (claim.outcome === "denied") return `denied_${claim.reason}`;
  try {
    const res = await send();
    if (res.ok) {
      const w = await store.completeDelivery(id, claim.fenceToken);
      return w === "applied" ? "sent" : "stale";
    }
    return await store.failDelivery(id, claim.fenceToken,
      classifySendError(res.httpStatus) === "retryable", nowMs, policy, `http ${res.httpStatus}`);
  } catch (e) {
    return await store.failDelivery(id, claim.fenceToken, true, nowMs, policy, String(e));
  }
}

/** P0-3:occurrence 結果推導含 skipped */
export type OccurrenceOutcome = "pending" | "delivered" | "skipped" | "missed";
export async function deriveOccurrenceOutcome(store: PushStore, node: string, etDate: string,
  pastWindow: boolean): Promise<OccurrenceOutcome> {
  if (await store.hasSentDelivery(`del:${node}:${etDate}:`)) return "delivered";
  const cands = await store.candidatesFor(node, etDate);
  if (!pastWindow) return "pending";
  if (cands.length > 0 && cands.every(c => c.startsWith("skipped"))) return "skipped";
  return "missed"; // 有 eligible 卻無 sent,或整窗未評估
}
