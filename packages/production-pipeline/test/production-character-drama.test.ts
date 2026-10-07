import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProductionPipeline } from "../src/production-pipeline.js";
import type { CharacterScript } from "../src/character-script.js";
import type { VisualDirectorAgentInput } from "../src/visual-director.js";

test("MC-A05/13 formal script→director persists the explicit versions and exact character dialogue", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-character-pipeline-"));
  try {
    const { script } = JSON.parse(await readFile(new URL("../../../tests/fixtures/character-drama-cases.json", import.meta.url), "utf8")) as { script: CharacterScript };
    const calls: VisualDirectorAgentInput[] = [];
    const subject = new ProductionPipeline({ workspaceRoot,
      worker: { run: async (request) => ({ protocolVersion: "video-factory/worker-v1", commandId: String(request.commandId),
        status: "rejected", artifacts: [], error: { code: "CONTROLLED_STOP", message: "规划消费者测试到此为止，媒体由独立用例覆盖。" } }) },
      screenwriterAgent: { id: "codex-screenwriter-v1", draft: async () => structuredClone(script) },
      directorAgent: { id: "api-visual-director-v1", plan: async (input) => {
        calls.push(input);
        return { version: "video-factory/director-plan-v2", requestedProfileId: "auto", resolvedProfileId: "quiet-humanism",
          profileRationale: "对话反应镜头", visualBible: { narrativeApproach: "先疑问后发现", pacing: "自然", composition: "中景",
            camera: "固定", color: "自然", continuity: "同一小店", sound: "按角色分别配音" },
          shots: script.scenes.map((s) => ({ scenePosition: s.position, characterIds: s.character_ids, speakingTurnIds: s.dialogue.map((t) => t.id),
            narrativeRole: s.purpose, authenticityPolicy: "illustrative", preferredProviderId: "pexels-stock-v1", deliveryType: "stock_video",
            alternativeProviderIds: [], query: s.visual_prompt, generationPrompt: s.visual_prompt, rationale: "示意画面", continuityNote: "同一地点",
            temporalBeats: [{ startSeconds: 0, endSeconds: 6, action: "保持中景" }], confidence: 0.8, estimatedCostCny: 0 })) };
      } },
      assetProviders: [{ id: "pexels-stock-v1", label: "受控图库", billing: "free", modes: ["实拍"], deliveryTypes: ["stock_video"] }],
    });
    const run = await subject.start({ protocolVersion: "video-factory/brief-v1", title: "找钥匙", angle: "四人短剧", audience: "普通观众",
      nicheSlug: "story", durationSeconds: 24, platform: "douyin", reviewMode: "manual", runPurpose: "test", presentationMode: "character_drama",
      providers: { script: "codex-screenwriter-v1", director: "api-visual-director-v1", assets: "ai-shot-router-v1", voice: "macos-say-v1",
        render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" },
      director: { profileId: "auto", assetProviderIds: ["pexels-stock-v1"] },
      voiceDirection: { profileId: "macos:Tingting", rate: 185, pauseScale: 1, masteringPreset: "natural" },
    });
    assert.equal(calls.length, 1, JSON.stringify(run.nodeRuns.map((n) => ({ id: n.nodeId, status: n.status, error: n.error }))));
    assert.equal(calls[0]!.brief.presentationMode, "character_drama");
    assert.deepEqual(calls[0]!.brief.characters, script.characters);
    assert.ok(calls[0]!.scenes.every((s) => !("narration" in s) && "dialogue" in s));
    const scriptArtifact = run.artifacts.find((a) => a.kind === "script")!;
    const directorArtifact = run.artifacts.find((a) => a.kind === "storyboard")!;
    assert.equal(scriptArtifact.schemaVersion, script.version);
    assert.equal(directorArtifact.schemaVersion, "video-factory/director-plan-v2");
    const saved = JSON.parse(await readFile(scriptArtifact.uri!, "utf8"));
    assert.deepEqual(saved.characters, script.characters);
    assert.deepEqual(saved.scenes, script.scenes);
  } finally { await rm(workspaceRoot, { recursive: true, force: true }); }
});
