import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  StudioInputError,
  type StudioPublishBatch,
  type StudioPublishCheck,
  type StudioPublishDelivery,
  type StudioPublishInput,
  type StudioPublishPlatformId,
  type StudioPublishReadiness,
  type StudioPublishTarget,
  type StudioRunDetail,
} from "../shared/api.js";
import { StudioNotFoundError } from "./studio-errors.js";

export interface PlatformPublishRequest {
  platformId: StudioPublishPlatformId;
  run: StudioRunDetail;
  idempotencyKey: string;
}

export interface PlatformPublishReceipt {
  externalId: string;
  reviewStatus: string;
}

export interface PlatformPublisher {
  target: StudioPublishTarget;
  publish(request: PlatformPublishRequest): Promise<PlatformPublishReceipt>;
}

export interface PublishingStudioOptions {
  workspaceRoot: string;
  getRun: (runId: string) => Promise<StudioRunDetail | undefined>;
  loadPublishPackage: (run: StudioRunDetail) => Promise<unknown>;
  loadEffectiveResourceReviewCount?: (runId: string) => Promise<number | undefined>;
  withRunLease?: <T>(runId: string, action: () => Promise<T>) => Promise<T>;
  publishers?: PlatformPublisher[];
  targets?: StudioPublishTarget[];
  now?: () => Date;
}

export class PublishingStudio {
  private readonly publishers: Map<StudioPublishPlatformId, PlatformPublisher>;
  private readonly targets: StudioPublishTarget[];
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, { digest: string; operation: Promise<StudioPublishBatch> }>();

  constructor(private readonly options: PublishingStudioOptions) {
    this.publishers = new Map((options.publishers ?? []).map((publisher) => [publisher.target.id, publisher]));
    const targets = new Map((options.targets ?? []).map((target) => [target.id, target]));
    for (const publisher of options.publishers ?? []) targets.set(publisher.target.id, publisher.target);
    this.targets = [...targets.values()];
    this.now = options.now ?? (() => new Date());
  }

  listTargets(): StudioPublishTarget[] {
    return this.targets.map((target) => ({ ...target }));
  }

  async readiness(runId: string): Promise<StudioPublishReadiness> {
    const run = await this.requiredRun(runId);
    const publishPackage = await this.options.loadPublishPackage(run);
    const effectiveResourceReviewCount = this.options.loadEffectiveResourceReviewCount
      ? await this.options.loadEffectiveResourceReviewCount(runId)
      : undefined;
    const checks = complianceChecks(run, publishPackage, effectiveResourceReviewCount);
    return {
      runId,
      ready: !checks.some((check) => check.status === "blocked"),
      title: run.title,
      targets: this.listTargets(),
      checks,
    };
  }

