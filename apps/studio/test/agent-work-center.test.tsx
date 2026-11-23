import { useState } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkCenter } from "../src/client/agent/WorkCenter.js";
import { agentApi, subscribeEvents } from "../src/client/agent/api.js";
import { ExecutionRecord, TaskProgress } from "../src/client/agent/TaskProgress.js";
import type { ArtifactRevision, ContentSource, Message, RequestProgress, UploadMime, Work } from "../src/shared/agent/generated/contracts.js";

const time = "2026-11-16T10:00:00Z";
const revision = (work: string, version: number): ArtifactRevision => ({ artifactId: work, revisionId: `${work}-v${version}`, revisionNumber: version, baseRevisionId: null, requestId: null, runId: null, digest: "a".repeat(64), content: { format: "markdown", text: `${work}第${version}版正文` }, createdAt: time });
const source = (work: string, version: number): ContentSource => ({ kind: "artifact_revision", artifactId: work, revisionId: `${work}-v${version}`, digest: "a".repeat(64) });
const work = (id: string, title = id): Work => ({ id, title, revision: 1, createdAt: time, updatedAt: time, reviewGroups: [{ id: `group-${id}`, title: "审阅内容", revision: 1, nextIntent: null, items: [{ id: `item-${id}`, label: `${title}脚本`, role: "content", required: true, draft: source(id, 3), approved: source(id, 2), finalizedSource: null, confirmationId: `approved-${id}`, approvedAt: time }] }] });
const cacheFor = (works: Work[]) => Object.fromEntries(works.flatMap(item => [2, 3].map(version => [`${item.id}:${item.id}-v${version}`, revision(item.id, version)])));
const propsFor = (works: Work[]) => ({ works, selectedWorkId: null, onSelectWork: vi.fn(), onOpenReview: vi.fn(), revisions: cacheFor(works), onRevisionLoaded: vi.fn(), artifacts: [], onOpenArtifact: vi.fn(), children: null });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("总览同时保留各作品未确认 v3 和已确认 v2，打开时传递准确作品、事项和版本", async () => {
  const props = propsFor([work("earth", "轨道之上"), work("coffee", "一杯早晨"), work("city", "夜色上海")]);
  render(<WorkCenter {...props} />);
  const pending = within(screen.getByRole("region", { name: "轨道之上 · 未确认" }));
  const approved = within(screen.getByRole("region", { name: "轨道之上 · 已确认" }));
  expect(pending.getByText("earth第3版正文")).toBeVisible();
  expect(approved.getByText("earth第2版正文")).toBeVisible();
  expect(pending.queryByText("earth第2版正文")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看已确认一杯早晨脚本 v2" }));
  expect(props.onOpenReview).toHaveBeenCalledWith({ workId: "coffee", groupId: "group-coffee", itemId: "item-coffee", artifactId: "coffee", revisionId: "coffee-v2" });
  await userEvent.click(screen.getByRole("button", { name: "审阅夜色上海脚本 v3" }));
  expect(props.onOpenReview).toHaveBeenLastCalledWith({ workId: "city", groupId: "group-city", itemId: "item-city", artifactId: "city", revisionId: "city-v3" });
});

it("长对话分批显示作品，搜索覆盖未展示作品，空结果可恢复且筛选不混淆新旧版", async () => {
  const works = Array.from({ length: 24 }, (_, index) => work(`work-${index}`, `作品${index}`));
  works[22]!.reviewGroups[0]!.items[0]!.approved = null;
  const props = propsFor(works);
  render(<WorkCenter {...props} />);
  expect(screen.queryByRole("button", { name: "审阅作品23" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /再显示 8 件作品/ }));
  expect(screen.getByRole("button", { name: "审阅作品15" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "审阅作品23" })).toBeNull();
  await userEvent.type(screen.getByRole("textbox", { name: "搜索作品和交付内容" }), "作品23");
  expect(screen.getByRole("button", { name: "审阅作品23" })).toBeVisible();
  await userEvent.clear(screen.getByRole("textbox", { name: "搜索作品和交付内容" }));
  await userEvent.type(screen.getByRole("textbox", { name: "搜索作品和交付内容" }), "作品22");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "筛选作品" }), "approved");
  expect(screen.getByRole("status")).toHaveTextContent("没有符合条件的作品");
  await userEvent.click(screen.getByRole("button", { name: "显示全部作品" }));
  expect(screen.getByRole("button", { name: "审阅作品0" })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "搜索作品和交付内容" })).toHaveValue("");
});

