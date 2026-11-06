import type { Bootstrap, ModelBinding } from "../../shared/agent/generated/contracts.js";
import { AgentError } from "./errors.js";
import { renderSlotRole } from "./render-inputs.js";
import { canonicalJson, digestOf } from "./util.js";
import { RENDER_CATALOG_KEY, type CatalogValidationContext, type QuoteCatalog, type QuoteCatalogEntry, type TrustedOperationInput } from "./artifact-store.js";

// C1 服务端媒体配置 + M2 三家视频扩展：Seedance（Ark）、MiniMax H3/H3-Max、阿里万相 3.0。
// profile 是唯一的非秘密执行配置；connectionId 属绑定身份，credentialFile 仅旧部署导入源。
// 同一份 profile 同时决定目录条目、参数校验、Bootstrap 描述与提交映射，不维护第二套常量。

/** 存量固定组合（v11/v12 冻结版本行，按原含义解析：恰好 5s/720p/16:9/无声）。 */
export interface AgentMediaVideoConfig {
  durationSeconds: number;
  aspectRatio: "16:9";
  resolution: "720p";
  audioMode: "none";
}

/** M2 参数化能力：整数时长区间 + 原声开关集合；单次操作仍明示具体时长。 */
export interface RangedVideoCapability {
  durationSecondsMin: number;
  durationSecondsMax: number;
  aspectRatio: "16:9";
  resolution: string;
  audioModes: ReadonlyArray<"none" | "native">;
}

export type VideoCapability = AgentMediaVideoConfig | RangedVideoCapability;

export const isRangedVideoCapability = (capability: VideoCapability): capability is RangedVideoCapability =>
  "durationSecondsMin" in capability;

export interface AgentMediaQuoteConfig {
  amountMinor: number;
  kind: "estimate";
  version: string;
  source: string;
  verifiedAt: string;
}

/** 参数化估价（M2 视频）：按冻结时长 × 分辨率单价计算；USD 站点带冻结换算率一次换算。 */
export interface RangedVideoQuoteConfig {
  kind: "estimate";
  /** CNY 原生站点的分/秒单价，按 resolution 小写键。 */
  perSecondMinor: Record<string, number>;
  /** USD 站点的美元/秒单价（api.minimax.io）；与 perSecondMinor 二选一。 */
  perSecondUsd: Record<string, number> | null;
  usdCny: number | null;
  version: string;
  source: string;
  verifiedAt: string;
}

export type VideoQuoteConfig = AgentMediaQuoteConfig | RangedVideoQuoteConfig;

export const isRangedVideoQuote = (quote: VideoQuoteConfig): quote is RangedVideoQuoteConfig =>
  "perSecondMinor" in quote || "perSecondUsd" in quote;

/** 单一口径的参数化每次尝试报价：与 artifact-store.operationQuoteMinor 的目录消费同式。 */
export function rangedQuoteMinor(quote: RangedVideoQuoteConfig, durationSeconds: number, resolution: string): number {
  const key = resolution.toLowerCase();
  if (quote.perSecondUsd && quote.usdCny) {
    const usd = quote.perSecondUsd[key];
    if (typeof usd !== "number") throw new Error(`报价表没有分辨率 ${resolution} 的单价。`);
    return Math.ceil(100 * quote.usdCny * durationSeconds * usd);
  }
  const minor = quote.perSecondMinor[key];
  if (typeof minor !== "number") throw new Error(`报价表没有分辨率 ${resolution} 的单价。`);
  return durationSeconds * minor;
}

/** 参数校验（M2 参数化通道共用）：整数时长区间、画幅/分辨率等于冻结值、原声开关属于能力集合。 */
export function validateRangedVideoParameters(capability: RangedVideoCapability, parameters: {
  durationSeconds: number; aspectRatio: string; resolution: string; audioMode: string;
}, channelLabel: string): void {
  if (!Number.isInteger(parameters.durationSeconds)
    || parameters.durationSeconds < capability.durationSecondsMin || parameters.durationSeconds > capability.durationSecondsMax) {
    throw new AgentError("CAPABILITY_UNAVAILABLE",
      `视频时长必须是 ${capability.durationSecondsMin}–${capability.durationSecondsMax} 的整数秒（${channelLabel}）。`);
  }
  if (parameters.aspectRatio !== capability.aspectRatio || parameters.resolution !== capability.resolution) {
    throw new AgentError("CAPABILITY_UNAVAILABLE",
      `视频参数与已核实的启用组合不一致（${capability.resolution}/${capability.aspectRatio}，${channelLabel}）。`);
  }
  if (!capability.audioModes.includes(parameters.audioMode as "none" | "native")) {
    throw new AgentError("CAPABILITY_UNAVAILABLE", `该通道不支持 ${parameters.audioMode} 原声模式（${channelLabel}）。`);
  }
}

/** 单份文字输入约束（三家 t2v 通道共用）。 */
export function requireSingleTextInput(op: { inputs: unknown[] }, inputs: TrustedOperationInput[] | undefined): void {
  if (!inputs) return;
  const input = inputs[0];
  if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
    throw new AgentError("INVALID_INPUT", "该视频通道只接受一份文字作为输入；多段合成请用独立 render 操作。");
  }
}

/** 存量固定组合版本行（v11/v12 冻结，按原含义解析：恰好 5s/720p/16:9/无声、定值报价）。 */
export interface LegacyArkVideoProfile {
  providerId: string;
  modelId: string;
  baseUrl: string;
  video: AgentMediaVideoConfig;
  quote: AgentMediaQuoteConfig;
}

/** M2 参数化版本行：时长区间 + 原声开关 + 按秒报价。两种形状不混用（能力与报价同形）。 */
export interface RangedArkVideoProfile {
  providerId: string;
  modelId: string;
  baseUrl: string;
  video: RangedVideoCapability;
  quote: RangedVideoQuoteConfig;
}

export type ArkVideoProfile = LegacyArkVideoProfile | RangedArkVideoProfile;

