import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { NodeOverrideDraft, WorkflowRun } from "@video-factory/workflow-core";
import { ProductionPipeline, productionWorkflowVersion, validateShotGrammar, type ProductionBrief, type ProductionNodeDocumentAuditDraft } from "@video-factory/production-pipeline";
import { FileRunStore } from "../../../packages/production-pipeline/src/run-store.js";
import { ProductionStudio, type StudioPipelinePort } from "../src/server/production-studio.js";
import { StudioConflictError, StudioNotFoundError } from "../src/server/studio-errors.js";
import { StudioInputError } from "../src/shared/api.js";

// 「初稿审一次」合同 S4：发布文案（publish-package）的 AI 修订只产未审新稿、
// 主动再审只审当前精确稿；两者都必须绑定用户看到的版本身份。

const STARTED_AT = "2026-09-24T10:00:00.000Z";

function productionBrief(): ProductionBrief {
  return {
    protocolVersion: "video-factory/brief-v1",
    title: "下班后别急着做这 3 件事",
    angle: "用三条具体动作减少下班后的决策消耗",
    audience: "普通上班族",
    nicheSlug: "life-avoidance",
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
    economics: { recipeId: "custom", allowMeteredProviders: true, maxPaidShots: 0, maxCostCny: 0 },
    voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
  } as unknown as ProductionBrief;
}

function publishPackageDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "video-factory/publish-package-v1",
    runId: "run-publish",
    platform: "douyin",
    title: "下班后别急着做这 3 件事",
    copy: {
      source: "codex-publish-copy-v1",
      title: "下班后别急着做这 3 件事",
      description: "三个动作，把下班后的决定变少。",
      hashtags: ["下班", "决策消耗"],
    },
    approval: { status: "pending" },
    aigc: { disclosureRequired: true },
    resourceManifest: { version: 1, itemCount: 0, needsReviewCount: 0 },
    artifacts: [],
    ...overrides,
  };
}

interface HarnessOptions {
  copyOverride?: Record<string, unknown>;
  contentReview?: Record<string, unknown>;
}

