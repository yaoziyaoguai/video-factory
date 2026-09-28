import { createHash } from "node:crypto";
import type { WorkflowRun, HumanReviewDisposition } from "@video-factory/workflow-core";

export interface ReviewDecisionPrefill {
  expectedRunRevision: number;
  basis: string | null;
  reviewEvidenceId?: string;
  sourceDecisionId?: string;
  dispositions: HumanReviewDisposition[];
}

export function reviewDecisionBasis(run: WorkflowRun<unknown>): string | undefined {
  const identities = [];
  for (const id of ["voice", "render", "visual-review"]) {
    const node = run.nodeRuns.find(candidate => candidate.nodeId === id);
    if (!node && id === "voice") continue;
    const state = node?.outputState;
    const version = state?.versions.find(candidate => candidate.id === state.effectiveVersionId);
    if (!version || state?.stale || node?.inputState?.stale || node?.outcomeUncertain
      || !["succeeded", "needs_human"].includes(node!.status) || !version.artifactIds.length) return undefined;
    const artifacts = version.artifactIds.map(artifactId => run.artifacts.find(artifact => artifact.id === artifactId));
    if (artifacts.some(artifact => !artifact?.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256))) return undefined;
    const requestId = node?.executionReceipt?.requestId;
    // 审查执行身份不完整时不得生成可沿用身份：requestId 缺失/空白即退回手填（F01）。
    // 声音/本地渲染节点没有供应商回执不在此列；只约束机器审片执行本身。
    if (id === "visual-review" && (typeof requestId !== "string" || !requestId.trim())) return undefined;
    identities.push({ nodeId: id, versionId: version.id, inputVersionIds: version.inputVersionIds,
      requestId,
      // 包含完整有效输出：声音布局/字幕/审计操作身份改变时不可仅靠相同文件SHA借用旧表态。
      output: version.output, artifacts: artifacts.map(artifact => ({ id: artifact!.id, sha256: artifact!.sha256 }))
        .sort((a, b) => a.id.localeCompare(b.id)) });
  }
  if (!currentEvidenceId(run)) return undefined;
  return createHash("sha256").update(JSON.stringify({ runId: run.id, identities })).digest("hex");
}

function currentEvidenceId(run: WorkflowRun<unknown>): string | undefined {
  const node = run.nodeRuns.find(candidate => candidate.nodeId === "visual-review");
  const output = node?.outputState?.versions.find(version => version.id === node.outputState?.effectiveVersionId)?.output;
  if (!output || typeof output !== "object" || !("report" in output)) return undefined;
  const report = output.report;
  if (!report || typeof report !== "object" || !("reviewScope" in report)) return undefined;
  const scope = report.reviewScope;
  if (!scope || typeof scope !== "object" || !("evidenceId" in scope) || !("reviewStage" in scope)
    || scope.reviewStage !== "rendered_video" || typeof scope.evidenceId !== "string"
    || !/^[a-f0-9]{64}$/.test(scope.evidenceId)) return undefined;
  return scope.evidenceId;
}

export function reviewDecisionPrefill(run: WorkflowRun<unknown>, actor: string): ReviewDecisionPrefill {
  const basis = reviewDecisionBasis(run);
  const reviewEvidenceId = currentEvidenceId(run);
  const prior = basis && [...run.decisions].reverse().find(decision => decision.action === "approve"
    && decision.actor === actor && decision.reviewDispositionBasis === basis
    && decision.reviewEvidenceId === reviewEvidenceId && decision.reviewDispositions?.length);
  return { expectedRunRevision: run.revision, basis: basis ?? null, ...(reviewEvidenceId ? { reviewEvidenceId } : {}),
    ...(prior ? { sourceDecisionId: prior.id } : {}), dispositions: structuredClone(prior ? prior.reviewDispositions! : []) };
}
