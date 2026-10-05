import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioArtifact, StudioIntervention, StudioNarrationPlanPreview, StudioNode, StudioRunDetail } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { RunWorkbench } from "../src/client/components/RunWorkbench.js";
import { decisionConsequenceView } from "../src/client/components/decision-consequence.js";

// CLOUD-02/P1.2：决定栏说明必须来自结构化停点事实，按执行包 P1.2 表逐行核对。
describe("decision consequence table", () => {
  it("explains visual-review adoption of the verified film as reuse, not a new render", () => {
    const view = decisionConsequenceView({
      nodeId: "visual-review",
      continuationScope: "rendered_video_optional_review",
      hasPublishPackageNode: true,
    });
    expect(view.consequence).toContain("复用这份已核实的成片进入人工终审");
    expect(view.consequence).toContain("不会重买素材、重做配音、重新渲染");
    expect(view.costNote).not.toContain("免费");
    expect(view.costNote).toContain("仍按原记录独立待核");
    expect(view.rerunNote).toContain("不重跑渲染与配音");
  });

  it("separates final-review approval from later copy-generation costs when publish-package exists", () => {
    const withPublish = decisionConsequenceView({ nodeId: "final-review", hasPublishPackageNode: true });
    expect(withPublish.consequence).toContain("不会重做现有画面与配音");
    expect(withPublish.consequence).toContain("文案模型可能产生新的调用费用");
    expect(withPublish.costNote).not.toContain("免费");
    const withoutPublish = decisionConsequenceView({ nodeId: "final-review", hasPublishPackageNode: false });
    expect(withoutPublish.consequence).toContain("没有发布包步骤");
    expect(withoutPublish.costNote).toContain("无后续自动费用");
  });

  it("does not let a publish-package adoption masquerade as a new final-review signature", () => {
    const view = decisionConsequenceView({ nodeId: "publish-package", hasPublishPackageNode: true });
    expect(view.consequence).toContain("不是新的成片终审签字");
    expect(view.consequence).toContain("不会自动发布到外部平台");
    expect(view.rerunNote).toContain("不重跑当前节点");
  });

  it("keeps boundary continuation honest about later metered services", () => {
    const view = decisionConsequenceView({ nodeId: "voice", boundary: "node-complete", hasPublishPackageNode: false });
    expect(view.consequence).toContain("不会重跑当前节点");
    expect(view.costNote).toContain("依已选服务规则计费");
    expect(view.costNote).not.toContain("免费");
  });

  it("keeps incomplete source review reuse without promising free later voice work", () => {
    const view = decisionConsequenceView({ nodeId: "asset-source-review", kind: "source_review_retry", reviewStatus: "incomplete", hasPublishPackageNode: false });
    expect(view.consequence).toContain("复用已生成的画面");
    expect(view.costNote).toContain("不扩大");
    expect(view.costNote).not.toContain("无后续配音费");
  });

  it("never applies the optional-review adoption wording to unknown paid outcomes", () => {
    const view = decisionConsequenceView({ nodeId: "visual-review", kind: "source_review_retry", reviewStatus: "unknown_or_unsafe", continuationScope: "rendered_video_optional_review", hasPublishPackageNode: true });
    expect(view.consequence).not.toContain("复用这份已核实的成片");
    expect(view.costNote).toBe("不自动新增费用");
    expect(view.rerunNote).toContain("不自动重发");
  });

  it("falls back to a conservative wording instead of inventing quotes for unknown stops", () => {
    const view = decisionConsequenceView({ nodeId: "some-future-node", hasPublishPackageNode: false });
    expect(view.rerunNote).toBe("请查看本次动作说明");
    expect(view.costNote).toBe("后续服务按现有授权与配置计费");
  });
});

