import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openAgentDatabase } from "../src/server/agent/db.js";
import { ProductionBlobs } from "../src/server/agent/production-blobs.js";
import { AgentError } from "../src/server/agent/errors.js";

const staticClock = () => "2026-11-20T00:00:00.000Z";

// 审计第一阶段止血项：verify() 常规路径改为只校验文件长度，不再全量重读哈希。
// 必须守住的不变量：文件缺失或长度不符时仍给调用边界 CAPABILITY_UNAVAILABLE。
test("verify 常规路径按长度校验：命中即通过，截断与缺失仍拒绝", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-blobs-verify-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const blobs = new ProductionBlobs(db, directory, staticClock);

  const row = blobs.persist("local-owner", "conv-1", Buffer.from("frame-blob-bytes"), "application/octet-stream", null);
  blobs.verify(row);
  // 同一字节再次落库走去重分支，同样只做长度校验并复用原行。
  assert.equal(blobs.persist("local-owner", "conv-1", Buffer.from("frame-blob-bytes"), "application/octet-stream", null).id, row.id);

  const file = path.join(directory, "blobs", row.digest);
  await truncate(file, 4);
  assert.throws(() => blobs.verify(row), (error: unknown) =>
    error instanceof AgentError && error.code === "CAPABILITY_UNAVAILABLE", "长度不符应拒绝");

  await rm(file, { force: true });
  assert.throws(() => blobs.verify(row), (error: unknown) =>
    error instanceof AgentError && error.code === "CAPABILITY_UNAVAILABLE", "文件缺失应拒绝");
});

// 审计第二阶段：成片经 64KB 流式哈希 + 同盘 rename 零拷贝落盘，与 Buffer 路径共用内容寻址与去重。
test("persistFromFile：流式哈希等价于 Buffer 路径，零拷贝移动源文件，去重复用原行", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-blobs-file-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const blobs = new ProductionBlobs(db, directory, staticClock);

  const bytes = Buffer.from("streamed-render-output-bytes");
  const source = path.join(directory, "work", "final.mp4");
  await mkdir(path.join(directory, "work"), { recursive: true });
  await writeFile(source, bytes);
  const streamed = await blobs.persistFromFile("local-owner", "conv-2", source, "video/mp4", 12_345);
  assert.ok(!existsSync(source), "源文件应被零拷贝移动");
  assert.equal(existsSync(blobs.filePath(streamed.digest)), true);
  assert.equal(streamed.size_bytes, bytes.length);
  assert.equal(streamed.mime_type, "video/mp4");
  assert.equal(streamed.duration_ms, 12_345);
  blobs.verify(streamed);

  // 与 Buffer 路径互为去重：同内容不另建行，只按只升级规则补齐标签。
  const buffered = blobs.persist("local-owner", "conv-2", bytes, "application/octet-stream", null);
  assert.equal(buffered.id, streamed.id);
  assert.equal(buffered.mime_type, "video/mp4", "标签只升级不降级");
});

// 审计第三阶段：未入库草稿媒体（崩溃遗留 tmp-* 与无行引用的 digest 文件）按天龄清扫；
// 入库文件与新鲜孤儿不动，非预期文件名保守跳过。
test("sweepOrphans：删除超龄孤儿与 tmp 残留，保留入库文件与新鲜文件", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-blobs-sweep-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const root = path.join(directory, "blobs");

  const kept = blobs.persist("local-owner", "conv-3", Buffer.from("kept-blob"), "application/octet-stream", null);
  const oldDigest = "b".repeat(64);
  const freshDigest = "c".repeat(64);
  await writeFile(path.join(root, oldDigest), "orphan-old");
  await writeFile(path.join(root, freshDigest), "orphan-fresh");
  await writeFile(path.join(root, "tmp-stale-upload"), "stale");
  await writeFile(path.join(root, "unexpected-name.txt"), "keep");
  // 把两个“应删”文件的 mtime 回拨到 3 天前（fresh 与 tmp 之外的新鲜对照走当前 mtime）。
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
  await utimes(path.join(root, oldDigest), threeDaysAgo, threeDaysAgo);
  await utimes(path.join(root, "tmp-stale-upload"), threeDaysAgo, threeDaysAgo);

  const result = await blobs.sweepOrphans({ olderThanMs: 86400_000 });
  assert.equal(result.files, 2);
  assert.equal(result.bytes, "orphan-old".length + "stale".length);
  assert.equal(existsSync(blobs.filePath(kept.digest)), true, "入库文件保留");
  assert.equal(existsSync(path.join(root, oldDigest)), false, "超龄无行 digest 删除");
  assert.equal(existsSync(path.join(root, freshDigest)), true, "新鲜孤儿保留（并发窗口保护）");
  assert.equal(existsSync(path.join(root, "unexpected-name.txt")), true, "非预期文件名不动");
  assert.equal((await blobs.sweepOrphans({ olderThanMs: 86400_000 })).files, 0, "幂等");
});
