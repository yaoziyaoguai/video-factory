import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionArticleSourceSnapshot } from "@video-factory/production-pipeline";
import { STUDIO_CASE_BORROW_AXES } from "../shared/api.js";
import type {
  StudioCaseBorrowAxis,
  StudioCaseCatalog,
  StudioCaseDetail,
  StudioCaseFacets,
  StudioCaseSelection,
  StudioCaseSourceStatus,
  StudioCaseSummary,
} from "../shared/api.js";
import { CaseContentCache, caseSources, type CaseSource } from "./case-source.js";

const CATALOG_SCHEMA_VERSION = 1;
const DEFAULT_CATALOG_TTL_MS = 30 * 60 * 1_000;
const MAX_TRANSCRIPT_WARM_ITEMS = 6;
/** 来源报错后的冷却：反复重试只会把"暂时不可用"升级成更长时间的风控。 */
const SOURCE_FAILURE_COOLDOWN_MS = 60 * 1_000;
const CASE_EXTRACTOR_VERSION = "case-source-v1";

export interface CaseStudioOptions {
  cacheRoot: string;
  selectionPath: string;
  sources?: CaseSource[];
  contentCache?: CaseContentCache;
  now?: () => Date;
  catalogTtlMs?: number;
}

/** 服务端保存的选中记录：比界面投影多一份正文快照，规划因此不依赖当次网络。 */
export interface CaseSelectionRecord extends StudioCaseSelection {
  snapshot: CaseSnapshot;
}

export interface CaseSnapshot {
  readStatus: ProductionArticleSourceSnapshot["readStatus"];
  paragraphs: Array<{ id: string; text: string }>;
  truncated: boolean;
  contentSha256?: string;
  fetchedAt: string;
  reason?: string;
}

export interface CaseSearchQuery {
  keyword?: string;
  sourceId?: string;
  topic?: string;
  language?: string;
  contentState?: string;
}

export class CaseStudio {
  private readonly sources: CaseSource[];
  private readonly contentCache: CaseContentCache;
  private readonly now: () => Date;
  private readonly catalogTtlMs: number;
  private cachedCatalog: StudioCaseCatalog | undefined;
  private building: Promise<StudioCaseCatalog> | undefined;
  private selectionQueue: Promise<void> = Promise.resolve();
  private readonly sourceCooldownUntil = new Map<string, number>();
  private readonly lastFailure = new Map<string, string>();

  constructor(private readonly options: CaseStudioOptions) {
    this.sources = options.sources ?? caseSources();
    this.contentCache = options.contentCache ?? new CaseContentCache({ cacheRoot: options.cacheRoot });
    this.now = options.now ?? (() => new Date());
    this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  }

  async catalog(options: { force?: boolean } = {}): Promise<StudioCaseCatalog> {
    if (!options.force) {
      const cached = this.cachedCatalog ?? await this.readPersistedCatalog();
      if (cached && this.now().getTime() - Date.parse(cached.generatedAt ?? "") < this.catalogTtlMs) {
        this.cachedCatalog = cached;
        return structuredClone(cached);
      }
    }
    if (this.building) return structuredClone(await this.building);
    this.building = this.buildCatalog().finally(() => { this.building = undefined; });
    const built = await this.building;
    return structuredClone(built);
  }

  async search(query: CaseSearchQuery, options: { force?: boolean } = {}): Promise<StudioCaseCatalog> {
    const catalog = await this.catalog({ ...(options.force ? { force: true } : {}) });
    const keyword = query.keyword?.trim().toLowerCase() ?? "";
    const items = catalog.items.filter((item) =>
      (!query.sourceId || item.sourceId === query.sourceId)
      && (!query.topic || item.topics.includes(query.topic))
      && (!query.language || item.language === query.language)
      && (!query.contentState || item.contentState === query.contentState)
      && (!keyword || searchableText(item).includes(keyword)));
    // 分面始终基于完整目录，而不是上一次的筛选结果：否则筛一次就会把别的选项挤没。
    return { ...catalog, items };
  }

  async readDetail(caseId: string, options: { force?: boolean } = {}): Promise<StudioCaseDetail | undefined> {
    const catalog = await this.catalog();
    const item = catalog.items.find((candidate) => candidate.id === caseId);
    if (!item) return undefined;
    const source = this.sources.find((candidate) => candidate.sourceId === item.sourceId);
    if (!source) return undefined;
    if (!options.force) {
      const cached = await this.contentCache.read(item.sourceId, item.id);
      if (cached) return cached;
    }
    const detail = await source.readDetail(item);
    if (detail.transcript.state !== "unavailable") {
      await this.contentCache.write(item.sourceId, item.id, detail);
      this.mergeItem(detail.item);
    }
    return detail;
  }

