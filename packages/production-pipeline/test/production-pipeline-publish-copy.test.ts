import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  RoleAgentLoopError,
  type PublishCopyInput,
  type PublishCopyWriter,
  type ScreenwriterAgent,
  type ScriptDraft,
  type WorkerResponse,
} from "../src/index.js";

const brief = {
  protocolVersion: "video-factory/brief-v1",
  title: "下班后别急着做这 3 件事",
  angle: "低风险、可收藏的生活清单",
  audience: "有决策压力的普通上班族",
  nicheSlug: "life-avoidance",
  durationSeconds: 24,
  platform: "douyin",
  reviewMode: "automatic",
  providers: {
    script: "codex-screenwriter-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
  voiceDirection: {
    profileId: "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  },
} as const;

const scriptDraft: ScriptDraft = {
  scenes: [
    {
      position: 1,
      narration: "下班回家，第一件事不是躺下，而是先把外套挂起来。",
      duration: 8,
      visual_strategy: "stock",
      visual_prompt: "进门挂外套的日常动作，竖屏近景",
      search_terms: ["下班回家", "进门挂外套"],
    },
    {
      position: 2,
      narration: "第二件事：只处理一个信封大小的待办，别打开整个清单。",
      duration: 8,
      visual_strategy: "image",
      visual_prompt: "一张待办清单只圈出第一项的特写",
      search_terms: ["待办清单", "决策消耗"],
    },
    {
      position: 3,
      narration: "第三件事：给明天留一句开头，明天的你会感谢现在的你。",
      duration: 8,
      visual_strategy: "local",
      visual_prompt: "手写一句话开头的编辑卡片",
      search_terms: ["明日计划", "编辑卡片"],
    },
  ],
};

const publishCopy = {
  title: "下班后别急着做这三件事",
  description: "三个动作，把下班后的决定变少。",
  hashtags: ["下班", "决策消耗"],
};

class RecordingWorker {
  readonly requests: Array<{ capability: string; input: Record<string, unknown> }> = [];

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    this.requests.push({ capability, input: (request.input ?? {}) as Record<string, unknown> });
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "asset.prepare": { assetPlanPath: path.join(outputDir, "asset_plan.json") },
      "voice.synthesize": {
        voiceoverPlanPath: path.join(outputDir, "voiceover_plan.json"),
        trackPath: path.join(outputDir, "narration.m4a"),
      },
      "video.render": {
        videoPath: path.join(outputDir, "final.mp4"),
        renderManifestPath: path.join(outputDir, "render_manifest.json"),
      },
      "quality.review": { reviewPath: path.join(outputDir, "technical_review.json"), passed: true },
    };
    const output = outputs[capability];
    assert.ok(output, `Unexpected fake capability: ${capability}`);
    const content = JSON.stringify({ capability });
    const primaryPath = String(Object.values(output)[0]);
    await writeFile(primaryPath, content, "utf8");
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [
        {
          kind: capability.replace(".", "_"),
          uri: primaryPath,
          sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: Buffer.byteLength(content),
          contentType: capability === "video.render" ? "video/mp4" : "application/json",
          provenance: {
            providerId: String((request.parameters as Record<string, unknown>).providerId),
            producerNodeId: String(request.nodeRunId),
            attempt: Number(request.attempt),
            licenseNote: "Fake worker artifact for integration testing.",
          },
        },
      ],
    };
  }
}

const screenwriter: ScreenwriterAgent = {
  id: "codex-screenwriter-v1",
  draft: async () => scriptDraft,
};

function stubWriter(behavior: () => unknown): { writer: PublishCopyWriter; calls: PublishCopyInput[] } {
  const calls: PublishCopyInput[] = [];
  return {
    calls,
    writer: {
      id: "codex-publish-copy-v1",
      write: async (input) => {
        calls.push(input);
        return behavior();
      },
    },
  };
}

async function readPackage(run: { artifacts: Array<{ kind: string; uri?: string }> }): Promise<Record<string, unknown>> {
  const packageArtifact = run.artifacts.find((artifact) => artifact.kind === "publish_package");
  assert.ok(packageArtifact?.uri);
  return JSON.parse(await readFile(packageArtifact.uri, "utf8")) as Record<string, unknown>;
}

