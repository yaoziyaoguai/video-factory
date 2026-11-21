import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

// 审计第二阶段：成片经 64KB 流式哈希 + 同盘硬链接零拷贝落盘，与 Buffer 路径共用内容寻址与去重。
// P1 已渲染成片无法恢复：摘要文件就位后源文件必须留在原位（回执边界），由调用方显式 release 归还。
test("persistFromFile：流式哈希等价于 Buffer 路径，硬链接保留源文件直至 release，去重复用原行", async t => {
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
  assert.ok(existsSync(source), "回执边界前源文件保留在尝试目录，恢复仍可从原位读取");
  assert.equal(existsSync(blobs.filePath(streamed.digest)), true);
  assert.equal(streamed.size_bytes, bytes.length);
  assert.equal(streamed.mime_type, "video/mp4");
  assert.equal(streamed.duration_ms, 12_345);
  blobs.verify(streamed);

  // 回执落库后归还源文件：仅删尝试目录的链接，blobs 根的内容寻址副本不受影响。
  blobs.release(source);
  assert.ok(!existsSync(source), "release 后源文件归还");
  assert.equal(existsSync(blobs.filePath(streamed.digest)), true, "blobs 根文件仍在");
  blobs.verify(streamed);
  blobs.release(source); // 重复归还静默幂等。

  // 与 Buffer 路径互为去重：同内容不另建行，只按只升级规则补齐标签。
  const buffered = blobs.persist("local-owner", "conv-2", bytes, "application/octet-stream", null);
  assert.equal(buffered.id, streamed.id);
  assert.equal(buffered.mime_type, "video/mp4", "标签只升级不降级");

  // 同摘要二次落盘（EEXIST 容错）不报错且不产生第二行。
  await writeFile(source, bytes);
  const again = await blobs.persistFromFile("local-owner", "conv-2", source, "video/mp4", 12_345);
  assert.equal(again.id, streamed.id);
  blobs.release(source);
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

// P1 刚登记的媒体被清理的验收（README：先扫描旧孤儿，再保存相同内容，登记文件仍能读回）。
// 审计的注入手法是 hook fs/promises.stat 在“清扫 stat 到旧孤儿之后、unlink 之前”安排一次
// 正常保存；修复后引用复查、mtime 复取与删除在同一同步段内完成，删除路径不再有异步 stat，
// 该注入点无从生效。这里按同一手法复核：注入不再命中清扫路径，随后的正常保存永远安全。
test("sweepOrphans：扫描期间不存在可注入的异步间隙，扫描后保存同内容仍可读回", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-blobs-sweep-race-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const db = openAgentDatabase(directory);
  t.after(() => db.close());
  const blobs = new ProductionBlobs(db, directory, staticClock);
  const root = path.join(directory, "blobs");

  const bytes = Buffer.from("swept-then-resaved");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const target = blobs.filePath(digest);
  await writeFile(target, bytes);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000);
  await utimes(target, threeDaysAgo, threeDaysAgo);

  const filesystem = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const originalStat = filesystem.stat;
  let statHookedDuringSweep = false;
  // 包装器按原签名整体委托；rest 参数展开无法保留重载精确保留，用同一类型断言收口。
  filesystem.stat = (async (...args: Parameters<typeof originalStat>) => {
    if (String(args[0]) === target) statHookedDuringSweep = true;
    return originalStat(...args);
  }) as typeof originalStat;
  syncBuiltinESMExports();
  t.after(() => { filesystem.stat = originalStat; syncBuiltinESMExports(); });

  // 第一遍清扫：删除超龄孤儿；修复后的删除路径是同步段，不应触发任何异步 stat。
  const first = await blobs.sweepOrphans({ olderThanMs: 86400_000 });
  assert.equal(first.files, 1, "超龄孤儿正常清除");
  assert.equal(statHookedDuringSweep, false, "删除判定不再经过可被并发保存交错的异步 stat");

  // 清扫后正常保存相同内容：登记行与文件必须可读回，再次清扫也不误删。
  const saved = blobs.persist("local-owner", "conv-4", bytes, "video/mp4", 900);
  blobs.verify(saved);
  assert.equal((await blobs.sweepOrphans({ olderThanMs: 86400_000 })).files, 0, "登记文件不被清扫");
  assert.equal(existsSync(blobs.filePath(saved.digest)), true);
  blobs.verify(saved);
});
