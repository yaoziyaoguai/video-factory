import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// 审查探针：正式目录 → 能力摘要 → 角色适配器 → 正式 parser；不读取凭据或发送请求。
const layer = process.env.VF_REVIEW_DIST === '1' ? 'dist' : 'src';
const ext = layer === 'dist' ? 'js' : 'ts';
const root = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, root));
const { reviewedVideoModelCatalog } = await load(`apps/studio/${layer === 'dist' ? 'dist/server/server' : 'src/server'}/video-provider-settings.${ext}`);
const { summarizeProductionCapabilities } = await load(`packages/production-pipeline/${layer}/production-capabilities.${ext}`);
const { CodexCreativeTreatmentAgent } = await load(`packages/production-pipeline/${layer}/codex-creative-treatment.${ext}`);
const { parseTaskRequest, codexExecutorProfileFor } = await load(`apps/codex-broker/${layer}/codex-executor.${ext}`);
const { taskContractDescriptorFor } = await load(`apps/codex-broker/${layer}/task-definitions.${ext}`);
const { CodexBrokerServer } = await load(`apps/codex-broker/${layer}/broker-server.${ext}`);
const { CodexBridgeClient } = await load(`packages/production-pipeline/${layer}/codex-chat.${ext}`);
const { ProductionPipeline } = await load(`packages/production-pipeline/${layer}/production-pipeline.${ext}`);
const { buildDirectorAssetProviders, buildProductionProviderRuntimeMetadata } = await load(`apps/studio/${layer === 'dist' ? 'dist/server/server' : 'src/server'}/production-worker.${ext}`);
const { validateScriptDraft } = await load(`packages/production-pipeline/${layer}/codex-screenwriter.${ext}`);

const catalog = reviewedVideoModelCatalog({});
for (const [providerId, models] of Object.entries(catalog)) {
  const model = models.find(m => m.recommended) ?? models[0];
  test(`${layer}: enabled ${providerId} official model capabilities reach treatment parser`, async () => {
    const capabilities = summarizeProductionCapabilities([{
      id: providerId, deliveryTypes: ['generated_video'], strengths: ['概念视觉'],
      constraints: ['合成画面不得作为事实证据'], selectedModelId: model.id,
      minDurationSeconds: model.minDurationSeconds, maxDurationSeconds: model.maxDurationSeconds,
      aspectRatios: model.aspectRatios,
    }]);
    let payload;
    const stop = new Error('captured-without-submission');
    const agent = new CodexCreativeTreatmentAgent({client: {
      runTask: async (_kind, value) => { payload = value; throw stop; },
    }});
    await assert.rejects(agent.treat({brief: {
      title: '日常现象解释', angle: '用直观画面解释现象', audience: '普通观众',
      nicheSlug: 'ordinary-life', platform: 'douyin', durationSeconds: 24,
      durationRange: {minSeconds: 20, maxSeconds: 34}, productionCapabilities: capabilities,
    }, suppliedSources: []}), error => error === stop);
    let failure;
    try {
      parseTaskRequest({protocolVersion: 'video-factory/codex-bridge-v2', requestId: `review-${providerId}`,
        kind: 'creative-treatment', payload,
        expectedContractDigest: taskContractDescriptorFor('creative-treatment').digest,
      }, codexExecutorProfileFor('openai').identity);
    } catch (error) { failure = error; }
    console.log(JSON.stringify({layer, providerId, modelId: model.id, aspectRatios: model.aspectRatios, error: failure?.message, externalCalls: 0}));
    assert.equal(failure, undefined, 'official enabled capability profile must not reject an unrelated text planning request');
  });
}

test(`${layer}: a series with no established facts may return an empty canonFacts array`, () => {
  const script = {viewerPromise: '用节奏和色彩传达情绪', narrativeArc: '由紧张到舒缓', canonFacts: [],
    scenes: [1, 2, 3].map(position => ({position, narration: '观察光线与色彩的变化。', duration: 8,
      visual_strategy: 'image', visual_prompt: '抽象色彩，不充当事实证据', search_terms: ['light texture']}))};
  assert.doesNotThrow(() => validateScriptDraft(script, {
    durationSeconds: 24, durationRange: {minSeconds: 20, maxSeconds: 34}, requireCanonFacts: true,
  }), 'a factual-integrity requirement must not force invented facts');
});

