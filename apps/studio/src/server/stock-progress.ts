import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { StudioStockProgress } from "../shared/api.js";

/** 失败摘要的安全枚举（与 Python 侧 stock_execution 的白名单同口径）。 */
const FAILURE_STAGES = new Set(["dns", "connect", "tls", "http", "body", "media", "operation", "unknown"]);
const FAILURE_REASONS = new Set([
  "timeout", "dns_failure", "connection_failure", "tls_failure", "http_error",
  "incomplete", "too_large", "invalid_media", "unknown",
]);

/** 二次白名单校验：未知枚举、非法状态码或私有字段整体丢弃，其余进度照常投影。 */
function safeLastFailure(value: unknown): StudioStockProgress["scenes"][number]["lastFailure"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const failure = value as Record<string, unknown>;
  if (typeof failure.provider !== "string" || !/^[a-z_-]{1,40}$/.test(failure.provider)) return undefined;
  if (typeof failure.stage !== "string" || !FAILURE_STAGES.has(failure.stage)) return undefined;
  if (typeof failure.reason !== "string" || !FAILURE_REASONS.has(failure.reason)) return undefined;
  const httpStatus: unknown = failure.httpStatus;
  if (httpStatus !== undefined
    && (typeof httpStatus !== "number" || !Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) return undefined;
  return { provider: failure.provider, stage: failure.stage, reason: failure.reason,
    ...(typeof httpStatus === "number" ? { httpStatus } : {}) };
}

/** 进度只绑定正在查看的执行；上次尝试、路径和未过滤异常均不投影给浏览器。 */
export async function loadStockProgress(root: string, runId: string, nodeId: string, operationId?: string): Promise<StudioStockProgress | undefined> {
  if (!operationId || !["creative-planning", "asset-candidates", "assets"].includes(nodeId)) return undefined;
  try {
    const file = path.join(root, "runs", runId, "nodes", nodeId, "stock-progress.json");
    if ((await stat(file)).size > 64 * 1024) return undefined;
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== "stock-progress-v1" || value.operationId !== operationId
      || !["search", "download"].includes(value.phase) || !Number.isInteger(value.totalScenes)
      || value.totalScenes < 1 || value.totalScenes > 200 || !Number.isFinite(value.updatedAt)
      || !Array.isArray(value.scenes) || value.scenes.length > value.totalScenes) return undefined;
    const positions = new Set<number>();
    const scenes: StudioStockProgress["scenes"] = [];
    for (const scene of value.scenes) {
      if (!scene || !Number.isInteger(scene.scenePosition) || scene.scenePosition < 1 || positions.has(scene.scenePosition)
        || !["searching", "downloading", "retrying", "completed", "failed", "stopped"].includes(scene.state)
        || typeof scene.provider !== "string" || !/^[a-z_-]{0,40}$/.test(scene.provider)
        || !Number.isSafeInteger(scene.candidateCount) || scene.candidateCount < 0
        || !Number.isSafeInteger(scene.failedAttempts) || scene.failedAttempts < 0) return undefined;
      positions.add(scene.scenePosition);
      const lastFailure = safeLastFailure(scene.lastFailure);
      scenes.push({ scenePosition: scene.scenePosition, state: scene.state, provider: scene.provider,
        candidateCount: scene.candidateCount, failedAttempts: scene.failedAttempts,
        ...(lastFailure ? { lastFailure } : {}) });
    }
    return { phase: value.phase, totalScenes: value.totalScenes, updatedAt: new Date(value.updatedAt * 1000).toISOString(), scenes };
  } catch { return undefined; }
}

export function stockProgressLabel(progress: StudioStockProgress): string {
  const completed = progress.scenes.filter(scene => scene.state === "completed").length;
  const failed = progress.scenes.reduce((sum, scene) => sum + scene.failedAttempts, 0);
  return `${progress.phase === "search" ? "正在检索候选画面" : "正在获取免费素材"}：已完成 ${completed}/${progress.totalScenes} 镜${failed ? `，${failed} 次获取失败，正在尝试其他候选` : ""}。`;
}
