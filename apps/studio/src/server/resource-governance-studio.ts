import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionBrief } from "@video-factory/production-pipeline";
import type {
  StudioResourceManifest,
  StudioResourceManifestItem,
  StudioTemplateExperimentScorecard,
} from "../shared/api.js";

const EXPERIMENT_TEMPLATES = [
  ["trend-fact-brief", "热点事实简报"],
  ["knowledge-explainer", "知识解释"],
  ["photo-story", "照片故事"],
] as const;

interface StoredManifest {
  version: "video-factory/resource-manifest-v1";
  runId: string;
  items: Array<Omit<StudioResourceManifestItem, "runId" | "runTitle">>;
}

export class ResourceGovernanceStudio {
  constructor(
    private readonly workspaceRoot: string,
    private readonly listRuns: () => Promise<WorkflowRun<ProductionBrief>[]>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async manifest(): Promise<StudioResourceManifest> {
    const allRuns = await this.listRuns();
    const runs = allRuns.slice(0, 500);
    const items: StudioResourceManifestItem[] = [];
    let legacyRunsWithoutManifest = 0;
    let reconstructedRunCount = 0;
    let unreadableManifestCount = 0;
    for (const run of runs) {
      const artifact = [...run.artifacts].reverse().find((candidate) => candidate.kind === "resource_manifest" && candidate.uri);
      if (!artifact?.uri) {
        if (hasMeteredExecution(run)) {
          reconstructedRunCount += 1;
          items.push(...reconstructManifestItems(run));
        } else if (run.status === "succeeded") legacyRunsWithoutManifest += 1;
        continue;
      }
      try {
        const manifest = await this.readManifest(artifact.uri, run.id);
        items.push(...manifest.items.map((item) => ({ ...item, runId: run.id, runTitle: run.initialInput.title })));
      } catch {
        unreadableManifestCount += 1;
        if (hasMeteredExecution(run)) {
          reconstructedRunCount += 1;
          items.push(...reconstructManifestItems(run));
        }
      }
    }
    const categories: StudioResourceManifest["categories"] = { visual: 0, voice: 0, font: 0, document: 0, other: 0 };
    for (const item of items) categories[item.category] += 1;
    return {
      generatedAt: this.now().toISOString(),
      totalItems: items.length,
      needsReviewCount: items.filter((item) => item.reviewStatus === "needs_review").length,
      legacyRunsWithoutManifest,
      reconstructedRunCount,
      unreadableManifestCount,
      truncatedRunCount: Math.max(0, allRuns.length - runs.length),
      categories,
      items: items.slice(0, 500),
    };
  }

  async templateExperiments(): Promise<StudioTemplateExperimentScorecard[]> {
    const runs = await this.listRuns();
    return EXPERIMENT_TEMPLATES.map(([templateId, templateName]) => {
      const samples = runs.filter((run) => run.initialInput.templateSnapshot?.templateId === templateId);
      const completed = samples.filter((run) => run.nodeRuns.some((node) => node.nodeId === "render" && node.status === "succeeded"));
      const approved = samples.filter((run) => run.decisions.some((decision) => decision.action === "approve"));
      const manualEditCount = samples.reduce((total, run) => total + run.nodeRuns.reduce((nodeTotal, node) => {
        const inputEdits = node.inputState?.versions.filter((version) => version.source === "human").length ?? 0;
        const outputEdits = node.outputState?.versions.filter((version) => version.source === "human").length ?? 0;
        return nodeTotal + inputEdits + outputEdits;
      }, 0), 0);
      const visualScores = samples.flatMap((run) => run.nodeRuns.flatMap((node) => {
        if (node.nodeId !== "visual-review" || !isRecord(node.output) || !isRecord(node.output.scores)) return [];
        const composition = finiteNumber(node.output.scores.composition);
        const continuity = finiteNumber(node.output.scores.continuity);
        return composition === undefined || continuity === undefined ? [] : [(composition + continuity) / 2];
      }));
      const soundChecks = samples.flatMap((run) => run.nodeRuns.flatMap((node) => {
        if (node.nodeId !== "technical-review" || !isRecord(node.output)) return [];
        return typeof node.output.passed === "boolean" ? [node.output.passed ? 100 : 0] : [];
      }));
      const costRatios = samples.flatMap((run) => {
        const budget = run.initialInput.economics.maxCostCny;
        if (budget <= 0) return [];
        const actualCost = (run.executionReceipts ?? []).reduce((sum, receipt) => sum + (receipt.actualCostCny ?? 0), 0);
        return [actualCost / budget];
      });
      const costEfficiency = costRatios.length
        ? clampScore(100 - average(costRatios) * 100)
        : null;
      return {
        templateId,
        templateName,
        sampleSize: samples.length,
        metrics: {
          hookClarity: null,
          narrativeCompleteness: samples.length ? percent(completed.length, samples.length) : null,
          visualMatch: visualScores.length ? roundScore(average(visualScores)) : null,
          soundQuality: soundChecks.length ? roundScore(average(soundChecks)) : null,
          costEfficiency,
          manualEditCount,
          finalApprovalRate: samples.length ? percent(approved.length, samples.length) : null,
        },
        note: samples.length
          ? "只展示可由运行证据计算的指标；钩子清晰度需后续接入独立人工评分，当前不编造分数。"
          : "尚无使用该模板完成的样本；首次成片后开始累计，不修改已发布模板版本。",
      };
    });
  }

  private async readManifest(uri: string, runId: string): Promise<StoredManifest> {
    const [workspaceRoot, target] = await Promise.all([realpath(this.workspaceRoot), realpath(uri)]);
    const relative = path.relative(workspaceRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("资源清单不在受控工作区中。");
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) throw new Error("资源清单文件无效或过大。");
    const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== "video-factory/resource-manifest-v1" || parsed.runId !== runId || !Array.isArray(parsed.items)) {
      throw new Error("资源清单格式不正确。");
    }
    if (parsed.items.length > 2_000) throw new Error("资源清单条目过多。");
    return {
      version: "video-factory/resource-manifest-v1",
      runId,
      items: parsed.items.map((item, index) => parseManifestItem(item, index)),
    };
  }
}

