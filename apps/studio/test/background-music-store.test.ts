import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BackgroundMusicStore } from "../src/server/background-music-store.js";

const mix = { volume: 0.25, fadeInSeconds: 1, fadeOutSeconds: 1.5, ducking: true };

test("音乐上传核验真实媒体，按内容保存并只使用服务端来源", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-music-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", fixture]);
  const bytes = await readFile(fixture);
  const store = new BackgroundMusicStore(path.join(root, "library"));
  const uploaded = await store.upload({ label: "测试音乐.wav", licenseNote: "本地合成测试夹具", bytes });
  assert.equal(uploaded.durationSeconds, 2);
  assert.equal("path" in uploaded, false);
  const resolved = await store.resolve({ ...mix, uploadId: uploaded.uploadId, path: "/etc/passwd", sha256: "0".repeat(64), licenseNote: "forged" });
  assert.deepEqual(await readFile(resolved.path), bytes);
  assert.equal(resolved.licenseNote, "本地合成测试夹具");
  assert.equal(resolved.sha256, uploaded.uploadId);
  assert.equal((await store.resource(uploaded.uploadId)).contentType, "audio/wav");
  assert.deepEqual(await store.upload({ label: "another.wav", licenseNote: "重复文件", bytes }), uploaded);
  // 重启和长久使用不会让已采用制作引用的曲目过期。
  assert.equal((await new BackgroundMusicStore(path.join(root, "library")).resolve({ ...mix, uploadId: uploaded.uploadId })).sha256, uploaded.uploadId);
  await writeFile(resolved.path, Buffer.alloc(bytes.length));
  await assert.rejects(store.resolve({ ...mix, uploadId: uploaded.uploadId }), /内容已变化/);
});

test("无授权、伪装文件、路径穿越和非法混音不被接受", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "vf-music-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new BackgroundMusicStore(root);
  await assert.rejects(store.upload({ label: "file.wav", licenseNote: "", bytes: Buffer.alloc(100) }), /授权/);
  await assert.rejects(store.upload({ label: "file.wav", licenseNote: "自有", bytes: Buffer.alloc(100) }));
  await assert.rejects(store.resolve({ ...mix, uploadId: "../../private" }), /编号/);
  await assert.rejects(store.resolve({ ...mix, uploadId: "f".repeat(64), volume: Infinity }), /volume/);
  await assert.rejects(store.resolve({ ...mix, uploadId: "f".repeat(64), ducking: "true" }), /明确/);
});
