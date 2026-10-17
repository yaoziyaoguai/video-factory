import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowRun } from "@video-factory/workflow-core";
import { ProductionPipeline, PythonWorkerClient, type ProductionBrief, type ProductionPaidNodeReconciliationDraft,
  type ProductionPipelineOptions, type WorkerResponse } from "../../src/index.js";
import { explicitEditorialDirector, localEditorialAssetProvider } from "../../src/cli.js";

export interface R4VoiceItem {
  groupId: string;
  itemRequestId: string;
  state: string;
  stateHistory: string[];
  actualCostCny?: number;
  actualCostSource?: string;
  localPath?: string;
  metadataPath?: string;
  sha256?: string;
  sizeBytes?: number;
  synthesisKey: string;
  reusedFromOperationId?: string;
  reusedFromItemRequestId?: string;
  responseItemRequestId?: string;
  notChargedSettlement?: { reconciliationId: string; settledAt: string };
}

export interface R4VoiceLedger {
  version: string;
  operationId: string;
  completed: boolean;
  actualCostCny?: number;
  actualCostSource?: string;
  items: R4VoiceItem[];
  terminalEvidence?: { source: string; reconciliation?: { reconciliationId: string; settledItemRequestIds: string[] } };
}

export interface R4Reconciliation {
  status: string;
  reconciliationId: string;
  runId?: string;
  operationId?: string;
  nodeId: string;
  outcome: string;
  settledItemRequestIds?: string[];
  expectedRunRevision: number;
  resultingRunRevision?: number;
}

export interface R4Snapshot {
  run: WorkflowRun<ProductionBrief>;
  runSha256: string;
  ledgers: R4VoiceLedger[];
  ledgerSha256: Record<string, string>;
  media: Record<string, { sha256: string; sizeBytes: number }>;
  calls: Array<{ pid: number; mode: string; text: string; itemRequestId: string; rejected: boolean }>;
  workerEvents: Array<{ pid: number; kind: string; capability?: string; index?: number; interrupted?: boolean }>;
  hostEvents: Array<{ pid: number; kind: string; point?: string }>;
  reconciliation?: R4Reconciliation;
  reconciliationSha256?: string;
}

export interface R4Stage {
  phase: string;
  pid: number;
  node: string;
  sources: Record<string, string>;
  sourcesAfter: Record<string, string>;
  error?: string;
  snapshot: R4Snapshot;
}

interface Command {
  runId: string;
  operationId: string;
  draft: ProductionPaidNodeReconciliationDraft;
}

type Scenario = "explicit-rejection" | "local-interruption";
type CrashPoint = "record-before-ledger" | "ledger-before-run" | "run-before-completed";
const [phase, root, scenario, point] = process.argv.slice(2) as [string, string, Scenario, CrashPoint | undefined];
if (!root || !["setup", "crash", "retry", "resume"].includes(phase)
  || !["explicit-rejection", "local-interruption"].includes(scenario)) throw new Error("Invalid R4 child arguments.");
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sourceFiles = ["packages/production-pipeline/src/production-pipeline.ts", "src/video_factory/group_voiceover.py",
  "src/video_factory/voiceover.py", "src/video_factory/worker.py"];
const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const productSources = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) =>
  [file, digest(await readFile(path.join(repositoryRoot, file)))] as const)));
