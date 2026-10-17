import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { StudioPublishInput, StudioRunDetail } from "../src/shared/api.js";
import { PublishingStudio, type PlatformPublisher } from "../src/server/publishing-studio.js";
import { ProductionPipeline, type ProductionBrief, type WorkerResponse, type WorkflowRun } from "@video-factory/production-pipeline";
import { StudioService } from "../src/server/studio-service.js";
import { buildStudioApp } from "../src/server/app.js";
import { studioApi, StudioApiError } from "../src/client/api.js";
import { ResourceGovernanceStudio } from "../src/server/resource-governance-studio.js";
import { explicitEditorialDirector, localEditorialAssetProvider } from "../../../packages/production-pipeline/src/cli.js";

const completedRun: StudioRunDetail = {
  id: "run-1",
  title: "下班后的第一个小时",
  status: "succeeded",
  platform: "douyin",
  durationSeconds: 24,
  startedAt: "2026-08-25T00:00:00.000Z",
  finishedAt: "2026-08-25T00:01:00.000Z",
  currentNodeId: "publish-package",
  revision: 9,
  angle: "用一个真实动作降低决策消耗",
  audience: "普通上班族",
  nicheSlug: "after-work",
  reviewMode: "manual",
  nodes: [],
  artifacts: [
    { id: "video", kind: "render", createdAt: "2026-08-25T00:00:50.000Z", contentType: "video/mp4", licenseNote: "Owner-generated render.", contentUrl: "/api/video" },
    { id: "package", kind: "publish_package", createdAt: "2026-08-25T00:01:00.000Z", contentType: "application/json", licenseNote: "Approved publish package.", contentUrl: "/api/package" },
  ],
  decisions: [{ id: "decision-1", action: "approve", actor: "director", createdAt: "2026-08-25T00:01:00.000Z" }],
  videoArtifactId: "video",
  publishPackageArtifactId: "package",
  continuation: { supported: true },
};

const loadPublishPackage = async () => ({
  aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
  resourceManifest: { needsReviewCount: 0 },
  artifacts: [
    { id: "video", kind: "render", provenance: { licenseNote: "Owner-generated render." } },
    { id: "asset-1", kind: "media_asset", provenance: { licenseNote: "Provider terms recorded." } },
  ],
});

/** 与 completedRun 同一投影的所见快照（R7）：readiness 返回、提交原样带回。 */
function completedRunSnapshot() {
  return {
    revision: completedRun.revision,
    videoArtifactId: completedRun.videoArtifactId ?? null,
    publishPackageArtifactId: completedRun.publishPackageArtifactId ?? null,
  };
}

function confirmedInput(requestId = "publish-request-1") {
  return {
    requestId,
    platformIds: ["douyin", "kuaishou"] as const,
    confirmations: {
      finalContent: true,
      aigcDisclosure: true,
      rightsAndLikeness: true,
      factualAccuracy: true,
      commercialDisclosure: true,
    },
    expected: completedRunSnapshot(),
  };
}