/** video/quote 同形是 profile 工厂与解析的不变量；一处收窄辅助，避免各消费点重复断言。 */
export function asRangedArkProfile(profile: ArkVideoProfile): RangedArkVideoProfile | null {
  return "durationSecondsMin" in profile.video ? profile as RangedArkVideoProfile : null;
}
export function asLegacyArkProfile(profile: ArkVideoProfile): LegacyArkVideoProfile | null {
  return "durationSeconds" in profile.video ? profile as LegacyArkVideoProfile : null;
}

export interface AgentMediaConfig extends LegacyArkVideoProfile {
  connectionId: string;
  credentialFile: string;
}

// C1 已核实的固定能力模板（agent-media.example.json 的非秘密事实）；网页首次配置不需要用户手工建 JSON。
// M2 起保存产生参数化能力（4–30s、none/native），存量固定行按原含义继续解析。
export const LEGACY_FIXED_ARK_VIDEO_PROFILE: LegacyArkVideoProfile = {
  providerId: "ark",
  modelId: "doubao-seedance-2-5-260628",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  video: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioMode: "none" },
  quote: { amountMinor: 756, kind: "estimate", version: "2026-10-public-pricing", source: "volcengine ark 官方定价页", verifiedAt: "2026-10-26" },
};

// 采价（2026-11-01 官方模型价格页，token 计费、completion_tokens 为准；每秒价为官方 16:9 输出示例）：
// 480p ¥0.67/s、720p ¥1.51/s、1080p ¥3.74/s。本包只启用 720p。
export const DEFAULT_ARK_VIDEO_PROFILE: RangedArkVideoProfile = {
  providerId: "ark",
  modelId: "doubao-seedance-2-5-260628",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  video: { durationSecondsMin: 4, durationSecondsMax: 30, aspectRatio: "16:9", resolution: "720p", audioModes: ["none", "native"] },
  quote: {
    kind: "estimate", perSecondMinor: { "720p": 151 }, perSecondUsd: null, usdCny: null,
    version: "2026-11-public-pricing", source: "volcengine ark 模型价格页（16:9 输出每秒示例价，token 计费）", verifiedAt: "2026-11-01",
  },
};

function requiredString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`媒体配置缺少有效字段 ${key}。`);
  return value.trim();
}

// OpenAI 媒体适配的固定型号范围（B1）：图片两个、配音两个共用各自协议实现，以 profile 的
// 精确 model 区分。目录同步只把这两个集合识别为 image/speech，未知新型号显示为尚未支持。
export const OPENAI_IMAGE_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
export const OPENAI_SPEECH_MODEL_IDS: ReadonlySet<string> = new Set(["gpt-realtime-2.1-mini", "gpt-realtime-2.1"]);

export function parseAgentMediaConfig(raw: unknown): AgentMediaConfig {
  if (typeof raw !== "object" || raw === null) throw new Error("媒体配置必须是 JSON 对象。");
  const record = raw as Record<string, unknown>;
  const quoteRaw = record.quote;
  if (typeof quoteRaw !== "object" || quoteRaw === null) throw new Error("媒体配置缺少 quote 报价信息。");
  const quote = quoteRaw as Record<string, unknown>;
  const baseUrl = requiredString(record, "baseUrl");
  if (!/^https:\/\/[^\s]+$/.test(baseUrl)) throw new Error("媒体配置 baseUrl 必须是官方 HTTPS 地址。");
  // 旧部署导入格式只承载固定组合（5s/720p/16:9/无声）；M2 参数化能力经统一连接保存产生。
  const legacy: AgentMediaVideoConfig = LEGACY_FIXED_ARK_VIDEO_PROFILE.video;
  const videoRaw = record.video as Record<string, unknown> | undefined;
  if (!videoRaw || videoRaw.durationSeconds !== legacy.durationSeconds || videoRaw.aspectRatio !== legacy.aspectRatio
    || videoRaw.resolution !== legacy.resolution || videoRaw.audioMode !== legacy.audioMode) {
    throw new Error("旧导入格式只接受 5 秒、720p、16:9、无声视频；新能力请用统一连接页配置。");
  }
  const amountMinor = quote.amountMinor;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("quote.amountMinor 必须是非负整数（分）。");
  if (quote.kind !== "estimate") throw new Error("本阶段报价必须是 estimate（供应商按 token 计费，无硬封顶）。");
  return {
    providerId: requiredString(record, "providerId"),
    connectionId: requiredString(record, "connectionId"),
    modelId: requiredString(record, "modelId"),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    credentialFile: requiredString(record, "credentialFile"),
    video: { ...legacy },
    quote: {
      amountMinor,
      kind: "estimate",
      version: requiredString(quote, "version"),
      source: requiredString(quote, "source"),
      verifiedAt: requiredString(quote, "verifiedAt"),
    },
  };
}

// 有效模型/账号身份/参数/报价任一变化都必须改变绑定修订；凭据文件路径与 Key 值不参与绑定身份。
// 显式列举身份字段：传入对象可能是含 credentialFile 的旧导入配置，不能整体展开进摘要。
export function mediaConfigurationRevisionId(profile: ArkVideoProfile, connectionId: string): string {
  const { providerId, modelId, baseUrl, video, quote } = profile;
  return `cfg-${digestOf({ providerId, modelId, baseUrl, video, quote, connectionId }).slice(0, 24)}`;
}

export function mediaBinding(profile: ArkVideoProfile, connectionId: string): ModelBinding {
  return {
    providerId: profile.providerId, modelId: profile.modelId,
    connectionId, configurationRevisionId: mediaConfigurationRevisionId(profile, connectionId),
  };
}

// 通道校验：已核实参数组合、单次创建尝试、恰好一份文字输入。存量固定行按原组合逐字比对；
// M2 参数化行走时长区间与原声开关校验。
export function arkVideoValidator(profile: ArkVideoProfile): NonNullable<QuoteCatalogEntry["validate"]> {
  return (op, inputs): void => {
    if (op.kind !== "video") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 video 操作。");
    if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
    if (isRangedVideoCapability(profile.video)) {
      validateRangedVideoParameters(profile.video, op.parameters, "Seedance");
      requireSingleTextInput(op, inputs);
      return;
    }
    if (canonicalJson(op.parameters) !== canonicalJson(profile.video)) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", `视频参数与已核实的启用组合不一致（${profile.video.durationSeconds}s/${profile.video.resolution}/${profile.video.aspectRatio}/${profile.video.audioMode}）。`);
    }
    if (!inputs) return;
    const input = inputs[0];
    if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
      throw new AgentError("INVALID_INPUT", "该视频通道只接受一份文字作为输入；多段合成请用独立 render 操作。");
    }
  };
}

