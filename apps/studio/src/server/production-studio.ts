import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeVersionConflictError } from "@video-factory/workflow-core";
import type { ArtifactDraft, NodeInputOverrideDraft, NodeOverrideDraft, SpendAuthorizationDraft, WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionTemplateSnapshot } from "@video-factory/template-core";
import {
  parseBrief,
  StaleRunRevisionError,
  type DispatchedProductionRun,
  type ProductionBrief,
  type ProductionRunListener,
} from "@video-factory/production-pipeline";
import {
  StudioInputError,
  type StartRunResponse,
  type StudioArtifact,
  type StudioArtifactResource,
  type StudioDecision,
  type StudioDecisionInput,
  type StudioIntervention,
  type StudioNode,
  type StudioNodeInputOverrideInput,
  type StudioNodeOverrideInput,
  type StudioProvider,
  type StudioRunDetail,
  type StudioRunSummary,
} from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";
import { validateNodeOverrideOutput } from "./node-output-validator.js";

const MANAGED_FILE_PLACEHOLDER = "[系统托管文件]";

export interface StudioPipelinePort {
  list(): Promise<WorkflowRun<ProductionBrief>[]>;
  remove(runId: string): Promise<void>;
  loadPersisted(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  show(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  dispatch(input: unknown, listener?: ProductionRunListener): Promise<DispatchedProductionRun>;
  decide(runId: string, decision: {
    interventionId: string;
    action: "approve" | "reject";
    actor: string;
    note?: string;
  }): Promise<WorkflowRun<ProductionBrief>>;
  applyNodeOverride(runId: string, override: NodeOverrideDraft): Promise<WorkflowRun<ProductionBrief>>;
  applyNodeInputOverride(runId: string, override: NodeInputOverrideDraft): Promise<WorkflowRun<ProductionBrief>>;
  authorizeSpend(runId: string, authorization: SpendAuthorizationDraft): Promise<WorkflowRun<ProductionBrief>>;
  resumeStale(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  retryFailedNode(runId: string, nodeId: string): Promise<WorkflowRun<ProductionBrief>>;
}

export interface ProductionStudioOptions {
  workspaceRoot: string;
  pipeline: StudioPipelinePort;
  listProviders: () => Promise<StudioProvider[]>;
  maxRunCostCny?: number;
  resolveTemplateSnapshot?: (input: unknown, brief: ProductionBrief) => Promise<ProductionTemplateSnapshot>;
}

const WORKFLOW_NODES: Array<{ id: string; label: string; role: string }> = [
  { id: "brief", label: "内容简报", role: "制片人" },
  { id: "script", label: "脚本", role: "编剧" },
  { id: "reference-grammar", label: "参考镜头语法", role: "参考视频分析师" },
  { id: "visual-direction", label: "导演方案", role: "导演" },
  { id: "asset-candidates", label: "候选素材", role: "素材研究员" },
  { id: "asset-semantic-rank", label: "语义选片", role: "语义选片师" },
  { id: "assets", label: "画面", role: "素材导演" },
  { id: "voice", label: "配音", role: "声音导演" },
  { id: "render", label: "渲染", role: "剪辑师" },
  { id: "technical-review", label: "机器质检", role: "技术质检" },
  { id: "visual-review", label: "视觉审片", role: "视觉审片员" },
  { id: "final-review", label: "人工终审", role: "总导演" },
  { id: "publish-package", label: "发布文案与发布包", role: "发行编辑" },
];

const EDITABLE_DOCUMENTS: Record<string, { pathField: string; kind: string; embeddedField?: string }> = {
  script: { pathField: "scriptPath", kind: "script" },
  "reference-grammar": { pathField: "referenceGrammarPath", kind: "shot_grammar", embeddedField: "grammar" },
  "visual-direction": { pathField: "directorPlanPath", kind: "storyboard" },
  "asset-candidates": { pathField: "candidateSearchPath", kind: "asset_candidates" },
  "asset-semantic-rank": { pathField: "candidateRankingPath", kind: "asset_ranking", embeddedField: "ranking" },
  assets: { pathField: "assetPlanPath", kind: "asset_plan" },
  voice: { pathField: "voiceoverPlanPath", kind: "voiceover_plan" },
  render: { pathField: "renderManifestPath", kind: "render_manifest" },
  "technical-review": { pathField: "reviewPath", kind: "review_report" },
  "visual-review": { pathField: "visualReviewPath", kind: "review_report", embeddedField: "report" },
  "publish-package": { pathField: "publishPackagePath", kind: "publish_package" },
};

export class ProductionStudio {
  private readonly listeners = new Map<string, Set<(run: StudioRunDetail) => void>>();
  private readonly completions = new Set<Promise<void>>();
  private readonly startsInFlight = new Map<string, { digest: string; operation: Promise<StartRunResponse> }>();

  constructor(private readonly options: ProductionStudioOptions) {}

  async list(): Promise<StudioRunSummary[]> {
    return (await this.options.pipeline.list()).map(toRunSummary);
  }

  async get(runId: string): Promise<StudioRunDetail | undefined> {
    try {
      return toRunDetail(await this.options.pipeline.show(runId));
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async remove(runId: string): Promise<void> {
    const current = await this.loadRequiredRun(runId);
    if (!isTerminalRun(current.status)) {
      throw new StudioConflictError("这条制作仍在运行或等待确认，结束流程后才能删除。");
    }
    await this.options.pipeline.remove(runId);
    this.listeners.delete(runId);
    await this.removeStartRecordsForRun(runId);
  }

  private async removeStartRecordsForRun(runId: string): Promise<void> {
    const directory = path.join(this.options.workspaceRoot, "idempotency", "production-start");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const recordPath = path.join(directory, entry);
      try {
        const record = await readStartRecord(recordPath);
        if (record.state === "completed" && record.response?.runId === runId) {
          await rm(recordPath, { force: true });
        }
      } catch {
        // 旧记录损坏不应阻止用户删除已经结束的制作。
      }
    }));
  }

  async replayStart(input: unknown, idempotencyKey?: string): Promise<StartRunResponse | undefined> {
    if (!idempotencyKey) return undefined;
    assertIdempotencyKey(idempotencyKey);
    const digest = startRequestDigest(input);
    const inFlight = this.startsInFlight.get(idempotencyKey);
    if (inFlight) {
      if (inFlight.digest !== digest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      return inFlight.operation;
    }
    const recordPath = startRecordPath(this.options.workspaceRoot, idempotencyKey);
    try {
      await stat(recordPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    const previous = await readStartRecord(recordPath);
    if (previous.digest !== digest) {
      throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
    }
    if (previous.state === "completed" && previous.response) return previous.response;
    throw new StudioConflictError("相同制作请求仍在处理中，请稍后查看制作记录，不会重复扣费。");
  }

  async start(input: unknown, idempotencyKey?: string, idempotencyInput: unknown = input): Promise<StartRunResponse> {
    const replay = await this.replayStart(idempotencyInput, idempotencyKey);
    if (replay) return replay;
    let brief = parseBriefWithInputError(input);
    if (brief.reviewMode !== "manual") {
      throw new StudioInputError("正式制作必须经过人工终审，不能自动跳过发布前确认。");
    }
    const maxRunCostCny = this.options.maxRunCostCny ?? 20;
    if (brief.economics.maxCostCny > maxRunCostCny) {
      throw new StudioInputError(`本次成本上限不能超过服务端安全上限 ¥${maxRunCostCny}。`);
    }
    if (this.options.resolveTemplateSnapshot) {
      try {
        const templateSnapshot = await this.options.resolveTemplateSnapshot(input, brief);
        brief = applyTemplateModelDefaults({ ...brief, templateSnapshot }, templateSnapshot.modelDefaults);
      } catch (error) {
        throw new StudioInputError(error instanceof Error ? error.message : "模板解析失败。");
      }
    }
    await this.assertProvidersAvailable(brief, maxRunCostCny);
    if (!idempotencyKey) return this.dispatchBrief(brief);
    assertIdempotencyKey(idempotencyKey);
    const existing = this.startsInFlight.get(idempotencyKey);
    const requestDigest = startRequestDigest(idempotencyInput);
    if (existing) {
      if (existing.digest !== requestDigest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      return existing.operation;
    }
    const operation = this.startIdempotently(brief, idempotencyKey, requestDigest).finally(() => {
      if (this.startsInFlight.get(idempotencyKey)?.operation === operation) this.startsInFlight.delete(idempotencyKey);
    });
    this.startsInFlight.set(idempotencyKey, { digest: requestDigest, operation });
    return operation;
  }

  private async dispatchBrief(brief: ProductionBrief): Promise<StartRunResponse> {
    const dispatched = await this.options.pipeline.dispatch(brief, (run) => this.publish(toRunDetail(run)));
    const tracked: Promise<void> = dispatched.completion
      .then(() => undefined)
      .catch(async () => {
        const persisted = await this.get(dispatched.runId);
        if (persisted) this.publish(persisted);
      })
      .finally(() => this.completions.delete(tracked));
    this.completions.add(tracked);
    return { runId: dispatched.runId, status: "running" };
  }

  private async startIdempotently(brief: ProductionBrief, idempotencyKey: string, digest: string): Promise<StartRunResponse> {
    const directory = path.join(this.options.workspaceRoot, "idempotency", "production-start");
    const recordPath = startRecordPath(this.options.workspaceRoot, idempotencyKey);
    await mkdir(directory, { recursive: true });
    try {
      const handle = await open(recordPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, state: "pending", digest })}\n`, "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const previous = await readStartRecord(recordPath);
      if (previous.digest !== digest) {
        throw new StudioConflictError("这个制作请求编号已被另一组参数使用，请重新打开制作方案。");
      }
      if (previous.state === "completed" && previous.response) return previous.response;
      throw new StudioConflictError("相同制作请求仍在处理中，请稍后查看制作记录，不会重复扣费。");
    }

    let response: StartRunResponse;
    try {
      response = await this.dispatchBrief(brief);
    } catch (error) {
      await rm(recordPath, { force: true });
      throw error;
    }
    await writeStartRecord(recordPath, { version: 1, state: "completed", digest, response });
    return response;
  }

  async decide(runId: string, input: StudioDecisionInput, actor: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status !== "needs_human") throw new StudioConflictError("这条制作当前不在人工终审阶段。");
    const intervention = current.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
    if (!intervention) throw new StudioConflictError("这条制作没有待处理的人工决定。");
    if (input.action === "reject" && !input.note?.trim()) throw new StudioConflictError("打回时必须填写原因。");
    let updated: WorkflowRun<ProductionBrief>;
    try {
      updated = await this.options.pipeline.decide(runId, {
        interventionId: intervention.id,
        action: input.action,
        actor,
        ...(input.note ? { note: input.note } : {}),
      });
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新页面后重试。");
      }
      throw error;
    }
    const detail = toRunDetail(updated);
    this.publish(detail);
    return detail;
  }

  async applyNodeOverride(
    runId: string,
    nodeId: string,
    input: StudioNodeOverrideInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status === "running") {
      throw new StudioConflictError("制作仍在执行，暂时不能修改节点。请等待它停在确认点后再编辑。");
    }
    if (isTerminalRun(current.status) && input.confirmTerminalEdit !== true) {
      throw new StudioConflictError("这条制作已经结束。请明确确认创建人工修订版后再保存。");
    }
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new StudioInputError(`没有找到节点“${nodeId}”。`);
    const editsOutput = input.output !== undefined;
    const editsDocument = input.document !== undefined;
    if (editsOutput === editsDocument) throw new StudioInputError("请选择一种节点交付进行修改。");
    const effectiveVersion = node.outputState?.versions.find((version) => version.id === node.outputState?.effectiveVersionId);
    const reference = effectiveVersion?.output ?? node.output;
    let overrideOutput = input.output === undefined
      ? undefined
      : restoreManagedFileReferences(input.output, reference);
    let overrideArtifacts: ArtifactDraft[] | undefined;
    let humanDocumentPaths: string[] = [];
    if (input.document) {
      const prepared = await this.prepareDocumentOverride({
        runId,
        nodeId,
        actor,
        reference,
        nodeArtifactIds: node.artifactIds,
        runArtifacts: current.artifacts,
        document: input.document,
        authorizedRunFiles: input.authorizedRunFiles ?? [],
      });
      overrideOutput = prepared.output;
      overrideArtifacts = prepared.artifacts;
      humanDocumentPaths = prepared.cleanupPaths;
    }
    validateNodeOverrideOutput({
      output: overrideOutput,
      reference,
      nodeId,
      runRoot: path.join(this.options.workspaceRoot, "runs", runId),
      allowPathChanges: editsDocument,
    });
    let persisted = false;
    try {
      const updated = await this.options.pipeline.applyNodeOverride(runId, {
        nodeId,
        actor,
        output: overrideOutput,
        ...(overrideArtifacts ? { artifacts: overrideArtifacts } : {}),
        ...(effectiveVersion ? { expectedVersionId: effectiveVersion.id } : {}),
        allowTerminalEdit: isTerminalRun(current.status) && input.confirmTerminalEdit === true,
        schemaVersion: effectiveVersion?.schemaVersion ?? "1",
      });
      persisted = true;
      const detail = toRunDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (!persisted) {
        await Promise.all(humanDocumentPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      }
      if (error instanceof StaleRunRevisionError || error instanceof NodeVersionConflictError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async applyNodeInputOverride(
    runId: string,
    nodeId: string,
    input: StudioNodeInputOverrideInput,
    actor: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status === "running") {
      throw new StudioConflictError("制作仍在执行，暂时不能修改节点输入。请等待它停在确认点后再编辑。");
    }
    if (isTerminalRun(current.status) && input.confirmTerminalEdit !== true) {
      throw new StudioConflictError("这条制作已经结束。请明确确认创建人工修订版后再保存输入。");
    }
    if (!current.nodeRuns.some((candidate) => candidate.nodeId === nodeId)) {
      throw new StudioInputError(`没有找到节点“${nodeId}”。`);
    }
    const node = current.nodeRuns.find((candidate) => candidate.nodeId === nodeId)!;
    const effectiveInputVersion = node.inputState?.versions.find(
      (version) => version.id === node.inputState?.effectiveVersionId,
    );
    try {
      const updated = await this.options.pipeline.applyNodeInputOverride(runId, {
        nodeId,
        actor,
        input: restoreManagedFileReferences(input.input, effectiveInputVersion?.value),
        ...(effectiveInputVersion ? { expectedVersionId: effectiveInputVersion.id } : {}),
        allowTerminalEdit: isTerminalRun(current.status) && input.confirmTerminalEdit === true,
      });
      const detail = toRunDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || error instanceof NodeVersionConflictError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  private async prepareDocumentOverride(options: {
    runId: string;
    nodeId: string;
    actor: string;
    reference: unknown;
    nodeArtifactIds: string[];
    runArtifacts: WorkflowRun<ProductionBrief>["artifacts"];
    document: NonNullable<StudioNodeOverrideInput["document"]>;
    authorizedRunFiles: string[];
  }): Promise<{ output: Record<string, unknown>; artifacts: ArtifactDraft[]; cleanupPaths: string[] }> {
    const contract = EDITABLE_DOCUMENTS[options.nodeId];
    if (!contract) throw new StudioInputError(`节点“${options.nodeId}”没有可编辑的结构化产物。`);
    if (!isRecord(options.reference)) throw new StudioInputError(`节点“${options.nodeId}”尚无可编辑的结构化交付。`);
    const artifact = options.runArtifacts.find((candidate) => candidate.id === options.document.artifactId);
    if (!artifact || !options.nodeArtifactIds.includes(artifact.id) || artifact.producer?.nodeId !== options.nodeId) {
      throw new StudioInputError("请选择这个节点当前可编辑产物。");
    }
    if (artifact.kind !== contract.kind || artifact.contentType !== "application/json" || !artifact.uri) {
      throw new StudioInputError("所选产物不是这个节点可编辑的 JSON 交付。");
    }
    const referencedPath = options.reference[contract.pathField];
    if (typeof referencedPath !== "string" || path.resolve(referencedPath) !== path.resolve(artifact.uri)) {
      throw new StudioInputError("所选产物已经不是当前有效版本，请刷新后重试。");
    }
    const runRoot = path.join(this.options.workspaceRoot, "runs", options.runId);
    await assertContainedFile(runRoot, artifact.uri);
    let referenceDocument: unknown;
    try {
      referenceDocument = JSON.parse(await readFile(artifact.uri, "utf8"));
    } catch {
      throw new StudioInputError("当前结构化产物无法读取，请先重新生成该节点。");
    }
    const mediaArtifacts = await prepareAuthorizedRunFileArtifacts({
      nodeId: options.nodeId,
      actor: options.actor,
      runRoot,
      referenceDocument,
      nextDocument: options.document.content,
      authorizedRunFiles: options.authorizedRunFiles,
      parentArtifactId: artifact.id,
      attempt: artifact.producer?.attempt ?? 1,
    });
    validateNodeOverrideOutput({
      output: options.document.content,
      reference: referenceDocument,
      nodeId: `${options.nodeId} 结构化交付`,
      runRoot,
      allowPathChanges: mediaArtifacts.length > 0,
    });

    const revisionId = randomUUID();
    const content = `${JSON.stringify(options.document.content, null, 2)}\n`;
    const destination = path.join(runRoot, "nodes", options.nodeId, "human-revisions", `${revisionId}.json`);
    const output = structuredClone(options.reference);
    output[contract.pathField] = destination;
    const privateRevision = options.nodeId === "asset-candidates"
      ? await prepareCandidateInventoryRevision(runRoot, options.reference, options.document.content, revisionId)
      : undefined;
    if (privateRevision) output.candidateInventoryPath = privateRevision.destination;
    if (contract.embeddedField) output[contract.embeddedField] = structuredClone(options.document.content);
    if (options.nodeId === "technical-review" && isRecord(options.document.content)) {
      output.passed = options.document.content.status === "passed";
    }
    const cleanupPaths = [destination, ...(privateRevision ? [privateRevision.destination] : [])];
    try {
      await writePrivateTextAtomically(destination, content);
      if (privateRevision) await writePrivateTextAtomically(privateRevision.destination, privateRevision.content);
    } catch (error) {
      await Promise.all(cleanupPaths.map((candidate) => rm(candidate, { force: true }).catch(() => undefined)));
      throw error;
    }
    return {
      output,
      cleanupPaths,
      artifacts: [{
        kind: artifact.kind,
        uri: destination,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        contentType: "application/json",
        ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
        parentArtifactIds: [artifact.id],
        producer: { nodeId: options.nodeId, attempt: artifact.producer?.attempt ?? 1 },
        provenance: {
          providerId: "human-editor",
          providerVersion: "1",
          creator: options.actor,
          licenseNote: "Human-edited derivative retained as an immutable revision.",
        },
      }, ...mediaArtifacts, ...(privateRevision ? [{
        kind: "candidate_inventory_private",
        uri: privateRevision.destination,
        sha256: createHash("sha256").update(privateRevision.content).digest("hex"),
        sizeBytes: Buffer.byteLength(privateRevision.content),
        contentType: "application/json",
        schemaVersion: "video-factory/asset-candidate-inventory-v1",
        parentArtifactIds: [artifact.id],
        producer: { nodeId: options.nodeId, attempt: artifact.producer?.attempt ?? 1 },
        provenance: {
          providerId: "human-editor-private-state",
          providerVersion: "1",
          creator: options.actor,
          licenseNote: "Private runtime inventory synchronized to the reviewed public candidate revision.",
        },
      } satisfies ArtifactDraft] : [])],
    };
  }

  async authorizeSpend(
    runId: string,
    nodeId: string,
    input: Omit<SpendAuthorizationDraft, "nodeId" | "approvedBy">,
    approvedBy: string,
  ): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    const plan = current.nodeRuns.find((node) => node.nodeId === nodeId)?.spendPlan;
    if (!plan) throw new StudioConflictError("这个节点当前没有待确认的费用计划，请刷新页面后重试。");
    if (
      input.providerId !== plan.providerId
      || input.modelId !== plan.modelId
      || input.maxCostCny !== plan.maxCostCny
      || input.maxAttempts !== plan.maxAttempts
      || input.inputVersionIds.length !== plan.inputVersionIds.length
      || input.inputVersionIds.some((versionId, index) => versionId !== plan.inputVersionIds[index])
    ) {
      throw new StudioConflictError("费用计划或上游版本已经变化，请重新检查后确认。");
    }
    try {
      const updated = await this.options.pipeline.authorizeSpend(runId, {
        nodeId,
        inputVersionIds: [...plan.inputVersionIds],
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: plan.maxCostCny,
        maxAttempts: plan.maxAttempts,
        approvedBy,
      });
      const detail = toRunDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("费用授权已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async resumeStale(runId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status !== "stale") throw new StudioConflictError("这条制作当前没有需要重新生成的旧结果。");
    try {
      const updated = await this.options.pipeline.resumeStale(runId);
      const detail = toRunDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  async retryFailedNode(runId: string, nodeId: string): Promise<StudioRunDetail> {
    const current = await this.loadRequiredRun(runId);
    if (current.status !== "failed" || current.nodeRuns.find((node) => node.nodeId === nodeId)?.status !== "failed") {
      throw new StudioConflictError("这个节点当前不能重试，请刷新页面检查最新状态。");
    }
    try {
      const updated = await this.options.pipeline.retryFailedNode(runId, nodeId);
      const detail = toRunDetail(updated);
      this.publish(detail);
      return detail;
    } catch (error) {
      if (error instanceof StaleRunRevisionError || (error instanceof Error && /locked by another writer/.test(error.message))) {
        throw new StudioConflictError("这条制作已被其他操作更新，请刷新后重试。");
      }
      throw error;
    }
  }

  subscribe(runId: string, listener: (run: StudioRunDetail) => void): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<(run: StudioRunDetail) => void>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  async resolveArtifact(runId: string, artifactId: string): Promise<StudioArtifactResource | undefined> {
    let run: WorkflowRun<ProductionBrief>;
    try {
      run = await this.options.pipeline.loadPersisted(runId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioNotFoundError("没有找到这条制作记录。");
      throw error;
    }
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact?.uri || isPrivateArtifactKind(artifact.kind)) return undefined;
    const [runRoot, artifactPath] = await Promise.all([
      realpath(path.join(this.options.workspaceRoot, "runs", runId)),
      realpath(artifact.uri),
    ]);
    const relative = path.relative(runRoot, artifactPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Artifact '${artifactId}' is outside run directory '${runId}'.`);
    }
    const artifactStat = await stat(artifactPath);
    if (!artifactStat.isFile()) return undefined;
    return { path: artifactPath, contentType: artifact.contentType ?? "application/octet-stream", sizeBytes: artifactStat.size };
  }

  private async loadRequiredRun(runId: string): Promise<WorkflowRun<ProductionBrief>> {
    try {
      return await this.options.pipeline.show(runId);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StudioNotFoundError("没有找到这条制作记录。");
      throw error;
    }
  }

  private async assertProvidersAvailable(brief: ProductionBrief, maxRunCostCny: number): Promise<void> {
    const providers = await this.options.listProviders();
    const selectedProviderIds = new Set([
      brief.providers.script,
      ...(brief.providers.director ? [brief.providers.director] : []),
      brief.providers.assets,
      brief.providers.voice,
      brief.providers.render,
      brief.providers.technicalReview,
      ...(brief.providers.visualReview ? [brief.providers.visualReview] : []),
      ...(brief.director?.assetProviderIds ?? []),
      ...(brief.workflowFeatures?.referenceGrammar ? ["codex-reference-grammar-v1"] : []),
    ]);
    if (brief.workflowFeatures?.referenceGrammar) {
      const referenceProvider = providers.find((provider) => provider.id === "codex-reference-grammar-v1");
      if (!referenceProvider?.available || referenceProvider.capability !== "reference.grammar") {
        throw new StudioInputError("参考视频分析能力当前不可用，请检查 Codex Broker 后重试。");
      }
    }
    for (const [providerId, modelId] of Object.entries(brief.models ?? {})) {
      if (!selectedProviderIds.has(providerId)) {
        throw new StudioInputError(`模型“${modelId}”绑定到了本次未启用的能力“${providerId}”。`);
      }
      const provider = providers.find((candidate) => candidate.id === providerId);
      const model = provider?.modelProfiles?.find((candidate) => candidate.id === modelId);
      if (!provider || !model) throw new StudioInputError(`“${provider?.label ?? providerId}”不支持模型“${modelId}”。`);
      if (!model.available) throw new StudioInputError(`模型“${model.label}”当前不可用。`);
    }
    let fixedMeteredEstimateCny = 0;
    const bindings: Array<[string, string]> = [
      ["script.draft", brief.providers.script],
      ...(brief.director && brief.providers.director ? [["storyboard.plan", brief.providers.director] as [string, string]] : []),
      ["asset.prepare", brief.providers.assets],
      ["voice.synthesize", brief.providers.voice],
      ["video.render", brief.providers.render],
      ["quality.review", brief.providers.technicalReview],
      ...(brief.providers.visualReview ? [["quality.review.visual", brief.providers.visualReview] as [string, string]] : []),
    ];
    for (const [capability, id] of bindings) {
      const selected = providers.find((candidate) => candidate.capability === capability && candidate.id === id);
      if (!selected) throw new StudioInputError(`没有找到制作能力“${id}”。`);
      if (selected.kind === "test") {
        throw new StudioInputError(`“${selected.label}”是测试能力，不能用于正式制作。`);
      }
      if (!selected.available) {
        throw new StudioInputError(`“${selected.label}”当前不可用：${selected.requirement ?? "缺少运行条件"}。`);
      }
      if (selected.billing !== "metered") continue;
      if (!brief.economics.allowMeteredProviders) {
        throw new StudioInputError(`当前配方未允许使用付费能力“${selected.label}”。`);
      }
      const selectedEstimate = modelEstimate(selected, brief.models?.[selected.id]);
      if (selectedEstimate === undefined) {
        throw new StudioInputError(`“${selected.label}”尚未配置估价，不能进入预算计算。`);
      }
      if (selected.billingUnit === "run") {
        fixedMeteredEstimateCny = roundMoney(fixedMeteredEstimateCny + selectedEstimate);
        continue;
      }
      if (brief.economics.maxPaidShots < 1) {
        throw new StudioInputError(`“${selected.label}”按镜头计费，但本次没有设置付费镜头额度。`);
      }
      const estimatedCost = roundMoney(selectedEstimate * brief.economics.maxPaidShots);
      if (estimatedCost > brief.economics.maxCostCny) {
        throw new StudioInputError(`“${selected.label}”预计需要 ¥${estimatedCost}，超过本次预计成本上限 ¥${brief.economics.maxCostCny}。`);
      }
    }
    if (brief.director) {
      let hasMeteredSource = false;
      let hasFreeSource = false;
      for (const id of brief.director.assetProviderIds) {
        const selected = providers.find((provider) => provider.capability === "asset.prepare" && provider.id === id);
        if (!selected) throw new StudioInputError(`导演素材池中没有找到“${id}”。`);
        if (!selected.available) throw new StudioInputError(`导演素材池中的“${selected.label}”当前不可用。`);
        if (selected.kind === "test" || selected.id === "ai-shot-router-v1") {
          throw new StudioInputError(`“${selected.label}”不能作为导演的镜头素材来源。`);
        }
        if (selected.billing === "metered") {
          hasMeteredSource = true;
          if (!brief.economics.allowMeteredProviders) {
            throw new StudioInputError(`当前成本策略未允许使用“${selected.label}”。`);
          }
          const selectedEstimate = modelEstimate(selected, brief.models?.[selected.id]);
          if (!selectedEstimate || selectedEstimate > brief.economics.maxCostCny) {
            throw new StudioInputError(`“${selected.label}”的单镜估价超过本次成本上限。`);
          }
        } else {
          hasFreeSource = true;
        }
      }
      if (hasMeteredSource && !hasFreeSource) {
        throw new StudioInputError("使用付费镜头时，导演素材池必须至少保留一个免费素材来源作为其余镜头与失败回退的保底。");
      }
    }
    const estimatedRunCeiling = roundMoney(brief.economics.maxCostCny + fixedMeteredEstimateCny);
    if (estimatedRunCeiling > maxRunCostCny) {
      throw new StudioInputError(`本次镜头预算与按次能力预计合计 ¥${estimatedRunCeiling}，超过服务端安全上限 ¥${maxRunCostCny}。`);
    }
  }

  private publish(run: StudioRunDetail): void {
    for (const listener of this.listeners.get(run.id) ?? []) listener(structuredClone(run));
  }
}

async function prepareCandidateInventoryRevision(
  runRoot: string,
  reference: Record<string, unknown>,
  publicDocument: unknown,
  revisionId: string,
): Promise<{ destination: string; content: string }> {
  const inventoryPath = reference.candidateInventoryPath;
  if (typeof inventoryPath !== "string") {
    throw new StudioInputError("候选素材缺少私有下载清单，请重新生成候选素材后再编辑。");
  }
  await assertContainedFile(runRoot, inventoryPath);
  let inventoryDocument: unknown;
  try {
    inventoryDocument = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    throw new StudioInputError("候选素材的私有下载清单无法读取，请重新生成候选素材。");
  }
  const publicReport = candidateReport(publicDocument, "候选素材清单");
  const privateInventory = candidateReport(inventoryDocument, "候选素材私有清单");
  if (privateInventory.version !== "video-factory/asset-candidate-inventory-v1") {
    throw new StudioInputError("候选素材私有清单版本不受支持，请重新生成候选素材。");
  }
  const privateScenes = sceneCandidateMap(privateInventory.scene_candidates, "候选素材私有清单");
  const publicScenes = sceneCandidateMap(publicReport.scene_candidates, "候选素材清单");
  if (publicScenes.size !== privateScenes.size || [...privateScenes.keys()].some((position) => !publicScenes.has(position))) {
    throw new StudioInputError("人工修订必须保留原有的全部场景；可以删除或重排每个场景内的候选素材。");
  }

  const sceneCandidates = publicReport.scene_candidates.map((publicScene, sceneIndex) => {
    const scenePosition = candidateScenePosition(publicScene, `候选素材清单第 ${sceneIndex + 1} 个场景`);
    const privateScene = privateScenes.get(scenePosition)!;
    const privateCandidates = candidateArray(privateScene.candidates, `场景 ${scenePosition} 的私有候选素材`);
    const indexed = new Map<string, Record<string, unknown>>();
    for (const [candidateIndex, candidate] of privateCandidates.entries()) {
      const key = candidateIdentity(candidate, `场景 ${scenePosition} 的私有候选素材 ${candidateIndex + 1}`);
      if (indexed.has(key)) throw new StudioInputError(`场景 ${scenePosition} 的私有候选素材存在重复身份。`);
      indexed.set(key, candidate);
    }
    const selected = candidateArray(publicScene.candidates, `场景 ${scenePosition} 的候选素材`).map((candidate, candidateIndex) => {
      const key = candidateIdentity(candidate, `场景 ${scenePosition} 的候选素材 ${candidateIndex + 1}`);
      const match = indexed.get(key);
      if (!match) throw new StudioInputError(`场景 ${scenePosition} 包含不属于原候选池的素材，不能写入私有下载清单。`);
      assertCandidateSourceFieldsUnchanged(candidate, match, `场景 ${scenePosition} 的候选素材 ${candidateIndex + 1}`);
      indexed.delete(key);
      return structuredClone(match);
    });
    return { scene_position: scenePosition, candidates: selected };
  });
  const revisedInventory = { ...privateInventory, scene_candidates: sceneCandidates };
  return {
    destination: path.join(runRoot, "nodes", "asset-candidates", "human-revisions", `${revisionId}.inventory.private.json`),
    content: `${JSON.stringify(revisedInventory, null, 2)}\n`,
  };
}

function candidateReport(value: unknown, label: string): Record<string, unknown> & { version: string; scene_candidates: Record<string, unknown>[] } {
  if (!isRecord(value) || typeof value.version !== "string" || !Array.isArray(value.scene_candidates)) {
    throw new StudioInputError(`${label}格式不正确。`);
  }
  return { ...value, version: value.version, scene_candidates: candidateArray(value.scene_candidates, label) };
}

function sceneCandidateMap(scenes: Record<string, unknown>[], label: string): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const [index, scene] of scenes.entries()) {
    const position = candidateScenePosition(scene, `${label}第 ${index + 1} 个场景`);
    if (result.has(position)) throw new StudioInputError(`${label}包含重复场景 ${position}。`);
    result.set(position, scene);
  }
  return result;
}

function candidateScenePosition(scene: Record<string, unknown>, label: string): number {
  if (!Number.isInteger(scene.scene_position) || Number(scene.scene_position) < 1) {
    throw new StudioInputError(`${label}缺少有效场景编号。`);
  }
  return Number(scene.scene_position);
}

function candidateArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((candidate) => !isRecord(candidate))) {
    throw new StudioInputError(`${label}格式不正确。`);
  }
  return value as Record<string, unknown>[];
}