if (process.env.VF_REVIEW_CAPTURE_RUN === '1') {
  for (const omitSeedance of [false, true]) {
    test(`${layer}: captured manual run through formal pipeline/socket (${omitSeedance ? 'isolate-other-providers' : 'original-selection'})`, async () => {
      const recorded = JSON.parse(await readFile(new URL('workspace/factory/runs/run-b50a099c-8d66-4785-8745-231fc5182a37/run.json', root), 'utf8'));
      const brief = structuredClone(recorded.initialInput);
      if (omitSeedance) brief.director.assetProviderIds = brief.director.assetProviderIds.filter(id => id !== 'seedance-video-v1');
      const directory = await mkdtemp(path.join(tmpdir(), 'vf-r7-entry-'));
      const socketPath = path.join(directory, 'worker.sock');
      let executions = 0, capturedError, capturedPayload;
      const server = new CodexBrokerServer({socketPath,
        idempotencyDirectory: path.join(directory, 'durable'), sessionDirectory: path.join(directory, 'sessions'),
        executor: {identity: codexExecutorProfileFor('openai').identity, async runTask() {
          executions++; throw new Error('review boundary reached; external executor disabled');
        }},
      });
      class CaptureClient extends CodexBridgeClient {
        async runTaskDetailed(...args) {
          capturedPayload = args[1];
          try { return await super.runTaskDetailed(...args); }
          catch (error) { capturedError = {message: error.message, stage: error.stage, status: error.statusCode}; throw error; }
        }
      }
      try {
        await server.start();
        const client = new CaptureClient({socketPath, timeoutMs: 1000, maxAttempts: 1, pollIntervalMs: 5});
        const env = {ARK_API_KEY: 'isolated-not-a-secret', MINIMAX_API_KEY: 'isolated-not-a-secret', PEXELS_API_KEY: 'isolated-not-a-secret', SEEDANCE_ESTIMATED_CNY_PER_CLIP: '5'};
        const forbidden = async () => { throw new Error('Review must not reach another role or media service'); };
        const pipeline = new ProductionPipeline({workspaceRoot: path.join(directory, 'workspace'),
          worker: {run: forbidden},
          assetProviders: buildDirectorAssetProviders({environment: env}),
          providerRuntimeMetadata: buildProductionProviderRuntimeMetadata(env),
          treatmentAgents: [{providerId: 'openai', agent: new CodexCreativeTreatmentAgent({client, maxReviewIterations: 1})}],
          screenwriterAgent: {id: brief.providers.script, draft: forbidden, draftDetailed: forbidden},
          directorAgent: {id: brief.providers.director, direct: forbidden, directDetailed: forbidden},
          assetSemanticRanker: {id: 'review-ranker', modelId: 'review-only', rank: forbidden},
          visualReviewAgent: {id: brief.providers.visualReview, review: forbidden, finalReviewConfiguration: {mode: 'dual', reviewers: [
            {providerId: 'review-only-a', modelId: 'review-only-a', independentRoleAudit: true},
            {providerId: 'review-only-b', modelId: 'review-only-b', independentRoleAudit: true},
          ]}},
        });
        const run = await pipeline.start(brief);
        console.log(JSON.stringify({layer, omitSeedance, executions, error: capturedError,
          capabilities: capturedPayload?.brief?.productionCapabilities,
          persistedErrorContainsField: JSON.stringify(run).includes('aspectRatios'),
          failure: run.nodeRuns.filter(n => n.status === 'failed').map(n => ({nodeId:n.nodeId,error:n.error})),
        }));
        assert.equal(executions, 1, 'valid Studio entry must reach the isolated executor exactly once');
      } finally { await server.close(); await rm(directory, {recursive: true, force: true}); }
    });
  }
}