// 真实本地 ordered_concat 校验：已有输入文件必须在付费前探测通过；声音方案由 canonical
// audioMode 冻结——省略/none 允许有声输入并整条去原声，preserve 按时段保留原声。
export function realRenderValidator(
  op: Parameters<NonNullable<QuoteCatalogEntry["validate"]>>[0],
  inputs?: TrustedOperationInput[],
  ctx?: CatalogValidationContext,
): void {
  if (op.kind !== "render" || op.parameters.assembly !== "ordered_concat") {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 ordered_concat 拼接。");
  }
  if (op.parameters.width !== 1280 || op.parameters.height !== 720 || op.parameters.fps !== 24) {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "本阶段拼接只启用 1280×720、24fps 输出。");
  }
  const probes = ctx?.renderFileProbes;
  if (!probes) return;
  for (const input of inputs ?? []) {
    const blobId = input.kind === "blob" ? input.blobId
      : input.kind === "artifact_revision" && input.content.format === "media" ? input.content.blobId : null;
    if (!blobId) continue;
    const probe = probes.get(blobId);
    if (!probe) continue;
    if (!probe.ok) throw new AgentError("INVALID_INPUT", `渲染输入文件不可读：${probe.reason}`);
    if (probe.kind !== "video") throw new AgentError("INVALID_INPUT", "渲染输入不是视频文件。");
  }
}

// T6：固定参数由 canonical 入口验证，槽位覆盖在 prepare 校验；此处只核可用能力与实际文件。
export function narratedRenderValidator(
  op: Parameters<NonNullable<QuoteCatalogEntry["validate"]>>[0],
  inputs?: TrustedOperationInput[],
  ctx?: CatalogValidationContext,
): void {
  if (op.kind !== "render" || op.parameters.assembly !== "narrated_concat") {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 narrated_concat 拼接。");
  }
  const probes = ctx?.renderFileProbes;
  if (!probes) return;
  for (const input of inputs ?? []) {
    const blobId = input.kind === "blob" ? input.blobId
      : input.kind === "artifact_revision" && input.content.format === "media" ? input.content.blobId : null;
    if (!blobId) continue;
    const probe = probes.get(blobId);
    if (!probe) continue;
    if (!probe.ok) throw new AgentError("INVALID_INPUT", `渲染输入文件不可读：${probe.reason}`);
  }
}

// S3-04：固定片段时间线由 canonical 验证，片段与文件事实在此核对；
// 视频片段必须能按源真实时长裁切，图片片段必须是实际可解码的单张图片，旁白必须是可读音频。
export function timedNarratedRenderValidator(
  op: Parameters<NonNullable<QuoteCatalogEntry["validate"]>>[0],
  inputs?: TrustedOperationInput[],
  ctx?: CatalogValidationContext,
): void {
  if (op.kind !== "render" || op.parameters.assembly !== "timed_narrated_concat") {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 timed_narrated_concat 拼接。");
  }
  if (op.parameters.width !== 1280 || op.parameters.height !== 720 || op.parameters.fps !== 24) {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "本阶段剪辑只启用 1280×720、24fps 输出。");
  }
  const probes = ctx?.renderFileProbes;
  if (!probes) return;
  const kindsBySlot = new Map<number, "video" | "image" | "audio">();
  for (const segment of op.parameters.segments) kindsBySlot.set(segment.inputSlot, segment.kind);
  kindsBySlot.set(op.parameters.narrationInputSlot, "audio");
  for (const [slot, expected] of kindsBySlot) {
    const input = inputs?.[slot];
    const blobId = input?.kind === "blob" ? input.blobId
      : input?.kind === "artifact_revision" && input.content.format === "media" ? input.content.blobId : null;
    if (!blobId) continue;
    const probe = probes.get(blobId);
    // 待生成输出尚未落文件，产出后由渲染自身再核验。
    if (!probe) continue;
    if (!probe.ok) throw new AgentError("INVALID_INPUT", `渲染输入文件不可读：${probe.reason}`);
    if (probe.kind !== expected) {
      throw new AgentError("INVALID_INPUT", expected === "audio" ? "旁白槽必须是可读的音频文件。"
        : expected === "image" ? "图片片段必须是可解码的图片文件。" : "视频片段必须是视频文件。");
    }
  }
}

export function mixedRenderCatalogEntry(): QuoteCatalogEntry {
  return {
    binding: null, quoteMinor: 0, priceKind: "bounded", probeRenderInputs: true, maxCreateAttempts: 1,
    validate: (op, inputs, ctx) => {
      if (op.kind !== "render" || op.parameters.assembly !== "mixed_concat") {
        throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 mixed_concat 混音。");
      }
      for (const [slot, input] of (inputs ?? []).entries()) {
        const blobId = input.kind === "blob" ? input.blobId
          : input.kind === "artifact_revision" && input.content.format === "media" ? input.content.blobId : null;
        if (!blobId) continue;
        const probe = ctx?.renderFileProbes?.get(blobId);
        if (!probe) continue;
        if (!probe.ok) throw new AgentError("INVALID_INPUT", `混音输入不可读：${probe.reason}`);
        if (probe.kind !== renderSlotRole(op.parameters, slot)) throw new AgentError("INVALID_INPUT", "混音输入与冻结槽位用途不一致。");
      }
    },
  };
}

/** 启动时核实一次的本地渲染/探测能力；保存设置不追加探活。AAC 影响有声分支。 */
export interface LocalRenderFacts {
  available: boolean;
  probeAvailable: boolean;
  aacAvailable: boolean;
  reason: string;
}

