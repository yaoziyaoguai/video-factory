import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// B3 创作规划 checkpoint 存储：只封装官方 SqliteSaver 的生命周期、固定落盘路径与
// 稳定 thread key；不迁移业务 run/授权/paid ledger，也不提供任何内存回退。

export function planningCheckpointSqlitePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "planning", "checkpoints.sqlite");
}

// thread key 是 (runId, 已接受规划输入 digest) 的确定性纯函数：同一输入身份总能恢复同一
// thread，输入变化自然进入新 thread，不依赖运行时状态或随机 id。
export function planningThreadId(runId: string, inputDigest: string): string {
  const run = runId.trim();
  const digest = inputDigest.trim();
  if (!run) throw new Error("planningThreadId runId must be a non-empty string.");
  if (!digest) throw new Error("planningThreadId inputDigest must be a non-empty string.");
  // runId 来自业务侧、可能包含不适合做存储键的字符：sanitize 只保留可读前缀。唯一性不能
  // 依赖可读前缀——清洗会把 "/" 与 ":" 折叠成 "-"，截断会丢弃 64 字符之后的差异——因此 key
  // 必须同时包含 trim 后原始 runId 与 inputDigest 各自的 sha256 片段，清洗/截断不造成跨 run 碰撞。
  const safeRun = run.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 64);
  const runHash = createHash("sha256").update(run).digest("hex").slice(0, 32);
  const digestHash = createHash("sha256").update(digest).digest("hex").slice(0, 32);
  return `creative-planning:${safeRun}:${runHash}:${digestHash}`;
}

export interface PlanningThreadConfig {
  configurable: { thread_id: string };
}

export class CreativePlanningStore {
  readonly sqlitePath: string;
  readonly saver: SqliteSaver;

  private constructor(sqlitePath: string, saver: SqliteSaver) {
    this.sqlitePath = sqlitePath;
    this.saver = saver;
  }

  static open(workspaceRoot: string): CreativePlanningStore {
    const sqlitePath = planningCheckpointSqlitePath(workspaceRoot);
    const planningDir = path.dirname(sqlitePath);
    let saver: SqliteSaver;
    try {
      mkdirSync(planningDir, { recursive: true });
      saver = SqliteSaver.fromConnString(sqlitePath);
    } catch (error) {
      // 损坏或不可写必须显式失败：创作规划不接受 MemorySaver 或其他静默回退。
      throw new Error(
        `Creative planning checkpoint store cannot open '${sqlitePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new CreativePlanningStore(sqlitePath, saver);
  }

  threadId(runId: string, inputDigest: string): string {
    return planningThreadId(runId, inputDigest);
  }

  threadConfig(runId: string, inputDigest: string): PlanningThreadConfig {
    return { configurable: { thread_id: planningThreadId(runId, inputDigest) } };
  }

  close(): void {
    this.saver.db.close();
  }
}
