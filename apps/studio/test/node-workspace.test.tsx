import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioCostDashboard as CostDto, StudioNode, StudioProvider } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { CostDashboard, RunCostDetailPanel } from "../src/client/components/CostDashboard.js";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";

// C2 制作范围授权需要当前方案 digest：工作区测试统一携带一个合法形态的 fixture 值。
const TEST_PLAN_DIGEST = "b".repeat(64);

const succeededNode: StudioNode = {
  id: "script",
  label: "脚本",
  role: "编剧",
  status: "succeeded",
  artifactIds: [],
  qualityGateResults: [],
  output: { hook: "旧钩子" },
  inputState: {
    effectiveVersionId: "input-generated",
    stale: false,
    versions: [{
      id: "input-generated",
      source: "derived",
      value: { brief: { title: "旧题目" } },
      upstreamVersionIds: ["brief-v1"],
      createdAt: "2026-08-27T00:00:00.000Z",
      createdBy: "workflow:script",
      schemaVersion: "script-input-v1",
    }],
  },
  outputState: {
    generatedVersionId: "version-generated",
    effectiveVersionId: "version-generated",
    stale: false,
    versions: [{
      id: "version-generated",
      source: "generated",
      artifactIds: [],
      inputVersionIds: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      createdBy: "codex-screenwriter-v1",
      schemaVersion: "script-v1",
      output: { hook: "旧钩子" },
    }],
  },
  executionReceipt: {
    providerId: "codex-screenwriter-v1",
    providerLabel: "Codex 编剧",
    modelId: "codex",
    transport: "unix_socket",
    billing: "subscription",
    configurationSource: "template_default",
    parameters: { promptPack: "video-factory/screenwriter-v4", temperature: 0.4 },
    status: "succeeded",
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    actualModelIds: ["codex-runtime-actual"],
  },
};

const seedanceProvider: StudioProvider = {
  id: "seedance-video-v1",
  capability: "asset.prepare",
  label: "Seedance 视频生成",
  available: true,
  kind: "external",
  billing: "metered",
  defaultModelId: "seedance-v1",
  modelProfiles: [{
    id: "seedance-v1",
    providerId: "seedance-video-v1",
    providerFamily: "seedance",
    label: "Seedance 1",
    description: "视频生成",
    available: true,
    taskTypes: ["text-to-video"],
  }],
};

const hailuoProvider: StudioProvider = {
  id: "hailuo-video-v1",
  capability: "asset.prepare",
  label: "MiniMax 视频生成",
  available: true,
  kind: "external",
  billing: "metered",
  defaultModelId: "MiniMax-Hailuo-02",
  modelProfiles: [{
    id: "MiniMax-Hailuo-02",
    providerId: "hailuo-video-v1",
    providerFamily: "minimax",
    label: "MiniMax Hailuo 02",
    description: "视频生成",
    available: true,
    taskTypes: ["text-to-video"],
  }],
};

