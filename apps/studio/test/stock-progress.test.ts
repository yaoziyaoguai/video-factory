import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadStockProgress, stockProgressLabel } from "../src/server/stock-progress.js";

const execFileAsync = promisify(execFile);

// 跨层 fixture 必须验证当前 checkout：仓库根从测试文件位置推导（不依赖调用者 cwd，
// 也不写死个人绝对路径）；Python 沿仓库生产约定选择（resolveProductionPython 同款：
// VIDEO_FACTORY_PYTHON → 本 checkout venv → python3）。
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function resolveCheckoutPython(): string {
  if (process.env.VIDEO_FACTORY_PYTHON) return process.env.VIDEO_FACTORY_PYTHON;
  const localRuntime = path.join(repositoryRoot, ".local", "python", ".venv", "bin", "python");
  return existsSync(localRuntime) ? localRuntime : "python3";
}

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

it("validates lastFailure against the safe enum whitelist and drops unknown values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stock-progress-failure-"));
  try {
    const directory = path.join(root, "runs", "run-1", "nodes", "assets");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "stock-progress.json");
    const base = { version: "stock-progress-v1", operationId: "op", phase: "download", totalScenes: 1, updatedAt: 1_800_000_000 };

    // 合法摘要原样投影；未知枚举/携带私有字段只丢弃该字段，其余照常。
    await writeFile(file, JSON.stringify({ ...base, scenes: [{ scenePosition: 1, state: "stopped", provider: "pexels",
      candidateCount: 0, failedAttempts: 1, lastFailure: { provider: "pexels", stage: "connect", reason: "timeout" } }] }));
    let progress = await loadStockProgress(root, "run-1", "assets", "op");
    assert.deepEqual(progress?.scenes[0]?.lastFailure, { provider: "pexels", stage: "connect", reason: "timeout" });

    await writeFile(file, JSON.stringify({ ...base, scenes: [{ scenePosition: 1, state: "stopped", provider: "pexels",
      candidateCount: 0, failedAttempts: 1, lastFailure: { provider: "pexels", stage: "vpn", reason: "guess", httpStatus: 999, url: "https://private" } }] }));
    progress = await loadStockProgress(root, "run-1", "assets", "op");
    assert.equal(progress?.scenes[0]?.lastFailure, undefined, "未知枚举/非法状态码整字段丢弃，不直出页面");

    // 旧进度 JSON 缺新增可选字段仍可读。
    await writeFile(file, JSON.stringify({ ...base, scenes: [{ scenePosition: 1, state: "completed", provider: "pexels",
      candidateCount: 2, failedAttempts: 0 }] }));
    progress = await loadStockProgress(root, "run-1", "assets", "op");
    assert.equal(progress?.scenes[0]?.lastFailure, undefined);
    assert.equal(progress?.scenes[0]?.candidateCount, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("loads a progress file written by the real Python StockExecution", async () => {
  // 跨层 fixture（D 批次）：Python 正式写入 → loadStockProgress → 浏览器合同形态。
  const root = await mkdtemp(path.join(tmpdir(), "stock-progress-python-"));
  try {
    const progressPath = path.join(root, "stock-progress.json");
    const script = [
      "import os",
      "import video_factory.stock_execution as stock_execution_module",
      // 同机存在原仓库时也不能被误导入：被测 Python 源码必须来自当前 checkout。
      "assert os.path.realpath(stock_execution_module.__file__).startswith(os.path.realpath(os.getcwd()) + os.sep), stock_execution_module.__file__",
      "from video_factory.stock_execution import StockExecution",
      `execution = StockExecution({"stockProgressPath": ${JSON.stringify(progressPath)}, "commandId": "op-cross"})`,
      "execution.progress(1, 2, 'searching', 'pexels', 3)",
      "execution.progress(1, 2, 'retrying', 'pexels', last_failure={'provider': 'pexels', 'stage': 'http', 'reason': 'http_error', 'httpStatus': 429})",
      "execution.progress(1, 2, 'stopped')",
    ].join("\n");
    await execFileAsync(resolveCheckoutPython(), ["-c", script], {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") },
    });
    const directory = path.join(root, "runs", "run-x", "nodes", "assets");
    await mkdir(directory, { recursive: true });
    await (await import("node:fs/promises")).rename(progressPath, path.join(directory, "stock-progress.json"));

    const progress = await loadStockProgress(root, "run-x", "assets", "op-cross");
    assert.ok(progress);
    assert.equal(progress.scenes[0]?.state, "stopped");
    assert.equal(progress.scenes[0]?.provider, "pexels");
    assert.deepEqual(progress.scenes[0]?.lastFailure, { provider: "pexels", stage: "http", reason: "http_error", httpStatus: 429 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("projects a real Python all-sources-failed scene terminal state (R2-06)", async () => {
  // 跨层（R2-06）：Python failed 终态保留 provider/lastFailure/failedAttempts；
  // Studio 白名单接受 failed 并原样投影，失败镜不冒充 completed。
  const root = await mkdtemp(path.join(tmpdir(), "stock-progress-python-failed-"));
  try {
    const progressPath = path.join(root, "stock-progress.json");
    const script = [
      "import os",
      "import video_factory.stock_execution as stock_execution_module",
      "assert os.path.realpath(stock_execution_module.__file__).startswith(os.path.realpath(os.getcwd()) + os.sep), stock_execution_module.__file__",
      "from video_factory.stock_execution import StockExecution",
      `execution = StockExecution({"stockProgressPath": ${JSON.stringify(progressPath)}, "commandId": "op-failed"})`,
      "execution.progress(1, 2, 'searching', 'pixabay')",
      "execution.progress(1, 2, 'retrying', 'pixabay', last_failure={'provider': 'pixabay', 'stage': 'body', 'reason': 'timeout'})",
      "execution.progress(1, 2, 'failed', candidates=0)",
    ].join("\n");
    await execFileAsync(resolveCheckoutPython(), ["-c", script], {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: path.join(repositoryRoot, "src") },
    });
    const directory = path.join(root, "runs", "run-y", "nodes", "assets");
    await mkdir(directory, { recursive: true });
    await (await import("node:fs/promises")).rename(progressPath, path.join(directory, "stock-progress.json"));

    const progress = await loadStockProgress(root, "run-y", "assets", "op-failed");
    assert.ok(progress);
    assert.equal(progress.scenes[0]?.state, "failed");
    assert.equal(progress.scenes[0]?.provider, "pixabay");
    assert.equal(progress.scenes[0]?.failedAttempts, 1);
    assert.deepEqual(progress.scenes[0]?.lastFailure, { provider: "pixabay", stage: "body", reason: "timeout" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
