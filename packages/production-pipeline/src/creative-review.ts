import { createHash, randomUUID } from "node:crypto";

export const CREATIVE_REVIEW_VERSION = "video-factory/creative-review-v1" as const;
export const CREATIVE_REVIEW_FEATURE = "user-confirmed-v1" as const;

export type CreativeStage = "treatment" | "script" | "director";
export type CreativeReviewPhase = "drafting" | "waiting_user" | "responding" | "checking" | "confirmed";

export interface CreativeReviewMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  commandId: string;
}

export interface CreativeReviewProposal {
  proposalId: string;
  baseDraftSha256: string;
  draft: CreativeDraftRef;
  document: unknown;
  changeSummary: string[];
  commandId: string;
}

export interface EffectiveUserInstruction {
  commandId: string;
  message: string;
  active: boolean;
}

export interface CreativeDiscussionSelection {
  kind: "document" | "beat" | "scene";
  ids: string[];
  scenePositions: number[];
}

export interface CreativeDiscussionResult {
  stage: CreativeStage;
  intent: "explain" | "propose" | "revise" | "clarify" | "request_upstream_change";
  reply: string;
  changeSummary: string[];
  treatment: unknown | null;
  script: unknown | null;
  director: unknown | null;
  upstreamRequest: { stage: "treatment" | "script"; reason: string } | null;
}

