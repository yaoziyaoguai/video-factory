import { spawn } from "node:child_process";
import { WORKER_PROTOCOL_VERSION } from "./contracts.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface PythonWorkerClientOptions {
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface WorkerArtifactDescriptor {
  kind: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  provenance: {
    providerId: string;
    producerNodeId: string;
    attempt: number;
    licenseNote: string;
    sourceUrl?: string;
    creator?: string;
  };
}

export interface WorkerResponse {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  commandId: string;
  status: "succeeded" | "failed" | "rejected";
  output?: Record<string, unknown>;
  artifacts: WorkerArtifactDescriptor[];
  error?: { code: string; message: string };
  diagnostics?: Record<string, unknown>;
}

export class PythonWorkerClient {
  constructor(private readonly options: PythonWorkerClientOptions) {
    if (!options.command.length || !options.command[0]) {
      throw new Error("Python worker command cannot be empty.");
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error("Python worker timeoutMs must be a positive integer.");
    }
  }

  async run(request: Record<string, unknown>): Promise<WorkerResponse> {
    const [executable, ...args] = this.options.command;
    if (!executable) {
      throw new Error("Python worker command cannot be empty.");
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.options.cwd,
        detached: process.platform !== "win32",
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputExceeded = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, this.options.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          outputExceeded = true;
          killProcessTree(child.pid);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
          outputExceeded = true;
          killProcessTree(child.pid);
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Python worker timed out after ${this.options.timeoutMs}ms.`));
          return;
        }
        if (outputExceeded) {
          reject(new Error(`Python worker output exceeded ${MAX_OUTPUT_BYTES} bytes.`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Python worker exited with code ${String(code)}: ${stderr.trim()}`));
          return;
        }

        try {
          resolve(parseWorkerResponse(stdout, request.commandId));
        } catch (error) {
          reject(error);
        }
      });

      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

function parseWorkerResponse(stdout: string, expectedCommandId: unknown): WorkerResponse {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Python worker must write exactly one JSON response; received ${lines.length} lines.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0] ?? "");
  } catch (error) {
    throw new Error(`Python worker did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) {
    throw new Error("Python worker response must be a JSON object.");
  }
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported worker response protocolVersion: ${String(value.protocolVersion)}.`);
  }
  if (typeof expectedCommandId !== "string" || !expectedCommandId) {
    throw new Error("Worker request commandId must be a non-empty string.");
  }
  if (typeof value.commandId !== "string" || value.commandId !== expectedCommandId) {
    throw new Error(`Worker response commandId '${String(value.commandId)}' does not match the request.`);
  }
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "rejected") {
    throw new Error(`Unsupported worker response status: ${String(value.status)}.`);
  }
  if (!Array.isArray(value.artifacts)) {
    throw new Error("Worker response artifacts must be an array.");
  }
  const artifacts = value.artifacts.map((artifact, index) => parseArtifactDescriptor(artifact, index));
  const response: WorkerResponse = {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    commandId: value.commandId,
    status: value.status,
    artifacts,
  };
  if (value.output !== undefined) {
    if (!isRecord(value.output)) {
      throw new Error("Worker response output must be a JSON object when present.");
    }
    response.output = value.output;
  }
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
      throw new Error("Worker response error must contain string code and message fields.");
    }
    response.error = { code: value.error.code, message: value.error.message };
  }
  if (value.diagnostics !== undefined) {
    if (!isRecord(value.diagnostics)) {
      throw new Error("Worker response diagnostics must be a JSON object when present.");
    }
    response.diagnostics = value.diagnostics;
  }
  return response;
}

function parseArtifactDescriptor(value: unknown, index: number): WorkerArtifactDescriptor {
  if (!isRecord(value)) {
    throw new Error(`Worker artifact ${index} must be a JSON object.`);
  }
  const prefix = `Worker artifact ${index}`;
  if (typeof value.kind !== "string" || !value.kind) {
    throw new Error(`${prefix} kind must be a non-empty string.`);
  }
  if (typeof value.uri !== "string" || !value.uri) {
    throw new Error(`${prefix} uri must be a non-empty string.`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) {
    throw new Error(`${prefix} sha256 must be a 64-character hexadecimal digest.`);
  }
  if (!Number.isInteger(value.sizeBytes) || Number(value.sizeBytes) < 0) {
    throw new Error(`${prefix} sizeBytes must be a non-negative integer.`);
  }
  if (typeof value.contentType !== "string" || !value.contentType) {
    throw new Error(`${prefix} contentType must be a non-empty string.`);
  }
  if (!isRecord(value.provenance)) {
    throw new Error(`${prefix} provenance must be a JSON object.`);
  }
  const provenance = value.provenance;
  if (
    typeof provenance.providerId !== "string"
    || typeof provenance.producerNodeId !== "string"
    || !Number.isInteger(provenance.attempt)
    || Number(provenance.attempt) < 1
    || typeof provenance.licenseNote !== "string"
  ) {
    throw new Error(`${prefix} provenance is incomplete.`);
  }
  return {
    kind: value.kind,
    uri: value.uri,
    sha256: value.sha256,
    sizeBytes: Number(value.sizeBytes),
    contentType: value.contentType,
    provenance: {
      providerId: provenance.providerId,
      producerNodeId: provenance.producerNodeId,
      attempt: Number(provenance.attempt),
      licenseNote: provenance.licenseNote,
      ...(optionalArtifactText(provenance.sourceUrl, `${prefix} provenance sourceUrl`) ? { sourceUrl: optionalArtifactText(provenance.sourceUrl, `${prefix} provenance sourceUrl`)! } : {}),
      ...(optionalArtifactText(provenance.creator, `${prefix} provenance creator`) ? { creator: optionalArtifactText(provenance.creator, `${prefix} provenance creator`)! } : {}),
    },
  };
}

function optionalArtifactText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGKILL");
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch (error) {
    if (!hasCode(error, "ESRCH")) {
      throw error;
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
