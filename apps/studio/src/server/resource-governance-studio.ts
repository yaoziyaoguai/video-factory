import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkflowRun } from "@video-factory/workflow-core";
import type { ProductionBrief } from "@video-factory/production-pipeline";
import type {
  StudioAssetIndex,
  StudioAssetMediaKind,
  StudioAssetOrigin,
  StudioAssetReuseStatus,
  StudioIndexedAsset,
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
  items: Array<Omit<StudioResourceManifestItem, "runId" | "runTitle" | "contentUrl">>;
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
        items.push(...manifest.items.map((item) => ({
          ...item,
          runId: run.id,
          runTitle: run.initialInput.title,
          ...resourceContentUrl(run, item.id, item.sha256),
        })));
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
    const visibleItems = items.slice(0, 500);
    return {
      generatedAt: this.now().toISOString(),
      totalItems: items.length,
      needsReviewCount: items.filter((item) => item.reviewStatus === "needs_review").length,
      legacyRunsWithoutManifest,
      reconstructedRunCount,
      unreadableManifestCount,
      truncatedRunCount: Math.max(0, allRuns.length - runs.length),
      truncatedItemCount: Math.max(0, items.length - visibleItems.length),
      categories,
      items: visibleItems,
      assetIndex: buildAssetIndex(items),
    };
  }

  async templateExperiments(): Promise<StudioTemplateExperimentScorecard[]> {
    const runs = await this.listRuns();
    return EXPERIMENT_TEMPLATES.map(([templateId, templateName]) => {
      const samples = runs.filter((run) => run.initialInput.templateSnapshot?.templateId === templateId);
      const completed = samples.filter((run) => run.nodeRuns.some((node) =>
        node.nodeId === "render" && node.status === "succeeded" && node.outputState?.stale !== true));
      const approved = samples.filter((run) => hasCurrentFinalApproval(run));
      const manualEditCount = samples.reduce((total, run) => total + run.nodeRuns.reduce((nodeTotal, node) => {
        const inputEdits = node.inputState?.versions.filter((version) => version.source === "human").length ?? 0;
        const outputEdits = node.outputState?.versions.filter((version) => version.source === "human").length ?? 0;
        return nodeTotal + inputEdits + outputEdits;
      }, 0), 0);
      const visualScores = samples.flatMap((run) => run.nodeRuns.flatMap((node) => {
        if (node.nodeId !== "visual-review" || node.status !== "succeeded" || node.outputState?.stale === true || !isRecord(node.output)) return [];
        const report = isRecord(node.output.report) ? node.output.report : node.output;
        if (!isRecord(report.scores)) return [];
        const composition = finiteNumber(report.scores.composition);
        const continuity = finiteNumber(report.scores.continuity);
        return composition === undefined || continuity === undefined ? [] : [(composition + continuity) / 2];
      }));
      const soundChecks = samples.flatMap((run) => run.nodeRuns.flatMap((node) => {
        if (node.nodeId !== "technical-review" || node.status !== "succeeded" || node.outputState?.stale === true || !isRecord(node.output)) return [];
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

function hasCurrentFinalApproval(run: WorkflowRun<ProductionBrief>): boolean {
  if (run.status !== "succeeded") return false;
  const finalReview = run.nodeRuns.find((node) => node.nodeId === "final-review");
  if (!finalReview || finalReview.status !== "succeeded" || finalReview.outputState?.stale === true) return false;
  const finalReviewInterventions = new Set(
    run.interventions.filter((intervention) => intervention.nodeId === "final-review").map((intervention) => intervention.id),
  );
  return run.decisions.some((decision) =>
    decision.action === "approve" && finalReviewInterventions.has(decision.interventionId));
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
      ...resourceContentUrl(run, `artifact:${artifact.id}`, artifact.sha256),
    }));
}

function resourceContentUrl(run: WorkflowRun<ProductionBrief>, itemId: string, sha256?: string): { contentUrl?: string } {
  const artifactId = itemId.startsWith("artifact:") ? itemId.slice("artifact:".length) : undefined;
  const artifact = artifactId
    ? run.artifacts.find((candidate) => candidate.id === artifactId)
    : sha256
      ? run.artifacts.find((candidate) => candidate.sha256 === sha256)
      : undefined;
  if (!artifact?.uri || artifact.kind === "reference_video" || artifact.kind === "candidate_inventory_private") return {};
  if (!artifact.contentType?.startsWith("video/") && !artifact.contentType?.startsWith("image/") && !artifact.contentType?.startsWith("audio/")) return {};
  return { contentUrl: `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}/content` };
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
    ...(optionalInteger(item.scenePosition, "scenePosition", 1) !== undefined ? { scenePosition: optionalInteger(item.scenePosition, "scenePosition", 1)! } : {}),
    ...(optionalInteger(item.width, "width", 1) !== undefined ? { width: optionalInteger(item.width, "width", 1)! } : {}),
    ...(optionalInteger(item.height, "height", 1) !== undefined ? { height: optionalInteger(item.height, "height", 1)! } : {}),
    ...(optionalFinite(item.durationSeconds, "durationSeconds", 0) !== undefined ? { durationSeconds: optionalFinite(item.durationSeconds, "durationSeconds", 0)! } : {}),
    ...(optionalText(item.query, "query", 2_000) ? { query: optionalText(item.query, "query", 2_000)! } : {}),
    ...(item.semanticTags === undefined ? {} : { semanticTags: stringArray(item.semanticTags, "semanticTags", 24, 120) }),
    ...(item.selectedInFinal === undefined ? {} : { selectedInFinal: booleanValue(item.selectedInFinal, "selectedInFinal") }),
    commercialUse,
    attributionRequirement,
    reviewStatus,
  };
}

function buildAssetIndex(items: StudioResourceManifestItem[]): StudioAssetIndex {
  const indexed = new Map<string, StudioIndexedAsset>();
  for (const item of items) {
    const key = assetIdentity(item);
    const mediaKind = assetMediaKind(item);
    const origin = assetOrigin(item);
    const reuseStatus = assetReuseStatus(item, mediaKind, origin);
    const usage = {
      runId: item.runId,
      runTitle: item.runTitle,
      itemId: item.id,
      providerId: item.providerId,
      commercialUse: item.commercialUse,
      attributionRequirement: item.attributionRequirement,
      reviewStatus: item.reviewStatus,
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(item.creator ? { creator: item.creator } : {}),
      ...(item.licenseNote ? { licenseNote: item.licenseNote } : {}),
      ...(item.scenePosition !== undefined ? { scenePosition: item.scenePosition } : {}),
      ...(item.selectedInFinal !== undefined ? { selectedInFinal: item.selectedInFinal } : {}),
    };
    const existing = indexed.get(key);
    if (existing) {
      if (!existing.usages.some((entry) => entry.runId === usage.runId && entry.itemId === usage.itemId)) existing.usages.push(usage);
      existing.useCount = existing.usages.length;
      existing.tags = uniqueTags([...existing.tags, ...assetTags(item, mediaKind, origin)]);
      if (!existing.contentUrl && item.contentUrl) existing.contentUrl = item.contentUrl;
      if (existing.provenanceConflict || (existing.sourceUrl && item.sourceUrl && existing.sourceUrl !== item.sourceUrl)) {
        existing.provenanceConflict = true;
        delete existing.sourceUrl;
      } else if (!existing.sourceUrl && item.sourceUrl) existing.sourceUrl = item.sourceUrl;
      if (existing.providerId !== item.providerId) existing.providerId = "multiple";
      if (existing.creator && item.creator && existing.creator !== item.creator) existing.creator = "多个来源者";
      else if (!existing.creator && item.creator) existing.creator = item.creator;
      const mergedLicenseNote = mergeLicenseNotes(existing.licenseNote, item.licenseNote);
      if (mergedLicenseNote) existing.licenseNote = mergedLicenseNote;
      else delete existing.licenseNote;
      existing.commercialUse = strictCommercialUse(existing.commercialUse, item.commercialUse);
      existing.attributionRequirement = strictAttribution(existing.attributionRequirement, item.attributionRequirement);
      existing.reviewStatus = existing.reviewStatus === "needs_review" || item.reviewStatus === "needs_review" ? "needs_review" : "recorded";
      existing.reuseStatus = strictReuseStatus(existing.reuseStatus, reuseStatus);
      if (existing.provenanceConflict) {
        existing.reviewStatus = "needs_review";
        existing.reuseStatus = strictReuseStatus(existing.reuseStatus, "review_required");
      }
      continue;
    }
    indexed.set(key, {
      key,
      mediaKind,
      origin,
      reuseStatus,
      category: item.category,
      kind: item.kind,
      providerId: item.providerId,
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      ...(item.contentUrl ? { contentUrl: item.contentUrl } : {}),
      ...(item.creator ? { creator: item.creator } : {}),
      ...(item.licenseNote ? { licenseNote: item.licenseNote } : {}),
      ...(item.contentType ? { contentType: item.contentType } : {}),
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
      ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
      ...(item.width && item.height ? { aspectRatio: aspectRatioLabel(item.width, item.height) } : {}),
      ...(item.query ? { query: item.query } : {}),
      tags: assetTags(item, mediaKind, origin),
      commercialUse: item.commercialUse,
      attributionRequirement: item.attributionRequirement,
      reviewStatus: item.reviewStatus,
      useCount: 1,
      usages: [usage],
    });
  }
  const assets = [...indexed.values()].sort((left, right) => {
    const reuseOrder = { ready: 0, review_required: 1, private: 2, not_reusable: 3 } as const;
    return reuseOrder[left.reuseStatus] - reuseOrder[right.reuseStatus]
      || right.useCount - left.useCount
      || left.providerId.localeCompare(right.providerId);
  });
  return {
    version: "video-factory/asset-index-v1",
    totalAssets: assets.length,
    duplicateUses: Math.max(0, items.length - assets.length),
    reusableCount: assets.filter((item) => item.reuseStatus === "ready").length,
    needsReviewCount: assets.filter((item) => item.reuseStatus === "review_required").length,
    facets: {
      mediaKinds: countFacet(assets.map((item) => item.mediaKind)),
      origins: countFacet(assets.map((item) => item.origin)),
      providers: countFacet(assets.map((item) => item.providerId)),
      reuseStatuses: countFacet(assets.map((item) => item.reuseStatus)),
    },
    assets,
  };
}

function strictCommercialUse(
  left: StudioResourceManifestItem["commercialUse"],
  right: StudioResourceManifestItem["commercialUse"],
): StudioResourceManifestItem["commercialUse"] {
  const rank = { self_owned: 0, provider_terms: 1, review_required: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function strictAttribution(
  left: StudioResourceManifestItem["attributionRequirement"],
  right: StudioResourceManifestItem["attributionRequirement"],
): StudioResourceManifestItem["attributionRequirement"] {
  const rank = { not_required: 0, provider_terms: 1, unknown: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function strictReuseStatus(left: StudioAssetReuseStatus, right: StudioAssetReuseStatus): StudioAssetReuseStatus {
  const rank = { ready: 0, review_required: 1, private: 2, not_reusable: 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function mergeLicenseNotes(left?: string, right?: string): string | undefined {
  const notes = [...new Set([left, right].filter((value): value is string => Boolean(value)))];
  if (notes.length > 1) return "存在多条授权记录，请查看每次使用的独立来源与授权说明。";
  return notes[0];
}

function assetIdentity(item: StudioResourceManifestItem): string {
  if (item.sha256) return `sha256:${item.sha256.toLowerCase()}`;
  if (item.sourceUrl) return `source:${item.sourceUrl}`;
  return `usage:${item.runId}:${item.id}`;
}

function assetMediaKind(item: StudioResourceManifestItem): StudioAssetMediaKind {
  if (item.contentType?.startsWith("video/")) return "video";
  if (item.contentType?.startsWith("image/")) return "image";
  if (item.contentType?.startsWith("audio/")) return "audio";
  if (item.category === "document") return "document";
  if (item.category === "font") return "font";
  return "other";
}

function assetOrigin(item: StudioResourceManifestItem): StudioAssetOrigin {
  const provider = item.providerId.toLowerCase();
  if (item.kind === "render") return "final_render";
  if (provider === "creator-upload" || item.kind === "reference_video") return "creator_upload";
  if (item.category === "voice") return "voice_synthesis";
  if (item.category === "document") return "production_document";
  if (item.category === "font") return "system";
  if (/pexels|pixabay|stock/.test(provider)) return "stock";
  if (/seedance|seedream|minimax|hailuo|wan|kling|generated/.test(provider) || /AI-generated/i.test(item.licenseNote ?? "")) return "ai_generated";
  if (/local|video-factory/.test(provider)) return "local_generated";
  return "system";
}

function assetReuseStatus(item: StudioResourceManifestItem, mediaKind: StudioAssetMediaKind, origin: StudioAssetOrigin): StudioAssetReuseStatus {
  if (origin === "creator_upload") return "private";
  if (origin === "final_render" || origin === "voice_synthesis" || !["video", "image"].includes(mediaKind)) return "not_reusable";
  if (item.reviewStatus === "needs_review" || item.commercialUse === "review_required") return "review_required";
  return item.contentUrl || item.sourceUrl ? "ready" : "review_required";
}

function assetTags(item: StudioResourceManifestItem, mediaKind: StudioAssetMediaKind, origin: StudioAssetOrigin): string[] {
  return uniqueTags([
    item.runTitle,
    item.kind,
    item.providerId,
    mediaKind,
    origin,
    item.creator ?? "",
    item.query ?? "",
    ...(item.semanticTags ?? []),
  ]);
}

function uniqueTags(values: string[]): string[] {
  const tags = values.flatMap((value) => value.split(/[\s,，、/]+/u)).map((value) => value.trim()).filter(Boolean);
  return [...new Set(tags)].slice(0, 48);
}

function countFacet<T extends string>(values: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function aspectRatioLabel(width: number, height: number): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
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

function optionalInteger(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`资源清单 ${field} 格式不正确。`);
  return Number(value);
}

function optionalFinite(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`资源清单 ${field} 格式不正确。`);
  return value;
}

function stringArray(value: unknown, field: string, maximum: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`资源清单 ${field} 格式不正确。`);
  return value.map((item) => requiredText(item, field, maxLength));
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`资源清单 ${field} 格式不正确。`);
  return value;
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
