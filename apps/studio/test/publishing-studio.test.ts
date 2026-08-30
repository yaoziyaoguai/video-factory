import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { StudioRunDetail } from "../src/shared/api.js";
import { PublishingStudio, type PlatformPublisher } from "../src/server/publishing-studio.js";

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
};

const loadPublishPackage = async () => ({
  aigc: { explicitLabelChecked: true, implicitMetadataWritten: true },
  resourceManifest: { needsReviewCount: 0 },
  artifacts: [
    { id: "video", kind: "render", provenance: { licenseNote: "Owner-generated render." } },
    { id: "asset-1", kind: "media_asset", provenance: { licenseNote: "Provider terms recorded." } },
  ],
});

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
  };
}

describe("PublishingStudio", () => {
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

  it("rejects reuse of a request ID with different platform data", async () => {
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

    await assert.rejects(
      () => subject.publish("run-1", { ...confirmedInput(requestId), platformIds: ["kuaishou"] }),
      /已经绑定/,
    );
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

    await subject.publish("run-1", input);
    currentRun = { ...completedRun, revision: completedRun.revision + 1 };

    await assert.rejects(() => subject.publish("run-1", input), /已经绑定/);
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
