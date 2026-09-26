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
  { id: "planning", label: "策划定稿", nodeIds: ["brief", "creative-planning", "script", "reference-grammar", "visual-direction"] },
  { id: "assets", label: "素材筹备", nodeIds: ["asset-candidates", "asset-semantic-rank", "assets", "asset-source-review"] },
  { id: "composition", label: "声音与剪辑", nodeIds: ["voice", "render"] },
  { id: "review", label: "审片质检", nodeIds: ["technical-review", "visual-review", "final-review"] },
  { id: "delivery", label: "交付发布", nodeIds: ["publish-package"] },
];

const NODE_ACTIONS: Record<string, string> = {
  brief: "正在核对题目、观众与生产约束",
  "creative-planning": "正在准备当前创作阶段，完成后等待你讨论和确认",
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
  const sourceAssetRejected = input.status === "rejected"
    && input.nodes.some((node) => node.status === "rejected"
      && ["asset-source-review", "assets"].includes(node.id)
      && /源素材视觉预检|试片未通过/.test(node.error ?? ""));
  // 混合状态（任意整体状态下存在未解决 failed 节点）不得隐藏失败说明（R4-07/R5-04）：
  // 真实失败不因整体 rejected/needs_human/费用停点而消失；没有 failed 节点时人工拒绝
  // 继续走拒绝语义，不投影成可重试的技术失败。
  const mixedStateFailure = input.status !== "succeeded"
    && input.nodes.some((node) => node.status === "failed");
  const failure = input.status === "failed" || sourceAssetRejected || mixedStateFailure
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
  // 优先展示真实技术失败：普通人工拒绝（rejected）不得抢占 failed 节点的失败卡片，
  // 否则真实失败的未知结果保护会落到错误的节点上（R5-04）。
  const failed = nodes.find((node) => node.status === "failed")
    ?? nodes.find((node) => node.status === "rejected");
  if (!failed) return undefined;
  const raw = failed.error ?? "当前节点没有返回可用结果。";
  const provider = failed.executionReceipt?.providerLabel ?? failed.plannedExecution?.providerLabel;
  const savedNodeCount = nodes.filter(isCompleted).length;
  const laterNodes = nodes.slice(nodes.indexOf(failed) + 1).filter((node) => node.status === "pending");
  // joint-v1 的构思/脚本/导演方案是创作规划节点内部的阶段：节点失败时已保存的创作
  // 进度仍在工作区里，不能只数“已完成的整节点”让用户以为上游白做了。只声明“已保存”
  // 的部分，不凭节点 ID 点名具体阶段是否完成（R4-06）。
  const preserved = videoAvailable
    ? "成片已保留，可以预览；失败发生在后续审查或交付环节。"
    : failed.id === "creative-planning"
      ? "已保存的创作进度保留在创作规划工作区，可逐项查看。"
      : savedNodeCount > 0
        ? `前面 ${savedNodeCount} 个节点的结果已保留；${laterNodes[0]?.label ?? "后续制作"}尚未开始。`
        : `${laterNodes[0]?.label ?? "后续制作"}尚未开始。`;
  const normalized = normalizeFailure(raw, failed, provider);
  // 未知扣费结果完全服从核心：核心保留 outcomeUncertain 时，展示层不得用
  // “零次/零成本回执”抵消后开放普通重试（R3-08）。
  const outcomeUncertain = failed.outcomeUncertain === true;
  return {
    nodeId: failed.id,
    nodeLabel: failed.label,
    category: normalized.category,
    summary: normalized.summary,
    impact: preserved,
    retryable: !outcomeUncertain && normalized.retryable,
    ...(!outcomeUncertain && normalized.retryLabel ? { retryLabel: normalized.retryLabel } : {}),
    recoveryActions: outcomeUncertain
      ? ["先到服务商控制台核对任务状态与账单", "确认没有重复扣费后再决定是否重试"]
      : normalized.recoveryActions,
    savedNodeCount,
    // 技术详情只从受控令牌重建（稳定错误码/受控汇总/脱敏格式/白名单诊断尾标），
    // 不透出异常原文（R5-02）。
    ...(buildControlledDetail(raw, failed.id) ?? {}),
  };
}

