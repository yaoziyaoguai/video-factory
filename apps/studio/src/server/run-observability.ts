import type {
  StudioNode,
  StudioRunCurrentAction,
  StudioRunFailure,
  StudioRunPhase,
  StudioRunPhaseId,
  StudioRunPhaseStatus,
  StudioRunProgress,
  StudioRunResultAvailability,
  StudioRunStatus,
} from "../shared/api.js";

const PHASES: Array<{ id: StudioRunPhaseId; label: string; nodeIds: string[] }> = [
  { id: "planning", label: "策划定稿", nodeIds: ["brief", "script", "reference-grammar", "visual-direction"] },
  { id: "assets", label: "素材筹备", nodeIds: ["asset-candidates", "asset-semantic-rank", "assets", "asset-source-review"] },
  { id: "composition", label: "声音与剪辑", nodeIds: ["voice", "render"] },
  { id: "review", label: "审片质检", nodeIds: ["technical-review", "visual-review", "final-review"] },
  { id: "delivery", label: "交付发布", nodeIds: ["publish-package"] },
];

const NODE_ACTIONS: Record<string, string> = {
  brief: "正在核对题目、观众与生产约束",
  script: "编剧正在根据独立复核意见修改脚本，最多 3 轮",
  "reference-grammar": "正在提炼参考片的节奏、构图与镜头运动",
  "visual-direction": "正在统一叙事节奏、镜头语法与视觉规则",
  "asset-candidates": "正在检索并整理可用素材候选",
  "asset-semantic-rank": "正在按镜头语义、可信度与成本排序素材",
  assets: "正在组织逐镜画面并核对素材来源",
  "asset-source-review": "正在检查生成画面的文字、主体与动作一致性",
  voice: "正在生成配音并校准语速、停连和响度",
  render: "正在合成画面、声音、字幕与转场",
  "technical-review": "正在检查画幅、音量、字幕和文件完整性",
  "visual-review": "正在审查画面连贯性、可读性与视觉质量",
  "final-review": "正在等待你完整观看并作出终审判断",
  "publish-package": "正在整理标题、封面文案与平台发布包",
};

interface BuildRunObservabilityInput {
  status: StudioRunStatus;
  startedAt: string;
  finishedAt?: string;
  now: string;
  nodes: StudioNode[];
  historicalNodeDurations?: Record<string, number[]>;
  manualReview?: boolean;
  videoAvailable: boolean;
  publishPackageAvailable: boolean;
}

export interface StudioRunObservability {
  phases: StudioRunPhase[];
  progress: StudioRunProgress;
  currentAction?: StudioRunCurrentAction;
  failure?: StudioRunFailure;
  resultAvailability: StudioRunResultAvailability;
}

export function nodeActionLabel(nodeId: string, providerId?: string): string {
  if (nodeId === "script" && providerId !== "codex-screenwriter-v1") return "编剧正在生成结构化脚本";
  return NODE_ACTIONS[nodeId] ?? "正在完成当前节点的创作交付";
}

export function buildRunObservability(input: BuildRunObservabilityInput): StudioRunObservability {
  const phases = PHASES.map((phase) => buildPhase(phase, input.nodes)).filter((phase) => phase.totalNodes > 0);
  const completedNodes = input.nodes.filter(isCompleted).length;
  const totalNodes = input.nodes.length;
  const lastUpdatedAt = latestTimestamp(input.startedAt, input.nodes);
  const runningNode = input.nodes.find((node) => node.status === "running");
  const progress: StudioRunProgress = {
    completedNodes,
    totalNodes,
    percentage: totalNodes > 0 ? Math.round((completedNodes / totalNodes) * 100) : 0,
    elapsedSeconds: activeProcessingSeconds(input.nodes, input.now),
    ...(runningNode?.startedAt ? { currentNodeElapsedSeconds: secondsBetween(runningNode.startedAt, input.now) } : {}),
    lastUpdatedAt,
  };
  const eta = estimateRemaining(input);
  if (eta) {
    progress.eta = eta;
  } else {
    progress.etaUnavailableReason = etaUnavailableReason(input);
  }

  const activeNode = input.nodes.find((node) => node.status === "running")
    ?? input.nodes.find(isAttention)
    ?? input.nodes.find((node) => node.status === "failed" || node.status === "rejected")
    ?? input.nodes.find((node) => node.status === "pending");
  const currentAction = activeNode ? {
    nodeId: activeNode.id,
    role: activeNode.role ?? "制作角色",
    label: activeNode.actionLabel ?? nodeActionLabel(
      activeNode.id,
      (activeNode.executionReceipt ?? activeNode.plannedExecution)?.providerId,
    ),
  } : undefined;
  const failure = input.status === "failed"
    ? buildFailure(input.nodes, input.videoAvailable)
    : undefined;

  return {
    phases,
    progress,
    ...(currentAction ? { currentAction } : {}),
    ...(failure ? { failure } : {}),
    resultAvailability: buildResultAvailability(input, failure),
  };
}