describe("node production workspaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("describes this step's service and model choices in creator language", async () => {
    const providers: StudioProvider[] = [{
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "AI 编剧",
      available: true,
      kind: "external",
      billing: "subscription",
      defaultModelId: "gpt-5.6-terra",
      modelProfiles: [{
        id: "gpt-5.6-terra",
        providerId: "codex-screenwriter-v1",
        providerFamily: "openai",
        label: "GPT-5.6 Terra",
        description: "日常创作",
        available: true,
        taskTypes: ["text"],
      }],
    }, {
      id: "python-template-v1",
      capability: "script.draft",
      label: "模板编剧",
      available: true,
      kind: "local",
    }];
    const node: StudioNode = {
      id: "script",
      label: "脚本",
      role: "编剧",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "codex-screenwriter-v1",
        modelSelections: {},
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    const configuration = screen.getByRole("region", { name: "编剧本次制作选择" });
    expect(within(configuration).getByText("本次制作选择")).toBeInTheDocument();
    expect(configuration).not.toHaveTextContent("本次执行配置");
    await userEvent.click(within(configuration).getByRole("button", { name: "调整" }));
    expect(within(configuration).getByRole("combobox", { name: "制作方式" })).toBeInTheDocument();
    const modelSelect = within(configuration).getByRole("combobox", { name: "首选模型" });
    expect(within(modelSelect).getByRole("option", { name: "使用推荐：GPT-5.6 Terra" })).toBeInTheDocument();
    expect(configuration).not.toHaveTextContent(/执行能力|推荐默认/);
    expect(within(configuration).getByRole("button", { name: "保存选择" })).toBeInTheDocument();
  });

  it("explains real model, audit, validation, and retry timings without exposing the prompt", async () => {
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        parameters: {
          ...succeededNode.executionReceipt!.parameters,
          queueWaitMs: 260,
          providerWaitMs: 12_340,
          firstOutputEventMs: 410,
          providerValidationMs: 7,
          producerMs: 12_600,
          auditMs: 8_200,
          loopValidationMs: 14,
          modelCallCount: 2,
          retryCount: 1,
        },
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:21.000Z",
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      runStatus="succeeded"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByText("这一步为什么用了这些时间"));
    expect(screen.getByText("步骤总耗时").parentElement).toHaveTextContent("21 秒");
    expect(screen.getByText("排队等待").parentElement).toHaveTextContent("不到 1 秒");
    expect(screen.getByText("Provider 执行").parentElement).toHaveTextContent("12 秒");
    expect(screen.getByText("本地处理").parentElement).toHaveTextContent("8.4 秒");
    expect(screen.queryByText("首次响应")).not.toBeInTheDocument();
    expect(screen.queryByText("内容生成累计")).not.toBeInTheDocument();
    expect(screen.queryByText("独立复核累计")).not.toBeInTheDocument();
    expect(screen.getByText("模型调用").parentElement).toHaveTextContent("2 次");
    expect(screen.getByText("自动重试").parentElement).toHaveTextContent("1 次");
    expect(screen.queryByText(/Prompt Pack|screenwriter-v2/)).not.toBeInTheDocument();
  });

  it("separates fallback wait from the final model timing and call count", async () => {
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        actualModelIds: ["glm-5.3", "gpt-5.6-sol"],
        fallbackReason: "前 1 个候选模型调用失败，已自动切换。",
        parameters: {
          ...succeededNode.executionReceipt!.parameters,
          queueWaitMs: 8_000,
          providerWaitMs: 12_000,
          producerMs: 60_000,
          auditMs: 20_000,
          modelCallCount: 2,
        },
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:03:00.000Z",
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    await userEvent.click(screen.getByText("这一步为什么用了这些时间"));
    expect(screen.getByText("排队等待").parentElement).toHaveTextContent("8.0 秒");
    expect(screen.getByText("Provider 执行").parentElement).toHaveTextContent("12 秒");
    expect(screen.getByText("本地处理与候选切换").parentElement).toHaveTextContent("2 分 40 秒");
    expect(screen.getByText("候选切换").parentElement).toHaveTextContent("1 次");
    expect(screen.getByText("最终模型调用").parentElement).toHaveTextContent("2 次");
    expect(screen.queryByText(/^模型调用$/)).not.toBeInTheDocument();
  });

  it("lets a paused node replace an unavailable inherited provider", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const providers: StudioProvider[] = [{
      id: "retired-screenwriter-v1",
      capability: "script.draft",
      label: "已停用编剧",
      available: false,
      kind: "external",
      billing: "subscription",
    }, {
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "AI 编剧",
      available: true,
      kind: "external",
      billing: "subscription",
    }];
    const node: StudioNode = {
      id: "script",
      label: "脚本",
      role: "编剧",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "retired-screenwriter-v1",
        modelSelections: {},
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={onConfigure}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    const providerSelect = screen.getByRole("combobox", { name: "制作方式" });
    expect(providerSelect).toBeEnabled();
    expect(within(providerSelect).getByRole("option", { name: "已停用编剧（已失效）" })).toBeDisabled();
    await userEvent.selectOptions(providerSelect, "codex-screenwriter-v1");
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

    expect(onConfigure).toHaveBeenCalledWith("script", {
      expectedRunRevision: 2,
      providerId: "codex-screenwriter-v1",
      modelSelections: { "codex-screenwriter-v1": null },
    });
  });

  it("only offers provider models compatible with the current node", async () => {
    const providers: StudioProvider[] = [{
      id: "wan-video-v1",
      capability: "asset.prepare",
      label: "百炼 · 通义万相视频",
      available: true,
      kind: "external",
      billing: "metered",
      defaultModelId: "wan3.0-video",
      modelProfiles: [
        { id: "wan3.0-video", providerId: "wan-video-v1", providerFamily: "dashscope-video", label: "Wan 3.0", description: "文生视频", available: true, taskTypes: ["text-to-video"], estimatedCnyPerClip: 3 },
        { id: "wan2.7-i2v", providerId: "wan-video-v1", providerFamily: "dashscope-video", label: "Wan 2.7 图生视频", description: "需要首帧图片", available: true, taskTypes: ["image-to-video"], estimatedCnyPerClip: 3 },
      ],
    }];
    const node: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "ai-shot-router-v1",
        modelSelections: { "wan-video-v1": "wan3.0-video" },
        assetProviderIds: ["wan-video-v1"],
        economics: { allowMeteredProviders: true },
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    const modelSelect = screen.getByRole("combobox", { name: "百炼 · 通义万相视频模型" });
    expect(within(modelSelect).getByRole("option", { name: "Wan 3.0" })).toBeInTheDocument();
    expect(within(modelSelect).queryByRole("option", { name: "Wan 2.7 图生视频" })).not.toBeInTheDocument();
  });

  it("lets a paused asset node enable paid generation without forcing a video ceiling", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const providers: StudioProvider[] = [
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels", available: true, kind: "external", billing: "free" },
      { id: "seedance-video-v1", capability: "asset.prepare", label: "Seedance", available: true, kind: "external", billing: "metered", estimatedCnyPerClip: 3 },
    ];
    const node: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "ai-shot-router-v1",
        modelSelections: {},
        assetProviderIds: ["pexels-stock-v1"],
        economics: { allowMeteredProviders: false },
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={onConfigure}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Seedance/ }));
    expect(screen.queryByRole("spinbutton", { name: "付费镜头上限（可选）" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "单视频费用上限（可选）" })).not.toBeInTheDocument();
    expect(screen.getByText(/按实际导演方案报价.*逐笔人工确认/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

    expect(onConfigure).toHaveBeenCalledWith("assets", {
      expectedRunRevision: 2,
      modelSelections: { "pexels-stock-v1": null, "seedance-video-v1": null },
      assetProviderIds: ["pexels-stock-v1", "seedance-video-v1"],
      economics: { allowMeteredProviders: true },
    });
  });

  it("lets a failed source-visual gate switch its review service without rerunning paid assets", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const providers: StudioProvider[] = [
      {
        id: "glm-visual-review-v1",
        capability: "quality.review.visual",
        label: "GLM 视觉审片",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "glm-review",
        modelProfiles: [{ id: "glm-review", providerId: "glm-visual-review-v1", providerFamily: "zai", label: "GLM Review", description: "视觉审片", available: true, taskTypes: ["visual-review"] }],
      },
      {
        id: "codex-visual-review-v1",
        capability: "quality.review.visual",
        label: "Codex 视觉审片",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "gpt-review",
        modelProfiles: [{ id: "gpt-review", providerId: "codex-visual-review-v1", providerFamily: "openai", label: "GPT Review", description: "视觉审片", available: true, taskTypes: ["visual-review"] }],
      },
    ];
    const node: StudioNode = {
      id: "asset-source-review",
      label: "生成画面预检",
      role: "视觉审片员",
      status: "failed",
      error: "源素材视觉预检服务暂时不可用。",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "glm-visual-review-v1",
        modelSelections: { "glm-visual-review-v1": "glm-review" },
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="failed"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={onConfigure}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "制作方式" }), "codex-visual-review-v1");
    expect(screen.getByRole("combobox", { name: "首选模型" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

    expect(onConfigure).toHaveBeenCalledWith("asset-source-review", {
      expectedRunRevision: 2,
      providerId: "codex-visual-review-v1",
      modelSelections: { "codex-visual-review-v1": null },
      confirmTerminalEdit: true,
    });
  });

  it("shows and removes an unavailable inherited asset source", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const providers: StudioProvider[] = [{
      id: "retired-stock-v1",
      capability: "asset.prepare",
      label: "已停用素材库",
      available: false,
      kind: "external",
      billing: "free",
    }, {
      id: "pexels-stock-v1",
      capability: "asset.prepare",
      label: "Pexels",
      available: true,
      kind: "external",
      billing: "free",
    }];
    const node: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: {
        providerId: "ai-shot-router-v1",
        modelSelections: {},
        assetProviderIds: ["retired-stock-v1", "pexels-stock-v1"],
        economics: { allowMeteredProviders: false },
      },
    };

    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      providers={providers}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onConfigure={onConfigure}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    expect(screen.getByText(/切换到时长、任务能力不同的视频模型，会让导演重新规划；同一来源下，只有能力兼容的模型切换才从画面素材继续/))
      .toBeInTheDocument();
    const unavailableSource = screen.getByRole("checkbox", { name: /已停用素材库.*已失效/ });
    expect(unavailableSource).toBeChecked();
    await userEvent.click(unavailableSource);
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

    expect(onConfigure).toHaveBeenCalledWith("assets", {
      expectedRunRevision: 2,
      modelSelections: { "pexels-stock-v1": null },
      assetProviderIds: ["pexels-stock-v1"],
      economics: { allowMeteredProviders: false },
    });
  });

  it("shows provenance and saves a valid human output version", async () => {
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={succeededNode} runStatus="stale" artifacts={[]} busy={false} onOverride={onOverride} onInputOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText("本次使用 AI 编剧")).toBeInTheDocument();
    expect(screen.queryByText("codex-screenwriter-v1")).not.toBeInTheDocument();
    expect(screen.queryByText("codex-runtime-actual")).not.toBeInTheDocument();
    expect(screen.queryByText("模板默认")).not.toBeInTheDocument();
    expect(screen.queryByText(/screenwriter-v4/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    fireEvent.change(screen.getByRole("textbox", { name: "开场钩子" }), { target: { value: "人工钩子" } });
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));

    expect(onOverride).toHaveBeenCalledWith("script", {
      output: { hook: "人工钩子" },
    });
  });

  it("blocks an empty brief title before sending an override request", async () => {
    const onOverride = vi.fn(async () => undefined);
    const briefNode: StudioNode = {
      ...succeededNode,
      id: "brief",
      label: "内容简报",
      role: "制片人",
      output: { title: "原题", angle: "原角度", audience: "原观众" },
      outputState: {
        ...succeededNode.outputState!,
        effectiveVersionId: "brief-generated",
        generatedVersionId: "brief-generated",
        versions: [{
          ...succeededNode.outputState!.versions[0]!,
          id: "brief-generated",
          output: { title: "原题", angle: "原角度", audience: "原观众" },
        }],
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={briefNode} runStatus="paused" artifacts={[]} busy={false} onOverride={onOverride} onAuthorize={async () => undefined} />);

    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "标题" }));
    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));

    expect(screen.getByRole("alert")).toHaveTextContent("标题不能为空");
    expect(onOverride).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox", { name: "标题" }), "修正后的题目");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("discloses a failed agent audit and its public rule fallback reason", () => {
    const fallbackReason = "模型连续三轮未通过审计，已采用确定性脚本规则。";
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        parameters: {
          ...succeededNode.executionReceipt!.parameters,
          agentLoop: "failed",
          agentLoopIterations: 3,
          fallbackReason,
        },
      },
    };
    const { container } = render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    const summary = container.querySelector("summary");
    expect(summary).toHaveTextContent("智能复核未完成，已使用基础方案");
    expect(summary).toHaveTextContent(fallbackReason);
    expect(summary).not.toHaveTextContent("自审 3 轮");
    expect(screen.getByRole("alert")).toHaveTextContent(`智能复核未完成，已使用基础方案：${fallbackReason}`);
  });

  it("shows the live agent-loop round, phase, and latest audit summary", () => {
    const node = {
      ...succeededNode,
      status: "running" as const,
      agentLoopProgress: {
        iteration: 2,
        maxIterations: 3,
        phase: "auditing" as const,
        completedIterations: 1,
        latestAudit: { verdict: "repair" as const, score: 68, summary: "generated_image的on_screen_text仍有blocking。" },
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="running" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText("第 2 / 3 轮 · 独立复核中")).toBeInTheDocument();
    expect(screen.getByText("上一轮 68 分：AI 图片生成的屏幕文字仍有必须修改的问题。")).toBeInTheDocument();
  });

  it("keeps the role workspace open while live run data rerenders", async () => {
    const props = {
      node: succeededNode,
      runStatus: "stale" as const,
      artifacts: [],
      busy: false,
      onOverride: async () => undefined,
      onAuthorize: async () => undefined,
    };
    const { container, rerender } = render(<NodeWorkspace runId="run-nw" runRevision={2} acceptedPlanDigest={TEST_PLAN_DIGEST} {...props} />);
    const workspace = container.querySelector<HTMLDetailsElement>("#node-workspace-script")!;

    await userEvent.click(workspace.querySelector("summary")!);
    expect(workspace).toHaveAttribute("open");
    rerender(<NodeWorkspace runId="run-nw" runRevision={2} acceptedPlanDigest={TEST_PLAN_DIGEST} {...props} node={{ ...succeededNode }} />);

    expect(workspace).toHaveAttribute("open");
  });

  it("requests a cooperative pause before editing a completed upstream node", async () => {
    const onRequestPause = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={succeededNode}
      runStatus="running"
      artifacts={[]}
      busy={true}
      pauseBusy={false}
      onRequestPause={onRequestPause}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "暂停后修改" }));
    expect(onRequestPause).toHaveBeenCalledTimes(1);
  });

  it("allows editing after the workflow has safely paused between nodes", async () => {
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={succeededNode}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={onOverride}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByText(/制作已暂停，可以修改/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    fireEvent.change(screen.getByRole("textbox", { name: "开场钩子" }), { target: { value: "暂停后人工钩子" } });
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));
    expect(onOverride).toHaveBeenCalledWith("script", { output: { hook: "暂停后人工钩子" } });
  });

  it("blocks an invalid upstream brief before sending an input override", async () => {
    const onInputOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={succeededNode}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={onInputOverride}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByText("查看和调整这个角色收到的内容"));
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "标题" }));
    await userEvent.click(screen.getByRole("button", { name: "保存人工输入" }));
    expect(screen.getByRole("alert")).toHaveTextContent("内容简报：标题不能为空");
    expect(onInputOverride).not.toHaveBeenCalled();
  });

  it("discloses a receipt-level fallback reason when loop parameters were replaced", () => {
    const fallbackReason = "视觉模型不可用，已使用保守参考语法。";
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        parameters: { sampleMode: "keyframes" },
        fallbackReason,
      },
    };
    const { container } = render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    const summary = container.querySelector("summary");
    expect(summary).toHaveTextContent("智能复核未完成，已使用基础方案");
    expect(summary).toHaveTextContent(fallbackReason);
    expect(screen.getByRole("alert")).toHaveTextContent(`智能复核未完成，已使用基础方案：${fallbackReason}`);
  });

  it("distinguishes a successful backup model from a degraded rule fallback", () => {
    const fallbackReason = "首选模型服务端错误（HTTP 500），已自动切换到替补模型。";
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        providerId: "openai",
        providerLabel: "Codex 视觉审片",
        modelId: "gpt-backup",
        fallbackFromProviderId: "glm-visual-review-v1",
        fallbackReason,
        actualModelIds: ["glm-5.3-flash", "gpt-backup"],
      },
    };
    const { container } = render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    const summary = container.querySelector("summary");
    expect(summary).toHaveTextContent("首选模型暂时不可用，替补模型已完成");
    expect(summary).not.toHaveTextContent("已使用基础方案");
    expect(screen.getByRole("alert")).toHaveTextContent(`首选模型暂时不可用，替补模型已完成：${fallbackReason}`);
  });

  it("does not describe attempted backup models as successful when every candidate failed", () => {
    const fallbackReason = "2 个候选模型均未能完成。";
    const node: StudioNode = {
      ...succeededNode,
      status: "failed",
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        status: "failed",
        fallbackReason,
        actualModelIds: ["glm-5.3", "gpt-5.6-sol"],
      },
    };
    const { container } = render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} runStatus="failed" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    const summary = container.querySelector("summary");
    expect(summary).toHaveTextContent("已尝试替补模型，但本步骤仍未完成");
    expect(summary).not.toHaveTextContent("替补模型已完成");
    expect(screen.getByRole("alert")).toHaveTextContent(`已尝试替补模型，但本步骤仍未完成：${fallbackReason}`);
  });

  it("shows the immutable planned provider and model before a node executes", async () => {
    const pendingNode: StudioNode = {
      id: "visual-direction",
      label: "导演方案",
      role: "导演",
      status: "pending",
      artifactIds: [],
      qualityGateResults: [],
      plannedExecution: {
        providerId: "api-visual-director-v1",
        providerLabel: "Codex 视觉导演",
        modelId: "gpt-5.4",
        transport: "unix_socket",
        billing: "subscription",
        configurationSource: "template_default",
        parameters: { promptPack: "video-factory/director-v6" },
        estimatedCostCny: 0,
        snapshotSource: "created",
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={pendingNode} runStatus="running" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText(/AI 视觉导演/)).toBeInTheDocument();
    expect(screen.queryByText("api-visual-director-v1")).not.toBeInTheDocument();
    expect(screen.queryByText("模板默认")).not.toBeInTheDocument();
    expect(screen.queryByText(/director-v6/)).not.toBeInTheDocument();
  });

  it("lets a failed visual review select another model before recovery", async () => {
    const onConfigure = vi.fn(async () => undefined);
    const provider: StudioProvider = {
      id: "glm-visual-review-v1",
      capability: "quality.review.visual",
      label: "GLM 视觉审片",
      available: true,
      kind: "external",
      modelProfiles: [
        { id: "glm-old", providerId: "glm-visual-review-v1", providerFamily: "glm", label: "GLM Old", description: "视觉审片", available: true, taskTypes: ["visual-review"] },
        { id: "glm-new", providerId: "glm-visual-review-v1", providerFamily: "glm", label: "GLM New", description: "视觉审片", available: true, taskTypes: ["visual-review"] },
      ],
    };
    const node: StudioNode = {
      id: "visual-review",
      label: "视觉审片",
      role: "视觉审片员",
      status: "failed",
      error: "HTTP 500 upstream failed",
      artifactIds: [],
      qualityGateResults: [],
      executionConfiguration: { providerId: provider.id, modelSelections: { [provider.id]: "glm-old" } },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} providers={[provider]} runStatus="failed" artifacts={[]} busy={false} onOverride={async () => undefined} onConfigure={onConfigure} onAuthorize={async () => undefined} />);

    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /^首选模型/ }), "glm-new");
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

    expect(onConfigure).toHaveBeenCalledWith("visual-review", {
      expectedRunRevision: 2,
      providerId: provider.id,
      modelSelections: { [provider.id]: "glm-new" },
      confirmTerminalEdit: true,
    });
  });

  it("keeps billing internals out of the creative editor", () => {
    const node: StudioNode = {
      ...succeededNode,
      executionReceipt: {
        ...succeededNode.executionReceipt!,
        providerId: "seedance-video-v1",
        providerLabel: "Seedance",
        modelId: "seedance-2.5",
        billing: "metered",
        estimatedCostCny: 8,
        meteredAttemptCount: 1,
        meteredFailedAttemptCount: 1,
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={node} providers={[{
      ...seedanceProvider,
      modelProfiles: [{ ...seedanceProvider.modelProfiles![0]!, id: "seedance-2.5", label: "Seedance 2.5" }],
    }]} runStatus="stale" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText(/本次使用 Seedance 视频生成 · Seedance 2.5/)).toBeInTheDocument();
    expect(screen.queryByText(/1 \/ 1 次计费任务失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预估 ¥8.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/核算 ¥0.00/)).not.toBeInTheDocument();
  });

  it("shows the effective node input and saves a human input version", async () => {
    const onInputOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={succeededNode}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={onInputOverride}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByText("查看和调整这个角色收到的内容"));
    expect(screen.getAllByText(/旧题目/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), { target: { value: "人工题目" } });
    await userEvent.click(screen.getByRole("button", { name: "保存人工输入" }));

    expect(onInputOverride).toHaveBeenCalledWith("script", {
      input: { brief: { title: "人工题目" } },
      expectedRunRevision: 2,
      expectedVersionId: "input-generated",
    });
  });

  it("binds the input draft to the revision observed when the editor opened", async () => {
    const onInputOverride = vi.fn(async () => undefined);
    const node = { ...succeededNode };
    const { rerender } = render(<NodeWorkspace
      runId="run-nw"
      runRevision={2}
      acceptedPlanDigest={TEST_PLAN_DIGEST}
      node={node}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={onInputOverride}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByText("查看和调整这个角色收到的内容"));
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), { target: { value: "基线期间的题目" } });

    // 编辑期间后台数据刷新（revision 推进、输入版本替换）：草稿基线不变，
    // 保存仍以打开编辑器时观察到的 token 提交，服务端冲突时用户草稿不丢。
    rerender(<NodeWorkspace
      runId="run-nw"
      runRevision={7}
      acceptedPlanDigest={TEST_PLAN_DIGEST}
      node={{
        ...node,
        inputState: {
          ...node.inputState!,
          effectiveVersionId: "input-v5",
          versions: [...node.inputState!.versions, {
            id: "input-v5",
            source: "human" as const,
            value: { brief: { title: "后台新题目" } },
            upstreamVersionIds: ["brief-v1"],
            createdAt: "2026-08-27T01:00:00.000Z",
            createdBy: "someone-else",
            schemaVersion: "script-input-v1",
          }],
        },
      }}
      runStatus="paused"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={onInputOverride}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByRole("textbox", { name: "标题" })).toHaveValue("基线期间的题目");
    await userEvent.click(screen.getByRole("button", { name: "保存人工输入" }));

    expect(onInputOverride).toHaveBeenCalledWith("script", {
      input: { brief: { title: "基线期间的题目" } },
      expectedRunRevision: 2,
      expectedVersionId: "input-generated",
    });
  });

  it("previews the actual synthesized audio in the voice delivery", () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{ ...succeededNode, id: "voice", label: "配音", role: "声音导演", output: { voice: "female-chengshu", rate: 185 } }}
      runStatus="succeeded"
      artifacts={[
        {
          id: "voice-audio",
          kind: "voiceover",
          createdAt: "2026-08-27T00:00:00.000Z",
          contentType: "audio/mpeg",
          contentUrl: "/api/runs/run-1/artifacts/voice-audio/content",
          producerNodeId: "voice",
        },
        {
          id: "background-music",
          kind: "music",
          createdAt: "2026-08-27T00:00:01.000Z",
          contentType: "audio/mpeg",
          contentUrl: "/api/runs/run-1/artifacts/background-music/content",
          producerNodeId: "render",
        },
      ]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByText("成熟女声")).toBeInTheDocument();
    expect(screen.getByLabelText("实际配音试听")).toHaveAttribute("src", "/api/runs/run-1/artifacts/voice-audio/content");
  });

  it("edits voice instructions as node input instead of pretending generated audio metadata is editable", async () => {
    const onInputOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        id: "voice",
        label: "配音",
        role: "声音导演",
        output: {
          voice: "Tingting",
          rate: 185,
          direction: { rate: 185, pause_scale: 1, mastering_preset: "natural" },
        },
        inputState: {
          effectiveVersionId: "voice-input-generated",
          stale: false,
          versions: [{
            id: "voice-input-generated",
            source: "derived",
            value: {
              scriptPath: "/managed/script.json",
              voice: "Tingting",
              rate: 185,
              pause_scale: 1,
              mastering_preset: "natural",
            },
            upstreamVersionIds: ["script-v1", "assets-v1"],
            createdAt: "2026-08-27T00:00:00.000Z",
            createdBy: "workflow:voice",
            schemaVersion: "voice-input-v1",
          }],
        },
      }}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={onInputOverride}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("查看和调整这个角色收到的内容"));
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "语速（字/分钟）" }), { target: { value: "170" } });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "语速（字/分钟）" }));
    await userEvent.click(screen.getByRole("button", { name: "保存人工输入" }));

    expect(onInputOverride).toHaveBeenCalledWith("voice", {
      input: {
        scriptPath: "/managed/script.json",
        voice: "Tingting",
        rate: 170,
        pause_scale: 1,
        mastering_preset: "natural",
      },
      expectedRunRevision: 2,
      expectedVersionId: "voice-input-generated",
    });
  });

  it("keeps materialized scene assets read-only until a real replacement is supplied", () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        id: "assets",
        label: "画面",
        role: "素材导演",
        output: { director_routing: [{ scene_position: 1, query: "窗边水杯", rationale: "首镜建立氛围" }] },
      }}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
    expect(screen.getByText(/修改上方导演方案中的逐镜来源或提示/)).toBeInTheDocument();
  });

  it("previews every materialized scene image and video instead of only showing routing text", () => {
    const { container } = render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        id: "assets",
        label: "画面",
        role: "素材导演",
        artifactIds: ["scene-1", "scene-2"],
        output: { director_routing: [{ scene_position: 1, query: "窗边水杯", rationale: "首镜建立氛围" }] },
      }}
      runStatus="stale"
      artifacts={[
        { id: "scene-1", kind: "media_asset", createdAt: "2026-08-27T00:00:00.000Z", contentType: "image/png", contentUrl: "/scene-1.png", producerNodeId: "assets", providerId: "local-editorial-v1" },
        { id: "scene-2", kind: "media_asset", createdAt: "2026-08-27T00:00:01.000Z", contentType: "video/mp4", contentUrl: "/scene-2.mp4", producerNodeId: "assets", providerId: "hailuo-video-v1" },
      ]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByRole("img", { name: "素材 1 画面预览" })).toHaveAttribute("src", "/scene-1.png");
    expect(container.querySelector('video[aria-label="素材 2 画面预览"]')).toHaveAttribute("src", "/scene-2.mp4");
    expect(screen.getByText("本地编辑画面")).toBeInTheDocument();
    expect(screen.getByText("MiniMax 视频生成")).toBeInTheDocument();
  });

  it("uses a multiline editor for every visual-review suggestion", async () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        id: "visual-review",
        label: "视觉审片",
        role: "视觉审片员",
        output: {
          summary: "需要调整",
          findings: [{ category: "pacing", severity: "warning", description: "转场过亮", suggestion: "移除闪白" }],
        },
      }}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    expect(screen.getByRole("textbox", { name: "修改建议" }).tagName).toBe("TEXTAREA");
  });

  it("labels an existing voice artifact as outdated after a human edit", () => {
    const generated = succeededNode.outputState!.versions[0]!;
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        id: "voice",
        label: "配音",
        role: "声音导演",
        outputState: {
          ...succeededNode.outputState!,
          effectiveVersionId: "voice-human",
          versions: [generated, { ...generated, id: "voice-human", source: "human", artifactIds: [], createdBy: "human:editor" }],
        },
      }}
      runStatus="stale"
      artifacts={[{ id: "voice-audio", kind: "voiceover", createdAt: "2026-08-27T00:00:00.000Z", contentType: "audio/mpeg", contentUrl: "/voice.mp3", producerNodeId: "voice" }]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByLabelText("上次生成的配音试听")).toHaveAttribute("src", "/voice.mp3");
    expect(screen.getByText(/当前文字已修改/)).toBeInTheDocument();
  });

  it("labels reconstructed legacy input without presenting it as original execution evidence", async () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{
        ...succeededNode,
        inputState: {
          effectiveVersionId: "legacy-input",
          stale: false,
          versions: [{
            id: "legacy-input",
            source: "reconstructed",
            value: { brief: { title: "历史题目" } },
            upstreamVersionIds: [],
            createdAt: "2026-08-27T00:00:00.000Z",
            createdBy: "legacy-reconstruction:script",
            schemaVersion: "1",
          }],
        },
      }}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    await userEvent.click(screen.getByText("查看和调整这个角色收到的内容"));
    expect(screen.getByText("历史任务推断输入")).toBeInTheDocument();
    expect(screen.getByText(/旧任务没有保存当时的原始输入/)).toBeInTheDocument();
  });

  it("links a technical-path input back to the editable upstream role without exposing the path", async () => {
    const directorNode: StudioNode = {
        ...succeededNode,
        id: "visual-direction",
        label: "导演方案",
        role: "导演",
        inputState: {
          effectiveVersionId: "legacy-path-input",
          stale: false,
          versions: [{
            id: "legacy-path-input",
            source: "reconstructed",
            value: { scriptPath: "/private/runs/run-1/script.json" },
            upstreamVersionIds: [],
            createdAt: "2026-08-27T00:00:00.000Z",
            createdBy: "legacy-reconstruction:script",
            schemaVersion: "1",
          }],
        },
      };
    const nodes = [succeededNode, directorNode];
    const { container } = render(<>
      <NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={succeededNode} nodes={nodes} runStatus="stale" artifacts={[]} busy={false} onOverride={async () => undefined} onInputOverride={async () => undefined} onAuthorize={async () => undefined} />
      <NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={directorNode}
      nodes={nodes}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    /></>);

    const directorWorkspace = container.querySelector<HTMLElement>("#node-workspace-visual-direction")!;
    await userEvent.click(within(directorWorkspace).getByText("查看和调整这个角色收到的内容"));
    expect(within(directorWorkspace).getByText("编剧 · 脚本")).toBeInTheDocument();
    expect(within(directorWorkspace).getByText("自动版本")).toBeInTheDocument();
    expect(within(directorWorkspace).queryByRole("button", { name: "编辑输入" })).not.toBeInTheDocument();
    expect(within(directorWorkspace).queryByText(/private\/runs/)).not.toBeInTheDocument();
    await userEvent.click(within(directorWorkspace).getByRole("button", { name: "查看与修改 编剧 · 脚本" }));
    expect(container.querySelector("#node-workspace-script")).toHaveAttribute("open");
  });

  it("does not fetch or expose the immutable model trace in the creator workspace", () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      version: "video-factory/model-trace-v1",
      taskKind: "script-draft",
      promptVersion: "video-factory/screenwriter-v2",
      providerId: "openai",
      modelId: "gpt-5.4",
      prompt: "Prompt Pack: video-factory/screenwriter-v2\n实际发送内容",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const node: StudioNode = {
      ...succeededNode,
      artifactIds: ["trace-current"],
      outputState: {
        ...succeededNode.outputState!,
        versions: [{
          ...succeededNode.outputState!.versions[0]!,
          artifactIds: ["trace-current"],
        }],
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      runStatus="stale"
      artifacts={[{
        id: "trace-current",
        kind: "model_trace",
        createdAt: "2026-08-27T00:00:00.000Z",
        contentType: "application/json",
        contentUrl: "/api/runs/run-1/artifacts/trace-current/content",
        producerNodeId: "script",
      }]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByText("本次使用 AI 编剧")).toBeInTheDocument();
    expect(screen.queryByText(/video-factory\/screenwriter-v2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/实际发送内容/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds a spend confirmation to the visible plan", async () => {
    const onAuthorize = vi.fn(async () => undefined);
    const paidNode: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "awaiting_spend_approval",
      artifactIds: [],
      qualityGateResults: [],
      inputState: {
        effectiveVersionId: "assets-input-v1",
        stale: false,
        versions: [{
          id: "assets-input-v1",
          source: "derived",
          value: { directorPlan: { shots: [{ position: 1, generationPrompt: "窗边水杯" }] } },
          upstreamVersionIds: ["script-v2"],
          createdAt: "2026-08-27T00:00:00.000Z",
          createdBy: "workflow-runner",
          schemaVersion: "assets-input-v1",
        }],
      },
      spendPlan: {
        id: "plan-1",
        inputVersionIds: ["script-v2"],
        providerId: "hailuo-video-v1",
        modelId: "MiniMax-Hailuo-02",
        estimatedCostCny: 2.4,
        maxCostCny: 3,
        maxAttempts: 1,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    };
    const scriptNode: StudioNode = {
      ...succeededNode,
      outputState: {
        generatedVersionId: "script-v1",
        effectiveVersionId: "script-v2",
        stale: false,
        versions: [{
          id: "script-v2",
          source: "human",
          artifactIds: [],
          inputVersionIds: [],
          createdAt: "2026-08-27T00:00:00.000Z",
          createdBy: "studio-owner",
          schemaVersion: "script-v1",
          output: { hook: "人工钩子" },
        }],
      },
    };
    render(<NodeWorkspace node={paidNode} nodes={[scriptNode, paidNode]} providers={[hailuoProvider]} runStatus="awaiting_spend_approval" runId="run-1" runRevision={5} acceptedPlanDigest={"a".repeat(64)} artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={onAuthorize} />);

    const inputReview = screen.getByText("查看和调整这个角色收到的内容").closest("details");
    const spendGate = screen.getByRole("button", { name: /获取费用报价/ }).closest("section");
    expect(inputReview).toHaveAttribute("open");
    expect(inputReview?.compareDocumentPosition(spendGate!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // 报价绑定人工版本与模型信息在确认面板可见（C2：scope 确认取代逐项对话框）。
    expect(screen.getAllByText(/MiniMax Hailuo 02/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/最高 ¥3.00/).length).toBeGreaterThan(0);

    const quoteSpy = vi.spyOn(studioApi, "prepareProductionQuote").mockResolvedValue({
      quoteId: "quote-nw-1",
      acceptedPlanDigest: "a".repeat(64),
      estimatedCostCny: 2.4,
      maximumCostCny: 3,
      scopeSummary: { content: "测试报价", assets: [], uncertainty: [] },
      feasible: true,
    });
    const scopeSpy = vi.spyOn(studioApi, "authorizeProductionScope").mockResolvedValue({ id: "run-1" } as never);
    // 第一阶段：只取报价，不授权——用户必须先看见服务端金额。
    await userEvent.click(screen.getByRole("button", { name: /获取费用报价/ }));
    await waitFor(() => {
      expect(quoteSpy).toHaveBeenCalledWith("run-1", { expectedRunRevision: 5, acceptedPlanDigest: "a".repeat(64) });
      expect(scopeSpy).not.toHaveBeenCalled();
    });
    expect(await screen.findByText("测试报价")).toBeTruthy();
    // 第二阶段：明确接受已展示的同一份报价。
    await userEvent.click(screen.getByRole("button", { name: /确认并授权（最高 ¥3.00）/ }));
    await waitFor(() => {
      expect(scopeSpy).toHaveBeenCalledWith("run-1", {
        expectedRunRevision: 5,
        quoteId: "quote-nw-1",
        acceptedPlanDigest: "a".repeat(64),
        idempotencyKey: "scope-run-1-quote-nw-1",
      });
    });

    // C2：面板不再逐项调用 onAuthorize——授权由 scope 命令在服务端派生子凭证
    // （production-authorization-api.test.ts 覆盖派生细节），onAuthorize 保持 0 次调用。
    expect(onAuthorize).not.toHaveBeenCalled();
  });

  it("offers the funding three actions from the structured assessment", async () => {
    const onRejectSpend = vi.fn(async () => undefined);
    const onRequestPause = vi.fn(async () => undefined);
    const paidNode: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "awaiting_spend_approval",
      artifactIds: [],
      qualityGateResults: [],
      spendPlan: {
        id: "plan-1",
        inputVersionIds: ["script-v2"],
        providerId: "seedance-video-v1",
        modelId: "seedance-v1",
        estimatedCostCny: 7.2,
        maxCostCny: 14.4,
        maxAttempts: 2,
        createdAt: "2026-08-27T00:00:00.000Z",
      },
      spendAssessment: {
        action: "request_approval",
        reason: "amount",
        approvedAmountCents: 720,
        settledCents: 0,
        reservedCents: 0,
        pendingUnknownCents: 0,
        requestedMaximumCents: 1440,
        additionalCents: 720,
        resultingMaximumCents: 1440,
        blockedAssets: [],
      },
    };
    render(<NodeWorkspace node={paidNode} providers={[seedanceProvider]} runStatus="awaiting_spend_approval" runId="run-1" runRevision={7} acceptedPlanDigest={"a".repeat(64)} artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} onRejectSpend={onRejectSpend} onRequestPause={onRequestPause} />);

    // 结构化评估驱动三动作：同意追加（精确差额）/ 调整方案 / 暂不继续。
    expect(screen.getByText("当前授权余额不够完成这份方案。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /同意追加 ¥7.20 并继续/ })).toBeInTheDocument();

    // "暂不继续"走持久暂停，不发起任何授权。
    await userEvent.click(screen.getByRole("button", { name: /暂不继续/ }));
    await waitFor(() => expect(onRequestPause).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /同意追加 ¥7.20 并继续/ })).toBeEnabled();

    // "调整方案"打开既有返工意见面板（预填降本意见），不直接花。
    await userEvent.click(screen.getByRole("button", { name: /调整方案/ }));
    expect(await screen.findByRole("dialog", { name: "保存费用反馈" })).toBeInTheDocument();

    // "同意追加"先 prepare（生成服务端 funding request）再 amend，客户端不自报差额。
    const quoteSpy = vi.spyOn(studioApi, "prepareProductionQuote").mockResolvedValue({
      quoteId: "quote-funding-1",
      acceptedPlanDigest: "a".repeat(64),
      estimatedCostCny: 7.2,
      maximumCostCny: 14.4,
      scopeSummary: { content: "缺口报价", assets: [], uncertainty: [] },
      fundingRequestId: "funding-1",
      fundingAuthorizationId: "auth-active-1",
      additionalCents: 720,
      feasible: true,
    });
    const amendSpy = vi.spyOn(studioApi, "amendProductionScope").mockResolvedValue({ id: "run-1" } as never);
    await userEvent.click(screen.getByRole("button", { name: /同意追加 ¥7.20 并继续/ }));
    await waitFor(() => {
      expect(quoteSpy).toHaveBeenCalledWith("run-1", {
        expectedRunRevision: 7,
        acceptedPlanDigest: "a".repeat(64),
        requestedMaximumCny: 14.4,
      });
      expect(amendSpy).toHaveBeenCalledWith("run-1", "auth-active-1", {
        expectedRunRevision: 7,
        fundingRequestId: "funding-1",
        idempotencyKey: "amend-run-1-funding-1",
      });
    });
  });

  it("stores a rejected asset quote with a zero target for manual replanning", async () => {
    const onRejectSpend = vi.fn(async () => undefined);
    const paidNode: StudioNode = {
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "awaiting_spend_approval",
      artifactIds: [],
      qualityGateResults: [],
      spendPlan: {
        id: "plan-1",
        inputVersionIds: ["director-v1"],
        providerId: "ai-shot-router-v1",
        modelId: "seedance-v1",
        estimatedCostCny: 4.8,
        maxCostCny: 4.8,
        maxAttempts: 1,
        items: [
          { id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
          { id: "scene-2", label: "镜头 2", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 2.4 },
        ],
        createdAt: "2026-08-27T00:00:00.000Z",
      },
    };
    render(<NodeWorkspace
      runId="run-2"
      runRevision={7}
      node={paidNode}
      providers={[seedanceProvider]}
      runStatus="awaiting_spend_approval"
      acceptedPlanDigest={"b".repeat(64)}
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
      onRejectSpend={onRejectSpend}
    />);

    // C2：报价条目与模型在确认面板内可见（scope 确认取代逐项对话框），未识别模型不出现。
    expect(screen.getByText("镜头 1 · Seedance 视频生成 · Seedance 1")).toBeInTheDocument();
    expect(screen.getByText("镜头 2 · Seedance 视频生成 · Seedance 1")).toBeInTheDocument();
    expect(screen.queryByText(/未识别模型/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "这份报价不合适" }));
    const dialog = screen.getByRole("dialog", { name: "保存费用反馈" });
    expect(within(dialog).getByRole("heading", { name: "把这份报价退回导演" })).toBeInTheDocument();
    expect(within(dialog).getByText(/新方案会重新报价并再次等待你确认/)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/Agent|Provider|broker|schema|manifest|fallback|taskId|director-v1/i);
    await userEvent.type(within(dialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }), "4.8");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存反馈" }));
    expect(screen.getByRole("alert")).toHaveTextContent("下一版降本目标必须低于当前报价 ¥4.80");
    await userEvent.click(within(dialog).getByRole("button", { name: "返回检查" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "这份报价不合适" }));
    const reopenedDialog = screen.getByRole("dialog", { name: "保存费用反馈" });
    await userEvent.clear(within(reopenedDialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }));
    await userEvent.type(within(reopenedDialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }), "0");
    await userEvent.type(within(reopenedDialog).getByRole("textbox", { name: "具体调整意见（可选）" }), "第二镜优先改用真实图库。");
    await userEvent.click(within(reopenedDialog).getByRole("button", { name: "保存反馈" }));

    expect(onRejectSpend).toHaveBeenCalledWith("assets", {
      spendPlanId: "plan-1",
      reason: "too_expensive",
      targetEstimatedCostCny: 0,
      note: "第二镜优先改用真实图库。",
    });
  });

  it("loads and saves the editable JSON artifact instead of exposing only its file path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      title: "旧脚本",
      scenes: [{ narration: "旧旁白" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{ ...succeededNode, artifactIds: ["artifact-script"], output: { scriptPath: "/runs/run-1/script.json" } }}
      runStatus="stale"
      artifacts={[{
        id: "artifact-script",
        kind: "script",
        createdAt: "2026-08-27T00:00:00.000Z",
        contentType: "application/json",
        contentUrl: "/api/runs/run-1/artifacts/artifact-script/content",
        producerNodeId: "script",
      }]}
      busy={false}
      onOverride={onOverride}
      onAuthorize={async () => undefined}
    />);

    expect((await screen.findAllByText(/旧脚本/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), { target: { value: "人工脚本" } });
    fireEvent.change(screen.getByRole("textbox", { name: "旁白" }), { target: { value: "人工旁白" } });
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));

    expect(onOverride).toHaveBeenCalledWith("script", {
      document: {
        artifactId: "artifact-script",
        content: { title: "人工脚本", scenes: [{ narration: "人工旁白" }] },
      },
    });
  });

  it("loads the artifact attached to the effective version when older attempts are also present", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({
      hook: String(input).includes("current") ? "current" : "old",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const node: StudioNode = {
      ...succeededNode,
      artifactIds: ["artifact-old", "artifact-current"],
      outputState: {
        ...succeededNode.outputState!,
        effectiveVersionId: "version-current",
        versions: [{
          id: "version-current",
          source: "human",
          artifactIds: ["artifact-current"],
          inputVersionIds: [],
          createdAt: "2026-08-27T01:00:00.000Z",
          createdBy: "studio-owner",
          schemaVersion: "script-v1",
          output: { scriptPath: "/runs/current/script.json" },
        }],
      },
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={node}
      runStatus="stale"
      artifacts={[
        { id: "artifact-old", kind: "script", createdAt: "2026-08-27T00:00:00.000Z", contentType: "application/json", contentUrl: "/old", producerNodeId: "script" },
        { id: "artifact-current", kind: "script", createdAt: "2026-08-27T01:00:00.000Z", contentType: "application/json", contentUrl: "/current", producerNodeId: "script" },
      ]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(await screen.findByText(/current/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/current", expect.any(Object));
  });

  it("requires confirmation before editing a terminal run and closes the modal with Escape", async () => {
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST} runId="run-nw" runRevision={2} node={succeededNode} runStatus="succeeded" artifacts={[]} busy={false} onOverride={onOverride} onAuthorize={async () => undefined} />);

    await userEvent.click(screen.getByRole("button", { name: "编辑交付" }));
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));
    expect(screen.getByRole("dialog", { name: /创建已结束制作的人工修订版/ })).toBeInTheDocument();
    expect(onOverride).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /创建已结束制作的人工修订版/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));
    await userEvent.click(screen.getByRole("button", { name: "确认创建修订版" }));
    expect(onOverride).toHaveBeenCalledWith("script", { output: { hook: "旧钩子" }, confirmTerminalEdit: true });
  });

  it("renders stale output as an explicit warning and disables artifacts without a URL", () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{ ...succeededNode, outputState: { ...succeededNode.outputState!, stale: true } }}
      runStatus="stale"
      artifacts={[{ id: "missing", kind: "script", createdAt: "2026-08-27T00:00:00.000Z" }]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.getByRole("alert")).toHaveTextContent("后续成片不会继续采用它");
    expect(screen.queryByText("暂不可打开 · 尚无文件地址")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /script/ })).not.toBeInTheDocument();
  });

  it("does not offer editing when a failed node produced no structured output", () => {
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={{ id: "render", label: "渲染", role: "剪辑师", status: "failed", artifactIds: [], qualityGateResults: [] }}
      runStatus="failed"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
  });

  it("does not offer upstream edits while a downstream paid result is uncertain", () => {
    const scriptNode = {
      ...succeededNode,
      executionConfiguration: {
        providerId: "codex-screenwriter-v1",
        modelSelections: {},
      },
    };
    const uncertainAssetNode: StudioNode = {
      id: "assets",
      label: "画面素材",
      role: "素材制片",
      status: "failed",
      outcomeUncertain: true,
      artifactIds: [],
      qualityGateResults: [],
    };
    render(<NodeWorkspace acceptedPlanDigest={TEST_PLAN_DIGEST}
      runId="run-nw"
      runRevision={2}
      node={scriptNode}
      nodes={[scriptNode, uncertainAssetNode]}
      providers={[{
        id: "codex-screenwriter-v1",
        capability: "script.draft",
        label: "AI 编剧",
        available: true,
        kind: "external",
        billing: "subscription",
      }]}
      runStatus="failed"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onConfigure={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑输入" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整" })).not.toBeInTheDocument();
  });


  it("renders aggregate cost and links each video to its detail page", () => {
    const dashboard: CostDto = {
      currency: "CNY",
      totals: { estimatedCostCny: 2.4, authorizedCostCny: 3, actualCostCny: 0, actualPendingCount: 1, meteredCalls: 1, subscriptionCalls: 2, freeCalls: 3, failedMeteredCalls: 0 },
      byProvider: [
        { id: "hailuo-video-v1", providerId: "hailuo-video-v1", label: "MiniMax", calls: 1, estimatedCostCny: 2.4, actualCostCny: 0, actualPendingCount: 1 },
        { id: "local-render", providerId: "local-render", label: "本地渲染", calls: 2, estimatedCostCny: 0, actualCostCny: 0, actualPendingCount: 0 },
      ],
      byNode: [{ id: "assets", nodeId: "assets", label: "画面", calls: 1, estimatedCostCny: 2.4, actualCostCny: 0, actualPendingCount: 1 }],
      runs: [{ runId: "run-1", title: "付费成片", totals: { estimatedCostCny: 2.4, authorizedCostCny: 3, actualCostCny: 0, actualPendingCount: 1, meteredCalls: 1, subscriptionCalls: 2, freeCalls: 3, failedMeteredCalls: 0 } }],
    };
    render(<MemoryRouter><CostDashboard dashboard={dashboard} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "按服务和制作步骤核对费用" })).toBeInTheDocument();
    expect(screen.getByText("报价授权金额（非消费）")).toBeInTheDocument();
    expect(screen.getByText("待确认是否扣费")).toBeInTheDocument();
    expect(screen.getByText("按实际服务")).toBeInTheDocument();
    expect(screen.queryByText("授权上限")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /付费成片/ })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.getAllByText("¥3.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 笔待确认/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 次执行").length).toBeGreaterThan(0);
    expect(screen.getByText("2 次执行")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /付费成片/ })).toHaveTextContent("1 次按量调用");
    expect(screen.queryByText(/次已确认/)).not.toBeInTheDocument();
  });

  it("distinguishes subscription retries from failed metered calls", async () => {
    render(<RunCostDetailPanel detail={{
      runId: "run-1",
      title: "订阅模型重试",
      totals: {
        estimatedCostCny: 0,
        authorizedCostCny: 0,
        actualCostCny: 0,
        actualPendingCount: 0,
        meteredCalls: 0,
        subscriptionCalls: 2,
        freeCalls: 0,
        failedMeteredCalls: 0,
      },
      lines: [{
        id: "receipt-1",
        runId: "run-1",
        runTitle: "订阅模型重试",
        nodeId: "visual-direction",
        role: "导演",
        capability: "storyboard.plan",
        providerId: "openai",
        modelId: "gpt-5.6-terra",
        billing: "subscription",
        status: "failed",
        estimatedCostCny: 0,
        subscriptionCallCount: 2,
        actualPending: false,
        startedAt: "2026-08-27T00:00:00.000Z",
      }],
    }} />);

    expect(screen.getByText("付费服务失败")).toBeInTheDocument();
    const detailsHint = screen.getByText("报价不等于消费；只有外部任务结果不明确时才需确认是否扣费");
    await userEvent.click(detailsHint.closest("summary")!);
    expect(screen.getByText("AI 创作服务 · gpt-5.6-terra")).toBeInTheDocument();
    expect(screen.getByText("订阅任务失败 · 不产生按量费用")).toBeInTheDocument();
  });
});