function candidateIdentity(candidate: Record<string, unknown>, label: string): string {
  const provider = typeof candidate.provider_id === "string" && candidate.provider_id.trim()
    ? candidate.provider_id.trim()
    : typeof candidate.provider === "string" ? candidate.provider.trim() : "";
  const assetId = typeof candidate.asset_id === "string" ? candidate.asset_id.trim() : "";
  if (!provider || !assetId) throw new StudioInputError(`${label}缺少素材来源或素材编号。`);
  return `${provider}\u0000${assetId}`;
}

const IMMUTABLE_CANDIDATE_FIELDS = [
  "provider",
  "provider_id",
  "asset_id",
  "media_type",
  "width",
  "height",
  "duration",
  "preview_url",
  "source_url",
  "creator",
  "license_note",
] as const;

function assertCandidateSourceFieldsUnchanged(
  candidate: Record<string, unknown>,
  original: Record<string, unknown>,
  label: string,
): void {
  for (const field of IMMUTABLE_CANDIDATE_FIELDS) {
    if (!Object.is(candidate[field], original[field])) {
      throw new StudioInputError(`${label}的来源字段 ${field} 不能修改；可以删除、重排素材，或调整查询和评分。`);
    }
  }
}

function applyTemplateModelDefaults(
  brief: ProductionBrief,
  templateDefaults: Record<string, string> | undefined,
): ProductionBrief {
  if (!templateDefaults || Object.keys(templateDefaults).length === 0) return brief;
  const models = { ...(brief.models ?? {}) };
  const sources = { ...(brief.modelSelectionSources ?? {}) };
  const selectedProviders = new Set([
    ...Object.values(brief.providers).filter((value): value is string => typeof value === "string"),
    ...(brief.director?.assetProviderIds ?? []),
  ]);
  for (const [providerId, modelId] of Object.entries(templateDefaults)) {
    if (!selectedProviders.has(providerId)) continue;
    if (sources[providerId] === "run_override" || sources[providerId] === "node_override") continue;
    models[providerId] = modelId;
    sources[providerId] = "template_default";
  }
  return { ...brief, models, modelSelectionSources: sources };
}

