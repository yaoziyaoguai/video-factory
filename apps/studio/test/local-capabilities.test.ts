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

  it("reports command, voice, and optional model evidence without secrets", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-capabilities-"));
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      environment: { SECRET_TOKEN: "must-not-leak" },
      architecture: "arm64",
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
    assert.equal(report.find((item) => item.id === "kokoro-local")?.state, "available");
    assert.equal(voices.length, 4);
    assert.doesNotMatch(JSON.stringify({ report, voices }), /must-not-leak/);
  });

  it("does not offer the Apple Silicon Kokoro bootstrap on x64", async () => {
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      architecture: "x64",
      commandAvailable: async (command) => command === "uv",
      pathExists: async () => false,
    });

    const report = await service.report();

    assert.equal(report.find((item) => item.id === "kokoro-local")?.state, "missing");
  });

  it("honors verified project runtime directories from configuration", async () => {
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot: "/workspace",
      environment: {
        VIDEO_FACTORY_PYTHON_RUNTIME: "/runtime/python",
        VIDEO_FACTORY_AGENT_RUNTIME: "/runtime/agent",
      },
      commandAvailable: async (command) => command === "ollama",
      pathExists: async (target) => [
        "/runtime/python/.venv/bin/python",
        "/runtime/python/python.ready.json",
        "/runtime/agent/qwen3.ready.json",
      ].includes(target),
    });

    const report = await service.report();

    assert.equal(report.find((item) => item.id === "python")?.state, "ready");
    assert.match(report.find((item) => item.id === "python")?.evidence ?? "", /项目 Python/);
    assert.equal(report.find((item) => item.id === "qwen3-local")?.state, "ready");
  });

  it("gives first-run neural voice synthesis a longer execution budget", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-voice-preview-"));
    const commandBudgets: Array<{ command: string; timeoutMs: number | undefined }> = [];
    const service = new LocalCapabilityService({
      repositoryRoot: "/repo",
      workspaceRoot,
      commandAvailable: async () => false,
      pathExists: async (target) => target.endsWith("kokoro.ready.json"),
      runCommand: async (command, args, execution) => {
        commandBudgets.push({ command, timeoutMs: execution?.timeoutMs });
        const outputPath = command === "ffmpeg" ? args.at(-1) : args[args.indexOf("--output") + 1];
        if (outputPath) await writeFile(outputPath, "audio");
        return { stdout: "", stderr: "" };
      },
    });

    const preview = await service.preview({
      profileId: "kokoro:zf_002",
      text: "第一次试听也应该可靠完成。",
      rate: 180,
      pauseScale: 1,
      masteringPreset: "natural",
    });

    assert.equal(preview?.contentType, "audio/mp4");
    assert.equal(commandBudgets[0]?.timeoutMs, 180_000);
    assert.equal(commandBudgets[1]?.timeoutMs, undefined);
  });
});