// 凭据和探测能力均就绪才注册 video；缺少 FFmpeg 编码器不阻断纯视频生成。
// 参数化 profile 按冻结时长×分辨率报价，并把待生成时长上界交给 prepare 按参数计算。
export function arkVideoCatalogEntry(profile: ArkVideoProfile, binding: ModelBinding): QuoteCatalogEntry {
  const ranged = asRangedArkProfile(profile);
  if (ranged) {
    const entry = rangedVideoCatalogEntry(binding, ranged.video, ranged.quote, "Seedance");
    // Seedance 按 token 计费：每秒价是官方 16:9 输出示例，completion_tokens 为准。
    entry.estimateNote = `视频按冻结秒数 × 每秒示例价估价（官方 ${ranged.quote.source}，核实 ${ranged.quote.verifiedAt}；token 计费、completion_tokens 为准）；不是供应商账单。`;
    return entry;
  }
  const legacy = asLegacyArkProfile(profile);
  if (!legacy) throw new Error("Ark profile 的能力与报价形状不匹配（持久化行损坏）。");
  return {
    binding, quoteMinor: legacy.quote.amountMinor, priceKind: "estimate", validate: arkVideoValidator(profile), maxCreateAttempts: 1,
  };
}

// ordered_concat 目录条目：preserve 需要本地 AAC 编码器（与 T6 有声分支同一能力），
// 缺失只拒绝保留原声，无声拼接不受影响。
export function renderCatalogEntry(aacAvailable: boolean): QuoteCatalogEntry {
  return {
    binding: null, quoteMinor: 0, priceKind: "bounded", probeRenderInputs: true, maxCreateAttempts: 1,
    validate: (op, inputs, ctx) => {
      if (op.kind === "render" && op.parameters.assembly === "ordered_concat"
        && op.parameters.audioMode === "preserve" && !aacAvailable) {
        throw new AgentError("CAPABILITY_UNAVAILABLE", "本机 FFmpeg 缺少 AAC 编码器，保留原声的拼接不可用；可改为全片静音方案。");
      }
      realRenderValidator(op, inputs, ctx);
    },
  };
}

// T6 有声拼接目录条目：仅当本地 libx264 与 AAC 编码都可用时注册。
export function narratedRenderCatalogEntry(): QuoteCatalogEntry {
  return { binding: null, quoteMinor: 0, priceKind: "bounded", validate: narratedRenderValidator, probeRenderInputs: true, maxCreateAttempts: 1 };
}

// S3-04 有限机械剪辑：按冻结片段裁切/静帧并替换原声；仅当本地编码与支持该分支的 FFmpeg 可用时注册。
export function timedNarratedRenderCatalogEntry(): QuoteCatalogEntry {
  return { binding: null, quoteMinor: 0, priceKind: "bounded", validate: timedNarratedRenderValidator, probeRenderInputs: true, maxCreateAttempts: 1 };
}

// —— B1/B2 OpenAI 单图（Images API：1536×864/16:9/low/PNG；两个型号共用一个协议实现，profile 的 model 区分） ——

export interface AgentMediaImageConfig {
  aspectRatio: "16:9";
  resolution: "1536x864";
  quality: "low";
  format: "png";
}

// 估价事实（B2）：美元单价来自官方 Standard 定价页，估算量与换算率一次性冻结进 profile；
// quoteMinor = ceil(100 × usdCny × Σ(units × unitPriceUsd))。estimate 不是供应商账单封顶。
export interface OpenAIMediaQuote {
  kind: "estimate";
  quoteMinor: number;
  usdCny: number;
  pricedAt: string;
  source: string;
  items: ReadonlyArray<{ label: string; units: number; unitPriceUsd: number; basis: string }>;
}

// 采价（2026-10-31）：USD→CNY 参考汇率 6.66（exchangerates.org.uk 2026-10-30 收盘价，10-31 周末沿用）。
const USD_CNY = 6.66;
const PRICED_AT = "2026-10-31";

function quoteMinorOf(usdCny: number, items: ReadonlyArray<{ units: number; unitPriceUsd: number }>): number {
  return Math.ceil(100 * usdCny * items.reduce((sum, item) => sum + item.units * item.unitPriceUsd, 0));
}

// 图片 low 档官方未公布每张 token 数：按 2026-09 第三方对同尺寸 medium 档实测的 280 输出 token
// 作保守上限（low ≤ medium）；文字输入按单次提示 ≤2000 token 上限。单价 $30/1M 输出、$5/1M 输入。
export function openaiImageProfile(modelId: string, baseUrl: string): OpenAIImageProfile {
  const items = [
    { label: "图片输出", units: 280, unitPriceUsd: 30 / 1_000_000, basis: "1536×864 low 档未公布，取实测 medium 档 280 token 上限；$30/1M" },
    { label: "文字输入", units: 2_000, unitPriceUsd: 5 / 1_000_000, basis: "单次提示 ≤2000 token 上限；$5/1M" },
  ];
  return {
    providerId: "openai", modelId, baseUrl,
    image: { aspectRatio: "16:9", resolution: "1536x864", quality: "low", format: "png" },
    quote: {
      kind: "estimate", usdCny: USD_CNY, pricedAt: PRICED_AT,
      source: "developers.openai.com 图片定价页 + 第三方实测 medium 档 token 数（low 未公布，取保守上限）+ exchangerates.org.uk 汇率",
      items, quoteMinor: quoteMinorOf(USD_CNY, items),
    },
  };
}

export interface OpenAIImageProfile {
  providerId: "openai";
  modelId: string;
  baseUrl: string;
  image: AgentMediaImageConfig;
  quote: OpenAIMediaQuote;
}

// 火山方舟北京区单图文生图，2560×1440 时 Pro 属于 >261 万像素档。
// https://docs.volcengine.com/docs/82379/1544106 （2026-11-06）
export const SEEDREAM_IMAGES = new Map([
  ["doubao-seedream-5-0-flash-260915", { name: "Seedream 5.0 Flash", quoteMinor: 12 }],
  ["doubao-seedream-5-0-pro-260628", { name: "Seedream 5.0 Pro", quoteMinor: 60 }],
  ["doubao-seedream-4-0-20260415", { name: "Seedream 4.0", quoteMinor: 20 }],
]);

