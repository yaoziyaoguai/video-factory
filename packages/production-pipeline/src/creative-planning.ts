import { createHash } from "node:crypto";
import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { CreativeTreatment } from "./creative-treatment.js";
import type { ScriptDraft } from "./codex-screenwriter.js";
import type { ShotDecision, VisualDirectorPlan } from "./visual-director.js";
import { assetReuseSourceScenePosition } from "./generative-asset-worker.js";
import { validateAssetSemanticRanking, type AssetCandidateReport, type AssetSemanticRanking } from "./asset-semantic-ranker.js";
import { planningThreadId } from "./creative-planning-store.js";
import type { DurationRange } from "./executable-timeline.js";
import { RoleAgentLoopError, RoleAgentPlanningHaltError } from "./role-agent-loop.js";
import type { AgentLoopTrace, RoleAudit, RoleAuditPlanningDisposition } from "./codex-chat.js";
import {
  compileExecutableProductionPlan,
  parseExecutableProductionPlan,
  type CompileExecutableProductionPlanInput,
  type ExecutableProductionPlan,
} from "./executable-production-plan.js";
import {
  CREATIVE_REVIEW_FEATURE,
  applyCreativeReviewDeterministicCommand,
  confirmCreativeDraft,
  contentSha256,
  creativeReviewGate,
  initialCreativeReviewState,
  parseCreativeReviewResume,
  publishCreativeDraft,
  recordCreativeDiscussion,
  returnCreativeReviewToStage,
  recordCreativeReviewCheck,
  type CreativeDiscussionResult,
  type CreativeReviewResume,
  type CreativeReviewGate,
  type CreativeReviewState,
  type CreativeStage,
} from "./creative-review.js";

// B3 固定创作规划图：拓扑在构建期固定（模型不得生成任意节点/边），责任边界、有界回退与
// 输入身份由本文件确定性执行。图的公共依赖面只有创作角色 port，不包含付费授权、
// Provider registry 或媒体 create/download 能力。

export type PlanningStageId =
  | "treatment"
  | "script"
  | "director"
  | "candidates"
  | "rank"
  | "integrate"
  | "compile";

export interface PlanningIssue {
  id: string;
  target: "script" | "director" | "source" | "user";
  beatIds: string[];
  scenePositions: number[];
  reason: string;
  requiredChange: string;
  evidenceArtifactIds: string[];
  /** 默认图库可得性规则提供的结构化止损依据；模型或其它 reviewer 不得靠相似文案伪造。 */
  availabilityBlocker?: {
    reasonCode: "stock_candidate_below_automatic_use_threshold";
    narrativeTarget: {
      scenePurpose: string;
      narrativeRole: string;
      authenticityPolicy: string;
      subject: string;
      visibleAction: string;
      successCriteria: string[];
    };
    impactScope: { scenePositions: number[]; beatIds: string[] };
    evidence: {
      candidateCount: number;
      bestSemanticScore: number | null;
      lockedCandidateCount: number;
      automaticUseMinimum: number;
    };
  };
}

type AvailabilityBlocker = NonNullable<PlanningIssue["availabilityBlocker"]>;

interface AvailabilityBlockerObservation {
  identityDigest: string;
  evidence: AvailabilityBlocker["evidence"];
  reasonCode?: AvailabilityBlocker["reasonCode"];
  scenePositions?: number[];
  beatIds?: string[];
}

export interface CreativePlanningState {
  inputDigest: string;
  stage: PlanningStageId;
  artifactIds: Partial<Record<PlanningStageId, string[]>>;
  crossRoleRevisions: number;
  unresolvedIssueDigests: string[];
  issues: PlanningIssue[];
  creativeReview?: CreativeReviewState;
}

export type PlanningHaltReason =
  | "needs_user"
  | "needs_source"
  | "duplicate_issue"
  | "cross_role_revisions_exhausted";

export interface PlanningHalt {
  reason: PlanningHaltReason;
  issueIds: string[];
  detail: string;
}

// 跨角色回退（script/director 之间的重建）最多 2 次；角色内部打磨轮数由 role-agent-loop 的
// 既有约束（1-3 轮）承担，本图不重复实现。
export const MAX_CROSS_ROLE_REVISIONS = 2;

// 与 asset-semantic-ranker 审计 context 的 automaticUseMinimumSemanticScore 保持一致：
// 低于该语义分的候选不得自动采用，按导演责任上报换画面路线。
export const AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM = 40;

export interface PlanningArtifact<Output> {
  artifactId: string;
  output: Output;
  reviewCheck?: { audit: RoleAudit; checkIdentity: string };
  /**
   * 角色产出时带上来的建议：来源缺口这类"当前拿不到材料"的判定只能出建议，不能拦下制作。
   * 它进 state.issues → 下游角色当输入收到、创作者在确认关看到（见 production-pipeline 的
   * blockingIssues），但既不触发 halt 也不参与 duplicate_issue 判定。
   */
  advisories?: PlanningIssue[];
}

// 图的可持久化输入身份只包含 durable 领域字段。角色/模型输入与执行期 callback、deadline
// 属于注入 port 的宿主闭包：进入 checkpoint 后 SQLite 的 JSON round-trip 会静默丢掉函数，
// 让恢复依赖不可再现的运行时状态，因此这里不接受也不保存它们。
export interface CreativePlanningInput {
  runId: string;
  /** 宿主已接受的规划输入 digest：输入变化必须进入新 thread，不得命中旧图结果。 */
  inputDigest: string;
  durationRange: DurationRange;
  creativeReview?: typeof CREATIVE_REVIEW_FEATURE;
}

export interface CreativePlanningContext {
  runId: string;
  inputDigest: string;
  base: CreativePlanningInput;
  stage: PlanningStageId;
  /** 当前待处理的跨角色问题；责任路由保证只会走到被指 accountable 的角色。 */
  issues: PlanningIssue[];
  treatment: PlanningArtifact<CreativeTreatment> | null;
  script: PlanningArtifact<ScriptDraft> | null;
  directorPlan: PlanningArtifact<VisualDirectorPlan> | null;
  candidates: PlanningArtifact<AssetCandidateReport> | null;
  ranking: PlanningArtifact<AssetSemanticRanking> | null;
  integratedPlan: PlanningArtifact<VisualDirectorPlan> | null;
  availabilityHistory: AvailabilityBlockerObservation[];
  creativeReviewExecution?: { mode: "draft" } | { mode: "check"; stage: CreativeStage };
}

export type PlanningPort<Output> = (context: CreativePlanningContext) => Promise<PlanningArtifact<Output>>;

/** 候选搜索端口返回：公开报告产物 + worker 私有库存绑定（进入可恢复 checkpoint）。 */
export interface CandidateSearchPortResult extends PlanningArtifact<AssetCandidateReport> {
  /** worker 私有库存路径：与公开报告不同文件/内容；随候选进入 checkpoint。 */
  candidateInventoryPath?: string;
  /** 库存文件内容指纹（sha256）：恢复时校验文件未被替换。 */
  candidateInventorySha256?: string;
}

export interface CreativePlanningPorts {
  treatment: PlanningPort<CreativeTreatment>;
  screenwriter: PlanningPort<ScriptDraft>;
  /** 导演草案与按反馈重修共用同一 port；两者都是导演角色本体。 */
  director: PlanningPort<VisualDirectorPlan>;
  /** 整合排序候选产出最终导演方案；同属导演角色，与草案分开计数以供审计。图库路线必需。 */
  integrateDirector?: PlanningPort<VisualDirectorPlan>;
  /** 注入时启用图库路线；缺省为无图库固定路线（不搜索、不排序、不整合）。 */
  searchCandidates?: PlanningPort<AssetCandidateReport> | ((context: CreativePlanningContext) => Promise<CandidateSearchPortResult>);
  /** 图库路线必需：对候选产物做语义排序。无图库路线不要求（也不访问）该 port。 */
  rank?: PlanningPort<AssetSemanticRanking>;
  compile: PlanningPort<ExecutableProductionPlan>;
  discuss?: (input: {
    runId: string;
    stage: CreativeStage;
    commandId: string;
    currentDocument: CreativeTreatment | ScriptDraft | VisualDirectorPlan;
    message: string;
    selection?: { kind: "document" | "beat" | "scene"; ids: string[]; scenePositions: number[] };
    recentMessages: Array<{ role: "user" | "assistant"; text: string }>;
    effectiveUserInstructions: Array<{ commandId: string; message: string }>;
    upstreamDocuments: Partial<Record<"treatment" | "script", unknown>>;
  }) => Promise<CreativeDiscussionResult>;
}

export interface AvailabilityReviewInput {
  script: ScriptDraft;
  directorPlan: VisualDirectorPlan;
  ranking: PlanningArtifact<AssetSemanticRanking> | null;
}

export type AvailabilityReviewer = (input: AvailabilityReviewInput) => PlanningIssue[];

export interface CreateCreativePlanningGraphOptions {
  ports: CreativePlanningPorts;
  checkpointer?: BaseCheckpointSaver;
  availabilityReviewer?: AvailabilityReviewer;
}

export type CreativePlanningRunOutcome =
  | { status: "completed"; state: CreativePlanningState; executablePlan: PlanningArtifact<ExecutableProductionPlan> }
  | { status: "halted"; state: CreativePlanningState; halt: PlanningHalt }
  | { status: "waiting_user"; state: CreativePlanningState; gate: CreativeReviewGate };

const PlanningGraphAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  inputDigest: Annotation<string>(),
  base: Annotation<CreativePlanningInput>(),
  stage: Annotation<PlanningStageId>(),
  artifactIds: Annotation<Partial<Record<PlanningStageId, string[]>>>(),
  crossRoleRevisions: Annotation<number>(),
  unresolvedIssueDigests: Annotation<string[]>(),
  /** 已出现过的来源可得性阻断类别；不含镜头号、query 或本轮 artifact id，用于识别换措辞式假进展。 */
  availabilityBlockerDigests: Annotation<string[]>(),
  /** 同一叙事目标的最佳候选证据；用于区分真实改善与只换措辞、query 或 artifact。 */
  availabilityBlockerObservations: Annotation<AvailabilityBlockerObservation[]>(),
  issues: Annotation<PlanningIssue[]>(),
  // 产物字段用 null 而不是 undefined 初始：checkpoint 以 JSON 序列化，undefined 会丢字段。
  treatmentArtifact: Annotation<PlanningArtifact<CreativeTreatment> | null>(),
  scriptArtifact: Annotation<PlanningArtifact<ScriptDraft> | null>(),
  directorPlan: Annotation<PlanningArtifact<VisualDirectorPlan> | null>(),
  candidatesArtifact: Annotation<PlanningArtifact<AssetCandidateReport> | null>(),
  ranking: Annotation<PlanningArtifact<AssetSemanticRanking> | null>(),
  integratedPlan: Annotation<PlanningArtifact<VisualDirectorPlan> | null>(),
  executablePlan: Annotation<PlanningArtifact<ExecutableProductionPlan> | null>(),
  /** 上次搜索候选时导演方案的 stock 查询身份；重修后据此决定重搜还是直接复检。 */
  candidateSearchFingerprint: Annotation<string | null>(),
  /** 上次排序时的实际输入身份（稿件+导演方案+候选报告内容 digest）；与候选获取身份分离。 */
  rankingInputFingerprint: Annotation<string | null>(),
  /** worker 私有库存路径：与候选证据同一 checkpoint 持久化，seed/崩溃恢复不丢。 */
  candidateInventoryBinding: Annotation<string | null>(),
  /** 绑定指向的私有库存文件内容指纹：恢复时校验文件未被替换。 */
  candidateInventorySha256: Annotation<string | null>(),
  /** 跨 thread 播种时与产物同一 checkpoint 落盘的实际模型来源。 */
  carriedModelTraces: Annotation<Partial<Record<PlanningStageId, string>>>(),
  /** 播种产物的实际执行 provider 来源：与模型来源分开保存，正式 provenance 不混写命名空间。 */
  carriedProviderTraces: Annotation<Partial<Record<PlanningStageId, string>>>(),
  /** 播种产物所依据的阶段兼容身份；恢复不能依赖另一个非原子 sidecar。 */
  carriedStageInputIdentities: Annotation<Partial<Record<PlanningStageId, string>>>(),
  halt: Annotation<PlanningHalt | null>(),
  /** 自动图库调整达到止损边界后，转入现有导演讨论，而不是结束整条制作。 */
  manualDirectorReview: Annotation<boolean>(),
  creativeReview: Annotation<CreativeReviewState>(),
});

