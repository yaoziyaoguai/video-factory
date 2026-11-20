import assert from "node:assert/strict";
import { mkdtemp, rm, truncate } from "node:fs/promises";
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
