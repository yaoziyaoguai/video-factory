import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseProductionTemplate, type ProductionTemplate, type ProductionTemplateInput } from "@video-factory/template-core";

interface StoredTemplates {
  revision: number;
  templates: ProductionTemplateInput[];
  tombstones: string[];
  qaOnlyTemplateIds: string[];
}

const STALE_LOCK_MS = 2 * 60 * 1000;

export interface TemplateStoreSnapshot {
  storeRevision: number;
  templates: ProductionTemplate[];
  publishedTemplates: ProductionTemplate[];
  deletedBuiltIns: ProductionTemplate[];
}

export interface TemplateMutationResult {
  storeRevision: number;
  template: ProductionTemplate;
}

export class TemplateRevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Template store revision conflict: expected ${expected}, current revision is ${actual}.`);
    this.name = "TemplateRevisionConflictError";
  }
}

export class JsonTemplateStore {
  private readonly builtInIds: Set<string>;

  constructor(
    private readonly filePath: string,
    private readonly builtIns: readonly ProductionTemplate[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.builtInIds = new Set(builtIns.map((template) => template.id));
  }

  async list(): Promise<TemplateStoreSnapshot> {
    const state = await this.load();
    const tombstones = new Set(state.tombstones);
    const custom = state.templates
      .map((template) => parseProductionTemplate(template))
      .filter((template) => !state.qaOnlyTemplateIds.includes(template.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.version - left.version);
    const visibleBuiltIns = this.builtIns.filter((template) => !tombstones.has(template.id));
    const latest = new Map(visibleBuiltIns.map((template) => [template.id, template]));
    const published = new Map(visibleBuiltIns.map((template) => [template.id, template]));
    for (const template of custom) {
      const current = latest.get(template.id);
      if (!current || template.version > current.version
        || (template.version === current.version && this.builtIns.includes(current))) {
        latest.set(template.id, template);
      }
      const currentPublished = published.get(template.id);
      if (template.status === "published" && (
        !currentPublished
        || template.version > currentPublished.version
        || (template.version === currentPublished.version && this.builtIns.includes(currentPublished))
      )) {
        published.set(template.id, template);
      }
    }
    const builtInOrder = this.builtIns.map((template) => template.id);
    return {
      storeRevision: state.revision,
      templates: [
        ...builtInOrder.map((id) => latest.get(id)!).filter(Boolean),
        ...custom.filter((template) => !this.builtInIds.has(template.id) && latest.get(template.id) === template),
      ],
      publishedTemplates: [
        ...builtInOrder.map((id) => published.get(id)!).filter(Boolean),
        ...custom.filter((template) => !this.builtInIds.has(template.id) && published.get(template.id) === template),
      ],
      deletedBuiltIns: this.builtIns.filter((template) => tombstones.has(template.id)),
    };
  }

  async get(id: string, version?: number): Promise<ProductionTemplate | undefined> {
    const state = await this.load();
    if (state.tombstones.includes(id) || state.qaOnlyTemplateIds.includes(id)) return undefined;
    return [
      ...state.templates.map((template) => parseProductionTemplate(template)),
      ...this.builtIns,
    ]
      .filter((template) => template.id === id && (version === undefined || template.version === version))
      .sort((left, right) => right.version - left.version)[0];
  }

  async getPublished(id: string, version?: number): Promise<ProductionTemplate | undefined> {
    const state = await this.load();
    if (state.tombstones.includes(id) || state.qaOnlyTemplateIds.includes(id)) return undefined;
    return [
      ...state.templates.map((template) => parseProductionTemplate(template)),
      ...this.builtIns,
    ]
      .filter((template) => template.id === id && template.status === "published" && (version === undefined || template.version === version))
      .sort((left, right) => right.version - left.version)[0];
  }

  async clone(sourceId: string, newId: string, name: string, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      if (state.tombstones.includes(sourceId) || state.qaOnlyTemplateIds.includes(sourceId)) {
        throw new Error(`Template '${sourceId}' was not found.`);
      }
      const source = [...state.templates.map((item) => parseProductionTemplate(item)), ...this.builtIns]
        .find((template) => template.id === sourceId);
      if (!source) throw new Error(`Template '${sourceId}' was not found.`);
      if (this.builtInIds.has(newId) || state.templates.some((template) => template.id === newId)) {
        throw new Error(`Template '${newId}' already exists.`);
      }
      const timestamp = this.now();
      const draft = parseProductionTemplate({
        ...clone(source),
        id: newId,
        version: 1,
        status: "draft",
        name,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      state.templates.unshift(clone(draft));
      return draft;
    });
  }

  async create(
    input: ProductionTemplateInput,
    expectedRevision: number,
    visibility: "production" | "qa" = "production",
  ): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      if (this.builtInIds.has(input.id) || state.templates.some((template) => template.id === input.id)) {
        throw new Error(`Template '${input.id}' already exists.`);
      }
      const draft = parseProductionTemplate({ ...clone(input), status: "draft" });
      state.templates.unshift(clone(draft));
      if (visibility === "qa") state.qaOnlyTemplateIds.push(draft.id);
      return draft;
    });
  }

  async revise(id: string, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      if (state.tombstones.includes(id) || state.qaOnlyTemplateIds.includes(id)) throw new Error(`Template '${id}' was not found.`);
      const versions = [
        ...state.templates.map((template) => parseProductionTemplate(template)).filter((template) => template.id === id),
        ...this.builtIns.filter((template) => template.id === id),
      ];
      const source = versions.sort((left, right) => right.version - left.version)[0];
      if (!source) throw new Error(`Template '${id}' was not found.`);
      if (versions.some((template) => template.status === "draft")) {
        throw new Error(`Template '${id}' already has an editable draft.`);
      }
      const timestamp = this.now();
      const draft = parseProductionTemplate({
        ...clone(source),
        version: source.version + 1,
        status: "draft",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      state.templates.unshift(clone(draft));
      return draft;
    });
  }

  async delete(id: string, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      if (state.tombstones.includes(id)) throw new Error(`Template '${id}' was not found.`);
      const source = [
        ...state.templates.map((template) => parseProductionTemplate(template)),
        ...this.builtIns,
      ]
        .filter((template) => template.id === id)
        .sort((left, right) => right.version - left.version)[0];
      if (!source) throw new Error(`Template '${id}' was not found.`);
      state.templates = state.templates.filter((template) => template.id !== id);
      state.qaOnlyTemplateIds = state.qaOnlyTemplateIds.filter((templateId) => templateId !== id);
      if (this.builtInIds.has(id)) state.tombstones.push(id);
      return source;
    });
  }

  async restoreBuiltIn(id: string, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      const template = this.builtIns.find((candidate) => candidate.id === id);
      if (!template) throw new Error(`Built-in template '${id}' was not found.`);
      if (!state.tombstones.includes(id)) throw new Error(`Built-in template '${id}' is not deleted.`);
      state.tombstones = state.tombstones.filter((templateId) => templateId !== id);
      return template;
    });
  }

  async saveDraft(input: ProductionTemplateInput, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      const index = state.templates.findIndex((template) => template.id === input.id && template.version === input.version);
      if (index < 0) {
        if (this.builtIns.some((template) => template.id === input.id && template.version === input.version)) {
          throw new Error("A published built-in template cannot be edited directly; revise it first.");
        }
        throw new Error(`Template '${input.id}' version ${input.version} was not found.`);
      }
      if (state.templates[index]!.status !== "draft") throw new Error("Only a draft template can be edited.");
      const draft = parseProductionTemplate({ ...clone(input), status: "draft", updatedAt: this.now() });
      state.templates[index] = clone(draft);
      return draft;
    });
  }

  async publish(id: string, expectedRevision: number): Promise<TemplateMutationResult> {
    return this.mutate(expectedRevision, (state) => {
      const index = state.templates.findIndex((template) => template.id === id && template.status === "draft");
      if (index < 0) throw new Error(`Draft template '${id}' was not found.`);
      const latestVersion = Math.max(
        0,
        ...this.builtIns.filter((template) => template.id === id).map((template) => template.version),
        ...state.templates.filter((template) => template.id === id && template.status === "published").map((template) => template.version),
      );
      const published = parseProductionTemplate({
        ...clone(state.templates[index]!),
        version: Math.max(state.templates[index]!.version, latestVersion + 1),
        status: "published",
        updatedAt: this.now(),
      });
      state.templates[index] = clone(published);
      return published;
    });
  }

  private async mutate(
    expectedRevision: number,
    transition: (state: StoredTemplates) => ProductionTemplate,
  ): Promise<TemplateMutationResult> {
    return this.withLock(async () => {
      const state = await this.load();
      if (state.revision !== expectedRevision) throw new TemplateRevisionConflictError(expectedRevision, state.revision);
      const template = transition(state);
      state.revision += 1;
      await this.writeAtomically(state);
      return { storeRevision: state.revision, template };
    });
  }

  private async load(): Promise<StoredTemplates> {
    try {
      const input = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!isRecord(input) || !Number.isInteger(input.revision) || Number(input.revision) < 0 || !Array.isArray(input.templates)) {
        throw new Error("Stored template catalog is invalid.");
      }
      const templates = input.templates.map((template) => clone(parseProductionTemplate(template)));
      const qaOnlyTemplateIds = input.qaOnlyTemplateIds === undefined
        ? []
        : parseTemplateIds(input.qaOnlyTemplateIds, "qaOnlyTemplateIds");
      return {
        revision: Number(input.revision),
        templates,
        tombstones: input.tombstones === undefined
          ? []
          : parseTemplateIds(input.tombstones, "tombstones"),
        qaOnlyTemplateIds: [...new Set([
          ...qaOnlyTemplateIds,
          ...templates.filter(isLegacyBrowserAcceptanceTemplate).map((template) => template.id),
        ])],
      };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { revision: 0, templates: [], tombstones: [], qaOnlyTemplateIds: [] };
      throw error;
    }
  }

  private async writeAtomically(state: StoredTemplates): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    let temporaryHandle: FileHandle | undefined;
    try {
      temporaryHandle = await open(temporary, "wx", 0o600);
      await temporaryHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporary, this.filePath);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    let handle: FileHandle | undefined;
    for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          if (handle) await handle.close().catch(() => undefined);
          throw error;
        }
        if (attempt === 0 && await this.isStaleLock(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        throw new Error("Template catalog is locked by another writer.");
      }
    }
    if (!handle) throw new Error("Template catalog lock could not be acquired.");
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }

  private async isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
      if (Number.isInteger(value.pid) && Number(value.pid) > 0) {
        try {
          process.kill(Number(value.pid), 0);
          return false;
        } catch (error) {
          return hasCode(error, "ESRCH");
        }
      }
    } catch {
      // 旧版本或损坏的锁仅在超过保守时限后回收。
    }
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs > STALE_LOCK_MS;
    } catch (error) {
      return hasCode(error, "ENOENT");
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTemplateIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Stored template catalog ${field} is invalid.`);
  const ids = value.map((item) => {
    if (typeof item !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(item)) {
      throw new Error(`Stored template catalog ${field} is invalid.`);
    }
    return item;
  });
  return [...new Set(ids)];
}

function isLegacyBrowserAcceptanceTemplate(template: ProductionTemplateInput): boolean {
  return template.name.startsWith("夜间验收·")
    && template.description === "用于验证模板编辑、保存与发布流程，不调用付费模型。";
}