async function approvedPublishingFixture() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-r7-pipeline-"));
  const pipeline = new ProductionPipeline({ workspaceRoot, directorAgent: explicitEditorialDirector,
    assetProviders: [localEditorialAssetProvider], worker: { async run(request): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, string | boolean>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
      "asset.prepare": { assetPlanPath: path.join(outputDir, "assets.json") },
      "voice.synthesize": { voiceoverPlanPath: path.join(outputDir, "voice.json"), trackPath: path.join(outputDir, "audio.m4a") },
      "video.render": { videoPath: path.join(outputDir, "video.mp4"), renderManifestPath: path.join(outputDir, "manifest.json") },
      "quality.review": { reviewPath: path.join(outputDir, "review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected isolated capability ${capability}`);
    const script = { scenes: [1, 2, 3, 4].map(position => ({ position, duration: 5, narration: `第${position}幕`,
      visual_strategy: "local", visual_prompt: "说明卡片", on_screen_text: "确认内容", sound_cue: "环境声" })) };
    for (const file of Object.values(output).filter((value): value is string => typeof value === "string")) {
      await writeFile(file, capability === "script.draft" ? JSON.stringify(script)
        : file === output.renderManifestPath ? JSON.stringify({ duration_target: 20, slides: [1, 2, 3, 4].map(position => ({ position, duration: 5 })) })
          : JSON.stringify({ capability, file }));
    }
    return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded", output,
      artifacts: await Promise.all(Object.values(output).filter((value): value is string => typeof value === "string").map(async uri => {
        const bytes = await readFile(uri);
        return { kind: uri === output.videoPath ? "render" : uri === output.scriptPath ? "script" : uri === output.trackPath ? "voiceover" : capability.replace(".", "_"),
          uri, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
          contentType: uri === output.videoPath ? "video/mp4" : uri === output.trackPath ? "audio/mp4" : "application/json",
          provenance: { providerId: String((request.parameters as Record<string, unknown>).providerId), producerNodeId: String(request.nodeRunId),
            attempt: Number(request.attempt), licenseNote: "R7 isolated pipeline media fixture; no external provider." } };
      })) };
  } } });
  const waiting = await pipeline.start({ protocolVersion: "video-factory/brief-v1", title: "发布快照验证", angle: "两步确认", audience: "测试",
    nicheSlug: "life-avoidance", durationSeconds: 30, durationRange: { minSeconds: 20, maxSeconds: 40 },
    platform: "douyin", reviewMode: "manual", runPurpose: "test",
    director: {  assetProviderIds: ["local-editorial-v1"] },
    workflowFeatures: { executablePlan: true, assetSemanticRank: false, referenceGrammar: false },
    providers: { script: "python-template-v1", director: "explicit-editorial-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1" } });
  assert.equal(waiting.status, "needs_human", JSON.stringify(waiting.nodeRuns.map(node => ({ nodeId: node.nodeId, status: node.status, error: node.error }))));
  const finalReview = waiting.nodeRuns.find(node => node.nodeId === "final-review");
  assert.ok(finalReview?.intervention);
  const approved = await pipeline.decide(waiting.id, { interventionId: finalReview.intervention.id, action: "approve", actor: "r7-owner",
    expectedRunRevision: waiting.revision, reviewEvidenceId: null });
  assert.equal(approved.status, "succeeded", JSON.stringify(approved.nodeRuns));
  assert.ok(approved.decisions.some(decision => decision.action === "approve" && decision.interventionId === finalReview.intervention!.id));
  assert.ok(approved.artifacts.some(artifact => artifact.kind === "publish_package"));
  const service = new StudioService({ workspaceRoot, pipeline, environment: {}, commandAvailable: async () => false });
  return { workspaceRoot, pipeline, service, approved, async close() { await rm(workspaceRoot, { recursive: true, force: true }); } };
}

async function publishingHttpFixture(t: TestContext) {
  const fixture = await approvedPublishingFixture();
  const app = buildStudioApp({ service: fixture.service });
  t.after(async () => { await app.close(); await fixture.close(); });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const nativeFetch = globalThis.fetch;
  const posts: Array<{ serialized: string; input: StudioPublishInput; status: number }> = [];
  let dropAcceptedResponse = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(typeof url, "string");
    const target = new URL(String(url), origin);
    assert.equal(target.origin, origin, "R7 client transport is restricted to the isolated loopback server");
    const response = await nativeFetch(target, init);
    if (init?.method === "POST") {
      assert.equal(new Headers(init.headers).get("x-video-factory-request"), "studio");
      assert.equal(typeof init.body, "string");
      posts.push({ serialized: String(init.body), input: JSON.parse(String(init.body)) as StudioPublishInput, status: response.status });
      if (dropAcceptedResponse && response.ok) {
        dropAcceptedResponse = false;
        // 服务端已完成真实请求并落盘；只丢掉返回客户端的响应，不伪造受理或回执。
        await response.arrayBuffer();
        throw new TypeError("R7 accepted HTTP response was lost");
      }
    }
    return response;
  });
  return { ...fixture, posts, loseNextAcceptedResponse() { dropAcceptedResponse = true; } };
}

