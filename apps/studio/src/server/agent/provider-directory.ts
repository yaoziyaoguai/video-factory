import { providerAdapters, textBaseUrl } from "../../shared/agent/provider-capabilities.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AvailableProviderModels, ProviderConnection, ProviderDirectoryModel } from "../../shared/agent/generated/contracts.js";
import { AgentError } from "./errors.js";
import { findNativeTextModel, openaiChatCatalog } from "./text-model.js";
import { SEEDREAM_IMAGES, OPENAI_IMAGE_MODEL_IDS, OPENAI_SPEECH_MODEL_IDS, MINIMAX_SPEECH_MODEL_IDS, MINIMAX_VIDEO_MODEL_IDS, WAN_VIDEO_MODEL_IDS } from "./media-config.js";

interface DirectoryItem {
  id: string; name?: string; display_name?: string; status?: string; lifecycle?: string;
  task_type?: string[]; output_modalities?: string[]; modalities?: { output_modalities?: string[] };
  context_window?: number; max_output_tokens?: number;
  token_limits?: { context_window?: number; max_output_token_length?: number };
}
const stringArray = { type: "array", items: { type: "string" } };
const capacity = { type: "integer", minimum: 0 };
// 厂商响应只在此校验一次；未使用的扩展字段允许存在，不复制到产品契约。
const validatePage = new Ajv2020().compile<{ data: DirectoryItem[]; has_more?: boolean }>({
  type: "object", required: ["data"], properties: {
    has_more: { type: "boolean" },
    data: { type: "array", items: { type: "object", required: ["id"], properties: {
      id: { type: "string", minLength: 1 }, name: { type: "string" }, display_name: { type: "string" }, status: { type: "string" }, lifecycle: { type: "string" },
      task_type: stringArray, output_modalities: stringArray,
      modalities: { type: "object", properties: { output_modalities: stringArray } },
      context_window: capacity, max_output_tokens: capacity,
      token_limits: { type: "object", properties: { context_window: capacity, max_output_token_length: capacity } },
    } } },
  },
});

// 目录只核对账号可见 ID 与官方生命周期；能力来自 Pi 精确目录与已适配的媒体 profile（A2）。
// 同步是用户动作：更新可选列表，不自动选第一个、不改当前选择或冻结版本。
// MiniMax/万相没有已核实的账号级型号列表端点：不猜 /models 地址，同步返回本地已适配的
// 可执行型号目录（与 modelUnavailableReason 同一冻结集合），不把静态目录说成账号实时可见。
export async function readProviderDirectory(connection: ProviderConnection, fetcher: typeof fetch = fetch): Promise<AvailableProviderModels> {
  if (connection.protocol === "minimax" || connection.protocol === "wan") {
    const entries: { id: string; kind: ProviderDirectoryModel["kinds"][number] }[] = [];
    if (connection.protocol === "minimax") {
      for (const id of MINIMAX_SPEECH_MODEL_IDS) entries.push({ id, kind: "speech" });
      for (const id of MINIMAX_VIDEO_MODEL_IDS) entries.push({ id, kind: "video" });
    } else {
      for (const id of WAN_VIDEO_MODEL_IDS) entries.push({ id, kind: "video" });
    }
    return {
      models: entries.map(({ id, kind }) => ({
        id, name: id, kinds: [kind], status: "listed", contextWindowTokens: null, maxOutputTokens: null,
      })),
      hasMore: false, syncedAt: new Date().toISOString(),
    };
  }
  const payload = await fetchAccountModels(connection, fetcher, false);
  const models = new Map<string, ProviderDirectoryModel>();
  for (const item of payload.data) {
    models.set(item.id, connection.protocol === "openai"
      ? openaiDirectoryModel(item)
      : connection.protocol === "ark" ? arkDirectoryModel(item) : compatibleDirectoryModel(item, connection));
  }
  return { models: [...models.values()], hasMore: payload.has_more ?? false, syncedAt: new Date().toISOString() };
}

