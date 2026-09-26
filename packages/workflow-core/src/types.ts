export type JsonObject = Record<string, unknown>;

export type Platform =
  | "douyin"
  | "kuaishou"
  | "xiaohongshu"
  | "shipinhao"
  | "bilibili"
  | (string & {});

export type WorkflowStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "rejected"
  | "paused"
  | "stale"
  | "awaiting_spend_approval"
  | "approval_invalidated";

export type NodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "rejected"
  | "skipped"
  | "stale"
  | "awaiting_spend_approval"
  | "approval_invalidated";

export type NodeMode = "automatic" | "manual" | "hybrid";

export type QualityGateStatus = "passed" | "failed" | "needs_human";

export type ExecutionTransport = "unix_socket" | "local_process" | "http_api" | "human";

export type BillingType = "subscription" | "metered" | "free" | "local_compute" | "human";

export type ApprovalPolicy = "manual" | "automatic" | "none";

export type NodeExecutionReceiptStatus = "succeeded" | "failed" | "rejected" | "needs_human";
export type ExecutionConfigurationSource = "system_default" | "global_default" | "template_default" | "run_override" | "node_override";
export type ExecutionParameterValue = string | number | boolean | string[];

export type ArtifactKind =
  | "topic_signal"
  | "topic_candidate"
  | "script"
  | "storyboard"
  | "asset_plan"
  | "media_asset"
  | "voiceover"
  | "render"
  | "review_report"
  | "publish_package"
  | (string & {});

export type Capability =
  | "topic.intelligence"
  | "script.draft"
  | "storyboard.plan"
  | "asset.search"
  | "asset.prepare"
  | "voice.synthesize"
  | "video.render"
  | "quality.review"
  | "publish.package"
  | "metrics.ingest"
  | (string & {});

export interface Provenance {
  providerId?: string;
  providerVersion?: string;
  sourceUrl?: string;
  creator?: string;
  creatorUrl?: string;
  previewUrl?: string;
  licenseNote?: string;
  promptVersion?: string;
  model?: string;
  producerRequestDigest?: string;
  producerRequestSchemaVersion?: string;
  notes?: string;
  scenePosition?: number;
}

export interface ArtifactProducer {
  nodeId: string;
  attempt: number;
}

export interface Artifact<TData = unknown> {
  id: string;
  kind: ArtifactKind;
  data?: TData;
  uri?: string;
  createdAt: string;
  provenance: Provenance;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  schemaVersion?: string;
  parentArtifactIds?: string[];
  producer?: ArtifactProducer;
}

export interface ArtifactDraft<TData = unknown> {
  kind: ArtifactKind;
  data?: TData;
  uri?: string;
  provenance?: Provenance;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
  schemaVersion?: string;
  parentArtifactIds?: string[];
  producer?: ArtifactProducer;
}

export type HumanDecisionAction = "approve" | "request_changes" | "reject";

export interface HumanInterventionDraft {
  kind?: "creative_review" | "source_review_retry" | "source_review_decision";
  /**
   * 节点边界的"完成待放行"停点。显式标记而不靠 nodeId 或 options 猜：节点改名、增删
   * 按钮都不该让界面把"批准进入发布包"错安在一个中间节点的放行上。
   */
  boundary?: "node-complete";
  reason: string;
  requiredAction: HumanDecisionAction;
  options?: HumanDecisionAction[];
  /** 试片审查停点的事实分类；incomplete 只有在 provider 结果已知时才允许承担风险继续。 */
  reviewStatus?: "incomplete" | "unknown_or_unsafe";
  providerOutcomeKnown?: boolean;
  evidenceId?: string;
  artifactIds?: string[];
  continuation?: {
    stage: "treatment" | "script" | "director";
    reviewRevision: number;
    draftSha256: string;
  };
  /**
   * 自动循环是自己推不动了才停下的：停下的理由必须随停点一起到达人眼前。没有它，人只看到
   * "方案已生成，等你确认"，无从知道该在哪一件事上做决定。
   */
  stopDetail?: string;
}

export interface HumanIntervention extends HumanInterventionDraft {
  id: string;
  nodeId: string;
  createdAt: string;
}

/**
 * 人工对审片结论的逐条表态。采纳（accept）表示认可这条判断、要按它返修；
 * 不采纳（reject）表示维持现状不改，因此必须写明理由——不写理由的"我不认可"
 * 事后无法复核，等于把审片结论直接丢掉。
 */