async function buildHarness(tools: HarnessOptions["contentReview"] extends never ? never : {
  revise?: (input: { instruction: string }) => Promise<Record<string, unknown>>;
  auditCurrent?: (input: { copy: { title: string } }) => Promise<{ audit: Record<string, unknown> }>;
} | undefined, documentOptions: HarnessOptions = {}) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-doc-revision-"));
  const runRoot = path.join(workspaceRoot, "runs", "run-publish");
  const packagePath = path.join(runRoot, "nodes", "publish-package", "publish_package.json");
  const scriptPath = path.join(runRoot, "nodes", "script", "script.json");
  const manifestPath = path.join(runRoot, "nodes", "assets", "resource_manifest.json");
  await mkdir(path.dirname(packagePath), { recursive: true });
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const document = publishPackageDocument({
    ...(documentOptions.copyOverride ? { copy: { ...publishPackageDocument().copy, ...documentOptions.copyOverride } } : {}),
    ...(documentOptions.contentReview ? { contentReview: documentOptions.contentReview } : {}),
  });
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await writeFile(scriptPath, `${JSON.stringify({ scenes: [
    { narration: "第一场旁白" }, { narration: "第二场旁白" }, { narration: "第三场旁白" },
  ] }, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify({ version: 1, items: [] }, null, 2)}\n`, "utf8");

  const run: WorkflowRun<ProductionBrief> = {
    id: "run-publish",
    revision: 7,
    status: "needs_human",
    workflowId: "daily-production",
    workflowVersion: productionWorkflowVersion(productionBrief()),
    initialInput: productionBrief(),
    input: {},
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    nodeRuns: [
      {
        nodeId: "script",
        status: "succeeded",
        attempts: [],
        artifactIds: ["artifact-script"],
        qualityGateResults: [],
      },
      {
        nodeId: "publish-package",
        status: "succeeded",
        attempts: [],
        artifactIds: ["artifact-publish-package"],
        qualityGateResults: [],
        output: { publishPackagePath: packagePath, resourceManifestPath: manifestPath, contentReview: documentOptions.contentReview ?? { status: "has_suggestions", summary: "初稿审计：标题可以更具体。", suggestions: ["标题突出“少做一个决定”。"] } },
        outputState: {
          effectiveVersionId: "publish-v1",
          versions: [{
            id: "publish-v1",
            nodeId: "publish-package",
            source: "generated",
            artifactIds: ["artifact-publish-package"],
            inputVersionIds: [],
            createdAt: STARTED_AT,
            createdBy: "codex-publish-copy-v1",
            schemaVersion: "1",
            output: { publishPackagePath: packagePath, resourceManifestPath: manifestPath, contentReview: documentOptions.contentReview ?? { status: "has_suggestions", summary: "初稿审计：标题可以更具体。", suggestions: ["标题突出“少做一个决定”。"] } },
          }],
        },
      },
    ],
    artifacts: [
      {
        id: "artifact-publish-package",
        kind: "publish_package",
        createdAt: STARTED_AT,
        sha256: "a".repeat(64),
        sizeBytes: 128,
        contentType: "application/json",
        uri: packagePath,
        schemaVersion: "video-factory/publish-package-v1",
        producer: { nodeId: "publish-package", attempt: 1 },
        provenance: { providerId: "codex-publish-copy-v1" },
      },
      {
        id: "artifact-script",
        kind: "script",
        createdAt: STARTED_AT,
        sha256: "b".repeat(64),
        sizeBytes: 64,
        contentType: "application/json",
        uri: scriptPath,
        schemaVersion: "video-factory/script-draft-v1",
        producer: { nodeId: "script", attempt: 1 },
        provenance: { providerId: "codex-screenwriter-v1" },
      },
    ],
    decisions: [],
    interventions: [],
  };

  class FakePipeline implements StudioPipelinePort {
    lastOverride?: NodeOverrideDraft;
    lastAudit?: ProductionNodeDocumentAuditDraft;
    overrideResult?: WorkflowRun<ProductionBrief>;

    async list() { return [run]; }
    async remove() {}
    async loadPersisted() { return run; }
    async show() { return run; }
    async dispatch() { throw new Error("not expected in this test"); }
    async decide() { return run; }
    async recordNodeDocumentAudit(_runId: string, draft: ProductionNodeDocumentAuditDraft) {
      this.lastAudit = draft;
      return run;
    }
    async applyNodeOverride(_runId: string, override: NodeOverrideDraft) {
      this.lastOverride = override;
      const updated: WorkflowRun<ProductionBrief> = structuredClone(run);
      updated.revision = run.revision + 1;
      const node = updated.nodeRuns.find((candidate) => candidate.nodeId === override.nodeId)!;
      node.output = override.output;
      if (node.outputState) {
        node.outputState.versions = [...node.outputState.versions, {
          id: "publish-v2",
          nodeId: override.nodeId,
          source: "human",
          artifactIds: [],
          inputVersionIds: [],
          createdAt: STARTED_AT,
          createdBy: override.actor,
          schemaVersion: "1",
          output: override.output,
        }];
        node.outputState.effectiveVersionId = "publish-v2";
      }
      this.overrideResult = updated;
      return updated;
    }
  }

  const pipeline = new FakePipeline();
  const studio = new ProductionStudio({
    workspaceRoot,
    pipeline,
    listProviders: async () => [],
    archiveStore: { list: async () => ({}), archive: async () => {}, restore: async () => {} },
    now: () => new Date(STARTED_AT),
  });
  return { studio, pipeline, run, workspaceRoot, runRoot, packagePath, manifestPath, document };
}

const baseRevisionInput = {
  expectedRunRevision: 7,
  expectedVersionId: "publish-v1",
};

