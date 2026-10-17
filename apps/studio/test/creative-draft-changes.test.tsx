import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CreativeDraftChanges } from "../src/client/components/CreativeDraftChanges.js";

const first = { id: "stable-a", position: 1, narration: "原开头", duration: 8 };
const second = { id: "stable-b", position: 2, narration: "原结尾", duration: 6 };

describe("reliable draft comparisons", () => {
  it("uses stable ids when scenes move, showing exact field changes rather than pairing array indexes", async () => {
    render(<CreativeDraftChanges stage="script" previous={{ scenes: [first, second] }}
      current={{ scenes: [{ ...second, narration: "新结尾" }, first] }} />);
    expect(screen.getByText(/修改 1 项 · 排列顺序变化/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("只看改动"));
    expect(screen.getByRole("heading", { name: "第 2 段 · 已修改" })).toBeInTheDocument();
    expect(screen.getByText("原结尾")).toBeVisible();
    expect(screen.getByText("新结尾")).toBeVisible();
    expect(screen.queryByText("原开头")).not.toBeInTheDocument();
    expect(screen.getByText(/不代表已满足全部要求/)).toBeInTheDocument();
  });

  it("reports same text under a new identity as added and removed, never a matched unchanged segment", async () => {
    render(<CreativeDraftChanges stage="script" previous={{ scenes: [first] }}
      current={{ scenes: [{ ...first, id: "new-identity" }] }} />);
    expect(screen.getByText("新增 1 项 · 移除 1 项")).toBeInTheDocument();
    await userEvent.click(screen.getByText("只看改动"));
    expect(screen.getByRole("heading", { name: "第 1 段 · 新增" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "第 1 段 · 移除" })).toBeInTheDocument();
  });

  it.each([
    [{ scenes: [{ position: 1, narration: "旧" }] }, { scenes: [{ position: 1, narration: "新" }] }],
    [{ scenes: [first, { ...first, narration: "重复身份" }] }, { scenes: [first] }],
    [{ scenes: [first] }, { scenes: [{ ...first, id: "" }] }],
  ])("falls back to whole comparison for missing or duplicated ids", async (previous, current) => {
    render(<CreativeDraftChanges stage="script" previous={previous} current={current} />);
    expect(screen.getByText(/无法可靠逐项对应/)).toBeInTheDocument();
    expect(screen.queryByText("只看改动")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("对比前后整篇"));
    expect(screen.getByRole("heading", { name: "上一版" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "当前稿" })).toBeVisible();
  });

  it("does not treat a director's scenePosition as a stable cross-version identity", async () => {
    render(<CreativeDraftChanges stage="director" previous={{ shots: [{ scenePosition: 1, visibleAction: "旧画面" }] }}
      current={{ shots: [{ scenePosition: 1, visibleAction: "新画面" }] }} />);
    expect(screen.getByText(/无法可靠逐项对应/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("对比前后整篇"));
    expect(screen.getByText("旧画面")).toBeVisible();
    expect(screen.getByText("新画面")).toBeVisible();
  });

  it("compares free-form treatment without requiring segment identities", async () => {
    render(<CreativeDraftChanges stage="treatment" previous={{ concept: "原构思" }} current={{ concept: "新构思，保留开放结尾。" }} />);
    expect(screen.getByText("整体内容变化 1 项")).toBeInTheDocument();
    expect(screen.queryByText(/缺少可核对的段落身份/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("只看改动"));
    expect(screen.getByText("构思正文")).toBeVisible();
    expect(screen.getByText("原构思")).toBeVisible();
    expect(screen.getByText("新构思，保留开放结尾。")).toBeVisible();
  });

  it("does not report key order as a change, but recomputes for later versions and undo", async () => {
    const original = { scenes: [first] };
    const { rerender } = render(<CreativeDraftChanges stage="script" previous={original}
      current={{ scenes: [{ narration: "原开头", duration: 8, position: 1, id: "stable-a" }] }} />);
    expect(screen.getByText("当前稿与上一版内容相同")).toBeInTheDocument();
    const revised = { scenes: [{ ...first, narration: "新开头" }] };
    rerender(<CreativeDraftChanges stage="script" previous={original} current={revised} />);
    expect(screen.getByText("修改 1 项")).toBeInTheDocument();
    rerender(<CreativeDraftChanges stage="script" previous={revised} current={original} />);
    await userEvent.click(screen.getByText("只看改动"));
    const before = screen.getByText("之前").closest("dd")!;
    const after = screen.getByText("现在").closest("dd")!;
    expect(within(before).getByText("新开头")).toBeVisible();
    expect(within(after).getByText("原开头")).toBeVisible();
  });
});