export function seedreamImageProfile(modelId: string, baseUrl: string) {
  const listing = SEEDREAM_IMAGES.get(modelId);
  if (!listing || baseUrl !== DEFAULT_ARK_VIDEO_PROFILE.baseUrl) return null;
  return {
    providerId: "ark" as const, modelId, baseUrl,
    image: { aspectRatio: "16:9", resolution: "2560x1440", format: "jpeg" } as const,
    quote: { kind: "estimate" as const, quoteMinor: listing.quoteMinor, pricedAt: "2026-11-06", source: "火山方舟北京区单图按张定价" },
  };
}

export type ImageProfile = OpenAIImageProfile | NonNullable<ReturnType<typeof seedreamImageProfile>>;

export function imageBinding(profile: ImageProfile, connectionId: string): ModelBinding {
  const { providerId, modelId, baseUrl, image, quote } = profile;
  return {
    providerId, modelId, connectionId,
    configurationRevisionId: `cfg-${digestOf({ providerId, modelId, baseUrl, image, quote, connectionId }).slice(0, 24)}`,
  };
}

// 目录操作参数（contract ImageParameters）只承载画幅与分辨率；quality/format 是服务端冻结执行参数。
function imageValidator(profile: ImageProfile): NonNullable<QuoteCatalogEntry["validate"]> {
  return (op, inputs): void => {
    if (op.kind !== "image") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 image 操作。");
    if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
    const { aspectRatio, resolution } = op.parameters;
    if (aspectRatio !== profile.image.aspectRatio || resolution !== profile.image.resolution) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", `图片参数与已核实的启用组合不一致（${profile.image.resolution}/${profile.image.aspectRatio} 单张 ${profile.image.format.toUpperCase()}）。`);
    }
    if (!inputs) return;
    const input = inputs[0];
    if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
      throw new AgentError("INVALID_INPUT", "该图片通道只接受一份文字作为输入。");
    }
  };
}

export function imageCatalogEntry(profile: ImageProfile, binding: ModelBinding): QuoteCatalogEntry {
  return {
    binding, quoteMinor: profile.quote.quoteMinor, priceKind: "estimate", validate: imageValidator(profile), maxCreateAttempts: 1,
    estimateNote: profile.providerId === "ark"
      ? `火山方舟 ${profile.image.resolution} 单图公开估价 ¥${(profile.quote.quoteMinor / 100).toFixed(2)}/张（${profile.quote.pricedAt}）。`
      : `图片按 ${profile.image.resolution} ${profile.image.quality} 单张保守估算（low 档每张 token 数官方未公布，取实测 medium 档上限；官方 Standard 单价 ${profile.quote.pricedAt} 采价，USD→CNY ${profile.quote.usdCny}）；不是供应商账单。`,
  };
}

export function imageModelView(profile: ImageProfile, binding: ModelBinding, displayName: string): Bootstrap["models"][number] {
  return {
    binding, name: displayName, kind: "image",
    features: ["text-to-image", profile.image.resolution, profile.image.aspectRatio, profile.image.format.toUpperCase()],
    availability: "configured",
    verificationNote: profile.providerId === "ark"
      ? `单张 JPEG，${profile.image.resolution} · ¥${(profile.quote.quoteMinor / 100).toFixed(2)}/张（火山方舟公开估价）。`
      : `已核实范围：${profile.image.resolution}、${profile.image.aspectRatio}、low 单张 PNG。估价 ${(profile.quote.quoteMinor / 100).toFixed(2)} CNY/次（estimate：官方 Standard 美元单价 ${profile.quote.pricedAt} 采价，USD→CNY ${profile.quote.usdCny}；low 档每张 token 数官方未公布，按实测 medium 档保守估）；不是供应商账单。`,
    isDefault: false,
  };
}

// —— B1/B2 OpenAI 配音（Realtime 单次朗读：marin、PCM16/24kHz/mono → FFmpeg MP3；两个型号共用一个协议实现） ——

export interface AgentMediaSpeechConfig {
  voice: "marin";
  inputFormat: "pcm16-24000-mono";
  output: { format: "mp3"; sampleRateHz: 24_000; channels: 1 };
  maxDurationMs: 120_000;
  maxOutputTokens: 4_096;
  reasoningEffort: "low";
}

export interface OpenAISpeechProfile {
  providerId: "openai";
  modelId: string;
  baseUrl: string;
  speech: AgentMediaSpeechConfig;
  quote: OpenAIMediaQuote;
}

// 采价：gpt-realtime-2.1-mini 文本输入 $0.6/1M、文本输出 $2.4/1M、音频输出 $20/1M；
// gpt-realtime-2.1 分别为 $4/$24/$64（官方模型页）。音频 token 按实测样本 20 token/秒 × ≤120 秒
// = 2400 上限；旁白 ≤1000 码点按 ≤1100 token 上限，转写输出随音频返回、不超过旁白长度。
export function openaiSpeechProfile(modelId: string, baseUrl: string): OpenAISpeechProfile {
  const full = modelId === "gpt-realtime-2.1";
  const items = [
    { label: "文字输入", units: 1_100, unitPriceUsd: (full ? 4 : 0.6) / 1_000_000, basis: "≤1000 码点旁白按 ≤1100 token 上限" },
    { label: "音频输出", units: 2_400, unitPriceUsd: (full ? 64 : 20) / 1_000_000, basis: "≤120 秒 × 实测 20 token/秒" },
    { label: "转写输出", units: 1_100, unitPriceUsd: (full ? 24 : 2.4) / 1_000_000, basis: "随音频返回的文本转写 ≤ 旁白长度" },
  ];
  return {
    providerId: "openai", modelId, baseUrl,
    speech: { voice: "marin", inputFormat: "pcm16-24000-mono", output: { format: "mp3", sampleRateHz: 24_000, channels: 1 },
      maxDurationMs: 120_000, maxOutputTokens: 4_096, reasoningEffort: "low" },
    quote: {
      kind: "estimate", usdCny: USD_CNY, pricedAt: PRICED_AT,
      source: `developers.openai.com ${modelId} 模型页定价 + exchangerates.org.uk 汇率`,
      items, quoteMinor: quoteMinorOf(USD_CNY, items),
    },
  };
}