function documentPipeline(workspaceRoot: string, runRoot: string) {
  return new ProductionPipeline({ workspaceRoot, referenceVideoRoot: runRoot,
    referenceGrammarAgent: { id: "codex-reference-grammar-v1", modelId: "controlled",
      analyze: async () => { throw new Error("再审不得重新生成报告"); } },
    screenwriterAgent: { id: "codex-screenwriter-v1", draft: async () => { throw new Error("再审不得重新生成脚本"); } },
    directorAgent: { id: "api-visual-director-v1", plan: async () => { throw new Error("再审不得重新生成方案"); } },
    treatmentAgents: [{ providerId: "controlled", agent: { id: "codex-creative-treatment-v1", modelId: "controlled",
      treat: async () => { throw new Error("再审不得重新生成构思"); } } }],
    worker: { run: async () => { throw new Error("再审不得启动制作"); } } });
}

async function buildReferenceHarness() {
  const harness = await buildHarness(undefined);
  const videoPath = path.join(harness.runRoot, "nodes", "reference-grammar", "reference.mp4");
  const grammarPath = path.join(path.dirname(videoPath), "grammar.json");
  const video = Buffer.from("controlled-reference-video");
  const sha256 = createHash("sha256").update(video).digest("hex");
  const grammar = validateShotGrammar({
    version: "video-factory/shot-grammar-v1", summary: "由特写推进到全景。", durationMs: 10_000,
    pacing: "先慢后快", composition: "中心构图", camera: "无法由静帧确认连续运镜",
    color: "低饱和", transitions: "直接切换", sound: "未观察到声音",
    beats: [{ startMs: 0, endMs: 10_000, narrativeFunction: "揭示主体", shotSize: "全景",
      composition: "中心构图", cameraMovement: "未知", subjectMovement: "未知", lighting: "柔和",
      color: "低饱和", transitionIn: "直接切入", soundRole: "未知" }],
    reusableRules: ["用景别变化揭示主体"], avoidCopying: ["不复制人物身份"], confidence: 0.7,
  }, 10_000);
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, video);
  await writeFile(grammarPath, JSON.stringify(grammar));
  harness.run.initialInput.workflowFeatures!.referenceGrammar = true;
  harness.run.initialInput.referenceVideo = {
    uploadId: "reference-upload", path: videoPath, label: "我的参考片", mimeType: "video/mp4",
    sizeBytes: video.length, sha256,
  };
  const output = { referenceGrammarPath: grammarPath, grammar,
    contentReview: { status: "has_suggestions", summary: "建议细化节奏说明。", suggestions: ["具体说明景别变化。"] } };
  const node = harness.run.nodeRuns[0]!;
  node.nodeId = "reference-grammar";
  node.output = output;
  node.artifactIds = ["reference-report", "reference-video"];
  node.outputState = {
    generatedVersionId: "reference-v1", effectiveVersionId: "reference-v1", stale: false,
    versions: [{ id: "reference-v1", nodeId: "reference-grammar", source: "generated", output,
      artifactIds: [...node.artifactIds], inputVersionIds: [], createdAt: STARTED_AT,
      createdBy: "reference-agent", schemaVersion: "1" }],
  };
  harness.run.artifacts = [
    { id: "reference-report", kind: "shot_grammar", uri: grammarPath, contentType: "application/json",
      createdAt: STARTED_AT, producer: { nodeId: "reference-grammar", attempt: 1 },
      provenance: { providerId: "codex-reference-grammar-v1" },
      sha256: createHash("sha256").update(JSON.stringify(grammar)).digest("hex"),
      sizeBytes: Buffer.byteLength(JSON.stringify(grammar)) },
    { id: "reference-video", kind: "reference_video", uri: videoPath, contentType: "video/mp4",
      createdAt: STARTED_AT, sha256, sizeBytes: video.length,
      provenance: { providerId: "creator-upload" },
      producer: { nodeId: "reference-grammar", attempt: 1 } },
  ];
  return { ...harness, grammar, grammarPath, videoPath };
}

