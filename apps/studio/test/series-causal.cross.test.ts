import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { seriesCausalHarness, seriesInput, roadmapAudit } from "./fixtures/series-causal-harness.js";
import { CodexSeriesPlanningAgent } from "../src/server/series-planning-agent.js";
import { CodexBridgeClient } from "@video-factory/production-pipeline";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "../../codex-broker/src/chat-completions-executor.js";
import { CodexBrokerServer } from "../../codex-broker/src/broker-server.js";
import type { StudioSeries, StudioCostDashboard, StudioCandidateInbox } from "../src/shared/api.js";

it("cross-layer: save, explicit generation, failed audit, restart, retrieve, edit, adopt and inspect original usage", async () => {
  const h = await seriesCausalHarness();
  let reopened: ReturnType<typeof h.newApp> | undefined;
  try {
    const create = await h.app.inject({ method: "POST", url: "/api/series", payload: seriesInput });
    assert.equal(create.statusCode, 201, create.body);
    const series = create.json<StudioSeries>();
    assert.equal(h.calls.length, 0);
    const generation = await h.app.inject({ method: "POST", url: `/api/series/${series.id}/roadmap/generate` });
    assert.equal(generation.statusCode, 502, generation.body);
    assert.deepEqual(h.calls.map((call) => call.kind), ["series-roadmap", "role-audit", "role-audit"]);
    reopened = h.newApp();
    const refreshed = (await reopened.inject({ url: "/api/series" })).json<StudioSeries[]>()[0]!;
    const operation = refreshed.roadmapOperations![0]!;
    assert.equal(operation.auditStatus, "failed");
    assert.equal(operation.candidate?.length, 2);
    assert.equal(operation.executionFacts.length, 2);
    const base = `/api/series/${series.id}/roadmap/operations/${operation.id}`;
    assert.equal((await reopened.inject({ method: "POST", url: `${base}/regenerate` })).statusCode, 400);
    assert.equal((await reopened.inject({ method: "POST", url: `/api/series/${series.id}/roadmap/operations/invalid/retrieve` })).statusCode, 400);
    for (let i = 0; i < 2; i++) assert.equal((await reopened.inject({ method: "POST", url: `${base}/query` })).statusCode, 200);
    const retrieve = await reopened.inject({ method: "POST", url: `${base}/retrieve` });
    assert.equal(retrieve.statusCode, 200, retrieve.body);
    const recovered = retrieve.json<StudioSeries>();
    assert.equal(recovered.episodes[0]!.status, "planned");
    assert.equal(recovered.episodes[0]!.planning.auditStatus, "failed");
    assert.equal((await reopened.inject({ method: "POST", url: `${base}/retrieve` })).statusCode, 409);
    const episode = recovered.episodes[0]!;
    const edit = await reopened.inject({ method: "PATCH", url: `/api/series/${series.id}/episodes/1`, payload: {
      expectedRevision: recovered.revision, title: "人工决定保留的光影", pillar: episode.pillar, viewerPromise: episode.viewerPromise,
      hook: episode.hook, payoff: episode.payoff, fromPrevious: episode.continuity.fromPrevious, toNext: episode.continuity.toNext,
    } });
    assert.equal(edit.statusCode, 200, edit.body);
    const inbox = (await reopened.inject({ url: "/api/candidate-inbox?origins=series" })).json<StudioCandidateInbox>();
    assert.equal(inbox.items[1]!.seriesSequence?.status, "blocked");
    const candidate = inbox.items[0]!;
    const adopt = await reopened.inject({ method: "POST", url: `/api/candidate-inbox/${candidate.id}/adopt`, payload: { origin: "series", generationId: candidate.generationId } });
    assert.equal(adopt.statusCode, 201, adopt.body);
    assert.equal((await reopened.inject({ method: "POST", url: `${base}/retrieve` })).statusCode, 409);
    const costs = (await reopened.inject({ url: "/api/costs" })).json<StudioCostDashboard>();
    assert.equal(costs.runs.length, 0);
    assert.equal(costs.totals.verifiedBrokerRequests, 2);
    assert.equal(costs.totals.verifiedModelAttempts, 3);
    assert.equal(costs.totals.actualPendingCount, 2);
    assert.equal(costs.totals.actualCostCny, 0);
    const audit = costs.planningOperations![0]!.executionFacts.find((fact) => fact.purpose === "audit")!;
    assert.equal(audit.usage?.totalTokens, 330);
    assert.equal(audit.modelAttempts?.length, 2);
    assert.equal(audit.usageComplete, true);
    assert.equal(h.calls.length, 3);
    assert.doesNotMatch(JSON.stringify(costs), /local-test-only|Authorization|socketPath|"prompt"/);
  } finally { await reopened?.close(); await h.close(); }
});