export function parseCreativeDiscussionResult(value: unknown): CreativeDiscussionResult {
  if (!isRecord(value)) throw new Error("Creative discussion result must be an object.");
  const allowed = new Set([
    "stage", "intent", "reply", "changeSummary", "treatment", "script", "director", "upstreamRequest",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Creative discussion result field '${unknown}' is not allowed.`);
  if (value.stage !== "treatment" && value.stage !== "script" && value.stage !== "director") {
    throw new Error("Creative discussion result stage is invalid.");
  }
  if (!["explain", "propose", "revise", "clarify", "request_upstream_change"].includes(String(value.intent))) {
    throw new Error("Creative discussion result intent is invalid.");
  }
  const reply = requiredText(value.reply, "reply");
  const changeSummary = textArray(value.changeSummary, "changeSummary", 12);
  const upstreamRequest = value.upstreamRequest === null
    ? null
    : parseCreativeUpstreamRequest(value.upstreamRequest);
  return {
    stage: value.stage,
    intent: value.intent as CreativeDiscussionResult["intent"],
    reply,
    changeSummary,
    treatment: value.treatment ?? null,
    script: value.script ?? null,
    director: value.director ?? null,
    upstreamRequest,
  };
}

function parseCreativeUpstreamRequest(value: unknown): NonNullable<CreativeDiscussionResult["upstreamRequest"]> {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "stage" && key !== "reason")) {
    throw new Error("Creative discussion upstreamRequest is invalid.");
  }
  if (value.stage !== "treatment" && value.stage !== "script") {
    throw new Error("Creative discussion upstreamRequest.stage is invalid.");
  }
  return { stage: value.stage, reason: requiredText(value.reason, "upstreamRequest.reason") };
}

export interface CreativeReviewDiscussResume {
  action: "discuss" | "revise";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
  message: string;
  selection?: CreativeDiscussionSelection;
}

export interface CreativeReviewAdoptResume {
  action: "adopt_proposal";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
  proposalId: string;
}

export interface CreativeReviewEditDraftResume {
  action: "edit_draft";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
  /** 人工修订后的整份阶段稿。进入状态前由 gate 层按阶段合同校验（这里只保证存在且是对象）。 */
  document: unknown;
}

export interface CreativeReviewUndoResume {
  action: "undo_draft";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
}

export interface CreativeReviewReturnResume {
  action: "return_to_stage";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
  targetStage: CreativeStage;
  acknowledgeImpact: true;
}

export interface CreativeDraftRef {
  artifactId: string;
  sha256: string;
  revision: number;
  /** 不可变版本身份：A→B→A 的第三版与第一版文字相同，但 versionId 不同（TX-03/B03）。 */
  versionId: string;
  stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
}

/** 一条不可变的独立审计记录：绑定它所审的那个精确版本（A05）。 */
export interface CreativeAuditRecord {
  auditId: string;
  versionId: string;
  draftSha256: string;
  checkIdentity: string;
  recordedAt: string;
  source: "initial" | "manual";
  result: CreativeReviewCheckResult;
}

export interface CreativeStageConfirmation {
  libraryEvidenceDigest?: string;
  /** 用户采用的那一版；与 draftSha256 共同构成决定目标。 */
  versionId: string;
  draftSha256: string;
  stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
  /** 本版有审计时是所看那条审计的身份；未审采用时不存在，绝不虚构。 */
  checkIdentity?: string;
  /** 本版采用的审计记录 id；未审采用为 null。 */
  auditId: string | null;
  /** 用户明确承担「本版未经审计」的采用；与 repair 承担、费用授权是三件事。 */
  unauditedAdoption?: true;
  actor: string;
  confirmedAt: string;
  commandId: string;
  // 记录"确认时独立复核给的是 repair 且被人接受"，留痕供事后核查是谁在什么结论下放行的。
  acknowledgedRepair?: { verdict: "repair"; score: number; issueCount: number };
  acknowledgedIncomplete?: true;
  deliveryAcceptance?: StockDeliveryAcceptance;
}

/** 宿主在导演确认后生成；质量采用范围不是付费授权，也不能由模型生成。 */
export interface StockDeliveryAcceptance {
  policyVersion: "playable-first-v1";
  scopeDigest: string;
  inventorySha256?: string;
  scenePositions: number[];
  actor: string;
  commandId: string;
  confirmedAt: string;
}

export interface CreativeStageReviewState {
  phase: CreativeReviewPhase;
  currentDraft: CreativeDraftRef | null;
  previousDraft: CreativeDraftRef | null;
  confirmation: CreativeStageConfirmation | null;
  messages: CreativeReviewMessage[];
  currentDocument: unknown | null;
  previousDocument: unknown | null;
  proposals: CreativeReviewProposal[];
  effectiveUserInstructions: EffectiveUserInstruction[];
  previousEffectiveUserInstructions?: EffectiveUserInstruction[];
  checkResult: CreativeReviewCheckResult | null;
  /** 本版累积的全部审计记录（含历史轮）；checkResult 指向最新一条。 */
  auditHistory: CreativeAuditRecord[];
  /** 每版全文快照；旧 run 缺失时由投影层如实标记历史不足。 */
  versionHistory: Array<{ draft: CreativeDraftRef; document: unknown }>;
  /** 已作出的采用决定；不能因返回上游或改稿而抹除。 */
  confirmationHistory: CreativeStageConfirmation[];
}

export type CreativeReviewCheckResult = {
  draftSha256: string;
  checkIdentity: string;
  summary: string;
  /** 审计绑定的精确版本；缺失时按当前版本解释（旧数据兼容），新记录必须携带。 */
  versionId?: string;
  /** 本条审计的记录 id；与 auditHistory 对齐。 */
  auditId?: string;
} & ({
  status?: "completed";
  verdict: "pass" | "repair";
  score: number;
  issues: Array<{ severity: "advisory" | "blocking"; criterion: string; evidence: string; repairInstruction: string }>;
} | { status: "incomplete"; verdict?: never; score?: never; issues: [] });

export interface CreativeReviewState {
  version: typeof CREATIVE_REVIEW_VERSION;
  activeStage: CreativeStage;
  reviewRevision: number;
  /** 导演初稿与选材方案复用同一讨论机制，但必须保留各自的决定语义。 */
  directorReviewPurpose?: "direction" | "material_plan";
  directionConfirmation?: CreativeStageConfirmation | undefined;
  stages: Record<CreativeStage, CreativeStageReviewState>;
}

export interface CreativeReviewGate {
  kind: "creative_review";
  stage: CreativeStage;
  purpose?: "direction" | "material_plan";
  reviewRevision: number;
  draft: CreativeDraftRef;
}

export interface CreativeReviewConfirmResume {
  action: "confirm";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
  /** 本版有审计时必填（用户看过的那条）；未审采用不得携带。 */
  checkIdentity?: string;
  confirmedAt: string;
  /** 显式承担「本版未经审计」；与 repair/incomplete 承认互斥。 */
  acknowledgeUnaudited?: true;
  // 独立复核是"提议"而非"否决"：裁决为 repair 时默认仍拦住流程，但人可以显式承担后继续。
  // 与 return_to_stage 的 acknowledgeImpact 同一模式，取舍被记录进 confirmation 而不是被静默跳过。
  acknowledgeRepair?: true;
  acknowledgeIncomplete?: true;
  acceptQualityFallback?: true;
}

export interface CreativeReviewAuditCurrentResume {
  action: "audit_current";
  stage: CreativeStage;
  commandId: string;
  actor: string;
  baseDraftSha256: string;
  expectedReviewRevision: number;
}

export type CreativeReviewResume =
  | CreativeReviewConfirmResume
  | CreativeReviewDiscussResume
  | CreativeReviewAdoptResume
  | CreativeReviewEditDraftResume
  | CreativeReviewUndoResume
  | CreativeReviewReturnResume
  | CreativeReviewAuditCurrentResume;

const CREATIVE_STAGE_ORDER: CreativeStage[] = ["treatment", "script", "director"];

export function returnCreativeReviewToStage(
  review: CreativeReviewState,
  command: CreativeReviewReturnResume,
): CreativeReviewState {
  requireWaitingDraft(review, command);
  if (!command.acknowledgeImpact) throw new Error("Returning to a creative stage requires acknowledged impact.");
  const currentIndex = CREATIVE_STAGE_ORDER.indexOf(command.stage);
  const targetIndex = CREATIVE_STAGE_ORDER.indexOf(command.targetStage);
  if (targetIndex < 0 || targetIndex > currentIndex) {
    throw new Error("Creative review can only return to the current or an already reached upstream stage.");
  }
  const target = review.stages[command.targetStage];
  if (!target.currentDraft || target.currentDocument === null) {
    throw new Error("The requested upstream creative stage has no persisted draft.");
  }
  const stages = structuredClone(review.stages);
  for (let index = targetIndex; index < CREATIVE_STAGE_ORDER.length; index += 1) {
    const stage = CREATIVE_STAGE_ORDER[index]!;
    const current = stages[stage];
    current.confirmation = null;
    current.checkResult = null;
    current.phase = stage === command.targetStage ? "waiting_user" : "drafting";
    if (stage === command.targetStage && current.currentDraft) {
      // 被退回的这一版草稿内容未变：versionId 相同的历史审计仍然适用，恢复最新一条，
      // 避免对同一份文字重复烧一轮审计（审计适用性随版本，不随确认状态失效）。
      const applicable = [...current.auditHistory]
        .reverse()
        .find((record) => record.versionId === current.currentDraft!.versionId);
      if (applicable) current.checkResult = structuredClone(applicable.result);
    }
  }
  stages[command.targetStage].messages.push({
    id: `${command.commandId}:assistant`,
    role: "assistant",
    text: returnImpactMessage(command.targetStage),
    commandId: command.commandId,
  });
  return {
    ...review,
    directionConfirmation: undefined,
    activeStage: command.targetStage,
    reviewRevision: review.reviewRevision + 1,
    stages,
  };
}

export function creativeReturnTargets(review: CreativeReviewState): CreativeStage[] {
  const currentIndex = CREATIVE_STAGE_ORDER.indexOf(review.activeStage);
  return CREATIVE_STAGE_ORDER.slice(0, currentIndex + 1)
    .filter((stage) => review.stages[stage].currentDraft !== null);
}

function returnImpactMessage(stage: CreativeStage): string {
  if (stage === "treatment") return "已返回前期构思。脚本、导演方案及其后续确认已失效；已有历史稿件和素材保留，重新确认后再生成下游。";
  if (stage === "script") return "已返回脚本。前期构思确认保留，导演方案及其后续确认已失效；已有历史稿件和素材保留。";
  return "仍停留在导演方案；当前版本需要重新确认。";
}

function emptyStage(): CreativeStageReviewState {
  return {
    phase: "drafting",
    currentDraft: null,
    previousDraft: null,
    confirmation: null,
    messages: [],
    currentDocument: null,
    previousDocument: null,
    proposals: [],
    effectiveUserInstructions: [],
    checkResult: null,
    auditHistory: [],
    versionHistory: [],
    confirmationHistory: [],
  };
}

export function initialCreativeReviewState(): CreativeReviewState {
  return {
    version: CREATIVE_REVIEW_VERSION,
    activeStage: "treatment",
    reviewRevision: 0,
    stages: { treatment: emptyStage(), script: emptyStage(), director: emptyStage() },
  };
}

export function contentSha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/** 版本身份只由逻辑 artifact 与单调 revision 构成：相同文字的不同版本 id 不同（B03）。 */
export function creativeVersionId(artifactId: string, revision: number): string {
  return `${artifactId}#v${revision}`;
}

export function publishCreativeDraft(
  review: CreativeReviewState,
  stage: CreativeStage,
  artifactId: string,
  output: unknown,
  stageInputDigest: string,
): CreativeReviewState {
  const current = review.stages[stage];
  const sha256 = contentSha256(output);
  const sameDraft = current.currentDraft?.artifactId === artifactId
    && current.currentDraft.sha256 === sha256
    && current.currentDraft.stageInputDigest === stageInputDigest;
  const revision = sameDraft ? current.currentDraft!.revision : (current.currentDraft?.revision ?? 0) + 1;
  const nextDraft: CreativeDraftRef = {
    artifactId,
    sha256,
    revision,
    versionId: creativeVersionId(artifactId, revision),
    stageInputDigest,
    upstreamConfirmedDigests: upstreamDigests(review, stage),
  };
  return {
    ...review,
    activeStage: stage,
    reviewRevision: sameDraft && current.phase === "waiting_user"
      ? review.reviewRevision
      : review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [stage]: {
        ...current,
        phase: "waiting_user",
        currentDraft: nextDraft,
        versionHistory: sameDraft ? (current.versionHistory ?? []) : [
          ...(current.versionHistory ?? []),
          { draft: structuredClone(nextDraft), document: structuredClone(output) },
        ],
        previousDraft: sameDraft ? current.previousDraft : current.currentDraft,
        currentDocument: structuredClone(output),
        previousDocument: sameDraft ? current.previousDocument : current.currentDocument,
        previousEffectiveUserInstructions: sameDraft
          ? current.previousEffectiveUserInstructions
          : structuredClone(current.effectiveUserInstructions),
        confirmation: null,
        checkResult: sameDraft ? current.checkResult : null,
      },
    },
  };
}

export function creativeReviewGate(review: CreativeReviewState, stage: CreativeStage): CreativeReviewGate {
  const current = review.stages[stage];
  if (review.activeStage !== stage || current.phase !== "waiting_user" || !current.currentDraft) {
    throw new Error(`Creative review stage '${stage}' is not waiting for a current draft.`);
  }
  return {
    kind: "creative_review",
    stage,
    ...(stage === "director" ? { purpose: review.directorReviewPurpose ?? "material_plan" } : {}),
    reviewRevision: review.reviewRevision,
    draft: current.currentDraft,
  };
}

export function confirmCreativeDraft(review: CreativeReviewState, raw: unknown): CreativeReviewState {
  const command = parseCreativeReviewConfirmResume(raw);
  const current = review.stages[command.stage];
  const draft = current.currentDraft;
  if (review.activeStage !== command.stage || current.phase !== "waiting_user" || !draft) {
    throw new Error(`Creative review stage '${command.stage}' is not awaiting confirmation.`);
  }
  if (command.expectedReviewRevision !== review.reviewRevision) {
    throw new Error("Creative review confirmation is stale: review revision changed.");
  }
  if (command.baseDraftSha256 !== draft.sha256) {
    throw new Error("Creative review confirmation is stale: draft content changed.");
  }
  // 本版审计必须绑定当前版本才算数；修订后的未审稿没有这条记录，只能走显式未审采用。
  const check = current.checkResult && current.checkResult.draftSha256 === draft.sha256
    && (current.checkResult.versionId === undefined || current.checkResult.versionId === draft.versionId)
    ? current.checkResult
    : null;
  if (!check) {
    if (command.acknowledgeUnaudited !== true) {
      throw new Error("Creative review confirmation requires an independent check for the current draft; adopt explicitly as unaudited to proceed.");
    }
    return {
      ...review,
      reviewRevision: review.reviewRevision + 1,
      stages: {
        ...review.stages,
        [command.stage]: {
          ...current,
          phase: "confirmed",
          confirmation: {
            versionId: draft.versionId,
            draftSha256: draft.sha256,
            stageInputDigest: draft.stageInputDigest,
            upstreamConfirmedDigests: { ...draft.upstreamConfirmedDigests },
            auditId: null,
            unauditedAdoption: true,
            actor: command.actor,
            confirmedAt: command.confirmedAt,
            commandId: command.commandId,
          },
          confirmationHistory: [
            ...(current.confirmationHistory ?? []),
            {
              versionId: draft.versionId, draftSha256: draft.sha256,
              stageInputDigest: draft.stageInputDigest,
              upstreamConfirmedDigests: { ...draft.upstreamConfirmedDigests },
              auditId: null, unauditedAdoption: true,
              actor: command.actor, confirmedAt: command.confirmedAt, commandId: command.commandId,
            },
          ],
        },
      },
    };
  }
  if (command.checkIdentity !== check.checkIdentity) {
    throw new Error("Creative review confirmation is stale: the recorded check is not the one the creator saw.");
  }
  if (check.status === "incomplete" ? command.acknowledgeIncomplete !== true
    : check.verdict !== "pass" && command.acknowledgeRepair !== true) {
    throw new Error("Creative review confirmation requires a passing independent check for the current draft.");
  }
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [command.stage]: {
        ...current,
        phase: "confirmed",
        confirmation: {
          versionId: draft.versionId,
          draftSha256: draft.sha256,
          stageInputDigest: draft.stageInputDigest,
          upstreamConfirmedDigests: { ...draft.upstreamConfirmedDigests },
          checkIdentity: check.checkIdentity,
          auditId: check.auditId ?? null,
          actor: command.actor,
          confirmedAt: command.confirmedAt,
          commandId: command.commandId,
          ...(check.status === "incomplete" ? { acknowledgedIncomplete: true as const } : {}),
          ...(check.verdict === "repair"
            ? { acknowledgedRepair: { verdict: "repair" as const, score: check.score, issueCount: check.issues.length } }
            : {}),
        },
        confirmationHistory: [
          ...(current.confirmationHistory ?? []),
          {
            versionId: draft.versionId, draftSha256: draft.sha256,
            stageInputDigest: draft.stageInputDigest,
            upstreamConfirmedDigests: { ...draft.upstreamConfirmedDigests },
            checkIdentity: check.checkIdentity, auditId: check.auditId ?? null,
            actor: command.actor, confirmedAt: command.confirmedAt, commandId: command.commandId,
            ...(check.status === "incomplete" ? { acknowledgedIncomplete: true as const } : {}),
            ...(check.verdict === "repair"
              ? { acknowledgedRepair: { verdict: "repair" as const, score: check.score, issueCount: check.issues.length } }
              : {}),
          },
        ],
      },
    },
  };
}