function modelEstimate(provider: StudioProvider, modelId: string | undefined): number | undefined {
  if (!modelId) return provider.estimatedCnyPerClip;
  return provider.modelProfiles?.find((model) => model.id === modelId)?.estimatedCnyPerClip;
}

interface StartRecord {
  version: 1;
  state: "pending" | "completed";
  digest: string;
  response?: StartRunResponse;
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(idempotencyKey)) {
    throw new StudioInputError("制作请求编号格式不正确。");
  }
}

function startRecordPath(workspaceRoot: string, idempotencyKey: string): string {
  return path.join(workspaceRoot, "idempotency", "production-start", `${idempotencyKey}.json`);
}

function startRequestDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input) ?? "undefined").digest("hex");
}

async function readStartRecord(recordPath: string): Promise<StartRecord> {
  try {
    const value = JSON.parse(await readFile(recordPath, "utf8")) as StartRecord;
    if (value.version !== 1 || (value.state !== "pending" && value.state !== "completed") || !value.digest) throw new Error();
    return value;
  } catch {
    throw new StudioConflictError("制作幂等记录无法读取；为避免重复扣费，请先检查制作记录。");
  }
}

async function writeStartRecord(recordPath: string, record: StartRecord): Promise<void> {
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, "utf8");
  await rename(temporaryPath, recordPath);
}