export interface HumanReviewDisposition {
  /** 指向被表态的那一条问题。由问题内容算出，不含版本号与数组下标，重跑审片后同一问题仍是同一个键。 */
  itemKey: string;
  decision: "accept" | "reject" | "accept_risk";
  reason?: string;
}

export interface HumanDecisionDraft {
  interventionId: string;
  action: HumanDecisionAction;
  actor: string;
  note?: string;
  expectedRunRevision?: number;
  reviewEvidenceId?: string | null;
  /** 明确接受未完成审查风险继续生成首版；不能把审查状态改成通过。 */
  acceptIncomplete?: true;
  /** 逐条表态，成片终审用它取代"整片一句理由"的粗表态。未表态的问题不属于任何一侧，由调用方决定是否必须覆盖。 */
  reviewDispositions?: HumanReviewDisposition[];
  /** 发布文案/参考报告的本版人工决定，和成片审片证据及费用授权彼此独立。 */
  contentVersionId?: string;
  contentAuditStatus?: "passed" | "has_suggestions" | "not_audited";
  acceptUnauditedContent?: true;
  acceptContentSuggestions?: true;
}

export interface HumanDecision extends HumanDecisionDraft {
  id: string;
  createdAt: string;
}

export interface ExecutionConfigurationOverrideDraft<TInitialInput = unknown> {
  nodeId: string;
  actor: string;
  initialInput: TInitialInput;
  /** 调用方观察到的 run revision：持锁修改点必须复核，防止预检查后的并发写入被覆盖。 */
  expectedRunRevision?: number;
}

export interface QualityGateResult {
  gateId: string;
  status: QualityGateStatus;
  reasons: string[];
  score?: number;
  threshold?: number;
}

export interface QualityGateDefinition<TOutput = unknown> {
  id: string;
  description: string;
  evaluate: (context: WorkflowContext, output: TOutput) => Promise<QualityGateResult> | QualityGateResult;
}

export interface NodeExecutionReceiptDraft {
  providerId: string;
  providerLabel: string;
  modelId: string;
  transport: ExecutionTransport;
  billing: BillingType;
  configurationSource?: ExecutionConfigurationSource;
  parameters?: Record<string, ExecutionParameterValue>;
  /** 诊断字段超过 receipt 边界时只裁剪非核心参数；不能让观测失败改写业务结果。 */
  parametersTruncated?: boolean;
  estimatedCostCny?: number;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate" | "manual_reconciled";
  meteredAttemptCount?: number;
  meteredFailedAttemptCount?: number;
  requestId?: string;
  fallbackFromProviderId?: string;
  fallbackReason?: string;
  actualModelIds?: string[];
}

export interface NodeExecutionReceipt extends NodeExecutionReceiptDraft {
  nodeId: string;
  role?: string;
  capability: Capability;
  status: NodeExecutionReceiptStatus;
  spendAuthorizationId?: string;
  authorizedCostCny?: number;
  startedAt: string;
  finishedAt: string;
}

export interface NodeExecutionPlan extends NodeExecutionReceiptDraft {
  nodeId: string;
  role?: string;
  capability: Capability;
  snapshotSource: "created" | "reconstructed";
}

export type NodeOutputSource = "generated" | "human";

export interface NodeOutputVersion<TOutput = unknown> {
  id: string;
  nodeId: string;
  source: NodeOutputSource;
  artifactIds: string[];
  output?: TOutput;
  inputVersionIds: string[];
  parentVersionId?: string;
  createdAt: string;
  createdBy: string;
  schemaVersion: string;
}

export interface NodeOutputState<TOutput = unknown> {
  nodeId: string;
  generatedVersionId: string;
  effectiveVersionId: string;
  stale: boolean;
  versions: NodeOutputVersion<TOutput>[];
}

export type NodeInputSource = "derived" | "human" | "reconstructed";

export interface NodeInputVersion<TInput = unknown> {
  id: string;
  nodeId: string;
  source: NodeInputSource;
  value: TInput;
  upstreamVersionIds: string[];
  parentVersionId?: string;
  createdAt: string;
  createdBy: string;
  schemaVersion: string;
}

export interface NodeInputState<TInput = unknown> {
  nodeId: string;
  effectiveVersionId: string;
  stale: boolean;
  versions: NodeInputVersion<TInput>[];
}

