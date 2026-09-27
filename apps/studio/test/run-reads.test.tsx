import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { studioApi } from "../src/client/api.js";
import { RunPage } from "../src/client/pages/RunPage.js";
import type { StudioCostRunDetail, StudioRunDetail } from "../src/shared/api.js";

const detail = (id = "run-a", revision = 1): StudioRunDetail => ({
  id, revision, title: `制作${id}`, status: "running", platform: "douyin", durationSeconds: 20,
  angle: "当前方案", audience: "创作者", nicheSlug: "general", reviewMode: "manual",
  startedAt: "2026-09-27T01:00:00Z", currentNodeId: "render",
  nodes: [{ id: "render", label: "生成成片", status: "running", artifactIds: [], qualityGateResults: [] }],
  artifacts: [], decisions: [],
});
const cost = (runId = "run-a"): StudioCostRunDetail => ({
  runId, title: `费用${runId}`, lines: [], totals: { estimatedCostCny: 0, authorizedCostCny: 0,
    actualCostCny: 0, actualPendingCount: 0, meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0,
    failedMeteredCalls: 0, verifiedModelAttempts: 0, verifiedBrokerRequests: 0, legacyUnattributedReceipts: 0,
    countExact: true, countConflicts: 0 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("RunPage read scheduling", () => {
  let listeners: Map<string, EventListener>;
  beforeEach(() => {
    vi.useFakeTimers();
    listeners = new Map();
    vi.stubGlobal("EventSource", class {
      addEventListener(name: string, callback: EventListener) { listeners.set(name, callback); }
      close() {}
    });
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(studioApi, "run").mockImplementation(async id => detail(id));
    vi.spyOn(studioApi, "runCosts").mockImplementation(async id => cost(id));
    vi.spyOn(studioApi, "providers").mockResolvedValue([]);
    vi.spyOn(studioApi, "creativeReviewHistory").mockResolvedValue({ runId: "run-a", entries: [], legacyIncomplete: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function mount() {
    await act(async () => { render(<MemoryRouter initialEntries={["/projects/run-a"]}>
      <Link to="/projects/run-b">切换作品</Link>
      <Routes><Route path="/projects/:runId" element={<RunPage />} /></Routes>
    </MemoryRouter>); });
  }
  async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
  async function event(name: string, value: unknown) {
    await act(async () => listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(value) })));
  }

  it("uses a ten second cost fallback while heartbeats only update connection freshness", async () => {
    await mount();
    for (let i = 0; i < 4; i++) await event("heartbeat", { at: new Date().toISOString() });
    expect(studioApi.run).toHaveBeenCalledTimes(1);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(1);
    await tick(9_999);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(2);
    expect(studioApi.run).toHaveBeenCalledTimes(6);
  });

  it("keeps the reinspection confirmation open with its error when the formal API rejects", async () => {
    const run: StudioRunDetail = { ...detail(), status: "needs_human", currentNodeId: "final-review",
      videoArtifactId: "film", artifacts: [{ id: "film", kind: "render", createdAt: detail().startedAt,
        contentType: "video/mp4", contentUrl: "/api/runs/run-a/artifacts/film/content" }],
      nodes: [{ id: "visual-review", label: "成片审查", status: "succeeded", artifactIds: [], qualityGateResults: [] },
        { id: "final-review", label: "内部定版", status: "needs_human", artifactIds: [], qualityGateResults: [] }],
      activeIntervention: { id: "final", nodeId: "final-review", reason: "无有效审查", options: ["approve", "reject"],
        createdAt: detail().startedAt, reviewStatus: "incomplete", providerOutcomeKnown: true, evidenceId: "e".repeat(64) },
    };
    vi.mocked(studioApi.run).mockResolvedValue(run);
    vi.spyOn(studioApi, "reinspectVisualReview").mockRejectedValue(new Error("当前成片证据已变化，请刷新后重新确认。"));
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "重新审查当前成片" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认重新审查" })));
    const dialog = screen.getByRole("dialog", { name: "重新审查这一版成片？" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("当前成片证据已变化");
    expect(within(dialog).getByRole("button", { name: "先不审查" })).toBeEnabled();
    expect(studioApi.reinspectVisualReview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "下载成片" })).toHaveAttribute("href", "/api/runs/run-a/artifacts/film/content");
  });

  it("coalesces slow reads and preserves one authoritative follow-up at a terminal event", async () => {
    await mount();
    const slowRun = deferred<StudioRunDetail>();
    const slowCost = deferred<StudioCostRunDetail>();
    vi.mocked(studioApi.run).mockReturnValueOnce(slowRun.promise).mockResolvedValue({ ...detail("run-a", 3), status: "succeeded" });
    vi.mocked(studioApi.runCosts).mockReturnValueOnce(slowCost.promise).mockResolvedValue(cost());
    await event("run", detail("run-a", 2));
    await tick(1_000);
    expect(studioApi.run).toHaveBeenCalledTimes(2);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(2);
    await event("run", { ...detail("run-a", 3), status: "succeeded" });
    await tick(3_000);
    expect(studioApi.run).toHaveBeenCalledTimes(2);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(2);
    await act(async () => { slowRun.resolve(detail("run-a", 2)); slowCost.resolve(cost()); });
    expect(studioApi.run).toHaveBeenCalledTimes(3);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(3);
    await tick(20_000);
    expect(studioApi.run).toHaveBeenCalledTimes(3);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(3);
  });

  it("backs failed run reads off by 2/4/8/10 seconds without changing the run to failed", async () => {
    await mount();
    vi.mocked(studioApi.run).mockRejectedValue(new Error("temporary offline"));
    for (const [delay, calls] of [[2_000, 2], [2_000, 3], [4_000, 4], [8_000, 5], [10_000, 6]]) {
      await tick(delay! - 1);
      expect(studioApi.run).toHaveBeenCalledTimes(calls! - 1);
      await tick(1);
      expect(studioApi.run).toHaveBeenCalledTimes(calls!);
    }
    expect(screen.getByRole("heading", { name: "制作run-a" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试失败步骤" })).not.toBeInTheDocument();
  });

  it("pauses hidden fallback and refreshes once on visibility without duplicate streams", async () => {
    await mount();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await tick(30_000);
    expect(studioApi.run).toHaveBeenCalledTimes(1);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(studioApi.run).toHaveBeenCalledTimes(2);
    expect(studioApi.runCosts).toHaveBeenCalledTimes(2);
  });

  it("does not let an old initial load or cost read block or overwrite another run", async () => {
    const oldRun = deferred<StudioRunDetail>();
    const oldCost = deferred<StudioCostRunDetail>();
    vi.mocked(studioApi.run).mockReturnValueOnce(oldRun.promise);
    vi.mocked(studioApi.runCosts).mockReturnValueOnce(oldCost.promise);
    await mount();
    await act(async () => fireEvent.click(screen.getByRole("link", { name: "切换作品" })));
    expect(screen.getByRole("heading", { name: "制作run-b" })).toBeInTheDocument();
    await act(async () => { oldRun.resolve({ ...detail("run-a", 100), title: "不应回来的旧作品" }); oldCost.resolve(cost()); });
    expect(screen.getByRole("heading", { name: "制作run-b" })).toBeInTheDocument();
    expect(screen.queryByText("不应回来的旧作品")).not.toBeInTheDocument();
    await tick(10_000);
    expect(vi.mocked(studioApi.runCosts).mock.calls.slice(2).every(([id]) => id === "run-b")).toBe(true);
  });
});
