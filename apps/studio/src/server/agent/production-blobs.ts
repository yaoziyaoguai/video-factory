import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentDatabase } from "./db.js";
import { newAgentId, type AgentClock } from "./util.js";
import { AgentError } from "./errors.js";

export interface BlobRow {
  id: string; owner_id: string; conversation_id: string; digest: string;
  /** 列本身无 CHECK：媒体调用方传已验证的媒体枚举，工程文件传映射后的文件类型。 */
  mime_type: string; size_bytes: number; duration_ms: number | null;
}
export class ProductionBlobs {
  private readonly root: string;
  constructor(private readonly db: AgentDatabase, dataDir: string, private readonly clock: AgentClock) {
    this.root = path.join(dataDir, "blobs");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  // 这里只接收执行适配器已经探测过的字节；C 的网络下载/探测在适配器，不接受用户路径或 URL。
  persist(ownerId: string, conversationId: string, bytes: Buffer, mimeType: string, durationMs: number | null): BlobRow {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = this.dedupe(ownerId, conversationId, digest, mimeType, durationMs);
    if (existing) return existing;
    const temporary = path.join(this.root, newAgentId("tmp"));
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.filePath(digest));
    this.syncDirectory();
    return this.register(ownerId, conversationId, digest, mimeType, bytes.length, durationMs);
  }
  // 成片落盘：64KB 分块流式哈希 + 同盘 rename 零拷贝，避免整读数百 MB 成片造成主线程内存峰值
  // （审计第二阶段）。file 必须与 blobs 根同卷——调用方的 work 根在 dataDir 之下。
  async persistFromFile(ownerId: string, conversationId: string, file: string, mimeType: string, durationMs: number | null): Promise<BlobRow> {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      sizeBytes += buffer.length;
    }
    const digest = hash.digest("hex");
    const existing = this.dedupe(ownerId, conversationId, digest, mimeType, durationMs);
    if (existing) return existing;
    renameSync(file, this.filePath(digest));
    this.syncDirectory();
    return this.register(ownerId, conversationId, digest, mimeType, sizeBytes, durationMs);
  }
  // 命中同内容已有行时按只升级不降级规则复用（同一字节可先按工程文件登记、再按媒体成品补齐标签）；
  // 返回 undefined 表示需要新建行。
  private dedupe(ownerId: string, conversationId: string, digest: string, mimeType: string, durationMs: number | null): BlobRow | undefined {
    const existing = this.db.prepare("SELECT * FROM production_blobs WHERE owner_id=? AND conversation_id=? AND digest=?").get(ownerId, conversationId, digest) as BlobRow | undefined;
    if (!existing) return undefined;
    this.verify(existing);
    if (existing.mime_type === "application/octet-stream" && mimeType !== "application/octet-stream"
      || durationMs !== null && existing.duration_ms === null) {
      this.db.prepare("UPDATE production_blobs SET mime_type=?, duration_ms=COALESCE(duration_ms,?) WHERE id=?")
        .run(existing.mime_type === "application/octet-stream" ? mimeType : existing.mime_type, durationMs, existing.id);
      return this.get(ownerId, existing.id);
    }
    return existing;
  }
  private syncDirectory(): void {
    const directory = openSync(this.root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private register(ownerId: string, conversationId: string, digest: string, mimeType: string, sizeBytes: number, durationMs: number | null): BlobRow {
    const id = newAgentId("blob");
    this.db.prepare("INSERT INTO production_blobs(id,owner_id,conversation_id,digest,mime_type,size_bytes,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, ownerId, conversationId, digest, mimeType, sizeBytes, durationMs, this.clock());
    return this.get(ownerId, id);
  }
  get(ownerId: string, id: string): BlobRow {
    const row = this.db.prepare("SELECT * FROM production_blobs WHERE id=? AND owner_id=?").get(id, ownerId) as BlobRow | undefined;
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个媒体对象。");
    return row;
  }
  verify(row: BlobRow): void {
    try {
      // 常规路径只核对长度：文件由 persist() 按内容寻址原子写入，全量重读哈希会让百兆级成片
      // 在主线程秒级阻塞（审计第一阶段止血项）；流式哈希随第二阶段 persistFromFile 落地。
      if (statSync(this.filePath(row.digest)).size === row.size_bytes) return;
    } catch { /* 给调用边界一个明确的输入不可用结果。 */ }
    throw new AgentError("CAPABILITY_UNAVAILABLE", "媒体文件缺失或内容校验失败。");
  }
  filePath(digest: string): string { return path.join(this.root, digest); }
}