export function openaiSpeechBinding(profile: OpenAISpeechProfile, connectionId: string): ModelBinding {
  const { providerId, modelId, baseUrl, speech, quote } = profile;
  return {
    providerId, modelId, connectionId,
    configurationRevisionId: `cfg-${digestOf({ providerId, modelId, baseUrl, speech, quote, connectionId }).slice(0, 24)}`,
  };
}

// 目录操作参数（contract SpeechParameters）承载 voiceId 与输出格式；采样率/时长上限是服务端冻结执行参数。
export function openaiSpeechValidator(profile: OpenAISpeechProfile): NonNullable<QuoteCatalogEntry["validate"]> {
  return (op, inputs): void => {
    if (op.kind !== "speech") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 speech 操作。");
    if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
    if (op.parameters.voiceId !== profile.speech.voice || op.parameters.format !== profile.speech.output.format) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", `配音参数与已核实的启用组合不一致（${profile.speech.voice} 音色、${profile.speech.output.format} 输出）。`);
    }
    if (!inputs) return;
    const input = inputs[0];
    if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
      throw new AgentError("INVALID_INPUT", "该配音通道只接受一份旁白文本作为输入。");
    }
  };
}

export function openaiSpeechCatalogEntry(profile: OpenAISpeechProfile, binding: ModelBinding): QuoteCatalogEntry {
  return {
    binding, quoteMinor: profile.quote.quoteMinor, priceKind: "estimate", validate: openaiSpeechValidator(profile),
    maxCreateAttempts: 1, outputDurationBoundMs: profile.speech.maxDurationMs,
    estimateNote: `配音按 ≤1000 码点输入与 ≤120 秒音频上限保守估算（音频按实测 20 token/秒；官方 Standard 单价 ${profile.quote.pricedAt} 采价，USD→CNY ${profile.quote.usdCny}），不是每条实收；实际用量见完成消息，计费以供应商账单为准。`,
  };
}

export function openaiSpeechModelView(profile: OpenAISpeechProfile, binding: ModelBinding, displayName: string): Bootstrap["models"][number] {
  return {
    binding, name: displayName, kind: "speech",
    features: ["text-to-speech", profile.speech.voice, profile.speech.output.format, "≤1000 码点"],
    availability: "configured",
    verificationNote: `已核实范围：${profile.speech.voice} 音色逐字朗读、${profile.speech.output.format} ${profile.speech.output.sampleRateHz / 1000}kHz 单声道、≤1000 码点、实际音频 ≤120 秒。估价 ${(profile.quote.quoteMinor / 100).toFixed(2)} CNY/条（estimate：官方 Standard 美元单价 ${profile.quote.pricedAt} 采价，USD→CNY ${profile.quote.usdCny}，按用量上限保守估）；不是每条实收。`,
    isDefault: false,
  };
}

export function arkVideoUnavailableReason(credentialsConfigured: boolean, render: LocalRenderFacts): string {
  if (!credentialsConfigured) return "媒体凭据未启用，暂不能准备视频制作。";
  if (!render.probeAvailable) return "ffprobe 不可用，暂不能验收视频输出。";
  return "";
}
export function arkVideoModelEntry(profile: ArkVideoProfile, binding: ModelBinding, displayName: string,
  available: boolean, unavailableReason: string): Bootstrap["models"][number] {
  const ranged = asRangedArkProfile(profile);
  if (ranged) {
    return rangedVideoModelView(binding, displayName, ranged.video, ranged.quote, "Seedance", available, unavailableReason);
  }
  const legacy = asLegacyArkProfile(profile);
  if (!legacy) throw new Error("Ark profile 的能力与报价形状不匹配（持久化行损坏）。");
  return {
    binding, name: displayName, kind: "video",
    features: ["text-to-video", `${legacy.video.durationSeconds}s`, legacy.video.resolution, legacy.video.aspectRatio, "无声输出"],
    availability: available ? "configured" : "unavailable",
    verificationNote: `${unavailableReason}已核实范围：${legacy.video.durationSeconds} 秒、${legacy.video.resolution} ${legacy.video.aspectRatio}、无声。估价 ${(legacy.quote.amountMinor / 100).toFixed(2)} CNY/次（estimate，版本 ${legacy.quote.version}，核实日期 ${legacy.quote.verifiedAt}，来源 ${legacy.quote.source}）；按 token 计费，估价不是供应商账单封顶。`,
    isDefault: false,
  };
}

// —— M2 MiniMax 配音（t2a v2 同步 HTTP：speech-2.8-turbo/hd，非流式 hex MP3；官方 v1/t2a_v2 页核实） ——

// 已核实主机：国际站 api.minimax.io 按 USD 采价；中国站 api.minimax.cn / api.minimaxi.com 按 CNY 采价。
// 两地域 Key 不是通用 Key；未核实主机返回 null，按“已登记未接入”处理，不自动换域名。
export function minimaxRegionOf(baseUrl: string): "io" | "cn" | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    const host = url.hostname;
    if (host === "api.minimax.io") return "io";
    if (host === "api.minimax.cn" || host === "api.minimaxi.com") return "cn";
    return null;
  } catch { return null; }
}

export const MINIMAX_SPEECH_MODEL_IDS: ReadonlySet<string> = new Set(["speech-2.8-turbo", "speech-2.8-hd"]);
// 首轮冻结的已核实中文系统声线（官方声线目录：温润男声，旁白/讲故事）；声线集合后续按目录扩，不改内部 Id。
export const MINIMAX_SPEECH_VOICE = "Chinese (Mandarin)_Gentleman";

export interface MiniMaxSpeechProfile {
  providerId: "minimax";
  modelId: string;
  baseUrl: string;
  speech: {
    voice: typeof MINIMAX_SPEECH_VOICE;
    output: { format: "mp3"; sampleRateHz: 32_000; channels: 1; bitrate: 128_000 };
    maxTextLength: 1_000;
    maxDurationMs: 120_000;
  };
  quote: {
    kind: "estimate";
    /** USD 站点带冻结换算率；CNY 站点为 null。 */
    usdCny: number | null;
    /** 每百万计费字符的单价（USD 或 CNY，按 usdCny 是否为空区分）。 */
    perMillionChars: number;
    currency: "USD" | "CNY";
    pricedAt: string;
    source: string;
  };
}

