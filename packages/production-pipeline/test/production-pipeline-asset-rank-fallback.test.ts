import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { deterministicAssetRanking, ProductionPipeline, RoleAgentLoopError, type ProductionBrief, type WorkerResponse } from "../src/index.js";

class CandidateWorker {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const capability = String(request.capability);
    const outputDir = String(request.outputDir);
    await mkdir(outputDir, { recursive: true });
    if (capability === "asset.prepare") throw new Error("stop after ranking");
    if (capability === "script.draft") {
      const scriptPath = path.join(outputDir, "script.json");
      const content = JSON.stringify({ scenes: [{ position: 1, narration: "城市清晨", duration: 6, visual_strategy: "stock", visual_prompt: "早高峰地铁", visible_action: "乘客走入车厢", success_criteria: ["动作可见"], failure_conditions: ["空镜"] }] });
      await writeFile(scriptPath, content);
      return response(request, { scriptPath }, scriptPath, content, "script");
    }
    if (capability === "asset.search") {
      const candidateSearchPath = path.join(outputDir, "asset_candidates.json");
      const candidateInventoryPath = path.join(outputDir, "asset_candidate_inventory.json");
      const content = JSON.stringify({
        version: "video-factory/asset-candidates-v1",
        scene_candidates: [{
          scene_position: 1,
          intent: { subject: "通勤人群", visible_action: "进入车厢" },
          query: "city subway commute",
          candidates: [{ provider: "pexels", provider_id: "pexels-stock-v1", asset_id: "clip-1", media_type: "video", width: 1080, height: 1920, duration: 8, preview_url: "https://images.pexels.com/photos/1/preview.jpg", source_url: "https://www.pexels.com/video/1", creator: "Fixture", license_note: "Fixture", query: "subway", score: 80 }],
        }],
      });
      await writeFile(candidateSearchPath, content);
      await writeFile(candidateInventoryPath, "{}\n");
      return response(request, { candidateSearchPath, candidateInventoryPath }, candidateSearchPath, content, "asset_candidates");
    }
    throw new Error(`Unexpected capability: ${capability}`);
  }
}

