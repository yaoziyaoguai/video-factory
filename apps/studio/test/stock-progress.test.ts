import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStockProgress, stockProgressLabel } from "../src/server/stock-progress.js";

it("projects current operation progress without leaking raw fields or accepting stale/malformed progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stock-progress-"));
  try {
    const directory = path.join(root, "runs", "run-1", "nodes", "assets");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "stock-progress.json");
    const value = { version: "stock-progress-v1", operationId: "op", phase: "download", totalScenes: 2, updatedAt: 1_800_000_000,
      secret: "private", scenes: [{ scenePosition: 1, state: "retrying", provider: "pixabay", candidateCount: 0, failedAttempts: 3, url: "private" }] };
    await writeFile(file, JSON.stringify(value));
    const progress = await loadStockProgress(root, "run-1", "assets", "op");
    assert.ok(progress);
    assert.match(stockProgressLabel(progress), /已完成 0\/2 镜，3 次获取失败/);
    assert.doesNotMatch(JSON.stringify(progress), /private/);
    assert.equal(await loadStockProgress(root, "run-1", "assets", "other-op"), undefined);
    await writeFile(file, JSON.stringify({ ...value, scenes: [...value.scenes, ...value.scenes] }));
    assert.equal(await loadStockProgress(root, "run-1", "assets", "op"), undefined);
    await writeFile(file, "{");
    assert.equal(await loadStockProgress(root, "run-1", "assets", "op"), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
