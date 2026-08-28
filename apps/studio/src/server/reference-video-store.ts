import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StudioReferenceVideo } from "../shared/api.js";

const MAX_REFERENCE_VIDEO_BYTES = 30 * 1024 * 1024;
const MAX_STORED_REFERENCE_VIDEOS = 20;
const MAX_STORED_REFERENCE_BYTES = 300 * 1024 * 1024;
const REFERENCE_VIDEO_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SAFE_UPLOAD_ID = /^[a-f0-9-]{36}$/;
const EXTENSION_BY_TYPE = new Map<string, string>([
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
] as const);

interface StoredReferenceVideo extends StudioReferenceVideo {
  path: string;
}

export class ReferenceVideoStore {
  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {}

  async upload(input: { label: string; mimeType: string; bytes: Buffer }): Promise<StudioReferenceVideo> {
    const label = input.label.trim();
    if (!label || label.length > 160) throw new Error("参考视频文件名不正确。");
    const extension = EXTENSION_BY_TYPE.get(input.mimeType);
    if (!extension) throw new Error("参考视频只支持 MP4、MOV 或 WebM。");
    if (input.bytes.length < 12 || input.bytes.length > MAX_REFERENCE_VIDEO_BYTES) {
      throw new Error("参考视频大小必须在 12 字节到 30 MB 之间。");
    }
    if (!matchesContainer(input.bytes, input.mimeType)) throw new Error("参考视频内容与文件类型不匹配。");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanup(input.bytes.length);
    const uploadId = randomUUID();
    const directory = path.join(this.root, uploadId);
    const videoPath = path.join(directory, `source${extension}`);
    const metadataPath = path.join(directory, "metadata.json");
    await mkdir(directory, { recursive: false, mode: 0o700 });
    await writeFile(videoPath, input.bytes, { flag: "wx", mode: 0o600 });
    const metadata: StudioReferenceVideo = {
      uploadId,
      label,
      mimeType: input.mimeType as StudioReferenceVideo["mimeType"],
      sizeBytes: input.bytes.length,
      sha256: sha256(input.bytes),
      createdAt: this.now().toISOString(),
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { flag: "wx", mode: 0o600 });
    return metadata;
  }

  async resolve(uploadId: string): Promise<StoredReferenceVideo> {
    if (!SAFE_UPLOAD_ID.test(uploadId)) throw new Error("参考视频编号不正确。");
    try {
      const directory = await realpath(path.join(this.root, uploadId));
      const root = await realpath(this.root);
      const relative = path.relative(root, directory);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("参考视频不在受控目录中。");
      const metadata = JSON.parse(await readFile(path.join(directory, "metadata.json"), "utf8")) as StudioReferenceVideo;
      if (metadata.uploadId !== uploadId || !EXTENSION_BY_TYPE.has(metadata.mimeType) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
        throw new Error("参考视频元数据不正确。");
      }
      const createdAt = Date.parse(metadata.createdAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(metadata.sizeBytes)) throw new Error("参考视频元数据不正确。");
      if (this.now().getTime() - createdAt > REFERENCE_VIDEO_TTL_MS) {
        await rm(directory, { recursive: true, force: true });
        throw new Error("参考视频已超过 7 天保留期，请重新上传。");
      }
      const videoPath = await realpath(path.join(directory, `source${EXTENSION_BY_TYPE.get(metadata.mimeType)!}`));
      const bytes = await readFile(videoPath);
      if (bytes.length !== metadata.sizeBytes || sha256(bytes) !== metadata.sha256) {
        throw new Error("参考视频内容已经变化，请重新上传。");
      }
      return { ...metadata, path: videoPath };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("参考视频")) throw error;
      throw new Error("参考视频不存在或已经失效。");
    }
  }

  async remove(uploadId: string): Promise<void> {
    if (!SAFE_UPLOAD_ID.test(uploadId)) throw new Error("参考视频编号不正确。");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const target = path.resolve(root, uploadId);
    if (path.dirname(target) !== root) throw new Error("参考视频不在受控目录中。");
    await rm(target, { recursive: true, force: true });
  }

  private async cleanup(incomingBytes: number): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const stored: StudioReferenceVideo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_UPLOAD_ID.test(entry.name)) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(this.root, entry.name, "metadata.json"), "utf8")) as StudioReferenceVideo;
        if (metadata.uploadId !== entry.name
          || !Number.isFinite(metadata.sizeBytes)
          || !Date.parse(metadata.createdAt)
          || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error("invalid metadata");
        if (this.now().getTime() - Date.parse(metadata.createdAt) > REFERENCE_VIDEO_TTL_MS) {
          await rm(path.join(this.root, entry.name), { recursive: true, force: true });
        } else {
          stored.push(metadata);
        }
      } catch {
        await rm(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }
    stored.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    let totalBytes = stored.reduce((sum, item) => sum + item.sizeBytes, 0);
    while (stored.length >= MAX_STORED_REFERENCE_VIDEOS || totalBytes + incomingBytes > MAX_STORED_REFERENCE_BYTES) {
      const oldest = stored.shift();
      if (!oldest) throw new Error("参考视频存储空间不足。");
      totalBytes -= oldest.sizeBytes;
      await rm(path.join(this.root, oldest.uploadId), { recursive: true, force: true });
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function matchesContainer(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "video/webm") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return bytes.subarray(4, 8).toString("ascii") === "ftyp";
}