// 采价（2026-11-01 官方定价页）：国际站 turbo $60/百万字符、hd $100/百万字符；中国站 ¥200/¥350。
// 具体提案按实际冻结码点数 × 2 保守估算；型号卡仍可展示 1000 码点上限范围。
export function minimaxSpeechProfile(modelId: string, baseUrl: string): MiniMaxSpeechProfile | null {
  const region = minimaxRegionOf(baseUrl);
  if (!region || !MINIMAX_SPEECH_MODEL_IDS.has(modelId)) return null;
  const hd = modelId === "speech-2.8-hd";
  return {
    providerId: "minimax", modelId, baseUrl,
    speech: {
      voice: MINIMAX_SPEECH_VOICE,
      output: { format: "mp3", sampleRateHz: 32_000, channels: 1, bitrate: 128_000 },
      maxTextLength: 1_000, maxDurationMs: 120_000,
    },
    quote: region === "io"
      ? { kind: "estimate", usdCny: USD_CNY, perMillionChars: hd ? 100 : 60, currency: "USD",
          pricedAt: PRICED_AT, source: "platform.minimax.io 定价页（t2a 按计费字符）+ exchangerates.org.uk 汇率" }
      : { kind: "estimate", usdCny: null, perMillionChars: hd ? 350 : 200, currency: "CNY",
          pricedAt: PRICED_AT, source: "platform.minimax.cn 定价页（t2a 按计费字符，1 汉字 = 2 字符）" },
  };
}

export function minimaxSpeechQuoteMinor(profile: MiniMaxSpeechProfile, codepoints: number = profile.speech.maxTextLength): number {
  const billingChars = codepoints * 2; // 当前文本按全汉字权重估算，向上取分，不冒充实收
  return profile.quote.usdCny
    ? Math.ceil(100 * profile.quote.usdCny * billingChars / 1_000_000 * profile.quote.perMillionChars)
    : Math.ceil(100 * billingChars / 1_000_000 * profile.quote.perMillionChars);
}

export function minimaxSpeechBinding(profile: MiniMaxSpeechProfile, connectionId: string): ModelBinding {
  const { providerId, modelId, baseUrl, speech, quote } = profile;
  return {
    providerId, modelId, connectionId,
    configurationRevisionId: `cfg-${digestOf({ providerId, modelId, baseUrl, speech, quote, connectionId }).slice(0, 24)}`,
  };
}

export function minimaxSpeechValidator(profile: MiniMaxSpeechProfile): NonNullable<QuoteCatalogEntry["validate"]> {
  return (op, inputs): void => {
    if (op.kind !== "speech") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 speech 操作。");
    if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
    if (op.parameters.voiceId !== profile.speech.voice || op.parameters.format !== profile.speech.output.format) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", `配音参数与已核实的启用组合不一致（${profile.speech.voice} 声线、${profile.speech.output.format} 输出）。`);
    }
    if (!inputs) return;
    const input = inputs[0];
    if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
      throw new AgentError("INVALID_INPUT", "该配音通道只接受一份旁白文本作为输入。");
    }
  };
}

export function minimaxSpeechCatalogEntry(profile: MiniMaxSpeechProfile, binding: ModelBinding): QuoteCatalogEntry {
  const rate = `${profile.quote.currency === "USD" ? "$" : "¥"}${profile.quote.perMillionChars}/百万计费字符`;
  return {
    binding, quoteMinor: minimaxSpeechQuoteMinor(profile), priceKind: "estimate",
    quoteMinorFor: (_op, codepoints) => {
      if (codepoints === undefined) throw new Error("MiniMax 配音报价缺少冻结文本码点数。");
      return minimaxSpeechQuoteMinor(profile, codepoints);
    },
    validate: minimaxSpeechValidator(profile), maxCreateAttempts: 1, outputDurationBoundMs: profile.speech.maxDurationMs,
    estimateNote: `配音按本次冻结文本的实际 Unicode 码点数 × 2 保守估算并向上取分；官方单价 ${rate}（${profile.quote.pricedAt} 采价${profile.quote.usdCny ? `，USD→CNY ${profile.quote.usdCny}` : ""}）；usage_characters 与实际费用以供应商账单为准。`,
  };
}

export function minimaxSpeechModelView(profile: MiniMaxSpeechProfile, binding: ModelBinding, displayName: string): Bootstrap["models"][number] {
  return {
    binding, name: displayName, kind: "speech",
    features: ["text-to-speech", profile.speech.voice, profile.speech.output.format, "32kHz 单声道", `≤${profile.speech.maxTextLength} 码点`],
    availability: "configured",
    verificationNote: `已核实范围：${profile.speech.voice} 声线、${profile.speech.output.format} ${profile.speech.output.sampleRateHz / 1000}kHz 单声道、≤${profile.speech.maxTextLength} 码点旁白。估价 ${(minimaxSpeechQuoteMinor(profile) / 100).toFixed(2)} CNY/条（estimate：${profile.quote.source}）；账户可用性尚未验证，实际以供应商账单为准。`,
    isDefault: false,
  };
}

// —— M2 MiniMax H3 视频（v2 异步：/v2/video_generation + /v2/query/video_generation/{id}；官方页面无静音字段，不猜） ——

export const MINIMAX_VIDEO_MODEL_IDS: ReadonlySet<string> = new Set(["MiniMax-H3", "MiniMax-H3-Max"]);

export interface MiniMaxVideoProfile {
  providerId: "minimax";
  modelId: string;
  baseUrl: string;
  video: RangedVideoCapability;
  quote: RangedVideoQuoteConfig;
}