  async getSelection(): Promise<StudioCaseSelection | undefined> {
    const record = await this.readSelectionRecord();
    return record ? toSelectionProjection(record) : undefined;
  }

  /**
   * 保存/覆盖当前选中的参考。选中是单例：换一条就是替换，不做多选，
   * 否则"这次到底在参考哪一条"会变得无法回答。
   */
  async saveSelection(input: { caseId: string; intent: string; borrowIntent: string[] }): Promise<StudioCaseSelection> {
    const intent = input.intent.trim();
    if (!intent) throw new CaseSelectionError("请先写清这次想做什么，再开始创作。");
    if (intent.length > 500) throw new CaseSelectionError("这次想做什么请控制在 500 字以内。");
    // 借鉴方式只认固定几项：这段文字会进规划说明，不能让任意文本混进来。
    const borrowIntent = [...new Set(input.borrowIntent.map((item) => item.trim()))]
      .filter((item): item is StudioCaseBorrowAxis => (STUDIO_CASE_BORROW_AXES as readonly string[]).includes(item))
      .slice(0, STUDIO_CASE_BORROW_AXES.length);
    const detail = await this.readDetail(input.caseId);
    if (!detail) throw new CaseSelectionError("没有找到这条参考内容，请返回案例列表重新选择。");
    const now = this.now();
    const record: CaseSelectionRecord = {
      caseId: detail.item.id,
      sourceId: detail.item.sourceId,
      sourceLabel: detail.item.sourceLabel,
      title: detail.item.title,
      originalUrl: detail.item.originalUrl,
      contentState: detail.item.contentState,
      contentTypeLabel: detail.item.contentTypeLabel,
      ...(detail.item.language ? { language: detail.item.language } : {}),
      borrowIntent,
      intent,
      selectedAt: now.toISOString(),
      snapshot: snapshotFromDetail(detail, now),
    };
    await this.withSelectionLock(async () => {
      await this.writeSelectionRecord(record);
    });
    return toSelectionProjection(record);
  }

  async clearSelection(): Promise<void> {
    await this.withSelectionLock(async () => {
      await rm(this.options.selectionPath, { force: true });
    });
  }

  /** 供制作链读取的选中记录；正文快照随记录一起返回，规划不再回源抓取。 */
  async selectionRecord(caseId: string): Promise<CaseSelectionRecord | undefined> {
    const record = await this.readSelectionRecord();
    return record && record.caseId === caseId ? record : undefined;
  }

  async articleSourcesFor(caseId: string): Promise<ProductionArticleSourceSnapshot[]> {
    const record = await this.selectionRecord(caseId);
    if (!record) throw new CaseSelectionError("这次制作引用的参考内容已经不存在，请返回案例列表重新选择。");
    return [articleSourceFromSelection(record)];
  }

  /** 用参考内容自己的身份拼一段可读的借鉴说明；只陈述用户选了什么，不加系统判断。 */
  async borrowDirectiveFor(caseId: string): Promise<string | undefined> {
    const record = await this.selectionRecord(caseId);
    if (!record || record.borrowIntent.length === 0) return undefined;
    return `参考《${record.title}》（${record.sourceLabel}，${record.contentTypeLabel}）的${record.borrowIntent.join("、")}；只借鉴做法，不改变本次主题与观点。`;
  }

  private recordSourceFailure(sourceId: string, failure: string): void {
    this.lastFailure.set(sourceId, failure);
    this.sourceCooldownUntil.set(sourceId, this.now().getTime() + SOURCE_FAILURE_COOLDOWN_MS);
  }

  private clearSourceFailure(sourceId: string): void {
    this.lastFailure.delete(sourceId);
    this.sourceCooldownUntil.delete(sourceId);
  }

