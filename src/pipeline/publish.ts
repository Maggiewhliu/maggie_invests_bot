/**
 * src/pipeline/publish.ts — 完整發布管線(唯一對外送出路徑)
 * 順序(不可跳過):
 *   資料品質 → License Registry → Tier Access → Content Risk Guard
 *   → 人工核准閘門 → Recipient Delivery → 原子去重/重試 → Telegram
 */
import { assertPublishable, ApprovalRequiredError, ContentRiskError,
  type ApprovalRecord } from "../contentRiskGuard.ts";
import { canAccess, type Tier, type UserContext } from "../tierAccess.ts";
import { LicenseRegistry } from "../licenseRegistry.ts";
import { evaluateCandidate, deliverToRecipient, type PushStore,
  type DecisionSnapshot } from "../pushCore.ts";
import type { BotUser, RecipientProvider } from "../providers/recipientAdapter.ts";
import { verifySealedArtifact, renderingMatches, type SealedArtifact } from "./artifactSeal.ts";
import type { TelegramTransport } from "../providers/telegramTransport.ts";

export type BlockReason =
  | "blocked_data_quality" | "blocked_stale_data" | "blocked_license" | "blocked_entitlement"
  | "blocked_content_risk" | "requires_approval" | "blocked_artifact" | "blocked_channel_mismatch";

export interface PublishRequest {
  /** P0-B:node/etDate/candidateMode/feature/minTier/licenseUse 全部只讀 sealed policy,
   *  呼叫端不再提交任何政策欄位。 */
  artifact: SealedArtifact;
  renderFor: (u: BotUser) => string;   // 依語言產生文字(須命中密封 rendering hash)
  approval?: ApprovalRecord;
}
export interface PublishOutcome {
  candidateStatus: string; blocked?: BlockReason;
  sent: string[]; skipped: { userId: string; reason: string }[];
  noRecipients: boolean;
}

export async function publish(req: PublishRequest, deps: {
  store: PushStore; recipients: RecipientProvider; transport: TelegramTransport;
  license: LicenseRegistry; env?: Record<string, string | undefined>; nowMs?: number;
}): Promise<PublishOutcome> {
  const env = deps.env ?? process.env;
  const nowMs = deps.nowMs ?? Date.now();
  const out: PublishOutcome = { candidateStatus: "", sent: [], skipped: [], noRecipients: false };

  // 0. Artifact 驗簽(P0-1):偽造或竄改 → 一律擋,不進任何後續步驟
  const secret = env["ARTIFACT_HMAC_SECRET"] ?? "";
  if (!verifySealedArtifact(req.artifact, secret)) {
    out.candidateStatus = "rejected_artifact"; out.blocked = "blocked_artifact"; return out;
  }
  const pol = req.artifact.policy;
  // P0-2:實際 transport 必須就是密封政策指定的頻道;不符 → 零送出
  if (deps.transport.channel !== pol.channel) {
    out.candidateStatus = "rejected_channel"; out.blocked = "blocked_channel_mismatch"; return out;
  }
  const fixedCandidate = pol.candidateMode === "fixed";
  // 0.5 stale 與一般缺漏區分:條件節點遇資料過期不發;固定候選放行但文內已標示過期標的
  if (req.artifact.dataQuality === "stale" && !fixedCandidate) {
    out.candidateStatus = "skipped_stale_data"; out.blocked = "blocked_stale_data"; return out;
  }

  // 1. 資料品質 + 有無變化(Candidate 層;stale 映射為 incomplete 進封板核心)
  const cand = await evaluateCandidate(deps.store, pol.node, pol.etDate,
    fixedCandidate, { decisionVersion: req.artifact.decisionVersion,
      contentHash: req.artifact.contentHash,
      dataQuality: req.artifact.dataQuality === "stale" ? "incomplete" : req.artifact.dataQuality });
  out.candidateStatus = cand.status;
  if (cand.status !== "eligible") {
    if (cand.status === "skipped_data_quality") out.blocked = "blocked_data_quality";
    return out;
  }

  // 2. 收件人展開(minTier 來自 sealed policy)
  const users = await deps.recipients.expand(pol.minTier as Tier);
  if (users.length === 0) { out.noRecipients = true; return out; }

  for (const u of users) {
    // 3. License:由 artifact.sourceRefs 推導;use 來自 sealed policy
    const use = pol.licenseUse;
    let granted = req.artifact.sourceRefs.length > 0;
    for (const ref of req.artifact.sourceRefs) {
      const [supplier, dataset] = ref.licenseContext.split("/");
      const attested = ref.rawProvenanceHash?.length === 64 && ref.normalizedHash?.length === 64;
      if (!supplier || !dataset || !attested) { granted = false; break; }
      if (!deps.license.isGranted({ supplier, dataset, channel: pol.channel,
        jurisdiction: u.jurisdiction, use })) { granted = false; break; }
    }
    if (!granted) { out.skipped.push({ userId: u.userId, reason: "blocked_license" }); continue; }

    // 4. Tier / entitlement
    const ctx: UserContext = { tier: u.tier, jurisdictionPaidAllowed: u.jurisdictionPaidAllowed };
    const acc = canAccess(ctx, pol.feature, env);
    if (!acc.allowed) { out.skipped.push({ userId: u.userId, reason: acc.reason }); continue; }

    // 5. 措辭 + 人工核准 + rendering 綁定(P0-1:文字必須命中密封 hash)
    let text: string;
    const rendered = req.renderFor(u);
    if (!renderingMatches(req.artifact, u.lang, rendered)) {
      out.skipped.push({ userId: u.userId, reason: "blocked_artifact" }); continue;
    }
    try { text = assertPublishable(rendered, `${pol.node}:${u.userId}`, req.approval).text; }
    catch (e) {
      const reason = e instanceof ApprovalRequiredError ? "requires_approval"
        : e instanceof ContentRiskError ? "blocked_content_risk" : "blocked_content_risk";
      out.skipped.push({ userId: u.userId, reason }); continue;
    }

    // 6. 投遞(原子認領 + fencing + 重試由 pushCore 管)
    const st = await deliverToRecipient(deps.store, cand.candId,
      { channel: pol.channel, recipientKey: u.chatId, lang: u.lang }, nowMs,
      () => deps.transport.sendMessage(u.chatId, text));
    if (st === "sent") out.sent.push(u.userId);
    else out.skipped.push({ userId: u.userId, reason: String(st) });
  }
  return out;
}
