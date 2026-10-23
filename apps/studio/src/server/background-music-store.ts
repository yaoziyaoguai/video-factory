import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseBackgroundMusicMix, type ProductionBackgroundMusic } from "@video-factory/production-pipeline";
import type { StudioMusicUpload } from "../shared/api.js";

const execute = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_STORED_BYTES = 500 * 1024 * 1024;

/** 上传曲目按内容保存；已采用的制作不依赖会过期的临时上传。 */
export class BackgroundMusicStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}

  upload(input: { label: string; licenseNote: string; bytes: Buffer }): Promise<StudioMusicUpload> {
    const operation = this.queue.then(() => this.store(input));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async store(input: { label: string; licenseNote: string; bytes: Buffer }): Promise<StudioMusicUpload> {
    const label = input.label.trim();
    const licenseNote = input.licenseNote.trim();
    if (!label || label.length > 160 || !licenseNote || licenseNote.length > 500) throw new Error("请填写音乐名称及你持有的使用授权或来源。");
    if (input.bytes.length < 12 || input.bytes.length > MAX_BYTES) throw new Error("背景音乐文件应在 12 字节到 20 MB 之间。");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const uploadId = createHash("sha256").update(input.bytes).digest("hex");
    const existing = await stat(path.join(this.root, uploadId, "source")).catch(() => undefined);
    if (existing) return this.metadata(uploadId);
    let storedBytes = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
        storedBytes += (await stat(path.join(this.root, entry.name, "source"))).size;
      }
    }
    if (storedBytes + input.bytes.length > MAX_STORED_BYTES) throw new Error("音乐素材空间已满，请联系管理员整理未使用素材；已采用曲目不会自动删除。");
    const temporary = path.join(this.root, `.upload-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const source = path.join(temporary, "source");
      await writeFile(source, input.bytes, { flag: "wx", mode: 0o600 });
      const { stdout } = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
        "stream=codec_type:format=duration,format_name", "-of", "json", source], { timeout: 15_000, maxBuffer: 64 * 1024 });
      const probe = JSON.parse(stdout);
      const durationSeconds = Number(probe.format?.duration);
      if (!probe.streams?.some((stream: { codec_type: string }) => stream.codec_type === "audio")
        || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 600
        || !String(probe.format?.format_name).split(",").some(name => ["mp3", "wav", "flac", "ogg", "mov", "m4a", "aac"].includes(name))) {
        throw new Error("音乐应为可解码的 MP3、WAV、M4A、FLAC 或 OGG，长度在 1 秒到 10 分钟之间。");
      }
      const format = String(probe.format.format_name).split(",")[0];
      const contentType = ({ mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", mov: "audio/mp4", aac: "audio/aac" } as Record<string, string>)[format!] ?? "audio/mp4";
      const metadata = { uploadId, label, licenseNote, durationSeconds, contentType };
      await writeFile(path.join(temporary, "metadata.json"), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(this.root, uploadId));
      return metadata;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async resource(uploadId: string): Promise<{ path: string; contentType: string }> {
    const music = await this.resolve({ uploadId, volume: 0.25, fadeInSeconds: 1, fadeOutSeconds: 1.5, ducking: true });
    return { path: music.path, contentType: (await this.metadata(uploadId)).contentType };
  }

  private async metadata(uploadId: string): Promise<StudioMusicUpload & { contentType: string }> {
    if (!/^[a-f0-9]{64}$/.test(uploadId)) throw new Error("背景音乐编号不正确。");
    const metadata = JSON.parse(await readFile(path.join(this.root, uploadId, "metadata.json"), "utf8"));
    if (metadata.uploadId !== uploadId) throw new Error("背景音乐记录不完整。");
    return metadata;
  }

  async resolve(input: unknown): Promise<ProductionBackgroundMusic> {
    const mix = parseBackgroundMusicMix(input);
    const uploadId = String((input as Record<string, unknown>).uploadId ?? "");
    const metadata = await this.metadata(uploadId);
    const root = await realpath(this.root);
    const source = await realpath(path.join(root, uploadId, "source"));
    if (path.dirname(source) !== path.join(root, uploadId)) throw new Error("背景音乐不在素材目录中。");
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== uploadId) throw new Error("背景音乐内容已变化，请重新上传。");
    return { ...mix, ...metadata, path: source, sha256: uploadId };
  }
}
