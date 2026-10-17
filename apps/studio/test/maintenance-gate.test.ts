import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  holdMaintenanceWork, maintenanceRequestHeaders, runWithMaintenanceAdmission, transitionMaintenanceGate,
} from "@video-factory/production-pipeline/maintenance";
import { MAINTENANCE_ADMISSION_PROTOCOL, MaintenanceGate, StudioMaintenanceError } from "../src/server/maintenance-gate.js";
import { buildStudioApp, type StudioServicePort } from "../src/server/app.js";
import { ProductionStudio, type StudioPipelinePort } from "../src/server/production-studio.js";
import type { DispatchedProductionRun, ProductionBrief } from "@video-factory/production-pipeline";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { seriesCausalHarness, seriesInput } from "./fixtures/series-causal-harness.js";
import { TrendGateway } from "../src/server/trend-gateway.js";
import { TrendOpportunityAgent } from "../src/server/trend-opportunity-agent.js";
import { TrendStudio } from "../src/server/trend-studio.js";
import { setTimeout as delay } from "node:timers/promises";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-maintenance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await transitionMaintenanceGate(directory, "open", "setup");
  const gate = new MaintenanceGate({ directory });
  await gate.announceStartup();
  return { directory, gate };
}

async function drain(directory: string) {
  await transitionMaintenanceGate(directory, "draining", "deploy-1");
}

const stubService = {
  health: async () => ({ status: "ok", runtime: {} }),
  listRuns: async () => [],
  getCreatorSettings: async () => ({ language: "zh" }),
  updateCreatorSettings: async () => ({ language: "zh" }),
} as unknown as StudioServicePort;

describe("MaintenanceGate", () => {
  it("persists ownership before admission and leaves startup integrity unproven", async (t) => {
    const { directory, gate } = await setup(t);
    const startup = await gate.report();
    assert.equal(startup.protocol, MAINTENANCE_ADMISSION_PROTOCOL);
    assert.equal(startup.quiescent, false);
    const token = await gate.admit("POST /api/runs");
    assert.equal((await gate.report({ complete: true })).holders.length, 1);
    const saved = JSON.parse(await readFile(path.join(directory, "holders.json"), "utf8"));
    assert.equal(saved.holders[0].id, token.id);
    await gate.release(token);
    assert.equal((await gate.report({ complete: true })).quiescent, true);
  });

  it("rejects new work while draining or frozen without altering ownership", async (t) => {
    const { directory, gate } = await setup(t);
    await drain(directory);
    await assert.rejects(() => gate.admit("POST /api/runs"), (error: unknown) => {
      assert.ok(error instanceof StudioMaintenanceError);
      assert.equal(error.state, "draining");
      assert.equal(error.owner, "deploy-1");
      return true;
    });
    assert.equal(gate.currentInflight().length, 0);
    await transitionMaintenanceGate(directory, "frozen", "deploy-1");
    await assert.rejects(() => gate.admit("POST /api/runs"), /frozen/);
  });

  it("counts admitted work across gate closure and refuses to freeze until release", async (t) => {
    const { directory, gate } = await setup(t);
    const token = await gate.admit("POST /api/runs");
    await drain(directory);
    assert.equal((await gate.report({ complete: true })).quiescent, false);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-1"));
    await gate.release(token);
    await transitionMaintenanceGate(directory, "frozen", "deploy-1");
    assert.equal((await gate.currentGate())?.state, "frozen");
  });

  it("release waits for dynamically retained descendants and their finally work", async (t) => {
    const { directory, gate } = await setup(t);
    const first = deferred();
    const second = deferred();
    const descendantStarted = deferred();
    const token = await gate.admit("POST /api/runs");
    runWithMaintenanceAdmission(token, () => {
      holdMaintenanceWork(first.promise.then(() => {
        holdMaintenanceWork(second.promise);
        descendantStarted.resolve();
      }));
    });
    const released = gate.release(token);
    first.resolve();
    await descendantStarted.promise;
    await drain(directory);
    assert.equal((await gate.report({ complete: true })).holders.length, 1);
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-1"));
    second.resolve();
    await released;
    assert.equal((await gate.report({ complete: true })).holders.length, 0);
  });

  it("fails closed for missing, malformed and unreadable configured gate state", async (t) => {
    const { directory, gate } = await setup(t);
    await writeFile(path.join(directory, "gate.json"), "{not json");
    await assert.rejects(() => gate.currentGate());
    await assert.rejects(() => gate.admit("POST /api/runs"));
    await rm(path.join(directory, "gate.json"));
    await assert.rejects(() => gate.currentGate());
    const locked = path.join(directory, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await assert.rejects(() => new MaintenanceGate({ directory: locked }).admit("POST /api/runs"),
        (error: NodeJS.ErrnoException) => error.code === "EACCES");
    } finally { await chmod(locked, 0o700); }
  });

  it("is explicitly disabled without a configured directory", async () => {
    const gate = new MaintenanceGate();
    const token = await gate.admit("POST /api/runs");
    assert.deepEqual(runWithMaintenanceAdmission(token, maintenanceRequestHeaders), {});
    await gate.release(token);
    assert.equal(gate.enabled, false);
  });
});