// CR1（2026-10-05 复审反例 AP1/AP1b）：真实 Pipeline 的成片续看与人工终审停点本身携带
// reviewStatus=incomplete（production-pipeline.ts 恢复续看/可选审片未决/终审停点
// 2311、2324、7202、13637、13709、14116/14121）。“incomplete 先于节点/范围分类”会把
// 它们错误替换成素材预检的“后续配音、渲染仍计费”话术。分类必须按证据域/节点/动作，
// 输入使用真实干预的全字段组合，不能省掉 incomplete 让测试假绿。
describe("decision consequence table with incomplete review status carried by real stops", () => {
  it("AP1: rendered-video continuation stop keeps the reuse-into-final-review wording despite incomplete", () => {
    // 真实形态：production-pipeline.ts:2324 恢复的人工审看停点（nodeId=visual-review，
    // reviewStatus=incomplete，continuationScope=rendered_video_optional_review）。
    const actual = decisionConsequenceView({
      nodeId: "visual-review", reviewStatus: "incomplete",
      continuationScope: "rendered_video_optional_review", hasPublishPackageNode: true,
    });
    expect(actual.consequence).toContain("进入人工终审");
    expect(actual.consequence).toContain("不会重买素材、重做配音、重新渲染");
    expect(actual.costNote).not.toContain("后续配音、渲染");
  });

  it("AP1 optional-review uncertain shapes (13637/13709/14121) also reuse the film, not source-preflight costs", () => {
    // 审片请求仍在核实（providerOutcomeKnown=false）：同样是复用当前成片进入人工终审。
    const actual = decisionConsequenceView({
      nodeId: "visual-review", reviewStatus: "incomplete",
      continuationScope: "rendered_video_optional_review", hasPublishPackageNode: true,
    });
    expect(actual.rerunNote).toContain("不重跑渲染与配音");
    expect(actual.costNote).toContain("仍按原记录独立待核");
  });

  it("AP1b: final review inheriting incomplete explains the publish-copy consequence", () => {
    // 真实形态：production-pipeline.ts:7202 人工终审停点（机器审片未取得完整有效结论，
    // optionalContinuation 时携带 continuationScope=rendered_video_optional_review）。
    const actual = decisionConsequenceView({
      nodeId: "final-review", reviewStatus: "incomplete",
      continuationScope: "rendered_video_optional_review", hasPublishPackageNode: true,
    });
    expect(actual.consequence).toContain("发布文案");
    expect(actual.consequence).toContain("不会自动发布");
    expect(actual.costNote).not.toContain("后续配音、渲染");
  });

  it("final review with incomplete but no continuation scope still explains its own consequence", () => {
    // 7202 无 optionalContinuation 的停点不带 continuationScope。
    const withPublish = decisionConsequenceView({ nodeId: "final-review", reviewStatus: "incomplete", hasPublishPackageNode: true });
    expect(withPublish.consequence).toContain("文案模型可能产生新的调用费用");
    const withoutPublish = decisionConsequenceView({ nodeId: "final-review", reviewStatus: "incomplete", hasPublishPackageNode: false });
    expect(withoutPublish.consequence).toContain("没有发布包步骤");
    expect(withoutPublish.costNote).not.toContain("后续配音、渲染");
  });

  it("source-preflight incomplete (kind source_review_retry) keeps the later voice/render metering wording", () => {
    // 真实形态：production-pipeline.ts:6916 素材预检 canAcceptIncomplete 停点——
    // 只有这里的“后续配音、渲染仍按已选服务规则计费”才是正确话术。
    const actual = decisionConsequenceView({
      nodeId: "asset-source-review", kind: "source_review_retry",
      reviewStatus: "incomplete", hasPublishPackageNode: false,
    });
    expect(actual.consequence).toContain("复用已生成的画面");
    expect(actual.costNote).toContain("后续配音、渲染仍按已选服务规则计费");
  });

  it("incomplete at an unrecognized node falls back conservatively instead of promising source-preflight semantics", () => {
    // 未知节点不编造“只重试审查/后续配音渲染”的具体承诺。
    const actual = decisionConsequenceView({ nodeId: "some-future-node", reviewStatus: "incomplete", hasPublishPackageNode: false });
    expect(actual.rerunNote).toBe("请查看本次动作说明");
    expect(actual.costNote).toBe("后续服务按现有授权与配置计费");
  });
});