async function regenerateApprovedPublishingRun(fixture: Awaited<ReturnType<typeof approvedPublishingFixture>>) {
  const previous = await fixture.pipeline.loadPersisted(fixture.approved.id);
  const brief = previous.nodeRuns.find(node => node.nodeId === "brief");
  assert.ok(brief);
  const stale = await fixture.pipeline.applyNodeOverride(previous.id, {
    nodeId: "brief", actor: "r7-editor", allowTerminalEdit: true,
    expectedVersionId: brief.outputState?.effectiveVersionId ?? null,
    expectedRunRevision: previous.revision,
    output: { ...(brief.output as ProductionBrief), title: "发布快照验证第二版" },
  });
  assert.equal(stale.status, "stale");
  const waiting = await fixture.pipeline.resumeStale(stale.id);
  assert.equal(waiting.status, "needs_human", JSON.stringify(waiting.nodeRuns.map(node => ({ nodeId: node.nodeId, status: node.status, error: node.error }))));
  const review = waiting.nodeRuns.find(node => node.nodeId === "final-review");
  assert.ok(review?.intervention);
  assert.ok(!previous.decisions.some(decision => decision.interventionId === review.intervention!.id));
  const approved = await fixture.pipeline.decide(waiting.id, {
    interventionId: review.intervention.id, action: "approve", actor: "r7-editor",
    expectedRunRevision: waiting.revision, reviewEvidenceId: null,
  });
  assert.equal(approved.status, "succeeded");
  assert.ok(approved.decisions.some(decision => decision.action === "approve" && decision.interventionId === review.intervention!.id));
  assert.ok(approved.revision > previous.revision);
  return approved;
}

async function publishingFiles(workspaceRoot: string, runId: string): Promise<Record<string, string>> {
  const directory = path.join(workspaceRoot, "runs", runId, "publishing");
  const names = await readdir(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, await readFile(path.join(directory, name), "utf8")])));
}

function isHttpError(status: number, message: RegExp) {
  return (error: unknown) => error instanceof StudioApiError && error.status === status && message.test(error.message);
}