export interface NodeInputOverrideDraft<TInput = unknown> {
  nodeId: string;
  actor: string;
  input: TInput;
  expectedVersionId?: string;
  /** 调用方观察到的 run revision：持锁修改点必须复核，防止预检查后的并发写入被覆盖。 */
  expectedRunRevision?: number;
  allowTerminalEdit?: boolean;
  schemaVersion?: string;
}

export interface NodeOverrideDraft<TOutput = unknown> {
  nodeId: string;
  actor: string;
  output?: TOutput;
  artifacts?: ArtifactDraft[];
  expectedVersionId?: string;
  allowTerminalEdit?: boolean;
  schemaVersion?: string;
}

export interface NodeRevisionDraft<TOutput = unknown> extends NodeOverrideDraft<TOutput> {
  expectedVersionId: string;
  retainedArtifactIds: string[];
  invalidateDescendantNodeIds: string[];
  decision: HumanDecisionDraft & { action: "request_changes" };
}

export interface SpendPlan {
  id: string;
  nodeId: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  estimatedCostCny: number;
  maxCostCny: number;
  maxAttempts: number;
  items?: SpendQuoteItem[];
  excludedItems?: SpendExcludedItem[];
  createdAt: string;
}

export interface SpendQuoteItem {
  id: string;
  label: string;
  providerId: string;
  modelId: string;
  estimatedCostCny: number;
}

// 报价只列需要付费的条目，因此"不花钱的部分"在确认页上原本完全不出现——操作员看到
// 「制作内容」写整片、清单却少几行时，无法区分"这几镜头免费"与"这几镜头被漏掉了"。
// 这个字段只承载知情信息，不参与任何计费、授权或额度计算。
export interface SpendExcludedItem {
  id: string;
  label: string;
  /** 面向操作员的免收费理由，例如「复用镜头 1 的画面，不重复购买」。 */
  note: string;
}

export interface SpendQuote {
  estimatedCostCny: number;
  maxCostCny: number;
  items?: SpendQuoteItem[];
  excludedItems?: SpendExcludedItem[];
  // 只有解析后的当前输入明确不产生任何计费调用时，Provider 才能声明这一轮无需人工授权。
  requiresAuthorization?: boolean;
}

export interface SpendAuthorizationDraft {
  spendPlanId: string;
  nodeId: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  maxCostCny: number;
  maxAttempts: number;
  approvedBy: string;
  // C1：由制作范围授权（production scope）派生子凭证时的来源证明。仅作内部审计字段，
  // 不参与 exact matcher 的相等比较。
  derivedFromScopeId?: string;
  // C1：scope 派生的逐素材剩余 create 预算（assetKey → 剩余次数）。范围收窄发生在预留层，
  // 不改变必须与报价计划逐字段一致的 maxCostCny/maxAttempts；worker 在每个 create 边界执行。
  itemCreateBudgets?: Record<string, number>;
}

export interface SpendAuthorization extends SpendAuthorizationDraft {
  id: string;
  approvedAt: string;
}

export interface Provider<TInput = unknown, TOutput = unknown> {
  id: string;
  label?: string;
  modelId?: string;
  capability: Capability;
  transport?: ExecutionTransport;
  billing?: BillingType;
  approvalPolicy?: ApprovalPolicy;
  configurationSource?: ExecutionConfigurationSource;
  parameters?: Record<string, ExecutionParameterValue>;
  estimatedCostCny?: number;
  maxCostCny?: number;
  maxAttempts?: number;
  quoteSpend?: (input: TInput, context: WorkflowContext) => Promise<SpendQuote> | SpendQuote;
  run: (input: TInput, context: WorkflowContext) => Promise<TOutput> | TOutput;
}

export interface ProviderSelector {
  capability: Capability;
  providerId?: string;
}

interface NodeExecutionBase<TOutput = unknown> {
  output?: TOutput;
  artifacts?: ArtifactDraft[];
  receipt?: NodeExecutionReceiptDraft;
  error?: string;
  errorCode?: string;
  // 计费执行已成功落定，但同一节点内的免费后置检查失败时，不应误锁为付费结果未知。
  providerOutcomeKnown?: boolean;
  // 节点 execute 内已通过 context.addArtifact 登记的全局产物（如崩溃恢复后已存在的正式产物）：
  // 由 runner 校验归属（producer.nodeId 必须精确等于当前节点）后去重挂入 nodeRun.artifactIds，
  // 不重复登记。服务幂等恢复场景，不改变 result.artifacts 的既有合同。
  preRegisteredArtifactIds?: string[];
}

