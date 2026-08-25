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
