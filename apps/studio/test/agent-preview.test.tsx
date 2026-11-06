import { describe, expect, it } from "vitest";
import {
  createPreviewState,
  currentConversation,
  currentWork,
  hasReusableVoice,
  previewReducer,
} from "../src/client/agent/preview/preview-state.js";

describe("第一阶段：有限交互场景的阶段与版本语义", () => {
  it("只调整视频时保留脚本，下一版方案可沿用已有配音而不篡改旧方案报价", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    state = previewReducer(state, {
      type: "complete",
      workId: "trail-1",
      conversationId: "conversation-1",
    });
    expect(hasReusableVoice(currentWork(state)!)).toBe(false);
    state = previewReducer(state, {
      type: "send",
      text: "第二段太长了，缩短一点",
    });
    expect(currentWork(state)?.scripts).toHaveLength(1);
    expect(currentWork(state)?.phase).toBe("video");
    state = previewReducer(state, { type: "next-version", workId: "trail-1" });
    expect(currentWork(state)?.scripts).toHaveLength(1);
    expect(currentWork(state)?.phase).toBe("plan");
    expect(currentWork(state)?.plan?.version).toBe(2);
    expect(currentWork(state)?.runs[0]?.planVersion).toBe(1);
    expect(hasReusableVoice(currentWork(state)!)).toBe(true);
  });
  it("只要 Prompt 不创建作品、不准备方案或启动制作", () => {
    const empty = previewReducer(createPreviewState(), {
      type: "new-conversation",
    });
    const result = previewReducer(empty, {
      type: "send",
      text: "我想做视频，先给我 Prompt",
    });
    expect(currentConversation(result).works).toEqual([]);
    expect(currentConversation(result).messages.at(-1)?.text).toContain(
      "Prompt",
    );
  });
  it("视频意向仍可讨论，不自动进入创作", () => {
    const empty = previewReducer(createPreviewState(), {
      type: "new-conversation",
    });
    const result = previewReducer(empty, { type: "send", text: "我想做视频" });
    expect(currentConversation(result).works).toHaveLength(0);
  });
  it("改稿修订同一作品，确认前不创建下一阶段", () => {
    const result = previewReducer(createPreviewState(), {
      type: "send",
      text: "把开头改短一点",
    });
    expect(currentConversation(result).works).toHaveLength(1);
    expect(currentWork(result)?.scripts).toHaveLength(2);
    expect(currentWork(result)?.scripts.at(-1)?.opening).toBe(
      "收起手机，走进山里。让风带路，慢下来。",
    );
    expect(currentWork(result)?.plan).toBeNull();
  });
  it("否定修改不生成修订", () => {
    const result = previewReducer(createPreviewState(), {
      type: "send",
      text: "先别改，看看这版",
    });
    expect(currentWork(result)?.scripts).toHaveLength(1);
  });
  it("闲聊不改变作品进度", () => {
    const before = createPreviewState();
    const result = previewReducer(before, {
      type: "send",
      text: "我们先聊点别的",
    });
    expect(currentWork(result)).toEqual(currentWork(before));
  });
  it("阶段确认只对当前具体作品生效", () => {
    let state = previewReducer(createPreviewState(), {
      type: "send",
      text: "再做一条咖啡短片",
    });
    const coffee = currentWork(state)!;
    state = previewReducer(state, {
      type: "confirm-script",
      workId: coffee.id,
      version: 1,
    });
    expect(currentWork(state)?.phase).toBe("plan");
    expect(currentConversation(state).works[0]?.phase).toBe("script");
    expect(currentWork(state)?.runs).toHaveLength(0);
  });
  it("旧稿不能批准最新稿；重复查看已确认脚本不重造方案", () => {
    let state = previewReducer(createPreviewState(), {
      type: "send",
      text: "把开头改短",
    });
    state = previewReducer(state, {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    expect(currentWork(state)?.plan).toBeNull();
    state = previewReducer(state, {
      type: "confirm-script",
      workId: "trail-1",
      version: 2,
    });
    state = previewReducer(state, {
      type: "confirm-script",
      workId: "trail-1",
      version: 2,
    });
    expect(currentWork(state)?.plan?.version).toBe(1);
  });
  it("认可方案但明确暂不制作，不启动运行", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, {
      type: "send",
      text: "这版方案认可，先别制作",
    });
    expect(currentWork(state)?.plan?.approved).toBe(true);
    expect(currentWork(state)?.phase).toBe("plan");
    expect(currentWork(state)?.runs).toHaveLength(0);
  });
  it("原候选可以跨轮使用，不被另一条视频的素材列表替代", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "send", text: "再做一条咖啡短片" });
    state = previewReducer(state, {
      type: "send",
      text: "用徒步原列表里的第二个",
    });
    const trail = currentConversation(state).works[0]!;
    expect(trail.plan?.choices[0]).toBe("forest");
    expect(currentWork(state)?.topic).toBe("coffee");
  });
  it("回到前一步改稿时保留旧方案，需确认新稿后再更新", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "send", text: "把开头改短" });
    expect(currentWork(state)?.phase).toBe("script");
    expect(currentWork(state)?.plan?.scriptVersion).toBe(1);
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    expect(currentWork(state)?.runs).toHaveLength(0);
  });
  it("制作开始冻结输入；后续意见只进入下一版意见", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    const frozen = currentWork(state)!.runs[0]!;
    state = previewReducer(state, { type: "send", text: "结尾再安静一点" });
    const after = currentWork(state)!;
    expect(after.scripts).toHaveLength(1);
    expect(after.runs[0]?.choices).toEqual(frozen.choices);
    expect(after.runs[0]?.scriptVersion).toBe(frozen.scriptVersion);
    expect(after.runs[0]?.notes).toEqual(["结尾再安静一点"]);
  });
  it("切到另一会话后，完成结果仍归原会话且不抢占阅读", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    state = previewReducer(state, { type: "new-conversation" });
    const active = state.active;
    state = previewReducer(state, {
      type: "complete",
      workId: "trail-1",
      conversationId: "conversation-1",
    });
    expect(state.active).toBe(active);
    expect(currentConversation(state).works).toHaveLength(0);
    expect(state.conversations[0]?.works[0]?.phase).toBe("video");
  });
  it("视频认可只改变定稿状态，不新增一次生成", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    state = previewReducer(state, {
      type: "complete",
      workId: "trail-1",
      conversationId: "conversation-1",
    });
    state = previewReducer(state, { type: "finalize", workId: "trail-1" });
    expect(currentWork(state)?.phase).toBe("done");
    expect(currentWork(state)?.runs).toHaveLength(1);
  });
  it("明确的新一版草稿保留上一版视频与制作引用", () => {
    let state = previewReducer(createPreviewState(), {
      type: "confirm-script",
      workId: "trail-1",
      version: 1,
    });
    state = previewReducer(state, { type: "start", workId: "trail-1" });
    state = previewReducer(state, {
      type: "complete",
      workId: "trail-1",
      conversationId: "conversation-1",
    });
    state = previewReducer(state, { type: "next-version", workId: "trail-1" });
    expect(currentWork(state)?.scripts.at(-1)?.version).toBe(2);
    expect(currentWork(state)?.runs[0]?.scriptVersion).toBe(1);
    expect(currentWork(state)?.runs[0]?.status).toBe("completed");
  });
});
