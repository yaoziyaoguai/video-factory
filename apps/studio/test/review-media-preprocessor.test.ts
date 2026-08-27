import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PythonReviewMediaPreprocessor } from "../src/server/review-media-preprocessor.js";

const MAX_FRAME_BYTES = 512 * 1024;

interface FrameDescriptor {
  path: string;
  timestampMs: number;
  sha256: string;
}

interface Harness {
  root: string;
  runRoot: string;
  videoPath: string;
  manifestPath: string;
  capturePath: string;
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
          "12",
        ],
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
        const count = kind === "single" ? 1 : 12;
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
});

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "vf-review-boundary-"));
  const runRoot = path.join(root, "run");
  const reviewRoot = path.join(runRoot, "review_media");
  const manifestPath = path.join(reviewRoot, "manifest.json");
  const capturePath = path.join(root, "captured-arguments.txt");
  const commandPath = path.join(root, "python-fixture");
  await mkdir(reviewRoot, { recursive: true });
  await writeFile(
    commandPath,
    [
      "#!/bin/sh",
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
    preprocessor: undefined as unknown as PythonReviewMediaPreprocessor,
  };
  harness.preprocessor = createPreprocessor(harness, manifestPath, commandPath);
  return harness;
}

function createPreprocessor(harness: Harness, manifestPath: string, commandPath?: string): PythonReviewMediaPreprocessor {
  return new PythonReviewMediaPreprocessor({
    repositoryRoot: harness.root,
    pythonPath: path.join(harness.root, "python-src"),
    pythonCommand: commandPath ?? path.join(harness.root, "python-fixture"),
    environment: {
      MANIFEST_PATH: manifestPath,
      CAPTURE_PATH: harness.capturePath,
      SENSITIVE_FIXTURE_VALUE: "must-not-appear-in-errors",
    },
  });
}

async function writeManifest(harness: Harness, frames: FrameDescriptor[], durationMs = 1_000): Promise<void> {
  await writeFile(
    harness.manifestPath,
    JSON.stringify({ version: "video-factory/review-media-v1", durationMs, frames }),
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