const planFixture = (): StudioNarrationPlanPreview["plan"] => ({
  version: "video-factory/narration-plan-v2",
  mode: "continuous_groups",
  script: { sha256: "a".repeat(64) },
  visualPlan: { sha256: "b".repeat(64), fps: 30, totalFrames: 600 },
  source: { normalization: "narration-text-v1", sourceContextId: "sc-decision-test", canonicalSourceSha256: "c".repeat(64) },
  edgeTrim: "none",
  subtitleMode: "provider_sentence",
  silences: [],
  groups: [
    { id: "ng-1", sourceRange: { baseGroupId: "nb-1", startCodePoint: 0, endCodePoint: 6 }, sourceScenePositions: [1],
      text: "第一句。", window: { startFrame: 0, endFrame: 90 }, placement: { anchor: "start", offsetFrames: 0 } },
  ],
} as never);

const voiceNode: StudioNode = {
  id: "voice", label: "声音", status: "succeeded", artifactIds: ["art-plan", "art-audio"], qualityGateResults: [],
  output: { layoutKey: "layout-current", voiceOperationId: "tts-original-op" },
  outputState: { effectiveVersionId: "version-voice-1", stale: false, versions: [
    { id: "version-voice-1", artifactIds: ["art-plan", "art-audio"], schemaVersion: "video-factory/voiceover-plan-v3" },
  ] },
} as unknown as StudioNode;

const artifacts: StudioArtifact[] = [
  { id: "art-plan", kind: "voiceover_plan", sha256: "p".repeat(64), sizeBytes: 10, contentType: "application/json", producerNodeId: "voice", createdAt: "" },
  { id: "art-audio", kind: "voiceover", sha256: "q".repeat(64), sizeBytes: 20, contentType: "audio/mp4", producerNodeId: "voice", createdAt: "" },
  { id: "film-current", kind: "render", contentUrl: "/media/film.mp4", contentType: "video/mp4", createdAt: "2026-10-05T00:00:00Z", producerNodeId: "render" },
];

