import { useState } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkCenter } from "../src/client/agent/WorkCenter.js";
import { agentApi, subscribeEvents } from "../src/client/agent/api.js";
import { TaskProgress } from "../src/client/agent/TaskProgress.js";
import type { ArtifactRevision, ContentSource, Message, RequestProgress, Work } from "../src/shared/agent/generated/contracts.js";

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

const message: Message = { id: "message", requestId: "request", role: "user", kind: "chat", text: "继续一杯早晨", state: "running", revision: 1, target: null, feedback: null, librarySelections: [], createdAt: time, createdSequence: 1, references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] } };
const progress: RequestProgress = { requestId: "request", sequence: 3, phase: "tool_running", label: "查找素材", updatedAt: time, workId: "coffee", steps: [{ id: "read", label: "核对作品版本", state: "completed", workId: "coffee", updatedAt: time }, { id: "search", label: "查找素材", state: "running", workId: "coffee", updatedAt: time }] };
const progressProps = () => ({ activeRequestId: "request", messages: [message], progress, runs: [], works: [work("coffee", "一杯早晨")], onStop: vi.fn(async () => true), onOpenRun: vi.fn(), onOpenWork: vi.fn() });

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
  expect(screen.getByRole("heading", { name: "一杯早晨详情" })).toHaveFocus();
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
  expect(screen.getByText("batch-8第3版正文")).toBeVisible();
});
