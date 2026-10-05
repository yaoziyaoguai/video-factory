import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioProvider, StudioProductionInput } from "../src/shared/api.js";
import { studioApi } from "../src/client/api.js";
import { NewRunDialog } from "../src/client/components/NewRunDialog.js";

const providers: StudioProvider[] = [
  { id: "python-template-v1", capability: "script.draft", label: "模板脚本", available: true, kind: "local" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "AI 视觉导演", available: true, kind: "local" },
  { id: "ai-shot-router-v1", capability: "asset.prepare", label: "AI 逐镜路由", available: true, kind: "local" },
  { id: "pexels-stock-v1", capability: "asset.prepare", label: "Pexels 视频", available: true, kind: "external", status: "ready", deliveryTypes: ["stock_video", "stock_image"] },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "macOS 系统配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "FFmpeg 竖屏渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "本地技术审片", available: true, kind: "local" },
  { id: "codex-visual-review-v1", capability: "quality.review.visual", label: "Codex 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "gpt-5.6-sol" },
  { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "DeepSeek 视觉审片", available: true, kind: "external", billing: "subscription", defaultModelId: "deepseek-flash" },
];

const caseInitialValues = {
  title: "",
  angle: "用这条 TED 演讲的叙事结构，讲清楚注意力被碎片化吞掉的过程：从一次实验出发，先给现象，再给因果，最后给出可执行的三个步骤，全程用生活场景对照，不用专业术语；开头用一次真实的分心瞬间切入，中段对照实验数据与日常场景的差别，结尾回到创作者可立刻采用的两个小动作，并说明为什么它们比意志力可靠。",
  creationContext: { origin: "case" as const, opportunityId: "", caseSelectionId: "case-sel-1" },
};

function renderCaseDialog(overrides: { providers?: StudioProvider[]; initialDataReady?: boolean; onSubmit?: (input: StudioProductionInput) => Promise<void> } = {}) {
  const onSubmit = overrides.onSubmit ?? vi.fn(async () => undefined);
  const view = render(<NewRunDialog
    open
    providers={overrides.providers ?? providers}
    initialValues={caseInitialValues}
    {...(overrides.initialDataReady === undefined ? {} : { initialDataReady: overrides.initialDataReady })}
    onClose={() => undefined}
    onSubmit={onSubmit}
  />);
  return { ...view, onSubmit: onSubmit as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [] });
  vi.spyOn(studioApi, "voices").mockResolvedValue([
    { id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true },
  ]);
  vi.spyOn(studioApi, "voicePreview").mockResolvedValue("blob:default-preview");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// CLOUD-08/P3（V10）：案例入口标题留空由用户命名，角度保留完整意图；摘要不再三重推导。