export type NodeExecutionResult<TOutput = unknown> =
  | (NodeExecutionBase<TOutput> & { status?: "succeeded" })
  | (NodeExecutionBase<TOutput> & { status: "failed" | "rejected" })
  | (NodeExecutionBase<TOutput> & { status: "needs_human"; intervention: HumanInterventionDraft });

export interface NodeDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  label: string;
  role?: string;
  capability: Capability;
  mode: NodeMode;
  dependsOn?: string[];
  providerId?: string;
  plannedExecution?: NodeExecutionReceiptDraft;
  getInput?: (context: WorkflowContext) => TInput;
  execute?: (input: TInput, context: WorkflowContext) => Promise<NodeExecutionResult<TOutput>> | NodeExecutionResult<TOutput>;
  validateInputOverride?: (input: unknown, context: WorkflowContext) => TInput;
  validateOverride?: (output: unknown, context: WorkflowContext) => TOutput;
  qualityGates?: QualityGateDefinition<TOutput>[];
}

export interface NodeRun<TOutput = unknown> {
  nodeId: string;
  role?: string;
  status: NodeStatus;
  startedAt: string;
  operationRequestId?: string;
  interrupted?: boolean;
  outcomeUncertain?: boolean;
  finishedAt?: string;
  output?: TOutput;
  artifactIds: string[];
  qualityGateResults: QualityGateResult[];
  intervention?: HumanIntervention;
  executionReceipt?: NodeExecutionReceipt;
  inputState?: NodeInputState;
  outputState?: NodeOutputState<TOutput>;
  spendPlan?: SpendPlan;
  spendAuthorizationId?: string;
  // C1：报价等待节点上最近一次"范围未覆盖"的结构化评估（原因/金额/缺失目标），
  // 供服务端投影给 C2；凭范围自动继续或重新报价时清除。
  spendAssessment?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  nodes: NodeDefinition[];
}

export interface WorkflowRun<TInitialInput = unknown> {
  id: string;
  revision: number;
  workflowId: string;
  workflowVersion: string;
  status: WorkflowStatus;
  initialInput: TInitialInput;
  startedAt: string;
  finishedAt?: string;
  nodeRuns: NodeRun[];
  executionPlan?: NodeExecutionPlan[];
  artifacts: Artifact[];
  interventions: HumanIntervention[];
  decisions: HumanDecision[];
  executionReceipts?: NodeExecutionReceipt[];
  spendAuthorizations?: SpendAuthorization[];
  consumedSpendAuthorizationIds?: string[];
  /**
   * 创作讨论命令的持久化幂等账本。它只记录命令身份和终态，不复制创作正文；
   * 正文与消息仍由 creative-planning checkpoint 作为唯一权威。
   */
  creativeReviewOperations?: Array<{
    commandId: string;
    requestDigest: string;
    action: "discuss" | "revise" | "audit_current" | "adopt_proposal" | "edit_draft" | "undo_draft" | "confirm" | "return_to_stage";
    stage: "treatment" | "script" | "director";
    status: "running" | "completed" | "failed" | "unknown";
    acceptedAt: string;
    finishedAt?: string;
    /** 原始用户命令与图恢复输入；用于进程重启后观察/续接同一物理请求。 */
    request?: Record<string, unknown>;
    resume?: unknown;
  }>;
}

export interface WorkflowContext<TInitialInput = unknown> {
  runId: string;
  workflowId: string;
  initialInput: TInitialInput;
  artifacts: readonly Artifact[];
  decisions: readonly HumanDecision[];
  outputs: ReadonlyMap<string, unknown>;
  readonly spendAuthorization: Readonly<SpendAuthorization> | undefined;
  readonly spendAuthorizationExemptProviderId: string | undefined;
  readonly operationRequestId: string | undefined;
  now: () => string;
  nextId: (prefix: string) => string;
  addArtifact: <TData = unknown>(draft: ArtifactDraft<TData>) => Artifact<TData>;
  findArtifacts: (kind?: ArtifactKind) => Artifact[];
  resolveProvider: <TInput = unknown, TOutput = unknown>(selector: ProviderSelector) => Provider<TInput, TOutput>;
}