export type PlanningGraphState = typeof PlanningGraphAnnotation.State;

export function initialPlanningGraphState(input: CreativePlanningInput): PlanningGraphState {
  const base = durablePlanningInput(input);
  return {
    runId: base.runId,
    inputDigest: base.inputDigest,
    base,
    stage: "treatment",
    artifactIds: {},
    crossRoleRevisions: 0,
    unresolvedIssueDigests: [],
    availabilityBlockerDigests: [],
    availabilityBlockerObservations: [],
    issues: [],
    treatmentArtifact: null,
    scriptArtifact: null,
    directorPlan: null,
    candidatesArtifact: null,
    ranking: null,
    integratedPlan: null,
    executablePlan: null,
    candidateSearchFingerprint: null,
    rankingInputFingerprint: null,
    candidateInventoryBinding: null,
    candidateInventorySha256: null,
    carriedModelTraces: {},
    carriedProviderTraces: {},
    carriedStageInputIdentities: {},
    halt: null,
    manualDirectorReview: false,
    creativeReview: initialCreativeReviewState(),
  };
}

// 初始 state 投影为只含允许字段的新对象：调用方的额外属性（运行时 callback、deadline 等）
// 不进入 checkpoint。runId/inputDigest 非空与 durationRange 基本合法在此校验，先于任何节点执行。
function durablePlanningInput(input: CreativePlanningInput): CreativePlanningInput {
  const runId = requiredPlanningText(input.runId, "CreativePlanningInput.runId");
  const inputDigest = requiredPlanningText(input.inputDigest, "CreativePlanningInput.inputDigest");
  const raw = input.durationRange;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CreativePlanningInput.durationRange must be an object.");
  }
  const { minSeconds, maxSeconds } = raw;
  if (!Number.isInteger(minSeconds) || !Number.isInteger(maxSeconds)
    || minSeconds < 1 || maxSeconds < minSeconds) {
    throw new Error("CreativePlanningInput.durationRange is invalid: minSeconds/maxSeconds must be integers with 1 <= minSeconds <= maxSeconds.");
  }
  if (input.creativeReview !== undefined && input.creativeReview !== CREATIVE_REVIEW_FEATURE) {
    throw new Error(`CreativePlanningInput.creativeReview must be '${CREATIVE_REVIEW_FEATURE}'.`);
  }
  return {
    runId,
    inputDigest,
    durationRange: { minSeconds, maxSeconds },
    ...(input.creativeReview ? { creativeReview: input.creativeReview } : {}),
  };
}

function requiredPlanningText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

export function projectCreativePlanningState(state: PlanningGraphState): CreativePlanningState {
  return {
    inputDigest: state.inputDigest,
    stage: state.stage,
    artifactIds: Object.fromEntries(
      Object.entries(state.artifactIds).map(([stage, ids]) => [stage, [...(ids ?? [])]]),
    ) as Partial<Record<PlanningStageId, string[]>>,
    crossRoleRevisions: state.crossRoleRevisions,
    unresolvedIssueDigests: [...state.unresolvedIssueDigests],
    issues: state.issues.map((issue) => ({
      ...issue,
      beatIds: [...issue.beatIds],
      scenePositions: [...issue.scenePositions],
      evidenceArtifactIds: [...issue.evidenceArtifactIds],
    })),
    ...(state.base.creativeReview === CREATIVE_REVIEW_FEATURE
      ? { creativeReview: structuredClone(state.creativeReview) }
      : {}),
  };
}

// issue digest 只由结构化责任字段决定：id 与 requiredChange 不参与——改写修复建议或换一个
// issue id 不能绕过“同一结构问题第二次原样出现即停止”。
export function planningIssueDigest(issue: PlanningIssue): string {
  const canonical = {
    target: issue.target,
    reason: issue.reason.trim(),
    beatIds: distinctSorted(issue.beatIds),
    scenePositions: [...new Set(issue.scenePositions)].sort((left, right) => left - right),
    evidenceArtifactIds: distinctSorted(issue.evidenceArtifactIds),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// stock 镜头的完整检索身份：镜头位置、交付类型、trim 后检索词、Provider 路由（首选 + 排序
// 去重后的备选）与解析后的复用根。候选获取身份以它为原子单位。
interface StockQueryIdentity {
  scenePosition: number;
  deliveryType: string;
  query: string;
  preferredProviderId: string;
  alternativeProviderIds: string[];
  /** 解析后的复用根：复用镜头不搜索（生产 Python 行为），复用关系变化即候选获取身份变化。 */
  reuseFromScenePosition: number | null;
}

// 镜头的有效复用根：reuseFromScenePosition 字段优先，query 中的 REUSE_ONLY 编码兜底——与
// 生产搜索（stock_assets.py search_routed_scene_asset_candidates）对复用镜头的判定一致。
function shotReuseSource(shot: ShotDecision): number | undefined {
  return assetReuseSourceScenePosition({
    ...(shot.reuseFromScenePosition !== undefined ? { reuseFromScenePosition: shot.reuseFromScenePosition } : {}),
    query: shot.query,
  });
}

function stockQueryIdentities(plan: VisualDirectorPlan): StockQueryIdentity[] {
  return plan.shots
    .filter((shot) => shot.deliveryType === "stock_video" || shot.deliveryType === "stock_image")
    .map((shot) => ({
      scenePosition: shot.scenePosition,
      deliveryType: shot.deliveryType,
      query: shot.query.trim(),
      preferredProviderId: shot.preferredProviderId,
      alternativeProviderIds: [...new Set(shot.alternativeProviderIds)].sort(),
      reuseFromScenePosition: shotReuseSource(shot) ?? null,
    }))
    .sort((left, right) => left.scenePosition - right.scenePosition);
}

// 候选搜索指纹只覆盖仍依赖图库的镜头（stock 交付）的完整检索身份：镜头位置、交付类型、
// trim 后检索词、Provider 路由（首选 + 排序去重后的备选）与解析后的复用根。Provider 路由与
// 复用关系都属于候选条件——换 Provider、复用根变化（含独立 stock 改为复用）必须重搜重排；
// narrativeRole 等与检索无关的字段不参与。重修后指纹未变说明候选条件未变，不得重搜重排；
// 改用生成路线或改写检索词都必须重新搜索。
export function candidateSearchFingerprint(plan: VisualDirectorPlan): string {
  return createHash("sha256").update(JSON.stringify(stockQueryIdentities(plan))).digest("hex");
}

// 每镜排序证据身份：除 rationale（纯采用说明）外的全部画面要求字段。候选/排序适配判断依据
// 的字段——交付类型、检索词、Provider 路由、主体/环境/动作、真实性政策、景别/机位/灯光、
// 负面约束、参考要求、成功标准、节拍、连续性、narrativeRole 与 generationPrompt（均进入
// 生产 candidate intent）、参考关系——任一变化都意味着旧证据不再覆盖当前画面要求。复用根
// 以解析后的值为准：reuseFromScenePosition 字段与 query 的 REUSE_ONLY 编码解析结果相同视为
// 同一依赖身份。
function shotEvidenceIdentity(shot: ShotDecision): unknown {
  const identity: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shot)) {
    if (key === "rationale") continue;
    identity[key] = value;
  }
  identity.reuseFromScenePosition = shotReuseSource(shot) ?? null;
  return identity;
}

// 方案级创作合同身份：visualBible 与档案选择属于排序/画面语义输入，整合不得改写。
function planCreativeContractIdentity(plan: VisualDirectorPlan): unknown {
  return {
    version: plan.version,
    requestedProfileId: plan.requestedProfileId,
    resolvedProfileId: plan.resolvedProfileId,
    profileRationale: plan.profileRationale,
    visualBible: plan.visualBible,
  };
}

// 排序语义意图的权威投影：与图内证据覆盖检查使用同一份逐镜画面要求身份（除 rationale 外的
// 全部字段 + 复用根）与方案级创作合同。排序角色据此看到当前主体/动作/真实性要求，而不是只有
// 内容摘要式 artifact id；语义变化必然改变该投影与 checkpoint 身份，候选获取身份不变时不重搜。
export function rankingSemanticIntent(plan: VisualDirectorPlan): unknown {
  return {
    planContract: planCreativeContractIdentity(plan),
    shots: plan.shots.map((shot) => shotEvidenceIdentity(shot)),
  };
}

// 稳定 JSON：对象键排序、数组保序、过滤 undefined，保证 digest 只随内容语义变化。
function stablePlanningJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stablePlanningJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stablePlanningJson(record[key])}`).join(",")}}`;
}

function planningContentDigest(value: unknown): string {
  return createHash("sha256").update(stablePlanningJson(value)).digest("hex");
}

// 排序实际输入身份 = 参与排序语义判断的全部当前产物内容（稿件、导演方案、候选报告）。它与
// 候选获取身份（candidateSearchFingerprint）分离：检索条件未变但稿件/方案语义变化时，候选
// 可以复用（不重搜），旧排序却不能继续充当当前证据（必须重排）。
function currentRankingInputFingerprint(state: PlanningGraphState): string {
  return planningContentDigest({
    script: state.scriptArtifact?.output ?? null,
    directorPlan: state.directorPlan?.output ?? null,
    candidates: state.candidatesArtifact?.output ?? null,
  });
}

function withoutArtifactStages(
  artifactIds: Partial<Record<PlanningStageId, string[]>>,
  ...stages: PlanningStageId[]
): Partial<Record<PlanningStageId, string[]>> {
  const removed = new Set<PlanningStageId>(stages);
  return Object.fromEntries(
    Object.entries(artifactIds).filter(([stage]) => !removed.has(stage as PlanningStageId)),
  ) as Partial<Record<PlanningStageId, string[]>>;
}