describe("ProductionPipeline publish copy", () => {
  it("embeds the codex copy and records provenance and integrity", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publish-copy-"));
    const worker = new RecordingWorker();
    const { writer, calls } = stubWriter(() => publishCopy);
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: screenwriter,
      publishCopyWriter: writer,
    });

    const run = await pipeline.start(brief);

    assert.equal(run.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.platform, "douyin");
    assert.equal(calls[0]?.brief.nicheSlug, "life-avoidance");
    assert.deepEqual(calls[0]?.narrations, scriptDraft.scenes.map((scene) => scene.narration));

    const payload = await readPackage(run);
    const copy = payload.copy as Record<string, unknown>;
    assert.equal(copy.source, "codex-publish-copy-v1");
    assert.equal(copy.title, publishCopy.title);
    assert.equal(payload.title, publishCopy.title);
    assert.equal(copy.fallbackReason, undefined);

    const copyArtifact = run.artifacts.find((artifact) => artifact.kind === "publish_copy");
    assert.ok(copyArtifact?.uri);
    assert.equal(copyArtifact.producer?.nodeId, "publish-package");
    assert.equal(copyArtifact.provenance.providerId, "codex-publish-copy-v1");
    assert.equal(copyArtifact.schemaVersion, "video-factory/publish-copy-v1");
    const scriptArtifact = run.artifacts.find((artifact) => artifact.kind === "script");
    assert.deepEqual(copyArtifact.parentArtifactIds, [scriptArtifact?.id]);
    const bytes = await readFile(copyArtifact.uri);
    assert.equal(copyArtifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(copyArtifact.sizeBytes, bytes.byteLength);
  });

  it("falls back to the brief title once when the writer throws or returns malformed output", async () => {
    for (const behavior of [() => {
      throw new Error("codex backend unavailable");
    }, () => ({ title: "只有标题" })]) {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publish-copy-"));
      const worker = new RecordingWorker();
      const { writer, calls } = stubWriter(behavior);
      const pipeline = new ProductionPipeline({
        workspaceRoot,
        worker,
        screenwriterAgent: screenwriter,
        publishCopyWriter: writer,
      });

      const run = await pipeline.start(brief);

      assert.equal(run.status, "succeeded");
      assert.equal(calls.length, 1);
      assert.equal(run.artifacts.some((artifact) => artifact.kind === "publish_copy"), false);
      const payload = await readPackage(run);
      const copy = payload.copy as Record<string, unknown>;
      assert.equal(copy.source, "brief-title");
      assert.equal(copy.fallbackReason, "codex-publish-copy-unavailable");
      assert.equal(payload.title, brief.title);
      assert.deepEqual(copy.hashtags, []);
    }
  });

  it("uses the fallback without any model call when no writer is configured", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publish-copy-"));
    const worker = new RecordingWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: screenwriter });

    const run = await pipeline.start(brief);

    assert.equal(run.status, "succeeded");
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "publish_copy"), false);
    const payload = await readPackage(run);
    const copy = payload.copy as Record<string, unknown>;
    assert.equal(copy.source, "brief-title");
    assert.equal(payload.title, brief.title);
  });

  it("fails closed when the configured publishing agent exhausts its independent audit", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publish-audit-failure-"));
    const worker = new RecordingWorker();
    const writer: PublishCopyWriter = {
      id: "codex-publish-copy-v1",
      write: async () => publishCopy,
      writeDetailed: async () => { throw exhaustedAgentError("发行编辑"); },
    };
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: screenwriter, publishCopyWriter: writer });

    const run = await pipeline.start(brief);
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === "publish-package");

    assert.equal(run.status, "failed");
    assert.equal(node?.status, "failed");
    assert.match(node?.error ?? "", /三轮审计仍未通过/);
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "publish_package"), false);
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "agent_loop_trace"), true);
  });

  it("invokes the writer only after manual approval without rerunning media nodes", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-publish-copy-"));
    const worker = new RecordingWorker();
    const { writer, calls } = stubWriter(() => publishCopy);
    const options = {
      workspaceRoot,
      worker,
      screenwriterAgent: screenwriter,
      publishCopyWriter: writer,
      clock: (): string => "2026-08-21T10:00:00.000Z",
    };
    const firstProcess = new ProductionPipeline(options);

    const waiting = await firstProcess.start({ ...brief, reviewMode: "manual" });

    assert.equal(waiting.status, "needs_human");
    assert.equal(calls.length, 0);
    assert.deepEqual(worker.requests.map((request) => request.capability), [
      "asset.prepare",
      "voice.synthesize",
      "video.render",
      "quality.review",
    ]);

    const secondProcess = new ProductionPipeline(options);
    const approved = await secondProcess.decide(waiting.id, {
      interventionId: waiting.interventions[0]!.id,
      action: "approve",
      actor: "director",
      note: "Approved after full watch.",
    });

    assert.equal(approved.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.equal(worker.requests.length, 4);
    const payload = await readPackage(approved);
    const copy = payload.copy as Record<string, unknown>;
    assert.equal(copy.source, "codex-publish-copy-v1");
    assert.equal(payload.title, publishCopy.title);
  });
});

function exhaustedAgentError(role: string): RoleAgentLoopError {
  return new RoleAgentLoopError("三轮审计仍未通过", {
    version: "video-factory/agent-loop-v1",
    role,
    contractVersion: "fixture-v1",
    criteria: ["必须通过独立审计"],
    status: "failed",
    maxIterations: 3,
    modelCallCount: 6,
    iterations: [],
  });
}
