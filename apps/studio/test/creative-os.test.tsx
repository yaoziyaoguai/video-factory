import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AppShell } from "../src/client/components/AppShell.js";
import { DirectorPanel } from "../src/client/components/DirectorPanel.js";
import { OpportunityFocus } from "../src/client/components/OpportunityFocus.js";
import { OpportunityDialog } from "../src/client/components/OpportunityDialog.js";
import { OpportunityRail } from "../src/client/components/OpportunityRail.js";
import { ProductionStrip } from "../src/client/components/ProductionStrip.js";
import { SeriesDialog } from "../src/client/components/SeriesDialog.js";
import { SourceSupplementDialog } from "../src/client/components/SourceSupplementDialog.js";
import { TopicEntryWorkspace } from "../src/client/components/TopicEntryWorkspace.js";
import { ExperimentsPage } from "../src/client/pages/ExperimentsPage.js";
import { ProductionPage } from "../src/client/pages/ProductionPage.js";
import { ResourcesPage } from "../src/client/pages/ResourcesPage.js";
import { HomePage } from "../src/client/pages/HomePage.js";
import { TodayPage } from "../src/client/pages/TodayPage.js";
import type { StudioCandidateInboxItem, StudioCostDashboard, StudioLocalCapability, StudioOpportunity, StudioProvider, StudioRunSummary, StudioSeries, StudioTemplate, StudioTrendSource } from "../src/shared/api.js";
import { planVisualDirection } from "../src/shared/visual-plan.js";

const opportunity: StudioOpportunity = {
  id: "opportunity-1",
  origin: "trend",
  title: "下班后什么都不想做，是懒还是耗竭？",
  platform: "douyin",
  track: "ordinary-life",
  audience: "普通上班族",
  painPoint: "下班后没有精力",
  hook: "你不是懒，只是把最后一点力气用在了看起来正常。",
  status: "shortlisted",
  evidence: [{
    source: "manual-research",
    platform: "douyin",
    keyword: "下班后什么都不想做",
    strength: 86,
    evidenceUrl: "https://example.com/evidence",
    collectedAt: "2026-08-22T10:00:00.000Z",
  }],
  score: {
    audienceReach: 88,
    visualFeasibility: 90,
    productionCostEfficiency: 84,
    novelty: 78,
    monetization: 62,
    seriesPotential: 91,
    complianceRisk: 18,
    final: 84,
  },
  scoreProvenance: {
    source: "人工维度评分 · topic-intelligence-v1",
    scoredAt: "2026-08-22T10:00:00.000Z",
  },
  createdAt: "2026-08-22T10:00:00.000Z",
  updatedAt: "2026-08-22T10:00:00.000Z",
};

