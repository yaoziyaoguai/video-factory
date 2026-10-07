import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import { RunPage } from "../src/client/pages/RunPage.js";
import { studioApi } from "../src/client/api.js";
import type { StudioProvider, StudioRunDetail } from "../src/shared/api.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const providers: StudioProvider[] = [
  { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", billing: "free", deliveryTypes: ["stock_video"] },
  { id: "wan-video-v1", capability: "asset.prepare", label: "通义万相视频", available: true, kind: "external", billing: "metered", deliveryTypes: ["generated_video"], defaultModelId: "wan-video", modelProfiles: [
    { id: "wan-video", providerId: "wan-video-v1", providerFamily: "dashscope-video", label: "Wan 视频", description: "文生视频", available: true, taskTypes: ["text-to-video"] },
  ] },
  { id: "unavailable-video", capability: "asset.prepare", label: "不可用视频服务", available: false, kind: "external", billing: "metered", deliveryTypes: ["generated_video"] },
  { id: "test-source", capability: "asset.prepare", label: "测试素材服务", available: true, kind: "test" },
];

function planningRun(): StudioRunDetail {
  return {
    id: "run-source-access", title: "制作中修改画面来源", status: "needs_human", platform: "douyin",
    durationSeconds: 24, startedAt: "2026-10-07T00:00:00Z", currentNodeId: "creative-planning",
    revision: 8, angle: "可选择的画面", audience: "创作者", nicheSlug: "source-access", reviewMode: "manual",
    artifacts: [], decisions: [],
    activeIntervention: { id: "planning-stop", nodeId: "creative-planning", kind: "creative_review", reason: "确认当前稿", options: ["approve", "request_changes"], createdAt: "2026-10-07T00:00:00Z" },
    nodes: [
      { id: "creative-planning", label: "创作规划", role: "创作团队", status: "needs_human", artifactIds: [], qualityGateResults: [] },
      { id: "assets", label: "画面", role: "素材导演", status: "pending", artifactIds: [], qualityGateResults: [], executionConfiguration: {
        providerId: "ai-shot-router-v1", modelSelections: {}, assetProviderIds: ["pexels-stock-v1"], economics: { allowMeteredProviders: false },
      } },
    ],
  };
}

