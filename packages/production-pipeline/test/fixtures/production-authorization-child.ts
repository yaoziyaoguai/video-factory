import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GenerativeAssetWorkerClient,
  ProductionPipeline,
  inspectPaidAssetLedger,
  type ProductionBrief,
  type WorkerResponse,
} from "../../src/index.js";
import {
  canonicalProductionAssetIntentDigest,
  canonicalQualityContractDigest,
  foldProductionSpendLedger,
  type ProductionAuthorizationScope,
} from "../../src/production-authorization.js";

export const AUTH_BRIEF = {
  protocolVersion: "video-factory/brief-v1",
  title: "制作范围授权验证",
  angle: "授权边界",
  audience: "创作者",
  nicheSlug: "auth",
  durationSeconds: 24,
  durationRange: { minSeconds: 20, maxSeconds: 34 },
  platform: "douyin",
  runPurpose: "test",
  reviewMode: "manual",
  providers: {
    script: "codex-screenwriter-v1",
    director: "api-visual-director-v1",
    assets: "local-editorial-v1",
    voice: "macos-say-v1",
    render: "python-ffmpeg-v1",
    technicalReview: "python-technical-review-v1",
  },
  workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true, creativePlanning: "joint-v1" },
  director: { profileId: "auto", assetProviderIds: ["local-editorial-v1"] },
  economics: { recipeId: "economy-daily", allowMeteredProviders: false, maxPaidShots: 0, maxCostCny: 0 },
  voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
} as unknown as ProductionBrief;

export async function scopeForCurrentQuote(
  pipeline: ProductionPipeline,
  runId: string,
  overrides: Partial<ProductionAuthorizationScope> = {},
): Promise<ProductionAuthorizationScope> {
  const run = await pipeline.show(runId);
  const assets = run.nodeRuns.find((node) => node.nodeId === "assets")!;
  const plan = assets.spendPlan!;
  const effectiveInput = assets.inputState?.versions.find((v) => v.id === assets.inputState?.effectiveVersionId)?.value as { executablePlanPath?: string };
  assert.ok(effectiveInput?.executablePlanPath, "assets input must reference the executable plan");
  const planDigest = createHash("sha256").update(await readFile(effectiveInput.executablePlanPath)).digest("hex");
  const brief = run.initialInput;
  assert.ok(brief.durationPolicy === undefined, "此夹具保留旧版授权合同");
  return {
    version: "video-factory/production-authorization-v1",
    id: "scope-cover",
    runId,
    approvalRevision: run.revision,
    acceptedPlanDigest: planDigest,
    qualityContractDigest: canonicalQualityContractDigest({
      angle: brief.angle,
      audience: brief.audience,
      durationRange: brief.durationRange ?? { minSeconds: 0, maxSeconds: 0 },
      directorProfileId: brief.director?.profileId ?? "",
      ...(brief.visualProof ? { visualProof: brief.visualProof } : {}),
    }),
    approvedAmountCents: Math.round(plan.maxCostCny * 100) + 10_000,
    approvedBy: "owner",
    approvedAt: "2026-09-10T00:00:00.000Z",
    permittedAssets: (plan.items ?? []).map((item) => ({
      assetKey: item.id,
      intentDigest: canonicalProductionAssetIntentDigest(planDigest, item.id),
      models: [{ providerId: item.providerId, modelId: item.modelId }],
      maxCreateAttempts: 2,
    })),
    ...overrides,
  };
}

interface CreateEvent { scene: number; taskId: string; pid: number }

// 只替代本地素材底图和外部模型；授权、账本、物化、执行租约全部使用正式实现。
class AssetBaseline {
  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    assert.equal(request.capability, "asset.prepare");
    const input = request.input as { scriptPath: string; directorPlanPath: string };
    const script = JSON.parse(await readFile(input.scriptPath, "utf8")) as { scenes: Array<{ position: number; duration: number }> };
    const director = JSON.parse(await readFile(input.directorPlanPath, "utf8")) as {
      shots: Array<{ scenePosition: number; preferredProviderId: string; query: string }>;
    };
    const planPath = path.join(String(request.outputDir), "asset_plan.json");
    const bytes = JSON.stringify({
      job_id: 1,
      scene_assets: script.scenes.map((scene) => ({
        scene_position: scene.position, provider: "seedance-video-v1", asset_id: `pending-${scene.position}`,
        media_type: "video", width: 720, height: 1280, duration: scene.duration,
        local_path: "", source_url: `pending://scene-${scene.position}`, creator: "Controlled fixture",
        license_note: "Generation pending.", query: `镜头内容 ${scene.position}`,
      })),
      director_routing: director.shots.map((shot) => ({
        scene_position: shot.scenePosition, preferred_provider_id: shot.preferredProviderId,
        actual_provider_id: shot.preferredProviderId, actual_provider: shot.preferredProviderId,
        fallback_used: false, generation_pending: true, director_shot: shot,
      })),
    });
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, bytes);
    return {
      protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId), status: "succeeded",
      output: { assetPlanPath: planPath },
      artifacts: [{ kind: "asset_plan", uri: planPath, sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: Buffer.byteLength(bytes), contentType: "application/json",
        provenance: { providerId: "local-editorial-v1", producerNodeId: String(request.nodeRunId),
          attempt: Number(request.attempt), licenseNote: "Controlled local baseline." } }],
    };
  }
}