function finalReviewRun(intervention: Partial<StudioIntervention> & Pick<StudioIntervention, "id" | "reason" | "options">): StudioRunDetail {
  return {
    id: "run-decision", title: "决定栏测试", status: "needs_human", platform: "douyin", durationSeconds: 20,
    startedAt: "2026-10-05T10:00:00.000Z", currentNodeId: "final-review", revision: 8,
    angle: "测试角度", audience: "创作者", nicheSlug: "decision", reviewMode: "manual",
    activeIntervention: {
      nodeId: "final-review", createdAt: "2026-10-05T10:05:00.000Z",
      ...intervention,
    } as StudioIntervention,
    nodes: [
      { id: "render", label: "渲染", status: "succeeded", artifactIds: ["film-current"], qualityGateResults: [] },
      voiceNode,
      { id: "final-review", label: "人工终审", status: "needs_human", artifactIds: [], qualityGateResults: [] },
      { id: "publish-package", label: "发布包", status: "pending", artifactIds: [], qualityGateResults: [] },
    ],
    artifacts,
    decisions: [],
    videoArtifactId: "film-current",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// CLOUD-03/P1.3：终审可选时间工具默认折叠、主动作在前、折叠不卸载不丢状态。
describe("final review optional timing tool", () => {
  it("renders the main decision before the collapsed optional timing tool and opens it by keyboard", async () => {
    vi.spyOn(studioApi, "narrationPlan").mockResolvedValue({
      expectedRunRevision: 8, confirmed: true, sourceContextId: "sc-decision-test",
      plan: planFixture(),
      editorContext: { mode: "voice_stop", savedPlanStatus: "current" },
    } as never);
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} onRequestNarrationRevision={async () => undefined} /></MemoryRouter>);

    const aside = screen.getByRole("complementary", { name: "审片与产物" });
    const details = aside.querySelector("details.optional-timing-tool") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    const summary = within(details).getByText(/复用原配音调整时间，完成后回到试听确认/);
    expect(summary).toBeInTheDocument();

    // 主动作（人工终审决定区）在 DOM 上先于可选工具出现。
    const decisionPanel = aside.querySelector(".intervention-panel") as HTMLElement | null;
    expect(decisionPanel).not.toBeNull();
    expect(decisionPanel?.textContent).toContain("需要你的判断");
    expect((decisionPanel as HTMLElement).compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // summary 是可聚焦的开关（真实浏览器支持 Enter/Space；jsdom 只模拟 click 切换）。
    expect(summary.closest("summary")).toBe(summary);
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(await within(details).findByText(/不重新购买、不改文本、不改音色/)).toBeInTheDocument();
  });

  it("keeps the editor mounted and its unsaved input visible in the summary when collapsed", async () => {
    vi.spyOn(studioApi, "narrationPlan").mockResolvedValue({
      expectedRunRevision: 8, confirmed: true, sourceContextId: "sc-decision-test",
      plan: planFixture(),
      editorContext: { mode: "voice_stop", savedPlanStatus: "current" },
    } as never);
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    const { container } = render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} onRequestNarrationRevision={async () => undefined} /></MemoryRouter>);

    const details = container.querySelector("details.optional-timing-tool") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    details.open = true;
    await waitFor(() => expect(screen.getByLabelText("第 1 段窗口开始秒")).toBeInTheDocument());
    const editorBefore = container.querySelector(".narration-timing-editor") as HTMLElement;
    const input = screen.getByLabelText("第 1 段窗口开始秒");
    await userEvent.clear(input);
    await userEvent.type(input, "1.5");

    // 折叠后编辑器仍挂载在同一 DOM 节点（未卸载重挂），摘要处显露未保存修改。
    details.open = false;
    expect(details.open).toBe(false);
    const editorAfter = container.querySelector(".narration-timing-editor") as HTMLElement;
    expect(editorAfter).toBe(editorBefore);
    expect(editorAfter).toContainElement(screen.getByLabelText("第 1 段窗口开始秒"));
    expect(screen.getByText(/复用原配音调整时间，完成后回到试听确认（.*有未保存修改/)).toBeInTheDocument();

    // 重新展开后输入仍在。
    details.open = true;
    expect(details.open).toBe(true);
    expect(screen.getByLabelText("第 1 段窗口开始秒")).toHaveValue("1.5");
  });

  it("keeps a failed plan load visible in the closed summary and exposes the error on opening", async () => {
    vi.spyOn(studioApi, "narrationPlan").mockRejectedValue(new Error("本地声音方案暂时无法读取"));
    const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    const { container } = render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const details = container.querySelector<HTMLDetailsElement>(".optional-timing-tool")!;
    const summary = details.querySelector("summary")!;
    await waitFor(() => expect(summary).toHaveTextContent("有错误待处理"));
    expect(details.open).toBe(false);
    await userEvent.click(summary);
    expect(within(details).getByRole("alert")).toHaveTextContent("本地声音方案暂时无法读取");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["read", "write"] as const)("surfaces draft storage %s failure in the closed summary without losing in-memory input", async (mode) => {
    vi.spyOn(studioApi, "narrationPlan").mockResolvedValue({
      expectedRunRevision: 8, confirmed: true, sourceContextId: "sc-decision-test",
      plan: planFixture(), editorContext: { mode: "voice_stop", savedPlanStatus: "current" },
    } as never);
    const dispatch = vi.spyOn(studioApi, "requestNarrationRevision");
    if (mode === "read") vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage read denied"); });
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    const { container } = render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const details = container.querySelector<HTMLDetailsElement>(".optional-timing-tool")!;
    const summary = details.querySelector("summary")!;
    await userEvent.click(summary);
    const input = await screen.findByLabelText("第 1 段留空秒");
    if (mode === "write") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage quota"); });
    fireEvent.change(input, { target: { value: "0.5" } });
    await userEvent.click(summary);
    await waitFor(() => expect(summary).toHaveTextContent("本机草稿保存失败"));
    expect(summary).toHaveTextContent("有未保存修改");
    expect(details.open).toBe(false);
    await userEvent.click(summary);
    expect(input).toHaveValue("0.5");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a pending adjustment visible while collapsed and queries the same operation before any resubmission", async () => {
    vi.spyOn(studioApi, "narrationPlan").mockResolvedValue({
      expectedRunRevision: 8, confirmed: true, sourceContextId: "sc-decision-test",
      plan: planFixture(), editorContext: { mode: "voice_stop", savedPlanStatus: "current" },
    } as never);
    const dispatch = vi.spyOn(studioApi, "requestNarrationRevision").mockRejectedValue(new Error("响应中断，结果未知"));
    let settled = false;
    const query = vi.spyOn(studioApi, "narrationRelayoutOperation").mockImplementation(async (_runId, requestId) => settled
      ? { requestId, state: "applied", requestDigest: "d".repeat(64), resultVoiceVersionId: "version-voice-2", isCurrent: true }
      : { requestId, state: "reserved", requestDigest: "d".repeat(64), isCurrent: false });
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    const { container } = render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const details = container.querySelector<HTMLDetailsElement>(".optional-timing-tool")!;
    const summary = details.querySelector("summary")!;
    await userEvent.click(summary);
    await screen.findByLabelText("第 1 段留空秒");
    await userEvent.click(screen.getByRole("button", { name: "应用时间调整并重新试听" }));
    await waitFor(() => expect(query).toHaveBeenCalledOnce());
    const request = dispatch.mock.calls[0]![1];
    expect(request.action).toBe("relayout_narration");
    if (request.action !== "relayout_narration") throw new Error("expected relayout request");
    expect(query).toHaveBeenLastCalledWith(run.id, request.requestId);
    const editor = details.querySelector(".narration-timing-editor");
    await userEvent.click(summary);
    expect(summary).toHaveTextContent("有待处理的时间调整");
    expect(summary).toHaveTextContent("有错误待处理");
    expect(details.open).toBe(false);
    expect(details.querySelector(".narration-timing-editor")).toBe(editor);
    expect(dispatch).toHaveBeenCalledOnce();
    settled = true;
    await userEvent.click(summary);
    await userEvent.click(screen.getByRole("button", { name: "继续此时间调整" }));
    await screen.findByText(/已用原配音完成本地时间调整/);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(run.id, request.requestId);
    expect(dispatch).toHaveBeenCalledOnce();
    await userEvent.click(summary);
    expect(summary).not.toHaveTextContent("有待处理的时间调整");
  });
});