it("cross-layer: legacy request input identifies a read-only candidate and blocks generation across model keys", async () => {
  let model: string | undefined;
  const h = await seriesCausalHarness({ selectedModel: async () => model });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const operation = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const file = path.join(h.checkpointDirectory, `${operation.id}.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.planningOwner;
    delete legacy.requestExecutions;
    await writeFile(file, JSON.stringify(legacy));
    const before = await readFile(file, "utf8");
    const calls = h.calls.length;
    model = "deepseek-flash";
    const refused = await h.app.inject({ method: "POST", url: `/api/series/${created.id}/roadmap/generate` });
    assert.equal(h.calls.length, calls, "默认型号改为显式型号后也不能再产稿或审计");
    assert.equal(refused.statusCode, 409, refused.body);
    const current = (await service.listSeries())[0]!;
    const recovered = current.roadmapOperations![0]!;
    assert.equal(recovered.id, operation.id);
    assert.equal(recovered.owner.id, created.id);
    assert.equal(recovered.candidate?.length, 2);
    assert.equal(recovered.auditStatus, "failed");
    assert.equal(recovered.baseRevision, undefined, "原请求未保存revision，不猜成当前版本");
    assert.equal(recovered.canRetrieve, false);
    assert.match(recovered.evidenceIssue!, /原始版本/);
    await service.recoverSeriesRoadmap(created.id, operation.id, "query");
    const retrieve = await h.app.inject({ method: "POST", url: `/api/series/${created.id}/roadmap/operations/${operation.id}/retrieve` });
    assert.equal(retrieve.statusCode, 409);
    assert.equal(await readFile(file, "utf8"), before, "只读归属不改写历史检查点");
    const costs = await service.costDashboard();
    assert.equal(costs.planningOperations![0]!.owner.id, created.id);
    assert.equal(costs.totals.verifiedModelAttempts, 3);
    assert.equal(costs.totals.actualPendingCount, 2);
    assert.equal(h.calls.length, calls);
    assert.doesNotMatch(JSON.stringify(current), /local-test-only|socketPath|"prompt"/);
    for (const selected of [undefined, "deepseek-flash", "different-model"]) {
      await assert.rejects(new CodexSeriesPlanningAgent(h.client, h.checkpointDirectory, async () => selected)
        .generate({ ...created, episodes: [], nextEpisodeNumber: 1 }, created.episodes.length), /原路线图操作/);
    }
    const movedKey = createHash("sha256").update(`previous-contract:${created.id}`).digest("hex");
    await rename(file, path.join(h.checkpointDirectory, `${movedKey}.json`));
    const moved = (await service.listSeries())[0]!.roadmapOperations![0]!;
    assert.equal(moved.id, movedKey);
    assert.equal(moved.candidate?.length, 2);
    await assert.rejects(service.generateSeriesRoadmap(created.id), /原路线图操作/);
    const agent = new CodexSeriesPlanningAgent(h.client, h.checkpointDirectory);
    assert.equal((await agent.roadmapOperations({ ...created, id: "another-series-same-name" })).length, 0, "归属不按名称匹配");
    const another = await service.createSeries({ ...seriesInput, track: "another-series-same-name" });
    assert.equal((await service.listSeries()).find((item) => item.id === another.id)!.roadmapOperations!.length, 0, "无关系列不能串候选");
    await assert.rejects(service.generateSeriesRoadmap(another.id));
    assert.equal(h.calls.length, calls + 3, "明确归属另一系列的旧记录不阻止新系列正常执行");
  } finally { await h.close(); }
});

it("cross-layer: an owned same-key operation cannot start another audit through the Agent entry", async () => {
  const h = await seriesCausalHarness();
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const original = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const file = path.join(h.checkpointDirectory, `${original.id}.json`);
    const before = await readFile(file, "utf8");
    assert.equal(h.calls.length, 3);

    await assert.rejects(new CodexSeriesPlanningAgent(h.client, h.checkpointDirectory)
      .generate({ ...created, episodes: [], nextEpisodeNumber: 1 }, created.episodes.length), /原路线图操作/);

    assert.equal(h.calls.length, 3, "直接Agent入口也只能沿原请求查询，不能再次发起审计");
    assert.equal(await readFile(file, "utf8"), before);
    const current = (await service.listSeries())[0]!;
    assert.equal(current.revision, created.revision);
    assert.equal(current.roadmapOperations![0]!.candidate?.length, 2);
    assert.equal(current.roadmapOperations![0]!.auditStatus, "failed");
    const costs = await service.costDashboard();
    assert.equal(costs.totals.verifiedBrokerRequests, 2);
    assert.equal(costs.totals.verifiedModelAttempts, 3);
  } finally { await h.close(); }
});

it("cross-layer: provider fallback preserves each physical request, failure and usage without replaying", async () => {
  const h = await seriesCausalHarness({ audit: "pass" });
  const primaryCalls: string[] = [];
  const socketPath = path.join(h.workspaceRoot, "primary.sock");
  const executor = new ChatCompletionsExecutor({
    provider: { ...DEEPSEEK_CHAT_COMPLETIONS_PROVIDER, profileId: "openai", providerId: "openai",
      textModelId: "controlled-model", visualModelId: "controlled-model", label: "Controlled primary" },
    env: { DEEPSEEK_API_KEY: "local-test-only" },
    fetchFn: async (_url, init) => {
      const isAudit = String(init?.body).includes("video-factory/role-audit-v2");
      primaryCalls.push(isAudit ? "audit" : "produce");
      return new Response(JSON.stringify({ choices: [{ message: { content: isAudit ? JSON.stringify(roadmapAudit()) : "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200 });
    },
  });
  const broker = new CodexBrokerServer({ socketPath, executor, idempotencyDirectory: path.join(h.workspaceRoot, "primary-broker") });
  await broker.start();
  try {
    h.client.updateCandidates([
      { client: new CodexBridgeClient({ socketPath }), providerId: "openai", modelId: "controlled-model", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
      { client: h.transport, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
    ]);
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    const generated = await service.generateSeriesRoadmap(created.id);
    assert.equal(generated.episodes[0]!.planning.auditStatus, "passed");
    const costs = await service.costDashboard();
    assert.equal(costs.totals.verifiedBrokerRequests, 3);
    assert.equal(costs.totals.verifiedModelAttempts, 3);
    assert.equal(costs.totals.actualPendingCount, 3);
    assert.equal(costs.totals.countExact, true);
    const facts = costs.planningOperations![0]!.executionFacts;
    assert.equal(facts.length, 3);
    assert.equal(new Set(facts.map((fact) => fact.requestId)).size, 3);
    const failed = facts.find((fact) => fact.purpose === "produce" && fact.providerId === "openai")!;
    assert.equal(failed.state, "completed_failure");
    assert.equal(failed.usage?.totalTokens, 120);
    const backup = facts.find((fact) => fact.purpose === "produce" && fact.providerId === "deepseek")!;
    assert.equal(backup.state, "completed");
    assert.equal(backup.usage?.totalTokens, 110);
    assert.ok(facts.every((fact) => fact.usageComplete));
    const replayed = await h.service().costDashboard();
    assert.equal(replayed.totals.verifiedModelAttempts, 3);
    assert.equal(primaryCalls.length + h.calls.length, 3);

    h.client.updateCandidates([
      { client: new CodexBridgeClient({ socketPath }), providerId: "openai", modelId: "controlled-model", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
      { client: new CodexBridgeClient({ socketPath: path.join(h.workspaceRoot, "unavailable.sock") }), providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
    ]);
    const unavailable = await service.createSeries({ ...seriesInput, track: "causal-unavailable-backup" });
    await assert.rejects(service.generateSeriesRoadmap(unavailable.id));
    const failedCosts = await service.costDashboard();
    assert.equal(failedCosts.totals.verifiedBrokerRequests, 4, "备用服务未受理不能抹掉主服务已结束的请求");
    assert.equal(failedCosts.totals.verifiedModelAttempts, 4);
    assert.equal(failedCosts.totals.actualPendingCount, 4);
    const failedFacts = failedCosts.planningOperations!.find((item) => item.owner.id === unavailable.id)!.executionFacts;
    const returned = failedFacts.find((fact) => fact.providerId === "openai")!;
    assert.equal(returned.state, "completed_failure");
    assert.equal(returned.usage?.totalTokens, 120);
    assert.equal(primaryCalls.length + h.calls.length, 4);

    let release!: () => void;
    const pending = await seriesCausalHarness({ gateProduce: new Promise<void>((resolve) => { release = resolve; }), timeoutMs: 500 });
    try {
      pending.client.updateCandidates([
        { client: new CodexBridgeClient({ socketPath }), providerId: "openai", modelId: "controlled-model", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
        { client: pending.transport, providerId: "deepseek", modelId: "deepseek-flash", taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" },
      ]);
      const pendingService = pending.service();
      const waiting = await pendingService.createSeries(seriesInput);
      await assert.rejects(pendingService.generateSeriesRoadmap(waiting.id));
      const original = (await pendingService.listSeries())[0]!.roadmapOperations![0]!;
      assert.equal(original.auditStatus, "unknown");
      const before = await pendingService.costDashboard();
      assert.equal(before.totals.verifiedBrokerRequests, 2);
      assert.equal(before.totals.verifiedModelAttempts, 1);
      assert.equal(before.totals.countExact, false, "在途备用请求的尝试数尚未由回执核定");
      assert.equal(before.planningOperations![0]!.executionFacts.find((fact) => fact.providerId === "openai")!.usage?.totalTokens, 120);
      await pendingService.recoverSeriesRoadmap(waiting.id, original.id, "query");
      release();
      const deadline = Date.now() + 5000;
      while (true) {
        const refreshed = await pendingService.recoverSeriesRoadmap(waiting.id, original.id, "query");
        if (refreshed.roadmapOperations![0]!.candidate) break;
        if (Date.now() > deadline) throw new Error("Original backup did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const after = await pendingService.costDashboard();
      assert.equal(after.totals.verifiedBrokerRequests, 2);
      assert.equal(after.totals.verifiedModelAttempts, 2);
      assert.equal(after.totals.actualPendingCount, 2);
      assert.equal(after.totals.countExact, true);
      assert.deepEqual(after.planningOperations![0]!.executionFacts.map((fact) => fact.usage?.totalTokens).sort((a, b) => a! - b!), [110, 120]);
      assert.deepEqual(pending.calls.map((call) => call.kind), ["series-roadmap"], "取回迟到备用产稿不能启动审计");
      assert.equal(primaryCalls.length + h.calls.length + pending.calls.length, 6);
    } finally { release(); await pending.close(); }
  } finally { await broker.close(); await h.close(); }
});

it("cross-layer: unreadable or conflicting historical evidence blocks new execution without claiming a series", async () => {
  let model: string | undefined;
  const h = await seriesCausalHarness({ selectedModel: async () => model });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const original = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const file = path.join(h.checkpointDirectory, `${original.id}.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.planningOwner;
    delete legacy.requestExecutions;
    const missing = structuredClone(legacy);
    delete missing.pendingCandidate.candidateTrace.prompt;
    const hashMismatch = structuredClone(legacy);
    hashMismatch.pendingCandidate.candidateTrace.brokerRequestIdHash = "f".repeat(64);
    const ambiguous = structuredClone(legacy);
    ambiguous.pendingCandidate.candidateTrace.prompt += `\n<<<TASK_DATA\n{}\nTASK_DATA>>>`;
    const conflict = structuredClone(legacy);
    conflict.completed = [{ ...structuredClone(legacy.pendingCandidate), candidateTrace: {
      ...legacy.pendingCandidate.candidateTrace,
      prompt: legacy.pendingCandidate.candidateTrace.prompt.replace(created.id, "series-another"),
    } }];
    model = "deepseek-flash";
    for (const text of ["{broken-json", JSON.stringify(missing), JSON.stringify(hashMismatch), JSON.stringify(ambiguous), JSON.stringify(conflict)]) {
      await writeFile(file, text);
      const current = (await service.listSeries())[0]!;
      const unknown = current.roadmapOperations![0]!;
      assert.equal(unknown.owner.kind, "unassigned");
      assert.equal(unknown.candidate, undefined);
      assert.equal(unknown.canQuery, false);
      assert.equal(unknown.canRetrieve, false);
      for (const url of [`/api/series/${created.id}/roadmap/generate`, `/api/series/${created.id}/roadmap/operations/${original.id}/query`, `/api/series/${created.id}/roadmap/operations/${original.id}/retrieve`]) {
        assert.equal((await h.app.inject({ method: "POST", url })).statusCode, 409);
      }
      await assert.rejects(new CodexSeriesPlanningAgent(h.client, h.checkpointDirectory, async () => model)
        .generate({ ...created, episodes: [], nextEpisodeNumber: 1 }, 2), /无法核对业务归属/);
      assert.equal(h.calls.length, 3);
      assert.equal(await readFile(file, "utf8"), text);
      const costs = await service.costDashboard();
      assert.equal(costs.planningOperations![0]!.owner.kind, "unassigned");
      assert.ok(costs.planningOperations![0]!.evidenceIssue);
    }
  } finally { await h.close(); }
});

