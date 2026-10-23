import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseBrief, parsePersistedBrief } from "../src/contracts.js";
import { effectiveProductionBrief, ProductionPipeline } from "../src/production-pipeline.js";
import { FileRunStore } from "../src/run-store.js";

const brief = { protocolVersion: "video-factory/brief-v1", title: "普通记录", angle: "河边观察", audience: "", nicheSlug: "nature",
  durationSeconds: 30, platform: "douyin", reviewMode: "manual", providers: { script: "python-template-v1", assets: "local-editorial-v1",
    voice: "macos-say-v1", render: "python-ffmpeg-v1", technicalReview: "python-technical-review-v1" } };
const music = { uploadId: "a".repeat(64), sha256: "a".repeat(64), path: "/workspace/music/source", label: "自有音乐",
  licenseNote: "本人创作", durationSeconds: 20, volume: 0.25, fadeInSeconds: 1, fadeOutSeconds: 1.5, ducking: true };

test("单轨音乐设置完整持久化，旧制作和关闭音乐保持缺省", () => {
  assert.equal(parseBrief(brief).backgroundMusic, undefined);
  const parsed = parseBrief({ ...brief, backgroundMusic: music });
  assert.deepEqual(parsed.backgroundMusic, music);
  assert.deepEqual(parsePersistedBrief(JSON.parse(JSON.stringify(parsed))).backgroundMusic, music);
});

test("原生音画与无效混音不能混入独立曲目", () => {
  assert.throws(() => parseBrief({ ...brief, audioMode: "native_av", backgroundMusic: music }), /原生音画/);
  for (const change of [{ volume: 0.6 }, { fadeInSeconds: -1 }, { sha256: "b".repeat(64) }, { licenseNote: "" }, { durationSeconds: NaN }]) {
    assert.throws(() => parseBrief({ ...brief, backgroundMusic: { ...music, ...change } }));
  }
});

test("内容稿不能添加、替换或关闭宿主已绑定的背景音乐", () => {
  const injected = { ...music, path: "/tmp/not-from-music-store.wav", volume: 0.5 };
  for (const selected of [undefined, music]) {
    const initialInput = parseBrief({ ...brief, ...(selected ? { backgroundMusic: selected } : {}) });
    for (const proposed of [undefined, injected]) {
      const current = { ...initialInput, backgroundMusic: proposed };
      const result = effectiveProductionBrief({
        id: "music-content-boundary", revision: 1, workflowId: "production", workflowVersion: "1",
        status: "needs_human", initialInput, startedAt: "2026-10-23T00:00:00Z",
        nodeRuns: [{ nodeId: "brief", status: "succeeded", startedAt: "2026-10-23T00:00:00Z",
          output: current, artifactIds: [], qualityGateResults: [] }],
        artifacts: [], interventions: [], decisions: [],
      });
      assert.deepEqual(result.backgroundMusic, selected,
        "音乐必须取自开工时服务端解析的配置，不能由普通内容输入绕过素材库身份核验");
    }
  }
});

test("通用渲染输入编辑不能绕过选曲入口添加、删除或替换音乐", async t => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-music-input-boundary-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const pipeline = new ProductionPipeline({ workspaceRoot,
    worker: { run: async () => { throw new Error("This configuration test must not execute a worker."); } } });
  const store = new FileRunStore(path.join(workspaceRoot, "runs"));
  for (const selected of [undefined, music]) {
    const run = await pipeline.start({ ...brief, runPurpose: "test", ...(selected ? { backgroundMusic: selected } : {}),
      workflowFeatures: { assetSemanticRank: false, referenceGrammar: false, boundaryGates: "user-confirmed-v1" } });
    run.status = "stale";
    run.nodeRuns.push({ nodeId: "render", status: "stale", startedAt: run.startedAt, artifactIds: [], qualityGateResults: [],
      inputState: { nodeId: "render", effectiveVersionId: "render-input", stale: true,
        versions: [{ id: "render-input", nodeId: "render", source: "derived", createdAt: run.startedAt,
          createdBy: "creator", schemaVersion: "video-factory/node-input-v1", upstreamVersionIds: [], value: selected ? { backgroundMusic: selected } : {} }] } });
    await store.checkpoint(run);
    const before = JSON.stringify(await pipeline.show(run.id));
    for (const proposed of selected ? [undefined, { ...selected, volume: 0.5 }] : [music]) {
      await assert.rejects(pipeline.applyNodeInputOverride(run.id, { nodeId: "render", actor: "creator",
        expectedVersionId: "render-input", expectedRunRevision: run.revision,
        input: proposed ? { backgroundMusic: proposed } : {} }), /背景音乐|music/i);
      assert.equal(JSON.stringify(await pipeline.show(run.id)), before, "被拒绝的编辑不能改变当前制作或触发渲染");
    }
    const unchanged = await pipeline.applyNodeInputOverride(run.id, { nodeId: "render", actor: "creator",
      expectedVersionId: "render-input", expectedRunRevision: run.revision,
      input: selected ? { backgroundMusic: selected } : {} });
    const inputState = unchanged.nodeRuns.find(node => node.nodeId === "render")!.inputState!;
    assert.deepEqual(inputState.versions.find(version => version.id === inputState.effectiveVersionId)!.value,
      selected ? { backgroundMusic: selected } : {}, "保留原受管配置的普通输入复核仍然可用");
  }
});
