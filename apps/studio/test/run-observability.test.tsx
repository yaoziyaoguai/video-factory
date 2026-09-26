import { describe, expect, it } from "vitest";
import type { StudioNode, StudioRunStatus } from "../src/shared/api.js";
import { buildRunObservability } from "../src/server/run-observability.js";

function node(
  id: string,
  label: string,
  status: StudioNode["status"],
  overrides: Partial<StudioNode> = {},
): StudioNode {
  return {
    id,
    label,
    status,
    artifactIds: [],
    qualityGateResults: [],
    ...overrides,
  };
}

describe("run observability", () => {
  it("offers stock rematching for short material instead of retrying or changing review models", () => {
    const result = buildRunObservability({ status: "failed", startedAt: "2026-09-26T08:39:00Z", now: "2026-09-26T08:40:00Z",
      nodes: [node("assets", "画面", "succeeded"), node("asset-source-review", "预检", "failed", {
        error: "第 3 镜素材过短。",
        output: { sourceMediaFailure: { code: "SOURCE_RANGE_TOO_SHORT", scenePositions: [3], canRematch: true } },
      })], videoAvailable: false, publishPackageAvailable: false });
    expect(result.failure).toMatchObject({ summary: "第 3 镜素材长度不够，不能覆盖已确认的镜头时段",
      retryable: true, retryLabel: "重新匹配过短素材" });
    expect(result.failure?.recoveryActions.join("；")).not.toMatch(/切换.*模型|稍后重试/);
  });

  it("groups the production line into five creator-facing phases and reports truthful progress", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded", { startedAt: "2026-08-30T10:00:00.000Z", finishedAt: "2026-08-30T10:00:10.000Z" }),
        node("script", "脚本", "succeeded", { startedAt: "2026-08-30T10:00:10.000Z", finishedAt: "2026-08-30T10:01:00.000Z" }),
        node("assets", "画面", "running", { startedAt: "2026-08-30T10:01:00.000Z", role: "素材导演" }),
        node("voice", "配音", "pending"),
        node("render", "渲染", "pending"),
        node("technical-review", "机器质检", "pending"),
        node("publish-package", "发布包", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.phases.map((phase) => phase.label)).toEqual([
      "策划定稿",
      "素材筹备",
      "声音与剪辑",
      "审片质检",
      "交付发布",
    ]);
    expect(result.progress).toMatchObject({
      completedNodes: 2,
      totalNodes: 7,
      percentage: 29,
      elapsedSeconds: 120,
      currentNodeElapsedSeconds: 60,
      etaUnavailableReason: "insufficient_history",
    });
    expect(result.currentAction).toMatchObject({
      nodeId: "assets",
      role: "素材导演",
      label: "正在组织逐镜画面并核对素材来源",
    });
  });

  it("excludes human waiting and stale historical timestamps from processing time", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-31T10:00:20.000Z",
      nodes: [
        node("script", "脚本", "succeeded", {
          startedAt: "2026-08-30T10:00:00.000Z",
          finishedAt: "2026-08-30T10:00:40.000Z",
        }),
        node("visual-direction", "导演方案", "running", {
          startedAt: "2026-08-31T10:00:00.000Z",
        }),
        node("final-review", "人工终审", "pending", {
          startedAt: "2026-08-30T10:05:00.000Z",
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.elapsedSeconds).toBe(60);
    expect(result.progress.currentNodeElapsedSeconds).toBe(20);
    expect(result.progress.lastUpdatedAt).toBe("2026-08-31T10:00:00.000Z");
    expect(result.currentAction?.nodeId).toBe("visual-direction");
  });

  it("describes the script node as a producer and independent-auditor loop", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [node("script", "脚本", "running", {
        role: "编剧",
        plannedExecution: {
          providerId: "codex-screenwriter-v1",
          providerLabel: "Codex 编剧",
          modelId: "gpt-5.6-sol",
          transport: "unix_socket",
          billing: "subscription",
          snapshotSource: "created",
        },
      })],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.currentAction?.label).toBe("编剧正在根据独立复核意见修改脚本，最多 3 轮");
  });

  it("does not claim an Agent audit for the local template script provider", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [node("script", "脚本", "running", {
        role: "编剧",
        plannedExecution: {
          providerId: "python-template-v1",
          providerLabel: "模板脚本",
          modelId: "rule-template",
          transport: "local_process",
          billing: "free",
          snapshotSource: "created",
        },
      })],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.currentAction?.label).toBe("编剧正在生成结构化脚本");
  });

  it("only exposes an ETA range when every remaining node has enough historical evidence", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:00:30.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded", { finishedAt: "2026-08-30T10:00:10.000Z" }),
        node("voice", "配音", "running", { startedAt: "2026-08-30T10:00:10.000Z" }),
        node("render", "渲染", "pending"),
      ],
      historicalNodeDurations: {
        voice: [40, 50, 60],
        render: [90, 100, 110],
      },
      manualReview: false,
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.eta).toEqual({ lowSeconds: 104, highSeconds: 156, sampleSize: 6 });
    expect(result.progress.etaUnavailableReason).toBeUndefined();
  });

  it("does not estimate across a future human review gate", () => {
    const result = buildRunObservability({
      status: "running",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:00:10.000Z",
      nodes: [
        node("render", "渲染", "running", { startedAt: "2026-08-30T10:00:00.000Z" }),
        node("final-review", "人工终审", "pending"),
      ],
      historicalNodeDurations: { render: [20, 30, 40], "final-review": [5, 5, 5] },
      manualReview: true,
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.progress.eta).toBeUndefined();
    expect(result.progress.etaUnavailableReason).toBe("future_human_gate");
  });

  it("turns a provider failure into cause, impact, preserved work, and a safe recovery route", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:03:00.000Z",
      now: "2026-08-30T10:04:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("voice", "配音", "failed", {
          role: "声音导演",
          error: "HTTP 429 rate limit exceeded",
          executionReceipt: {
            providerId: "minimax-speech-v1",
            providerLabel: "MiniMax Speech",
            modelId: "speech-02-hd",
            transport: "http_api",
            billing: "metered",
            status: "failed",
            startedAt: "2026-08-30T10:02:00.000Z",
            finishedAt: "2026-08-30T10:03:00.000Z",
            meteredAttemptCount: 1,
          },
        }),
        node("render", "渲染", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "voice",
      category: "provider_capacity",
      retryable: true,
      savedNodeCount: 1,
      summary: "MiniMax Speech 当前请求过多，配音没有生成完成",
    });
    expect(result.failure?.impact).toContain("渲染尚未开始");
    expect(result.failure?.recoveryActions).toContain("稍后重试配音");
  });

  it("explains a media-worker failure as an environment fault, not a creative input problem", () => {
    // DF-04：候选检索的 Python worker 故障（如 OSError）以前落进通用兜底，被建议
    // “检查输入后重试/切换同类能力”，与真实失败原因无关。
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-21T13:40:00.000Z",
      finishedAt: "2026-09-21T13:42:54.000Z",
      now: "2026-09-21T13:43:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded"),
        node("creative-planning", "创作规划", "failed", {
          role: "创作规划制片",
          error: "Joint creative planning candidate search failed: 媒体处理失败（OSError），请查看本次任务对应的阶段诊断记录。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "creative-planning",
      category: "node_failure",
      retryable: true,
    });
    expect(result.failure?.summary).toContain("本地处理未返回具体原因");
    expect(result.failure?.impact).toContain("已保存的创作进度");
    const actions = result.failure?.recoveryActions.join("；") ?? "";
    expect(actions).not.toContain("切换");
    expect(actions).toContain("重试");
  });

  it("keeps routing a wrapped auth failure to configuration instead of infrastructure", () => {
    // 上游若把鉴权错误包进 candidate search 前缀，仍必须命中既有的密钥配置指引，
    // 不能被素材检索分支的文案覆盖（Oracle 审查 U05）。
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-21T13:40:00.000Z",
      finishedAt: "2026-09-21T13:42:54.000Z",
      now: "2026-09-21T13:43:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded"),
        node("creative-planning", "创作规划", "failed", {
          role: "创作规划制片",
          error: "Joint creative planning candidate search failed: HTTP 401 invalid API key",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure?.category).toBe("configuration");
    expect(result.failure?.summary).toContain("密钥");
  });

  it("surfaces the named failing stock sources from an all-sources candidate search failure", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-21T13:40:00.000Z",
      finishedAt: "2026-09-21T13:42:54.000Z",
      now: "2026-09-21T13:43:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded"),
        node("creative-planning", "创作规划", "failed", {
          role: "创作规划制片",
          error: "Joint creative planning candidate search failed: 图库候选检索全部来源失败（pexels-stock-v1：OSError、pixabay-stock-v1：PermissionError）。请检查这些素材来源的服务状态与网络后重试本步骤；已确认的构思、脚本与导演方案不会重跑。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({ category: "infrastructure", retryable: true });
    expect(result.failure?.summary).toContain("素材来源");
    expect(result.failure?.technicalDetail).toContain("pixabay-stock-v1：PermissionError");
  });

  it("explains a director contract failure with the affected scene and a concrete recovery", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:03:00.000Z",
      now: "2026-08-30T10:03:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("visual-direction", "导演方案", "failed", {
          role: "导演",
          error: "导演连续两次返回了无法使用的结果；本轮质量审计尚未消耗，可从已保存进度继续。shots[6].temporalBeats must contain at least two timed beats.",
        }),
        node("asset-candidates", "素材候选", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "visual-direction",
      summary: "导演方案中第 7 镜的时间描述没有通过结构校验",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "重试导演方案；已完成的脚本不会重新生成",
      "若同一镜头再次失败，在导演方案中检查该镜的动作与时长",
    ]);
  });

  it("surfaces the final director audit reason and routes an unfulfillable promise upstream", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:10:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("visual-direction", "导演方案", "failed", {
          role: "导演",
          error: "导演经过 2 轮修改后仍未通过独立审计。核心承诺要求同机位连续实验，但当前图库镜头无法兑现。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    // 复核意见本身经可信渠道（这一步的审计记录/latestAudit）展示；summary 是固定
    // 概要，不截取任意 error 正文（R6-01）。
    expect(result.failure?.summary).toContain("导演方案经过多轮修改仍未通过质量复核");
    expect(result.failure?.summary).not.toContain("核心承诺要求同机位连续实验");
    expect(result.failure?.recoveryActions).toEqual([
      "查看这一步的复核意见，按意见调整视频承诺或画面要求",
      "或准备连续实拍/自有素材后重新规划；已完成的脚本不会自动重跑",
    ]);
  });

  it("treats a repeated real-source availability stop as a manual gate instead of a retryable failure", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      now: "2026-08-30T10:16:00.000Z",
      nodes: [
        node("creative-planning", "创作规划", "failed", {
          role: "创作团队",
          error: "Joint creative planning stopped (needs_source): 连续两轮仍缺少可自动采用的真实图库素材，自动规划已停止。上传或实拍可追溯的真实素材；若不再主张实证，可改为非实证概念表达；也可以停止本次制作。AI 生成画面不能冒充真实实验证据。 不回退旧规划流程。",
        }),
        node("assets", "画面", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "creative-planning",
      retryable: false,
      summary: "真实素材目前不可得，自动规划已停下等待人工选择",
    });
    expect(result.failure?.recoveryActions).toEqual([
      "上传或实拍可追溯的真实素材后重新规划",
      "将内容改为不主张实验事实的概念表达后重新规划",
      "停止本次制作",
    ]);
  });

  it("marks a preserved render as a usable partial result when a later review fails", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("technical-review", "机器质检", "failed", { error: "audio loudness check failed" }),
        node("final-review", "人工终审", "pending"),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.resultAvailability).toMatchObject({
      kind: "draft_video",
      usable: false,
      label: "成片需修复",
    });
    expect(result.failure?.impact).toContain("成片已保留");
  });

  it("explains a source-asset visual gate failure as a review failure with an editable recovery", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("assets", "画面", "failed", { error: "源素材视觉预检服务暂时不可用。已保留生成结果，请重试素材步骤或更换视觉审片模型。" }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "生成画面的视觉预检没有完成，已保留本轮画面结果",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toContain("在画面步骤切换视觉审片服务或模型后重试");
  });

  it("projects an automated source-asset rejection as a recoverable failure, not a human final decision", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("assets", "画面", "succeeded"),
        node("asset-source-review", "生成画面预检", "rejected", {
          error: "源素材视觉预检未通过。镜头 2：主体动作与导演方案不一致。请调整导演方案后重新生成。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "asset-source-review",
      summary: "画面审查已完成并发现问题，已保留素材与修改建议",
      retryable: true,
    });
    expect(result.failure?.impact).toContain("配音尚未开始");
    expect(result.failure?.recoveryActions.join(" ")).not.toContain("切换视觉审片服务");
  });

  it("projects an in-node pilot rejection instead of hiding it behind the rejected run status", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("script", "脚本", "succeeded"),
        node("assets", "画面", "rejected", {
          error: "镜头 2 试片未通过，已停止后续付费生成。已保留试片与审查报告。人物动作与旁白相反。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "画面审查已完成并发现问题，已保留素材与修改建议",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "查看具体镜头的问题与修改建议",
      "先调整导演方案或替换已有素材；只有确需新生成时才重新报价",
    ]);
  });

  it("explains that an interrupted pilot review can continue without buying the generated shot again", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:02:00.000Z",
      now: "2026-08-30T10:02:00.000Z",
      nodes: [
        node("assets", "画面", "failed", {
          error: "镜头 2 已生成，但试片审查暂未完成，后续付费生成已停止。重试时会复用该镜头并恢复审查。连接超时。",
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "assets",
      summary: "试片审查没有完成，已生成画面仍会保留",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual([
      "继续未完成的试片审查",
      "重试会复用已生成画面，不会重新购买成功素材",
    ]);
  });

  it("explains a partial final dual review as one remaining subscription review branch", () => {
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("visual-review", "视觉审片", "failed", {
          error: "最终双模型审片尚未完成：gpt-5.6-sol 暂时不可用。已完成分支保留，重试只继续未完成分支。",
        }),
        node("final-review", "人工终审", "pending"),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.failure).toMatchObject({
      nodeId: "visual-review",
      summary: "最终双模型审片只完成了一部分，已保留完成结果",
      retryable: true,
    });
    expect(result.failure?.recoveryActions).toEqual(["重试未完成的审片模型分支"]);
    expect(result.failure?.impact).toContain("成片已保留");
  });

  it("does not ask for billing reconciliation when the provider returned a known content-policy rejection", () => {
    // 已知结果（provider 明确返回内容策略拒绝，核心已结清 outcomeUncertain）按普通
    // 内容问题恢复，不进入账单核对。
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:01:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [
        node("assets", "画面", "failed", {
          role: "素材导演",
          error: "The input text may contain sensitive information.",
          executionReceipt: {
            providerId: "seedream-image-v1",
            providerLabel: "Seedream 关键画面",
            modelId: "doubao-seedream-test",
            transport: "http_api",
            billing: "metered",
            status: "failed",
            actualCostCny: 0,
            actualCostSource: "configured_rate",
            meteredAttemptCount: 0,
            meteredFailedAttemptCount: 0,
            startedAt: "2026-08-30T10:00:00.000Z",
            finishedAt: "2026-08-30T10:01:00.000Z",
          },
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure?.recoveryActions).not.toContain("先到服务商控制台核对任务状态与账单");
    expect(result.failure).toMatchObject({
      category: "content_policy",
      summary: "Seedream 关键画面没有通过内容安全检查",
    });
    expect(result.failure?.recoveryActions).toContain("修改该节点的输入内容");
  });

  it("keeps an outcome-uncertain metered failure gated behind reconciliation even with a zero-attempt receipt", () => {
    // R3-08：核心对 providerOutcomeKnown=false 保留未知结果；展示层不得用零回执
    // 抵消后开放普通重试。
    const result = buildRunObservability({
      status: "failed",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:01:00.000Z",
      now: "2026-08-30T10:01:00.000Z",
      nodes: [
        node("assets", "画面", "failed", {
          role: "素材导演",
          outcomeUncertain: true,
          error: "connection reset while submitting the shot",
          executionReceipt: {
            providerId: "seedream-image-v1",
            providerLabel: "Seedream 关键画面",
            modelId: "doubao-seedream-test",
            transport: "http_api",
            billing: "metered",
            status: "failed",
            actualCostCny: 0,
            actualCostSource: "configured_rate",
            meteredAttemptCount: 0,
            meteredFailedAttemptCount: 0,
            startedAt: "2026-08-30T10:00:00.000Z",
            finishedAt: "2026-08-30T10:01:00.000Z",
          },
        }),
        node("voice", "配音", "pending"),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    expect(result.failure?.retryable).toBe(false);
    expect(result.failure?.recoveryActions).toContain("先到服务商控制台核对任务状态与账单");
  });

  it("does not present a stale publish package or render as the current deliverable (U09)", () => {
    // 过期发布包不得遮住仍然有效的成片：当前交付投影落到有效成片分支。
    const stalePublishValidVideo = buildRunObservability({
      status: "stale",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("publish-package", "发布包", "stale", {
          outputState: { generatedVersionId: "pkg-v1", effectiveVersionId: "pkg-v1", stale: true, versions: [] },
        }),
      ],
      videoAvailable: true,
      publishPackageAvailable: true,
    });
    expect(stalePublishValidVideo.resultAvailability.kind).toBe("draft_video");
    expect(stalePublishValidVideo.resultAvailability.usable).toBe(false);
    expect(stalePublishValidVideo.resultAvailability.label).not.toContain("发布包");

    // 成片与发布包都失效且没有有效成片可显示时，才显示过期发布包。
    const stalePublishStaleRender = buildRunObservability({
      status: "stale",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "stale", {
          outputState: { generatedVersionId: "render-v1", effectiveVersionId: "render-v1", stale: true, versions: [] },
        }),
        node("publish-package", "发布包", "stale", {
          outputState: { generatedVersionId: "pkg-v1", effectiveVersionId: "pkg-v1", stale: true, versions: [] },
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: true,
    });
    expect(stalePublishStaleRender.resultAvailability).toMatchObject({
      kind: "publish_package",
      usable: false,
      label: "发布包已过期",
    });

    const staleRender = buildRunObservability({
      status: "stale",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "stale", {
          outputState: { generatedVersionId: "render-v1", effectiveVersionId: "render-v1", stale: true, versions: [] },
        }),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });
    expect(staleRender.resultAvailability).toMatchObject({
      kind: "draft_video",
      usable: false,
      label: "成片已过期",
    });

    // 有效产物不被误禁：render 有效且后置审查失败时仍是可预览的待审成片。
    const validRender = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("visual-review", "视觉审片", "failed", { error: "连接超时" }),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });
    expect(validRender.resultAvailability).toMatchObject({ kind: "draft_video", usable: false, label: "成片需修复" });
  });

  it("keeps human rejection separate from technical failure in mixed states (R4-07)", () => {
    // 终审人工拒绝不是技术失败：混合状态下也不投影成可重试故障。
    const humanReject = buildRunObservability({
      status: "stale",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("final-review", "人工终审", "rejected"),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });
    expect(humanReject.failure).toBeUndefined();

    // 但未解决的 failed 节点在任何整体状态下都保持失败说明可见。
    const mixedFailure = buildRunObservability({
      status: "needs_human",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("brief", "内容简报", "needs_human"),
        node("assets", "画面", "failed", { error: "连接被重置" }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });
    expect(mixedFailure.failure).toMatchObject({ nodeId: "assets" });
  });

  it("never echoes injected secrets through failure detail fields (R5-02)", () => {
    const secret = "SECRET_MARKER sk-injected-key https://internal.example/path";
    // 稳定码后拼接注入内容：technicalDetail 只保留受控令牌。
    const coded = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("brief", "内容简报", "succeeded"),
        node("creative-planning", "创作规划", "failed", {
          error: `图库候选检索全部来源失败（pexels-stock-v1：PermissionError、pixabay-stock-v1：RuntimeError）。工作区中已保存的进度会保留。${secret} [ASSET_SEARCH_SOURCES_UNAVAILABLE]`,
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });
    const codedDetail = coded.failure?.technicalDetail ?? "";
    expect(codedDetail).not.toContain("SECRET_MARKER");
    expect(codedDetail).not.toContain("sk-injected-key");
    expect(codedDetail).toContain("pexels-stock-v1：PermissionError");
    expect(codedDetail).toContain("ASSET_SEARCH_SOURCES_UNAVAILABLE");

    // 诊断尾标后拼接注入内容：尾标只提取白名单键值对。
    const diagnosed = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("script", "脚本", "failed", {
          error: `模型调用超时\n诊断：stage=completed_failure；reasonCode=provider_timeout${secret}`,
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });
    const diagnosedDetail = diagnosed.failure?.technicalDetail ?? "";
    expect(diagnosedDetail).toContain("stage=completed_failure");
    expect(diagnosedDetail).not.toContain("SECRET_MARKER");

    // 审查节点的非审片异常不享受整段透出。
    const reviewInjected = buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("visual-review", "视觉审片", "failed", { error: secret }),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });
    expect(reviewInjected.failure?.technicalDetail).toBeUndefined();
  });

  it("keeps the observability projection itself from throwing on inherited diagnostic keys (R7-01)", () => {
    for (const injectedKey of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const result = buildRunObservability({
        status: "failed",
        startedAt: "2026-09-20T10:00:00.000Z",
        now: "2026-09-20T10:05:00.000Z",
        nodes: [
          node("script", "脚本", "failed", {
            error: `模型调用超时\n诊断：stage=completed_failure；${injectedKey}=secret_marker`,
          }),
        ],
        videoAvailable: false,
        publishPackageAvailable: false,
      });
      const detail = result.failure?.technicalDetail ?? "";
      expect(result.failure?.nodeId).toBe("script");
      expect(detail).toContain("stage=completed_failure");
      expect(detail).not.toContain(injectedKey);
      expect(detail).not.toContain("secret_marker");
    }
  });

  it("shows producer-format HTTP and total-timeout reasons instead of unknown (R7-02)", () => {
    const build = (summaryPart: string) => buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("creative-planning", "创作规划", "failed", {
          error: `Joint creative planning candidate search failed: 图库候选检索全部来源失败（${summaryPart}）。请按各来源的失败类型处理后重试。 [ASSET_SEARCH_SOURCES_UNAVAILABLE]`,
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    // 生产者实际格式：public_provider_error_fields 的完整投影。
    const producerHttp = build("pexels-stock-v1：Provider request failed with HTTP 401");
    expect(producerHttp.failure?.category).toBe("configuration");
    expect(producerHttp.failure?.technicalDetail).toContain("HTTP 401");
    expect(producerHttp.failure?.technicalDetail).not.toContain("未知原因");

    // 总时限常量被分段截断为前缀：按前缀识别并以完整常量重建。
    const producerTimeout = build("pexels-stock-v1：素材检索总时限已耗尽");
    expect(producerTimeout.failure?.category).toBe("provider_timeout");
    expect(producerTimeout.failure?.technicalDetail).toContain("素材检索总时限已耗尽");
    expect(producerTimeout.failure?.technicalDetail).not.toContain("未知原因");

    // 未知原因保持中性降级。
    const unknown = build("pexels-stock-v1：something unparseable happened");
    expect(unknown.failure?.technicalDetail).toContain("pexels-stock-v1：未知原因");
  });

  it("classifies all-sources candidate failures per reason and neutralises mixed causes (R5-03)", () => {
    const build = (summaryPart: string) => buildRunObservability({
      status: "failed",
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("creative-planning", "创作规划", "failed", {
          error: `Joint creative planning candidate search failed: 图库候选检索全部来源失败（${summaryPart}）。请按各来源的失败类型处理后重试。 [ASSET_SEARCH_SOURCES_UNAVAILABLE]`,
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    // 单一鉴权原因 → configuration 且不可直接重试（与通用鉴权口径一致）。
    const auth = build("pexels-stock-v1：MissingProviderKey、pixabay-stock-v1：RuntimeError/HTTP 401");
    expect(auth.failure).toMatchObject({ category: "configuration", retryable: false });

    // 单一限流原因 → provider_capacity。
    const capacity = build("pexels-stock-v1：RuntimeError/HTTP 429");
    expect(capacity.failure).toMatchObject({ category: "provider_capacity", retryable: true });

    // 单一超时原因（受控超时身份保留）→ provider_timeout。
    const timeout = build("pexels-stock-v1：Provider request timed out after 2 attempts");
    expect(timeout.failure).toMatchObject({ category: "provider_timeout", retryable: true });

    // 混合原因 → 中性 infrastructure，不强行单因归因。
    const mixed = build("pexels-stock-v1：RuntimeError/HTTP 401、pixabay-stock-v1：RuntimeError/HTTP 429");
    expect(mixed.failure).toMatchObject({ category: "infrastructure", retryable: true });
  });

  it("projects the real failed node even when a human rejection precedes it (R5-04)", () => {
    const build = (status: StudioRunStatus) => buildRunObservability({
      status,
      startedAt: "2026-09-20T10:00:00.000Z",
      now: "2026-09-20T10:05:00.000Z",
      nodes: [
        node("final-review", "人工终审", "rejected"),
        node("assets", "画面", "failed", {
          outcomeUncertain: true,
          error: "connection reset while submitting the shot",
        }),
      ],
      videoAvailable: false,
      publishPackageAvailable: false,
    });

    // 整体 rejected 下真实 failed 仍可见，且指向 failed 节点。
    for (const status of ["rejected", "needs_human", "awaiting_spend_approval", "stale", "paused"] as const) {
      const result = build(status);
      expect(result.failure?.nodeId).toBe("assets");
    }
    // 未知结果保护跟随真实失败节点：零回执也不抵消。
    const uncertain = build("rejected");
    expect(uncertain.failure?.retryable).toBe(false);
    expect(uncertain.failure?.recoveryActions).toContain("先到服务商控制台核对任务状态与账单");
  });

  it("keeps an explicit human rejection separate from a system failure", () => {
    const result = buildRunObservability({
      status: "rejected",
      startedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:05:00.000Z",
      now: "2026-08-30T10:05:00.000Z",
      nodes: [
        node("render", "渲染", "succeeded"),
        node("final-review", "人工终审", "rejected", { error: "开场节奏需要更紧" }),
      ],
      videoAvailable: true,
      publishPackageAvailable: false,
    });

    expect(result.failure).toBeUndefined();
    expect(result.resultAvailability).toMatchObject({ kind: "draft_video", usable: false });
  });
});