const providers: StudioProvider[] = [
  { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "本地视觉导演", available: true, kind: "local" },
  { id: "local-editorial-v1", capability: "asset.prepare", label: "本地编辑卡片", available: true, kind: "local", deliveryTypes: ["editorial_card"] },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "FFmpeg 渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "技术审片", available: true, kind: "local" },
  { id: "codex-role-auditor-v1", capability: "role.audit", label: "Codex 独立质量审计", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
];

const trendSources: StudioTrendSource[] = [
  {
    id: "manual-research",
    label: "人工研究",
    kind: "native",
    status: "ready",
    description: "录入已经人工核验的热点、搜索词或评论信号。",
    cadence: "随时",
  },
  {
    id: "douyin-hotsearch",
    label: "抖音官方热点",
    kind: "native",
    status: "needs_config",
    description: "读取实时热点词、上升词和关联视频。",
    cadence: "约 2 小时",
    requirement: "需要获批 hotsearch scope",
  },
];

const runningRun: StudioRunSummary = {
  id: "run-1",
  title: "为什么我们越来越不愿意接电话",
  status: "running",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-08-22T10:00:00.000Z",
  currentNodeId: "assets",
  creationOrigin: "trend",
};

function candidate(index: number, category: StudioCandidateInboxItem["category"]): StudioCandidateInboxItem {
  return {
    id: `trend-${index}`,
    origin: "trend",
    category,
    freshness: "live",
    risk: "low",
    verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
    editorialDecision: {
      verdict: "produce_video",
      score: 82,
      reasons: ["适合视频表达。"],
      guardrails: ["逐镜核验。"],
      recommendedTemplate: {
        id: "knowledge-explainer",
        name: "知识解释",
        format: "问题、因果模型与生活验证构成的解释视频",
        rationale: "让抽象信息形成可复述的因果链。",
      },
    },
    title: `候选提案 ${index}`,
    platform: index % 2 === 0 ? "bilibili" : "douyin",
    track: "daily-observer",
    audience: "中文短视频用户",
    painPoint: "信息很多但缺少判断",
    hook: `这是第 ${index} 条可核验的开场钩子。`,
    rationale: "来自语义模型与真实热点。",
    providerId: "api-topic-editor-v1",
    generatedAt: "2026-08-24T08:05:00.000Z",
    evidence: [{ source: "dailyhot", platform: "douyin", keyword: `候选 ${index}`, strength: 90 }],
    score: {
      audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80,
      novelty: 80, monetization: 60, seriesPotential: 80, complianceRisk: 10, final: 78,
    },
  };
}

function unselectedCandidate(index: number, category: StudioCandidateInboxItem["category"] = "technology"): StudioCandidateInboxItem {
  return {
    ...candidate(index, category),
    editorialDecision: { verdict: "skip", score: 0, reasons: ["没有越过生产门槛。"], guardrails: ["重做选题。"] },
  };
}

function sourceBlockedOpportunity(id: string, title: string): StudioOpportunity {
  return {
    ...opportunity,
    id,
    title,
    verification: {
      status: "blocked" as const,
      independentSources: 1,
      requiredSources: 2,
      reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接。"],
    },
  };
}

function searchTemplate(id: string, name: string): StudioTemplate {
  return {
    id,
    version: 1,
    status: "published",
    name,
    description: `${name}模板`,
    category: "knowledge",
    platforms: ["douyin"],
    durationSeconds: 24,
    automationLevel: "assisted",
    storyStructure: [
      { id: "hook", label: "开场", purpose: "抓住注意", required: true },
      { id: "body", label: "正文", purpose: "展开内容", required: true },
      { id: "close", label: "收束", purpose: "留下结论", required: true },
    ],
    shotSlots: [{ id: "shot", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
    visualSystem: { composition: "主体清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "自然可信", pace: "medium", musicIntent: "克制" },
    qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    builtIn: false,
  };
}

function inbox(items: StudioCandidateInboxItem[]) {
  return {
    items,
    facets: {
      total: items.length,
      origins: { trend: items.filter((item) => item.origin === "trend").length },
      categories: {
        technology: items.filter((item) => item.category === "technology").length,
        society: items.filter((item) => item.category === "society").length,
      },
      platforms: { douyin: items.filter((item) => item.platform === "douyin").length },
      verdicts: {
        produce_video: items.filter((item) => item.editorialDecision.verdict === "produce_video").length,
        produce_image_story: items.filter((item) => item.editorialDecision.verdict === "produce_image_story").length,
        skip: items.filter((item) => item.editorialDecision.verdict === "skip").length,
      },
    },
    generatedAt: "2026-08-24T09:00:00.000Z",
    refreshing: false,
  };
}

// TodayPage 同时渲染待制作区的热点机会板和候选收件箱，两块会用同一批候选的标题与来源文案。
// 收件箱自身的断言必须限定在收件箱容器内，否则会被机会板里的同名文本命中。
function withinTrendInbox() {
  const surface = document.querySelector('[data-tour="topic-inbox"]');
  if (!surface) throw new Error("trend inbox surface is not rendered");
  return within(surface as HTMLElement);
}

let restoreScrollIntoView: (() => void) | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", window.location.pathname);
  restoreScrollIntoView?.();
  restoreScrollIntoView = undefined;
});

function seriesPublicAffairs(): StudioSeries {
  return {
    id: "series-public-affairs",
    name: "台风事实台账",
    premise: "每集核对一条公共事件的原始来源。",
    audience: "需要辨别信息的中文观众",
    platform: "douyin",
    category: "society",
    track: "fact-review",
    pillars: ["来源核验"],
    tone: "克制",
    visualStyle: "证据图解",
    status: "active",
    revision: 1,
    currentSeason: { number: 1, title: "第一季", arc: "台风季事实核对" },
    bible: { rules: ["只引用可打开的原始来源"], recurringElements: [], forbiddenChanges: [] },
    canon: { revision: 0, facts: [] },
    episodes: [{
      id: "series-public-affairs-e1",
      seriesId: "series-public-affairs",
      episodeNumber: 1,
      seasonNumber: 1,
      arc: "台风季事实核对",
      pillar: "来源核验",
      title: "台风伤亡消息持续更新",
      viewerPromise: "看懂每条消息背后的来源",
      hook: "哪些伤亡说法真的有来源？",
      payoff: "给出可核验的来源清单",
      canonBaseRevision: 0,
      status: "planned",
      continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
      planning: { source: "rules", role: "系列总编", auditRole: "独立质量审计", auditStatus: "passed", auditIterations: 1, providerId: "rules", modelId: "deterministic", promptVersion: "test" },
      createdAt: "2026-09-07T08:00:00.000Z",
      updatedAt: "2026-09-07T08:00:00.000Z",
    }],
    nextEpisodeNumber: 1,
    createdAt: "2026-09-07T08:00:00.000Z",
    updatedAt: "2026-09-07T08:00:00.000Z",
  };
}

function seriesPublicAffairsBlockedCandidate(): StudioCandidateInboxItem {
  return {
    ...candidate(81, "society"),
    id: "series-public-affairs-e1",
    origin: "series",
    title: "台风伤亡消息持续更新",
    seriesId: "series-public-affairs",
    seriesName: "台风事实台账",
    episodeNumber: 1,
    seriesSequence: { status: "ready" },
    verification: {
      status: "blocked",
      independentSources: 0,
      requiredSources: 2,
      reasons: ["高风险公共题材不能只依据系列路线图开拍，需要补齐至少 2 个独立原始来源。"],
    },
  };
}

describe("Creative OS", () => {
  it("treats both manual and custom query aliases as the isolated custom creation entry", async () => {
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    const { unmount } = render(<MemoryRouter initialEntries={["/topics?mode=custom"]}><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自定义创作" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "热点候选收件箱" })).not.toBeInTheDocument();
    unmount();

    render(<MemoryRouter initialEntries={["/topics?mode=manual"]}><TodayPage /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "自定义创作" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "热点候选收件箱" })).not.toBeInTheDocument();
  });

  it("keeps already-produced opportunities out of every entry's pending-production area", async () => {
    const pending = { ...opportunity, id: "manual-pending", origin: "manual" as const, title: "仍待制作的自定义选题" };
    const produced = { ...pending, id: "manual-produced", status: "approved" as const, title: "已经投产的自定义选题" };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([produced, pending]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    render(<MemoryRouter initialEntries={["/topics?mode=custom"]}><TodayPage /></MemoryRouter>);

    const pendingHeading = await screen.findByRole("heading", { name: "待制作机会" });
    expect(screen.getByRole("heading", { name: pending.title })).toBeInTheDocument();
    expect(screen.queryByText(produced.title)).not.toBeInTheDocument();
    expect(pendingHeading.closest("header")?.querySelector(":scope > span")).toHaveTextContent("1 条");
  });

  it("uses an existing run as a fallback guard against duplicate production", async () => {
    const pending = { ...opportunity, id: "trend-with-run", title: "状态同步失败但已创建制作" };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([pending]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...runningRun, opportunityId: pending.id }]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "待制作机会" })).toBeInTheDocument();
    expect(screen.queryByText(pending.title)).not.toBeInTheDocument();
    expect(screen.getByText(/已开始制作的内容请到制作记录继续/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看制作记录" })).toHaveAttribute("href", "/projects");
  });

  it("presents a source-blocked historical topic as a current production opportunity with a visible advisory", async () => {
    const blocked = {
      ...opportunity,
      id: "historical-blocked",
      title: "缺少第二个独立来源的历史选题",
      verification: {
        status: "blocked" as const,
        independentSources: 1,
        requiredSources: 2,
        reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接。"],
      },
      editorialDecision: {
        verdict: "skip" as const,
        score: 0,
        reasons: ["证据门槛未满足。"],
        guardrails: ["补齐来源后再评估。"],
      },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([blocked]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));

    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByText(/0 条候选可进入制作 · 1 条已进入待制作区 · 1 条建议先补来源 · 0 条已完成/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "待制作机会" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: blocked.title })).toBeInTheDocument();
    // 来源不足只是醒目标注，不能变成"不可制作"的判决。
    expect(screen.getByRole("note")).toHaveTextContent("提醒（仅供参考，不影响你开工）：当前总编规则要求至少 2 个不同域名的有效原始来源链接。");
    expect(screen.getByRole("button", { name: "新建制作" })).toBeEnabled();
  });

  it("supplements a source-blocked candidate and refreshes its sources before adoption", async () => {
    const user = userEvent.setup();
    const blocked = {
      ...candidate(81, "technology"),
      id: "trend-needs-source",
      title: "AI 办公实测值不值得做",
      verification: { status: "blocked" as const, independentSources: 1, requiredSources: 2, reasons: ["还缺少第二个独立来源。"] },
    };
    const ready = {
      ...blocked,
      evidence: [...blocked.evidence, { source: "manual-supplement", platform: "manual", keyword: "人工补充来源", strength: 0, evidenceUrl: "https://news.example.org/report" }],
      verification: { status: "ready" as const, independentSources: 2, requiredSources: 2, reasons: ["来源门槛已满足。"] },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValueOnce(inbox([blocked])).mockResolvedValue(inbox([ready]));
    const supplement = vi.spyOn(studioApi, "supplementCandidateSources").mockResolvedValue(ready);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "查看来源不足的候选（1 条）" }));
    const supplementButton = await screen.findByRole("button", { name: `补充来源 ${blocked.title}` });
    await user.click(supplementButton);
    const input = screen.getByLabelText("来源链接（每行一条，1–10 条）");
    await user.type(input, "https://news.example.org/report\nhttps://search.example.com/results");
    await user.click(screen.getByRole("button", { name: "保存来源（2 条）" }));

    await waitFor(() => expect(supplement).toHaveBeenCalledWith(blocked.id, {
      evidenceUrls: ["https://news.example.org/report", "https://search.example.com/results"],
      origin: "trend",
    }));
    expect(await screen.findByRole("button", { name: `采用候选 ${ready.title}` })).toBeEnabled();
    expect(screen.getByText(/来源已保存；开工门槛与制作建议已按最新来源重算/)).toBeInTheDocument();
    expect(screen.getByText("用户补充 · 不作为热度信号")).toBeInTheDocument();
  });

  it("supplements a blocked historical trend and refreshes its score without promoting a fallback shot plan", async () => {
    const user = userEvent.setup();
    const blocked = sourceBlockedOpportunity("historical-source-gap", "历史热点补来源测试");
    const ready: StudioOpportunity = {
      ...blocked,
      evidence: [...blocked.evidence, { source: "manual-supplement", platform: "manual", keyword: "人工补充来源", strength: 0, evidenceUrl: "https://news.example.org/report" }],
      verification: { status: "ready", independentSources: 2, requiredSources: 2, reasons: ["来源门槛已满足。"] },
      editorialDecision: {
        verdict: "produce_video",
        score: 82,
        reasons: ["适合视频表达。"],
        guardrails: ["逐镜核验。"],
        recommendedTemplate: {
          id: "knowledge-explainer",
          name: "知识解释",
          format: "问题、因果模型与生活验证构成的解释视频",
          rationale: "让抽象信息形成可复述的因果链。",
        },
      },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValueOnce([blocked]).mockResolvedValue([ready]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    const supplement = vi.spyOn(studioApi, "supplementOpportunitySources").mockResolvedValue(ready);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "可参考的镜头方向" })).toBeInTheDocument();
    expect(screen.getByLabelText(/历史机会评分/)).toHaveTextContent("历史分");
    await user.click(screen.getByRole("button", { name: "补充原始来源" }));
    await user.type(screen.getByLabelText("来源链接（每行一条，1–10 条）"), "https://news.example.org/report");
    await user.click(screen.getByRole("button", { name: "保存来源（1 条）" }));

    await waitFor(() => expect(supplement).toHaveBeenCalledWith(blocked.id, { evidenceUrls: ["https://news.example.org/report"] }));
    expect(await screen.findByRole("heading", { name: "可参考的镜头方向" })).toBeInTheDocument();
    expect(screen.getByLabelText(/机会总分/)).toHaveTextContent("机会分");
    expect(screen.getByRole("button", { name: "新建制作" })).toBeEnabled();
  });

  it("keeps source input after a failed save and locks duplicate actions while pending", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("保存失败"));
    const { rerender } = render(<SourceSupplementDialog
      open
      title="来源待补选题"
      currentSources={1}
      requiredSources={2}
      pending={false}
      onClose={onClose}
      onSubmit={onSubmit}
    />);

    const input = screen.getByLabelText("来源链接（每行一条，1–10 条）");
    await user.type(input, "https://news.example.org/report");
    await user.click(screen.getByRole("button", { name: "保存来源（1 条）" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(["https://news.example.org/report"]));

    rerender(<SourceSupplementDialog
      open
      title="来源待补选题"
      currentSources={1}
      requiredSources={2}
      pending
      error="来源保存失败：网络暂不可用"
      onClose={onClose}
      onSubmit={onSubmit}
    />);
    expect(input).toHaveValue("https://news.example.org/report");
    expect(screen.getByRole("alert")).toHaveTextContent("来源保存失败：网络暂不可用");
    expect(screen.getByRole("button", { name: "正在保存..." })).toBeDisabled();
    expect(screen.getByTitle("关闭")).toBeDisabled();
    expect(screen.getByRole("button", { name: "暂不补充" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps all agent candidates visible beside persisted opportunities and filters by category", async () => {
    const user = userEvent.setup();
    const candidates = Array.from({ length: 8 }, (_, index) => candidate(index + 1, index < 5 ? "technology" : "society"));
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "热点候选收件箱" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "这轮没有可采用的热点建议" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /查看候选提案/ })).toHaveLength(8);
    expect(screen.getByRole("heading", { name: opportunity.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "待制作选题" })).toBeInTheDocument();
    expect(screen.queryByText("问题、因果模型与生活验证构成的解释视频")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /科技 5/ }));
    expect(screen.getAllByRole("button", { name: /查看候选提案/ })).toHaveLength(5);
  });

  it("shows broad trend categories and performs an explicit upstream refresh", async () => {
    const user = userEvent.setup();
    const candidates = [candidate(1, "technology"), candidate(2, "society")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:01.000Z",
      candidateCount: 2,
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    await waitFor(() => expect(screen.getByText(/2 个平台 · 2 条/)).toBeInTheDocument());
    expect(screen.getByText("2 条候选可进入制作 · 0 条已进入待制作区 · 0 条已完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "建议做视频 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `采用候选 ${candidates[0]!.title}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "游戏电竞 0" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "汽车 0" })).toBeDisabled();
    const platformFilter = screen.getByRole("combobox", { name: "热点来源平台" });
    expect(within(platformFilter).getByRole("option", { name: "全部来源平台" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/后台更新已开始/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "立即刷新热点" })).toBeEnabled(), { timeout: 4_000 });
  });

  it("keeps the trend refresh control disabled while the background refresh poll is still running", async () => {
    const user = userEvent.setup();
    const candidates = [candidate(1, "technology"), candidate(2, "society")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    const status = vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1", state: "running", requestedAt: "2026-08-30T10:00:00.000Z",
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    const refreshButton = screen.getByRole("button", { name: "立即刷新热点" });
    expect(refreshButton).toBeEnabled();

    await user.click(refreshButton);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refreshButton).toBeDisabled();

    status.mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:02.000Z",
      candidateCount: 2,
    });
    await waitFor(() => expect(refreshButton).toBeEnabled(), { timeout: 4_000 });
  });

  it("keeps the recovery refresh action locked while the background refresh is still running", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    const status = vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1", state: "running", requestedAt: "2026-08-30T10:00:00.000Z",
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    const recoveryRefresh = await screen.findByRole("button", { name: "重新刷新热点" });
    expect(recoveryRefresh).toBeEnabled();

    await user.click(recoveryRefresh);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "重新刷新热点" })).toBeDisabled();

    status.mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:02.000Z",
      candidateCount: 0,
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "重新刷新热点" })).toBeEnabled(), { timeout: 4_000 });
  });

  it("distinguishes collected trend signals from candidates still waiting for a decision", async () => {
    const user = userEvent.setup();
    const collected = [candidate(1, "technology"), candidate(2, "society")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox")
      .mockResolvedValueOnce(inbox(collected))
      .mockResolvedValue(inbox([collected[0]!]));
    vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:01.000Z",
      candidateCount: 2,
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));

    expect(await screen.findByText("本次采集 2 条，其中 1 条已进入制作区；当前有 1 条待判断。", {}, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("does not force-refresh trends when the creator returns to the page", async () => {
    const candidates = [candidate(1, "technology")];
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(candidates));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findByRole("button", { name: /查看候选提案/ });
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps source selection on the home page instead of asking twice", async () => {
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([candidate(1, "technology")]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "热点候选收件箱" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "选题入口" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今天做一条视频" })).not.toBeInTheDocument();
  });

  it("uses the home page only as a source launcher without screening candidates again", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([
      { ...runningRun, id: "run-attention", status: "needs_human", nextAction: "review" },
      runningRun,
      { ...runningRun, id: "run-done", status: "succeeded" },
      { ...runningRun, id: "run-failed", status: "failed" },
      { ...runningRun, id: "run-rejected", status: "rejected" },
      { ...runningRun, id: "run-archived", status: "rejected", archivedAt: "2026-09-07T12:00:00.000Z" },
    ]);
    const candidateInbox = vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([candidate(1, "technology")]));
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "你今天从哪里出发？" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "先替你筛到三条" })).not.toBeInTheDocument();
    expect(candidateInbox).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("待你处理3");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("自动制作1");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("已完成1");
    expect(screen.getByRole("region", { name: "制作概况" })).toHaveTextContent("已归档1");
    expect(screen.getByRole("region", { name: "制作概况" })).not.toHaveTextContent("需调整");
    expect(screen.getByText("选择一种开始方式。系统会沿同一条制作线推进；需要生成付费图片或视频时，会先报价并等你确认。")).toBeInTheDocument();
  });

  it("keeps a legacy read-only review out of the home to-do count and offers a new version", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([{
      ...runningRun,
      id: "legacy-review",
      title: "旧版待审记录",
      status: "needs_human",
      currentNodeId: "final-review",
      continuation: { supported: false, reason: "这条旧版制作只能查看。" },
    }]);
    render(<MemoryRouter><HomePage /></MemoryRouter>);

    expect(await screen.findByRole("region", { name: "制作概况" })).toHaveTextContent("待你处理0");
    expect(screen.getByText("历史只读")).toBeInTheDocument();
    expect(screen.queryByText("等你审片")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /基于这版重新制作/ })).toHaveAttribute("href", "/projects/legacy-review");
    expect(screen.queryByRole("link", { name: /进入审片/ })).not.toBeInTheDocument();
  });

  it("creates a durable series from the peer series entry mode", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    const create = vi.spyOn(studioApi, "createSeries").mockResolvedValue({
      id: "series-1",
      name: "AI 下班实验室",
      premise: "每集验证一个普通人真能用上的 AI 方法。",
      audience: "普通上班族",
      platform: "douyin",
      category: "technology",
      track: "series-ab12cd34",
      pillars: ["真实任务实验", "成本与时间复盘"],
      tone: "克制、具体、有结论",
      visualStyle: "真实桌面操作与生活空镜",
      status: "active",
      revision: 1,
      currentSeason: { number: 1, title: "第一季", arc: "验证普通人能用的 AI 方法" },
      bible: { rules: ["保持真实验证"], recurringElements: [], forbiddenChanges: [] },
      canon: { revision: 0, facts: [] },
      episodes: [],
      nextEpisodeNumber: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建系列" }));
    await user.type(screen.getByLabelText("系列名称"), "AI 下班实验室");
    await user.type(screen.getByLabelText("系列承诺"), "每集验证一个普通人真能用上的 AI 方法。");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    expect(screen.queryByRole("option", { name: "视频号" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建系列" }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: "AI 下班实验室",
      category: "technology",
      pillars: ["真实问题拆解", "方法与结果复盘"],
      platform: "douyin",
      tone: "克制、具体、有结论",
    }));
    expect(await screen.findByRole("option", { name: /AI 下班实验室/ })).toBeInTheDocument();
  });

  it("keeps a legacy unsupported series readable but blocks new production", () => {
    const legacySeries: StudioSeries = {
      id: "series-legacy-platform",
      name: "旧视频号系列",
      premise: "保留历史路线图",
      audience: "旧观众",
      platform: "shipinhao",
      category: "lifestyle",
      track: "legacy-channel",
      pillars: ["旧主题", "旧复盘"],
      tone: "具体",
      visualStyle: "生活实拍",
      status: "active",
      revision: 1,
      currentSeason: { number: 1, title: "第一季", arc: "历史内容" },
      bible: { rules: ["保留历史"], recurringElements: [], forbiddenChanges: [] },
      canon: { revision: 0, facts: [] },
      episodes: [{
        id: "legacy-episode-1",
        seriesId: "series-legacy-platform",
        episodeNumber: 1,
        seasonNumber: 1,
        arc: "历史内容",
        pillar: "旧主题",
        title: "历史单集",
        viewerPromise: "保留可读",
        hook: "历史开场",
        payoff: "历史结论",
        canonBaseRevision: 0,
        status: "planned",
        continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: [], canonChecks: [] },
        planning: { source: "rules", role: "系列总编", auditRole: "独立质量审计", auditStatus: "passed", auditIterations: 1, providerId: "rules", modelId: "deterministic", promptVersion: "test" },
        createdAt: "2026-08-24T09:00:00.000Z",
        updatedAt: "2026-08-24T09:00:00.000Z",
      }],
      nextEpisodeNumber: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    };

    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="series"
      selectedSeriesId={legacySeries.id}
      inbox={inbox([])}
      series={[legacySeries]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 0, candidateCount: 0 }}
      seriesAuditReady
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(screen.getByText(/这个历史系列使用的首发平台已不再支持新制作/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "历史单集" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /请先迁移到支持的平台/ })).toBeDisabled();
  });

  it("offers persisted source supplements for a source-blocked series episode before adoption", async () => {
    const user = userEvent.setup();
    const publicSeries = seriesPublicAffairs();
    const blockedEpisodeCandidate = seriesPublicAffairsBlockedCandidate();
    const onSupplementSources = vi.fn();
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="series"
      selectedSeriesId={publicSeries.id}
      inbox={inbox([blockedEpisodeCandidate])}
      series={[publicSeries]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 0, candidateCount: 1 }}
      seriesAuditReady
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onSupplementSources={onSupplementSources}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "台风伤亡消息持续更新" })).toBeInTheDocument();
    expect(screen.getByText(/高风险公共题材不能只依据系列路线图开拍/)).toBeInTheDocument();
    // 来源不足只是提醒：按钮保持可用，文案预告点下去会发生什么。
    const adopt = screen.getByRole("button", { name: /仍然进入制作/ });
    expect(adopt).toBeEnabled();
    expect(screen.getByRole("note")).toHaveTextContent("来源提醒（不影响你开工）：高风险公共题材不能只依据系列路线图开拍");

    await user.click(screen.getByRole("button", { name: /^补充原始来源/ }));
    expect(onSupplementSources).toHaveBeenCalledWith(blockedEpisodeCandidate);
  });

  it("routes series source supplements to the series entry and reloads the roadmap", async () => {
    const user = userEvent.setup();
    const publicSeries = seriesPublicAffairs();
    const blockedEpisodeCandidate = seriesPublicAffairsBlockedCandidate();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([publicSeries]);
    const inboxCalls = vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([blockedEpisodeCandidate]));
    const supplemented: StudioCandidateInboxItem = {
      ...blockedEpisodeCandidate,
      verification: {
        status: "review_required",
        independentSources: 2,
        requiredSources: 2,
        reasons: ["高风险公共题材已补齐独立原始来源，采用前需要人工查看并确认。"],
      },
    };
    const supplement = vi.spyOn(studioApi, "supplementCandidateSources").mockResolvedValue(supplemented);
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: /^补充原始来源/ }));
    await user.type(screen.getByLabelText(/来源链接/), "https://news.example.org/typhoon-report\nhttps://police.example.cn/notice");
    await user.click(screen.getByRole("button", { name: /保存来源（2 条）/ }));

    await waitFor(() => expect(supplement).toHaveBeenCalledOnce());
    expect(supplement).toHaveBeenCalledWith("series-public-affairs-e1", {
      evidenceUrls: ["https://news.example.org/typhoon-report", "https://police.example.cn/notice"],
      origin: "series",
    });
    // 补齐后重拉系列工作区，而不是在客户端乐观解除阻断。
    await waitFor(() => expect(inboxCalls.mock.calls.filter(([query]) => (query as { origins?: string[] } | undefined)?.origins?.[0] === "series").length).toBeGreaterThanOrEqual(2));
  });

  it("exposes the four real workspaces in the primary navigation", async () => {
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    const navigation = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(navigation.getByRole("link", { name: /创作台/ })).toHaveAttribute("href", "/");
    expect(navigation.getByRole("link", { name: /制作记录/ })).toHaveAttribute("href", "/projects");
    expect(navigation.getByRole("link", { name: /素材库/ })).toHaveAttribute("href", "/assets");
    expect(navigation.getByRole("link", { name: /模板工坊/ })).toHaveAttribute("href", "/templates");
    expect(navigation.getByRole("link", { name: /创作设置/ })).toHaveAttribute("href", "/resources");
    expect(navigation.getByRole("link", { name: /制作复盘/ })).toHaveAttribute("href", "/experiments");
  });

  it("opens an account menu before signing out", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    render(
      <MemoryRouter>
        <AppShell username="creator@example.com" onLogout={onLogout}><div>content</div></AppShell>
      </MemoryRouter>,
    );

    const accountTriggers = screen.getAllByRole("button", { name: /账号菜单/ });
    await user.click(accountTriggers[0]!);

    expect(onLogout).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "账号菜单" })).toBeInTheDocument();
    expect(screen.getByText("creator@example.com", { selector: ".studio-account-identity strong" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("searches real production records from the global command surface", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...runningRun, title: "窗边一杯水的六秒光影" }]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "窗边一杯水");

    expect(await screen.findByRole("link", { name: /窗边一杯水的六秒光影/ })).toHaveAttribute("href", "/projects/run-1");
  });

  it("shows the real run status in global search", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([{ ...runningRun, title: "失败的制作", status: "failed" }]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "失败的制作");

    expect(await screen.findByRole("link", { name: /失败的制作/ })).toHaveTextContent("失败");
    expect(screen.getByRole("link", { name: /失败的制作/ })).not.toHaveTextContent("制作中");
  });

  it("distinguishes same-name rework runs by creation time without exposing internal ids", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([
      { ...runningRun, id: "run-rework-alpha", title: "同名返工作品", startedAt: "2026-09-06T10:00:00.000Z" },
      { ...runningRun, id: "run-rework-beta", title: "同名返工作品", status: "failed", startedAt: "2026-09-07T10:00:00.000Z" },
    ]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "同名返工作品");

    const results = await screen.findAllByRole("link", { name: /同名返工作品/ });
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveTextContent("09/06");
    expect(results[1]).toHaveTextContent("09/07");
    expect(results[0]).not.toHaveTextContent("rework-alpha");
    expect(results[1]).not.toHaveTextContent("rework-beta");
    expect(results[0]).not.toHaveTextContent(results[1]?.textContent ?? "");
  });

  it("closes global search with Escape, clears it, and restores focus", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    const trigger = screen.getByRole("button", { name: "搜索项目、选题、模板或功能" });
    await user.click(trigger);
    const search = screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" });
    await user.type(search, "模板");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" })).toHaveValue("");
  });

  it("keeps opportunity selection, evidence, and production action in one workspace", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onProduce = vi.fn();
    render(
      <div>
        <OpportunityRail opportunities={[opportunity]} selectedId={opportunity.id} onSelect={onSelect} onCreate={() => undefined} />
        <OpportunityFocus opportunity={opportunity} />
        <DirectorPanel opportunity={opportunity} providers={providers} onProduce={onProduce} />
      </div>,
    );

    expect(screen.getAllByText(opportunity.title).length).toBeGreaterThan(0);
    // 来源线索印的必须是用户认得的平台，不是采集器 id：manual-research 对用户没有意义。
    expect(screen.getByRole("link", { name: "查看 下班后什么都不想做 来源" })).toHaveAttribute("href", "https://example.com/evidence");
    expect(screen.queryByText("manual-research")).toBeNull();
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByLabelText("机会评分维度")).toHaveTextContent("安全82%");
    expect(screen.getAllByText(/录入时估分/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "新建制作" }));
    expect(onProduce).toHaveBeenCalledOnce();
  });

  it("describes topic intelligence according to the selected creation origin", () => {
    const topicProviders: StudioProvider[] = [
      ...providers,
      { id: "api-topic-editor-v1", capability: "topic.intelligence", label: "Codex 选题总编", available: true, kind: "external" },
    ];
    const { rerender } = render(<MemoryRouter><DirectorPanel opportunity={{ ...opportunity, origin: "manual" }} providers={topicProviders} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByText("AI 提出自定义选题角度；系统检查来源链接；关键事实仍需按来源核对")).toBeInTheDocument();

    rerender(<MemoryRouter><DirectorPanel opportunity={{ ...opportunity, origin: "series" }} providers={topicProviders} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByText("系列选题、连续性检查与开拍前复核由 AI 系列总编完成")).toBeInTheDocument();
  });

  it("keeps production available for a historical trend the current criteria no longer recommend, with a visible advisory", () => {
    render(<MemoryRouter><DirectorPanel
      opportunity={{
        ...opportunity,
        verification: {
          status: "blocked",
          independentSources: 1,
          requiredSources: 2,
          reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接。"],
        },
        editorialDecision: {
          verdict: "skip",
          score: 0,
          reasons: ["证据门槛未满足。"],
          guardrails: ["补齐来源后再评估。"],
        },
      }}
      providers={providers}
      onProduce={() => undefined}
    /></MemoryRouter>);

    // 建议不再禁用开工：能力齐备时按钮必须可用，同时把提醒醒目标注出来。
    expect(screen.getByRole("note")).toHaveTextContent("提醒（仅供参考，不影响你开工）：当前总编规则要求至少 2 个不同域名的有效原始来源链接。");
    expect(screen.getByRole("button", { name: "新建制作" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "查看缺失能力" })).not.toBeInTheDocument();
  });

  it("carries the configured default duration into an adopted opportunity", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 45 },
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建制作" }));

    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("45");
  });

  it("uses the creator target platform instead of the opportunity source platform", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([{ ...opportunity, platform: "guokr" }]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "bilibili", durationSeconds: 24 },
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建制作" }));

    expect(screen.getByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
  });

  it("presents an executable visual plan for every topic without fake stock frames", () => {
    render(<OpportunityFocus opportunity={opportunity} />);

    const shotBoard = screen.getByRole("region", { name: "镜头方向示意" });
    expect(shotBoard).toHaveAttribute("data-tour", "visual-direction");
    expect(within(shotBoard).getByText("镜头 01")).toBeInTheDocument();
    expect(within(shotBoard).getByText("镜头 02")).toBeInTheDocument();
    expect(within(shotBoard).getByText("镜头 03")).toBeInTheDocument();
    expect(within(shotBoard).getAllByText(/素材搜索：下班后什么都不想做/)).toHaveLength(3);
    expect(within(shotBoard).queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps source advice visible without claiming the topic cannot start", () => {
    render(<OpportunityFocus opportunity={{
      ...opportunity,
      verification: {
        status: "blocked",
        independentSources: 1,
        requiredSources: 2,
        reasons: ["还缺少第二个独立来源。"],
      },
      visualPlan: {
        strategy: "把两条来源标题并列放进确定性标尺，补源后仍沿用这套视觉论证。",
        beats: [{
          id: "source-certainty",
          role: "来源核对",
          duration: "0-8 秒",
          description: "左右并列原始标题，高亮“网传”和“正在核查”。",
          searchQuery: "source headlines certainty",
          source: "screen",
        }],
      },
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("来源提醒（不影响你开工）");
    expect(screen.getByRole("status")).toHaveTextContent("还缺少第二个独立来源");
    expect(screen.getByLabelText(/历史机会评分/)).toHaveTextContent("历史分");
    expect(screen.getByText(/历史内容潜力，仅供参考/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已保存的镜头方向" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "可执行镜头计划" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "镜头方向示意" })).toHaveTextContent("高亮“网传”和“正在核查”");
  });

  it("keeps a stored shot plan with legitimate ellipses instead of recomputing it", () => {
    render(<OpportunityFocus opportunity={{
      ...opportunity,
      title: "学校治理AI作弊，难点可能不是“禁不禁”，而是怎样证明学习发生过",
      category: "education",
      verification: {
        status: "blocked",
        independentSources: 1,
        requiredSources: 2,
        reasons: ["还缺少第二个独立来源。"],
      },
      editorialDecision: {
        verdict: "produce_image_story",
        score: 72,
        reasons: ["适合用来源画面和数据解释。"],
        guardrails: ["补齐来源后再开工。"],
        recommendedTemplate: {
          id: "photo-story",
          name: "证据图解",
          format: "来源画面与数据证据驱动的图解视频",
          rationale: "以证据为主。",
        },
      },
      visualPlan: {
        strategy: "已保存的视觉方案。",
        beats: [{
          id: "legacy",
          role: "旧镜头",
          duration: "0-24 秒",
          description: "让“学校治理AI作弊，难点可能不是“禁不禁”，而是怎样证明…”能被复现。",
          searchQuery: "学校治理AI作弊，难点可能不是…",
          source: "screen",
        }],
      },
    }} />);

    const shotBoard = screen.getByRole("region", { name: "镜头方向示意" });
    expect(within(shotBoard).queryByText("推荐模板 · 证据图解")).not.toBeInTheDocument();
    expect(within(shotBoard).queryByText("视觉方案 · A01")).not.toBeInTheDocument();
    // 已保存计划是规范真相：含合法省略号的描述不得被展示层重算替换。
    expect(shotBoard).toHaveTextContent("已保存的视觉方案。");
    expect(shotBoard).toHaveTextContent("让“学校治理AI作弊，难点可能不是“禁不禁”，而是怎样证明…”能被复现。");
    expect(shotBoard).toHaveTextContent("素材搜索：学校治理AI作弊，难点可能不是…");
  });

  it("keeps successful data regions visible when the opportunity source fails", async () => {
    vi.spyOn(studioApi, "opportunities").mockRejectedValue(new Error("trend adapter timeout"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([runningRun]);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "机会读取失败" })).toBeInTheDocument());
    expect(screen.getByText(runningRun.title)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "当前没有可用热点候选" })).not.toBeInTheDocument();
  });

  it("does not turn failed resource or analytics requests into fake empty metrics", async () => {
    vi.spyOn(studioApi, "providers").mockRejectedValue(new Error("provider registry offline"));
    vi.spyOn(studioApi, "trendSources").mockRejectedValue(new Error("trend registry offline"));
    vi.spyOn(studioApi, "settings").mockRejectedValue(new Error("settings store offline"));
    vi.spyOn(studioApi, "runs").mockRejectedValue(new Error("run store offline"));
    render(<MemoryRouter><ResourcesPage /><ExperimentsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("画面能力状态未知")).toBeInTheDocument());
    expect(screen.getByText("热点源状态未知")).toBeInTheDocument();
    expect(screen.getByText("制作统计未知")).toBeInTheDocument();
    expect(screen.getByText("创作默认值读取失败")).toBeInTheDocument();
    expect(screen.queryByText("当前默认值已保存")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("制作统计")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未配置")).not.toBeInTheDocument();
  });

  it("does not turn a failed project request into an empty queue", async () => {
    vi.spyOn(studioApi, "runs").mockRejectedValue(new Error("run store offline"));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    render(<MemoryRouter><ProductionPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "制作记录读取失败" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "还没有制作记录" })).not.toBeInTheDocument();
  });

  it("shows a settings failure on the production page, blocks silent submission, and recovers with the saved values after an in-place retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [knowledgeTemplate()] });
    const settingsRequest = vi.spyOn(studioApi, "settings")
      .mockRejectedValueOnce(new Error("请求失败（500），请稍后重试。"))
      .mockResolvedValueOnce({
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "free-stock",
        topicStrategy: { customInstruction: "" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "bilibili", durationSeconds: 45 },
      });
    render(<MemoryRouter><ProductionPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText(/未能读取你的创作设置，为避免用错声音\/平台\/时长，暂未开工/)).toBeInTheDocument());
    const productionHeader = screen.getByRole("heading", { name: "制作记录" }).closest("header");
    expect(productionHeader).not.toBeNull();
    await user.click(within(productionHeader!).getByRole("button", { name: "新建制作" }));
    const dialog = screen.getByRole("dialog", { name: "创作设置读取失败" });
    expect(within(dialog).queryByRole("button", { name: "开始制作" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "重新读取" }));
    expect(settingsRequest).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("45");
    expect(screen.queryByText(/未能读取你的创作设置/)).not.toBeInTheDocument();
  });

  it("shows a settings failure on the today page, blocks silent submission, and recovers with the saved values after an in-place retry", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [knowledgeTemplate()] });
    const settingsRequest = vi.spyOn(studioApi, "settings")
      .mockRejectedValueOnce(new Error("请求失败（500），请稍后重试。"))
      .mockResolvedValueOnce({
        voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
        defaultRecipeId: "free-stock",
        topicStrategy: { customInstruction: "" },
        productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "bilibili", durationSeconds: 45 },
      });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText(/未能读取你的创作设置，为避免用错声音\/平台\/时长，暂未开工/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "新建制作" }));
    const dialog = screen.getByRole("dialog", { name: "创作设置读取失败" });
    expect(within(dialog).queryByRole("button", { name: "开始制作" })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "重新读取" }));
    expect(settingsRequest).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("combobox", { name: "目标平台" })).toHaveValue("bilibili");
    expect(screen.getByRole("combobox", { name: "建议时长" })).toHaveValue("45");
    expect(screen.queryByText(/未能读取你的创作设置/)).not.toBeInTheDocument();
  });

  it("shows real active production without inventing performance metrics", () => {
    render(<MemoryRouter><ProductionStrip runs={[runningRun]} /></MemoryRouter>);

    expect(screen.getByText("正在制作")).toBeInTheDocument();
    expect(screen.getByText(runningRun.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看生产/ })).toHaveAttribute("href", "/projects/run-1");
    expect(screen.queryByText(/播放量/)).not.toBeInTheDocument();
  });

  it("offers a real recovery path instead of a dead end when the round has no trend candidates", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole("heading", { name: "本轮还没有热点候选" })).toBeInTheDocument());
    expect(screen.getByText(/本轮收件箱还没有任何热点候选/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看缺来源的选题" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新刷新热点" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "继续已有系列" })).toHaveAttribute("href", "/topics?mode=series");
    await user.click(screen.getByRole("button", { name: "录入自己的选题" }));
    expect(screen.getByRole("dialog", { name: "录入机会" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    expect(screen.getByRole("textbox", { name: /机会数据/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "录入机会" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "录入自己的选题" })).toHaveFocus();
  });

  it("shows the exact evaluated, unselected, and source-blocked counts with the full recovery action set when nothing is clear for production", async () => {
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([
      sourceBlockedOpportunity("historical-blocked-1", "第一条缺来源的历史选题"),
      sourceBlockedOpportunity("historical-blocked-2", "第二条缺来源的历史选题"),
      sourceBlockedOpportunity("historical-blocked-3", "第三条缺来源的历史选题"),
    ]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    // 恢复面板只在本轮没有任何候选"来源达标且系列顺序已轮到"时出现，所以这一轮的候选全部来源不足。
    const evaluated = Array.from({ length: 12 }, (_, index) => ({
      ...unselectedCandidate(index + 1, index % 2 === 0 ? "technology" : "society"),
      verification: {
        status: "blocked" as const,
        independentSources: 1,
        requiredSources: 2,
        reasons: ["当前总编规则要求至少 2 个不同域名的有效原始来源链接。"],
      },
    }));
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox(evaluated));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "本轮候选都附带提醒，但都能开工" })).toBeInTheDocument();
    expect(screen.getByText(/选题总编本轮评估了 12 条热点候选，其中 12 条建议不做/)).toBeInTheDocument();
    expect(screen.getByText(/其中 12 条建议不做/)).toBeInTheDocument();
    expect(screen.getByText(/本轮另有 12 条候选的来源还没达到当前采用标准/)).toBeInTheDocument();
    expect(screen.getByText(/另有 3 条历史选题来源不足/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新刷新热点" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "录入自己的选题" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "继续已有系列" })).toHaveAttribute("href", "/topics?mode=series");
    expect(screen.getByRole("button", { name: "查看来源不足的候选（12 条）" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看缺来源的选题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看总编不建议的（12 条）/ })).toBeInTheDocument();
    // 恢复面板取代了筛选栏：本轮候选没有被闸门藏进任何分区。
    expect(screen.queryByRole("button", { name: /^全部 / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /科技 / })).not.toBeInTheDocument();
  });

  it("keeps every candidate reachable by default and filters under-sourced and editorially unskipped ones by tab", async () => {
    const user = userEvent.setup();
    const underSourced = {
      ...candidate(51, "technology"),
      verification: { status: "blocked" as const, independentSources: 1, requiredSources: 2, reasons: ["高风险热点至少需要 2 个独立来源"] },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([underSourced, unselectedCandidate(52), unselectedCandidate(53)])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 3 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    // 没有闸门：默认视图里三条候选全部可见，来源不足的那条没有被藏起来。
    expect(screen.getAllByRole("button", { name: /^查看/ })).toHaveLength(3);
    expect(screen.getByRole("button", { name: `查看${underSourced.title}` })).toBeInTheDocument();
    // 来源不足只是醒目标注，采用按钮保持可用。
    expect(screen.getByRole("note")).toHaveTextContent("来源不足：高风险热点至少需要 2 个独立来源（只是建议，不影响你采用）");
    expect(screen.getByRole("button", { name: `采用候选 ${underSourced.title}` })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /总编不建议 2/ }));

    expect(screen.getAllByRole("button", { name: /^查看/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: `查看${underSourced.title}` })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("总编不建议生产：没有越过生产门槛。（只是建议，不影响你采用）");

    await user.click(screen.getByRole("button", { name: /来源不足 1/ }));
    expect(screen.getByRole("button", { name: `查看${underSourced.title}` })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^查看/ })).toHaveLength(1);
  });

  it("allows an editorial candidate without a live recommended template to enter production", () => {
    const templateGone = {
      ...candidate(61, "technology"),
      editorialDecision: {
        verdict: "produce_video" as const,
        score: 82,
        reasons: ["适合视频表达。"],
        guardrails: ["逐镜核验。"],
      },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([templateGone])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 1 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(screen.queryByRole("heading", { name: "这轮没有可采用的热点建议" })).not.toBeInTheDocument();
    expect(screen.queryByText("推荐模板暂不可用 · 暂不可采用")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: `采用候选 ${templateGone.title}` })).toBeEnabled();
  });

  it("words source supplements and provider tooltips in creator language", async () => {
    const user = userEvent.setup();
    const underSourced = {
      ...candidate(71, "technology"),
      verification: { status: "blocked" as const, independentSources: 1, requiredSources: 2, reasons: ["高风险热点至少需要 2 个独立来源"] },
    };
    const skipped = unselectedCandidate(72);
    const renderWorkspace = (items: StudioCandidateInboxItem[]) => render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox(items)}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: items.length }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onSupplementSources={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    const { unmount } = renderWorkspace([underSourced]);
    await user.click(screen.getByRole("button", { name: "查看来源不足的候选（1 条）" }));
    await user.click(screen.getByRole("button", { name: `查看${underSourced.title}` }));
    expect(screen.getByText("来源不足 · 仍可由你决定开工")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `补充来源 ${underSourced.title}` })).toHaveTextContent("保存来源并重新评估");
    // 悬停提示用创作者语言，不暴露内部 provider id。
    expect(screen.getByTitle("AI 选题总编")).toBeInTheDocument();
    unmount();

    renderWorkspace([skipped]);
    await user.click(screen.getByRole("button", { name: /总编不建议 1/ }));
    await user.click(screen.getByRole("button", { name: `查看${skipped.title}` }));
    expect(screen.getByText("总编不建议 · 0 分")).toBeInTheDocument();
    expect(screen.getAllByText("没有越过生产门槛。").length).toBeGreaterThan(0);
    expect(screen.queryByText("证据不足，暂不可采用")).not.toBeInTheDocument();
  });

  it("never bills a rule-baseline round as the editor's judgement or leaks the collector id", async () => {
    const user = userEvent.setup();
    // 规则保底候选的 skip 是本地规则算出来的，不是总编说的：
    // 把它算进"总编不建议"会让从未评估过的候选看起来像被人否掉过。
    const ruleLead: StudioCandidateInboxItem = {
      ...unselectedCandidate(81),
      providerId: "trend-heuristic-v1",
      editorialDecision: {
        verdict: "skip",
        score: 0,
        reasons: ["当前只是热点规则保底候选，还没有经过选题总编形成具体、可拍的创作角度。"],
        guardrails: [],
        pendingEditorReview: true,
      },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([ruleLead])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 1 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onSupplementSources={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(screen.getByRole("button", { name: /待总编评估 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /总编不建议 0/ })).toBeDisabled();
    expect(screen.getByText("本轮热点由本地规则保底生成，还没有经过选题总编转译；先筛选，再核验证据。")).toBeInTheDocument();
    // 来源线索给的是平台，采集器 id 是内部实现，不该出现在用户面前。
    await user.click(screen.getByRole("button", { name: `查看${ruleLead.title}` }));
    expect(screen.getByText("抖音 · 榜单热度或排名信号 90")).toBeInTheDocument();
  });

  it("focuses the first source-blocked historical topic from the recovery action instead of the editorially skipped one", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "scrollIntoView");
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    restoreScrollIntoView = () => {
      if (scrollIntoViewDescriptor) Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
      else delete (window.HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    };
    const editorialSkipOnly = {
      ...opportunity,
      id: "historical-editorial-skip",
      title: "仅因编辑判断未入选的历史选题",
      editorialDecision: {
        verdict: "skip" as const,
        score: 0,
        reasons: ["没有越过生产门槛。"],
        guardrails: ["重做选题。"],
      },
    };
    const firstBlocked = sourceBlockedOpportunity("historical-blocked-a", "第一条真实缺来源的历史选题");
    const secondBlocked = sourceBlockedOpportunity("historical-blocked-b", "第二条真实缺来源的历史选题");
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([editorialSkipOnly, firstBlocked, secondBlocked]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    const adopt = vi.spyOn(studioApi, "adoptCandidate");
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "本轮还没有热点候选" })).toBeInTheDocument();
    expect(screen.getByText(/另有 2 条历史选题来源不足/)).toBeInTheDocument();
    // 总编不建议的历史选题照样在待制作区里，没有被藏起来。
    expect(screen.getByRole("button", { name: new RegExp(editorialSkipOnly.title) })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看缺来源的选题" }));

    const blockedSection = screen.getByRole("region", { name: "待制作机会" });
    await waitFor(() => expect(blockedSection).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: firstBlocked.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: editorialSkipOnly.title })).not.toBeInTheDocument();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("separates source-blocked historical topics from editorial skips instead of reporting one merged source gap", async () => {
    const editorialSkipOnly = {
      ...opportunity,
      id: "historical-editorial-skip-mixed",
      title: "仅因编辑判断未入选的历史选题",
      editorialDecision: {
        verdict: "skip" as const,
        score: 0,
        reasons: ["没有越过生产门槛。"],
        guardrails: ["重做选题。"],
      },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([
      editorialSkipOnly,
      sourceBlockedOpportunity("historical-blocked-mixed-a", "第一条真实缺来源的历史选题"),
      sourceBlockedOpportunity("historical-blocked-mixed-b", "第二条真实缺来源的历史选题"),
    ]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "本轮还没有热点候选" })).toBeInTheDocument();
    expect(screen.getByText(/另有 2 条历史选题来源不足/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "待制作机会" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "历史候选需补来源" })).not.toBeInTheDocument();
    // 两种理由不得合并计数：2 条来源不足的历史选题 + 1 条总编不建议，必须分开说。
    expect(screen.queryByText(/3 条建议先补来源/)).not.toBeInTheDocument();
    expect(screen.getByText("3 条已进入待制作区 · 2 条建议先补来源 · 1 条总编不建议")).toBeInTheDocument();
    expect(screen.getByText(/0 条候选可进入制作 · 3 条已进入待制作区 · 2 条建议先补来源 · 1 条总编不建议 · 0 条已完成/)).toBeInTheDocument();
    // 被当前政策阻断的历史热点：旧分数标为历史内容潜力，而不是当作当前结论。
    expect(screen.getAllByText("历史内容潜力").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("待补来源 · 仍可开工").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the manual path usable while the local topic model is warming up", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockReturnValue(new Promise(() => undefined));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "正在生成今日提案" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "今天做一条视频" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "录入自己的选题" }));
    expect(screen.getByRole("dialog", { name: "录入机会" })).toBeInTheDocument();
  });

  it("keeps the hard trend error explicit while a cached refresh failure still offers recovery", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const inboxApi = vi.spyOn(studioApi, "candidateInbox").mockRejectedValueOnce(new Error("热点服务超时"));
    const { unmount } = render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByText("热点候选暂时不可用")).toBeInTheDocument();
    expect(screen.getByText("热点服务超时")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重试/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "本轮还没有热点候选" })).not.toBeInTheDocument();
    unmount();

    // 总编不建议的候选不是被闸门拦住的候选：它们照常出现在候选列表里。
    inboxApi.mockResolvedValue(inbox([unselectedCandidate(1), unselectedCandidate(2)]));
    const refresh = vi.spyOn(studioApi, "refreshTrendCandidates").mockRejectedValue(new Error("上游刷新失败"));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "查看候选提案 1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "立即刷新热点" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/本次更新失败，继续展示上次缓存/)).toBeInTheDocument();
    // 刷新失败也不能把上一批缓存变成死路：候选继续可用，刷新入口重新打开。
    expect(screen.getByRole("button", { name: "查看候选提案 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看候选提案 2" })).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "立即刷新热点" })).toBeEnabled();
  });

  it("clears the stale cache warning once the background refresh lands and the fresh inbox arrives", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const inboxApi = vi.spyOn(studioApi, "candidateInbox")
      .mockResolvedValueOnce(inbox([candidate(1, "technology")]))
      .mockRejectedValueOnce(new Error("缓存读取闪断"))
      .mockResolvedValue(inbox([candidate(1, "technology"), candidate(2, "society")]));
    vi.spyOn(studioApi, "refreshTrendCandidates").mockResolvedValue({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" });
    vi.spyOn(studioApi, "trendCandidateRefreshStatus").mockResolvedValue({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:01.000Z",
      candidateCount: 2,
    });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findAllByRole("button", { name: /查看候选提案/ });
    const refreshButton = screen.getByRole("button", { name: "立即刷新热点" });
    await user.click(refreshButton);
    expect(await screen.findByText(/本次更新失败，继续展示上次缓存/)).toBeInTheDocument();
    expect(refreshButton).toBeDisabled();
    expect(inboxApi).toHaveBeenCalledTimes(2);

    await waitFor(() => expect(screen.queryByText(/本次更新失败，继续展示上次缓存/)).not.toBeInTheDocument(), { timeout: 4_000 });
    expect(screen.getByRole("button", { name: "立即刷新热点" })).toBeEnabled();
    expect(inboxApi).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("button", { name: /查看候选提案/ })).toHaveLength(2);
  });

  it("shows local series candidates while the trend model is still warming up", async () => {
    const user = userEvent.setup();
    const seriesCandidate: StudioCandidateInboxItem = {
      ...candidate(20, "lifestyle"),
      id: "series-series-1-episode-001",
      origin: "series",
      freshness: "evergreen",
      providerId: "series-planner-v1",
      seriesId: "series-1",
      seriesName: "下班观察室",
      episodeNumber: 1,
    };
    const secondSeriesCandidate: StudioCandidateInboxItem = {
      ...candidate(21, "education"),
      id: "series-series-2-episode-001",
      title: "第二个系列的第一集",
      origin: "series",
      freshness: "evergreen",
      providerId: "series-planner-v1",
      seriesId: "series-2",
      seriesName: "长期学习档案",
      episodeNumber: 1,
    };
    const opportunities = vi.spyOn(studioApi, "opportunities").mockResolvedValue([{
      ...opportunity,
      id: "series-series-1-episode-002",
      origin: "series",
      title: "已采用、尚未开工的第二集",
      seriesId: "series-1",
      episodeNumber: 2,
    }, {
      ...opportunity,
      id: "series-opportunity-finished",
      origin: "series",
      title: "历史成片不应再次制作",
      seriesId: "series-1",
      episodeNumber: 3,
    }]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    const runs = vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    const firstEpisode: StudioSeries["episodes"][number] = {
      id: seriesCandidate.id,
      seriesId: "series-1",
      episodeNumber: 1,
      seasonNumber: 1,
      arc: "回答真实难题",
      pillar: "问题",
      title: seriesCandidate.title,
      viewerPromise: seriesCandidate.painPoint,
      hook: seriesCandidate.hook,
      payoff: "回答一个真实难题",
      canonBaseRevision: 0,
      status: "planned",
      continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: ["留下下一集问题"], canonChecks: ["保持真实"] },
      planning: { source: "agent", role: "系列总编", auditRole: "独立质量审计 Agent", auditStatus: "passed", auditIterations: 2, auditScore: 91, auditSummary: "路线图有独立价值并形成递进。", providerId: "openai", modelId: "codex-default", promptVersion: "video-factory/series-showrunner-v1", reasoningEffort: "xhigh" },
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    };
    const seriesRecord: StudioSeries = {
      id: "series-1", name: "下班观察室", premise: "回答真实难题", audience: "上班族", platform: "douyin",
      category: "lifestyle", track: "after-work", pillars: ["问题", "复盘"], tone: "具体", visualStyle: "生活实拍",
      revision: 1, currentSeason: { number: 1, title: "第一季", arc: "回答真实难题" },
      bible: { rules: ["保持真实"], recurringElements: [], forbiddenChanges: [] }, canon: { revision: 0, facts: [] }, episodes: [firstEpisode, {
        ...firstEpisode,
        id: "series-series-1-episode-002",
        episodeNumber: 2,
        title: "已采用、尚未开工的第二集",
        status: "selected",
        opportunityId: "series-series-1-episode-002",
      }, {
        ...firstEpisode,
        id: "series-series-1-episode-003",
        episodeNumber: 3,
        title: "历史成片不应再次制作",
        status: "ready",
        opportunityId: "series-opportunity-finished",
        runId: "run-finished",
      }],
      status: "active", nextEpisodeNumber: 1, createdAt: "2026-08-24T09:00:00.000Z", updatedAt: "2026-08-24T09:00:00.000Z",
    };
    const secondSeriesRecord: StudioSeries = {
      ...seriesRecord,
      id: "series-2",
      name: "长期学习档案",
      track: "learning-journal",
      episodes: [{
        ...seriesRecord.episodes[0]!,
        id: secondSeriesCandidate.id,
        seriesId: "series-2",
        title: secondSeriesCandidate.title,
      }],
    };
    vi.spyOn(studioApi, "series").mockResolvedValue([seriesRecord, secondSeriesRecord]);
    const updateEpisode = vi.spyOn(studioApi, "updateSeriesEpisodePlan").mockImplementation(async (_seriesId, _episodeNumber, input) => ({
      ...seriesRecord,
      revision: 2,
      episodes: seriesRecord.episodes.map((episode) => ({
        ...episode,
        ...input,
        continuity: { ...episode.continuity, fromPrevious: input.fromPrevious, toNext: input.toNext },
        planning: {
          source: "human" as const,
          role: "主创手工改写",
          auditRole: "后续制作节点独立审计",
          auditStatus: "human_override" as const,
          auditIterations: 0,
          providerId: "human",
          modelId: "manual",
          promptVersion: "video-factory/series-episode-edit-v1",
        },
      })),
    }));
    vi.spyOn(studioApi, "candidateInbox").mockImplementation((query) => query?.origins?.includes("trend")
      ? new Promise(() => undefined)
      : Promise.resolve(inbox([seriesCandidate, secondSeriesCandidate])));
    render(<MemoryRouter initialEntries={["/topics?mode=series"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByRole("region", { name: "本季策划摘要" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /E01.*候选提案 20/ })).toBeInTheDocument();
    expect(screen.getByText("AI 系列总编")).toBeInTheDocument();
    expect(screen.getByText("独立复核 2/3 轮通过")).toBeInTheDocument();
    expect(screen.getByText(/路线图有独立价值并形成递进.*91 分/)).toBeInTheDocument();
    expect(screen.getByText("深入推理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑路线图" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "本集制作准备" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择待制作单集" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "选择待制作单集" })).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /历史成片不应再次制作/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "待制作选题" })).not.toBeInTheDocument();
    expect(opportunities).toHaveBeenCalledWith("series");
    expect(runs).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("heading", { name: "正在生成今日提案" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("选择系列"), "series-2");
    expect(screen.getByRole("button", { name: /E01.*第二个系列的第一集/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /E01.*候选提案 20/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("选择系列"), "series-1");

    await user.click(screen.getByRole("button", { name: "编辑路线图" }));
    const dialog = screen.getByRole("dialog", { name: "编辑第 1 集" });
    const title = within(dialog).getByLabelText("单集标题");
    await user.clear(title);
    await user.type(title, "人工确定的第一集");
    await user.click(within(dialog).getByRole("button", { name: "保存人工版本" }));
    await waitFor(() => expect(updateEpisode).toHaveBeenCalledWith("series-1", 1, expect.objectContaining({
      expectedRevision: 1,
      title: "人工确定的第一集",
    })));
    expect(await screen.findByText(/第 1 集路线图已保存为人工版本/)).toBeInTheDocument();
    expect(screen.getByText("人工 / 手工编辑")).toBeInTheDocument();
    expect(screen.getByText("人工决定")).toBeInTheDocument();
    expect(screen.queryByText(/复核结论：/)).not.toBeInTheDocument();
  });

  it("turns local agent candidates into editable opportunities with one explicit action", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const proposal: StudioCandidateInboxItem = {
      id: "trend-1",
      origin: "trend",
      category: "technology",
      freshness: "live",
      risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
      editorialDecision: {
        verdict: "produce_video",
        score: 86,
        reasons: ["适合视频表达。"],
        guardrails: ["逐镜核验。"],
        recommendedTemplate: {
          id: "knowledge-explainer",
          name: "知识解释",
          format: "问题、因果模型与生活验证构成的解释视频",
          rationale: "让抽象信息形成可复述的因果链。",
        },
      },
      title: "下班后的 AI 时间账本",
      platform: "douyin",
      track: "ai-daily-life",
      audience: "普通上班族",
      painPoint: "工具很多，却没有减少疲惫",
      hook: "真正偷走你下班时间的，可能不是加班。",
      rationale: "热点规模与低成本生活实验相交。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-08-24T08:05:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "AI 时间", strength: 96 }],
      score: {
        audienceReach: 90, visualFeasibility: 88, productionCostEfficiency: 90,
        novelty: 84, monetization: 72, seriesPotential: 88, complianceRisk: 12, final: 86,
      },
    };
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([proposal]));
    const adopt = vi.spyOn(studioApi, "adoptCandidate").mockResolvedValue({ ...opportunity, id: "trend-1", title: "下班后的 AI 时间账本" });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await screen.findByRole("heading", { name: "热点候选收件箱" });
    expect(screen.getAllByText("下班后的 AI 时间账本").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AI 选题总编").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "采用候选 下班后的 AI 时间账本" }));

    expect(adopt).toHaveBeenCalledWith("trend-1", { origin: "trend" });
    expect(screen.getByRole("heading", { name: "下班后的 AI 时间账本" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("下一步：检查证据与镜头计划");
  });

  it("requires explicit evidence confirmation for review candidates and keeps under-sourced high-risk candidates adoptable", async () => {
    const user = userEvent.setup();
    const reviewCandidate: StudioCandidateInboxItem = {
      ...candidate(31, "society"),
      id: "trend-review",
      title: "警方通报一项社会事件",
      risk: "review",
      verification: { status: "review_required", independentSources: 1, requiredSources: 1, reasons: ["采用前需要人工核验"] },
      evidence: [{ source: "newsnow", platform: "weibo", keyword: "警方通报", strength: 90, evidenceUrl: "https://example.com/report" }],
    };
    const blockedCandidate: StudioCandidateInboxItem = {
      ...candidate(32, "society"),
      id: "trend-blocked",
      title: "台风登陆消息持续更新",
      risk: "high",
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["高风险热点至少需要 2 个独立来源"] },
    };
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([reviewCandidate, blockedCandidate]));
    const adopt = vi.spyOn(studioApi, "adoptCandidate").mockResolvedValue({ ...opportunity, id: reviewCandidate.id });
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByText("1 条来源线索 · 1 个有效来源域名（需 1 个）")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: `采用候选 ${reviewCandidate.title}` }));
    expect(screen.getByRole("dialog", { name: "采用前核验证据" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /我已打开原始来源/ }));
    await user.click(screen.getByRole("button", { name: "确认核验并采用" }));
    expect(adopt).toHaveBeenCalledWith(reviewCandidate.id, { origin: "trend", verificationConfirmed: true });

    await user.click(screen.getByRole("button", { name: "查看来源不足的候选（1 条）" }));
    await user.click(screen.getByRole("button", { name: `查看${blockedCandidate.title}` }));
    const supplementSources = screen.getByRole("button", { name: `补充来源 ${blockedCandidate.title}` });
    expect(supplementSources).toBeEnabled();
    // 来源不足同样是建议：采用按钮存在、可用，同时必须出现醒目标注。
    const adoptBlocked = screen.getByRole("button", { name: `采用候选 ${blockedCandidate.title}` });
    expect(adoptBlocked).toBeEnabled();
    expect(adoptBlocked).toHaveTextContent("仍然采用");
    expect(withinTrendInbox().getByRole("note")).toHaveTextContent("来源不足：高风险热点至少需要 2 个独立来源（只是建议，不影响你采用）");
    expect(withinTrendInbox().getAllByText(/至少需要 2 个独立来源/).length).toBeGreaterThan(0);
    await user.click(supplementSources);
    expect(screen.getByRole("dialog", { name: "补齐可核验的原始来源" })).toBeInTheDocument();
  });

  it("shows content potential instead of a fake zero editorial score for source-blocked candidates", async () => {
    const user = userEvent.setup();
    const blockedCandidate: StudioCandidateInboxItem = {
      ...candidate(61, "technology"),
      title: "来源待补的高潜力候选",
      editorialDecision: { verdict: "skip", score: 0, reasons: ["证据门槛未满足：至少 2 个独立来源。"], guardrails: ["补齐来源后才推荐形态。"] },
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["至少需要 2 个不同域名的有效原始来源链接。"] },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([blockedCandidate, candidate(62, "technology")])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 2 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    // 内容潜力与开工状态分开：来源不足候选显示内容潜力分，不再显示“总编评分 0”。
    await user.click(screen.getByRole("button", { name: /来源不足 1/ }));
    expect(screen.getByRole("button", { name: `查看${blockedCandidate.title}` })).toBeInTheDocument();
    expect(screen.getByLabelText("内容潜力 78 分")).toBeInTheDocument();
    expect(screen.queryByLabelText("总编评分 0 分")).not.toBeInTheDocument();
    expect(screen.getByText("来源不足 · 仍可由你决定开工")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("来源不足：至少需要 2 个不同域名的有效原始来源链接。（只是建议，不影响你采用）");
    expect(screen.getByRole("button", { name: `采用候选 ${blockedCandidate.title}` })).toBeEnabled();
    expect(screen.queryByText("推荐形态")).not.toBeInTheDocument();
  });

  it("shows an honest pending-editor state once sources are complete instead of a fake zero score", async () => {
    const user = userEvent.setup();
    const heuristicCandidate: StudioCandidateInboxItem = {
      ...candidate(81, "technology"),
      title: "补齐来源后的规则保底候选",
      providerId: "trend-heuristic-v1",
      verification: { status: "ready", independentSources: 2, requiredSources: 2, reasons: ["常规风险候选，可进入制作区继续核验。"] },
      editorialDecision: {
        verdict: "skip",
        score: 0,
        reasons: ["当前只是热点规则保底候选，还没有经过选题总编形成具体、可拍的创作角度。"],
        guardrails: ["等待选题总编恢复，或由创作者补齐明确受众、观看收益、两秒钩子和可执行视频形态后再评估。"],
        pendingEditorReview: true,
      },
    };
    const modelEvaluated: StudioCandidateInboxItem = {
      ...unselectedCandidate(82),
      title: "总编评了零分的候选",
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([heuristicCandidate, modelEvaluated])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 2 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    // 两条候选各归各的分区：规则保底进"待总编评估"，总编真评过零分的才进"总编不建议"。
    // 两者照常出现在候选列表里，没有被任何闸门藏进任何分区。
    await user.click(await screen.findByRole("button", { name: /待总编评估 1/ }));

    // 规则保底候选：分数芯片显示“待总编评估”，绝不把“尚未评估”投影成“总编评分 0”。
    const heuristicRow = screen.getByRole("button", { name: `查看${heuristicCandidate.title}` });
    const heuristicChip = heuristicRow.querySelector(".candidate-score");
    expect(heuristicChip).toHaveTextContent("待总编评估");
    expect(heuristicChip).not.toHaveTextContent("0");
    await user.click(heuristicRow);
    expect(screen.getByLabelText("内容潜力 78 分")).toBeInTheDocument();
    expect(screen.getByText("来源已达标")).toBeInTheDocument();
    expect(screen.getByText("尚未评估 · 当前只有规则保底")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `采用候选 ${heuristicCandidate.title}` })).toHaveTextContent("仍然采用");
    expect(screen.getByRole("button", { name: `采用候选 ${heuristicCandidate.title}` })).toBeEnabled();
    // 提醒只是醒目标注，按钮保持可用；措辞必须说"没评估过"，不能替总编说"不建议"。
    expect(screen.getByRole("note")).toHaveTextContent("总编本轮没有评估这条：当前只是热点规则保底候选，还没有经过选题总编形成具体、可拍的创作角度。（只是建议，不影响你采用）");
    expect(screen.queryByLabelText("总编评分 0 分")).not.toBeInTheDocument();

    // 真实总编评出的 0 分仍如实显示为“总编评分 0”，不与“尚未评估”混淆。
    await user.click(screen.getByRole("button", { name: /总编不建议 1/ }));
    await user.click(screen.getByRole("button", { name: `查看${modelEvaluated.title}` }));
    expect(screen.getByLabelText("总编评分 0 分")).toBeInTheDocument();
    expect(screen.getByText("总编不建议 · 0 分")).toBeInTheDocument();
  });

  it("does not claim the topic editor evaluated a rule-only round in the recovery panel", async () => {
    // 恢复面板只在没有候选"来源达标且系列顺序已轮到"时出现，所以这一轮的规则保底候选同时来源不足。
    const pendingFirst: StudioCandidateInboxItem = {
      ...unselectedCandidate(91),
      title: "规则保底候选一",
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["还缺少第二个独立来源。"] },
      editorialDecision: {
        ...unselectedCandidate(91).editorialDecision,
        reasons: ["当前只是热点规则保底候选，还没有经过选题总编形成具体、可拍的创作角度。"],
        pendingEditorReview: true,
      },
    };
    const pendingSecond: StudioCandidateInboxItem = {
      ...pendingFirst,
      id: "trend-92",
      title: "规则保底候选二",
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([pendingFirst, pendingSecond])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 2 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "本轮候选都附带提醒，但都能开工" })).toBeInTheDocument();
    // 规则保底轮次不得谎称“选题总编已评估”。
    expect(screen.getByText(/2 条热点候选由规则保底生成，还没有经过选题总编评估/)).toBeInTheDocument();
    expect(screen.queryByText(/选题总编本轮评估了/)).not.toBeInTheDocument();
  });

  it("confirms a saved manual opportunity with its next step and a link into the custom entry", async () => {
    const user = userEvent.setup();
    const created: StudioOpportunity = {
      ...opportunity,
      id: "opp-manual-saved",
      title: "QA自有想法：三种手机充电习惯的耗电真相",
      origin: "manual",
      status: "draft",
    };
    vi.spyOn(studioApi, "opportunities").mockImplementation(async (origin) => (origin === "manual" ? [created] : []));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "createOpportunity").mockResolvedValue(created);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    // 先等热点收件箱完成加载并稳定在恢复面板，避免点击命中被替换的加载态按钮。
    await waitFor(() => expect(screen.getByRole("heading", { name: "本轮还没有热点候选" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "录入自己的选题" }));
    await user.type(await screen.findByLabelText("选题标题"), created.title);
    await user.type(screen.getByLabelText("目标受众"), "经常出门又不方便充电的通勤族");
    await user.type(screen.getByLabelText("核心痛点"), "手机一天要充三次，不知道哪些习惯在耗电");
    await user.type(screen.getByLabelText("开场钩子"), "这三个充电习惯，正在偷偷吃掉你的电量。");
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    // 保存成功必须可见、可继续：提示 + 指向自定义入口待制作区的下一步链接。
    expect(await screen.findByText(/已保存《QA自有想法：三种手机充电习惯的耗电真相》/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去查看并制作" })).toHaveAttribute("href", "/topics?mode=custom&opportunity=opp-manual-saved");

    // 点击链接进入自定义入口后，刚保存的机会已选中并处于待制作区。
    await user.click(screen.getByRole("link", { name: "去查看并制作" }));
    expect(await screen.findByRole("button", { name: new RegExp(created.title) })).toHaveClass("is-active");
  });

  it("selects the deep-linked opportunity when the custom entry is reopened", async () => {
    const created: StudioOpportunity = {
      ...opportunity,
      id: "opp-deep-link",
      title: "深链定位的机会",
      origin: "manual",
      status: "draft",
    };
    const other: StudioOpportunity = { ...created, id: "opp-other", title: "另一条机会" };
    vi.spyOn(studioApi, "opportunities").mockImplementation(async (origin) => (origin === "manual" ? [other, created] : []));
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    render(<MemoryRouter initialEntries={["/topics?mode=custom&opportunity=opp-deep-link"]}><TodayPage /></MemoryRouter>);

    // 刷新或直接访问深链 URL 后，仍定位到同一个机会，而不是回落到列表第一个。
    expect(await screen.findByRole("button", { name: /深链定位的机会/ })).toHaveClass("is-active");
    expect(screen.getByRole("button", { name: /另一条机会/ })).not.toHaveClass("is-active");
  });

  it("finds saved topic opportunities and current templates from global search", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({
      storeRevision: 1,
      templates: [searchTemplate("my-review-flow", "三步复盘法")],
      deletedBuiltIns: [],
    });
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([{
      ...opportunity,
      id: "opp-searchable",
      title: "电池耗电的三个真相",
      origin: "manual",
      status: "draft",
    }]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "电池");

    // 机会：按来源跳到对应入口并带上 opportunity 深链参数。
    expect(await screen.findByRole("link", { name: /电池耗电的三个真相/ })).toHaveAttribute("href", "/topics?mode=custom&opportunity=opp-searchable");

    await user.clear(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "复盘");

    // 模板：跳到模板工坊并直接打开对应模板。
    expect(await screen.findByRole("link", { name: /三步复盘法/ })).toHaveAttribute("href", "/templates?template=my-review-flow");
  });

  it("describes the real search scope when nothing matches", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 1, templates: [searchTemplate("my-review-flow", "三步复盘法")], deletedBuiltIns: [] });
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    render(<MemoryRouter><AppShell><div>content</div></AppShell></MemoryRouter>);

    await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
    await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), "量子物理讲义");

    expect(await screen.findByText("没有匹配的制作记录、选题机会、模板或功能。换一个更短的关键词试试。")).toBeInTheDocument();
  });

  it("opens actual voice settings from every voice search synonym on the same resources page", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "health").mockResolvedValue({ status: "ok", runtime: {} });
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [] });
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(studioApi, "settings").mockResolvedValue({ voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" }, defaultRecipeId: "economy-daily", roleProviderDefaults: {}, modelDefaults: {}, topicStrategy: { customInstruction: "" }, productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 } });
    render(<MemoryRouter initialEntries={["/resources#production-roles"]}><AppShell><ResourcesPage /></AppShell></MemoryRouter>);
    for (const word of ["声音", "配音", "音色", "语速", "停顿"]) {
      await user.click(screen.getByRole("button", { name: "搜索项目、选题、模板或功能" }));
      await user.type(screen.getByRole("textbox", { name: "搜索项目、选题、模板或功能" }), word);
      const link = (await screen.findAllByRole("link")).find((item) => item.getAttribute("href") === "/resources#voice-casting");
      expect(link).toBeDefined();
      await user.click(link!);
      await waitFor(() => expect(document.getElementById("voice-casting")).toHaveAttribute("data-active", "true"));
    }
  });

  it("links missing director capabilities straight to the production-roles section", () => {
    const partialProviders = providers.filter((provider) => provider.capability !== "script.draft" && provider.capability !== "voice.synthesize");
    render(<MemoryRouter><DirectorPanel opportunity={opportunity} providers={partialProviders} onProduce={vi.fn()} /></MemoryRouter>);

    const link = screen.getByRole("link", { name: "查看缺失能力" });
    expect(link).toHaveAttribute("href", "/resources?missing=script.draft%2Cvoice.synthesize#production-roles");
  });

  it("lands on the production-roles section and highlights the missing roles when arriving from the director panel", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));
    render(<MemoryRouter initialEntries={["/resources?missing=script.draft,voice.synthesize#production-roles"]}><ResourcesPage /></MemoryRouter>);

    // 直接落在制作分工分区，创作默认不再挡在前面（jsdom 不应用 CSS，用分区激活标记断言）。
    expect(await screen.findByRole("heading", { name: "按角色配置生产能力" })).toBeInTheDocument();
    expect(document.getElementById("production-roles")).toHaveAttribute("data-active", "true");
    expect(document.getElementById("creation-defaults")).not.toHaveAttribute("data-active");

    // 真正缺失的两个角色被高亮标记，其余角色不受影响。
    const flags = screen.getAllByText("当前缺失");
    expect(flags).toHaveLength(2);
    expect(flags[0]?.closest("article")).toHaveTextContent("编剧");
    expect(flags[1]?.closest("article")).toHaveTextContent("配音执行");

    // 键盘焦点落到目标分区，而不是停留在页面顶部。
    expect(document.getElementById("production-roles")).toHaveFocus();
  });

  it("reports this round's source-blocked candidates in the recovery panel and opens them", async () => {
    const user = userEvent.setup();
    const blockedCandidate: StudioCandidateInboxItem = {
      ...candidate(71, "technology"),
      title: "本轮被阻断的待补来源候选",
      editorialDecision: { verdict: "skip", score: 0, reasons: ["证据门槛未满足：至少 2 个独立来源。"], guardrails: ["补齐来源后才推荐形态。"] },
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["至少需要 2 个不同域名的有效原始来源链接。"] },
    };
    const blockedSecond: StudioCandidateInboxItem = {
      ...unselectedCandidate(72),
      title: "第二条本轮来源不足的候选",
      verification: { status: "blocked", independentSources: 1, requiredSources: 2, reasons: ["还缺少第二个独立来源。"] },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([blockedCandidate, blockedSecond])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 2 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "本轮候选都附带提醒，但都能开工" })).toBeInTheDocument();
    // 恢复面板统计的是本轮候选的来源阻断，而不是历史机会。
    expect(screen.getByText(/本轮另有 2 条候选的来源还没达到当前采用标准/)).toBeInTheDocument();
    expect(screen.getByText(/其中 2 条建议不做/)).toBeInTheDocument();
    expect(screen.queryByText(/历史选题来源不足/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看来源不足的候选（2 条）" }));

    const blockedRow = screen.getByRole("button", { name: `查看${blockedCandidate.title}` });
    expect(blockedRow.querySelector(".candidate-score")).toHaveTextContent("内容潜力");
    expect(screen.getByLabelText("内容潜力 78 分")).toBeInTheDocument();
  });

  it("shows every candidate by default and ranks the list by the score it displays", async () => {
    const user = userEvent.setup();
    const editorialWinner: StudioCandidateInboxItem = {
      ...candidate(33, "technology"),
      id: "trend-editorial-winner",
      title: "总编高分候选",
      score: { ...candidate(33, "technology").score, final: 42 },
      editorialDecision: {
        verdict: "produce_video",
        score: 93,
        reasons: ["观看价值明确。"],
        guardrails: ["核验结果。"],
        recommendedTemplate: {
          id: "knowledge-explainer",
          name: "知识解释",
          format: "问题、因果模型与生活验证构成的解释视频",
          rationale: "让抽象信息形成可复述的因果链。",
        },
      },
    };
    const rejectedRawWinner: StudioCandidateInboxItem = {
      ...candidate(34, "technology"),
      id: "trend-raw-winner",
      title: "原始分高但未入选",
      score: { ...candidate(34, "technology").score, final: 99 },
      editorialDecision: { verdict: "skip", score: 0, reasons: ["没有越过生产门槛。"], guardrails: ["重做选题。"] },
    };
    render(<MemoryRouter><TopicEntryWorkspace
      initialMode="trend"
      selectedSeriesId={undefined}
      inbox={inbox([rejectedRawWinner, editorialWinner])}
      series={[]}
      historicalRuns={[]}
      loading={{}}
      trendMeta={{ platformCount: 1, candidateCount: 2 }}
      onRetry={vi.fn()}
      onRefreshTrends={vi.fn()}
      onAdopt={vi.fn()}
      onCreateSeries={vi.fn()}
      onSelectSeries={vi.fn()}
      onUpdateSeriesEpisode={vi.fn()}
      onLinkLegacyRun={vi.fn()}
      onRescanSeries={vi.fn()}
      onViewProductionRecords={vi.fn()}
      onManual={vi.fn()}
      onImport={vi.fn()}
    /></MemoryRouter>);

    // 没有闸门：默认视图里两条候选都在。
    expect(screen.getByRole("button", { name: `查看${editorialWinner.title}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `查看${rejectedRawWinner.title}` })).toBeInTheDocument();
    // 排序必须用界面上显示的那个分：未入选候选显示的是总编评分 0，所以排在总编评分 93 之后。
    const listed = screen.getAllByRole("button", { name: /^查看/ }).map((row) => row.getAttribute("aria-label"));
    expect(listed).toEqual([`查看${editorialWinner.title}`, `查看${rejectedRawWinner.title}`]);
    expect(screen.getByLabelText("总编评分 93 分")).toBeInTheDocument();

    // 总编不建议只是醒目标注：候选照常排在列表里，点开就能看到"只是建议，不影响你采用"。
    await user.click(screen.getByRole("button", { name: `查看${rejectedRawWinner.title}` }));
    expect(screen.getByRole("note")).toHaveTextContent("总编不建议生产：没有越过生产门槛。（只是建议，不影响你采用）");

    await user.click(screen.getByRole("button", { name: /总编不建议 1/ }));

    expect(screen.getByRole("button", { name: `查看${rejectedRawWinner.title}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `查看${editorialWinner.title}` })).not.toBeInTheDocument();
    expect(screen.getByLabelText("总编评分 0 分")).toBeInTheDocument();
  });

  it("removes duplicate-key evidence from the previous candidate after switching rows", async () => {
    const user = userEvent.setup();
    const first = {
      ...candidate(41, "technology"),
      evidence: [
        { source: "newsnow", platform: "weibo", keyword: "同名信号", strength: 99, evidenceUrl: "https://example.com/old-a" },
        { source: "newsnow", platform: "weibo", keyword: "同名信号", strength: 98, evidenceUrl: "https://example.com/old-b" },
      ],
    } satisfies StudioCandidateInboxItem;
    const second = {
      ...candidate(42, "society"),
      evidence: [
        { source: "dailyhot", platform: "thepaper", keyword: "当前证据一", strength: 96, evidenceUrl: "https://example.com/current-a" },
        { source: "newsnow", platform: "toutiao", keyword: "当前证据二", strength: 94, evidenceUrl: "https://example.com/current-b" },
      ],
    } satisfies StudioCandidateInboxItem;
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([first, second]));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await withinTrendInbox().findAllByText("同名信号")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: `查看${second.title}` }));

    expect(withinTrendInbox().queryByText("同名信号")).not.toBeInTheDocument();
    expect(withinTrendInbox().getByText("当前证据一")).toBeInTheDocument();
    expect(withinTrendInbox().getByText("当前证据二")).toBeInTheDocument();
  });

  it("shows an actionable error when adopting an agent candidate fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    const proposal: StudioCandidateInboxItem = {
      id: "trend-invalid",
      origin: "trend",
      category: "lifestyle",
      freshness: "today",
      risk: "low",
      verification: { status: "ready", independentSources: 1, requiredSources: 1, reasons: ["常规风险"] },
      editorialDecision: {
        verdict: "produce_video",
        score: 78,
        reasons: ["适合视频表达。"],
        guardrails: ["逐镜核验。"],
        recommendedTemplate: {
          id: "knowledge-explainer",
          name: "知识解释",
          format: "问题、因果模型与生活验证构成的解释视频",
          rationale: "让抽象信息形成可复述的因果链。",
        },
      },
      title: "一个待核验的热点角度",
      platform: "douyin",
      track: "ordinary-life",
      audience: "普通上班族",
      painPoint: "信息很多但缺少判断",
      hook: "先看证据，再谈结论。",
      rationale: "来自本地热点信号。",
      providerId: "api-topic-editor-v1",
      generatedAt: "2026-08-24T08:05:00.000Z",
      evidence: [{ source: "dailyhot", platform: "douyin", keyword: "热点", strength: 80 }],
      score: {
        audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80,
        novelty: 70, monetization: 50, seriesPotential: 70, complianceRisk: 10, final: 78,
      },
    };
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([proposal]));
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "adoptCandidate").mockRejectedValue(new Error("选题保存失败"));
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "采用候选 一个待核验的热点角度" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("采用候选失败：选题保存失败");
    expect(screen.getByRole("button", { name: "采用候选 一个待核验的热点角度" })).toBeEnabled();
  });

  it("does not mark an opportunity approved when run creation fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([opportunity]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([
      ...providers,
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", billing: "free", deliveryTypes: ["stock_video"] },
      { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "deepseek-flash" },
      { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
    ]);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [knowledgeTemplate()] });
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    const start = vi.spyOn(studioApi, "start").mockRejectedValue(new Error("制作创建失败"));
    const updateStatus = vi.spyOn(studioApi, "updateOpportunityStatus");
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "新建制作" }));
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("shows an unsaved visual suggestion without submitting it as a user requirement", async () => {
    const user = userEvent.setup();
    const planless: StudioOpportunity = { ...opportunity };
    delete planless.visualPlan;
    vi.spyOn(studioApi, "opportunities").mockResolvedValue([planless]);
    vi.spyOn(studioApi, "providers").mockResolvedValue([
      ...providers,
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", billing: "free", deliveryTypes: ["stock_video"] },
      { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "deepseek-flash" },
      { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
    ]);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "series").mockResolvedValue([]);
    vi.spyOn(studioApi, "candidateInbox").mockResolvedValue(inbox([]));
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [knowledgeTemplate()] });
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "free-stock",
      topicStrategy: { customInstruction: "" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    const start = vi.spyOn(studioApi, "start").mockResolvedValue({ runId: "run-visual-plan-1" } as Awaited<ReturnType<typeof studioApi.start>>);
    render(<MemoryRouter initialEntries={["/topics"]}><TodayPage /></MemoryRouter>);

    expect(await screen.findByText("可参考的镜头方向")).toBeInTheDocument();
    expect(screen.getByText(planVisualDirection(opportunity).strategy)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "新建制作" }));
    await user.click(screen.getByRole("button", { name: "开始制作" }));

    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    // 自动预览只是建议；用户没有填写或采用时，不能升级成正式创作要求。
    expect(start.mock.calls[0]![0]).not.toHaveProperty("visualPlan");
    expect(start.mock.calls[0]![0]).not.toHaveProperty("visualIntent");
  });

  it("keeps scoring out of the creator form and records an optional reference", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    expect(screen.getByText("你填写创作事实和方向，机会评分交给系统")).toBeInTheDocument();
    expect(screen.queryByLabelText("人群覆盖")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("合规风险")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("选题标题"), opportunity.title);
    await user.type(screen.getByLabelText("目标受众"), opportunity.audience);
    await user.type(screen.getByLabelText("核心痛点"), opportunity.painPoint);
    await user.type(screen.getByLabelText("开场钩子"), opportunity.hook);
    await user.click(screen.getByText("可选：补充参考来源"));
    await user.type(screen.getByLabelText("参考链接"), "https://example.cn/source");
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: opportunity.title,
      track: "ordinary-life",
      evidence: [expect.objectContaining({
        source: "manual-supplement",
        platform: "manual",
        keyword: opportunity.title,
        strength: 0,
        evidenceUrl: "https://example.cn/source",
      })],
      scores: expect.objectContaining({ complianceRisk: 20 }),
    }));

    rerender(<OpportunityDialog open={false} onClose={() => undefined} onSubmit={onSubmit} />);
    rerender(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);
    expect(screen.getByRole("button", { name: "保存机会" })).toBeEnabled();
  });

  it("creates a quick opportunity with sensible evidence and score defaults", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("选题标题"), "下班后的十分钟如何真正休息");
    await user.type(screen.getByLabelText("目标受众"), "普通上班族");
    await user.type(screen.getByLabelText("核心痛点"), "下班后无法切换状态");
    await user.type(screen.getByLabelText("开场钩子"), "真正让人恢复的，可能不是继续刷手机。");
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      track: "ordinary-life",
      evidence: [expect.objectContaining({
        source: "manual-supplement",
        platform: "manual",
        keyword: "下班后的十分钟如何真正休息",
        strength: 0,
      })],
      scores: expect.objectContaining({ audienceReach: 70, complianceRisk: 20 }),
    }));
  });

  it("explains malformed JSON in Chinese and announces the error", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(screen.getByRole("alert")).toHaveTextContent("JSON 格式不正确");

    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{}" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears JSON errors when returning to manual entry", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: "{" } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));
    expect(screen.getByRole("alert")).toHaveTextContent("JSON 格式不正确");

    await user.click(screen.getByRole("tab", { name: "手动录入" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("内容系列")).not.toBeInTheDocument();
  });

  it("shows visible Chinese validation instead of relying on a browser bubble", async () => {
    const user = userEvent.setup();
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("button", { name: "保存机会" }));
    expect(screen.getByRole("alert")).toHaveTextContent("标题不能为空");

    await user.type(screen.getByLabelText("选题标题"), "继续填写选题");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("names the missing series field when creation is incomplete", async () => {
    const user = userEvent.setup();
    render(<SeriesDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    await user.click(screen.getByRole("button", { name: "创建系列" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请填写系列名称");

    await user.type(screen.getByLabelText("系列名称"), "继续填写系列");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("imports a structured opportunity without inventing missing fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { final: _final, ...scores } = opportunity.score;
    const input = {
      title: opportunity.title,
      platform: opportunity.platform,
      track: opportunity.track,
      audience: opportunity.audience,
      painPoint: opportunity.painPoint,
      hook: opportunity.hook,
      evidence: opportunity.evidence,
      scores,
    };
    render(<OpportunityDialog open onClose={() => undefined} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("tab", { name: "JSON 导入" }));
    fireEvent.change(screen.getByRole("textbox", { name: /机会数据/ }), { target: { value: JSON.stringify(input) } });
    await user.click(screen.getByRole("button", { name: "保存机会" }));

    expect(onSubmit).toHaveBeenCalledWith(input);
  });

  it("blocks production when a required node capability is unavailable", () => {
    render(<MemoryRouter><DirectorPanel opportunity={opportunity} providers={providers.filter((provider) => provider.capability !== "video.render")} onProduce={() => undefined} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "新建制作" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "查看缺失能力" })).toHaveAttribute("href", "/resources?missing=video.render#production-roles");
  });

  it("does not count a test provider as formal production readiness", () => {
    const providersWithTestVoice = [
      ...providers.filter((provider) => provider.capability !== "voice.synthesize"),
      { id: "ffmpeg-tone-test-v1", capability: "voice.synthesize", label: "测试音轨", available: true, kind: "test" as const },
    ];
    render(<MemoryRouter><DirectorPanel opportunity={opportunity} providers={providersWithTestVoice} onProduce={() => undefined} /></MemoryRouter>);

    expect(screen.getByRole("button", { name: "新建制作" })).toBeDisabled();
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("shows strategic resource gaps and refuses fabricated platform analytics", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue(trendSources);
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    render(<MemoryRouter><ResourcesPage /><ExperimentsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText("抖音官方热点")).toBeInTheDocument());
    expect(screen.getAllByText("需要配置").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "还不能判断是否成为爆款" })).toBeInTheDocument();
    expect(screen.queryByText(/播放量/)).not.toBeInTheDocument();
  });

  it("puts content learning before the secondary cost ledger on the review page", async () => {
    const user = userEvent.setup();
    const reviewRuns: StudioRunSummary[] = [
      { ...runningRun, id: "approved", title: "通过作品", status: "succeeded", currentNodeId: "publish", finalReviewOutcome: "approved" },
      { ...runningRun, id: "rejected", title: "返工作品", status: "rejected", currentNodeId: "final-review", finalReviewOutcome: "rejected" },
      { ...runningRun, id: "source-rejected", title: "来源打回作品", status: "rejected", currentNodeId: "asset-source-review" },
      { ...runningRun, id: "failed", title: "素材中断作品", status: "failed", currentNodeId: "assets" },
      { ...runningRun, id: "stale", title: "待重新生成作品", status: "stale", currentNodeId: "assets" },
      { ...runningRun, id: "source-review", title: "待核对来源作品", status: "needs_human", currentNodeId: "asset-source-review" },
      { ...runningRun, id: "review", title: "待审作品", status: "needs_human", currentNodeId: "final-review" },
    ];
    const costs: StudioCostDashboard = {
      currency: "CNY",
      totals: {
        estimatedCostCny: 1,
        authorizedCostCny: 1,
        actualCostCny: 1,
        actualPendingCount: 0,
        meteredCalls: 1,
        subscriptionCalls: 2,
        freeCalls: 3,
        failedMeteredCalls: 0,
      },
      byProvider: [],
      byNode: [],
      runs: [],
    };
    vi.spyOn(studioApi, "runs").mockResolvedValue(reviewRuns);
    vi.spyOn(studioApi, "templateExperiments").mockResolvedValue([{
      templateId: "knowledge-explainer",
      templateName: "知识解释",
      sampleSize: 4,
      metrics: {
        hookClarity: null,
        narrativeCompleteness: 75,
        visualMatch: 82,
        soundQuality: 100,
        costEfficiency: null,
        manualEditCount: 3,
        finalApprovalRate: 50,
      },
      note: "来自真实运行。",
    }]);
    const costRequest = vi.spyOn(studioApi, "costs").mockResolvedValue(costs);

    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "这一轮最该改什么" })).toBeInTheDocument();
    expect(screen.getByText("终审通过率")).toBeInTheDocument();
    expect(within(screen.getByLabelText("制作统计")).getByText("50%")).toBeInTheDocument();
    expect(within(screen.getByText("已打回返工").closest("article")!).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByText("制作中断").closest("article")!).getByText("1")).toBeInTheDocument();
    const reviewMetric = within(screen.getByLabelText("制作统计")).getByText("等你审片").closest("article");
    expect(within(reviewMetric!).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("画面出现 1 次问题")).toBeInTheDocument();
    fireEvent.click(screen.getByText("历史模板记录（暂停用于新制作）"));
    expect(screen.getByRole("link", { name: "查看模板资料" })).toHaveAttribute("href", "/templates");
    expect(screen.queryByRole("link", { name: "调整模板" })).not.toBeInTheDocument();
    expect(screen.getByText("82 分")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还不能判断是否成为爆款" })).toBeInTheDocument();
    expect(screen.queryByText("来源打回作品")).not.toBeInTheDocument();
    expect(screen.queryByText("待重新生成作品")).not.toBeInTheDocument();
    expect(screen.queryByText("待核对来源作品")).not.toBeInTheDocument();

    const costDetails = screen.getByText("费用与调用记录").closest("details");
    expect(costDetails).not.toBeNull();
    expect(costDetails).not.toHaveAttribute("open");
    expect(costRequest).not.toHaveBeenCalled();
    await user.click(screen.getByText("费用与调用记录"));
    expect(costDetails).toHaveAttribute("open");
    expect(await screen.findByRole("heading", { name: "按服务和制作步骤核对费用" })).toBeInTheDocument();
    expect(costRequest).toHaveBeenCalledTimes(1);
  });

  it("shows a template request failure without also claiming there are no samples", async () => {
    vi.spyOn(studioApi, "runs").mockResolvedValue([]);
    vi.spyOn(studioApi, "templateExperiments").mockRejectedValue(new Error("template store offline"));
    const costRequest = vi.spyOn(studioApi, "costs");

    render(<MemoryRouter><ExperimentsPage /></MemoryRouter>);

    expect(await screen.findByText("模板表现读取失败：template store offline")).toBeInTheDocument();
    expect(screen.queryByText("还没有可比较的模板样本。完成第一条成片后，这里会开始累计真实结果。")).not.toBeInTheDocument();
    expect(costRequest).not.toHaveBeenCalled();
  });

  it("exposes model economics and honest trend connector states in the resource registry", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue([
      ...providers,
      {
        id: "seedance-video-v1",
        capability: "asset.prepare",
        label: "Seedance 关键镜头",
        available: true,
        kind: "external",
        status: "ready",
        billing: "metered",
        deliveryTypes: ["generated_video"],
        description: "按预算生成少量关键镜头。",
        modes: ["文生视频", "9:16"],
        estimatedCnyPerClip: 8,
      },
      {
        id: "kling-video-v1",
        capability: "asset.prepare",
        label: "Kling 可灵",
        available: false,
        kind: "external",
        status: "planned",
        billing: "metered",
        deliveryTypes: ["generated_video"],
        description: "账号权限确认后启用。",
      },
    ]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue(trendSources);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([{
      id: "newsnow",
      label: "NewsNow",
      kind: "aggregator",
      status: "ready",
      lastCheckedAt: "2026-08-28T10:00:00.000Z",
    }]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const assetSection = (await screen.findByRole("heading", { name: "图库与画面生成" })).closest("section");
    expect(assetSection).not.toBeNull();
    expect(within(assetSection!).getByText("Seedance 视频生成")).toBeInTheDocument();
    expect(within(assetSection!).getByText("Kling 可灵")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "热点接入" })).toBeInTheDocument();
    expect(screen.getByText("抖音官方热点")).toBeInTheDocument();
    expect(screen.getAllByText("按量计费").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需要配置").length).toBeGreaterThan(0);
    expect(within(within(assetSection!).getByText("Seedance 视频生成").closest("article")!).getByText("已配置")).toBeInTheDocument();
    expect(screen.getByLabelText("NewsNow 内部服务已连接")).toBeInTheDocument();
  });

  it("presents unconnected trend sources as an administrator task and keeps the page free of internal operations language", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([
      ...trendSources,
      {
        id: "dailyhot-import",
        label: "DailyHotApi",
        kind: "import" as const,
        status: "needs_config" as const,
        description: "本地统一 JSON / RSS 热榜接口，补充抖音、微博、快手、百度和垂类榜单。",
        cadence: "建议 30-60 分钟",
        requirement: "运行 make setup-local-trends",
      },
      {
        id: "newrank-import",
        label: "新榜数据",
        kind: "commercial" as const,
        status: "manual_only" as const,
        description: "在商业数据合同确定前，以 CSV/JSON 导入保存来源边界。",
        cadence: "按购买方案",
        requirement: "需要商业数据授权",
      },
    ]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    await screen.findByText("抖音官方热点");
    expect(screen.getAllByText("该热点源尚未由管理员接入，请联系管理员")).toHaveLength(2);
    expect(screen.getByText("需要商业数据授权")).toBeInTheDocument();
    const pageText = document.body.textContent ?? "";
    expect(pageText).not.toMatch(/\bmake\b/i);
    expect(pageText).not.toMatch(/\bscope\b/i);
    expect(pageText).not.toContain("适配器");
    expect(pageText).not.toContain("环境变量");
    expect(pageText).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9_]+)+\b/);
    expect(screen.queryByText(/运行底座/)).not.toBeInTheDocument();
  });

  it("describes the production environment by creative impact instead of an internal runtime count", async () => {
    const capabilitiesApi = vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([
      { id: "python", label: "Python worker", category: "runtime", state: "ready", evidence: "项目 Python 3.11 与 Pillow 已通过烟雾测试" },
      { id: "ffmpeg", label: "FFmpeg 音视频引擎", category: "runtime", state: "ready", evidence: "ffmpeg 与 ffprobe 均可用" },
      { id: "docker", label: "Docker 本地服务", category: "runtime", state: "ready", evidence: "Docker CLI 已安装" },
      { id: "macos-voices", label: "macOS 中文音色", category: "voice", state: "ready", evidence: "发现 3 个中文音色" },
      { id: "minimax-tts", label: "MiniMax 云端声音演员", category: "voice", state: "ready", evidence: "已配置 8 个精选中文音色" },
    ] satisfies StudioLocalCapability[]);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));

    const { unmount } = render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByText("制作环境已就绪：画面处理、配音和成片合成可以直接使用。")).toBeInTheDocument();
    expect(screen.queryByText(/运行底座/)).not.toBeInTheDocument();
    unmount();

    capabilitiesApi.mockResolvedValue([
      { id: "python", label: "Python worker", category: "runtime", state: "ready", evidence: "python3 可执行文件" },
      { id: "ffmpeg", label: "FFmpeg 音视频引擎", category: "runtime", state: "missing", evidence: "需要 ffmpeg 与 ffprobe" },
      { id: "docker", label: "Docker 本地服务", category: "runtime", state: "ready", evidence: "Docker CLI 已安装" },
      { id: "macos-voices", label: "macOS 中文音色", category: "voice", state: "ready", evidence: "发现 3 个中文音色" },
      { id: "minimax-tts", label: "MiniMax 云端声音演员", category: "voice", state: "missing", evidence: "需要 MINIMAX_API_KEY" },
    ] satisfies StudioLocalCapability[]);
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const summary = await screen.findByText(/制作环境有 2 处未就绪/);
    expect(summary).toHaveTextContent("成片合成、云端配音暂不可用或受限");
    expect(summary).toHaveTextContent("无法自行解决时请联系管理员");
    expect(document.body.textContent ?? "").not.toContain("MINIMAX_API_KEY");
    expect(screen.queryByText(/运行底座/)).not.toBeInTheDocument();
  });

  it("loads production configuration even when unrelated resource requests stall", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      roleProviderDefaults: {},
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
    });
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockReturnValue(new Promise(() => undefined));

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("combobox", { name: "默认导演角色" })).toBeInTheDocument();
    expect(screen.getAllByText("模板脚本").length).toBeGreaterThan(0);
    expect(screen.queryByText("正在读取创作默认值...")).not.toBeInTheDocument();
  });

  it("explains the real topic gates without presenting misleading score weights", async () => {
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const topicGates = await screen.findByLabelText("视频选题准入标准");
    expect(within(topicGates).getByText("明确观众收益")).toBeInTheDocument();
    expect(within(topicGates).getByText("前两秒钩子")).toBeInTheDocument();
    expect(within(topicGates).getByText("画面不可替代")).toBeInTheDocument();
    expect(within(topicGates).getByText("可追溯来源")).toBeInTheDocument();
    expect(within(topicGates).getByText("成本与价值匹配")).toBeInTheDocument();
    expect(within(topicGates).getByText("风险与形式匹配")).toBeInTheDocument();
    expect(screen.getByText(/只需维护账号定位、内容边界和来源标准，不需要调整评分权重/)).toBeInTheDocument();
    expect(topicGates).not.toHaveTextContent(/\d+%/);
  });

  it("keeps the configuration room focused on one editable category at a time", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    vi.spyOn(studioApi, "providers").mockResolvedValue(providers);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);

    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    const defaultsLink = screen.getByRole("link", { name: "创作默认" });
    const rolesLink = screen.getByRole("link", { name: "制作分工" });
    expect(defaultsLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "新建制作默认值" }).closest("section")).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("heading", { name: "按角色配置生产能力" }).closest("section")).not.toHaveAttribute("data-active");

    await user.click(rolesLink);

    expect(rolesLink).toHaveAttribute("aria-current", "page");
    expect(defaultsLink).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#production-roles");
    expect(screen.getByRole("heading", { name: "按角色配置生产能力" }).closest("section")).toHaveAttribute("data-active", "true");
  });

  it("persists voice and creation choices while presenting model recommendations", async () => {
    const user = userEvent.setup();
    const readyProviders: StudioProvider[] = [
      ...providers,
      { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" as const, status: "ready" as const, billing: "free" as const },
      { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external" as const, status: "ready" as const, billing: "free" as const, deliveryTypes: ["stock_video"] as const },
      {
        id: "minimax-video-v1",
        capability: "asset.prepare",
        label: "MiniMax 视频生成",
        available: true,
        kind: "external" as const,
        status: "ready" as const,
        billing: "metered" as const,
        deliveryTypes: ["generated_video"] as const,
        defaultModelId: "MiniMax-Hailuo-2.3",
        modelProfiles: [
          { id: "MiniMax-Hailuo-2.3", providerId: "minimax-video-v1", providerFamily: "minimax", label: "MiniMax Hailuo 2.3", description: "经济关键镜头", available: true, recommended: true, taskTypes: ["text-to-video"] },
          { id: "MiniMax-H3", providerId: "minimax-video-v1", providerFamily: "minimax", label: "MiniMax H3", description: "高质量关键镜头", available: true, taskTypes: ["text-to-video"] },
        ],
      },
    ];
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    vi.spyOn(studioApi, "providers").mockResolvedValue(readyProviders);
    vi.spyOn(studioApi, "voices").mockResolvedValue([
      { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos" },
    ]);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(initialSettings);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(async (patch) => ({
      ...initialSettings,
      ...patch,
      productionDefaults: { ...initialSettings.productionDefaults, ...patch.productionDefaults },
      topicStrategy: { ...initialSettings.topicStrategy, ...patch.topicStrategy },
    }));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("button", { name: "已是制作默认" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "新建制作默认值" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "发布渠道" })).toBeInTheDocument();
    const recipeSelect = screen.getByRole("combobox", { name: "默认画面来源策略" });
    expect(within(recipeSelect).getAllByRole("option")).toHaveLength(2);
    expect(recipeSelect).toHaveValue("free-stock");
    expect(within(recipeSelect).queryByRole("option", { name: "经济日更" })).not.toBeInTheDocument();
    expect(within(recipeSelect).queryByRole("option", { name: "开放精品生成" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /高级微调/ }));
    fireEvent.change(screen.getByRole("slider", { name: "语速" }), { target: { value: "190" } });
    await user.click(await screen.findByRole("button", { name: "设为制作默认" }));
    expect(update).toHaveBeenCalledWith({ voiceDirection: { ...initialSettings.voiceDirection, rate: 190 } });

    const assetSection = screen.getByRole("heading", { name: "图库与画面生成" }).closest("section");
    expect(assetSection).not.toBeNull();
    expect(within(assetSection!).getByText("Pexels 图库")).toBeInTheDocument();
    expect(within(assetSection!).getByText("AI 逐镜选择画面来源")).toBeInTheDocument();
    expect(within(assetSection!).queryByRole("button", { name: "设为默认" })).not.toBeInTheDocument();
    const stockGroup = screen.getByText("图库实拍").closest("section");
    const generatedVideoGroup = screen.getByText("AI 生视频").closest("section");
    const routingGroup = screen.getByText("逐镜选择画面来源").closest("section");
    const editorialGroup = screen.getByText("主动排版画面").closest("section");
    expect(stockGroup).not.toBeNull();
    expect(generatedVideoGroup).not.toBeNull();
    expect(routingGroup).not.toBeNull();
    expect(editorialGroup).not.toBeNull();
    expect(within(stockGroup!).getByText("Pexels 图库")).toBeInTheDocument();
    expect(within(generatedVideoGroup!).getByText("MiniMax 视频生成")).toBeInTheDocument();
    expect(within(routingGroup!).getByText("AI 逐镜选择画面来源")).toBeInTheDocument();
    expect(within(editorialGroup!).getByText("本地编辑画面")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "画面来源" }));
    expect(screen.queryByRole("combobox", { name: "MiniMax 视频生成 首选模型" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存画面模型" })).not.toBeInTheDocument();
    expect(within(generatedVideoGroup!).getByText("MiniMax Hailuo 2.3")).toBeInTheDocument();
    expect(within(generatedVideoGroup!).getByText("可用替补：MiniMax H3")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "默认导演角色" }), "documentary-observer");
    await user.selectOptions(screen.getByRole("combobox", { name: "默认目标平台" }), "bilibili");
    await user.click(screen.getByRole("button", { name: "保存创作默认" }));
    expect(update).toHaveBeenLastCalledWith({
      defaultRecipeId: "free-stock",
      productionDefaults: {
        directorProfileId: "documentary-observer",
        reviewMode: "manual",
        platform: "bilibili",
        durationSeconds: 24,
      },
    });
  });

  it("configures providers and models by production role instead of a flat provider registry", async () => {
    const user = userEvent.setup();
    const roleProviders: StudioProvider[] = [
      ...providers.filter((provider) => provider.id !== "codex-role-auditor-v1"),
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
        ],
      },
      { id: "codex-role-auditor-v1", capability: "role.audit", label: "Codex 独立质量审计", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol", modes: ["独立会话", "xhigh 推理", "最多三轮"] },
      { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 视觉审片", available: true, kind: "external", billing: "subscription" },
      { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 视觉审片", available: true, kind: "external", billing: "subscription" },
    ];
    const initialSettings = {
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" as const },
      defaultRecipeId: "economy-daily" as const,
      roleProviderDefaults: { script: "python-template-v1" },
      modelDefaults: {},
      topicStrategy: { customInstruction: "优先可拍题材。" },
      productionDefaults: { directorProfileId: "auto" as const, reviewMode: "manual" as const, platform: "douyin" as const, durationSeconds: 24 as const },
    };
    vi.spyOn(studioApi, "providers").mockResolvedValue(roleProviders);
    vi.spyOn(studioApi, "trendSources").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendServices").mockResolvedValue([]);
    vi.spyOn(studioApi, "trendSignals").mockResolvedValue([]);
    vi.spyOn(studioApi, "localCapabilities").mockResolvedValue([]);
    vi.spyOn(studioApi, "settings").mockResolvedValue(initialSettings);
    vi.spyOn(studioApi, "publishTargets").mockResolvedValue([]);
    vi.spyOn(studioApi, "resourceManifest").mockResolvedValue({
      generatedAt: "2026-08-30T00:00:00.000Z",
      totalItems: 0,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
      items: [],
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 0,
        duplicateUses: 0,
        reusableCount: 0,
        needsReviewCount: 0,
        facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
        assets: [],
      },
    });
    const update = vi.spyOn(studioApi, "updateSettings").mockImplementation(async (patch) => ({
      ...initialSettings,
      ...patch,
      roleProviderDefaults: patch.roleProviderDefaults ?? initialSettings.roleProviderDefaults,
      modelDefaults: patch.modelDefaults ?? initialSettings.modelDefaults,
      productionDefaults: { ...initialSettings.productionDefaults, ...patch.productionDefaults },
      topicStrategy: { ...initialSettings.topicStrategy, ...patch.topicStrategy },
    }));
    render(<MemoryRouter><ResourcesPage /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "按角色配置生产能力" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "编剧首选能力" })).toHaveValue("python-template-v1");
    expect(screen.getByText(/只有确认首选请求尚未开始.*连接故障.*无输出/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去画面来源配置" })).toHaveAttribute("href", "#visual-providers");
    expect(screen.getByRole("link", { name: "去声音演员表配置" })).toHaveAttribute("href", "#voice-casting");
    expect(screen.queryByRole("combobox", { name: "画面执行首选能力" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "配音执行首选能力" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "编剧首选能力" }), "codex-screenwriter-v1");
    expect(screen.queryByRole("combobox", { name: "AI 编剧首选模型" })).not.toBeInTheDocument();
    const roleSection = screen.getByRole("heading", { name: "按角色配置生产能力" }).closest("section");
    expect(within(roleSection!).getByText("GPT-5.6 Terra")).toBeInTheDocument();
    expect(within(roleSection!).getByText("故障替补：GPT-5.6 Sol")).toBeInTheDocument();
    expect(within(roleSection!).getByText(/中途画面预检优先使用首选模型.*连接故障.*最终成片由 DeepSeek 基于抽帧证据完成独立质量复核/)).toBeInTheDocument();
    expect(screen.getByText("独立质量复核")).toBeInTheDocument();
    expect(screen.getByText("独立复核 · 最多三轮")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存角色配置" }));

    expect(update).toHaveBeenLastCalledWith({
      roleProviderDefaults: expect.objectContaining({ script: "codex-screenwriter-v1" }),
    });
  });
});

function knowledgeTemplate(): StudioTemplate {
  return {
    id: "knowledge-explainer", version: 2, status: "published", name: "知识解释", description: "讲清一个问题。",
    category: "knowledge", platforms: ["douyin"], durationSeconds: 24, automationLevel: "assisted",
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
    createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z", builtIn: true,
  };
}
