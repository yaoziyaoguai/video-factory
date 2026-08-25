import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
});