async function fetchAccountModels(connection: ProviderConnection, fetcher: typeof fetch, probe: boolean) {
  if (!providerAdapters[connection.protocol].accountDirectory) throw new AgentError("CAPABILITY_UNAVAILABLE", "此供应商未提供已接入的账户型号探测接口。");
  let payload: unknown;
  try {
    const anthropic = connection.protocol === "anthropic-messages";
    const url = new URL(connection.baseUrl + (anthropic ? "/v1/models" : "/models"));
    if (probe && anthropic) url.searchParams.set("limit", "1");
    if (!connection.apiKey) throw new AgentError("INVALID_INPUT", "请先保存 API Key。");
    const headers: Record<string, string> = anthropic
      ? { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${connection.apiKey}` };
    const response = await fetcher(url.href, {
      headers,
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new AgentError("TEMPORARILY_UNAVAILABLE", `供应商未返回型号列表（HTTP ${response.status}），请检查连接后重试。`);
    payload = await response.json();
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException)) throw error;
    throw new AgentError("TEMPORARILY_UNAVAILABLE", "同步型号失败，请检查地址与 Key；已选型号未改动。");
  }
  if (!validatePage(payload)) throw new AgentError("TEMPORARILY_UNAVAILABLE", "供应商的型号列表格式不受支持；已选型号未改动。");
  return payload;
}

export async function probeAccountModels(connection: ProviderConnection, fetcher: typeof fetch) {
  await fetchAccountModels(connection, fetcher, true);
  return { checkedAt: new Date().toISOString() };
}

// OpenAI /models 不带任务/模态字段：文本按 Pi 精确目录识别，图片/配音只认实际适配的
// profile 型号；Sora/Videos API 已于 2026-09-24 官方停用，不因目录残留名称显示为可用视频。
// Pi 不认识的其余型号一律 kinds:[]（尚未支持），不按 ID 前缀猜容量或推理。
function openaiDirectoryModel(item: DirectoryItem): ProviderDirectoryModel {
  const chat = openaiChatCatalog().get(item.id);
  const kinds: ProviderDirectoryModel["kinds"] = [];
  if (chat) kinds.push("text");
  if (OPENAI_IMAGE_MODEL_IDS.has(item.id)) kinds.push("image");
  if (OPENAI_SPEECH_MODEL_IDS.has(item.id)) kinds.push("speech");
  return {
    id: item.id, name: item.display_name ?? item.name ?? item.id, kinds,
    status: /^sora-/.test(item.id) ? "retired" : "listed",
    contextWindowTokens: chat?.contextWindow ?? null,
    maxOutputTokens: chat?.maxTokens ?? null,
  };
}

// 火山图片只列已接通报价和执行的具体型号；视频沿用厂商任务和模态。
function arkDirectoryModel(item: DirectoryItem): ProviderDirectoryModel {
  const tasks = item.task_type ?? [];
  const outputs = item.output_modalities ?? item.modalities?.output_modalities ?? [];
  const id = item.id.toLowerCase().split("/").at(-1)!;
  const isVideo = tasks.some(task => ["TextToVideo", "ImageToVideo", "TextToAudioVideo", "ImageToAudioVideo", "MultimodalToVideo", "VideoEditing", "VideoExtension"].includes(task))
    || outputs.includes("video")
    || (tasks.length === 0 && outputs.length === 0
      && (/^(doubao-seedance|minimax-hailuo)/.test(id) || /^wan.*(?:video|t2v|i2v|r2v|flf2v)/.test(id)));
  const image = SEEDREAM_IMAGES.get(item.id);
  const status = (item.lifecycle ?? item.status ?? "").toLowerCase();
  return {
    id: item.id, name: image?.name ?? item.display_name ?? item.name ?? item.id,
    kinds: image ? ["image"] : isVideo ? ["video"] : tasks.some(task => ["Chat", "TextGeneration", "TextToText"].includes(task)) || outputs.includes("text") ? ["text"] : [],
    status: ["shutdown", "retired"].includes(status) ? "retired" : ["retiring", "deprecated"].includes(status) ? "retiring" : "listed",
    contextWindowTokens: item.context_window || item.token_limits?.context_window || null,
    maxOutputTokens: item.max_output_tokens || item.token_limits?.max_output_token_length || null,
  };
}

function compatibleDirectoryModel(item: DirectoryItem, connection: ProviderConnection): ProviderDirectoryModel {
  const known = findNativeTextModel(providerAdapters[connection.protocol].textApi, item.id, textBaseUrl(connection.protocol, connection.baseUrl));
  // 兼容目录可能同时列出嵌入或媒体型号；只有厂商声明或 Pi 精确识别的才自动分类。
  const listed = arkDirectoryModel(item);
  const text = connection.protocol === "anthropic-messages" || known || listed.kinds.includes("text");
  return { ...listed, kinds: text ? ["text"] : [], contextWindowTokens: known?.contextWindow ?? listed.contextWindowTokens,
    maxOutputTokens: known?.maxTokens ?? listed.maxOutputTokens };
}