function buildPhase(
  definition: { id: StudioRunPhaseId; label: string; nodeIds: string[] },
  nodes: StudioNode[],
): StudioRunPhase {
  const phaseNodes = definition.nodeIds.flatMap((nodeId) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    return node ? [node] : [];
  });
  return {
    id: definition.id,
    label: definition.label,
    status: phaseStatus(phaseNodes),
    nodeIds: phaseNodes.map((node) => node.id),
    completedNodes: phaseNodes.filter(isCompleted).length,
    totalNodes: phaseNodes.length,
  };
}

function phaseStatus(nodes: StudioNode[]): StudioRunPhaseStatus {
  if (nodes.some((node) => node.status === "failed" || node.status === "rejected")) return "failed";
  if (nodes.some(isAttention)) return "attention";
  if (nodes.length > 0 && nodes.every(isCompleted)) return "completed";
  if (nodes.some((node) => node.status === "running") || nodes.some(isCompleted)) return "running";
  return "pending";
}

function isCompleted(node: StudioNode): boolean {
  return node.status === "succeeded" || node.status === "skipped";
}

function isAttention(node: StudioNode): boolean {
  return node.status === "needs_human"
    || node.status === "awaiting_spend_approval"
    || node.status === "approval_invalidated"
    || node.status === "stale";
}

function estimateRemaining(input: BuildRunObservabilityInput): StudioRunProgress["eta"] | undefined {
  if (input.status !== "running") return undefined;
  const remaining = input.nodes.filter((node) => !isCompleted(node));
  if (remaining.length === 0) return undefined;
  if (hasFutureHumanGate(input, remaining)) return undefined;
  const samples = remaining.map((node) => input.historicalNodeDurations?.[node.id] ?? []);
  if (samples.some((values) => values.length < 3)) return undefined;
  const expectedSeconds = remaining.reduce((sum, node, index) => {
    const fullDuration = median(samples[index] ?? []);
    const elapsed = node.status === "running" && node.startedAt
      ? secondsBetween(node.startedAt, input.now)
      : 0;
    return sum + Math.max(0, fullDuration - elapsed);
  }, 0);
  return {
    lowSeconds: Math.max(1, Math.round(expectedSeconds * 0.8)),
    highSeconds: Math.max(1, Math.round(expectedSeconds * 1.2)),
    sampleSize: samples.reduce((sum, values) => sum + values.length, 0),
  };
}

function etaUnavailableReason(input: BuildRunObservabilityInput): NonNullable<StudioRunProgress["etaUnavailableReason"]> {
  if (isHumanWaitingStatus(input.status)) return "waiting_for_human";
  if (input.status !== "running") return "not_running";
  const remaining = input.nodes.filter((node) => !isCompleted(node));
  if (hasFutureHumanGate(input, remaining)) return "future_human_gate";
  return "insufficient_history";
}

function hasFutureHumanGate(input: BuildRunObservabilityInput, remaining: StudioNode[]): boolean {
  return remaining.some((node) =>
    (input.manualReview === true && node.id === "final-review")
    || (node.plannedExecution?.billing === "metered" && !node.spendAuthorizationId));
}

function isHumanWaitingStatus(status: StudioRunStatus): boolean {
  return status === "needs_human"
    || status === "awaiting_spend_approval"
    || status === "approval_invalidated"
    || status === "stale";
}

function buildFailure(nodes: StudioNode[], videoAvailable: boolean): StudioRunFailure | undefined {
  const failed = nodes.find((node) => node.status === "failed" || node.status === "rejected");
  if (!failed) return undefined;
  const raw = failed.error ?? "当前节点没有返回可用结果。";
  const provider = failed.executionReceipt?.providerLabel ?? failed.plannedExecution?.providerLabel;
  const savedNodeCount = nodes.filter(isCompleted).length;
  const laterNodes = nodes.slice(nodes.indexOf(failed) + 1).filter((node) => node.status === "pending");
  const preserved = videoAvailable
    ? "成片已保留，可以预览；失败发生在后续审查或交付环节。"
    : savedNodeCount > 0
      ? `前面 ${savedNodeCount} 个节点的结果已保留；${laterNodes[0]?.label ?? "后续制作"}尚未开始。`
      : `${laterNodes[0]?.label ?? "后续制作"}尚未开始。`;
  const normalized = normalizeFailure(raw, failed, provider);
  const outcomeUncertain = failed.outcomeUncertain === true && !isDefinitiveZeroAttemptFailure(failed);
  return {
    nodeId: failed.id,
    nodeLabel: failed.label,
    category: normalized.category,
    summary: normalized.summary,
    impact: preserved,
    retryable: !outcomeUncertain && normalized.retryable,
    recoveryActions: outcomeUncertain
      ? ["先到服务商控制台核对任务状态与账单", "确认没有重复扣费后再决定是否重试"]
      : normalized.recoveryActions,
    savedNodeCount,
    technicalDetail: raw,
  };
}

