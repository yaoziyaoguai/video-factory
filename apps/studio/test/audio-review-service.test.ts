import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { AudioReviewService } from "../src/server/audio-review-service.js";
import { ModelRegistry } from "../../codex-broker/src/model-registry.js";
import { taskContractDescriptorFor } from "../../codex-broker/src/task-definitions.js";
import { CodexBridgeClient, CodexBridgeError, AUDIO_REVIEW_CHECKS, validateAudioReviewReport } from "@video-factory/production-pipeline";
import type { ConnectedModel } from "../src/server/model-connections.js";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const audio = Buffer.from("ID3-test-soundtrack");
const media = { prepare: async () => ({ durationMs: 1000, frames: [{ timecodeMs: 0, sha256: sha(jpeg), jpegBase64: jpeg.toString("base64") }] }) };
const checks = Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"]));

test("audio task travels through durable socket; same evidence resumes without new execution", async () => {
  const directory = await mkdtemp("/tmp/vf-audio-");
  let calls = 0;
  const registry = new ModelRegistry({ directory: path.join(directory, "registry"), socketDirectory: directory, timeoutMs: 1000,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["audio-review"] },
      modelCandidates: [entry.id], runTask: async (task) => {
        calls++;
        assert.equal(task.kind, "audio-review");
        if (task.kind !== "audio-review") throw new Error("wrong task");
        assert.deepEqual(task.payload.audio, audio);
        return { output: JSON.stringify({ audioSha256: task.payload.audioSha256, summary: "测试仅确认声音证据送达，不伪造听感。", checks, findings: [] }), trace: {
          providerId: entry.id, modelId: entry.id, taskKind: task.kind, prompt: "test",
          contractDigest: taskContractDescriptorFor(task.kind).digest, promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
        } };
      },
    }),
  });
  try {
    await registry.start();
    await registry.handle("POST", "/v1/models", { label: "Audio", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "audio-native", apiKey: "test", maxOutputTokens: 32000, capabilities: ["image", "audio"] });
    const model = registry.list()[0]!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
    let wireFailure: unknown;
    const originalRun = client.runTaskDetailed.bind(client);
    client.runTaskDetailed = async (...args) => {
      try { return await originalRun(...args); } catch (error) { wireFailure = error; throw error; }
    };
    const connections: ConnectedModel[] = [{ model, client }];
    const service = new AudioReviewService({ connections: () => connections, media, extract: async (_video, output) => { await writeFile(output, audio); } });
    const video = path.join(directory, "render.mp4");
    await writeFile(video, "fixture-video");
    const input = { runRoot: directory, videoPath: video, selectedAudioModelId: model.id };
    const first = await service.review(input);
    assert.equal(first.status, "completed", `${JSON.stringify(first)} ${String(wireFailure)}`);
    if (first.status === "completed") {
      assert.equal(first.audioSha256, sha(audio));
      assert.equal(first.videoSha256, sha(Buffer.from("fixture-video")));
    }
    assert.equal((await service.review(input)).status, "completed");
    assert.equal(calls, 1);
    const originalObserve = client.observePrepared.bind(client);
    client.observePrepared = async () => { throw new CodexBridgeError("waiting", false, "uncertain"); };
    assert.equal((await service.review(input)).status, "uncertain");
    assert.equal(calls, 1);
    client.observePrepared = originalObserve;
    assert.equal((await service.review({ runRoot: directory, videoPath: video })).status, "not_configured", "old runs must not silently acquire a new model");
    const wrongRoot = await mkdtemp("/tmp/vf-audio-boundary-");
    try { assert.equal((await service.review({ ...input, runRoot: wrongRoot })).status, "failed"); }
    finally { await rm(wrongRoot, { recursive: true, force: true }); }
    assert.equal(calls, 1);
    model.enabled = false;
    assert.equal((await service.review(input)).status, "completed", "disabling must not hide an accepted result");
    await writeFile(video, "changed-video");
    assert.equal((await service.review(input)).status, "not_reviewed", "disabled connection cannot submit new evidence");
    assert.equal(calls, 1);
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});

test("audio findings bind the actual track, valid time range, and check result", () => {
  const report = { audioSha256: sha(audio), summary: "测试", checks, findings: [] };
  assert.equal(validateAudioReviewReport(report, sha(audio), 1000).summary, "测试");
  assert.throws(() => validateAudioReviewReport(report, "a".repeat(64), 1000), /音轨/);
  assert.throws(() => validateAudioReviewReport(report, sha(audio), Number.NaN), /时长/);
  assert.throws(() => validateAudioReviewReport({ ...report, checks: { ...checks, pauses: "issue" } }, sha(audio), 1000), /时间定位/);
  assert.throws(() => validateAudioReviewReport({ ...report, findings: [{ startMs: 900, endMs: 1100, category: "pauses", observation: "不自然", suggestion: "调整" }] }, sha(audio), 1000), /时间范围/);
});

test("real ffmpeg extraction sends the whole rendered soundtrack and does not call a model for silent video", async () => {
  const directory = await mkdtemp("/tmp/vf-audio-ffmpeg-");
  const execFile = promisify(execFileCallback);
  let calls = 0;
  const client = new CodexBridgeClient({ socketPath: "/unused/test" });
  client.runTaskDetailed = async (_kind, input) => {
    calls++;
    const payload = input as { audioBase64: string; audioSha256: string };
    const bytes = Buffer.from(payload.audioBase64, "base64");
    assert.ok(bytes.length > 8000, "actual encoded soundtrack, not transcript");
    assert.equal(sha(bytes), payload.audioSha256);
    return { output: { audioSha256: payload.audioSha256, summary: "提取测试", checks, findings: [] }, trace: { taskKind: "audio-review", providerId: "m-333333333333", modelId: "m-333333333333", promptVersion: "test", prompt: "test" } };
  };
  const service = new AudioReviewService({ media, connections: () => [{ client, model: { id: "m-333333333333", label: "测试", modelId: "audio", enabled: true, credentialConfigured: true, socketName: "m-333333333333.sock", protocol: "openai-chat-completions", baseUrl: "https://example.com", capabilities: ["audio", "image"], maxOutputTokens: 32000 } }] });
  try {
    const video = path.join(directory, "video.mp4");
    await execFile("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", video]);
    assert.equal((await service.review({ runRoot: directory, videoPath: video, selectedAudioModelId: "m-333333333333" })).status, "completed");
    const silent = path.join(directory, "silent.mp4");
    await execFile("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", video, "-an", "-c:v", "copy", silent]);
    assert.equal((await service.review({ runRoot: directory, videoPath: silent, selectedAudioModelId: "m-333333333333" })).status, "failed");
    assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
