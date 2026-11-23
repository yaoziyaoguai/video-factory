import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
  ExecutionInput,
  MarkdownContent,
  OperationRequest,
  VideoParameters,
} from "../../shared/agent/generated/contracts.js";
import { markdownFullText } from "../../shared/agent/markdown.js";
import type { CatalogValidationContext, TrustedOperationInput } from "./artifact-store.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { probeImageFile } from "./media-probe.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { runRow } from "./production-store.js";

type VideoOp = Extract<OperationRequest, { kind: "video" }>;
type ImageRole = "first_frame" | "last_frame" | "reference_image";
type Slot = { slot: number; role: ImageRole };

const profiles = {
  ark: {
    minSide: 300,
    maxSide: 6000,
    maxAspect: 2.5,
    maxBytes: 30_000_000 - 1,
    refs: 30,
    lastOnly: false,
    bodyLimit: 64_000_000,
  },
  minimax: {
    minSide: 256,
    maxSide: 5760,
    maxAspect: 2.5,
    maxBytes: 30_000_000,
    refs: 9,
    lastOnly: true,
    bodyLimit: 64_000_000,
  },
  wan: { minSide: 240, maxSide: 8000, maxAspect: 8, maxBytes: 20_000_000, refs: 10, lastOnly: false, bodyLimit: null },
} as const;
const supported = new Map<string, keyof typeof profiles>([
  ["doubao-seedance-2-5-260628", "ark"],
  ["MiniMax-H3", "minimax"],
  ["MiniMax-H3-Max", "minimax"],
  ["wan3.0-video", "wan"],
  ["wan3.0-video-prime", "wan"],
]);
export function videoImageFeatures(model: string): string[] {
  return supported.has(model) ? ["i2v", "first-last-frame", "subject-ref"] : [];
}
export function videoImageSlots(p: VideoParameters): Slot[] {
  const slots: Slot[] = [];
  if (p.firstFrameSlot !== undefined) slots.push({ slot: p.firstFrameSlot, role: "first_frame" });
  if (p.lastFrameSlot !== undefined) slots.push({ slot: p.lastFrameSlot, role: "last_frame" });
  for (const slot of p.referenceImageSlots ?? []) slots.push({ slot, role: "reference_image" });
  return slots;
}

/** 这类输入图片决定输出画幅（方舟首帧、MiniMax 首尾帧）：图片必须就是视频的冻结画幅。 */
const decidesOutputRatio = (key: keyof typeof profiles, role: ImageRole): boolean =>
  (key === "minimax" && role !== "reference_image") || (key === "ark" && role === "first_frame");

function verifyImage(
  model: string,
  p: VideoParameters,
  role: ImageRole,
  facts: { width: number; height: number; sizeBytes: number },
): void {
  const key = supported.get(model);
  if (!key) throw new AgentError("CAPABILITY_UNAVAILABLE", "该视频型号不支持参考图。");
  const profile = profiles[key],
    { width, height, sizeBytes } = facts;
  if (
    Math.min(width, height) < profile.minSide ||
    Math.max(width, height) > profile.maxSide ||
    Math.max(width / height, height / width) > profile.maxAspect ||
    sizeBytes > profile.maxBytes
  ) {
    throw new AgentError(
      "CAPABILITY_UNAVAILABLE",
      `该型号要求参考图每边在 ${profile.minSide}–${profile.maxSide} 像素内，长宽比最多 ${profile.maxAspect}，单图上限 ${Math.ceil(profile.maxBytes / 1000000)} MB。`,
    );
  }
  if (decidesOutputRatio(key, role)) {
    const [a, b] = p.aspectRatio.split(":").map(Number) as [number, number];
    if (Math.abs(width * b - height * a) > Math.max(a, b))
      throw new AgentError("CAPABILITY_UNAVAILABLE", "该型号按输入关键帧决定输出画幅，请将图片裁为冻结画幅。");
  }
}

