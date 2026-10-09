import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBrief, parsePersistedBrief } from "../src/contracts.js";
import { WanVideoAdapter, SeedanceVideoAdapter, MiniMaxVideoAdapter } from "../src/video-generation.js";

const base = {
  protocolVersion: "video-factory/brief-v1", title: "小店的三位客人", angle: "原创对话", audience: "普通观众",
  nicheSlug: "story", durationSeconds: 20, durationRange: { minSeconds: 20, maxSeconds: 30 },
  platform: "douyin", reviewMode: "manual", audioMode: "native_av", nativeVideoProviderId: "wan-video-v1",
  providers: { script: "codex-screenwriter-v1", director: "codex-visual-director-v1", assets: "ai-shot-router-v1",
    render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
  models: { "wan-video-v1": "wan3.0-video" }, director: { profileId: "auto", assetProviderIds: ["wan-video-v1"] },
  economics: { recipeId: "custom", allowMeteredProviders: true },
  workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, executablePlan: true },
};

describe("native audio brief boundary", () => {
  it("round-trips four origins with a host-owned local voice provider and no TTS configuration", () => {
    for (const origin of ["manual", "trend", "series", "case"]) {
      const parsed = parseBrief({ ...base, creationContext: { origin, opportunityId: origin === "case" ? "" : "op-1",
        ...(origin === "case" ? { caseSelectionId: "case-1" } : {}) } });
      assert.equal((parsed as unknown as Record<string, unknown>).audioMode, "native_av");
      assert.equal(parsed.providers.voice, "python-native-audio-v1");
      assert.equal(parsed.voiceDirection, undefined);
      assert.deepEqual(parsePersistedBrief(JSON.parse(JSON.stringify(parsed))), parsed);
    }
  });
  it("rejects invalid modes, unpinned models, mixed sources and TTS inputs before work", () => {
    for (const audioMode of [null, "native", 1, false]) assert.throws(() => parseBrief({ ...base, audioMode }), /audioMode/);
    for (const bad of [
      { models: {} }, { models: { "wan-video-v1": "wan3.0-prime" } },
      { director: { profileId: "auto", assetProviderIds: ["wan-video-v1", "pexels-stock-v1"] } },
      { voiceDirection: { profileId: "minimax:female-chengshu", rate: 190, pauseScale: 1, masteringPreset: "natural" } },
      { providers: { ...base.providers, voice: "minimax-tts-v1" } },
      { workflowFeatures: { assetSemanticRank: false, referenceGrammar: false } },
    ]) assert.throws(() => parseBrief({ ...base, ...bad }), /native|原生/);
  });
  it("preserves the old default without migration and still requires real TTS settings", () => {
    const { audioMode: _a, nativeVideoProviderId: _p, ...old } = base;
    const tts = { ...old, providers: { ...old.providers, voice: "minimax-tts-v1" },
      voiceDirection: { profileId: "minimax:female-chengshu", rate: 190, pauseScale: 1, masteringPreset: "natural" } };
    assert.equal(Object.hasOwn(parseBrief(tts), "audioMode"), false);
    assert.throws(() => parseBrief({ ...tts, voiceDirection: undefined }), /voiceDirection/);
    assert.throws(() => parseBrief({ ...tts, nativeVideoProviderId: "wan-video-v1" }), /nativeVideoProviderId/);
  });
});

describe("native provider request control", () => {
  it("sends explicit Wan audio policy for new requests without changing observation", async () => {
    for (const generateAudio of [true, false]) {
      const bodies: Record<string, unknown>[] = [];
      const adapter = new WanVideoAdapter({ apiKey: "test", workspaceId: "test", model: "wan3.0-video", sleep: async () => {},
        fetch: async (_url, init) => {
          if (init?.body) bodies.push(JSON.parse(String(init.body)));
          return Response.json({ output: init?.method === "POST" ? { task_id: "t", task_status: "PENDING" }
            : { task_id: "t", task_status: "SUCCEEDED", video_url: "https://media.example/v.mp4" } });
        } });
      const request = { prompt: "预算只够买一杯；你呢？", durationSeconds: 6, ratio: "9:16" as const, generateAudio };
      await adapter.generate(request);
      await adapter.reconcile!("t", {});
      assert.equal(bodies.length, 1);
      assert.equal((bodies[0]!.parameters as Record<string, unknown>).audio, generateAudio);
    }
  });
  it("sends Seedance audio but never invents a H3 audio switch", async () => {
    const bodies: Record<string, unknown>[] = [];
    const seedance = new SeedanceVideoAdapter({ apiKey: "test", model: "doubao-seedance-2-5-260628", sleep: async () => {},
      fetch: async (_url, init) => { if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return Response.json(init?.method === "POST" ? { id: "s" } : { id: "s", status: "succeeded", content: { video_url: "https://media.example/s.mp4" } }); } });
    await seedance.generate({ prompt: "对白", durationSeconds: 6, ratio: "9:16", generateAudio: true });
    assert.equal(bodies[0]!.generate_audio, true);
    const h3 = new MiniMaxVideoAdapter({ apiKey: "test", model: "MiniMax-H3", modelProtocols: { "MiniMax-H3": "v2" }, sleep: async () => {},
      fetch: async (_url, init) => { if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return Response.json(init?.method === "POST" ? { task_id: "h", base_resp: { status_code: 0 } }
          : { task: { status: "succeeded", content: { url: "https://media.example/h.mp4" } } }); } });
    await h3.generate({ prompt: "对白", durationSeconds: 6, ratio: "9:16", resolution: "768P", generateAudio: true });
    assert.equal(Object.hasOwn(bodies[1]!, "audio"), false);
    assert.equal(Object.hasOwn(bodies[1]!, "generate_audio"), false);
  });
});
