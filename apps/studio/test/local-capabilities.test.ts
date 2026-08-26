import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  LocalCapabilityService,
  parseMacOSVoiceList,
} from "../src/server/local-capabilities.js";
import { CapabilityStudio } from "../src/server/capability-studio.js";

const voiceOutput = `
Eddy (中文（中国大陆）) zh_CN    # 你好！我是Eddy。
Meijia              zh_TW    # 你好，我叫美佳。
Sinji               zh_HK    # 你好，我叫善怡。
Tingting            zh_CN    # 你好！我叫婷婷。
Samantha            en_US    # Hello! My name is Samantha.
`;

describe("local capability discovery", () => {
  it("keeps the core service healthy on Linux when macOS say is unavailable", async () => {
    const studio = new CapabilityStudio({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      environment: {},
      commandAvailable: async (command) => ["python3", "ffmpeg", "ffprobe"].includes(command),
      localCapabilities: {
        report: async () => [],
        listVoices: async () => [],
        preview: async () => undefined,
      },
    });

    assert.deepEqual(await studio.health(), {
      status: "ok",
      runtime: { python: true, ffmpeg: true, ffprobe: true, say: false },
    });
  });

  it("parses installed Chinese macOS voices into stable profiles", () => {
    const profiles = parseMacOSVoiceList(voiceOutput);

    assert.deepEqual(profiles.map((profile) => [profile.id, profile.locale]).sort(), [
      ["macos:Eddy (中文（中国大陆）)", "zh-CN"],
      ["macos:Meijia", "zh-TW"],
      ["macos:Sinji", "zh-HK"],
      ["macos:Tingting", "zh-CN"],
    ].sort());
    assert.equal(profiles.every((profile) => profile.providerId === "macos-say-v1"), true);
  });

  it("reports command and system voice evidence without self-hosted models or secrets", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-capabilities-"));
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      environment: { SECRET_TOKEN: "must-not-leak" },
      commandAvailable: async (command) => ["python3", "ffmpeg", "ffprobe", "say", "uv"].includes(command),
      runCommand: async (command, args) => {
        if (command === "say" && args[0] === "-v") return { stdout: voiceOutput, stderr: "" };
        return { stdout: "", stderr: "" };
      },
      pathExists: async () => false,
    });

    const report = await service.report();
    const voices = await service.listVoices();

    assert.equal(report.find((item) => item.id === "macos-voices")?.state, "ready");
    assert.match(report.find((item) => item.id === "macos-voices")?.evidence ?? "", /4 个中文音色/);
    assert.equal(report.some((item) => item.id === "kokoro-local" || item.id === "qwen3-local"), false);
    assert.equal(voices.length, 4);
    assert.doesNotMatch(JSON.stringify({ report, voices }), /must-not-leak/);
  });

  it("exposes a curated MiniMax voice cast when the server key is configured", async () => {
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      environment: { MINIMAX_API_KEY: "must-not-leak" },
      commandAvailable: async () => false,
      pathExists: async () => false,
    });

    const voices = await service.listVoices();

    assert.equal(voices.length >= 8, true);
    assert.equal(voices.every((voice) => voice.providerId === "minimax-tts-v1"), true);
    assert.equal(voices.some((voice) => voice.id === "minimax:Chinese (Mandarin)_News_Anchor"), true);
    assert.doesNotMatch(JSON.stringify(voices), /must-not-leak/);
  });

  it("previews a MiniMax actor through the server and masters the cached audio", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-minimax-preview-"));
    let requestBody: Record<string, unknown> | undefined;
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      environment: { MINIMAX_API_KEY: "server-only", MINIMAX_TTS_MODEL_ID: "speech-2.8-turbo" },
      commandAvailable: async () => false,
      pathExists: async () => false,
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          data: { audio: Buffer.from("fake-mp3").toString("hex"), status: 2 },
          base_resp: { status_code: 0, status_msg: "success" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      runCommand: async (command, args) => {
        if (command === "ffmpeg") await writeFile(args.at(-1)!, "mastered-audio");
        return { stdout: "", stderr: "" };
      },
    });

    const resource = await service.preview({
      profileId: "minimax:Chinese (Mandarin)_News_Anchor",
      text: "先看证据，再谈结论。",
      rate: 190,
      pauseScale: 1.8,
      masteringPreset: "natural",
    });

    assert.equal(resource?.contentType, "audio/mp4");
    assert.equal(requestBody?.model, "speech-2.8-turbo");
    assert.equal((requestBody?.voice_setting as { voice_id?: string }).voice_id, "Chinese (Mandarin)_News_Anchor");
    assert.match(String(requestBody?.text), /\n\n/);
    assert.doesNotMatch(JSON.stringify(requestBody), /server-only/);
  });

  it("coalesces concurrent previews so one click burst cannot bill twice", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-minimax-preview-"));
    let requestCount = 0;
    let renderCount = 0;
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      environment: { MINIMAX_API_KEY: "server-only" },
      commandAvailable: async () => false,
      pathExists: async () => false,
      fetcher: async () => {
        requestCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(JSON.stringify({
          data: { audio: Buffer.from("fake-mp3").toString("hex") },
          base_resp: { status_code: 0, status_msg: "success" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      runCommand: async (command, args) => {
        if (command === "ffmpeg") {
          renderCount += 1;
          await writeFile(args.at(-1)!, "mastered-audio");
        }
        return { stdout: "", stderr: "" };
      },
    });
    const input = {
      profileId: "minimax:Chinese (Mandarin)_News_Anchor",
      text: "这是一段并发预览。",
      rate: 190,
      pauseScale: 1,
      masteringPreset: "natural" as const,
    };

    const [first, second] = await Promise.all([service.preview(input), service.preview(input)]);

    assert.equal(first?.uri, second?.uri);
    assert.equal(requestCount, 1);
    assert.equal(renderCount, 1);
  });

  it("persists an hourly cloud preview limit across distinct texts", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-minimax-preview-"));
    let requests = 0;
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      environment: { MINIMAX_API_KEY: "server-only", VIDEO_FACTORY_MAX_CLOUD_VOICE_PREVIEWS_PER_HOUR: "1" },
      commandAvailable: async () => false,
      pathExists: async () => false,
      fetcher: async () => {
        requests += 1;
        return new Response(JSON.stringify({
          data: { audio: Buffer.from("fake-mp3").toString("hex") },
          base_resp: { status_code: 0, status_msg: "success" },
        }), { status: 200 });
      },
      runCommand: async (command, args) => {
        if (command === "ffmpeg") await writeFile(args.at(-1)!, "mastered-audio");
        return { stdout: "", stderr: "" };
      },
    });
    const base = {
      profileId: "minimax:Chinese (Mandarin)_News_Anchor",
      rate: 190,
      pauseScale: 1,
      masteringPreset: "natural" as const,
    };

    await service.preview({ ...base, text: "第一段试听。" });
    await assert.rejects(() => service.preview({ ...base, text: "第二段试听。" }), /每小时 1 次/);

    assert.equal(requests, 1);
  });

  it("does not discover self-hosted models even when old binaries and markers remain", async () => {
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      commandAvailable: async (command) => ["ollama", "uv"].includes(command),
      pathExists: async (target) => target.includes("kokoro.ready.json") || target.includes("qwen3.ready.json"),
    });

    const report = await service.report();

    assert.equal(report.some((item) => item.id === "kokoro-local" || item.id === "qwen3-local"), false);
    assert.equal((await service.listVoices()).some((voice) => voice.providerId === "kokoro-local-v1"), false);
  });

  it("honors verified project runtime directories from configuration", async () => {
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      environment: {
        VIDEO_FACTORY_PYTHON_RUNTIME: "/runtime/python",
      },
      commandAvailable: async () => false,
      pathExists: async (target) => [
        "/runtime/python/.venv/bin/python",
        "/runtime/python/python.ready.json",
      ].includes(target),
    });

    const report = await service.report();

    assert.equal(report.find((item) => item.id === "python")?.state, "ready");
    assert.match(report.find((item) => item.id === "python")?.evidence ?? "", /项目 Python/);
    assert.equal(report.some((item) => item.id === "qwen3-local"), false);
  });
});
