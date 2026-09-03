import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioCostDashboard as CostDto, StudioNode, StudioProvider } from "../src/shared/api.js";
import { CostDashboard, RunCostDetailPanel } from "../src/client/components/CostDashboard.js";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";

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

describe("node production workspaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

    render(<NodeWorkspace
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

    render(<NodeWorkspace
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
    await userEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(onConfigure).toHaveBeenCalledWith("assets", {
      modelSelections: { "pexels-stock-v1": null, "seedance-video-v1": null },
      assetProviderIds: ["pexels-stock-v1", "seedance-video-v1"],
      economics: { allowMeteredProviders: true },
    });
  });

  it("shows provenance and saves a valid human output version", async () => {
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace node={succeededNode} runStatus="stale" artifacts={[]} busy={false} onOverride={onOverride} onInputOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText(/本次使用 Codex 编剧 · codex/)).toBeInTheDocument();
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
    render(<NodeWorkspace node={briefNode} runStatus="paused" artifacts={[]} busy={false} onOverride={onOverride} onAuthorize={async () => undefined} />);

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
    const { container } = render(<NodeWorkspace node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

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
        latestAudit: { verdict: "repair" as const, score: 68, summary: "开场钩子仍需具体。" },
      },
    };
    render(<NodeWorkspace node={node} runStatus="running" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText("第 2 / 3 轮 · 独立审计中")).toBeInTheDocument();
    expect(screen.getByText("上一轮 68 分：开场钩子仍需具体。")).toBeInTheDocument();
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
    const { container, rerender } = render(<NodeWorkspace {...props} />);
    const workspace = container.querySelector<HTMLDetailsElement>("#node-workspace-script")!;

    await userEvent.click(workspace.querySelector("summary")!);
    expect(workspace).toHaveAttribute("open");
    rerender(<NodeWorkspace {...props} node={{ ...succeededNode }} />);

    expect(workspace).toHaveAttribute("open");
  });

  it("requests a cooperative pause before editing a completed upstream node", async () => {
    const onRequestPause = vi.fn(async () => undefined);
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    const { container } = render(<NodeWorkspace node={node} runStatus="succeeded" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    const summary = container.querySelector("summary");
    expect(summary).toHaveTextContent("智能复核未完成，已使用基础方案");
    expect(summary).toHaveTextContent(fallbackReason);
    expect(screen.getByRole("alert")).toHaveTextContent(`智能复核未完成，已使用基础方案：${fallbackReason}`);
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
    render(<NodeWorkspace node={pendingNode} runStatus="running" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText(/Codex 视觉导演 · gpt-5.4/)).toBeInTheDocument();
    expect(screen.queryByText("api-visual-director-v1")).not.toBeInTheDocument();
    expect(screen.queryByText("模板默认")).not.toBeInTheDocument();
    expect(screen.queryByText(/director-v6/)).not.toBeInTheDocument();
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
    render(<NodeWorkspace node={node} runStatus="stale" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={async () => undefined} />);

    expect(screen.getByText(/本次使用 Seedance 视频生成 · seedance-2.5/)).toBeInTheDocument();
    expect(screen.queryByText(/1 \/ 1 次计费任务失败/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预估 ¥8.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/核算 ¥0.00/)).not.toBeInTheDocument();
  });

  it("shows the effective node input and saves a human input version", async () => {
    const onInputOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace
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
    });
  });

  it("previews the actual synthesized audio in the voice delivery", () => {
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    });
  });

  it("keeps materialized scene assets read-only until a real replacement is supplied", () => {
    render(<NodeWorkspace
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
    const { container } = render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
      <NodeWorkspace node={succeededNode} nodes={nodes} runStatus="stale" artifacts={[]} busy={false} onOverride={async () => undefined} onInputOverride={async () => undefined} onAuthorize={async () => undefined} />
      <NodeWorkspace
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
    render(<NodeWorkspace
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

    expect(screen.getByText(/本次使用 Codex 编剧 · codex/)).toBeInTheDocument();
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
    render(<NodeWorkspace node={paidNode} nodes={[scriptNode, paidNode]} runStatus="awaiting_spend_approval" artifacts={[]} busy={false} onOverride={async () => undefined} onAuthorize={onAuthorize} />);

    const inputReview = screen.getByText("查看和调整这个角色收到的内容").closest("details");
    const spendGate = screen.getByRole("button", { name: "检查并确认" }).closest("section");
    expect(inputReview).toHaveAttribute("open");
    expect(inputReview?.compareDocumentPosition(spendGate!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await userEvent.click(screen.getByRole("button", { name: "检查并确认" }));
    const dialog = screen.getByRole("dialog", { name: "确认本次费用" });
    expect(within(dialog).getByText("编剧 · 脚本")).toBeInTheDocument();
    expect(within(dialog).getByText("人工版本")).toBeInTheDocument();
    expect(screen.getAllByText(/MiniMax-Hailuo-02/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/最高 ¥3.00/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "确认并执行" }));

    expect(onAuthorize).toHaveBeenCalledWith("assets", {
      inputVersionIds: ["script-v2"],
      providerId: "hailuo-video-v1",
      modelId: "MiniMax-Hailuo-02",
      maxCostCny: 3,
      maxAttempts: 1,
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
      node={paidNode}
      runStatus="awaiting_spend_approval"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
      onRejectSpend={onRejectSpend}
    />);

    expect(screen.getByText("镜头 1 · Seedance 视频生成 · seedance-v1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "这份报价不合适" }));
    const dialog = screen.getByRole("dialog", { name: "保存费用反馈" });
    await userEvent.clear(within(dialog).getByRole("spinbutton", { name: "希望下一版控制在多少元（可选）" }));
    await userEvent.type(within(dialog).getByRole("spinbutton", { name: "希望下一版控制在多少元（可选）" }), "0");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "具体调整意见（可选）" }), "第二镜优先改用真实图库。");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存反馈" }));

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
    render(<NodeWorkspace
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
    render(<NodeWorkspace
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
    render(<NodeWorkspace node={succeededNode} runStatus="succeeded" artifacts={[]} busy={false} onOverride={onOverride} onAuthorize={async () => undefined} />);

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
    render(<NodeWorkspace
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
    render(<NodeWorkspace
      node={{ id: "render", label: "渲染", role: "剪辑师", status: "failed", artifactIds: [], qualityGateResults: [] }}
      runStatus="failed"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByRole("button", { name: "编辑交付" })).not.toBeInTheDocument();
  });

  it("renders aggregate cost and links each video to its detail page", () => {
    const dashboard: CostDto = {
      currency: "CNY",
      totals: { estimatedCostCny: 2.4, authorizedCostCny: 3, actualCostCny: 0, actualPendingCount: 1, meteredCalls: 1, subscriptionCalls: 2, freeCalls: 3, failedMeteredCalls: 0 },
      byProvider: [{ id: "hailuo-video-v1", providerId: "hailuo-video-v1", label: "MiniMax", calls: 1, estimatedCostCny: 2.4, actualCostCny: 0, actualPendingCount: 1 }],
      byNode: [{ id: "assets", nodeId: "assets", label: "画面", calls: 1, estimatedCostCny: 2.4, actualCostCny: 0, actualPendingCount: 1 }],
      runs: [{ runId: "run-1", title: "付费成片", totals: { estimatedCostCny: 2.4, authorizedCostCny: 3, actualCostCny: 0, actualPendingCount: 1, meteredCalls: 1, subscriptionCalls: 2, freeCalls: 3, failedMeteredCalls: 0 } }],
    };
    render(<MemoryRouter><CostDashboard dashboard={dashboard} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "每一笔费用都能追到制作步骤" })).toBeInTheDocument();
    expect(screen.getByText("已批准报价合计")).toBeInTheDocument();
    expect(screen.queryByText("授权上限")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /付费成片/ })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.getAllByText("¥3.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 笔待核对/).length).toBeGreaterThan(0);
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

    expect(screen.getByText("按量调用失败")).toBeInTheDocument();
    await userEvent.click(screen.getByText("逐角色消费明细"));
    expect(screen.getByText("Codex · gpt-5.6-terra")).toBeInTheDocument();
    expect(screen.getByText("订阅任务失败 · 不产生按量费用")).toBeInTheDocument();
  });
});
