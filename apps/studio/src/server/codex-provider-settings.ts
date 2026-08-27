import http from "node:http";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { CODEX_BRIDGE_PROTOCOL_VERSION } from "@video-factory/production-pipeline";

export const DEFAULT_CODEX_SOCKET_PATH = "/run/video-factory-codex/worker.sock";
export const DEFAULT_ZAI_CODEX_SOCKET_PATH = "/run/video-factory-zai-codex/worker.sock";

export type CodexSocketStatus =
  | "ready"
  | "missing"
  | "not_a_socket"
  | "inaccessible"
  | "unreachable"
  | "protocol_mismatch"
  | "identity_mismatch";

const CODEX_HEALTH_TIMEOUT_MS = 1_000;
const CODEX_HEALTH_MAX_BYTES = 16 * 1024;

export interface CodexSocketResolution {
  socketPath: string;
  configured: boolean;
  requirement: string;
}

export interface CodexProviderSettings {
  socketPath: string;
  configured: boolean;
  available: boolean;
  requirement: string;
  reason: string;
}

export interface CodexProviderSettingsOptions {
  socketProbe?: (socketPath: string) => Promise<CodexSocketStatus>;
}

interface CodexHealthIdentity {
  profileId: string;
  providerId: string;
  modelId: string;
  taskKinds: readonly string[];
}

// 同步层：只解析 env 与默认路径，供 provider catalog 等同步调用方使用。
export function resolveCodexSocketPath(environment: NodeJS.ProcessEnv): CodexSocketResolution {
  const configured = environment.VIDEO_FACTORY_CODEX_SOCKET_PATH?.trim() ?? "";
  return {
    socketPath: configured || DEFAULT_CODEX_SOCKET_PATH,
    configured: configured.length > 0,
    requirement: "需要宿主机 Codex bridge 服务正在监听，并将 VIDEO_FACTORY_CODEX_SOCKET_PATH 指向该 Unix socket。",
  };
}

export function resolveZaiCodexSocketPath(environment: NodeJS.ProcessEnv): CodexSocketResolution {
  const configured = environment.VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH?.trim() ?? "";
  return {
    socketPath: configured || DEFAULT_ZAI_CODEX_SOCKET_PATH,
    configured: configured.length > 0,
    requirement: "需要 ZAI visual-review broker 正在监听，并将 VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH 指向该 Unix socket。",
  };
}

// 异步层：先验证文件类型与权限，再通过 Unix socket 请求 /health 并核对协议版本。
export async function readCodexProviderSettings(
  environment: NodeJS.ProcessEnv,
  options: CodexProviderSettingsOptions = {},
): Promise<CodexProviderSettings> {
  const resolution = resolveCodexSocketPath(environment);
  return readProviderSettings(resolution, {
    profileId: "openai",
    providerId: "openai",
    modelId: environment.VIDEO_FACTORY_CODEX_MODEL?.trim() || "codex-default",
    taskKinds: ["topic-ideas", "director-plan", "script-draft", "publish-copy", "visual-review"],
  }, options);
}

export async function readZaiCodexProviderSettings(
  environment: NodeJS.ProcessEnv,
  options: CodexProviderSettingsOptions = {},
): Promise<CodexProviderSettings> {
  return readProviderSettings(resolveZaiCodexSocketPath(environment), {
    profileId: "zai",
    providerId: "zai-coding-plan",
    modelId: "glm-5.3-flash",
    taskKinds: ["visual-review"],
  }, options);
}

async function readProviderSettings(
  resolution: CodexSocketResolution,
  expectedIdentity: CodexHealthIdentity | undefined,
  options: CodexProviderSettingsOptions,
): Promise<CodexProviderSettings> {
  const probe = options.socketProbe ?? ((socketPath) => probeCodexSocket(socketPath, expectedIdentity));
  const status = await probe(resolution.socketPath);
  const available = status === "ready";
  return {
    socketPath: resolution.socketPath,
    configured: resolution.configured,
    available,
    requirement: resolution.requirement,
    reason: available ? "" : codexUnavailableReason(status, resolution.socketPath),
  };
}

async function probeCodexSocket(
  socketPath: string,
  expectedIdentity?: CodexHealthIdentity,
): Promise<CodexSocketStatus> {
  let stats: Stats;
  try {
    stats = await stat(socketPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM"
      ? "inaccessible"
      : "missing";
  }
  if (!stats.isSocket()) return "not_a_socket";
  try {
    await access(socketPath, constants.W_OK);
  } catch {
    return "inaccessible";
  }
  return probeCodexHealth(socketPath, expectedIdentity);
}

function codexUnavailableReason(status: CodexSocketStatus, socketPath: string): string {
  if (status === "not_a_socket") return `'${socketPath}' 存在但不是 Unix socket。`;
  if (status === "inaccessible") return `当前进程对 '${socketPath}' 没有写权限；请检查宿主机侧 socket 的组权限。`;
  if (status === "unreachable") return `Codex bridge socket '${socketPath}' 存在，但健康检查无法连接。`;
  if (status === "protocol_mismatch") return `Codex bridge socket '${socketPath}' 使用了不兼容的协议版本。`;
  if (status === "identity_mismatch") return `Codex bridge socket '${socketPath}' 的模型身份或任务权限与预期不一致。`;
  return `未找到 Codex bridge socket '${socketPath}'；请确认宿主机 broker 已启动。`;
}

function probeCodexHealth(
  socketPath: string,
  expectedIdentity?: CodexHealthIdentity,
): Promise<CodexSocketStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status: CodexSocketStatus): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    const request = http.request({
      socketPath,
      path: "/health",
      method: "GET",
      timeout: CODEX_HEALTH_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      let oversized = false;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > CODEX_HEALTH_MAX_BYTES) {
          oversized = true;
          request.destroy();
          settle("protocol_mismatch");
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => settle("unreachable"));
      response.on("end", () => {
        if (oversized || response.statusCode !== 200) {
          settle(response.statusCode === 200 ? "protocol_mismatch" : "unreachable");
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (body.protocolVersion !== CODEX_BRIDGE_PROTOCOL_VERSION) {
            settle("protocol_mismatch");
            return;
          }
          settle(expectedIdentity && !matchesIdentity(body, expectedIdentity) ? "identity_mismatch" : "ready");
        } catch {
          settle("protocol_mismatch");
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      settle("unreachable");
    });
    request.on("error", () => settle("unreachable"));
    request.end();
  });
}

function matchesIdentity(body: Record<string, unknown>, expected: CodexHealthIdentity): boolean {
  if (
    body.profileId !== expected.profileId
    || body.providerId !== expected.providerId
    || body.modelId !== expected.modelId
    || !Array.isArray(body.taskKinds)
  ) return false;
  const actualKinds = new Set(body.taskKinds.filter((value): value is string => typeof value === "string"));
  return expected.taskKinds.every((value) => actualKinds.has(value));
}