function toRunSummary(run: WorkflowRun<ProductionBrief>): StudioRunSummary {
  const currentNodeId = run.nodeRuns.at(-1)?.nodeId ?? "brief";
  const videoArtifact = effectiveNodeArtifact(run, "render", (artifact) =>
    artifact.kind === "render" && artifact.contentType === "video/mp4")
    ?? [...run.artifacts].reverse().find((artifact) =>
      artifact.producer?.nodeId === "render" && artifact.contentType === "video/mp4");
  return {
    id: run.id,
    title: run.initialInput.title,
    status: run.status,
    platform: run.initialInput.platform,
    durationSeconds: run.initialInput.durationSeconds,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    currentNodeId,
    ...(run.status === "needs_human"
      ? { nextAction: "review" as const }
      : run.status === "awaiting_spend_approval" || run.status === "approval_invalidated"
        ? { nextAction: "confirm_spend" as const }
        : run.status === "stale"
          ? { nextAction: "regenerate" as const }
          : {}),
    ...(videoArtifact?.uri ? { videoContentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(videoArtifact.id)}/content` } : {}),
  };
}

function toRunDetail(run: WorkflowRun<ProductionBrief>): StudioRunDetail {
  const artifacts = run.artifacts.map((artifact): StudioArtifact => ({
    id: artifact.id,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    ...(artifact.schemaVersion ? { schemaVersion: artifact.schemaVersion } : {}),
    ...(artifact.producer ? { producerNodeId: artifact.producer.nodeId } : {}),
    ...(artifact.provenance.providerId ? { providerId: artifact.provenance.providerId } : {}),
    ...(artifact.provenance.licenseNote ? { licenseNote: artifact.provenance.licenseNote } : {}),
    ...(artifact.uri && !isPrivateArtifactKind(artifact.kind) ? { contentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}/content` } : {}),
  }));
  const nodeRuns = new Map(run.nodeRuns.map((node) => [node.nodeId, node]));
  const executionPlans = new Map((run.executionPlan ?? []).map((plan) => [plan.nodeId, plan]));
  const workflowNodes = run.initialInput.director
    ? WORKFLOW_NODES
    : WORKFLOW_NODES.filter((item) => item.id !== "visual-direction");
  const semanticNodes = run.initialInput.workflowFeatures?.assetSemanticRank
    ? workflowNodes
    : workflowNodes.filter((item) => item.id !== "asset-candidates" && item.id !== "asset-semantic-rank");
  const referenceNodes = run.initialInput.workflowFeatures?.referenceGrammar
    ? semanticNodes
    : semanticNodes.filter((item) => item.id !== "reference-grammar");
  const visibleNodes = run.initialInput.providers.visualReview
    ? referenceNodes
    : referenceNodes.filter((item) => item.id !== "visual-review");
  const nodes = visibleNodes.map(({ id, label, role }): StudioNode => {
    const node = nodeRuns.get(id);
    const plannedExecution = executionPlans.get(id);
    const safeExecutionReceipt = node?.executionReceipt
      ? redactManagedFileReferences(node.executionReceipt) as NonNullable<StudioNode["executionReceipt"]>
      : undefined;
    const safePlannedExecution = plannedExecution
      ? redactManagedFileReferences(plannedExecution) as NonNullable<StudioNode["plannedExecution"]>
      : undefined;
    return {
      id,
      label,
      role: node?.role ?? role,
      status: node?.status ?? "pending",
      ...(node?.startedAt ? { startedAt: node.startedAt } : {}),
      ...(node?.finishedAt ? { finishedAt: node.finishedAt } : {}),
      ...(node?.error ? { error: redactManagedPathText(node.error) } : {}),
      artifactIds: [...(node?.artifactIds ?? [])],
      qualityGateResults: (node?.qualityGateResults ?? []).map((result) => ({
        gateId: result.gateId,
        status: result.status,
        reasons: result.reasons.map(redactManagedPathText),
      })),
      ...(node?.output !== undefined ? { output: redactManagedFileReferences(node.output) } : {}),
      ...(node?.inputState ? {
        inputState: {
          effectiveVersionId: node.inputState.effectiveVersionId,
          stale: node.inputState.stale,
          versions: node.inputState.versions.map((version) => ({
            id: version.id,
            source: version.source,
            value: redactManagedFileReferences(version.value),
            upstreamVersionIds: [...version.upstreamVersionIds],
            ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
            createdAt: version.createdAt,
            createdBy: version.createdBy,
            schemaVersion: version.schemaVersion,
          })),
        },
      } : {}),
      ...(node?.outputState ? {
        outputState: {
          generatedVersionId: node.outputState.generatedVersionId,
          effectiveVersionId: node.outputState.effectiveVersionId,
          stale: node.outputState.stale,
          versions: node.outputState.versions.map((version) => ({
            id: version.id,
            source: version.source,
            artifactIds: [...version.artifactIds],
            inputVersionIds: [...version.inputVersionIds],
            ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
            createdAt: version.createdAt,
            createdBy: version.createdBy,
            schemaVersion: version.schemaVersion,
            ...(version.output !== undefined ? { output: redactManagedFileReferences(version.output) } : {}),
          })),
        },
      } : {}),
      ...(safeExecutionReceipt ? { executionReceipt: safeExecutionReceipt } : {}),
      ...(safePlannedExecution ? {
        plannedExecution: {
          ...safePlannedExecution,
        },
      } : {}),
      ...(node?.spendPlan ? { spendPlan: { ...node.spendPlan, inputVersionIds: [...node.spendPlan.inputVersionIds] } } : {}),
      ...(node?.spendAuthorizationId ? { spendAuthorizationId: node.spendAuthorizationId } : {}),
    };
  });
  const active = run.nodeRuns.find((node) => node.status === "needs_human")?.intervention;
  const activeIntervention: StudioIntervention | undefined = active ? {
    id: active.id,
    nodeId: active.nodeId,
    reason: active.reason,
    options: [...(active.options ?? [active.requiredAction])],
    createdAt: active.createdAt,
  } : undefined;
  const decisions = run.decisions.map((decision): StudioDecision => ({
    id: decision.id,
    action: decision.action,
    actor: decision.actor,
    ...(decision.note ? { note: decision.note } : {}),
    createdAt: decision.createdAt,
  }));
  const videoArtifactId = effectiveNodeArtifact(run, "render", (artifact) =>
    artifact.kind === "render" && artifact.contentType === "video/mp4")?.id
    ?? [...run.artifacts].reverse().find((artifact) =>
      artifact.producer?.nodeId === "render" && artifact.contentType === "video/mp4")?.id;
  const publishPackageArtifactId = effectiveNodeArtifact(run, "publish-package", (artifact) =>
    artifact.kind === "publish_package")?.id
    ?? [...run.artifacts].reverse().find((artifact) => artifact.kind === "publish_package")?.id;
  return {
    ...toRunSummary(run),
    revision: run.revision,
    angle: run.initialInput.angle,
    audience: run.initialInput.audience,
    nicheSlug: run.initialInput.nicheSlug,
    reviewMode: run.initialInput.reviewMode,
    nodes,
    artifacts,
    decisions,
    ...(activeIntervention ? { activeIntervention } : {}),
    ...(videoArtifactId ? { videoArtifactId } : {}),
    ...(publishPackageArtifactId ? { publishPackageArtifactId } : {}),
  };
}

