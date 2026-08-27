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
    status: "succeeded",
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
  },
};

describe("node production workspaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows provenance and saves a valid human output version", async () => {
    const onOverride = vi.fn(async () => undefined);
    render(<NodeWorkspace node={succeededNode} runStatus="stale" artifacts={[]} busy={false} onOverride={onOverride} onInputOverride={async () => undefined} onAuthorize={async () => undefined} />);

    await userEvent.click(screen.getByRole("tab", { name: "角色与模型" }));
    expect(screen.getByText("codex-screenwriter-v1")).toBeInTheDocument();
    expect(screen.getByText("codex", { selector: "span" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "输出" }));
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "脚本交付内容" }), { target: { value: "{\"hook\":\"人工钩子\"}" } });
    await userEvent.click(screen.getByRole("button", { name: "保存为人工版本" }));

    expect(onOverride).toHaveBeenCalledWith("script", {
      output: { hook: "人工钩子" },
    });
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

    await userEvent.click(screen.getByRole("tab", { name: "输入" }));
    expect(screen.getByText(/旧题目/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑输入" }));
    fireEvent.change(screen.getByRole("textbox", { name: "脚本输入内容" }), {
      target: { value: "{\"brief\":{\"title\":\"人工题目\"}}" },
    });
    await userEvent.click(screen.getByRole("button", { name: "保存为人工输入版本" }));

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

    await userEvent.click(screen.getByRole("tab", { name: "输入" }));
    expect(screen.getByText("历史任务推断输入")).toBeInTheDocument();
    expect(screen.getByText(/历史记录未保存原始输入/)).toBeInTheDocument();
  });

  it("shows the immutable prompt pack, provider, model, and exact prompt for the effective version", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      version: "video-factory/model-trace-v1",
      taskKind: "script-draft",
      promptVersion: "video-factory/screenwriter-v2",
      providerId: "openai",
      modelId: "gpt-5.4",
      prompt: "Prompt Pack: video-factory/screenwriter-v2\n实际发送内容",
    }), { status: 200, headers: { "content-type": "application/json" } })));
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

    await userEvent.click(screen.getByRole("tab", { name: "实际 Prompt" }));

    expect(await screen.findByText("video-factory/screenwriter-v2")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.4")).toBeInTheDocument();
    expect(screen.getByText(/实际发送内容/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "脚本交付内容" }), {
      target: { value: "{\"title\":\"人工脚本\",\"scenes\":[{\"narration\":\"人工旁白\"}]}" },
    });
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
      source: String(input).includes("current") ? "current" : "old",
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

    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
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
    expect(screen.getByText("暂不可打开 · 尚无文件地址").closest("span")).toHaveAttribute("aria-disabled", "true");
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

    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
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
    expect(screen.getAllByText(/1 笔待回填/).length).toBeGreaterThan(0);
  });
});