function hasMeteredExecution(run: WorkflowRun<ProductionBrief>): boolean {
  return (run.executionReceipts ?? []).some((receipt) => receipt.billing === "metered");
}

function reconstructManifestItems(run: WorkflowRun<ProductionBrief>): StudioResourceManifestItem[] {
  return run.artifacts
    .filter((artifact) => artifact.kind !== "resource_manifest")
    .map((artifact) => ({
      id: `reconstructed:${artifact.id}`,
      runId: run.id,
      runTitle: run.initialInput.title,
      category: reconstructedCategory(artifact.kind, artifact.contentType, artifact.producer?.nodeId),
      kind: artifact.kind,
      providerId: artifact.provenance.providerId ?? "unknown",
      ...(artifact.provenance.sourceUrl ? { sourceUrl: artifact.provenance.sourceUrl } : {}),
      ...(artifact.provenance.creator ? { creator: artifact.provenance.creator } : {}),
      licenseNote: artifact.provenance.licenseNote
        ? `从未完成任务恢复：${artifact.provenance.licenseNote}`
        : "从未完成任务恢复，授权与来源尚未形成最终清单，必须人工复核。",
      ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      commercialUse: "review_required" as const,
      attributionRequirement: "unknown" as const,
      reviewStatus: "needs_review" as const,
    }));
}

function reconstructedCategory(
  kind: string,
  contentType?: string,
  producerNodeId?: string,
): StudioResourceManifestItem["category"] {
  if (producerNodeId === "voice" || kind === "voiceover" || contentType?.startsWith("audio/")) return "voice";
  if (kind === "media_asset" || kind === "render" || contentType?.startsWith("video/") || contentType?.startsWith("image/")) return "visual";
  if (contentType === "application/json" || kind.endsWith("_plan") || kind.endsWith("_report")) return "document";
  return "other";
}

function parseManifestItem(value: unknown, index: number): StoredManifest["items"][number] {
  const item = requiredRecord(value, `资源清单第 ${index + 1} 项`);
  const categories = new Set(["visual", "voice", "font", "document", "other"] as const);
  const commercialUses = new Set(["self_owned", "provider_terms", "review_required"] as const);
  const attributions = new Set(["not_required", "provider_terms", "unknown"] as const);
  const reviewStatuses = new Set(["recorded", "needs_review"] as const);
  const category = enumValue(item.category, categories, "category");
  const commercialUse = enumValue(item.commercialUse, commercialUses, "commercialUse");
  const attributionRequirement = enumValue(item.attributionRequirement, attributions, "attributionRequirement");
  const reviewStatus = enumValue(item.reviewStatus, reviewStatuses, "reviewStatus");
  const sha256 = optionalText(item.sha256, "sha256", 64);
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("资源清单 sha256 格式不正确。");
  return {
    id: requiredText(item.id, "id", 256),
    category,
    kind: requiredText(item.kind, "kind", 128),
    providerId: requiredText(item.providerId, "providerId", 160),
    ...(optionalText(item.sourceUrl, "sourceUrl", 2_048) ? { sourceUrl: optionalText(item.sourceUrl, "sourceUrl", 2_048)! } : {}),
    ...(optionalText(item.creator, "creator", 512) ? { creator: optionalText(item.creator, "creator", 512)! } : {}),
    ...(optionalText(item.licenseNote, "licenseNote", 2_048) ? { licenseNote: optionalText(item.licenseNote, "licenseNote", 2_048)! } : {}),
    ...(optionalText(item.contentType, "contentType", 160) ? { contentType: optionalText(item.contentType, "contentType", 160)! } : {}),
    ...(sha256 ? { sha256 } : {}),
    commercialUse,
    attributionRequirement,
    reviewStatus,
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}格式不正确。`);
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`资源清单 ${field} 格式不正确。`);
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, field, maxLength);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, field: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) throw new Error(`资源清单 ${field} 格式不正确。`);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(numerator: number, denominator: number): number {
  return roundScore((numerator / denominator) * 100);
}

function clampScore(value: number): number {
  return roundScore(Math.max(0, Math.min(100, value)));
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}