export function validateVideoImages(
  modelId: string,
  op: VideoOp,
  facts?: TrustedOperationInput[],
  context?: CatalogValidationContext,
): boolean {
  const slots = videoImageSlots(op.parameters);
  if (!slots.length) return false;
  const provider = supported.get(modelId);
  if (!provider)
    throw new AgentError("CAPABILITY_UNAVAILABLE", "当前视频型号只支持文字输入，请选择支持图生视频的型号。");
  const p = op.parameters,
    profile = profiles[provider];
  const indexes = new Set(slots.map((x) => x.slot));
  if (
    indexes.size !== slots.length ||
    slots.some(({ slot }) => !Number.isInteger(slot) || slot < 0 || slot >= op.inputs.length) ||
    op.inputs.length !== slots.length + 1
  )
    throw new AgentError("INVALID_INPUT", "请为每张参考图指定独立输入槽，并保留一份镜头提示词。");
  if (p.referenceImageSlots && (p.firstFrameSlot !== undefined || p.lastFrameSlot !== undefined))
    throw new AgentError("CAPABILITY_UNAVAILABLE", "首尾帧和角色参考图须分别制作。");
  if (p.lastFrameSlot !== undefined && p.firstFrameSlot === undefined && !profile.lastOnly)
    throw new AgentError("CAPABILITY_UNAVAILABLE", "该型号的尾帧须和首帧一起使用。");
  if ((p.referenceImageSlots?.length ?? 0) > profile.refs)
    throw new AgentError("CAPABILITY_UNAVAILABLE", `该型号每次最多采用 ${profile.refs} 张参考图。`);
  if (!facts) return true;
  const text = facts.find((_, i) => !indexes.has(i));
  if (!text || !(text.kind === "text" || (text.kind === "artifact_revision" && text.content.format === "markdown")))
    throw new AgentError("INVALID_INPUT", "未指定为图片的槽必须是镜头提示词。");
  let encodedBytes = 0;
  for (const { slot, role } of slots) {
    const fact = facts[slot]!;
    if (fact.kind === "operation_output" && fact.producerKind === "image") {
      // 上游图片尚未生成、没有像素可探：按它冻结的画幅预判，别等出图花了钱才发现首帧画幅不对。
      if (decidesOutputRatio(provider, role) && fact.producerAspectRatio !== p.aspectRatio) {
        throw new AgentError("CAPABILITY_UNAVAILABLE",
          `该型号按输入关键帧决定输出画幅：上游图片按 ${fact.producerAspectRatio} 生成，与视频冻结画幅 ${p.aspectRatio} 不一致。`);
      }
      continue;
    }
    const media =
      fact.kind === "blob"
        ? fact
        : fact.kind === "artifact_revision" && fact.content.format === "media"
          ? fact.content
          : undefined;
    if (!media || !["image/png", "image/jpeg", "image/webp"].includes(media.mimeType))
      throw new AgentError("INVALID_INPUT", "参考帧必须是本会话中可用的图片或上游图片输出。");
    const probe = context?.renderFileProbes?.get(media.blobId);
    if (probe && !(probe.ok && probe.kind === "image")) throw new AgentError("INVALID_INPUT", "参考图无法解码。");
    if (probe?.ok && probe.kind === "image" && probe.sizeBytes !== undefined) {
      verifyImage(modelId, p, role, { ...probe, sizeBytes: probe.sizeBytes });
      encodedBytes += 4 * Math.ceil(probe.sizeBytes / 3);
    }
  }
  if (profile.bodyLimit !== null && encodedBytes >= profile.bodyLimit)
    throw new AgentError("CAPABILITY_UNAVAILABLE", "参考图合计超过该供应商的 64 MB 请求上限，请缩小图片。");
  return true;
}

class ImageFile {
  constructor(
    readonly file: string,
    readonly mime: string,
    readonly size: number,
  ) {}
}
type Json = null | boolean | number | string | ImageFile | Json[] | { [key: string]: Json };