describe("PublishingStudio", () => {
  it("R7 HTTP client rejects an unseen legally regenerated version before writing any journal", { timeout: 30_000 }, async t => {
    const fixture = await publishingHttpFixture(t);
    const { workspaceRoot, approved } = fixture;
    const viewed = await studioApi.publishReadiness(approved.id);
    assert.equal(viewed.ready, true);
    const oldIntent: StudioPublishInput = { ...confirmedInput("r7-http-stale-first"), platformIds: ["douyin"], expected: viewed.snapshot };
    const revised = await regenerateApprovedPublishingRun(fixture);
    assert.equal(revised.id, approved.id);
    await assert.rejects(() => studioApi.publish(approved.id, oldIntent), isHttpError(409, /已有更新/));
    assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), {}, "旧快照首次提交不能留下 journal、delivery 或回执");

    const refreshed = await studioApi.publishReadiness(approved.id);
    assert.equal(refreshed.ready, true, JSON.stringify(refreshed.checks));
    assert.equal(refreshed.snapshot.revision, revised.revision);
    assert.notEqual(refreshed.snapshot.videoArtifactId, viewed.snapshot.videoArtifactId);
    assert.notEqual(refreshed.snapshot.publishPackageArtifactId, viewed.snapshot.publishPackageArtifactId);
    assert.ok(refreshed.targets.filter(target => target.id === "douyin" || target.id === "xiaohongshu").every(target => target.status === "manual_only"));
    const next: StudioPublishInput = { ...confirmedInput("r7-http-fresh-confirmed"), platformIds: ["douyin"], expected: refreshed.snapshot };
    await assert.rejects(() => studioApi.publish(approved.id, { ...next, confirmations: { ...next.confirmations, finalContent: false } }),
      isHttpError(400, /全部发布合规确认/));
    assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), {});
    const batch = await studioApi.publish(approved.id, next);
    assert.deepEqual(batch.deliveries.map(delivery => delivery.status), ["export_ready"]);
    const accepted = await publishingFiles(workspaceRoot, approved.id);
    assert.deepEqual(await studioApi.publish(approved.id, next), batch);
    assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), accepted, "同版本重放不重写原 journal 或回执");
  });

  it("R7 HTTP response loss and a real lease conflict preserve the original request and durable receipt", { timeout: 30_000 }, async t => {
    const fixture = await publishingHttpFixture(t);
    const { pipeline, workspaceRoot, approved } = fixture;
    const readiness = await studioApi.publishReadiness(approved.id);
    const input: StudioPublishInput = { ...confirmedInput("r7-http-lost-response"), platformIds: ["douyin", "xiaohongshu"], expected: readiness.snapshot };
    const runPath = path.join(workspaceRoot, "runs", approved.id, "run.json");
    const runBefore = await readFile(runPath, "utf8");
    fixture.loseNextAcceptedResponse();
    await assert.rejects(() => studioApi.publish(approved.id, input), /accepted HTTP response was lost/);
    const accepted = await publishingFiles(workspaceRoot, approved.id);
    assert.deepEqual(Object.keys(accepted).sort(), [`${input.requestId}.journal.json`, `${input.requestId}.json`].sort());
    const journal = JSON.parse(accepted[`${input.requestId}.journal.json`]!) as { state: string; deliveries: Array<{ status: string }> };
    assert.equal(journal.state, "completed");
    assert.deepEqual(journal.deliveries.map(delivery => delivery.status), ["export_ready", "export_ready"]);

    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = pipeline.withRunMaintenanceLease([approved.id], async () => { entered(); await gate; });
    try {
      await ready;
      await assert.rejects(() => studioApi.publish(approved.id, input), isHttpError(409, /正在执行、编辑或归档/));
      assert.deepEqual((await studioApi.publishReadiness(approved.id)).snapshot, readiness.snapshot);
      assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), accepted);
    } finally {
      release();
      await held;
    }
    const replay = await studioApi.publish(approved.id, input);
    assert.deepEqual(replay, JSON.parse(accepted[`${input.requestId}.json`]!));
    assert.deepEqual(fixture.posts.map(post => post.status), [200, 409, 200]);
    assert.ok(fixture.posts.every(post => post.serialized === fixture.posts[0]!.serialized));
    assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), accepted, "重试没有重写 delivery、journal 或原回执");
    assert.equal(await readFile(runPath, "utf8"), runBefore, "发布重试不能改写 run");
  });

  it("R7 HTTP client cannot move an accepted request to a later legally approved version", { timeout: 30_000 }, async t => {
    const fixture = await publishingHttpFixture(t);
    const { workspaceRoot, approved } = fixture;
    const viewed = await studioApi.publishReadiness(approved.id);
    const original: StudioPublishInput = { ...confirmedInput("r7-http-bound-original"), platformIds: ["douyin"], expected: viewed.snapshot };
    await studioApi.publish(approved.id, original);
    const accepted = await publishingFiles(workspaceRoot, approved.id);
    await regenerateApprovedPublishingRun(fixture);
    const refreshed = await studioApi.publishReadiness(approved.id);
    await assert.rejects(() => studioApi.publish(approved.id, original), isHttpError(409, /已有更新/));
    await assert.rejects(() => studioApi.publish(approved.id, { ...original, expected: refreshed.snapshot }), isHttpError(400, /已经绑定/));
    assert.deepEqual(await publishingFiles(workspaceRoot, approved.id), accepted, "已受理 ID 不可迁移到新版本或覆盖原回执");
    const next = { ...original, requestId: "r7-http-explicit-new", expected: refreshed.snapshot };
    assert.deepEqual((await studioApi.publish(approved.id, next)).deliveries.map(delivery => delivery.status), ["export_ready"]);
    const afterNewIntent = await publishingFiles(workspaceRoot, approved.id);
    for (const [name, bytes] of Object.entries(accepted)) assert.equal(afterNewIntent[name], bytes);
  });

  it("R7 reads package and rights from the same legally approved pipeline snapshot", async t => {
    const fixture = await approvedPublishingFixture();
    t.after(() => fixture.close());
    const { pipeline, service, approved } = fixture;
    let showReads = 0;
    let persistedReads = 0;
    let scanReads = 0;
    const show = pipeline.show.bind(pipeline);
    const load = pipeline.loadPersisted.bind(pipeline);
    const scan = pipeline.scanRuns.bind(pipeline);
    pipeline.show = async runId => { showReads += 1; return show(runId); };
    pipeline.loadPersisted = async runId => { persistedReads += 1; return load(runId); };
    pipeline.scanRuns = async () => { scanReads += 1; return scan(); };
    const readiness = await service.publishReadiness(approved.id);
    assert.equal(readiness.ready, true, JSON.stringify(readiness.checks));
    assert.deepEqual({ showReads, persistedReads, scanReads }, { showReads: 0, persistedReads: 1, scanReads: 0 },
      "发布快照及其包/授权检查必须消费同一份原 run，不走完整详情的跨 run 读取");
    const next = { ...confirmedInput("r7-legal-snapshot"), platformIds: ["douyin"] as const, expected: readiness.snapshot };
    const batch = await service.publish(approved.id, next);
    assert.deepEqual(batch.deliveries.map(delivery => delivery.status), ["export_ready"]);
    assert.deepEqual({ showReads, persistedReads, scanReads }, { showReads: 0, persistedReads: 2, scanReads: 0 });
  });

  it("R7 does not combine old snapshot readiness with a newer resource manifest", async t => {
    const fixture = await approvedPublishingFixture();
    t.after(() => fixture.close());
    const { pipeline, service, approved } = fixture;
    const show = pipeline.show.bind(pipeline);
    const load = pipeline.loadPersisted.bind(pipeline);
    const staleRead = (runId: string) => runId === approved.id ? structuredClone(approved) : load(runId);
    pipeline.show = async runId => runId === approved.id ? structuredClone(approved) : show(runId);
    pipeline.loadPersisted = async runId => staleRead(runId);
    const manifest = approved.artifacts.find(artifact => artifact.kind === "resource_manifest");
    assert.ok(manifest?.uri);
    const changedManifest = path.join(path.dirname(manifest.uri), "newer-resource-manifest.json");
    await writeFile(changedManifest, JSON.stringify({ version: "video-factory/resource-manifest-v1", runId: approved.id, items: [{
      id: "newer-unapproved-rights", category: "visual", kind: "human_media_revision", providerId: "human-editor",
      commercialUse: "review_required", attributionRequirement: "unknown", reviewStatus: "needs_review",
    }] }));
    const newer: WorkflowRun<ProductionBrief> = { ...structuredClone(approved), revision: approved.revision + 1,
      artifacts: [...approved.artifacts.filter(artifact => artifact.kind !== "resource_manifest"), { ...manifest, uri: changedManifest }] };
    pipeline.scanRuns = async () => ({ runs: [newer], issues: [], complete: true });
    pipeline.list = async () => [newer];
    assert.equal(await new ResourceGovernanceStudio(fixture.workspaceRoot, async () => [newer]).needsReviewCount(approved.id), 1);
    const readiness = await service.publishReadiness(approved.id);
    assert.equal(readiness.snapshot.revision, approved.revision);
    assert.equal(readiness.checks.find(check => check.id === "rights")?.status, "passed", "旧投影只使用其自己的资源清单，不能混用新 run 的待复核事实");
  });

  it("blocks a legacy completed run before any publisher call", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-legacy-publishing-"));
    let calls = 0;
    const publisher: PlatformPublisher = {
      target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
      publish: async () => { calls += 1; return { externalId: "douyin-legacy", reviewStatus: "processing" }; },
    };
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => ({
        ...completedRun,
        continuation: { supported: false, reason: "这条制作来自旧版工作流，只能查看现有结果。" },
      }),
      loadPublishPackage,
      publishers: [publisher],
    });

    const readiness = await subject.readiness("run-1");
    assert.equal(readiness.ready, false);
    assert.equal(readiness.checks.find((check) => check.id === "continuation")?.status, "blocked");
    await assert.rejects(
      () => subject.publish("run-1", { ...confirmedInput(), platformIds: ["douyin"] }),
      /旧版|重新制作|不能发布/,
    );
    assert.equal(calls, 0);
  });

  it("blocks unfinished runs and incomplete legal confirmations before any external call", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    let calls = 0;
    const publisher: PlatformPublisher = {
      target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
      publish: async () => { calls += 1; return { externalId: "douyin-1", reviewStatus: "processing" }; },
    };
    const unfinished = new PublishingStudio({
      workspaceRoot,
      getRun: async () => ({ ...completedRun, status: "needs_human", publishPackageArtifactId: undefined }),
      loadPublishPackage,
      publishers: [publisher],
    });
    const readiness = await unfinished.readiness("run-1");
    assert.equal(readiness.ready, false);
    assert.ok(readiness.checks.some((check) => check.status === "blocked"));
    await assert.rejects(() => unfinished.publish("run-1", {
      ...confirmedInput(),
      confirmations: { ...confirmedInput().confirmations, aigcDisclosure: false },
    }), /批准|确认/);
    assert.equal(calls, 0);
  });

  it("does not label a legacy automatic run as human-approved", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => ({ ...completedRun, reviewMode: "automatic", decisions: [] }),
      loadPublishPackage,
      publishers: [],
    });

    const readiness = await subject.readiness("run-1");

    assert.equal(readiness.ready, false);
    assert.match(readiness.checks.find((check) => check.id === "approval")?.detail ?? "", /人工批准/);
  });

  it("blocks a human replacement that still carries the previous stock license", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({
        aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
        resourceManifest: { needsReviewCount: 1 },
        artifacts: [{
          kind: "human_media_revision",
          provenance: { providerId: "human-editor", licenseNote: "Human-selected replacement; usage rights require manual verification before publishing." },
        }],
      }),
      publishers: [],
    });

    const readiness = await subject.readiness("run-1");

    assert.equal(readiness.ready, false);
    assert.match(readiness.checks.find((check) => check.id === "rights")?.detail ?? "", /人工替换素材.*确认版权/);
  });

  it("blocks resources that have a note but are still marked for rights review", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({
        aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
        resourceManifest: { needsReviewCount: 2 },
        artifacts: [{
          kind: "media_asset",
          provenance: { licenseNote: "Asset rights require review." },
        }],
      }),
      publishers: [],
    });

    const readiness = await subject.readiness("run-1");

    assert.equal(readiness.ready, false);
    assert.match(readiness.checks.find((check) => check.id === "rights")?.detail ?? "", /2 项.*待授权复核/);
  });

  it("uses the effective review ledger for the rights publishing gate", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-review-ledger-"));
    const confirmed = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({ ...(await loadPublishPackage()), resourceManifest: { needsReviewCount: 1 } }),
      loadEffectiveResourceReviewCount: async () => 0,
      publishers: [],
    });
    assert.equal((await confirmed.readiness("run-1")).checks.find((check) => check.id === "rights")?.status, "passed");

    const rejected = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      loadEffectiveResourceReviewCount: async () => 1,
      publishers: [],
    });
    const rights = (await rejected.readiness("run-1")).checks.find((check) => check.id === "rights");
    assert.equal(rights?.status, "blocked");
    assert.match(rights?.detail ?? "", /1 项.*待授权复核/);
  });

  it("falls back to the immutable package review count when the live manifest is unavailable", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-review-fallback-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({ ...(await loadPublishPackage()), resourceManifest: { needsReviewCount: 2 } }),
      loadEffectiveResourceReviewCount: async () => undefined,
      publishers: [],
    });

    const rights = (await subject.readiness("run-1")).checks.find((check) => check.id === "rights");
    assert.equal(rights?.status, "blocked");
    assert.match(rights?.detail ?? "", /2 项.*待授权复核/);
  });

  it("fails closed when a legacy publish package has no artifact snapshot", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({
        aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
        resourceManifest: { needsReviewCount: 0 },
      }),
      publishers: [],
    });

    const readiness = await subject.readiness("run-1");

    assert.equal(readiness.ready, false);
    assert.match(readiness.checks.find((check) => check.id === "rights")?.detail ?? "", /缺少素材快照/);
  });

  it("blocks a publish package that points at an older render revision", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage: async () => ({
        aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
        resourceManifest: { needsReviewCount: 0 },
        artifacts: [
          { id: "old-video", kind: "render", provenance: { licenseNote: "Owner-generated render." } },
          { id: "asset-1", kind: "media_asset", provenance: { licenseNote: "Provider terms recorded." } },
        ],
      }),
      publishers: [],
    });

    const readiness = await subject.readiness("run-1");

    assert.equal(readiness.ready, false);
    assert.match(readiness.checks.find((check) => check.id === "video-binding")?.detail ?? "", /当前成片版本/);
  });

  it("dispatches ready platforms once and reuses the persisted result for the same request ID", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const calls: string[] = [];
    const publishers: PlatformPublisher[] = ["douyin", "kuaishou"].map((id) => ({
      target: { id: id as "douyin" | "kuaishou", label: id, mode: "official_api", status: "ready" },
      publish: async (request) => {
        calls.push(request.platformId);
        return { externalId: `${request.platformId}-item`, reviewStatus: "processing" };
      },
    }));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      publishers,
      now: () => new Date("2026-08-25T00:02:00.000Z"),
    });

    const first = await subject.publish("run-1", confirmedInput());
    const repeated = await subject.publish("run-1", confirmedInput());

    assert.equal(first.status, "succeeded");
    assert.deepEqual(first.deliveries.map((delivery) => delivery.status), ["submitted", "submitted"]);
    assert.deepEqual(calls, ["douyin", "kuaishou"]);
    assert.deepEqual(repeated, first);
  });

  it("keeps successful receipts when another platform fails", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      publishers: [
        {
          target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
          publish: async () => ({ externalId: "douyin-item", reviewStatus: "processing" }),
        },
        {
          target: { id: "kuaishou", label: "快手", mode: "official_api", status: "ready" },
          publish: async () => { throw new Error("rate limited"); },
        },
      ],
    });

    const batch = await subject.publish("run-1", confirmedInput("publish-request-partial"));

    assert.equal(batch.status, "partial");
    assert.equal(batch.deliveries.find((item) => item.platformId === "douyin")?.status, "submitted");
    assert.equal(batch.deliveries.find((item) => item.platformId === "kuaishou")?.status, "failed");
  });

  it("coalesces concurrent retries with the same idempotency key", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    let calls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      publishers: [{
        target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        publish: async () => {
          calls += 1;
          markStarted();
          await gate;
          return { externalId: "douyin-item", reviewStatus: "processing" };
        },
      }],
    });
    const input = { ...confirmedInput("publish-request-concurrent"), platformIds: ["douyin"] as const };

    const first = subject.publish("run-1", input);
    const second = subject.publish("run-1", input);
    await started;
    assert.equal(calls, 1);
    release();

    assert.deepEqual(await second, await first);
  });

  it("rejects reuse of a request ID with different platform or confirmation data", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      targets: [
        { id: "douyin", label: "抖音", mode: "export_package", status: "manual_only" },
        { id: "kuaishou", label: "快手", mode: "export_package", status: "manual_only" },
      ],
    });
    const requestId = "publish-request-bound";

    await subject.publish("run-1", { ...confirmedInput(requestId), platformIds: ["douyin"] });
    const accepted = await publishingFiles(workspaceRoot, "run-1");

    await assert.rejects(
      () => subject.publish("run-1", { ...confirmedInput(requestId), platformIds: ["kuaishou"] }),
      /已经绑定/,
    );
    await assert.rejects(
      () => subject.publish("run-1", { ...confirmedInput(requestId), platformIds: ["douyin"],
        confirmations: { ...confirmedInput().confirmations, rightsAndLikeness: false } }),
      /全部发布合规确认/,
    );
    assert.deepEqual(await publishingFiles(workspaceRoot, "run-1"), accepted);
  });

  it("rejects an old publish request after the approved run revision changes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    let currentRun = completedRun;
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => currentRun,
      loadPublishPackage,
      targets: [{ id: "douyin", label: "抖音", mode: "export_package", status: "manual_only" }],
    });
    const input = { ...confirmedInput("publish-request-version-bound"), platformIds: ["douyin"] as const };

    const accepted = await subject.publish("run-1", input);
    assert.equal(accepted.status, "succeeded");
    currentRun = { ...completedRun, revision: completedRun.revision + 1 };

    // R7：已受理意图跨版本重发在租约内快照比对即拒绝，原回执不被替换。
    await assert.rejects(() => subject.publish("run-1", input), /自你核对发布条件以来这条制作已有更新/);
    const replayWithFreshSnapshot = { ...input, expected: { ...input.expected, revision: completedRun.revision + 1 } };
    await assert.rejects(() => subject.publish("run-1", replayWithFreshSnapshot), /已经绑定到另一组平台、确认内容或制作版本/);
  });

  it("never replays a platform call whose prior process outcome is uncertain", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const input = { ...confirmedInput("publish-request-uncertain"), platformIds: ["douyin"] as const };
    const requestDigest = createHash("sha256").update(JSON.stringify({
      runId: "run-1",
      platformIds: input.platformIds,
      confirmations: input.confirmations,
      revision: completedRun.revision,
      videoArtifactId: completedRun.videoArtifactId,
      publishPackageArtifactId: completedRun.publishPackageArtifactId,
    })).digest("hex");
    const directory = path.join(workspaceRoot, "runs", "run-1", "publishing");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${input.requestId}.journal.json`), JSON.stringify({
      version: "video-factory/publish-journal-v1",
      runId: "run-1",
      requestId: input.requestId,
      requestDigest,
      state: "running",
      createdAt: "2026-08-25T00:02:00.000Z",
      deliveries: [],
      inProgressPlatformId: "douyin",
    }));
    let calls = 0;
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      publishers: [{
        target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        publish: async () => { calls += 1; return { externalId: "unexpected", reviewStatus: "processing" }; },
      }],
    });

    await assert.rejects(() => subject.publish("run-1", input), /结果不确定.*不会自动重投/);
    assert.equal(calls, 0);
  });

  // R7-A/R7-C：A 基于旧快照首次提交新请求编号——租约内重读发现 run 已推进（B 完成
  // 且批准 V2：revision 与成片/发布包身份变化）即冲突，早于任何 journal/delivery/publisher。
  it("rejects a first publish whose viewed snapshot no longer matches the run, before any side effect", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    let currentRun = completedRun;
    // 发布包与当前 run 的成片身份同步绑定，避免旧包绑定挡住刷新后的放行阶段。
    const packageForRun = async (run: StudioRunDetail) => ({
      aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
      resourceManifest: { needsReviewCount: 0 },
      artifacts: [
        { id: run.videoArtifactId, kind: "render", provenance: { licenseNote: "Owner-generated render." } },
        { id: run.publishPackageArtifactId, kind: "publish_package", provenance: { licenseNote: "Approved publish package." } },
      ],
    });
    let calls = 0;
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => currentRun,
      loadPublishPackage: packageForRun,
      publishers: [{
        target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        publish: async () => { calls += 1; return { externalId: "douyin-item", reviewStatus: "processing" }; },
      }],
    });
    const viewed = await subject.readiness("run-1");
    assert.deepEqual(viewed.snapshot, { revision: 9, videoArtifactId: "video", publishPackageArtifactId: "package" });
    assert.equal(viewed.runId, "run-1");

    currentRun = {
      ...completedRun,
      revision: completedRun.revision + 2,
      videoArtifactId: "video-v2",
      publishPackageArtifactId: "package-v2",
      artifacts: [
        { id: "video-v2", kind: "render", createdAt: "2026-08-25T00:03:00.000Z", contentType: "video/mp4", licenseNote: "Owner-generated render.", contentUrl: "/api/video" },
        { id: "package-v2", kind: "publish_package", createdAt: "2026-08-25T00:04:00.000Z", contentType: "application/json", licenseNote: "Approved publish package.", contentUrl: "/api/package" },
      ],
    };
    const staleInput = { ...confirmedInput("publish-stale-snapshot"), platformIds: ["douyin"] as const };
    await assert.rejects(() => subject.publish("run-1", staleInput), /自你核对发布条件以来这条制作已有更新/);
    assert.equal(calls, 0, "零 publisher 调用");
    const publishingDirectory = await readdir(path.join(workspaceRoot, "runs", "run-1", "publishing")).catch(() => []);
    assert.deepEqual(publishingDirectory, [], "零 journal、delivery 或回执文件");

    // 刷新到 V2 快照重新确认后放行（R7-B）；同 ID 意图跨版本已被拒绝，需新请求编号。
    const refreshed = await subject.readiness("run-1");
    const accepted = await subject.publish("run-1", { ...confirmedInput("publish-refreshed-snapshot"), platformIds: ["douyin"] as const, expected: refreshed.snapshot });
    assert.equal(accepted.status, "succeeded");
    assert.equal(calls, 1);
  });

  // R7-E：inFlight 摘要含快照身份——同 ID 不同快照不能共享另一次的 Promise。
  it("refuses to share an in-flight publish across different viewed snapshots", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    let releasePublish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      publishers: [{
        target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        publish: async () => { await gate; return { externalId: "douyin-item", reviewStatus: "processing" }; },
      }],
    });
    const base = { ...confirmedInput("publish-inflight-snapshot"), platformIds: ["douyin"] as const };
    const first = subject.publish("run-1", base);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const otherSnapshot = { ...base, expected: { ...base.expected, videoArtifactId: "video-v2" } };
    await assert.rejects(() => subject.publish("run-1", otherSnapshot), /已经绑定到另一组平台、确认内容或制作版本/);
    await assert.rejects(() => subject.publish("run-1", { ...base, platformIds: ["xiaohongshu"] }), /已经绑定到另一组平台、确认内容或制作版本/);
    await assert.rejects(() => subject.publish("run-1", { ...base, confirmations: { ...base.confirmations, finalContent: false } }),
      /已经绑定到另一组平台、确认内容或制作版本/);
    const sameIntent = subject.publish("run-1", base);
    releasePublish!();
    const [firstBatch, sameBatch] = await Promise.all([first, sameIntent]);
    assert.deepEqual(sameBatch, firstBatch);
  });

  it("holds the run maintenance lease for the entire external publish batch", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publishing-"));
    const events: string[] = [];
    const subject = new PublishingStudio({
      workspaceRoot,
      getRun: async () => completedRun,
      loadPublishPackage,
      withRunLease: async (runId, action) => {
        events.push(`lease:${runId}:start`);
        try {
          return await action();
        } finally {
          events.push(`lease:${runId}:end`);
        }
      },
      publishers: [{
        target: { id: "douyin", label: "抖音", mode: "official_api", status: "ready" },
        publish: async () => {
          events.push("publish");
          return { externalId: "douyin-item", reviewStatus: "processing" };
        },
      }],
    });

    await subject.publish("run-1", { ...confirmedInput("publish-with-lease"), platformIds: ["douyin"] });

    assert.deepEqual(events, ["lease:run-1:start", "publish", "lease:run-1:end"]);
  });
});
