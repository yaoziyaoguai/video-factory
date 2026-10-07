import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NARRATION_FIT_CONFLICT_V2_VERSION, parseNarrationFitConflictV2, parseNarrationFitConflictV3, parseNarrationRelayoutRequest, parseRelayoutSource, RELAYOUT_OPERATION_VERSION } from "../src/narration-relayout.js";

describe("narration-relayout 合同解析（§2.4）", () => {
  const validVoiceVersion = {
    kind: "voice_version", voiceVersionId: "input-version-1",
    voicePlanArtifactId: "artifact-1", voicePlanSha256: "a".repeat(64),
    expectedNarrationPlanSha256: "b".repeat(64), expectedLayoutKey: "layout-key-1",
    expectedAudioSha256: "c".repeat(64), sourceVoiceOperationId: "voice-op-1",
  };
  const validLayout = {
    narrationPlanVersion: "video-factory/narration-plan-v1" as const,
    groups: [{ groupId: "narration-1", window: { startFrame: 0, endFrame: 180 },
      placement: { anchor: "start" as const, offsetFrames: 0 } }],
    userSilences: [],
  };

  it("接受两类来源的 apply 请求并保留全部身份字段", () => {
    const parsed = parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-relayout-1",
      expectedRunRevision: 8, interventionId: "intervention-1",
      sourceContextId: "sc-1", note: "把第一段往后挪",
      source: validVoiceVersion, layout: validLayout,
    });
    assert.equal(parsed.intent, "apply");
    assert.equal(parsed.source.kind, "voice_version");
    assert.deepEqual(parsed.layout.groups[0]?.window, { startFrame: 0, endFrame: 180 });
    const materialized = parseRelayoutSource({
      kind: "materialized_operation", voiceInputVersionId: "input-version-0",
      sourceVoiceOperationId: "voice-op-0", sourceManifestArtifactId: "artifact-m",
      sourceManifestSha256: "d".repeat(64), sourceReceiptArtifactId: "artifact-r",
    });
    assert.equal(materialized.kind, "materialized_operation");
  });

  it("拒绝未知来源类型、坏摘要、坏整数与空说明", () => {
    assert.throws(() => parseRelayoutSource({ kind: "cache" }), /来源类型未知/);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-2", expectedRunRevision: 1,
      interventionId: "intervention-1", sourceContextId: "sc-1", note: "x",
      source: { ...validVoiceVersion, expectedAudioSha256: "nothex" },
      layout: validLayout }), /64 位十六进制/);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-3", expectedRunRevision: -1,
      interventionId: "intervention-1", sourceContextId: "sc-1", note: "x",
      source: validVoiceVersion, layout: validLayout }), /非负安全整数/);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-4", expectedRunRevision: 1,
      interventionId: "intervention-1", sourceContextId: "sc-1", note: "   ",
      source: validVoiceVersion, layout: validLayout }), /说明/);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-5", expectedRunRevision: 1,
      interventionId: "intervention-1", sourceContextId: "sc-1", note: "x", source: validVoiceVersion,
      layout: { ...validLayout, userSilences: [{ startFrame: 1.5, endFrame: 2 }] } }), /整数帧/);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-missing-stop", expectedRunRevision: 1,
      sourceContextId: "sc-1", note: "x", source: validVoiceVersion, layout: validLayout }), /停点身份/);
  });

  it("discard 意图必须带目标请求；v1 留白的业务禁令由 worker 层校验", () => {
    const discarded = parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "discard_unapplied", requestId: "req-d-1",
      expectedRunRevision: 9, interventionId: "intervention-1",
      targetRequestId: "req-relayout-1", note: "撤销这次未生效的调整",
    });
    assert.equal(discarded.intent, "discard_unapplied");
    // TS 解析只管形状；「v1 不能引入留白」的合同禁令在 narration_relayout.parse_relayout_layout 执行。
    const v1WithSilences = parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "apply", requestId: "req-6", expectedRunRevision: 1,
      interventionId: "intervention-1", sourceContextId: "sc-1", note: "x", source: validVoiceVersion,
      layout: { ...validLayout, userSilences: [{ startFrame: 10, endFrame: 20 }] } });
    assert.equal(v1WithSilences.intent === "apply" ? v1WithSilences.layout.userSilences.length : 0, 1);
    assert.throws(() => parseNarrationRelayoutRequest({
      action: "relayout_narration", intent: "discard_unapplied", requestId: "req-d-missing-stop",
      expectedRunRevision: 9, targetRequestId: "req-relayout-1", note: "撤销"
    }), /停点身份/);
  });

  it("操作记录版本常量已冻结", () => {
    assert.equal(RELAYOUT_OPERATION_VERSION, "video-factory/narration-relayout-operation-v1");
  });

  it("角色 v3 的台词布局与冲突显式分派，拒绝把角色或正文塞进时间调整", () => {
    const request = { action: "relayout_narration", intent: "apply", requestId: "character-layout",
      expectedRunRevision: 1, interventionId: "stop", sourceContextId: "source", note: "调整第一句时间",
      source: validVoiceVersion, layout: { ...validLayout, narrationPlanVersion: "video-factory/narration-plan-v3" } };
    const parsed = parseNarrationRelayoutRequest(request);
    assert.ok(parsed.intent === "apply");
    assert.equal(parsed.layout.narrationPlanVersion, "video-factory/narration-plan-v3");
    assert.throws(() => parseNarrationRelayoutRequest({ ...request, layout: { ...request.layout,
      groups: [{ ...validLayout.groups[0], speakerId: "replace-speaker" }] } }), /角色|字段/);
    for (const level of ["root", "window", "placement", "silence"]) {
      const layout: any = structuredClone(request.layout);
      const target = level === "root" ? layout : level === "silence" ? (layout.userSilences[0] = { startFrame: 0, endFrame: 1 }) : layout.groups[0][level];
      target.voiceProfileId = "minimax:female-tianmei";
      assert.throws(() => parseNarrationRelayoutRequest({ ...request, layout }), /字段|角色/, level);
    }
    const conflict = { version: "video-factory/narration-fit-conflict-v3", code: "NARRATION_TURN_DOES_NOT_FIT",
      groupId: "turn_1", turnId: "turn_1", speakerId: "shopkeeper", voiceProfileId: "minimax:male-qn-jingying",
      sourceScenePositions: [1], window: { startFrame: 0, endFrame: 15 },
      placement: { anchor: "start", offsetFrames: 0 }, sourceSamples: 44_100,
      requiredFrames: 30, availableFrames: 15, shortfallFrames: 15,
      sourceOperationId: "voice-op-1", sourceContextId: "sc-1",
      manifestArtifactId: "artifact-manifest-1", manifestSha256: "d".repeat(64) };
    assert.equal(parseNarrationFitConflictV3(conflict).speakerId, "shopkeeper");
    assert.throws(() => parseNarrationFitConflictV2(conflict), /版本|错误码/);
    assert.throws(() => parseNarrationFitConflictV3({ ...conflict, turnId: "another" }), /台词/);
    assert.throws(() => parseNarrationFitConflictV3({ ...conflict, requiredFrames: 29 }), /帧数/);
  });

  it("用同一完整合同解析首次与再次 v2 fit 冲突", () => {
    const parsed = parseNarrationFitConflictV2({
      version: NARRATION_FIT_CONFLICT_V2_VERSION, code: "NARRATION_GROUP_DOES_NOT_FIT_V2",
      groupId: "ng-1", sourceRange: { baseGroupId: "nbg-1", startCodePoint: 0, endCodePoint: 4 },
      sourceScenePositions: [1], window: { startFrame: 0, endFrame: 15 },
      placement: { anchor: "start", offsetFrames: 0 }, sourceSamples: 44_100,
      requiredFrames: 30, availableFrames: 15, shortfallFrames: 15,
      sourceOperationId: "voice-op-1", sourceContextId: "sc-1",
      manifestArtifactId: "artifact-manifest-1", manifestSha256: "d".repeat(64),
    });
    assert.equal(parsed.sourceSamples, 44_100);
    assert.equal(parsed.manifestArtifactId, "artifact-manifest-1");
    assert.throws(() => parseNarrationFitConflictV2({ ...parsed, shortfallFrames: 14 }), /帧数事实不一致/);
    assert.throws(() => parseNarrationFitConflictV2({ ...parsed, manifestArtifactId: undefined }), /来源清单产物/);
  });
});
