import { createHash } from "node:crypto";
import type { CodexTaskKind, CodexTaskSession } from "./codex-chat.js";

export const TASK_BINDING_VERSION = "video-factory/task-binding-v1" as const;

export interface CodexBrokerBinding {
  version: typeof TASK_BINDING_VERSION;
  storeId: string;
  providerId: string;
  modelId: string;
}

export interface CodexTaskBinding extends CodexBrokerBinding {
  requestDigest: string;
  kind: CodexTaskKind;
  contractDigest: string | null;
  sessionDigest: string;
}

export function requestDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function sessionDigest(session: CodexTaskSession | undefined): string {
  return sha256(canonicalJson(session ? { key: session.key, handle: session.handle ?? null } : null));
}

export function taskBinding(input: {
  request: unknown;
  broker: CodexBrokerBinding;
  kind: CodexTaskKind;
  contractDigest?: string;
  session?: CodexTaskSession;
}): CodexTaskBinding {
  return {
    ...input.broker,
    requestDigest: requestDigest(input.request),
    kind: input.kind,
    contractDigest: input.contractDigest ?? null,
    sessionDigest: sessionDigest(input.session),
  };
}

export function taskBindingHeaders(binding: CodexTaskBinding): Record<string, string> {
  return {
    "x-video-factory-binding-version": binding.version,
    "x-video-factory-store-id": binding.storeId,
    "x-video-factory-provider-id": binding.providerId,
    "x-video-factory-model-id": binding.modelId,
    "x-video-factory-request-digest": binding.requestDigest,
    "x-video-factory-task-kind": binding.kind,
    "x-video-factory-contract-digest": binding.contractDigest ?? "none",
    "x-video-factory-session-digest": binding.sessionDigest,
  };
}

export function parseTaskBinding(value: unknown): CodexTaskBinding {
  if (!isRecord(value)
    || value.version !== TASK_BINDING_VERSION
    || !isStoreId(value.storeId)
    || !isIdentifier(value.providerId)
    || !isIdentifier(value.modelId)
    || !isDigest(value.requestDigest)
    || !isTaskKind(value.kind)
    || (value.contractDigest !== null && !isDigest(value.contractDigest))
    || !isDigest(value.sessionDigest)) {
    throw new Error("Codex task binding is invalid.");
  }
  return value as unknown as CodexTaskBinding;
}

export function sameTaskBinding(left: CodexTaskBinding, right: CodexTaskBinding): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function parseBrokerBinding(value: unknown, kind: CodexTaskKind, payload: unknown): CodexBrokerBinding {
  if (!isRecord(value)
    || value.protocolVersion !== "video-factory/codex-bridge-v2"
    || value.taskBindingVersion !== TASK_BINDING_VERSION
    || !isStoreId(value.storeId)
    || !isIdentifier(value.providerId)) {
    throw new Error("Codex broker does not support immutable task binding.");
  }
  const taskModels = isRecord(value.taskModels) ? value.taskModels : undefined;
  const taskModelRoutes = parseTaskModelRoutes(value.taskModelRoutes);
  if (value.taskModelRoutes !== undefined && taskModelRoutes === undefined) {
    throw new Error("Codex broker task model routes are invalid.");
  }
  const route = taskModelRoutes?.[kind];
  const selectedModel = route
    ? (hasRouteImages(kind, payload) ? route.withImages : route.withoutImages)
    : taskModels?.[kind] ?? value.modelId;
  if (!isIdentifier(selectedModel)) throw new Error(`Codex broker has no model identity for '${kind}'.`);
  return {
    version: TASK_BINDING_VERSION,
    storeId: value.storeId,
    providerId: value.providerId,
    modelId: selectedModel,
  };
}

/**
 * broker 在 /health 里公告的已审核候选模型：请求方只能在这张表里选，选的模型随信封的
 * brokerBinding.modelId 送给 broker，broker 会独立再校验一遍。这里读出来只是为了让
 * "这个模型不在候选表里"在提交前就以可读的方式暴露出来——客户端不是安全边界。
 */
export function brokerModelCandidates(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.modelCandidates)) return [];
  return value.modelCandidates.filter((entry): entry is string => typeof entry === "string");
}

function parseTaskModelRoutes(value: unknown): Partial<Record<CodexTaskKind, { withoutImages: string; withImages: string }>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const result: Partial<Record<CodexTaskKind, { withoutImages: string; withImages: string }>> = {};
  for (const [kind, route] of Object.entries(value)) {
    if ((kind !== "role-audit" && kind !== "asset-rank")
      || !isRecord(route)
      || Object.keys(route).some((key) => key !== "withoutImages" && key !== "withImages")
      || !isIdentifier(route.withoutImages)
      || !isIdentifier(route.withImages)) return undefined;
    result[kind] = { withoutImages: route.withoutImages, withImages: route.withImages };
  }
  return result;
}

function hasRouteImages(kind: CodexTaskKind, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (kind === "role-audit") return Array.isArray(payload.images) && payload.images.length > 0;
  if (kind === "asset-rank") return Array.isArray(payload.thumbnails) && payload.thumbnails.length > 0;
  return false;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\r\n\t]/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isStoreId(value: unknown): value is string {
  return typeof value === "string" && /^vfs_store_[a-f0-9]{32}$/.test(value);
}

function isTaskKind(value: unknown): value is CodexTaskKind {
  return typeof value === "string" && [
    "topic-ideas", "series-roadmap", "creative-treatment", "director-plan", "script-draft",
    "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit", "creative-discussion",
  ].includes(value);
}