function isDefinitiveZeroAttemptFailure(node: StudioNode): boolean {
  const receipt = node.executionReceipt;
  return receipt?.billing === "metered"
    && receipt.meteredAttemptCount === 0
    && (receipt.meteredFailedAttemptCount ?? 0) === 0
    && (receipt.actualCostCny ?? 0) === 0;
}

function normalizeFailure(raw: string, node: StudioNode, provider?: string): Pick<StudioRunFailure, "category" | "summary" | "retryable" | "recoveryActions"> {
  const service = provider ?? node.role ?? node.label;
  if (/源素材视觉预检/.test(raw)) {
    return {
      category: /timeout|timed out|超时/i.test(raw) ? "provider_timeout" : "node_failure",
      summary: "生成画面的视觉预检没有完成，已保留本轮画面结果",
      retryable: true,
      recoveryActions: ["在画面步骤切换视觉审片服务或模型后重试", "若服务暂时不可用，可稍后重试画面步骤"],
    };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(raw)) {
    return {
      category: "provider_capacity",
      summary: `${service} 当前请求过多，${node.label}没有生成完成`,
      retryable: true,
      recoveryActions: [`稍后重试${node.label}`, "连续失败时切换同类服务"],
    };
  }
  if (/timeout|timed out|超时/i.test(raw)) {
    return {
      category: "provider_timeout",
      summary: `${service} 在等待时间内没有返回${node.label}结果`,
      retryable: true,
      recoveryActions: [`重试${node.label}`, "连续超时时检查服务状态或切换同类服务"],
    };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api.?key|permission|鉴权|权限/i.test(raw)) {
    return {
      category: "configuration",
      summary: `${service} 的账号、密钥或权限配置不可用`,
      retryable: false,
      recoveryActions: ["到创作设置检查对应服务的密钥与权限", "测试连接成功后再重试"],
    };
  }
  if (/moderation|content.?policy|sensitive information|审核|违规|敏感|rejected by provider/i.test(raw)) {
    return {
      category: "content_policy",
      summary: `${service}没有通过内容安全检查`,
      retryable: false,
      recoveryActions: ["修改该节点的输入内容", "确认人物、品牌与素材权利后重新生成"],
    };
  }
  if (/ENOSPC|no space|disk|ffmpeg|spawn|ECONNREFUSED|network|socket/i.test(raw)) {
    return {
      category: "infrastructure",
      summary: `运行环境没有完成${node.label}`,
      retryable: true,
      recoveryActions: ["检查系统状态和磁盘空间", `环境恢复后重试${node.label}`],
    };
  }
  return {
    category: "node_failure",
    summary: `${node.role ?? "当前角色"}没有完成${node.label}`,
    retryable: true,
    recoveryActions: [`检查${node.label}输入后重试`, "连续失败时切换同类能力"],
  };
}

function buildResultAvailability(
  input: BuildRunObservabilityInput,
  failure: StudioRunFailure | undefined,
): StudioRunResultAvailability {
  if (input.publishPackageAvailable) {
    return { kind: "publish_package", usable: true, label: "发布包已准备", detail: "成片与平台发布资料都已保留。" };
  }
  if (input.videoAvailable) {
    const reviewPassed = input.nodes.some((node) => node.id === "final-review" && node.status === "succeeded");
    const reviewFailed = input.nodes.some((node) =>
      ["technical-review", "visual-review", "final-review"].includes(node.id)
      && (node.status === "failed" || node.status === "rejected" || node.status === "stale"));
    return reviewPassed
      ? { kind: "reviewed_video", usable: true, label: "已有审片成片", detail: "成片已通过终审，发布包尚未生成。" }
      : reviewFailed
        ? { kind: "draft_video", usable: false, label: "成片需修复", detail: "文件仍可预览，但没有通过当前审查，不能作为可发布结果。" }
        : { kind: "draft_video", usable: false, label: "已有待审片成片", detail: failure ? "后置节点失败，文件仍可预览但尚未通过审查。" : "成片正在等待后续审查。" };
  }
  return { kind: "none", usable: false, label: "尚未生成成片", detail: "当前制作还没有可播放的视频文件。" };
}

function latestTimestamp(startedAt: string, nodes: StudioNode[]): string {
  const candidates = nodes.filter((node) => node.status !== "pending" && node.status !== "stale").flatMap((node) => [
    node.startedAt,
    node.finishedAt,
    node.executionReceipt?.startedAt,
    node.executionReceipt?.finishedAt,
  ]).filter((value): value is string => Boolean(value));
  return candidates.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest, startedAt);
}

function activeProcessingSeconds(nodes: StudioNode[], now: string): number {
  return nodes.reduce((total, node) => {
    if (!node.startedAt) return total;
    const end = node.status === "running" ? now : node.finishedAt;
    return end ? total + secondsBetween(node.startedAt, end) : total;
  }, 0);
}

function secondsBetween(start: string, end: string): number {
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration / 1_000)) : 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}