export function recordCreativeReviewCheck(
  review: CreativeReviewState,
  stage: CreativeStage,
  result: CreativeReviewCheckResult,
  options: { auditId?: string; source?: "initial" | "manual"; recordedAt?: string } = {},
): CreativeReviewState {
  const current = review.stages[stage];
  if (review.activeStage !== stage || current.phase !== "waiting_user" || !current.currentDraft) {
    throw new Error(`Creative review stage '${stage}' is not awaiting a check.`);
  }
  if (result.draftSha256 !== current.currentDraft.sha256) {
    throw new Error("Creative review check belongs to another draft.");
  }
  // 版本绑定：携带 versionId 的结果必须属于当前版本；A→B→A 的 V1 审计不能回挂 V3，
  // 相同文字不等于同一版本（TX-03/B03）。缺省（旧数据）按当前版本解释。
  if (result.versionId !== undefined && result.versionId !== current.currentDraft.versionId) {
    throw new Error("Creative review check belongs to another draft version.");
  }
  // R3-02：auditId 绑定持久化操作而非返回结果——生产路径必须由调用方传入
  // H(auditOperationId) 派生的稳定 id；缺失（测试/旧数据）才退回随机，但随机 id
  // 不参与幂等（找不到重放即正常追加）。
  const explicitAuditId = result.auditId ?? options?.auditId;
  const auditId = explicitAuditId ?? `audit-${randomUUID()}`;
  // R3-02 记账幂等（严格 no-op）：同一 auditId 再次登记时——
  // · 已应用（无论之后是否有更新的审计）：返回原状态，不回退 checkResult、
  //   不追加历史、不推进 reviewRevision（P12：A 后 B 再重放 A，当前必须仍是 B）；
  // · 完整比较（verdict/score/summary/draftSha256/versionId/checkIdentity/issues/source）
  //   任一不同 → 明确冲突（P09/P11：同操作异结果、同字节跨版本复用 auditId 均不放行）。
  const replayed = (current.auditHistory ?? []).find((entry) => entry.auditId === auditId);
  if (replayed) {
    const sameTarget = replayed.versionId === current.currentDraft.versionId
      && replayed.draftSha256 === result.draftSha256;
    const sameResult = replayed.result.verdict === result.verdict
      && replayed.result.score === result.score
      && replayed.result.summary === result.summary
      && replayed.result.checkIdentity === result.checkIdentity
      && replayed.result.issues.length === (result.issues?.length ?? 0)
      && replayed.result.issues.every((issue, index) => {
        const next = result.issues?.[index];
        return next !== undefined
          && issue.severity === next.severity
          && issue.criterion === next.criterion
          && issue.evidence === next.evidence
          && issue.repairInstruction === next.repairInstruction;
      })
      && replayed.source === (options?.source ?? "initial");
    if (!sameTarget || !sameResult) {
      throw new Error(
        sameTarget
          ? "同一审计操作的恢复结论与已记账结论不一致；请刷新后重新核对，不覆盖既有审计。"
          : "该审计编号属于另一版本的审计操作，不能登记到当前版本。",
      );
    }
    // 严格 no-op：已应用操作的重放只返回原回执（原状态原样），当前 checkResult 保持不变。
    return review;
  }
  const stamped: CreativeReviewCheckResult = {
    ...structuredClone(result),
    versionId: current.currentDraft.versionId,
    auditId,
  };
  const record: CreativeAuditRecord = {
    auditId,
    versionId: current.currentDraft.versionId,
    draftSha256: stamped.draftSha256,
    checkIdentity: stamped.checkIdentity,
    recordedAt: options?.recordedAt ?? new Date().toISOString(),
    source: options?.source ?? "initial",
    result: stamped,
  };
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [stage]: {
        ...current,
        phase: "waiting_user",
        checkResult: stamped,
        // 全部审计轮次留痕；checkResult 只指向最新一条（A05）。
        auditHistory: [...(current.auditHistory ?? []), record],
      },
    },
  };
}

