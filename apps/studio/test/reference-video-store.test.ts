import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ReferenceVideoStore } from "../src/server/reference-video-store.js";

const MP4_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe("ReferenceVideoStore", () => {
  it("stores a validated reference video and resolves only the server-side path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-reference-"));
    const store = new ReferenceVideoStore(root, () => new Date("2026-08-28T10:00:00.000Z"));

    const uploaded = await store.upload({ label: "节奏参考.mp4", mimeType: "video/mp4", bytes: MP4_HEADER });
    const resolved = await store.resolve(uploaded.uploadId);

    assert.equal(uploaded.label, "节奏参考.mp4");
    assert.equal(uploaded.sizeBytes, MP4_HEADER.length);
    assert.match(uploaded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(resolved.uploadId, uploaded.uploadId);
    assert.ok(resolved.path.startsWith(await realpath(root)));
    assert.deepEqual(await readFile(resolved.path), MP4_HEADER);
    assert.equal("path" in uploaded, false);
  });

  it("rejects a same-size reference video whose bytes changed after upload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-reference-"));
    const store = new ReferenceVideoStore(root);
    const uploaded = await store.upload({ label: "节奏参考.mp4", mimeType: "video/mp4", bytes: MP4_HEADER });
    const resolved = await store.resolve(uploaded.uploadId);
    const replacement = Buffer.from(MP4_HEADER);
    replacement.write("mp42", 8, "ascii");
    await writeFile(resolved.path, replacement);

    await assert.rejects(() => store.resolve(uploaded.uploadId), /内容已经变化/);
  });

  it("rejects a file whose bytes do not match the declared video container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-reference-"));
    const store = new ReferenceVideoStore(root);

    await assert.rejects(
      () => store.upload({ label: "伪装.mp4", mimeType: "video/mp4", bytes: Buffer.from("not-a-video!") }),
      /内容与文件类型不匹配/,
    );
  });

  it("creates a missing store root and expires old uploads", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "video-factory-reference-parent-"));
    const root = path.join(parent, "nested", "reference-videos");
    let now = new Date("2026-08-01T10:00:00.000Z");
    const store = new ReferenceVideoStore(root, () => now);
    const uploaded = await store.upload({ label: "短期参考.mp4", mimeType: "video/mp4", bytes: MP4_HEADER });

    now = new Date("2026-08-09T10:00:00.000Z");

    await assert.rejects(() => store.resolve(uploaded.uploadId), /超过 7 天保留期/);
  });

  it("returns a controlled error for an unknown upload and evicts the oldest item at capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-reference-"));
    let now = new Date("2026-08-01T10:00:00.000Z");
    const store = new ReferenceVideoStore(root, () => now);
    await assert.rejects(() => store.resolve("00000000-0000-0000-0000-000000000000"), /参考视频不存在或已经失效/);

    const uploads = [];
    for (let index = 0; index < 21; index += 1) {
      now = new Date(now.getTime() + 1_000);
      uploads.push(await store.upload({ label: `参考-${index}.mp4`, mimeType: "video/mp4", bytes: MP4_HEADER }));
    }
    await assert.rejects(() => store.resolve(uploads[0]!.uploadId), /不存在或已经失效/);
    assert.equal((await store.resolve(uploads.at(-1)!.uploadId)).uploadId, uploads.at(-1)!.uploadId);
  });
});
