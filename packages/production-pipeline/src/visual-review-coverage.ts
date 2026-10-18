import { createHash } from "node:crypto";
import type { VisualReviewFinding } from "./codex-visual-review.js";

export interface VisualReviewRequirement {
  id: string;
  scenePosition: number;
  text: string;
}

export interface VisualReviewCoverage {
  source: "host";
  requirements: Array<VisualReviewRequirement & {
    status: "confirmed" | "failed" | "unconfirmed" | "not_applicable";
    findingIndices: number[];
  }>;
}

/** 只复用已采用稿的明确条件，不从自由正文、审美评价或模型报告另造验收目标。 */
export function visualReviewRequirements(context?: Record<string, unknown>, scenePositions?: readonly number[]): VisualReviewRequirement[] {
  if (!context) return [];
  const pilot = scenePositions ?? (Array.isArray(context.pilotScenePositions) ? context.pilotScenePositions as number[] : undefined);
  const director = asRecord(context.directorPlan);
  const script = asRecord(context.script);
  const requirements: VisualReviewRequirement[] = [];
  const add = (items: unknown, sceneKey: string, criteriaKey: string, source: string) => {
    for (const item of Array.isArray(items) ? items : []) {
      const entry = asRecord(item);
      const scenePosition = entry?.[sceneKey];
      if (!Number.isInteger(scenePosition) || Number(scenePosition) < 1 || (pilot && !pilot.includes(Number(scenePosition)))) continue;
      const criteria = entry?.[criteriaKey];
      for (const text of Array.isArray(criteria) ? criteria : []) {
        if (typeof text !== "string" || !text.trim()) continue;
        const id = `${source}:${scenePosition}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
        if (!requirements.some((requirement) => requirement.id === id)) requirements.push({ id, scenePosition: Number(scenePosition), text });
      }
    }
  };
  // 导演 successCriteria 的既有合同限定为产出画面可直接检查的条件。源素材尚无后期字幕/声音，
  // 不将脚本的整片条件带到这个阶段；成片则同时核对脚本明确写出的条件。
  add(director?.shots, "scenePosition", "successCriteria", "director");
  if (context.reviewStage === "rendered_video") add(script?.scenes, "position", "success_criteria", "script");
  return requirements;
}

export function assessVisualReviewCoverage(requirements: readonly VisualReviewRequirement[], findings: readonly VisualReviewFinding[]): VisualReviewCoverage {
  return {
    source: "host",
    requirements: requirements.map((requirement) => {
      const findingIndices = findings.flatMap((finding, index) => finding.requirementId === requirement.id
        && finding.scenePosition === requirement.scenePosition ? [index] : []);
      const checks = findingIndices.map((index) => findings[index]!);
      const status = checks.some((finding) => finding.evidenceStatus === "failed") ? "failed"
        : checks.length === 0 || checks.some((finding) => finding.evidenceStatus === "not_observed") ? "unconfirmed"
        : checks.some((finding) => finding.evidenceStatus === "satisfied") ? "confirmed"
        : "not_applicable";
      return { ...requirement, status, findingIndices };
    }),
  };
}

/** 已落盘报告重读只恢复宿主清单，状态重新按 finding 推导，不能信任缓存里的 confirmed。 */
export function storedVisualReviewRequirements(value: unknown): VisualReviewRequirement[] | undefined {
  if (value === undefined) return undefined;
  const coverage = asRecord(value);
  if (coverage?.source !== "host" || !Array.isArray(coverage.requirements)) throw new Error("Visual review coverage is invalid.");
  const ids = new Set<string>();
  return coverage.requirements.map((value): VisualReviewRequirement => {
    const requirement = asRecord(value);
    if (!requirement || typeof requirement.id !== "string" || !requirement.id
      || ids.has(requirement.id) || !Number.isInteger(requirement.scenePosition) || Number(requirement.scenePosition) < 1
      || typeof requirement.text !== "string" || !requirement.text.trim()) throw new Error("Visual review coverage requirement is invalid.");
    ids.add(requirement.id);
    return { id: requirement.id, scenePosition: Number(requirement.scenePosition), text: requirement.text };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
