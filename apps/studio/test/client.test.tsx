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
import type { StudioProvider, StudioRunDetail, StudioRunSummary } from "../src/shared/api.js";

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

beforeEach(() => {
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
    { id: "brief", label: "需求校验", role: "制片人", status: "succeeded", artifactIds: [], qualityGateResults: [] },
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
  it("reports a dropped run event stream while leaving EventSource reconnection active", () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    class FakeEventSource {
      addEventListener(type: string, listener: EventListener) { listeners.set(type, listener); }
      close = close;
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const disconnected = vi.fn();

    const unsubscribe = subscribeToRun("run-1", vi.fn(), disconnected);
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
    await user.click(screen.getByRole("button", { name: "筛选：等你审片" }));
    expect(screen.queryByText("已经完成的内容")).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "开始制作" })).toBeEnabled();
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

  it("uses persisted creator defaults for recipe, voice, and asset provider", async () => {
    const configuredProviders: StudioProvider[] = [
      ...providers.map((provider) => provider.id === "pexels-stock-v1" ? { ...provider, available: true, status: "ready" as const } : provider),
    ];
    render(<NewRunDialog
      open
      providers={configuredProviders}
      creatorSettings={{
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
        defaultRecipeId: "free-stock",
        defaultAssetProviderId: "pexels-stock-v1",
      }}
      onClose={() => undefined}
      onSubmit={async () => undefined}
    />);

    expect(screen.getByRole("radio", { name: /全免费精搜/ })).toBeChecked();
    expect(await screen.findByRole("slider", { name: "语速" })).toHaveValue("205");
    await userEvent.setup().click(screen.getByText("高级：逐节点配置"));
    expect(screen.getByRole("checkbox", { name: /Pexels 视频/ })).toBeChecked();
  });

  it("blocks dispatch when only a test provider can serve a required node", () => {
    const providersWithTestVoice = [
      ...providers.filter((provider) => provider.capability !== "voice.synthesize"),
      { id: "ffmpeg-tone-test-v1", capability: "voice.synthesize", label: "测试音轨", available: true, kind: "test" as const },
    ];
    render(<NewRunDialog open providers={providersWithTestVoice} onClose={() => undefined} onSubmit={async () => undefined} />);

    expect(screen.queryByRole("option", { name: "测试音轨" })).not.toBeInTheDocument();
    expect(screen.getByText(/缺少正式生产能力：配音/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始制作" })).toBeDisabled();
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

    expect(screen.getByTitle("成片预览")).toHaveAttribute("src", "/api/video");
    expect(screen.getByText("总导演 · 人工终审")).toBeInTheDocument();
    expect(screen.getByText("导演 · 导演方案")).toBeInTheDocument();
    expect(screen.getByText("请完整观看成片，确认内容和节奏。")).toBeInTheDocument();
    const artifacts = within(screen.getByLabelText("生产产物"));
    expect(artifacts.getByRole("heading", { name: /脚本生成/ })).toBeInTheDocument();
    expect(artifacts.getByRole("heading", { name: /视频渲染/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "批准进入发布包" }));

    expect(screen.getByRole("dialog", { name: "确认批准成片" })).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认批准并生成发布包" }));
    expect(onDecision).toHaveBeenCalledWith({ action: "approve", actor: "director" });
  });

  it("shows the director's visual bible and AI-generated per-shot routes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
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
    }), { status: 200 })));
    render(<RunWorkbench
      run={{
        ...runDetail,
        artifacts: [
          ...runDetail.artifacts,
          { id: "director-plan", kind: "storyboard", producerNodeId: "visual-direction", createdAt: "2026-08-21T10:00:20.000Z", contentUrl: "/api/director-plan" },
        ],
      }}
      decisionPending={false}
      onDecision={async () => undefined}
    />);

    const panel = await screen.findByLabelText("导演方案");
    expect(within(panel).getByText("纪实观察")).toBeInTheDocument();
    expect(within(panel).getByText("先现场后解释")).toBeInTheDocument();
    expect(within(panel).getByText("事实镜头")).toBeInTheDocument();
    expect(within(panel).getByText(/Pexels 图库/)).toBeInTheDocument();
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
});