it("cross-layer: legacy pending audit keeps original binding across query failures and terminal observation", async () => {
  let release!: () => void;
  let model: string | undefined;
  const h = await seriesCausalHarness({ audit: "pass", gateAudit: new Promise<void>((resolve) => { release = resolve; }), timeoutMs: 500, selectedModel: async () => model });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const original = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const file = path.join(h.checkpointDirectory, `${original.id}.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.planningOwner;
    delete legacy.requestExecutions;
    const originalEnvelope = legacy.pendingOperation.operation.serializedEnvelope;
    await writeFile(file, JSON.stringify(legacy));
    model = "different-model";
    const current = (await service.listSeries())[0]!;
    assert.equal(current.roadmapOperations![0]!.auditStatus, "unknown");
    assert.equal(current.roadmapOperations![0]!.candidate?.length, 2);
    const observe = h.client.observePreparedOnce.bind(h.client);
    for (const state of ["query_failure", "conflict", "not_accepted"] as const) {
      h.client.observePreparedOnce = async () => state === "query_failure" ? { state, observationError: "offline" } : { state };
      await assert.rejects(service.recoverSeriesRoadmap(created.id, original.id, "query"));
      assert.equal((await service.listSeries())[0]!.roadmapOperations![0]!.candidate?.length, 2);
      assert.equal(h.calls.length, 2);
    }
    h.client.observePreparedOnce = observe;
    await assert.rejects(service.generateSeriesRoadmap(created.id), /原路线图操作/);
    const episode = created.episodes[0]!;
    await service.updateSeriesEpisodePlan(created.id, 1, { expectedRevision: created.revision, title: "历史候选旁的人工新稿", pillar: episode.pillar,
      viewerPromise: episode.viewerPromise, hook: episode.hook, payoff: episode.payoff, fromPrevious: [], toNext: [] });
    release();
    const deadline = Date.now() + 5000;
    let result: StudioSeries;
    do {
      result = await service.recoverSeriesRoadmap(created.id, original.id, "query");
      if (result.roadmapOperations![0]!.auditStatus === "passed") break;
      if (Date.now() > deadline) throw new Error("Legacy audit did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
    assert.equal(result.episodes[0]!.title, "历史候选旁的人工新稿");
    assert.equal(result.roadmapOperations![0]!.canRetrieve, false);
    await assert.rejects(service.recoverSeriesRoadmap(created.id, original.id, "retrieve"));
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.planningOwner, undefined);
    assert.equal(saved.planningOriginalOperation.serializedEnvelope, originalEnvelope);
    assert.equal((await h.service().listSeries())[0]!.roadmapOperations![0]!.candidate?.length, 2);
    const costs = await service.costDashboard();
    assert.equal(costs.totals.verifiedBrokerRequests, 2);
    assert.equal(costs.totals.verifiedModelAttempts, 2);
    assert.equal(h.calls.length, 2);
  } finally { release(); await h.close(); }
});

it("cross-layer: legacy production is located from its immutable envelope and queried without starting an audit", async () => {
  let release!: () => void;
  const h = await seriesCausalHarness({ gateProduce: new Promise<void>((resolve) => { release = resolve; }), timeoutMs: 500 });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const original = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const file = path.join(h.checkpointDirectory, `${original.id}.json`);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.planningOwner;
    delete legacy.requestExecutions;
    legacy.contractDigest = "earlier-contract";
    const before = JSON.stringify(legacy);
    await writeFile(file, before);
    assert.equal((await service.listSeries())[0]!.roadmapOperations![0]!.owner.id, created.id);
    const conflicting = structuredClone(legacy);
    conflicting.pendingOperation.operation.envelope.payload.series.id = "series-wrong-owner";
    // 即使同步序列化文本，原 binding 的 digest 仍能拒绝篡改后的输入。
    conflicting.pendingOperation.operation.serializedEnvelope = JSON.stringify(conflicting.pendingOperation.operation.envelope);
    await writeFile(file, JSON.stringify(conflicting));
    const blocked = (await service.listSeries())[0]!.roadmapOperations![0]!;
    assert.equal(blocked.owner.kind, "unassigned");
    assert.equal(blocked.canQuery, false);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    assert.equal(h.calls.length, 1);
    await writeFile(file, before);
    release();
    const deadline = Date.now() + 5000;
    let result: StudioSeries;
    do {
      result = await service.recoverSeriesRoadmap(created.id, original.id, "query");
      if (result.roadmapOperations![0]!.candidate) break;
      if (Date.now() > deadline) throw new Error("Legacy production did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
    const recovered = result.roadmapOperations![0]!;
    assert.equal(recovered.auditStatus, "not_audited");
    assert.equal(recovered.candidate?.length, 2);
    assert.equal(recovered.canRetrieve, false);
    await assert.rejects(service.recoverSeriesRoadmap(created.id, original.id, "retrieve"));
    await assert.rejects(service.generateSeriesRoadmap(created.id), /原路线图操作/);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(stored.planningOwner, undefined);
    assert.deepEqual(stored.planningOriginalOperation, legacy.pendingOperation.operation);
    assert.deepEqual(h.calls.map((call) => call.kind), ["series-roadmap"]);
    assert.equal((await service.costDashboard()).totals.verifiedModelAttempts, 1);
  } finally { release(); await h.close(); }
});

it("cross-layer: successful roadmap stays planned and repeated generation does not call models", async () => {
  const h = await seriesCausalHarness({ audit: "pass" });
  try {
    const created = await h.service().createSeries(seriesInput);
    const generated = await h.service().generateSeriesRoadmap(created.id);
    assert.ok(generated.episodes.every((episode) => episode.status === "planned" && episode.planning.auditStatus === "passed"));
    await h.service().generateSeriesRoadmap(created.id);
    assert.equal(h.calls.length, 2);
  } finally { await h.close(); }
});

it("cross-layer: concurrent human edits survive the late candidate and block old-version retrieval", async () => {
  let release!: () => void;
  const gateAudit = new Promise<void>((resolve) => { release = resolve; });
  const h = await seriesCausalHarness({ audit: "pass", gateAudit });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    const result = service.generateSeriesRoadmap(created.id).then(() => undefined, (error: unknown) => error);
    await h.auditStart;
    const inFlight = (await h.service().listSeries())[0]!;
    await assert.rejects(h.service().recoverSeriesRoadmap(created.id, inFlight.roadmapOperations![0]!.id, "query"), /仍在执行/);
    const episode = created.episodes[0]!;
    await h.service().updateSeriesEpisodePlan(created.id, 1, { expectedRevision: created.revision, title: "并发人工版本", pillar: episode.pillar,
      viewerPromise: episode.viewerPromise, hook: episode.hook, payoff: episode.payoff, fromPrevious: [], toNext: [] });
    release();
    assert.match(String(await result), /路线图|修改|版本/);
    const current = (await service.listSeries())[0]!;
    assert.equal(current.episodes[0]!.title, "并发人工版本");
    assert.equal(current.roadmapOperations![0]!.canRetrieve, false);
    await assert.rejects(service.recoverSeriesRoadmap(created.id, current.roadmapOperations![0]!.id, "retrieve"));
    assert.equal(h.calls.length, 2);
  } finally { release(); await h.close(); }
});

it("cross-layer: unknown audit is queried at the original request without submitting a new attempt", async () => {
  let release!: () => void;
  const gateAudit = new Promise<void>((resolve) => { release = resolve; });
  const h = await seriesCausalHarness({ audit: "pass", gateAudit, timeoutMs: 500 });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    await h.auditStart;
    const current = (await h.service().listSeries())[0]!;
    const operation = current.roadmapOperations![0]!;
    const observe = h.client.observePreparedOnce.bind(h.client);
    for (const state of ["query_failure", "conflict", "not_accepted"] as const) {
      h.client.observePreparedOnce = async () => state === "query_failure" ? { state, observationError: "offline" } : { state };
      await assert.rejects(service.recoverSeriesRoadmap(created.id, operation.id, "query"));
      assert.equal((await service.listSeries())[0]!.roadmapOperations![0]!.candidate?.length, 2);
      assert.equal(h.calls.length, 2);
    }
    h.client.observePreparedOnce = observe;
    assert.equal(operation.auditStatus, "unknown");
    assert.equal(operation.candidate?.length, 2);
    await service.recoverSeriesRoadmap(created.id, operation.id, "query");
    await assert.rejects(service.generateSeriesRoadmap(created.id), /原路线图操作/);
    assert.equal(h.calls.length, 2);
    release();
    // 等原 durable 回执终结，绝不通过发新任务探测完成。
    const deadline = Date.now() + 5000;
    while (true) {
      const records = await Promise.all((await readdir(path.join(h.workspaceRoot, "broker"))).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(h.workspaceRoot, "broker", name), "utf8")) as { state: string }));
      if (records.length === 2 && records.every((record) => record.state === "completed")) break;
      if (Date.now() > deadline) throw new Error("Original audit did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const observed = await service.recoverSeriesRoadmap(created.id, operation.id, "query");
    assert.equal(observed.roadmapOperations![0]!.auditStatus, "passed");
    const retrieved = await service.recoverSeriesRoadmap(created.id, operation.id, "retrieve");
    assert.equal(retrieved.episodes[0]!.planning.auditScore, 90);
    assert.equal(retrieved.episodes[0]!.status, "planned");
    assert.equal(h.calls.length, 2);
  } finally { release(); await h.close(); }
});

it("cross-layer: original production query retrieves a late candidate without starting audit under a changed contract", async () => {
  let release!: () => void;
  const gateProduce = new Promise<void>((resolve) => { release = resolve; });
  const h = await seriesCausalHarness({ gateProduce, timeoutMs: 500 });
  try {
    const service = h.service();
    const created = await service.createSeries(seriesInput);
    await assert.rejects(service.generateSeriesRoadmap(created.id));
    const original = (await service.listSeries())[0]!.roadmapOperations![0]!;
    const checkpointPath = path.join(h.checkpointDirectory, `${original.id}.json`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.contractDigest = "old-role-contract";
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    release();
    const deadline = Date.now() + 5000;
    let result: StudioSeries;
    do {
      result = await service.recoverSeriesRoadmap(created.id, original.id, "query");
      if (result.roadmapOperations![0]!.candidate) break;
      if (Date.now() > deadline) throw new Error("Original candidate did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
    assert.equal(result.roadmapOperations![0]!.auditStatus, "not_audited");
    const retrieved = await service.recoverSeriesRoadmap(created.id, original.id, "retrieve");
    assert.equal(retrieved.episodes[0]!.planning.auditStatus, "not_audited");
    assert.deepEqual(h.calls.map((call) => call.kind), ["series-roadmap"]);
    assert.equal((await service.costDashboard()).totals.verifiedModelAttempts, 1);
  } finally { release(); await h.close(); }
});