// 排序证据失效时其下游有效产物一并失效：旧排序、整合方案与可执行方案都不得在变化后的
// checkpoint 中冒充当前结果。候选报告本身保留——候选获取身份未变时它可以继续复用。
function invalidateRankingEvidence(artifactIds: Partial<Record<PlanningStageId, string[]>>) {
  return {
    ranking: null,
    rankingInputFingerprint: null,
    integratedPlan: null,
    executablePlan: null,
    artifactIds: withoutArtifactStages(artifactIds, "rank", "integrate", "compile"),
  };
}

// 默认可得性审查是确定性规则，不调模型：排序证据里没有可自动采用的候选、且当前导演方案仍
// 要求该镜头走图库时，按导演责任上报换画面路线。改走生成路线的镜头不再依赖候选，不报。
// 合法复用镜头的可得性由其母片根承担：生产搜索对复用镜头跳过搜索、只保留空候选报告行，
// 不要求复用镜头自身有高分候选；根的缺失/向后/环在 evaluate 的确定性校验中 fail closed，
// 根是 stock 时根镜头自身的候选可用性就是这条复用链的证据（根不可用由根镜头的问题承担，
// 不为复用镜头重复造一条）。
export function defaultAvailabilityReviewer(input: AvailabilityReviewInput): PlanningIssue[] {
  if (!input.ranking) return [];
  const stockShots = input.directorPlan.shots
    .filter((shot) => shot.deliveryType === "stock_video" || shot.deliveryType === "stock_image");
  const stockScenes = new Set(stockShots.map((shot) => shot.scenePosition));
  if (stockScenes.size === 0) return [];
  const reuseShots = new Set(
    stockShots.filter((shot) => shotReuseSource(shot) !== undefined).map((shot) => shot.scenePosition),
  );
  const issues: PlanningIssue[] = [];
  for (const scene of input.ranking.output.scenes) {
    if (!stockScenes.has(scene.scenePosition)) continue;
    if (reuseShots.has(scene.scenePosition)) continue;
    const usable = scene.candidates.some(
      (candidate) => candidate.locked || candidate.semanticScore >= AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM,
    );
    if (usable) continue;
    const shot = stockShots.find((candidate) => candidate.scenePosition === scene.scenePosition)!;
    const scriptScene = input.script.scenes.find((candidate) => candidate.position === scene.scenePosition);
    const semanticScores = scene.candidates.map((candidate) => candidate.semanticScore);
    issues.push({
      id: `asset-availability-scene-${scene.scenePosition}`,
      target: "director",
      beatIds: [],
      scenePositions: [scene.scenePosition],
      reason: "图库候选不足：该镜头没有达到自动采用语义阈值的候选",
      requiredChange: "调整该镜头画面路线（检索词、生成或复用）；素材确实不可得时按 source/user 上报",
      evidenceArtifactIds: [input.ranking.artifactId],
      availabilityBlocker: {
        reasonCode: "stock_candidate_below_automatic_use_threshold",
        narrativeTarget: {
          scenePurpose: scriptScene?.purpose?.trim() ?? "",
          narrativeRole: shot.narrativeRole.trim(),
          authenticityPolicy: shot.authenticityPolicy,
          subject: shot.subject?.trim() ?? "",
          visibleAction: shot.visibleAction?.trim() ?? "",
          successCriteria: distinctSorted(shot.successCriteria ?? []),
        },
        impactScope: { scenePositions: [scene.scenePosition], beatIds: [] },
        evidence: {
          candidateCount: scene.candidates.length,
          bestSemanticScore: semanticScores.length > 0 ? Math.max(...semanticScores) : null,
          lockedCandidateCount: scene.candidates.filter((candidate) => candidate.locked).length,
          automaticUseMinimum: AUTOMATIC_CANDIDATE_SEMANTIC_MINIMUM,
        },
      },
    });
  }
  return issues;
}

const STOCK_CANDIDATE_AVAILABILITY_REASON = "图库候选不足：该镜头没有达到自动采用语义阈值的候选";
const FACTUAL_STOCK_CANDIDATE_REQUIRED_CHANGE =
  "上传或实拍可追溯的真实素材；若不再主张实证，可改为非实证概念表达；也可以停止本次制作。AI 生成画面不能冒充真实实验证据。";
const ILLUSTRATIVE_STOCK_CANDIDATE_REQUIRED_CHANGE =
  "调整检索词，改用已启用的生成或复用路线，或人工补充合适素材；也可以停止本次制作。";

function stockCandidateRequiredChange(issue: PlanningIssue): string {
  return issue.availabilityBlocker?.narrativeTarget.authenticityPolicy === "evidence"
    ? FACTUAL_STOCK_CANDIDATE_REQUIRED_CHANGE
    : ILLUSTRATIVE_STOCK_CANDIDATE_REQUIRED_CHANGE;
}

// 同一来源边界不能靠改 query、换镜头号或生成新的 ranking artifact 伪装成进展。这里仅对
// 默认确定性可得性规则生成的问题归类；一般导演质量问题仍按精确结构 digest 使用既有回退上限。
function availabilityBlockerDigest(issue: PlanningIssue): string | undefined {
  const blocker = issue.availabilityBlocker;
  if (issue.target !== "director"
    || blocker?.reasonCode !== "stock_candidate_below_automatic_use_threshold") return undefined;
  return planningContentDigest({
    reasonCode: blocker.reasonCode,
    narrativeTarget: blocker.narrativeTarget,
    impactScope: {
      scenePositions: [...new Set(blocker.impactScope.scenePositions)].sort((left, right) => left - right),
      beatIds: distinctSorted(blocker.impactScope.beatIds),
    },
    evidence: blocker.evidence,
  });
}

function availabilityBlockerObservation(
  issue: PlanningIssue,
  state: PlanningGraphState,
): AvailabilityBlockerObservation | undefined {
  const blocker = issue.availabilityBlocker;
  if (issue.target !== "director"
    || blocker?.reasonCode !== "stock_candidate_below_automatic_use_threshold") return undefined;
  const acceptedSceneGoals = blocker.impactScope.scenePositions.map((scenePosition) => {
    const scene = state.scriptArtifact?.output.scenes.find((candidate) => candidate.position === scenePosition);
    if (!scene) return null;
    // position、duration 和 search_terms 会随排版/检索策略变化，不是新的叙事目标；真正的
    // 目标变化必须来自已接受稿件中的画面/动作/成功条件，而不是导演本轮同义改写。
    return {
      purpose: scene.purpose ?? "",
      narration: scene.narration,
      visualStrategy: scene.visual_strategy,
      visualPrompt: scene.visual_prompt,
      visibleAction: scene.visible_action ?? "",
      successCriteria: scene.success_criteria ?? [],
      failureConditions: scene.failure_conditions ?? [],
    };
  });
  return {
    identityDigest: planningContentDigest({
      reasonCode: blocker.reasonCode,
      acceptedSceneGoals,
      automaticUseMinimum: blocker.evidence.automaticUseMinimum,
    }),
    evidence: { ...blocker.evidence },
    reasonCode: blocker.reasonCode,
    scenePositions: [...new Set(blocker.impactScope.scenePositions)].sort((left, right) => left - right),
    beatIds: distinctSorted(blocker.impactScope.beatIds),
  };
}

function availabilityEvidenceImproved(
  current: AvailabilityBlockerObservation["evidence"],
  previous: AvailabilityBlockerObservation["evidence"],
): boolean {
  if (current.lockedCandidateCount !== previous.lockedCandidateCount) {
    return current.lockedCandidateCount > previous.lockedCandidateCount;
  }
  const currentScore = current.bestSemanticScore ?? -1;
  const previousScore = previous.bestSemanticScore ?? -1;
  if (currentScore !== previousScore) return currentScore > previousScore;
  return current.candidateCount > previous.candidateCount;
}

function mergeAvailabilityBlockerObservations(
  previous: AvailabilityBlockerObservation[],
  current: AvailabilityBlockerObservation[],
): AvailabilityBlockerObservation[] {
  const merged = previous.map((observation) => structuredClone(observation));
  for (const observation of current) {
    const index = merged.findIndex((candidate) => candidate.identityDigest === observation.identityDigest);
    if (index === -1) {
      merged.push(structuredClone(observation));
    } else if (availabilityEvidenceImproved(observation.evidence, merged[index]!.evidence)) {
      merged[index] = structuredClone(observation);
    }
  }
  return merged;
}

export function compileInputFromContext(context: CreativePlanningContext): CompileExecutableProductionPlanInput {
  const script = context.script;
  const finalPlan = context.integratedPlan ?? context.directorPlan;
  if (!script || !finalPlan) {
    throw new Error("Creative planning compile requires accepted script and director plan artifacts.");
  }
  return {
    ...(context.treatment ? { treatmentArtifactId: context.treatment.artifactId } : {}),
    scriptArtifactId: script.artifactId,
    directorArtifactId: finalPlan.artifactId,
    ...(context.candidates && context.ranking
      ? { candidateArtifactIds: [context.candidates.artifactId, context.ranking.artifactId] }
      : {}),
    durationRange: context.base.durationRange,
    scenes: script.output.scenes.map((scene) => ({ position: scene.position, duration: scene.duration })),
    shots: finalPlan.output.shots.map((shot) => {
      // 复用根按有效值投影：显式 reuseFromScenePosition 与 query 的 REUSE_ONLY 编码（数字/
      // 英文词形）解析为同一根，整合删除冗余显式字段后仍由 query 承载——正式 executable plan
      // 对所有等价表达产生相同母片绑定（assetKey/sourceInFrame）。
      const reuseFrom = shotReuseSource(shot);
      return {
        scenePosition: shot.scenePosition,
        ...(reuseFrom !== undefined ? { reuseFromScenePosition: reuseFrom } : {}),
        ...(shot.sourceInSeconds !== undefined ? { sourceInSeconds: shot.sourceInSeconds } : {}),
        temporalBeats: shot.temporalBeats ?? [],
      };
    }),
  };
}

// compile 的默认注入适配器：确定性使用 A 阶段正式编译器与 parse 合同（round-trip 验证），
// 不调用模型。非法时间轴/引用输入在此 fail closed。
export const executablePlanCompilePort: PlanningPort<ExecutableProductionPlan> = async (context) => {
  const compiled = compileExecutableProductionPlan(compileInputFromContext(context));
  const verified = parseExecutableProductionPlan(JSON.parse(JSON.stringify(compiled)) as unknown);
  const artifactId = `executable-plan:${createHash("sha256").update(JSON.stringify(verified)).digest("hex")}`;
  return { artifactId, output: verified };
};

