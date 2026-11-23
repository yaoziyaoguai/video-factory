import { readFile } from "node:fs/promises";
import { extractVideoFrames } from "./media-probe.js";
import { createHash } from "node:crypto";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { AgentToolError } from "./errors.js";

export async function readModelImage(file: string, mimeType: string, sizeBytes: number, signal?: AbortSignal) {
  if (sizeBytes <= 1024 * 1024) return { bytes: await readFile(file, { signal }), mimeType };
  const [still] = await extractVideoFrames(file, [0], signal, "reference");
  return { bytes: still!, mimeType: "image/jpeg" };
}

// read_artifact 与发送时的历史投影共用；Pi 的 maxBytes 约束的是 base64 长度。
export async function resizeImageForModel(bytes: Uint8Array, mimeType: string) {
  const resized = await resizeImage(bytes, mimeType, {
    maxWidth: 1280, maxHeight: 1280, maxBytes: 256 * 1024, jpegQuality: 75,
  });
  if (!resized) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "图像无法缩放到模型可接受的大小。");
  return resized;
}

type ProjectedImage = Awaited<ReturnType<typeof resizeImageForModel>>;

export class HistoryImageCache {
  private readonly keys = new WeakMap<object, string>();
  private readonly items = new Map<string, ProjectedImage>();
  private readonly pending = new Map<string, Promise<ProjectedImage>>();
  private bytes = 0;

  constructor(private readonly project = resizeImageForModel) {}

  async read(block: { data: string; mimeType: string }): Promise<ProjectedImage> {
    let key = this.keys.get(block);
    if (!key) {
      key = block.mimeType + ":" + createHash("sha256").update(block.data, "base64").digest("hex");
      this.keys.set(block, key);
    }
    const hit = this.items.get(key);
    if (hit) { this.items.delete(key); this.items.set(key, hit); return hit; }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const loading = this.project(Buffer.from(block.data, "base64"), block.mimeType);
    this.pending.set(key, loading);
    try {
      const output = await loading;
      if (output.data.length <= 32 * 1024 * 1024) {
        this.items.set(key, output);
        this.bytes += output.data.length;
        while (this.items.size > 64 || this.bytes > 32 * 1024 * 1024) {
          const oldest = this.items.entries().next().value!;
          this.items.delete(oldest[0]);
          this.bytes -= oldest[1].data.length;
        }
      }
      return output;
    } finally { this.pending.delete(key); }
  }
}
