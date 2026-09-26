import { readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import {
  CodexBridgeClient, CodexPublishCopyWriter, CodexReferenceGrammarAgent, ProductionPipeline,
  type DocumentTaskContext,
} from "@video-factory/production-pipeline";
import { ProductionStudio } from "../../src/server/production-studio.js";

const config = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  workspaceRoot: string; socketPath: string; nodeId: "reference-grammar" | "publish-package";
  action: "revise" | "audit"; mode: string; input: {
    commandId: string; expectedRunRevision: number; expectedVersionId: string; instruction: string;
  };
};
const runId = "run-publish";
const runRoot = path.join(config.workspaceRoot, "runs", runId);
async function pause(stage: string): Promise<void> {
  if (config.mode !== stage) return;
  process.send?.({ stage });
  await new Promise<void>(() => { setInterval(() => {}, 1_000); });
}
function instrument(task: DocumentTaskContext | undefined): void {
  if (!task) throw new Error("Missing durable context");
  const prepare = task.beforeSubmit;
  const complete = task.onCompleted;
  task.beforeSubmit = async (operation) => { await prepare(operation); await pause("prepared"); };
  task.onCompleted = async (execution) => {
    await pause("execution-before");
    await complete(execution);
    await pause("execution-after");
  };
}
const pipeline = new ProductionPipeline({ workspaceRoot: config.workspaceRoot, referenceVideoRoot: runRoot,
  referenceGrammarAgent: { id: "codex-reference-grammar-v1", modelId: "controlled", analyze: async () => { throw new Error("unexpected initial generation"); } },
  screenwriterAgent: { id: "codex-screenwriter-v1", draft: async () => { throw new Error("unexpected script generation"); } },
  directorAgent: { id: "api-visual-director-v1", plan: async () => { throw new Error("unexpected direction"); } },
  treatmentAgents: [{ providerId: "controlled", agent: { id: "codex-creative-treatment-v1", modelId: "controlled",
    treat: async () => { throw new Error("unexpected treatment"); } } }],
  worker: { run: async () => { throw new Error("unexpected media production"); } },
});
const apply = pipeline.applyNodeOverride.bind(pipeline);
pipeline.applyNodeOverride = async (...args) => { const result = await apply(...args); await pause("commit"); return result; };
const audit = pipeline.recordNodeDocumentAudit.bind(pipeline);
pipeline.recordNodeDocumentAudit = async (...args) => { const result = await audit(...args); await pause("commit"); return result; };
const client = new CodexBridgeClient({ socketPath: config.socketPath, maxAttempts: 1, pollIntervalMs: 10 });
const writer = new CodexPublishCopyWriter({ client });
const reference = new CodexReferenceGrammarAgent({ client, media: { prepare: async () => {
  if (config.mode === "recover") throw new Error("恢复不得再次抽帧");
  await appendFile(path.join(config.workspaceRoot, "sampling.txt"), "sample\n");
  return { durationMs: 10_000, frames: [{ timecodeMs: 0, sha256: "a".repeat(64), jpegBase64: "/9j/" + "A".repeat(300_000) }] };
} } });
const studio = new ProductionStudio({ workspaceRoot: config.workspaceRoot, pipeline, listProviders: async () => [],
  archiveStore: { list: async () => ({}), archive: async () => {}, restore: async () => {} },
  documentCopyTools: {
    revise: (input) => { instrument(input.task); return writer.revise(input); },
    auditCurrent: (input) => { instrument(input.task); return writer.auditCurrent(input); },
    observeTask: (task) => writer.observeTask(task),
  },
  referenceGrammarTools: {
    id: reference.id,
    revise: (input) => { instrument(input.task); return reference.revise(input); },
    auditCurrent: (input) => { instrument(input.task); return reference.auditCurrent(input); },
    observeTask: (task) => reference.observeTask(task),
  },
});
try {
  if (config.action === "revise") await studio.reviseNodeDocument(runId, config.nodeId, config.input, "creator");
  else await studio.auditNodeDocumentCurrent(runId, config.nodeId, config.input, "creator");
  process.send?.({ stage: "done" });
} catch (error) {
  process.send?.({ stage: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  process.exitCode = 1;
} finally { process.disconnect?.(); }