function effectiveNodeArtifact(
  run: WorkflowRun<ProductionBrief>,
  nodeId: string,
  matches: (artifact: WorkflowRun<ProductionBrief>["artifacts"][number]) => boolean,
): WorkflowRun<ProductionBrief>["artifacts"][number] | undefined {
  const node = run.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
  const effectiveVersion = node?.outputState?.versions.find(
    (version) => version.id === node.outputState?.effectiveVersionId,
  );
  const artifactIds = effectiveVersion?.artifactIds ?? node?.artifactIds ?? [];
  for (const artifactId of [...artifactIds].reverse()) {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (artifact && matches(artifact)) return artifact;
  }
  return undefined;
}

function parseBriefWithInputError(value: unknown): ProductionBrief {
  try {
    return parseBrief(value);
  } catch (error) {
    throw new StudioInputError(productionInputMessage(error));
  }
}

function productionInputMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("voiceDirection.profileId") && message.includes("providers.voice")) {
    return "所选音色与配音能力不一致，请重新选择音色。";
  }
  if (message.includes("durationSeconds")) return "成片时长必须是 20 到 180 秒之间的整数。";
  if (message.includes("reviewMode")) return "人工终审设置无效。";
  if (message.includes("protocolVersion")) return "制作参数版本不受支持，请刷新页面后重试。";
  if (/\b(title|angle|audience|nicheSlug|platform)\b/.test(message)) return "请完整填写标题、内容角度、目标受众、系列标识和平台。";
  if (message.includes("providers")) return "制作能力配置不完整，请重新选择制作配方。";
  if (message.includes("economics")) return "预计成本和付费镜头设置不符合要求。";
  if (message.includes("voiceDirection")) return "配音设置不符合要求，请重新选择音色。";
  return "制作参数不符合要求，请检查后重试。";
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isTerminalRun(status: WorkflowRun<ProductionBrief>["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "rejected";
}

function isPrivateArtifactKind(kind: string): boolean {
  return kind === "reference_video" || kind === "candidate_inventory_private";
}

function redactManagedFileReferences(value: unknown): unknown {
  if (typeof value === "string") {
    return redactManagedPathText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactManagedFileReferences(item));
  if (!isRecord(value)) return structuredClone(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactManagedFileReferences(item)]),
  );
}

