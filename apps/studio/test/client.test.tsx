/// <reference types="node" />

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewRunDialog } from "../src/client/components/NewRunDialog.js";
import { VoiceStudio } from "../src/client/components/VoiceStudio.js";
import { VOICE_PRESETS } from "../src/shared/template-voice-recommendation.js";
import { studioApi, subscribeToRun } from "../src/client/api.js";
import { ProductionQueue } from "../src/client/components/ProductionQueue.js";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import { MultiPlatformPublishDialog } from "../src/client/components/MultiPlatformPublishDialog.js";
import { preferRunSnapshot, RunPage } from "../src/client/pages/RunPage.js";
import type { StudioCreatorSettings, StudioDecisionInput, StudioProvider, StudioRunDetail, StudioRunSummary, StudioTemplate } from "../src/shared/api.js";

const runSummary: StudioRunSummary = {
  id: "run-1",
  title: "做决定前，先避开这 3 个坑",
  status: "needs_human",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-08-21T10:00:00.000Z",
  currentNodeId: "final-review",
  nextAction: "review",
};

const providers: StudioProvider[] = [
  { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "local" },
  { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
  { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑卡片", available: true, kind: "local", deliveryTypes: ["editorial_card"] },
  { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", status: "ready", deliveryTypes: ["stock_video", "stock_image"] },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "macOS 系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "FFmpeg 竖屏渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "本地技术审片", available: true, kind: "local" },
  { id: "glm-visual-review-v1", capability: "quality.review.visual", label: "GLM-5.3-Flash 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "glm-5.3-flash" },
  { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
  { id: "codex-role-auditor-v1", capability: "role.audit", label: "Codex 独立质量审计", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
];

function template(id: string, name: string): StudioTemplate {
  return {
    id,
    version: 3,
    status: "published",
    name,
    description: `${name}模板`,
    category: "knowledge",
    platforms: ["douyin"],
    durationSeconds: 24,
    automationLevel: "assisted",
    storyStructure: [
      { id: "hook", label: "开场", purpose: "抓住注意", required: true },
      { id: "body", label: "解释", purpose: "展开内容", required: true },
      { id: "close", label: "收束", purpose: "留下结论", required: true },
    ],
    shotSlots: [{ id: "shot", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
    visualSystem: { composition: "主体清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
    qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    builtIn: true,
  };
}

function renderReworkDialog(
  rework: NonNullable<import("../src/shared/api.js").StudioProductionInput["rework"]>,
  title = "返工镜头全集与影响步骤",
  onSubmit = vi.fn(),
  requiredAffectedScenePositions?: number[],
) {
  return render(<NewRunDialog
    open
    providers={providers}
    initialValues={{
      title,
      angle: "按上一版真实资料展示返工事实",
      audience: "短视频创作者",
      nicheSlug: "rework-review-fixes",
      providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      economics: { recipeId: "free-stock", allowMeteredProviders: false },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      rework,
    }}
    {...(requiredAffectedScenePositions ? { requiredAffectedScenePositions } : {})}
    onClose={() => undefined}
    onSubmit={onSubmit}
  />);
}

beforeEach(() => {
  vi.spyOn(studioApi, "templates").mockResolvedValue({
    storeRevision: 0,
    templates: [template("knowledge-explainer", "知识解释"), template("photo-story", "照片故事"), template("trend-fact-brief", "热点事实简报")],
  });
  vi.spyOn(studioApi, "voices").mockResolvedValue([
    { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
  ]);
  vi.spyOn(studioApi, "voicePreview").mockResolvedValue("blob:default-preview");
});

const runDetail: StudioRunDetail = {
  ...runSummary,
  revision: 3,
  continuation: { supported: true },
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  reviewMode: "manual",
  nodes: [
    { id: "brief", label: "需求校验", role: "制片人", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { title: "做决定前，先避开这 3 个坑", angle: "低风险、可收藏的生活清单", audience: "有决策压力的普通上班族" } },
    { id: "visual-direction", label: "导演方案", role: "导演", status: "succeeded", artifactIds: [], qualityGateResults: [] },
    { id: "final-review", label: "人工终审", role: "总导演", status: "needs_human", artifactIds: [], qualityGateResults: [] },
    { id: "publish-package", label: "发布包", role: "制片人", status: "pending", artifactIds: [], qualityGateResults: [] },
  ],
  artifacts: [
    { id: "script", kind: "script", producerNodeId: "script", createdAt: "2026-08-21T10:00:10.000Z", contentType: "application/json", contentUrl: "/api/script" },
    { id: "video", kind: "render", producerNodeId: "render", createdAt: "2026-08-21T10:00:30.000Z", contentType: "video/mp4", contentUrl: "/api/video" },
  ],
  decisions: [],
  activeIntervention: {
    id: "intervention-1",
    nodeId: "final-review",
    reason: "请完整观看成片，确认内容和节奏。",
    options: ["approve", "reject"],
    createdAt: "2026-08-21T10:01:00.000Z",
  },
  videoArtifactId: "video",
};

describe("Studio client", () => {
  it.each([false, true])("settles an adopted proposal at the same run revision, including lost submit response (%s)", async (lostResponse) => {
    vi.restoreAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
    const user = userEvent.setup();
    const initial: StudioRunDetail = {
      ...runDetail, currentNodeId: "creative-planning", artifacts: [],
      nodes: [{ id: "creative-planning", label: "创作规划", status: "needs_human", artifactIds: [], qualityGateResults: [] }],
      activeIntervention: { id: "review", nodeId: "creative-planning", kind: "creative_review", reason: "等你确认", options: ["approve", "request_changes"], createdAt: runDetail.startedAt },
    };
    delete initial.videoArtifactId;
    const oldReview: import("../src/shared/api.js").StudioCreativeReviewSnapshot = {
      runId: initial.id, runRevision: initial.revision, stage: "treatment", reviewRevision: 1,
      draftSha256: "a".repeat(64), draftArtifactId: "draft", phase: "waiting_user",
      allowedActions: ["discuss", "adopt_proposal", "confirm"], returnTargets: [],
      draft: { payoff: "当前旧结尾" }, messages: [], effectiveUserInstructions: [], blockingIssues: [],
      proposals: [{ proposalId: "alternative", baseDraftSha256: "a".repeat(64), document: { payoff: "采用后的新结尾" }, changeSummary: ["替换结尾"] }],
    };
    let adopted = false;
    vi.spyOn(studioApi, "run").mockImplementation(async () => structuredClone(initial));
    vi.spyOn(studioApi, "runCosts").mockRejectedValue(new Error("no cost fixture"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "creativeReview").mockImplementation(async () => adopted
      ? { ...oldReview, reviewRevision: 2, draftSha256: "b".repeat(64), draft: { payoff: "采用后的新结尾" }, proposals: [] }
      : oldReview);
    const post = vi.spyOn(studioApi, "commandCreativeReview").mockImplementation(async (_id, input) => {
      adopted = true;
      if (lostResponse) throw new Error("response lost after acceptance");
      return { commandId: input.commandId, status: "completed", observationUrl: "/unused" };
    });
    vi.spyOn(studioApi, "creativeReviewCommand").mockImplementation(async (_id, commandId) => ({ commandId, status: "completed", observationUrl: "/unused" }));
    render(<MemoryRouter initialEntries={["/projects/run-1"]}><Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "采用这个备选" }));
    await waitFor(() => expect(within(screen.getByRole("article", { name: "当前导演方案" })).getByText("采用后的新结尾")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "确认当前方案，继续" })).toBeEnabled();
    expect(screen.queryByText("正在处理原操作")).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it("types voice timing as an action-discriminated decision", () => {
    const requestChanges: StudioDecisionInput = {
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    };
    // @ts-expect-error request_changes 必须携带配音时长调整。
    const missingVoiceTiming: StudioDecisionInput = {
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
    };
    // @ts-expect-error approve 禁止携带配音时长调整。
    const approveWithVoiceTiming: StudioDecisionInput = {
      action: "approve",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    };

    expect(requestChanges.voiceTiming.durationSeconds).toBe(8.2);
    expect(missingVoiceTiming.action).toBe("request_changes");
    expect(approveWithVoiceTiming.action).toBe("approve");
  });

  it("never lets an older polled snapshot overwrite newer run progress", () => {
    const newer = {
      ...runDetail,
      revision: 9,
      status: "succeeded" as const,
      planningStages: [{ id: "director" as const, status: "failed" as const, artifactIds: [], allowedActions: [] }],
    };
    const older = { ...runDetail, revision: 8, status: "running" as const };
    const sameRevision = { ...runDetail, revision: 9, status: "needs_human" as const };

    expect(preferRunSnapshot(newer, older)).toBe(newer);
    expect(preferRunSnapshot(newer, sameRevision)).toMatchObject({
      status: "needs_human",
      planningStages: newer.planningStages,
    });
    expect(preferRunSnapshot(undefined, older)).toBe(older);
  });

  it("shows an actionable error when the terminal event cannot be reconciled with authoritative detail", async () => {
    const { activeIntervention: _activeIntervention, ...runWithoutIntervention } = runDetail;
    const terminalRun: StudioRunDetail = {
      ...runWithoutIntervention,
      status: "failed",
      nodes: runDetail.nodes.map((node, index) => index === 0
        ? { ...node, status: "failed", error: "轻量事件只包含概要错误" }
        : node),
    };
    vi.spyOn(studioApi, "run")
      .mockResolvedValueOnce(terminalRun)
      .mockRejectedValueOnce(new Error("detail endpoint unavailable"));
    vi.spyOn(studioApi, "runCosts").mockRejectedValue(new Error("cost fixture unavailable"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByText(/最终状态详情读取失败/)).toHaveTextContent(/请刷新页面重读.*不会重新执行模型或付费任务/);
  });

  it("reports a dropped run event stream while leaving EventSource reconnection active", () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    class FakeEventSource {
      addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); }
      close = close;
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const disconnected = vi.fn();
    const heartbeat = vi.fn();

    const unsubscribe = subscribeToRun("run-1", vi.fn(), disconnected, heartbeat);
    listeners.get("heartbeat")?.(new MessageEvent("heartbeat", { data: JSON.stringify({ at: "2026-08-30T10:00:00.000Z" }) }));
    expect(heartbeat).toHaveBeenCalledWith("2026-08-30T10:00:00.000Z");
    listeners.get("error")?.(new Event("error"));

    expect(disconnected).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    unsubscribe();
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("directs and previews a concrete local Chinese voice", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Meijia", providerId: "macos-say-v1", label: "Meijia", locale: "zh-CN", engine: "macos", curated: true },
    ]);
    const preview = vi.spyOn(studioApi, "voicePreview").mockResolvedValue("blob:voice-preview");
    const onChange = vi.fn();
    render(<VoiceStudio
      value={{ profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" }}
      onChange={onChange}
    />);

    await screen.findByRole("radio", { name: /Meijia/ });
    await user.click(screen.getByRole("radio", { name: /Meijia/ }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: "macos:Meijia" }), "macos-say-v1");

    await user.click(screen.getByRole("button", { name: "试听 Meijia" }));
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "macos:Meijia",
      masteringPreset: "natural",
    }));
    expect(await screen.findByLabelText("声音试听")).toHaveAttribute("src", "blob:voice-preview");

    await user.click(screen.getByRole("button", { name: /高级微调/ }));
    await user.click(screen.getByRole("radio", { name: "社交清晰" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ masteringPreset: "social" }), "macos-say-v1");

    fireEvent.change(screen.getByRole("slider", { name: "语速" }), { target: { value: "205" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 205 }), "macos-say-v1");

    await user.click(screen.getByRole("button", { name: "降低语速" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 200 }), "macos-say-v1");
    await user.click(screen.getByRole("button", { name: "增加停顿" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pauseScale: 1.1 }), "macos-say-v1");
  });

  it("starts with a concise voice shortlist and exposes every system voice through filters", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Flo", providerId: "macos-say-v1", label: "Flo", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Meijia", providerId: "macos-say-v1", label: "Meijia", locale: "zh-CN", engine: "macos", curated: true },
    ]);
    render(<VoiceStudio value={{ profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" }} onChange={() => undefined} />);

    expect(await screen.findByRole("tab", { name: /推荐/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("radio", { name: /Flo/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /系统音色/ }));
    expect(screen.getByRole("radio", { name: /Flo/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Meijia/ })).toBeInTheDocument();
  });

  it("keeps the selected voice visible when browsing a category it does not belong to", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:DefaultMan", providerId: "macos-say-v1", label: "默认男声", locale: "zh-CN", engine: "macos", gender: "male", curated: true },
      { id: "macos:CandidateWoman", providerId: "macos-say-v1", label: "备选女声", locale: "zh-CN", engine: "macos", gender: "female", curated: true },
    ]);
    const onChange = vi.fn();
    render(<VoiceStudio value={{ profileId: "macos:DefaultMan", rate: 185, pauseScale: 1, masteringPreset: "natural" }} onChange={onChange} />);

    await user.click(await screen.findByRole("tab", { name: /女声/ }));

    expect(screen.getByRole("radio", { name: /默认男声/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /备选女声/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("当前所选声音“默认男声”不属于这个分类");
    expect(screen.getByRole("status")).toHaveTextContent("切换分类不会更改已选声音");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["macos:Tingting", "macos:Meijia", "minimax:female-chengshu"])("applies every rhythm suggestion without replacing actor %s", async (profileId) => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Meijia", providerId: "macos-say-v1", label: "Meijia", locale: "zh-CN", engine: "macos", curated: true },
      { id: "minimax:female-chengshu", providerId: "minimax-tts-v1", label: "成熟女声", locale: "zh-CN", engine: "minimax", curated: true },
    ]);
    const onChange = vi.fn();
    render(<VoiceStudio
      value={{ profileId, rate: 185, pauseScale: 1, masteringPreset: "natural" }}
      onChange={onChange}
    />);

    for (const preset of VOICE_PRESETS) {
      await user.click(await screen.findByRole("button", { name: new RegExp(preset.label) }));
      expect(onChange).toHaveBeenLastCalledWith({ profileId, rate: preset.rate, pauseScale: preset.pauseScale, masteringPreset: preset.masteringPreset }, profileId.startsWith("macos:") ? "macos-say-v1" : "minimax-tts-v1");
    }
  });

  it("requires an explicit actor selection when the saved voice is unavailable", async () => {
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "minimax:Chinese (Mandarin)_News_Anchor", providerId: "minimax-tts-v1", label: "新闻女声", locale: "zh-CN", engine: "minimax", curated: true },
      { id: "minimax:female-chengshu", providerId: "minimax-tts-v1", label: "成熟女声", locale: "zh-CN", engine: "minimax", curated: true },
    ]);
    const onChange = vi.fn();
    render(<VoiceStudio
      value={{ profileId: "macos:Meijia", rate: 170, pauseScale: 1.2, masteringPreset: "intimate" }}
      onChange={onChange}
    />);

    await screen.findByRole("radio", { name: /成熟女声/ });
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /人物纪实/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请先选择一个可用演员");
    await userEvent.click(screen.getByRole("radio", { name: /成熟女声/ }));
    expect(onChange).toHaveBeenCalledWith({
      profileId: "minimax:female-chengshu",
      rate: 170,
      pauseScale: 1.2,
      masteringPreset: "intimate",
    }, "minimax-tts-v1");
  });

  it("explains why production voice is unavailable instead of leaving an empty panel", async () => {
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);

    render(<VoiceStudio value={{ profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" }} onChange={() => undefined} />);

    expect(await screen.findByText("当前没有正式配音演员")).toBeInTheDocument();
    expect(screen.getByText(/测试音轨不会用于成片/)).toBeInTheDocument();
  });

  it("presents production state and the next human action in a scannable queue", async () => {
    const user = userEvent.setup();
    const failed = { ...runSummary, id: "run-3", title: "生成失败、等待处理", status: "failed" as const };
    render(
      <MemoryRouter>
        <ProductionQueue runs={[runSummary, { ...runSummary, id: "run-2", title: "已经完成的内容", status: "succeeded" }, failed]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "制作记录", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建制作" })).toHaveClass("project-create-button");
    expect(screen.getByText(runSummary.title)).toBeInTheDocument();
    expect(screen.getAllByText("等你审片").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /进入审片/ })[0]).toHaveAttribute("href", "/projects/run-1");
    expect(screen.getByText("待你处理", { selector: ".project-edition span" }).closest("div")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "筛选：待你处理" }));
    expect(screen.getByText("生成失败、等待处理")).toBeInTheDocument();
    expect(screen.queryByText("已经完成的内容")).not.toBeInTheDocument();
  });

  it("renders historical production progress from that run's actual workflow", () => {
    const historical = {
      ...runSummary,
      workflowNodeIds: ["brief", "script", "visual-direction", "assets", "voice", "render", "technical-review", "visual-review", "final-review"],
    };
    const { container } = render(
      <MemoryRouter>
        <ProductionQueue runs={[historical]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    const progress = container.querySelector(".project-progress");
    expect(progress?.querySelectorAll("span")).toHaveLength(historical.workflowNodeIds.length);
    expect(progress?.querySelector('[title="生成画面预检"]')).not.toBeInTheDocument();
  });

  it("keeps the mobile production create icon visible on its primary background", () => {
    const css = readFileSync(resolve(process.cwd(), "src/client/studio-v3.css"), "utf8");

    expect(css).toMatch(/\.project-create-button\s+svg\s*\{[^}]*color:\s*#ffffff;/);
  });

  it("does not reserve an empty provider panel height above the mobile asset source pool", () => {
    const css = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");

    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.provider-browser\s*\{\s*min-height:\s*0;/);
  });

  it("keeps the skip link invisible until keyboard focus on any viewport", () => {
    const css = readFileSync(resolve(process.cwd(), "src/client/styles.css"), "utf8");

    // 默认态必须用 opacity 隐藏并禁用指针：transform 位移在移动端弹窗等包含块变化下会失效露出。
    expect(css).toMatch(/\.skip-link\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
    expect(css).toMatch(/\.skip-link:focus\s*\{[^}]*opacity:\s*1;/);
    expect(css).not.toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY/);
  });

  it("archives completed records and keeps permanent deletion inside the archive", async () => {
    const user = userEvent.setup();
    const completed = { ...runSummary, id: "run-2", title: "已经完成的内容", status: "succeeded" as const };
    const archived = { ...completed, archivedAt: "2026-08-30T08:00:00.000Z" };
    const onArchive = vi.fn().mockResolvedValue(undefined);
    const onRestore = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <MemoryRouter>
        <ProductionQueue runs={[runSummary, completed]} loading={false} onCreate={() => undefined} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: /永久删除制作记录/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "归档制作记录：已经完成的内容" }));
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith([completed]));

    rerender(
      <MemoryRouter>
        <ProductionQueue runs={[runSummary, archived]} loading={false} onCreate={() => undefined} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /归档 1/ }));
    await user.click(screen.getByRole("button", { name: "恢复制作记录：已经完成的内容" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith([archived]));
    await user.click(screen.getByRole("button", { name: "永久删除制作记录：已经完成的内容" }));
    expect(screen.getByRole("dialog", { name: /确定删除/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(archived));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("bulk archives selected terminal records", async () => {
    const user = userEvent.setup();
    const first = { ...runSummary, id: "run-2", title: "成片一", status: "succeeded" as const };
    const second = { ...runSummary, id: "run-3", title: "成片二", status: "failed" as const };
    const onArchive = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <ProductionQueue runs={[runSummary, first, second]} loading={false} onCreate={() => undefined} onArchive={onArchive} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("checkbox", { name: "选择制作记录：成片一" }));
    await user.click(screen.getByRole("checkbox", { name: "选择制作记录：成片二" }));
    await user.click(screen.getByRole("button", { name: "批量归档" }));

    await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());
    const archivedRuns = onArchive.mock.calls[0]![0];
    expect(archivedRuns).toHaveLength(2);
    expect(archivedRuns).toEqual(expect.arrayContaining([first, second]));
  });

  it("creates a valid free-stock production brief without auto-selecting editorial cards", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const { rerender } = render(
      <NewRunDialog open providers={providers} onClose={onClose} onSubmit={onSubmit} />,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await user.type(screen.getByLabelText("视频标题"), "下班后别急着做这 3 件事");
    await user.type(screen.getByLabelText("内容角度"), "用三条具体动作减少下班后的决策消耗");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    expect(screen.queryByLabelText("选题系列")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /仅免费画面/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "导演角色" })).toHaveValue("auto");
    expect(screen.getByText(/AI 根据题材选择导演语法/)).toBeInTheDocument();
    expect(screen.getByLabelText("费用方式")).toHaveTextContent("图片 / 视频无现金报价");
    expect(screen.queryByRole("button", { name: /画面素材/ })).not.toBeInTheDocument();
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.click(screen.getByRole("button", { name: /画面素材/ }));
    expect(screen.getByRole("radio", { name: /AI 逐镜选择画面来源/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Pexels 图库/ })).toBeChecked();
    expect(screen.getByRole("option", { name: "20 秒" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "18 秒" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: "下班后别急着做这 3 件事",
      nicheSlug: expect.stringMatching(/^topic-[a-f0-9]{8}$/),
      protocolVersion: "video-factory/brief-v1",
      reviewMode: "manual",
      runPurpose: "production",
      providers: expect.objectContaining({ script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1" }),
      director: {
        profileId: "auto",
        assetProviderIds: ["pexels-stock-v1"],
      },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
      economics: {
        recipeId: "free-stock",
        allowMeteredProviders: false,
      },
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("visualPlan");
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("visualIntent");

    rerender(<NewRunDialog open={false} providers={providers} onClose={onClose} onSubmit={onSubmit} />);
    rerender(<NewRunDialog open providers={providers} onClose={onClose} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
  });

  it("drops a stale suggested visual plan when the creator rewrites its visual intent", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const visualPlan = {
      strategy: "用真实标题并列和确定性标尺贯穿全片，禁止拼成虚构传播链。",
      beats: [{
        id: "headline-certainty-scale",
        role: "证据并列",
        duration: "0-8 秒",
        description: "左右并列两条真实标题，高亮“网传”和“正在核查”。",
        searchQuery: "source headline screenshot certainty scale",
        source: "screen" as const,
      }],
    };
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "同一事件为什么有不同确定性",
        angle: "先比较标题证据，不猜传播链",
        audience: "想核验热点的普通观众",
        nicheSlug: "headline-certainty",
        visualProof: "两条真实标题的措辞差异可以直接并列核对。",
        visualPlan,
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    const creativeSummary = screen.getByRole("region", { name: "创作目标摘要" });
    expect(within(creativeSummary).getByText("想核验热点的普通观众")).toBeInTheDocument();
    expect(within(creativeSummary).getByText("先比较标题证据，不猜传播链")).toBeInTheDocument();
    expect(within(creativeSummary).getByText("两条真实标题的措辞差异可以直接并列核对。")).toBeInTheDocument();
    expect(within(creativeSummary).getByText("围绕“同一事件为什么有不同确定性”给出明确答案或可执行判断")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("必须让观众看到的证据（可选）"));
    await user.type(screen.getByLabelText("必须让观众看到的证据（可选）"), "两张来源截图必须在同一屏内完整可读。");
    await user.clear(screen.getByLabelText("视觉论证方式（可选）"));
    await user.type(screen.getByLabelText("视觉论证方式（可选）"), "先并列原始截图，再逐项标出措辞差异。");

    await user.click(await screen.findByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      visualProof: "两张来源截图必须在同一屏内完整可读。",
      visualIntent: "先并列原始截图，再逐项标出措辞差异。",
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("visualPlan");
  });

  it("keeps an untouched upstream visual plan as optional guidance instead of a user requirement", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const visualPlan = {
      strategy: "用三组构图示意展示视觉重心变化。",
      beats: [{
        id: "composition-guidance",
        role: "构图对比",
        duration: "0-8 秒",
        description: "同一无字杯子在相同背景中只改变主体位置。",
        searchQuery: "cup composition negative space",
        source: "generated" as const,
      }],
    };
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "构图如何改变视觉重心",
        angle: "用示意解释主体位置与负空间",
        audience: "短视频创作者",
        nicheSlug: "composition-guidance",
        visualPlan,
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getByLabelText("视觉论证方式（可选）")).toHaveValue("");
    expect(screen.getByText(/可参考的方向：用三组构图示意展示视觉重心变化/)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      visualPlan,
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("visualIntent");
  });

  it("waits for providers and creator settings before initializing an open production dialog", async () => {
    const creatorSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" as const },
      defaultRecipeId: "free-stock" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      defaultAssetProviderId: "pexels-stock-v1",
      productionDefaults: { directorProfileId: "documentary-observer", reviewMode: "manual", platform: "bilibili", durationSeconds: 30 },
    } satisfies StudioCreatorSettings;
    const { rerender } = render(<NewRunDialog
      open
      providers={[]}
      initialDataReady={false}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(screen.getByText("正在读取制作配置...")).toBeInTheDocument();
    expect(screen.queryByLabelText("目标平台")).not.toBeInTheDocument();

    rerender(<NewRunDialog
      open
      providers={providers}
      creatorSettings={creatorSettings}
      initialDataReady
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(await screen.findByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("30");
    expect(screen.getByRole("radio", { name: /仅免费画面/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "导演角色" })).toHaveValue("documentary-observer");
  });

  it("keeps the dialog openable but unsubmittable while creator settings failed, then initializes from the retried server values", async () => {
    const user = userEvent.setup();
    const onRetrySettings = vi.fn();
    const savedSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "free-stock" as const,
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "bilibili", durationSeconds: 45 },
    } satisfies StudioCreatorSettings;
    const { rerender } = render(<NewRunDialog
      open
      providers={providers}
      initialDataReady={false}
      settingsError="请求失败（500），请稍后重试。"
      onRetrySettings={onRetrySettings}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: "创作设置读取失败" })).toBeInTheDocument();
    expect(screen.getByText(/未能读取你的创作设置，为避免用错声音\/平台\/时长，暂未开工/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始制作" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(onRetrySettings).toHaveBeenCalledTimes(1);

    rerender(<NewRunDialog
      open
      providers={providers}
      initialDataReady
      creatorSettings={savedSettings}
      onRetrySettings={onRetrySettings}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("45");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeInTheDocument();
    expect(screen.queryByText(/未能读取你的创作设置/)).not.toBeInTheDocument();
  });

  it("does not submit an unsupported initial platform behind a visually different option", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{ platform: "guokr" }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("");
    await user.type(screen.getByLabelText("视频标题"), "平台边界测试");
    await user.type(screen.getByLabelText("内容角度"), "验证来源平台不会进入成片配置");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请选择目标平台");
  });

  it("shows only two real visual strategies and maps a legacy cinematic default to paid key shots", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithPaidVisuals: StudioProvider[] = [...providers, {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 3,
    }];
    render(<NewRunDialog
      open
      providers={providersWithPaidVisuals}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "cinematic-ai",
        topicStrategy: { customInstruction: "" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getAllByRole("radio", { name: /(?:仅免费画面|允许 AI 生成画面，按实际镜头报价)/ })).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeDisabled();
    expect(screen.queryByText("经济日更")).not.toBeInTheDocument();
    expect(screen.queryByText("开放精品生成")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "旧配方映射到真实策略");
    await user.type(screen.getByLabelText("内容角度"), "不再展示重复选择");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      economics: { recipeId: "keyshot-ai", allowMeteredProviders: true },
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
    }));
  });

  it("does not overwrite production choices when ready data rerenders", async () => {
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    } satisfies StudioCreatorSettings;
    const { rerender } = render(<NewRunDialog
      open
      providers={providers}
      creatorSettings={initialSettings}
      initialDataReady
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);
    await screen.findByRole("button", { name: "开始制作" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "目标平台" }), "xiaohongshu");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "建议时长" }), "40");

    rerender(<NewRunDialog
      open
      providers={[]}
      initialDataReady={false}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);
    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("xiaohongshu");

    rerender(<NewRunDialog
      open
      providers={[...providers]}
      creatorSettings={{
        ...initialSettings,
        productionDefaults: { ...initialSettings.productionDefaults, platform: "bilibili", durationSeconds: 45 },
      }}
      initialDataReady
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("xiaohongshu");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("40");
  });

  it("stops before production when only an unselected editorial card can supply visuals", async () => {
    const providersWithoutAutomaticVisuals = providers.map((provider) => provider.id === "pexels-stock-v1"
      ? { ...provider, available: false, status: "needs_config" as const, requirement: "需要 PEXELS_API_KEY" }
      : provider);
    render(<NewRunDialog
      open
      providers={providersWithoutAutomaticVisuals}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    await screen.findByRole("button", { name: "开始制作" });
    await userEvent.click(screen.getByText("更多：素材来源与制作细节"));
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).not.toBeChecked();
    expect(screen.getByText(/缺少正式生产能力.*导演画面来源/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  });

  it("starts production only from the explicit start control", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.type(screen.getByLabelText("视频标题"), "避免下拉选择误触开工");
    await user.type(screen.getByLabelText("内容角度"), "所有配置完成后再明确开始制作");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    const startButton = await screen.findByRole("button", { name: "开始制作" });
    const form = startButton.closest("form");
    expect(form).not.toBeNull();

    fireEvent.submit(form!);
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(startButton);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("falls back to an available role provider when a saved binding is no longer usable", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithRetiredScript: StudioProvider[] = [
      ...providers,
      { id: "retired-script-v1", capability: "script.draft", label: "已停用编剧", available: false, kind: "external" },
    ];
    render(<NewRunDialog
      open
      providers={providersWithRetiredScript}
      initialValues={{ providers: {
        script: "retired-script-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      } }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getByRole("combobox", { name: "编剧能力" })).toHaveValue("python-template-v1");
    await user.type(screen.getByLabelText("视频标题"), "失效配置必须安全回退");
    await user.type(screen.getByLabelText("内容角度"), "不能显示一个能力却提交另一个能力");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ script: "python-template-v1" }),
    }));
  });

  it("blocks production when the independent role auditor is unavailable", () => {
    render(<NewRunDialog
      open
      providers={providers.filter((provider) => provider.id !== "codex-role-auditor-v1")}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(screen.getByText(/缺少正式生产能力：独立质量复核/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  });

  it("links a missing production role straight to the production-roles settings section", () => {
    render(<NewRunDialog
      open
      providers={providers.filter((provider) => provider.id !== "codex-role-auditor-v1")}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(screen.getByText(/缺少正式生产能力：独立质量复核/)).toBeInTheDocument();
    const settingsLink = screen.getByRole("link", { name: "打开创作设置" });
    expect(settingsLink).toHaveAttribute("href", "/resources#production-roles");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  });

  it("links a missing director asset source to the visual-providers settings section", async () => {
    render(<NewRunDialog
      open
      providers={providers.filter((provider) => provider.id !== "pexels-stock-v1")}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(await screen.findByText(/缺少正式生产能力：导演画面来源/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开创作设置" })).toHaveAttribute("href", "/resources#visual-providers");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
  });

  it("shows the production team and applies a shared GLM choice to script and treatment", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithAgents: StudioProvider[] = [
      ...providers,
      {
        id: "codex-screenwriter-v1",
        capability: "script.draft",
        label: "Codex 编剧",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "gpt-5.6-terra",
        modelProfiles: [
          { id: "gpt-5.6-terra", providerId: "codex-screenwriter-v1", providerFamily: "openai", label: "GPT-5.6 Terra", description: "日常创作", available: true, taskTypes: ["text"] },
          { id: "gpt-5.6-sol", providerId: "codex-screenwriter-v1", providerFamily: "openai", label: "GPT-5.6 Sol", description: "高质量创作", available: true, recommended: true, taskTypes: ["text"] },
          { id: "glm-5.3", providerId: "codex-screenwriter-v1", providerFamily: "zai-bigmodel", label: "GLM-5.3", description: "GLM 创作", available: true, taskTypes: ["text"] },
        ],
      },
      {
        id: "codex-creative-treatment-v1",
        capability: "creative.treatment",
        label: "AI 前期构思",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "gpt-5.6-terra",
        modelProfiles: [
          { id: "gpt-5.6-terra", providerId: "codex-creative-treatment-v1", providerFamily: "openai", label: "GPT-5.6 Terra", description: "日常构思", available: true, taskTypes: ["text"] },
          { id: "glm-5.3", providerId: "codex-creative-treatment-v1", providerFamily: "zai-bigmodel", label: "GLM-5.3", description: "GLM 构思", available: true, taskTypes: ["text"] },
        ],
      },
    ];
    render(<NewRunDialog
      open
      providers={providersWithAgents}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "economy-daily",
        roleProviderDefaults: { script: "codex-screenwriter-v1" },
        modelDefaults: { "codex-screenwriter-v1": "gpt-5.6-terra" },
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getByRole("heading", { name: "自动制作设置" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "编剧能力" })).toHaveValue("codex-screenwriter-v1");
    expect(screen.getByText(/独立质量复核/)).toBeInTheDocument();
    expect(screen.getByText(/深入质量复核.*最多三轮/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "编剧本次模型" }), "glm-5.3");
    await user.type(screen.getByLabelText("视频标题"), "角色配置必须在开工前确认");
    await user.type(screen.getByLabelText("内容角度"), "验证编剧模型覆盖真实进入生产单");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ script: "codex-screenwriter-v1" }),
      models: expect.objectContaining({
        "codex-screenwriter-v1": "glm-5.3",
        "codex-creative-treatment-v1": "glm-5.3",
      }),
    }));
  });

  it("preserves in-progress edits when provider and creator settings refresh in the background", async () => {
    const user = userEvent.setup();
    const creatorSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      modelDefaults: {},
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    const { rerender } = render(
      <NewRunDialog open providers={providers} creatorSettings={creatorSettings} onClose={() => undefined} onSubmit={async () => undefined} />,
    );

    await user.type(screen.getByLabelText("视频标题"), "后台刷新不能清空这段编辑");
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    const voiceStage = screen.getByRole("button", { name: /配音声音导演/ });
    await user.click(voiceStage);
    expect(voiceStage).toHaveAttribute("aria-pressed", "true");

    rerender(
      <NewRunDialog
        open
        providers={providers.map((provider) => ({ ...provider }))}
        creatorSettings={{ ...creatorSettings, modelDefaults: {} }}
        onClose={() => undefined}
        onSubmit={async () => undefined}
      />,
    );

    expect(screen.getByLabelText("视频标题")).toHaveValue("后台刷新不能清空这段编辑");
    expect(screen.getByRole("button", { name: /配音声音导演/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not query or depend on the template catalog for a new production", async () => {
    vi.mocked(studioApi.templates).mockRejectedValueOnce(new Error("模板服务离线"));
    const onSubmit = vi.fn(async () => undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(await screen.findByRole("button", { name: "开始制作" })).toBeEnabled();
    expect(screen.queryByText(/无法读取模板目录/)).not.toBeInTheDocument();
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("keeps rework, voice, sources, and form edits across readiness rerenders without querying templates", async () => {
    vi.mocked(studioApi.templates).mockRejectedValueOnce(new Error("模板服务离线"));
    const user = userEvent.setup();
    const initialValues: Partial<import("../src/shared/api.js").StudioProductionInput> = {
      title: "上一版标题",
      angle: "保留上一版角度",
      audience: "内容创作者",
      template: { templateId: "knowledge-explainer", templateVersion: 3 },
      providers: {
        script: "python-template-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      economics: { recipeId: "free-stock", allowMeteredProviders: false },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      rework: {
        sourceRunId: "run-retry-template",
        sourceRunRevision: 2,
        rejectionReason: "开场节奏过慢。",
        nodeInstructions: { script: "缩短开场。", visualDirection: "加快镜头推进。", assets: "保留可用实拍。" },
        findings: [],
      },
    };
    const { rerender } = render(<NewRunDialog open providers={providers} initialValues={initialValues} initialDataReady onClose={() => undefined} onSubmit={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /查看继承设置/ }));

    await user.clear(screen.getByLabelText("视频标题"));
    await user.type(screen.getByLabelText("视频标题"), "配置刷新后仍保留的标题");
    const scriptInstruction = screen.getByRole("textbox", { name: "脚本修改要求" });
    await user.clear(scriptInstruction);
    await user.type(scriptInstruction, "只缩短第一句，其他内容不变。");
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.click(screen.getByRole("checkbox", { name: /本地编辑画面/ }));
    await user.click(screen.getByRole("button", { name: /人物纪实/ }));

    rerender(<NewRunDialog open providers={[...providers]} initialValues={initialValues} initialDataReady={false} onClose={() => undefined} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("视频标题")).toHaveValue("配置刷新后仍保留的标题");
    rerender(<NewRunDialog open providers={[...providers]} initialValues={initialValues} initialDataReady onClose={() => undefined} onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("视频标题")).toHaveValue("配置刷新后仍保留的标题");
    expect(screen.getByRole("textbox", { name: "脚本修改要求" })).toHaveValue("只缩短第一句，其他内容不变。");
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /人物纪实/ })).toHaveAttribute("aria-pressed", "true");
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("keeps invalid rework selections visible and blocked until the creator explicitly replaces each one", async () => {
    const user = userEvent.setup();
    const providersWithDirectorModel = [
      ...providers.map((provider) => provider.id === "api-visual-director-v1" ? {
        ...provider,
        defaultModelId: "director-current",
        modelProfiles: [{
          id: "director-current",
          providerId: provider.id,
          providerFamily: "openai",
          label: "当前导演模型",
          description: "当前可用",
          available: true,
          taskTypes: ["text" as const],
        }],
      } : provider),
      {
        id: "retired-script-v1",
        capability: "asset.prepare",
        label: "已转为画面执行的旧能力",
        available: true,
        kind: "external",
      } satisfies StudioProvider,
    ];
    render(<NewRunDialog
      open
      providers={providersWithDirectorModel}
      initialValues={{
        title: "失效配置返工",
        angle: "逐项替换后才能开工",
        audience: "内容创作者",
        template: { templateId: "retired-template", templateVersion: 1 },
        providers: {
          script: "retired-script-v1",
          director: "api-visual-director-v1",
          assets: "ai-shot-router-v1",
          voice: "macos-say-v1",
          render: "python-ffmpeg-v1",
          technicalReview: "python-technical-review-v1",
        },
        models: { "api-visual-director-v1": "retired-director-model" },
        director: { profileId: "auto", assetProviderIds: ["retired-stock-v1"] },
        economics: { recipeId: "economy-daily", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Retired", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-invalid-inheritance",
          sourceRunRevision: 4,
          rejectionReason: "需要重新制作。",
          nodeInstructions: { script: "保留事实。", visualDirection: "保持纪实。", assets: "替换失效画面。" },
          findings: [],
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    const alertTitle = await screen.findByText(/上一版有 \d+ 项已失效，暂不能开工/);
    const alert = alertTitle.closest("section")!;
    expect(alert).toHaveTextContent("已转为画面执行的旧能力");
    expect(alert).toHaveTextContent("现在用于画面素材，不能继续作为编剧");
    expect(alert).toHaveTextContent("上一版画面来源");
    expect(alert).toHaveTextContent("上一版模型");
    await waitFor(() => expect(alert).toHaveTextContent("上一版声音演员"));
    expect(alert).not.toHaveTextContent("retired-template");
    expect(alert).not.toHaveTextContent("retired-script-v1");
    expect(alert).not.toHaveTextContent("retired-stock-v1");
    expect(alert).not.toHaveTextContent("retired-director-model");
    expect(alert).not.toHaveTextContent("macos:Retired");
    expect(alert).not.toHaveTextContent("asset.prepare");
    expect(alert).not.toHaveTextContent("script.draft");
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /查看继承设置/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "编剧能力" }), "python-template-v1");
    await user.selectOptions(screen.getByRole("combobox", { name: "导演本次模型" }), "");
    await user.click(screen.getByRole("button", { name: "用当前策略的可用来源替换" }));
    await user.click(screen.getByRole("radio", { name: /Tingting/ }));

    await waitFor(() => expect(screen.queryByRole("alert", { name: /上一版有/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
  });

  it("opens inherited settings and the asset source controls from the rework source shortcut", async () => {
    const user = userEvent.setup();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderReworkDialog({
        sourceRunId: "run-adjust-rework-sources",
        sourceRunRevision: 2,
        affectedScenePositions: [2],
        nodeInstructions: { script: "保持脚本。", visualDirection: "调整第二镜。", assets: "替换第二镜素材。" },
        findings: [],
        previousScript: { scenes: [{ position: 1 }, { position: 2 }] },
        previousDirectorPlan: { shots: [{ scenePosition: 1 }, { scenePosition: 2 }] },
      });

      const inheritedToggle = await screen.findByRole("button", { name: /查看继承设置/ });
      expect(inheritedToggle).toHaveAttribute("aria-expanded", "false");
      await user.click(screen.getByRole("button", { name: "调整来源" }));

      expect(inheritedToggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: /更多：素材来源与制作细节/ })).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("checkbox", { name: /Pexels 图库/ })).toBeVisible();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(screen.getByRole("button", { name: "收起来源" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "收起来源" }));
      expect(screen.getByRole("button", { name: /更多：素材来源与制作细节/ })).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("checkbox", { name: /Pexels 图库/ })).not.toBeInTheDocument();
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("scrolls to the source pool again when the top repair shortcut is used after sources are already expanded", async () => {
    const user = userEvent.setup();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<NewRunDialog
        open
        providers={providers}
        initialValues={{
          title: "失效来源返工",
          angle: "明确替换已经失效的来源",
          audience: "短视频创作者",
          template: { templateId: "knowledge-explainer", templateVersion: 3 },
          providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
          director: { profileId: "auto", assetProviderIds: ["retired-stock-v1"] },
          economics: { recipeId: "free-stock", allowMeteredProviders: false },
          voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
          rework: {
            sourceRunId: "run-expanded-source-repair",
            sourceRunRevision: 2,
            affectedScenePositions: [1],
            nodeInstructions: { script: "保持脚本。", visualDirection: "重新核对来源。", assets: "替换失效来源。" },
            findings: [],
          },
        }}
        onClose={() => undefined}
        onSubmit={vi.fn()}
      />);

      const inheritedToggle = await screen.findByRole("button", { name: /查看继承设置/ });
      await user.click(inheritedToggle);
      await user.click(screen.getByRole("button", { name: /更多：素材来源与制作细节/ }));
      expect(screen.getByRole("checkbox", { name: /Pexels 图库/ })).toBeVisible();
      scrollIntoView.mockClear();

      await user.click(screen.getByRole("button", { name: "用当前策略的可用来源替换" }));

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("does not infer an editorial layout source from a historical photo-story template", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "照片叙事返工",
        angle: "替换已经失效的画面来源",
        audience: "短视频创作者",
        template: { templateId: "photo-story", templateVersion: 3 },
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["retired-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-photo-story-invalid-source",
          sourceRunRevision: 3,
          affectedScenePositions: [1],
          nodeInstructions: { script: "保持脚本。", visualDirection: "保持照片叙事。", assets: "替换失效来源。" },
          findings: [],
        },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(await screen.findByRole("button", { name: "用当前策略的可用来源替换" }));
    await waitFor(() => expect(screen.queryByText(/上一版有.*项已失效/)).not.toBeInTheDocument());
    const start = screen.getByRole("button", { name: "开始制作" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      director: expect.objectContaining({
        assetProviderIds: ["pexels-stock-v1"],
      }),
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
  });

  it("does not turn an identifiable historical rework template back into an executable choice", async () => {
    const historicalTemplate = { ...template("historical-template", "历史模板"), version: 2 };
    vi.mocked(studioApi.templates).mockResolvedValueOnce({
      storeRevision: 2,
      templates: [historicalTemplate, template("knowledge-explainer", "知识解释")],
    });
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "历史模板返工",
        angle: "保留不可再新选的历史模板",
        audience: "内容创作者",
        template: { templateId: "historical-template", templateVersion: 2 },
        providers: {
          script: "python-template-v1",
          director: "api-visual-director-v1",
          assets: "ai-shot-router-v1",
          voice: "macos-say-v1",
          render: "python-ffmpeg-v1",
          technicalReview: "python-technical-review-v1",
        },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-historical-template",
          sourceRunRevision: 3,
          rejectionReason: "仅修改画面。",
          nodeInstructions: { script: "保持不变。", visualDirection: "修正构图。", assets: "替换一镜。" },
          findings: [],
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    await userEvent.click(screen.getByRole("button", { name: /查看继承设置/ }));

    expect(screen.queryByRole("radio", { name: /历史模板/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/上一版有.*项已失效/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("strips a historical template snapshot while preserving the rest of the rework input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const latestTemplate = template("historical-template", "历史模板新版");
    vi.mocked(studioApi.templates).mockResolvedValueOnce({
      storeRevision: 3,
      templates: [latestTemplate, template("knowledge-explainer", "知识解释")],
      productionTemplates: [latestTemplate, template("knowledge-explainer", "知识解释")],
    });
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "旧模板版本返工",
        angle: "沿用原制作的模板快照",
        audience: "内容创作者",
        template: { templateId: "historical-template", templateVersion: 2 },
        providers: {
          script: "python-template-v1",
          director: "api-visual-director-v1",
          assets: "ai-shot-router-v1",
          voice: "macos-say-v1",
          render: "python-ffmpeg-v1",
          technicalReview: "python-technical-review-v1",
        },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-old-template-version",
          sourceRunRevision: 2,
          nodeInstructions: { script: "保持不变。", visualDirection: "修正构图。", assets: "替换一镜。" },
          findings: [],
        },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(screen.getByRole("button", { name: /查看继承设置/ }));

    expect(screen.queryByRole("radio", { name: /历史模板新版/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/上一版有.*项已失效/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: "旧模板版本返工" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("requires a creator to replace an unavailable inherited visual review", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithUnavailableReview: StudioProvider[] = [...providers, {
      id: "retired-visual-review-v1",
      capability: "quality.review.visual",
      label: "旧视觉审片",
      available: false,
      kind: "external",
      requirement: "服务已停用",
    }, {
      id: "replacement-visual-review-v1",
      capability: "quality.review.visual",
      label: "可用视觉审片",
      available: true,
      kind: "external",
    }];
    render(<NewRunDialog
      open
      providers={providersWithUnavailableReview}
      initialValues={{
        title: "停用旧审片",
        angle: "保留人工终审",
        audience: "内容创作者",
        template: { templateId: "knowledge-explainer", templateVersion: 3 },
        providers: {
          script: "python-template-v1",
          director: "api-visual-director-v1",
          assets: "ai-shot-router-v1",
          voice: "macos-say-v1",
          render: "python-ffmpeg-v1",
          technicalReview: "python-technical-review-v1",
          visualReview: "retired-visual-review-v1",
        },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-retired-review",
          sourceRunRevision: 2,
          nodeInstructions: { script: "保持不变。", visualDirection: "修正构图。", assets: "替换一镜。" },
          findings: [],
        },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(await screen.findByText(/上一版有 1 项已失效，暂不能开工/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /查看继承设置/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "视觉审片员能力" }), "glm-visual-review-v1");
    await waitFor(() => expect(screen.queryByText(/上一版有.*项已失效/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0]?.[0].providers).toMatchObject({ visualReview: "glm-visual-review-v1" });
  });

  it("allows an explicitly selected editorial layout source alongside a paid visual strategy", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithPaidVisuals: StudioProvider[] = [...providers, {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 3,
    }];
    render(<NewRunDialog open providers={providersWithPaidVisuals} onClose={() => undefined} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.click(screen.getByRole("checkbox", { name: /本地编辑画面/ }));
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).toBeChecked();
    await user.type(screen.getByLabelText("视频标题"), "证据图解能力测试");
    await user.type(screen.getByLabelText("内容角度"), "只开放正式排版能力");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
      director: expect.objectContaining({ assetProviderIds: expect.arrayContaining(["local-editorial-v1"]) }),
    }));
  });

  it("does not infer editorial layout capability from a legacy photo-story selection", async () => {
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{ template: { templateId: "photo-story" } }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(screen.queryByRole("radio", { name: /照片故事/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("更多：素材来源与制作细节"));
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).not.toBeChecked();
  });

  it("preserves an explicit custom duration without applying a template automation level", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} initialValues={{ durationSeconds: 27, template: { templateId: "automatic-custom" } }} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(await screen.findByRole("option", { name: "27 秒" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "一条自定义时长的视频");
    await user.type(screen.getByLabelText("内容角度"), "验证显式时长不依赖模板");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      durationSeconds: 27,
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
  });

  it("creates an editable duration range and keeps the suggested duration inside it", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    const minimum = screen.getByLabelText("最短时长");
    const maximum = screen.getByLabelText("最长时长");
    expect(minimum).toHaveValue(20);
    expect(maximum).toHaveValue(34);

    fireEvent.change(minimum, { target: { value: "30" } });
    expect(screen.getByLabelText("建议时长")).toHaveValue("30");

    await user.type(screen.getByLabelText("视频标题"), "动态时长合同测试");
    await user.type(screen.getByLabelText("内容角度"), "让完整表达决定最终时长");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      durationSeconds: 30,
      durationRange: { minSeconds: 30, maxSeconds: 34 },
    }));
  });

  it("keeps mandatory dual visual review enabled for every production run", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    const visualReview = screen.getByRole("checkbox", { name: /视觉审片/ });
    expect(visualReview).toBeChecked();
    expect(visualReview).toBeDisabled();
    await user.type(screen.getByLabelText("视频标题"), "视觉审片必须进入生产单");
    await user.type(screen.getByLabelText("内容角度"), "验证可选模型角色的开关");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
    }));

    await user.click(visualReview);
    expect(visualReview).toBeChecked();
  });

  it("keeps the production dialog open while toggling workflow gates", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<NewRunDialog open providers={providers} onClose={onClose} onSubmit={async () => undefined} />);

    await user.click(screen.getByText("更多：素材来源与制作细节"));
    const semanticRank = screen.getByRole("checkbox", { name: /AI 候选画面排序/ });
    const visualReview = screen.getByRole("checkbox", { name: /视觉审片/ });

    await user.click(semanticRank);
    await user.click(visualReview);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(semanticRank).not.toBeChecked();
    expect(visualReview).toBeChecked();
    expect(visualReview).toBeDisabled();
  });

  it("uploads an optional reference video and enables editable shot-grammar analysis", async () => {
    const user = userEvent.setup();
    const upload = vi.spyOn(studioApi, "uploadReferenceVideo").mockResolvedValue({
      uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
      label: "参考节奏.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_048_576,
      sha256: "a".repeat(64),
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithReference: StudioProvider[] = [...providers, {
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: true,
      kind: "external",
      billing: "subscription",
    }];
    render(<NewRunDialog open providers={providersWithReference} onClose={() => undefined} onSubmit={onSubmit} />);

    const file = new File([new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109])], "参考节奏.mp4", { type: "video/mp4" });
    await user.upload(screen.getByLabelText("参考视频"), file);

    expect(upload).toHaveBeenCalledWith(file);
    expect(await screen.findByText("参考节奏.mp4")).toBeInTheDocument();
    expect(screen.getByText(/只提炼节奏、构图、运镜/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "参考镜头语法生成新视频");
    await user.type(screen.getByLabelText("内容角度"), "借鉴制作语法但不复制内容");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      referenceVideo: { uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d", label: "参考节奏.mp4" },
      // 新制作显式携带 joint-v1 共同创作规划标记（B4）。
      workflowFeatures: { assetSemanticRank: true, referenceGrammar: true, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1" },
    }));
  });

  it("deletes a removed reference upload instead of only hiding it", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "uploadReferenceVideo").mockResolvedValue({
      uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
      label: "参考节奏.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1_048_576,
      sha256: "a".repeat(64),
      createdAt: "2026-08-28T10:00:00.000Z",
    });
    const remove = vi.spyOn(studioApi, "deleteReferenceVideo").mockResolvedValue(undefined);
    const providersWithReference: StudioProvider[] = [...providers, {
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: true,
      kind: "external",
      billing: "subscription",
    }];
    render(<NewRunDialog open providers={providersWithReference} onClose={() => undefined} onSubmit={vi.fn()} />);

    const file = new File([new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109])], "参考节奏.mp4", { type: "video/mp4" });
    await user.upload(screen.getByLabelText("参考视频"), file);
    await user.click(await screen.findByRole("button", { name: "删除参考视频" }));

    expect(remove).toHaveBeenCalledWith("67d86948-5517-4b17-8da1-b0a695159d4d");
    expect(screen.queryByText("参考节奏.mp4")).not.toBeInTheDocument();
  });

  it("shows an inherited rework reference and lets the creator remove it without deleting a source artifact", async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(studioApi, "deleteReferenceVideo").mockResolvedValue(undefined);
    remove.mockClear();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithReference: StudioProvider[] = [...providers, {
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "Codex 编剧",
      available: true,
      kind: "external",
      billing: "subscription",
    }, {
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: true,
      kind: "external",
      billing: "subscription",
    }];
    render(<NewRunDialog
      open
      providers={providersWithReference}
      initialValues={{
        title: "沿用参考语法的返工视频",
        angle: "只调整审片指出的镜头",
        audience: "短视频创作者",
        nicheSlug: "reference-rework",
        durationSeconds: 24,
        platform: "douyin",
        reviewMode: "manual",
        providers: { script: "codex-screenwriter-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        workflowFeatures: { assetSemanticRank: false, referenceGrammar: true },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-reference-source",
          sourceRunRevision: 7,
          nodeInstructions: { script: "保留原脚本。", visualDirection: "调整问题镜头。", assets: "替换问题画面。" },
          findings: [],
        },
      }}
      inheritedReferenceVideo={{ label: "参考节奏.mp4", mimeType: "video/mp4", sizeBytes: 1_048_576 }}
      inheritedNodeIds={["brief", "reference-grammar"]}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(screen.getByRole("button", { name: /查看继承设置/ }));
    expect(await screen.findByText("参考节奏.mp4")).toBeInTheDocument();
    expect(screen.getByText(/沿用上一版参考视频/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "不再沿用参考视频" }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByText("参考节奏.mp4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1", creativeReview: "user-confirmed-v1" },
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("referenceVideo");
  });

  it("clears the file picker after a failed upload so the same file can be retried", async () => {
    const user = userEvent.setup();
    const upload = vi.spyOn(studioApi, "uploadReferenceVideo")
      .mockRejectedValueOnce(new Error("上传链路暂时不可用"))
      .mockResolvedValueOnce({
        uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
        label: "参考节奏.mp4",
        mimeType: "video/mp4",
        sizeBytes: 12,
        sha256: "a".repeat(64),
        createdAt: "2026-08-28T10:00:00.000Z",
      });
    upload.mockClear();
    vi.spyOn(studioApi, "deleteReferenceVideo").mockResolvedValue(undefined);
    const providersWithReference: StudioProvider[] = [...providers, {
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: true,
      kind: "external",
      billing: "subscription",
    }];
    render(<NewRunDialog open providers={providersWithReference} onClose={() => undefined} onSubmit={vi.fn()} />);
    const picker = screen.getByLabelText("参考视频") as HTMLInputElement;
    const file = new File([new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109])], "参考节奏.mp4", { type: "video/mp4" });

    await user.upload(picker, file);
    expect(await screen.findByText(/上传链路暂时不可用/)).toBeInTheDocument();
    expect(picker.value).toBe("");
    await user.upload(picker, file);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("参考节奏.mp4")).toBeInTheDocument();
  });

  it("does not ask for a video-wide ceiling when updating the selected model", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithModels: StudioProvider[] = [...providers, {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 1,
      defaultModelId: "economy-model",
      modelProfiles: [
        { id: "economy-model", providerId: "seedance-video-v1", providerFamily: "ark-video", label: "经济模型", description: "低成本模型", available: true, taskTypes: ["text-to-video"], estimatedCnyPerClip: 1 },
        { id: "premium-model", providerId: "seedance-video-v1", providerFamily: "ark-video", label: "精品模型", description: "高质量模型", available: true, taskTypes: ["text-to-video"], estimatedCnyPerClip: 3 },
      ],
    }];
    render(<NewRunDialog open providers={providersWithModels} onClose={() => undefined} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeDisabled();
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Seedance 视频生成 本次模型" }), "premium-model");

    expect(screen.queryByLabelText("预计成本上限")).not.toBeInTheDocument();
    expect(screen.getByText(/当前模型参考单价约 ¥3\/镜头/)).toBeInTheDocument();
    expect(screen.getByLabelText("费用方式")).toHaveTextContent(/按实际方案报价.*逐项人工确认/);
    await user.type(screen.getByLabelText("视频标题"), "为这条视频选择生成模型");
    await user.type(screen.getByLabelText("内容角度"), "验证逐镜报价进入生产单");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
      },
    }));
  });

  it("quotes the creator's effective provider model before a paid run is submitted", async () => {
    const providersWithModels: StudioProvider[] = [...providers, {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 1,
      defaultModelId: "economy-model",
      modelProfiles: [
        { id: "economy-model", providerId: "seedance-video-v1", providerFamily: "ark-video", label: "经济模型", description: "低成本模型", available: true, taskTypes: ["text-to-video"], estimatedCnyPerClip: 1 },
        { id: "premium-model", providerId: "seedance-video-v1", providerFamily: "ark-video", label: "精品模型", description: "高质量模型", available: true, taskTypes: ["text-to-video"], estimatedCnyPerClip: 3 },
      ],
    }];
    const creatorSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      modelDefaults: { "seedance-video-v1": "economy-model" },
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    const user = userEvent.setup();
    render(<NewRunDialog open providers={providersWithModels} creatorSettings={creatorSettings} onClose={() => undefined} onSubmit={vi.fn()} />);

    await user.click(await screen.findByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    await user.click(screen.getByText("更多：素材来源与制作细节"));

    const modelSelect = screen.getByRole("combobox", { name: "Seedance 视频生成 本次模型" });
    expect(modelSelect).toHaveValue("");
    expect(within(modelSelect).getAllByRole("option", { name: "使用推荐：economy-model" })).not.toHaveLength(0);
    expect(screen.queryByLabelText("预计成本上限")).not.toBeInTheDocument();
    expect(screen.getByLabelText("费用方式")).toHaveTextContent(/按实际方案报价.*逐项人工确认/);
  });

  it("treats GLM Flash visual review as Code Plan without a cash quote and explains final dual review", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.queryByText("1 次付费审片")).not.toBeInTheDocument();
    expect(screen.getByText(/视觉审片使用订阅额度/)).toBeInTheDocument();
    expect(screen.getByText(/负责中途预检；最终成片由 GLM 与 Codex 对同一组抽帧分别独立审查，不上传音轨/)).toBeInTheDocument();
    expect(screen.queryByLabelText("预计成本上限")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("视频标题"), "按次审片预算");
    await user.type(screen.getByLabelText("内容角度"), "审片不占付费镜头额度");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
      economics: {
        recipeId: "free-stock",
        allowMeteredProviders: false,
      },
    }));
  });

  it("auto-accounts metered voice without presenting a separate quote", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithMeteredVoice: StudioProvider[] = [
      ...providers.filter((provider) => provider.capability !== "voice.synthesize"),
      {
        id: "minimax-tts-v1",
        capability: "voice.synthesize",
        label: "MiniMax 中文声音演员",
        available: true,
        kind: "external",
        billing: "metered",
        approvalPolicy: "automatic",
        billingUnit: "run",
        estimatedCnyPerClip: 0.5,
      },
    ];
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "minimax:Chinese (Mandarin)_News_Anchor", providerId: "minimax-tts-v1", label: "新闻主播", locale: "zh-CN", engine: "minimax", curated: true },
    ]);
    render(<NewRunDialog open providers={providersWithMeteredVoice} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.queryByText("1 次付费配音")).not.toBeInTheDocument();
    expect(screen.getByText(/配音自动计入已记录费用，不弹现金报价；失败会停在配音步骤/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "按次配音预算");
    await user.type(screen.getByLabelText("内容角度"), "声音调用独立确认");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ voice: "minimax-tts-v1" }),
      economics: expect.objectContaining({
        allowMeteredProviders: true,
      }),
    }));
  });

  it("keeps the selected macOS voice profile and execution provider aligned", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Meijia", providerId: "macos-say-v1", label: "Meijia", locale: "zh-CN", engine: "macos", curated: true },
    ]);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    await screen.findByRole("radio", { name: /Meijia/ });
    await user.click(screen.getByRole("radio", { name: /Meijia/ }));
    await user.type(screen.getByLabelText("视频标题"), "系统旁白选择也要真正生效");
    await user.type(screen.getByLabelText("内容角度"), "确认所选音色进入制作参数");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ voice: "macos-say-v1" }),
      voiceDirection: expect.objectContaining({ profileId: "macos:Meijia" }),
    }));
  });

  it("replaces an unavailable macOS creator voice before a cloud run can be submitted", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const cloudProviders: StudioProvider[] = [
      ...providers.filter((provider) => provider.id !== "macos-say-v1"),
      {
        id: "minimax-tts-v1",
        capability: "voice.synthesize",
        label: "MiniMax 云端配音",
        available: true,
        kind: "external",
        billing: "metered",
      },
    ];
    vi.mocked(studioApi.voices).mockReturnValueOnce(new Promise(() => undefined));
    render(<NewRunDialog
      open
      providers={cloudProviders}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.type(screen.getByLabelText("视频标题"), "云端配音初始化不能产生竞态");
    await user.type(screen.getByLabelText("内容角度"), "即使音色目录仍在加载也应提交可执行配置");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ voice: "minimax-tts-v1" }),
      voiceDirection: expect.objectContaining({ profileId: "minimax:Chinese (Mandarin)_News_Anchor" }),
    }));
  });

  it("prefers the codex screenwriter for scripting when the bridge is available", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const codexProviders: StudioProvider[] = [
      ...providers,
      { id: "codex-screenwriter-v1", capability: "script.draft", label: "Codex 编剧", available: true, kind: "external" },
    ];
    render(<NewRunDialog open providers={codexProviders} onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("视频标题"), "用编剧写出第一条真的能拍的脚本");
    await user.type(screen.getByLabelText("内容角度"), "把清单变成三个具体动作");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
      }),
    }));
  });

  it("enables paid providers without pre-filling a video ceiling or forcing an editorial card", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const configuredProviders: StudioProvider[] = [
      ...providers,
      {
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "Seedance 关键镜头",
        available: true,
        kind: "external",
        status: "ready",
        billing: "metered",
        estimatedCnyPerClip: 3.5,
        description: "按预算生成关键镜头。",
      },
    ];
    render(<NewRunDialog open providers={configuredProviders} onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("视频标题"), "下班后的第一个小时");
    await user.type(screen.getByLabelText("内容角度"), "用一个关键镜头建立情绪转折");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    await user.click(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeDisabled();
    await user.click(screen.getByText("更多：素材来源与制作细节"));

    expect(screen.getByRole("checkbox", { name: /Seedance 视频生成/ })).toBeChecked();
    const localBaseline = screen.getByRole("checkbox", { name: /本地编辑画面/ });
    expect(localBaseline).not.toBeChecked();
    expect(localBaseline).toBeEnabled();
    expect(screen.queryByLabelText("预计成本上限")).not.toBeInTheDocument();
    expect(screen.getByLabelText("费用方式")).toHaveTextContent(/按实际方案报价.*逐项人工确认/);
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({
        assets: "ai-shot-router-v1",
        director: "api-visual-director-v1",
        visualReview: "glm-visual-review-v1",
      }),
      director: expect.objectContaining({
        profileId: "auto",
        assetProviderIds: expect.arrayContaining(["pexels-stock-v1", "seedance-video-v1"]),
      }),
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
      },
    }));
    expect(onSubmit.mock.calls[0]?.[0].director?.assetProviderIds).not.toContain("local-editorial-v1");
  });

  it("treats template shot capabilities as guidance when a selected generation route is executable", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={[...providers, {
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "Seedance 视频生成",
        available: true,
        kind: "external",
        billing: "metered",
        estimatedCnyPerClip: 3.5,
        deliveryTypes: ["generated_video"],
      }]}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.type(screen.getByLabelText("视频标题"), "只启用生成画面也要在开工前发现素材能力冲突");
    await user.type(screen.getByLabelText("内容角度"), "模板要求真实来源时不能交给导演猜");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.click(screen.getByRole("checkbox", { name: /Pexels 图库/ }));

    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      director: expect.objectContaining({ assetProviderIds: ["seedance-video-v1"] }),
    }));
  });

  it("blocks production in the form when every real visual source is deselected", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("视频标题"), "没有画面来源不能开始制作");
    await user.type(screen.getByLabelText("内容角度"), "验证真正的制作能力边界");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    await user.click(screen.getByRole("checkbox", { name: /Pexels 图库/ }));

    expect(screen.getByText(/当前素材池没有任何可用画面来源/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks every production run when dual visual review is unavailable", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithoutVisualReview: StudioProvider[] = [...providers.filter((provider) => provider.capability !== "quality.review.visual"), {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "Seedance 关键镜头",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 3.5,
    }];
    render(<NewRunDialog open providers={providersWithoutVisualReview} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/缺少正式生产能力/)).toHaveTextContent("GLM 与 Codex 双模型审片");
  });

  it("prefills an editable production brief from a selected opportunity", () => {
    render(
      <NewRunDialog
        open
        providers={providers}
        initialValues={{
          title: "下班后什么都不想做，是懒还是耗竭？",
          angle: "你不是懒，只是累了。",
          audience: "普通上班族",
          nicheSlug: "ordinary-life",
          platform: "douyin",
        }}
        onClose={() => undefined}
        onSubmit={async () => undefined}
      />,
    );

    expect(screen.getByLabelText("视频标题")).toHaveValue("下班后什么都不想做，是懒还是耗竭？");
    expect(screen.getByLabelText("内容角度")).toHaveValue("你不是懒，只是累了。");
    expect(screen.getByLabelText("目标受众")).toHaveValue("普通上班族");
    expect(screen.queryByLabelText("选题系列")).not.toBeInTheDocument();
  });

  it("starts without fetching templates or overriding an explicit brief", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(studioApi.templates).mockRejectedValue(new Error("模板目录离线"));
    render(<NewRunDialog open providers={providers} initialValues={{
      title: "情绪隐喻短片", angle: "全片为 AI 示意，不讲实验事实", audience: "普通观众",
      template: { templateId: "retired-template" }, durationSeconds: 30,
      voiceDirection: { profileId: "macos:Tingting", rate: 175, pauseScale: 1.2, masteringPreset: "natural" },
    }} onClose={() => undefined} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      angle: "全片为 AI 示意，不讲实验事实", durationSeconds: 30,
      voiceDirection: expect.objectContaining({ rate: 175, pauseScale: 1.2 }),
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
    expect(studioApi.templates).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "视频模板" })).not.toBeInTheDocument();
  });

  it("keeps a manual camera-test brief editable without selecting a template", async () => {
    const user = userEvent.setup();
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={vi.fn()} />);

    await user.type(screen.getByLabelText("视频标题"), "为什么手机拍咖啡总显得灰：同机位侧灯实测");
    await user.type(screen.getByLabelText("内容角度"), "再加入前后对比验证");
    expect(screen.getByLabelText("视频标题")).toHaveValue("为什么手机拍咖啡总显得灰：同机位侧灯实测");
    expect(screen.getByLabelText("内容角度")).toHaveValue("再加入前后对比验证");
    expect(screen.queryByRole("heading", { name: "视频模板" })).not.toBeInTheDocument();
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("locks an editorial image story to a free production path", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const meteredVideoProvider: StudioProvider = {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 3,
    };
    render(
      <NewRunDialog
        open
        providers={[...providers, meteredVideoProvider]}
        initialValues={{
          title: "警方通报一项社会事件调查进展",
          angle: "只解释原始来源已经确认的内容",
          audience: "关注公共信息的普通用户",
          nicheSlug: "public-update",
          editorial: {
            verdict: "produce_image_story",
            reasons: ["信息价值高于动作价值。"],
            guardrails: ["不得用 AI 生成画面虚构现场。"],
          },
        }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("radio", { name: /仅免费画面/ })).toBeChecked();
    expect(screen.getByText(/图文成片/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ }));
    expect(screen.getByRole("radio", { name: /仅免费画面/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /允许 AI 生成画面，按实际镜头报价/ })).toBeDisabled();
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    expect(screen.getByRole("checkbox", { name: /本地编辑画面/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      editorial: expect.objectContaining({ verdict: "produce_image_story" }),
      economics: expect.objectContaining({ allowMeteredProviders: false }),
      director: expect.objectContaining({ assetProviderIds: expect.arrayContaining(["local-editorial-v1"]) }),
    }));
  });

  it("keeps an editorial decision but strips its historical template recommendation", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <NewRunDialog
        open
        providers={providers}
        initialValues={{
          title: "一条值得解释的实时变化",
          angle: "从可核验事实解释观众影响",
          audience: "关注变化的普通用户",
          nicheSlug: "verified-change",
          editorial: { verdict: "produce_video", reasons: ["具有时效价值。"], guardrails: ["逐项核验来源。"] },
          template: { templateId: "trend-fact-brief" },
        }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      editorial: expect.objectContaining({ verdict: "produce_video" }),
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
  });

  it("does not block production when a historical template recommendation is unavailable", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const retiredRecommendation = { ...template("retired-recommendation", "已下架推荐模板"), status: "draft" as const };
    const availableTemplate = template("knowledge-explainer", "知识解释");
    vi.mocked(studioApi.templates).mockResolvedValueOnce({
      storeRevision: 4,
      templates: [retiredRecommendation, availableTemplate],
      productionTemplates: [availableTemplate],
    });

    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "推荐模板下架后的制作",
        angle: "要求创作者确认实际可用的视频结构",
        audience: "短视频创作者",
        nicheSlug: "retired-template-recommendation",
        template: { templateId: "retired-recommendation" },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(await screen.findByRole("button", { name: "开始制作" })).toBeEnabled();
    expect(screen.queryByText(/推荐模板当前不可用/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
    expect(studioApi.templates).not.toHaveBeenCalled();
  });

  it("does not require or invent a template for an editorial candidate", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "已删除推荐模板的候选",
        angle: "先让创作者确认实际叙事结构",
        audience: "关注实用解释的观众",
        nicheSlug: "missing-editorial-template",
        editorial: { verdict: "produce_video", reasons: ["题材值得制作。"], guardrails: ["核验事实。"] },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(await screen.findByRole("button", { name: "开始制作" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "视频模板" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalled();
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
  });

  it("keeps product voice controls independent from template sound presets", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const comparisonTemplate = {
      ...template("ranked-comparison", "条件式对比"),
      soundSystem: { voiceIntent: "利落、公平、先说标准再说结论", pace: "fast" as const, musicIntent: "统一节拍" },
    };
    vi.spyOn(studioApi, "templates").mockResolvedValue({
      storeRevision: 0,
      templates: [template("knowledge-explainer", "知识解释"), comparisonTemplate],
    });
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{ title: "两款工具怎么选", angle: "同条件实测", audience: "项目经理", nicheSlug: "comparison" }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    const voiceSummary = await screen.findByRole("button", { name: /高级微调/ });
    await waitFor(() => expect(voiceSummary).toHaveTextContent("185 字/分 · 停顿 1.0× · 自然"));
    expect(studioApi.templates).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /人物纪实/ }));
    expect(screen.getByRole("button", { name: /高级微调/ })).toHaveTextContent("170 字/分 · 停顿 1.2× · 贴近人声");

    const start = screen.getByRole("button", { name: "开始制作" });
    expect(start).toBeEnabled();
    expect(start.closest("form")?.checkValidity()).toBe(true);
    await user.click(start);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 170,
        pauseScale: 1.2,
        masteringPreset: "intimate",
      },
    })));
  });

  it("keeps the configured actor when creator settings are still automatic", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(studioApi.voices).mockResolvedValueOnce([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "macos:Meijia", providerId: "macos-say-v1", label: "Meijia", locale: "zh-CN", engine: "macos", curated: true },
    ]);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{ title: "把复杂概念讲明白", angle: "用一个生活案例解释", audience: "普通观众", nicheSlug: "explainer" }}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Meijia", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        voiceDirectionCustomized: false,
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: /高级微调/ })).toHaveTextContent("185 字/分 · 停顿 1.0× · 自然"));
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      voiceDirection: {
        profileId: "macos:Meijia",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
    }));
  });

  it("prefers a configured cloud voice over the shipped macOS default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithCloudVoice: StudioProvider[] = [
      ...providers,
      {
        id: "minimax-tts-v1",
        capability: "voice.synthesize",
        label: "MiniMax 中文声音演员",
        available: true,
        kind: "external",
        billing: "metered",
        approvalPolicy: "automatic",
        billingUnit: "run",
        estimatedCnyPerClip: 0.5,
      },
    ];
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
      { id: "minimax:Chinese (Mandarin)_News_Anchor", providerId: "minimax-tts-v1", label: "新闻女声", locale: "zh-CN", engine: "minimax", curated: true },
    ]);
    render(<NewRunDialog
      open
      providers={providersWithCloudVoice}
      initialValues={{ title: "已配置云端配音", angle: "验证出厂默认不会压住可用配音", audience: "普通观众", nicheSlug: "cloud-voice" }}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        voiceDirectionCustomized: false,
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      voiceDirection: expect.objectContaining({ profileId: "minimax:Chinese (Mandarin)_News_Anchor" }),
      providers: expect.objectContaining({ voice: "minimax-tts-v1" }),
    }));
  });

  it("does not replace an explicitly customized creator voice", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{ title: "保留创作者声音", angle: "验证声音优先级", audience: "普通观众", nicheSlug: "custom-voice" }}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 177, pauseScale: 1.1, masteringPreset: "natural" },
        voiceDirectionCustomized: true,
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 177,
        pauseScale: 1.1,
        masteringPreset: "natural",
      },
    }));
  });

  it("does not replace a voice explicitly supplied for a new production", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "入口指定声音",
        angle: "验证显式输入优先级",
        audience: "普通观众",
        nicheSlug: "explicit-voice",
        voiceDirection: { profileId: "macos:Tingting", rate: 166, pauseScale: 1.3, masteringPreset: "intimate" },
      }}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        voiceDirectionCustomized: false,
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 166,
        pauseScale: 1.3,
        masteringPreset: "intimate",
      },
    }));
  });

  it("edits node-prefilled review guidance while inheriting the rejected production choices", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const rework = {
      sourceRunId: "run-rejected-1",
      sourceRunRevision: 8,
      rejectionReason: "第三镜文字遮挡主体，应进入 manualReplacement。",
      nodeInstructions: {
        script: "保留 Codex 复核确认的旁白事实和屏幕文字，只缩短第三镜。",
        visualDirection: "第三镜沿用Provider选择的自然纪实风格并留出字幕安全区。",
        assets: "只替换第三镜；没有合格素材时进入 manualReplacement，禁止使用带字素材和说明卡。",
      },
      findings: [{
        findingId: "vf_0123456789abcdef01234567",
        timecodeMs: 8_500,
        scenePosition: 3,
        category: "text_interference",
        description: "素材自带文字与字幕重叠，应进入 manualReplacement。",
        suggestion: "换成无字母片并保持人物方向一致，不要暴露 manualReplacement。",
        targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">,
      }],
      previousScript: { scenes: [{ position: 3, narration: "旧旁白" }] },
      previousDirectorPlan: { shots: [{ scenePosition: 3, visualIntent: "旧构图" }] },
    };
    const codexScreenwriter: StudioProvider = {
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "AI 编剧",
      available: true,
      kind: "external",
      billing: "subscription",
      defaultModelId: "gpt-primary",
      modelProfiles: [
        { id: "gpt-primary", providerId: "codex-screenwriter-v1", providerFamily: "openai", label: "GPT 首选", description: "首选编剧", available: true, taskTypes: ["text"] },
        { id: "glm-backup", providerId: "codex-screenwriter-v1", providerFamily: "zai-bigmodel", label: "GLM 替补", description: "替补编剧", available: true, taskTypes: ["text"] },
      ],
    };
    render(<NewRunDialog
      open
      providers={[
        ...providers.map((provider) => provider.id === "pexels-stock-v1" ? {
          ...provider,
          defaultModelId: "search-v2",
          modelProfiles: [{
            id: "search-v2",
            providerId: "pexels-stock-v1",
            providerFamily: "pexels",
            label: "Pexels Search v2",
            description: "图库搜索",
            available: true,
            taskTypes: ["text-to-video" as const],
          }],
        } : provider),
        codexScreenwriter,
      ]}
      initialValues={{
        title: "被打回的视频",
        angle: "保留主体，只修视觉问题",
        audience: "短视频创作者",
        nicheSlug: "rework-case",
        durationSeconds: 24,
        platform: "bilibili",
        reviewMode: "manual",
        template: { templateId: "knowledge-explainer", templateVersion: 3 },
        providers: {
          script: "codex-screenwriter-v1",
          director: "api-visual-director-v1",
          assets: "ai-shot-router-v1",
          voice: "macos-say-v1",
          render: "python-ffmpeg-v1",
          technicalReview: "python-technical-review-v1",
        },
        models: { "codex-screenwriter-v1": "gpt-primary", "pexels-stock-v1": "search-v2" },
        director: { profileId: "documentary-observer", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
        rework,
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("第三镜文字遮挡主体，应进入 人工补充素材。")).toBeInTheDocument();
    expect(screen.getByText("素材自带文字与字幕重叠，应进入 人工补充素材。")).toBeInTheDocument();
    expect(screen.queryByText(/manualReplacement/i)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "脚本修改要求" })).toHaveValue("保留 Codex 复核确认的旁白事实和屏幕文字，只缩短第三镜。");
    expect(screen.getByRole("textbox", { name: "导演方案修改要求" })).toHaveValue("第三镜沿用服务选择的自然纪实风格并留出字幕安全区。");
    const assetInstruction = screen.getByRole("textbox", { name: "画面素材修改要求" });
    expect(assetInstruction).toHaveValue("只替换第三镜；没有合格素材时进入 人工补充素材，禁止使用带字素材和说明卡。");
    expect(screen.getByRole("combobox", { name: "编剧本次模型" })).toHaveValue("gpt-primary");
    await user.selectOptions(screen.getByRole("combobox", { name: "编剧本次模型" }), "glm-backup");
    await user.clear(assetInstruction);
    await user.type(assetInstruction, "第三镜改用无字实拍母片，其他镜头不得变化。");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({
        script: "codex-screenwriter-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
      }),
      models: { "codex-screenwriter-v1": "glm-backup", "pexels-stock-v1": "search-v2" },
      director: { profileId: "documentary-observer", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
      rework: expect.objectContaining({
        sourceRunId: "run-rejected-1",
        rejectionReason: rework.rejectionReason,
        findings: rework.findings,
        previousScript: rework.previousScript,
        previousDirectorPlan: rework.previousDirectorPlan,
        nodeInstructions: expect.objectContaining({
          script: rework.nodeInstructions.script,
          visualDirection: rework.nodeInstructions.visualDirection,
          assets: "第三镜改用无字实拍母片，其他镜头不得变化。",
        }),
      }),
    }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("template");
  });

  it("loads the rejected run draft from the run page and submits the real node-prefilled rework", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const rejectedRun: StudioRunDetail = {
      ...withoutIntervention,
      status: "rejected",
      decisions: [{
        id: "decision-reject-1",
        action: "reject",
        actor: "owner",
        note: "第三镜文字遮挡主体。",
        createdAt: "2026-08-21T11:00:00.000Z",
      }],
    };
    const rework = {
      sourceRunId: rejectedRun.id,
      sourceRunRevision: rejectedRun.revision,
      rejectionReason: "第三镜文字遮挡主体。",
      nodeInstructions: {
        script: "缩短第三镜旁白。",
        visualDirection: "第三镜保留字幕安全区。",
        assets: "第三镜改用无字实拍画面，禁止说明卡。",
      },
      findings: [{
        findingId: "vf_0123456789abcdef01234567",
        timecodeMs: 8_500,
        scenePosition: 3,
        category: "text_interference",
        description: "素材文字与字幕重叠。",
        suggestion: "换成无字画面。",
        targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">,
      }],
      previousScript: { scenes: [1, 2, 3].map((position) => ({ position, narration: "旧旁白" })) },
      previousDirectorPlan: { shots: [1, 2, 3].map((scenePosition) => ({ scenePosition, visualIntent: "旧构图" })) },
    };
    const input = {
      protocolVersion: "video-factory/brief-v1" as const,
      title: rejectedRun.title,
      angle: rejectedRun.angle,
      audience: rejectedRun.audience,
      nicheSlug: rejectedRun.nicheSlug,
      durationSeconds: rejectedRun.durationSeconds,
      platform: rejectedRun.platform,
      reviewMode: "manual" as const,
      runPurpose: "test" as const,
      template: { templateId: "knowledge-explainer", templateVersion: 3 },
      providers: {
        script: "python-template-v1",
        director: "api-visual-director-v1",
        assets: "ai-shot-router-v1",
        voice: "macos-say-v1",
        render: "python-ffmpeg-v1",
        technicalReview: "python-technical-review-v1",
      },
      director: { profileId: "documentary-observer" as const, assetProviderIds: ["pexels-stock-v1"] },
      economics: { recipeId: "free-stock" as const, allowMeteredProviders: false },
      voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" as const },
      rework,
    };
    vi.spyOn(studioApi, "run").mockResolvedValue(rejectedRun);
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: rejectedRun.id,
      title: rejectedRun.title,
      totals: { estimatedCostCny: 0, authorizedCostCny: 0, actualCostCny: 0, actualPendingCount: 0, meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0 },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: input.voiceDirection,
      defaultRecipeId: "economy-daily",
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      topicStrategy: { customInstruction: "" },
    });
    const draft = vi.spyOn(studioApi, "reworkDraft").mockResolvedValue({
      input,
      inheritedNodeIds: ["brief", "script", "visual-direction", "visual-review"],
      requiredAffectedScenePositions: [3],
      scopeState: "resolved" as const,
    });
    const start = vi.spyOn(studioApi, "start").mockResolvedValue({ runId: "run-rework-2", status: "running" });

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "调整方案后重新制作" }));
    expect(draft).toHaveBeenCalledWith("run-1");
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "脚本修改要求" })).toHaveValue(rework.nodeInstructions.script);
    expect(screen.getByRole("textbox", { name: "导演方案修改要求" })).toHaveValue(rework.nodeInstructions.visualDirection);
    expect(screen.getByRole("textbox", { name: "画面素材修改要求" })).toHaveValue(rework.nodeInstructions.assets);
    expect(screen.getByText("本轮选择 1 个镜头：3")).toBeInTheDocument();
    expect(screen.getByText("其余 2 个镜头计划沿用：1、2")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "第 3 镜" })).toBeDisabled();
    expect(screen.getByText(/已带入上一版基线资料：需求简报、上一版脚本、上一版导演方案、视觉审片记录/)).toBeInTheDocument();
    expect(screen.getByLabelText("最短时长")).toHaveValue(20);
    expect(screen.getByLabelText("最长时长")).toHaveValue(34);

    const scriptInstruction = screen.getByRole("textbox", { name: "脚本修改要求" });
    await userEvent.clear(scriptInstruction);
    await userEvent.type(scriptInstruction, "关闭弹窗后不应保留的本地编辑");
    await userEvent.click(screen.getByTitle("关闭"));
    await userEvent.click(await screen.findByRole("button", { name: "调整方案后重新制作" }));
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "脚本修改要求" })).toHaveValue(rework.nodeInstructions.script);
    expect(screen.getByRole("textbox", { name: "脚本修改要求" })).not.toHaveValue("关闭弹窗后不应保留的本地编辑");
    expect(screen.getByText(/已带入上一版基线资料/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("最长时长"), { target: { value: "36" } });
    expect(screen.getByLabelText("最长时长")).toHaveValue(36);

    await userEvent.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      runPurpose: input.runPurpose ?? "production",
      durationRange: { minSeconds: 20, maxSeconds: 36 },
      workflowFeatures: expect.objectContaining({ executablePlan: true }),
      director: expect.objectContaining({ profileId: "documentary-observer" }),
      rework: expect.objectContaining({
        sourceRunId: "run-1",
        nodeInstructions: rework.nodeInstructions,
        previousScript: rework.previousScript,
        previousDirectorPlan: rework.previousDirectorPlan,
      }),
    })));
  });

  it("summarizes the rework scope from deduped findings and keeps every scene issue grouped", async () => {
    const sceneFinding = (findingId: string, scenePosition: number | undefined, description: string) => ({
      findingId,
      timecodeMs: 8_000,
      ...(scenePosition === undefined ? {} : { scenePosition }),
      category: "legibility",
      description,
      suggestion: "按建议修改。",
      targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">,
    });
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "返工范围摘要",
        angle: "先看范围再改设置",
        audience: "短视频创作者",
        nicheSlug: "rework-scope",
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-rejected-scope",
          sourceRunRevision: 9,
          rejectionReason: "四个镜头需要修改。",
          nodeInstructions: { script: "保留旁白事实。", visualDirection: "复核所列镜头。", assets: "替换问题镜头素材。" },
          findings: [
            sceneFinding("vf-scope-000000000001", 4, "镜头 4 文字过小。"),
            sceneFinding("vf-scope-000000000002", 6, "镜头 6 连续性断裂。"),
            sceneFinding("vf-scope-000000000003", 7, "镜头 7 文字与主体重叠。"),
            sceneFinding("vf-scope-000000000003", 7, "镜头 7 文字与主体重叠。"),
            sceneFinding("vf-scope-000000000004", 7, "镜头 7 节奏拖沓。"),
            sceneFinding("vf-scope-000000000005", 8, "镜头 8 构图失衡。"),
          ],
          previousScript: { scenes: [1, 2, 3, 4, 5, 6, 7, 8].map((position) => ({ position })) },
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("本轮选择 4 个镜头：4、6、7、8")).toBeInTheDocument();
    expect(screen.getByText("其余 4 个镜头计划沿用：1、2、3、5")).toBeInTheDocument();
    expect(screen.getByText("是否能直接复用上一版母片，以重新规划后的画面方案和真实报价为准。")).toBeInTheDocument();
    expect(within(screen.getByLabelText("需要处理的问题")).getAllByText("第 7 镜")).toHaveLength(1);
    expect(screen.getAllByText("镜头 7 文字与主体重叠。")).toHaveLength(1);
    expect(screen.getByText("镜头 7 节奏拖沓。")).toBeInTheDocument();
    expect(screen.queryByText(/本轮选择 6 个镜头/)).not.toBeInTheDocument();
  });

  it("prefills the explicit rework scene selection from saved scope and scene findings", async () => {
    renderReworkDialog({
      sourceRunId: "run-explicit-scope-default",
      sourceRunRevision: 3,
      rejectionReason: "第二、四镜需要修改。",
      affectedScenePositions: [2, 99],
      nodeInstructions: { script: "保留事实。", visualDirection: "调整构图。", assets: "替换问题画面。" },
      findings: [
        { findingId: "vf-explicit-000000001", timecodeMs: 12_000, scenePosition: 4, category: "composition", description: "第四镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] },
      ],
      previousScript: { scenes: [1, 2, 3, 4].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3, 4].map((scenePosition) => ({ scenePosition })) },
    });

    expect(await screen.findByRole("checkbox", { name: "第 1 镜" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 2 镜" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 2 镜" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "第 3 镜" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 4 镜" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 4 镜" })).toBeDisabled();
    expect(screen.getByText("本轮选择 2 个镜头：2、4")).toBeInTheDocument();
    expect(screen.getByText("其余 2 个镜头计划沿用：1、3")).toBeInTheDocument();
    expect(screen.getByText(/勾选决定哪些镜头进入本轮画面重新规划与生成，并直接影响图片 \/ 视频报价/)).toBeInTheDocument();
    expect(screen.getByText(/下方文字只说明怎么改，不代替这里的镜头选择/)).toBeInTheDocument();
  });

  it("locks server-confirmed failure scenes while keeping other preselected scenes editable", async () => {
    renderReworkDialog({
      sourceRunId: "run-explicit-scope-required",
      sourceRunRevision: 5,
      affectedScenePositions: [3],
      nodeInstructions: { script: "保留事实。", visualDirection: "复核失败镜头。", assets: "重做失败画面。" },
      findings: [],
      previousScript: { scenes: [1, 2, 3].map((position) => ({ position })) },
    }, "失败镜头不可移除", vi.fn(), [2]);

    expect(await screen.findByRole("checkbox", { name: "第 2 镜" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 2 镜" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "第 3 镜" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 3 镜" })).toBeEnabled();
    expect(screen.getByText("必改")).toBeInTheDocument();
  });

  it("locks a scene-specific script finding into the visual rework and paid scope", async () => {
    renderReworkDialog({
      sourceRunId: "run-script-only-scope",
      sourceRunRevision: 2,
      affectedScenePositions: [],
      nodeInstructions: { script: "精简第二镜旁白。", visualDirection: "保持连续性。", assets: "跟随脚本调整画面。" },
      findings: [{
        findingId: "vf-script-only-000000001",
        timecodeMs: 6_000,
        scenePosition: 2,
        category: "narration",
        description: "第二镜旁白信息过密。",
        suggestion: "删去重复解释。",
        targetNodeIds: ["script"],
      }],
      previousScript: { scenes: [1, 2, 3].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3].map((scenePosition) => ({ scenePosition })) },
    });

    expect(await screen.findByRole("checkbox", { name: "第 2 镜" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "第 2 镜" })).toBeDisabled();
  });

  it("updates the scope summary and submits the creator's scene selection, including an empty scope", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderReworkDialog({
      sourceRunId: "run-explicit-scope-edit",
      sourceRunRevision: 4,
      affectedScenePositions: [],
      nodeInstructions: { script: "保留事实。", visualDirection: "调整所选镜头。", assets: "替换所选画面。" },
      findings: [],
      previousScript: { scenes: [1, 2, 3].map((position) => ({ position })) },
    }, "手动确认返工范围", onSubmit);

    const sceneTwo = await screen.findByRole("checkbox", { name: "第 2 镜" });
    expect(sceneTwo).not.toBeChecked();
    await user.click(sceneTwo);
    expect(screen.getByText("本轮选择 1 个镜头：2")).toBeInTheDocument();
    await user.click(sceneTwo);
    expect(screen.getByText("本轮未选择需要重新规划 / 生成的镜头")).toBeInTheDocument();
    expect(screen.getByText("其余 3 个镜头计划沿用：1、2、3")).toBeInTheDocument();

    const startButton = screen.getByRole("button", { name: "开始制作" });
    await waitFor(() => expect(startButton).toBeEnabled());
    await user.click(startButton);
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      rework: expect.objectContaining({ affectedScenePositions: [] }),
    })));

    await user.click(screen.getByRole("checkbox", { name: "第 3 镜" }));
    expect(screen.getByText("本轮选择 1 个镜头：3")).toBeInTheDocument();
    expect(screen.getByText("其余 2 个镜头计划沿用：1、2")).toBeInTheDocument();
    await user.click(startButton);
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      rework: expect.objectContaining({ affectedScenePositions: [3] }),
    })));
  });

  it("selects the whole verified film when any finding cannot be located to a scene", async () => {
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "返工全片复核",
        angle: "没有定位镜头时保守展示",
        audience: "短视频创作者",
        nicheSlug: "rework-whole-film",
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-rejected-whole-film",
          sourceRunRevision: 4,
          rejectionReason: "整体节奏问题。",
          nodeInstructions: { script: "精简旁白。", visualDirection: "加快剪辑。", assets: "沿用可用素材。" },
          findings: [
            { findingId: "vf-whole-000000000001", timecodeMs: 8_000, scenePosition: 4, category: "composition", description: "镜头 4 构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
            { findingId: "vf-whole-000000000002", timecodeMs: 2_000, category: "pacing", description: "整体节奏偏慢。", suggestion: "整体加快剪辑节奏。", targetNodeIds: ["script", "visual-direction", "assets"] as Array<"script" | "visual-direction" | "assets"> },
          ],
          previousScript: { scenes: [1, 2, 3, 4, 5, 6, 7, 8].map((position) => ({ position })) },
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    const scope = screen.getByRole("region", { name: "本轮变更范围" });
    expect(within(scope).getAllByRole("checkbox")).toHaveLength(8);
    for (const checkbox of within(scope).getAllByRole("checkbox")) {
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
    }
    expect(within(scope).getByText("本轮选择 8 个镜头：1、2、3、4、5、6、7、8")).toBeInTheDocument();
    expect(within(scope).queryByText(/个镜头计划沿用/)).not.toBeInTheDocument();
    expect(screen.getByText("全片问题")).toBeInTheDocument();
    expect(screen.getByText("整体节奏偏慢。")).toBeInTheDocument();
  });

  it("keeps an explicitly cleared visual scope when unlocated findings only target the script", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderReworkDialog({
      sourceRunId: "run-script-unlocated-scope",
      sourceRunRevision: 3,
      rejectionReason: "整体旁白需要精简，但画面保持不变。",
      affectedScenePositions: [],
      nodeInstructions: { script: "全片精简旁白。", visualDirection: "画面沿用上一版。", assets: "素材沿用。" },
      findings: [
        { findingId: "vf-script-unlocated-1", timecodeMs: 4_000, category: "narration", description: "全片旁白信息过密。", suggestion: "整体删减重复解释。", targetNodeIds: ["script"] as Array<"script"> },
      ],
      previousScript: { scenes: [1, 2, 3].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3].map((scenePosition) => ({ scenePosition })) },
    }, "脚本返工不扩大画面范围", onSubmit);

    // 仅指向脚本的未定位 finding 不把画面返工扩大到全片：显式空范围保持可选可改。
    const scope = screen.getByRole("region", { name: "本轮变更范围" });
    for (const checkbox of within(scope).getAllByRole("checkbox")) {
      expect(checkbox).not.toBeChecked();
      expect(checkbox).toBeEnabled();
    }
    expect(within(scope).getByText(/本轮未选择/)).toBeInTheDocument();
    expect(within(scope).queryByText(/全片问题/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      rework: expect.objectContaining({ affectedScenePositions: [] }),
    })));
  });

  it("allows a media-only rework to keep the script instruction empty and inherit the previous script", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderReworkDialog({
      sourceRunId: "run-media-only-rework",
      sourceRunRevision: 5,
      rejectionReason: "第五镜节奏不符合导演方案。",
      affectedScenePositions: [5],
      nodeInstructions: { script: "", visualDirection: "只调整第五镜节奏。", assets: "只替换第五镜素材。" },
      findings: [
        { findingId: "vf-media-only-000001", timecodeMs: 7_000, scenePosition: 5, category: "pacing", description: "第五镜人物离场过晚。", suggestion: "重做第五镜。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
      ],
      previousScript: { scenes: [1, 2, 3, 4, 5].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3, 4, 5].map((scenePosition) => ({ scenePosition })) },
    }, "媒体局部返工", onSubmit);

    const scriptInstruction = await screen.findByRole("textbox", { name: "脚本修改要求" });
    expect(scriptInstruction).toHaveValue("");
    expect(scriptInstruction).not.toBeRequired();
    expect(screen.getByText("脚本：沿用上一版脚本，本轮不重跑编剧。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      rework: expect.objectContaining({
        affectedScenePositions: [5],
        nodeInstructions: expect.objectContaining({ script: "" }),
      }),
    })));
  });

  it("keeps an inspection-only finding out of the mandatory rework scope", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderReworkDialog({
      sourceRunId: "run-inspection-only-scope",
      sourceRunRevision: 9,
      affectedScenePositions: [1, 2, 3, 4],
      nodeInstructions: { script: "", visualDirection: "只重做第 1、4 镜。", assets: "先补查第 5 镜已有素材，不进入新购买。" },
      findings: [
        { findingId: "vf-replace-000001", timecodeMs: 3_150, scenePosition: 1, category: "continuity", description: "第 1 镜人物提前消失。", suggestion: "重新生成母片。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">, action: "replace_asset" },
        { findingId: "vf-replace-000004", timecodeMs: 15_900, scenePosition: 4, category: "continuity", description: "第 4 镜树影没有跨缝变化。", suggestion: "更换母片后段。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">, action: "replace_asset" },
        { findingId: "vf-inspect-000005", timecodeMs: 23_062, scenePosition: 5, category: "continuity", description: "第 5 镜倒影移动采样不足。", suggestion: "先调看源 4.5 秒至结尾的完整片段。", targetNodeIds: ["assets"] as Array<"assets">, action: "inspect_existing_media" },
      ],
      previousScript: { scenes: [1, 2, 3, 4, 5].map((position) => ({ position })) },
      previousDirectorPlan: {
        shots: [
          { scenePosition: 1 },
          { scenePosition: 2, reuseFromScenePosition: 1 },
          { scenePosition: 3, reuseFromScenePosition: 1 },
          { scenePosition: 4, reuseFromScenePosition: 1 },
          { scenePosition: 5 },
        ],
      },
    }, "补查不等于重做", onSubmit, [1, 2, 3, 4]);

    // "先补查已有素材"不是重做授权：只要求补查的镜头不能进默认范围，也不能被标成必改，
    // 否则它会被当成重生成意图，逼迫下一轮为它重新购买或编造既有素材绑定。
    const scope = screen.getByRole("region", { name: "本轮变更范围" });
    const checkboxes = within(scope).getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(5);
    expect(checkboxes[4]).not.toBeChecked();
    expect(checkboxes[4]).toBeEnabled();
    expect(within(scope).getByText("本轮选择 4 个镜头：1、2、3、4")).toBeInTheDocument();
    expect(within(scope).getByText("其余 1 个镜头计划沿用：5")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始制作" }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      rework: expect.objectContaining({ affectedScenePositions: [1, 2, 3, 4] }),
    })));
  });

  it("restores the source run budget intention when an asynchronously loaded rework dialog opens", async () => {
    const baseProps = {
      providers,
      onClose: () => undefined,
      onSubmit: vi.fn(),
    };
    const view = render(<NewRunDialog open={false} {...baseProps} />);
    view.rerender(<NewRunDialog
      open
      {...baseProps}
      initialValues={{
        title: "保留返工预算意向",
        angle: "预算意向属于规划输入身份，不能在返工时静默丢失",
        audience: "短视频创作者",
        nicheSlug: "rework-budget-intention",
        budgetIntentionCny: 35,
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-budget-inheritance",
          sourceRunRevision: 4,
          affectedScenePositions: [2],
          nodeInstructions: { script: "", visualDirection: "只调整第二镜。", assets: "只替换第二镜。" },
          findings: [
            { findingId: "vf-budget-inherit-0001", timecodeMs: 5_000, scenePosition: 2, category: "pacing", description: "第二镜节奏不符。", suggestion: "重做第二镜。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
          ],
          previousScript: { scenes: [{ position: 1 }, { position: 2 }] },
          previousDirectorPlan: { shots: [{ scenePosition: 1 }, { scenePosition: 2 }] },
        },
      }}
    />);

    await userEvent.click(await screen.findByRole("button", { name: /查看继承设置/ }));
    expect(screen.getByRole("spinbutton", { name: "本片预算意向" })).toHaveValue(35);
  });

  it("keeps inherited settings collapsed and words inheritance as baseline reuse without promising free output", async () => {
    const user = userEvent.setup();
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "返工继承文案",
        angle: "只承诺基线与设置沿用",
        audience: "短视频创作者",
        nicheSlug: "rework-inheritance-copy",
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-rejected-inheritance",
          sourceRunRevision: 6,
          rejectionReason: "第二镜需要修改。",
          nodeInstructions: { script: "微调旁白。", visualDirection: "复核第二镜。", assets: "替换第二镜素材。" },
          findings: [
            { findingId: "vf-inherit-0000000001", timecodeMs: 8_000, scenePosition: 2, category: "composition", description: "第二镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
          ],
          previousScript: { scenes: [1, 2, 3, 4].map((position) => ({ position })) },
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("上一版脚本会作为修改基线带入，本轮需要重新规划画面方案；这些文字是待执行要求，不代表问题已经修好。")).toBeInTheDocument();
    expect(screen.getByText("脚本：以上一版脚本为修改基线，并按审片反馈调整。")).toBeInTheDocument();
    expect(screen.getByText("导演：上一版导演方案未产出，本轮需要重新规划画面方案。")).toBeInTheDocument();
    expect(screen.getByText("声音：声音设置已预填；脚本文字变化时，配音可能重新生成。")).toBeInTheDocument();
    expect(screen.getByText("审片反馈将预填到：导演方案、画面素材。")).toBeInTheDocument();
    expect(screen.getByText("报价：下一轮会对实际需要重新生成的图片和视频逐项报价；最终项目和金额以费用确认页为准。")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveTextContent("成品已保留");
    expect(dialog).not.toHaveTextContent("不会重新执行");
    expect(dialog).not.toHaveTextContent("无需重写");
    expect(dialog).not.toHaveTextContent("完全免费");
    expect(dialog).not.toHaveTextContent("模板快照");
    const inheritedToggle = screen.getByRole("button", { name: /查看继承设置/ });
    expect(inheritedToggle).toHaveAttribute("aria-expanded", "false");
    expect(inheritedToggle).toHaveTextContent("上一版预填与本轮可调整设置");
    expect(inheritedToggle).not.toHaveTextContent("默认沿用上一版");
    await user.click(inheritedToggle);
    expect(screen.getByLabelText("视频标题")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "视频模板" })).not.toBeInTheDocument();
  });

  it("words the rework header as loaded available settings instead of promising full inheritance", async () => {
    renderReworkDialog({
      sourceRunId: "run-header-wording",
      sourceRunRevision: 2,
      rejectionReason: "第二镜构图需要调整。",
      nodeInstructions: { script: "微调旁白。", visualDirection: "复核第二镜。", assets: "替换第二镜素材。" },
      findings: [
        { findingId: "vf-header-0000000001", timecodeMs: 8_000, scenePosition: 2, category: "composition", description: "第二镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
      ],
      previousScript: { scenes: [{ position: 1 }, { position: 2 }] },
      previousDirectorPlan: { shots: [{ scenePosition: 1 }, { scenePosition: 2 }] },
    });

    const dialog = await screen.findByRole("dialog", { name: "调整方案后重新制作" });
    expect(within(dialog).getByText("已载入上一版可用设置；真实母片复用与最终方案仍需重新规划验证。下面的修改要求会真正交给对应制作步骤执行。")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("已继承上一版方案");
    // 返工事实分组与预填不得被削弱。
    expect(within(dialog).getAllByText("第 2 镜")).toHaveLength(2);
    expect(within(dialog).getByLabelText("脚本修改要求")).toHaveValue("微调旁白。");
  });

  it("asks the creator to regenerate the script and replan the visuals when the previous run failed early", async () => {
    render(<NewRunDialog
      open
      providers={providers}
      inheritedNodeIds={["brief", "visual-review"]}
      initialValues={{
        title: "早期失败返工",
        angle: "上一版没有留下脚本和导演方案",
        audience: "短视频创作者",
        nicheSlug: "rework-early-failure",
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-early-failure",
          sourceRunRevision: 1,
          rejectionReason: "上一版在脚本步骤前失败。",
          nodeInstructions: { script: "重新生成完整脚本。", visualDirection: "重新规划画面方案。", assets: "重新准备画面素材。" },
          findings: [
            { findingId: "vf-early-00000000001", timecodeMs: 4_000, scenePosition: 2, category: "composition", description: "第二镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
          ],
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("上一版未留下脚本和导演方案，本轮需要重新生成脚本并重新规划画面方案；这些文字是待执行要求，不代表问题已经修好。")).toBeInTheDocument();
    expect(screen.getByText("脚本：上一版脚本未产出，本轮需要重新生成脚本。")).toBeInTheDocument();
    expect(screen.getByText("导演：上一版导演方案未产出，本轮需要重新规划画面方案。")).toBeInTheDocument();
    expect(screen.getByText("声音：声音设置已预填；脚本文字变化时，配音可能重新生成。")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveTextContent("以上一版脚本为修改基线");
    expect(dialog).not.toHaveTextContent("会作为修改基线带入");
    expect(dialog).not.toHaveTextContent("模板快照");
    expect(screen.getByText(/已带入上一版基线资料：需求简报、视觉审片记录/)).toBeInTheDocument();
    expect(screen.getByText("全片需复核；具体重做范围以重新规划后的方案为准。")).toBeInTheDocument();
    expect(screen.queryByText(/个镜头计划沿用/)).not.toBeInTheDocument();
  });

  it("reviews the whole film when historical scene numbers repeat or skip, and reuses a complete out-of-order set in order", async () => {
    const finding = (findingId: string) => ({
      findingId,
      timecodeMs: 6_000,
      scenePosition: 2,
      category: "composition",
      description: "第二镜构图失衡。",
      suggestion: "重新构图。",
      targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">,
    });
    const nodeInstructions = { script: "保留旁白事实。", visualDirection: "复核所列镜头。", assets: "替换问题镜头素材。" };

    const duplicated = renderReworkDialog({
      sourceRunId: "run-duplicate-scenes",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [finding("vf-set-000000000001")],
      previousScript: { scenes: [1, 2, 2, 3].map((position) => ({ position })) },
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("全片需复核；具体重做范围以重新规划后的方案为准。")).toBeInTheDocument();
    expect(screen.queryByText(/个镜头计划沿用/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "本轮变更范围" })).queryAllByRole("checkbox")).toHaveLength(0);
    duplicated.unmount();

    const missing = renderReworkDialog({
      sourceRunId: "run-missing-scenes",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [finding("vf-set-000000000002")],
      previousScript: { scenes: [1, 3].map((position) => ({ position })) },
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("全片需复核；具体重做范围以重新规划后的方案为准。")).toBeInTheDocument();
    expect(screen.queryByText(/个镜头计划沿用/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "本轮变更范围" })).queryAllByRole("checkbox")).toHaveLength(0);
    missing.unmount();

    renderReworkDialog({
      sourceRunId: "run-unordered-scenes",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [finding("vf-set-000000000003")],
      previousScript: { scenes: [3, 1, 2].map((position) => ({ position })) },
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("本轮选择 1 个镜头：2")).toBeInTheDocument();
    expect(screen.getByText("其余 2 个镜头计划沿用：1、3")).toBeInTheDocument();
  });

  it("falls back to the director plan scene set when the script history is unreliable, and to whole-film review when the two disagree", async () => {
    const finding = (findingId: string) => ({
      findingId,
      timecodeMs: 6_000,
      scenePosition: 2,
      category: "composition",
      description: "第二镜构图失衡。",
      suggestion: "重新构图。",
      targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets">,
    });
    const nodeInstructions = { script: "保留旁白事实。", visualDirection: "复核所列镜头。", assets: "替换问题镜头素材。" };

    const directorOnly = renderReworkDialog({
      sourceRunId: "run-plan-reliable",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [finding("vf-plan-00000000001")],
      previousScript: { scenes: [1, 2, 2].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3].map((scenePosition) => ({ scenePosition })) },
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("本轮选择 1 个镜头：2")).toBeInTheDocument();
    expect(screen.getByText("其余 2 个镜头计划沿用：1、3")).toBeInTheDocument();
    directorOnly.unmount();

    renderReworkDialog({
      sourceRunId: "run-set-disagreement",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [finding("vf-plan-00000000002")],
      previousScript: { scenes: [1, 2, 3, 4].map((position) => ({ position })) },
      previousDirectorPlan: { shots: [1, 2, 3].map((scenePosition) => ({ scenePosition })) },
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("全片需复核；具体重做范围以重新规划后的方案为准。")).toBeInTheDocument();
    expect(screen.queryByText(/个镜头计划沿用/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "本轮变更范围" })).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("lists exactly the production steps the deduped findings point to, in a fixed order", async () => {
    const nodeInstructions = { script: "重写旁白。", visualDirection: "复核构图。", assets: "替换素材。" };
    const previousScript = { scenes: [1, 2].map((position) => ({ position })) };

    const assetOnly = renderReworkDialog({
      sourceRunId: "run-target-assets",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [
        { findingId: "vf-target-00000000001", timecodeMs: 6_000, scenePosition: 1, category: "composition", description: "第一镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["assets"] as Array<"assets"> },
      ],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("审片反馈将预填到：画面素材。")).toBeInTheDocument();
    assetOnly.unmount();

    const scriptOnly = renderReworkDialog({
      sourceRunId: "run-target-script",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [
        { findingId: "vf-target-00000000002", timecodeMs: 6_000, scenePosition: 1, category: "narration", description: "第一镜旁白拗口。", suggestion: "改写句子。", targetNodeIds: ["script"] as Array<"script"> },
      ],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("审片反馈将预填到：脚本。")).toBeInTheDocument();
    scriptOnly.unmount();

    const deduped = renderReworkDialog({
      sourceRunId: "run-target-deduped",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [
        { findingId: "vf-multi-000000000001", timecodeMs: 5_000, scenePosition: 1, category: "composition", description: "第一镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
        { findingId: "vf-multi-000000000001", timecodeMs: 5_000, scenePosition: 2, category: "narration", description: "重复反馈记录，不应追加脚本步骤。", suggestion: "以第一条为准。", targetNodeIds: ["script"] as Array<"script"> },
      ],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("审片反馈将预填到：导演方案、画面素材。")).toBeInTheDocument();
    deduped.unmount();

    renderReworkDialog({
      sourceRunId: "run-target-multi",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [
        { findingId: "vf-multi-000000000002", timecodeMs: 5_000, scenePosition: 1, category: "composition", description: "第一镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
        { findingId: "vf-multi-000000000003", timecodeMs: 7_000, scenePosition: 2, category: "pacing", description: "第二镜节奏拖沓。", suggestion: "加快节奏。", targetNodeIds: ["script"] as Array<"script"> },
      ],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.getByText("审片反馈将预填到：脚本、导演方案、画面素材。")).toBeInTheDocument();
  });

  it("shows which planning stage a finding says to redo, and stays silent when the finding does not name one", async () => {
    const nodeInstructions = { script: "重写论证。", visualDirection: "复核构图。", assets: "替换素材。" };
    const previousScript = { scenes: [1, 2].map((position) => ({ position })) };

    const planningStageFinding = renderReworkDialog({
      sourceRunId: "run-planning-stage",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [{
        findingId: "vf-stage-00000000001",
        timecodeMs: 6_000,
        scenePosition: 1,
        category: "continuity",
        description: "跨镜论证依赖同一人物，当前路由兑现不了。",
        suggestion: "改用可复用的母片，或重写为无需同一主体的叙事。",
        targetNodeIds: ["visual-direction"] as Array<"visual-direction">,
        planningStageId: "director",
      }],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    // 意见指名了要重做哪一段就照它说；说成笼统的"方案有问题"会让人从最上游重做，代价是整轮素材白买。
    expect(screen.getByText(/方案 · 分镜与可执行性 ·/)).toBeInTheDocument();
    planningStageFinding.unmount();

    renderReworkDialog({
      sourceRunId: "run-asset-only-stage",
      sourceRunRevision: 2,
      nodeInstructions,
      findings: [{
        findingId: "vf-stage-00000000002",
        timecodeMs: 6_000,
        scenePosition: 1,
        category: "composition",
        description: "第一镜主体缺失。",
        suggestion: "换一条命中主体的素材。",
        targetNodeIds: ["assets"] as Array<"assets">,
      }],
      previousScript,
    });
    expect(await screen.findByRole("heading", { name: "调整方案后重新制作" })).toBeInTheDocument();
    // 素材问题本来就不落在方案里，界面不替它猜一段出来。
    expect(screen.queryByText(/方案 · /)).not.toBeInTheDocument();
  });

  it("focuses the change-scope panel first in rework mode and still focuses the title for a fresh production", async () => {
    const reworkRender = render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "返工首焦点",
        angle: "先聚焦本轮变更范围",
        audience: "短视频创作者",
        nicheSlug: "rework-focus",
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-rejected-focus",
          sourceRunRevision: 2,
          nodeInstructions: { script: "微调旁白。", visualDirection: "复核第二镜。", assets: "替换第二镜素材。" },
          findings: [
            { findingId: "vf-focus-00000000001", timecodeMs: 8_000, scenePosition: 2, category: "composition", description: "第二镜构图失衡。", suggestion: "重新构图。", targetNodeIds: ["visual-direction", "assets"] as Array<"visual-direction" | "assets"> },
          ],
          previousScript: { scenes: [1, 2].map((position) => ({ position })) },
        },
      }}
      onClose={() => undefined}
      onSubmit={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole("region", { name: "本轮变更范围" })).toHaveFocus());
    reworkRender.unmount();

    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText("视频标题")).toHaveFocus());
  });

  it("keeps a reopened rework dialog at the top without pinning later user scroll", async () => {
    const user = userEvent.setup();
    const positions = new WeakMap<HTMLElement, number>();
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: function (this: HTMLElement) { return positions.get(this) ?? 2_042; },
      set: function (this: HTMLElement, value: number) { positions.set(this, value); },
    });
    try {
      const initialValues: Partial<import("../src/shared/api.js").StudioProductionInput> = {
        title: "异步初始化返工",
        angle: "重开后仍从变更范围开始",
        audience: "短视频创作者",
        template: { templateId: "knowledge-explainer", templateVersion: 3 },
        providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
        director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
        economics: { recipeId: "free-stock", allowMeteredProviders: false },
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        rework: {
          sourceRunId: "run-async-reopen-scroll",
          sourceRunRevision: 2,
          affectedScenePositions: [1],
          nodeInstructions: { script: "只调整开场。", visualDirection: "保持视觉规则。", assets: "复核第一镜。" },
          findings: [],
          previousScript: { scenes: [{ position: 1 }, { position: 2 }] },
        },
      };
      const onSubmit = vi.fn();
      const dialog = (open: boolean) => <NewRunDialog open={open} providers={providers} initialValues={initialValues} onClose={() => undefined} onSubmit={onSubmit} />;
      const { rerender } = render(dialog(true));
      const firstScroll = document.querySelector<HTMLElement>(".recipe-form-scroll")!;
      await waitFor(() => expect(firstScroll.scrollTop).toBe(0));
      await user.click(await screen.findByRole("button", { name: /查看继承设置/ }));
      firstScroll.scrollTop = 2_042;

      rerender(dialog(false));
      rerender(dialog(true));

      const reopenedScroll = document.querySelector<HTMLElement>(".recipe-form-scroll")!;
      await waitFor(() => expect(reopenedScroll.scrollTop).toBe(0));
      expect(screen.getByRole("button", { name: /查看继承设置/ })).toHaveAttribute("aria-expanded", "false");

      reopenedScroll.scrollTop = 480;
      fireEvent.change(screen.getByRole("textbox", { name: "脚本修改要求" }), { target: { value: "用户主动修改并继续向下浏览。" } });
      expect(reopenedScroll.scrollTop).toBe(480);
      expect(studioApi.templates).not.toHaveBeenCalled();
    } finally {
      if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
    }
  });

  it("uses persisted creator defaults for recipe, voice, and asset provider", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const configuredProviders: StudioProvider[] = [
      ...providers.map((provider) => provider.id === "pexels-stock-v1" ? { ...provider, available: true, status: "ready" as const } : provider),
    ];
    render(<NewRunDialog
      open
      providers={configuredProviders}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
        defaultRecipeId: "free-stock",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        defaultAssetProviderId: "pexels-stock-v1",
        productionDefaults: { directorProfileId: "documentary-observer", reviewMode: "manual", platform: "bilibili", durationSeconds: 30 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    expect(screen.getByRole("radio", { name: /仅免费画面/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "导演角色" })).toHaveValue("documentary-observer");
    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("30");
    expect(screen.getByLabelText("终审模式")).toHaveTextContent("人工终审");
    expect(await screen.findByRole("button", { name: /高级微调/ })).toHaveTextContent("205 字/分");
    await user.click(screen.getByText("更多：素材来源与制作细节"));
    expect(screen.getByRole("checkbox", { name: /Pexels 图库/ })).toBeChecked();
    await user.type(screen.getByLabelText("视频标题"), "默认值真实进入生产单");
    await user.type(screen.getByLabelText("内容角度"), "验证总配置不是展示页");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      platform: "bilibili",
      durationSeconds: 30,
      reviewMode: "manual",
      director: expect.objectContaining({ profileId: "documentary-observer" }),
      economics: expect.objectContaining({ recipeId: "free-stock" }),
    }));
  });

  it("does not carry a metered default asset into a free recipe", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const configuredProviders: StudioProvider[] = [...providers, {
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: true,
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: 5,
    }];
    render(<NewRunDialog
      open
      providers={configuredProviders}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        defaultAssetProviderId: "seedance-video-v1",
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.type(screen.getByLabelText("视频标题"), "免费配方不能夹带付费素材");
    await user.type(screen.getByLabelText("内容角度"), "配置优先级必须与成本承诺一致");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      economics: expect.objectContaining({ allowMeteredProviders: false }),
      director: expect.objectContaining({
        assetProviderIds: expect.not.arrayContaining(["seedance-video-v1"]),
      }),
    }));
  });

  it("never treats the shot router itself as a director asset source", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog
      open
      providers={providers}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "economy-daily",
        topicStrategy: { customInstruction: "优先可拍题材。" },
        defaultAssetProviderId: "ai-shot-router-v1",
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      }}
      onClose={() => undefined}
      onSubmit={onSubmit}
    />);

    await user.type(screen.getByLabelText("视频标题"), "素材路由不能把自己当素材");
    await user.type(screen.getByLabelText("内容角度"), "验证编排器与素材来源的边界");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      director: expect.objectContaining({ assetProviderIds: ["pexels-stock-v1"] }),
    }));
  });

  it("blocks dispatch and shows voice as unconfigured when only a test provider can serve it", async () => {
    const providersWithTestVoice = [
      ...providers.filter((provider) => provider.capability !== "voice.synthesize"),
      { id: "ffmpeg-tone-test-v1", capability: "voice.synthesize", label: "测试音轨", available: true, kind: "test" as const },
    ];
    render(<NewRunDialog open providers={providersWithTestVoice} onClose={() => undefined} onSubmit={async () => undefined} />);

    expect(screen.queryByRole("option", { name: "测试音轨" })).not.toBeInTheDocument();
    expect(screen.getByText(/缺少正式生产能力：配音/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    await userEvent.setup().click(screen.getByText("更多：素材来源与制作细节"));
    expect(screen.getByRole("button", { name: /04配音声音导演未配置/ })).toBeInTheDocument();
  });

  it("traps dialog focus and restores the trigger after closing", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={async () => undefined} />);

    await waitFor(() => expect(screen.getByLabelText("视频标题")).toHaveFocus());
    screen.getByTitle("关闭").focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "开始制作" })).toHaveFocus();

    rerender(<NewRunDialog open={false} providers={providers} onClose={() => undefined} onSubmit={async () => undefined} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("keeps the video, workflow state, and approval action in one review surface", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(undefined);
    render(<RunWorkbench run={runDetail} decisionPending={false} onDecision={onDecision} />);

    expect(screen.getByTitle("成片预览")).toHaveAttribute("src", "/api/video#t=0.1");
    const preview = screen.getByRole("region", { name: "成片预览" });
    const workspaces = screen.getByRole("region", { name: "逐项预览与修改" });
    expect(preview.compareDocumentPosition(workspaces) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("总导演 · 人工终审")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "人工终审 · 总导演" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /人工终审/ })).not.toBeInTheDocument();
    expect(screen.getByText("导演 · 导演方案")).toBeInTheDocument();
    expect(screen.getByText("请完整观看成片，确认内容和节奏。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载成片" })).toHaveAttribute("download");
    expect(screen.queryByText(/技术文件与运行证据/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /脚本技术文件/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "批准进入发布包" }));

    expect(screen.getByRole("dialog", { name: "确认批准成片" })).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认批准并生成发布包" }));
    expect(onDecision).toHaveBeenCalledWith({
      action: "approve",
      expectedRunRevision: 3,
      interventionId: "intervention-1",
      reviewEvidenceId: null,
    });
  });

  it("offers the voice timing intervention action instead of publish approval", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const { videoArtifactId: _videoArtifactId, ...runWithoutVideo } = runDetail;
    const run: StudioRunDetail = {
      ...runWithoutVideo,
      revision: 4,
      activeIntervention: {
        id: "voice-timing-1",
        nodeId: "voice",
        reason: "自然配音超出当前镜头；请调整统一方案。",
        options: ["request_changes", "reject"],
        createdAt: "2026-09-09T10:00:00.000Z",
      },
      nodes: [...runDetail.nodes.filter((node) => node.id !== "voice"), {
        ...runDetail.nodes.find((node) => node.id === "final-review")!,
        id: "voice",
        label: "配音",
        role: "声音导演",
        status: "needs_human",
        output: { conflict: {
          code: "VOICE_DOES_NOT_FIT",
          scenePosition: 1,
          plannedSeconds: 8,
          speechSeconds: 8.2,
          requiredSeconds: 8.2,
          audioArtifact: { kind: "voiceover_raw", uri: "/managed/raw.mp3", sha256: "a".repeat(64), sizeBytes: 12, contentType: "audio/mpeg" },
        } },
      }],
    };

    render(<RunWorkbench run={run} decisionPending={false} onDecision={onDecision} />);

    expect(screen.getByRole("button", { name: "调整方案" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批准|发布包/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "调整方案" }));
    const dialog = screen.getByRole("dialog", { name: "调整配音时长" });
    expect(within(dialog).getByLabelText("镜头 1 时长（秒）")).toHaveValue(8.2);
    await user.click(within(dialog).getByRole("button", { name: "接受新时长并继续制作" }));
    expect(onDecision).toHaveBeenCalledWith({
      action: "request_changes",
      expectedRunRevision: 4,
      interventionId: "voice-timing-1",
      reviewEvidenceId: null,
      voiceTiming: { scenePosition: 1, durationSeconds: 8.2 },
    });
  });

  it("makes the visual review recommendation the default final-review decision", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(undefined);
    // 逐条表态的条目编号由服务端按结论内容算出后随成片下发。这里用固定值模拟服务端已经发过的编号，
    // 界面只负责原样回传——界面自己算键会让表态落到别的条目上。
    const notObservedItemKey = "b".repeat(64);
    const infoItemKey = "c".repeat(64);
    const run: StudioRunDetail = {
      ...runDetail,
      nodes: [
        ...runDetail.nodes.filter((node) => node.id !== "final-review"),
        {
          id: "visual-review",
          label: "视觉审片",
          role: "视觉审片员",
          status: "succeeded",
          artifactIds: [],
          qualityGateResults: [],
          output: { report: {
            recommendation: "revise",
            confidence: 0.87,
            summary: "画面语义与导演方案不一致，应进入 manualReplacement 后再审。",
            scores: { composition: 65, continuity: 41, pacing: 54, legibility: 62, safety: 84 },
            findings: [
              { severity: "major", message: "开场缺少关键动作。" },
              {
                timecodeMs: 2400,
                scenePosition: 1,
                category: "legibility",
                description: "第 1 镜字幕压在浅色背景上。",
                suggestion: "加深字幕描边或换到深色区域。",
                evidenceStatus: "not_observed",
                severity: "warning",
                itemKey: notObservedItemKey,
              },
              {
                timecodeMs: 9100,
                scenePosition: 2,
                category: "pacing",
                description: "第 2 镜停留略长。",
                suggestion: "确认这里是否有意留白。",
                evidenceStatus: "satisfied",
                severity: "info",
                itemKey: infoItemKey,
              },
            ],
            reviewScope: { evidenceId: "a".repeat(64) },
            independentReviews: [{
              providerId: "glm-visual-review-v1",
              modelId: "glm-5.3-flash",
              report: {
                recommendation: "revise",
                summary: "GLM 发现开场画面没有兑现承诺。",
                scores: { composition: 68, continuity: 45, pacing: 52, legibility: 64, safety: 86 },
                findings: [{ claimType: "static", evidenceStatus: "failed", severity: "warning" }],
              },
            }, {
              providerId: "codex-visual-review-v1",
              modelId: "gpt-5.6-sol",
              report: {
                recommendation: "reject",
                summary: "Codex 认为关键动作缺失，不能直接发布。",
                scores: { composition: 60, continuity: 38, pacing: 50, legibility: 62, safety: 84 },
                findings: [
                  { claimType: "static", evidenceStatus: "failed", severity: "critical" },
                  { claimType: "static", evidenceStatus: "failed", severity: "warning" },
                ],
              },
            }],
          } },
        },
        runDetail.nodes.find((node) => node.id === "final-review")!,
      ],
    };

    render(<RunWorkbench run={run} providers={providers} decisionPending={false} onDecision={onDecision} />);

    expect(screen.getByText("视觉审片建议修改后再审")).toBeInTheDocument();
    expect(screen.getByText("请完整观看成片，确认内容和节奏。")).toBeInTheDocument();
    expect(screen.getAllByText("画面语义与导演方案不一致，应进入 人工补充素材 后再审。").length).toBeGreaterThan(0);
    expect(screen.queryByText(/manualReplacement/i)).not.toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "连续性 41")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "终止制作" })).toBeInTheDocument();
    const dualReview = screen.getByRole("region", { name: "双模型审片结果" });
    expect(within(dualReview).getByText("两者查看同一份成片证据")).toBeInTheDocument();
    expect(within(dualReview).getByText("GLM 发现开场画面没有兑现承诺。")).toBeInTheDocument();
    expect(within(dualReview).getByText("Codex 认为关键动作缺失，不能直接发布。")).toBeInTheDocument();
    expect(within(dualReview).getByText(/glm-5\.3-flash · 63 分 · 1 项问题/)).toBeInTheDocument();
    expect(within(dualReview).getByText(/gpt-5\.6-sol · 59 分 · 2 项问题/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "仍要批准（说明理由）" }));
    const dialog = screen.getByRole("dialog", { name: "逐条表态后批准成片" });
    const approve = within(dialog).getByRole("button", { name: "逐条表态已完成，生成发布包" });
    // 审片提出的每一条结论都要表态；只要还有没表态的条目，批准就必须是禁用的。
    expect(approve).toBeDisabled();
    expect(within(dialog).getByText("还有 2 条没有表态。")).toBeInTheDocument();
    expect(within(dialog).getByText("镜头 1 · 00:02")).toBeInTheDocument();
    expect(within(dialog).getByText("抽帧看不出来，需要人眼确认")).toBeInTheDocument();
    // 机器质检不在逐条表态范围内，界面要说清这一点，否则操作员会以为漏签了什么。
    expect(within(dialog).getByText(/技术质检不适用逐条表态/)).toBeInTheDocument();

    // 采纳等于承认这条结论要返修，本轮就不能批准；这是"逐条表态"与旧版"覆盖建议"的分界。
    const adopt = within(dialog).getAllByRole("button", { name: "采纳，先返修" })[0]!;
    await user.click(adopt);
    expect(within(dialog).getByText("已采纳：这条结论需要先返修，本轮不能批准。")).toBeInTheDocument();
    expect(approve).toBeDisabled();
    expect(within(dialog).getByText(/其中 1 条已采纳、还等着返修。/)).toBeInTheDocument();

    await user.click(within(dialog).getAllByRole("button", { name: "不采纳，维持现状" })[0]!);
    const firstReason = within(dialog).getByLabelText("不采纳理由");
    await user.type(firstReason, "已逐帧复核，这里是刻意的浅色画面");
    // 只有不采纳的条目需要写明理由，两条都表态且都写了理由才放行。
    expect(approve).toBeDisabled();
    await user.click(within(dialog).getAllByRole("button", { name: "不采纳，维持现状" })[1]!);
    const secondReason = within(dialog).getAllByLabelText("不采纳理由")[1]!;
    await user.type(secondReason, "节奏符合本次发布要求");
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(onDecision).toHaveBeenCalledWith({
      action: "approve",
      expectedRunRevision: 3,
      interventionId: "intervention-1",
      reviewEvidenceId: "a".repeat(64),
      reviewDispositions: [
        { itemKey: notObservedItemKey, decision: "reject", reason: "已逐帧复核，这里是刻意的浅色画面" },
        { itemKey: infoItemKey, decision: "reject", reason: "节奏符合本次发布要求" },
      ],
    });
  });

  it("labels a review branch whose own audit did not pass without calling the work failed", () => {
    // 分支审计判 repair，说的是"这份审片报告本身站不住"，不是"作品不行"。发布闸门因此不再拦它，
    // 但界面必须如实说出来——否则用户会拿着一条没过质检的意见去返修一个其实没问题的镜头。
    const run: StudioRunDetail = {
      ...runDetail,
      nodes: [
        ...runDetail.nodes.filter((node) => node.id !== "final-review"),
        {
          id: "visual-review",
          label: "视觉审片",
          role: "视觉审片员",
          status: "succeeded",
          artifactIds: [],
          qualityGateResults: [],
          output: { report: {
            recommendation: "approve",
            confidence: 0.82,
            summary: "两个模型都认为成片可用。",
            scores: { composition: 80, continuity: 78 },
            findings: [],
            reviewScope: {
              evidenceId: "a".repeat(64),
              actualModels: [
                { providerId: "glm-visual-review-v1", modelId: "glm-5.3-flash", auditVerdict: "pass" },
                { providerId: "codex-visual-review-v1", modelId: "gpt-5.6-sol", auditVerdict: "repair" },
              ],
            },
            independentReviews: [{
              providerId: "glm-visual-review-v1",
              modelId: "glm-5.3-flash",
              report: { recommendation: "approve", summary: "GLM 认为可以发布。", scores: { composition: 80 } },
            }, {
              providerId: "codex-visual-review-v1",
              modelId: "gpt-5.6-sol",
              report: { recommendation: "approve", summary: "Codex 认为可以发布。", scores: { composition: 76 } },
            }],
          } },
        },
        runDetail.nodes.find((node) => node.id === "final-review")!,
      ],
    };

    render(<RunWorkbench run={run} providers={providers} decisionPending={false} onDecision={vi.fn()} />);

    const dualReview = screen.getByRole("region", { name: "双模型审片结果" });
    const caveat = within(dualReview).getByRole("note");
    expect(within(caveat).getByText("有 1 份意见自己的独立审计没通过")).toBeInTheDocument();
    expect(caveat).toHaveTextContent("AI 视觉审片 · gpt-5.6-sol");
    // 说清审计查的是什么，避免被读成对作品的判决。
    expect(caveat).toHaveTextContent("这份审片报告本身站不站得住");
    expect(caveat).toHaveTextContent("作品能不能发由你定");
    // 逐分支标注：只有没过质检的那条被点名，另一条不受牵连。
    expect(within(dualReview).getByText(/gpt-5\.6-sol · 76 分 · 0 项问题 · 独立审计未通过/)).toBeInTheDocument();
    expect(within(dualReview).getByText(/glm-5\.3-flash · 80 分 · 0 项问题/).textContent).toBe("glm-5.3-flash · 80 分 · 0 项问题");
  });

  it("keeps an older workflow read-only and offers a new production instead of broken review actions", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const onRestart = vi.fn();
    const reason = "这条制作来自旧版工作流，只能查看现有结果。若要继续调整，请基于这版重新制作。";

    render(<RunWorkbench
      run={{
        ...runDetail,
        continuation: { supported: false, reason },
        progress: {
          completedNodes: 10,
          totalNodes: 12,
          percentage: 83,
          elapsedSeconds: 120,
          lastUpdatedAt: "2026-09-07T12:00:00.000Z",
        },
        phases: [{ id: "review", label: "质量审片", status: "attention", nodeIds: ["final-review"], completedNodes: 0, totalNodes: 1 }],
      }}
      decisionPending={false}
      onDecision={onDecision}
      onRestart={onRestart}
    />);

    expect(screen.getByText("历史只读")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "这条旧版制作仅供查看" })).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "制作进度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "生产工作流" })).not.toBeInTheDocument();
    expect(screen.queryByText("10 / 12 个步骤完成")).not.toBeInTheDocument();
    expect(screen.queryByText("83%")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "批准进入发布包" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打回" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "基于这版重新制作" }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("submits a localized scene revision and seeks the preview to the finding", async () => {
    const user = userEvent.setup();
    const onRequestSceneRevision = vi.fn().mockResolvedValue(undefined);
    const run: StudioRunDetail = {
      ...runDetail,
      revision: 7,
      artifacts: [
        ...runDetail.artifacts,
        { id: "review-current", kind: "review_report", producerNodeId: "visual-review", createdAt: "2026-08-21T10:00:30.000Z" },
      ],
      nodes: [
        ...runDetail.nodes.filter((node) => node.id !== "final-review"),
        {
          id: "assets",
          label: "画面",
          status: "succeeded",
          artifactIds: [],
          qualityGateResults: [],
          outputState: { generatedVersionId: "assets-v1", effectiveVersionId: "assets-v1", stale: false, versions: [] },
        },
        {
          id: "visual-review",
          label: "视觉审片",
          status: "succeeded",
          artifactIds: ["review-current"],
          qualityGateResults: [],
          outputState: {
            generatedVersionId: "review-v1",
            effectiveVersionId: "review-v1",
            stale: false,
            versions: [{
              id: "review-v1",
              source: "generated",
              artifactIds: ["review-current"],
              inputVersionIds: [],
              createdAt: "2026-08-21T10:00:30.000Z",
              createdBy: "glm-visual-review-v1",
              schemaVersion: "video-factory/visual-review-v1",
              output: { report: {
                recommendation: "revise",
                confidence: 0.91,
                summary: "第二镜动作不连续。",
                scores: { composition: 80, continuity: 45, pacing: 80, legibility: 85, safety: 95 },
                findings: [{
                  timecodeMs: 6_000,
                  scenePosition: 2,
                  targetNodeId: "assets",
                  category: "continuity",
                  severity: "warning",
                  claimType: "static", evidenceStatus: "failed",
                  nextAction: "rework_asset",
                  description: "第二镜与第一镜动作不连续。",
                  suggestion: "复用第一镜母片。",
                }],
              } },
            }],
          },
        },
        runDetail.nodes.find((node) => node.id === "final-review")!,
      ],
    };

    render(<RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} onRequestSceneRevision={onRequestSceneRevision} />);
    const preview = screen.getByTitle("成片预览") as HTMLVideoElement;
    Object.defineProperty(preview, "currentTime", { value: 0, writable: true });
    await user.click(screen.getByRole("button", { name: /镜头 2.*00:06/ }));
    expect(preview.currentTime).toBe(6);
    await user.selectOptions(screen.getByLabelText("用已有镜头替换"), "1");
    await user.type(screen.getByLabelText("修改说明"), "第二镜复用第一镜母片");
    await user.click(screen.getByRole("button", { name: "替换后重新审片" }));

    expect(onRequestSceneRevision).toHaveBeenCalledWith({
      expectedRunRevision: 7,
      expectedAssetVersionId: "assets-v1",
      reviewArtifactId: "review-current",
      findingIndex: 0,
      reuseFromScenePosition: 1,
      note: "第二镜复用第一镜母片",
    });
  });

  it("offers a narration rewrite on every located finding, next to the asset-reuse option", async () => {
    const user = userEvent.setup();
    const onRequestNarrationRevision = vi.fn().mockResolvedValue(undefined);
    const onLoadSceneNarration = vi.fn(async (scenePosition: number) => `镜头 ${scenePosition} 的原文`);
    const run: StudioRunDetail = {
      ...runDetail,
      revision: 7,
      artifacts: [
        ...runDetail.artifacts,
        { id: "review-current", kind: "review_report", producerNodeId: "visual-review", createdAt: "2026-08-21T10:00:30.000Z" },
      ],
      nodes: [
        ...runDetail.nodes.filter((node) => node.id !== "final-review"),
        {
          id: "assets",
          label: "画面",
          status: "succeeded",
          artifactIds: [],
          qualityGateResults: [],
          outputState: { generatedVersionId: "assets-v1", effectiveVersionId: "assets-v1", stale: false, versions: [] },
        },
        {
          id: "visual-review",
          label: "视觉审片",
          status: "succeeded",
          artifactIds: ["review-current"],
          qualityGateResults: [],
          outputState: {
            generatedVersionId: "review-v1",
            effectiveVersionId: "review-v1",
            stale: false,
            versions: [{
              id: "review-v1",
              source: "generated",
              artifactIds: ["review-current"],
              inputVersionIds: [],
              createdAt: "2026-08-21T10:00:30.000Z",
              createdBy: "glm-visual-review-v1",
              schemaVersion: "video-factory/visual-review-v1",
              output: { report: {
                recommendation: "revise",
                confidence: 0.91,
                summary: "第一镜口播没说清，第二镜画面不连续。",
                scores: { composition: 80, continuity: 45, pacing: 80, legibility: 85, safety: 95 },
                findings: [
                  {
                    timecodeMs: 2_000,
                    scenePosition: 1,
                    targetNodeId: "script",
                    category: "messaging",
                    severity: "warning",
                    claimType: "non_visual", evidenceStatus: "failed",
                    nextAction: "replan_upstream",
                    description: "第一镜口播与画面主张不一致。",
                    suggestion: "改写第一镜旁白。",
                  },
                  {
                    timecodeMs: 6_000,
                    scenePosition: 2,
                    targetNodeId: "assets",
                    category: "continuity",
                    severity: "warning",
                    claimType: "static", evidenceStatus: "failed",
                    nextAction: "rework_asset",
                    description: "第二镜与第一镜动作不连续。",
                    suggestion: "复用第一镜母片。",
                  },
                ],
              } },
            }],
          },
        },
        runDetail.nodes.find((node) => node.id === "final-review")!,
      ],
    };

    render(<RunWorkbench
      run={run}
      decisionPending={false}
      onDecision={async () => undefined}
      onRequestSceneRevision={async () => undefined}
      onRequestNarrationRevision={onRequestNarrationRevision}
      onLoadSceneNarration={onLoadSceneNarration}
    />);
    // 两条结论都带镜位，所以都给文字入口：指向脚本的结论改字是唯一修法；指向素材的结论
    // 「画面没兑现这句话」有两个修法（改画面或改承诺），哪边是问题由操作员判断。
    const rewriteButtons = screen.getAllByRole("button", { name: "改这一镜的字幕/旁白" });
    expect(rewriteButtons).toHaveLength(2);
    // 素材那一条同时并排给出"复用更早镜头"：两个修法都摆出来，不替操作员选边。
    expect(screen.getAllByRole("button", { name: "替换后重新审片" })).toHaveLength(1);
    // 第一镜没有更早的镜头可复用，替换控件整块不渲染；文字入口不受影响。
    expect(screen.getAllByLabelText("用已有镜头替换")).toHaveLength(1);

    // 原文要等到展开时才取：改字必须看得到现在写的是什么，不能凭记忆重打一遍。
    expect(onLoadSceneNarration).not.toHaveBeenCalled();
    await user.click(rewriteButtons[0]!);
    expect(onLoadSceneNarration).toHaveBeenCalledWith(1);
    const text = await screen.findByLabelText("镜头 1 的旁白字幕");
    expect(text).toHaveValue("镜头 1 的原文");
    expect(screen.getByText(/只改字，画面不重新生成、也不重新购买/)).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "按新文字重做配音与字幕" });
    // 文字没变就不该让操作员白花一次配音钱。
    expect(submit).toBeDisabled();
    expect(screen.getByText("文字和现在一样，改完不会产生任何变化。")).toBeInTheDocument();
    await user.clear(text);
    await user.type(text, "改过的第一镜旁白");
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("这一镜的修改说明"), "第一镜口播与画面主张不一致");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onRequestNarrationRevision).toHaveBeenCalledWith({
      expectedRunRevision: 7,
      scenePosition: 1,
      narration: "改过的第一镜旁白",
      note: "第一镜口播与画面主张不一致",
    });
  });

  it("keeps technical execution nodes out of the editable creative deliverables", () => {
    const run: StudioRunDetail = {
      ...runDetail,
      nodes: [
        ...runDetail.nodes,
        { id: "render", label: "渲染", role: "剪辑师", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { duration_target: 30 } },
        { id: "technical-review", label: "机器质检", role: "技术质检", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { status: "passed" } },
      ],
    };

    render(<RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} />);

    const workspaces = screen.getByRole("region", { name: "逐项预览与修改" });
    expect(within(workspaces).queryByRole("group", { name: "渲染 · 剪辑师" })).not.toBeInTheDocument();
    expect(within(workspaces).queryByRole("group", { name: "机器质检 · 技术质检" })).not.toBeInTheDocument();
    expect(within(workspaces).queryByRole("group", { name: "人工终审 · 总导演" })).not.toBeInTheDocument();
  });

  it("keeps generated scene media available after the asset plan is manually revised", async () => {
    const user = userEvent.setup();
    const run: StudioRunDetail = {
      ...runDetail,
      nodes: [
        ...runDetail.nodes,
        {
          id: "assets",
          label: "画面",
          role: "素材导演",
          status: "succeeded",
          artifactIds: ["asset-plan-human"],
          qualityGateResults: [],
          output: { director_routing: [{ scene_position: 1, query: "窗边水杯" }] },
        },
      ],
      artifacts: [
        ...runDetail.artifacts,
        { id: "asset-plan-human", kind: "asset_plan", producerNodeId: "assets", providerId: "human-editor", createdAt: "2026-08-21T10:00:40.000Z", contentType: "application/json", contentUrl: "/api/asset-plan" },
        { id: "scene-video", kind: "media_asset", producerNodeId: "assets", providerId: "hailuo-video-v1", scenePosition: 6, createdAt: "2026-08-21T10:00:20.000Z", contentType: "video/mp4", contentUrl: "/api/scene-video" },
      ],
    };

    render(<RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} />);
    await user.click(screen.getByText("画面").closest("summary")!);

    expect(document.querySelector('video[aria-label="镜头 6 画面预览"]')).toHaveAttribute("src", "/api/scene-video");
    expect(screen.getByText("镜头 6")).toBeInTheDocument();
  });

  it("puts the current paid node and its confirmation action above unfinished output", async () => {
    const { activeIntervention: _activeIntervention, videoArtifactId: _videoArtifactId, ...base } = runDetail;
    const paidRun: StudioRunDetail = {
      ...base,
      status: "awaiting_spend_approval",
      nextAction: "confirm_spend",
      currentNodeId: "voice",
      artifacts: [],
      nodes: [
        { id: "brief", label: "内容简报", role: "制片人", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { title: runDetail.title } },
        {
          id: "voice",
          label: "配音",
          role: "声音导演",
          status: "awaiting_spend_approval",
          artifactIds: [],
          qualityGateResults: [],
          spendPlan: {
            id: "voice-plan",
            inputVersionIds: [],
            providerId: "minimax-speech-v1",
            modelId: "speech-02-hd",
            estimatedCostCny: 0.3,
            maxCostCny: 0.5,
            maxAttempts: 1,
            createdAt: "2026-08-29T00:00:00.000Z",
          },
        },
        { id: "render", label: "渲染", role: "剪辑师", status: "pending", artifactIds: [], qualityGateResults: [] },
      ],
    };

    render(<RunWorkbench run={paidRun} decisionPending={false} onDecision={async () => undefined} onAuthorizeSpend={async () => undefined} />);

    expect(screen.getByRole("heading", { name: "现在需要你：确认配音" })).toBeInTheDocument();
    // C2 后主按钮是两阶段制作范围授权（先取报价）；无 digest 时禁用。
    const confirmButton = screen.getByRole("button", { name: /获取费用报价/ });
    expect(confirmButton).toBeInTheDocument();
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/声音导演完成后，系统会继续推进后续步骤/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "成片预览" })).not.toBeInTheDocument();
  });

  it("shows the director's visual bible and AI-generated per-shot routes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      resolvedProfileId: "documentary-observer",
      profileRationale: "热点内容需要真实动作与环境证据。",
      visualBible: {
        narrativeApproach: "先现场后解释",
        pacing: "前快后稳",
        composition: "环境中景与细节特写",
        camera: "轻微手持",
        color: "自然暖色",
        sound: "保留环境声",
      },
      shots: [{
        scenePosition: 1,
        narrativeRole: "事实钩子",
        authenticityPolicy: "evidence",
        preferredProviderId: "pexels-stock-v1",
        rationale: "使用真实街景建立可信度。",
        continuityNote: "保持同一清晨",
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RunWorkbench
      run={{
        ...runDetail,
        nodes: runDetail.nodes.map((node) => node.id === "visual-direction" ? {
          ...node,
          artifactIds: ["director-plan-current"],
          outputState: {
            generatedVersionId: "director-v1",
            effectiveVersionId: "director-v2",
            stale: false,
            versions: [
              { id: "director-v1", source: "generated", artifactIds: ["director-plan-old"], inputVersionIds: [], createdAt: "2026-08-21T10:00:20.000Z", createdBy: "director", schemaVersion: "1" },
              { id: "director-v2", source: "human", artifactIds: ["director-plan-current"], inputVersionIds: [], createdAt: "2026-08-21T10:00:30.000Z", createdBy: "owner", schemaVersion: "1" },
            ],
          },
        } : node),
        artifacts: [
          ...runDetail.artifacts,
          { id: "director-plan-old", kind: "storyboard", producerNodeId: "visual-direction", createdAt: "2026-08-21T10:00:20.000Z", contentType: "application/json", contentUrl: "/api/director-plan-old" },
          { id: "director-plan-current", kind: "storyboard", producerNodeId: "visual-direction", createdAt: "2026-08-21T10:00:30.000Z", contentType: "application/json", contentUrl: "/api/director-plan-current" },
        ],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    const panel = [...document.querySelectorAll<HTMLElement>(".node-workspace")].find((element) => element.textContent?.includes("导演方案"));
    if (!panel) throw new Error("导演方案节点不存在");
    await user.click(within(panel).getByText("导演方案"));
    expect(await within(panel).findByText("纪实观察")).toBeInTheDocument();
    expect(within(panel).getByText("先现场后解释")).toBeInTheDocument();
    expect(within(panel).getByText("事实镜头")).toBeInTheDocument();
    expect(within(panel).getByText(/Pexels 图库/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/director-plan-current", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.unstubAllGlobals();
  });

  it("requires explicit compliance confirmations before one-click multi-platform publishing", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "publishReadiness").mockResolvedValue({
      runId: "run-1",
      ready: true,
      title: runDetail.title,
      targets: [
        { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        { id: "kuaishou", label: "快手", mode: "official_api", status: "planned", requirement: "需要申请开放平台权限" },
        { id: "xiaohongshu", label: "小红书", mode: "export_package", status: "manual_only", requirement: "导出后人工上传" },
      ],
      checks: [
        { id: "approval", label: "终审与发布包", status: "passed", detail: "已批准" },
        { id: "aigc", label: "AI 内容声明", status: "requires_confirmation", detail: "发布时主动声明" },
      ],
    });
    const publish = vi.spyOn(studioApi, "publish").mockResolvedValue({
      id: "publish-1",
      runId: "run-1",
      status: "succeeded",
      createdAt: "2026-08-25T00:02:00.000Z",
      deliveries: [
        { platformId: "douyin", status: "submitted", externalId: "douyin-item" },
        { platformId: "xiaohongshu", status: "export_ready" },
      ],
    });
    render(<MultiPlatformPublishDialog runId="run-1" onClose={() => undefined} />);

    expect(await screen.findByRole("checkbox", { name: /抖音/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /快手/ })).toBeDisabled();
    const submit = screen.getByRole("button", { name: /确认并执行 2 个平台/ });
    expect(submit).toBeDisabled();
    for (const confirmation of [
      /完整观看最终成片/,
      /主动声明 AI/,
      /具备发布所需授权/,
      /事实来源与时效/,
      /商品、服务或商业合作/,
    ]) {
      await user.click(screen.getByRole("checkbox", { name: confirmation }));
    }
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(publish).toHaveBeenCalledWith("run-1", expect.objectContaining({
      requestId: expect.stringMatching(/^publish-/),
      platformIds: ["douyin", "xiaohongshu"],
      confirmations: expect.objectContaining({ aigcDisclosure: true, rightsAndLikeness: true }),
    }));
    expect(await screen.findByText("已提交审核")).toBeInTheDocument();
    expect(screen.getByText("发布包已准备")).toBeInTheDocument();
    expect(screen.getByText("抖音")).toBeInTheDocument();
    expect(screen.getByText("小红书")).toBeInTheDocument();
  });

  it("closes the rejection dialog when the run leaves human review", async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<RunWorkbench run={runDetail} decisionPending={false} onDecision={onDecision} />);
    await user.click(screen.getByRole("button", { name: "终止制作" }));
    expect(screen.getByRole("dialog", { name: "终止这条视频的制作" })).toBeInTheDocument();

    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    rerender(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "rejected",
        decisions: [{
          id: "decision-1",
          action: "reject",
          actor: "operator",
          note: "字幕需要精简",
          createdAt: "2026-08-21T11:00:00.000Z",
        }],
      }}
      decisionPending={false}
      onDecision={onDecision}
    />);

    expect(screen.queryByRole("dialog", { name: "终止这条视频的制作" })).not.toBeInTheDocument();
    expect(screen.getByText("字幕需要精简")).toBeInTheDocument();
  });

  it("offers a recoverable route after a failed production", async () => {
    const user = userEvent.setup();
    const onRestart = vi.fn();
    const onRetryFailedNode = vi.fn().mockResolvedValue(undefined);
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{ ...withoutIntervention, status: "failed", nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, status: "failed" } : node) }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={onRestart}
      onRetryFailedNode={onRetryFailedNode}
    />);

    await user.click(screen.getByRole("button", { name: "重试失败步骤" }));
    expect(onRetryFailedNode).toHaveBeenCalledWith(withoutIntervention.nodes[0]?.id);
    await user.click(screen.getByRole("button", { name: "调整方案后重新制作" }));

    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("shows five production phases, truthful progress, current role action, and model provenance", () => {
    const { activeIntervention: _activeIntervention, videoArtifactId: _videoArtifactId, ...withoutReview } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutReview,
        status: "running",
        currentNodeId: "visual-direction",
        phases: [
          { id: "planning", label: "策划定稿", status: "running", nodeIds: ["brief", "visual-direction"], completedNodes: 1, totalNodes: 2 },
          { id: "assets", label: "素材筹备", status: "pending", nodeIds: [], completedNodes: 0, totalNodes: 0 },
          { id: "composition", label: "声音与剪辑", status: "pending", nodeIds: [], completedNodes: 0, totalNodes: 0 },
          { id: "review", label: "审片质检", status: "pending", nodeIds: [], completedNodes: 0, totalNodes: 0 },
          { id: "delivery", label: "交付发布", status: "pending", nodeIds: [], completedNodes: 0, totalNodes: 0 },
        ],
        progress: {
          completedNodes: 1,
          totalNodes: 4,
          percentage: 25,
          elapsedSeconds: 42,
          currentNodeElapsedSeconds: 7,
          lastUpdatedAt: "2026-08-30T10:00:42.000Z",
          etaUnavailableReason: "insufficient_history",
        },
        currentAction: { nodeId: "visual-direction", role: "导演", label: "正在统一叙事节奏、镜头语法与视觉规则" },
        resultAvailability: { kind: "none", usable: false, label: "尚未生成成片", detail: "当前仍在前期制作。" },
        nodes: withoutReview.nodes.map((node) => node.id === "visual-direction" ? {
          ...node,
          status: "running",
          plannedExecution: {
            providerId: "glm-director",
            providerLabel: "智谱视觉导演",
            modelId: "glm-5.3-flash",
            transport: "http_api",
            billing: "subscription",
            snapshotSource: "created",
          },
        } : node),
        artifacts: [],
      }}
      providers={[{
        id: "glm-director",
        capability: "storyboard.plan",
        label: "智谱视觉导演",
        available: true,
        kind: "external",
        billing: "subscription",
        defaultModelId: "glm-5.3-flash",
        modelProfiles: [{ id: "glm-5.3-flash", providerId: "glm-director", providerFamily: "zai-bigmodel", label: "GLM-5.3-Flash", description: "视觉导演模型", available: true, taskTypes: ["text"] }],
      }]}
      decisionPending={false}
      onDecision={async () => undefined}
      connectionHeartbeatAt="2026-08-30T10:00:43.000Z"
    />);

    expect(screen.getByRole("region", { name: "制作进度" })).toBeInTheDocument();
    expect(screen.getAllByText("策划定稿").length).toBeGreaterThan(0);
    expect(screen.getByText("1 / 4 个步骤完成")).toBeInTheDocument();
    expect(screen.getByText("7 秒")).toBeInTheDocument();
    expect(screen.getByText("当前步骤")).toBeInTheDocument();
    expect(screen.getByText("正在统一叙事节奏、镜头语法与视觉规则")).toBeInTheDocument();
    expect(screen.getByText("暂无法估算剩余时间；已处理 42 秒")).toBeInTheDocument();
    expect(screen.getByText(/智谱视觉导演 · GLM-5.3-Flash/)).toBeInTheDocument();
    expect(screen.queryByText(/glm-5\.3-flash/)).not.toBeInTheDocument();
    expect(screen.getByText("制作服务连接刚刚确认")).toBeInTheDocument();
  });

  it("uses the observable active node instead of a stale summary node", () => {
    const { activeIntervention: _activeIntervention, videoArtifactId: _videoArtifactId, ...withoutReview } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutReview,
        status: "running",
        currentNodeId: "final-review",
        progress: {
          completedNodes: 2,
          totalNodes: 4,
          percentage: 50,
          elapsedSeconds: 60,
          currentNodeElapsedSeconds: 20,
          lastUpdatedAt: "2026-08-31T10:00:20.000Z",
          etaUnavailableReason: "insufficient_history",
        },
        currentAction: { nodeId: "visual-direction", role: "导演", label: "正在统一叙事节奏、镜头语法与视觉规则" },
        nodes: withoutReview.nodes.map((node) => node.id === "visual-direction" ? { ...node, status: "running" } : node),
        artifacts: [],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    expect(screen.getByRole("heading", { name: "导演正在处理导演方案" })).toBeInTheDocument();
    expect(screen.getByText("20 秒")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /人工终审/ })).not.toBeInTheDocument();
  });

  it("explains a failed node without hiding its impact or preserved output", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        failure: {
          nodeId: "voice",
          nodeLabel: "配音",
          category: "provider_capacity",
          summary: "MiniMax Speech 当前请求过多，配音没有生成完成",
          impact: "脚本与导演方案已保留；渲染尚未开始。",
          retryable: true,
          recoveryActions: ["稍后重试配音", "连续失败时切换同类声音服务"],
          savedNodeCount: 4,
          technicalDetail: "HTTP 429 rate limit exceeded",
        },
        resultAvailability: { kind: "none", usable: false, label: "尚未生成成片", detail: "渲染尚未完成。" },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "voice", label: "配音", status: "failed" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRetryFailedNode={async () => undefined}
    />);

    expect(screen.getByRole("heading", { name: "配音没有完成" })).toBeInTheDocument();
    expect(screen.getByText("MiniMax Speech 当前请求过多，配音没有生成完成")).toBeInTheDocument();
    expect(screen.getByText(/脚本与导演方案已保留/)).toBeInTheDocument();
    expect(screen.getByText("稍后重试配音")).toBeInTheDocument();
    expect(screen.getByText("已保留前面 4 个步骤的结果")).toBeInTheDocument();
    expect(screen.queryByText("HTTP 429 rate limit exceeded")).not.toBeInTheDocument();
    expect(screen.queryByText("技术诊断")).not.toBeInTheDocument();
  });

  it("shows the real visual-review failure reason and a retry action", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        failure: {
          nodeId: "visual-review",
          nodeLabel: "视觉审片",
          category: "node_failure",
          summary: "视觉审片员没有完成视觉审片",
          impact: "成片已保留。",
          retryable: true,
          recoveryActions: ["选择可用模型后重试"],
          savedNodeCount: 8,
          technicalDetail: "上游视觉模型返回空结果",
        },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "visual-review", label: "视觉审片", status: "failed" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRetryFailedNode={async () => undefined}
    />);

    expect(screen.getByText((_, element) => element?.textContent === "失败原因：上游视觉模型返回空结果")).toBeVisible();
    expect(screen.getByRole("button", { name: "重试视觉审片" })).toBeInTheDocument();
  });

  it("keeps the creative goal visible while reviewing the finished video", () => {
    render(<RunWorkbench
      run={{
        ...runDetail,
        creativeSummary: {
          audience: "想核验热点的普通观众",
          openingPromise: "先比较标题证据，不猜传播链",
          requiredVisual: "两条真实标题的措辞差异可以直接并列核对。",
          payoff: "让观众能区分传闻和已证实信息",
        },
      }}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    const creativeSummary = screen.getByRole("region", { name: "创作目标摘要" });
    expect(within(creativeSummary).getByText("想核验热点的普通观众")).toBeInTheDocument();
    expect(within(creativeSummary).getByText("让观众能区分传闻和已证实信息")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "成片预览" }).compareDocumentPosition(creativeSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows a source-asset review failure reason on the main failure panel", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reason = "源素材视觉预检服务暂时不可用。已保留生成结果，请切换视觉审片模型。";
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        failure: {
          nodeId: "assets",
          nodeLabel: "画面",
          category: "node_failure",
          summary: "生成画面的视觉预检没有完成，已保留本轮画面结果",
          impact: "配音尚未开始。",
          retryable: true,
          recoveryActions: ["在画面步骤切换视觉审片服务或模型后重试"],
          savedNodeCount: 3,
          technicalDetail: reason,
        },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "assets", label: "画面", status: "failed" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    expect(screen.getByText("结论")).toBeVisible();
    expect(screen.getByText("源素材视觉预检服务暂时不可用。")).toBeVisible();
    expect(screen.getByText("已保留生成结果，请切换视觉审片模型。")).toBeVisible();
  });

  it("turns a multi-scene source review rejection into a creator action list", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const technicalDetail = "源素材视觉预检未通过，系统已在配音和渲染前停止。主体与导演方案不一致。镜头 4：画面出现大段模型水印。 镜头 6：人物动作与旁白相反。 请调整导演方案或画面 Provider，重新报价并确认后再生成。";
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        failure: {
          nodeId: "asset-source-review",
          nodeLabel: "生成画面预检",
          category: "node_failure",
          summary: "生成画面未达到成片标准，后续制作没有继续",
          impact: "脚本、导演方案和已生成画面都已保留；配音与渲染尚未开始。",
          retryable: true,
          recoveryActions: ["按逐镜问题修改画面方案", "重新报价并确认后再生成"],
          savedNodeCount: 6,
          technicalDetail,
        },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "asset-source-review", label: "生成画面预检", status: "failed" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={() => undefined}
    />);

    expect(screen.getByRole("heading", { name: "画面预检未通过" })).toBeInTheDocument();
    expect(screen.getByText("结论")).toBeInTheDocument();
    expect(screen.getByText("逐镜问题")).toBeInTheDocument();
    expect(screen.getByText("主体与导演方案不一致。")).toBeInTheDocument();
    expect(screen.getByText("镜头 4：画面出现大段模型水印。")).toBeInTheDocument();
    expect(screen.getByText("镜头 6：人物动作与旁白相反。")).toBeInTheDocument();
    expect(screen.getByText("已保留的内容")).toBeInTheDocument();
    expect(screen.getByText("下一步")).toBeInTheDocument();
    expect(screen.getByText("请调整导演方案或画面服务，重新报价并确认后再生成。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调整方案后重新制作" })).toBeInTheDocument();
    expect(screen.queryByText(technicalDetail)).not.toBeInTheDocument();
  });

  it("shows an in-node pilot rejection as a safe visual stop", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const retry = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "rejected",
        failure: {
          nodeId: "assets",
          nodeLabel: "画面",
          category: "node_failure",
          summary: "画面审查已完成并发现问题，已保留素材与修改建议",
          impact: "试片和前序方案已保留；后续付费画面尚未生成。",
          retryable: true,
          recoveryActions: ["查看具体镜头的问题与修改建议", "先调整导演方案或替换已有素材；只有确需新生成时才重新报价"],
          savedNodeCount: 5,
          technicalDetail: "镜头 2 试片未通过，已停止后续付费生成。人物动作与旁白相反。",
        },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "assets", label: "画面", status: "rejected" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRetryFailedNode={retry}
      onRestart={() => undefined}
    />);

    expect(screen.getByRole("heading", { name: "画面预检未通过" })).toBeInTheDocument();
    expect(screen.getByText("已保留的内容")).toBeInTheDocument();
    expect(screen.getByText("先调整导演方案或替换已有素材；只有确需新生成时才重新报价")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新检查已有试片" })).toBeInTheDocument();
  });

  it("shows an explicit regenerate action instead of pretending a stale run is active", async () => {
    const regenerate = vi.fn(async () => undefined);
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const { videoArtifactId: _videoArtifactId, ...withoutVideo } = withoutIntervention;
    render(<RunWorkbench
      run={{
        ...withoutVideo,
        status: "stale",
        artifacts: withoutIntervention.artifacts.filter((artifact) => artifact.id !== withoutIntervention.videoArtifactId),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRegenerateStale={regenerate}
    />);

    expect(screen.queryByText("自动制作中")).not.toBeInTheDocument();
    expect(screen.getByText(/上游内容已被人工修改/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按人工版本继续生成" }));
    expect(regenerate).toHaveBeenCalledOnce();
  });

  it("does not offer a blind retry when the failure requires configuration repair", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        failure: {
          nodeId: "voice",
          nodeLabel: "配音",
          category: "configuration",
          summary: "MiniMax Speech 的账号、密钥或权限配置不可用",
          impact: "脚本与导演方案已保留；渲染尚未开始。",
          retryable: false,
          recoveryActions: ["到创作设置检查对应服务的密钥与权限"],
          savedNodeCount: 4,
          technicalDetail: "HTTP 401 unauthorized",
        },
        nodes: withoutIntervention.nodes.map((node, index) => index === 0 ? { ...node, id: "voice", label: "配音", status: "failed" } : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRetryFailedNode={vi.fn()}
      onRestart={vi.fn()}
    />);

    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "调整方案后重新制作" })).toBeInTheDocument();
  });

  it("offers an approved production as the source of a new version", async () => {
    const restart = vi.fn();
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{ ...withoutIntervention, status: "succeeded" }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={restart}
    />);

    await userEvent.click(screen.getByRole("button", { name: "基于这版重新制作" }));
    expect(restart).toHaveBeenCalledOnce();
  });

  it("shows paid task evidence and reconciles it instead of offering a blind retry", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        recommendedOutcome: "resume_original",
        requiresManualReconciliation: false,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-1",
          quoteItemId: "scene-1",
          scenePosition: 1,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedream-image-v1",
          modelId: "seedream-image-v1",
          state: "submitted",
          estimatedCostCny: 2.4,
          taskId: "provider-task-1",
          actualCostCny: 2.4,
          actualCostSource: "configured_rate",
        }],
      }}
      providers={[{
        id: "seedream-image-v1",
        capability: "asset.prepare",
        label: "Seedream 关键画面",
        available: true,
        kind: "external",
        billing: "metered",
        status: "ready",
        description: "关键画面",
        modes: ["文生图"],
      }]}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={vi.fn()}
      onRetryFailedNode={vi.fn()}
      onReconcilePaidNode={reconcile}
    />);

    expect(screen.getByText("Seedream")).toBeInTheDocument();
    expect(screen.queryByText(/seedream-image-v1/)).not.toBeInTheDocument();
    expect(screen.getByText(/provider-task-1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整方案后重新制作" })).not.toBeInTheDocument();
    expect(screen.getByText("已找到可恢复的付费任务")).toBeInTheDocument();
    expect(screen.getByText(/不会创建新任务或新增报价/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "继续获取原任务结果" }));
    expect(reconcile).toHaveBeenCalledWith("assets", { outcome: "resume_original" });
  });

  it("lets manual reconciliation attach a provider task id without exposing a retry action", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        requiresManualReconciliation: true,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-1",
          quoteItemId: "scene-1",
          scenePosition: 1,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "unknown",
          estimatedCostCny: 2.4,
        }],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={vi.fn()}
      onRetryFailedNode={vi.fn()}
      onReconcilePaidNode={reconcile}
    />);

    expect(screen.getByText("这次请求是否扣费还不确定")).toBeInTheDocument();
    expect(screen.getByText("尚无服务商任务编号")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整方案后重新制作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续获取原任务结果" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("服务商任务编号"), "provider-task-recovered");
    await userEvent.click(screen.getByRole("button", { name: "录入编号并继续查询原任务" }));
    expect(reconcile).toHaveBeenCalledWith("assets", {
      outcome: "resume_original",
      taskId: "provider-task-recovered",
    });
  });

  it("requires an audited confirmation before recording a charged manual outcome", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        requiresManualReconciliation: true,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-2",
          quoteItemId: "scene-2",
          scenePosition: 2,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "unknown",
          estimatedCostCny: 2.4,
        }, {
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-3",
          quoteItemId: "scene-3",
          scenePosition: 3,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "submitted",
          estimatedCostCny: 2.4,
        }],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={vi.fn()}
      onRetryFailedNode={vi.fn()}
      onReconcilePaidNode={reconcile}
    />);

    await userEvent.click(screen.getByRole("radio", { name: "已扣费 · 计入已记录费用" }));
    await userEvent.selectOptions(screen.getByLabelText("本次核对镜头"), "paid-scene-3");
    await userEvent.type(screen.getByLabelText("实际费用（可选）"), "2.40");
    await userEvent.type(screen.getByLabelText("核对记录"), "已在服务商控制台核实账单。 ");
    const submit = screen.getByRole("button", { name: "确认已扣费：计入已记录费用" });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /我确认已在服务商控制台核对/ }));
    await userEvent.click(submit);

    expect(reconcile).toHaveBeenCalledWith("assets", {
      outcome: "confirmed_charged",
      itemRequestId: "paid-scene-3",
      actualCostCny: 2.4,
      note: "已在服务商控制台核实账单。",
    });
  });

  it("offers a clickable provider console entry for manual paid reconciliation", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        requiresManualReconciliation: true,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-1",
          quoteItemId: "scene-1",
          scenePosition: 1,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "unknown",
          estimatedCostCny: 2.4,
        }],
      }}
      providers={[{
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "火山方舟视频",
        available: true,
        kind: "external",
        billing: "metered",
        consoleUrl: "https://console.volcengine.com/ark",
      }]}
      decisionPending={false}
      onDecision={async () => undefined}
      onReconcilePaidNode={vi.fn(async () => undefined)}
    />);

    const consoleLink = screen.getByRole("link", { name: "打开火山方舟视频控制台" });
    expect(consoleLink).toHaveAttribute("href", "https://console.volcengine.com/ark");
    expect(consoleLink).toHaveAttribute("target", "_blank");
    expect(screen.queryByText(/请联系管理员核对/)).not.toBeInTheDocument();
  });

  it("asks the creator to contact an admin instead of an empty link when no console entry exists", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        requiresManualReconciliation: true,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-1",
          quoteItemId: "scene-1",
          scenePosition: 1,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "unknown",
          estimatedCostCny: 2.4,
        }],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onReconcilePaidNode={vi.fn(async () => undefined)}
    />);

    expect(screen.getByText(/请联系管理员核对任务与账单/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /控制台/ })).not.toBeInTheDocument();
  });

  it("labels the active provider through the model catalog instead of a raw model id", () => {
    const { activeIntervention: _activeIntervention, videoArtifactId: _videoArtifactId, ...withoutReview } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutReview,
        status: "running",
        currentNodeId: "visual-direction",
        currentAction: { nodeId: "visual-direction", role: "导演", label: "正在统一叙事节奏、镜头语法与视觉规则" },
        nodes: withoutReview.nodes.map((node) => node.id === "visual-direction" ? {
          ...node,
          status: "running",
          executionReceipt: {
            providerId: "api-visual-director-v1",
            providerLabel: "AI 视觉导演",
            modelId: "internal-director-model-x",
            transport: "unix_socket",
            billing: "subscription",
            status: "failed",
            startedAt: "2026-08-21T10:00:00.000Z",
            finishedAt: "2026-08-21T10:00:05.000Z",
          },
        } : node),
        artifacts: [],
      }}
      providers={providers}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    expect(screen.getByText("当前能力：AI 视觉导演 · 模型名称未记录")).toBeInTheDocument();
    expect(screen.queryByText(/internal-director-model-x/)).not.toBeInTheDocument();
  });

  it("keeps the internal record revision out of the creator-facing run header", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench run={withoutIntervention} decisionPending={false} onDecision={async () => undefined} />);

    expect(screen.getByText(/抖音 · 目标 24 秒/)).toBeInTheDocument();
    expect(screen.queryByText(/版本\s*3/)).not.toBeInTheDocument();
  });

  it("explains that requoting only covers failed or unstarted paid scenes", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "assets",
        operationId: "paid-operation-1",
        recommendedOutcome: "requote",
        requiresManualReconciliation: false,
        items: [{
          operationId: "paid-operation-1",
          itemRequestId: "paid-scene-2",
          quoteItemId: "scene-2",
          scenePosition: 2,
          executorProviderId: "ai-shot-router-v1",
          providerId: "seedance-video-v1",
          modelId: "seedance-v1",
          state: "terminal_failed",
          estimatedCostCny: 2.4,
        }],
      }}
      providers={[{
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "Seedance 视频生成",
        available: true,
        kind: "external",
        billing: "metered",
        defaultModelId: "seedance-v1",
        modelProfiles: [{ id: "seedance-v1", providerId: "seedance-video-v1", providerFamily: "seedance", label: "Seedance 1", description: "视频生成", available: true, taskTypes: ["text-to-video"] }],
      }]}
      decisionPending={false}
      onDecision={async () => undefined}
      onReconcilePaidNode={reconcile}
    />);

    expect(screen.getByText("Seedance · Seedance 1")).toBeInTheDocument();
    expect(screen.getByText(/只会重新计算明确失败或尚未提交的镜头/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "为未完成镜头重新报价" }));
    expect(reconcile).toHaveBeenCalledWith("assets", { outcome: "requote" });
  });

  it("carries a rejected quote through director replanning to a cheaper quote and fresh approval", async () => {
    vi.stubGlobal("EventSource", class {
      addEventListener() { /* 本用例只验证页面发出的写操作，不模拟实时推送。 */ }
      close() { /* 页面卸载时允许正常关闭测试连接。 */ }
    });
    const quoteNode = (planId: string, estimatedCostCny: number, directorVersionId: string) => ({
      id: "assets",
      label: "画面",
      role: "素材导演",
      status: "awaiting_spend_approval" as const,
      artifactIds: [],
      qualityGateResults: [],
      inputState: {
        effectiveVersionId: `assets-input-${planId}`,
        stale: false,
        versions: [{
          id: `assets-input-${planId}`,
          source: "derived" as const,
          value: { directorPlan: { versionId: directorVersionId } },
          upstreamVersionIds: [directorVersionId],
          createdAt: "2026-09-04T01:00:00.000Z",
          createdBy: "workflow-runner",
          schemaVersion: "assets-input-v1",
        }],
      },
      spendPlan: {
        id: planId,
        inputVersionIds: [directorVersionId],
        providerId: "ai-shot-router-v1",
        modelId: "seedance-v1",
        estimatedCostCny,
        maxCostCny: estimatedCostCny,
        maxAttempts: 1,
        items: [{ id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny }],
        createdAt: "2026-09-04T01:00:00.000Z",
      },
    });
    const { activeIntervention: _activeIntervention, videoArtifactId: _videoArtifactId, ...baseRun } = runDetail;
    const initialRun: StudioRunDetail = {
      ...baseRun,
      revision: 10,
      status: "awaiting_spend_approval",
      currentNodeId: "assets",
      productionPlanDigest: "a".repeat(64),
      nodes: [
        { id: "visual-direction", label: "导演方案", role: "导演", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { costIntent: "保持效果" } },
        quoteNode("quote-high", 8.4, "director-v1"),
      ],
      artifacts: [],
      decisions: [],
    };
    const { spendPlan: _oldSpendPlan, ...staleAssetNode } = quoteNode("quote-high", 8.4, "director-v1");
    const staleRun: StudioRunDetail = {
      ...initialRun,
      revision: 11,
      status: "stale",
      currentNodeId: "visual-direction",
      nodes: [
        {
          id: "visual-direction",
          label: "导演方案",
          role: "导演",
          status: "stale",
          artifactIds: [],
          qualityGateResults: [],
          inputState: {
            effectiveVersionId: "director-replan-input",
            stale: false,
            versions: [{
              id: "director-replan-input",
              source: "derived",
              value: { costFeedback: { reason: "too_expensive", targetEstimatedCostCny: 3, note: "只保留一个关键生成镜头，其余使用图库。" } },
              upstreamVersionIds: [],
              createdAt: "2026-09-04T01:01:00.000Z",
              createdBy: "workflow-runner",
              schemaVersion: "director-input-v1",
            }],
          },
        },
        { ...staleAssetNode, status: "stale" },
      ],
    };
    const cheaperQuoteRun: StudioRunDetail = {
      ...initialRun,
      revision: 12,
      nodes: [
        { id: "visual-direction", label: "导演方案", role: "导演", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { costIntent: "只保留一个关键生成镜头，其余使用图库" } },
        quoteNode("quote-lower", 2.4, "director-v2"),
      ],
    };
    const runningRun: StudioRunDetail = {
      ...cheaperQuoteRun,
      revision: 13,
      status: "running",
      nodes: cheaperQuoteRun.nodes.map((node) => node.id === "assets" ? { ...node, status: "running", spendAuthorizationId: "approval-lower" } : node),
    };
    vi.spyOn(studioApi, "run").mockResolvedValue(initialRun);
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: initialRun.id,
      title: initialRun.title,
      totals: { estimatedCostCny: 8.4, authorizedCostCny: 0, actualCostCny: 0, actualPendingCount: 0, meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0 },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue([{
      id: "seedance-video-v1",
      capability: "asset.prepare",
      label: "Seedance 视频生成",
      available: true,
      kind: "external",
      billing: "metered",
      defaultModelId: "seedance-v1",
      modelProfiles: [{ id: "seedance-v1", providerId: "seedance-video-v1", providerFamily: "seedance", label: "Seedance 1", description: "视频生成", available: true, taskTypes: ["text-to-video"] }],
    }]);
    const reject = vi.spyOn(studioApi, "rejectSpend").mockResolvedValue(staleRun);
    const replan = vi.spyOn(studioApi, "regenerateStale").mockResolvedValue(cheaperQuoteRun);
    const authorize = vi.spyOn(studioApi, "authorizeSpend").mockResolvedValue(runningRun);

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByText("预计 ¥8.40，最高 ¥8.40 · 最多 1 次")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "这份报价不合适" }));
    const rejectionDialog = screen.getByRole("dialog", { name: "保存费用反馈" });
    await userEvent.type(within(rejectionDialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }), "8.4");
    await userEvent.click(within(rejectionDialog).getByRole("button", { name: "保存反馈" }));
    expect(screen.getByRole("alert")).toHaveTextContent("下一版降本目标必须低于当前报价 ¥8.40");
    expect(reject).not.toHaveBeenCalled();
    await userEvent.clear(within(rejectionDialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }));
    await userEvent.type(within(rejectionDialog).getByRole("spinbutton", { name: "下一版降本目标（可选）" }), "3");
    await userEvent.type(within(rejectionDialog).getByRole("textbox", { name: "具体调整意见（可选）" }), "只保留一个关键生成镜头，其余使用图库。");
    await userEvent.click(within(rejectionDialog).getByRole("button", { name: "保存反馈" }));

    expect(reject).toHaveBeenCalledWith("run-1", "assets", {
      spendPlanId: "quote-high",
      reason: "too_expensive",
      targetEstimatedCostCny: 3,
      note: "只保留一个关键生成镜头，其余使用图库。",
    });
    expect(await screen.findByText(/降本意见已经保存/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按降本意见重新规划并报价" }));
    expect(replan).toHaveBeenCalledWith("run-1");

    expect(await screen.findByText("预计 ¥2.40，最高 ¥2.40 · 最多 1 次")).toBeInTheDocument();
    // C2：确认面板走制作范围授权（服务端报价→授权→自动继续），不再弹逐项确认对话框。
    const quoteSpy = vi.spyOn(studioApi, "prepareProductionQuote").mockResolvedValue({
      quoteId: "quote-c2-1",
      acceptedPlanDigest: "a".repeat(64),
      estimatedCostCny: 2.4,
      maximumCostCny: 2.4,
      scopeSummary: { content: "镜头 1", assets: [], uncertainty: [] },
      feasible: true,
    });
    const scopeAuthSpy = vi.spyOn(studioApi, "authorizeProductionScope").mockResolvedValue(cheaperQuoteRun);
    // 第一阶段只取报价；授权必须等用户看到服务端金额后第二次点击。
    await userEvent.click(screen.getByRole("button", { name: /获取费用报价/ }));
    await waitFor(() => {
      expect(quoteSpy).toHaveBeenCalledWith("run-1", { expectedRunRevision: 12, acceptedPlanDigest: "a".repeat(64) });
      expect(scopeAuthSpy).not.toHaveBeenCalled();
    });
    await userEvent.click(await screen.findByRole("button", { name: /确认并授权（最高 ¥2.40）/ }));
    await waitFor(() => {
      expect(scopeAuthSpy).toHaveBeenCalledWith("run-1", {
        expectedRunRevision: 12,
        quoteId: "quote-c2-1",
        acceptedPlanDigest: "a".repeat(64),
        idempotencyKey: "scope-run-1-quote-c2-1",
      });
    });
    vi.unstubAllGlobals();
  });

  it("loads and reconciles paid task evidence from the run page with the current revision", async () => {
    const { activeIntervention: _activeIntervention, ...runWithoutIntervention } = runDetail;
    const uncertainRun: StudioRunDetail = {
      ...runWithoutIntervention,
      status: "failed",
      nodes: runDetail.nodes.map((node, index) => index === 0
        ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
        : node),
    };
    vi.spyOn(studioApi, "run").mockResolvedValue(uncertainRun);
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: uncertainRun.id,
      title: uncertainRun.title,
      totals: {
        estimatedCostCny: 2.4,
        authorizedCostCny: 2.4,
        actualCostCny: 2.4,
        actualPendingCount: 0,
        meteredCalls: 1,
        subscriptionCalls: 0,
        freeCalls: 0,
        failedMeteredCalls: 0,
      },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "paidOperation").mockResolvedValue({
      nodeId: "assets",
      operationId: "paid-operation-1",
      recommendedOutcome: "resume_original",
      requiresManualReconciliation: false,
      items: [{
        operationId: "paid-operation-1",
        itemRequestId: "paid-scene-1",
        quoteItemId: "scene-1",
        scenePosition: 1,
        executorProviderId: "ai-shot-router-v1",
        providerId: "seedance-video-v1",
        modelId: "seedance-v1",
        state: "submitted",
        estimatedCostCny: 2.4,
        taskId: "provider-task-1",
      }],
    });
    const reconcile = vi.spyOn(studioApi, "reconcilePaidOperation").mockResolvedValue({ ...uncertainRun, revision: 4 });

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "继续获取原任务结果" }));
    expect(reconcile).toHaveBeenCalledWith("run-1", "assets", {
      expectedRunRevision: 3,
      reconciliationId: expect.any(String),
      outcome: "resume_original",
    });
  });

  it("shows legacy paid failures as settlement-only and never retries after charge settlement", async () => {
    const { activeIntervention: _activeIntervention, ...runWithoutIntervention } = runDetail;
    const legacyVoiceRun: StudioRunDetail = {
      ...runWithoutIntervention,
      continuation: { supported: false, reason: "这条制作来自旧版工作流，只能查看现有结果。" },
      status: "failed",
      nodes: runDetail.nodes.map((node, index) => index === 0
        ? { ...node, id: "voice", label: "配音", status: "failed", outcomeUncertain: true }
        : node),
    };
    vi.spyOn(studioApi, "run").mockResolvedValue(legacyVoiceRun);
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: legacyVoiceRun.id,
      title: legacyVoiceRun.title,
      totals: {
        estimatedCostCny: 0.5,
        authorizedCostCny: 0.5,
        actualCostCny: 0,
        actualPendingCount: 1,
        meteredCalls: 1,
        subscriptionCalls: 0,
        freeCalls: 0,
        failedMeteredCalls: 1,
      },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "paidOperation").mockResolvedValue({
      nodeId: "voice",
      failureKind: "unknown_outcome",
      recommendedOutcome: "resume_original",
      requiresManualReconciliation: true,
      items: [],
    });
    const reconcile = vi.spyOn(studioApi, "reconcilePaidOperation").mockResolvedValue({ ...legacyVoiceRun, revision: 4 });
    const retry = vi.spyOn(studioApi, "retryFailedNode");

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByText("这条旧版制作仅供查看")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续获取原任务结果" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "为未完成镜头重新报价" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("radio", { name: /已扣费/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "核对记录" }), "Provider 控制台确认旧任务已扣费。");
    await userEvent.click(screen.getByRole("checkbox", { name: /我确认已在服务商控制台核对/ }));
    await userEvent.click(screen.getByRole("button", { name: "确认已扣费：计入已记录费用" }));

    expect(reconcile).toHaveBeenCalledWith("run-1", "voice", expect.objectContaining({
      expectedRunRevision: 3,
      outcome: "confirmed_charged",
      note: "Provider 控制台确认旧任务已扣费。",
    }));
    expect(retry).not.toHaveBeenCalled();
  });

  it("reuses the latest authoritative revision and reconciliation id after an uncertain network response", async () => {
    const { activeIntervention: _activeIntervention, ...runWithoutIntervention } = runDetail;
    const uncertainRun: StudioRunDetail = {
      ...runWithoutIntervention,
      status: "failed",
      nodes: runDetail.nodes.map((node, index) => index === 0
        ? { ...node, id: "assets", label: "素材", status: "failed", outcomeUncertain: true }
        : node),
    };
    const newerRun = { ...uncertainRun, revision: 4 };
    const runRequest = vi.spyOn(studioApi, "run")
      .mockResolvedValueOnce(uncertainRun)
      .mockResolvedValue(newerRun);
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: uncertainRun.id,
      title: uncertainRun.title,
      totals: {
        estimatedCostCny: 2.4,
        authorizedCostCny: 2.4,
        actualCostCny: 0,
        actualPendingCount: 1,
        meteredCalls: 1,
        subscriptionCalls: 0,
        freeCalls: 0,
        failedMeteredCalls: 1,
      },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "paidOperation").mockResolvedValue({
      nodeId: "assets",
      operationId: "paid-operation-1",
      recommendedOutcome: "resume_original",
      requiresManualReconciliation: false,
      items: [{
        operationId: "paid-operation-1",
        itemRequestId: "paid-scene-1",
        quoteItemId: "scene-1",
        scenePosition: 1,
        executorProviderId: "ai-shot-router-v1",
        providerId: "seedance-video-v1",
        modelId: "seedance-v1",
        state: "submitted",
        estimatedCostCny: 2.4,
        taskId: "provider-task-1",
      }],
    });
    let rejectFirst!: (reason: Error) => void;
    const firstRequest = new Promise<StudioRunDetail>((_resolve, reject) => { rejectFirst = reject; });
    const reconcile = vi.spyOn(studioApi, "reconcilePaidOperation")
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValue(newerRun);
    runRequest.mockClear();
    reconcile.mockClear();

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    await userEvent.click(await screen.findByRole("button", { name: "继续获取原任务结果" }));
    await waitFor(() => expect(runRequest).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    rejectFirst(new Error("response lost after submission"));
    await screen.findByText("response lost after submission");
    await userEvent.click(screen.getByRole("button", { name: "继续获取原任务结果" }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));

    const firstInput = reconcile.mock.calls[0]?.[2];
    const secondInput = reconcile.mock.calls[1]?.[2];
    expect(firstInput?.expectedRunRevision).toBe(4);
    expect(secondInput?.expectedRunRevision).toBe(4);
    expect(secondInput?.reconciliationId).toBe(firstInput?.reconciliationId);
  });

  it("starts a new reconciliation when automatic TTS becomes uncertain again", async () => {
    const { activeIntervention: _activeIntervention, ...runWithoutIntervention } = runDetail;
    const voiceRun = (revision: number): StudioRunDetail => ({
      ...runWithoutIntervention,
      revision,
      status: "failed",
      nodes: runDetail.nodes.map((node, index) => index === 0
        ? { ...node, id: "voice", label: "配音", status: "failed", outcomeUncertain: true }
        : node),
    });
    vi.spyOn(studioApi, "run").mockResolvedValue(voiceRun(3));
    vi.spyOn(studioApi, "runCosts").mockResolvedValue({
      runId: runDetail.id,
      title: runDetail.title,
      totals: {
        estimatedCostCny: 0.5,
        authorizedCostCny: 0.5,
        actualCostCny: 0,
        actualPendingCount: 1,
        meteredCalls: 1,
        subscriptionCalls: 0,
        freeCalls: 0,
        failedMeteredCalls: 1,
      },
      lines: [],
    });
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "paidOperation").mockResolvedValue({
      nodeId: "voice",
      failureKind: "unknown_outcome",
      requiresManualReconciliation: true,
      items: [],
    });
    const reconcile = vi.spyOn(studioApi, "reconcilePaidOperation").mockResolvedValueOnce(voiceRun(4));
    const retry = vi.spyOn(studioApi, "retryFailedNode").mockResolvedValueOnce({
      ...voiceRun(5),
      nodes: voiceRun(5).nodes.map((node) => node.id === "voice" ? { ...node, outcomeUncertain: false } : node),
    });
    reconcile.mockClear();
    retry.mockClear();

    render(<MemoryRouter initialEntries={["/projects/run-1"]}>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>);

    expect(await screen.findByText("配音连接中断")).toBeInTheDocument();
    expect(screen.getByText(/按原预估费用计入已记录费用/)).toBeInTheDocument();
    expect(screen.getByText(/再创建一条新的配音任务/)).toBeInTheDocument();
    expect(screen.queryByText("0 个镜头")).not.toBeInTheDocument();
    expect(screen.queryByText(/按 taskId 核对/)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "未扣费" })).not.toBeInTheDocument();

    expect(screen.getByText("按预估费用保守记账")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按预估记账并重新配音" }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("run-1", "voice"));
    expect(reconcile.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      expectedRunRevision: 3,
      outcome: "confirmed_charged",
    }));
  });

  it("does not record a charge when the voice provider explicitly rejects the request", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn().mockResolvedValue(undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "voice", label: "配音", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "voice",
        failureKind: "terminal_failure",
        requiresManualReconciliation: true,
        items: [],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onReconcilePaidNode={reconcile}
    />);

    expect(screen.getByText("配音请求被明确拒绝")).toBeInTheDocument();
    expect(screen.getByText("未扣费 · 不计入已记录费用")).toBeInTheDocument();
    expect(screen.getByText(/不会自动再次调用/)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "已扣费" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按零费用结清并调整配音" }));
    expect(reconcile).toHaveBeenCalledWith("voice", expect.objectContaining({ outcome: "confirmed_not_charged" }));
  });

  it("keeps legacy voice failures out of the asset reconciliation form", async () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    const reconcile = vi.fn().mockResolvedValue(undefined);
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, id: "voice", label: "配音", status: "failed", outcomeUncertain: true }
          : node),
      }}
      paidNodeSummary={{
        nodeId: "voice",
        failureKind: "missing_evidence",
        requiresManualReconciliation: true,
        items: [],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onReconcilePaidNode={reconcile}
    />);

    expect(screen.getByText("配音结果无法确认")).toBeInTheDocument();
    expect(screen.getByText("按预估费用保守记账")).toBeInTheDocument();
    expect(screen.queryByText("服务商账单核对结果")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按预估记账并重新配音" }));
    expect(reconcile).toHaveBeenCalledWith("voice", expect.objectContaining({ outcome: "confirmed_charged" }));
  });
});