export function createCreativePlanningGraph(options: CreateCreativePlanningGraphOptions) {
  const { ports } = options;
  const availabilityReviewer = options.availabilityReviewer ?? defaultAvailabilityReviewer;
  const searchCandidates = ports.searchCandidates;
  if (searchCandidates && (!ports.rank || !ports.integrateDirector)) {
    // 图库路线的固定拓扑包含 rank 与 integrate 节点：缺 port 在构建期明确失败，而不是运行到
    // 一半才发现。无图库路线不要求（也不访问）这两个 port。
    throw new Error("Creative planning with the searchCandidates port requires both the rank and integrateDirector ports.");
  }
  const actions = planningNodeActions(ports, availabilityReviewer, searchCandidates, ports.rank, ports.integrateDirector);
  const compileOptions = options.checkpointer ? { checkpointer: options.checkpointer } : undefined;

  if (!searchCandidates) {
    // 无图库固定路线：构思→稿件→导演→编译。不存在搜索/排序/复检/整合节点，也不得以
    // “整合”名义对合格导演草案再调一次导演。
    return new StateGraph(PlanningGraphAnnotation)
      .addNode("treatment", actions.treatment)
      .addNode("treatment_review", actions.treatmentReview)
      .addNode("script", actions.script)
      .addNode("script_review", actions.scriptReview)
      .addNode("director", actions.director)
      .addNode("director_review", actions.directorReview)
      .addNode("compile", actions.compile)
      .addEdge(START, "treatment")
      .addConditionalEdges("treatment", routeAfterTreatment, { halt: END, review: "treatment_review", next: "script" })
      .addConditionalEdges("treatment_review", routeAfterReview("treatment"), { wait: "treatment_review", next: "script" })
      .addConditionalEdges("script", routeAfterScript, { halt: END, review: "script_review", next: "director" })
      .addConditionalEdges("script_review", routeAfterReview("script"), { wait: "script_review", treatment: "treatment_review", next: "director" })
      .addConditionalEdges("director", routeAfterFinalDirector, { halt: END, review: "director_review", next: "compile" })
      .addConditionalEdges("director_review", routeAfterReview("director"), { wait: "director_review", treatment: "treatment_review", script: "script_review", next: "compile" })
      .addEdge("compile", END)
      .compile(compileOptions);
  }

  // 有图库固定路线：构思→稿件→导演→候选→排序→复检→（整合→复检→编译 | 回退 | 停止）。
  return new StateGraph(PlanningGraphAnnotation)
    .addNode("treatment", actions.treatment)
    .addNode("treatment_review", actions.treatmentReview)
    .addNode("script", actions.script)
    .addNode("script_review", actions.scriptReview)
    .addNode("director", actions.director)
    .addNode("candidates", actions.candidates)
    .addNode("rank", actions.rank)
    .addNode("evaluate", actions.evaluate)
    .addNode("integrate", actions.integrate)
    .addNode("director_review", actions.directorReview)
    .addNode("compile", actions.compile)
    .addEdge(START, "treatment")
    .addConditionalEdges("treatment", routeAfterTreatment, { halt: END, review: "treatment_review", next: "script" })
    .addConditionalEdges("treatment_review", routeAfterReview("treatment"), { wait: "treatment_review", next: "script" })
    .addConditionalEdges("script", routeAfterScript, { halt: END, review: "script_review", next: "director" })
    .addConditionalEdges("script_review", routeAfterReview("script"), { wait: "script_review", treatment: "treatment_review", next: "director" })
    // 首轮导演草案之后先搜候选；重修/重建后只在候选获取身份变化时重搜，排序实际输入变化时
    // 只重排，两者都未变才直接复检。
    .addConditionalEdges(
      "director",
      routeAfterDirector,
      { halt: END, candidates: "candidates", rank: "rank", evaluate: "evaluate" },
    )
    .addEdge("candidates", "rank")
    .addEdge("rank", "evaluate")
    // 责任路由：需要用户/素材、重复问题或回退耗尽时停止；script 问题回到编剧（随后必然重建
    // 导演）；只有导演问题时修导演。路由优先级 script > director：上游内容变更会级联下游。
    .addConditionalEdges(
      "evaluate",
      routeFromEvaluate,
      { halt: END, compile: "compile", review: "director_review", integrate: "integrate", script: "script", director: "director" },
    )
    // 整合方案回到同一 evaluate 复检（含确定性覆盖检查），复检通过才编译——integrate 不直连
    // compile，最终整合方案不能绕过可得性检查。
    .addEdge("integrate", "evaluate")
    .addConditionalEdges(
      "director_review",
      routeAfterLibraryDirectorReview,
      {
        halt: END,
        wait: "director_review",
        treatment: "treatment_review",
        script: "script_review",
        recheck: "candidates",
        candidates: "candidates",
        rank: "rank",
        evaluate: "evaluate",
        next: "compile",
      },
    )
    .addEdge("compile", END)
    .compile(compileOptions);
}

export type CreativePlanningGraph = ReturnType<typeof createCreativePlanningGraph>;

function planningNodeActions(
  ports: CreativePlanningPorts,
  availabilityReviewer: AvailabilityReviewer,
  searchCandidates: PlanningPort<AssetCandidateReport> | undefined,
  rank: PlanningPort<AssetSemanticRanking> | undefined,
  integrateDirector: PlanningPort<VisualDirectorPlan> | undefined,
) {
  return {
    treatment: async (state: PlanningGraphState) => {
      try {
        // 返回产物同样深拷贝后校验/入 state：port 不保留可继续修改图状态的别名。
        const artifact = isolatedPlanningValue(await ports.treatment(contextFor(state)));
        requireArtifact(artifact, "treatment");
        return {
          stage: "treatment" as const,
          treatmentArtifact: artifact,
          ...sourceAdvisoryUpdate(artifact),
          artifactIds: withArtifactId(state, "treatment", artifact.artifactId),
          ...(state.base.creativeReview === CREATIVE_REVIEW_FEATURE
            ? { creativeReview: publishCreativeDraft(state.creativeReview, "treatment", artifact.artifactId, artifact.output, treatmentReviewInputDigest(state)) }
            : {}),
        };
      } catch (error) {
        return planningRoleHaltUpdate(error, "treatment");
      }
    },
    script: async (state: PlanningGraphState) => {
      try {
        const artifact = isolatedPlanningValue(await ports.screenwriter(contextFor(state)));
        requireArtifact(artifact, "script");
        const artifactIds = withArtifactId(state, "script", artifact.artifactId);
        // 稿件画面/语义内容实际变化时，依赖稿件语义的排序证据与下游整合/编译产物全部失效；
        // 内容未变（重跑得到同一输出）不失效——不通过一律重排掩盖问题，也不无故丢弃有效证据。
        const changed = state.scriptArtifact !== null
          && planningContentDigest(state.scriptArtifact.output) !== planningContentDigest(artifact.output);
        return {
          stage: "script" as const,
          scriptArtifact: artifact,
          ...sourceAdvisoryUpdate(artifact),
          ...(changed ? invalidateRankingEvidence(artifactIds) : { artifactIds }),
          ...(state.base.creativeReview === CREATIVE_REVIEW_FEATURE
            ? { creativeReview: publishCreativeDraft(state.creativeReview, "script", artifact.artifactId, artifact.output, scriptReviewInputDigest(state)) }
            : {}),
        };
      } catch (error) {
        return planningRoleHaltUpdate(error, "script");
      }
    },
    director: async (state: PlanningGraphState) => {
      try {
        const artifact = isolatedPlanningValue(await ports.director(contextFor(state)));
        requireArtifact(artifact, "director");
        const artifactIds = withArtifactId(state, "director", artifact.artifactId);
        // 导演方案内容实际变化时同样失效排序及下游产物（是否重搜由候选获取身份另行判断）。
        const changed = state.directorPlan !== null
          && planningContentDigest(state.directorPlan.output) !== planningContentDigest(artifact.output);
        return {
          stage: "director" as const,
          directorPlan: artifact,
          ...sourceAdvisoryUpdate(artifact),
          ...(changed ? invalidateRankingEvidence(artifactIds) : { artifactIds }),
          ...(state.base.creativeReview === CREATIVE_REVIEW_FEATURE && !searchCandidates
            ? { creativeReview: publishCreativeDraft(state.creativeReview, "director", artifact.artifactId, artifact.output, directorReviewInputDigest(state)) }
            : {}),
        };
      } catch (error) {
        return planningRoleHaltUpdate(error, "director");
      }
    },
    candidates: async (state: PlanningGraphState) => {
      if (!searchCandidates) {
        throw new Error("Creative planning candidates node requires the searchCandidates port.");
      }
      if (!state.directorPlan) {
        throw new Error("Creative planning candidates search requires a director plan artifact.");
      }
      const artifact = isolatedPlanningValue(await searchCandidates(contextFor(state))) as CandidateSearchPortResult;
      requireArtifact(artifact, "candidates");
      return {
        stage: "candidates" as const,
        candidatesArtifact: artifact,
        candidateSearchFingerprint: candidateSearchFingerprint(state.directorPlan.output),
        // 私有库存绑定（路径+内容指纹）与候选证据同一 checkpoint 原子持久化：崩溃/播种恢复不丢、不可被替换。
        ...(artifact.candidateInventoryPath ? { candidateInventoryBinding: artifact.candidateInventoryPath } : {}),
        ...(artifact.candidateInventorySha256 ? { candidateInventorySha256: artifact.candidateInventorySha256 } : {}),
        // 新一轮搜索产生新的候选集合：旧排序及其下游产物不能再描述当前证据，必须重排。
        ...invalidateRankingEvidence(withArtifactId(state, "candidates", artifact.artifactId)),
      };
    },
    rank: async (state: PlanningGraphState) => {
      if (!rank) {
        throw new Error("Creative planning rank node requires the rank port.");
      }
      if (!state.candidatesArtifact) {
        throw new Error("Creative planning rank requires the candidates artifact.");
      }
      const artifact = isolatedPlanningValue(await rank(contextFor(state)));
      requireArtifact(artifact, "rank");
      // 排序产物在进入 availability reviewer 前用现有合同校验：缺 scene、未知/重复候选、
      // 重复 rank、模型凭空锁定都直接 fail closed——不走模型 fallback，也不给导演伪造
      // “换画面”反馈。lock 的现有 override（allowLocks）保留给宿主对已持久化人工锁定的
      // re-read 边界；本图的 rank 产物是排序角色输出，处于宿主人工锁定之前，不授予 lock。
      validateAssetSemanticRanking(artifact.output, state.candidatesArtifact.output);
      return {
        stage: "rank" as const,
        ranking: artifact,
        rankingInputFingerprint: currentRankingInputFingerprint(state),
        artifactIds: withArtifactId(state, "rank", artifact.artifactId),
      };
    },
    evaluate: evaluateNode(availabilityReviewer),
    integrate: async (state: PlanningGraphState) => {
      if (!integrateDirector) {
        throw new Error("Creative planning integrate node requires the integrateDirector port.");
      }
      const draft = state.directorPlan;
      if (!draft || !state.candidatesArtifact || !state.ranking) {
        throw new Error("Creative planning integrate requires director plan, candidates, and ranking artifacts.");
      }
      // baseline（state.directorPlan）在 port 之前就不可被改写：port 收到的是深拷贝 context，
      // 返回产物再深拷贝一次入 state——原地改写传入草案并原样返回的对象会在下方身份比较中被
      // 拒绝，而不是同时污染 baseline 与 output 后自我通过。
      const artifact = isolatedPlanningValue(await integrateDirector(contextFor(state)));
      requireArtifact(artifact, "integrate");
      // 整合出口检查：整合只能在旧候选/排序证据仍覆盖完整当前画面要求时继续。除 rationale
      // （纯采用说明）外，草案与整合方案的逐镜画面要求字段（交付类型、检索词、Provider 路由、
      // 主体/环境/动作、真实性政策、景别/机位/灯光、约束与成功标准、节拍、连续性、
      // narrativeRole 与 generationPrompt 等排序意图字段）与复用/参考关系必须一致；方案级创作
      // 合同（visualBible/档案）同样不得改写。把 stock 改成生成/说明卡/另一 stock 类型、改主体
      // 动作或复用根，都意味着旧证据不再覆盖当前画面要求——compile 永远不会收到绕过可得性
      // 证据的方案。这是确定性身份比较，不调用模型。
      if (candidateSearchFingerprint(draft.output) !== state.candidateSearchFingerprint) {
        throw new Error("Creative planning integrate: candidate evidence no longer matches the current director plan; re-run candidate search first.");
      }
      if (artifact.output.shots.length !== draft.output.shots.length) {
        throw new Error(
          `Creative planning integrate: integrated plan must keep every draft shot `
          + `(received ${artifact.output.shots.length} shots for ${draft.output.shots.length} draft shots); `
          + "candidate and ranking evidence covers the draft shot set.",
        );
      }
      const draftShotIdentities = new Map(
        draft.output.shots.map((shot) => [shot.scenePosition, planningContentDigest(shotEvidenceIdentity(shot))]),
      );
      for (const shot of artifact.output.shots) {
        const draftIdentity = draftShotIdentities.get(shot.scenePosition);
        if (draftIdentity === undefined) {
          throw new Error(
            `Creative planning integrate: integrated plan contains scene ${shot.scenePosition}, which the draft evidence does not cover.`,
          );
        }
        if (draftIdentity !== planningContentDigest(shotEvidenceIdentity(shot))) {
          throw new Error(
            `Creative planning integrate: integrated plan changes the candidate/ranking evidence identity for scene ${shot.scenePosition} `
            + `('${shot.query}'); the evidence does not cover the current picture requirements.`,
          );
        }
      }
      if (planningContentDigest(planCreativeContractIdentity(draft.output))
        !== planningContentDigest(planCreativeContractIdentity(artifact.output))) {
        throw new Error(
          "Creative planning integrate: integrated plan changes plan-level creative contract fields (visual bible/profile); "
          + "the ranking evidence does not cover them.",
        );
      }
      return {
        stage: "integrate" as const,
        integratedPlan: artifact,
        artifactIds: withArtifactId(state, "integrate", artifact.artifactId),
        ...(state.base.creativeReview === CREATIVE_REVIEW_FEATURE
          ? { creativeReview: publishCreativeDraft(state.creativeReview, "director", artifact.artifactId, artifact.output, directorReviewInputDigest(state)) }
          : {}),
      };
    },
    compile: async (state: PlanningGraphState) => {
      const artifact = isolatedPlanningValue(await ports.compile(contextFor(state)));
      requireArtifact(artifact, "compile");
      return {
        stage: "compile" as const,
        executablePlan: artifact,
        artifactIds: withArtifactId(state, "compile", artifact.artifactId),
      };
    },
    treatmentReview: reviewGateNode("treatment", ports.discuss, ports.treatment),
    scriptReview: reviewGateNode("script", ports.discuss, ports.screenwriter),
    directorReview: reviewGateNode("director", ports.discuss, ports.director),
  };
}

