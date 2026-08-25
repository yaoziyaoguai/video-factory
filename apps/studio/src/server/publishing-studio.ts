import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  publishers?: PlatformPublisher[];
  targets?: StudioPublishTarget[];
  now?: () => Date;
}

export class PublishingStudio {
  private readonly publishers: Map<StudioPublishPlatformId, PlatformPublisher>;
  private readonly targets: StudioPublishTarget[];
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<StudioPublishBatch>>();

  constructor(private readonly options: PublishingStudioOptions) {
    this.publishers = new Map((options.publishers ?? []).map((publisher) => [publisher.target.id, publisher]));
    const targets = new Map((options.targets ?? []).map((target) => [target.id, target]));
    for (const publisher of options.publishers ?? []) targets.set(publisher.target.id, publisher.target);
    this.targets = [...targets.values()];
    this.now = options.now ?? (() => new Date());
  }

  async readiness(runId: string): Promise<StudioPublishReadiness> {
    const run = await this.requiredRun(runId);
    const publishPackage = await this.options.loadPublishPackage(run);
    const checks = complianceChecks(run, publishPackage);
    return {
      runId,
      ready: !checks.some((check) => check.status === "blocked"),
      title: run.title,
      targets: this.targets.map((target) => ({ ...target })),
      checks,
    };
  }

  async publish(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.requestId)) {
      throw new StudioInputError("发布请求编号格式不正确。");
    }
    const key = `${runId}:${input.requestId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.publishOnce(runId, input).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async publishOnce(runId: string, input: StudioPublishInput): Promise<StudioPublishBatch> {
    const run = await this.requiredRun(runId);
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
    const existing = await readBatch(batchPath);
    if (existing) return existing;

    await mkdir(directory, { recursive: true });
    const deliveries: StudioPublishDelivery[] = [];
    for (const target of selected) {
      if (target.status === "manual_only") {
        deliveries.push({ platformId: target.id, status: "export_ready", detail: "已准备平台发布包，需要在平台内人工上传。" });
        continue;
      }
      const publisher = this.publishers.get(target.id);
      if (target.status !== "ready" || !publisher) {
        deliveries.push({ platformId: target.id, status: "needs_config", detail: target.requirement ?? "需要完成官方应用与账号授权。" });
        continue;
      }
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
          detail: "平台请求失败，成功平台不会重复发送；请稍后单独重试此平台。",
        });
      }
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
      createdAt: this.now().toISOString(),
      deliveries,
    };
    await writeBatch(batchPath, batch);
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
      mode: "official_api",
      status: "planned",
      requirement: "需要通过抖音开放平台应用审核、申请 video.create 权限并完成账号 OAuth 授权。",
      docsUrl: "https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution",
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

function complianceChecks(run: StudioRunDetail, publishPackage: unknown): StudioPublishCheck[] {
  const checks: StudioPublishCheck[] = [];
  checks.push(run.status === "succeeded" && Boolean(run.publishPackageArtifactId)
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
  const unlicensed = run.artifacts.filter((artifact) => artifact.kind === "media_asset" && !artifact.licenseNote);
  checks.push(unlicensed.length === 0
    ? { id: "rights", label: "素材授权记录", status: "passed", detail: "素材产物均保留授权或来源说明。" }
    : { id: "rights", label: "素材授权记录", status: "blocked", detail: `${unlicensed.length} 个画面素材缺少授权记录，不能发布。` });
  checks.push({ id: "aigc", label: "平台 AI 声明", status: "requires_confirmation", detail: "文件标识不能替代平台声明；发布时仍须主动选择 AI 生成或辅助生成。" });
  checks.push({ id: "facts", label: "事实与敏感领域", status: "requires_confirmation", detail: "确认事实来源、时效和医疗/金融/法律等高风险内容已人工复核。" });
  checks.push({ id: "commercial", label: "商业与广告", status: "requires_confirmation", detail: "如含商业推广，确认已按平台与广告规则明确标识。" });
  return checks;
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
  const temporaryPath = `${batchPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(batch, null, 2)}\n`, "utf8");
  await rename(temporaryPath, batchPath);
}
