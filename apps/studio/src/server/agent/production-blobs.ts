import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentDatabase } from "./db.js";
import type { MediaContent } from "../../shared/agent/generated/contracts.js";
import { newAgentId, type AgentClock } from "./util.js";
import { AgentError } from "./errors.js";

export interface BlobRow {
  id: string; owner_id: string; conversation_id: string; digest: string;
  mime_type: MediaContent["mimeType"]; size_bytes: number; duration_ms: number | null;
}
export class ProductionBlobs {
  private readonly root: string;
  constructor(private readonly db: AgentDatabase, dataDir: string, private readonly clock: AgentClock) {
    this.root = path.join(dataDir, "blobs");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  // 这里只接收执行适配器已经探测过的字节；C 的网络下载/探测在适配器，不接受用户路径或 URL。
  persist(ownerId: string, conversationId: string, bytes: Buffer, mimeType: MediaContent["mimeType"], durationMs: number | null): BlobRow {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.prepare("SELECT * FROM production_blobs WHERE owner_id=? AND conversation_id=? AND digest=?").get(ownerId, conversationId, digest) as BlobRow | undefined;
    if (existing) { this.verify(existing); return existing; }
    const temporary = path.join(this.root, newAgentId("tmp"));
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, this.filePath(digest));
    const directory = openSync(this.root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    const id = newAgentId("blob");
    this.db.prepare("INSERT INTO production_blobs(id,owner_id,conversation_id,digest,mime_type,size_bytes,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, ownerId, conversationId, digest, mimeType, bytes.length, durationMs, this.clock());
    return this.get(ownerId, id);
  }
  get(ownerId: string, id: string): BlobRow {
    const row = this.db.prepare("SELECT * FROM production_blobs WHERE id=? AND owner_id=?").get(id, ownerId) as BlobRow | undefined;
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个媒体对象。");
    return row;
  }
  verify(row: BlobRow): void {
    try {
      const file = this.filePath(row.digest);
      if (statSync(file).size === row.size_bytes && createHash("sha256").update(readFileSync(file)).digest("hex") === row.digest) return;
    } catch { /* 给调用边界一个明确的输入不可用结果。 */ }
    throw new AgentError("CAPABILITY_UNAVAILABLE", "媒体文件缺失或内容校验失败。");
  }
  filePath(digest: string): string { return path.join(this.root, digest); }
}