// 技术详情只从受控令牌重建，任何分支都不再整段放行 raw（R6-01）：
// - 稳定阶段码：worker 定义的 ASSET_SEARCH_SOURCES_UNAVAILABLE；
// - 逐来源原因：完整受控语法（类型枚举/HTTP 状态/受控超时/固定总时限文案），
//   不匹配语法的来源降级为固定「未知原因」；
// - 顶层脱敏格式：仅异常类名；
// - 诊断尾标：键限实际生产者定义的白名单，值按字段校验（枚举/整数/小写标识）。
// 审查发现经结构化审查报告展示，不经 error 关键词认定来源。
// 键与值域按实际生产者（role-agent-loop 的 safeBridgeDiagnostic / CodexBridgeError
// 枚举）定义：stage/failureKind 用其枚举，httpStatus 三位数字，hash 十六进制等。
const DIAGNOSTIC_KEY_SPECS: Record<string, RegExp> = {
  stage: /^(not_accepted|completed_failure|uncertain|rejected|conflict)$/,
  httpStatus: /^\d{3}$/,
  failureKind: /^(model_provider_transient|model_provider_no_output|contract_rejected|binding_conflict)$/,
  reasonCode: /^[a-z0-9_]+$/,
  fieldPath: /^[A-Za-z0-9_.\[\]]+$/,
  taskKind: /^[a-z0-9_-]+$/,
  requestIdHash: /^[a-f0-9]+$/,
  accepted: /^(true|false)$/,
};

const CONTROLLED_REASON_PATTERN = new RegExp([
  "^(RuntimeError|ValueError|TimeoutError|PermissionError|OSError|MissingProviderKey|IsADirectoryError)$",
  // 生产者实际产出两种受控格式：短格式 "HTTP 401"（全失败聚合以 message 优先时不会
  // 出现，但保留兼容）与 public_provider_error_fields 的完整投影 "Provider request
  // failed with HTTP 401"（R7-02）。
  "^(?:HTTP |Provider request failed with HTTP )\\d{3}$",
  "^Provider request timed out after \\d+ attempts$",
].join("|"));

// 固定总时限常量内部含 "；/。"，会被逐来源分段截断为前缀；按前缀识别、以完整常量重建。
const STATIC_TIMEOUT_PREFIX = "素材检索总时限已耗尽";
const STATIC_TIMEOUT_FULL = "素材检索总时限已耗尽；请稍后重试或选择其他来源。";

function rebuildControlledReason(candidate: string): string {
  const http = /^(?:HTTP |Provider request failed with HTTP )(\d{3})$/.exec(candidate);
  if (http) return `HTTP ${http[1]}`;
  if (CONTROLLED_REASON_PATTERN.test(candidate)) return candidate;
  if (candidate.startsWith(STATIC_TIMEOUT_PREFIX)) return STATIC_TIMEOUT_FULL;
  return "未知原因";
}

function buildControlledDetail(raw: string, nodeId: string): { technicalDetail: string } | undefined {
  void nodeId;
  const parts: string[] = [];
  const stageCode = /ASSET_SEARCH_SOURCES_UNAVAILABLE/.exec(raw);
  if (stageCode) parts.push(stageCode[0]);
  for (const match of raw.matchAll(/([A-Za-z0-9-]+-v\d+)：([^，。；;、\n()（）]+)/g)) {
    const source = match[1]!;
    parts.push(`${source}：${rebuildControlledReason(match[2]!.trim())}`);
  }
  const masked = /媒体处理失败（[A-Za-z]+）/.exec(raw);
  if (masked) parts.push(masked[0]);
  const diagnostics = /诊断：([^\n]*)/.exec(raw);
  if (diagnostics) {
    const pairs: string[] = [];
    for (const segment of diagnostics[1]!.split("；")) {
      const pair = /^([A-Za-z][A-Za-z0-9]*)=([^=]+)$/.exec(segment.trim());
      if (!pair) continue;
      const key = pair[1]!;
      // 只认白名单的自有属性：constructor/toString 等继承键必须整对丢弃，
      // 否则取到原型函数会让投影本身抛错（R7-01）。
      if (!Object.prototype.hasOwnProperty.call(DIAGNOSTIC_KEY_SPECS, key)) continue;
      const pattern = DIAGNOSTIC_KEY_SPECS[key];
      // 值不满足该字段的校验——整对丢弃（fail closed）。
      if (!pattern || !pattern.test(pair[2]!.trim())) continue;
      pairs.push(`${key}=${pair[2]!.trim()}`);
    }
    if (pairs.length) parts.push(`诊断：${pairs.join("；")}`);
  }
  if (!parts.length) return undefined;
  return { technicalDetail: parts.join("；") };
}

