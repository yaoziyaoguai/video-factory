import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// B1 固定图验证：LangGraph.js + 官方 SQLite checkpoint 的进程中断恢复不变量。
// 只锁定框架层行为（跨进程恢复、已完成节点不重复、thread 隔离、失败不静默回退），
// 不实现正式 creative-planning store，也不接入 ProductionPipeline（B2 范围）。

const GraphAnnotation = Annotation.Root({
  value: Annotation<string>(),
  aExecutions: Annotation<number>(),
  bExecutions: Annotation<number>(),
});

interface GraphState {
  value: string;
  aExecutions: number;
  bExecutions: number;
}

function sideEffectCount(sideEffectFile: string): number {
  if (!existsSync(sideEffectFile)) {
    return 0;
  }
  return readFileSync(sideEffectFile, "utf8").split("\n").filter((line) => line === "A").length;
}

// roleA 模拟带外部副作用（如媒体调用）的已完成角色，每次执行向副作用账本追加一行；
// roleB 可控失败，用于在 A 的 checkpoint 落盘后模拟进程中断。
function buildFixedGraph(
  checkpointer: SqliteSaver | MemorySaver,
  options: { sideEffectFile: string; failB?: boolean },
) {
  return new StateGraph(GraphAnnotation)
    .addNode("roleA", (state: GraphState) => {
      appendFileSync(options.sideEffectFile, "A\n");
      return { value: `${state.value}+A`, aExecutions: state.aExecutions + 1 };
    })
    .addNode("roleB", (state: GraphState) => {
      if (options.failB) {
        throw new Error("SIMULATED_INTERRUPTION_inside_roleB");
      }
      return { value: `${state.value}+B`, bExecutions: state.bExecutions + 1 };
    })
    .addEdge(START, "roleA")
    .addEdge("roleA", "roleB")
    .addEdge("roleB", END)
    .compile({ checkpointer });
}

interface RunReport {
  ok: boolean;
  error?: string;
  nextBefore?: string[];
  valuesBefore?: GraphState;
  finalState?: GraphState;
  sideEffectCount?: number;
}

// 子进程脚本：以独立 Node 进程运行同一固定图（phase1 执行 A 后在 B 中断；phase2 恢复）。
// 通过 --input-type=module -e 在仓库根目录求值，bare import 解析到根 node_modules。
function childScript(args: {
  mode: "phase1" | "phase2";
  sqlitePath: string;
  sideEffectFile: string;
  threadId: string;
  inputValue: string;
  failB: boolean;
}): string {
  return `
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const mode = ${JSON.stringify(args.mode)};
const sqlitePath = ${JSON.stringify(args.sqlitePath)};
const sideEffectFile = ${JSON.stringify(args.sideEffectFile)};
const threadId = ${JSON.stringify(args.threadId)};
const inputValue = ${JSON.stringify(args.inputValue)};
const failB = ${JSON.stringify(args.failB)};

const GraphState = Annotation.Root({
  value: Annotation(),
  aExecutions: Annotation(),
  bExecutions: Annotation(),
});

function sideEffectCount() {
  if (!existsSync(sideEffectFile)) return 0;
  return readFileSync(sideEffectFile, "utf8").split("\\n").filter((line) => line === "A").length;
}

const graph = new StateGraph(GraphState)
  .addNode("roleA", (state) => {
    appendFileSync(sideEffectFile, "A\\n");
    return { value: state.value + "+A", aExecutions: state.aExecutions + 1 };
  })
  .addNode("roleB", (state) => {
    if (failB) throw new Error("SIMULATED_INTERRUPTION_inside_roleB");
    return { value: state.value + "+B", bExecutions: state.bExecutions + 1 };
  })
  .addEdge(START, "roleA")
  .addEdge("roleA", "roleB")
  .addEdge("roleB", END)
  .compile({ checkpointer: SqliteSaver.fromConnString(sqlitePath) });

const config = { configurable: { thread_id: threadId } };
try {
  if (mode === "phase1") {
    const result = await graph.invoke({ value: inputValue, aExecutions: 0, bExecutions: 0 }, config);
    console.log(JSON.stringify({ ok: true, finalState: result, sideEffectCount: sideEffectCount() }));
  } else {
    const before = await graph.getState(config);
    const result = await graph.invoke(null, config);
    console.log(JSON.stringify({
      ok: true,
      nextBefore: before.next,
      valuesBefore: before.values,
      finalState: result,
      sideEffectCount: sideEffectCount(),
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error && error.message) }));
  process.exit(1);
}
`;
}

function runChild(args: Parameters<typeof childScript>[0]): Promise<{ exitCode: number | null; report: RunReport | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(args)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      let report: RunReport | null = null;
      const lastLine = stdout.trim().split("\n").pop();
      if (lastLine) {
        try {
          report = JSON.parse(lastLine) as RunReport;
        } catch {
          report = null;
        }
      }
      resolve({ exitCode: code, report, stderr });
    });
  });
}

