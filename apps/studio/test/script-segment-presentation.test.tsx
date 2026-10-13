import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { CreativeDraftReader } from "../src/client/components/CreativeDraftReader.js";

it("presents script source summaries, positions and durations while retaining segment and whole-draft reading", () => {
  const value = { scenes: [
    { id: "first", position: 3, duration: 6.5, narration: "清晨的光线越过窗台，落在还没有翻开的书页上。", visual_prompt: "窗边的书桌" },
    { id: "second", position: 8, duration: 11, narration: "他翻开书页，终于看到了那封迟到的来信。", visual_prompt: "书页里的信件" },
  ] };
  const original = JSON.stringify(value);
  render(<CreativeDraftReader stage="script" value={value} />);
  const nav = screen.getByRole("navigation", { name: "稿件段落" });
  expect(within(nav).getByText("脚本段落")).toBeInTheDocument();
  expect(within(nav).getByText("2 段")).toBeInTheDocument();
  const first = within(nav).getByRole("button", { name: "阅读第 3 段" });
  const second = within(nav).getByRole("button", { name: "阅读第 8 段" });
  expect(within(first).getByText("03")).toBeInTheDocument();
  expect(within(first).getByText(value.scenes[0]!.narration)).toBeInTheDocument();
  expect(within(first).getByText("6.5 秒")).toBeInTheDocument();
  expect(within(second).getByText("08")).toBeInTheDocument();
  expect(within(second).getByText(value.scenes[1]!.narration)).toBeInTheDocument();
  expect(within(second).getByText("11 秒")).toBeInTheDocument();
  expect(screen.getByText("窗边的书桌")).toBeInTheDocument();
  expect(screen.queryByText("书页里的信件")).not.toBeInTheDocument();

  fireEvent.click(second);
  expect(second).toHaveAttribute("aria-current", "true");
  expect(screen.getByText("第 8 段 · 11 秒")).toBeInTheDocument();
  expect(screen.getByText("书页里的信件")).toBeInTheDocument();
  expect(screen.queryByText("窗边的书桌")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看整篇" }));
  expect(screen.getByText("窗边的书桌")).toBeInTheDocument();
  expect(screen.getByText("书页里的信件")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "返回分段阅读" }));
  expect(screen.getByRole("button", { name: "阅读第 8 段" })).toHaveAttribute("aria-current", "true");
  expect(JSON.stringify(value)).toBe(original);
});

it.each([
  { stage: "treatment" as const, value: { progression: [{ beatId: "beat", purpose: "提出问题", viewerGain: "理解问题", narration: "不属于构思导航的旁白", duration: 9 }] }, button: "阅读内容推进 1" },
  { stage: "director" as const, value: { shots: [{ scenePosition: 4, visibleAction: "人物推开窗户", narration: "不属于导演导航的旁白", duration: 9 }] }, button: "阅读镜头 4" },
])("retains the existing number-only $stage navigation", ({ stage, value, button }) => {
  render(<CreativeDraftReader stage={stage} value={value} />);
  const nav = screen.getByRole("navigation", { name: "稿件段落" });
  expect(within(nav).queryByText("脚本段落")).not.toBeInTheDocument();
  expect(within(nav).getByRole("button", { name: button })).toHaveTextContent(/^01$/);
  expect(within(nav).queryByText("9 秒")).not.toBeInTheDocument();
});