function redactManagedPathText(value: string): string {
  if (isAbsoluteFilePath(value)) return MANAGED_FILE_PLACEHOLDER;
  return value
    .replace(
      /(^|[\s"'`(=])\/(?:Users|home|var|tmp|private|opt|srv|etc|run|root|mnt|Volumes)(?:\/[^\s"'`<>),;\]}]+)+/g,
      `$1${MANAGED_FILE_PLACEHOLDER}`,
    )
    .replace(/(^|[\s"'`(=])[A-Za-z]:\\[^\s"'`<>),;\]}]+/g, `$1${MANAGED_FILE_PLACEHOLDER}`);
}

function restoreManagedFileReferences(value: unknown, reference: unknown): unknown {
  if (value === MANAGED_FILE_PLACEHOLDER) {
    return typeof reference === "string" && isAbsoluteFilePath(reference)
      ? reference
      : value;
  }
  if (Array.isArray(value)) {
    const referenceItems = Array.isArray(reference) ? reference : [];
    return value.map((item, index) => restoreManagedFileReferences(item, referenceItems[index]));
  }
  if (!isRecord(value)) return structuredClone(value);
  const referenceRecord = isRecord(reference) ? reference : {};
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, restoreManagedFileReferences(item, referenceRecord[key])]),
  );
}

function isAbsoluteFilePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

async function assertContainedFile(runRoot: string, candidate: string): Promise<void> {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(runRoot), realpath(candidate)]);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StudioInputError("所选产物不属于当前制作目录。");
  }
  if (!(await stat(resolvedCandidate)).isFile()) throw new StudioInputError("所选产物不是可编辑文件。");
}