export function recordCreativeDiscussion(
  review: CreativeReviewState,
  command: CreativeReviewDiscussResume,
  result: CreativeDiscussionResult,
): CreativeReviewState {
  const current = requireWaitingDraft(review, command);
  if (result.stage !== command.stage) throw new Error("Creative discussion result belongs to another stage.");
  if (!result.reply.trim()) throw new Error("Creative discussion reply must be non-empty.");
  if (result.changeSummary.length > 12 || result.changeSummary.some((entry) => !entry.trim())) {
    throw new Error("Creative discussion changeSummary is invalid.");
  }
  const document = discussionDocument(result);
  const messages = [
    ...current.messages,
    { id: `${command.commandId}:user`, role: "user" as const, text: command.message, commandId: command.commandId },
    { id: `${command.commandId}:assistant`, role: "assistant" as const, text: result.reply.trim(), commandId: command.commandId },
  ];
  if (command.action === "discuss" && result.intent === "revise") {
    messages[messages.length - 1] = {
      ...messages[messages.length - 1]!,
      text: `模型返回了修改稿，但你只请求讨论；当前稿未修改。${result.reply.trim()}`,
    };
    return {
      ...review,
      reviewRevision: review.reviewRevision + 1,
      stages: { ...review.stages, [command.stage]: { ...current, phase: "waiting_user", messages } },
    };
  }
  if (result.intent === "propose") {
    if (document === null) throw new Error("Creative discussion proposal is missing its stage document.");
    const draft = draftRefForDocument(current.currentDraft!, document);
    return {
      ...review,
      reviewRevision: review.reviewRevision + 1,
      stages: {
        ...review.stages,
        [command.stage]: {
          ...current,
          phase: "waiting_user",
          messages,
          proposals: [...current.proposals, {
            proposalId: `proposal:${command.commandId}`,
            baseDraftSha256: current.currentDraft!.sha256,
            draft,
            document: structuredClone(document),
            changeSummary: result.changeSummary.map((entry) => entry.trim()),
            commandId: command.commandId,
          }],
        },
      },
    };
  }
  if (result.intent === "revise") {
    if (document === null) throw new Error("Creative discussion revision is missing its stage document.");
    const revised = publishCreativeDraft(
      review,
      command.stage,
      `creative-discussion:${command.commandId}`,
      document,
      current.currentDraft!.stageInputDigest,
    );
    return {
      ...revised,
      stages: {
        ...revised.stages,
        [command.stage]: {
          ...revised.stages[command.stage],
          messages,
          effectiveUserInstructions: [
            ...current.effectiveUserInstructions,
            { commandId: command.commandId, message: command.message, active: true },
          ],
        },
      },
    };
  }
  if (document !== null) throw new Error("Creative discussion explanation cannot replace the current draft.");
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [command.stage]: { ...current, phase: "waiting_user", messages },
    },
  };
}

