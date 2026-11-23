import { createHash } from "node:crypto";
import { existsSync, readdirSync, createWriteStream, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, renameSync, statSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { AgentDatabase } from "./db.js";
import { newAgentId, type AgentClock } from "./util.js";
import { AgentError } from "./errors.js";

export interface BlobRow {
  id: string; owner_id: string; conversation_id: string; digest: string;
  /** 列本身无 CHECK：媒体调用方传已验证的媒体枚举，工程文件传映射后的文件类型。 */
  mime_type: string; size_bytes: number; duration_ms: number | null; purged_at: string | null;
}
export interface PreparedFile { file: string; digest: string; sizeBytes: number }

type RegisterFile = (source: PreparedFile, mimeType: string, durationMs: number | null) => BlobRow;

export class ProductionBlobs {
  readonly transferRoot: string;
  readonly stagingRoot: string;
  private readonly root: string;
  private readonly archiveRoot: string;
  constructor(private readonly db: AgentDatabase, dataDir: string, private readonly clock: AgentClock) {
    this.root = path.join(dataDir, "blobs");
    this.archiveRoot = path.join(this.root, ".archiving");
    this.transferRoot = path.join(dataDir, "creative-transfer");
    this.stagingRoot = path.join(this.root, ".staging");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (existsSync(this.archiveRoot)) this.finishArchive();
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
  async withStagingDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(this.stagingRoot, "tmp-"));
    try { return await action(directory); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  async sweepStaging(): Promise<void> {
    const cutoff = Date.now() - 86400_000;
    for (const [root, names] of [[this.stagingRoot, /^tmp-[a-z0-9_-]+$/i], [this.transferRoot, /^[a-f0-9]{64}-(?:inputs|[a-f0-9-]{36})$/]] as const) {
      let entries;
      try { entries = await readdir(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const name of entries.filter(name => names.test(name))) {
        const file = path.join(root, name);
        try { if ((await stat(file)).mtimeMs < cutoff) await rm(file, { recursive: true, force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }

  // 复用固定缓冲区，最大成片也不会逐块分配数百 MiB 的 Buffer。
  async prepareFile(file: string): Promise<PreparedFile> {
    const handle = await open(file, "r");
    const hash = createHash("sha256");
    const block = Buffer.allocUnsafe(256 * 1024);
    let sizeBytes = 0;
    try {
      for (;;) {
        const { bytesRead } = await handle.read(block, 0, block.length, null);
        if (bytesRead === 0) break;
        hash.update(block.subarray(0, bytesRead));
        sizeBytes += bytesRead;
      }
      await handle.sync();
      return { file, digest: hash.digest("hex"), sizeBytes };
    } finally { await handle.close(); }
  }

  // SQLite 回滚不能撤销硬链接。只回收本事务实际新建且回滚后没有任何所有者登记的摘要。
  withRegistration<T>(ownerId: string, conversationId: string, action: (register: RegisterFile) => T): T {
    const linked = new Set<string>();
    let committed = false;
    const register: RegisterFile = (source, mimeType, durationMs) => {
      const existing = this.dedupe(ownerId, conversationId, source.digest, mimeType, durationMs);
      if (existing) return existing;
      try {
        linkSync(source.file, this.filePath(source.digest));
        linked.add(source.digest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return this.register(ownerId, conversationId, source.digest, mimeType, source.sizeBytes, durationMs);
    };
    try {
      const result = this.db.transaction(() => {
        const value = action(register);
        if (linked.size) this.syncDirectory();
        return value;
      }).immediate();
      committed = true;
      return result;
    } finally {
      if (!committed && linked.size) this.db.transaction(() => {
        const retained = this.db.prepare("SELECT 1 FROM production_blobs WHERE digest=? AND purged_at IS NULL LIMIT 1");
        for (const digest of linked) if (!retained.get(digest)) unlinkSync(this.filePath(digest));
        this.syncDirectory();
      }).immediate();
    }
  }

  async persistFromFileAsync(ownerId: string, conversationId: string, file: string, mimeType: string, durationMs: number | null): Promise<BlobRow> {
    const prepared = await this.prepareFile(file);
    return this.withRegistration(ownerId, conversationId, register => register(prepared, mimeType, durationMs));
  }

  async persistFromStream(ownerId: string, conversationId: string, readable: Readable, mimeType: string, durationMs: number | null): Promise<BlobRow> {
    await mkdir(this.stagingRoot, { mode: 0o700, recursive: true });
    const file = path.join(this.stagingRoot, newAgentId("tmp"));
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const measure = new Transform({ transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      done(null, chunk);
    } });
    try {
      await pipeline(readable, measure, createWriteStream(file, { flags: "wx", mode: 0o600, flush: true }));
      return this.withRegistration(ownerId, conversationId, register => register({ file, digest: hash.digest("hex"), sizeBytes }, mimeType, durationMs));
    } finally { await rm(file, { force: true }); }
  }
  // 命中同内容已有行时按只升级不降级规则复用（同一字节可先按工程文件登记、再按媒体成品补齐标签）；
  // 返回 undefined 表示需要新建行。
  private dedupe(ownerId: string, conversationId: string, digest: string, mimeType: string, durationMs: number | null): BlobRow | undefined {
    const existing = this.db.prepare("SELECT * FROM production_blobs WHERE owner_id=? AND conversation_id=? AND digest=? AND purged_at IS NULL").get(ownerId, conversationId, digest) as BlobRow | undefined;
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
  private syncDirectory(root = this.root): void {
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  private register(ownerId: string, conversationId: string, digest: string, mimeType: string, sizeBytes: number, durationMs: number | null): BlobRow {
    const revived = this.db.prepare(`UPDATE production_blobs SET purged_at=NULL,created_at=?,mime_type=?,duration_ms=coalesce(?,duration_ms)
      WHERE owner_id=? AND conversation_id=? AND digest=? AND purged_at IS NOT NULL RETURNING *`)
      .get(this.clock(), mimeType, durationMs, ownerId, conversationId, digest) as BlobRow | undefined;
    if (revived) return revived;
    const id = newAgentId("blob");
    this.db.prepare("INSERT INTO production_blobs(id,owner_id,conversation_id,digest,mime_type,size_bytes,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, ownerId, conversationId, digest, mimeType, sizeBytes, durationMs, this.clock());
    return this.get(ownerId, id);
  }
  get(ownerId: string, id: string): BlobRow {
    const row = this.db.prepare("SELECT * FROM production_blobs WHERE id=? AND owner_id=?").get(id, ownerId) as BlobRow | undefined;
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个媒体对象。");
    if (row.purged_at) throw new AgentError("MEDIA_ARCHIVED", "这份历史草稿的媒体已归档。");
    return row;
  }
  verify(row: BlobRow): void {
    try {
      // 常规路径只核对长度：文件由 persist() 按内容寻址原子写入，全量重读哈希会让百兆级成片
      // 在主线程秒级阻塞。真实摘要在写入时以流式方式计算。
      if (statSync(this.filePath(row.digest)).size === row.size_bytes) return;
    } catch { /* 给调用边界一个明确的输入不可用结果。 */ }
    throw new AgentError("CAPABILITY_UNAVAILABLE", "媒体文件缺失或内容校验失败。");
  }
  filePath(digest: string): string { return path.join(this.root, digest); }

  // SQLite 与文件系统没有共同事务。先原子改名，事务提交后才释放字节；进程在
  // 两者之间退出时，下次打开按已提交的登记恢复原名或完成删除。
  withArchive<T>(action: (stage: (digest: string) => number | null) => T): T {
    let moved = false;
    try {
      return this.db.transaction(() => {
        const result = action(digest => {
          mkdirSync(this.archiveRoot, { recursive: true, mode: 0o700 });
          const staged = path.join(this.archiveRoot, digest);
          try { renameSync(this.filePath(digest), staged); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
          moved = true;
          return statSync(staged).size;
        });
        if (moved) { this.syncDirectory(this.archiveRoot); this.syncDirectory(); }
        return result;
      }).immediate();
    } finally { if (existsSync(this.archiveRoot)) this.finishArchive(); }
  }

  private finishArchive(): void {
    this.db.transaction(() => {
      const paths = readdirSync(this.archiveRoot);
      if (!paths.length) return;
      const retained = this.db.prepare("SELECT 1 FROM production_blobs WHERE digest=? AND purged_at IS NULL LIMIT 1");
      for (const digest of paths) {
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("归档目录存在未知文件。");
        const staged = path.join(this.archiveRoot, digest);
        if (retained.get(digest) && !existsSync(this.filePath(digest))) renameSync(staged, this.filePath(digest));
        else unlinkSync(staged);
      }
      this.syncDirectory(this.archiveRoot);
      this.syncDirectory();
    }).immediate();
  }

  /** 仅删除超过保留期、且无登记引用的摘要文件或临时文件。 */
  async sweepOrphans(options: { now?: () => Date; olderThanMs?: number } = {}): Promise<{ files: number; bytes: number }> {
    const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1000;
    const cutoff = (options.now ?? (() => new Date()))().getTime() - olderThanMs;
    let files = 0;
    let bytes = 0;
    const entries = await readdir(this.root);
    // 目录异步读取后再取引用，直到最后一次删除之间不让出执行权，避免用过期集合删除新登记的文件。
    const referenced = new Set(this.db.prepare("SELECT DISTINCT digest FROM production_blobs WHERE purged_at IS NULL").pluck().all() as string[]);
    for (const name of entries) {
      const temporary = name.startsWith("tmp-");
      const digestLike = /^[a-f0-9]{64}$/.test(name);
      if (!temporary && (!digestLike || referenced.has(name))) continue;
      try {
        const file = path.join(this.root, name);
        const info = statSync(file);
        if (!info.isFile() || info.mtimeMs >= cutoff) continue;
        unlinkSync(file);
        files += 1;
        bytes += info.size;
      } catch { /* 并发消失或不可删的文件留待下次扫尾。 */ }
    }
    return { files, bytes };
  }
}
