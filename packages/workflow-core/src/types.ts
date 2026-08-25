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
  | "rejected";

export type NodeStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_human"
  | "rejected"
  | "skipped";

export type NodeMode = "automatic" | "manual" | "hybrid";

export type QualityGateStatus = "passed" | "failed" | "needs_human";

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

export interface Provider<TInput = unknown, TOutput = unknown> {
  id: string;
  capability: Capability;
  run: (input: TInput, context: WorkflowContext) => Promise<TOutput> | TOutput;
}

export interface ProviderSelector {
  capability: Capability;
  providerId?: string;
}

interface NodeExecutionBase<TOutput = unknown> {
  output?: TOutput;
  artifacts?: ArtifactDraft[];
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
  getInput?: (context: WorkflowContext) => TInput;
  execute?: (input: TInput, context: WorkflowContext) => Promise<NodeExecutionResult<TOutput>> | NodeExecutionResult<TOutput>;
  qualityGates?: QualityGateDefinition<TOutput>[];
}

export interface NodeRun<TOutput = unknown> {
  nodeId: string;
  role?: string;
  status: NodeStatus;
  startedAt: string;
  finishedAt?: string;
  output?: TOutput;
  artifactIds: string[];
  qualityGateResults: QualityGateResult[];
  intervention?: HumanIntervention;
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
  artifacts: Artifact[];
  interventions: HumanIntervention[];
  decisions: HumanDecision[];
}

export interface WorkflowContext<TInitialInput = unknown> {
  runId: string;
  workflowId: string;
  initialInput: TInitialInput;
  artifacts: readonly Artifact[];
  outputs: ReadonlyMap<string, unknown>;
  now: () => string;
  nextId: (prefix: string) => string;
  addArtifact: <TData = unknown>(draft: ArtifactDraft<TData>) => Artifact<TData>;
  findArtifacts: (kind?: ArtifactKind) => Artifact[];
  resolveProvider: <TInput = unknown, TOutput = unknown>(selector: ProviderSelector) => Provider<TInput, TOutput>;
}