export function createR5Fixture(workspaceRoot: string, options: {
  fallback?: { run(request: Record<string, unknown>): Promise<WorkerResponse> };
  outcome?: (scene: number, attempt: number) => "succeeded" | "failed";
  onCreate?: (event: CreateEvent) => Promise<void> | void;
} = {}) {
  const creates: CreateEvent[] = [];
  const worker = new GenerativeAssetWorkerClient({
    runsRoot: path.join(workspaceRoot, "runs"),
    fallback: options.fallback ?? new AssetBaseline(),
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url) => new Response(`controlled-media:${String(url)}`, { headers: { "content-type": "video/mp4" } }),
    adapters: [{
      estimatedCnyPerClip: 2.4, defaultModelId: "seedance-v1", modelPrices: { "seedance-v1": 2.4 },
      adapter: {
        providerId: "seedance-video-v1",
        generate: async (request, progress) => {
          const matched = /第(\d+)个生成镜头/.exec(request.prompt);
          assert.ok(matched, "provider request must retain its scene identity");
          const scene = Number(matched[1]);
          const attempt = creates.filter((entry) => entry.scene === scene).length + 1;
          const taskId = `r5-task-${process.pid}-${scene}-${attempt}`;
          const event = { scene, taskId, pid: process.pid };
          creates.push(event);
          await options.onCreate?.(event);
          await progress?.({ providerId: "seedance-video-v1", taskId, status: "submitted" });
          if (options.outcome?.(scene, attempt) === "succeeded") {
            return { providerId: "seedance-video-v1", taskId, videoUrl: `https://example.com/${taskId}.mp4` };
          }
          await progress?.({ providerId: "seedance-video-v1", taskId, status: "failed",
            error: `accepted task ${taskId} failed after acceptance` });
          throw new Error(`accepted task ${taskId} failed after acceptance`);
        },
      },
    }],
  });
  const pipeline = new ProductionPipeline({
    workspaceRoot, worker,
    treatmentAgents: [{ providerId: "openai", agent: {
      id: "codex-creative-treatment-v1", modelId: "treatment-model-a",
      treat: async () => ({
        version: "video-factory/creative-treatment-v2", viewerPromise: "看完能记住要点",
        hook: { narrationIntent: "直接抛出问题", visualIntent: "真实生活场景" },
        progression: [{ beatId: "beat-1", purpose: "建立问题", viewerGain: "识别坑" }],
        payoff: "低风险决策清单", visualPrinciples: ["真实动作"], soundPrinciples: ["环境声"],
        evidenceRequirements: [], feasibilityQuestions: [],
      }),
    } }],
    screenwriterAgent: {
      id: "codex-screenwriter-v1", modelId: "screenwriter-model-one",
      draft: async () => ({ viewerPromise: "看完能记住要点", narrativeArc: "问题-方法", canonFacts: ["要点可执行"],
        scenes: [
          { position: 1, narration: "第一段旁白", duration: 12,
            visual_strategy: "generated", visual_prompt: "第一个生成镜头", search_terms: ["镜头 1"] },
          { position: 2, narration: "第二段旁白", duration: 12,
            visual_strategy: "generated", visual_prompt: "第二个生成镜头", search_terms: ["镜头 2"] },
        ],
      }),
    } as never,
    directorAgent: {
      id: "api-visual-director-v1", modelId: "director-model-one",
      plan: async (input: { brief: { requestedProfileId: string }; scenes: Array<{ position: number }> }) => ({
        version: "video-factory/director-plan-v1", requestedProfileId: input.brief.requestedProfileId,
        resolvedProfileId: "documentary-observer", profileRationale: "生成镜头交付。",
        visualBible: { narrativeApproach: "逐步展示", pacing: "均匀", composition: "稳定中景",
          camera: "固定机位", color: "自然色", continuity: "同一时段", sound: "环境声" },
        shots: input.scenes.map((scene) => ({
          scenePosition: scene.position, narrativeRole: "解释", authenticityPolicy: "illustrative",
          preferredProviderId: "seedance-video-v1", deliveryType: "generated_video", alternativeProviderIds: [],
          temporalBeats: ["[0s-12s] 建立动作"], query: `镜头内容 ${scene.position}`,
          generationPrompt: `第${scene.position}个生成镜头`, rationale: "生成能力可以交付。",
          continuityNote: "保持自然色。", confidence: 0.8, estimatedCostCny: 0,
        })),
      }),
    } as never,
    assetProviders: [{ id: "seedance-video-v1", label: "Seedance", billing: "metered", modes: ["文生视频"],
      deliveryTypes: ["generated_video"], estimatedCnyPerClip: 2.4, generative: true }],
    providerRuntimeMetadata: [{ id: "seedance-video-v1", label: "Seedance", modelId: "seedance-v1",
      transport: "http_api", billing: "metered", estimatedCostCny: 2.4, maxAttempts: 1 }],
  });
  const brief: ProductionBrief = {
    ...AUTH_BRIEF,
    providers: { ...AUTH_BRIEF.providers, assets: "ai-shot-router-v1" },
    director: { profileId: "auto", assetProviderIds: ["seedance-video-v1"] },
    economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
  };
  return { pipeline, worker, brief, creates };
}

