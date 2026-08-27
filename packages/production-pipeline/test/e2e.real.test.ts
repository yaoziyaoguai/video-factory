import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { ProductionPipeline, PythonWorkerClient, type WorkerResponse } from "../src/index.js";

const execFileAsync = promisify(execFile);
const e2eEnabled = process.env.VIDEO_FACTORY_E2E === "1";

describe("real production E2E", () => {
  it("renders and approves an audible 1080x1920 production package", { skip: !e2eEnabled }, async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-real-e2e-"));
    await Promise.all([
      execFileAsync("ffmpeg", ["-version"]),
      execFileAsync("ffprobe", ["-version"]),
      execFileAsync("say", ["-v", "Tingting", "-o", path.join(workspaceRoot, "voice-check.aiff"), "测试"]),
    ]);
    const repositoryRoot = process.cwd();
    const brief = JSON.parse(
      await readFile(path.join(repositoryRoot, "examples", "briefs", "life-avoidance-local.json"), "utf8"),
    ) as unknown;
    const client = new PythonWorkerClient({
      command: [process.env.VIDEO_FACTORY_PYTHON ?? "python3", "-m", "video_factory.worker"],
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") },
      timeoutMs: 20 * 60 * 1000,
    });
    const calls: string[] = [];
    const worker = {
      run: async (request: Record<string, unknown>): Promise<WorkerResponse> => {
        calls.push(String(request.capability));
        return client.run(request);
      },
    };
    const firstProcess = new ProductionPipeline({ workspaceRoot, worker });

    const waiting = await firstProcess.start(brief);

    assert.equal(waiting.status, "needs_human");
    assert.deepEqual(calls, [
      "script.draft",
      "asset.prepare",
      "voice.synthesize",
      "video.render",
      "quality.review",
    ]);
    const render = waiting.artifacts.find((artifact) => artifact.kind === "render");
    const review = waiting.artifacts.find((artifact) => artifact.kind === "review_report");
    assert.ok(render?.uri);
    assert.ok(review?.uri);
    const report = JSON.parse(await readFile(review.uri, "utf8"));
    assert.equal(report.status, "passed");
    assert.ok(report.audio.max_volume_db > -60);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      render.uri,
    ]);
    const streams = JSON.parse(stdout).streams as Array<Record<string, unknown>>;
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    assert.equal(video?.codec_name, "h264");
    assert.equal(video?.width, 1080);
    assert.equal(video?.height, 1920);
    assert.equal(audio?.codec_name, "aac");

    const intervention = waiting.interventions.at(-1);
    assert.ok(intervention);
    const secondProcess = new ProductionPipeline({ workspaceRoot, worker });
    const approved = await secondProcess.decide(waiting.id, {
      interventionId: intervention.id,
      action: "approve",
      actor: "e2e-director",
      note: "Automated technical checks passed; test approval records the resume path.",
    });

    assert.equal(approved.status, "succeeded");
    assert.equal(calls.length, 5);
    const publishPackage = approved.artifacts.find((artifact) => artifact.kind === "publish_package");
    assert.ok(publishPackage?.uri);
    const packageData = JSON.parse(await readFile(publishPackage.uri, "utf8"));
    assert.equal(packageData.approval.actor, "e2e-director");
    const persisted = JSON.parse(
      await readFile(path.join(workspaceRoot, "runs", waiting.id, "run.json"), "utf8"),
    );
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.revision, 1);
  });
});