function routeAfterRole(state: PlanningGraphState): "halt" | "next" {
  return state.halt ? "halt" : "next";
}

function routeAfterTreatment(state: PlanningGraphState): "halt" | "review" | "next" {
  if (state.halt) return "halt";
  return state.base.creativeReview === CREATIVE_REVIEW_FEATURE ? "review" : "next";
}

function routeAfterScript(state: PlanningGraphState): "halt" | "review" | "next" {
  if (state.halt) return "halt";
  return state.base.creativeReview === CREATIVE_REVIEW_FEATURE ? "review" : "next";
}

function routeAfterFinalDirector(state: PlanningGraphState): "halt" | "review" | "next" {
  if (state.halt) return "halt";
  return state.base.creativeReview === CREATIVE_REVIEW_FEATURE ? "review" : "next";
}

function routeAfterDirector(state: PlanningGraphState): "halt" | "candidates" | "rank" | "evaluate" {
  if (state.halt) return "halt";
  if (state.candidatesArtifact === null) return "candidates";
  const current = candidateSearchFingerprint(state.directorPlan?.output ?? rejectMissingDirectorPlan());
  if (current !== state.candidateSearchFingerprint) return "candidates";
  // 候选获取身份未变：候选报告可复用（不重搜）。排序是否有效看排序实际输入身份——稿件或
  // 方案内容变化会使记录的指纹失配，必须重排；两者都一致才直接复检。
  if (state.ranking === null || state.rankingInputFingerprint !== currentRankingInputFingerprint(state)) {
    return "rank";
  }
  return "evaluate";
}

/**
 * 角色产出携带的来源建议转入图状态。它只进 state.issues（下游角色当输入收到、创作者在确认关
 * 看到），不进 unresolvedIssueDigests：来源缺口不是"同一问题回退后原样出现"，把它记成未解问题
 * 会让 duplicate_issue 把一条本来可以继续做的方案判停。
 */
function sourceAdvisoryUpdate<Output>(
  artifact: PlanningArtifact<Output>,
): { issues: PlanningIssue[] } | Record<string, never> {
  const advisories = artifact.advisories;
  if (!advisories?.length) return {};
  return { issues: advisories.map((issue) => parsePlanningIssue(issue)) };
}

// 审计路由出去的阻塞问题转成图的 PlanningIssue：id 由 stage + 路由动作 + 判据内容决定，
// 改写修复建议或换措辞不会伪装成另一条问题。
function auditDispositionIssues(
  audit: RoleAudit,
  disposition: RoleAuditPlanningDisposition,
  stage: "treatment" | "script" | "director",
): PlanningIssue[] {
  const target = disposition.action === "needs_source" ? "source" as const : "user" as const;
  return disposition.issueIndexes.map((issueIndex) => {
    const issue = audit.issues[issueIndex];
    if (!issue || issue.severity !== "blocking") {
      throw new Error("Planning role halt references an invalid non-blocking audit issue.");
    }
    const id = `role-audit:${createHash("sha256").update(JSON.stringify({
      stage,
      action: disposition.action,
      criterion: issue.criterion,
      evidence: issue.evidence,
      repairInstruction: issue.repairInstruction,
    })).digest("hex")}`;
    return {
      id,
      target,
      beatIds: [],
      scenePositions: [],
      reason: `${issue.criterion}：${issue.evidence}`,
      requiredChange: issue.repairInstruction,
      evidenceArtifactIds: [],
    };
  });
}

/**
 * 角色产出携带的来源建议：宿主就绪检查判定的 needs_source（已由审计认领为误判的不算）与独立
 * 审计路由出去的 needs_source 合并成建议列表。宿主与审计是同一件事的两条来源——"当前流水线
 * 拿不到这份材料"——所以共用同一份转换，不各自造一套 id 约定。
 */
export function planningSourceAdvisories(
  execution: { agentLoop?: AgentLoopTrace },
  stage: "treatment" | "script" | "director",
): PlanningIssue[] {
  const last = execution.agentLoop?.iterations.at(-1);
  if (!last) return [];
  const corrected = new Set(last.audit.hostReadinessReview?.misclassifiedIssueIds ?? []);
  const hostIssues: PlanningIssue[] = last.hostReadiness?.status === "needs_source"
    ? last.hostReadiness.issues
      .filter((issue) => (issue.target === "source" || issue.target === "user") && !corrected.has(issue.id))
      .map((issue) => ({
        id: issue.id,
        target: issue.target === "user" ? "user" as const : "source" as const,
        beatIds: [...issue.beatIds],
        scenePositions: [...issue.scenePositions],
        reason: issue.reason,
        requiredChange: issue.requiredChange,
        evidenceArtifactIds: [...issue.evidenceArtifactIds],
      }))
    : [];
  const disposition = last.audit.planningDisposition;
  const auditIssues = disposition?.action === "needs_source"
    ? auditDispositionIssues(last.audit, disposition, stage)
    : [];
  return [...hostIssues, ...auditIssues];
}

// needs_user 仍然停摆：它把决定交还给决策者本人，不是对作品下判。needs_source 已经不再是停摆
// （见 role-agent-loop 的轮内注释），走的是 sourceAdvisoryUpdate 那条建议通道。
function planningRoleHaltUpdate(error: unknown, stage: "treatment" | "script" | "director") {
  if (!(error instanceof RoleAgentPlanningHaltError)) throw error;
  const disposition = error.disposition;
  if (!disposition || disposition.action !== "needs_user") {
    throw new Error("Planning role halt must carry a needs_user audit disposition.");
  }
  const issues = auditDispositionIssues(error.audit, disposition, stage);
  return {
    stage,
    issues,
    unresolvedIssueDigests: issues.map(planningIssueDigest),
    halt: {
      reason: "needs_user" as const,
      issueIds: issues.map((issue) => issue.id),
      detail: `独立审计确认继续需要用户决定是否改变既定承诺或路线：${error.audit.summary}`,
    },
  };
}

function routeFromEvaluate(state: PlanningGraphState): "halt" | "compile" | "review" | "integrate" | "script" | "director" {
  if (state.halt) return "halt";
  if (state.manualDirectorReview) return "review";
  // 草案复检通过 → 整合；整合方案复检通过 → 编译。整合输出必须经过同一责任边界，不允许
  // integrate 直连 compile 绕过可得性检查。
  if (state.issues.length === 0) {
    if (!state.integratedPlan) return "integrate";
    return state.base.creativeReview === CREATIVE_REVIEW_FEATURE ? "review" : "compile";
  }
  return state.issues.some((issue) => issue.target === "script") ? "script" : "director";
}

