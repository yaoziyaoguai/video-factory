import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FallbackScreenwriterAgent,
  ProductionPipeline,
  RoleAgentLoopError,
  runRoleAgentLoop,
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

const seriesContext = {
  seriesId: "series-1",
  episodeId: "episode-1",
  seriesName: "下班实验室",
  seriesRevision: 1,
  episodeNumber: 1,
  seasonNumber: 1,
  canonBaseRevision: 0,
  premise: "每集完成一个可复现的真实实验。",
  audience: "普通上班族",
  platform: "douyin",
  track: "after-work-lab",
  arc: "从一次实验走到可持续流程",
  episode: {
    updatedAt: "2026-08-30T00:00:00.000Z",
    pillar: "真实实验",
    title: "第一集",
    viewerPromise: "完成一次低成本验证",
    hook: "先展示最容易失败的一步",
    payoff: "给出可复现的结论",
    planning: {
      source: "agent",
      role: "系列开拍总编",
      auditRole: "独立质量审计 Agent",
      auditStatus: "passed",
      auditIterations: 2,
      providerId: "openai",
      modelId: "codex",
      promptVersion: "video-factory/series-greenlight-v1",
    },
  },
  bible: { rules: ["结论必须来自本集实际内容"], recurringElements: [], forbiddenChanges: [] },
  canon: { revision: 0, facts: [] },
  continuity: { inheritedFromPrevious: [], fromPrevious: [], toNext: ["下一集复核边界"], canonChecks: [] },
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

const templateSnapshot = {
  templateId: "knowledge-explainer",
  templateVersion: 1,
  resolvedAt: "2026-08-27T00:00:00.000Z",
  resolvedBlueprint: {
    platform: "douyin",
    durationSeconds: 24,
    automationLevel: "assisted",
    storyStructure: [{ id: "question", label: "提出问题", purpose: "从日常误解切入", required: true }],
    shotSlots: [{ id: "shot-question", beatId: "question", purpose: "建立问题", durationSeconds: 6, allowedCapabilities: ["asset.search"], manualReplacement: true }],
    visualSystem: { composition: "一个镜头一个概念", colorIntent: "自然底色", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "聪明但不居高临下", pace: "medium", musicIntent: "轻盈节拍" },
    qualityRules: [{ id: "facts", label: "事实准确", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
  },
  sourceLayers: [{ layer: "template", sourceId: "knowledge-explainer@1", appliedFields: ["storyStructure"] }],
  fieldSources: { storyStructure: "template" },
} as const;

class RecordingWorker {
  readonly requests: Array<{ capability: string; input: Record<string, unknown> }> = [];

  constructor(private readonly scriptDocument: Record<string, unknown> = { capability: "script.draft" }) {}

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
    const content = JSON.stringify(capability === "script.draft" ? this.scriptDocument : { capability });
    const primaryPath = String(Object.values(output)[0]);
    await writeFile(primaryPath, content, "utf8");
    return {
      protocolVersion: "video-factory/worker-v1",
      commandId: String(request.commandId),
      status: "succeeded",
      output,
      artifacts: [
        {
          kind: capability === "script.draft" ? "script" : capability.replace(".", "_"),
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
  it("passes editable rework instructions and the previous script into the new script node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-rework-"));
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const worker = new RecordingWorker();
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    await pipeline.start({
      ...brief,
      rework: {
        sourceRunId: "run-rejected-1",
        sourceRunRevision: 9,
        nodeInstructions: {
          script: "缩短第三镜旁白，保留前两镜。",
          visualDirection: "第三镜重做构图。",
          assets: "第三镜换成无字母片。",
        },
        findings: [
          {
            findingId: "vf_111111111111111111111111",
            timecodeMs: 1_000,
            category: "pacing",
            description: "旁白过长",
            suggestion: "缩短旁白",
            targetNodeIds: ["script"],
          },
          {
            findingId: "vf_222222222222222222222222",
            timecodeMs: 8_000,
            category: "continuity",
            description: "画面跳变",
            suggestion: "调整构图并替换母片",
            targetNodeIds: ["visual-direction", "assets"],
          },
        ],
        previousScript: { viewerPromise: "原承诺", scenes: [{ position: 1 }] },
      },
    });

    assert.equal(inputs[0]?.brief.rework?.sourceRunId, "run-rejected-1");
    assert.equal(inputs[0]?.brief.rework?.instruction, "缩短第三镜旁白，保留前两镜。");
    assert.deepEqual(inputs[0]?.brief.rework?.findings.map(({ findingId }) => findingId), ["vf_111111111111111111111111"]);
    assert.deepEqual(inputs[0]?.brief.rework?.previousScript, { viewerPromise: "原承诺", scenes: [{ position: 1 }] });
    const assetInput = worker.requests.find(({ capability }) => capability === "asset.prepare")?.input.rework as { findings?: Array<{ findingId: string }> };
    assert.deepEqual(assetInput.findings?.map(({ findingId }) => findingId), ["vf_222222222222222222222222"]);
  });

  it("scopes identical agent loops to their production run", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-run-scope-"));
    const worker = new RecordingWorker();
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const first = await pipeline.start(brief);
    const second = await pipeline.start(brief);

    assert.notEqual(first.id, second.id);
    assert.equal(inputs.length, 2);
    assert.notEqual(inputs[0]?.agentLoopCheckpoint?.key, inputs[1]?.agentLoopCheckpoint?.key);
  });

  it("passes the selected screenwriter model and isolates checkpoints by model", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-model-scope-"));
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });

    const run = await pipeline.start({
      ...brief,
      models: { "codex-screenwriter-v1": "glm-5.3" },
      modelSelectionSources: { "codex-screenwriter-v1": "run_override" },
    });

    const input = inputs[0];
    assert.equal(input?.selectedModelId, "glm-5.3");
    assert.ok(input?.agentLoopCheckpointForModel);
    const selectedCheckpoint = input.agentLoopCheckpointForModel("glm-5.3");
    const backupCheckpoint = input.agentLoopCheckpointForModel("gpt-5.6-sol");
    assert.notEqual(selectedCheckpoint.key, backupCheckpoint.key);
    assert.notEqual(selectedCheckpoint.key, input.agentLoopCheckpoint?.key);
    assert.equal(input.agentLoopCheckpointForModel("glm-5.3").key, selectedCheckpoint.key);
    const plan = run.executionPlan?.find(({ nodeId }) => nodeId === "script");
    assert.equal(plan?.modelId, "glm-5.3");
    assert.equal(plan?.configurationSource, "run_override");
  });

  it("keeps the selected model in a pre-trace failure receipt without calling its backup", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-pre-trace-failure-"));
    const calls: string[] = [];
    const candidate = (modelId: string): ScreenwriterAgent => ({
      id: "codex-screenwriter-v1",
      modelId,
      draft: async () => scriptDraft,
      draftDetailed: async () => {
        calls.push(modelId);
        if (modelId === "glm-5.3") throw new Error("prompt validation stopped before transport");
        throw new Error("backup must not run");
      },
    });
    const agent = new FallbackScreenwriterAgent({
      candidates: [
        { agent: candidate("gpt-5.6-sol"), providerId: "openai" },
        { agent: candidate("glm-5.3"), providerId: "zai-bigmodel-api" },
      ],
    });
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });

    const run = await pipeline.start({
      ...brief,
      models: { "codex-screenwriter-v1": "glm-5.3" },
      modelSelectionSources: { "codex-screenwriter-v1": "run_override" },
    });

    assert.deepEqual(calls, ["glm-5.3"]);
    const node = run.nodeRuns.find(({ nodeId }) => nodeId === "script");
    assert.equal(node?.status, "failed");
    assert.equal(node?.executionReceipt?.modelId, "glm-5.3");
    assert.equal(node?.executionReceipt?.configurationSource, "run_override");
  });

  it("starts a fresh agent loop after an explicit retry of an exhausted node", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-retry-cycle-"));
    const checkpointKeys: string[] = [];
    const requestIds: string[] = [];
    let modelCalls = 0;
    const agent: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      draft: async () => scriptDraft,
      draftDetailed: async (input) => {
        const checkpoint = input.agentLoopCheckpoint;
        assert.ok(checkpoint);
        checkpointKeys.push(checkpoint.key);
        return runRoleAgentLoop({
          role: "编剧",
          contractVersion: "retry-cycle-test-v1",
          criteria: ["前两秒建立具体钩子"],
          maxIterations: 1,
          checkpoint,
          produce: async (_revision, { requestId }) => {
            modelCalls += 1;
            requestIds.push(requestId);
            return { output: scriptDraft };
          },
          audit: async () => ({
            output: modelCalls === 1
              ? {
                  version: "video-factory/role-audit-v1",
                  verdict: "repair",
                  score: 70,
                  summary: "仍需修订。",
                  issues: [{ severity: "blocking", criterion: "钩子", evidence: "开场偏慢", repairInstruction: "重写开场" }],
                  repairInstructions: ["重写开场"],
                }
              : {
                  version: "video-factory/role-audit-v1",
                  verdict: "pass",
                  score: 92,
                  summary: "可以继续。",
                  issues: [],
                  repairInstructions: [],
                },
          }),
          validate: (value) => value as ScriptDraft,
        });
      },
    };
    const subject = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });
    const failed = await subject.start(brief);

    assert.equal(failed.status, "failed");
    const retried = await subject.retryFailedNode(failed.id, "script");

    assert.equal(modelCalls, 2);
    assert.equal(checkpointKeys.length, 2);
    assert.equal(checkpointKeys[0], checkpointKeys[1]);
    assert.notEqual(requestIds[0], requestIds[1]);
    assert.notEqual(retried.status, "failed");
  });

  it("preserves the last rejected script draft as an editable artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-rejected-draft-"));
    const rejectedDraft = { ...scriptDraft, viewerPromise: "仍可由人工修订的最后草稿" };
    const agent: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      draft: async () => rejectedDraft,
      draftDetailed: async () => {
        throw new RoleAgentLoopError("三轮审计仍未通过", {
          version: "video-factory/agent-loop-v1",
          role: "编剧",
          contractVersion: "screenwriter-v4|role-audit-v1|script-validator-v1",
          criteria: ["前两秒建立具体钩子"],
          status: "failed",
          maxIterations: 3,
          modelCallCount: 6,
          iterations: [{
            iteration: 3,
            candidate: rejectedDraft,
            candidateHash: "a".repeat(64),
            audit: {
              version: "video-factory/role-audit-v1",
              verdict: "repair",
              score: 70,
              summary: "仍需人工判断。",
              issues: [{ severity: "blocking", criterion: "钩子", evidence: "开场偏慢", repairInstruction: "人工重写开场" }],
              repairInstructions: ["人工重写开场"],
            },
          }],
        });
      },
    };

    const run = await new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent }).start(brief);
    const scriptNode = run.nodeRuns.find((node) => node.nodeId === "script");
    const scriptArtifact = run.artifacts.find((artifact) => artifact.kind === "script");

    assert.equal(run.status, "failed");
    assert.equal(scriptNode?.status, "failed");
    assert.ok(scriptArtifact?.uri);
    assert.equal((scriptNode?.output as { scriptPath?: string })?.scriptPath, scriptArtifact.uri);
    assert.equal(JSON.parse(await readFile(scriptArtifact.uri, "utf8")).viewerPromise, "仍可由人工修订的最后草稿");
  });

  it("refuses to form a series Internal Master when a generic script has no canon facts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-generic-script-"));
    const worker = new RecordingWorker();
    const run = await new ProductionPipeline({ workspaceRoot, worker }).start({
      ...brief,
      providers: { ...brief.providers, script: "python-template-v1" },
      seriesContext,
    });

    assert.equal(run.status, "failed");
    assert.equal(run.nodeRuns.at(-1)?.nodeId, "script");
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /进入素材、配音和渲染前必须确认 1 到 8 条.*定版事实/);
    assert.deepEqual(worker.requests.map((request) => request.capability), ["script.draft"]);
  });

  it("reads series canon facts from the verified generic script artifact", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-generic-canon-"));
    const canonFacts = ["本集已经确认一条可供后集依赖的事实。"];
    const worker = new RecordingWorker({ scenes: scriptDraft.scenes, canonFacts });
    const run = await new ProductionPipeline({ workspaceRoot, worker }).start({
      ...brief,
      providers: { ...brief.providers, script: "python-template-v1" },
      seriesContext,
    });

    assert.equal(run.status, "succeeded");
    assert.deepEqual((run.nodeRuns.find((node) => node.nodeId === "script")?.output as { canonFacts?: string[] }).canonFacts, canonFacts);
    assert.deepEqual((run.nodeRuns.find((node) => node.nodeId === "final-review")?.output as { canonFacts?: string[] }).canonFacts, canonFacts);
  });

  it("carries script canon facts into the final-review contract", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-canon-review-"));
    const worker = new RecordingWorker();
    const canonFacts = ["本集已经完成一次可复现的真实验证。"];
    const { agent } = stubAgent(() => ({ ...scriptDraft, canonFacts }));
    const run = await new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent }).start(brief);

    const scriptNode = run.nodeRuns.find((node) => node.nodeId === "script");
    const finalReview = run.nodeRuns.find((node) => node.nodeId === "final-review");
    assert.deepEqual((scriptNode?.output as { canonFacts?: string[] }).canonFacts, canonFacts);
    assert.deepEqual((finalReview?.output as { canonFacts?: string[] }).canonFacts, canonFacts);
    assert.deepEqual(
      (finalReview?.inputState?.versions.at(-1)?.value as { canonFacts?: string[] }).canonFacts,
      canonFacts,
    );
  });

  it("persists the exact model prompt as an immutable artifact on the generated output version", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-trace-"));
    const worker = new RecordingWorker();
    const agent: ScreenwriterAgent = {
      id: "codex-screenwriter-v1",
      draft: async () => scriptDraft,
      draftDetailed: async () => ({
        output: scriptDraft,
        trace: {
          taskKind: "script-draft",
          promptVersion: "video-factory/screenwriter-v2",
          prompt: "Prompt Pack: video-factory/screenwriter-v2\nactual prompt",
          providerId: "openai",
          modelId: "gpt-5.4",
          reasoningEffort: "high",
          fallbackFromModelId: "glm-5.3",
          fallbackReason: "首选模型连接失败，已自动切换。",
          attemptedModelIds: ["glm-5.3", "gpt-5.4"],
          providerWaitMs: 12_340,
          firstOutputEventMs: 410,
          toolMs: 0,
          validationMs: 7,
          modelCandidateAttempts: [{
            modelId: "glm-5.3",
            providerId: "zai-bigmodel-api",
            outcome: "failed",
            failureStage: "not_accepted",
            failureReason: "连接失败",
          }, {
            modelId: "gpt-5.4",
            providerId: "openai",
            outcome: "succeeded",
          }],
        },
        agentLoop: {
          version: "video-factory/agent-loop-v1",
          role: "编剧",
          contractVersion: "screenwriter-v4|role-audit-v1|script-validator-v1",
          criteria: ["标题具体"],
          status: "passed",
          maxIterations: 2,
          modelCallCount: 2,
          producerModelCallCount: 1,
          auditModelCallCount: 1,
          producerMs: 12_600,
          auditMs: 8_200,
          validationMs: 14,
          retryCount: 1,
          iterations: [{
            iteration: 1,
            candidate: scriptDraft,
            candidateHash: "a".repeat(64),
            audit: {
              version: "video-factory/role-audit-v1",
              verdict: "pass",
              score: 93,
              summary: "可执行。",
              issues: [],
              repairInstructions: [],
            },
            auditTrace: {
              taskKind: "role-audit",
              promptVersion: "video-factory/role-audit-v1",
              prompt: "independent audit prompt",
              providerId: "openai",
              modelId: "gpt-5.6-sol",
              reasoningEffort: "xhigh",
            },
          }],
        },
      }),
    };
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const run = await pipeline.start(brief);

    const traceArtifact = run.artifacts.find((artifact) => artifact.kind === "model_trace");
    assert.ok(traceArtifact?.uri);
    assert.equal(traceArtifact.producer?.nodeId, "script");
    assert.equal(traceArtifact.provenance.promptVersion, "video-factory/screenwriter-v2");
    assert.equal(traceArtifact.provenance.model, "gpt-5.4");
    assert.deepEqual(JSON.parse(await readFile(traceArtifact.uri, "utf8")), {
      version: "video-factory/model-trace-v1",
      taskKind: "script-draft",
      promptVersion: "video-factory/screenwriter-v2",
      providerId: "openai",
      modelId: "gpt-5.4",
      reasoningEffort: "high",
      fallbackFromModelId: "glm-5.3",
      fallbackReason: "首选模型连接失败，已自动切换。",
      attemptedModelIds: ["glm-5.3", "gpt-5.4"],
      modelCandidateAttempts: [{
        modelId: "glm-5.3",
        providerId: "zai-bigmodel-api",
        outcome: "failed",
        failureStage: "not_accepted",
        failureReason: "连接失败",
      }, {
        modelId: "gpt-5.4",
        providerId: "openai",
        outcome: "succeeded",
      }],
      providerWaitMs: 12_340,
      firstOutputEventMs: 410,
      toolMs: 0,
      validationMs: 7,
      prompt: "Prompt Pack: video-factory/screenwriter-v2\nactual prompt",
    });
    const loopArtifact = run.artifacts.find((artifact) => artifact.kind === "agent_loop_trace");
    assert.ok(loopArtifact?.uri);
    const loopTrace = JSON.parse(await readFile(loopArtifact.uri, "utf8")) as Record<string, unknown>;
    assert.equal(loopTrace.status, "passed");
    assert.equal((loopTrace.iterations as Array<{ auditor?: { reasoningEffort?: string } }>)[0]?.auditor?.reasoningEffort, "xhigh");
    const scriptNode = run.nodeRuns.find((node) => node.nodeId === "script");
    assert.equal(scriptNode?.executionReceipt?.parameters?.agentLoopIterations, 1);
    assert.equal(scriptNode?.executionReceipt?.parameters?.auditReasoningEffort, "xhigh");
    assert.equal(scriptNode?.executionReceipt?.parameters?.modelCallCount, 2);
    assert.equal(scriptNode?.executionReceipt?.parameters?.providerWaitMs, 12_340);
    assert.equal(scriptNode?.executionReceipt?.parameters?.firstOutputEventMs, 410);
    assert.equal(scriptNode?.executionReceipt?.parameters?.providerValidationMs, 7);
    assert.equal(scriptNode?.executionReceipt?.parameters?.producerMs, 12_600);
    assert.equal(scriptNode?.executionReceipt?.parameters?.auditMs, 8_200);
    assert.equal(scriptNode?.executionReceipt?.parameters?.loopValidationMs, 14);
    assert.equal(scriptNode?.executionReceipt?.parameters?.retryCount, 1);
    assert.equal(scriptNode?.executionReceipt?.fallbackReason, "首选模型连接失败，已自动切换。");
    assert.deepEqual(scriptNode?.executionReceipt?.actualModelIds, ["glm-5.3", "gpt-5.4"]);
    const generatedVersion = scriptNode?.outputState?.versions.find((version) => version.source === "generated");
    assert.ok(generatedVersion?.artifactIds.includes(traceArtifact.id));
  });

  it("persists the codex script, feeds the same path downstream, and records provenance", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-"));
    const worker = new RecordingWorker();
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });

    const run = await pipeline.start({ ...brief, templateSnapshot });

    assert.equal(run.status, "succeeded");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.brief.nicheSlug, "life-avoidance");
    assert.equal(inputs[0]?.brief.title, brief.title);
    assert.equal(inputs[0]?.brief.platform, brief.platform);
    assert.equal(inputs[0]?.brief.durationSeconds, brief.durationSeconds);
    assert.deepEqual(inputs[0]?.brief.templateBlueprint, templateSnapshot.resolvedBlueprint);

    const scriptArtifact = run.artifacts.find((artifact) => artifact.kind === "script");
    assert.ok(scriptArtifact?.uri);
    assert.equal(scriptArtifact.producer?.nodeId, "script");
    assert.equal(scriptArtifact.provenance.providerId, "codex-screenwriter-v1");
    assert.equal(scriptArtifact.contentType, "application/json");
    assert.equal(scriptArtifact.schemaVersion, "video-factory/script-draft-v1");
    const content = await readFile(scriptArtifact.uri, "utf8");
    assert.deepEqual(JSON.parse(content), {
      title: brief.title,
      hook: scriptDraft.scenes[0]!.narration,
      duration_target: brief.durationSeconds,
      disclosure_required: true,
      niche_slug: brief.nicheSlug,
      structure: "AI 编剧短视频结构",
      quality_checks: ["核验事实与数据", "人工审片后再发布"],
      platform_notes: {
        platform: brief.platform,
        audience: brief.audience,
        angle: brief.angle,
      },
      hashtags: [],
      scenes: scriptDraft.scenes,
    });
    assert.equal(scriptArtifact.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(scriptArtifact.sizeBytes, Buffer.byteLength(content));

    const assetsRequest = worker.requests.find((request) => request.capability === "asset.prepare");
    assert.equal(assetsRequest?.input.scriptPath, scriptArtifact.uri);
    assert.equal(worker.requests.some((request) => request.capability === "script.draft"), false);
  });

  it("reruns the screenwriter from the saved human node input instead of the original brief closure", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-input-"));
    const worker = new RecordingWorker();
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });
    const completed = await pipeline.start(brief);

    const edited = await pipeline.applyNodeInputOverride(completed.id, {
      nodeId: "script",
      actor: "editor",
      input: { brief: { ...brief, title: "人工修改后的题目" } },
      allowTerminalEdit: true,
    });
    const regenerated = await pipeline.resumeStale(edited.id);

    assert.equal(regenerated.status, "succeeded");
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1]?.brief.title, "人工修改后的题目");
    assert.equal(regenerated.nodeRuns.find((node) => node.nodeId === "script")?.inputState?.versions.at(-1)?.source, "human");
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

  it("keeps a historical codex run readable when that provider is no longer configured", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-history-"));
    const worker = new RecordingWorker();
    const { agent } = stubAgent(() => scriptDraft);
    const writer = new ProductionPipeline({ workspaceRoot, worker, screenwriterAgent: agent });
    const completed = await writer.start(brief);

    const observer = new ProductionPipeline({ workspaceRoot, worker });
    const historical = await observer.show(completed.id);

    assert.equal(historical.id, completed.id);
    assert.equal(historical.status, "succeeded");
    assert.equal(historical.nodeRuns.find((node) => node.nodeId === "script")?.status, "succeeded");
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
    assert.match(run.nodeRuns.at(-1)?.error ?? "", /between 3 and 24 scenes/);
    assert.equal(run.artifacts.some((artifact) => artifact.kind === "script"), false);
    assert.equal(worker.requests.length, 0);
    await assert.rejects(
      () => readFile(path.join(workspaceRoot, "runs", run.id, "nodes", "script", "attempt-1", "script.json"), "utf8"),
      /ENOENT/,
    );
  });
});
