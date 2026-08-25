import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type {
  StudioArtifactResource,
  StudioHealth,
  StudioLocalCapability,
  StudioProvider,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";
import { LocalCapabilityService } from "./local-capabilities.js";
import { buildProviderCatalog, type CodexCatalogAvailability } from "./provider-catalog.js";

export interface CapabilityStudioOptions {
  repositoryRoot: string;
  workspaceRoot: string;
  environment: NodeJS.ProcessEnv;
  commandAvailable?: (command: string) => Promise<boolean>;
  localCapabilities?: Pick<LocalCapabilityService, "report" | "listVoices" | "preview">;
  codexAvailability?: CodexCatalogAvailability;
}

export class CapabilityStudio {
  private readonly commandAvailable: (command: string) => Promise<boolean>;
  private readonly localCapabilities: Pick<LocalCapabilityService, "report" | "listVoices" | "preview">;

  constructor(private readonly options: CapabilityStudioOptions) {
    this.commandAvailable = options.commandAvailable ?? isCommandAvailable;
    this.localCapabilities = options.localCapabilities ?? new LocalCapabilityService({
      repositoryRoot: options.repositoryRoot,
      workspaceRoot: options.workspaceRoot,
      environment: options.environment,
      commandAvailable: this.commandAvailable,
    });
  }

  async health(): Promise<StudioHealth> {
    const [python, ffmpeg, ffprobe, say] = await Promise.all([
      this.commandAvailable("python3"),
      this.commandAvailable("ffmpeg"),
      this.commandAvailable("ffprobe"),
      this.commandAvailable("say"),
    ]);
    return {
      status: python && ffmpeg && ffprobe ? "ok" : "degraded",
      runtime: { python, ffmpeg, ffprobe, say },
    };
  }

  async listProviders(): Promise<StudioProvider[]> {
    const health = await this.health();
    return buildProviderCatalog({
      python: health.runtime.python ?? false,
      ffmpeg: health.runtime.ffmpeg ?? false,
      ffprobe: health.runtime.ffprobe ?? false,
      say: health.runtime.say ?? false,
    }, this.options.environment, this.options.codexAvailability);
  }

  listLocalCapabilities(): Promise<StudioLocalCapability[]> {
    return this.localCapabilities.report();
  }

  listVoices(): Promise<StudioVoiceProfile[]> {
    return this.localCapabilities.listVoices();
  }

  previewVoice(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined> {
    return this.localCapabilities.preview(input);
  }
}

async function isCommandAvailable(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH entries.
    }
  }
  return false;
}
