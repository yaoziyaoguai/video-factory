import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileRoleAgentLoopCheckpoint, mergeModelExecutionFacts, projectCheckpointExecutions, type RoleAgentLoopCheckpoint } from "@video-factory/production-pipeline";
import type { StudioPlanningOperation } from "../shared/api.js";
import { StudioConflictError } from "./studio-errors.js";
import { legacySeriesPlanningOwner } from "./legacy-series-planning.js";

export interface PlanningOwner {
  kind: "series" | "topic";
  id: string;
  title: string;
  action: "generate" | "audit" | "revise";
  baseRevision?: number;
  episodeNumber?: number;
  pillars?: string[];
  startEpisodeNumber?: number;
  count?: number;
}

/** 业务归属和执行事实共存于原检查点；不另造run或现金账本。 */
export function planningCheckpoint(directory: string, key: string, owner: PlanningOwner): RoleAgentLoopCheckpoint {
  const checkpoint = fileRoleAgentLoopCheckpoint(path.join(directory, `${key}.json`), key);
  let originalOwner = owner;
  return { ...checkpoint,
    async load() {
      const saved = await checkpoint.load();
      if (saved !== undefined) {
        if (!isRecord(saved) || !isPlanningOwner(saved.planningOwner)
          || saved.planningOwner.kind !== owner.kind || saved.planningOwner.id !== owner.id || saved.planningOwner.action !== owner.action) {
          throw new StudioConflictError("历史模型操作缺少可核对的业务归属，已停止执行；请核对原请求，不会用当前版本认领或重新提交。");
        }
        originalOwner = saved.planningOwner;
      }
      return saved;
    },
    save: (value) => checkpoint.save({ ...(value as Record<string, unknown>), planningOwner: originalOwner }),
  };
}

export async function readPlanningCheckpoints(directory: string, onUnassigned?: (operation: StudioPlanningOperation) => void, recoverLegacySeries = path.basename(directory) === "series-showrunner") {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: Array<{ key: string; owner: PlanningOwner; checkpoint: Record<string, unknown>; operation: StudioPlanningOperation }> = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const key = name.slice(0, -5);
    const text = await readFile(path.join(directory, name), "utf8");
    let checkpoint: unknown;
    try { checkpoint = JSON.parse(text); } catch { checkpoint = undefined; }
    const explicitOwner = isRecord(checkpoint) && isPlanningOwner(checkpoint.planningOwner) ? checkpoint.planningOwner : undefined;
    const owner = explicitOwner ?? (isRecord(checkpoint) && checkpoint.planningOwner === undefined && recoverLegacySeries
      ? legacySeriesPlanningOwner(checkpoint) : undefined);
    if (!isRecord(checkpoint) || !owner) {
      const issue = isRecord(checkpoint) ? "历史检查点缺少可核对的业务归属，或原请求证据不一致；不猜测对象或补造用量。" : "检查点无法解析，调用与费用证据不完整。";
      onUnassigned?.({ id: `${path.basename(directory)}:${key}`, owner: { kind: "unassigned", id: key, title: "制作前历史操作 · 归属待核" },
        action: "unknown", state: "unknown", evidenceIssue: issue,
        executionFacts: isRecord(checkpoint) ? mergeModelExecutionFacts(projectCheckpointExecutions(`${path.basename(directory)}.planning`, checkpoint, `planning:${key}`)) : [] });
      continue;
    }
    const facts = mergeModelExecutionFacts(projectCheckpointExecutions(`${owner.kind}.planning`, checkpoint, `planning:${key}`));
    records.push({ key, owner, checkpoint, operation: {
      id: key, owner: { kind: owner.kind, id: owner.id, title: owner.title }, action: owner.action,
      ...(owner.baseRevision !== undefined ? { baseRevision: owner.baseRevision } : {}),
      ...(owner.episodeNumber !== undefined ? { episodeNumber: owner.episodeNumber } : {}),
      ...(!explicitOwner ? { evidenceIssue: "已按原请求输入核对系列归属；未保存原始版本，候选仅供查看，不覆盖当前稿。" } : {}),
      executionFacts: facts, state: typeof checkpoint.status === "string" ? checkpoint.status : "unknown",
    } });
  }
  return records;
}

export async function readPlanningOperations(workspaceRoot: string): Promise<StudioPlanningOperation[]> {
  const unassigned: StudioPlanningOperation[] = [];
  const groups = await Promise.all(["series-showrunner", "topic-editor"].map((name) =>
    readPlanningCheckpoints(path.join(workspaceRoot, "checkpoints", name), (operation) => unassigned.push(operation))));
  return [...groups.flat().map((record) => record.operation), ...unassigned];
}

function isPlanningOwner(value: unknown): value is PlanningOwner {
  return isRecord(value) && ["series", "topic"].includes(String(value.kind))
    && typeof value.id === "string" && typeof value.title === "string"
    && ["generate", "audit", "revise"].includes(String(value.action));
}
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