// 采价（2026-11-01 官方定价页）：国际站 768P 输出 $0.08/秒（两型号同价）；中国站 ¥0.50/秒。
// t2v 无输入视频/图片费用。H3 4–15s、H3-Max 5–15s（官方 create 页），仅 768P、原生音画。
export function minimaxVideoProfile(modelId: string, baseUrl: string): MiniMaxVideoProfile | null {
  const region = minimaxRegionOf(baseUrl);
  if (!region || !MINIMAX_VIDEO_MODEL_IDS.has(modelId)) return null;
  const max = modelId === "MiniMax-H3-Max";
  return {
    providerId: "minimax", modelId, baseUrl,
    video: { durationSecondsMin: max ? 5 : 4, durationSecondsMax: 15, aspectRatio: "16:9", resolution: "768P", audioModes: ["native"] },
    quote: region === "io"
      ? { kind: "estimate", perSecondMinor: {}, perSecondUsd: { "768p": 0.08 }, usdCny: USD_CNY,
          version: "2026-11-official-pricing", source: "platform.minimax.io 定价页（H3/H3-Max 768P 输出 $0.08/秒）", verifiedAt: "2026-11-01" }
      : { kind: "estimate", perSecondMinor: { "768p": 50 }, perSecondUsd: null, usdCny: null,
          version: "2026-11-official-pricing", source: "platform.minimax.cn 定价页（H3/H3-Max 768P 输出 ¥0.50/秒）", verifiedAt: "2026-11-01" },
  };
}

export function minimaxVideoBinding(profile: MiniMaxVideoProfile, connectionId: string): ModelBinding {
  const { providerId, modelId, baseUrl, video, quote } = profile;
  return {
    providerId, modelId, connectionId,
    configurationRevisionId: `cfg-${digestOf({ providerId, modelId, baseUrl, video, quote, connectionId }).slice(0, 24)}`,
  };
}

// —— M2 阿里万相视频（DashScope 异步：video-synthesis + /api/v1/tasks/{id}；audio 开关同价） ——

export const WAN_VIDEO_MODEL_IDS: ReadonlySet<string> = new Set(["wan3.0-video", "wan3.0-video-prime"]);

export interface WanVideoProfile {
  providerId: "wan";
  modelId: string;
  baseUrl: string;
  video: RangedVideoCapability;
  quote: RangedVideoQuoteConfig;
}

// 万相工作空间媒体端点形如 https://{workspaceId}.{region}.maas.aliyuncs.com；Chat Completions 地址不是视频 API。
export function isWanMediaBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password
      && /^\w[\w-]*\.[a-z0-9-]+\.maas\.aliyuncs\.com$/.test(url.hostname);
  } catch { return false; }
}

// 采价（2026-11-01 百炼模型价格页，华北2 列表价）：wan3.0-video 720P ¥0.60/秒、prime 720P ¥0.90/秒；
// audio 开关同价；t2v 无输入视频费用。时长 2–30 整数秒（无视频输入时）。
export function wanVideoProfile(modelId: string, baseUrl: string): WanVideoProfile | null {
  if (!isWanMediaBaseUrl(baseUrl) || !WAN_VIDEO_MODEL_IDS.has(modelId)) return null;
  const prime = modelId === "wan3.0-video-prime";
  return {
    providerId: "wan", modelId, baseUrl,
    video: { durationSecondsMin: 2, durationSecondsMax: 30, aspectRatio: "16:9", resolution: "720P", audioModes: ["none", "native"] },
    quote: {
      kind: "estimate", perSecondMinor: { "720p": prime ? 90 : 60 }, perSecondUsd: null, usdCny: null,
      version: "2026-11-official-pricing", source: `阿里云百炼模型价格页（${modelId} 720P 列表价，audio 开关同价）`, verifiedAt: "2026-11-01",
    },
  };
}

export function wanVideoBinding(profile: WanVideoProfile, connectionId: string): ModelBinding {
  const { providerId, modelId, baseUrl, video, quote } = profile;
  return {
    providerId, modelId, connectionId,
    configurationRevisionId: `cfg-${digestOf({ providerId, modelId, baseUrl, video, quote, connectionId }).slice(0, 24)}`,
  };
}

// 参数化视频通道共用：校验器/目录条目/型号视图（Seedance 参数化行、H3、万相同一形状）。
export function rangedVideoValidator(video: RangedVideoCapability, channelLabel: string): NonNullable<QuoteCatalogEntry["validate"]> {
  return (op, inputs): void => {
    if (op.kind !== "video") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 video 操作。");
    if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
    validateRangedVideoParameters(video, op.parameters, channelLabel);
    requireSingleTextInput(op, inputs);
  };
}

export function rangedVideoCatalogEntry(binding: ModelBinding, video: RangedVideoCapability, quote: RangedVideoQuoteConfig,
  channelLabel: string): QuoteCatalogEntry {
  return {
    binding, quoteMinor: rangedQuoteMinor(quote, video.durationSecondsMin, video.resolution), priceKind: "estimate",
    validate: rangedVideoValidator(video, channelLabel), maxCreateAttempts: 1,
    quoteMinorFor: op => op.kind === "video" ? rangedQuoteMinor(quote, op.parameters.durationSeconds, op.parameters.resolution) : 0,
    estimateNote: `${channelLabel}视频按冻结秒数 × 每秒单价估价（${quote.source}，核实 ${quote.verifiedAt}${quote.usdCny ? `，USD→CNY ${quote.usdCny}` : ""}）；实际以供应商账单为准。`,
  };
}

export function rangedVideoModelView(binding: ModelBinding, displayName: string, video: RangedVideoCapability,
  quote: RangedVideoQuoteConfig, channelLabel: string, available = true, unavailableReason = ""): Bootstrap["models"][number] {
  return {
    binding, name: displayName, kind: "video",
    features: ["text-to-video", `${video.durationSecondsMin}–${video.durationSecondsMax}s`, video.resolution, video.aspectRatio,
      video.audioModes.includes("native") ? video.audioModes.includes("none") ? "无声或原生音画" : "原生音画" : "无声输出"],
    availability: available ? "configured" : "unavailable",
    verificationNote: `${unavailableReason}已核实范围：${video.durationSecondsMin}–${video.durationSecondsMax} 整数秒、${video.resolution} ${video.aspectRatio}、${
      video.audioModes.includes("native") ? video.audioModes.includes("none") ? "无声或原生音画" : "原生音画（官方无静音字段）" : "无声输出"}。按冻结秒数 × 每秒单价估价（${quote.source}，核实 ${quote.verifiedAt}）；账户可用性尚未验证，实际以供应商账单为准。`,
    isDefault: false,
  };
}