  async publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.requestId)) {
      throw new StudioInputError("发布请求编号格式不正确。");
    }
    const key = `${runId}:${input.requestId}`;
    const digest = publishRequestDigest(runId, input);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.digest !== digest) throw new StudioInputError("这个发布请求编号已经绑定到另一组平台或确认内容，请重新生成请求编号。");
      return existing.operation;
    }
    const operation = this.publishOnce(runId, input).finally(() => {
      if (this.inFlight.get(key)?.operation === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { digest, operation });
    return operation;
  }

  private async publishOnce(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    const withRunLease = this.options.withRunLease ?? (async <T>(_runId: string, action: () => Promise<T>) => action());
    return withRunLease(runId, () => this.publishUnderLease(runId, input));
  }

  private async publishUnderLease(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    const run = await this.requiredRun(runId);
    const snapshotDigest = publishRequestDigest(runId, input, run);
    const readiness = await this.readiness(runId);
    const blocker = readiness.checks.find((check) => check.status === "blocked");
    if (blocker) throw new StudioInputError(blocker.detail);
    if (Object.values(input.confirmations).some((confirmed) => !confirmed)) {
      throw new StudioInputError("请完成全部发布合规确认后再发送。");
    }
    const selected = input.platformIds.map((platformId) => {
      const target = this.targets.find((candidate) => candidate.id === platformId);
      if (!target) throw new StudioInputError(`发布平台“${platformId}”尚未接入。`);
      return target;
    });
    const directory = path.join(this.options.workspaceRoot, "runs", runId, "publishing");
    const batchPath = path.join(directory, `${input.requestId}.json`);
    const journalPath = path.join(directory, `${input.requestId}.journal.json`);
    const journal = await readPublishJournal(journalPath);
    if (journal && (journal.runId !== runId || journal.requestId !== input.requestId || journal.requestDigest !== snapshotDigest)) {
      throw new StudioInputError("这个发布请求编号已经绑定到另一组平台或确认内容，请重新生成请求编号。");
    }
    const existing = await readBatch(batchPath);
    if (journal?.state === "completed") {
      if (!existing) throw new StudioInputError("发布回执索引不完整，请先人工核验各平台结果，系统不会自动重投。");
      return existing;
    }
    if (!journal && existing) {
      throw new StudioInputError("历史发布回执缺少成片版本绑定，请先人工核验平台结果并新建发布请求，系统不会自动重投。");
    }
    if (journal?.inProgressPlatformId) {
      throw new StudioInputError(`上次向“${journal.inProgressPlatformId}”发送时进程中断，平台结果不确定；请先到平台核验，系统不会自动重投。`);
    }

    await mkdir(directory, { recursive: true });
    const progress: PublishJournal = journal ?? {
      version: "video-factory/publish-journal-v1",
      runId,
      requestId: input.requestId,
      requestDigest: snapshotDigest,
      state: "running",
      createdAt: this.now().toISOString(),
      deliveries: [],
    };
    if (!journal) await writePublishJournal(journalPath, progress);
    const deliveries = [...progress.deliveries];
    for (const target of selected) {
      if (deliveries.some((delivery) => delivery.platformId === target.id)) continue;
      if (target.status === "manual_only") {
        deliveries.push({ platformId: target.id, status: "export_ready", detail: "已准备平台发布包，需要在平台内人工上传。" });
        progress.deliveries = [...deliveries];
        await writePublishJournal(journalPath, progress);
        continue;
      }
      const publisher = this.publishers.get(target.id);
      if (target.status !== "ready" || !publisher) {
        deliveries.push({ platformId: target.id, status: "needs_config", detail: target.requirement ?? "需要完成官方应用与账号授权。" });
        progress.deliveries = [...deliveries];
        await writePublishJournal(journalPath, progress);
        continue;
      }
      progress.inProgressPlatformId = target.id;
      await writePublishJournal(journalPath, progress);
      try {
        const receipt = await publisher.publish({
          platformId: target.id,
          run,
          idempotencyKey: `${run.id}:${target.id}:${input.requestId}`,
        });
        deliveries.push({
          platformId: target.id,
          status: "submitted",
          externalId: receipt.externalId,
          reviewStatus: receipt.reviewStatus,
        });
      } catch {
        deliveries.push({
          platformId: target.id,
          status: "failed",
          detail: "平台请求未取得确定回执；成功平台不会重复发送，请先到平台核验后再新建请求。",
        });
      }
      delete progress.inProgressPlatformId;
      progress.deliveries = [...deliveries];
      await writePublishJournal(journalPath, progress);
    }
    const successful = deliveries.filter((delivery) => delivery.status === "submitted" || delivery.status === "export_ready").length;
    const status: StudioPublishBatch["status"] = successful === deliveries.length
      ? "succeeded"
      : successful > 0
        ? "partial"
        : "failed";
    const batch: StudioPublishBatch = {
      id: input.requestId,
      runId,
      status,
      createdAt: progress.createdAt,
      deliveries,
    };
    await writeBatch(batchPath, batch);
    progress.state = "completed";
    await writePublishJournal(journalPath, progress);
    return batch;
  }

  private async requiredRun(runId: string): Promise<StudioRunDetail> {
    const run = await this.options.getRun(runId);
    if (!run) throw new StudioNotFoundError("没有找到这条制作记录。");
    return run;
  }
}

export function buildPublishTargetCatalog(): StudioPublishTarget[] {
  return [
    {
      id: "douyin",
      label: "抖音",
      mode: "export_package",
      status: "manual_only",
      requirement: "当前为个人主体，不满足抖音 H5/SDK 投稿能力的企业准入条件；先导出发布包，再由本人在抖音内确认发布。",
      docsUrl: "https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/useclue",
    },
    {
      id: "toutiao",
      label: "今日头条",
      mode: "official_api",
      status: "planned",
      requirement: "需要申请 toutiao.video.create 权限并完成账号 OAuth 授权。",
      docsUrl: "https://open.douyin.com/platform/resource/docs/openapi/video-management/toutiao/create-video/publish-video",
    },
    {
      id: "kuaishou",
      label: "快手",
      mode: "official_api",
      status: "planned",
      requirement: "需要快手开放平台应用、USER_VIDEO_PUBLISH 权限与账号 OAuth 授权。",
      docsUrl: "https://open.kuaishou.com/platform/openApi?menu=20",
    },
    {
      id: "bilibili",
      label: "哔哩哔哩",
      mode: "official_api",
      status: "planned",
      requirement: "需要完成哔哩哔哩开放平台身份认证、应用审核与账号授权。",
      docsUrl: "https://openhome.bilibili.com/doc",
    },
    {
      id: "xiaohongshu",
      label: "小红书",
      mode: "export_package",
      status: "manual_only",
      requirement: "尚未核验到面向普通创作者的公开通用笔记发布 API，当前仅导出平台包。",
    },
  ];
}

