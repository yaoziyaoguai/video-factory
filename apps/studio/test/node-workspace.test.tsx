import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioCostDashboard as CostDto, StudioNode } from "../src/shared/api.js";
import { CostDashboard } from "../src/client/components/CostDashboard.js";
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

    await userEvent.click(screen.getByText("调整这个角色收到的内容"));
    expect(screen.getAllByText(/旧题目/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "标题" }), { target: { value: "人工题目" } });
    await userEvent.click(screen.getByRole("button", { name: "保存人工输入" }));

    expect(onInputOverride).toHaveBeenCalledWith("script", {
      input: { brief: { title: "人工题目" } },
    });
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

    await userEvent.click(screen.getByText("调整这个角色收到的内容"));
    expect(screen.getByText("历史任务推断输入")).toBeInTheDocument();
    expect(screen.getByText(/旧任务没有保存当时的原始输入/)).toBeInTheDocument();
  });

  it("does not offer an input editor when a legacy node only saved technical paths", () => {
    render(<NodeWorkspace
      node={{
        ...succeededNode,
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
      }}
      runStatus="stale"
      artifacts={[]}
      busy={false}
      onOverride={async () => undefined}
      onInputOverride={async () => undefined}
      onAuthorize={async () => undefined}
    />);

    expect(screen.queryByText("调整这个角色收到的内容")).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/runs/)).not.toBeInTheDocument();
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

    await userEvent.click(screen.getByRole("button", { name: "检查并确认" }));
    expect(screen.getByText("编剧 · 脚本")).toBeInTheDocument();
    expect(screen.getByText("人工版本")).toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "每一分钱都能追到节点" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /付费成片/ })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.getAllByText("¥3.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 笔待核对/).length).toBeGreaterThan(0);
  });
});