export function applyCreativeReviewDeterministicCommand(
  review: CreativeReviewState,
  command: CreativeReviewAdoptResume | CreativeReviewUndoResume,
): CreativeReviewState {
  const current = requireWaitingDraft(review, command);
  if (command.action === "adopt_proposal") {
    const proposal = current.proposals.find((candidate) => candidate.proposalId === command.proposalId);
    if (!proposal) throw new Error("Creative review proposal does not exist in the current stage.");
    if (proposal.baseDraftSha256 !== current.currentDraft!.sha256) {
      throw new Error("Creative review proposal is stale: its base draft changed.");
    }
    return {
      ...review,
      reviewRevision: review.reviewRevision + 1,
      stages: {
        ...review.stages,
        [command.stage]: {
          ...current,
          phase: "waiting_user",
          previousDraft: current.currentDraft,
          previousDocument: current.currentDocument,
          previousEffectiveUserInstructions: structuredClone(current.effectiveUserInstructions),
          currentDraft: {
            ...proposal.draft,
            revision: current.currentDraft!.revision + 1,
            versionId: creativeVersionId(proposal.draft.artifactId, current.currentDraft!.revision + 1),
          },
          versionHistory: [
            ...(current.versionHistory ?? []),
            { draft: {
              ...proposal.draft,
              revision: current.currentDraft!.revision + 1,
              versionId: creativeVersionId(proposal.draft.artifactId, current.currentDraft!.revision + 1),
            }, document: structuredClone(proposal.document) },
          ],
          currentDocument: structuredClone(proposal.document),
          confirmation: null,
          checkResult: null,
          effectiveUserInstructions: [
            ...current.effectiveUserInstructions,
            { commandId: command.commandId, message: `采用备选 ${proposal.proposalId}`, active: true },
          ],
        },
      },
    };
  }
  if (!current.previousDraft || current.previousDocument === null) {
    throw new Error("Creative review has no previous draft to restore.");
  }
  // 老记录未保存指令快照时不能猜测哪些要求属于上一稿。
  if (!current.previousEffectiveUserInstructions && current.effectiveUserInstructions.length > 0) {
    throw new Error("上一稿缺少对应的要求记录，无法安全撤销；请通过讨论说明要恢复的内容。当前稿件和讨论历史已保留。");
  }
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [command.stage]: {
        ...current,
        phase: "waiting_user",
        currentDraft: {
          ...current.previousDraft,
          revision: current.currentDraft!.revision + 1,
          versionId: creativeVersionId(current.previousDraft.artifactId, current.currentDraft!.revision + 1),
        },
        versionHistory: [
          ...(current.versionHistory ?? []),
          { draft: {
            ...current.previousDraft,
            revision: current.currentDraft!.revision + 1,
            versionId: creativeVersionId(current.previousDraft.artifactId, current.currentDraft!.revision + 1),
          }, document: structuredClone(current.previousDocument) },
        ],
        currentDocument: structuredClone(current.previousDocument),
        previousDraft: current.currentDraft,
        previousDocument: current.currentDocument,
        effectiveUserInstructions: structuredClone(current.previousEffectiveUserInstructions ?? []),
        previousEffectiveUserInstructions: structuredClone(current.effectiveUserInstructions),
        confirmation: null,
        checkResult: null,
      },
    },
  };
}