describe("case preparation form", () => {
  it("opens with an empty required title, the full intent as angle, and a naming hint", () => {
    renderCaseDialog();
    const title = screen.getByLabelText(/视频标题/) as HTMLInputElement;
    const angle = screen.getByLabelText(/内容角度/) as HTMLInputElement;
    expect(title.value).toBe("");
    expect(title.required).toBe(true);
    expect(angle.value).toBe(caseInitialValues.angle);
    expect(screen.getByText("给这次创作起个标题；完整想法已放在内容角度")).toBeInTheDocument();
    // 不借用原作品题目，也不预填一个机械标题。
    expect(title.value).not.toContain("TED");
  });

  it("shows filled creative goals only: no derived promise/payoff and an expandable angle excerpt", async () => {
    renderCaseDialog();
    expect(screen.getByText("已填写的创作目标")).toBeInTheDocument();
    expect(screen.getAllByText("待填写").length).toBeGreaterThanOrEqual(1); // 标题/受众留空如实说待填写
    const excerpt = screen.getByText("内容角度（节选）", { exact: true });
    expect(excerpt).toBeInTheDocument();
    // 角度超过 120 码点：默认节选＋可展开原文，不再伪装成开头承诺/画面/结尾三段。
    expect(screen.queryByText("开头承诺")).toBeNull();
    expect(screen.queryByText("结尾收益")).toBeNull();
    expect(screen.queryByText(/待填写开头承诺/)).toBeNull();
    await userEvent.click(screen.getByText("展开原文"));
    // 展开后节选与全文同时可见（同一段文字的两处呈现）。
    expect(screen.getAllByText(new RegExp(caseInitialValues.angle.slice(0, 20))).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the derived summary for non-case entries (series hook/payoff untouched)", () => {
    render(<NewRunDialog
      open
      providers={providers}
      initialValues={{
        title: "系列标题",
        angle: "系列角度",
        audience: "创作者",
        seriesContext: { seriesId: "s1", episodeNumber: 3, episode: { hook: "系列钩子", payoff: "系列收益" } } as never,
      }}
      onClose={() => undefined}
      onSubmit={vi.fn(async () => undefined)}
    />);
    expect(screen.getByText("系统整理的创作目标")).toBeInTheDocument();
    expect(screen.getByText("系列钩子")).toBeInTheDocument();
    expect(screen.getByText("系列收益")).toBeInTheDocument();
    expect(screen.queryByText("已填写的创作目标")).toBeNull();
    expect(screen.queryByText("给这次创作起个标题；完整想法已放在内容角度")).toBeNull();
  });

  it("blocks submission with an empty title and creates no run (V11)", async () => {
    vi.spyOn(HTMLFormElement.prototype, "reportValidity").mockImplementation(() => false);
    const { onSubmit } = renderCaseDialog();
    const start = screen.getByRole("button", { name: /开始前期构思/ });
    expect(start).not.toBeDisabled();
    await userEvent.click(start);
    await waitFor(() => expect(HTMLFormElement.prototype.reportValidity).toHaveBeenCalled());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/视频标题/)).toHaveFocus();
  });

  it("submits the user's typed title with the edited full angle and the case binding", async () => {
    const { onSubmit } = renderCaseDialog();
    await userEvent.type(screen.getByLabelText(/视频标题/), "注意力去哪儿了");
    const angle = screen.getByLabelText(/内容角度/);
    await userEvent.clear(angle);
    await userEvent.type(angle, "用户改写后的完整角度");
    await userEvent.type(screen.getByLabelText(/目标受众/), "短视频创作者");
    await userEvent.click(screen.getByRole("button", { name: /开始前期构思/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const input = onSubmit.mock.calls[0]![0] as StudioProductionInput;
    expect(input.title).toBe("注意力去哪儿了");
    expect(input.angle).toBe("用户改写后的完整角度");
    expect(input.creationContext).toEqual({ origin: "case", opportunityId: "", caseSelectionId: "case-sel-1" });
  });

  it("does not overwrite typed fields when providers arrive late (V11)", async () => {
    vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 0, templates: [] });
    vi.spyOn(studioApi, "voices").mockResolvedValue([]);
    // 表单在 initialDataReady 时立即可填（目录可以晚到）；已填值不因目录/设置后到被重置。
    const { rerender } = render(<NewRunDialog
      open
      providers={[]}
      initialValues={caseInitialValues}
      initialDataReady
      onClose={() => undefined}
      onSubmit={vi.fn(async () => undefined)}
    />);
    await userEvent.type(screen.getByLabelText(/视频标题/), "我起的标题");
    const angle = screen.getByLabelText(/内容角度/);
    await userEvent.clear(angle);
    await userEvent.type(angle, "我改过的角度");
    rerender(<NewRunDialog
      open
      providers={providers}
      initialValues={caseInitialValues}
      initialDataReady
      onClose={() => undefined}
      onSubmit={vi.fn(async () => undefined)}
    />);
    await waitFor(() => expect(screen.getByLabelText(/视频标题/)).toHaveValue("我起的标题"));
    expect(screen.getByLabelText(/内容角度/)).toHaveValue("我改过的角度");
  });
});