describe("reference-grammar document commands", () => {
  it("refuses a changed reference video before revision or audit can call a model", async () => {
    const harness = await buildReferenceHarness();
    let calls = 0;
    (harness.studio as unknown as { options: { referenceGrammarTools: unknown } }).options.referenceGrammarTools = {
      revise: async () => { calls += 1; return harness.grammar; },
      auditCurrent: async () => { calls += 1; throw new Error("不可调用"); },
    };
    await writeFile(harness.videoPath, "changed-reference");
    const input = { expectedRunRevision: 7, expectedVersionId: "reference-v1", instruction: "改节奏" };
    await assert.rejects(() => harness.studio.reviseNodeDocument(harness.run.id, "reference-grammar", input, "creator"), /内容已经变化/);
    await assert.rejects(() => harness.studio.auditNodeDocumentCurrent(harness.run.id, "reference-grammar", input, "creator"), /内容已经变化/);
    assert.equal(calls, 0);
    assert.equal(harness.pipeline.lastOverride, undefined);
    assert.equal(harness.pipeline.lastAudit, undefined);
    assert.deepEqual(JSON.parse(await readFile(harness.grammarPath, "utf8")), harness.grammar);
  });
  it("revises the seen reference report once into an immutable unaudited draft", async () => {
    const harness = await buildReferenceHarness();
    const calls: Array<{ instruction: string; currentGrammar: unknown; videoPath: string; sourceLabel: string }> = [];
    (harness.studio as unknown as { options: { referenceGrammarTools: unknown } }).options.referenceGrammarTools = {
      revise: async (input: typeof calls[number]) => {
        calls.push(input);
        return { ...harness.grammar, summary: "先展示局部，再揭示整体，给观众一个明确的发现过程。" };
      },
      auditCurrent: async () => { throw new Error("修订不应自动审计"); },
    };
    await harness.studio.reviseNodeDocument("run-publish", "reference-grammar", {
      expectedRunRevision: 7, expectedVersionId: "reference-v1", instruction: "把景别变化说得具体一点。",
    }, "creator-1");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.currentGrammar, harness.grammar);
    assert.equal(calls[0]!.videoPath, harness.videoPath);
    assert.equal(calls[0]!.sourceLabel, "我的参考片");
    const output = harness.pipeline.lastOverride!.output as {
      referenceGrammarPath: string; grammar: { summary: string }; contentReview: { status: string };
    };
    assert.notEqual(output.referenceGrammarPath, harness.grammarPath);
    assert.equal(output.contentReview.status, "not_audited");
    assert.equal(output.grammar.summary, "先展示局部，再揭示整体，给观众一个明确的发现过程。");
    assert.deepEqual(JSON.parse(await readFile(harness.grammarPath, "utf8")), harness.grammar);
  });

  it("re-audits the reference report through the real pipeline without replacing its version or invalidating downstream", async () => {
    const harness = await buildReferenceHarness();
    const store = new FileRunStore(path.join(harness.workspaceRoot, "runs"));
    await store.create(harness.run);
    const pipeline = documentPipeline(harness.workspaceRoot, harness.runRoot);
    let audits = 0;
    const studio = new ProductionStudio({ workspaceRoot: harness.workspaceRoot, pipeline,
      listProviders: async () => [],
      archiveStore: { list: async () => ({}), archive: async () => {}, restore: async () => {} },
      referenceGrammarTools: {
        revise: async () => ({ ...harness.grammar, summary: "用户明确修订后：由特写逐步展开全景。" }),
        auditCurrent: async (input) => {
          audits += 1;
          assert.equal(input.grammar.summary, audits <= 2 ? harness.grammar.summary : "用户明确修订后：由特写逐步展开全景。");
          return { audit: {
            version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
            verdict: "pass", score: 90, summary: `报告复核 ${audits}`, issues: [], repairInstructions: [],
            assessments: [{ targetPath: "", dimensions: ["evidence", "coverage", "consistency", "actionability"].map(
              (dimension) => ({ dimension, score: 90, evidence: "所见关键帧支持本项描述。" }),
            ) }],
          } };
        },
      },
    });
    const before = await pipeline.show(harness.run.id);
    for (let i = 0; i < 2; i += 1) {
      const current = await pipeline.show(harness.run.id);
      await studio.auditNodeDocumentCurrent(harness.run.id, "reference-grammar", {
        expectedRunRevision: current.revision, expectedVersionId: "reference-v1",
      }, "creator-1");
    }
    const after = await pipeline.show(harness.run.id);
    assert.equal(audits, 2);
    assert.equal(after.nodeRuns[0]!.outputState!.effectiveVersionId, "reference-v1");
    assert.equal(after.nodeRuns[0]!.outputState!.versions.length, 1, "再审不是换稿，不增加内容版本");
    assert.deepEqual(after.nodeRuns.slice(1), before.nodeRuns.slice(1), "下游状态和授权不受再审影响");
    assert.deepEqual(after.artifacts, before.artifacts);
    assert.deepEqual(after.decisions, before.decisions);
    assert.equal(after.status, before.status);
    const review = (after.nodeRuns[0]!.output as { contentReview: { history: Array<{ auditId?: string; versionId: string }> } }).contentReview;
    assert.equal(review.history.filter((entry) => entry.auditId).length, 2, "两次真实再审各有独立记录");
    assert.ok(review.history.every((entry) => entry.versionId === "reference-v1"));
    assert.deepEqual(JSON.parse(await readFile(harness.grammarPath, "utf8")), harness.grammar);
    await studio.reviseNodeDocument(harness.run.id, "reference-grammar", {
      expectedRunRevision: after.revision, expectedVersionId: "reference-v1", instruction: "现在把节奏说明改得更具体。",
    }, "creator-1");
    const revised = await pipeline.show(harness.run.id);
    const revisions = revised.nodeRuns[0]!.outputState!;
    assert.equal(audits, 2, "明确修订不触发下一轮审计");
    assert.equal(revisions.versions.length, 2);
    assert.equal((revised.nodeRuns[0]!.output as { contentReview: { status: string } }).contentReview.status, "not_audited");
    assert.deepEqual((revisions.versions[0]!.output as { contentReview: unknown }).contentReview, review);
    await studio.auditNodeDocumentCurrent(harness.run.id, "reference-grammar", {
      expectedRunRevision: revised.revision, expectedVersionId: revisions.effectiveVersionId!,
    }, "creator-1");
    assert.equal(audits, 3, "新稿仍能以同一参考片证据主动审计");
  });
});