  private async buildCatalog(): Promise<StudioCaseCatalog> {
    // 上一轮已取到的内容：这一轮某个来源暂时不可用时，用它兜住列表，
    // 而不是让一次风控或超时把已经拿到的真实内容整片抹掉。
    const previous = this.cachedCatalog ?? await this.readPersistedCatalog();
    const previousBySource = new Map<string, StudioCaseSummary[]>();
    for (const item of previous?.items ?? []) {
      const bucket = previousBySource.get(item.sourceId);
      if (bucket) bucket.push(item);
      else previousBySource.set(item.sourceId, [item]);
    }
    const previousStatus = new Map((previous?.sources ?? []).map((status) => [status.sourceId, status]));

    const collected = await Promise.all(this.sources.map(async (source) => {
      const cooldownUntil = this.sourceCooldownUntil.get(source.sourceId);
      if (cooldownUntil && cooldownUntil > this.now().getTime()) {
        return { source, result: { items: [] as StudioCaseSummary[], failure: this.lastFailure.get(source.sourceId) } };
      }
      try {
        const result = await source.list();
        // 来源把失败写在结果里（B 站的风控就是这样回来的），和抛错一样要冷却：
        // 否则每次刷新都会再去撞一次风控，把"暂时不可用"拖成更长时间不可用。
        const failure = result.items.length === 0 ? result.failure?.trim() : undefined;
        if (failure) this.recordSourceFailure(source.sourceId, failure);
        else this.clearSourceFailure(source.sourceId);
        return { source, result };
      } catch (error) {
        const failure = error instanceof Error ? error.message.trim() : String(error);
        this.recordSourceFailure(source.sourceId, failure);
        return { source, result: { items: [] as StudioCaseSummary[], failure } };
      }
    }));
    const seen = new Map<string, StudioCaseSummary>();
    const statuses: StudioCaseSourceStatus[] = collected.map(({ source, result }) => {
      const fresh = result.items.length > 0;
      const carried = fresh || !result.failure ? [] : previousBySource.get(source.sourceId) ?? [];
      for (const item of fresh ? result.items : carried) if (!seen.has(item.id)) seen.set(item.id, item);
      const retained = previousStatus.get(source.sourceId)?.fetchedAt;
      if (carried.length > 0) {
        return {
          sourceId: source.sourceId,
          label: source.label,
          state: "failed",
          itemCount: carried.length,
          detail: `${result.failure}；下面显示的仍是${retained ? ` ${new Date(retained).toLocaleString("zh-CN", { hour12: false })}` : "上次"}取得的 ${carried.length} 条，本轮没有更新。`,
          ...(retained ? { fetchedAt: retained } : {}),
        };
      }
      return {
        sourceId: source.sourceId,
        label: source.label,
        state: result.failure && !fresh ? "failed" : "ready",
        itemCount: result.items.length,
        detail: result.failure ?? `已取得 ${result.items.length} 条真实内容。`,
        fetchedAt: this.now().toISOString(),
      };
    });
    const items = [...seen.values()];
    const catalog: StudioCaseCatalog = {
      items,
      facets: buildFacets(items),
      sources: statuses,
      generatedAt: this.now().toISOString(),
      loading: false,
    };
    // 先挂上目录再预热：mergeItem 就地改写 this.cachedCatalog 里的条目，
    // 如果预热跑在赋值之前，刚读到的正文会被随后新建的目录覆盖掉，首屏又变回"未读取"。
    this.cachedCatalog = catalog;
    await this.warmTranscripts(items);
    await this.persistCatalog(catalog);
    return catalog;
  }

