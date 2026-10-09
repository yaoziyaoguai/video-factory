import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ProductionPipeline, type ProductionCreativeReviewCommandDraft, type ProductionPipelineOptions } from "../../src/production-pipeline.js";
import { CodexBridgeClient } from "../../src/codex-chat.js";
import { CodexVisualDirectorAgent } from "../../src/codex-visual-director.js";
import { FallbackVisualDirectorAgent } from "../../src/index.js";

// 真实Store/SQLite/执行租约，外部边界全部拒绝；改承诺不应进入任一生成端口。
const [workspaceRoot, phase, window] = process.argv.slice(2) as [string, string, "afterAccepted" | "afterGraph" | "afterRunSaved" | "duringDirector" | "afterContinued"];
const input = JSON.parse(await readFile(path.join(workspaceRoot, "duration-command.json"), "utf8")) as {
  runId: string; command: ProductionCreativeReviewCommandDraft; socketPath?: string;
};
const unexpected = async (): Promise<never> => {
  await appendFile(path.join(workspaceRoot, "unexpected-provider-calls.log"), "unexpected\n");
  throw new Error("Local duration change must not call a provider.");
};
const options: ProductionPipelineOptions = {
  workspaceRoot, worker: { run: unexpected },
  referenceVideoRoot: workspaceRoot,
  referenceGrammarAgent: { id: "reference-fixture", modelId: "reference-fixture", analyze: unexpected },
  // run已保存的恢复只能补回执；随后目录不可用不应触发重规划或阻塞已生效的命令。
  assetProviders: phase === "recover" && window === "afterRunSaved" ? []
    : [{ id: "local-editorial-v1", label: "本地编辑卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] }],
  treatmentAgents: [{ providerId: "openai", agent: { id: "codex-creative-treatment-v1", modelId: "treatment-model-a", treat: unexpected } }],
  screenwriterAgent: { id: "codex-screenwriter-v1", modelId: "screenwriter-binding-model", draft: unexpected },
  directorAgent: input.socketPath ? new FallbackVisualDirectorAgent({ candidates: [{ providerId: "duration-fixture",
    agent: new CodexVisualDirectorAgent({ modelId: "director-binding-model", sessionMode: "stateless",
      client: new CodexBridgeClient({ socketPath: input.socketPath, timeoutMs: 30_000, pollIntervalMs: 20, maxAttempts: 1 }) }) }] })
    : { id: "api-visual-director-v1", plan: unexpected },
  executionLeaseStaleMs: 5_000, executionLeaseHeartbeatMs: 1_000,
  ...(phase === "crash" ? { durationChangeFailpoints: { [window]: () => process.kill(process.pid, "SIGKILL") } } : {}),
};
const subject = new ProductionPipeline(options);
if (phase === "recover") {
  // 每窗先尝试另一写入口；屏障不能只保护creative-review本路由。
  const before = await subject.show(input.runId);
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["configuration", () => subject.applyNodeExecutionConfiguration(input.runId, "creative-planning", before.initialInput, "other-writer", before.revision)],
    ["maintenance/rework", () => subject.withRunMaintenanceLease([input.runId], unexpected)],
    ["voice timing", () => subject.requestVoiceTimingRevision(input.runId, { expectedRunRevision: before.revision,
      interventionId: before.nodeRuns.find(node => node.intervention)?.intervention?.id ?? "not-voice", scenePosition: 1, durationSeconds: 12, actor: "other-writer" })],
    ["resume", () => subject.resumeStale(input.runId)],
    ["retry", () => subject.retryFailedNode(input.runId, "creative-planning")],
    ["pause", () => subject.requestPause(input.runId)],
    ["clear pause", () => subject.clearPauseRequest(input.runId)],
    ["voice preview ticket", () => subject.previewNarrationPlanV2(input.runId, { expectedRunRevision: before.revision,
      sourceContextId: "test-source", editorSessionId: "test-editor", editSequence: 1, candidate: {}, actor: "other-writer" })],
    ["node document", () => subject.applyNodeOverride(input.runId, { nodeId: "publish-package", actor: "other-writer", output: {} })],
    ["node input", () => subject.applyNodeInputOverride(input.runId, { nodeId: "creative-planning", actor: "other-writer", input: {} })],
    ["document audit", () => subject.recordNodeDocumentAudit(input.runId, { nodeId: "publish-package", actor: "other-writer",
      expectedRunRevision: before.revision, expectedVersionId: "old-version", auditId: "audit",
      audit: { version: "video-factory/role-audit-v2", rubricVersion: "controlled-v1", verdict: "pass", score: 90,
        assessments: [], summary: "受控审计", issues: [], repairInstructions: [] } })],
    ["voice plan v1", () => subject.confirmNarrationPlan(input.runId, { expectedRunRevision: before.revision, plan: {}, actor: "other-writer" })],
    ["voice plan v2", () => subject.confirmNarrationPlanV2(input.runId, { expectedRunRevision: before.revision, requestId: "new-voice-plan",
      sourceContextId: "test-source", editorSessionId: "test-editor", editSequence: 1, candidateId: "candidate", ticketId: "ticket",
      planSha256: "a".repeat(64), actor: "other-writer" })],
    ["voice relayout", () => subject.requestNarrationRevision(input.runId, { action: "relayout_narration", intent: "discard_unapplied",
      requestId: "relayout-discard", targetRequestId: "old-relayout", expectedRunRevision: before.revision, interventionId: "voice-stop",
      actor: "other-writer", note: "受控恢复测试" })],
    ["spend authorization", () => subject.authorizeSpend(input.runId, { spendPlanId: "old-quote", nodeId: "assets", inputVersionIds: [],
      providerId: "fixture-video", modelId: "fixture-model", maxCostCny: 1, maxAttempts: 1, approvedBy: "other-writer" })],
    ["scope authorization", () => subject.acceptProductionAuthorization(input.runId, {})],
    ["spend rejection", () => subject.rejectSpend(input.runId, { nodeId: "assets", spendPlanId: "old-quote", reason: "other", rejectedBy: "other-writer" })],
    ["human decision", () => subject.decide(input.runId, { interventionId: "old-stop", actor: "other-writer", action: "reject", note: "受控恢复测试" })],
    ["remove", () => subject.remove(input.runId)],
  ];
  for (const [name, write] of writes) {
    let blocked = false;
    try { await write(); }
    catch (error) { blocked = error instanceof Error && error.message.includes("时长修改尚未完成"); }
    if (!blocked) throw new Error(`Pending duration transaction did not block ${name} before reading mixed state.`);
    const afterBlocked = await subject.show(input.runId);
    if (JSON.stringify(before) !== JSON.stringify(afterBlocked)) throw new Error(`Rejected ${name} changed the run.`);
  }
  if (await subject.recoverInterruptedRuns({ leaseStaleAfterMs: 0 }) !== 0
    || JSON.stringify(await subject.show(input.runId)) !== JSON.stringify(before)) {
    throw new Error("Startup recovery must leave the pending local duration transaction for its original command.");
  }
}
const result = await (await subject.dispatchCreativeReviewCommand(input.runId, input.command)).completion;
process.stdout.write(`${JSON.stringify({ status: result.status, revision: result.revision, operations: result.creativeReviewOperations })}\n`);
