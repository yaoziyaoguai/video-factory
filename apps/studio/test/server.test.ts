import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildStudioApp, type StudioServicePort } from "../src/server/app.js";
import { BUILTIN_TEMPLATES } from "../src/server/template-catalog.js";
import type { StudioOpportunity, StudioRunDetail } from "../src/shared/api.js";

function runDetail(status: StudioRunDetail["status"] = "needs_human"): StudioRunDetail {
  return {
    id: "run-1",
    title: "第一条视频",
    status,
    platform: "douyin",
    durationSeconds: 24,
    startedAt: "2026-08-21T10:00:00.000Z",
    currentNodeId: "final-review",
    revision: 1,
    angle: "实用清单",
    audience: "普通上班族",
    nicheSlug: "life-avoidance",
    reviewMode: "manual",
    nodes: [],
    artifacts: [],
    decisions: [],
  };
}

function fakeService(overrides: Partial<StudioServicePort> = {}): StudioServicePort {
  return {
    health: async () => ({ status: "ok", runtime: { ffmpeg: true, ffprobe: true, say: true } }),
    listProviders: async () => ([
      {
        id: "local-editorial-v1",
        capability: "asset.prepare",
        label: "本地编辑卡片",
        available: true,
        kind: "local",
      },
      {
        id: "pexels-stock-v1",
        capability: "asset.prepare",
        label: "Pexels 视频",
        available: false,
        kind: "external",
        requirement: "需要 PEXELS_API_KEY",
      },
    ]),
    listLocalCapabilities: async () => ([{
      id: "macos-voices",
      label: "macOS 中文音色",
      category: "voice",
      state: "ready",
      evidence: "发现 19 个中文音色",
    }]),
    listVoices: async () => ([{
      id: "macos:Tingting",
      providerId: "macos-say-v1",
      label: "Tingting",
      locale: "zh-CN",
      engine: "macos",
      curated: true,
    }]),
    previewVoice: async () => undefined,
    getCreatorSettings: async () => ({
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: "economy-daily",
      productionDefaults: { directorProfileId: "auto", reviewMode: "manual", platform: "douyin", durationSeconds: 24 },
      topicStrategy: { customInstruction: "优先可拍、可核验、可连载的题材。" },
    }),
    updateCreatorSettings: async (input) => ({
      voiceDirection: input.voiceDirection ?? { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
      defaultRecipeId: input.defaultRecipeId ?? "economy-daily",
      productionDefaults: {
        directorProfileId: input.productionDefaults?.directorProfileId ?? "auto",
        reviewMode: input.productionDefaults?.reviewMode ?? "manual",
        platform: input.productionDefaults?.platform ?? "douyin",
        durationSeconds: input.productionDefaults?.durationSeconds ?? 24,
      },
      topicStrategy: input.topicStrategy ?? { customInstruction: "优先可拍、可核验、可连载的题材。" },
      ...(input.defaultAssetProviderId ? { defaultAssetProviderId: input.defaultAssetProviderId } : {}),
    }),
    listTemplates: async () => ({ storeRevision: 0, templates: [] }),
    templateExperiments: async () => [],
    resourceManifest: async () => ({
      generatedAt: "2026-08-28T10:00:00.000Z",
      totalItems: 0,
      needsReviewCount: 0,
      legacyRunsWithoutManifest: 0,
      reconstructedRunCount: 0,
      unreadableManifestCount: 0,
      truncatedRunCount: 0,
      truncatedItemCount: 0,
      categories: { visual: 0, voice: 0, font: 0, document: 0, other: 0 },
      assetIndex: {
        version: "video-factory/asset-index-v1",
        totalAssets: 0,
        duplicateUses: 0,
        reusableCount: 0,
        needsReviewCount: 0,
        facets: { mediaKinds: {}, origins: {}, providers: {}, reuseStatuses: {} },
        assets: [],
      },
      items: [],
    }),
    getTemplate: async () => undefined,
    createTemplate: async () => { throw new Error("not configured"); },
    cloneTemplate: async () => { throw new Error("not configured"); },
    saveTemplateDraft: async () => { throw new Error("not configured"); },
    publishTemplate: async () => { throw new Error("not configured"); },
    listPublishTargets: async () => [],
    listTrendSources: async () => [],
    listTrendServices: async () => [],
    listTrendSignals: async () => [],
    listTrendCandidates: async () => [],
    refreshTrendCandidates: async () => ({ refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" }),
    trendCandidateRefreshStatus: async () => ({
      refreshId: "refresh-1",
      state: "succeeded",
      requestedAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:00:10.000Z",
      candidateCount: 8,
    }),
    listCandidateInbox: async () => ({
      items: [],
      facets: { total: 0, origins: {}, categories: {}, platforms: {}, verdicts: {} },
      generatedAt: "2026-08-24T09:00:00.000Z",
    }),
    adoptCandidate: async () => {
      throw new Error("not configured");
    },
    listSeries: async () => [],
    createSeries: async () => {
      throw new Error("not configured");
    },
    updateSeriesEpisodePlan: async () => {
      throw new Error("not configured");
    },
    linkLegacySeriesRun: async () => {
      throw new Error("not configured");
    },
    listOpportunities: async () => [],
    getOpportunity: async () => undefined,
    createOpportunity: async () => {
      throw new Error("not configured");
    },
    updateOpportunityStatus: async () => {
      throw new Error("not configured");
    },
    listRuns: async () => ([runDetail()]),
    costDashboard: async () => ({
      currency: "CNY",
      totals: { estimatedCostCny: 0, authorizedCostCny: 0, actualCostCny: 0, actualPendingCount: 0, meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0 },
      byProvider: [],
      byNode: [],
      runs: [],
    }),
    runCostDetail: async (runId) => ({
      runId,
      title: "第一条视频",
      totals: { estimatedCostCny: 0, authorizedCostCny: 0, actualCostCny: 0, actualPendingCount: 0, meteredCalls: 0, subscriptionCalls: 0, freeCalls: 0, failedMeteredCalls: 0 },
      lines: [],
    }),
    getRun: async (runId) => runId === "run-1"
      ? runDetail()
      : undefined,
    archiveRuns: async () => undefined,
    restoreRuns: async () => undefined,
    deleteRun: async () => undefined,
    startRun: async () => ({ runId: "run-2", status: "running" }),
    decide: async (_runId, input) => runDetail(input.action === "approve" ? "succeeded" : "rejected"),
    applyNodeOverride: async () => runDetail("stale"),
    applyNodeInputOverride: async () => runDetail("stale"),
    authorizeSpend: async () => runDetail("running"),
    resumeStale: async () => runDetail("running"),
    retryFailedNode: async () => runDetail("running"),
    subscribe: () => () => undefined,
    resolveArtifact: async () => undefined,
    publishReadiness: async (runId) => ({
      runId,
      ready: true,
      title: "第一条视频",
      targets: [{ id: "douyin", label: "抖音", mode: "official_api", status: "ready" }],
      checks: [{ id: "approval", label: "终审", status: "passed", detail: "已批准" }],
    }),
    publish: async (runId, input) => ({
      id: input.requestId,
      runId,
      status: "succeeded",
      createdAt: "2026-08-25T00:02:00.000Z",
      deliveries: input.platformIds.map((platformId) => ({ platformId, status: "submitted" as const, externalId: `${platformId}-item` })),
    }),
    ...overrides,
  };
}

describe("Studio API", () => {
  it("scopes opportunities and runs by a validated creation origin", async () => {
    const opportunityOrigins: Array<string | undefined> = [];
    const runOrigins: Array<string | undefined> = [];
    const app = buildStudioApp({ service: fakeService({
      listOpportunities: async (origin) => {
        opportunityOrigins.push(origin);
        return [];
      },
      listRuns: async (origin) => {
        runOrigins.push(origin);
        return [];
      },
    }) });

    const opportunities = await app.inject({ method: "GET", url: "/api/opportunities?origin=series" });
    const runs = await app.inject({ method: "GET", url: "/api/runs?origin=trend" });
    const invalid = await app.inject({ method: "GET", url: "/api/runs?origin=unknown" });

    assert.equal(opportunities.statusCode, 200);
    assert.equal(runs.statusCode, 200);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(opportunityOrigins, ["series"]);
    assert.deepEqual(runOrigins, ["trend"]);
    assert.match(invalid.json().error, /创作入口/);
    await app.close();
  });

  it("archives and restores production records in batches", async () => {
    const archived: string[][] = [];
    const restored: string[][] = [];
    const app = buildStudioApp({ service: fakeService({
      archiveRuns: async (runIds) => { archived.push(runIds); },
      restoreRuns: async (runIds) => { restored.push(runIds); },
    }) });

    const archive = await app.inject({ method: "POST", url: "/api/runs/archive", payload: { runIds: ["run-1", "run-2", "run-1"] } });
    const restore = await app.inject({ method: "POST", url: "/api/runs/restore", payload: { runIds: ["run-2"] } });
    const invalid = await app.inject({ method: "POST", url: "/api/runs/archive", payload: { runIds: [] } });

    assert.equal(archive.statusCode, 204);
    assert.equal(restore.statusCode, 204);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(archived, [["run-1", "run-2"]]);
    assert.deepEqual(restored, [["run-2"]]);
    await app.close();
  });

  it("deletes a terminal production record through the API", async () => {
    const deleted: string[] = [];
    const app = buildStudioApp({ service: fakeService({ deleteRun: async (runId) => { deleted.push(runId); } }) });

    const response = await app.inject({ method: "DELETE", url: "/api/runs/run-1" });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(deleted, ["run-1"]);
    await app.close();
  });

  it("creates a user template through validated input", async () => {
    const calls: unknown[] = [];
    const app = buildStudioApp({ service: fakeService({
      createTemplate: async (input) => {
        calls.push(input);
        return { storeRevision: 1, template: { ...BUILTIN_TEMPLATES[0]!, id: input.id, name: input.name, status: "draft", builtIn: false } };
      },
    }) });

    const response = await app.inject({ method: "POST", url: "/api/templates", payload: { id: "city-portrait", name: "城市人物", expectedRevision: 0 } });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(calls, [{ id: "city-portrait", name: "城市人物", expectedRevision: 0 }]);
    await app.close();
  });

  it("accepts bounded reference-video bytes without exposing a server path", async () => {
    const calls: Array<{ label: string; mimeType: string; bytes: Buffer }> = [];
    const app = buildStudioApp({ service: fakeService({
      uploadReferenceVideo: async (input) => {
        calls.push(input);
        return {
          uploadId: "67d86948-5517-4b17-8da1-b0a695159d4d",
          label: input.label,
          mimeType: "video/mp4",
          sizeBytes: input.bytes.length,
          sha256: "a".repeat(64),
          createdAt: "2026-08-28T10:00:00.000Z",
        };
      },
    }) });
    const bytes = Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);

    const response = await app.inject({
      method: "POST",
      url: "/api/reference-videos",
      headers: { "content-type": "video/mp4", "x-video-factory-filename": encodeURIComponent("参考节奏.mp4") },
      payload: bytes,
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().label, "参考节奏.mp4");
    assert.equal("path" in response.json(), false);
    assert.deepEqual(calls[0]?.bytes, bytes);
    await app.close();
  });

  it("rejects an empty or oversized reference upload before calling the store", async () => {
    let calls = 0;
    const app = buildStudioApp({ service: fakeService({
      uploadReferenceVideo: async () => {
        calls += 1;
        throw new Error("must not be called");
      },
    }) });
    const empty = await app.inject({
      method: "POST",
      url: "/api/reference-videos",
      headers: { "x-video-factory-filename": encodeURIComponent("empty.mp4") },
    });
    assert.equal(empty.statusCode, 400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/reference-videos",
      headers: { "content-type": "video/mp4", "x-video-factory-filename": encodeURIComponent("large.mp4") },
      payload: Buffer.alloc(30 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(calls, 0);
    await app.close();
  });

  it("deletes a temporary reference video through a path-safe route", async () => {
    const deleted: string[] = [];
    const app = buildStudioApp({ service: fakeService({
      deleteReferenceVideo: async (uploadId) => { deleted.push(uploadId); },
    }) });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/reference-videos/67d86948-5517-4b17-8da1-b0a695159d4d",
      headers: { "x-video-factory-request": "studio" },
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(deleted, ["67d86948-5517-4b17-8da1-b0a695159d4d"]);
    const unsafe = await app.inject({ method: "DELETE", url: "/api/reference-videos/%2e%2e" });
    assert.notEqual(unsafe.statusCode, 204);
    await app.close();
  });

  it("exposes cost ledgers, editable node versions, spend approval, and stale regeneration", async () => {
    const calls: string[] = [];
    const service = fakeService({
      costDashboard: async () => ({
        currency: "CNY",
        totals: { estimatedCostCny: 2.4, authorizedCostCny: 3, actualCostCny: 0, actualPendingCount: 1, meteredCalls: 1, subscriptionCalls: 0, freeCalls: 1, failedMeteredCalls: 0 },
        byProvider: [],
        byNode: [],
        runs: [],
      }),
      applyNodeOverride: async (_runId, nodeId, input, actor) => { calls.push(`override:${nodeId}:${String((input.output as { hook?: string }).hook)}:${actor}`); return runDetail("stale"); },
      applyNodeInputOverride: async (_runId, nodeId, input, actor) => { calls.push(`input:${nodeId}:${String((input.input as { title?: string }).title)}:${actor}`); return runDetail("stale"); },
      authorizeSpend: async (_runId, nodeId, input, approvedBy) => { calls.push(`spend:${nodeId}:${input.modelId}:${approvedBy}`); return runDetail("running"); },
      resumeStale: async () => { calls.push("regenerate"); return runDetail("running"); },
      retryFailedNode: async (_runId, nodeId) => { calls.push(`retry:${nodeId}`); return runDetail("running"); },
    });
    const app = buildStudioApp({ service });

    const costs = await app.inject({ method: "GET", url: "/api/costs" });
    const override = await app.inject({ method: "PUT", url: "/api/runs/run-1/nodes/script/override", payload: { actor: "editor", output: { hook: "人工钩子" } } });
    const inputOverride = await app.inject({ method: "PUT", url: "/api/runs/run-1/nodes/script/input-override", payload: { actor: "forged", input: { title: "人工题目" } } });
    const spend = await app.inject({ method: "POST", url: "/api/runs/run-1/nodes/assets/spend-authorizations", payload: { inputVersionIds: ["version-1"], providerId: "hailuo-video-v1", modelId: "MiniMax-Hailuo-02", maxCostCny: 3, maxAttempts: 1, approvedBy: "owner" } });
    const regenerate = await app.inject({ method: "POST", url: "/api/runs/run-1/regenerate-stale" });
    const retry = await app.inject({ method: "POST", url: "/api/runs/run-1/nodes/voice/retry" });

    assert.equal(costs.statusCode, 200);
    assert.equal(costs.json().totals.actualPendingCount, 1);
    assert.equal(override.statusCode, 200);
    assert.equal(inputOverride.statusCode, 200);
    assert.equal(spend.statusCode, 200);
    assert.equal(regenerate.statusCode, 200);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(calls, ["override:script:人工钩子:studio-owner", "input:script:人工题目:studio-owner", "spend:assets:MiniMax-Hailuo-02:studio-owner", "regenerate", "retry:voice"]);
    await app.close();
  });

  it("accepts a structured document override without trusting a client actor", async () => {
    const calls: Array<{ actor: string; input: unknown }> = [];
    const service = fakeService({
      applyNodeOverride: async (_runId, _nodeId, input, actor) => {
        calls.push({ actor, input });
        return runDetail("stale");
      },
    });
    const app = buildStudioApp({ service });

    const response = await app.inject({
      method: "PUT",
      url: "/api/runs/run-1/nodes/script/override",
      payload: {
        actor: "forged-actor",
        document: { artifactId: "artifact-script", content: { title: "人工脚本" } },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{
      actor: "studio-owner",
      input: { document: { artifactId: "artifact-script", content: { title: "人工脚本" } } },
    }]);
    await app.close();
  });

  it("exposes template catalog and validates template mutations", async () => {
    const template = {
      id: "knowledge-explainer",
      version: 1,
      status: "published" as const,
      name: "知识解释",
      description: "讲清一个问题。",
      category: "knowledge",
      platforms: ["douyin"],
      durationSeconds: 36,
      automationLevel: "assisted" as const,
      storyStructure: [{ id: "hook", label: "钩子", purpose: "提出问题", required: true }],
      shotSlots: [{ id: "shot-hook", beatId: "hook", purpose: "提出问题", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
      visualSystem: { composition: "主体清晰", colorIntent: "中性色", subtitleDensity: "medium" as const, pacing: "measured" as const },
      soundSystem: { voiceIntent: "可信", pace: "medium" as const, musicIntent: "克制" },
      qualityRules: [{ id: "facts", label: "事实", dimension: "factual" as const, required: true, threshold: 80 }],
      capabilityRequirements: [{ capability: "script.draft", required: true }],
      costPolicy: { currency: "CNY" as const, maxCost: 5, maxPaidShots: 1 },
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      builtIn: true,
    };
    const app = buildStudioApp({
      service: fakeService({
        listTemplates: async () => ({ storeRevision: 0, templates: [template] }),
        getTemplate: async () => template,
        cloneTemplate: async (input) => ({ storeRevision: 1, template: { ...template, id: input.newId, name: input.name, status: "draft", builtIn: false } }),
      }),
    });

    const catalog = await app.inject({ method: "GET", url: "/api/templates" });
    const cloned = await app.inject({
      method: "POST",
      url: "/api/templates/clone",
      headers: { "x-video-factory-request": "studio" },
      payload: { sourceId: "knowledge-explainer", newId: "my-explainer", name: "我的解释", expectedRevision: 0 },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/templates/clone",
      headers: { "x-video-factory-request": "studio" },
      payload: { sourceId: "knowledge-explainer", newId: "../escape", name: "错误", expectedRevision: 0 },
    });
    const invalidDraft = await app.inject({
      method: "PUT",
      url: "/api/templates/knowledge-explainer/draft",
      headers: { "x-video-factory-request": "studio" },
      payload: { expectedRevision: 0, template: { id: "knowledge-explainer", version: 1 } },
    });

    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().templates[0].name, "知识解释");
    assert.equal(cloned.statusCode, 201);
    assert.equal(cloned.json().template.id, "my-explainer");
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalidDraft.statusCode, 400);
    assert.match(invalidDraft.json().error, /模板参数不正确/);
    await app.close();
  });

  it("keeps health public while requiring a signed session for studio data", async () => {
    const app = buildStudioApp({
      service: fakeService(),
      ...{
        auth: {
          username: "owner",
          passwordHash: "scrypt:v1:dGVzdC1zYWx0:pmeouWD7DazLps4NKXPdmS3_gNAeOnnMRDfJz9l6RvU",
          sessionSecret: "test-session-secret-that-is-long-enough",
          secureCookie: true,
        },
      },
    } as Parameters<typeof buildStudioApp>[0]);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const session = await app.inject({ method: "GET", url: "/api/auth/session" });
    const settings = await app.inject({ method: "GET", url: "/api/settings" });

    assert.equal(health.statusCode, 200);
    assert.deepEqual(session.json(), { enabled: true, authenticated: false });
    assert.equal(settings.statusCode, 401);
    assert.deepEqual(settings.json(), { error: "请先登录 VideoFactory。" });
    await app.close();
  });

  it("creates and clears a secure single-user session", async () => {
    const app = buildStudioApp({
      service: fakeService(),
      ...{
        auth: {
          username: "owner",
          passwordHash: "scrypt:v1:dGVzdC1zYWx0:pmeouWD7DazLps4NKXPdmS3_gNAeOnnMRDfJz9l6RvU",
          sessionSecret: "test-session-secret-that-is-long-enough",
          secureCookie: true,
        },
      },
    } as Parameters<typeof buildStudioApp>[0]);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "wrong" },
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "correct horse battery staple" },
    });
    const cookie = accepted.headers["set-cookie"];

    assert.equal(rejected.statusCode, 401);
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().username, "owner");
    assert.match(String(cookie), /vf_session=/);
    assert.match(String(cookie), /HttpOnly/);
    assert.match(String(cookie), /SameSite=Strict/);
    assert.match(String(cookie), /Secure/);

    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: String(cookie) } });
    const settings = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie: String(cookie) } });
    assert.deepEqual(session.json(), { enabled: true, authenticated: true, username: "owner" });
    assert.equal(settings.statusCode, 200);

    const missingCsrf = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { cookie: String(cookie) },
      payload: { defaultRecipeId: "free-stock" },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const unsafeLogout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: String(cookie) },
    });
    assert.equal(unsafeLogout.statusCode, 403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: String(cookie), "x-video-factory-request": "studio" },
    });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    await app.close();
  });

  it("reports malformed JSON as a client error", async () => {
    const app = buildStudioApp({ service: fakeService() });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: '{"username":',
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "请求内容不是有效的 JSON。" });
    await app.close();
  });

  it("reads and persists creator defaults", async () => {
    let savedRecipe = "";
    const app = buildStudioApp({ service: fakeService({
      updateCreatorSettings: async (input) => {
        savedRecipe = input.defaultRecipeId ?? "";
        return {
          voiceDirection: input.voiceDirection ?? { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
          defaultRecipeId: input.defaultRecipeId ?? "economy-daily",
          productionDefaults: {
            directorProfileId: input.productionDefaults?.directorProfileId ?? "auto",
            reviewMode: input.productionDefaults?.reviewMode ?? "manual",
            platform: input.productionDefaults?.platform ?? "douyin",
            durationSeconds: input.productionDefaults?.durationSeconds ?? 24,
          },
          topicStrategy: input.topicStrategy ?? { customInstruction: "优先可拍、可核验、可连载的题材。" },
        };
      },
    }) });

    const initial = await app.inject({ method: "GET", url: "/api/settings" });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        voiceDirection: { profileId: "macos:Tingting", rate: 205, pauseScale: 1.1, masteringPreset: "social" },
        defaultRecipeId: "free-stock",
      },
    });

    assert.equal(initial.statusCode, 200);
    assert.equal(updated.statusCode, 200);
    assert.equal(savedRecipe, "free-stock");
    assert.equal(updated.json().voiceDirection.rate, 205);
    await app.close();
  });

  it("exposes the candidate inbox, adoption, and durable series routes", async () => {
    let receivedQuery: unknown;
    let adoptedId = "";
    const service = fakeService();
    service.listCandidateInbox = async (input) => {
      receivedQuery = input;
      return {
        items: [],
        facets: { total: 0, origins: {}, categories: {}, platforms: {}, verdicts: {} },
        generatedAt: "2026-08-24T09:00:00.000Z",
      };
    };
    service.adoptCandidate = async (candidateId) => {
      adoptedId = candidateId;
      return {
        id: candidateId,
        title: "AI 工作流",
        platform: "douyin",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "不知道是否真省时间",
        hook: "先验证，再下结论。",
        status: "shortlisted",
        score: {
          audienceReach: 80, visualFeasibility: 80, productionCostEfficiency: 80,
          novelty: 80, monetization: 60, seriesPotential: 80, complianceRisk: 10, final: 78,
        },
        scoreProvenance: { source: "热点候选", scoredAt: "2026-08-24T09:00:00.000Z" },
        evidence: [{ source: "dailyhot", platform: "douyin", keyword: "AI", strength: 90 }],
        createdAt: "2026-08-24T09:00:00.000Z",
        updatedAt: "2026-08-24T09:00:00.000Z",
      };
    };
    service.listSeries = async () => [];
    service.createSeries = async (input) => ({
      id: "series-1",
      ...input,
      status: "active",
      revision: 1,
      currentSeason: { number: 1, title: "第一季", arc: input.premise },
      bible: { rules: [input.premise], recurringElements: [], forbiddenChanges: [] },
      canon: { revision: 0, facts: [] },
      episodes: [],
      nextEpisodeNumber: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
    });
    let episodePlanInput: unknown;
    let linkedLegacyInput: unknown;
    service.updateSeriesEpisodePlan = async (seriesId, episodeNumber, input) => {
      episodePlanInput = { seriesId, episodeNumber, input };
      return {
        ...(await service.createSeries({
          name: "AI 下班实验室",
          premise: "每集验证一个普通人真能用上的 AI 方法。",
          audience: "普通上班族",
          platform: "douyin",
          category: "technology",
          track: "ai-after-work",
          pillars: ["真实任务实验", "成本与时间复盘"],
          tone: "克制、具体",
          visualStyle: "真实桌面操作与生活空镜",
        })),
        revision: input.expectedRevision + 1,
      };
    };
    service.linkLegacySeriesRun = async (seriesId, episodeNumber, runId) => {
      linkedLegacyInput = { seriesId, episodeNumber, runId };
      return service.createSeries({
        name: "AI 下班实验室",
        premise: "每集验证一个普通人真能用上的 AI 方法。",
        audience: "普通上班族",
        platform: "douyin",
        category: "technology",
        track: "ai-after-work",
        pillars: ["真实任务实验", "成本与时间复盘"],
        tone: "克制、具体",
        visualStyle: "真实桌面操作与生活空镜",
      });
    };
    const app = buildStudioApp({ service });

    const inbox = await app.inject({
      method: "GET",
      url: "/api/candidate-inbox?origins=trend&categories=technology&platforms=douyin&limit=12",
    });
    const adopted = await app.inject({
      method: "POST",
      url: "/api/candidate-inbox/trend-1/adopt",
      payload: { origin: "trend" },
    });
    const listedSeries = await app.inject({ method: "GET", url: "/api/series" });
    const createdSeries = await app.inject({
      method: "POST",
      url: "/api/series",
      payload: {
        name: "AI 下班实验室",
        premise: "每集验证一个普通人真能用上的 AI 方法。",
        audience: "普通上班族",
        platform: "douyin",
        category: "technology",
        track: "ai-after-work",
        pillars: ["真实任务实验", "成本与时间复盘"],
        tone: "克制、具体",
        visualStyle: "真实桌面操作与生活空镜",
      },
    });
    const updatedEpisode = await app.inject({
      method: "PATCH",
      url: "/api/series/series-1/episodes/2",
      payload: {
        expectedRevision: 3,
        pillar: "真实任务实验",
        title: "一条人工改写的单集",
        viewerPromise: "看到真实结论",
        hook: "先看结果",
        payoff: "完成验证",
        fromPrevious: ["承接上一集"],
        toNext: ["留下下一题"],
      },
    });
    const linkedLegacy = await app.inject({
      method: "POST",
      url: "/api/series/series-1/episodes/1/legacy-run",
      payload: { runId: "run-old-1" },
    });

    assert.equal(inbox.statusCode, 200);
    assert.deepEqual(receivedQuery, {
      origins: ["trend"],
      categories: ["technology"],
      platforms: ["douyin"],
      limit: 12,
    });
    assert.equal(adopted.statusCode, 201);
    assert.equal(adoptedId, "trend-1");
    assert.equal(listedSeries.statusCode, 200);
    assert.equal(createdSeries.statusCode, 201);
    assert.equal(createdSeries.json().track, "ai-after-work");
    assert.equal(updatedEpisode.statusCode, 200);
    assert.equal(linkedLegacy.statusCode, 200);
    assert.deepEqual(linkedLegacyInput, { seriesId: "series-1", episodeNumber: 1, runId: "run-old-1" });
    assert.deepEqual(episodePlanInput, {
      seriesId: "series-1",
      episodeNumber: 2,
      input: {
        expectedRevision: 3,
        pillar: "真实任务实验",
        title: "一条人工改写的单集",
        viewerPromise: "看到真实结论",
        hook: "先看结果",
        payoff: "完成验证",
        fromPrevious: ["承接上一集"],
        toNext: ["留下下一题"],
      },
    });
    await app.close();
  });

  it("returns runtime health and provider availability without secret values", async () => {
    const app = buildStudioApp({ service: fakeService({
      listTrendSources: async () => ([{
        id: "douyin-hotsearch",
        label: "抖音官方热点",
        kind: "native",
        status: "needs_config",
        description: "读取实时热点词。",
        cadence: "约 2 小时",
        requirement: "需要 hotsearch scope",
      }]),
    }) });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const providers = await app.inject({ method: "GET", url: "/api/providers" });
    const trendSources = await app.inject({ method: "GET", url: "/api/trend-sources" });

    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok", runtime: { ffmpeg: true, ffprobe: true, say: true } });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json()[1].available, false);
    assert.doesNotMatch(providers.body, /api[_-]?key.*[=:].+/i);
    assert.equal(trendSources.statusCode, 200);
    assert.equal(trendSources.json()[0].status, "needs_config");
    await app.close();
  });

  it("exposes self-hosted trend service health and normalized signals", async () => {
    let requestedPlatforms: string[] = [];
    const app = buildStudioApp({ service: fakeService({
      listTrendServices: async () => ([{
        id: "dailyhot",
        label: "DailyHotApi",
        kind: "aggregator",
        status: "ready",
        baseUrl: "http://127.0.0.1:6688",
        lastCheckedAt: "2026-08-24T08:00:00.000Z",
        itemCount: 30,
      }]),
      listTrendSignals: async (input) => {
        requestedPlatforms = input.platforms ?? [];
        return [{
          id: "dailyhot-1",
          sourceId: "dailyhot",
          platform: "douyin",
          title: "真实热点",
          rank: 1,
          collectedAt: "2026-08-24T08:00:00.000Z",
          url: "https://example.com/hot",
        }];
      },
    }) });

    const services = await app.inject({ method: "GET", url: "/api/trend-services" });
    const signals = await app.inject({ method: "GET", url: "/api/trend-signals?platforms=douyin,weibo&limit=12" });

    assert.equal(services.statusCode, 200);
    assert.equal(services.json()[0].status, "ready");
    assert.equal(signals.statusCode, 200);
    assert.equal(signals.json()[0].title, "真实热点");
    assert.deepEqual(requestedPlatforms, ["douyin", "weibo"]);
    await app.close();
  });

  it("exposes traceable trend candidates from the agent workflow", async () => {
    let refreshCalls = 0;
    const app = buildStudioApp({ service: fakeService({
      listTrendCandidates: async () => ([{
        id: "trend-1",
        title: "下班后的 AI 时间账本",
        platform: "douyin",
        track: "ai-daily-life",
        audience: "普通上班族",
        painPoint: "时间被工具反向占用",
        hook: "真正偷走你下班时间的，可能不是加班。",
        rationale: "抖音热点与低成本生活实验相交。",
        providerId: "api-topic-editor-v1",
        generatedAt: "2026-08-24T08:05:00.000Z",
        evidence: [{ source: "dailyhot", platform: "douyin", keyword: "AI 时间", strength: 96 }],
        score: {
          audienceReach: 90, visualFeasibility: 88, productionCostEfficiency: 90,
          novelty: 84, monetization: 72, seriesPotential: 88, complianceRisk: 12, final: 86,
        },
      }]),
      refreshTrendCandidates: async () => {
        refreshCalls += 1;
        return { refreshId: "refresh-1", status: "started", requestedAt: "2026-08-30T10:00:00.000Z" };
      },
    }) });

    const response = await app.inject({ method: "GET", url: "/api/trend-candidates" });
    const refreshed = await app.inject({ method: "POST", url: "/api/trend-candidates/refresh" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json()[0].providerId, "api-topic-editor-v1");
    assert.equal(response.json()[0].evidence[0].source, "dailyhot");
    assert.equal(refreshed.statusCode, 202);
    assert.equal(refreshed.json().status, "started");
    assert.equal(refreshed.json().refreshId, "refresh-1");
    assert.equal(refreshCalls, 1);
    await app.close();
  });

  it("reports the terminal state of a background trend refresh", async () => {
    const app = buildStudioApp({ service: fakeService() });

    const response = await app.inject({ method: "GET", url: "/api/trend-candidates/refresh/refresh-1" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().state, "succeeded");
    assert.equal(response.json().candidateCount, 8);
    await app.close();
  });

  it("exposes discovered local capabilities and serves generated voice previews", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-voice-preview-"));
    const previewPath = path.join(directory, "preview.m4a");
    await writeFile(previewPath, "audio-bytes", "utf8");
    let receivedProfile = "";
    const app = buildStudioApp({ service: fakeService({
      previewVoice: async (input) => {
        receivedProfile = input.profileId;
        return { path: previewPath, contentType: "audio/mp4", sizeBytes: 11 };
      },
    }) });

    const capabilities = await app.inject({ method: "GET", url: "/api/local-capabilities" });
    const voices = await app.inject({ method: "GET", url: "/api/voices" });
    const preview = await app.inject({
      method: "POST",
      url: "/api/voices/preview",
      payload: {
        profileId: "macos:Tingting",
        text: "先试听，再决定。",
        rate: 180,
        pauseScale: 1.1,
        masteringPreset: "natural",
      },
    });

    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.json()[0].state, "ready");
    assert.equal(voices.statusCode, 200);
    assert.equal(voices.json()[0].id, "macos:Tingting");
    assert.equal(preview.statusCode, 200);
    assert.match(preview.headers["content-type"] ?? "", /audio\/mp4/);
    assert.equal(preview.body, "audio-bytes");
    assert.equal(receivedProfile, "macos:Tingting");
    await app.close();
  });

  it("rejects malformed voice previews before synthesis", async () => {
    let called = false;
    const app = buildStudioApp({ service: fakeService({
      previewVoice: async () => {
        called = true;
        return undefined;
      },
    }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/voices/preview",
      payload: { profileId: "remote:voice", text: "试听", rate: 999, pauseScale: 1, masteringPreset: "loud" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
    await app.close();
  });

  it("lists, starts, loads, and decides runs through browser-safe routes", async () => {
    const app = buildStudioApp({ service: fakeService() });

    const list = await app.inject({ method: "GET", url: "/api/runs" });
    const started = await app.inject({ method: "POST", url: "/api/runs", headers: { "idempotency-key": "start-run-2" }, payload: { title: "第二条视频" } });
    const detail = await app.inject({ method: "GET", url: "/api/runs/run-1" });
    const decision = await app.inject({
      method: "POST",
      url: "/api/runs/run-1/decisions",
      payload: { action: "approve", actor: "jinkun", note: "检查通过" },
    });

    assert.equal(list.statusCode, 200);
    assert.equal(list.json()[0].id, "run-1");
    assert.equal(started.statusCode, 202);
    assert.deepEqual(started.json(), { runId: "run-2", status: "running" });
    assert.equal(detail.statusCode, 200);
    assert.equal(decision.statusCode, 200);
    assert.equal(decision.json().status, "succeeded");
    await app.close();
  });

  it("plans and dispatches an explicitly confirmed multi-platform publish batch", async () => {
    const app = buildStudioApp({ service: fakeService() });
    const readiness = await app.inject({ method: "GET", url: "/api/runs/run-1/publishing/readiness" });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/runs/run-1/publishing",
      payload: { requestId: "publish-1", platformIds: [], confirmations: {} },
    });
    const published = await app.inject({
      method: "POST",
      url: "/api/runs/run-1/publishing",
      payload: {
        requestId: "publish-1",
        platformIds: ["douyin"],
        confirmations: {
          finalContent: true,
          aigcDisclosure: true,
          rightsAndLikeness: true,
          factualAccuracy: true,
          commercialDisclosure: true,
        },
      },
    });

    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.json().targets[0].id, "douyin");
    assert.equal(invalid.statusCode, 400);
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().deliveries[0].externalId, "douyin-item");
    await app.close();
  });

  it("returns 404 for an unknown run", async () => {
    const app = buildStudioApp({ service: fakeService() });

    const response = await app.inject({ method: "GET", url: "/api/runs/missing" });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "没有找到这条制作记录。" });
    await app.close();
  });

  it("rejects unsafe route identifiers before they reach the service", async () => {
    let called = false;
    const app = buildStudioApp({ service: fakeService({
      getRun: async () => {
        called = true;
        return undefined;
      },
    }) });

    const response = await app.inject({ method: "GET", url: "/api/runs/..%252Foutside" });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "制作编号格式不正确。" });
    assert.equal(called, false);
    await app.close();
  });

  it("rejects malformed decision input before calling the service", async () => {
    let called = false;
    const app = buildStudioApp({ service: fakeService({
      decide: async () => {
        called = true;
        throw new Error("should not be called");
      },
    }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/runs/run-1/decisions",
      payload: { action: "publish", actor: "" },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(called, false);
    await app.close();
  });

  it("streams run snapshots as server-sent events and closes on a terminal state", async () => {
    let unsubscribed = false;
    const app = buildStudioApp({ service: fakeService({
      getRun: async () => runDetail("running"),
      subscribe: (_runId, listener) => {
        setTimeout(() => listener(runDetail("succeeded")), 0);
        return () => {
          unsubscribed = true;
        };
      },
    }) });

    const response = await app.inject({ method: "GET", url: "/api/runs/run-1/events" });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
    assert.match(response.body, /event: run/);
    assert.match(response.body, /event: heartbeat/);
    assert.match(response.body, /"status":"running"/);
    assert.match(response.body, /"status":"succeeded"/);
    assert.equal(unsubscribed, true);
    await app.close();
  });

  it("buffers a terminal event emitted while the initial SSE snapshot is loading", async () => {
    let listener: ((run: StudioRunDetail) => void) | undefined;
    let unsubscribed = false;
    const app = buildStudioApp({ service: fakeService({
      subscribe: (_runId, nextListener) => {
        listener = nextListener;
        return () => {
          unsubscribed = true;
        };
      },
      getRun: async () => {
        listener?.(runDetail("succeeded"));
        return runDetail("running");
      },
    }) });

    const response = await app.inject({ method: "GET", url: "/api/runs/run-1/events" });

    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /"status":"running"/);
    assert.match(response.body, /"status":"succeeded"/);
    assert.equal(unsubscribed, true);
    await app.close();
  });

  it("returns a path-safe internal error response", async () => {
    const app = buildStudioApp({ service: fakeService({
      listRuns: async () => {
        throw new Error("EACCES: /Users/private/workspace/runs.json");
      },
    }) });

    const response = await app.inject({ method: "GET", url: "/api/runs" });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: "Internal server error." });
    assert.doesNotMatch(response.body, /Users\/private/);
    await app.close();
  });

  it("serves complete and ranged artifact content", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-api-"));
    const artifactPath = path.join(directory, "final.mp4");
    await writeFile(artifactPath, "0123456789", "utf8");
    const app = buildStudioApp({ service: fakeService({
      resolveArtifact: async () => ({ path: artifactPath, contentType: "video/mp4", sizeBytes: 10 }),
    }) });

    const complete = await app.inject({ method: "GET", url: "/api/runs/run-1/artifacts/video/content" });
    const partial = await app.inject({
      method: "GET",
      url: "/api/runs/run-1/artifacts/video/content",
      headers: { range: "bytes=2-5" },
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/api/runs/run-1/artifacts/video/content",
      headers: { range: "bytes=20-30" },
    });

    assert.equal(complete.statusCode, 200);
    assert.equal(complete.body, "0123456789");
    assert.equal(complete.headers["accept-ranges"], "bytes");
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.body, "2345");
    assert.equal(partial.headers["content-range"], "bytes 2-5/10");
    assert.equal(partial.headers["content-length"], "4");
    assert.equal(invalid.statusCode, 416);
    assert.equal(invalid.headers["content-range"], "bytes */10");
    await app.close();
  });

  it("creates, lists, loads, and updates opportunities through validated routes", async () => {
    const opportunity: StudioOpportunity = {
      id: "opportunity-1",
      title: "下班后什么都不想做，是懒还是耗竭？",
      platform: "douyin",
      track: "ordinary-life",
      audience: "普通上班族",
      painPoint: "下班后没有精力",
      hook: "你不是懒，只是累了。",
      status: "shortlisted",
      evidence: [{ source: "manual", platform: "douyin", keyword: "下班后", strength: 86 }],
      score: {
        audienceReach: 88,
        visualFeasibility: 90,
        productionCostEfficiency: 84,
        novelty: 78,
        monetization: 62,
        seriesPotential: 91,
        complianceRisk: 18,
        final: 84,
      },
      scoreProvenance: {
        source: "人工维度评分 · topic-intelligence-v1",
        scoredAt: "2026-08-22T10:00:00.000Z",
      },
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:00:00.000Z",
    };
    const service = {
      ...fakeService(),
      listOpportunities: async () => [opportunity],
      getOpportunity: async (id: string) => id === opportunity.id ? opportunity : undefined,
      createOpportunity: async () => opportunity,
      updateOpportunityStatus: async (_id: string, status: StudioOpportunity["status"]) => ({ ...opportunity, status }),
    } as StudioServicePort;
    const app = buildStudioApp({ service });

    const list = await app.inject({ method: "GET", url: "/api/opportunities" });
    const created = await app.inject({
      method: "POST",
      url: "/api/opportunities",
      payload: {
        ...opportunity,
        scores: { ...opportunity.score, final: undefined },
      },
    });
    const detail = await app.inject({ method: "GET", url: "/api/opportunities/opportunity-1" });
    const status = await app.inject({
      method: "PATCH",
      url: "/api/opportunities/opportunity-1/status",
      payload: { status: "approved" },
    });

    assert.equal(list.statusCode, 200);
    assert.equal(created.statusCode, 201);
    assert.equal(detail.statusCode, 200);
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().status, "approved");
    await app.close();
  });
});
