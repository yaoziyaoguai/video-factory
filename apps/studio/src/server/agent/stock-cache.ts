import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fetchApiJsonWithMetadata, stockValueHelpers, StockUnavailableError, type HttpFetch } from "./stock-http.js";

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

interface Track { title: string; id: string; file: string; searchable: string; durationMs: number | null }
interface MusicCatalog { fetchedAt: number; etag: string | null; modified: string | null; payload: unknown[] }
interface IndexedCatalog { metadata: MusicCatalog; tracks: Track[] }
const musicCatalogs = new WeakMap<HttpFetch, Map<string | null, IndexedCatalog>>();

function indexMusic(metadata: MusicCatalog): IndexedCatalog {
  const tracks: Track[] = [];
  for (const raw of metadata.payload) {
    if (!raw || typeof raw !== "object") continue;
    const track = raw as Record<string, unknown>;
    const title = stockValueHelpers.asText(track.title, 300);
    const id = stockValueHelpers.asText(track.isrc, 100);
    const file = stockValueHelpers.asText(track.filename, 300);
    if (!title || !id || !file || !file.toLowerCase().endsWith(".mp3") || file.includes("/")) continue;
    const time = typeof track.length === "string" ? /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(track.length) : null;
    tracks.push({ title, id, file, searchable: [title, track.instruments, track.feel, track.description].join(" ").toLowerCase(),
      durationMs: time ? (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000 : null });
  }
  return { metadata, tracks };
}

export async function incompetechCatalog(url: string, fetchImpl: HttpFetch, root: string | null, signal?: AbortSignal): Promise<Track[]> {
  let byRoot = musicCatalogs.get(fetchImpl);
  if (!byRoot) { byRoot = new Map(); musicCatalogs.set(fetchImpl, byRoot); }
  let saved = byRoot.get(root);
  const target = root ? path.join(root, "incompetech-pieces.json") : null;
  if (!saved && target) {
    try {
      const data = JSON.parse(await readFile(target, "utf8")) as MusicCatalog;
      if (data && Number.isFinite(data.fetchedAt) && Array.isArray(data.payload)) saved = indexMusic(data);
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  signal?.throwIfAborted();
  if (saved && Date.now() >= saved.metadata.fetchedAt && Date.now() - saved.metadata.fetchedAt < TTL_MS) {
    byRoot.set(root, saved);
    return saved.tracks;
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (saved?.metadata.etag) headers["if-none-match"] = saved.metadata.etag;
  if (saved?.metadata.modified) headers["if-modified-since"] = saved.metadata.modified;
  const result = await fetchApiJsonWithMetadata({ url, label: "Incompetech", fetchImpl, headers, signal });
  if (result.status === 304) {
    if (!saved) throw new StockUnavailableError("Incompetech 返回 304，但没有可复用的目录。");
    saved = { ...saved, metadata: { ...saved.metadata, fetchedAt: Date.now() } };
  } else {
    if (!Array.isArray(result.payload)) throw new StockUnavailableError("Incompetech 曲目目录格式不可识别。");
    saved = indexMusic({ fetchedAt: Date.now(), etag: result.etag, modified: result.modified, payload: result.payload });
  }
  if (target) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(saved.metadata), { mode: 0o600 }); await rename(temp, target); }
    finally { await rm(temp, { force: true }); }
  }
  byRoot.set(root, saved);
  return saved.tracks;
}