/**
 * 人工修订稿换入当前阶段。文档必须先由 gate 层按阶段合同校验（这里不做阶段 schema 校验，
 * 只做状态迁移）——校验与迁移分离，是因为阶段合同校验需要 brief/脚本上下文，那是组合根的职责。
 *
 * 与 AI 讨论改稿同一条制度：换稿即新一版草稿（revision+1、checkResult 清空），随后停点重现，
 * 确认不再补审（A06）：改稿形成未审新稿并停人；人可以主动审计，或看意见后显式承担，
 * 或未审采用。确认动作本身零模型调用。
 */
export function applyCreativeReviewEditDraft(
  review: CreativeReviewState,
  command: CreativeReviewEditDraftResume,
  validatedDocument: unknown,
): CreativeReviewState {
  const current = requireWaitingDraft(review, command);
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [command.stage]: {
        ...current,
        phase: "waiting_user",
        previousDraft: current.currentDraft,
        previousDocument: current.currentDocument,
        previousEffectiveUserInstructions: structuredClone(current.effectiveUserInstructions),
        // artifactId 与 stageInputDigest 保持不变：工件由调用方的 creativeDocumentArtifactUpdate
        // 原地换内容，阶段输入没变；变的是稿件内容本身，所以 sha256 按新文档重算、revision+1。
        currentDraft: {
          ...current.currentDraft!,
          sha256: contentSha256(validatedDocument),
          revision: current.currentDraft!.revision + 1,
          versionId: creativeVersionId(current.currentDraft!.artifactId, current.currentDraft!.revision + 1),
        },
        versionHistory: [
          ...(current.versionHistory ?? []),
          { draft: {
            ...current.currentDraft!,
            sha256: contentSha256(validatedDocument),
            revision: current.currentDraft!.revision + 1,
            versionId: creativeVersionId(current.currentDraft!.artifactId, current.currentDraft!.revision + 1),
          }, document: structuredClone(validatedDocument) },
        ],
        currentDocument: structuredClone(validatedDocument),
        confirmation: null,
        checkResult: null,
        effectiveUserInstructions: [
          ...current.effectiveUserInstructions,
          { commandId: command.commandId, message: "人工修订这一阶段的稿件", active: true },
        ],
      },
    },
  };
}

