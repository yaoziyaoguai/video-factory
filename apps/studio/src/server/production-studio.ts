import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowRun } from "@video-factory/workflow-core";
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
  type StudioProvider,
  type StudioRunDetail,
  type StudioRunSummary,
} from "../shared/api.js";
import { StudioConflictError, StudioNotFoundError } from "./studio-errors.js";

export interface StudioPipelinePort {
  list(): Promise<WorkflowRun<ProductionBrief>[]>;
  show(runId: string): Promise<WorkflowRun<ProductionBrief>>;
  dispatch(input: unknown, listener?: ProductionRunListener): Promise<DispatchedProductionRun>;
  decide(runId: string, decision: {
    interventionId: string;
    action: "approve" | "reject";
    actor: string;
    note?: string;
  }): Promise<WorkflowRun<ProductionBrief>>;
}

export interface ProductionStudioOptions {
  workspaceRoot: string;
  pipeline: StudioPipelinePort;
  listProviders: () => Promise<StudioProvider[]>;
  maxRunCostCny?: number;
}

const WORKFLOW_NODES: Array<{ id: string; label: string; role: string }> = [
  { id: "brief", label: "内容简报", role: "制片人" },
  { id: "script", label: "脚本", role: "编剧" },
  { id: "visual-direction", label: "导演方案", role: "导演" },
  { id: "assets", label: "画面", role: "素材导演" },
  { id: "voice", label: "配音", role: "声音导演" },
  { id: "render", label: "渲染", role: "剪辑师" },
  { id: "technical-review", label: "机器质检", role: "技术质检" },
  { id: "final-review", label: "人工终审", role: "总导演" },
  { id: "publish-package", label: "发布文案与发布包", role: "发行编辑" },
];

export class ProductionStudio {
  private readonly listeners = new Map<string, Set<(run: StudioRunDetail) => void>>();
  private readonly completions = new Set<Promise<void>>();
  private readonly startsInFlight = new Map<string, Promise<StartRunResponse>>();

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

  async start(input: unknown, idempotencyKey?: string): Promise<StartRunResponse> {
    const brief = parseBriefWithInputError(input);
    if (brief.reviewMode !== "manual") {
      throw new StudioInputError("正式制作必须经过人工终审，不能自动跳过发布前确认。");
    }
    const maxRunCostCny = this.options.maxRunCostCny ?? 20;
    if (brief.economics.maxCostCny > maxRunCostCny) {
      throw new StudioInputError(`本次成本上限不能超过服务端安全上限 ¥${maxRunCostCny}。`);
    }
    await this.assertProvidersAvailable(brief);
    if (!idempotencyKey) return this.dispatchBrief(brief);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(idempotencyKey)) {
      throw new StudioInputError("制作请求编号格式不正确。");
    }
    const existing = this.startsInFlight.get(idempotencyKey);
    if (existing) return existing;
    const operation = this.startIdempotently(brief, idempotencyKey).finally(() => {
      if (this.startsInFlight.get(idempotencyKey) === operation) this.startsInFlight.delete(idempotencyKey);
    });
    this.startsInFlight.set(idempotencyKey, operation);
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