function complianceChecks(run: StudioRunDetail, publishPackage: unknown, effectiveResourceReviewCount?: number): StudioPublishCheck[] {
  const checks: StudioPublishCheck[] = [];
  const humanApproved = run.decisions.some((decision) => decision.action === "approve");
  checks.push(run.status === "succeeded" && Boolean(run.publishPackageArtifactId) && humanApproved
    ? { id: "approval", label: "终审与发布包", status: "passed", detail: "已通过人工终审并生成发布包。" }
    : { id: "approval", label: "终审与发布包", status: "blocked", detail: "成片必须先通过人工批准并生成发布包。" });
  checks.push(run.videoArtifactId
    ? { id: "video", label: "成片文件", status: "passed", detail: "已找到最终成片。" }
    : { id: "video", label: "成片文件", status: "blocked", detail: "没有找到可发布的最终视频。" });
  const aigc = publishPackage && typeof publishPackage === "object"
    ? (publishPackage as { aigc?: { explicitLabelChecked?: unknown; implicitMetadataWritten?: unknown } }).aigc
    : undefined;
  checks.push(aigc?.explicitLabelChecked === true && aigc.implicitMetadataWritten === true
    ? { id: "aigc-file", label: "文件 AI 标识", status: "passed", detail: "成片已写入开场显式标识和生成来源 metadata。" }
    : { id: "aigc-file", label: "文件 AI 标识", status: "blocked", detail: "发布包未证明成片包含显式与隐式 AI 标识，请重新生成或人工补齐后再发布。" });
  const packageArtifacts = publishPackageArtifacts(publishPackage);
  const currentVideoBound = Boolean(
    run.videoArtifactId
    && packageArtifacts?.some((artifact) => artifact.id === run.videoArtifactId && artifact.kind === "render"),
  );
  checks.push(currentVideoBound
    ? { id: "video-binding", label: "成片版本绑定", status: "passed", detail: "发布包绑定的是当前成片版本。" }
    : { id: "video-binding", label: "成片版本绑定", status: "blocked", detail: "发布包没有绑定当前成片版本；请重新生成发布包并终审，避免误发旧版本。" });
  const resourceReview = publishPackageResourceReview(publishPackage);
  const humanReplacements = packageArtifacts?.filter((artifact) => artifact.kind === "human_media_revision") ?? [];
  const unlicensed = packageArtifacts?.filter((artifact) =>
    (artifact.kind === "media_asset" || artifact.kind === "human_media_revision")
    && !artifact.licenseNote,
  ) ?? [];
  checks.push(!packageArtifacts
    ? { id: "rights", label: "素材授权记录", status: "blocked", detail: "当前发布包缺少素材快照，无法确认使用的是哪一版素材，请重新生成发布包。" }
    : !resourceReview
      ? { id: "rights", label: "素材授权记录", status: "blocked", detail: "当前发布包缺少结构化授权检查结果，请重新生成发布包。" }
    : effectiveResourceReviewCount !== undefined && effectiveResourceReviewCount > 0
      ? { id: "rights", label: "素材授权记录", status: "blocked", detail: `${effectiveResourceReviewCount} 项当前资源仍标记为待授权复核，不能发布。` }
    : effectiveResourceReviewCount === 0
      ? { id: "rights", label: "素材授权记录", status: "passed", detail: "当前入片素材均已记录来源或通过人工授权核对。" }
    : effectiveResourceReviewCount === undefined && humanReplacements.length > 0
      ? { id: "rights", label: "素材授权记录", status: "blocked", detail: `${humanReplacements.length} 个人工替换素材仍需确认版权、肖像与商用范围，确认机制完成前不能发布。` }
    : effectiveResourceReviewCount === undefined && resourceReview.needsReviewCount > 0
      ? { id: "rights", label: "素材授权记录", status: "blocked", detail: `${resourceReview.needsReviewCount} 项当前资源仍标记为待授权复核，不能发布。` }
    : unlicensed.length === 0
      ? { id: "rights", label: "素材授权记录", status: "passed", detail: "当前发布包内的素材均保留授权或来源说明。" }
      : { id: "rights", label: "素材授权记录", status: "blocked", detail: `${unlicensed.length} 个当前画面素材缺少授权记录，不能发布。` });
  checks.push({ id: "aigc", label: "平台 AI 声明", status: "requires_confirmation", detail: "文件标识不能替代平台声明；发布时仍须主动选择 AI 生成或辅助生成。" });
  checks.push({ id: "facts", label: "事实与敏感领域", status: "requires_confirmation", detail: "确认事实来源、时效和医疗/金融/法律等高风险内容已人工复核。" });
  checks.push({ id: "commercial", label: "商业与广告", status: "requires_confirmation", detail: "如含商业推广，确认已按平台与广告规则明确标识。" });
  return checks;
}