describe("creative planning SQLite checkpoint（B1 固定图验证）", () => {
  it("独立新进程用相同 SQLite 文件与 thread key 恢复，已完成 roleA 的副作用严格为 1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-sqlite-"));
    try {
      const sqlitePath = path.join(root, "checkpoints.sqlite");
      const sideEffectFile = path.join(root, "side-effects.txt");

      const first = await runChild({ mode: "phase1", sqlitePath, sideEffectFile, threadId: "thread-b1", inputValue: "payload-b1", failB: true });
      assert.equal(first.exitCode, 1);
      assert.equal(first.report?.ok, false);
      assert.match(String(first.report?.error), /SIMULATED_INTERRUPTION_inside_roleB/);
      assert.equal(sideEffectCount(sideEffectFile), 1);

      const second = await runChild({ mode: "phase2", sqlitePath, sideEffectFile, threadId: "thread-b1", inputValue: "payload-b1", failB: false });
      assert.equal(second.exitCode, 0);
      assert.equal(second.report?.ok, true);
      assert.deepEqual(second.report?.nextBefore, ["roleB"]);
      assert.equal(second.report?.valuesBefore?.aExecutions, 1);
      assert.equal(second.report?.finalState?.value, "payload-b1+A+B");
      assert.equal(second.report?.finalState?.aExecutions, 1);
      assert.equal(second.report?.finalState?.bExecutions, 1);
      assert.equal(second.report?.sideEffectCount, 1);
      assert.equal(sideEffectCount(sideEffectFile), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("两个不同 thread key 的输入身份互不串用，各自 roleA 副作用恰为 1 次", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-threads-"));
    try {
      const sqlitePath = path.join(root, "checkpoints.sqlite");
      const sideEffectFile = path.join(root, "side-effects.txt");

      for (const threadId of ["thread-one", "thread-two"]) {
        const first = await runChild({ mode: "phase1", sqlitePath, sideEffectFile, threadId, inputValue: `payload-${threadId}`, failB: true });
        assert.equal(first.exitCode, 1);
      }
      assert.equal(sideEffectCount(sideEffectFile), 2);

      const resumedOne = await runChild({ mode: "phase2", sqlitePath, sideEffectFile, threadId: "thread-one", inputValue: "", failB: false });
      assert.equal(resumedOne.exitCode, 0);
      assert.equal(resumedOne.report?.finalState?.value, "payload-thread-one+A+B");

      const resumedTwo = await runChild({ mode: "phase2", sqlitePath, sideEffectFile, threadId: "thread-two", inputValue: "", failB: false });
      assert.equal(resumedTwo.exitCode, 0);
      assert.equal(resumedTwo.report?.finalState?.value, "payload-thread-two+A+B");

      assert.equal(sideEffectCount(sideEffectFile), 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("已完成 thread 的重复恢复不再执行任何节点", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-idempotent-"));
    try {
      const sqlitePath = path.join(root, "checkpoints.sqlite");
      const sideEffectFile = path.join(root, "side-effects.txt");

      const first = await runChild({ mode: "phase1", sqlitePath, sideEffectFile, threadId: "thread-done", inputValue: "payload-done", failB: true });
      assert.equal(first.exitCode, 1);
      const second = await runChild({ mode: "phase2", sqlitePath, sideEffectFile, threadId: "thread-done", inputValue: "", failB: false });
      assert.equal(second.exitCode, 0);
      const third = await runChild({ mode: "phase2", sqlitePath, sideEffectFile, threadId: "thread-done", inputValue: "", failB: false });

      assert.equal(third.exitCode, 0);
      assert.deepEqual(third.report?.nextBefore, []);
      assert.equal(third.report?.finalState?.value, "payload-done+A+B");
      assert.equal(third.report?.finalState?.aExecutions, 1);
      assert.equal(third.report?.sideEffectCount, 1);
      assert.equal(sideEffectCount(sideEffectFile), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("进程内 MemorySaver 无法在新会话恢复同一 thread，不能作为跨进程恢复手段", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-memory-"));
    try {
      const sideEffectFile = path.join(root, "side-effects.txt");
      const config = { configurable: { thread_id: "thread-memory" } };
      const input: GraphState = { value: "payload-memory", aExecutions: 0, bExecutions: 0 };

      const failing = buildFixedGraph(new MemorySaver(), { sideEffectFile, failB: true });
      await assert.rejects(() => failing.invoke(input, config), /SIMULATED_INTERRUPTION_inside_roleB/);
      assert.equal(sideEffectCount(sideEffectFile), 1);

      // 新会话的 MemorySaver 不持有旧进程的 checkpoint：快照没有携带任何旧状态，恢复请求必须失败，而不是重跑图。
      const freshSession = buildFixedGraph(new MemorySaver(), { sideEffectFile, failB: false });
      const snapshot = await freshSession.getState(config);
      assert.equal(snapshot.values?.value, undefined);
      await assert.rejects(() => freshSession.invoke(null, config));
      assert.equal(sideEffectCount(sideEffectFile), 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("损坏的 checkpoint 数据库明确失败，不静默回退到其他 saver", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-corrupt-"));
    try {
      const sqlitePath = path.join(root, "checkpoints.sqlite");
      await writeFile(sqlitePath, "this is definitely not a sqlite database file, just garbage bytes", "utf8");
      const sideEffectFile = path.join(root, "side-effects.txt");

      const graph = buildFixedGraph(SqliteSaver.fromConnString(sqlitePath), { sideEffectFile });
      await assert.rejects(
        () => graph.invoke({ value: "payload-x", aExecutions: 0, bExecutions: 0 }, { configurable: { thread_id: "thread-corrupt" } }),
        (error: unknown) => error instanceof Error && /file is not a database/.test(error.message),
      );
      assert.equal(sideEffectCount(sideEffectFile), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("不可写的 checkpoint 目录在打开数据库时明确失败", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-b1-readonly-"));
    const readonlyDir = path.join(root, "planning");
    try {
      await mkdir(readonlyDir, { recursive: true });
      await chmod(readonlyDir, 0o555);
      const sqlitePath = path.join(readonlyDir, "checkpoints.sqlite");

      assert.throws(
        () => SqliteSaver.fromConnString(sqlitePath),
        (error: unknown) => error instanceof Error && /unable to open database file/.test(error.message),
      );
    } finally {
      await chmod(readonlyDir, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