function* jsonParts(value: Json): Generator<string | ImageFile> {
  if (value instanceof ImageFile) {
    yield value;
    return;
  }
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
    return;
  }
  const array = Array.isArray(value);
  yield array ? "[" : "{";
  let comma = false;
  for (const [key, child] of Object.entries(value)) {
    if (comma) yield ",";
    comma = true;
    if (!array) yield JSON.stringify(key) + ":";
    yield* jsonParts(child);
  }
  yield array ? "]" : "}";
}

// Node 的 base64 字符串解码器会保留跨块的余数。流只持有一块图片数据。
export class StreamedVideoJson {
  constructor(private readonly parts: (string | ImageFile)[]) {}
  stream(): ReadableStream<Uint8Array> {
    const parts = this.parts;
    async function* chunks() {
      for (const part of parts) {
        if (typeof part === "string") {
          yield Buffer.from(part);
          continue;
        }
        yield Buffer.from(`"data:${part.mime};base64,`);
        for await (const data of createReadStream(part.file, { encoding: "base64", highWaterMark: 48 * 1024 }))
          yield Buffer.from(data);
        yield Buffer.from('"');
      }
    }
    return Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>;
  }
}

export async function videoWireBody(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  input: ExecutionInput,
  model: string,
  encode: (prompt: string, images: { role: ImageRole; url: ImageFile }[]) => Json,
): Promise<Json | StreamedVideoJson> {
  const op = input.operation;
  if (op.kind !== "video") throw new Error("冻结操作并非视频。");
  const slots = videoImageSlots(op.parameters);
  const designated = new Set(slots.map((x) => x.slot));
  const ref = op.inputs.find((_, slot) => !designated.has(slot));
  if (!ref || (ref.kind !== "text" && ref.kind !== "artifact_revision"))
    throw new AgentError("INVALID_INPUT", "冻结镜头缺少提示词。");
  const prompt =
    ref.kind === "text"
      ? ref.text
      : markdownFullText(
          JSON.parse(
            (
              db
                .prepare("SELECT content_json FROM artifact_revisions WHERE id=? AND artifact_id=?")
                .get(ref.revisionId, ref.artifactId) as { content_json: string }
            ).content_json,
          ) as MarkdownContent,
        );
  if (!slots.length) return encode(prompt, []);
  const owner = runRow(db, input.runId).owner_id;
  const images: { role: ImageRole; url: ImageFile }[] = [];
  for (const { slot, role } of slots) {
    const resolved = input.resolvedInputs.find((x) => x.slot === slot);
    if (!resolved) throw new AgentError("INVALID_INPUT", "参考图还没有可用的文件。");
    const blob = blobs.get(owner, resolved.blobId),
      file = blobs.filePath(blob.digest);
    const facts = await probeImageFile(file);
    if (blob.digest !== resolved.digest || facts.mimeType !== blob.mime_type)
      throw new AgentError("INVALID_INPUT", "参考图与冻结版本不一致。");
    verifyImage(model, op.parameters, role, { ...facts, sizeBytes: blob.size_bytes });
    images.push({ role, url: new ImageFile(file, facts.mimeType, blob.size_bytes) });
  }
  const parts = [...jsonParts(encode(prompt, images))];
  const length = parts.reduce(
    (n, p) =>
      n +
      (typeof p === "string"
        ? Buffer.byteLength(p)
        : Buffer.byteLength(`"data:${p.mime};base64,"`) + Math.ceil(p.size / 3) * 4),
    0,
  );
  const limit = profiles[supported.get(model)!].bodyLimit;
  if (limit !== null && length > limit)
    throw new AgentError("CAPABILITY_UNAVAILABLE", "参考图合计超过该供应商的 64 MB 请求上限，请缩小图片。");
  return new StreamedVideoJson(parts);
}
