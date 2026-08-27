import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateNodeOverrideOutput } from "../src/server/node-output-validator.js";

test("accepts heterogeneous arrays when editing a node output", () => {
  const report = {
    status: "passed",
    probe: {
      streams: [
        { codec_name: "h264", codec_type: "video", width: 1080, height: 1920 },
        { codec_name: "aac", codec_type: "audio" },
      ],
    },
  };

  assert.doesNotThrow(() => validateNodeOverrideOutput({
    output: structuredClone(report),
    reference: report,
    nodeId: "technical-review",
    runRoot: "/tmp/video-factory/run-1",
  }));
});

test("still validates each existing heterogeneous array item against its own shape", () => {
  const reference = {
    streams: [
      { codec_type: "video", width: 1080 },
      { codec_type: "audio" },
    ],
  };

  assert.throws(
    () => validateNodeOverrideOutput({
      output: { streams: [{ codec_type: "video" }, { codec_type: "audio" }] },
      reference,
      nodeId: "technical-review",
      runRoot: "/tmp/video-factory/run-1",
    }),
    /streams\[0\]\.width 是必填字段/,
  );
});

test("keeps local file references immutable in the raw JSON editor", async () => {
  const runRoot = await mkdtemp(path.join(tmpdir(), "video-factory-node-output-"));
  const original = path.join(runRoot, "original.json");
  const replacement = path.join(runRoot, "replacement.json");
  await Promise.all([writeFile(original, "{}"), writeFile(replacement, "{}")]);

  assert.throws(
    () => validateNodeOverrideOutput({
      output: { publishPackagePath: replacement, artifacts: [{ uri: replacement }] },
      reference: { publishPackagePath: original, artifacts: [{ uri: original }] },
      nodeId: "publish-package",
      runRoot,
    }),
    /文件引用，不能在 JSON 编辑器中改指/,
  );
});

test("rejects unknown fields instead of persisting an unvalidated document shape", () => {
  assert.throws(
    () => validateNodeOverrideOutput({
      output: { title: "保留", injected: true },
      reference: { title: "原始" },
      nodeId: "script",
      runRoot: "/tmp/video-factory/run-1",
    }),
    /injected 不是当前交付支持的字段/,
  );
});