describe("publish-package document revision and current-version audit", () => {
  it("persists a publish audit on the original version and refuses late results under the write lease", async () => {
    const harness = await buildHarness(undefined);
    const store = new FileRunStore(path.join(harness.workspaceRoot, "runs"));
    await store.create(harness.run);
    const pipeline = documentPipeline(harness.workspaceRoot, harness.runRoot);
    const audit: ProductionNodeDocumentAuditDraft["audit"] = {
      version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v1",
      verdict: "pass", score: 90, summary: "标题和实际内容一致", issues: [], repairInstructions: [],
      assessments: [{ targetPath: "", dimensions: ["attention", "progression", "payoff", "expression"].map(
        (dimension) => ({ dimension, score: 90, evidence: "标题兑现了内容承诺" }),
      ) }],
    };
    const draft: ProductionNodeDocumentAuditDraft = { nodeId: "publish-package", actor: "creator",
      expectedRunRevision: 7, expectedVersionId: "publish-v1", auditId: "audit-publish-1", audit };
    const after = await pipeline.recordNodeDocumentAudit(harness.run.id, draft);
    assert.equal(after.nodeRuns[1]!.outputState!.effectiveVersionId, "publish-v1");
    assert.equal(after.nodeRuns[1]!.outputState!.versions.length, 1);
    assert.deepEqual(after.nodeRuns[0], harness.run.nodeRuns[0]);
    assert.deepEqual(after.artifacts, harness.run.artifacts);
    assert.equal(after.status, "needs_human");
    const snapshot = await pipeline.show(harness.run.id);
    await assert.rejects(() => pipeline.recordNodeDocumentAudit(harness.run.id, { ...draft, auditId: "late" }), /revision/i);
    await assert.rejects(() => pipeline.recordNodeDocumentAudit(harness.run.id, {
      ...draft, expectedRunRevision: after.revision, expectedVersionId: "old-publish-version",
    }), /version/i);
    assert.deepEqual(await pipeline.show(harness.run.id), snapshot, "拒绝迟到审计不能改写任何持久状态");
  });
  it("reviseNodeDocument produces exactly one unaudited AI revision bound to the seen version", async () => {
    const reviseCalls: Array<{ instruction: string; currentCopy: { title: string }; narrations: string[] }> = [];
    const harness = await buildHarness(undefined);
    const studio = harness.studio;
    (studio as unknown as { options: { documentCopyTools?: unknown } }).options.documentCopyTools = {
      revise: async (input: { instruction: string; currentCopy: { title: string }; narrations: string[] }) => {
        reviseCalls.push(input);
        return { title: "下班后先少做一个决定", description: "三个动作，把下班后的决定变少。", hashtags: ["下班", "决策消耗"] };
      },
    };

    const detail = await (studio as unknown as {
      reviseNodeDocument: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).reviseNodeDocument("run-publish", "publish-package", {
      ...baseRevisionInput,
      instruction: "标题改得更具体，突出“少做一个决定”。",
    }, "creator-1");

    assert.equal(reviseCalls.length, 1, "revision must call the copy tools exactly once");
    assert.equal(reviseCalls[0]!.instruction, "标题改得更具体，突出“少做一个决定”。");
    assert.equal(reviseCalls[0]!.currentCopy.title, "下班后别急着做这 3 件事");
    assert.deepEqual(reviseCalls[0]!.narrations, ["第一场旁白", "第二场旁白", "第三场旁白"]);
    assert.ok(detail);
    assert.equal(harness.pipeline.lastOverride?.nodeId, "publish-package");
    const output = harness.pipeline.lastOverride?.output as { publishPackagePath: string; contentReview: { status: string } };
    const revisedDocument = JSON.parse(await readFile(output.publishPackagePath, "utf8")) as {
      title: string;
      copy: { title: string; source: string };
    };
    assert.notEqual(output.publishPackagePath, harness.packagePath, "the revision must be a new immutable artifact");
    assert.equal(revisedDocument.title, "下班后先少做一个决定");
    assert.equal(revisedDocument.copy.title, "下班后先少做一个决定");
    assert.equal(revisedDocument.copy.source, "codex-publish-copy-v1", "hosted fields stay untouched");
    assert.equal(output.contentReview.status, "not_audited", "AI revision must be unaudited and stop for the user");
  });

  it("reviseNodeDocument refuses stale versions and missing tools without any model call", async () => {
    const harness = await buildHarness(undefined);
    (harness.studio as unknown as { options: { documentCopyTools?: unknown } }).options.documentCopyTools = {
      revise: async () => { throw new Error("must not be called"); },
    };
    await assert.rejects(() => (harness.studio as unknown as {
      reviseNodeDocument: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).reviseNodeDocument("run-publish", "publish-package", {
      ...baseRevisionInput,
      expectedVersionId: "publish-v0",
      instruction: "改标题",
    }, "creator-1"), StudioConflictError);

    const noTools = await buildHarness(undefined);
    await assert.rejects(() => (noTools.studio as unknown as {
      reviseNodeDocument: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).reviseNodeDocument("run-publish", "publish-package", {
      ...baseRevisionInput,
      instruction: "改标题",
    }, "creator-1"), /没有可用的发布文案修订模型/);

    await assert.rejects(() => (harness.studio as unknown as {
      reviseNodeDocument: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).reviseNodeDocument("run-publish", "publish-package", {
      ...baseRevisionInput,
      instruction: "   ",
    }, "creator-1"), StudioInputError);
    assert.equal(harness.pipeline.lastOverride, undefined);
    assert.equal(noTools.pipeline.lastOverride, undefined);
  });

  it("auditNodeDocumentCurrent records the fresh audit verdict and identity without changing the copy", async () => {
    const auditCalls: Array<{ copy: { title: string } }> = [];
    const harness = await buildHarness(undefined);
    (harness.studio as unknown as { options: { documentCopyTools?: unknown } }).options.documentCopyTools = {
      auditCurrent: async (input: { copy: { title: string } }) => {
        auditCalls.push(input);
        return { audit: {
          version: "video-factory/role-audit-v2",
          rubricVersion: "video-factory/role-quality-rubric-v1",
          assessments: [{ targetPath: "", dimensions: [
            { dimension: "attention", score: 62, evidence: "标题可以更具体。" },
            { dimension: "payoff", score: 62, evidence: "收益清楚。" },
            { dimension: "expression", score: 62, evidence: "表达自然。" },
          ] }],
          verdict: "repair",
          score: 62,
          summary: "标题仍未落到具体动作。",
          issues: [{
            severity: "blocking",
            criterion: "不制造额外承诺",
            evidence: "标题未点出“少做一个决定”。",
            repairInstruction: "把标题改成脚本已兑现的具体变化。",
            creatorTitle: "标题缺具体动作",
            creatorAction: "标题写出“少做一个决定”这个动作。",
          }],
          repairInstructions: ["把标题改成脚本已兑现的具体变化。"],
        } };
      },
    };

    await (harness.studio as unknown as {
      auditNodeDocumentCurrent: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).auditNodeDocumentCurrent("run-publish", "publish-package", baseRevisionInput, "creator-1");

    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0]!.copy.title, "下班后别急着做这 3 件事");
    assert.equal(harness.pipeline.lastOverride, undefined, "auditing must not use the content replacement path");
    const onDisk = JSON.parse(await readFile(harness.packagePath, "utf8")) as { copy: { title: string } };
    assert.equal(onDisk.copy.title, "下班后别急着做这 3 件事", "auditing must not change the copy");
    assert.equal(harness.pipeline.lastAudit?.audit.verdict, "repair");
    assert.equal(harness.pipeline.lastAudit?.expectedVersionId, "publish-v1");
    assert.equal(harness.pipeline.lastAudit?.expectedRunRevision, 7);
    assert.ok(harness.pipeline.lastAudit?.auditId, "the audit identity must be recorded");
  });

  it("auditNodeDocumentCurrent refuses stale versions and unknown nodes", async () => {
    const harness = await buildHarness(undefined);
    (harness.studio as unknown as { options: { documentCopyTools?: unknown } }).options.documentCopyTools = {
      auditCurrent: async () => { throw new Error("must not be called"); },
    };
    await assert.rejects(() => (harness.studio as unknown as {
      auditNodeDocumentCurrent: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).auditNodeDocumentCurrent("run-publish", "publish-package", {
      ...baseRevisionInput,
      expectedRunRevision: 6,
    }, "creator-1"), StudioConflictError);
    await assert.rejects(() => (harness.studio as unknown as {
      auditNodeDocumentCurrent: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    }).auditNodeDocumentCurrent("run-publish", "script", baseRevisionInput, "creator-1"), StudioInputError);
    assert.equal(harness.pipeline.lastOverride, undefined);
  });

  it("plain output overrides can no longer rewrite the hosted audit status", async () => {
    const harness = await buildHarness(undefined);
    await assert.rejects(() => harness.studio.applyNodeOverride("run-publish", "publish-package", {
      output: {
        publishPackagePath: harness.packagePath,
        resourceManifestPath: harness.manifestPath,
        contentReview: { status: "passed", summary: "手工宣布通过。", suggestions: [] },
      },
      expectedVersionId: "publish-v1",
    } as never, "creator-1"), /审计状态/);
  });

  it("keeps returning not-found for unknown runs", async () => {
    const harness = await buildHarness(undefined);
    (harness.studio as unknown as { options: { documentCopyTools?: unknown } }).options.documentCopyTools = {
      revise: async () => ({ title: "标题", description: "描述", hashtags: ["标签"] }),
    };
    const studio = harness.studio as unknown as {
      reviseNodeDocument: (runId: string, nodeId: string, input: Record<string, unknown>, actor: string) => Promise<unknown>;
    };
    const originalShow = harness.pipeline.show.bind(harness.pipeline);
    harness.pipeline.show = async (runId: string) => {
      if (runId === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return originalShow(runId);
    };
    await assert.rejects(() => studio.reviseNodeDocument("missing", "publish-package", {
      ...baseRevisionInput,
      instruction: "改标题",
    }, "creator-1"), StudioNotFoundError);
  });
});
