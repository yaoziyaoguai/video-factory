import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StudioCreatorSettings,
  StudioCreatorSettingsPatch,
  StudioProductionRoleBindingKey,
  StudioRoleProviderDefaults,
} from "../shared/api.js";
import {
  DEFAULT_STUDIO_PRODUCTION_DEFAULTS,
  DEFAULT_STUDIO_TOPIC_STRATEGY,
} from "../shared/api.js";

const PRODUCTION_ROLE_KEYS = new Set<StudioProductionRoleBindingKey>([
  "script",
  "director",
  "assets",
  "voice",
  "render",
  "technicalReview",
  "visualReview",
]);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CreatorSettingsRepository {
  get(): Promise<StudioCreatorSettings>;
  update(patch: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings>;
}

interface CreatorSettingsFile {
  version: 1;
  settings: StudioCreatorSettings;
}

export const DEFAULT_CREATOR_SETTINGS: StudioCreatorSettings = {
  voiceDirection: {
    profileId: "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  },
  voiceDirectionCustomized: false,
  defaultRecipeId: "economy-daily",
  roleProviderDefaults: {},
  modelDefaults: {},
  productionDefaults: { ...DEFAULT_STUDIO_PRODUCTION_DEFAULTS },
  topicStrategy: { ...DEFAULT_STUDIO_TOPIC_STRATEGY },
};

export class JsonCreatorSettingsStore implements CreatorSettingsRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async get(): Promise<StudioCreatorSettings> {
    return structuredClone((await this.read()).settings);
  }

  async update(patch: StudioCreatorSettingsPatch): Promise<StudioCreatorSettings> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const file = await this.read();
      const settings: StudioCreatorSettings = {
        ...file.settings,
        ...patch,
        ...(patch.voiceDirection ? { voiceDirection: { ...patch.voiceDirection } } : {}),
        voiceDirectionCustomized: patch.voiceDirection ? true : file.settings.voiceDirectionCustomized ?? false,
        roleProviderDefaults: patch.roleProviderDefaults
          ? { ...patch.roleProviderDefaults }
          : { ...file.settings.roleProviderDefaults },
        modelDefaults: patch.modelDefaults ? { ...patch.modelDefaults } : { ...file.settings.modelDefaults },
        productionDefaults: {
          ...file.settings.productionDefaults,
          ...patch.productionDefaults,
          reviewMode: "manual",
        },
        topicStrategy: patch.topicStrategy
          ? { ...file.settings.topicStrategy, ...patch.topicStrategy }
          : { ...file.settings.topicStrategy },
      };
      await this.write({ version: 1, settings });
      return structuredClone(settings);
    } finally {
      release();
    }
  }

  private async read(): Promise<CreatorSettingsFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as CreatorSettingsFile;
      if (parsed.version !== 1 || !parsed.settings?.voiceDirection || !parsed.settings.defaultRecipeId) {
        throw new Error(`Unsupported creator settings format at '${this.filePath}'.`);
      }
      return {
        version: 1,
        settings: {
          ...structuredClone(DEFAULT_CREATOR_SETTINGS),
          ...parsed.settings,
          voiceDirection: { ...DEFAULT_CREATOR_SETTINGS.voiceDirection, ...parsed.settings.voiceDirection },
          voiceDirectionCustomized: parsed.settings.voiceDirectionCustomized
            ?? !sameVoiceDirection(parsed.settings.voiceDirection, DEFAULT_CREATOR_SETTINGS.voiceDirection),
          roleProviderDefaults: sanitizeRoleProviderDefaults(parsed.settings.roleProviderDefaults),
          modelDefaults: { ...DEFAULT_CREATOR_SETTINGS.modelDefaults, ...parsed.settings.modelDefaults },
          productionDefaults: {
            ...DEFAULT_CREATOR_SETTINGS.productionDefaults,
            ...parsed.settings.productionDefaults,
            reviewMode: "manual",
          },
          topicStrategy: {
            ...DEFAULT_CREATOR_SETTINGS.topicStrategy,
            ...parsed.settings.topicStrategy,
          },
        },
      };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { version: 1, settings: structuredClone(DEFAULT_CREATOR_SETTINGS) };
      throw error;
    }
  }

  private async write(file: CreatorSettingsFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function sameVoiceDirection(
  left: StudioCreatorSettings["voiceDirection"],
  right: StudioCreatorSettings["voiceDirection"],
): boolean {
  return left.profileId === right.profileId
    && left.rate === right.rate
    && left.pauseScale === right.pauseScale
    && left.masteringPreset === right.masteringPreset;
}

function sanitizeRoleProviderDefaults(value: unknown): StudioRoleProviderDefaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const sanitized: StudioRoleProviderDefaults = {};
  for (const [role, providerId] of Object.entries(value)) {
    if (!PRODUCTION_ROLE_KEYS.has(role as StudioProductionRoleBindingKey) || typeof providerId !== "string") continue;
    const normalized = providerId.trim();
    if (!PROVIDER_ID_PATTERN.test(normalized)) continue;
    sanitized[role as StudioProductionRoleBindingKey] = normalized;
  }
  return sanitized;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