describe("ProductionPipeline semantic ranking fallback", () => {
  it("records the failed model and reason in the immutable execution receipt", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rank-fallback-"));
    let auditFailure = false;
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new CandidateWorker(),
      assetSemanticRanker: {
        id: "codex-asset-ranker-v1",
        modelId: "codex-default",
        rank: async () => {
          if (auditFailure) throw exhaustedRankingAudit();
          throw new Error("thumbnail model unavailable at /workspace/video-factory/private/codex.sock");
        },
      },
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "真实通勤画面优先。",
          visualBible: { narrativeApproach: "观察", pacing: "紧凑", composition: "人物与环境", camera: "跟随", color: "自然", continuity: "同一早晨", sound: "环境声" },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "建立场景",
            authenticityPolicy: "evidence",
            preferredProviderId: "pexels-stock-v1",
            deliveryType: "stock_video",
            alternativeProviderIds: [],
            temporalBeats: ["[0s-3s] 人群接近车门", "[3s-6s] 人群进入车厢"],
            query: "city subway commute",
            generationPrompt: "通勤人群进入地铁车厢",
            rationale: "实拍素材更可信。",
            continuityNote: "保持清晨光线。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });
    const brief: ProductionBrief = {
      protocolVersion: "video-factory/brief-v1",
      title: "城市通勤",
      angle: "观察早高峰",
      audience: "城市青年",
      nicheSlug: "city-commute",
      durationSeconds: 24,
      platform: "douyin",
      reviewMode: "manual",
      providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      workflowFeatures: { assetSemanticRank: true, referenceGrammar: false },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"] },
      economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    };

    const run = await pipeline.start(brief);
    const ranking = run.nodeRuns.find((node) => node.nodeId === "asset-semantic-rank");
    assert.equal(run.status, "failed");
    assert.equal(ranking?.status, "succeeded", JSON.stringify(run.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, error: node.error }))));
    assert.equal(ranking?.executionReceipt?.providerId, "deterministic-quality-v1");
    assert.equal(ranking?.executionReceipt?.fallbackFromProviderId, "codex-asset-ranker-v1");
    assert.match(ranking?.executionReceipt?.fallbackReason ?? "", /thumbnail model unavailable/);
    assert.match(ranking?.executionReceipt?.fallbackReason ?? "", /\[系统托管文件\]/);
    assert.doesNotMatch(ranking?.executionReceipt?.fallbackReason ?? "", /\/workspace\/video-factory/);
    assert.equal(JSON.stringify((ranking?.output as { ranking?: unknown })?.ranking).includes(workspaceRoot), false);
    const rankingArtifact = run.artifacts.find((artifact) => artifact.kind === "asset_ranking");
    assert.ok(rankingArtifact?.uri);
    assert.equal((await readFile(rankingArtifact.uri, "utf8")).includes(workspaceRoot), false);

    auditFailure = true;
    const blocked = await pipeline.start({ ...brief, title: "审计失败的语义选片" });
    const blockedRanking = blocked.nodeRuns.find((node) => node.nodeId === "asset-semantic-rank");
    assert.equal(blocked.status, "failed");
    assert.equal(blockedRanking?.status, "failed");
    assert.match(blockedRanking?.error ?? "", /三轮语义选片审计仍未通过/);
    assert.equal(blocked.artifacts.some((artifact) => artifact.kind === "asset_ranking"), false);
  });

  it("records the model that actually executed instead of the configured broker alias", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-rank-trace-"));
    const pipeline = new ProductionPipeline({
      workspaceRoot,
      worker: new CandidateWorker(),
      assetSemanticRanker: {
        id: "codex-asset-ranker-v1",
        modelId: "codex-default",
        rank: async (report) => deterministicAssetRanking(report),
        rankDetailed: async (report) => {
          const output = deterministicAssetRanking(report);
          const trace = {
            taskKind: "asset-rank",
            promptVersion: "video-factory/asset-rank-v2",
            prompt: "fixture",
            providerId: "openai-codex-subscription",
            modelId: "gpt-5.4-mini",
            reasoningEffort: "high",
          } as const;
          return {
            output,
            trace,
            agentLoop: {
              version: "video-factory/agent-loop-v1",
              role: "语义选片师",
              contractVersion: "fixture-v1",
              criteria: ["候选顺序与画面证据一致"],
              status: "passed",
              maxIterations: 3,
              modelCallCount: 2,
              iterations: [{
                iteration: 1,
                candidate: output,
                candidateHash: "a".repeat(64),
                candidateTrace: trace,
                auditTrace: {
                  taskKind: "role-audit",
                  promptVersion: "video-factory/role-audit-v1",
                  prompt: "fixture audit",
                  providerId: "openai-codex-subscription",
                  modelId: "gpt-5.6-sol",
                  reasoningEffort: "xhigh",
                },
                audit: {
                  version: "video-factory/role-audit-v1",
                  verdict: "pass",
                  score: 96,
                  summary: "排序已核验。",
                  issues: [],
                  repairInstructions: [],
                },
              }],
            },
          };
        },
      },
      directorAgent: {
        id: "api-visual-director-v1",
        plan: async (input) => ({
          version: "video-factory/director-plan-v1",
          requestedProfileId: input.brief.requestedProfileId,
          resolvedProfileId: "documentary-observer",
          profileRationale: "真实通勤画面优先。",
          visualBible: { narrativeApproach: "观察", pacing: "紧凑", composition: "人物与环境", camera: "跟随", color: "自然", continuity: "同一早晨", sound: "环境声" },
          shots: input.scenes.map((scene) => ({
            scenePosition: scene.position,
            narrativeRole: "建立场景",
            authenticityPolicy: "evidence",
            preferredProviderId: "pexels-stock-v1",
            deliveryType: "stock_video",
            alternativeProviderIds: [],
            temporalBeats: ["[0s-3s] 人群接近车门", "[3s-6s] 人群进入车厢"],
            query: "city subway commute",
            generationPrompt: "通勤人群进入地铁车厢",
            rationale: "实拍素材更可信。",
            continuityNote: "保持清晨光线。",
            confidence: 0.8,
            estimatedCostCny: 0,
          })),
        }),
      },
      assetProviders: [
        { id: "pexels-stock-v1", label: "Pexels", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] },
        { id: "local-editorial-v1", label: "本地卡片", billing: "free", modes: ["本地"], deliveryTypes: ["editorial_card"] },
      ],
    });

    const run = await pipeline.start(semanticBrief("实际模型血缘"));
    const node = run.nodeRuns.find((candidate) => candidate.nodeId === "asset-semantic-rank");
    const rankingPath = (node?.output as { candidateRankingPath?: string } | undefined)?.candidateRankingPath;
    assert.ok(rankingPath);
    const ranking = JSON.parse(await readFile(rankingPath, "utf8"));
    assert.equal(ranking.providerId, "openai-codex-subscription");
    assert.equal(ranking.modelId, "gpt-5.4-mini");
    assert.equal(node?.executionReceipt?.modelId, "gpt-5.4-mini");
    assert.equal(node?.executionReceipt?.parameters?.agentLoop, "passed");
    assert.equal(node?.executionReceipt?.parameters?.agentLoopIterations, 1);
    assert.equal(node?.executionReceipt?.parameters?.auditReasoningEffort, "xhigh");
    assert.equal(node?.executionReceipt?.parameters?.rankingMode, "visual_semantic");
  });
});

function semanticBrief(title: string): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title,
    angle: "观察早高峰",
    audience: "城市青年",
    nicheSlug: "city-commute",
    durationSeconds: 24,
    platform: "douyin",
    reviewMode: "manual",
    providers: { script: "python-template-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
    workflowFeatures: { assetSemanticRank: true, referenceGrammar: false },
    director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1", "local-editorial-v1"] },
    economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  };
}

function exhaustedRankingAudit(): RoleAgentLoopError {
  return new RoleAgentLoopError("三轮语义选片审计仍未通过", {
    version: "video-factory/agent-loop-v1",
    role: "语义选片师",
    contractVersion: "fixture-v1",
    criteria: ["候选素材必须与画面意图一致"],
    status: "failed",
    maxIterations: 3,
    modelCallCount: 6,
    iterations: [],
  });
}

function response(
  request: Record<string, unknown>,
  output: Record<string, unknown>,
  uri: string,
  content: string,
  kind: string,
): WorkerResponse {
  return {
    protocolVersion: "video-factory/worker-v1",
    commandId: String(request.commandId),
    status: "succeeded",
    output,
    artifacts: [{
      kind,
      uri,
      contentType: "application/json",
      sizeBytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      provenance: { providerId: "fixture", producerNodeId: String(request.nodeRunId), attempt: Number(request.attempt), licenseNote: "Fixture" },
    }],
  };
}