const sources = await productSources();
const callsPath = path.join(root, "r4-provider-calls.jsonl");
const workerEventsPath = path.join(root, "r4-worker-events.jsonl");
const hostEventsPath = path.join(root, "r4-host-events.jsonl");
const commandPath = path.join(root, "r4-command.json");
const record = (event: Record<string, unknown>) => appendFileSync(hostEventsPath, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const workerMode = phase === "setup" ? scenario === "explicit-rejection" ? "reject-second" : "local-interruption" : "ok";
const workerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", NO_PROXY: "*", no_proxy: "*" };
for (const key of ["SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
  if (process.env[key] !== undefined) workerEnv[key] = process.env[key];
}
const client = new PythonWorkerClient({
  command: [process.env.VIDEO_FACTORY_PYTHON ?? "python3", "-I", "-B",
    fileURLToPath(new URL("./voice-r4-worker.py", import.meta.url)), path.join(repositoryRoot, "src"),
    callsPath, workerEventsPath, workerMode],
  cwd: repositoryRoot, env: workerEnv, timeoutMs: 60_000,
});
const options: ProductionPipelineOptions = {
  workspaceRoot: root, executionLeaseStaleMs: 5_000, executionLeaseHeartbeatMs: 1_000,
  worker: {
    async run(request): Promise<WorkerResponse> {
      const response = await client.run(request);
      record({ kind: "worker-response", capability: request.capability, status: response.status });
      if (request.capability === "voice.synthesize" && workerMode === "local-interruption") {
        record({ kind: "lost-worker-response" });
        throw new Error("R4 fixture: transport lost after the real worker durably stopped before group 2.");
      }
      return response;
    },
    forecastPaidVoiceSpend: (request) => client.forecastPaidVoiceSpend(request),
  },
  directorAgent: explicitEditorialDirector, assetProviders: [localEditorialAssetProvider],
  screenwriterAgent: {
    id: "codex-screenwriter-v1", modelId: "r4-isolated-screenwriter",
    async draft() {
      return {   canonFacts: ["受控素材"],
        scenes: [1, 2, 3, 4, 5].map(position => ({ position, duration: 5,
          narration: position % 2 ? `第${position}组说话。` : "……", visual_strategy: "local",
          visual_prompt: `第${position}个说明卡片`, search_terms: [`说明${position}`] })) };
    },
  },
  providerRuntimeMetadata: [{ id: "minimax-tts-v1", label: "MiniMax", modelId: "speech-2.8-turbo",
    transport: "http_api", billing: "metered", approvalPolicy: "automatic", estimatedCostCny: 0.5, maxAttempts: 1 }],
};
const subject = new ProductionPipeline(options);
await mkdir(root, { recursive: true });
record({ kind: "process-start", phase, sources });

const ledgerPath = (command: Command) => path.join(root, "runs", command.runId, "nodes", "voice", ".voice-operations",
  `${createHash("sha256").update(command.operationId).digest("hex")}.json`);
const reconciliationPath = (command: Command) => path.join(root, "runs", command.runId, ".paid-reconciliations",
  `${createHash("sha256").update(command.draft.reconciliationId).digest("hex")}.json`);
async function optionalBytes(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
const jsonLines = async (file: string) => (await optionalBytes(file))?.toString("utf8").trim().split("\n")
  .filter(Boolean).map(line => JSON.parse(line)) ?? [];

async function snapshot(command: Command): Promise<R4Snapshot> {
  const runRoot = path.join(root, "runs", command.runId);
  const runBytes = await readFile(path.join(runRoot, "run.json"));
  const directory = path.dirname(ledgerPath(command));
  const records = await Promise.all((await readdir(directory)).filter(file => file.endsWith(".json")).sort().map(async file => {
    const bytes = await readFile(path.join(directory, file));
    return { ledger: JSON.parse(bytes.toString("utf8")) as R4VoiceLedger, hash: digest(bytes) };
  }));
  const media: R4Snapshot["media"] = {};
  for (const { ledger } of records) for (const item of ledger.items) for (const file of [item.localPath, item.metadataPath]) {
    if (file && !media[file]) {
      const bytes = await optionalBytes(file);
      if (bytes) media[file] = { sha256: digest(bytes), sizeBytes: bytes.length };
    }
  }
  const reconciliationBytes = await optionalBytes(reconciliationPath(command));
  return { run: JSON.parse(runBytes.toString("utf8")), runSha256: digest(runBytes),
    ledgers: records.map(record => record.ledger), ledgerSha256: Object.fromEntries(records.map(record => [record.ledger.operationId, record.hash])),
    media, calls: await jsonLines(callsPath), workerEvents: await jsonLines(workerEventsPath), hostEvents: await jsonLines(hostEventsPath),
    ...(reconciliationBytes ? { reconciliation: JSON.parse(reconciliationBytes.toString("utf8")), reconciliationSha256: digest(reconciliationBytes) } : {}) };
}

if (phase === "setup") {
  const brief = JSON.parse(await readFile(path.join(repositoryRoot, "examples/briefs/life-avoidance-local.json"), "utf8"));
  let run = await subject.start({ ...brief, durationRange: { minSeconds: 20, maxSeconds: 34 },
    providers: { ...brief.providers, script: "codex-screenwriter-v1", voice: "minimax-tts-v1" },
    voiceDirection: { profileId: "minimax:female-chengshu", rate: 190, pauseScale: 1, masteringPreset: "natural" },
    workflowFeatures: { boundaryGates: "user-confirmed-v1", executablePlan: true, assetSemanticRank: false, referenceGrammar: false } });
  for (let step = 0; step < 10 && !run.nodeRuns.some(node => node.nodeId === "assets" && node.status === "needs_human"); step++) {
    const gate = run.nodeRuns.find(node => node.status === "needs_human");
    assert.ok(gate?.intervention, JSON.stringify(run.nodeRuns));
    run = await subject.decide(run.id, { interventionId: gate.intervention.id, action: "approve", actor: "r4-e2e-owner",
      expectedRunRevision: run.revision, reviewEvidenceId: null });
  }
  const preview = await subject.previewNarrationPlan(run.id);
  assert.equal(preview.plan.groups.length, 3);
  const confirmed = await subject.confirmNarrationPlan(run.id, { expectedRunRevision: run.revision, plan: preview.plan, actor: "r4-e2e-owner" });
  record({ kind: "confirmed-narration-plan", groupIds: preview.plan.groups.map(group => group.id) });
  const gate = confirmed.nodeRuns.find(node => node.nodeId === "assets")?.intervention;
  assert.ok(gate);
  const failed = await subject.decide(run.id, { interventionId: gate.id, action: "approve", actor: "r4-e2e-owner",
    expectedRunRevision: confirmed.revision, reviewEvidenceId: null });
  const voice = failed.nodeRuns.find(node => node.nodeId === "voice");
  assert.equal(voice?.status, "failed", JSON.stringify(failed.nodeRuns));
  assert.ok(voice.operationRequestId);
  const command: Command = { runId: run.id, operationId: voice.operationRequestId,
    draft: { nodeId: "voice", expectedRunRevision: failed.revision, reconciliationId: "r4-e2e-not-charged",
      outcome: "confirmed_not_charged", actor: "r4-e2e-owner", note: "受控服务商确认：仅第 1 组已发送，后两组未收费。" } };
  await writeFile(commandPath, JSON.stringify(command));
}
const command: Command = JSON.parse(await readFile(commandPath, "utf8"));
if (phase === "crash") {
  assert.ok(point && ["record-before-ledger", "ledger-before-run", "run-before-completed"].includes(point));
  // 注入点只观察真实持久化边界；SIGKILL 不运行 finally，也不删除租约或补写产品数据。
  const crash = async () => {
    record({ kind: "crash", point });
    await writeFile(path.join(root, "r4-crash-stage.json"), JSON.stringify({ phase, pid: process.pid, node: process.version,
      sources, sourcesAfter: await productSources(), snapshot: await snapshot(command) } satisfies R4Stage));
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  };
  if (point === "record-before-ledger") {
    const seam = subject as unknown as { assertExecutionLease(...args: unknown[]): Promise<void> };
    const assertLease = seam.assertExecutionLease.bind(subject);
    seam.assertExecutionLease = async (...args) => {
      await assertLease(...args);
      const bytes = await optionalBytes(reconciliationPath(command));
      if (!bytes || (JSON.parse(bytes.toString("utf8")) as R4Reconciliation).status !== "in_progress") return;
      const ledger = JSON.parse(await readFile(ledgerPath(command), "utf8")) as R4VoiceLedger;
      if (!ledger.terminalEvidence?.reconciliation) await crash();
    };
  } else {
    const seam = subject as unknown as { store: { save(run: WorkflowRun<ProductionBrief>, revision: number): Promise<void> } };
    const save = seam.store.save.bind(seam.store);
    seam.store.save = async (run, revision) => {
      if (point === "run-before-completed") await save(run, revision);
      await crash();
    };
  }
  await subject.reconcilePaidNode(command.runId, command.draft);
  throw new Error(`R4 crash point '${point}' was not reached.`);
}
let error: string | undefined;
if (phase === "retry") {
  try { await subject.retryFailedNode(command.runId, "voice"); }
  catch (cause) { error = String(cause); }
} else if (phase === "resume") {
  await subject.reconcilePaidNode(command.runId, command.draft);
}
console.log(JSON.stringify({ phase, pid: process.pid, node: process.version, sources, sourcesAfter: await productSources(),
  ...(error ? { error } : {}), snapshot: await snapshot(command) } satisfies R4Stage));
