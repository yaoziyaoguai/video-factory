import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBrokerServer } from "../../src/broker-server.js";
import { taskContractDescriptorFor } from "../../src/task-definitions.js";

const directory = process.argv[2];
if (!directory) throw new Error("Fixture directory is required.");
const socketPath = path.join(directory, "worker.sock");
const records = path.join(directory, "records");
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
const executor = {
  identity: { profileId: "audit", providerId: "openai", modelId: "fixture-model", taskKinds: ["topic-ideas"] },
  async runTask(task: { kind: "topic-ideas"; expectedContractDigest?: string }) {
    await gate;
    return {
      output: "{\"ideas\":[]}",
      trace: {
        taskKind: task.kind,
        promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
        contractDigest: task.expectedContractDigest,
        prompt: "fixture",
        providerId: "openai",
        modelId: "fixture-model",
      },
    };
  },
};
const broker = new CodexBrokerServer({ socketPath, executor: executor as never, idempotencyDirectory: records });
await broker.start();
const health = await request("GET", "/health");
const identity = JSON.parse(health.body) as { taskBindingVersion: string; storeId: string; providerId: string; modelId: string };
const body = JSON.stringify({
  protocolVersion: "video-factory/codex-bridge-v2",
  requestId: "completion-persistence-failure",
  kind: "topic-ideas",
  payload: { signals: [] },
  expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest,
  brokerBinding: {
    version: identity.taskBindingVersion,
    storeId: identity.storeId,
    providerId: identity.providerId,
    modelId: identity.modelId,
  },
});
const accepted = await request("POST", "/v1/tasks", body);
if (accepted.status !== 202) throw new Error(`Fixture expected 202, received ${accepted.status}.`);
const recordPath = path.join(records, `${createHash("sha256").update("completion-persistence-failure").digest("hex")}.json`);
await rm(recordPath);
await mkdir(recordPath);
release();
await delay(150);
await broker.close();
process.stdout.write("Broker survived completion persistence failure\n");

function request(method: string, requestPath: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
