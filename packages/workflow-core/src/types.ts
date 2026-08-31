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
  licenseNote?: string;
  promptVersion?: string;
  model?: string;
  notes?: string;
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

export type HumanDecisionAction = "approve" | "reject";

export interface HumanInterventionDraft {
  reason: string;
  requiredAction: HumanDecisionAction;
  options?: HumanDecisionAction[];
  artifactIds?: string[];
}

export interface HumanIntervention extends HumanInterventionDraft {
  id: string;
  nodeId: string;
  createdAt: string;
}

export interface HumanDecisionDraft {
  interventionId: string;
  action: HumanDecisionAction;
  actor: string;
  note?: string;
}

export interface HumanDecision extends HumanDecisionDraft {
  id: string;
  createdAt: string;
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
  estimatedCostCny?: number;
  actualCostCny?: number;
  actualCostSource?: "provider_reported" | "configured_rate";
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

export interface SpendPlan {
  id: string;
  nodeId: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  estimatedCostCny: number;
  maxCostCny: number;
  maxAttempts: number;
  createdAt: string;
}

export interface SpendAuthorizationDraft {
  nodeId: string;
  inputVersionIds: string[];
  providerId: string;
  modelId: string;
  maxCostCny: number;
  maxAttempts: number;
  approvedBy: string;
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
  configurationSource?: ExecutionConfigurationSource;
  parameters?: Record<string, ExecutionParameterValue>;
  estimatedCostCny?: number;
  maxCostCny?: number;
  maxAttempts?: number;
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
  error?: string;
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
}

export interface WorkflowContext<TInitialInput = unknown> {
  runId: string;
  workflowId: string;
  initialInput: TInitialInput;
  artifacts: readonly Artifact[];
  outputs: ReadonlyMap<string, unknown>;
  readonly spendAuthorization: Readonly<SpendAuthorization> | undefined;
  readonly operationRequestId: string | undefined;
  now: () => string;
  nextId: (prefix: string) => string;
  addArtifact: <TData = unknown>(draft: ArtifactDraft<TData>) => Artifact<TData>;
  findArtifacts: (kind?: ArtifactKind) => Artifact[];
  resolveProvider: <TInput = unknown, TOutput = unknown>(selector: ProviderSelector) => Provider<TInput, TOutput>;
}
