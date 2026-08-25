import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ProductionPipeline,
  type ScreenwriterAgent,
  type ScreenwriterAgentInput,
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

class RecordingWorker {
  readonly requests: Array<{ capability: string; input: Record<string, unknown> }> = [];

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    this.requests.push({ capability, input: (request.input ?? {}) as Record<string, unknown> });
    await mkdir(outputDir, { recursive: true });
    const outputs: Record<string, Record<string, unknown>> = {
      "script.draft": { scriptPath: path.join(outputDir, "script.json") },
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

function stubAgent(
  behavior: (input: ScreenwriterAgentInput) => unknown,
): { agent: ScreenwriterAgent; inputs: ScreenwriterAgentInput[] } {
  const inputs: ScreenwriterAgentInput[] = [];
  return {
    inputs,
    agent: {
      id: "codex-screenwriter-v1",
      draft: async (input) => {
        inputs.push(input);
        return behavior(input);
      },
    },
  };
}

describe("ProductionPipeline codex screenwriter", () => {
  it("persists the codex script, feeds the same path downstream, and records provenance", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-"));
    const worker = new RecordingWorker();
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const run = await pipeline.start(brief);

    assert.equal(run.status, "succeeded");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.brief.nicheSlug, "life-avoidance");
    assert.equal(inputs[0]?.brief.title, brief.title);
    assert.equal(inputs[0]?.brief.platform, brief.platform);
    assert.equal(inputs[0]?.brief.durationSeconds, brief.durationSeconds);

    const scriptArtifact = run.artifacts.find((artifact) => artifact.kind === "script");
    assert.ok(scriptArtifact?.uri);
    assert.equal(scriptArtifact.producer?.nodeId, "script");
    assert.equal(scriptArtifact.provenance.providerId, "codex-screenwriter-v1");
    assert.equal(scriptArtifact.contentType, "application/json");
    assert.equal(scriptArtifact.schemaVersion, "video-factory/script-draft-v1");
    const content = await readFile(scriptArtifact.uri, "utf8");
    assert.deepEqual(JSON.parse(content), scriptDraft);
    assert.equal(scriptArtifact.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(scriptArtifact.sizeBytes, Buffer.byteLength(content));

    const assetsRequest = worker.requests.find((request) => request.capability === "asset.prepare");
    assert.equal(assetsRequest?.input.scriptPath, scriptArtifact.uri);
    assert.equal(worker.requests.some((request) => request.capability === "script.draft"), false);
  });

  it("rejects before any execution when the screenwriter agent is missing or mismatched", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-"));
    const worker = new RecordingWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker });
    await assert.rejects(() => pipeline.start(brief), /Script provider 'codex-screenwriter-v1' is not configured/);
    assert.equal((await pipeline.list()).length, 0);
    assert.equal(worker.requests.length, 0);

    const mismatchedPipeline = new ProductionPipeline({
      workspaceRoot,
      worker,
      screenwriterAgent: { id: "another-screenwriter-v1", draft: async () => scriptDraft },
    });
    await assert.rejects(() => mismatchedPipeline.start(brief), /Script provider 'codex-screenwriter-v1' is not configured/);
    assert.equal(worker.requests.length, 0);
  });

  it("fails the run without template substitution when the agent throws", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-"));
    const worker = new RecordingWorker();
    const { agent, inputs } = stubAgent(() => {
      throw new Error("codex backend unavailable");
    });
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const run = await pipeline.start(brief);

    assert.equal(run.status, "failed");
    assert.equal(run.nodeRuns.at(-1)?.nodeId, "script");
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /codex backend unavailable/);
    assert.equal(inputs.length, 1);
    assert.equal(worker.requests.some((request) => request.capability === "script.draft"), false);
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "script"), false);
  });

  it("fails before persisting or calling downstream when a matching agent returns a malformed draft", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-"));
    const worker = new RecordingWorker();
    const { agent } = stubAgent(() => ({ scenes: [{ position: 1 }] }));
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const run = await pipeline.start(brief);

    assert.equal(run.status, "failed");
    assert.equal(run.nodeRuns.at(-1)?.nodeId, "script");
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /between 3 and 10 scenes/);
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "script"), false);
    assert.equal(worker.requests.length, 0);
    await assert.rejects(
      () => readFile(path.join(workspaceRoot, "runs", run.id, "nodes", "script", "attempt-1", "script.json"), "utf8"),
      /ENOENT/,
    );
  });
});