export async function runCreativePlanning(
  graph: CreativePlanningGraph,
  options: { input: CreativePlanningInput; threadId: string; resume?: CreativeReviewResume },
): Promise<CreativePlanningRunOutcome> {
  // 入口先校验输入身份（runId/inputDigest 非空、durationRange 基本合法），再要求传入 threadId
  // 精确等于 planningThreadId(runId, inputDigest)：错配在任何节点执行前 fail closed，不依赖
  // 调用方自己算对 thread key。
  const canonicalInput = durablePlanningInput(options.input);
  const expectedThreadId = planningThreadId(canonicalInput.runId, canonicalInput.inputDigest);
  if (options.threadId !== expectedThreadId) {
    throw new Error(
      `Creative planning thread id '${options.threadId}' must equal planningThreadId(runId, inputDigest) '${expectedThreadId}'; open a new thread for a different input identity.`,
    );
  }
  const config = { configurable: { thread_id: options.threadId } };
  const snapshot = await graph.getState(config);
  const existing = (snapshot?.values ?? {}) as Partial<PlanningGraphState>;
  let finalState: PlanningGraphState;
  if (existing.inputDigest !== undefined && existing.inputDigest !== null) {
    // 已存在 checkpoint 必须同时核对 runId 与 inputDigest：线程身份是 (runId, digest) 的联合，
    // 任一错配都不得把旧图结果交给当前输入（纵深防御，防御 checkpoint 被手工放置到错误 thread）。
    if (existing.runId !== canonicalInput.runId) {
      throw new Error(
        `Creative planning thread '${options.threadId}' holds run '${String(existing.runId)}' and cannot serve run '${canonicalInput.runId}'.`,
      );
    }
    if (existing.inputDigest !== canonicalInput.inputDigest) {
      throw new Error(
        `Creative planning thread '${options.threadId}' already holds input digest '${String(existing.inputDigest)}' and cannot accept '${canonicalInput.inputDigest}'; open a new thread for changed input.`,
      );
    }
    // 旧版本曾允许导演讨论改变素材路线后绕过候选/排序/整合，留下“已有可执行方案，但图库
    // 证据链不完整”的不可能完成态。恢复时从导演出口重新按当前证据身份路由；不重跑构思、
    // 脚本或导演初稿，也不直接沿用这个被污染的完成态。
    if (incompleteLibraryCompletion(existing)) {
      await graph.updateState(config, {
        ...invalidateRankingEvidence(existing.artifactIds ?? {}),
        ...(existing.candidatesArtifact === null
          ? {
              candidateSearchFingerprint: null,
              candidateInventoryBinding: null,
              candidateInventorySha256: null,
              artifactIds: withoutArtifactStages(existing.artifactIds ?? {}, "candidates", "rank", "integrate", "compile"),
            }
          : {}),
      }, "director");
    }
    // 恢复：invoke(null) 从 checkpoint 继续，不重跑已完成节点，也不重置跨角色计数。
    finalState = await graph.invoke(
      options.resume ? new Command({ resume: options.resume }) : null,
      config,
    ) as PlanningGraphState;
  } else {
    // 首次运行只消费入口已校验的 canonical 快照：options.input 是调用方可变对象，在上方
    // 首个 await 之后被原地改写或整体替换时，不得把变化后的值写进按入口身份计算的 thread。
    finalState = await graph.invoke(initialPlanningGraphState(canonicalInput), config) as PlanningGraphState;
  }
  return planningOutcome(finalState);
}

function incompleteLibraryCompletion(state: Partial<PlanningGraphState>): boolean {
  const hasLibraryEvidence = state.candidatesArtifact !== null && state.candidatesArtifact !== undefined
    || state.candidateSearchFingerprint !== null && state.candidateSearchFingerprint !== undefined;
  return state.executablePlan !== null
    && state.executablePlan !== undefined
    && hasLibraryEvidence
    && (state.candidatesArtifact == null || state.ranking == null || state.integratedPlan == null);
}

function evaluateNode(availabilityReviewer: AvailabilityReviewer) {
  return async (state: PlanningGraphState) => {
    if (!state.scriptArtifact || !state.directorPlan) {
      throw new Error("Creative planning evaluate requires accepted script and director plan artifacts.");
    }
    // 复检对象是当前最终候选方案：整合方案存在时审整合方案（integrate 后回到这里），否则审
    // 导演草案。两者共用同一确定性覆盖检查、复用完整性检查与责任路由。
    const reviewedPlan = state.integratedPlan ?? state.directorPlan;
    assertStockCoverage(reviewedPlan.output, state);
    assertReuseIntegrity(reviewedPlan.output);
    // 可注入 reviewer 与角色 port 同一边界纪律：只看 JSON 深拷贝的隔离快照。reviewer 原地改写
    // 传入的 script/directorPlan/ranking 不影响图拥有的证据与后续 checkpoint——否则两轮复检
    // 放行后 integrate/compile 会携旧 ranking 消费被改写的画面语义。返回 issues 仍过
    // parsePlanningIssue 形状校验，不解析自然语言。
    const pending = availabilityReviewer(
      isolatedPlanningValue<AvailabilityReviewInput>({
        script: state.scriptArtifact.output,
        directorPlan: reviewedPlan.output,
        ranking: state.ranking,
      }),
    ).map((issue) => parsePlanningIssue(issue));
    const digests = pending.map((issue) => planningIssueDigest(issue));
    // 已见问题的 digest 合并保留（不替换）：跨阶段仍待验证的问题清单只增不减，直到整合方案
    // 复检确认无问题为止。
    const carriedUnresolved = mergedIssueDigests(state.unresolvedIssueDigests, digests);
    const priorAvailabilityBlockers = state.availabilityBlockerDigests ?? [];
    const currentAvailabilityBlockers = pending.flatMap((issue) => {
      const digest = availabilityBlockerDigest(issue);
      return digest ? [digest] : [];
    });
    const carriedAvailabilityBlockers = mergedIssueDigests(
      priorAvailabilityBlockers,
      currentAvailabilityBlockers,
    );
    const priorAvailabilityObservations = state.availabilityBlockerObservations ?? [];
    const currentAvailabilityObservations = pending.flatMap((issue) => {
      const observation = availabilityBlockerObservation(issue, state);
      return observation ? [observation] : [];
    });
    const carriedAvailabilityObservations = mergeAvailabilityBlockerObservations(
      priorAvailabilityObservations,
      currentAvailabilityObservations,
    );

    // 只有用户能解决的问题（口径、取舍、授权范围）与素材确实不可得：停止自动重试。
    const userIssues = pending.filter((issue) => issue.target === "user");
    if (userIssues.length > 0) {
      return {
        issues: pending,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: {
          reason: "needs_user" as const,
          issueIds: userIssues.map((issue) => issue.id),
          detail: "存在只有用户能解决的问题，停止自动重试，等待用户决定。",
        },
      };
    }
    const sourceIssues = pending.filter((issue) => issue.target === "source");
    if (sourceIssues.length > 0) {
      return {
        issues: pending,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: {
          reason: "needs_source" as const,
          issueIds: sourceIssues.map((issue) => issue.id),
          detail: "素材来源确实不可得，停止自动重试，需要补充素材或更换输入。",
        },
      };
    }
    const confirmedDirector = state.creativeReview.stages.director.confirmation;
    const confirmedDirectorDraft = state.creativeReview.stages.director.currentDraft;
    const confirmedAvailabilityIssues = pending.filter((issue) => availabilityBlockerDigest(issue) !== undefined);
    const currentDirectorPlanWasConfirmed = state.base.creativeReview === CREATIVE_REVIEW_FEATURE
      && confirmedDirector !== null
      && confirmedDirectorDraft?.sha256 === confirmedDirector.draftSha256
      && contentSha256(state.directorPlan.output) === confirmedDirector.draftSha256;
    if (currentDirectorPlanWasConfirmed && confirmedAvailabilityIssues.length > 0) {
      const confirmedIds = new Set(confirmedAvailabilityIssues.map((issue) => issue.id));
      const escalatedIssues = pending.map((issue) => confirmedIds.has(issue.id)
        ? { ...issue, target: "source" as const, requiredChange: stockCandidateRequiredChange(issue) }
        : issue);
      return {
        issues: escalatedIssues,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: null,
        manualDirectorReview: true,
        creativeReview: publishCreativeDraft(
          state.creativeReview,
          "director",
          reviewedPlan.artifactId,
          reviewedPlan.output,
          directorReviewInputDigest(state),
        ),
      };
    }
    const stalledAvailabilityIssues = pending.filter((issue) => {
      const digest = availabilityBlockerDigest(issue);
      if (digest !== undefined && priorAvailabilityBlockers.includes(digest)) return true;
      const current = availabilityBlockerObservation(issue, state);
      if (!current) return false;
      const previous = priorAvailabilityObservations.find(
        (observation) => observation.identityDigest === current.identityDigest,
      );
      return previous !== undefined && !availabilityEvidenceImproved(current.evidence, previous.evidence);
    });
    if (stalledAvailabilityIssues.length > 0) {
      const stalledIds = new Set(stalledAvailabilityIssues.map((issue) => issue.id));
      const escalatedIssues = pending.map((issue) => stalledIds.has(issue.id)
        ? { ...issue, target: "source" as const, requiredChange: stockCandidateRequiredChange(issue) }
        : issue);
      const requiredChanges = [...new Set(stalledAvailabilityIssues.map(stockCandidateRequiredChange))];
      if (state.base.creativeReview === CREATIVE_REVIEW_FEATURE && reviewedPlan) {
        return {
          issues: escalatedIssues,
          unresolvedIssueDigests: carriedUnresolved,
          availabilityBlockerDigests: carriedAvailabilityBlockers,
          availabilityBlockerObservations: carriedAvailabilityObservations,
          halt: null,
          manualDirectorReview: true,
          creativeReview: publishCreativeDraft(
            state.creativeReview,
            "director",
            reviewedPlan.artifactId,
            reviewedPlan.output,
            directorReviewInputDigest(state),
          ),
        };
      }
      return {
        issues: escalatedIssues,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: {
          reason: "needs_source" as const,
          issueIds: stalledAvailabilityIssues.map((issue) => issue.id),
          detail: `连续两轮仍缺少可自动采用的真实图库素材，自动规划已停止。${requiredChanges.join(" ")}`,
        },
      };
    }
    if (pending.length === 0) {
      // 草案复检通过只是中间结论：此前已见问题（含整合问题）的 digest 仍未被整合方案复检
      // 确认，不得在这里清空——否则同一整合问题第二次出现会被当成新回退而不是 duplicate_issue。
      // 只有整合方案复检确认无问题、即将编译时才消解。
      return state.integratedPlan !== null
        ? { issues: [], unresolvedIssueDigests: [], halt: null, manualDirectorReview: false }
        : { issues: [], halt: null, manualDirectorReview: false };
    }
    const duplicated = pending.filter((issue, index) => state.unresolvedIssueDigests.includes(digests[index]!));
    if (duplicated.length > 0) {
      return {
        issues: pending,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: {
          reason: "duplicate_issue" as const,
          issueIds: duplicated.map((issue) => issue.id),
          detail: "同一结构问题在回退后原样出现：修复没有生效，停止循环。",
        },
      };
    }
    if (state.crossRoleRevisions >= MAX_CROSS_ROLE_REVISIONS) {
      return {
        issues: pending,
        unresolvedIssueDigests: carriedUnresolved,
        availabilityBlockerDigests: carriedAvailabilityBlockers,
        availabilityBlockerObservations: carriedAvailabilityObservations,
        halt: {
          reason: "cross_role_revisions_exhausted" as const,
          issueIds: pending.map((issue) => issue.id),
          detail: `跨角色回退已达上限 ${MAX_CROSS_ROLE_REVISIONS} 次，停止自动重试。`,
        },
      };
    }
    return {
      issues: pending,
      unresolvedIssueDigests: carriedUnresolved,
      availabilityBlockerDigests: carriedAvailabilityBlockers,
      availabilityBlockerObservations: carriedAvailabilityObservations,
      crossRoleRevisions: state.crossRoleRevisions + 1,
      halt: null,
      // 走回退即表示整合/编译产物不再代表当前方案：连同其 artifact 引用一并失效。排序证据
      // 是否保留由 script/director 节点按内容变化另行决定（候选获取身份未变时不重搜）。
      integratedPlan: null,
      executablePlan: null,
      artifactIds: withoutArtifactStages(state.artifactIds, "integrate", "compile"),
    };
  };
}

