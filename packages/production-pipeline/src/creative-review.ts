import { createHash } from "node:crypto";

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
  action: "discuss";
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
  stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
}

export interface CreativeStageConfirmation {
  libraryEvidenceDigest?: string;
  draftSha256: string;
  stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
  checkIdentity: string;
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
}

export type CreativeReviewCheckResult = {
  draftSha256: string;
  checkIdentity: string;
  summary: string;
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
  checkIdentity: string;
  confirmedAt: string;
  // 独立复核是"提议"而非"否决"：裁决为 repair 时默认仍拦住流程，但人可以显式承担后继续。
  // 与 return_to_stage 的 acknowledgeImpact 同一模式，取舍被记录进 confirmation 而不是被静默跳过。
  acknowledgeRepair?: true;
  acknowledgeIncomplete?: true;
  acceptQualityFallback?: true;
}

export type CreativeReviewResume =
  | CreativeReviewConfirmResume
  | CreativeReviewDiscussResume
  | CreativeReviewAdoptResume
  | CreativeReviewEditDraftResume
  | CreativeReviewUndoResume
  | CreativeReviewReturnResume;

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

export function publishCreativeDraft(
  review: CreativeReviewState,
  stage: CreativeStage,
  artifactId: string,
  output: unknown,
  stageInputDigest: string,
): CreativeReviewState {
  const current = review.stages[stage];
  const sha256 = contentSha256(output);
  const sameDraft = current.currentDraft?.sha256 === sha256
    && current.currentDraft.stageInputDigest === stageInputDigest;
  const nextDraft: CreativeDraftRef = {
    artifactId,
    sha256,
    revision: sameDraft ? current.currentDraft!.revision : (current.currentDraft?.revision ?? 0) + 1,
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
  if (!current.checkResult
    || current.checkResult.draftSha256 !== draft.sha256
    || current.checkResult.checkIdentity !== command.checkIdentity) {
    throw new Error("Creative review confirmation requires an independent check for the current draft.");
  }
  const check = current.checkResult;
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
          draftSha256: draft.sha256,
          stageInputDigest: draft.stageInputDigest,
          upstreamConfirmedDigests: { ...draft.upstreamConfirmedDigests },
          checkIdentity: command.checkIdentity,
          actor: command.actor,
          confirmedAt: command.confirmedAt,
          commandId: command.commandId,
          ...(check.status === "incomplete" ? { acknowledgedIncomplete: true as const } : {}),
          ...(check.verdict === "repair"
            ? { acknowledgedRepair: { verdict: "repair" as const, score: check.score, issueCount: check.issues.length } }
            : {}),
        },
      },
    },
  };
}

export function recordCreativeReviewCheck(
  review: CreativeReviewState,
  stage: CreativeStage,
  result: CreativeReviewCheckResult,
): CreativeReviewState {
  const current = review.stages[stage];
  if (review.activeStage !== stage || current.phase !== "waiting_user" || !current.currentDraft) {
    throw new Error(`Creative review stage '${stage}' is not awaiting a check.`);
  }
  if (result.draftSha256 !== current.currentDraft.sha256) {
    throw new Error("Creative review check belongs to another draft.");
  }
  return {
    ...review,
    reviewRevision: review.reviewRevision + 1,
    stages: {
      ...review.stages,
      [stage]: {
        ...current,
        phase: "waiting_user",
        checkResult: structuredClone(result),
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
          currentDraft: { ...proposal.draft, revision: current.currentDraft!.revision + 1 },
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
        currentDraft: { ...current.previousDraft, revision: current.currentDraft!.revision + 1 },
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
 * 人点确认时对改后的稿自动跑一轮新的独立复核——通过直接放行，有问题把意见摆出来由人承担。
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
        },
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
  if (value.action !== "discuss") throw new Error("Creative review resume action is invalid.");
  const allowed = new Set([
    "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "message", "selection",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Creative review resume field '${unknown}' is not allowed.`);
  const base = parseCreativeReviewCommandBase(value);
  const message = requiredText(value.message, "message");
  const selection = value.selection === undefined ? undefined : parseDiscussionSelection(value.selection);
  return { action: "discuss", ...base, message, ...(selection ? { selection } : {}) };
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
  return {
    ...base,
    artifactId: `creative-proposal:${contentSha256(document)}`,
    sha256: contentSha256(document),
    revision: base.revision + 1,
  };
}

export function parseCreativeReviewConfirmResume(value: unknown): CreativeReviewConfirmResume {
  if (!isRecord(value)) throw new Error("Creative review resume must be an object.");
  const allowed = new Set([
    "action", "stage", "commandId", "actor", "baseDraftSha256", "expectedReviewRevision", "checkIdentity", "confirmedAt",
    "acknowledgeRepair", "acknowledgeIncomplete", "acceptQualityFallback",
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
  const confirmedAt = requiredText(value.confirmedAt, "confirmedAt");
  if (!Number.isFinite(Date.parse(confirmedAt))) throw new Error("Creative review confirmedAt must be an ISO timestamp.");
  return {
    action: "confirm",
    ...base,
    checkIdentity: sha256(value.checkIdentity, "checkIdentity"),
    confirmedAt,
    ...(value.acknowledgeRepair === true ? { acknowledgeRepair: true as const } : {}),
    ...(value.acknowledgeIncomplete === true ? { acknowledgeIncomplete: true as const } : {}),
    ...(value.acceptQualityFallback === true ? { acceptQualityFallback: true as const } : {}),
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
