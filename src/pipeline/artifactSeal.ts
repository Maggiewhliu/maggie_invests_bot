/**
 * src/pipeline/artifactSeal.ts — Decision Artifact 密封 v2(最終驗收 P0-A / P0-B)
 *
 * P0-A:seal 不再接受呼叫端提交的任何 hash。
 *   - 來源證據只能經 ProvenanceStore.attest()(供應商 adapter 的 ingestion 邊界)登錄,
 *     seal 以 provenanceId 讀取,嚴格驗證 64 位 hex;不存在或格式不符 → 拒絕密封。
 *   - contentHash 與 rendering hash 由 seal 自行對「文字本身」計算。
 * P0-B:發布政策(channel/node/etDate/candidateMode/feature/minTier/licenseUse)
 *   一併納入 HMAC;publish() 只讀 sealed policy,呼叫端無法重新提交這些欄位。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

export interface SourceRef {
  provenanceId: string;
  licenseContext: string;
  rawProvenanceHash: string;   // 由 gateway 對 rawPayload 計算,呼叫端無法提供
  normalizedHash: string;      // 由 gateway 對 normalizedData 計算,呼叫端無法提供
}

/**
 * P0-1:Ingestion Gateway。
 *  - Writer 只收「原始 payload + 正規化資料」,兩個 SHA-256 由 gateway 自行計算;
 *    介面上不存在任何可傳入 hash 的參數。
 *  - supplier/dataset 由 Provider adapter 設定決定(adapter 建構時持有 writer)。
 *  - Seal 與業務層只能取得 Reader;寫入權不外流。
 */
export interface IngestInput {
  supplier: string; dataset: string;
  rawPayload: string;          // 供應商原始回應逐字
  normalizedData: unknown;     // 正規化後資料(gateway 以 canonical JSON 計 hash)
}
export interface ProvenanceWriter { ingest(input: IngestInput): string; }
export interface ProvenanceReader { get(id: string): SourceRef | undefined; }

export class ProvenanceLedger implements ProvenanceWriter, ProvenanceReader {
  private m = new Map<string, SourceRef>();
  ingest(input: IngestInput): string {
    if (!input.supplier?.trim() || !input.dataset?.trim())
      throw new Error("ingest: supplier/dataset required");
    if (typeof input.rawPayload !== "string" || input.rawPayload.length === 0)
      throw new Error("ingest: rawPayload required");
    const rawProvenanceHash = sha256(input.rawPayload);
    const normalizedHash = sha256(JSON.stringify(input.normalizedData));
    const id = `prov:${rawProvenanceHash.slice(0, 16)}:${normalizedHash.slice(0, 16)}`;
    this.m.set(id, { provenanceId: id,
      licenseContext: `${input.supplier}/${input.dataset}`,
      rawProvenanceHash, normalizedHash });
    return id;
  }
  get(id: string) { return this.m.get(id); }
  /** 業務層注入用:只暴露讀取能力 */
  reader(): ProvenanceReader { return { get: (id) => this.get(id) }; }
}

export interface PublishPolicy {
  channel: "telegram" | "email";
  node: string;
  etDate: string;
  candidateMode: "fixed" | "conditional";
  feature: string;
  minTier: 0 | 1 | 2 | 3 | 4;
  licenseUse: string;
}
export interface Rendering { lang: string; sha256: string; }

export interface ArtifactCore {
  decisionVersion: string;
  contentHash: string;                       // 主要語言全文 sha256(seal 自算)
  dataQuality: "real" | "incomplete" | "stale" | "invalid";
  sourceRefs: SourceRef[];                   // 從 ProvenanceStore 讀出後凍結
  renderings: Rendering[];                   // seal 對文字自算
  policy: PublishPolicy;                     // P0-B:政策入簽
  sealedAt: string;
}
export interface SealedArtifact extends ArtifactCore { hmac: string; }

function canonical(core: ArtifactCore): string {
  const p = core.policy;
  return JSON.stringify({
    v: core.decisionVersion, c: core.contentHash, q: core.dataQuality,
    s: [...core.sourceRefs].map(r =>
      `${r.provenanceId}|${r.licenseContext}|${r.rawProvenanceHash}|${r.normalizedHash}`).sort(),
    r: [...core.renderings].map(x => `${x.lang}|${x.sha256}`).sort(),
    p: [p.channel, p.node, p.etDate, p.candidateMode, p.feature, p.minTier, p.licenseUse].join("|"),
    t: core.sealedAt,
  });
}

export interface SealInput {
  decisionVersion: string;
  dataQuality: ArtifactCore["dataQuality"];
  provenanceIds: string[];
  renderings: { lang: string; text: string }[];   // 給文字,不給 hash
  policy: PublishPolicy;
  primaryLang?: string;
}

export function sealDecisionArtifact(input: SealInput, prov: ProvenanceReader,
  secret: string): SealedArtifact {
  if (!secret) throw new Error("ARTIFACT_HMAC_SECRET missing — refuse to seal");
  if (!input.provenanceIds.length) throw new Error("seal: no provenance");
  const sourceRefs: SourceRef[] = input.provenanceIds.map(id => {
    const rec = prov.get(id);
    if (!rec) throw new Error(`seal: provenance not found: ${id}`);
    if (!HEX64.test(rec.rawProvenanceHash) || !HEX64.test(rec.normalizedHash))
      throw new Error(`seal: provenance hashes invalid: ${id}`);
    return { ...rec };
  });
  if (!input.renderings.length) throw new Error("seal: no renderings");
  const renderings: Rendering[] = input.renderings.map(r => ({ lang: r.lang, sha256: sha256(r.text) }));
  const primary = input.renderings.find(r => r.lang === (input.primaryLang ?? input.renderings[0].lang))!;
  const full: ArtifactCore = {
    decisionVersion: input.decisionVersion,
    contentHash: sha256(primary.text),
    dataQuality: input.dataQuality,
    sourceRefs, renderings, policy: input.policy,
    sealedAt: new Date().toISOString(),
  };
  return { ...full, hmac: createHmac("sha256", secret).update(canonical(full)).digest("hex") };
}

export function verifySealedArtifact(a: SealedArtifact, secret: string): boolean {
  if (!secret || !a?.hmac || !HEX64.test(a.hmac)) return false;
  const expect = createHmac("sha256", secret).update(canonical(a)).digest("hex");
  const A = Buffer.from(a.hmac, "hex"); const B = Buffer.from(expect, "hex");
  return A.length === B.length && timingSafeEqual(A, B);
}

export function renderingMatches(a: SealedArtifact, lang: string, text: string): boolean {
  const h = sha256(text);
  return a.renderings.some(r => r.lang === lang && r.sha256 === h);
}