// 覆盖关联合同检查：当前被复检方案要求的每个图库镜头，必须在候选报告与排序证据中都有明确
// 覆盖，且报告检索词与当前方案一致。report 与 ranking 一致地漏掉同一镜头属于合同错误，fail
// closed——不得静默放行，也不得转写成导演“换画面”反馈；镜头已覆盖但候选为空或分数不足才
// 走 availability 责任路由。这是确定性检查，不依赖 reviewer 是否遍历到该镜头。
function assertStockCoverage(plan: VisualDirectorPlan, state: PlanningGraphState): void {
  const stockShots = plan.shots
    .filter((shot) => shot.deliveryType === "stock_video" || shot.deliveryType === "stock_image");
  if (stockShots.length === 0) return;
  const candidatesArtifact = state.candidatesArtifact;
  const rankingArtifact = state.ranking;
  if (!candidatesArtifact || !rankingArtifact) {
    throw new Error("Creative planning evaluate requires candidate and ranking artifacts for a plan with stock shots.");
  }
  for (const shot of stockShots) {
    const reportScene = candidatesArtifact.output.scenes.find((scene) => scene.scenePosition === shot.scenePosition);
    if (!reportScene) {
      throw new Error(
        `Creative planning evaluate: required stock scene ${shot.scenePosition} is missing from the candidate report `
        + `'${candidatesArtifact.artifactId}'; the current plan must be covered by candidate and ranking evidence.`,
      );
    }
    if (reportScene.query.trim() !== shot.query.trim()) {
      throw new Error(
        `Creative planning evaluate: candidate report scene ${shot.scenePosition} query '${reportScene.query.trim()}' `
        + `does not match the current plan query '${shot.query.trim()}'.`,
      );
    }
    const rankingScene = rankingArtifact.output.scenes.find((scene) => scene.scenePosition === shot.scenePosition);
    if (!rankingScene) {
      throw new Error(
        `Creative planning evaluate: required stock scene ${shot.scenePosition} is missing from the ranking evidence `
        + `'${rankingArtifact.artifactId}'.`,
      );
    }
  }
}

// 合并保留已见问题 digest：跨阶段仍待验证的问题清单只增不减（保序去重），不被新一轮问题
// 替换——否则早前问题会被“忘记”，第二次原样出现时不再触发 duplicate_issue。
function mergedIssueDigests(existing: readonly string[], digests: readonly string[]): string[] {
  const merged = [...existing];
  for (const digest of digests) {
    if (!merged.includes(digest)) merged.push(digest);
  }
  return merged;
}

// 复用完整性关联合同检查：每个带复用关系的镜头，其复用链上的每个源镜头必须存在、是更早镜头
// 且无环。缺失/向后/自环属于方案合同违约（validateVisualDirectorPlan 会在上游拒绝同类形态），
// 在图内确定性 fail closed——不得伪装成导演质量问题，也不得静默放行。draft 与整合方案复检时
// 都经过本检查。
function assertReuseIntegrity(plan: VisualDirectorPlan): void {
  const shotsByPosition = new Map(plan.shots.map((shot) => [shot.scenePosition, shot]));
  for (const shot of plan.shots) {
    if (shotReuseSource(shot) === undefined) continue;
    const visited = new Set<number>([shot.scenePosition]);
    let current = shot;
    while (true) {
      const reuseFrom = shotReuseSource(current);
      if (reuseFrom === undefined) break;
      if (visited.has(reuseFrom)) {
        throw new Error(`Creative planning evaluate: plan contains a reuse cycle involving scene ${reuseFrom}.`);
      }
      const source = shotsByPosition.get(reuseFrom);
      if (!source) {
        throw new Error(
          `Creative planning evaluate: scene ${current.scenePosition} reuses scene ${reuseFrom}, which is missing from the plan.`,
        );
      }
      if (source.scenePosition >= current.scenePosition) {
        throw new Error(
          `Creative planning evaluate: scene ${current.scenePosition} must reuse an earlier scene, received ${source.scenePosition}.`,
        );
      }
      visited.add(reuseFrom);
      current = source;
    }
  }
}

function planningOutcome(state: PlanningGraphState): CreativePlanningRunOutcome {
  if (state.halt) {
    return { status: "halted", halt: state.halt, state: projectCreativePlanningState(state) };
  }
  if (state.executablePlan) {
    return { status: "completed", executablePlan: state.executablePlan, state: projectCreativePlanningState(state) };
  }
  if (state.base.creativeReview === CREATIVE_REVIEW_FEATURE) {
    return {
      status: "waiting_user",
      gate: creativeReviewGate(state.creativeReview, state.creativeReview.activeStage),
      state: projectCreativePlanningState(state),
    };
  }
  throw new Error("Creative planning ended without an executable plan or a halt; the graph topology is invalid.");
}

function reviewGateNode(
  stage: CreativeStage,
  discuss: CreativePlanningPorts["discuss"],
  rolePort: PlanningPort<CreativeTreatment | ScriptDraft | VisualDirectorPlan>,
) {
  return async (state: PlanningGraphState) => {
    if (state.base.creativeReview !== CREATIVE_REVIEW_FEATURE) return {};
    const gate = creativeReviewGate(state.creativeReview, stage);
    const resume = parseCreativeReviewResume(interrupt(gate));
    if (resume.action === "confirm") {
      let checked: PlanningArtifact<CreativeTreatment | ScriptDraft | VisualDirectorPlan>;
      try {
        checked = await rolePort(contextFor(state, { mode: "check", stage }));
      } catch (error) {
        if (!(error instanceof RoleAgentLoopError)) throw error;
        const audit = error.agentLoop.iterations.at(-1)?.audit;
        if (!audit) throw error;
        const checkIdentity = contentSha256({
          stage,
          draftSha256: gate.draft.sha256,
          stageInputDigest: gate.draft.stageInputDigest,
          audit,
        });
        return {
          creativeReview: recordCreativeReviewCheck(state.creativeReview, stage, {
            draftSha256: gate.draft.sha256,
            checkIdentity,
            verdict: "repair",
            score: audit.score,
            summary: audit.summary,
            issues: structuredClone(audit.issues),
          }),
        };
      }
      const audit = checked.reviewCheck?.audit;
      if (!audit || audit.verdict !== "pass" || !checked.reviewCheck?.checkIdentity) {
        throw new Error(`Creative review '${stage}' confirmation did not produce a passing independent check.`);
      }
      const reviewed = recordCreativeReviewCheck(state.creativeReview, stage, {
        draftSha256: gate.draft.sha256,
        checkIdentity: checked.reviewCheck.checkIdentity,
        verdict: "pass",
        score: audit.score,
        summary: audit.summary,
        issues: structuredClone(audit.issues),
      });
      return {
        creativeReview: confirmCreativeDraft(reviewed, {
          ...resume,
          expectedReviewRevision: reviewed.reviewRevision,
          checkIdentity: checked.reviewCheck.checkIdentity,
          confirmedAt: new Date().toISOString(),
        }),
      };
    }
    if (resume.action === "adopt_proposal" || resume.action === "undo_draft") {
      const creativeReview = applyCreativeReviewDeterministicCommand(state.creativeReview, resume);
      return {
        creativeReview,
        ...creativeDocumentArtifactUpdate(state, stage, creativeReview),
      };
    }
    if (resume.action === "return_to_stage") {
      const creativeReview = returnCreativeReviewToStage(state.creativeReview, resume);
      return {
        creativeReview,
        stage: resume.targetStage,
        issues: [],
        halt: null,
        ...invalidateAfterCreativeReturn(state, resume.targetStage),
      };
    }
    if (!discuss) throw new Error("Creative planning discussion requires a configured discussion port.");
    const result = await discuss({
      runId: state.runId,
      stage,
      commandId: resume.commandId,
      currentDocument: currentCreativeDocument(state, stage),
      message: resume.message,
      ...(resume.selection ? { selection: resume.selection } : {}),
      recentMessages: state.creativeReview.stages[stage].messages.slice(-20).map(({ role, text }) => ({ role, text })),
      effectiveUserInstructions: state.creativeReview.stages[stage].effectiveUserInstructions
        .filter((instruction) => instruction.active)
        .map(({ commandId, message }) => ({ commandId, message })),
      upstreamDocuments: {
        ...(stage !== "treatment" && state.treatmentArtifact ? { treatment: structuredClone(state.treatmentArtifact.output) } : {}),
        ...(stage === "director" && state.scriptArtifact ? { script: structuredClone(state.scriptArtifact.output) } : {}),
      },
    });
    const creativeReview = recordCreativeDiscussion(state.creativeReview, resume, result);
    const draftChanged = creativeReview.stages[stage].currentDraft?.sha256
      !== state.creativeReview.stages[stage].currentDraft?.sha256;
    return {
      creativeReview,
      ...creativeDocumentArtifactUpdate(state, stage, creativeReview),
      ...(draftChanged
        ? {
            issues: [],
            halt: null,
            ...(stage === "director" ? { manualDirectorReview: false } : {}),
          }
        : {}),
    };
  };
}

function invalidateAfterCreativeReturn(
  state: PlanningGraphState,
  targetStage: CreativeStage,
): Partial<PlanningGraphState> {
  const removedStages: PlanningStageId[] = targetStage === "treatment"
    ? ["script", "director", "candidates", "rank", "integrate", "compile"]
    : targetStage === "script"
      ? ["director", "candidates", "rank", "integrate", "compile"]
      : ["candidates", "rank", "integrate", "compile"];
  return {
    ...(targetStage === "treatment" ? { scriptArtifact: null, directorPlan: null } : {}),
    ...(targetStage === "script" ? { directorPlan: null } : {}),
    candidatesArtifact: null,
    ranking: null,
    integratedPlan: null,
    executablePlan: null,
    candidateSearchFingerprint: null,
    rankingInputFingerprint: null,
    candidateInventoryBinding: null,
    candidateInventorySha256: null,
    artifactIds: Object.fromEntries(Object.entries(state.artifactIds).filter(([stage]) => !removedStages.includes(stage as PlanningStageId))),
  };
}

function creativeDocumentArtifactUpdate(
  state: PlanningGraphState,
  stage: CreativeStage,
  review: CreativeReviewState,
): Partial<PlanningGraphState> {
  const stageState = review.stages[stage];
  if (!stageState.currentDraft || stageState.currentDocument === null) return {};
  const artifact = { artifactId: stageState.currentDraft.artifactId, output: structuredClone(stageState.currentDocument) };
  if (stage === "treatment") return { treatmentArtifact: artifact as PlanningArtifact<CreativeTreatment> };
  if (stage === "script") {
    return {
      scriptArtifact: artifact as PlanningArtifact<ScriptDraft>,
      ...invalidateRankingEvidence(state.artifactIds),
    };
  }
  return {
    directorPlan: artifact as PlanningArtifact<VisualDirectorPlan>,
    ...invalidateRankingEvidence(state.artifactIds),
  };
}