it("作品总览优先展示真实成片预览，不让较早的多份脚本挤掉已确认视频", async () => {
  const film = work("film", "太空短片");
  const group = film.reviewGroups[0]!;
  const original = group.items[0]!;
  group.items = Array.from({ length: 10 }, (_, index) => ({ ...original, id: `script-${index}`, label: `已确认脚本${index}`, draft: source("film", 2) }));
  group.items.push({ ...original, id: "final-video", label: "视频初稿", role: "video", draft: source("film-video", 3), approved: source("film-video", 2) });
  const revisions = { ...cacheFor([film]), ...Object.fromEntries([2, 3].map(version => [`film-video:film-video-v${version}`, { ...revision("film-video", version), content: { format: "media", blobId: `film-file-v${version}`, mimeType: "video/mp4", durationMs: 90000 } } satisfies ArtifactRevision])) };
  const props = propsFor([film]);
  render(<WorkCenter {...props} revisions={revisions} />);
  const approved = within(screen.getByRole("region", { name: "太空短片 · 已确认" }));
  const preview = approved.getByRole("button", { name: "查看已确认视频初稿 v2" });
  expect(screen.getByRole("button", { name: "审阅太空短片" }).querySelector("img")).toHaveAttribute("src", "/api/agent/v1/blobs/film-file-v3/poster");
  expect(preview.querySelector("video")).toBeNull();
  expect(approved.getAllByRole("button")[0]).toBe(preview);
  await userEvent.click(preview);
  expect(props.onOpenReview).toHaveBeenCalledWith({ workId: "film", groupId: group.id, itemId: "final-video", artifactId: "film-video", revisionId: "film-video-v2" });
});

it("总览只为进入可见范围的卡片读取修订，失败可重试且不替换为别的版本", async () => {
  let observe: IntersectionObserverCallback | undefined;
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { observe = callback; } observe() {} disconnect() {} });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: "UNAVAILABLE", message: "暂不可读" }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(revision("lazy", 3)), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const item = work("lazy"); item.reviewGroups[0]!.items[0]!.approved = null;
  render(<WorkCenter {...propsFor([item])} revisions={{}} />);
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => observe!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await userEvent.click(await screen.findByRole("button", { name: "重新读取" }));
  expect(await screen.findByText("lazy第3版正文")).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/artifacts/lazy/revisions/lazy-v3"))).toBe(true);
});

// UIUX-02：收集全部 IntersectionObserver 回调（行封面与卡片各自注册观察者），逐一触发进入视口。
function stubViewportObservers() {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
  return async () => { await act(async () => { for (const callback of [...callbacks]) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); }); };
}

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const mediaRevision = (id: string, version: number, mimeType: UploadMime, durationMs?: number): ArtifactRevision => ({
  ...revision(id, version), content: { format: "media", blobId: `${id}-file-v${version}`, mimeType, durationMs: durationMs ?? null },
});

