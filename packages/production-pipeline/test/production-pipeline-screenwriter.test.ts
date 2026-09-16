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
  summarizeReworkImpact,
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
  runPurpose: "test",
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

  it("reuses a verified unchanged source script before calling the screenwriter", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-reuse-"));
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });
    const source = await pipeline.start(brief);
    const sourceScript = source.artifacts.find((artifact) => artifact.kind === "script");
    assert.ok(sourceScript?.uri);
    const previousScript = JSON.parse(await readFile(sourceScript.uri, "utf8"));

    const reworked = await pipeline.start({
      ...brief,
      rework: {
        sourceRunId: source.id,
        sourceRunRevision: source.revision,
        affectedScenePositions: [],
        nodeInstructions: {
          script: "没有脚本问题，沿用已验证脚本。",
          visualDirection: "没有视觉问题，沿用已验证方案。",
          assets: "没有素材问题，沿用已验证母片。",
        },
        findings: [],
        previousScript,
      },
    });

    assert.equal(inputs.length, 1, "the rework must decide reuse before invoking the model");
    const reworkedScript = reworked.artifacts.find((artifact) => artifact.kind === "script");
    assert.equal(reworkedScript?.sha256, sourceScript.sha256);
    assert.equal(reworkedScript?.provenance.providerId, sourceScript.provenance.providerId);
    assert.equal(reworkedScript?.provenance.model, sourceScript.provenance.model);
    assert.equal(reworked.artifacts.some((artifact) => artifact.kind === "model_trace"), false);
    assert.deepEqual(summarizeReworkImpact(reworked), {
      version: "video-factory/rework-impact-v1",
      sourceRunId: source.id,
      affectedScenePositions: [],
      nodes: [
        { nodeId: "script", action: "inherited", reason: "verified_source_match" },
        { nodeId: "visual-direction", action: "not_run", reason: "not_reached" },
        { nodeId: "assets", action: "executed", reason: "affected_input" },
        { nodeId: "voice", action: "executed", reason: "affected_input" },
        { nodeId: "render", action: "executed", reason: "affected_input" },
        { nodeId: "technical-review", action: "executed", reason: "affected_input" },
        { nodeId: "visual-review", action: "not_run", reason: "not_reached" },
      ],
      calls: { scriptModel: 0, mediaCreate: 0, voice: 1, render: 1, visualReview: 0 },
      media: { retainedSha256: [], producedSha256: [], mayCreateNewMedia: false },
    });

    const briefNode = reworked.nodeRuns.find(({ nodeId }) => nodeId === "brief");
    assert.ok(briefNode?.outputState);
    briefNode.outputState.versions.push({
      id: "brief-human-rework",
      nodeId: "brief",
      source: "human",
      output: {
        rework: {
          ...reworked.initialInput.rework,
          sourceRunId: "run-source-after-brief-revision",
          affectedScenePositions: [2],
        },
      },
      artifactIds: [],
      inputVersionIds: [],
      createdAt: reworked.startedAt,
      createdBy: "owner",
      schemaVersion: "video-factory/brief-v1",
    });
    briefNode.outputState.effectiveVersionId = "brief-human-rework";

    assert.equal(summarizeReworkImpact(reworked)?.sourceRunId, "run-source-after-brief-revision");
    assert.deepEqual(summarizeReworkImpact(reworked)?.affectedScenePositions, [2]);

    const fullScopeRework = { ...reworked.initialInput.rework };
    delete fullScopeRework.affectedScenePositions;
    briefNode.outputState.versions.push({
      id: "brief-human-full-scope-rework",
      nodeId: "brief",
      source: "human",
      output: { rework: fullScopeRework },
      artifactIds: [],
      inputVersionIds: [],
      createdAt: reworked.startedAt,
      createdBy: "owner",
      schemaVersion: "video-factory/brief-v1",
    });
    briefNode.outputState.effectiveVersionId = "brief-human-full-scope-rework";

    assert.deepEqual(summarizeReworkImpact(reworked)?.affectedScenePositions, [1, 2, 3]);
  });

  it("binds source script reuse to the effective source node input", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-source-input-"));
    const { agent, inputs } = stubAgent(() => scriptDraft);
    const pipeline = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });
    const source = await pipeline.start(brief);
    const sourceScriptNode = source.nodeRuns.find(({ nodeId }) => nodeId === "script");
    const sourceInput = sourceScriptNode?.inputState?.versions.find(
      ({ id }) => id === sourceScriptNode.inputState?.effectiveVersionId,
    )?.value as ScreenwriterAgentInput | undefined;
    assert.ok(sourceInput);

    const effectiveTitle = "实际由源编剧消费的人工题目";
    const stale = await pipeline.applyNodeInputOverride(source.id, {
      nodeId: "script",
      actor: "editor",
      input: { ...sourceInput, brief: { ...sourceInput.brief, title: effectiveTitle } },
      allowTerminalEdit: true,
    });
    const regeneratedSource = await pipeline.resumeStale(stale.id);
    const effectiveScriptNode = regeneratedSource.nodeRuns.find(({ nodeId }) => nodeId === "script");
    const effectiveOutput = effectiveScriptNode?.outputState?.versions.find(
      ({ id }) => id === effectiveScriptNode.outputState?.effectiveVersionId,
    );
    const effectiveScriptArtifact = effectiveOutput?.artifactIds
      .map((id) => regeneratedSource.artifacts.find((artifact) => artifact.id === id))
      .find((artifact) => artifact?.kind === "script");
    assert.ok(effectiveScriptArtifact?.uri);
    const previousScript = JSON.parse(await readFile(effectiveScriptArtifact.uri, "utf8"));

    await pipeline.start({
      ...brief,
      title: effectiveTitle,
      rework: {
        sourceRunId: regeneratedSource.id,
        sourceRunRevision: regeneratedSource.revision,
        affectedScenePositions: [],
        nodeInstructions: { script: "沿用", visualDirection: "沿用", assets: "沿用" },
        findings: [],
        previousScript,
      },
    });
    assert.equal(inputs.length, 2, "matching the source node's actual input must reuse before another model call");

    const sourceRunPath = path.join(workspaceRoot, "runs", regeneratedSource.id, "run.json");
    await pipeline.withRunMaintenanceLease([regeneratedSource.id], async () => {
      await pipeline.start({
        ...brief,
        title: effectiveTitle,
        rework: {
          sourceRunId: regeneratedSource.id,
          sourceRunRevision: regeneratedSource.revision,
          affectedScenePositions: [],
          nodeInstructions: { script: "沿用", visualDirection: "沿用", assets: "沿用" },
          findings: [],
          previousScript,
        },
      });
      const sourceMutation = JSON.parse(await readFile(sourceRunPath, "utf8"));
      sourceMutation.revision += 1;
      await writeFile(sourceRunPath, `${JSON.stringify(sourceMutation, null, 2)}\n`, "utf8");
    });
    assert.equal(inputs.length, 3, "a locked source snapshot must fail closed instead of being inherited");
    await writeFile(sourceRunPath, `${JSON.stringify(regeneratedSource, null, 2)}\n`, "utf8");

    const persistedSource = JSON.parse(await readFile(sourceRunPath, "utf8"));
    const persistedScriptNode = persistedSource.nodeRuns.find((node: { nodeId: string }) => node.nodeId === "script");
    const effectiveVersion = persistedScriptNode.outputState.versions.find(
      (version: { id: string }) => version.id === persistedScriptNode.outputState.effectiveVersionId,
    );
    const persistedScriptArtifact = persistedSource.artifacts.find(
      (artifact: { id: string }) => effectiveVersion.artifactIds.includes(artifact.id),
    );
    persistedScriptArtifact.producer.nodeId = "brief";
    await writeFile(sourceRunPath, `${JSON.stringify(persistedSource, null, 2)}\n`, "utf8");
    await pipeline.start({
      ...brief,
      title: effectiveTitle,
      rework: {
        sourceRunId: regeneratedSource.id,
        sourceRunRevision: regeneratedSource.revision,
        affectedScenePositions: [],
        nodeInstructions: { script: "沿用", visualDirection: "沿用", assets: "沿用" },
        findings: [],
        previousScript,
      },
    });
    assert.equal(inputs.length, 4, "an artifact with the wrong producer must not be inherited");
    await writeFile(sourceRunPath, `${JSON.stringify(regeneratedSource, null, 2)}\n`, "utf8");

    await pipeline.start({
      ...brief,
      title: "与源节点实际输入不同的题目",
      rework: {
        sourceRunId: regeneratedSource.id,
        sourceRunRevision: regeneratedSource.revision,
        affectedScenePositions: [],
        nodeInstructions: { script: "沿用", visualDirection: "沿用", assets: "沿用" },
        findings: [],
        previousScript,
      },
    });
    assert.equal(inputs.length, 5, "different actual screenwriter input must invoke the model");
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
    let auditCalls = 0;
    let repairing = true;
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
          maxIterations: 2,
          checkpoint,
          produce: async (_revision, { requestId }) => {
            modelCalls += 1;
            requestIds.push(requestId);
            // 每轮都交回同一份草稿。审计说 repair 不再让节点失败——那是人的裁决——所以循环真正
            // 耗尽的路径是"按建议重做后内容没有变化"：模型没带来任何新东西，重试也就无从谈起。
            return { output: scriptDraft };
          },
          audit: async () => {
            auditCalls += 1;
            return {
              output: repairing
                ? {
                    version: "video-factory/role-audit-v2",
                    rubricVersion: "video-factory/role-quality-rubric-v1",
                    assessments: [{
                      targetPath: "",
                      dimensions: [
                        { dimension: "attention", score: 70, evidence: "开场没有具体对象。" },
                        { dimension: "progression", score: 70, evidence: "中段信息推进偏慢。" },
                        { dimension: "payoff", score: 70, evidence: "结尾没有回答开场承诺。" },
                        { dimension: "expression", score: 70, evidence: "旁白句式拖沓。" },
                      ],
                    }],
                    verdict: "repair",
                    score: 70,
                    summary: "仍需修订。",
                    issues: [{ severity: "blocking", criterion: "钩子", evidence: "开场偏慢", repairInstruction: "重写开场" }],
                    repairInstructions: ["重写开场"],
                  }
                : {
                    version: "video-factory/role-audit-v2",
                    rubricVersion: "video-factory/role-quality-rubric-v1",
                    assessments: [{
                      targetPath: "",
                      dimensions: [
                        { dimension: "attention", score: 92, evidence: "开场给出具体对象。" },
                        { dimension: "progression", score: 92, evidence: "中段逐步给出结果。" },
                        { dimension: "payoff", score: 92, evidence: "结尾回答原承诺。" },
                        { dimension: "expression", score: 92, evidence: "旁白自然可读。" },
                      ],
                    }],
                    verdict: "pass",
                    score: 92,
                    summary: "可以继续。",
                    issues: [],
                    repairInstructions: [],
                  },
            };
          },
          validate: (value) => value as ScriptDraft,
        });
      },
    };
    const subject = new ProductionPipeline({ workspaceRoot, worker: new RecordingWorker(), screenwriterAgent: agent });
    const failed = await subject.start(brief);
    repairing = false;

    assert.equal(failed.status, "failed");
    const retried = await subject.retryFailedNode(failed.id, "script");

    // 第一轮两次产出、一次审计（第二轮在审计前就因内容没变而终止），重试后是新 cycle 的又一次产出。
    assert.equal(modelCalls, 3);
    assert.equal(auditCalls, 2);
    assert.equal(checkpointKeys.length, 2);
    assert.equal(checkpointKeys[0], checkpointKeys[1]);
    assert.notEqual(requestIds[0], requestIds[2]);
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
              version: "video-factory/role-audit-v2",
              rubricVersion: "video-factory/role-quality-rubric-v1",
              assessments: [{
                targetPath: "",
                dimensions: [
                  { dimension: "attention", score: 70, evidence: "开场没有具体对象。" },
                  { dimension: "progression", score: 70, evidence: "中段信息推进偏慢。" },
                  { dimension: "payoff", score: 70, evidence: "结尾没有回答开场承诺。" },
                  { dimension: "expression", score: 70, evidence: "旁白句式拖沓。" },
                ],
              }],
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

  it("allows a series episode with no new canon facts to continue through final review", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-series-generic-script-"));
    const worker = new RecordingWorker({ capability: "script.draft", canonFacts: [] });
    const run = await new ProductionPipeline({ workspaceRoot, worker }).start({
      ...brief,
      providers: { ...brief.providers, script: "python-template-v1" },
      seriesContext,
    });

    assert.equal(run.status, "succeeded");
    assert.deepEqual(
      (run.nodeRuns.find((node) => node.nodeId === "script")?.output as { canonFacts?: string[] }).canonFacts,
      [],
    );
    assert.deepEqual(
      (run.nodeRuns.find((node) => node.nodeId === "final-review")?.output as { canonFacts?: string[] }).canonFacts,
      [],
    );
    assert.equal(run.nodeRuns.find((node) => node.nodeId === "final-review")?.status, "succeeded");
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
          queueWaitMs: 100,
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
            candidateTrace: {
              taskKind: "script-draft",
              promptVersion: "video-factory/screenwriter-v2",
              prompt: "producer prompt",
              providerId: "openai",
              modelId: "gpt-5.4",
              queueWaitMs: 100,
              providerWaitMs: 12_340,
            },
            audit: {
              version: "video-factory/role-audit-v2",
              rubricVersion: "video-factory/role-quality-rubric-v1",
              assessments: [{
                targetPath: "",
                dimensions: [
                  { dimension: "attention", score: 93, evidence: "开场给出具体对象。" },
                  { dimension: "progression", score: 93, evidence: "中段逐步给出结果。" },
                  { dimension: "payoff", score: 93, evidence: "结尾回答原承诺。" },
                  { dimension: "expression", score: 93, evidence: "旁白自然可读。" },
                ],
              }],
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
              queueWaitMs: 200,
              providerWaitMs: 8_000,
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
      queueWaitMs: 100,
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
    assert.equal(scriptNode?.executionReceipt?.parameters?.queueWaitMs, 300);
    assert.equal(scriptNode?.executionReceipt?.parameters?.providerWaitMs, 20_340);
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
    assert.equal("templateGuidance" in (inputs[0]?.brief ?? {}), false);

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

  it("propagates an explicit duration range and rejects the same 31.5s draft for a fixed 24s production", async () => {
    const rangedDraft: ScriptDraft = {
      scenes: [4, 6, 3, 3, 3, 4, 7, 1.5].map((duration, index) => ({
        ...scriptDraft.scenes[index % scriptDraft.scenes.length]!,
        position: index + 1,
        duration,
      })),
    };
    const rangedWorkspace = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-range-"));
    const rangedAgent = stubAgent(() => rangedDraft);
    const rangedRun = await new ProductionPipeline({
      workspaceRoot: rangedWorkspace,
      worker: new RecordingWorker(),
      screenwriterAgent: rangedAgent.agent,
    }).start({
      ...brief,
      durationRange: { minSeconds: 20, maxSeconds: 34 },
    });

    assert.equal(rangedRun.status, "succeeded");
    assert.deepEqual(rangedAgent.inputs[0]?.brief.durationRange, { minSeconds: 20, maxSeconds: 34 });
    const rangedScript = rangedRun.artifacts.find((artifact) => artifact.kind === "script");
    assert.ok(rangedScript?.uri);
    assert.deepEqual(JSON.parse(await readFile(rangedScript.uri, "utf8")).duration_range, {
      minSeconds: 20,
      maxSeconds: 34,
    });

    const fixedWorkspace = await mkdtemp(path.join(tmpdir(), "video-factory-screenwriter-fixed-range-"));
    const fixedRun = await new ProductionPipeline({
      workspaceRoot: fixedWorkspace,
      worker: new RecordingWorker(),
      screenwriterAgent: stubAgent(() => rangedDraft).agent,
    }).start({
      ...brief,
      durationRange: { minSeconds: 24, maxSeconds: 24 },
    });

    assert.equal(fixedRun.status, "failed");
    assert.equal(fixedRun.nodeRuns.at(-1)?.nodeId, "script");
    assert.match(fixedRun.nodeRuns.at(-1)?.error ?? "", /outside the 24-24s duration range/);
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
