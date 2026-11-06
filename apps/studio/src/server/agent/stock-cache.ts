import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Pixabay 服务条款要求把 API 响应缓存 24 小时；只缓存搜索元数据 JSON，
// 不缓存媒体文件或凭据（Key 只出现在请求 URL，落盘文件名是整条 URL 的 sha256，
// 缓存内容不含 Key）。缓存目录不可用或文件损坏时降级为直接检索，不改变检索语义。

const TTL_MS = 24 * 60 * 60 * 1000;

interface CachedEnvelope {
  fetchedAt: number;
  payload: unknown;
}

function validPayload(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).hits)
    && !("error" in payload);
}

/** 读缓存 → 未命中取网络 → 原子写回；任何缓存环节失败都不影响返回结果。 */
export async function cachedPixabayResponse(
  url: string, fetchFresh: () => Promise<unknown>, cacheRoot: string | null,
): Promise<unknown> {
  if (!cacheRoot) return mustBeValid(await fetchFresh());
  let dir: string;
  try {
    dir = path.join(cacheRoot, "pixabay");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return mustBeValid(await fetchFresh());
  }
  const target = path.join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);
  try {
    const cached = JSON.parse(readFileSync(target, "utf8")) as CachedEnvelope;
    const age = Date.now() - cached.fetchedAt;
    if (Number.isFinite(age) && age >= 0 && age < TTL_MS && validPayload(cached.payload)) return cached.payload;
  } catch { /* 无缓存或缓存损坏：按未命中处理。 */ }
  const payload = mustBeValid(await fetchFresh());
  const temporary = path.join(dir, `${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ fetchedAt: Date.now(), payload } satisfies CachedEnvelope), { mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* 清理失败不影响结果。 */ }
  }
  return payload;
}

function mustBeValid(payload: unknown): unknown {
  if (!validPayload(payload)) throw new Error("Pixabay 搜索响应不可识别。");
  return payload;
}
