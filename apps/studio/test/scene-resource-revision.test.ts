import assert from "node:assert/strict";
import { it } from "node:test";
import { StudioInputError, parseStudioSceneResourceRevisionInput } from "../src/shared/api.js";

// 「重取这一镜素材」的入参校验。要点是这一镜由**审片条目**决定，不由调用方指定：
// 客户端交上来的是"第几条结论"，镜位在服务端从那份结论里解出来，客户端说了不算。

it("accepts a well-formed reselection request", () => {
  assert.deepEqual(
    parseStudioSceneResourceRevisionInput({
      expectedRunRevision: 16,
      reviewArtifactId: "artifact-6af08369",
      findingIndex: 8,
      note: "杯口上方看不到蒸汽，换一版画面",
    }),
    {
      expectedRunRevision: 16,
      reviewArtifactId: "artifact-6af08369",
      findingIndex: 8,
      note: "杯口上方看不到蒸汽，换一版画面",
    },
  );
});

it("requires the caller revision so a stale page cannot re-source the wrong render", () => {
  assert.throws(
    () => parseStudioSceneResourceRevisionInput({ reviewArtifactId: "a", findingIndex: 0, note: "x" }),
    StudioInputError,
  );
});

it("requires an explicit reason", () => {
  assert.throws(
    () => parseStudioSceneResourceRevisionInput({ expectedRunRevision: 1, reviewArtifactId: "a", findingIndex: 0, note: "   " }),
    StudioInputError,
  );
});

it("rejects a negative finding index and an over-long reason", () => {
  assert.throws(
    () => parseStudioSceneResourceRevisionInput({ expectedRunRevision: 1, reviewArtifactId: "a", findingIndex: -1, note: "x" }),
    StudioInputError,
  );
  assert.throws(
    () => parseStudioSceneResourceRevisionInput({
      expectedRunRevision: 1,
      reviewArtifactId: "a",
      findingIndex: 0,
      note: "x".repeat(2_001),
    }),
    StudioInputError,
  );
});