async function prepareAuthorizedRunFileArtifacts(options: {
  nodeId: string;
  actor: string;
  runRoot: string;
  referenceDocument: unknown;
  nextDocument: unknown;
  authorizedRunFiles: string[];
  parentArtifactId: string;
  attempt: number;
}): Promise<ArtifactDraft[]> {
  if (options.authorizedRunFiles.length === 0) return [];
  if (options.nodeId !== "assets") {
    throw new StudioInputError("只有逐镜素材节点可以登记人工替换媒体。");
  }
  const authorized = new Set(options.authorizedRunFiles.map((candidate) => path.resolve(candidate)));
  const previous = collectManagedFileReferences(options.referenceDocument);
  const next = collectManagedFileReferences(options.nextDocument);
  const changed = new Set<string>();
  for (const [field, nextPath] of next) {
    if (previous.get(field) !== nextPath) changed.add(path.resolve(nextPath));
  }
  if (changed.size === 0) throw new StudioInputError("人工替换文件清单没有对应到任何已修改的素材路径。");
  for (const candidate of changed) {
    if (!authorized.has(candidate)) throw new StudioInputError("每个改指的素材文件都必须登记为人工替换文件。");
  }
  for (const candidate of authorized) {
    if (!changed.has(candidate)) throw new StudioInputError("人工替换文件必须被当前素材计划引用。");
    await assertContainedFile(options.runRoot, candidate);
  }
  return Promise.all([...authorized].map(async (candidate) => {
    const content = await readFile(candidate);
    return {
      kind: "human_media_revision",
      uri: candidate,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
      contentType: mediaContentType(candidate),
      schemaVersion: "video-factory/human-media-revision-v1",
      parentArtifactIds: [options.parentArtifactId],
      producer: { nodeId: options.nodeId, attempt: options.attempt },
      provenance: {
        providerId: "human-editor",
        providerVersion: "1",
        creator: options.actor,
        licenseNote: "Human-selected media retained with immutable bytes and run-local provenance.",
      },
    } satisfies ArtifactDraft;
  }));
}

function collectManagedFileReferences(value: unknown, field = "output", result = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectManagedFileReferences(item, `${field}[${index}]`, result));
    return result;
  }
  if (!isRecord(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const childField = `${field}.${key}`;
    if (isManagedFileReferenceKey(key) && typeof child === "string" && child) result.set(childField, child);
    else collectManagedFileReferences(child, childField, result);
  }
  return result;
}

function isManagedFileReferenceKey(key: string): boolean {
  return key === "uri"
    || key.endsWith("Path")
    || key.endsWith("Root")
    || key.endsWith("_path")
    || key.endsWith("_root")
    || key.endsWith("_file");
}

function mediaContentType(candidate: string): string {
  switch (path.extname(candidate).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    default: return "application/octet-stream";
  }
}

async function writePrivateTextAtomically(destination: string, content: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