  /**
   * 冷启动时预热有界的正文前缀：这样首屏的"已有正文"是真的，
   * 而不是把整库都标成"未读取"再让用户逐条点开才发现有没有。
   */
  private async warmTranscripts(items: StudioCaseSummary[]): Promise<void> {
    const candidates = items.filter((item) => item.sourceId === "ted").slice(0, MAX_TRANSCRIPT_WARM_ITEMS);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const item = candidates[cursor++]!;
        const cached = await this.contentCache.read(item.sourceId, item.id);
        if (cached) {
          this.mergeItem(cached.item);
          continue;
        }
        const source = this.sources.find((candidate) => candidate.sourceId === item.sourceId);
        if (!source) continue;
        const detail = await source.readDetail(item).catch(() => undefined);
        if (!detail || detail.transcript.state === "unavailable") continue;
        await this.contentCache.write(item.sourceId, item.id, detail);
        this.mergeItem(detail.item);
      }
    }));
  }

  private mergeItem(updated: StudioCaseSummary): void {
    if (!this.cachedCatalog) return;
    const index = this.cachedCatalog.items.findIndex((item) => item.id === updated.id);
    if (index < 0) return;
    this.cachedCatalog.items[index] = { ...this.cachedCatalog.items[index]!, ...updated };
    this.cachedCatalog.facets = buildFacets(this.cachedCatalog.items);
  }

  private async readPersistedCatalog(): Promise<StudioCaseCatalog | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as { version?: number; catalog?: StudioCaseCatalog };
      if (parsed.version !== CATALOG_SCHEMA_VERSION || !parsed.catalog?.items) return undefined;
      return { ...parsed.catalog, loading: false };
    } catch {
      return undefined;
    }
  }

  private async persistCatalog(catalog: StudioCaseCatalog): Promise<void> {
    try {
      await writeJsonAtomic(this.catalogPath, { version: CATALOG_SCHEMA_VERSION, catalog });
    } catch {
      // 目录落盘失败只影响下次冷启动的耗时，不影响本次浏览。
    }
  }

  private async readSelectionRecord(): Promise<CaseSelectionRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.options.selectionPath, "utf8")) as { version?: number; selection?: CaseSelectionRecord };
      return parsed.version === 1 && parsed.selection ? parsed.selection : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeSelectionRecord(record: CaseSelectionRecord): Promise<void> {
    await writeJsonAtomic(this.options.selectionPath, { version: 1, selection: record });
  }

  private get catalogPath(): string {
    return path.join(this.options.cacheRoot, "catalog.json");
  }

  private async withSelectionLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.selectionQueue;
    let release!: () => void;
    this.selectionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class CaseSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseSelectionError";
  }
}

function snapshotFromDetail(detail: StudioCaseDetail, now: Date): CaseSnapshot {
  const transcript = detail.transcript;
  const hasBody = transcript.state !== "unavailable" && transcript.paragraphs.length > 0;
  if (!hasBody) {
    return {
      readStatus: "title_only",
      paragraphs: [],
      truncated: false,
      fetchedAt: now.toISOString(),
      reason: transcript.reason ?? "该来源只公开视频信息，没有可自动取得的正文。",
    };
  }
  const content = transcript.paragraphs.map((paragraph) => `${paragraph.id}:${paragraph.text}`).join("\n");
  return {
    readStatus: transcript.state === "partial" ? "partial" : "read",
    paragraphs: transcript.paragraphs.map((paragraph) => ({ ...paragraph })),
    truncated: transcript.state === "partial",
    contentSha256: createHash("sha256").update(content).digest("hex"),
    fetchedAt: transcript.fetchedAt ?? now.toISOString(),
    ...(transcript.reason ? { reason: transcript.reason } : {}),
  };
}

function articleSourceFromSelection(record: CaseSelectionRecord): ProductionArticleSourceSnapshot {
  return {
    sourceId: caseSourceId(record),
    originalUrl: record.originalUrl,
    finalUrl: record.originalUrl,
    pageTitle: record.title,
    fetchedAt: record.snapshot.fetchedAt,
    ...(record.snapshot.contentSha256 ? { contentSha256: record.snapshot.contentSha256 } : {}),
    extractorVersion: CASE_EXTRACTOR_VERSION,
    readStatus: record.snapshot.readStatus,
    ...(record.snapshot.reason ? { reason: record.snapshot.reason } : {}),
    paragraphs: record.snapshot.paragraphs.map((paragraph) => ({ ...paragraph })),
    truncated: record.snapshot.truncated,
  };
}

function caseSourceId(record: CaseSelectionRecord): string {
  return `case:${record.sourceId}:${record.caseId}`;
}

function toSelectionProjection(record: CaseSelectionRecord): StudioCaseSelection {
  const { snapshot: _snapshot, ...projection } = record;
  return projection;
}

function searchableText(item: StudioCaseSummary): string {
  return [item.title, item.summary ?? "", item.author ?? "", item.sourceLabel, ...item.topics].join(" ").toLowerCase();
}

// 分面只数真实存在的取值：没有数据的筛选项不出现，也不用"未知"占位。
function buildFacets(items: StudioCaseSummary[]): StudioCaseFacets {
  const facets: StudioCaseFacets = { sources: {}, topics: {}, languages: {}, contentStates: {} };
  for (const item of items) {
    increment(facets.sources, item.sourceLabel);
    increment(facets.contentStates, item.contentState);
    for (const topic of item.topics) increment(facets.topics, topic);
    if (item.language) increment(facets.languages, item.language);
  }
  return facets;
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}