function publishPackageResourceReview(value: unknown): { needsReviewCount: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const resourceManifest = (value as { resourceManifest?: unknown }).resourceManifest;
  if (!resourceManifest || typeof resourceManifest !== "object" || Array.isArray(resourceManifest)) return undefined;
  const needsReviewCount = (resourceManifest as { needsReviewCount?: unknown }).needsReviewCount;
  if (!Number.isInteger(needsReviewCount) || Number(needsReviewCount) < 0) return undefined;
  return { needsReviewCount: Number(needsReviewCount) };
}

function publishPackageArtifacts(value: unknown): Array<{ id?: string; kind: string; licenseNote?: string }> | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { artifacts?: unknown }).artifacts)) return undefined;
  return (value as { artifacts: unknown[] }).artifacts.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const artifact = candidate as { id?: unknown; kind?: unknown; provenance?: unknown };
    if (typeof artifact.kind !== "string") return [];
    const provenance = artifact.provenance && typeof artifact.provenance === "object"
      ? artifact.provenance as { licenseNote?: unknown }
      : undefined;
    return [{
      ...(typeof artifact.id === "string" && artifact.id ? { id: artifact.id } : {}),
      kind: artifact.kind,
      ...(typeof provenance?.licenseNote === "string" && provenance.licenseNote ? { licenseNote: provenance.licenseNote } : {}),
    }];
  });
}

interface PublishJournal {
  version: "video-factory/publish-journal-v1";
  runId: string;
  requestId: string;
  requestDigest: string;
  state: "running" | "completed";
  createdAt: string;
  deliveries: StudioPublishDelivery[];
  inProgressPlatformId?: StudioPublishPlatformId;
}

function publishRequestDigest(runId: string, input: StudioPublishInput, run?: StudioRunDetail): string {
  return createHash("sha256").update(JSON.stringify({
    runId,
    platformIds: input.platformIds,
    confirmations: input.confirmations,
    ...(run ? {
      revision: run.revision,
      videoArtifactId: run.videoArtifactId,
      publishPackageArtifactId: run.publishPackageArtifactId,
    } : {}),
  })).digest("hex");
}

async function readPublishJournal(journalPath: string): Promise<PublishJournal | undefined> {
  try {
    const value = JSON.parse(await readFile(journalPath, "utf8")) as Partial<PublishJournal>;
    if (value.version !== "video-factory/publish-journal-v1"
      || typeof value.runId !== "string"
      || typeof value.requestId !== "string"
      || typeof value.requestDigest !== "string"
      || (value.state !== "running" && value.state !== "completed")
      || typeof value.createdAt !== "string"
      || !Array.isArray(value.deliveries)) {
      throw new Error("Publish journal is invalid.");
    }
    return value as PublishJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePublishJournal(journalPath: string, journal: PublishJournal): Promise<void> {
  await writeJsonAtomically(journalPath, journal);
}

async function readBatch(batchPath: string): Promise<StudioPublishBatch | undefined> {
  try {
    return JSON.parse(await readFile(batchPath, "utf8")) as StudioPublishBatch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeBatch(batchPath: string, batch: StudioPublishBatch): Promise<void> {
  await writeJsonAtomically(batchPath, batch);
}

async function writeJsonAtomically(destination: string, value: unknown): Promise<void> {
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
