import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ProviderRegistry,
  WorkflowRunner,
  scoreTopicCandidate,
  topicCandidateArtifact,
  type NodeDefinition,
  type NodeRevisionDraft,
  type Provider,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowRun,
} from "../src/index.js";

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix: string) => `${prefix}-${next++}`;
}

const clock = (): string => "2026-08-21T10:00:00.000Z";

describe("WorkflowRunner", () => {
  it("pauses between nodes on request and resumes without replaying completed work", async () => {
    let pauseRequested = false;
    let firstCalls = 0;
    let secondCalls = 0;
    const definition: WorkflowDefinition = {
      id: "cooperative-pause",
      name: "Cooperative pause",
      version: "1.0.0",
      nodes: [{
        id: "script",
        label: "Script",
        capability: "script.draft",
        mode: "automatic",
        execute: () => {
          firstCalls += 1;
          pauseRequested = true;
          return { output: { text: "draft" } };
        },
      }, {
        id: "director",
        label: "Director",
        capability: "storyboard.plan",
        mode: "automatic",
        dependsOn: ["script"],
        execute: () => {
          secondCalls += 1;
          return { output: { shots: 3 } };
        },
      }],
    };
    const runner = new WorkflowRunner({
      shouldPause: () => pauseRequested,
    });

    const paused = await runner.run(definition, {});

    assert.equal(paused.status, "paused");
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
    assert.deepEqual(paused.nodeRuns.map((node) => [node.nodeId, node.status]), [["script", "succeeded"]]);

    pauseRequested = false;
    const resumed = await runner.resumePaused(definition, paused);

    assert.equal(resumed.status, "succeeded");
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1);
  });

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
      parameters: { reviewModes: ["frames", "timeline"] },
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
    assert.deepEqual(run.executionPlan, [{
      nodeId: "review",
      role: "总导演",
      capability: "quality.review",
      providerId: "review-model",
      providerLabel: "Review Model",
      modelId: "review-v2",
      transport: "http_api",
      billing: "subscription",
      parameters: { reviewModes: ["frames", "timeline"] },
      snapshotSource: "created",
    }]);
    assert.deepEqual(nodeRun.executionReceipt, {
      nodeId: "review",
      role: "总导演",
      capability: "quality.review",
      providerId: "review-model",
      providerLabel: "Review Model",
      modelId: "review-v2",
      transport: "http_api",
      billing: "subscription",
      parameters: { reviewModes: ["frames", "timeline"] },
      status: "succeeded",
      startedAt: clock(),
      finishedAt: clock(),
    });
    assert.equal("credentials" in nodeRun.executionReceipt, false);
    const resumed = await new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry }).hydrateLegacyVersionStates(definition, run);
    (resumed.nodeRuns[0]!.executionReceipt!.parameters!.reviewModes as string[]).push("mutated");
    assert.deepEqual(run.nodeRuns[0]!.executionReceipt!.parameters!.reviewModes, ["frames", "timeline"]);
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

  it("refreshes future execution plans on retry without rewriting completed history", async () => {
    const firstRegistry = new ProviderRegistry();
    firstRegistry.register({
      id: "writer",
      label: "Writer",
      modelId: "writer-v1",
      capability: "script.draft",
      run: () => ({ text: "draft" }),
    });
    firstRegistry.register({
      id: "reviewer",
      label: "Reviewer",
      modelId: "reviewer-v1",
      capability: "quality.review",
      run: () => {
        throw new Error("temporary model failure");
      },
    });
    const definition: WorkflowDefinition = {
      id: "refresh-retry-plan",
      name: "Refresh retry plan",
      version: "1.0.0",
      nodes: [
        { id: "script", label: "Script", capability: "script.draft", providerId: "writer", mode: "automatic" },
        {
          id: "review",
          label: "Review",
          capability: "quality.review",
          providerId: "reviewer",
          mode: "automatic",
          dependsOn: ["script"],
        },
      ],
    };
    const failed = await new WorkflowRunner({ providers: firstRegistry }).run(definition, {});

    const secondRegistry = new ProviderRegistry();
    secondRegistry.register({
      id: "writer",
      label: "Writer",
      modelId: "writer-v2",
      capability: "script.draft",
      run: () => ({ text: "new draft" }),
    });
    secondRegistry.register({
      id: "reviewer",
      label: "Reviewer",
      modelId: "reviewer-v2",
      capability: "quality.review",
      run: () => ({ approved: true }),
    });

    const retried = await new WorkflowRunner({ providers: secondRegistry }).retryFailedNode(
      definition,
      failed,
      "review",
    );

    assert.equal(retried.executionPlan?.find((plan) => plan.nodeId === "script")?.modelId, "writer-v1");
    assert.equal(retried.executionPlan?.find((plan) => plan.nodeId === "script")?.snapshotSource, "created");
    assert.equal(retried.executionPlan?.find((plan) => plan.nodeId === "review")?.modelId, "reviewer-v2");
    assert.equal(retried.executionPlan?.find((plan) => plan.nodeId === "review")?.snapshotSource, "reconstructed");
    assert.equal(retried.nodeRuns.find((node) => node.nodeId === "review")?.executionReceipt?.modelId, "reviewer-v2");
  });

  it("snapshots custom receipt arrays independently from node results and receipt history", async () => {
    const mutableParameters = ["/private/input.mp4"];
    const mutableModelIds = ["review-v1"];
    const definition: WorkflowDefinition = {
      id: "custom-receipt-snapshot",
      name: "Custom receipt snapshot",
      version: "1.0.0",
      nodes: [{
        id: "review",
        label: "Review",
        capability: "quality.review",
        mode: "automatic",
        getInput: () => ({}),
        execute: async () => ({
          output: { approved: true },
          receipt: {
            providerId: "custom-review",
            providerLabel: "Custom review",
            modelId: "review-v1",
            transport: "http_api",
            billing: "subscription",
            parameters: { sourcePaths: mutableParameters },
            actualModelIds: mutableModelIds,
          },
        }),
      }],
    };

    const run = await new WorkflowRunner({ clock, idFactory: deterministicIds() }).run(definition, {});
    mutableParameters.push("mutated");
    mutableModelIds.push("mutated-model");

    assert.deepEqual(run.nodeRuns[0]?.executionReceipt?.parameters?.sourcePaths, ["/private/input.mp4"]);
    assert.deepEqual(run.nodeRuns[0]?.executionReceipt?.actualModelIds, ["review-v1"]);
    assert.deepEqual(run.executionReceipts?.[0]?.parameters?.sourcePaths, ["/private/input.mp4"]);
    assert.deepEqual(run.executionReceipts?.[0]?.actualModelIds, ["review-v1"]);
    assert.notEqual(run.executionReceipts?.[0]?.parameters?.sourcePaths, run.nodeRuns[0]?.executionReceipt?.parameters?.sourcePaths);
    assert.notEqual(run.executionReceipts?.[0]?.actualModelIds, run.nodeRuns[0]?.executionReceipt?.actualModelIds);
  });

  it("persists valid nested metered counts and rejects impossible failure totals", async () => {
    async function execute(meteredAttemptCount: number, meteredFailedAttemptCount: number) {
      const registry = new ProviderRegistry();
      registry.register({
        id: "asset-router",
        label: "Asset router",
        modelId: "router-v1",
        capability: "asset.prepare",
        transport: "local_process",
        billing: "metered",
        estimatedCostCny: 0.5,
        maxCostCny: 1,
        maxAttempts: 1,
        run: () => ({ fallback: true }),
      });
      const definition: WorkflowDefinition = {
        id: "nested-metered-counts",
        name: "Nested metered counts",
        version: "1.0.0",
        nodes: [{
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          providerId: "asset-router",
          mode: "automatic",
          execute: async (input, context) => ({
            output: await context.resolveProvider({ capability: "asset.prepare", providerId: "asset-router" }).run(input, context),
            receipt: {
              providerId: "asset-router",
              providerLabel: "Asset router",
              modelId: "router-v1",
              transport: "local_process",
              billing: "metered",
              estimatedCostCny: 0.5,
              actualCostCny: 0,
              actualCostSource: "configured_rate",
              meteredAttemptCount,
              meteredFailedAttemptCount,
            },
          }),
        }],
      };
      const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
      const paused = await runner.run(definition, {});
      const plan = paused.nodeRuns[0]?.spendPlan;
      assert.ok(plan);
      return runner.authorizeSpend(definition, paused, {
        nodeId: plan.nodeId,
        inputVersionIds: plan.inputVersionIds,
        providerId: plan.providerId,
        modelId: plan.modelId,
        maxCostCny: plan.maxCostCny,
        maxAttempts: plan.maxAttempts,
        approvedBy: "producer",
      });
    }

    const valid = await execute(2, 1);
    assert.equal(valid.nodeRuns[0]?.executionReceipt?.meteredAttemptCount, 2);
    assert.equal(valid.nodeRuns[0]?.executionReceipt?.meteredFailedAttemptCount, 1);

    const invalid = await execute(1, 2);
    assert.equal(invalid.status, "failed");
    assert.match(invalid.nodeRuns[0]?.error ?? "", /failed metered attempts cannot exceed total metered attempts/);
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

  it("fails closed after an authorized metered call has an uncertain outcome", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-voice",
      label: "Paid voice",
      modelId: "voice-v1",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 0.5,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        throw new Error("connection reset");
      },
    });
    const definition: WorkflowDefinition = {
      id: "retry-failed-node",
      name: "Retry failed node",
      version: "1.0.0",
      nodes: [
        { id: "script", label: "Script", capability: "script.draft", mode: "automatic", execute: () => ({ output: { text: "keep me" } }) },
        { id: "voice", label: "Voice", capability: "voice.synthesize", providerId: "paid-voice", mode: "automatic", dependsOn: ["script"] },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const firstPause = await runner.run(definition, {});
    const firstPlan = firstPause.nodeRuns.find((node) => node.nodeId === "voice")?.spendPlan;
    assert.ok(firstPlan);
    const failed = await runner.authorizeSpend(definition, firstPause, {
      nodeId: firstPlan.nodeId,
      inputVersionIds: firstPlan.inputVersionIds,
      providerId: firstPlan.providerId,
      modelId: firstPlan.modelId,
      maxCostCny: firstPlan.maxCostCny,
      maxAttempts: firstPlan.maxAttempts,
      approvedBy: "producer",
    });
    const failedNode = failed.nodeRuns.find((node) => node.nodeId === "voice");
    assert.equal(failedNode?.outcomeUncertain, true);
    assert.ok(failedNode?.operationRequestId);
    await assert.rejects(() => runner.retryFailedNode(definition, failed, "voice"), /uncertain paid-provider outcome/);
    await assert.rejects(() => runner.retryFailedNode(definition, failed, "voice"), /uncertain paid-provider outcome/);
    const staleAfterUpstreamEdit = {
      ...failed,
      status: "stale" as const,
      nodeRuns: failed.nodeRuns.map((nodeRun) => nodeRun.nodeId === "voice"
        ? { ...nodeRun, status: "stale" as const }
        : nodeRun),
    };
    await assert.rejects(() => runner.resumeStale(definition, staleAfterUpstreamEdit), /uncertain paid-provider outcome/);
    assert.equal(calls, 1);
  });

  it("durably marks an automatic metered operation uncertain before the provider call", async () => {
    const checkpoints: WorkflowRun[] = [];
    const registry = new ProviderRegistry();
    registry.register({
      id: "automatic-paid-voice",
      label: "Automatic paid voice",
      modelId: "voice-v1",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.1,
      maxCostCny: 0.1,
      maxAttempts: 1,
      run: () => {
        assert.equal(checkpoints.at(-1)?.nodeRuns[0]?.outcomeUncertain, true);
        return { audio: "voice.mp3" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "automatic-paid-checkpoint",
      name: "Automatic paid checkpoint",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "automatic-paid-voice",
        mode: "automatic",
      }],
    };
    const runner = new WorkflowRunner({
      clock,
      idFactory: deterministicIds(),
      providers: registry,
      checkpoint: (run) => { checkpoints.push(structuredClone(run)); },
    });

    const completed = await runner.run(definition, {});

    assert.equal(completed.status, "succeeded");
    assert.equal(completed.nodeRuns[0]?.outcomeUncertain, undefined);
  });

  it("keeps an automatic metered operation locked when the provider returns a structured failure", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "automatic-paid-voice",
      label: "Automatic paid voice",
      modelId: "voice-v1",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.1,
      maxCostCny: 0.1,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { accepted: true };
      },
    });
    const definition: WorkflowDefinition = {
      id: "automatic-paid-structured-failure",
      name: "Automatic paid structured failure",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "automatic-paid-voice",
        mode: "automatic",
        execute: async (input, context) => {
          await context.resolveProvider({
            capability: "voice.synthesize",
            providerId: "automatic-paid-voice",
          }).run(input, context);
          return {
            status: "failed",
            error: "provider response was ambiguous",
            receipt: {
              providerId: "automatic-paid-voice",
              providerLabel: "Automatic paid voice",
              modelId: "voice-v1",
              transport: "http_api",
              billing: "metered",
              estimatedCostCny: 0.1,
            },
          };
        },
      }],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });

    const failed = await runner.run(definition, {});

    assert.equal(failed.status, "failed");
    assert.equal(failed.nodeRuns.filter((node) => node.nodeId === "voice").length, 1);
    assert.equal(failed.nodeRuns[0]?.outcomeUncertain, true);
    await assert.rejects(
      () => runner.retryFailedNode(definition, failed, "voice"),
      /uncertain paid-provider outcome/,
    );
    assert.equal(calls, 1);
  });

  it("unlocks a metered failure when the receipt proves no request was submitted", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "automatic-paid-image",
      label: "Automatic paid image",
      modelId: "image-v1",
      capability: "asset.prepare",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.25,
      maxCostCny: 0.25,
      maxAttempts: 1,
      run: () => ({ rejected: true }),
    });
    const definition: WorkflowDefinition = {
      id: "automatic-paid-definitive-rejection",
      name: "Automatic paid definitive rejection",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "automatic-paid-image",
        mode: "automatic",
        execute: async (input, context) => {
          await context.resolveProvider({
            capability: "asset.prepare",
            providerId: "automatic-paid-image",
          }).run(input, context);
          return {
            status: "failed",
            error: "provider rejected before creating a task",
            receipt: {
              providerId: "automatic-paid-image",
              providerLabel: "Automatic paid image",
              modelId: "image-v1",
              transport: "http_api",
              billing: "metered",
              estimatedCostCny: 0.25,
              actualCostCny: 0,
              actualCostSource: "configured_rate",
              meteredAttemptCount: 0,
              meteredFailedAttemptCount: 0,
            },
          };
        },
      }],
    };

    const failed = await new WorkflowRunner({ providers: registry }).run(definition, {});

    assert.equal(failed.status, "failed");
    assert.equal(failed.nodeRuns[0]?.outcomeUncertain, undefined);
    assert.equal(failed.nodeRuns[0]?.executionReceipt?.meteredAttemptCount, 0);
  });

  it("allows retry when an authorized node fails before invoking its metered provider", async () => {
    let providerCalls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-voice",
      label: "Paid voice",
      modelId: "voice-v1",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 0.5,
      maxAttempts: 1,
      run: () => {
        providerCalls += 1;
        return { audio: "voice.mp3" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "pre-provider-failure",
      name: "Pre-provider failure",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "paid-voice",
        mode: "automatic",
        execute: () => { throw new Error("invalid local input"); },
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

    assert.equal(providerCalls, 0);
    assert.equal(failed.nodeRuns[0]?.outcomeUncertain, undefined);
    const retry = await runner.retryFailedNode(definition, failed, "voice");
    assert.equal(retry.status, "awaiting_spend_approval");
  });

  it("reuses the persisted external operation id when retrying an interrupted node", async () => {
    const observed: Array<string | undefined> = [];
    const registry = new ProviderRegistry();
    registry.register({
      id: "idempotent-provider",
      label: "Idempotent provider",
      modelId: "voice-v1",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.1,
      maxCostCny: 0.1,
      maxAttempts: 1,
      run: (_input, context) => {
        observed.push(context.operationRequestId);
        return { audio: "voice.mp3" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "retry-interrupted-node",
      name: "Retry interrupted node",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "idempotent-provider",
        mode: "automatic",
        execute: async (input, context) => {
          const provider = context.resolveProvider({ capability: "voice.synthesize", providerId: "idempotent-provider" });
          const output = await provider.run(input, context);
          assert.ok(context.operationRequestId);
          return {
            output,
            receipt: {
              providerId: "idempotent-provider",
              providerLabel: "Idempotent provider",
              modelId: "voice-v1",
              transport: "http_api",
              billing: "metered",
              estimatedCostCny: 0.1,
              meteredAttemptCount: 1,
              requestId: context.operationRequestId,
            },
          };
        },
      }],
    };
    const interrupted = {
      id: "run-interrupted",
      revision: 1,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "failed" as const,
      initialInput: {},
      startedAt: "2026-08-30T00:00:00.000Z",
      finishedAt: "2026-08-30T00:01:00.000Z",
      nodeRuns: [{
        nodeId: "voice",
        status: "failed" as const,
        startedAt: "2026-08-30T00:00:00.000Z",
        finishedAt: "2026-08-30T00:01:00.000Z",
        operationRequestId: "persisted-operation-id",
        interrupted: true,
        artifactIds: [],
        qualityGateResults: [],
        error: "interrupted",
      }],
      executionReceipts: [{
        nodeId: "voice",
        capability: "voice.synthesize" as const,
        providerId: "idempotent-provider",
        providerLabel: "Idempotent provider",
        modelId: "voice-v1",
        transport: "http_api" as const,
        billing: "metered" as const,
        status: "failed" as const,
        estimatedCostCny: 0.1,
        actualCostCny: 0.1,
        actualCostSource: "configured_rate" as const,
        meteredAttemptCount: 1,
        meteredFailedAttemptCount: 1,
        requestId: "persisted-operation-id",
        startedAt: "2026-08-30T00:00:00.000Z",
        finishedAt: "2026-08-30T00:01:00.000Z",
      }],
      artifacts: [],
      interventions: [],
      decisions: [],
    };

    const retried = await new WorkflowRunner({ providers: registry }).retryFailedNode(definition, interrupted, "voice");

    assert.equal(retried.status, "succeeded");
    assert.deepEqual(observed, ["persisted-operation-id"]);
    assert.equal(retried.nodeRuns[0]?.interrupted, undefined);
    assert.equal(retried.executionReceipts?.length, 1);
    assert.equal(retried.executionReceipts?.[0]?.status, "succeeded");
    assert.equal(retried.executionReceipts?.[0]?.actualCostCny, 0.1);
    assert.equal(retried.executionReceipts?.[0]?.actualCostSource, "configured_rate");
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
              actualModelIds: ["asset-specialist-v2"],
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
    assert.deepEqual(withinLimit.run.nodeRuns[0]?.executionReceipt?.actualModelIds, ["asset-specialist-v2"]);
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

  it("enforces the authorized attempt limit inside a custom metered node", async () => {
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
        return { ok: true };
      },
    });
    const definition: WorkflowDefinition = {
      id: "bounded-provider-attempts",
      name: "Bounded provider attempts",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "paid-assets",
        mode: "automatic",
        execute: async (input, context) => {
          const provider = context.resolveProvider({ capability: "asset.prepare", providerId: "paid-assets" });
          await provider.run(input, context);
          await provider.run(input, context);
          return { output: { ok: true } };
        },
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

    assert.equal(calls, 1);
    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns[0]?.error ?? "", /authorized attempt limit/);
  });

  it("does not expose the internal provider registry to custom nodes", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-assets",
      modelId: "assets-v1",
      capability: "asset.prepare",
      billing: "metered",
      estimatedCostCny: 0.5,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { ok: true };
      },
    });
    const definition: WorkflowDefinition = {
      id: "context-facade",
      name: "Context facade",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        mode: "automatic",
        execute: (_input, context) => {
          const runtime = context as WorkflowContext & {
            providers?: ProviderRegistry;
            resolveProviderForNode?: (selector: { capability: "asset.prepare"; providerId: string }) => Provider;
            withSpendAuthorization?: (authorization: unknown, execute: () => Promise<unknown>) => Promise<unknown>;
          };
          assert.equal(runtime.providers, undefined);
          assert.equal(runtime.resolveProviderForNode, undefined);
          assert.equal(runtime.withSpendAuthorization, undefined);
          return { output: { ok: true } };
        },
      }],
    };

    const run = await new WorkflowRunner({ providers: registry }).run(definition, {});

    assert.equal(run.status, "succeeded");
    assert.equal(calls, 0);
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

  it("records request changes and reruns only the revised asset descendants", async () => {
    const calls = { assets: 0, voice: 0, render: 0, review: 0, final: 0 };
    const definition: WorkflowDefinition = {
      id: "review-directed-scene-revision",
      name: "Review-directed scene revision",
      version: "1.0.0",
      nodes: [
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          execute: () => {
            calls.assets += 1;
            return {
              output: { assetPlanPath: "/tmp/asset-plan-v1.json" },
              artifacts: [
                { kind: "asset_plan", data: { version: 1 } },
                { kind: "media_asset", data: { scenePosition: 1 } },
                { kind: "media_asset", data: { scenePosition: 2 } },
              ],
            };
          },
        },
        {
          id: "voice",
          label: "Voice",
          capability: "voice.synthesize",
          mode: "automatic",
          dependsOn: ["assets"],
          execute: () => {
            calls.voice += 1;
            return { output: { voicePath: "/tmp/voice.m4a" } };
          },
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          dependsOn: ["assets", "voice"],
          execute: () => {
            calls.render += 1;
            return { output: { videoPath: `/tmp/render-${calls.render}.mp4` } };
          },
        },
        {
          id: "visual-review",
          label: "Visual review",
          capability: "quality.review.visual",
          mode: "automatic",
          dependsOn: ["render"],
          execute: () => {
            calls.review += 1;
            return { output: { report: { findings: [{ scenePosition: 2 }] } } };
          },
        },
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review.human",
          mode: "manual",
          dependsOn: ["visual-review"],
          execute: () => {
            calls.final += 1;
            return {
              status: "needs_human",
              output: { reviewed: true },
              intervention: {
                reason: "Scene 2 needs a different asset.",
                requiredAction: "approve",
                options: ["approve", "request_changes", "reject"],
              },
            };
          },
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const waiting = await runner.run(definition, {});
    const intervention = waiting.interventions.at(-1)!;
    const assets = waiting.nodeRuns.find((node) => node.nodeId === "assets")!;
    const currentAssetVersion = assets.outputState?.versions.find(
      (version) => version.id === assets.outputState?.effectiveVersionId,
    );
    const sceneOneArtifact = waiting.artifacts.find((artifact) => (
      artifact.kind === "media_asset"
      && (artifact.data as { scenePosition?: number } | undefined)?.scenePosition === 1
    ));
    const sceneTwoArtifact = waiting.artifacts.find((artifact) => (
      artifact.kind === "media_asset"
      && (artifact.data as { scenePosition?: number } | undefined)?.scenePosition === 2
    ));
    const originalPlanArtifact = waiting.artifacts.find((artifact) => artifact.kind === "asset_plan");
    assert.ok(currentAssetVersion);
    assert.ok(sceneOneArtifact);
    assert.ok(sceneTwoArtifact);
    assert.ok(originalPlanArtifact);

    await assert.rejects(
      () => runner.resume(definition, waiting, {
        interventionId: intervention.id,
        action: "request_changes",
        actor: "director",
      }),
      /must include a node revision/,
    );

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan-v1.json" },
        artifacts: [],
        retainedArtifactIds: [],
        invalidateDescendantNodeIds: ["render", "visual-review", "final-review"],
        decision: {
          interventionId: intervention.id,
          action: "request_changes",
          actor: "director",
        },
      } as unknown as NodeRevisionDraft),
      /must include the expected current output version/,
    );

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan-v1.json" },
        artifacts: [],
        retainedArtifactIds: ["artifact-not-current"],
        invalidateDescendantNodeIds: ["render", "visual-review", "final-review"],
        expectedVersionId: assets.outputState!.effectiveVersionId,
        decision: {
          interventionId: intervention.id,
          action: "request_changes",
          actor: "director",
        },
      }),
      /cannot retain non-current artifact/,
    );

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan-v1.json" },
        artifacts: [],
        retainedArtifactIds: [],
        invalidateDescendantNodeIds: ["render", "visual-review", "final-review"],
        expectedVersionId: assets.outputState!.effectiveVersionId,
        decision: {
          interventionId: intervention.id,
          action: "approve",
          actor: "director",
        },
      } as unknown as NodeRevisionDraft),
      /must use a request_changes decision/,
    );

    const revised = runner.applyNodeRevision(definition, waiting, {
      nodeId: "assets",
      actor: "director",
      output: { assetPlanPath: "/tmp/asset-plan-v2.json" },
      artifacts: [
        { kind: "asset_plan", uri: "/tmp/asset-plan-v2.json" },
        { kind: "scene_revision_request", data: { scenePosition: 2, reuseFromScenePosition: 1 } },
      ],
      retainedArtifactIds: [sceneOneArtifact.id, sceneOneArtifact.id],
      invalidateDescendantNodeIds: ["render", "visual-review", "final-review"],
      expectedVersionId: assets.outputState!.effectiveVersionId,
      decision: {
        interventionId: intervention.id,
        action: "request_changes",
        actor: "director",
        note: "Scene 2 reuses scene 1.",
      },
    });

    assert.equal(revised.status, "stale");
    assert.equal(revised.decisions.at(-1)?.action, "request_changes");
    assert.equal(revised.interventions.length, 0);
    assert.equal(revised.nodeRuns.find((node) => node.nodeId === "assets")?.status, "succeeded");
    assert.equal(revised.nodeRuns.find((node) => node.nodeId === "voice")?.status, "succeeded");
    assert.deepEqual(
      revised.nodeRuns.filter((node) => node.status === "stale").map((node) => node.nodeId),
      ["render", "visual-review", "final-review"],
    );
    const revisedAssetVersion = revised.nodeRuns.find((node) => node.nodeId === "assets")?.outputState?.versions.at(-1);
    assert.deepEqual(
      revisedAssetVersion?.artifactIds.map((artifactId) => revised.artifacts.find((artifact) => artifact.id === artifactId)?.kind),
      ["media_asset", "asset_plan", "scene_revision_request"],
    );
    assert.equal(revisedAssetVersion?.artifactIds.includes(originalPlanArtifact.id), false);
    assert.equal(revisedAssetVersion?.artifactIds.includes(sceneTwoArtifact.id), false);

    const reviewedAgain = await runner.resumeStale(definition, revised);

    assert.equal(reviewedAgain.status, "needs_human");
    assert.deepEqual(calls, { assets: 1, voice: 1, render: 2, review: 2, final: 2 });
    assert.equal(reviewedAgain.decisions.at(-1)?.action, "request_changes");
  });

  it("rejects a node revision that invalidates a non-descendant", async () => {
    const definition: WorkflowDefinition = {
      id: "bounded-node-revision",
      name: "Bounded node revision",
      version: "1.0.0",
      nodes: [
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          execute: () => ({ output: { assetPlanPath: "/tmp/asset-plan-v1.json" } }),
        },
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review.human",
          mode: "manual",
          dependsOn: ["assets"],
          execute: () => ({
            status: "needs_human",
            intervention: {
              reason: "Review",
              requiredAction: "approve",
              options: ["approve", "request_changes", "reject"],
            },
          }),
        },
        {
          id: "unrelated",
          label: "Unrelated",
          capability: "noop",
          mode: "automatic",
          execute: () => ({ output: { ok: true } }),
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const waiting = await runner.run(definition, {});
    const assets = waiting.nodeRuns.find((node) => node.nodeId === "assets")!;
    const intervention = waiting.interventions.at(-1)!;

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan-v1.json" },
        artifacts: [],
        retainedArtifactIds: [],
        invalidateDescendantNodeIds: ["unrelated"],
        expectedVersionId: assets.outputState!.effectiveVersionId,
        decision: {
          interventionId: intervention.id,
          action: "request_changes",
          actor: "director",
        },
      }),
      /only invalidate descendants/,
    );
  });

  it("rejects a node revision that leaves an invalidated node's descendants current", async () => {
    const definition: WorkflowDefinition = {
      id: "closed-node-revision",
      name: "Closed node revision",
      version: "1.0.0",
      nodes: [
        {
          id: "assets",
          label: "Assets",
          capability: "asset.prepare",
          mode: "automatic",
          execute: () => ({ output: { assetPlanPath: "/tmp/asset-plan.json" } }),
        },
        {
          id: "render",
          label: "Render",
          capability: "video.render",
          mode: "automatic",
          dependsOn: ["assets"],
          execute: () => ({ output: { videoPath: "/tmp/video.mp4" } }),
        },
        {
          id: "final-review",
          label: "Final review",
          capability: "quality.review.human",
          mode: "manual",
          dependsOn: ["render"],
          execute: () => ({
            status: "needs_human",
            intervention: {
              reason: "Review",
              requiredAction: "approve",
              options: ["approve", "request_changes", "reject"],
            },
          }),
        },
      ],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds() });
    const waiting = await runner.run(definition, {});
    const assets = waiting.nodeRuns.find((node) => node.nodeId === "assets")!;

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan.json" },
        artifacts: [],
        retainedArtifactIds: [],
        invalidateDescendantNodeIds: ["render"],
        expectedVersionId: assets.outputState!.effectiveVersionId,
        decision: {
          interventionId: waiting.interventions.at(-1)!.id,
          action: "request_changes",
          actor: "director",
        },
      }),
      /must include descendant 'final-review'/,
    );

    assert.throws(
      () => runner.applyNodeRevision(definition, waiting, {
        nodeId: "assets",
        actor: "director",
        output: { assetPlanPath: "/tmp/asset-plan.json" },
        artifacts: [],
        retainedArtifactIds: [],
        invalidateDescendantNodeIds: [],
        expectedVersionId: assets.outputState!.effectiveVersionId,
        decision: {
          interventionId: waiting.interventions.at(-1)!.id,
          action: "request_changes",
          actor: "director",
        },
      }),
      /must invalidate the node with the active intervention/,
    );
  });

  it("cannot mark a run succeeded by overriding one leaf while another node is stale", async () => {
    const definition: WorkflowDefinition = {
      id: "independent-stale-leaf",
      name: "Independent stale leaf",
      version: "1.0.0",
      nodes: [{
        id: "left",
        label: "Left",
        capability: "left",
        mode: "automatic",
        getInput: () => ({ value: "left" }),
        execute: (input) => ({ output: input }),
      }, {
        id: "right",
        label: "Right",
        capability: "right",
        mode: "automatic",
        getInput: () => ({ value: "right" }),
        execute: (input) => ({ output: input }),
      }],
    };
    const runner = new WorkflowRunner();
    const generated = await runner.run(definition, {});
    const oneStale = runner.applyNodeInputOverride(definition, generated, {
      nodeId: "right",
      actor: "editor",
      input: { value: "human right" },
      allowTerminalEdit: true,
    });
    const stillStale = runner.applyNodeOverride(definition, oneStale, {
      nodeId: "left",
      actor: "editor",
      output: { value: "human left" },
    });

    assert.equal(stillStale.status, "stale");
    assert.equal(stillStale.nodeRuns.find((node) => node.nodeId === "right")?.status, "stale");
  });

  it("requires explicit review before replacing a stale human output", async () => {
    const definition: WorkflowDefinition = {
      id: "stale-human-output",
      name: "Stale human output",
      version: "1.0.0",
      nodes: [{
        id: "source",
        label: "Source",
        capability: "source",
        mode: "automatic",
        execute: () => ({ output: { value: "one" } }),
      }, {
        id: "script",
        label: "Script",
        capability: "script",
        mode: "automatic",
        dependsOn: ["source"],
        getInput: (context) => context.outputs.get("source"),
        execute: (input) => ({ output: input }),
      }],
    };
    const runner = new WorkflowRunner();
    const generated = await runner.run(definition, {});
    const humanScript = runner.applyNodeOverride(definition, generated, {
      nodeId: "script",
      actor: "editor",
      output: { value: "human script" },
      allowTerminalEdit: true,
    });
    const sourceChanged = runner.applyNodeOverride(definition, humanScript, {
      nodeId: "source",
      actor: "editor",
      output: { value: "two" },
      allowTerminalEdit: true,
    });

    await assert.rejects(
      () => runner.resumeStale(definition, sourceChanged),
      /stale human output.*reviewed.*discarded/i,
    );
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

  it("new metered providers default to manual approval and pause for an exact spend plan", async () => {
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

  it("metered manual provider pauses for an immutable spend authorization", async () => {
    let paidCalls = 0;
    let itemCostCny = 1.2;
    const registry = new ProviderRegistry();
    registry.register({
      id: "shot-router",
      label: "Shot router",
      modelId: "router-v2",
      capability: "asset.prepare",
      transport: "local_process",
      billing: "metered",
      approvalPolicy: "manual",
      estimatedCostCny: 48,
      maxCostCny: 48,
      maxAttempts: 1,
      quoteSpend: (input) => {
        const shots = (input as { shots: Array<{ scenePosition: number }> }).shots;
        return {
          estimatedCostCny: shots.length * itemCostCny,
          maxCostCny: shots.length * itemCostCny,
          items: shots.map((shot) => ({
            id: `scene-${shot.scenePosition}`,
            label: `镜头 ${shot.scenePosition}`,
            providerId: "seedance-video-v1",
            modelId: "seedance-v1",
            estimatedCostCny: itemCostCny,
          })),
        };
      },
      run: () => {
        paidCalls += 1;
        return { assetPlanPath: "assets.json" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "quoted-assets",
      name: "Quoted assets",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "shot-router",
        mode: "automatic",
        getInput: () => ({ shots: [{ scenePosition: 1 }, { scenePosition: 2 }, { scenePosition: 3 }] }),
      }],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });

    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.equal(paidCalls, 0);
    assert.equal(plan?.estimatedCostCny, 3.6);
    assert.equal(plan?.maxCostCny, 3.6);
    assert.deepEqual(plan?.items, [
      { id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 1.2 },
      { id: "scene-2", label: "镜头 2", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 1.2 },
      { id: "scene-3", label: "镜头 3", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 1.2 },
    ]);

    assert.ok(plan);
    const originalPlan = structuredClone(plan);
    itemCostCny = 1.5;
    const invalidated = await runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    });

    assert.equal(invalidated.status, "approval_invalidated");
    assert.equal(paidCalls, 0);
    assert.deepEqual(paused.nodeRuns[0]?.spendPlan, originalPlan);
    assert.notEqual(invalidated.nodeRuns[0]?.spendPlan?.id, plan.id);
    assert.equal(invalidated.nodeRuns[0]?.spendPlan?.estimatedCostCny, 4.5);
    assert.deepEqual(invalidated.nodeRuns[0]?.spendPlan?.items?.map((item) => item.estimatedCostCny), [1.5, 1.5, 1.5]);
  });

  it("rejects duplicate spend quote item ids before invoking a paid provider", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "duplicate-quote-router",
      modelId: "router-v1",
      capability: "asset.prepare",
      billing: "metered",
      approvalPolicy: "manual",
      estimatedCostCny: 2,
      maxCostCny: 2,
      maxAttempts: 1,
      quoteSpend: () => ({
        estimatedCostCny: 2,
        maxCostCny: 2,
        items: [
          { id: "scene-1", label: "镜头 1", providerId: "seedance-video-v1", modelId: "seedance-v1", estimatedCostCny: 1 },
          { id: "scene-1", label: "镜头 1 重复", providerId: "seedream-image-v1", modelId: "seedream-v1", estimatedCostCny: 1 },
        ],
      }),
      run: () => {
        calls += 1;
        return { assetPlanPath: "never.json" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "duplicate-spend-items",
      name: "Duplicate spend items",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "duplicate-quote-router",
        mode: "automatic",
      }],
    };

    const failed = await new WorkflowRunner({ providers: registry }).run(definition, {});

    assert.equal(failed.status, "failed");
    assert.match(failed.nodeRuns[0]?.error ?? "", /unique item ids/i);
    assert.equal(calls, 0);
  });

  it("metered automatic provider executes without a spend plan and keeps a metered receipt", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "automatic-voice",
      label: "Automatic voice",
      modelId: "voice-v2",
      capability: "voice.synthesize",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.4,
      maxCostCny: 0.4,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { uri: "voice.mp3" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "automatic-metered-voice",
      name: "Automatic metered voice",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "automatic-voice",
        mode: "automatic",
      }],
    };

    const completed = await new WorkflowRunner({
      clock,
      idFactory: deterministicIds(),
      providers: registry,
    }).run(definition, {});

    const nodeRun = completed.nodeRuns[0];
    assert.equal(completed.status, "succeeded");
    assert.equal(calls, 1);
    assert.equal(nodeRun?.spendPlan, undefined);
    assert.equal(nodeRun?.spendAuthorizationId, undefined);
    assert.deepEqual(completed.spendAuthorizations, []);
    assert.equal(nodeRun?.executionReceipt?.billing, "metered");
    assert.equal(nodeRun?.executionReceipt?.spendAuthorizationId, undefined);
    assert.equal(nodeRun?.executionReceipt?.meteredAttemptCount, 1);
  });

  it("metered automatic provider remains bounded by its declared attempt limit", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "automatic-assets",
      modelId: "assets-v2",
      capability: "asset.prepare",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.8,
      maxCostCny: 0.8,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { ok: true };
      },
    });
    const definition: WorkflowDefinition = {
      id: "bounded-automatic-assets",
      name: "Bounded automatic assets",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "automatic-assets",
        mode: "automatic",
        execute: async (input, context) => {
          const provider = context.resolveProvider({
            capability: "asset.prepare",
            providerId: "automatic-assets",
          });
          await provider.run(input, context);
          await provider.run(input, context);
          return { output: { ok: true } };
        },
      }],
    };

    const failed = await new WorkflowRunner({ providers: registry }).run(definition, {});
    const nodeRun = failed.nodeRuns[0];

    assert.equal(failed.status, "failed");
    assert.equal(calls, 1);
    assert.equal(nodeRun?.spendPlan, undefined);
    assert.equal(nodeRun?.outcomeUncertain, true);
    assert.match(nodeRun?.error ?? "", /automatic attempt limit/);
    assert.equal(nodeRun?.executionReceipt?.billing, "metered");
    assert.equal(nodeRun?.executionReceipt?.meteredAttemptCount, 1);
    assert.equal(nodeRun?.executionReceipt?.spendAuthorizationId, undefined);
  });

  it("does not accept a stale manual authorization after a provider becomes automatic", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    const provider = (approvalPolicy: "manual" | "automatic"): Provider => ({
      id: "changing-voice",
      modelId: "voice-v2",
      capability: "voice.synthesize",
      billing: "metered",
      approvalPolicy,
      estimatedCostCny: 0.4,
      maxCostCny: 0.4,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { uri: "voice.mp3" };
      },
    });
    registry.register(provider("manual"));
    const definition: WorkflowDefinition = {
      id: "changing-voice-policy",
      name: "Changing voice policy",
      version: "1.0.0",
      nodes: [{
        id: "voice",
        label: "Voice",
        capability: "voice.synthesize",
        providerId: "changing-voice",
        mode: "automatic",
      }],
    };
    const runner = new WorkflowRunner({ providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;
    assert.ok(plan);
    registry.replace(provider("automatic"));

    await assert.rejects(() => runner.authorizeSpend(definition, paused, {
      nodeId: plan.nodeId,
      inputVersionIds: plan.inputVersionIds,
      providerId: plan.providerId,
      modelId: plan.modelId,
      maxCostCny: plan.maxCostCny,
      maxAttempts: plan.maxAttempts,
      approvedBy: "producer",
    }), /no longer requires manual spend approval/);
    assert.equal(calls, 0);
    assert.deepEqual(paused.spendAuthorizations, []);
  });

  it("metered none policy fails closed instead of bypassing spend approval", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "misconfigured-paid-review",
      modelId: "review-v1",
      capability: "quality.review",
      billing: "metered",
      approvalPolicy: "none",
      estimatedCostCny: 0.5,
      maxCostCny: 0.5,
      maxAttempts: 1,
      run: () => {
        calls += 1;
        return { approved: true };
      },
    });
    const definition: WorkflowDefinition = {
      id: "misconfigured-metered-review",
      name: "Misconfigured metered review",
      version: "1.0.0",
      nodes: [{
        id: "review",
        label: "Review",
        capability: "quality.review",
        providerId: "misconfigured-paid-review",
        mode: "automatic",
      }],
    };

    const paused = await new WorkflowRunner({ providers: registry }).run(definition, {});

    assert.equal(paused.status, "awaiting_spend_approval");
    assert.equal(paused.nodeRuns[0]?.status, "awaiting_spend_approval");
    assert.ok(paused.nodeRuns[0]?.spendPlan);
    assert.equal(calls, 0);
  });

  it("runs a metered-capable node without approval only when its resolved quote is explicitly free", async () => {
    let calls = 0;
    const registry = new ProviderRegistry();
    registry.register({
      id: "conditional-router",
      label: "Conditional router",
      modelId: "router-v2",
      capability: "asset.prepare",
      transport: "local_process",
      billing: "metered",
      estimatedCostCny: 2.4,
      maxCostCny: 2.4,
      maxAttempts: 1,
      quoteSpend: () => ({
        estimatedCostCny: 0,
        maxCostCny: 0,
        requiresAuthorization: false,
      }),
      run: (_input, context) => {
        calls += 1;
        assert.equal(context.spendAuthorization, undefined);
        return { assetPlanPath: "free-assets.json" };
      },
    });
    const definition: WorkflowDefinition = {
      id: "free-router-plan",
      name: "Free router plan",
      version: "1.0.0",
      nodes: [{
        id: "assets",
        label: "Assets",
        capability: "asset.prepare",
        providerId: "conditional-router",
        mode: "automatic",
      }],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });

    const completed = await runner.run(definition, {});

    assert.equal(completed.status, "succeeded");
    assert.equal(calls, 1);
    assert.equal(completed.nodeRuns[0]?.spendPlan, undefined);
    assert.deepEqual(completed.spendAuthorizations, []);
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.billing, "free");
    assert.equal(completed.nodeRuns[0]?.executionReceipt?.estimatedCostCny, 0);
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

  it("replans a stopped node after an execution configuration override without calling either provider", async () => {
    let paidCalls = 0;
    const registry = new ProviderRegistry();
    for (const [id, modelId, estimatedCostCny] of [
      ["video-a", "model-a", 1],
      ["video-b", "model-b", 2],
    ] as const) {
      registry.register({
        id,
        label: id,
        modelId,
        capability: "asset.prepare",
        transport: "http_api",
        billing: "metered",
        configurationSource: id === "video-b" ? "node_override" : "run_override",
        estimatedCostCny,
        maxCostCny: 4,
        maxAttempts: 1,
        run: () => {
          paidCalls += 1;
          return { assetIds: [id] };
        },
      });
    }
    const definition = (providerId: string): WorkflowDefinition => ({
      id: "configurable-video",
      name: "Configurable video",
      version: "1.0.0",
      nodes: [{ id: "assets", label: "Assets", capability: "asset.prepare", mode: "automatic", providerId }],
    });
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const waiting = await runner.run(definition("video-a"), { selected: "video-a" });

    const updated = runner.applyExecutionConfigurationOverride(
      definition("video-b"),
      waiting,
      { nodeId: "assets", actor: "producer", initialInput: { selected: "video-b" } },
    );

    assert.equal(paidCalls, 0);
    assert.equal(updated.status, "stale");
    assert.equal(updated.nodeRuns[0]?.status, "stale");
    assert.equal(updated.nodeRuns[0]?.spendPlan, undefined);
    assert.deepEqual(updated.spendAuthorizations, []);
    assert.equal(updated.executionPlan?.find((plan) => plan.nodeId === "assets")?.providerId, "video-b");
    assert.equal(updated.executionPlan?.find((plan) => plan.nodeId === "assets")?.modelId, "model-b");
    assert.equal(updated.executionPlan?.find((plan) => plan.nodeId === "assets")?.configurationSource, "node_override");
  });

  it("does not fabricate actual usage when a successful metered provider omits it", async () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: "paid-review-without-usage",
      label: "Paid review without usage",
      modelId: "review-v2",
      capability: "quality.review",
      transport: "http_api",
      billing: "metered",
      estimatedCostCny: 0.6,
      maxCostCny: 1,
      maxAttempts: 1,
      run: () => ({ approved: true }),
    });
    const definition: WorkflowDefinition = {
      id: "metered-receipt-fallback",
      name: "Metered receipt fallback",
      version: "1.0.0",
      nodes: [{
        id: "review",
        label: "Review",
        capability: "quality.review",
        mode: "automatic",
        providerId: "paid-review-without-usage",
      }],
    };
    const runner = new WorkflowRunner({ clock, idFactory: deterministicIds(), providers: registry });
    const paused = await runner.run(definition, {});
    const plan = paused.nodeRuns[0]?.spendPlan;
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

    const receipt = completed.nodeRuns[0]?.executionReceipt;
    assert.equal(receipt?.estimatedCostCny, 0.6);
    assert.equal(receipt?.actualCostCny, undefined);
    assert.equal(receipt?.actualCostSource, undefined);
    assert.equal(receipt?.meteredAttemptCount, undefined);
    assert.equal(receipt?.meteredFailedAttemptCount, undefined);
    assert.equal(receipt?.actualModelIds, undefined);
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