function normalizeFailure(raw: string, node: StudioNode, provider?: string): Pick<StudioRunFailure, "category" | "summary" | "retryable" | "retryLabel" | "recoveryActions"> {
  const materialFailure = node.output && typeof node.output === "object" && "sourceMediaFailure" in node.output
    ? node.output.sourceMediaFailure : undefined;
  if (node.id === "asset-source-review" && materialFailure && typeof materialFailure === "object"
    && "code" in materialFailure && materialFailure.code === "SOURCE_RANGE_TOO_SHORT"
    && "scenePositions" in materialFailure && Array.isArray(materialFailure.scenePositions)
    && materialFailure.scenePositions.length > 0 && materialFailure.scenePositions.length <= 24
    && materialFailure.scenePositions.every(position => Number.isInteger(position) && position > 0 && position <= 10_000)) {
    const canRematch = "canRematch" in materialFailure && materialFailure.canRematch === true;
    return { category: "node_failure",
      summary: `第 ${materialFailure.scenePositions.join("、")} 镜素材长度不够，不能覆盖已确认的镜头时段`,
      retryable: canRematch,
      ...(canRematch ? { retryLabel: "重新匹配过短素材" } : {}),
      recoveryActions: canRematch
        ? ["保留合格素材和上游方案，从已允许的免费来源重新匹配；更换后由你确认", "这次在本地素材检查时停止，没有提交审片模型"]
        : ["调整该镜素材或剪辑方案；如需新购买，仍要确认费用", "更换审片模型不能修复素材长度不足"],
    };
  }
  const service = provider ?? node.role ?? node.label;
  const planningHalt = node.id === "creative-planning"
    ? /Joint creative planning stopped \((needs_user|needs_source|duplicate_issue|cross_role_revisions_exhausted)\):/.exec(raw)
    : null;
  if (planningHalt) {
    if (planningHalt[1] === "needs_source") {
      return {
        category: "node_failure",
        summary: "真实素材目前不可得，自动规划已停下等待人工选择",
        retryable: false,
        recoveryActions: [
          "上传或实拍可追溯的真实素材后重新规划",
          "将内容改为不主张实验事实的概念表达后重新规划",
          "停止本次制作",
        ],
      };
    }
    return {
      category: "node_failure",
      summary: planningHalt[1] === "needs_user"
        ? "规划遇到需要你决定的问题，自动执行已暂停"
        : "多轮规划没有取得实质进展，自动执行已停止",
      retryable: false,
      recoveryActions: ["查看规划阶段的问题", "调整输入或方案后重新规划", "停止本次制作"],
    };
  }
  // 导演多轮审计未通过：summary 用固定概要，具体复核意见经可信渠道（agent-loop
  // checkpoint 的 latestAudit/结构化审查记录）展示，不从任意 error 正文截取（R6-01）。
  if (node.id === "visual-direction" && /导演经过\s+\d+\s+轮修改后仍未通过独立审计/.test(raw)) {
    return {
      category: "node_failure",
      summary: "导演方案经过多轮修改仍未通过质量复核；具体复核意见见这一步的审计记录",
      retryable: true,
      recoveryActions: [
        "查看这一步的复核意见，按意见调整视频承诺或画面要求",
        "或准备连续实拍/自有素材后重新规划；已完成的脚本不会自动重跑",
      ],
    };
  }
  const directorBeatFailure = node.id === "visual-direction"
    ? /shots\[(\d+)\]\.temporalBeats/.exec(raw)
    : null;
  if (directorBeatFailure) {
    const scenePosition = Number(directorBeatFailure[1]) + 1;
    return {
      category: "node_failure",
      summary: `导演方案中第 ${scenePosition} 镜的时间描述没有通过结构校验`,
      retryable: true,
      recoveryActions: [
        "重试导演方案；已完成的脚本不会重新生成",
        "若同一镜头再次失败，在导演方案中检查该镜的动作与时长",
      ],
    };
  }
  if (node.id === "visual-review" && /最终双模型审片尚未完成|已完成分支保留/.test(raw)) {
    return {
      category: "node_failure",
      summary: "最终双模型审片只完成了一部分，已保留完成结果",
      retryable: true,
      recoveryActions: ["重试未完成的审片模型分支"],
    };
  }
  if (["asset-source-review", "assets"].includes(node.id) && node.status === "rejected"
    && /源素材视觉预检|试片未通过/.test(raw)) {
    return {
      category: "node_failure",
      summary: "画面审查已完成并发现问题，已保留素材与修改建议",
      retryable: true,
      recoveryActions: ["查看具体镜头的问题与修改建议", "先调整导演方案或替换已有素材；只有确需新生成时才重新报价"],
    };
  }
  if (["asset-source-review", "assets"].includes(node.id) && /试片审查暂未完成/.test(raw)) {
    return {
      category: /timeout|timed out|超时/i.test(raw) ? "provider_timeout" : "node_failure",
      summary: "试片审查没有完成，已生成画面仍会保留",
      retryable: true,
      recoveryActions: ["继续未完成的试片审查", "重试会复用已生成画面，不会重新购买成功素材"],
    };
  }
  if (/源素材视觉预检/.test(raw)) {
    return {
      category: /timeout|timed out|超时/i.test(raw) ? "provider_timeout" : "node_failure",
      summary: "生成画面的视觉预检没有完成，已保留本轮画面结果",
      retryable: true,
      recoveryActions: ["在画面步骤切换视觉审片服务或模型后重试", "若服务暂时不可用，可稍后重试画面步骤"],
    };
  }
  // 素材检索的结构化失败（R4-06/R5-03）：worker 对“全部来源失败”返回稳定错误码
  // ASSET_SEARCH_SOURCES_UNAVAILABLE（message 含逐来源受控失败原因）。joint 与独立
  // asset-candidates 两条路径都会把这个码带进 message，因此这里不按节点 ID 区分。
  // 阶段码只说明“发生于候选检索”；根因按逐来源受控原因分别归类——全部同一原因
  // 才用对应分类，混合或含未知原因一律用中性的基础设施分类，不强行单因归因。
  if (/ASSET_SEARCH_SOURCES_UNAVAILABLE|图库候选检索全部来源失败/.test(raw)) {
    const reasons = [...raw.matchAll(/([A-Za-z0-9-]+-v\d+)：([^，。；;、\n()（）]+)/g)]
      .map((match) => match[2]!.trim());
    const kinds = new Set(reasons.map((reason) => (
      /HTTP 40[13]|MissingProviderKey|unauthori[sz]ed|forbidden/i.test(reason) ? "auth"
      : /HTTP 429|rate.?limit|too many requests|quota/i.test(reason) ? "capacity"
      : /时限|timed? ?out|timeout/i.test(reason) ? "timeout"
      : "other"
    )));
    const only = (kind: "auth" | "capacity" | "timeout" | "other") => kinds.size === 1 && kinds.has(kind);
    const category = only("auth")
      ? "configuration" as const
      : only("capacity")
        ? "provider_capacity" as const
        : only("timeout")
          ? "provider_timeout" as const
          : "infrastructure" as const;
    // 鉴权失败的恢复口径与通用分支一致：配置未处理前，“立即重试”不是有效方案。
    const recoveryActions = category === "configuration"
      ? ["到创作设置补齐失败来源所需的密钥或权限配置，测试连接后再重试本步骤", "通过当前可用的恢复入口继续；工作区中已保存的进度会保留"]
      : category === "provider_capacity"
        ? ["稍后重试本步骤；限流中的来源通常自行恢复", "通过当前可用的恢复入口继续；工作区中已保存的进度会保留"]
        : category === "provider_timeout"
          ? ["稍后重试本步骤；素材检索总时限耗尽通常与网络有关", "通过当前可用的恢复入口继续；工作区中已保存的进度会保留"]
          : [
            "按失败原因逐项检查各来源的失败类型（如密钥、限流、超时）并处理后重试本步骤",
            "通过当前可用的恢复入口继续；工作区中已保存的进度会保留",
          ];
    return {
      category,
      summary: "候选画面检索没有完成：全部启用的素材来源都检索失败，失败来源见下方失败原因",
      retryable: category !== "configuration",
      recoveryActions,
    };
  }
  if (/媒体处理失败（[A-Za-z]+）/.test(raw)) {
    // 顶层脱敏格式覆盖多种原因（协议、输入、环境），不做排他性归因，只给中性事实
    // 与可复现的恢复动作；不承诺无法在此证明的检查点行为。
    return {
      category: "node_failure",
      summary: `${node.label}没有完成：本地处理未返回具体原因，详见下方失败原因`,
      retryable: true,
      recoveryActions: [
        `重试${node.label}；已成功的步骤不会重复执行`,
        "连续失败时保留现场并联系维护者检查运行环境",
      ],
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
  // 布尔值只证明“产物文件存在”；是否仍是当前有效交付物由对应节点的有效完成状态
  // 决定——失效版本的历史文件可查看，但不能冒充当前可发布结果（R3-08，U09）。
  // 过期发布包不得遮住仍然有效的成片结果。
  if (input.publishPackageAvailable && nodeEffectivelyDone(input.nodes, "publish-package")) {
    return { kind: "publish_package", usable: true, label: "发布包已准备", detail: "成片与平台发布资料都已保留。" };
  }
  if (input.videoAvailable) {
    const reviewPassed = nodeEffectivelyDone(input.nodes, "final-review");
    const reviewFailed = input.nodes.some((node) =>
      ["technical-review", "visual-review", "final-review"].includes(node.id)
      && (node.status === "failed" || node.status === "rejected" || node.status === "stale"));
    if (!nodeEffectivelyDone(input.nodes, "render")) {
      return {
        kind: "draft_video",
        usable: false,
        label: "成片已过期",
        detail: "历史成片文件仍可预览，但它对应的结果已失效，需要重新生成后才能进入审查。",
      };
    }
    return reviewPassed
      ? { kind: "reviewed_video", usable: true, label: "已有审片成片", detail: "成片已通过终审，发布包尚未生成。" }
      : reviewFailed
        ? { kind: "draft_video", usable: false, label: "成片需修复", detail: "文件仍可预览，但没有通过当前审查，不能作为可发布结果。" }
        : { kind: "draft_video", usable: false, label: "已有待审片成片", detail: failure ? "后置节点失败，文件仍可预览但尚未通过审查。" : "成片正在等待后续审查。" };
  }
  if (input.publishPackageAvailable) {
    return {
      kind: "publish_package",
      usable: false,
      label: "发布包已过期",
      detail: "历史发布包文件仍可查看，但它对应的结果已失效，不能作为当前交付物。",
    };
  }
  return { kind: "none", usable: false, label: "尚未生成成片", detail: "当前制作还没有可播放的视频文件。" };
}

function nodeEffectivelyDone(nodes: StudioNode[], nodeId: string): boolean {
  // 与核心 isEffectivelyDone 同一有效性口径：成功状态、输入/输出未失效、已存在的
  // 版本状态能解析出有效版本（R4-07）。
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.status !== "succeeded") return false;
  if (node.inputState?.stale === true || node.outputState?.stale === true) return false;
  if (node.inputState && !node.inputState.versions.some((version) => version.id === node.inputState!.effectiveVersionId)) return false;
  if (node.outputState && !node.outputState.versions.some((version) => version.id === node.outputState!.effectiveVersionId)) return false;
  return true;
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
