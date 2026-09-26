import { fork, type ChildProcess } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CODEX_BRIDGE_PROTOCOL_VERSION, type CodexTaskKind } from "../../../../packages/production-pipeline/src/codex-chat.js";
import { taskBinding, type CodexBrokerBinding } from "../../../../packages/production-pipeline/src/codex-task-binding.js";

// 本地协议夹具：只模拟外部模型结果；socket、受理文件、Studio、Pipeline和子进程都是真实的。
export async function documentSocket(workspaceRoot: string, output: unknown) {
  const socketPath = path.join(workspaceRoot, "b.sock");
  const resultFile = path.join(workspaceRoot, "broker-result.json");
  const accepted = Promise.withResolvers<void>();
  const posts: Record<string, unknown>[] = [];
  let holdResponse = false;
  let queryMode: "complete" | "failure" | "running" | "unknown" | "conflict" = "complete";
  const broker: CodexBrokerBinding = { version: "video-factory/task-binding-v1", storeId: `vfs_store_${"b".repeat(32)}`,
    providerId: "controlled", modelId: "chosen-document-model" };
  const respond = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.url === "/health") {
        respond(response, 200, { protocolVersion: CODEX_BRIDGE_PROTOCOL_VERSION, taskBindingVersion: broker.version,
          ...broker, modelCandidates: [broker.modelId] });
        return;
      }
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        posts.push(envelope);
        const binding = taskBinding({ request: envelope, broker, kind: envelope.kind as CodexTaskKind,
          contractDigest: envelope.expectedContractDigest as string });
        const result = { state: "completed_success", ok: true, requestId: envelope.requestId, binding, output: JSON.stringify(output),
          trace: { taskKind: envelope.kind, promptVersion: "document-test-v1", prompt: "controlled fixture",
            contractDigest: envelope.expectedContractDigest, providerId: broker.providerId, modelId: broker.modelId,
            modelAttemptCount: 2, structuredRepairCount: 1, queueWaitMs: 0, providerWaitMs: 35 } };
        await writeFile(resultFile, JSON.stringify(result));
        accepted.resolve();
        if (holdResponse) return; // 已受理后不回包，由父测试杀掉调用方进程。
        respond(response, 202, { state: "running", requestId: envelope.requestId, binding });
        return;
      }
      let result: Record<string, unknown>;
      try { result = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const header = (field: string) => request.headers[`x-video-factory-${field}`];
        respond(response, 200, { state: "not_accepted", requestId: decodeURIComponent(request.url!.split("/").at(-1)!),
          binding: { ...broker, requestDigest: header("request-digest"), kind: header("task-kind"),
            contractDigest: header("contract-digest") === "none" ? null : header("contract-digest"), sessionDigest: header("session-digest") } });
        return;
      }
      if (queryMode === "failure") { respond(response, 503, { error: "query unavailable" }); return; }
      if (queryMode === "conflict") { respond(response, 409, { error: "binding_conflict" }); return; }
      respond(response, 200, queryMode === "complete" ? result : { state: queryMode === "running" ? "running" : "accepted_unknown",
        requestId: result.requestId, binding: result.binding });
    })().catch((error) => respond(response, 500, { error: error instanceof Error ? error.message : String(error) }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { socketPath, posts, accepted: accepted.promise,
    hold: () => { holdResponse = true; }, query: (mode: typeof queryMode) => { queryMode = mode; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

export async function startDocumentChild(config: {
  workspaceRoot: string; socketPath: string; nodeId: string; action: string; mode: string; input: unknown;
}) {
  const configPath = path.join(config.workspaceRoot, `child-${config.mode}.json`);
  await writeFile(configPath, JSON.stringify(config));
  const child = fork(path.join(import.meta.dirname, "document-command-child.ts"), [configPath],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const message = Promise.withResolvers<{ stage: string; message?: string }>();
  child.once("message", (value) => message.resolve(value as { stage: string; message?: string }));
  const exited = once(child, "exit");
  child.once("exit", (code, signal) => message.resolve({ stage: "exit", message: `${code}/${signal}\n${output}` }));
  return { child, message: message.promise, exited, output: () => output };
}

export async function killDocumentChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