function routeAfterReview(stage: CreativeStage) {
  return (state: PlanningGraphState): "wait" | "next" | "treatment" | "script" | "recheck" => {
    if (state.creativeReview.activeStage !== stage) {
      return state.creativeReview.activeStage === "treatment" ? "treatment" : "script";
    }
    if (state.creativeReview.stages[stage].phase !== "confirmed") return "wait";
    return stage === "director" && state.manualDirectorReview ? "recheck" : "next";
  };
}

function routeAfterLibraryDirectorReview(
  state: PlanningGraphState,
): "halt" | "wait" | "next" | "treatment" | "script" | "recheck" | "candidates" | "rank" | "evaluate" {
  const reviewRoute = routeAfterReview("director")(state);
  if (reviewRoute !== "next") return reviewRoute;
  // 用户在导演讨论中可能改变素材路线或检索身份。讨论会使旧排序、整合与编译证据失效；
  // 只有当前确认稿仍有完整整合证据时才能直接编译，否则复用与正常导演节点相同的证据路由。
  if (state.integratedPlan !== null) return "next";
  return routeAfterDirector(state);
}

function currentCreativeDocument(
  state: PlanningGraphState,
  stage: CreativeStage,
): CreativeTreatment | ScriptDraft | VisualDirectorPlan {
  const artifact = stage === "treatment"
    ? state.treatmentArtifact
    : stage === "script"
      ? state.scriptArtifact
      : state.integratedPlan ?? state.directorPlan;
  if (!artifact) throw new Error(`Creative review '${stage}' document is missing from the planning checkpoint.`);
  return structuredClone(artifact.output);
}

function treatmentReviewInputDigest(state: PlanningGraphState): string {
  return planningContentDigest({ inputDigest: state.inputDigest, stage: "treatment" });
}

function scriptReviewInputDigest(state: PlanningGraphState): string {
  return planningContentDigest({
    inputDigest: state.inputDigest,
    stage: "script",
    treatment: state.creativeReview.stages.treatment.confirmation?.draftSha256,
  });
}

function directorReviewInputDigest(state: PlanningGraphState): string {
  return planningContentDigest({
    inputDigest: state.inputDigest,
    stage: "director",
    treatment: state.creativeReview.stages.treatment.confirmation?.draftSha256,
    script: state.creativeReview.stages.script.confirmation?.draftSha256,
  });
}

function contextFor(
  state: PlanningGraphState,
  creativeReviewExecution?: CreativePlanningContext["creativeReviewExecution"],
): CreativePlanningContext {
  // 角色 port 边界隔离：port 收到的是图状态的 JSON 深拷贝（与 SQLite checkpoint 的持久化语义
  // 一致）。port 原地改写传入 context 中的任何产物都只改写自己的副本，无法污染 graph state
  // 或后续 checkpoint——包括 integrate 的 baseline 身份（草案在 state 中，port 不可达）。
  // 不用 Object.freeze：浅冻结挡不住嵌套对象（shots/scenes）的别名改写。
  return isolatedPlanningValue<CreativePlanningContext>({
    runId: state.runId,
    inputDigest: state.inputDigest,
    base: state.base,
    stage: state.stage,
    issues: state.issues.map((issue) => ({ ...issue })),
    treatment: state.treatmentArtifact,
    script: state.scriptArtifact,
    directorPlan: state.directorPlan,
    candidates: state.candidatesArtifact,
    ranking: state.ranking,
    integratedPlan: state.integratedPlan,
    availabilityHistory: (state.availabilityBlockerObservations ?? []).map((observation) => ({
      ...observation,
      evidence: { ...observation.evidence },
      ...(observation.scenePositions ? { scenePositions: [...observation.scenePositions] } : {}),
      ...(observation.beatIds ? { beatIds: [...observation.beatIds] } : {}),
    })),
    ...(creativeReviewExecution
      ? { creativeReviewExecution }
      : state.base.creativeReview === CREATIVE_REVIEW_FEATURE && state.stage !== "compile"
        ? { creativeReviewExecution: { mode: "draft" as const } }
        : {}),
  });
}

// JSON round-trip 深拷贝：所有进入图状态或交给 port 的值都不保留对端可继续改写的别名。图的
// 状态本来就以 JSON 落 SQLite checkpoint，这一隔离与持久化语义天然一致（undefined 字段落拷贝
// 后消失，与 stablePlanningJson 的 undefined 过滤等价，不影响任何身份比较）。
// 非有限 number（NaN/Infinity/-Infinity）会被 JSON.stringify 静默改写成 null，下游
// `sourceInSeconds ?? 0` 一类的空值兜底会把静默的 null 变成 0 秒偏移——必须在该值被改写之前
// 以合同错误拒绝（fail closed），而不是把改写后的 null 当作已接受的产物。replacer 在改写发生
// 前收到原始 number，是拦截的唯一时点；只特判单个字段拦不住其他数值字段，所以检查是共享的。
function isolatedPlanningValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, rejectNonFinitePlanningNumber)) as T;
}

function rejectNonFinitePlanningNumber(key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(
      `Creative planning isolation rejected non-finite number ${String(value)} at '${key}': `
      + "values crossing the planning boundary must stay JSON-finite.",
    );
  }
  return value;
}

function withArtifactId(
  state: PlanningGraphState,
  stage: PlanningStageId,
  artifactId: string,
): Partial<Record<PlanningStageId, string[]>> {
  return { ...state.artifactIds, [stage]: [artifactId] };
}

// port 返回的产物必须立即可绑定 artifact：缺失/空 artifactId 或空 output 是合同违约，
// 直接失败（schema 类问题不 fallback）。
function requireArtifact(artifact: PlanningArtifact<unknown>, stage: string): void {
  if (typeof artifact !== "object" || artifact === null) {
    throw new Error(`Creative planning '${stage}' port must return an artifact object.`);
  }
  if (typeof artifact.artifactId !== "string" || !artifact.artifactId.trim()) {
    throw new Error(`Creative planning '${stage}' artifactId must be a non-empty string.`);
  }
  if (artifact.output === null || artifact.output === undefined) {
    throw new Error(`Creative planning '${stage}' artifact output must be defined.`);
  }
}

// 注入的 reviewer 输出同样过形状校验：责任路由只消费结构化 issue，不解析自然语言。
function parsePlanningIssue(value: unknown): PlanningIssue {
  const input = record(value, "Planning issue");
  const target = input.target;
  if (target !== "script" && target !== "director" && target !== "source" && target !== "user") {
    throw new Error("Planning issue target must be script, director, source, or user.");
  }
  const availabilityBlocker = input.availabilityBlocker === undefined
    ? undefined
    : parseAvailabilityBlocker(input.availabilityBlocker);
  return {
    id: text(input.id, "Planning issue id"),
    target,
    beatIds: stringArray(input.beatIds, "Planning issue beatIds"),
    scenePositions: numberArray(input.scenePositions, "Planning issue scenePositions"),
    reason: text(input.reason, "Planning issue reason"),
    requiredChange: text(input.requiredChange, "Planning issue requiredChange"),
    evidenceArtifactIds: stringArray(input.evidenceArtifactIds, "Planning issue evidenceArtifactIds"),
    ...(availabilityBlocker ? { availabilityBlocker } : {}),
  };
}

function parseAvailabilityBlocker(
  value: unknown,
): NonNullable<PlanningIssue["availabilityBlocker"]> {
  const blocker = exactRecord(
    value,
    ["reasonCode", "narrativeTarget", "impactScope", "evidence"],
    "Planning issue availabilityBlocker",
  );
  if (blocker.reasonCode !== "stock_candidate_below_automatic_use_threshold") {
    throw new Error("Planning issue availabilityBlocker reasonCode is invalid.");
  }
  const target = exactRecord(
    blocker.narrativeTarget,
    ["scenePurpose", "narrativeRole", "authenticityPolicy", "subject", "visibleAction", "successCriteria"],
    "Planning issue availabilityBlocker narrativeTarget",
  );
  const scope = exactRecord(
    blocker.impactScope,
    ["scenePositions", "beatIds"],
    "Planning issue availabilityBlocker impactScope",
  );
  const evidence = exactRecord(
    blocker.evidence,
    ["candidateCount", "bestSemanticScore", "lockedCandidateCount", "automaticUseMinimum"],
    "Planning issue availabilityBlocker evidence",
  );
  const candidateCount = nonNegativeInteger(evidence.candidateCount, "Planning issue availabilityBlocker candidateCount");
  const lockedCandidateCount = nonNegativeInteger(
    evidence.lockedCandidateCount,
    "Planning issue availabilityBlocker lockedCandidateCount",
  );
  const automaticUseMinimum = nonNegativeInteger(
    evidence.automaticUseMinimum,
    "Planning issue availabilityBlocker automaticUseMinimum",
  );
  const bestSemanticScore = evidence.bestSemanticScore === null
    ? null
    : nonNegativeInteger(evidence.bestSemanticScore, "Planning issue availabilityBlocker bestSemanticScore");
  return {
    reasonCode: blocker.reasonCode,
    narrativeTarget: {
      scenePurpose: text(target.scenePurpose, "Planning issue availabilityBlocker scenePurpose"),
      narrativeRole: text(target.narrativeRole, "Planning issue availabilityBlocker narrativeRole"),
      authenticityPolicy: text(target.authenticityPolicy, "Planning issue availabilityBlocker authenticityPolicy"),
      subject: optionalText(target.subject, "Planning issue availabilityBlocker subject"),
      visibleAction: optionalText(target.visibleAction, "Planning issue availabilityBlocker visibleAction"),
      successCriteria: stringArray(target.successCriteria, "Planning issue availabilityBlocker successCriteria"),
    },
    impactScope: {
      scenePositions: numberArray(scope.scenePositions, "Planning issue availabilityBlocker scenePositions"),
      beatIds: stringArray(scope.beatIds, "Planning issue availabilityBlocker beatIds"),
    },
    evidence: {
      candidateCount,
      bestSemanticScore,
      lockedCandidateCount,
      automaticUseMinimum,
    },
  };
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = record(value, field);
  const allowed = new Set(keys);
  const unknown = Object.keys(result).find((key) => !allowed.has(key));
  const missing = keys.find((key) => !(key in result));
  if (unknown) throw new Error(`${field} contains unknown field '${unknown}'.`);
  if (missing) throw new Error(`${field} is missing '${missing}'.`);
  return result;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative integer.`);
  return Number(value);
}

function optionalText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value.trim();
}

function rejectMissingDirectorPlan(): VisualDirectorPlan {
  throw new Error("Creative planning candidate routing requires a director plan artifact.");
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function numberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => {
    if (!Number.isInteger(entry)) throw new Error(`${field}[${index}] must be an integer.`);
    return entry as number;
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}