// CLOUD-02 组件层：决定栏真实渲染时采用表驱动说明。
describe("current decision bar integration", () => {
  it("describes the visual-review adoption stop with the reuse wording, not the generic metered quote", () => {
    const run = finalReviewRun({
      id: "int-visual", reason: "审片未完成，可由你决定采用当前成片。", options: ["approve", "reject"],
    });
    // 真实续看停点携带 reviewStatus=incomplete（CR1/AP1）：组件层也不能退回预检计费话术。
    run.activeIntervention = { ...run.activeIntervention!, nodeId: "visual-review", reviewStatus: "incomplete", continuationScope: "rendered_video_optional_review" };
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const bar = screen.getByRole("status", { name: "当前决定" });
    expect(bar).toHaveTextContent("复用这份已核实的成片进入人工终审");
    expect(bar).not.toHaveTextContent("画面按报价授权");
    expect(bar).toHaveTextContent("不新增素材、配音或渲染费用");
    expect(bar).toHaveTextContent("仍按原记录独立待核");
  });

  it("mentions possible copy-generation costs after final approval when publish-package exists downstream", () => {
    const run = finalReviewRun({ id: "int-final", reason: "请完整观看成片后终审。", options: ["approve", "reject"] });
    render(<MemoryRouter><RunWorkbench run={run} decisionPending={false} onDecision={async () => undefined} /></MemoryRouter>);
    const bar = screen.getByRole("status", { name: "当前决定" });
    expect(bar).toHaveTextContent("文案模型可能产生新的调用费用");
    expect(bar.textContent).not.toMatch(/全程免费|零模型/);
  });
});