export async function readR5SpendState(workspaceRoot: string, runId: string) {
  const items = await inspectPaidAssetLedger(path.join(workspaceRoot, "runs", runId, "nodes", "assets"));
  return { items, state: foldProductionSpendLedger(items) };
}

// 每个阶段在新的OS进程中重建宿主。只传run身份；历史次数/金额只能从正式持久账本读取。
async function runChild() {
  const [root, scenario, phase] = process.argv.slice(2);
  assert.ok(root && ["attempts", "amount"].includes(scenario!) && ["seed", "retry", "amend"].includes(phase!));
  const fixture = createR5Fixture(root, { onCreate: event => appendFile(path.join(root, "provider-events.jsonl"), `${JSON.stringify(event)}\n`) });
  const { pipeline } = fixture;
  const commandPath = path.join(root, "r5-command.json");
  const recovered = await pipeline.recoverInterruptedRuns();
  let run;
  let before;
  if (phase === "seed") {
    const waiting = await pipeline.start(fixture.brief);
    assert.equal(waiting.status, "awaiting_spend_approval");
    const quoteMaximumCents = Math.round(waiting.nodeRuns.find(node => node.nodeId === "assets")!.spendPlan!.maxCostCny * 100);
    const scope = await scopeForCurrentQuote(pipeline, waiting.id);
    if (scenario === "amount") {
      scope.approvedAmountCents = quoteMaximumCents;
      scope.permittedAssets.forEach(asset => { asset.maxCreateAttempts = 4; });
    }
    run = await pipeline.acceptProductionAuthorization(waiting.id, scope);
    await writeFile(commandPath, JSON.stringify({ runId: run.id, quoteMaximumCents, scopeId: scope.id }));
  } else {
    const command = JSON.parse(await readFile(commandPath, "utf8")) as { runId: string; quoteMaximumCents: number; scopeId: string };
    before = await readR5SpendState(root, command.runId);
    if (phase === "amend") {
      assert.equal(scenario, "amount");
      const scope = await scopeForCurrentQuote(pipeline, command.runId, {
        id: "scope-added-funds", supersedesAuthorizationId: command.scopeId,
        approvedAmountCents: command.quoteMaximumCents + 240,
      });
      scope.permittedAssets.forEach(asset => { asset.maxCreateAttempts = 4; });
      run = await pipeline.acceptProductionAuthorization(command.runId, scope);
    } else {
      const previous = await pipeline.loadPersisted(command.runId);
      run = previous.status === "failed"
        ? await pipeline.retryFailedNode(command.runId, "assets")
        : await pipeline.resumeCoveredSpendApproval(command.runId);
    }
  }
  const after = await readR5SpendState(root, run.id);
  const scope = await pipeline.readProductionAuthorization(run.id);
  console.log(JSON.stringify({ pid: process.pid, recovered, before, after, run, scope, creates: fixture.creates }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runChild();
}