describe("in-production asset source access", () => {
  it("keeps the existing voice permission when saving only free visual sources", async () => {
    const run = planningRun();
    run.nodes[1]!.executionConfiguration!.economics = { allowMeteredProviders: true };
    const configure = vi.fn(async () => undefined);
    render(<RunWorkbench run={run} providers={providers} decisionPending={false} onDecision={vi.fn()} onConfigureNode={configure} />);
    const editor = within(screen.getByRole("region", { name: "本片画面来源" }));
    await userEvent.click(editor.getByRole("button", { name: "调整" }));
    await userEvent.click(editor.getByRole("button", { name: "保存选择" }));
    expect(configure).toHaveBeenCalledExactlyOnceWith("assets", expect.objectContaining({
      assetProviderIds: ["pexels-stock-v1"], economics: { allowMeteredProviders: true },
    }));
  });

  it("keeps unsaved script edits safe through the real page and sends the source change to the existing API only", async () => {
    const storage = new Map<string, string>();
    const memoryStorage = () => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("sessionStorage", memoryStorage());
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
    const run = planningRun();
    vi.spyOn(studioApi, "run").mockResolvedValue(run);
    vi.spyOn(studioApi, "runCosts").mockRejectedValue(new Error("no cost fixture"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "creativeReviewHistory").mockResolvedValue({ runId: run.id, legacyIncomplete: false, entries: [] });
    vi.spyOn(studioApi, "creativeReview").mockResolvedValue({ runId: run.id, runRevision: run.revision, stage: "script", reviewRevision: 1,
      draftSha256: "a".repeat(64), draftArtifactId: "script-current", phase: "waiting_user", allowedActions: ["confirm", "edit_draft", "discuss", "revise"], returnTargets: [],
      draft: { narrativeArc: "观察到行动", scenes: [{ position: 1, duration: 8, narration: "当前旁白", visual_prompt: "窗边光影" }] },
      messages: [], proposals: [], effectiveUserInstructions: [], blockingIssues: [] });
    const configure = vi.spyOn(studioApi, "configureNode").mockImplementation(async (_run, _node, input) => ({ ...run, revision: 9, status: "stale",
      nodes: run.nodes.map(node => node.id === "assets" ? { ...node, status: "stale", executionConfiguration: { ...node.executionConfiguration!,
        assetProviderIds: input.assetProviderIds!, economics: input.economics! } } : node) }));
    const command = vi.spyOn(studioApi, "commandCreativeReview");
    render(<MemoryRouter initialEntries={[`/projects/${run.id}`]}><Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes></MemoryRouter>);
    const editor = within(await screen.findByRole("region", { name: "本片画面来源" }));
    await userEvent.click(await screen.findByText("手动修订这份稿件"));
    fireEvent.change(screen.getByLabelText("分镜 1 · 旁白"), { target: { value: "尚未保存的用户旁白" } });
    expect(await editor.findByText(/请先保存或放弃当前稿件/)).toBeVisible();
    expect(editor.queryByRole("button", { name: "调整" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("尚未保存的用户旁白");
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await userEvent.click(editor.getByRole("button", { name: "调整" }));
    await userEvent.click(editor.getByRole("checkbox", { name: /通义万相视频/ }));
    await userEvent.click(editor.getByRole("button", { name: "保存选择" }));
    await waitFor(() => expect(configure).toHaveBeenCalledExactlyOnceWith(run.id, "assets", expect.objectContaining({ expectedRunRevision: 8, assetProviderIds: ["pexels-stock-v1", "wan-video-v1"] })));
    await waitFor(() => expect(editor.queryByRole("button", { name: "保存选择" })).not.toBeInTheDocument());
    expect(editor.getByText(/Pexels 视频、通义万相视频/)).toBeVisible();
    expect(command).not.toHaveBeenCalled();
  });

  it("exposes the existing source editor during creative review and saves only an explicit per-run selection", async () => {
    const configure = vi.fn(async () => undefined);
    const decide = vi.fn();
    const authorize = vi.fn();
    render(<RunWorkbench run={planningRun()} providers={providers} creativeDiscussion={<section aria-label="当前稿件">当前脚本</section>}
      decisionPending={false} onDecision={decide} onConfigureNode={configure} onAuthorizeSpend={authorize} />);
    const editor = within(screen.getByRole("region", { name: "本片画面来源" }));
    expect(editor.getByText(/Pexels 视频.*当前不调用付费生成/)).toBeVisible();
    await userEvent.click(editor.getByRole("button", { name: "调整" }));
    expect(editor.getByRole("checkbox", { name: /Pexels 视频/ })).toBeChecked();
    expect(editor.getByRole("checkbox", { name: /通义万相视频/ })).not.toBeChecked();
    expect(editor.queryByRole("checkbox", { name: /不可用视频|测试素材/ })).not.toBeInTheDocument();
    expect(editor.getByText(/保存不会开始生成或付费/)).toBeVisible();
    await userEvent.click(editor.getByRole("checkbox", { name: /通义万相视频/ }));
    await userEvent.selectOptions(editor.getByRole("combobox", { name: "通义万相视频模型" }), "wan-video");
    expect(editor.getByText(/逐笔人工确认/)).toBeVisible();
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(editor.getByRole("button", { name: "保存选择" }));
    expect(configure).toHaveBeenCalledExactlyOnceWith("assets", {
      expectedRunRevision: 8, assetProviderIds: ["pexels-stock-v1", "wan-video-v1"],
      modelSelections: { "pexels-stock-v1": null, "wan-video-v1": "wan-video" }, economics: { allowMeteredProviders: true },
    });
    expect(decide).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("cancels without saving and can replace rather than merely add a source", async () => {
    const configure = vi.fn(async () => undefined);
    render(<RunWorkbench run={planningRun()} providers={providers} decisionPending={false} onDecision={vi.fn()} onConfigureNode={configure} />);
    const editor = within(screen.getByRole("region", { name: "本片画面来源" }));
    await userEvent.click(editor.getByRole("button", { name: "调整" }));
    await userEvent.click(editor.getByRole("checkbox", { name: /通义万相视频/ }));
    await userEvent.click(editor.getByRole("button", { name: "取消" }));
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(editor.getByRole("button", { name: "调整" }));
    expect(editor.getByRole("checkbox", { name: /通义万相视频/ })).not.toBeChecked();
    await userEvent.click(editor.getByRole("checkbox", { name: /Pexels 视频/ }));
    await userEvent.click(editor.getByRole("button", { name: "保存选择" }));
    expect(editor.getByRole("alert")).toHaveTextContent("至少保留一个画面来源");
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(editor.getByRole("checkbox", { name: /通义万相视频/ }));
    await userEvent.click(editor.getByRole("button", { name: "保存选择" }));
    expect(configure).toHaveBeenCalledExactlyOnceWith("assets", expect.objectContaining({ assetProviderIds: ["wan-video-v1"] }));
  });

  it("has only one editor even when the assets workspace becomes visible, and retains the opening revision on conflicts", async () => {
    const configure = vi.fn(async () => { throw new Error("这条制作已被其他操作更新，请刷新后重试。"); });
    const run = planningRun();
    const props = { providers, decisionPending: false, onDecision: vi.fn(), onConfigureNode: configure };
    const view = render(<RunWorkbench run={run} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /通义万相视频/ }));
    view.rerender(<RunWorkbench run={{ ...run, revision: 9, nodes: run.nodes.map(node => node.id === "assets" ? { ...node, status: "stale" } : node) }} {...props} />);
    expect(screen.getAllByRole("region", { name: "本片画面来源" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "保存选择" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
    expect(configure).toHaveBeenCalledExactlyOnceWith("assets", expect.objectContaining({ expectedRunRevision: 8 }));
    expect(screen.getByRole("checkbox", { name: /通义万相视频/ })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("已被其他操作更新");
  });

  it.each(["running", "unknown", "legacy", "busy"] as const)("does not open an unsafe edit while %s", async (mode) => {
    const run = planningRun();
    if (mode === "running") run.status = "running";
    if (mode === "unknown") run.nodes[0]!.outcomeUncertain = true;
    if (mode === "legacy") run.continuation = { supported: false, reason: "旧版仅可查看" };
    const configure = vi.fn();
    render(<RunWorkbench run={run} providers={providers} decisionPending={false} nodeMutationPending={mode === "busy"}
      onDecision={vi.fn()} onConfigureNode={configure} />);
    const editor = within(screen.getByRole("region", { name: "本片画面来源" }));
    const button = editor.queryByRole("button", { name: "调整" });
    if (button) { expect(button).toBeDisabled(); await userEvent.click(button); }
    expect(editor.queryByRole("button", { name: "保存选择" })).not.toBeInTheDocument();
    expect(configure).not.toHaveBeenCalled();
  });

  it("disables an already open editor when execution begins instead of submitting against a running node", async () => {
    const run = planningRun();
    const configure = vi.fn();
    const props = { providers, decisionPending: false, onDecision: vi.fn(), onConfigureNode: configure };
    const view = render(<RunWorkbench run={run} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "调整" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /通义万相视频/ }));
    view.rerender(<RunWorkbench run={{ ...run, status: "running" }} {...props} />);
    expect(screen.getByRole("button", { name: "保存选择" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /通义万相视频/ })).toBeDisabled();
    expect(configure).not.toHaveBeenCalled();
  });
});
