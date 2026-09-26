import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { NodeOverrideDraft, WorkflowRun } from "@video-factory/workflow-core";
import { productionWorkflowVersion, type ProductionBrief } from "@video-factory/production-pipeline";
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
  };

  class FakePipeline implements StudioPipelinePort {
    lastOverride?: NodeOverrideDraft;
    overrideResult?: WorkflowRun<ProductionBrief>;

    async list() { return [run]; }
    async remove() {}
    async loadPersisted() { return run; }
    async show() { return run; }
    async dispatch() { throw new Error("not expected in this test"); }
    async decide() { return run; }
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
  return { studio, pipeline, run, runRoot, packagePath, manifestPath, document };
}

const baseRevisionInput = {
  expectedRunRevision: 7,
  expectedVersionId: "publish-v1",
};

describe("publish-package document revision and current-version audit", () => {
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
    const output = harness.pipeline.lastOverride?.output as { publishPackagePath: string; contentReview: { status: string; summary: string; suggestions: string[]; auditId?: string } };
    assert.equal(output.publishPackagePath, harness.packagePath, "auditing must not create a new artifact version");
    const onDisk = JSON.parse(await readFile(harness.packagePath, "utf8")) as { copy: { title: string } };
    assert.equal(onDisk.copy.title, "下班后别急着做这 3 件事", "auditing must not change the copy");
    assert.equal(output.contentReview.status, "has_suggestions");
    assert.deepEqual(output.contentReview.suggestions, ["标题写出“少做一个决定”这个动作。"]);
    assert.ok(output.contentReview.auditId, "the audit identity must be recorded");
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
