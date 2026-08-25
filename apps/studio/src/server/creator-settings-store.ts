import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StudioCreatorSettings, StudioCreatorSettingsPatch } from "../shared/api.js";

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
  defaultRecipeId: "economy-daily",
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
      return parsed;
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

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
