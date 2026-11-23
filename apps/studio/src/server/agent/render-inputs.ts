import type { OperationRequest, RenderInputParameters, RenderParameters } from "../../shared/agent/generated/contracts.js";

import { AgentError } from "./errors.js";
import type { RenderFileProbe, TrustedOperationInput } from "./artifact-store.js";

// 探测、能力校验与worker共用冻结槽位用途；音乐/配音不进入视觉片段列表。
export function renderSlotRole(parameters: RenderInputParameters, slot: number): "video" | "image" | "audio" | "none" {
  if (parameters.assembly === "narrated_concat") {
    return slot === parameters.narrationInputSlot ? "audio" : "video";
  }
  if (parameters.assembly === "timed_narrated_concat") {
    return slot === parameters.narrationInputSlot ? "audio"
      : parameters.segments.find(segment => segment.inputSlot === slot)?.kind ?? "none";
  }
  if (parameters.assembly === "mixed_concat") {
    if (slot === parameters.music?.inputSlot || slot === parameters.narration?.inputSlot) return "audio";
    return parameters.segments.find(segment => segment.inputSlot === slot)?.kind ?? "none";
  }
  return "video";
}

type NativeInput = Exclude<RenderInputParameters, { assembly: "code_project" }>;
type Canvas = Pick<Exclude<RenderParameters, { assembly: "code_project" }>, "width" | "height" | "fps">;
const ratios = [[16, 9], [9, 16], [1, 1], [4, 3], [3, 4]] as const;

export function validateRenderCanvas(parameters: Pick<NativeInput, "width" | "height" | "fps">): void {
  const { width, height, fps } = parameters;
  if (width === undefined || height === undefined || fps === undefined
    || ![width, height].every(n => Number.isInteger(n) && n >= 360 && n <= 2160 && n % 2 === 0)
    || width * height > 1920 * 1080 || ![24, 25, 30, 60].includes(fps)) {
    throw new AgentError("CAPABILITY_UNAVAILABLE", "合成宽高须为 360–2160 之间的偶数，总像素最多 1920×1080；帧率支持 24、25、30 或 60。");
  }
}

// 按视觉片段票数选主画幅，同票沿第一次出现的画幅。同画幅使用已知素材的最高 720p/1080p 档。
export function resolveRenderCanvas(parameters: NativeInput, inputs: OperationRequest["inputs"], facts: TrustedOperationInput[],
  producers: Map<string, OperationRequest>, frozen: Map<string, RenderParameters>, probes?: Map<string, RenderFileProbe>): Canvas {
  const fps = parameters.fps ?? 24;
  const slots = parameters.assembly === "ordered_concat" ? inputs.map((_, slot) => slot)
    : parameters.assembly === "narrated_concat" ? parameters.videoInputSlots : parameters.segments.map(segment => segment.inputSlot);
  if ("visualStyles" in parameters && parameters.visualStyles) {
    const styles = parameters.visualStyles.map(s => s.inputSlot);
    if (new Set(styles).size !== styles.length || styles.some(slot => !slots.includes(slot))) {
      throw new AgentError("INVALID_INPUT", "画幅适配须指向唯一的视觉输入槽。");
    }
  }
  if (parameters.width !== undefined || parameters.height !== undefined) {
    validateRenderCanvas({ ...parameters, fps });
    return { width: parameters.width!, height: parameters.height!, fps };
  }
  const groups = new Map<string, { ratio: readonly [number, number]; count: number; tier: number }>();
  for (const slot of slots) {
    const ref = inputs[slot]!, fact = facts[slot]!;
    let source: { width: number; height: number } | undefined;
    if (ref.kind === "operation_output") {
      const upstream = producers.get(ref.producerOperationId)!;
      if (upstream.kind === "render") {
        const spec = frozen.get(upstream.operationId)!;
        if ("width" in spec && "height" in spec) source = spec;
      } else if (upstream.kind === "video" || upstream.kind === "image") {
        const [w, h] = upstream.parameters.aspectRatio.split(":").map(Number) as [number, number];
        const resolution = upstream.parameters.resolution;
        const pixels = /^(\d+)[x×](\d+)$/i.exec(resolution);
        const high = pixels ? Math.min(Number(pixels[1]), Number(pixels[2])) >= 1080 : /^(?:1080p|2k|4k)$/i.test(resolution);
        const short = high ? 1080 : 720;
        source = { width: short * w / Math.min(w, h), height: short * h / Math.min(w, h) };
      }
    } else {
      const id = fact.kind === "blob" ? fact.blobId : fact.kind === "artifact_revision" && fact.content.format === "media" ? fact.content.blobId : undefined;
      const probe = id ? probes?.get(id) : undefined;
      if (probe?.ok && probe.kind !== "audio") source = probe.kind === "video" && probe.displayWidth !== undefined && probe.displayHeight !== undefined
        ? { width: probe.displayWidth, height: probe.displayHeight } : probe;
    }
    if (!source) throw new AgentError("INVALID_INPUT", "无法核实视觉素材画幅，请明确输出宽高或重新选择可读取的画面。");
    const aspect = source.width / source.height;
    const ratio = ratios.reduce((best, next) => Math.abs(Math.log(aspect * next[1] / next[0])) < Math.abs(Math.log(aspect * best[1] / best[0])) ? next : best);
    const key = ratio.join(":");
    const group = groups.get(key) ?? { ratio, count: 0, tier: 720 };
    group.count++;
    if (Math.min(source.width, source.height) >= 1080) group.tier = 1080;
    groups.set(key, group);
  }
  let dominant: { ratio: readonly [number, number]; count: number; tier: number } | undefined;
  for (const group of groups.values()) if (!dominant || group.count > dominant.count) dominant = group;
  if (!dominant) throw new AgentError("INVALID_INPUT", "合成需要至少一个视觉片段。");
  const [w, h] = dominant.ratio;
  return { width: dominant.tier * w / Math.min(w, h), height: dominant.tier * h / Math.min(w, h), fps };
}