describe("joint-v1 planning stages panel (B4)", () => {
  const jointProviders: StudioProvider[] = [
    ...providers,
    {
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "AI 编剧",
      available: true,
      kind: "external",
      defaultModelId: "screenwriter-model-one",
      modelProfiles: [
        { id: "screenwriter-model-one", label: "编剧一号", providerId: "codex-screenwriter-v1", providerFamily: "openai", available: true, description: "首选", taskTypes: ["text"] },
        { id: "screenwriter-model-two", label: "编剧二号", providerId: "codex-screenwriter-v1", providerFamily: "openai", available: true, description: "备选", taskTypes: ["text"] },
      ],
    },
    {
      id: "codex-creative-treatment-v1",
      capability: "creative.treatment",
      label: "AI 前期构思",
      available: true,
      kind: "external",
      defaultModelId: "treatment-model-a",
      modelProfiles: [
        { id: "treatment-model-a", label: "构思一号", providerId: "codex-creative-treatment-v1", providerFamily: "openai", available: true, description: "首选", taskTypes: ["text"] },
        { id: "treatment-model-b", label: "构思二号", providerId: "codex-creative-treatment-v1", providerFamily: "zai-bigmodel", available: true, description: "备选", taskTypes: ["text"] },
      ],
    },
  ];

  const jointRun: StudioRunDetail = {
    ...runDetail,
    nodes: [
      { id: "brief", label: "需求校验", role: "制片人", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { title: "做决定前，先避开这 3 个坑" } },
      {
        id: "creative-planning",
        label: "创作规划",
        role: "创作规划制片",
        status: "succeeded",
        artifactIds: ["planning-script"],
        qualityGateResults: [],
        output: { scriptPath: "/managed/script.json", directorPlanPath: "/managed/director_plan.json", executablePlanPath: "/managed/executable_plan.json" },
        inputState: {
          effectiveVersionId: "input-v1",
          stale: false,
          versions: [{
            id: "input-v1",
            source: "derived",
            value: { brief: { title: "做决定前，先避开这 3 个坑", angle: "低风险清单", audience: "上班族" } },
            upstreamVersionIds: [],
            createdAt: "2026-08-21T10:00:05.000Z",
            createdBy: "workflow:creative-planning",
            schemaVersion: "1",
          }],
        },
      },
      { id: "final-review", label: "人工终审", role: "总导演", status: "needs_human", artifactIds: [], qualityGateResults: [] },
    ],
    artifacts: [
      { id: "planning-script", kind: "script", producerNodeId: "creative-planning", createdAt: "2026-08-21T10:00:10.000Z", contentType: "application/json", contentUrl: "/api/planning-script" },
      ...runDetail.artifacts,
    ],
    planningStages: [
      { id: "treatment", status: "completed", effectiveModelId: "treatment-model-a", artifactIds: [], allowedActions: ["edit_input", "change_model"] },
      { id: "script", status: "failed", effectiveModelId: "screenwriter-model-two", artifactIds: [], issue: "脚本三次修改仍未通过质量复核，需要人工调整要求。", allowedActions: ["edit_input", "change_model"] },
      { id: "director", status: "pending", artifactIds: [], allowedActions: ["edit_input", "change_model"] },
      { id: "compile", status: "pending", artifactIds: [], allowedActions: [] },
    ],
  };

  it("renders real planning stage status, current model, and readable issue text", () => {
    render(<RunWorkbench run={jointRun} providers={jointProviders} decisionPending={false} onDecision={async () => undefined} />);

    const panel = screen.getByLabelText("创作规划阶段");
    expect(within(panel).getByText("前期构思")).toBeInTheDocument();
    expect(within(panel).getByText("已完成")).toBeInTheDocument();
    expect(within(panel).getByText("treatment-model-a")).toBeInTheDocument();
    expect(within(panel).getByText("脚本")).toBeInTheDocument();
    expect(within(panel).getByText("未通过")).toBeInTheDocument();
    expect(within(panel).getByText(/脚本三次修改仍未通过质量复核/)).toBeInTheDocument();
    expect(within(panel).getByText("导演方案")).toBeInTheDocument();
    expect(within(panel).getAllByText("待开始").length).toBe(2);
    // 内部术语不进入用户文案。
    expect(within(panel).queryByText(/checkpoint|lease|audit exhausted|digest/i)).not.toBeInTheDocument();
  });

  it("submits stage-scoped model changes with planningStageId", async () => {
    const configure = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={jointRun}
      providers={jointProviders}
      decisionPending={false}
      onDecision={async () => undefined}
      onConfigureNode={configure}
    />);

    const panel = screen.getByLabelText("创作规划阶段");
    const treatmentModelSelect = within(panel).getByLabelText(/下次使用构思模型/);
    await userEvent.selectOptions(treatmentModelSelect, "treatment-model-b");
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole("button", { name: "保存模型" }));
    expect(configure).toHaveBeenCalledWith("creative-planning", {
      expectedRunRevision: 3,
      planningStageId: "treatment",
      modelSelections: { "codex-creative-treatment-v1": "treatment-model-b" },
    });
  });

  it("keeps a failed model save as a draft and blocks retrying the old effective model", async () => {
    const configure = vi.fn(async () => { throw new Error("模型保存冲突，请刷新后重试。"); });
    const retry = vi.fn(async () => undefined);
    const { activeIntervention: _activeIntervention, ...jointRunWithoutIntervention } = jointRun;
    const failedRun: StudioRunDetail = {
      ...jointRunWithoutIntervention,
      status: "failed",
      failure: {
        nodeId: "creative-planning",
        nodeLabel: "创作规划",
        category: "provider_timeout",
        summary: "脚本模型调用失败",
        impact: "构思已保留，脚本尚未完成。",
        retryable: true,
        recoveryActions: ["保存模型后重试"],
        savedNodeCount: 1,
      },
      nodes: jointRun.nodes.map((node) => node.id === "creative-planning"
        ? { ...node, status: "failed" as const }
        : node.id === "final-review"
          ? { ...node, status: "pending" as const }
          : node),
    };
    render(<RunWorkbench
      run={failedRun}
      providers={jointProviders}
      decisionPending={false}
      onDecision={async () => undefined}
      onConfigureNode={configure}
      onRetryFailedNode={retry}
    />);

    const panel = screen.getByLabelText("创作规划阶段");
    await userEvent.selectOptions(within(panel).getByLabelText(/下次使用构思模型/), "treatment-model-b");
    const retryButton = screen.getByRole("button", { name: "重试失败步骤" });
    expect(retryButton).toBeDisabled();
    expect(screen.getByText(/模型选择尚未保存/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "保存模型" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("模型保存冲突");
    expect(within(panel).getByText("treatment-model-a")).toBeInTheDocument();
    expect(retryButton).toBeDisabled();
    expect(retry).not.toHaveBeenCalled();
  });

  it("saves stage-scoped input edits with planningStageId", async () => {
    const overrideInput = vi.fn(async () => undefined);
    render(<RunWorkbench
      run={jointRun}
      providers={jointProviders}
      decisionPending={false}
      onDecision={async () => undefined}
      onOverrideNodeInput={overrideInput}
    />);

    const panel = screen.getByLabelText("创作规划阶段");
    const scriptStage = within(panel).getByText("脚本").closest("li")!;
    await userEvent.click(within(scriptStage as HTMLElement).getByRole("button", { name: /编辑这一阶段的输入/ }));
    await userEvent.click(screen.getByRole("button", { name: /保存人工输入/ }));
    await waitFor(() => {
      expect(overrideInput).toHaveBeenCalledWith("creative-planning", expect.objectContaining({
        planningStageId: "script",
        input: expect.objectContaining({ brief: expect.any(Object) }),
      }));
    });
  });
});

