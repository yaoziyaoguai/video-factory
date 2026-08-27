import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderRegistry,
  WorkflowRunner,
  scoreTopicCandidate,
  topicCandidateArtifact,
  type NodeDefinition,
  type Provider,
  type WorkflowDefinition,
} from "../src/index.js";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}-${next++}`;
}

const clock = (): string => "2026-08-21T10:00:00.000Z";

describe("WorkflowRunner", () => {
  it("runs nodes in dependency order and tracks topic artifacts", async () => {
    const topicNode: NodeDefinition = {
      id: "topic-intelligence",
      label: "Topic Intelligence",
      role: "选题总编",
      capability: "topic.intelligence",
      mode: "automatic",
      execute: () => {
        const candidate = scoreTopicCandidate("topic-1", {
          platform: "douyin",
          track: "ordinary-decision-checklist",
          audience: "刚开始做生活决策训练的普通人",
          painPoint: "选择太多，不知道先看什么",
          hook: "买任何贵东西前，先问自己这 3 个问题",
          evidence: [
            {
              source: "manual-research",
              platform: "douyin",
              keyword: "消费避坑",
              strength: 80,
            },
          ],
          audienceReach: 82,
          visualFeasibility: 76,
          productionCostEfficiency: 90,
          novelty: 68,
          monetization: 66,
          seriesPotential: 88,
          complianceRisk: 12,
        });

        return {
          output: candidate,
          artifacts: [topicCandidateArtifact(candidate)],
        };
      },
    };
    const scriptNode: NodeDefinition = {
      id: "script",
      label: "Script Draft",
      capability: "script.draft",
      mode: "automatic",
      dependsOn: ["topic-intelligence"],
      getInput: (context) => context.outputs.get("topic-intelligence"),
      execute: (candidate) => ({
        output: {
          title: "消费前先问 3 个问题",
          topicId: (candidate as { id: string }).id,
        },
      }),
    };
    const workflow: WorkflowDefinition = {
      id: "daily-short-video",
      name: "Daily Short Video",
      version: "0.1.0",
      nodes: [scriptNode, topicNode],
    };

    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, { seedTrack: "ordinary-decision-checklist" });

    assert.equal(run.status, "succeeded");
    assert.deepEqual(
      run.nodeRuns.map((nodeRun) => nodeRun.nodeId),
      ["topic-intelligence", "script"],
    );
    assert.equal(run.artifacts.length, 1);
    assert.equal(run.artifacts[0]?.kind, "topic_candidate");
    assert.equal(run.nodeRuns[0]?.role, "选题总编");
    assert.deepEqual(run.nodeRuns[1]?.output, {
      title: "消费前先问 3 个问题",
      topicId: "topic-1",
    });
  });

  it("preserves immutable artifact integrity and lineage metadata", async () => {
    const definition: WorkflowDefinition = {
      id: "artifact-lineage",
      name: "Artifact lineage",
      version: "1.0.0",
      nodes: [
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          execute: () => ({
            status: "succeeded",
            artifacts: [
              {
                kind: "script",
                uri: "/tmp/script.json",
                sha256: "a".repeat(64),
                sizeBytes: 512,
                contentType: "application/json",
                schemaVersion: "video-factory/script-v1",
                parentArtifactIds: ["brief-1"],
                producer: { nodeId: "script", attempt: 1 },
                provenance: {
                  providerId: "python-template-v1",
                  providerVersion: "1.0.0",
                  licenseNote: "Generated script.",
                },
              },
            ] as never,
          }),
        },
      ],
    };

    const run = await new WorkflowRunner().run(definition, {});
    const artifact = run.artifacts[0] as (typeof run.artifacts)[number] & {
      sha256?: string;
      sizeBytes?: number;
      contentType?: string;
      schemaVersion?: string;
      parentArtifactIds?: string[];
      producer?: { nodeId: string; attempt: number };
    };

    assert.equal(artifact.sha256, "a".repeat(64));
    assert.equal(artifact.sizeBytes, 512);
    assert.equal(artifact.contentType, "application/json");
    assert.equal(artifact.schemaVersion, "video-factory/script-v1");
    assert.deepEqual(artifact.parentArtifactIds, ["brief-1"]);
    assert.deepEqual(artifact.producer, { nodeId: "script", attempt: 1 });
  });

  it("stops the workflow when a quality gate rejects output", async () => {
    const workflow: WorkflowDefinition = {
      id: "quality-gated-video",
      name: "Quality Gated Video",
      version: "0.1.0",
      nodes: [
        {
          id: "asset-plan",
          label: "Asset Plan",
          capability: "asset.search",
          mode: "automatic",
          execute: () => ({
            output: {
              semanticMatch: 22,
              source: "random-stock",
            },
          }),
          qualityGates: [
            {
              id: "semantic-match",
              description: "素材必须和脚本语义相关。",
              evaluate: (_context, output) => {
                const score = (output as { semanticMatch: number }).semanticMatch;
                return {
                  gateId: "semantic-match",
                  status: score >= 70 ? "passed" : "failed",
                  score,
                  threshold: 70,
                  reasons: ["素材和脚本语义关系太弱。"],
                };
              },
            },
          ],
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          dependsOn: ["asset-plan"],
          execute: () => ({ output: { uri: "workspace/renders/final.mp4" } }),
        },
      ],
    };

    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, {});

    assert.equal(run.status, "rejected");
    assert.equal(run.nodeRuns.length, 1);
    assert.equal(run.nodeRuns[0]?.status, "rejected");
    assert.equal(run.nodeRuns[0]?.qualityGateResults[0]?.gateId, "semantic-match");
  });

  it("treats human intervention as a first-class terminal state", async () => {
    const workflow: WorkflowDefinition = {
      id: "manual-review",
      name: "Manual Review",
      version: "0.1.0",
      nodes: [
        {
          id: "editorial-review",
          label: "Editorial Review",
          capability: "quality.review",
          mode: "manual",
          execute: () => ({
            status: "needs_human",
            intervention: {
              reason: "脚本方向接近敏感社会议题，需要人工确认。",
              requiredAction: "approve",
              options: ["approve", "reject"],
            },
          }),
        },
      ],
    };

    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, {});

    assert.equal(run.status, "needs_human");
    assert.equal(run.interventions.length, 1);
    assert.equal(run.interventions[0]?.nodeId, "editorial-review");
    assert.equal(run.interventions[0]?.requiredAction, "approve");
  });

  it("resolves and replaces providers by capability", async () => {
    const registry = new ProviderRegistry();
    const weakProvider: Provider<{ prompt: string }, { score: number }> = {
      id: "mock-assets",
      capability: "asset.search",
      run: () => ({ score: 30 }),
    };
    const strongProvider: Provider<{ prompt: string }, { score: number }> = {
      id: "mock-assets",
      capability: "asset.search",
      run: () => ({ score: 85 }),
    };
    registry.register(weakProvider);
    registry.replace(strongProvider);

    const workflow: WorkflowDefinition = {
      id: "provider-backed-assets",
      name: "Provider Backed Assets",
      version: "0.1.0",
      nodes: [
        {
          id: "asset-search",
          label: "Asset Search",
          capability: "asset.search",
          mode: "automatic",
          providerId: "mock-assets",
          getInput: () => ({ prompt: "真实生活 B-roll" }),
        },
      ],
    };

    const runner = new WorkflowRunner({ providers: registry, clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, {});

    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.nodeRuns[0]?.output, { score: 85 });
  });

  it("records a safe execution receipt and immutable generated output version", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "review-model",
      label: "Review Model",
      modelId: "review-v2",
      capability: "quality.review",
      transport: "http_api",
      billing: "subscription",
      run: () => ({ approved: true }),
    });
    const definition: WorkflowDefinition = {
      id: "receipt-and-version",
      name: "Receipt and version",
      version: "1.0.0",
      nodes: [
        {
          id: "review",
          label: "Review",
          role: "总导演",
          capability: "quality.review",
          mode: "automatic",
          providerId: "review-model",
        },
      ],
    };

    const run = await new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry }).run(
      definition,
      {},
    );
    const nodeRun = run.nodeRuns[0];

    assert.ok(nodeRun);
    assert.deepEqual(nodeRun.executionReceipt, {
      nodeId: "review",
      role: "总导演",
      capability: "quality.review",
      providerId: "review-model",
      providerLabel: "Review Model",
      modelId: "review-v2",
      transport: "http_api",
      billing: "subscription",
      status: "succeeded",
      startedAt: clock(),
      finishedAt: clock(),
    });
    assert.equal("credentials" in nodeRun.executionReceipt, false);
    const inputVersionId = nodeRun.inputState?.effectiveVersionId;
    const outputVersionId = nodeRun.outputState?.effectiveVersionId;
    assert.ok(inputVersionId);
    assert.ok(outputVersionId);
    assert.deepEqual(nodeRun.outputState, {
      nodeId: "review",
      generatedVersionId: outputVersionId,
      effectiveVersionId: outputVersionId,
      stale: false,
      versions: [
        {
          id: outputVersionId,
          nodeId: "review",
          source: "generated",
          artifactIds: [],
          output: { approved: true },
          inputVersionIds: [inputVersionId],
          createdAt: clock(),
          createdBy: "review-model",
          schemaVersion: "1",
        },
      ],
    });
  });

  it("keeps failed execution receipts and validates reported actual cost", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-review",
      label: "Paid review",
      modelId: "review-v1",
      capability: "quality.review",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => {
        throw new Error("provider unavailable");
      },
    });
    const definition: WorkflowDefinition = {
      id: "failed-receipt",
      name: "Failed receipt",
      version: "1.0.0",
      nodes: [{
        id: "review",
        label: "Review",
        capability: "quality.review",
        providerId: "paid-review",
        mode: "automatic",
      }],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;
    assert.ok(plan);

    const failed = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.nodeRuns[0]?.executionReceipt?.status, "failed");
    assert.equal(failed.executionReceipts?.at(-1)?.status, "failed");
    assert.match(failed.nodeRuns[0]?.error ?? "", /provider unavailable/);
  });

  it("records actual cost and fails the node when reported spending exceeds authorization", async () => {
    async function execute(actualCostCny: number) {
      let calls = 0;
      const registry = new ProviderRegistry();
      registry.register({
        id: "paid-assets",
        label: "Paid assets",
        modelId: "assets-v1",
        capability: "asset.prepare",
        transport: "http_api",
        billing: "metered",
        estimatedCostCny: 0.5,
        maxCostCny: 1,
        maxAttempts: 1,
        run: () => {
          calls += 1;
          return { assetIds: ["asset-1"] };
        },
      });
      const definition: WorkflowDefinition = {
        id: "actual-cost",
        name: "Actual cost",
        version: "1.0.0",
        nodes: [{
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          providerId: "paid-assets",
          mode: "automatic",
          execute: async (input, context) => ({
            output: await context.resolveProvider({ capability: "asset.prepare", providerId: "paid-assets" }).run(input, context),
            receipt: {
              providerId: "paid-assets",
              providerLabel: "Paid assets",
              modelId: "assets-v1",
              transport: "http_api",
              billing: "metered",
              estimatedCostCny: 0.5,
              actualCostCny,
            },
          }),
        }],
      };
      const runner = new WorkflowRunner({ providers: registry });
      const paused = await runner.run(definition, {});
      const plan = paused.nodeRuns[0]?.spendPlan;
      assert.ok(plan);
      const run = await runner.authorizeSpend(definition, paused, {
        nodeId: plan.nodeId,
        inputVersionIds: plan.inputVersionIds,
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: plan.maxCostCny,
        maxAttempts: plan.maxAttempts,
        approvedBy: "producer",
      });
      return { calls, run };
    }

    const withinLimit = await execute(0.75);
    assert.equal(withinLimit.run.status, "succeeded");
    assert.equal(withinLimit.run.nodeRuns[0]?.executionReceipt?.actualCostCny, 0.75);
    assert.equal(withinLimit.run.nodeRuns[0]?.executionReceipt?.status, "succeeded");
    assert.equal(withinLimit.run.nodeRuns[0]?.executionReceipt?.authorizedCostCny, 1);
    assert.equal(
      withinLimit.run.nodeRuns[0]?.executionReceipt?.spendAuthorizationId,
      withinLimit.run.nodeRuns[0]?.spendAuthorizationId,
    );

    const overLimit = await execute(1.01);
    assert.equal(overLimit.calls, 1);
    assert.equal(overLimit.run.status, "failed");
    assert.equal(overLimit.run.nodeRuns[0]?.executionReceipt?.actualCostCny, 1.01);
    assert.equal(overLimit.run.nodeRuns[0]?.executionReceipt?.status, "failed");
    assert.match(overLimit.run.nodeRuns[0]?.error ?? "", /exceeded the authorized maximum/);

    const invalidCost = await execute(Number.POSITIVE_INFINITY);
    assert.equal(invalidCost.run.status, "failed");
    assert.equal(invalidCost.run.nodeRuns[0]?.executionReceipt?.actualCostCny, undefined);
    assert.match(invalidCost.run.nodeRuns[0]?.error ?? "", /actualCostCny must be a finite non-negative number/);
  });

  it("rejects non-finite metered limits before invoking the provider", async () => {
    const invalidScopes = [
      { maxCostCny: undefined },
      { maxCostCny: null },
      { maxCostCny: Number.NaN },
      { maxCostCny: Number.POSITIVE_INFINITY },
      { maxCostCny: 0 },
      { maxAttempts: undefined },
      { maxAttempts: null },
      { maxAttempts: Number.NaN },
      { maxAttempts: Number.POSITIVE_INFINITY },
      { maxAttempts: 0 },
      { maxAttempts: 1.5 },
    ];
    for (const invalid of invalidScopes) {
      let calls = 0;
      const registry = new ProviderRegistry();
      registry.register({
        id: "invalid-paid",
        modelId: "paid-v1",
        capability: "asset.prepare",
        billing: "metered",
        estimatedCostCny: 0.5,
        maxCostCny: 1,
        maxAttempts: 1,
        run: () => {
          calls += 1;
          return {};
        },
        ...invalid,
      } as Provider);
      const definition: WorkflowDefinition = {
        id: "invalid-metered",
        name: "Invalid metered",
        version: "1.0.0",
        nodes: [{ id: "assets", label: "Assets", capability: "asset.prepare", providerId: "invalid-paid", mode: "automatic" }],
      };

      const failed = await new WorkflowRunner({ providers: registry }).run(definition, {});

      assert.equal(failed.status, "failed");
      assert.equal(failed.nodeRuns[0]?.executionReceipt?.status, "failed");
      assert.equal(calls, 0);
    }
  });

  it("blocks a custom executor from switching to another metered provider", async () => {
    let alternateCalls = 0;
    const registry = new ProviderRegistry();
    for (const id of ["approved-paid", "alternate-paid"]) {
      registry.register({
        id,
        modelId: `${id}-v1`,
        capability: "asset.prepare",
        billing: "metered",
        estimatedCostCny: 0.5,
        maxCostCny: 1,
        maxAttempts: 1,
        run: () => {
          if (id === "alternate-paid") alternateCalls += 1;
          return {};
        },
      });
    }
    const definition: WorkflowDefinition = {
      id: "provider-switch",
      name: "Provider switch",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "approved-paid",
        mode: "automatic",
        execute: async (input, context) => ({
          output: await context.resolveProvider({ capability: "asset.prepare", providerId: "alternate-paid" }).run(input, context),
        }),
      }],
    };
    const runner = new WorkflowRunner({ providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;
    assert.ok(plan);

    const failed = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns[0]?.error ?? "", /outside the active spend authorization/);
    assert.equal(alternateCalls, 0);
  });

  it("rejects a receipt that does not match the authorized provider and model", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-assets",
      label: "Paid assets",
      modelId: "assets-v1",
      capability: "asset.prepare",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => ({}),
    });
    const definition: WorkflowDefinition = {
      id: "receipt-scope",
      name: "Receipt scope",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "paid-assets",
        mode: "automatic",
        execute: async (input, context) => ({
          output: await context.resolveProvider({ capability: "asset.prepare", providerId: "paid-assets" }).run(input, context),
          receipt: {
            providerId: "another-provider",
            providerLabel: "Another provider",
            modelId: "another-model",
            transport: "http_api",
            billing: "metered",
            actualCostCny: 0.5,
          },
        }),
      }],
    };
    const runner = new WorkflowRunner({ providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;
    assert.ok(plan);

    const failed = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns[0]?.error ?? "", /does not match the active authorization/);
    assert.equal(failed.nodeRuns[0]?.executionReceipt?.status, "failed");
  });

  it("validates human overrides before creating a new output version", async () => {
    const definition: WorkflowDefinition = {
      id: "validated-override",
      name: "Validated override",
      version: "1.0.0",
      nodes: [{
        id: "script",
        label: "Script",
        capability: "script.draft",
        mode: "automatic",
        execute: () => ({ output: { text: "generated" } }),
        validateOverride: (output) => {
          if (typeof output !== "object" || output === null || typeof (output as { text?: unknown }).text !== "string") {
            throw new Error("script override is invalid");
          }
          return { text: (output as { text: string }).text.trim() };
        },
      }],
    };
    const runner = new WorkflowRunner();
    const generated = await runner.run(definition, {});

    assert.throws(
      () => runner.applyNodeOverride(definition, generated, { nodeId: "script", actor: "editor", output: { text: "edited" } }),
      /requires explicit confirmation/,
    );
    assert.throws(
      () => runner.applyNodeOverride(definition, generated, { nodeId: "script", actor: "editor", output: { nope: true }, allowTerminalEdit: true }),
      /script override is invalid/,
    );
    const overridden = runner.applyNodeOverride(definition, generated, {
      nodeId: "script",
      actor: "editor",
      output: { text: "  edited  " },
      allowTerminalEdit: true,
    });
    assert.deepEqual(overridden.nodeRuns[0]?.output, { text: "edited" });
    assert.equal(overridden.status, "succeeded");

    const rejected = structuredClone(generated);
    rejected.status = "rejected";
    rejected.nodeRuns[0]!.status = "rejected";
    rejected.finishedAt = clock();
    assert.throws(
      () => runner.applyNodeOverride(definition, rejected, { nodeId: "script", actor: "editor", output: { text: "edited" } }),
      /requires explicit confirmation/,
    );
    const revisedRejected = runner.applyNodeOverride(definition, rejected, {
      nodeId: "script",
      actor: "editor",
      output: { text: "edited after review" },
      allowTerminalEdit: true,
    });
    assert.deepEqual(revisedRejected.nodeRuns[0]?.output, { text: "edited after review" });
    assert.equal(revisedRejected.status, "succeeded");
  });

  it("creates a human output version and marks only DAG descendants stale", async () => {
    const definition: WorkflowDefinition = {
      id: "editable-dag",
      name: "Editable DAG",
      version: "1.0.0",
      nodes: [
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          execute: () => ({
            output: { text: "generated" },
            artifacts: [
              { kind: "script", data: { text: "generated" } },
              { kind: "model_trace", data: { prompt: "immutable" } },
            ],
          }),
        },
        {
          id: "unrelated",
          label: "Unrelated",
          capability: "metrics.ingest",
          mode: "automatic",
          execute: () => ({ output: { preserved: true } }),
        },
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          dependsOn: ["script"],
          execute: () => ({ output: { assets: 1 } }),
        },
        {
          id: "voice",
          label: "Voice",
          capability: "voice.synthesize",
          mode: "automatic",
          dependsOn: ["script"],
          execute: () => ({ output: { voice: 1 } }),
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          dependsOn: ["assets", "voice"],
          execute: () => ({ output: { uri: "generated.mp4" } }),
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const generated = await runner.run(definition, {});
    const generatedScriptState = generated.nodeRuns.find((node) => node.nodeId === "script")?.outputState;

    const overridden = runner.applyNodeOverride(definition, generated, {
      nodeId: "script",
      actor: "editor",
      output: { text: "human edit" },
      artifacts: [{ kind: "script", data: { text: "human edit" } }],
      allowTerminalEdit: true,
      schemaVersion: "script-v2",
    });
    const scriptRun = overridden.nodeRuns.find((node) => node.nodeId === "script");

    assert.equal(generated.status, "succeeded");
    assert.equal(generatedScriptState?.versions.length, 1);
    assert.equal(overridden.status, "stale");
    assert.equal(overridden.revision, 1);
    assert.equal(scriptRun?.outputState?.generatedVersionId, generatedScriptState?.generatedVersionId);
    assert.equal(scriptRun?.outputState?.versions.length, 2);
    assert.deepEqual(scriptRun?.outputState?.versions[1], {
      id: scriptRun.outputState.effectiveVersionId,
      nodeId: "script",
      source: "human",
      artifactIds: scriptRun.artifactIds,
      output: { text: "human edit" },
      inputVersionIds: [scriptRun?.inputState?.effectiveVersionId],
      parentVersionId: generatedScriptState?.effectiveVersionId,
      createdAt: clock(),
      createdBy: "editor",
      schemaVersion: "script-v2",
    });
    assert.deepEqual(
      overridden.nodeRuns.filter((node) => node.status === "stale").map((node) => node.nodeId),
      ["assets", "voice", "render"],
    );
    assert.equal(overridden.nodeRuns.find((node) => node.nodeId === "unrelated")?.status, "succeeded");
    assert.equal(overridden.nodeRuns.find((node) => node.nodeId === "assets")?.outputState?.stale, true);
    assert.deepEqual(
      scriptRun?.artifactIds.map((artifactId) => overridden.artifacts.find((artifact) => artifact.id === artifactId)?.kind),
      ["model_trace", "script"],
    );

    const regenerated = await runner.resumeStale(definition, overridden);
    const regeneratedAssets = regenerated.nodeRuns.find((node) => node.nodeId === "assets");
    assert.equal(regenerated.status, "succeeded");
    assert.equal(regenerated.revision, 2);
    assert.equal(regenerated.nodeRuns.some((node) => node.status === "stale"), false);
    assert.equal(regeneratedAssets?.outputState?.versions.length, 2);
    assert.deepEqual(regeneratedAssets?.outputState?.versions.at(-1)?.inputVersionIds, [
      regeneratedAssets?.inputState?.effectiveVersionId,
      scriptRun?.outputState?.effectiveVersionId,
    ]);
    assert.equal(regenerated.nodeRuns.find((node) => node.nodeId === "unrelated")?.outputState?.versions.length, 1);
    assert.equal(regenerated.executionReceipts?.length, 8);
  });

  it("persists node inputs as versions and reruns from the effective human input", async () => {
    const receivedInputs: unknown[] = [];
    const definition: WorkflowDefinition = {
      id: "editable-input",
      name: "Editable input",
      version: "1.0.0",
      nodes: [
        {
          id: "source",
          label: "Source",
          capability: "topic.intelligence",
          mode: "automatic",
          execute: () => ({ output: { title: "自动题目" } }),
        },
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          dependsOn: ["source"],
          getInput: (context) => context.outputs.get("source"),
          validateInputOverride: (input) => {
            if (typeof input !== "object" || input === null || typeof (input as { title?: unknown }).title !== "string") {
              throw new Error("script input is invalid");
            }
            return { title: (input as { title: string }).title.trim() };
          },
          execute: (input) => {
            receivedInputs.push(input);
            return { output: { text: `脚本：${(input as { title: string }).title}` } };
          },
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const generated = await runner.run(definition, {});
    const generatedScript = generated.nodeRuns.find((node) => node.nodeId === "script");

    assert.deepEqual(generatedScript?.inputState?.versions[0]?.value, { title: "自动题目" });
    assert.equal(generatedScript?.inputState?.versions[0]?.source, "derived");
    assert.throws(
      () => runner.applyNodeInputOverride(definition, generated, { nodeId: "script", actor: "editor", input: { nope: true }, allowTerminalEdit: true }),
      /script input is invalid/,
    );
    assert.throws(
      () => runner.applyNodeInputOverride(definition, generated, {
        nodeId: "script",
        actor: "editor",
        input: { title: "人工题目" },
        expectedVersionId: "stale-input-version",
        allowTerminalEdit: true,
      }),
      /effective version changed/,
    );

    const edited = runner.applyNodeInputOverride(definition, generated, {
      nodeId: "script",
      actor: "editor",
      input: { title: "  人工题目  " },
      expectedVersionId: generatedScript?.inputState?.effectiveVersionId,
      allowTerminalEdit: true,
      schemaVersion: "script-input-v2",
    });
    const editedScript = edited.nodeRuns.find((node) => node.nodeId === "script");
    assert.equal(edited.status, "stale");
    assert.equal(editedScript?.status, "stale");
    assert.equal(editedScript?.inputState?.versions.at(-1)?.source, "human");
    assert.deepEqual(editedScript?.inputState?.versions.at(-1)?.value, { title: "人工题目" });
    assert.equal(editedScript?.inputState?.versions.at(-1)?.schemaVersion, "script-input-v2");

    const regenerated = await runner.resumeStale(definition, edited);
    assert.deepEqual(receivedInputs, [{ title: "自动题目" }, { title: "人工题目" }]);
    assert.deepEqual(regenerated.nodeRuns.find((node) => node.nodeId === "script")?.output, { text: "脚本：人工题目" });
  });

  it("bounds manual input versions and keeps file references immutable", async () => {
    const definition: WorkflowDefinition = {
      id: "bounded-input",
      name: "Bounded input",
      version: "1.0.0",
      nodes: [{
        id: "render",
        label: "Render",
        capability: "video.render",
        mode: "automatic",
        getInput: () => ({ scriptPath: "/runs/run-1/script.json", note: "原始" }),
        execute: (input) => ({ output: input }),
      }],
    };
    const runner = new WorkflowRunner();
    const generated = await runner.run(definition, {});

    assert.throws(
      () => runner.applyNodeInputOverride(definition, generated, {
        nodeId: "render",
        actor: "editor",
        input: { scriptPath: "/runs/run-1/other.json", note: "人工" },
        allowTerminalEdit: true,
      }),
      /cannot be changed/,
    );
    assert.throws(
      () => runner.applyNodeInputOverride(definition, generated, {
        nodeId: "render",
        actor: "editor",
        input: { scriptPath: "/runs/run-1/script.json", note: "x".repeat(1_000_001) },
        allowTerminalEdit: true,
      }),
      /1 MB manual version limit/,
    );
  });

  it("requires stale human inputs to be reviewed again after an upstream output changes", async () => {
    const definition: WorkflowDefinition = {
      id: "stale-human-input",
      name: "Stale human input",
      version: "1.0.0",
      nodes: [
        {
          id: "source",
          label: "Source",
          capability: "topic.intelligence",
          mode: "automatic",
          execute: () => ({ output: { title: "版本一" } }),
        },
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          dependsOn: ["source"],
          getInput: (context) => context.outputs.get("source"),
          execute: (input) => ({ output: input }),
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const generated = await runner.run(definition, {});
    const withHumanInput = runner.applyNodeInputOverride(definition, generated, {
      nodeId: "script",
      actor: "editor",
      input: { title: "人工保留" },
      allowTerminalEdit: true,
    });
    const regenerated = await runner.resumeStale(definition, withHumanInput);
    const sourceChanged = runner.applyNodeOverride(definition, regenerated, {
      nodeId: "source",
      actor: "editor",
      output: { title: "版本二" },
      allowTerminalEdit: true,
    });

    assert.equal(sourceChanged.nodeRuns.find((node) => node.nodeId === "script")?.inputState?.stale, true);
    await assert.rejects(
      () => runner.resumeStale(definition, sourceChanged),
      /human input.*reviewed/i,
    );

    const reconfirmed = runner.applyNodeInputOverride(definition, sourceChanged, {
      nodeId: "script",
      actor: "editor",
      input: { title: "人工保留" },
    });
    const completed = await runner.resumeStale(definition, reconfirmed);
    assert.deepEqual(completed.nodeRuns.find((node) => node.nodeId === "script")?.output, { title: "人工保留" });
  });

  it("pauses a metered node until its exact spend plan is authorized", async () => {
    let paidCalls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-render",
      label: "Paid Render",
      modelId: "render-v3",
      capability: "video.render",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 1.2,
      maxCostCny: 2,
      maxAttempts: 1,
      run: () => {
        paidCalls += 1;
        return { uri: "paid.mp4" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "metered-render",
      name: "Metered render",
      version: "1.0.0",
      nodes: [
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          execute: () => ({ output: { text: "ready" } }),
        },
        {
          id: "voice",
          label: "Voice",
          capability: "voice.synthesize",
          mode: "automatic",
          execute: () => ({ output: { uri: "voice.wav" } }),
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          providerId: "paid-render",
          dependsOn: ["script", "voice"],
          getInput: (context) => ({
            script: context.outputs.get("script"),
            voice: context.outputs.get("voice"),
          }),
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });

    const paused = await runner.run(definition, {});
    const renderRun = paused.nodeRuns.find((node) => node.nodeId === "render");
    const plan = renderRun?.spendPlan;

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.equal(renderRun?.status, "awaiting_spend_approval");
    assert.equal(paidCalls, 0);
    assert.deepEqual(plan, {
      id: plan?.id,
      nodeId: "render",
      inputVersionIds: [
        renderRun?.inputState?.effectiveVersionId,
        paused.nodeRuns.find((node) => node.nodeId === "script")?.outputState?.effectiveVersionId,
        paused.nodeRuns.find((node) => node.nodeId === "voice")?.outputState?.effectiveVersionId,
      ],
      providerId: "paid-render",
      modelId: "render-v3",
      estimatedCostCny: 1.2,
      maxCostCny: 2,
      maxAttempts: 1,
      createdAt: clock(),
    });
    assert.deepEqual(paused.spendAuthorizations, []);
    assert.equal(JSON.stringify(paused).includes("credential"), false);

    assert.ok(plan);
    await assert.rejects(
      () => runner.authorizeSpend(definition, paused, {
        nodeId: plan.nodeId,
        inputVersionIds: plan.inputVersionIds,
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: Number.POSITIVE_INFINITY,
        maxAttempts: plan.maxAttempts,
        approvedBy: "producer",
      }),
      /finite positive limits/,
    );
    assert.equal(paidCalls, 0);

    const resumed = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(resumed.status, "succeeded");
    assert.equal(paidCalls, 1);
    assert.equal(resumed.revision, 1);
    assert.equal(resumed.spendAuthorizations?.length, 1);
    assert.equal(resumed.nodeRuns.find((node) => node.nodeId === "render")?.status, "succeeded");
  });

  it("gates a metered provider before a custom node executor can call it", async () => {
    let executeCalls = 0;
    let providerCalls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "wrapped-paid-provider",
      label: "Wrapped Paid Provider",
      modelId: "wrapped-v1",
      capability: "asset.prepare",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => {
        providerCalls += 1;
        return { assetIds: ["asset-1"] };
      },
    });
    const definition: WorkflowDefinition = {
      id: "wrapped-metered-provider",
      name: "Wrapped metered provider",
      version: "1.0.0",
      nodes: [
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          providerId: "wrapped-paid-provider",
          execute: async (input, context) => {
            executeCalls += 1;
            const output = await context.resolveProvider({
              capability: "asset.prepare",
              providerId: "wrapped-paid-provider",
            }).run(input, context);
            return { output };
          },
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.equal(executeCalls, 0);
    assert.equal(providerCalls, 0);
    assert.ok(plan);

    const completed = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(completed.status, "succeeded");
    assert.equal(executeCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.providerId, "wrapped-paid-provider");
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.modelId, "wrapped-v1");
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.billing, "metered");
  });

  it("invalidates spend approval when any bound execution scope changes", async () => {
    async function setup() {
      let paidCalls = 0;
      const registry = new ProviderRegistry();
      const paidProvider = (overrides: Record<string, unknown> = {}) => ({
        id: "paid-render",
        label: "Paid Render",
        modelId: "render-v3",
        capability: "video.render" as const,
        transport: "http_api" as const,
        billing: "metered" as const,
        estimatedCostCny: 1,
        maxCostCny: 2,
        maxAttempts: 1,
        run: () => {
          paidCalls += 1;
          return { uri: "paid.mp4" };
        },
        ...overrides,
      });
      registry.register(paidProvider());
      registry.register(paidProvider({ id: "alternate-render", label: "Alternate Render" }));
      const definition: WorkflowDefinition = {
        id: "bound-spend",
        name: "Bound spend",
        version: "1.0.0",
        nodes: [
          {
            id: "script",
            label: "Script",
            capability: "script.draft",
            mode: "automatic",
            execute: () => ({ output: { text: "generated" } }),
          },
          {
            id: "render",
            label: "Render",
            capability: "video.render",
            mode: "automatic",
            providerId: "paid-render",
            dependsOn: ["script"],
          },
        ],
      };
      const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
      const paused = await runner.run(definition, {});
      const plan = paused.nodeRuns.find((node) => node.nodeId === "render")?.spendPlan;
      assert.ok(plan);
      const authorization = {
        nodeId: plan.nodeId,
        inputVersionIds: plan.inputVersionIds,
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: plan.maxCostCny,
        maxAttempts: plan.maxAttempts,
        approvedBy: "producer",
      };
      return { authorization, definition, getPaidCalls: () => paidCalls, paidProvider, paused, registry, runner };
    }

    const scenarios = [
      {
        name: "provider",
        change: async (state: Awaited<ReturnType<typeof setup>>) => {
          const definition = {
            ...state.definition,
            nodes: state.definition.nodes.map((node) => ({ ...node })),
          };
          definition.nodes.find((node) => node.id === "render")!.providerId = "alternate-render";
          return { definition, run: state.paused };
        },
      },
      {
        name: "model",
        change: async (state: Awaited<ReturnType<typeof setup>>) => {
          state.registry.replace(state.paidProvider({ modelId: "render-v4" }));
          return { definition: state.definition, run: state.paused };
        },
      },
      {
        name: "max cost",
        change: async (state: Awaited<ReturnType<typeof setup>>) => {
          state.registry.replace(state.paidProvider({ maxCostCny: 3 }));
          return { definition: state.definition, run: state.paused };
        },
      },
      {
        name: "max attempts",
        change: async (state: Awaited<ReturnType<typeof setup>>) => {
          state.registry.replace(state.paidProvider({ maxAttempts: 2 }));
          return { definition: state.definition, run: state.paused };
        },
      },
    ];

    const inputChanged = await setup();
    const stale = inputChanged.runner.applyNodeOverride(inputChanged.definition, inputChanged.paused, {
      nodeId: "script",
      actor: "editor",
      output: { text: "human" },
    });
    const staleRender = stale.nodeRuns.find((node) => node.nodeId === "render");
    assert.equal(stale.status, "stale");
    assert.equal(staleRender?.spendPlan, undefined);
    assert.equal(staleRender?.spendAuthorizationId, undefined);
    assert.equal(inputChanged.getPaidCalls(), 0);

    for (const scenario of scenarios) {
      const state = await setup();
      const changed = await scenario.change(state);
      const invalidated = await state.runner.authorizeSpend(changed.definition, changed.run, state.authorization);
      const renderRun = invalidated.nodeRuns.find((node) => node.nodeId === "render");

      assert.equal(invalidated.status, "approval_invalidated", scenario.name);
      assert.equal(renderRun?.status, "approval_invalidated", scenario.name);
      assert.notDeepEqual(renderRun?.spendPlan, state.paused.nodeRuns[1]?.spendPlan, scenario.name);
      assert.equal(state.getPaidCalls(), 0, scenario.name);
    }
  });

  it("requires separate approvals for consecutive metered nodes", async () => {
    const calls: string[] = [];
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-assets",
      label: "Paid Assets",
      modelId: "assets-v1",
      capability: "asset.prepare",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.8,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => {
        calls.push("assets");
        return { assetIds: ["asset-1"] };
      },
    });
    registry.register({
      id: "paid-render",
      label: "Paid Render",
      modelId: "render-v1",
      capability: "video.render",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 1.5,
      maxCostCny: 2,
      maxAttempts: 1,
      run: () => {
        calls.push("render");
        return { uri: "final.mp4" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "consecutive-spend",
      name: "Consecutive spend",
      version: "1.0.0",
      nodes: [
        {
          id: "script",
          label: "Script",
          capability: "script.draft",
          mode: "automatic",
          execute: () => ({ output: { text: "ready" } }),
        },
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          providerId: "paid-assets",
          dependsOn: ["script"],
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          providerId: "paid-render",
          dependsOn: ["assets"],
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const firstPause = await runner.run(definition, {});
    const firstPlan = firstPause.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan;
    assert.ok(firstPlan);

    const secondPause = await runner.authorizeSpend(definition, firstPause, {
      nodeId: firstPlan.nodeId,
      inputVersionIds: firstPlan.inputVersionIds,
      providerId: firstPlan.providerId,
      modelId: firstPlan.modelId,
      maxCostCny: firstPlan.maxCostCny,
      maxAttempts: firstPlan.maxAttempts,
      approvedBy: "producer",
    });
    const assetsRun = secondPause.nodeRuns.find((node) => node.nodeId === "assets");
    const secondPlan = secondPause.nodeRuns.find((node) => node.nodeId === "render")?.spendPlan;

    assert.equal(secondPause.status, "awaiting_spend_approval");
    assert.deepEqual(calls, ["assets"]);
    assert.ok(secondPlan);
    assert.deepEqual(secondPlan.inputVersionIds, [
      secondPause.nodeRuns.find((node) => node.nodeId === "render")?.inputState?.effectiveVersionId,
      assetsRun?.outputState?.effectiveVersionId,
    ]);
    assert.equal(secondPause.spendAuthorizations?.length, 1);

    const overriddenAssets = runner.applyNodeOverride(definition, secondPause, {
      nodeId: "assets",
      actor: "producer",
      output: { assetIds: ["human-asset"] },
    });
    assert.equal(overriddenAssets.nodeRuns.find((node) => node.nodeId === "assets")?.spendPlan, undefined);
    assert.equal(overriddenAssets.nodeRuns.find((node) => node.nodeId === "assets")?.spendAuthorizationId, undefined);
    assert.equal(overriddenAssets.nodeRuns.find((node) => node.nodeId === "render")?.spendPlan, undefined);
    assert.equal(overriddenAssets.nodeRuns.find((node) => node.nodeId === "render")?.status, "stale");
    assert.deepEqual(overriddenAssets.spendAuthorizations, []);

    await assert.rejects(
      () => runner.authorizeSpend(definition, secondPause, {
        nodeId: firstPlan.nodeId,
        inputVersionIds: firstPlan.inputVersionIds,
        providerId: firstPlan.providerId,
        modelId: firstPlan.modelId,
        maxCostCny: firstPlan.maxCostCny,
        maxAttempts: firstPlan.maxAttempts,
        approvedBy: "producer",
      }),
      /not awaiting spend approval/,
    );

    const completed = await runner.authorizeSpend(definition, secondPause, {
      nodeId: secondPlan.nodeId,
      inputVersionIds: secondPlan.inputVersionIds,
      providerId: secondPlan.providerId,
      modelId: secondPlan.modelId,
      maxCostCny: secondPlan.maxCostCny,
      maxAttempts: secondPlan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(calls, ["assets", "render"]);
    assert.deepEqual(completed.spendAuthorizations?.map((authorization) => authorization.nodeId), ["assets", "render"]);
    assert.notEqual(completed.spendAuthorizations?.[0]?.id, completed.spendAuthorizations?.[1]?.id);
  });

  it("keeps provider capability indexes consistent when replacing providers", () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "manual-provider",
      capability: "asset.search",
      run: () => ({ score: 60 }),
    });
    registry.replace({
      id: "manual-provider",
      capability: "quality.review",
      run: () => ({ approved: true }),
    });

    assert.equal(registry.list("asset.search").length, 0);
    assert.equal(registry.list("quality.review").length, 1);
    assert.throws(
      () => registry.resolve({ capability: "asset.search", providerId: "manual-provider" }),
      /cannot serve 'asset.search'/,
    );
  });

  it("fails fast if a node returns skipped before skip semantics exist", async () => {
    const workflow: WorkflowDefinition = {
      id: "unsupported-skip",
      name: "Unsupported Skip",
      version: "0.1.0",
      nodes: [
        {
          id: "optional-assets",
          label: "Optional Assets",
          capability: "asset.search",
          mode: "automatic",
          execute: () => ({ status: "skipped" }) as never,
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          dependsOn: ["optional-assets"],
          execute: () => ({ output: { uri: "workspace/renders/final.mp4" } }),
        },
      ],
    };

    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, {});

    assert.equal(run.status, "failed");
    assert.equal(run.nodeRuns.length, 1);
    assert.match(run.nodeRuns[0]?.error ?? "", /unsupported status 'skipped'/);
  });

  it("fails if a node asks for human work without an actionable intervention", async () => {
    const workflow: WorkflowDefinition = {
      id: "invalid-human-state",
      name: "Invalid Human State",
      version: "0.1.0",
      nodes: [
        {
          id: "review",
          label: "Review",
          capability: "quality.review",
          mode: "manual",
          execute: () => ({ status: "needs_human" }) as never,
        },
      ],
    };

    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const run = await runner.run(workflow, {});

    assert.equal(run.status, "failed");
    assert.equal(run.interventions.length, 0);
    assert.match(run.nodeRuns[0]?.error ?? "", /without an intervention/);
  });

  it("resumes an approved human intervention without rerunning completed nodes", async () => {
    let completedNodeRuns = 0;
    const definition: WorkflowDefinition = {
      id: "publishable-video",
      name: "Publishable video",
      version: "1.0.0",
      nodes: [
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          execute: () => {
            completedNodeRuns += 1;
            return { status: "succeeded", output: { uri: "final.mp4" } };
          },
        },
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review",
          mode: "manual",
          dependsOn: ["render"],
          execute: () => ({
            status: "needs_human",
            output: { uri: "final.mp4" },
            intervention: {
              reason: "A person must watch the final render.",
              requiredAction: "approve",
            },
          }),
        },
        {
          id: "publish-package",
          label: "Publish package",
          capability: "publish.package",
          mode: "automatic",
          dependsOn: ["final-review"],
          execute: () => ({ status: "succeeded", output: { uri: "publish_package.json" } }),
        },
      ],
    };

    const paused = await new WorkflowRunner().run(definition, { title: "A useful checklist" });
    const intervention = paused.interventions[0];
    assert.ok(intervention);
    assert.equal((paused as typeof paused & { revision?: number }).revision, 0);

    const resumed = await (
      new WorkflowRunner() as WorkflowRunner & {
        resume: (
          workflow: WorkflowDefinition,
          run: typeof paused,
          decision: { interventionId: string; action: "approve"; actor: string; note?: string },
        ) => Promise<typeof paused & { decisions: Array<{ action: string; actor: string }> }>;
      }
    ).resume(definition, paused, {
      interventionId: intervention.id,
      action: "approve",
      actor: "director",
      note: "Picture, subtitles and narration are aligned.",
    });

    assert.equal(resumed.status, "succeeded");
    assert.equal((resumed as typeof resumed & { revision?: number }).revision, 1);
    assert.equal(completedNodeRuns, 1);
    assert.deepEqual(resumed.nodeRuns.map((node) => node.nodeId), ["render", "final-review", "publish-package"]);
    assert.equal(resumed.decisions[0]?.action, "approve");
    assert.equal(resumed.decisions[0]?.actor, "director");
  });

  it("normalizes legacy outputs before versioning resumed downstream inputs", async () => {
    const definition: WorkflowDefinition = {
      id: "legacy-version-resume",
      name: "Legacy version resume",
      version: "1.0.0",
      nodes: [
        {
          id: "draft",
          label: "Draft",
          capability: "script.draft",
          mode: "automatic",
          execute: () => ({ output: { text: "draft" } }),
        },
        {
          id: "review",
          label: "Review",
          capability: "quality.review",
          mode: "manual",
          dependsOn: ["draft"],
          getInput: (context) => context.outputs.get("draft"),
          execute: () => ({
            status: "needs_human",
            output: { text: "approved draft" },
            intervention: { reason: "Review it.", requiredAction: "approve" },
          }),
        },
        {
          id: "package",
          label: "Package",
          capability: "publish.package",
          mode: "automatic",
          dependsOn: ["review"],
          getInput: (context) => context.outputs.get("review"),
          execute: () => ({ output: { uri: "package.json" } }),
        },
      ],
    };
    const paused = await new WorkflowRunner().run(definition, {});
    const legacy = structuredClone(paused);
    for (const nodeRun of legacy.nodeRuns) {
      delete nodeRun.outputState;
      delete nodeRun.inputState;
      delete nodeRun.executionReceipt;
    }
    delete legacy.spendAuthorizations;

    const resumed = await new WorkflowRunner({ clock, idFactory: deterministicIds() }).resume(definition, legacy, {
      interventionId: legacy.interventions[0]!.id,
      action: "approve",
      actor: "director",
    });
    const reviewState = resumed.nodeRuns.find((node) => node.nodeId === "review")?.outputState;
    const packageVersion = resumed.nodeRuns.find((node) => node.nodeId === "package")?.outputState?.versions[0];

    assert.ok(resumed.nodeRuns.find((node) => node.nodeId === "draft")?.outputState);
    assert.ok(reviewState);
    const reconstructedReviewInput = resumed.nodeRuns.find((node) => node.nodeId === "review")?.inputState?.versions[0];
    assert.equal(reconstructedReviewInput?.source, "reconstructed");
    assert.deepEqual(reconstructedReviewInput?.value, { text: "draft" });
    assert.deepEqual(packageVersion?.inputVersionIds, [
      resumed.nodeRuns.find((node) => node.nodeId === "package")?.inputState?.effectiveVersionId,
      reviewState.effectiveVersionId,
    ]);
  });

  it("records rejection and refuses a decision for a run that is no longer waiting", async () => {
    const definition: WorkflowDefinition = {
      id: "review-only",
      name: "Review only",
      version: "1.0.0",
      nodes: [
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review",
          mode: "manual",
          execute: () => ({
            status: "needs_human",
            intervention: { reason: "Watch it.", requiredAction: "approve", options: ["approve", "reject"] },
          }),
        },
      ],
    };
    const runner = new WorkflowRunner() as WorkflowRunner & {
      resume: (
        workflow: WorkflowDefinition,
        run: Awaited<ReturnType<WorkflowRunner["run"]>>,
        decision: { interventionId: string; action: "approve" | "reject"; actor: string },
      ) => Promise<Awaited<ReturnType<WorkflowRunner["run"]>> & { decisions: Array<{ action: string }> }>;
    };
    const paused = await runner.run(definition, {});
    const intervention = paused.interventions[0];
    assert.ok(intervention);

    const rejected = await runner.resume(definition, paused, {
      interventionId: intervention.id,
      action: "reject",
      actor: "director",
    });

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decisions[0]?.action, "reject");
    await assert.rejects(
      () => runner.resume(definition, rejected, {
        interventionId: intervention.id,
        action: "approve",
        actor: "director",
      }),
      /not waiting for human input/,
    );
  });

  it("rejects a human action that the intervention did not offer", async () => {
    const definition: WorkflowDefinition = {
      id: "approval-only",
      name: "Approval only",
      version: "1.0.0",
      nodes: [
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review",
          mode: "manual",
          execute: () => ({
            status: "needs_human",
            intervention: {
              reason: "Approve the final render.",
              requiredAction: "approve",
              options: ["approve"],
            },
          }),
        },
      ],
    };
    const runner = new WorkflowRunner();
    const paused = await runner.run(definition, {});

    await assert.rejects(
      () => runner.resume(definition, paused, {
        interventionId: paused.interventions[0]!.id,
        action: "reject",
        actor: "director",
      }),
      /does not allow action 'reject'/,
    );
  });
});

describe("Topic Intelligence", () => {
  it("scores compliance risk as a penalty instead of a growth signal", () => {
    const base = {
      platform: "douyin" as const,
      track: "ai-life-explainer",
      audience: "对 AI 有好奇但不想看技术细节的人",
      painPoint: "不知道 AI 新闻和自己有什么关系",
      hook: "这个 AI 变化，会先影响你每天用的 3 个软件",
      evidence: [],
      audienceReach: 80,
      visualFeasibility: 80,
      productionCostEfficiency: 80,
      novelty: 80,
      monetization: 80,
      seriesPotential: 80,
    };

    const safe = scoreTopicCandidate("safe", { ...base, complianceRisk: 10 });
    const risky = scoreTopicCandidate("risky", { ...base, complianceRisk: 90 });

    assert.ok(safe.score.final > risky.score.final);
    assert.equal(safe.status, "shortlisted");
    assert.equal(risky.status, "draft");
  });
});