describe("maintenance admission in the studio app", () => {
  it("finishes a real trend refresh and releases admission even when one source ignores abort", async (t) => {
    const { directory, gate } = await setup(t);
    const stalled = deferred<Response>();
    let cancelLateBody = 0;
    let modelCalls = 0;
    let releaseDone!: Promise<void>;
    const release = gate.release.bind(gate);
    t.mock.method(gate, "release", (token) => { releaseDone = release(token); return releaseDone; });
    const gateway = new TrendGateway({ timeoutMs: 50, fetcher: async (input) => String(input).includes("/douyin")
      ? stalled.promise : new Response(JSON.stringify({ data: [], items: [] })) });
    const trends = new TrendStudio({ repositoryRoot: directory, cachePath: path.join(directory, "candidates.json"),
      environment: {}, now: () => new Date(), trendGateway: gateway,
      trendAgent: new TrendOpportunityAgent({ signals: gateway,
        model: { id: "test", generate: async () => { modelCalls += 1; return []; } } }),
    });
    const app = buildStudioApp({ maintenanceGate: gate,
      service: { ...stubService, refreshTrendCandidates: () => trends.requestCandidateRefresh() } });
    t.after(() => app.close());
    try {
      const response = await app.inject({ method: "POST", url: "/api/trend-candidates/refresh" });
      assert.equal(response.statusCode, 202);
      const completed = await Promise.race([
        trends.activeWork().then(() => releaseDone).then(() => true),
        delay(1_000).then(() => false),
      ]);
      assert.equal(completed, true, "刷新和维护登记都必须在来源截止后结束");
      assert.equal(trends.candidateRefreshStatus(response.json().refreshId)?.state, "succeeded");
      assert.equal((await gate.report({ complete: true })).holders.length, 0);
      assert.equal(modelCalls, 1);
      const cached = await readFile(path.join(directory, "candidates.json"), "utf8");
      stalled.resolve(new Response(new ReadableStream({ cancel() { cancelLateBody += 1; } })));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(cancelLateBody, 1, "迟到响应必须被取消，不能重新触发生成或覆盖缓存");
      assert.equal(await readFile(path.join(directory, "candidates.json"), "utf8"), cached);
      await drain(directory);
      await transitionMaintenanceGate(directory, "frozen", "deploy-1");
    } finally {
      stalled.resolve(new Response("{}"));
      await trends.activeWork();
      await releaseDone;
    }
  });

  it("keeps read routes available and rejects all work routes while draining", async (t) => {
    const { directory, gate } = await setup(t);
    const app = buildStudioApp({ service: stubService, maintenanceGate: gate, maintenanceIntegrity: async () => ({ complete: true, issues: [] }) });
    t.after(() => app.close());
    await drain(directory);
    for (const url of ["/api/health", "/api/runs", "/api/settings"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 200, response.body);
    }
    for (const url of ["/api/series", "/api/cases", "/api/candidate-inbox"]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 503, url);
    }
    const write = await app.inject({ method: "PATCH", url: "/api/settings", payload: {},
      headers: { "x-video-factory-admission": "caller-cannot-claim-a-parent" } });
    assert.equal(write.statusCode, 503);
    assert.equal(write.headers["retry-after"], "30");
    assert.match(write.json().error, /维护进行中/);
    assert.equal((await gate.report({ complete: true })).holders.length, 0);
  });

  it("finishes a newly admitted roadmap and its later broker audit across draining", async (t) => {
    const produce = deferred();
    const audit = deferred();
    const h = await seriesCausalHarness({ maintenance: true, audit: "pass", gateProduce: produce.promise, gateAudit: audit.promise });
    const releases: Promise<void>[] = [];
    const release = h.maintenanceGate.release.bind(h.maintenanceGate);
    t.mock.method(h.maintenanceGate, "release", (token) => {
      const pending = release(token);
      releases.push(pending);
      return pending;
    });
    let generation: Promise<Awaited<ReturnType<typeof h.app.inject>>> | undefined;
    try {
      const created = await h.app.inject({ method: "POST", url: "/api/series", payload: seriesInput });
      assert.equal(created.statusCode, 201, created.body);
      generation = h.app.inject({ method: "POST", url: `/api/series/${created.json().id}/roadmap/generate` }).then((response) => response);
      await h.produceStart;
      await drain(h.maintenanceDirectory!);
      assert.equal((await h.broker.maintenanceStatus()).quiescent, false);
      for (const url of ["/api/series", "/api/candidate-inbox"]) {
        assert.equal((await h.app.inject({ url })).statusCode, 503);
      }
      assert.equal((await h.app.inject({ url: "/api/runs" })).statusCode, 200);
      const rejected = await h.app.inject({ method: "POST", url: "/api/series", payload: seriesInput });
      assert.equal(rejected.statusCode, 503);
      assert.deepEqual(h.calls.map((call) => call.kind), ["series-roadmap"]);
      await assert.rejects(() => transitionMaintenanceGate(h.maintenanceDirectory!, "frozen", "deploy-1"));

      produce.resolve();
      await h.auditStart;
      assert.deepEqual(h.calls.map((call) => call.kind), ["series-roadmap", "role-audit"], "关门后原链的后继 broker 请求仍能续作");
      assert.equal((await h.broker.maintenanceStatus()).quiescent, false);
      audit.resolve();
      const response = await generation;
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().episodes[0].planning.auditStatus, "passed");
      await Promise.all(releases);
      const settled = await h.broker.maintenanceStatus();
      assert.equal(settled.integrity.complete, true, JSON.stringify(settled));
      assert.equal(settled.quiescent, true, JSON.stringify(settled));
      await transitionMaintenanceGate(h.maintenanceDirectory!, "frozen", "deploy-1");
      assert.equal((await h.maintenanceGate.currentGate())?.state, "frozen");
      assert.equal(h.calls.length, 2);
    } finally {
      produce.resolve();
      audit.resolve();
      await generation;
      await h.close();
    }
  });

  it("retains real ProductionStudio background work created after handler admission", async (t) => {
    const { directory, gate } = await setup(t);
    const background = deferred<WorkflowRun<ProductionBrief>>();
    const handlerStarted = deferred();
    const handlerAllowed = deferred();
    let releaseDone!: Promise<void>;
    const release = gate.release.bind(gate);
    t.mock.method(gate, "release", (token) => { releaseDone = release(token); return releaseDone; });
    const production = new ProductionStudio({ pipeline: {} as StudioPipelinePort,
      workspaceRoot: directory, listProviders: async () => [], archiveStore: { list: async () => ({}) } as never, now: () => new Date() });
    const service = { ...stubService, updateCreatorSettings: async () => {
      // 调用真实生产完成链的登记点；此前 onRequest 的空快照无法覆盖它。
      (production as unknown as { trackCompletion(value: DispatchedProductionRun): void }).trackCompletion({ runId: "run-test", completion: background.promise });
      handlerStarted.resolve();
      await handlerAllowed.promise;
      return { language: "zh" };
    } } as unknown as StudioServicePort;
    const app = buildStudioApp({ service, maintenanceGate: gate });
    t.after(() => app.close());
    const responding = app.inject({ method: "PATCH", url: "/api/settings", payload: {} }).then((response) => response);
    await handlerStarted.promise;
    assert.equal((await gate.report({ complete: true })).holders.length, 1);
    handlerAllowed.resolve();
    const response = await responding;
    assert.equal(response.statusCode, 200);
    await drain(directory);
    assert.equal((await gate.report({ complete: true })).holders.length, 1, "HTTP 返回不代表后台链完成");
    await assert.rejects(() => transitionMaintenanceGate(directory, "frozen", "deploy-1"));
    background.resolve({} as WorkflowRun<ProductionBrief>);
    await production.activeWork();
    await releaseDone;
    assert.equal((await gate.report({ complete: true })).holders.length, 0);
  });

  it("never exposes holder credentials and refuses idle when integrity is incomplete", async (t) => {
    const { gate } = await setup(t);
    const app = buildStudioApp({ service: stubService, maintenanceGate: gate,
      maintenanceIntegrity: async () => ({ complete: false, issues: [{ runId: "broken", problem: "invalid_json" }] }) });
    t.after(() => app.close());
    const token = await gate.admit("test-chain");
    const response = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().maintenance.protocol, MAINTENANCE_ADMISSION_PROTOCOL);
    assert.equal(response.json().maintenance.quiescent, false);
    assert.equal(response.json().maintenance.integrity.complete, false);
    assert.equal(response.body.includes(token.id), false);
    await gate.release(token);
    const empty = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(empty.json().maintenance.quiescent, false);
  });

  it("uses a fresh internal admission instead of forwarding a caller credential", async (t) => {
    const { gate } = await setup(t);
    const releases: Promise<void>[] = [];
    const release = gate.release.bind(gate);
    t.mock.method(gate, "release", (token) => {
      const pending = release(token);
      releases.push(pending);
      return pending;
    });
    let internal: Record<string, string> | undefined;
    const service = { ...stubService, updateCreatorSettings: async () => {
      internal = maintenanceRequestHeaders();
      return { language: "zh" };
    } } as unknown as StudioServicePort;
    const app = buildStudioApp({ service, maintenanceGate: gate });
    t.after(() => app.close());
    const response = await app.inject({ method: "PATCH", url: "/api/settings", payload: {},
      headers: { "x-video-factory-admission": "public-caller-value" } });
    assert.equal(response.statusCode, 200);
    assert.ok(internal?.["x-video-factory-admission"]);
    assert.notEqual(internal?.["x-video-factory-admission"], "public-caller-value");
    assert.equal(response.body.includes(internal!["x-video-factory-admission"]!), false);
    // inject 返回不代表 onResponse 的持久释放完成；先等原释放再清理测试目录。
    assert.ok(releases.length > 0);
    await Promise.all(releases);
    assert.equal((await gate.report({ complete: true })).holders.length, 0);
  });
});
