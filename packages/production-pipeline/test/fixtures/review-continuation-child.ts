import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { ProductionPipeline, CodexBridgeClient, CodexPublishCopyWriter, CodexBridgeError, RoleAgentLoopError,
  type ProductionPipelineOptions, type ProductionReviewContinuationInput, type WorkerResponse } from "../../src/index.js";
import type { HumanDecisionDraft } from "@video-factory/workflow-core";

// 外部生成边界受控；决定、文件存储、执行租约及重放全部使用正式实现。
const [phase, mode, window, root] = process.argv.slice(2);
if (!root || !["prepare", "approve", "final"].includes(mode!)) throw new Error("Invalid controlled child arguments.");
const sideEffects = path.join(root, "side-effects.jsonl");
const commandFile = path.join(root, "command.json");
const record = (kind: string) => appendFileSync(sideEffects, `${JSON.stringify({ kind, pid: process.pid })}\n`);
const killAt = (name: string) => { if (phase === "crash" && window === name) {
  record(`kill:${name}`); process.kill(process.pid, "SIGKILL");
} };
const options: ProductionPipelineOptions = {
  workspaceRoot: root, executionLeaseStaleMs: 5000, executionLeaseHeartbeatMs: 1000,
  ...(mode === "final" ? { publishCopyWriter: new CodexPublishCopyWriter({ client: new CodexBridgeClient({
    socketPath: path.join(root, "publisher.sock"), timeoutMs: 10_000, pollIntervalMs: 10, maxAttempts: 1,
  }) }) } : {}),
  worker: { async run(request): Promise<WorkerResponse> {
    record(`worker:${request.capability}`);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    const output: Record<string, unknown> = request.capability === "script.draft"
      ? { scriptPath: path.join(outputDir, "script.json") }
      : request.capability === "asset.prepare" ? { assetPlanPath: path.join(outputDir, "assets.json") }
      : request.capability === "voice.synthesize" ? { voiceoverPlanPath: path.join(outputDir, "voice.json"), trackPath: path.join(outputDir, "audio.m4a") }
      : request.capability === "video.render" ? { videoPath: path.join(outputDir, "video.mp4"), renderManifestPath: path.join(outputDir, "manifest.json") }
      : { reviewPath: path.join(outputDir, "technical.json"), passed: true };
    const bytes = JSON.stringify(request.capability === "script.draft" ? { scenes: [
      { position: 1, narration: "第一幕", duration: mode === "final" ? 3 : 5, visual_strategy: "stock", visual_prompt: "日常", on_screen_text: "日常", sound_cue: "环境声" },
      { position: 2, narration: "第二幕", duration: mode === "final" ? 3 : 5, visual_strategy: "stock", visual_prompt: "动作", on_screen_text: "动作", sound_cue: "环境声" },
      ...(mode === "final" ? [{ position: 3, narration: "第三幕", duration: 4, visual_strategy: "stock", visual_prompt: "收束", on_screen_text: "收束", sound_cue: "环境声" }] : []),
    ] } : { capability: request.capability });
    const uri = String(Object.values(output)[0]);
    await writeFile(uri, bytes);
    if (request.capability === "voice.synthesize") await writeFile(String(output.trackPath), "controlled audio fixture");
    if (request.capability === "video.render") await writeFile(String(output.renderManifestPath), JSON.stringify({ duration_target: 10,
      slides: mode === "final" ? [{ position: 1, duration: 3 }, { position: 2, duration: 3 }, { position: 3, duration: 4 }]
        : [{ position: 1, duration: 5 }, { position: 2, duration: 5 }] }));
    return { protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded", output,
      artifacts: await Promise.all(Object.values(output).filter(value => typeof value === "string").map(async filename => {
        const content = await readFile(String(filename));
        return { kind: String(request.capability).replace(".", "_"), uri: String(filename), sha256: createHash("sha256").update(content).digest("hex"),
          sizeBytes: content.length, contentType: filename === output.videoPath ? "video/mp4" : filename === output.trackPath ? "audio/mp4" : "application/json",
          provenance: { providerId: String((request.parameters as Record<string, unknown>).providerId), producerNodeId: String(request.nodeRunId), attempt: Number(request.attempt),
            licenseNote: "Deterministic contract fixture, not playable media or an external purchase." } };
      })) };
  } },
  providerRuntimeMetadata: [{ id: "deepseek-visual-review-v1", label: "受控审计", modelId: "deepseek-flash",
    transport: "unix_socket", billing: "subscription", approvalPolicy: "none", maxAttempts: 1 }],
  visualReviewAgents: [{ id: "deepseek-visual-review-v1", modelId: "deepseek-flash", async review() { throw new Error("Detailed only"); },
    async reviewDetailed(input) {
      record(`audit:${input.reviewStage}`);
      if (input.reviewStage === "source_assets") return { output: { version: "video-factory/visual-review-v1" as const,
        summary: "受控源素材结论", scores: { composition: 90, continuity: 90, pacing: 90, legibility: 90, safety: 90 }, findings: [], confidence: .95, recommendation: "approve" as const }, inspectedDurationMs: 10000 };
      if (mode === "prepare") throw new Error("Controlled optional report consumer failure.");
      throw new RoleAgentLoopError("原审计待核", { version: "video-factory/agent-loop-v1", role: "视觉审片员",
        contractVersion: "controlled", criteria: [], status: "failed", maxIterations: 1, iterations: [],
        failure: { stage: "uncertain", summary: "原请求待核" } }, undefined, new CodexBridgeError("受理后中断", false, "uncertain"));
    } }],
  reviewContinuationFailpoints: { afterAccepted: () => killAt("W1"), afterEvidence: () => killAt("W2"), afterDecisionCheckpoint: () => killAt("W3") },
};
const pipeline = new ProductionPipeline(options);
if (phase === "setup") {
  let run = await pipeline.start({ protocolVersion: "video-factory/brief-v1", title: "崩溃窗口", angle: "受控合同", audience: "测试",
    nicheSlug: "life-avoidance", durationSeconds: 30, platform: "douyin", reviewMode: "manual", runPurpose: "test",
    providers: { script: "python-template-v1", assets: "local-editorial-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1",
      technicalReview: "python-technical-review-v1", visualReview: "deepseek-visual-review-v1" },
    ...(mode === "final" ? { workflowFeatures: { assetSemanticRank: false, referenceGrammar: false,
      boundaryGates: "user-confirmed-v1" as const } } : {}) });
  if (mode === "final") {
    for (let step = 0; step < 12 && run.status === "needs_human"; step++) {
      const active = run.nodeRuns.find(node => node.status === "needs_human")!;
      if (active.nodeId === "final-review") break;
      const scoped = active.intervention?.continuationScope === "rendered_video_optional_review";
      run = await pipeline.decide(run.id, { action: "approve", actor: "controlled-owner", interventionId: active.intervention!.id,
        expectedRunRevision: run.revision, reviewEvidenceId: active.intervention?.evidenceId ?? null,
        ...(scoped ? { commandId: "visual-before-final", acceptIncomplete: true } : {}) });
    }
  }
  const render = run.nodeRuns.find(node => node.nodeId === "render")!;
  const visual = run.nodeRuns.find(node => node.nodeId === (mode === "final" ? "final-review" : "visual-review"))!;
  const video = run.artifacts.find(artifact => artifact.producer?.nodeId === "render" && artifact.contentType === "video/mp4")!;
  const input = mode === "prepare" ? { commandId: "same-command", expectedRunRevision: run.revision, nodeId: "visual-review",
    targetArtifactId: video.id, targetVersionId: render.outputState!.effectiveVersionId, targetSha256: video.sha256! }
    : { commandId: "same-command", expectedRunRevision: run.revision, interventionId: visual.intervention!.id,
      actor: "controlled-owner", action: "approve", acceptIncomplete: true, reviewEvidenceId: visual.intervention!.evidenceId };
  await writeFile(commandFile, JSON.stringify({ runId: run.id, input }));
}
const { runId, input } = JSON.parse(await readFile(commandFile, "utf8"));
if (phase === "recover") {
  await pipeline.recoverInterruptedRuns();
  if (mode === "final" && (await pipeline.loadPersisted(runId)).status === "failed") {
    await pipeline.retryFailedNode(runId, "publish-package", { recoverOriginalTextTask: true });
  }
}
const run = phase === "setup" ? await pipeline.loadPersisted(runId)
  : mode === "prepare" ? await pipeline.prepareReviewContinuation(runId, input as ProductionReviewContinuationInput, "controlled-owner")
  : await pipeline.decide(runId, input as HumanDecisionDraft);
console.log(JSON.stringify({ pid: process.pid, run }));