it("UIUX-02 折叠在「另 1 项」里的视频仍是作品封面：行封面独立读取海报与时长角标", async () => {
  const intersectAll = stubViewportObservers();
  const fetch = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/artifacts/short-cut/revisions/short-cut-v1")) return jsonResponse(mediaRevision("short-cut", 1, "video/mp4", 95000));
    if (url.endsWith("/artifacts/short-doc/revisions/short-doc-v3")) return jsonResponse(revision("short-doc", 3));
    throw new Error(`测试未模拟的请求：${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const film = work("short", "折叠视频");
  const base = film.reviewGroups[0]!.items[0]!;
  film.reviewGroups[0]!.items = [
    { ...base, id: "doc-1", label: "文稿一", draft: source("short-doc", 3) },
    { ...base, id: "doc-2", label: "文稿二", draft: source("short-doc", 3) },
    { ...base, id: "cut", label: "视频初稿", role: "video", draft: source("short-cut", 1) },
  ];
  render(<WorkCenter {...propsFor([film])} revisions={{}} />);
  expect(fetch).not.toHaveBeenCalled();
  await intersectAll();
  const rowButton = screen.getByRole("button", { name: "审阅折叠视频" });
  expect(await within(rowButton).findByText("1:35")).toBeVisible();
  expect(rowButton.querySelector("img")).toHaveAttribute("src", "/api/agent/v1/blobs/short-cut-file-v1/poster");
  expect(screen.getAllByRole("button", { name: /^另 1 项/ }).length).toBeGreaterThanOrEqual(1);
  expect(fetch.mock.calls.filter(([url]) => String(url).includes("short-cut"))).toHaveLength(1);
});

it("UIUX-02 封面选择只看角色先验：未加载的视频胜过已加载的文稿，返回后不换封面", async () => {
  const intersectAll = stubViewportObservers();
  let releaseVideo!: (value: ArtifactRevision) => void;
  const videoPending = new Promise<ArtifactRevision>(resolve => { releaseVideo = resolve; });
  const fetch = vi.fn(async (input: string | URL) => {
    if (String(input).endsWith("/artifacts/cut-video/revisions/cut-video-v1")) return jsonResponse(await videoPending);
    throw new Error(`测试未模拟的请求：${String(input)}`);
  });
  vi.stubGlobal("fetch", fetch);
  const film = work("stable", "不跳变");
  const base = film.reviewGroups[0]!.items[0]!;
  film.reviewGroups[0]!.items = [
    { ...base, id: "doc", label: "文稿", draft: source("doc", 3) },
    { ...base, id: "cut", label: "视频初稿", role: "video", draft: source("cut-video", 1) },
  ];
  render(<WorkCenter {...propsFor([film])} revisions={{ "doc:doc-v3": revision("doc", 3) }} />);
  await intersectAll();
  const rowButton = screen.getByRole("button", { name: "审阅不跳变" });
  // 视频修订悬挂中：封面停在读取中，而不是先闪已加载的文稿摘录。
  expect(within(rowButton).getByText("读取中…")).toBeVisible();
  expect(within(rowButton).queryByText("doc第3版正文")).toBeNull();
  await act(async () => releaseVideo(mediaRevision("cut-video", 1, "video/mp4", 8000)));
  expect(await within(rowButton).findByText("0:08")).toBeVisible();
  expect(within(rowButton).queryByText("doc第3版正文")).toBeNull();
});

it("UIUX-02 总览视觉事项显示缩略图，与行封面同修订的卡片不重复小图", () => {
  const film = work("thumbs", "缩略图");
  const base = film.reviewGroups[0]!.items[0]!;
  film.reviewGroups[0]!.items = [
    { ...base, id: "cut", label: "视频初稿", role: "video", draft: source("thumbs-cut", 3) },
    { ...base, id: "board", label: "分镜图", role: "storyboard", draft: source("thumbs-board", 1) },
  ];
  const revisions = {
    "thumbs-cut:thumbs-cut-v3": mediaRevision("thumbs-cut", 3, "video/mp4", 90000),
    "thumbs-board:thumbs-board-v1": mediaRevision("thumbs-board", 1, "image/png"),
  };
  render(<WorkCenter {...propsFor([film])} revisions={revisions} />);
  const boardVideo = screen.getByRole("button", { name: "审阅视频初稿 v3" });
  expect(boardVideo.querySelector(".agent-revision-cover")).toBeNull();
  const boardStory = screen.getByRole("button", { name: "审阅分镜图 v1" });
  expect(boardStory.querySelector(".agent-revision-cover")).not.toBeNull();
  expect(boardStory.querySelector("img")).toHaveAttribute("src", "/api/agent/v1/blobs/thumbs-board-file-v1/content");
});

it("UIUX-02 后台会话的总览（active=false）不发起任何封面或卡片请求", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(<WorkCenter {...propsFor([work("bg", "后台作品")])} revisions={{}} active={false} />);
  expect(fetch).not.toHaveBeenCalled();
});

const message: Message = { id: "message", requestId: "request", role: "user", kind: "chat", text: "继续一杯早晨", state: "running", revision: 1, target: null, feedback: null, librarySelections: [], createdAt: time, createdSequence: 1, references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] } };
const progress: RequestProgress = { requestId: "request", sequence: 3, phase: "tool_running", label: "查找素材", updatedAt: time, workId: "coffee", steps: [{ id: "read", label: "核对作品版本", state: "completed", workId: "coffee", updatedAt: time }, { id: "search", label: "查找素材", state: "running", workId: "coffee", updatedAt: time }] };
const progressProps = () => ({ activeRequestId: "request", messages: [message], progress, runs: [], works: [work("coffee", "一杯早晨")], onStop: vi.fn(async () => true), onOpenRun: vi.fn(), onOpenWork: vi.fn() });

it.each(["completed", "failed", "stopped"] as const)("%s 的真实执行记录可展开，重新挂载后仍可读且不冒充仍在执行", async state => {
  const saved: Message = { ...message, state, execution: { startedAt: time, endedAt: "2026-11-16T10:01:01Z", progress } };
  const ui = render(<ExecutionRecord message={saved} />);
  const result = state === "completed" ? "本轮已结束" : state === "stopped" ? "已停止" : "未完成";
  await userEvent.click(screen.getByLabelText(`查看本轮执行记录：${result}`));
  expect(screen.getByRole("list", { name: "本轮实际执行步骤" })).toHaveTextContent("核对作品版本已完成");
  expect(screen.getByText("结束前未取得完成回执", { selector: "small" })).toBeVisible();
  expect(screen.queryByText("已停止", { selector: "small" })).toBeNull();
  expect(screen.getByText("01:01")).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  ui.unmount();
  render(<ExecutionRecord message={saved} />);
  await userEvent.click(screen.getByLabelText(`查看本轮执行记录：${result}`));
  expect(screen.getByRole("list", { name: "本轮实际执行步骤" })).toBeVisible();
});

it.each([
  ["timeout", "已提前结束（超过时间上限）"],
  ["tool_limit", "已提前结束（达到工具调用上限）"],
] as const)("终态 %s 的零工具记录仍可展开并如实说明", async (completionReason, label) => {
  const saved: Message = { ...message, state: "completed", execution: { startedAt: time, endedAt: time,
    completionReason, progress: { ...progress, steps: [] } } };
  const first = render(<ExecutionRecord message={saved} />);
  expect(screen.getByLabelText(`查看本轮执行记录：${label}`)).toBeVisible();
  first.unmount();
  render(<ExecutionRecord message={structuredClone(saved)} />);
  await userEvent.click(screen.getByLabelText(`查看本轮执行记录：${label}`));
  expect(screen.getByText("这轮没有执行工具操作。")).toBeVisible();
});

it("UIUX-09 正常完成的零工具回合是轻量静态落款：无折叠语义，短回合不报耗时，满 5 秒才显示", () => {
  const short: Message = { ...message, state: "completed", execution: { startedAt: time, endedAt: "2026-11-16T10:00:02Z",
    completionReason: "finished", progress: { ...progress, steps: [] } } };
  const ui = render(<ExecutionRecord message={short} />);
  const line = screen.getByText("已完成", { selector: "p" });
  expect(line).toHaveClass("agent-execution-static");
  expect(screen.queryByLabelText("查看本轮执行记录：已完成")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText("这轮没有执行工具操作。")).toBeNull();
  expect(ui.container.querySelector("time")).toBeNull();
  ui.unmount();
  const longer: Message = { ...message, state: "completed", execution: { startedAt: time, endedAt: "2026-11-16T10:00:06Z",
    completionReason: "finished", progress: { ...progress, steps: [] } } };
  render(<ExecutionRecord message={longer} />);
  expect(screen.getByText("00:06", { selector: "time" })).toBeVisible();
  expect(screen.queryByLabelText("查看本轮执行记录：已完成")).toBeNull();
});

it("UIUX-09 多步回合摘要优先取可归属作品的已完成步骤，不机械取收尾核对", async () => {
  const saved: Message = { ...message, state: "completed", execution: { startedAt: time, endedAt: time, completionReason: "finished", progress: { ...progress,
    steps: [
      { id: "write", label: "编写创作文件", state: "completed", workId: "coffee", updatedAt: time },
      { id: "verify", label: "核对作品版本", state: "completed", updatedAt: time },
    ] } } };
  render(<ExecutionRecord message={saved} works={[work("coffee", "一杯早晨")]} />);
  expect(screen.getByLabelText("查看本轮执行记录：已完成")).toHaveAttribute("title", "一杯早晨 · 编写创作文件 · 2 项操作");
});

it("历史执行步骤沿保存的作品归属显示，同名操作在刷新后仍能区分", async () => {
  const saved: Message = { ...message, state: "completed", execution: { startedAt: time, endedAt: time, completionReason: "finished", progress: { ...progress,
    steps: ["coffee", "earth", "unloaded"].map(id => ({ id, label: "编写创作文件", state: "completed", workId: id, updatedAt: time })),
  } } };
  const works = [work("coffee", "一杯早晨"), work("earth", "轨道之上")];
  const ui = render(<ExecutionRecord message={saved} works={works} />);
  await userEvent.click(screen.getByLabelText("查看本轮执行记录：已完成"));
  const steps = within(screen.getByRole("list", { name: "本轮实际执行步骤" })).getAllByRole("listitem");
  expect(steps[0]).toHaveTextContent("一杯早晨");
  expect(steps[1]).toHaveTextContent("轨道之上");
  expect(steps[2]).toHaveTextContent("关联作品未载入");
  ui.unmount();
  render(<ExecutionRecord message={saved} works={[...works].reverse()} />);
  await userEvent.click(screen.getByLabelText("查看本轮执行记录：已完成"));
  expect(within(screen.getByRole("list", { name: "本轮实际执行步骤" })).getAllByRole("listitem")[0]).toHaveTextContent("一杯早晨");
});

it("旧消息不编造执行记录，运行中刷新沿已保存的阶段恢复", () => {
  const ui = render(<ExecutionRecord message={{ ...message, state: "completed" }} />);
  expect(screen.queryByText("执行记录")).toBeNull();
  ui.rerender(<TaskProgress {...progressProps()} progress={null} messages={[{ ...message, execution: { startedAt: time, endedAt: null, progress } }]} />);
  expect(screen.getByRole("status")).toHaveTextContent("查找素材");
  expect(screen.getByRole("list", { name: "最近执行步骤" })).toHaveTextContent("核对作品版本已完成");
});

it("执行圈有不确定进度语义、真实作品和步骤，断线与终态不会继续假装执行", async () => {
  const props = progressProps();
  const ui = render(<TaskProgress {...props} />);
  expect(screen.getByRole("progressbar", { name: "Agent 正在执行" })).not.toHaveAttribute("value");
  expect(screen.getByRole("status")).toHaveTextContent("正在为「一杯早晨」查找素材");
  expect(screen.getByRole("list", { name: "最近执行步骤" })).toHaveTextContent("核对作品版本已完成");
  await userEvent.click(screen.getAllByRole("button", { name: "一杯早晨" })[0]!);
  expect(props.onOpenWork).toHaveBeenCalledWith("coffee");
  ui.rerender(<TaskProgress {...props} disconnected />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("进展暂未同步");
  expect(screen.getByRole("button", { name: "停止本轮" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
  expect(props.onStop).toHaveBeenCalledTimes(1);
  ui.rerender(<TaskProgress {...props} activeRequestId={null} messages={[{ ...message, state: "completed" }]} />);
  expect(screen.queryByRole("region", { name: "当前进展" })).toBeNull();
});

it("停止请求在受理前防止重复点击，失败恢复可重试，失败步骤不冒充转圈", async () => {
  let resolve!: (value: boolean) => void;
  const props = progressProps(); props.onStop = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  const ui = render(<TaskProgress {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "停止本轮" }));
  expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
  expect(props.onStop).toHaveBeenCalledTimes(1);
  await act(async () => resolve(false));
  expect(screen.getByRole("button", { name: "停止本轮" })).toBeEnabled();
  ui.rerender(<TaskProgress {...props} progress={{ ...progress, phase: "tool_failed", steps: [{ ...progress.steps![1]!, state: "failed" }] }} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("list", { name: "最近执行步骤" })).toHaveTextContent("未完成");
});


it("浏览器离线直接终止 SSE 并仅通知一次，关闭订阅后不再响应旧网络事件", () => {
  const instances: { close: ReturnType<typeof vi.fn>; onerror: (() => void) | null }[] = [];
  vi.stubGlobal("EventSource", class { close = vi.fn(); onerror = null; constructor() { instances.push(this); } addEventListener() {} });
  const onReset = vi.fn();
  const sub = subscribeEvents("offline", "cursor", { onBusiness: vi.fn(), onDelta: vi.fn(), onReset });
  window.dispatchEvent(new Event("offline"));
  instances[0]!.onerror?.();
  expect(onReset).toHaveBeenCalledTimes(1);
  expect(instances[0]!.close).toHaveBeenCalledTimes(1);
  sub.close();
  const ended = subscribeEvents("closed", "cursor", { onBusiness: vi.fn(), onDelta: vi.fn(), onReset });
  ended.close(); window.dispatchEvent(new Event("offline"));
  expect(onReset).toHaveBeenCalledTimes(1);
});


it("总览进入审阅把焦点交给作品标题，返回搜索后仍保留已打开详情的输入", async () => {
  const props = propsFor([work("coffee", "一杯早晨")]);
  function Harness() {
    const [selected, setSelected] = useState<string | null>(null);
    return <WorkCenter {...props} selectedWorkId={selected} onSelectWork={setSelected}>
      <div className="agent-work-heading"><h2 tabIndex={-1}>一杯早晨详情</h2><textarea aria-label="审阅草稿" /></div>
    </WorkCenter>;
  }
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "审阅一杯早晨" }));
  expect(screen.getByRole("heading", { name: "一杯早晨" })).toHaveFocus();
  await userEvent.type(screen.getByRole("textbox", { name: "审阅草稿" }), "保留草稿");
  await userEvent.click(screen.getByRole("button", { name: "全部作品 1 件" }));
  expect(screen.getByRole("textbox", { name: "搜索作品和交付内容" })).toHaveFocus();
  await userEvent.click(screen.getByRole("button", { name: "审阅一杯早晨" }));
  expect(screen.getByRole("textbox", { name: "审阅草稿" })).toHaveValue("保留草稿");
});

it("Oracle P2-02 相同修订的同时读取共享请求，失败后可重新读取", async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
  const first = agentApi.readRevision("shared", "shared-v3");
  const second = agentApi.readRevision("shared", "shared-v3");
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(new Response(JSON.stringify({ code: "UNAVAILABLE", message: "暂不可用" }), { status: 503 }));
  const failed = await Promise.allSettled([first, second]);
  expect(failed.every(result => result.status === "rejected")).toBe(true);
  const retry = agentApi.readRevision("shared", "shared-v3");
  resolve(new Response(JSON.stringify(revision("shared", 3)), { status: 200 }));
  expect(await retry).toEqual(revision("shared", 3)); expect(fetch).toHaveBeenCalledTimes(2);
});

it("Oracle P2-07 聚焦状态用持久终态说明失败和停止，不留旧执行环", async () => {
  const props = progressProps(); const open = vi.fn();
  const ui = render(<TaskProgress {...props} compact onOpenChat={open} activeRequestId={null} messages={[{ ...message, state: "failed" }]} />);
  expect(screen.getByRole("status")).toHaveTextContent("本轮未完成"); expect(screen.queryByRole("progressbar")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看对话" })); expect(open).toHaveBeenCalledOnce();
  ui.rerender(<TaskProgress {...props} compact activeRequestId={null} messages={[{ ...message, state: "stopped" }]} />);
  expect(screen.getByRole("status")).toHaveTextContent("本轮已停止");
});

it("Oracle P2-08 本批没有交付而后面有时解释计数并可直接展开", async () => {
  const works = Array.from({ length: 9 }, (_, index) => work(`batch-${index}`));
  works.slice(0, 8).forEach(item => { item.reviewGroups = []; });
  render(<WorkCenter {...propsFor(works)} />);
  expect(screen.getByRole("heading", { name: "未确认 1 项" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /再显示 1 件作品/ }));
  expect(within(screen.getByRole("region", { name: "batch-8 · 未确认" })).getByText("batch-8第3版正文")).toBeVisible();
});
