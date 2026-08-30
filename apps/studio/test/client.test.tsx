import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewRunDialog } from "../src/client/components/NewRunDialog.js";
import { VoiceStudio } from "../src/client/components/VoiceStudio.js";
import { studioApi, subscribeToRun } from "../src/client/api.js";
import { ProductionQueue } from "../src/client/components/ProductionQueue.js";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import { MultiPlatformPublishDialog } from "../src/client/components/MultiPlatformPublishDialog.js";
import { preferRunSnapshot } from "../src/client/pages/RunPage.js";
import type { StudioProvider, StudioRunDetail, StudioRunSummary, StudioTemplate } from "../src/shared/api.js";

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
  { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑卡片", available: true, kind: "local" },
  { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: false, kind: "external", requirement: "需要 PEXELS_API_KEY" },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "macOS 系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "FFmpeg 竖屏渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "本地技术审片", available: true, kind: "local" },
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
    costPolicy: { currency: "CNY", maxCost: 8, maxPaidShots: 1 },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    builtIn: true,
  };
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
  it("never lets an older polled snapshot overwrite newer run progress", () => {
    const newer = { ...runDetail, revision: 9, status: "succeeded" as const };
    const older = { ...runDetail, revision: 8, status: "running" as const };
    const sameRevision = { ...runDetail, revision: 9, status: "needs_human" as const };

    expect(preferRunSnapshot(newer, older)).toBe(newer);
    expect(preferRunSnapshot(newer, sameRevision)).toBe(sameRevision);
    expect(preferRunSnapshot(undefined, older)).toBe(older);
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

  it("explains why production voice is unavailable instead of leaving an empty panel", async () => {
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);

    render(<VoiceStudio value={{ profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" }} onChange={() => undefined} />);

    expect(await screen.findByText("当前没有正式配音演员")).toBeInTheDocument();
    expect(screen.getByText(/测试音轨不会用于成片/)).toBeInTheDocument();
  });

  it("presents production state and the next human action in a scannable queue", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProductionQueue runs={[runSummary, { ...runSummary, id: "run-2", title: "已经完成的内容", status: "succeeded" }]} loading={false} onCreate={() => undefined} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "制作记录", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(runSummary.title)).toBeInTheDocument();
    expect(screen.getAllByText("等你审片").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /进入审片/ })[0]).toHaveAttribute("href", "/projects/run-1");
    await user.click(screen.getByRole("button", { name: "筛选：待你处理" }));
    expect(screen.queryByText("已经完成的内容")).not.toBeInTheDocument();
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

    await waitFor(() => expect(onArchive).toHaveBeenCalledWith([first, second]));
  });

  it("creates a valid local production brief without exposing unavailable providers", async () => {
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
    expect(screen.getByRole("radio", { name: /经济日更/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /效果均衡/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "导演角色" })).toHaveValue("auto");
    expect(screen.getByText(/AI 根据题材选择导演语法/)).toBeInTheDocument();
    expect(screen.getByText("¥0")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /画面素材/ })).not.toBeInTheDocument();
    await user.click(screen.getByText("高级：逐节点配置"));
    await user.click(screen.getByRole("button", { name: /画面素材/ }));
    expect(screen.getByRole("radio", { name: /AI 逐镜路由/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /本地编辑卡片/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Pexels 视频/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: "20 秒" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "18 秒" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: "下班后别急着做这 3 件事",
      nicheSlug: expect.stringMatching(/^topic-[a-f0-9]{8}$/),
      protocolVersion: "video-factory/brief-v1",
      reviewMode: "manual",
      template: {
        templateId: "knowledge-explainer",
        runOverrides: { durationSeconds: 24, automationLevel: "assisted" },
      },
      providers: expect.objectContaining({ script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1" }),
      director: {
        profileId: "auto",
        assetProviderIds: ["local-editorial-v1"],
      },
      voiceDirection: {
        profileId: "macos:Tingting",
        rate: 185,
        pauseScale: 1,
        masteringPreset: "natural",
      },
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: false,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    }));

    rerender(<NewRunDialog open={false} providers={providers} onClose={onClose} onSubmit={onSubmit} />);
    rerender(<NewRunDialog open providers={providers} onClose={onClose} onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled());
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
    await user.click(screen.getByText("高级：逐节点配置"));
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

  it("blocks production when the published template catalog cannot be loaded", async () => {
    vi.mocked(studioApi.templates).mockRejectedValueOnce(new Error("模板服务离线"));
    const onSubmit = vi.fn(async () => undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(await screen.findByText(/无法读取模板目录：模板服务离线/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("applies the selected template automation level and preserves a custom duration", async () => {
    const automaticTemplate = {
      ...template("automatic-custom", "自动化自定义模板"),
      durationSeconds: 27,
      automationLevel: "automatic" as const,
    };
    vi.mocked(studioApi.templates).mockResolvedValueOnce({ storeRevision: 1, templates: [automaticTemplate] });
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<NewRunDialog open providers={providers} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(await screen.findByRole("option", { name: "27 秒" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "一条模板驱动的视频");
    await user.type(screen.getByLabelText("内容角度"), "验证模板快照而不是写死参数");
    await user.type(screen.getByLabelText("目标受众"), "内容创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      durationSeconds: 27,
      template: {
        templateId: "automatic-custom",
        runOverrides: { durationSeconds: 27, automationLevel: "automatic" },
      },
    }));
  });

  it("enables the optional Codex visual-review role only when its broker is available", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithVisualReview: StudioProvider[] = [
      ...providers,
      {
        id: "codex-visual-review-v1",
        capability: "quality.review.visual",
        label: "Codex 视觉审片",
        available: true,
        kind: "external",
        billing: "subscription",
      },
    ];
    render(<NewRunDialog open providers={providersWithVisualReview} onClose={() => undefined} onSubmit={onSubmit} />);

    const visualReview = screen.getByRole("checkbox", { name: /视觉审片/ });
    expect(visualReview).toBeChecked();
    await user.type(screen.getByLabelText("视频标题"), "视觉审片必须进入生产单");
    await user.type(screen.getByLabelText("内容角度"), "验证可选模型角色的开关");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "codex-visual-review-v1" }),
    }));

    await user.click(visualReview);
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit.mock.calls.at(-1)?.[0].providers).not.toHaveProperty("visualReview");
  });

  it("keeps the production dialog open while toggling workflow gates", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const providersWithVisualReview: StudioProvider[] = [
      ...providers,
      {
        id: "codex-visual-review-v1",
        capability: "quality.review.visual",
        label: "Codex 视觉审片",
        available: true,
        kind: "external",
        billing: "subscription",
      },
    ];
    render(<NewRunDialog open providers={providersWithVisualReview} onClose={onClose} onSubmit={async () => undefined} />);

    await user.click(screen.getByText("高级：逐节点配置"));
    const semanticRank = screen.getByRole("checkbox", { name: /候选语义选片/ });
    const visualReview = screen.getByRole("checkbox", { name: /视觉审片/ });

    await user.click(semanticRank);
    await user.click(visualReview);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(semanticRank).not.toBeChecked();
    expect(visualReview).not.toBeChecked();
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
      workflowFeatures: { assetSemanticRank: true, referenceGrammar: true },
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

  it("recalculates the paid-shot budget from the selected model profile", async () => {
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

    await user.click(screen.getByRole("radio", { name: /效果均衡/ }));
    await user.click(screen.getByText("高级：逐节点配置"));
    await user.selectOptions(screen.getByRole("combobox", { name: "火山方舟视频 本次模型" }), "premium-model");

    expect(screen.getByLabelText("预计成本上限")).toHaveValue(3);
    expect(screen.getByText(/生成最低 ¥3/)).toBeInTheDocument();
  });

  it("quotes the effective template model before a paid run is submitted", async () => {
    const premiumTemplate = {
      ...template("knowledge-explainer", "知识解释"),
      modelDefaults: { "seedance-video-v1": "premium-model" },
    };
    vi.mocked(studioApi.templates).mockResolvedValueOnce({
      storeRevision: 1,
      templates: [premiumTemplate, template("photo-story", "照片故事")],
    });
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

    await user.click(await screen.findByRole("radio", { name: /效果均衡/ }));
    await user.click(screen.getByText("高级：逐节点配置"));

    expect(screen.getByRole("combobox", { name: "火山方舟视频 本次模型" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "继承默认：premium-model" })).toBeInTheDocument();
    expect(screen.getByLabelText("预计成本上限")).toHaveValue(3);
    expect(screen.getByText(/生成最低 ¥3/)).toBeInTheDocument();
  });

  it("shows metered GLM review cost separately from the paid-shot budget", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const providersWithGlmReview: StudioProvider[] = [
      ...providers,
      {
        id: "glm-visual-review-v1",
        capability: "quality.review.visual",
        label: "GLM-5.3-Flash 视觉审片",
        available: true,
        kind: "external",
        billing: "metered",
        estimatedCnyPerClip: 0.1,
        billingUnit: "run",
      },
    ];
    render(<NewRunDialog open providers={providersWithGlmReview} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByRole("checkbox", { name: /视觉审片/ })).toBeChecked();
    expect(screen.getByText("1 次付费审片")).toBeInTheDocument();
    expect(screen.getByText(/视觉审片预计 ¥0.1，执行前分别确认/)).toBeInTheDocument();
    expect(screen.getByLabelText("预计成本上限")).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("视频标题"), "按次审片预算");
    await user.type(screen.getByLabelText("内容角度"), "审片不占付费镜头额度");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ visualReview: "glm-visual-review-v1" }),
      economics: {
        recipeId: "economy-daily",
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
      },
    }));
  });

  it("treats metered voice as one separately approved run call", async () => {
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
        billingUnit: "run",
        estimatedCnyPerClip: 0.5,
      },
    ];
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "minimax:Chinese (Mandarin)_News_Anchor", providerId: "minimax-tts-v1", label: "新闻主播", locale: "zh-CN", engine: "minimax", curated: true },
    ]);
    render(<NewRunDialog open providers={providersWithMeteredVoice} onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByText("1 次付费配音")).toBeInTheDocument();
    expect(screen.getByText(/配音预计 ¥0.5，执行前分别确认/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("视频标题"), "按次配音预算");
    await user.type(screen.getByLabelText("内容角度"), "声音调用独立确认");
    await user.type(screen.getByLabelText("目标受众"), "短视频创作者");
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ voice: "minimax-tts-v1" }),
      economics: expect.objectContaining({
        allowMeteredProviders: true,
        maxPaidShots: 0,
        maxCostCny: 0,
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

  it("enables a metered recipe only when a priced model is configured", async () => {
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
    await user.click(screen.getByRole("radio", { name: /效果均衡/ }));
    await user.click(screen.getByText("高级：逐节点配置"));

    expect(screen.getByRole("checkbox", { name: /Seedance 关键镜头/ })).toBeChecked();
    const localBaseline = screen.getByRole("checkbox", { name: /本地编辑卡片/ });
    expect(localBaseline).toBeChecked();
    expect(localBaseline).toBeDisabled();
    expect(screen.getByLabelText("预计成本上限")).toHaveValue(3.5);
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.objectContaining({ assets: "ai-shot-router-v1", director: "api-visual-director-v1" }),
      director: expect.objectContaining({
        profileId: "auto",
        assetProviderIds: expect.arrayContaining(["local-editorial-v1", "seedance-video-v1"]),
      }),
      economics: {
        recipeId: "keyshot-ai",
        allowMeteredProviders: true,
        maxPaidShots: 1,
        maxCostCny: 3.5,
      },
    }));
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

  it("locks an editorial image story to a free production path", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <NewRunDialog
        open
        providers={providers}
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

    expect(screen.getByRole("radio", { name: /全免费精搜/ })).toBeChecked();
    expect(screen.getByText(/图文成片/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "开始制作" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      editorial: expect.objectContaining({ verdict: "produce_image_story" }),
      economics: expect.objectContaining({ allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 }),
    }));
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

    expect(screen.getByRole("radio", { name: /全免费精搜/ })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "导演角色" })).toHaveValue("documentary-observer");
    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "视频时长" })).toHaveValue("30");
    expect(screen.getByLabelText("终审模式")).toHaveTextContent("人工终审");
    expect(await screen.findByRole("slider", { name: "语速" })).toHaveValue("205");
    await user.click(screen.getByText("高级：逐节点配置"));
    expect(screen.getByRole("checkbox", { name: /Pexels 视频/ })).toBeChecked();
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
      director: expect.objectContaining({ assetProviderIds: ["local-editorial-v1"] }),
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
    await userEvent.setup().click(screen.getByText("高级：逐节点配置"));
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
    expect(onDecision).toHaveBeenCalledWith({ action: "approve" });
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
    expect(screen.getByRole("button", { name: "检查并确认" })).toBeInTheDocument();
    expect(screen.getByText(/声音导演完成后，系统会继续推进后续节点/)).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "打回" }));
    expect(screen.getByRole("dialog", { name: "打回这条视频" })).toBeInTheDocument();

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

    expect(screen.queryByRole("dialog", { name: "打回这条视频" })).not.toBeInTheDocument();
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
      decisionPending={false}
      onDecision={async () => undefined}
      connectionHeartbeatAt="2026-08-30T10:00:43.000Z"
    />);

    expect(screen.getByRole("region", { name: "制作进度" })).toBeInTheDocument();
    expect(screen.getAllByText("策划定稿").length).toBeGreaterThan(0);
    expect(screen.getByText("1 / 4 个节点完成")).toBeInTheDocument();
    expect(screen.getByText("正在统一叙事节奏、镜头语法与视觉规则")).toBeInTheDocument();
    expect(screen.getByText(/样本不足.*不提供虚假 ETA/)).toBeInTheDocument();
    expect(screen.getByText(/智谱视觉导演.*glm-5.3-flash/)).toBeInTheDocument();
    expect(screen.getByText("云端连接刚刚确认")).toBeInTheDocument();
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
    expect(screen.getByText("已保留 4 个前序节点")).toBeInTheDocument();
    expect(screen.getByText("HTTP 429 rate limit exceeded")).not.toBeVisible();
    expect(screen.getByText("技术诊断")).toBeInTheDocument();
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
          recoveryActions: ["到总配置检查对应服务的密钥与权限"],
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

  it("blocks retry and restart while a paid provider outcome is uncertain", () => {
    const { activeIntervention: _activeIntervention, ...withoutIntervention } = runDetail;
    render(<RunWorkbench
      run={{
        ...withoutIntervention,
        status: "failed",
        nodes: withoutIntervention.nodes.map((node, index) => index === 0
          ? { ...node, status: "failed", outcomeUncertain: true }
          : node),
      }}
      decisionPending={false}
      onDecision={async () => undefined}
      onRestart={vi.fn()}
      onRetryFailedNode={vi.fn()}
    />);

    expect(screen.getByText(/先在 Provider 控制台核对任务与账单/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "调整方案后重新制作" })).not.toBeInTheDocument();
  });
});