export function parseCreativeReviewResume(value: unknown): CreativeReviewResume {
  if (!isRecord(value)) throw new Error("Creative review resume must be an object.");
  if (value.action === "confirm") return parseCreativeReviewConfirmResume(value);
  if (value.action === "adopt_proposal") {
    const allowed = new Set([
      "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "proposalId",
    ]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
    return {
      action: "adopt_proposal",
      ...parseCreativeReviewCommandBase(value),
      proposalId: requiredText(value.proposalId, "proposalId"),
    };
  }
  if (value.action === "edit_draft") {
    const allowed = new Set([
      "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "document",
    ]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
    if (typeof value.document !== "object" || value.document === null || Array.isArray(value.document)) {
      throw new Error("Creative review edit requires a document object.");
    }
    return {
      action: "edit_draft",
      ...parseCreativeReviewCommandBase(value),
      document: value.document,
    };
  }
  if (value.action === "undo_draft") {
    const allowed = new Set(["action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision"]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
    return { action: "undo_draft", ...parseCreativeReviewCommandBase(value) };
  }
  if (value.action === "return_to_stage") {
    const allowed = new Set([
      "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "targetStage", "acknowledgeImpact",
    ]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
    const base = parseCreativeReviewCommandBase(value);
    if (value.targetStage !== "treatment" && value.targetStage !== "script" && value.targetStage !== "director") {
      throw new Error("Creative review return target stage is invalid.");
    }
    if (value.acknowledgeImpact !== true) throw new Error("Creative review return requires acknowledgeImpact=true.");
    return { action: "return_to_stage", ...base, targetStage: value.targetStage, acknowledgeImpact: true };
  }
  if (value.action === "audit_current") {
    const allowed = new Set(["action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision"]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
    return { action: "audit_current", ...parseCreativeReviewCommandBase(value) };
  }
  if (value.action !== "discuss" && value.action !== "revise") throw new Error("Creative review resume action is invalid.");
  const allowed = new Set([
    "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "message", "selection",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
  const base = parseCreativeReviewCommandBase(value);
  const message = requiredText(value.message, "message");
  const selection = value.selection === undefined ? undefined : parseDiscussionSelection(value.selection);
  return { action: value.action, ...base, message, ...(selection ? { selection } : {}) };
}

function discussionDocument(result: CreativeDiscussionResult): unknown | null {
  const documents = {
    treatment: result.treatment,
    script: result.script,
    director: result.director,
  };
  const populated = Object.entries(documents).filter(([, document]) => document !== null);
  if (result.intent === "propose" || result.intent === "revise") {
    if (populated.length !== 1 || populated[0]![0] !== result.stage) {
      throw new Error("Creative discussion must populate only the current stage document.");
    }
    return populated[0]![1];
  }
  if (populated.length > 0) throw new Error("Creative discussion must not return a document for this intent.");
  return null;
}

function draftRefForDocument(base: CreativeDraftRef, document: unknown): CreativeDraftRef {
  const revision = base.revision + 1;
  return {
    ...base,
    artifactId: `creative-proposal:${contentSha256(document)}`,
    sha256: contentSha256(document),
    revision,
    versionId: creativeVersionId(`creative-proposal:${contentSha256(document)}`, revision),
  };
}

export function parseCreativeReviewConfirmResume(value: unknown): CreativeReviewConfirmResume {
  if (!isRecord(value)) throw new Error("Creative review resume must be an object.");
  const allowed = new Set([
    "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "checkIdentity", "confirmedAt",
    "acknowledgeRepair", "acknowledgeIncomplete", "acceptQualityFallback", "acknowledgeUnaudited",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
  if (value.action !== "confirm") throw new Error("Creative review resume action must be 'confirm'.");
  if (value.acknowledgeRepair !== undefined && value.acknowledgeRepair !== true) {
    throw new Error("Creative review acknowledgeRepair must be true when present.");
  }
  if (value.acknowledgeIncomplete !== undefined && value.acknowledgeIncomplete !== true) {
    throw new Error("Creative review acknowledgeIncomplete must be true when present.");
  }
  const base = parseCreativeReviewCommandBase(value);
  if (value.acceptQualityFallback !== undefined
    && (value.acceptQualityFallback !== true || base.stage !== "director")) {
    throw new Error("Quality fallback acceptance requires an explicit director confirmation.");
  }
  if (value.acknowledgeUnaudited !== undefined && value.acknowledgeUnaudited !== true) {
    throw new Error("Creative review acknowledgeUnaudited must be true when present.");
  }
  if (value.acknowledgeUnaudited === true && (value.acknowledgeRepair === true || value.acknowledgeIncomplete === true)) {
    throw new Error("Creative review unaudited adoption cannot be combined with check acknowledgements.");
  }
  const confirmedAt = requiredText(value.confirmedAt, "confirmedAt");
  if (!Number.isFinite(Date.parse(confirmedAt))) throw new Error("Creative review confirmedAt must be an ISO timestamp.");
  return {
    action: "confirm",
    ...base,
    // 未审采用没有「用户看过的那条复核」；checkIdentity 只在存在审计时允许携带。
    ...(value.checkIdentity === undefined && value.acknowledgeUnaudited !== true
      ? (() => { throw new Error("Creative review confirmation requires checkIdentity or an explicit unaudited adoption."); })()
      : {}),
    ...(value.checkIdentity !== undefined ? { checkIdentity: sha256(value.checkIdentity, "checkIdentity") } : {}),
    confirmedAt,
    ...(value.acknowledgeRepair === true ? { acknowledgeRepair: true as const } : {}),
    ...(value.acknowledgeIncomplete === true ? { acknowledgeIncomplete: true as const } : {}),
    ...(value.acceptQualityFallback === true ? { acceptQualityFallback: true as const } : {}),
    ...(value.acknowledgeUnaudited === true ? { acknowledgeUnaudited: true as const } : {}),
  };
}

function parseCreativeReviewCommandBase(value: Record<string, unknown>): Omit<CreativeReviewDiscussResume, "action" | "message" | "selection"> {
  if (value.stage !== "treatment" && value.stage !== "script" && value.stage !== "director") {
    throw new Error("Creative review resume stage is invalid.");
  }
  if (!Number.isInteger(value.expectedReviewRevision) || Number(value.expectedReviewRevision) < 0) {
    throw new Error("Creative review expectedReviewRevision must be a non-negative integer.");
  }
  return {
    stage: value.stage,
    commandId: requiredText(value.commandId, "commandId"),
    actor: requiredText(value.actor, "actor"),
    baseDraftSha256: sha256(value.baseDraftSha256, "baseDraftSha256"),
    expectedReviewRevision: Number(value.expectedReviewRevision),
  };
}

function requireWaitingDraft(
  review: CreativeReviewState,
  command: Pick<CreativeReviewDiscussResume, "stage" | "expectedReviewRevision" | "baseDraftSha256">,
): CreativeStageReviewState {
  const current = review.stages[command.stage];
  if (review.activeStage !== command.stage || current.phase !== "waiting_user" || !current.currentDraft) {
    throw new Error(`Creative review stage '${command.stage}' is not awaiting a command.`);
  }
  if (command.expectedReviewRevision !== review.reviewRevision) {
    throw new Error("Creative review command is stale: review revision changed.");
  }
  if (command.baseDraftSha256 !== current.currentDraft.sha256) {
    throw new Error("Creative review command is stale: draft content changed.");
  }
  return current;
}

function parseDiscussionSelection(value: unknown): CreativeDiscussionSelection {
  if (!isRecord(value)) throw new Error("Creative review selection must be an object.");
  const allowed = new Set(["kind", "ids", "scenePositions"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Creative review selection field '${unknown}' is not allowed.`);
  if (value.kind !== "document" && value.kind !== "beat" && value.kind !== "scene") {
    throw new Error("Creative review selection kind is invalid.");
  }
  const ids = textArray(value.ids, "selection.ids", 24);
  if (!Array.isArray(value.scenePositions) || value.scenePositions.length > 24
    || value.scenePositions.some((position) => !Number.isInteger(position) || Number(position) < 1)) {
    throw new Error("Creative review selection.scenePositions must contain at most 24 positive integers.");
  }
  return { kind: value.kind, ids, scenePositions: value.scenePositions.map(Number) };
}

function textArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Creative review ${field} is invalid.`);
  return value.map((entry) => requiredText(entry, field));
}

function upstreamDigests(review: CreativeReviewState, stage: CreativeStage): Partial<Record<CreativeStage, string>> {
  const output: Partial<Record<CreativeStage, string>> = {};
  if (stage === "script" || stage === "director") {
    const treatment = review.stages.treatment.confirmation;
    if (!treatment) throw new Error("Creative review script/director draft requires a confirmed treatment.");
    output.treatment = treatment.draftSha256;
  }
  if (stage === "director") {
    const script = review.stages.script.confirmation;
    if (!script) throw new Error("Creative review director draft requires a confirmed script.");
    output.script = script.draftSha256;
  }
  return output;
}

function sha256(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`Creative review ${field} must be a SHA-256 digest.`);
  return text;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Creative review ${field} must be a non-empty string.`);
  if (value.length > 4_000) throw new Error(`Creative review ${field} exceeds 4000 characters.`);
  return value.trim();
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
