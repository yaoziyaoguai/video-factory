import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { BROKER_TASK_KINDS, type BrokerTaskKind } from "./task-definitions.js";

export const TASK_BINDING_VERSION = "video-factory/task-binding-v1" as const;

export interface ExpectedBrokerBinding {
  version: typeof TASK_BINDING_VERSION;
  storeId: string;
  providerId: string;
  modelId: string;
}

export interface DurableTaskBinding extends ExpectedBrokerBinding {
  requestDigest: string;
  kind: BrokerTaskKind;
  contractDigest: string | null;
  sessionDigest: string;
}

const QUERY_HEADERS = {
  version: "x-video-factory-binding-version",
  storeId: "x-video-factory-store-id",
  providerId: "x-video-factory-provider-id",
  modelId: "x-video-factory-model-id",
  requestDigest: "x-video-factory-request-digest",
  kind: "x-video-factory-task-kind",
  contractDigest: "x-video-factory-contract-digest",
  sessionDigest: "x-video-factory-session-digest",
} as const;

export function requestDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function sessionDigest(session: { key: string; handle?: string } | undefined): string {
  return sha256(canonicalJson(session ? { key: session.key, handle: session.handle ?? null } : null));
}

export function expectedBrokerBinding(value: unknown): ExpectedBrokerBinding | undefined {
  if (!isRecord(value) || value.brokerBinding === undefined) return undefined;
  if (!isRecord(value.brokerBinding)) throw new Error("Codex broker binding must be an object.");
  const binding = value.brokerBinding;
  if (Object.keys(binding).some((key) => !["version", "storeId", "providerId", "modelId"].includes(key))
    || binding.version !== TASK_BINDING_VERSION
    || !isStoreId(binding.storeId)
    || !isIdentifier(binding.providerId)
    || !isIdentifier(binding.modelId)) {
    throw new Error("Codex broker binding is invalid.");
  }
  return binding as unknown as ExpectedBrokerBinding;
}

export function durableTaskBinding(input: {
  request: unknown;
  storeId: string;
  providerId: string;
  modelId: string;
  kind: BrokerTaskKind;
  contractDigest?: string;
  session?: { key: string; handle?: string };
}): DurableTaskBinding {
  return {
    version: TASK_BINDING_VERSION,
    storeId: input.storeId,
    providerId: input.providerId,
    modelId: input.modelId,
    requestDigest: requestDigest(input.request),
    kind: input.kind,
    contractDigest: input.contractDigest ?? null,
    sessionDigest: sessionDigest(input.session),
  };
}

export function queryBinding(headers: IncomingHttpHeaders): DurableTaskBinding | undefined {
  const version = header(headers, QUERY_HEADERS.version);
  const storeId = header(headers, QUERY_HEADERS.storeId);
  const providerId = header(headers, QUERY_HEADERS.providerId);
  const modelId = header(headers, QUERY_HEADERS.modelId);
  const requestDigestValue = header(headers, QUERY_HEADERS.requestDigest);
  const kind = header(headers, QUERY_HEADERS.kind);
  const contractDigestValue = header(headers, QUERY_HEADERS.contractDigest);
  const sessionDigestValue = header(headers, QUERY_HEADERS.sessionDigest);
  if ([version, storeId, providerId, modelId, requestDigestValue, kind, contractDigestValue, sessionDigestValue]
    .every((value) => value === undefined)) return undefined;
  const contractDigest = contractDigestValue === "none" ? null : contractDigestValue;
  if (version !== TASK_BINDING_VERSION
    || !isStoreId(storeId)
    || !isIdentifier(providerId)
    || !isIdentifier(modelId)
    || !isDigest(requestDigestValue)
    || !isTaskKind(kind)
    || (contractDigest !== null && !isDigest(contractDigest))
    || !isDigest(sessionDigestValue)) {
    throw new Error("Codex task query binding is invalid.");
  }
  return {
    version,
    storeId,
    providerId,
    modelId,
    requestDigest: requestDigestValue,
    kind,
    contractDigest,
    sessionDigest: sessionDigestValue,
  };
}

export function taskBindingHeaders(binding: DurableTaskBinding): Record<string, string> {
  return {
    [QUERY_HEADERS.version]: binding.version,
    [QUERY_HEADERS.storeId]: binding.storeId,
    [QUERY_HEADERS.providerId]: binding.providerId,
    [QUERY_HEADERS.modelId]: binding.modelId,
    [QUERY_HEADERS.requestDigest]: binding.requestDigest,
    [QUERY_HEADERS.kind]: binding.kind,
    [QUERY_HEADERS.contractDigest]: binding.contractDigest ?? "none",
    [QUERY_HEADERS.sessionDigest]: binding.sessionDigest,
  };
}

export function sameTaskBinding(left: DurableTaskBinding, right: DurableTaskBinding): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function isDurableTaskBinding(value: unknown): value is DurableTaskBinding {
  if (!isRecord(value)) return false;
  return value.version === TASK_BINDING_VERSION
    && isStoreId(value.storeId)
    && isIdentifier(value.providerId)
    && isIdentifier(value.modelId)
    && isDigest(value.requestDigest)
    && isTaskKind(value.kind)
    && (value.contractDigest === null || isDigest(value.contractDigest))
    && isDigest(value.sessionDigest);
}

export function isStoreId(value: unknown): value is string {
  return typeof value === "string" && /^vfs_store_[a-f0-9]{32}$/.test(value);
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

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
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

function isTaskKind(value: unknown): value is BrokerTaskKind {
  return typeof value === "string" && (BROKER_TASK_KINDS as readonly string[]).includes(value);
}
