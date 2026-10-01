import { open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ProductionPipeline,
  PythonWorkerClient,
  parsePersistedBrief,
  type CreativeTreatmentAgent,
  type ProductionPipelineOptions,
  type ScreenwriterAgent,
  type VisualAssetProviderCapability,
  type VisualDirectorAgent,
  type WorkerResponse,
} from "@video-factory/production-pipeline";

type CrashPoint = "afterReservation" | "afterWorkerCompletion" | "afterAdoptionCheckpoint";

interface ChildConfig {
  workspaceRoot: string;
  runId: string;
  action: "apply" | "query";
  requestPath?: string;
  requestId: string;
  countPath: string;
  eventPath: string;
  resultPath: string;
  repositoryRoot: string;
  python: string;
  holdEnteredPath?: string;
  holdReleasePath?: string;
  crashPoint?: CrashPoint;
  crashExitCode?: number;
}

async function appendDurably(file: string, value: Record<string, unknown>): Promise<void> {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class CountingRelayoutWorker {
  constructor(
    private readonly delegate: PythonWorkerClient,
    private readonly countPath: string,
  ) {}

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const input = request.input;
    if (input && typeof input === "object" && !Array.isArray(input)
      && (input as Record<string, unknown>).relayout === true) {
      await appendDurably(this.countPath, {
        commandId: request.commandId,
        attempt: request.attempt,
        outputDir: request.outputDir,
        pid: process.pid,
      });
    }
    return this.delegate.run(request);
  }
}

function unavailableAgents(): Pick<ProductionPipelineOptions,
  "screenwriterAgent" | "directorAgent" | "treatmentAgents"> {
  const screenwriterAgent = {
    id: "codex-screenwriter-v1",
    modelId: "screenwriter-model-one",
    draft: async () => { throw new Error("crash harness must not execute script generation"); },
  } as ScreenwriterAgent;
  const directorAgent = {
    id: "api-visual-director-v1",
    modelId: "director-model-one",
    plan: async () => { throw new Error("crash harness must not execute visual direction"); },
  } as VisualDirectorAgent;
  const treatmentAgent = {
    id: "codex-creative-treatment-v1",
    modelId: "treatment-model-a",
    treat: async () => { throw new Error("crash harness must not execute treatment generation"); },
  } as CreativeTreatmentAgent;
  return { screenwriterAgent, directorAgent, treatmentAgents: [{ providerId: "openai", agent: treatmentAgent }] };
}

const ASSET_PROVIDERS: VisualAssetProviderCapability[] = [{
  id: "local-editorial-v1",
  label: "本地编辑卡片",
  billing: "free",
  modes: ["本地"],
  deliveryTypes: ["editorial_card"],
}];

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("crash child requires a config path");
  const config = JSON.parse(await readFile(configPath, "utf8")) as ChildConfig;
  const persisted = JSON.parse(await readFile(
    path.join(config.workspaceRoot, "runs", config.runId, "run.json"), "utf8"));
  parsePersistedBrief(persisted.initialInput);

  const python = new PythonWorkerClient({
    command: config.holdEnteredPath && config.holdReleasePath
      ? [config.python, path.join(config.repositoryRoot, "apps", "studio", "test", "helpers",
        "narration-relayout-hold-worker.py")]
      : [config.python, "-m", "video_factory.worker"],
    cwd: config.repositoryRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      PYTHONPATH: path.join(config.repositoryRoot, "src"),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ...(config.holdEnteredPath && config.holdReleasePath ? {
        VF_RELAYOUT_HOLD_ENTERED: config.holdEnteredPath,
        VF_RELAYOUT_HOLD_RELEASE: config.holdReleasePath,
      } : {}),
    },
    timeoutMs: 120_000,
  });
  const crash = async (point: CrashPoint) => {
    if (config.crashPoint !== point) return;
    await appendDurably(config.eventPath, { point, pid: process.pid });
    process.exit(config.crashExitCode ?? 90);
  };
  const pipeline = new ProductionPipeline({
    workspaceRoot: config.workspaceRoot,
    worker: new CountingRelayoutWorker(python, config.countPath),
    ...unavailableAgents(),
    assetProviders: ASSET_PROVIDERS,
    providerRuntimeMetadata: [{
      id: "minimax-tts-v1",
      label: "MiniMax",
      modelId: "speech-2.8-turbo",
      transport: "http_api",
      billing: "metered",
      approvalPolicy: "automatic",
      estimatedCostCny: 0.5,
      maxAttempts: 1,
    }],
    executionLeaseHeartbeatMs: 1_000,
    executionLeaseStaleMs: 2_500,
    narrationRelayoutFailpoints: {
      afterReservation: () => crash("afterReservation"),
      afterWorkerCompletion: () => crash("afterWorkerCompletion"),
      afterAdoptionCheckpoint: () => crash("afterAdoptionCheckpoint"),
    },
  });

  if (config.action === "query") {
    const operation = await pipeline.readNarrationRelayoutOperation(config.runId, config.requestId);
    await writeFile(config.resultPath, `${JSON.stringify({ operation })}\n`, "utf8");
    return;
  }
  if (!config.requestPath) throw new Error("apply action requires requestPath");
  const request = JSON.parse(await readFile(config.requestPath, "utf8"));
  const dispatched = await pipeline.dispatchNarrationRevision(config.runId, request);
  const run = await dispatched.completion;
  const voice = run.nodeRuns.find((node) => node.nodeId === "voice");
  await writeFile(config.resultPath, `${JSON.stringify({
    revision: run.revision,
    voiceVersionId: voice?.outputState?.effectiveVersionId,
    interventionId: voice?.intervention?.id,
    operation: await pipeline.readNarrationRelayoutOperation(config.runId, config.requestId),
  })}\n`, "utf8");
}

await main();
