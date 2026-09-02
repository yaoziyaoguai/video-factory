#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { HumanDecisionDraft, WorkflowRun } from "@video-factory/workflow-core";
import { ProductionPipeline } from "./production-pipeline.js";
import { PythonWorkerClient } from "./python-worker-client.js";
import type { VisualAssetProviderCapability, VisualDirectorAgent } from "./visual-director.js";

interface PipelineCommands {
  start(input: unknown): Promise<WorkflowRun>;
  show(runId: string): Promise<WorkflowRun>;
  decide(runId: string, decision: HumanDecisionDraft): Promise<WorkflowRun>;
}

export interface CliDependencies {
  createPipeline: (workspaceRoot: string) => PipelineCommands;
  stdout: (text: string) => void;
}

const EXPLICIT_EDITORIAL_DIRECTOR_ID = "explicit-editorial-director-v1";

// 部署 smoke 必须显式经过导演路由，不能靠素材失败降级出卡片。
const explicitEditorialDirector: VisualDirectorAgent = {
  id: EXPLICIT_EDITORIAL_DIRECTOR_ID,
  modelId: "rules-v1",
  plan: async (input) => ({
    version: "video-factory/director-plan-v1",
    requestedProfileId: input.brief.requestedProfileId,
    resolvedProfileId: "geometric-control",
    profileRationale: "部署 smoke 明确选择静态编辑画面，以验证离线媒体链路。",
    visualBible: {
      narrativeApproach: "每个场景使用一张完整静态画面。",
      pacing: "按脚本场景稳定推进。",
      composition: "统一竖屏信息构图。",
      camera: "整张画面保持静态。",
      color: "使用统一高对比配色。",
      continuity: "所有场景保持同一版式系统。",
      sound: "使用离线测试音轨。",
    },
    shots: input.scenes.map((scene) => {
      const midpoint = scene.duration / 2;
      return {
        scenePosition: scene.position,
        narrativeRole: "部署链路验证",
        authenticityPolicy: "illustrative",
        preferredProviderId: "local-editorial-v1",
        deliveryType: "editorial_card",
        alternativeProviderIds: [],
        temporalBeats: [
          `[0s-${midpoint}s] 保持完整静态画面`,
          `[${midpoint}s-${scene.duration}s] 保持统一版式`,
        ],
        query: scene.visualPrompt,
        generationPrompt: scene.visualPrompt,
        rationale: "部署 smoke 主动选择本地静态编辑画面。",
        continuityNote: "沿用统一版式。",
        confidence: 1,
        estimatedCostCny: 0,
      };
    }),
  }),
};

const localEditorialAssetProvider: VisualAssetProviderCapability = {
  id: "local-editorial-v1",
  label: "本地编辑卡片",
  billing: "free",
  modes: ["本地排版"],
  deliveryTypes: ["editorial_card"],
};

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = defaultDependencies(),
): Promise<number> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    dependencies.stdout(usage());
    return 0;
  }

  const workspaceRoot = path.resolve(optionValue(argv, "--workspace") ?? "workspace/factory");
  const positionals = positionalArguments(argv.slice(1));

  if (command === "run") {
    const briefPath = positionals[0];
    if (!briefPath) {
      throw new Error("factory run requires a brief JSON path.");
    }
    const brief = JSON.parse(await readFile(path.resolve(briefPath), "utf8")) as unknown;
    const run = await dependencies.createPipeline(workspaceRoot).start(brief);
    dependencies.stdout(JSON.stringify(runSummary(run, workspaceRoot)));
    return run.status === "failed" ? 1 : 0;
  }

  if (command === "show") {
    const runId = positionals[0];
    if (!runId) {
      throw new Error("factory show requires a run id.");
    }
    const run = await dependencies.createPipeline(workspaceRoot).show(runId);
    dependencies.stdout(JSON.stringify(run, null, 2));
    return 0;
  }

  if (command === "approve" || command === "reject") {
    const runId = positionals[0];
    if (!runId) {
      throw new Error(`factory ${command} requires a run id.`);
    }
    const actor = optionValue(argv, "--actor");
    if (!actor?.trim()) {
      throw new Error(`factory ${command} requires --actor <name>.`);
    }
    const note = optionValue(argv, "--note") ?? "";
    const pipeline = dependencies.createPipeline(workspaceRoot);
    const waiting = await pipeline.show(runId);
    if (waiting.status !== "needs_human") {
      throw new Error(`Run '${runId}' is not waiting for human input.`);
    }
    const intervention = waiting.nodeRuns.find((nodeRun) => nodeRun.status === "needs_human")?.intervention
      ?? waiting.interventions.at(-1);
    if (!intervention) {
      throw new Error(`Run '${runId}' has no active intervention.`);
    }
    const decision: HumanDecisionDraft = {
      interventionId: intervention.id,
      action: command,
      actor: actor.trim(),
      ...(note ? { note } : {}),
    };
    const run = await pipeline.decide(runId, decision);
    dependencies.stdout(JSON.stringify(runSummary(run, workspaceRoot)));
    return 0;
  }

  throw new Error(`Unknown factory command '${command}'.\n${usage()}`);
}

function defaultDependencies(): CliDependencies {
  return {
    createPipeline: (workspaceRoot) => {
      const repositoryRoot = process.cwd();
      const existingPythonPath = process.env.PYTHONPATH;
      const pythonPath = existingPythonPath
        ? `${path.join(repositoryRoot, "src")}${path.delimiter}${existingPythonPath}`
        : path.join(repositoryRoot, "src");
      const worker = new PythonWorkerClient({
        command: [process.env.VIDEO_FACTORY_PYTHON ?? "python3", "-m", "video_factory.worker"],
        cwd: repositoryRoot,
        env: { ...process.env, PYTHONPATH: pythonPath },
        timeoutMs: 20 * 60 * 1000,
      });
      return new ProductionPipeline({
        workspaceRoot,
        worker,
        directorAgent: explicitEditorialDirector,
        assetProviders: [localEditorialAssetProvider],
      });
    },
    stdout: (text) => process.stdout.write(`${text}\n`),
  };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function positionalArguments(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function runSummary(run: WorkflowRun, workspaceRoot: string): Record<string, unknown> {
  const activeIntervention = run.nodeRuns.find((nodeRun) => nodeRun.status === "needs_human")?.intervention;
  return {
    id: run.id,
    revision: run.revision,
    status: run.status,
    runPath: path.join(workspaceRoot, "runs", run.id, "run.json"),
    ...(activeIntervention ? { intervention: activeIntervention } : {}),
    artifacts: run.artifacts.map((artifact) => ({ id: artifact.id, kind: artifact.kind, uri: artifact.uri })),
  };
}

function usage(): string {
  return [
    "VideoFactory production CLI",
    "",
    "factory run <brief.json> [--workspace <path>]",
    "factory show <run-id> [--workspace <path>]",
    "factory approve <run-id> --actor <name> [--note <text>] [--workspace <path>]",
    "factory reject <run-id> --actor <name> [--note <text>] [--workspace <path>]",
  ].join("\n");
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  runCli(process.argv.slice(2)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
