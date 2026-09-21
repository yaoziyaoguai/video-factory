import { spawn } from "node:child_process";
import { WORKER_PROTOCOL_VERSION } from "./contracts.js";
import { diagnosticEvent } from "./diagnostics.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_LINE = 8_192;

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
    creatorUrl?: string;
    previewUrl?: string;
    scenePosition?: number;
    notes?: string;
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
  /**
   * 素材试片在 worker 内已经物化、但不能继续提交后续付费任务时的结构化结果。
   * 这不是浏览器可以伪造的决定；ProductionPipeline 只接受 worker 已校验过的素材、报告和身份。
   */
  sourceReview?: SourceReviewOutcome;
}

export interface SourceReviewOutcome {
  kind: "complete_negative" | "incomplete";
  mediaSha256: string;
  inputFingerprint: string;
  operationId: string;
  scenePosition: number;
  /** 完整负面报告才有可供用户承担的证据身份。 */
  evidenceId?: string;
  reviewArtifactSha256?: string;
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
    const startedAt = performance.now();
    diagnosticEvent("worker.started", request);
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
      let diagnosticLine = "";
      let discardDiagnosticLine = false;
      let stderrBytes = 0;
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
        // stderr 只消费白名单事件；海量或无换行的诊断不得杀死已经付费的任务。
        stderrBytes += Buffer.byteLength(chunk);
        const parts = chunk.split("\n");
        for (const [index, part] of parts.entries()) {
          if (!discardDiagnosticLine) {
            diagnosticLine += part;
            if (Buffer.byteLength(diagnosticLine) > MAX_DIAGNOSTIC_LINE) {
              diagnosticLine = "";
              discardDiagnosticLine = true;
            }
          }
          if (index === parts.length - 1) break;
          const line = discardDiagnosticLine ? "" : diagnosticLine;
          diagnosticLine = "";
          discardDiagnosticLine = false;
          try {
            const entry: unknown = JSON.parse(line);
            if (isRecord(entry) && entry.component === "media-worker" && typeof entry.event === "string"
              && /^(stock\.[a-z_]+|worker\.execute)$/.test(entry.event)) {
              diagnosticEvent(entry.event, { ...entry, ...request, providerId: entry.provider, status: entry.state });
            }
          } catch { /* 原始异常可能含提示词、密钥或签名地址，不转发。 */ }
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        diagnosticEvent("worker.spawn_failed", { ...request, errorType: error.name, elapsedMs: performance.now() - startedAt });
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        diagnosticEvent("worker.process_finished", { ...request, exitCode: code, bytes: stderrBytes, elapsedMs: performance.now() - startedAt,
          status: timedOut ? "timeout" : outputExceeded ? "output_limit" : code === 0 ? "exited" : "failed" });
        if (timedOut) {
          reject(new Error(`Python worker timed out after ${this.options.timeoutMs}ms.`));
          return;
        }
        if (outputExceeded) {
          reject(new Error(`Python worker output exceeded ${MAX_OUTPUT_BYTES} bytes.`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`Python worker exited with code ${String(code)}. See structured worker stage diagnostics.`));
          return;
        }

        try {
          const response = parseWorkerResponse(stdout, request.commandId);
          diagnosticEvent("worker.result", { ...request, status: response.status, elapsedMs: performance.now() - startedAt });
          resolve(response);
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
  } catch {
    throw new Error("Python worker did not return valid JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Python worker response must be a JSON object.");
  }
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    throw new Error("Unsupported worker response protocolVersion.");
  }
  if (typeof expectedCommandId !== "string" || !expectedCommandId) {
    throw new Error("Worker request commandId must be a non-empty string.");
  }
  if (typeof value.commandId !== "string" || value.commandId !== expectedCommandId) {
    throw new Error("Worker response commandId does not match the request.");
  }
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "rejected") {
    throw new Error("Unsupported worker response status.");
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
  if (value.sourceReview !== undefined) {
    response.sourceReview = parseSourceReviewOutcome(value.sourceReview);
  }
  return response;
}

/** WorkerProvider 也会调用它，避免测试替身绕过子进程 parser 后把任意字段当成质量决定。 */
export function parseSourceReviewOutcome(value: unknown): SourceReviewOutcome {
  if (!isRecord(value)) throw new Error("Worker sourceReview must be a JSON object.");
  if (value.kind !== "complete_negative" && value.kind !== "incomplete") {
    throw new Error("Worker sourceReview kind is unsupported.");
  }
  if (typeof value.mediaSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.mediaSha256)) {
    throw new Error("Worker sourceReview mediaSha256 must be a SHA-256 digest.");
  }
  if (typeof value.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(value.inputFingerprint)) {
    throw new Error("Worker sourceReview inputFingerprint must be a SHA-256 digest.");
  }
  if (typeof value.operationId !== "string" || !value.operationId.trim() || value.operationId.length > 512) {
    throw new Error("Worker sourceReview operationId must be a non-empty string.");
  }
  if (!Number.isSafeInteger(value.scenePosition) || Number(value.scenePosition) < 1) {
    throw new Error("Worker sourceReview scenePosition must be a positive integer.");
  }
  const outcome: SourceReviewOutcome = {
    kind: value.kind,
    mediaSha256: value.mediaSha256.toLowerCase(),
    inputFingerprint: value.inputFingerprint.toLowerCase(),
    operationId: value.operationId,
    scenePosition: Number(value.scenePosition),
  };
  if (value.kind === "complete_negative") {
    if (typeof value.evidenceId !== "string" || !/^[a-f0-9]{64}$/i.test(value.evidenceId)) {
      throw new Error("Complete negative sourceReview must include an evidenceId SHA-256 digest.");
    }
    if (typeof value.reviewArtifactSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.reviewArtifactSha256)) {
      throw new Error("Complete negative sourceReview must include a reviewArtifactSha256 digest.");
    }
    outcome.evidenceId = value.evidenceId.toLowerCase();
    outcome.reviewArtifactSha256 = value.reviewArtifactSha256.toLowerCase();
  } else if (value.evidenceId !== undefined || value.reviewArtifactSha256 !== undefined) {
    throw new Error("Incomplete sourceReview must not claim a review evidence identity.");
  }
  return outcome;
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
      ...(optionalArtifactText(provenance.creatorUrl, `${prefix} provenance creatorUrl`) ? { creatorUrl: optionalArtifactText(provenance.creatorUrl, `${prefix} provenance creatorUrl`)! } : {}),
      ...(optionalArtifactText(provenance.previewUrl, `${prefix} provenance previewUrl`) ? { previewUrl: optionalArtifactText(provenance.previewUrl, `${prefix} provenance previewUrl`)! } : {}),
      ...(Number.isInteger(provenance.scenePosition) && Number(provenance.scenePosition) > 0
        ? { scenePosition: Number(provenance.scenePosition) }
        : {}),
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