  private async startIdempotently(brief: ProductionBrief, idempotencyKey: string): Promise<StartRunResponse> {
    const directory = path.join(this.options.workspaceRoot, "idempotency", "production-start");
    const recordPath = path.join(directory, `${idempotencyKey}.json`);
    const digest = createHash("sha256").update(JSON.stringify(brief)).digest("hex");
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

  async decide(runId: string, input: StudioDecisionInput): Promise<StudioRunDetail> {
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
        actor: input.actor,
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
    const run = await this.loadRequiredRun(runId);
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact?.uri) return undefined;
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

  private async assertProvidersAvailable(brief: ProductionBrief): Promise<void> {
    const providers = await this.options.listProviders();
    const bindings: Array<[string, string]> = [
      ["script.draft", brief.providers.script],
      ...(brief.director && brief.providers.director ? [["storyboard.plan", brief.providers.director] as [string, string]] : []),
      ["asset.prepare", brief.providers.assets],
      ["voice.synthesize", brief.providers.voice],
      ["video.render", brief.providers.render],
      ["quality.review", brief.providers.technicalReview],
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
      if (selected.estimatedCnyPerClip === undefined) {
        throw new StudioInputError(`“${selected.label}”尚未配置单镜头估价，不能进入预算计算。`);
      }
      const estimatedCost = roundMoney(selected.estimatedCnyPerClip * brief.economics.maxPaidShots);
      if (estimatedCost > brief.economics.maxCostCny) {
        throw new StudioInputError(`“${selected.label}”预计需要 ¥${estimatedCost}，超过本次预计成本上限 ¥${brief.economics.maxCostCny}。`);
      }
    }
    if (brief.director) {
      for (const id of brief.director.assetProviderIds) {
        const selected = providers.find((provider) => provider.capability === "asset.prepare" && provider.id === id);
        if (!selected) throw new StudioInputError(`导演素材池中没有找到“${id}”。`);
        if (!selected.available) throw new StudioInputError(`导演素材池中的“${selected.label}”当前不可用。`);
        if (selected.kind === "test" || selected.id === "ai-shot-router-v1") {
          throw new StudioInputError(`“${selected.label}”不能作为导演的镜头素材来源。`);
        }
        if (selected.billing === "metered") {
          if (!brief.economics.allowMeteredProviders) {
            throw new StudioInputError(`当前成本策略未允许使用“${selected.label}”。`);
          }
          if (!selected.estimatedCnyPerClip || selected.estimatedCnyPerClip > brief.economics.maxCostCny) {
            throw new StudioInputError(`“${selected.label}”的单镜估价超过本次成本上限。`);
          }
        }
      }
    }
  }

  private publish(run: StudioRunDetail): void {
    for (const listener of this.listeners.get(run.id) ?? []) listener(structuredClone(run));
  }
}

interface StartRecord {
  version: 1;
  state: "pending" | "completed";
  digest: string;
  response?: StartRunResponse;
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
  const videoArtifact = run.artifacts.find((artifact) => artifact.kind === "render" && artifact.contentType === "video/mp4")
    ?? run.artifacts.find((artifact) => artifact.producer?.nodeId === "render" && artifact.contentType === "video/mp4");
  return {
    id: run.id,
    title: run.initialInput.title,
    status: run.status,
    platform: run.initialInput.platform,
    durationSeconds: run.initialInput.durationSeconds,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    currentNodeId,
    ...(run.status === "needs_human" ? { nextAction: "review" as const } : {}),
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
    ...(artifact.uri ? { contentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}/content` } : {}),
  }));
  const nodeRuns = new Map(run.nodeRuns.map((node) => [node.nodeId, node]));
  const workflowNodes = run.initialInput.director
    ? WORKFLOW_NODES
    : WORKFLOW_NODES.filter((item) => item.id !== "visual-direction");
  const nodes = workflowNodes.map(({ id, label, role }): StudioNode => {
    const node = nodeRuns.get(id);
    return {
      id,
      label,
      role: node?.role ?? role,
      status: node?.status ?? "pending",
      ...(node?.startedAt ? { startedAt: node.startedAt } : {}),
      ...(node?.finishedAt ? { finishedAt: node.finishedAt } : {}),
      ...(node?.error ? { error: node.error } : {}),
      artifactIds: [...(node?.artifactIds ?? [])],
      qualityGateResults: (node?.qualityGateResults ?? []).map((result) => ({
        gateId: result.gateId,
        status: result.status,
        reasons: [...result.reasons],
      })),
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
  const videoArtifactId = run.artifacts.find((artifact) => artifact.kind === "render" && artifact.contentType === "video/mp4")?.id
    ?? run.artifacts.find((artifact) => artifact.producer?.nodeId === "render" && artifact.contentType === "video/mp4")?.id;
  const publishPackageArtifactId = run.artifacts.find((artifact) => artifact.kind === "publish_package")?.id;
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
