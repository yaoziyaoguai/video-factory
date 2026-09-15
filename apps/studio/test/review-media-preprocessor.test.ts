import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PythonReviewMediaPreprocessor } from "../src/server/review-media-preprocessor.js";

const MAX_FRAME_BYTES = 256 * 1024;

interface FrameDescriptor {
  path: string;
  timestampMs: number;
  sourceTimecodeMs?: number;
  sha256: string;
  scenePosition?: number;
  phase?: "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe";
}

interface Harness {
  root: string;
  runRoot: string;
  videoPath: string;
  manifestPath: string;
  capturePath: string;
  runsPath: string;
  preprocessor: PythonReviewMediaPreprocessor;
}

describe("PythonReviewMediaPreprocessor trust boundary", () => {
  it("invokes only the fixed module and bounded frame arguments", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(harness, [frame("review_media/frame.jpg", 100, jpeg)]);

      const result = await harness.preprocessor.prepare({
        videoPath: harness.videoPath,
        runRoot: harness.runRoot,
      });

      assert.equal(result.durationMs, 1_000);
      assert.equal(result.frames.length, 1);
      assert.deepEqual(
        (await readFile(harness.capturePath, "utf8")).trim().split("\n"),
        [
          "-m",
          "video_factory.review_media",
          "--video",
          harness.videoPath,
          "--run-root",
          harness.runRoot,
          "--max-frames",
          "24",
        ],
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("uses the fixed source-asset mode before rendering", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      const assetPlanPath = path.join(harness.runRoot, "assets", "asset_plan.json");
      const executablePlanPath = path.join(harness.runRoot, "production-preflight", "executable_plan.json");
      await mkdir(path.dirname(assetPlanPath), { recursive: true });
      await writeFile(assetPlanPath, "{}", "utf8");
      await mkdir(path.dirname(executablePlanPath), { recursive: true });
      await writeFile(executablePlanPath, "{}", "utf8");
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(harness, [frame("review_media/frame.jpg", 100, jpeg)]);

      await harness.preprocessor.prepare({ assetPlanPath, executablePlanPath, runRoot: harness.runRoot });

      assert.deepEqual(
        (await readFile(harness.capturePath, "utf8")).trim().split("\n"),
        [
          "-m",
          "video_factory.review_media",
          "--asset-plan",
          assetPlanPath,
          "--run-root",
          harness.runRoot,
          "--max-frames",
          "24",
          "--executable-plan",
          executablePlanPath,
        ],
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("preserves the manifest's actual sparse sampling mode and frame mapping", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(
        harness,
        [{ ...frame("review_media/frame.jpg", 250, jpeg), scenePosition: 1, phase: "hook" }],
        1_000,
        { mode: "hook_and_scene_midpoints", sceneCount: 9 },
      );

      const result = await harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot });

      assert.deepEqual(result.sampling, {
        mode: "hook_and_scene_midpoints",
        sceneCount: 9,
        coveredScenePositions: [1],
        missingScenePositions: [2, 3, 4, 5, 6, 7, 8, 9],
      });
      assert.equal(result.frames[0]?.scenePosition, 1);
      assert.equal(result.frames[0]?.phase, "hook");
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("preserves a valid source timecode and rejects an invalid one", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(harness, [{
        ...frame("review_media/frame.jpg", 250, jpeg),
        sourceTimecodeMs: 4_250,
        scenePosition: 1,
      }]);

      const result = await harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot });
      assert.equal(result.frames[0]?.sourceTimecodeMs, 4_250);

      await writeManifest(harness, [{
        ...frame("review_media/frame.jpg", 250, jpeg),
        sourceTimecodeMs: -1,
        scenePosition: 1,
      }]);
      await assert.rejects(
        () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
        /source timecode is invalid/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("keeps a pilot's original scene position and rejects evidence from other scenes", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(harness,
        [{ ...frame("review_media/frame.jpg", 250, jpeg), scenePosition: 3, phase: "midpoint" }],
        1_000, { mode: "hook_and_scene_midpoints", sceneCount: 8 });
      const input = { assetPlanPath: path.join(harness.runRoot, "asset_plan.json"), runRoot: harness.runRoot, scenePositions: [3] };
      const result = await harness.preprocessor.prepare(input);
      assert.deepEqual(result.sampling?.coveredScenePositions, [3]);
      assert.match(await readFile(harness.capturePath, "utf8"), /--scene-positions\n3/);
      await assert.rejects(() => harness.preprocessor.prepare({ ...input, scenePositions: [2] }), /exactly the requested scenes/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("accepts an ordered dense frame sequence for a video pilot", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      const frames: FrameDescriptor[] = [];
      for (let index = 0; index < 4; index += 1) {
        const relativePath = `review_media/sequence-${index}.jpg`;
        await writeFrame(harness, relativePath, jpeg);
        frames.push({
          ...frame(relativePath, 100 + index * 200, jpeg),
          scenePosition: 6,
          phase: index === 0 ? "opening" : index === 3 ? "closing" : "middle",
        });
      }
      await writeManifest(harness, frames, 1_000, { mode: "scene_sequence", sceneCount: 8 });

      const result = await harness.preprocessor.prepare({
        assetPlanPath: path.join(harness.runRoot, "asset_plan.json"),
        runRoot: harness.runRoot,
        scenePositions: [6],
      });

      assert.deepEqual(result.sampling, {
        mode: "scene_sequence",
        sceneCount: 8,
        coveredScenePositions: [6],
        missingScenePositions: [1, 2, 3, 4, 5, 7, 8],
      });
      assert.deepEqual(result.frames.map((item) => item.phase), ["opening", "middle", "middle", "closing"]);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects a manifest that claims scene triplets without three phases for every scene", async () => {
    const harness = await createHarness();
    try {
      const first = makeJpeg(64);
      const second = makeJpeg(65);
      await writeFrame(harness, "review_media/opening.jpg", first);
      await writeFrame(harness, "review_media/middle.jpg", second);
      await writeManifest(
        harness,
        [
          { ...frame("review_media/opening.jpg", 100, first), scenePosition: 1, phase: "opening" },
          { ...frame("review_media/middle.jpg", 500, second), scenePosition: 1, phase: "middle" },
        ],
        1_000,
        { mode: "scene_triplets", sceneCount: 1 },
      );

      await assert.rejects(
        () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
        /incomplete for scene 1/,
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("passes a confined render manifest so production sampling follows scene interiors", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      const renderManifestPath = path.join(harness.runRoot, "render", "render_manifest.json");
      await mkdir(path.dirname(renderManifestPath), { recursive: true });
      await writeFile(renderManifestPath, JSON.stringify({ slides: [{ duration: 1 }] }));
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(harness, [frame("review_media/frame.jpg", 100, jpeg)]);

      await harness.preprocessor.prepare({
        videoPath: harness.videoPath,
        runRoot: harness.runRoot,
        renderManifestPath,
      });

      assert.deepEqual(
        (await readFile(harness.capturePath, "utf8")).trim().split("\n").slice(-2),
        ["--render-manifest", renderManifestPath],
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("rejects parent traversal, absolute paths, and symlinks escaping the run", async () => {
    const cases = ["parent", "absolute", "symlink", "manifest"] as const;
    for (const kind of cases) {
      const harness = await createHarness();
      try {
        const jpeg = makeJpeg(64);
        const outsidePath = path.join(harness.root, `sensitive-outside-${kind}.jpg`);
        await writeFile(outsidePath, jpeg);
        let descriptorPath = "review_media/frame.jpg";

        if (kind === "parent") descriptorPath = "../sensitive-outside-parent.jpg";
        if (kind === "absolute") descriptorPath = outsidePath;
        if (kind === "symlink") {
          descriptorPath = "review_media/linked.jpg";
          await symlink(outsidePath, path.join(harness.runRoot, descriptorPath));
        }
        if (kind === "manifest") {
          await writeFile(
            outsidePath,
            JSON.stringify({
              version: "video-factory/review-media-v1",
              durationMs: 1_000,
              frames: [frame("review_media/frame.jpg", 100, jpeg)],
            }),
          );
          await writeFile(path.join(harness.root, "manifest-location"), outsidePath);
          harness.preprocessor = createPreprocessor(harness, outsidePath);
        } else {
          await writeManifest(harness, [frame(descriptorPath, 100, jpeg)]);
        }

        await assertSanitizedRejection(
          () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
          [harness.root, "sensitive-outside"],
        );
      } finally {
        await rm(harness.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a single oversized frame and an aggregate crossing the total boundary", async () => {
    const cases = ["single", "total"] as const;
    for (const kind of cases) {
      const harness = await createHarness();
      try {
        const frames: FrameDescriptor[] = [];
        const count = kind === "single" ? 1 : 20;
        for (let index = 0; index < count; index += 1) {
          const size = kind === "single" || index === count - 1
            ? MAX_FRAME_BYTES + 1
            : MAX_FRAME_BYTES;
          const jpeg = makeJpeg(size);
          const relativePath = `review_media/sensitive-frame-${index}.jpg`;
          await writeFrame(harness, relativePath, jpeg);
          frames.push(frame(relativePath, index + 1, jpeg));
        }
        await writeManifest(harness, frames, 2_000);

        await assertSanitizedRejection(
          () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
          [harness.root, "sensitive-frame"],
        );
      } finally {
        await rm(harness.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects wrong hashes, unordered timestamps, and non-JPEG content", async () => {
    const cases = ["hash", "timecode", "format"] as const;
    for (const kind of cases) {
      const harness = await createHarness();
      try {
        const first = kind === "format" ? Buffer.from("sensitive-not-a-jpeg") : makeJpeg(64);
        const second = makeJpeg(64);
        await writeFrame(harness, "review_media/sensitive-first.jpg", first);
        await writeFrame(harness, "review_media/sensitive-second.jpg", second);
        const frames = kind === "timecode"
          ? [frame("review_media/sensitive-first.jpg", 200, first), frame("review_media/sensitive-second.jpg", 100, second)]
          : [frame("review_media/sensitive-first.jpg", 100, first)];
        if (kind === "hash") frames[0]!.sha256 = "0".repeat(64);
        await writeManifest(harness, frames);

        await assertSanitizedRejection(
          () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
          [harness.root, "sensitive-first", "sensitive-not-a-jpeg"],
        );
      } finally {
        await rm(harness.root, { recursive: true, force: true });
      }
    }
  });

  it("redacts child-process paths and stderr when preprocessing fails", async () => {
    const harness = await createHarness();
    const commandPath = path.join(harness.root, "failing-python-fixture");
    try {
      await writeFile(commandPath, "#!/bin/sh\nprintf '%s\\n' \"$SENSITIVE_FIXTURE_VALUE $1\" >&2\nexit 23\n");
      await chmod(commandPath, 0o700);
      harness.preprocessor = createPreprocessor(harness, harness.manifestPath, commandPath);

      await assertSanitizedRejection(
        () => harness.preprocessor.prepare({ videoPath: harness.videoPath, runRoot: harness.runRoot }),
        [harness.root, harness.videoPath, commandPath],
      );
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("runs one child process for concurrent identical requests and hands each caller its own copy", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(
        harness,
        [{ ...frame("review_media/frame.jpg", 250, jpeg), scenePosition: 3, phase: "midpoint" }],
        1_000,
        { mode: "hook_and_scene_midpoints", sceneCount: 6 },
      );
      const input = {
        assetPlanPath: path.join(harness.runRoot, "asset_plan.json"),
        runRoot: harness.runRoot,
        scenePositions: [3],
      };

      // 试片双分支复审正是这样并发要同一份证据：以前两个子进程会同时发布同一个目录，
      // 一个以 "Directory not empty" 失败，再被报成模型调用失败。
      const [left, right] = await Promise.all([
        harness.preprocessor.prepare(input),
        harness.preprocessor.prepare(input),
      ]);

      assert.equal(await childRunCount(harness), 1, "并发相同请求只应跑一次预处理");
      assert.deepEqual(left, right);
      assert.notEqual(left, right);
      assert.notEqual(left.frames, right.frames);
      left.frames[0]!.timecodeMs = 9_999;
      assert.equal(right.frames[0]?.timecodeMs, 250, "一个分支不得改写另一个分支的证据");
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("neither shares evidence across different inputs nor caches it after settling", async () => {
    const harness = await createHarness();
    try {
      const jpeg = makeJpeg(64);
      await writeFrame(harness, "review_media/frame.jpg", jpeg);
      await writeManifest(
        harness,
        [{ ...frame("review_media/frame.jpg", 250, jpeg), scenePosition: 3, phase: "midpoint" }],
        1_000,
        { mode: "hook_and_scene_midpoints", sceneCount: 6 },
      );
      const assetPlanPath = path.join(harness.runRoot, "asset_plan.json");
      const scoped = { assetPlanPath, runRoot: harness.runRoot, scenePositions: [3] };
      const whole = { assetPlanPath, runRoot: harness.runRoot };

      const [scopedResult, wholeResult] = await Promise.all([
        harness.preprocessor.prepare(scoped),
        harness.preprocessor.prepare(whole),
      ]);

      assert.equal(await childRunCount(harness), 2, "不同预处理身份必须各跑一次");
      assert.deepEqual(scopedResult.sampling?.coveredScenePositions, [3]);
      assert.deepEqual(wholeResult.sampling?.missingScenePositions, [1, 2, 4, 5, 6]);

      await harness.preprocessor.prepare(scoped);
      assert.equal(await childRunCount(harness), 3, "预处理结果不得跨请求复用");
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("classifies the failure for the operator and keeps the child's real reason on the server", async () => {
    const harness = await createHarness();
    const logged: string[] = [];
    const commandPath = path.join(harness.root, "failing-python-fixture");
    try {
      await writeFile(commandPath, "#!/bin/sh\nprintf '%s\\n' \"$SENSITIVE_FIXTURE_VALUE $1\" >&2\nexit 23\n");
      await chmod(commandPath, 0o700);
      harness.preprocessor = createPreprocessor(
        harness,
        harness.manifestPath,
        commandPath,
        (message) => logged.push(message),
      );

      const input = { videoPath: harness.videoPath, runRoot: harness.runRoot };
      const settled = await Promise.allSettled([
        harness.preprocessor.prepare(input),
        harness.preprocessor.prepare(input),
      ]);

      for (const result of settled) {
        assert.equal(result.status, "rejected");
        if (result.status !== "rejected") continue;
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        assert.match(message, /exit code 23/);
        assert.match(message, /were not sent to the client/);
        assert.equal(message.includes(harness.root), false);
        assert.equal(message.includes("must-not-appear-in-errors"), false);
      }
      assert.equal(logged.length, 1, "并发相同请求只应触发一次子进程");
      assert.match(logged[0]!, /exit code 23/);
      assert.match(logged[0]!, /must-not-appear-in-errors -m/);
      assert.match(logged[0]!, /command: failing-python-fixture/);
    } finally {
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "vf-review-boundary-"));
  const runRoot = path.join(root, "run");
  const reviewRoot = path.join(runRoot, "review_media");
  const manifestPath = path.join(reviewRoot, "manifest.json");
  const capturePath = path.join(root, "captured-arguments.txt");
  const runsPath = path.join(root, "child-runs.txt");
  const commandPath = path.join(root, "python-fixture");
  await mkdir(reviewRoot, { recursive: true });
  await writeFile(
    commandPath,
    [
      "#!/bin/sh",
      'printf "run\\n" >> "$RUNS_PATH"',
      ': > "$CAPTURE_PATH"',
      'for argument in "$@"; do printf "%s\\n" "$argument" >> "$CAPTURE_PATH"; done',
      'printf \'{"manifestPath":"%s"}\\n\' "$MANIFEST_PATH"',
      "",
    ].join("\n"),
  );
  await chmod(commandPath, 0o700);
  const harness = {
    root,
    runRoot,
    videoPath: path.join(runRoot, "render", "sensitive-video-name.mp4"),
    manifestPath,
    capturePath,
    runsPath,
    preprocessor: undefined as unknown as PythonReviewMediaPreprocessor,
  };
  harness.preprocessor = createPreprocessor(harness, manifestPath, commandPath);
  return harness;
}

function createPreprocessor(
  harness: Harness,
  manifestPath: string,
  commandPath?: string,
  logChildFailure?: (message: string) => void,
): PythonReviewMediaPreprocessor {
  return new PythonReviewMediaPreprocessor({
    repositoryRoot: harness.root,
    pythonPath: path.join(harness.root, "python-src"),
    pythonCommand: commandPath ?? path.join(harness.root, "python-fixture"),
    environment: {
      MANIFEST_PATH: manifestPath,
      CAPTURE_PATH: harness.capturePath,
      RUNS_PATH: harness.runsPath,
      SENSITIVE_FIXTURE_VALUE: "must-not-appear-in-errors",
    },
    ...(logChildFailure ? { logChildFailure } : {}),
  });
}

async function childRunCount(harness: Harness): Promise<number> {
  try {
    return (await readFile(harness.runsPath, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function writeManifest(
  harness: Harness,
  frames: FrameDescriptor[],
  durationMs = 1_000,
  sampling?: { mode: string; sceneCount?: number },
): Promise<void> {
  await writeFile(
    harness.manifestPath,
    JSON.stringify({ version: "video-factory/review-media-v1", durationMs, ...(sampling ? { sampling } : {}), frames }),
  );
}

async function writeFrame(harness: Harness, relativePath: string, content: Buffer): Promise<void> {
  const target = path.join(harness.runRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function frame(relativePath: string, timestampMs: number, content: Buffer): FrameDescriptor {
  return {
    path: relativePath,
    timestampMs,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function makeJpeg(size: number): Buffer {
  assert.ok(size >= 5);
  const value = Buffer.alloc(size, 0x20);
  value[0] = 0xff;
  value[1] = 0xd8;
  value[2] = 0xff;
  value[size - 2] = 0xff;
  value[size - 1] = 0xd9;
  return value;
}

async function assertSanitizedRejection(action: () => Promise<unknown>, forbidden: string[]): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const value of [...forbidden, "must-not-appear-in-errors"]) {
      assert.equal(error.message.includes(value), false, `error leaked sensitive value: ${value}`);
    }
    return true;
  });
}