describe("planning stage model selection resolves the bound provider (B4-FIX)", () => {
  it("uses the stage's bound provider instead of the first provider with the capability", async () => {
    const twoWriterProviders: StudioProvider[] = [
      {
        id: "other-screenwriter-v1",
        capability: "script.draft",
        label: "另一位编剧",
        available: true,
        kind: "external",
        defaultModelId: "other-model-one",
        modelProfiles: [
          { id: "other-model-one", label: "其他一号", providerId: "other-screenwriter-v1", providerFamily: "openai", available: true, description: "不在绑定内", taskTypes: ["text"] },
        ],
      },
      {
        id: "codex-screenwriter-v1",
        capability: "script.draft",
        label: "AI 编剧",
        available: true,
        kind: "external",
        defaultModelId: "screenwriter-model-one",
        modelProfiles: [
          { id: "screenwriter-model-one", label: "编剧一号", providerId: "codex-screenwriter-v1", providerFamily: "openai", available: true, description: "首选", taskTypes: ["text"] },
          { id: "screenwriter-model-two", label: "编剧二号", providerId: "codex-screenwriter-v1", providerFamily: "openai", available: true, description: "备选", taskTypes: ["text"] },
        ],
      },
    ];
    const { activeIntervention: _omit, ...detailWithoutIntervention } = runDetail;
    const boundRun: StudioRunDetail = {
      ...detailWithoutIntervention,
      nodes: [
        { id: "brief", label: "需求校验", role: "制片人", status: "succeeded", artifactIds: [], qualityGateResults: [], output: { title: "标题" } },
        {
          id: "creative-planning",
          label: "创作规划",
          role: "创作规划制片",
          status: "needs_human",
          artifactIds: [],
          qualityGateResults: [],
          output: { scriptPath: "/managed/script.json", directorPlanPath: "/managed/director_plan.json", executablePlanPath: "/managed/executable_plan.json" },
        },
        { id: "final-review", label: "人工终审", role: "总导演", status: "pending", artifactIds: [], qualityGateResults: [] },
      ],
      artifacts: [],
      decisions: [],
      planningStages: [
        { id: "script", status: "completed", effectiveModelId: "screenwriter-model-one", providerId: "codex-screenwriter-v1", artifactIds: [], allowedActions: ["edit_input", "change_model"] },
      ],
    };
    const configure = vi.fn(async () => undefined);
    render(<RunWorkbench run={boundRun} providers={twoWriterProviders} decisionPending={false} onDecision={async () => undefined} onConfigureNode={configure} />);

    const panel = screen.getByLabelText("创作规划阶段");
    const select = within(panel).getByLabelText(/下次使用脚本模型/) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((option) => option.value);
    expect(optionValues).toEqual(["screenwriter-model-one", "screenwriter-model-two"]);
    await userEvent.selectOptions(select, "screenwriter-model-two");
    expect(configure).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole("button", { name: "保存模型" }));
    expect(configure).toHaveBeenCalledWith("creative-planning", {
      expectedRunRevision: 3,
      planningStageId: "script",
      modelSelections: { "codex-screenwriter-v1": "screenwriter-model-two" },
    });
  });
});
