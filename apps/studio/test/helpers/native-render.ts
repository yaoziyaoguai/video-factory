import path from "node:path";
import { createAgentRuntime, type AgentRuntime } from "../../src/server/agent/assembly.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL, defaultSkillsRoot } from "../../src/server/agent/offline.js";
import { LocalRenderPort } from "../../src/server/agent/local-render.js";
import { mixedRenderCatalogEntry, renderCatalogEntry, narratedRenderCatalogEntry, timedNarratedRenderCatalogEntry } from "../../src/server/agent/media-config.js";
import type { AgentDatabase } from "../../src/server/agent/db.js";
import type { ProductionBlobs } from "../../src/server/agent/production-blobs.js";
import type { QuoteCatalog } from "../../src/server/agent/artifact-store.js";
import type { MediaExecutionPort } from "../../src/shared/agent/ports.js";
const staticClock = () => "2026-10-28T00:00:00.000Z";
const FAUX_TEXT_ENTRY = { binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
  name: "Faux 文本模型", kind: "text" as const, features: ["chat", "tools"], availability: "configured" as const,
  verificationNote: "离线 Faux 文本", isDefault: true };
export const LOCAL_CATALOG = () => ({ "render:ordered_concat": renderCatalogEntry(true), "render:narrated_concat": narratedRenderCatalogEntry(), "render:timed_narrated_concat": timedNarratedRenderCatalogEntry(), "render:mixed_concat": mixedRenderCatalogEntry() });

export function buildLocalRuntime(directory: string, createPort?: (blobs: ProductionBlobs, db: AgentDatabase) => MediaExecutionPort, extraCatalog: QuoteCatalog = {}): Promise<AgentRuntime> {
  const workRoot = path.join(directory, "media-work");
  return createAgentRuntime({
    dataDir: directory, skillsRoot: defaultSkillsRoot,
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, clock: staticClock,
    media: { autoStart: false, factory: (db, blobs) => ({
      port: createPort ? createPort(blobs, db) : new LocalRenderPort(db, blobs, staticClock, { workRoot }),
      catalog: () => ({ ...LOCAL_CATALOG(), ...extraCatalog }), models: () => [],
    }) },
  });
}

