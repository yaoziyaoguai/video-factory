import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// B4-R4 真实进程崩溃恢复（publication protocol）：子进程在规划发布的确定性窗口被 SIGKILL
// 硬杀，由第二个全新子进程经真实 lease 恢复（recoverInterruptedRuns + retryFailedNode）。
// 断言：已完成角色调用不增加（跨进程 side-effect 计数）、正式 artifact 不重复、只有一份
// 当前 accepted 结果、fallback provider/model provenance 存活。外部 transport 全部为替身。
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = path.resolve(import.meta.dirname, "fixtures", "production-planning-publication-child.ts");

interface ChildArgs {
  phase: "crash" | "recover";
  window: "afterGraph" | "afterArtifacts" | "afterCommit" | "afterSeed" | "afterAccepted";
  workspaceRoot: string;
  runId: string;
  sideEffectFile: string;
  seedFallbackTreatment?: boolean;
}

interface ChildReport {
  status: string;
  nodeStatuses: Array<{ nodeId: string; status: string }>;
  artifactKinds: Record<string, number>;
  artifactIdsByKind: Record<string, string[]>;
  outputVersionOwnerships: Array<{ versionId: string; artifactIds: string[]; effective: boolean }>;
  commitCount: number;
  treatmentProvenance: { providerId?: string } | undefined;
  planningStageModels: Array<{ stageId: string; effectiveModelId?: string }>;
}

async function runChild(args: ChildArgs, timeoutMs = 120_000): Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null; report: ChildReport | null; stderr: string }> {
  const childArgs = [
    "--import",
    "tsx",
    CHILD_SCRIPT,
    `--phase=${args.phase}`,
    `--window=${args.window}`,
    `--workspace=${args.workspaceRoot}`,
    `--run-id=${args.runId}`,
    `--side-effect=${args.sideEffectFile}`,
    ...(args.seedFallbackTreatment ? ["--seed-fallback-treatment"] : []),
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, { cwd: path.resolve(import.meta.dirname, "../.."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child (${args.phase}/${args.window}) timed out; stderr: ${stderr.slice(-2000)}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      let report: ChildReport | null = null;
      const lastLine = stdout.trim().split("\n").pop();
      if (lastLine?.startsWith("{")) {
        try {
          const parsed = JSON.parse(lastLine) as { ok: boolean; report?: ChildReport; error?: string };
          report = parsed.ok ? parsed.report ?? null : null;
          if (!parsed.ok) stderr += `\nchild error: ${parsed.error ?? "unknown"}`;
        } catch {
          report = null;
        }
      }
      resolve({ exitCode: code, signalCode: signal, report, stderr });
    });
  });
}

async function readSideEffects(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function countRoleCalls(entries: readonly string[], prefix: string): number {
  return entries.filter((entry) => entry.startsWith(prefix)).length;
}

const FORMAL_KINDS = ["creative_treatment", "script", "storyboard", "executable_plan"] as const;

describe("joint-v1 planning publication crash recovery (real child processes)", () => {
  for (const window of ["afterGraph", "afterArtifacts", "afterCommit"] as const) {
    it(`recovers the ${window} kill window with unique artifacts and one accepted result`, async () => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-publication-"));
      const runId = `run-publication-${window}`;
      const sideEffectFile = path.join(workspaceRoot, "side-effects.txt");
      try {
        const crashed = await runChild({ phase: "crash", window, workspaceRoot, runId, sideEffectFile });
        // 窗口 failpoint 用 SIGKILL 硬杀：进程必然异常退出（不是干净 throw）。
        assert.equal(crashed.exitCode === null && crashed.signalCode === "SIGKILL" || crashed.exitCode === 137, true, `the child must die by SIGKILL (stderr: ${crashed.stderr.slice(-500)})`);
        const before = await readSideEffects(sideEffectFile);
        assert.equal(countRoleCalls(before, "treatment:"), 1, "the graph itself must have completed the treatment once");
        assert.equal(countRoleCalls(before, "screenwriter"), 1);
        assert.equal(countRoleCalls(before, "director"), 1);

        const recovery = await runChild({ phase: "recover", window, workspaceRoot, runId, sideEffectFile });
        assert.equal(recovery.exitCode, 0, `recovery must succeed (stderr: ${recovery.stderr.slice(-800)})`);
        assert.ok(recovery.report);
        assert.equal(recovery.report.status, "needs_human", JSON.stringify(recovery.report.nodeStatuses));

        // 已完成角色调用不增加：恢复只登记/复用正式产物，不重跑创作角色。
        const after = await readSideEffects(sideEffectFile);
        assert.equal(countRoleCalls(after, "treatment:"), 1, `treatment must not re-run after ${window}`);
        assert.equal(countRoleCalls(after, "screenwriter"), 1, `screenwriter must not re-run after ${window}`);
        assert.equal(countRoleCalls(after, "director"), 1, `director must not re-run after ${window}`);

        // 正式 artifact 不重复：每个 kind 恰好一份；只有一份当前 accepted 结果
        // （当前 output version 恰好拥有整组正式产物）；commit 恰好一个。
        for (const kind of FORMAL_KINDS) {
          assert.equal(recovery.report.artifactKinds[kind], 1, `exactly one formal ${kind} artifact expected, got ${JSON.stringify(recovery.report.artifactKinds)}`);
        }
        assert.equal(recovery.report.commitCount, 1, "exactly one planning commit must exist");
        const owners = recovery.report.outputVersionOwnerships.filter((version) => version.effective && version.artifactIds.length === FORMAL_KINDS.length);
        assert.equal(owners.length, 1, `exactly one output version must own the full formal set: ${JSON.stringify(recovery.report.outputVersionOwnerships)}`);
        assert.deepEqual(
          [...owners[0]!.artifactIds].sort(),
          FORMAL_KINDS.flatMap((kind) => recovery.report!.artifactIdsByKind[kind] ?? []).sort(),
          "the accepted output version must own exactly the formal planning artifacts",
        );
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  }

  it("reuses the accepted result when the process dies after run acceptance", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-publication-accepted-"));
    const runId = "run-publication-after-accepted";
    const sideEffectFile = path.join(workspaceRoot, "side-effects.txt");
    try {
      // start 完整返回（run CAS 已保存、正式身份已被 run 接受）后立即硬杀。
      const crashed = await runChild({ phase: "crash", window: "afterAccepted", workspaceRoot, runId, sideEffectFile });
      assert.equal(crashed.exitCode === null && crashed.signalCode === "SIGKILL" || crashed.exitCode === 137, true, `the child must die by SIGKILL (stderr: ${crashed.stderr.slice(-500)})`);
      const before = await readSideEffects(sideEffectFile);
      assert.equal(countRoleCalls(before, "treatment:"), 1);

      // 恢复进程：没有任何 running 节点可恢复，直接复用已接受结果。
      const recovery = await runChild({ phase: "recover", window: "afterAccepted", workspaceRoot, runId, sideEffectFile });
      assert.equal(recovery.exitCode, 0, `recovery must succeed (stderr: ${recovery.stderr.slice(-800)})`);
      assert.ok(recovery.report);
      assert.equal(recovery.report.status, "needs_human", JSON.stringify(recovery.report.nodeStatuses));
      const after = await readSideEffects(sideEffectFile);
      assert.equal(countRoleCalls(after, "treatment:"), 1, "the accepted result must be reused without re-running roles");
      assert.equal(countRoleCalls(after, "screenwriter"), 1);
      assert.equal(countRoleCalls(after, "director"), 1);
      for (const kind of FORMAL_KINDS) {
        assert.equal(recovery.report.artifactKinds[kind], 1, `exactly one formal ${kind} artifact expected, got ${JSON.stringify(recovery.report.artifactKinds)}`);
      }
      assert.equal(recovery.report.commitCount, 1, "the accepted commit must not be rewritten or duplicated");
      const owners = recovery.report.outputVersionOwnerships.filter((version) => version.effective && version.artifactIds.length === FORMAL_KINDS.length);
      assert.equal(owners.length, 1, "the accepted output version must remain the single current result");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps the fallback provider/model provenance across the seed kill window", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "vf-publication-seed-"));
    const runId = "run-publication-after-seed";
    const sideEffectFile = path.join(workspaceRoot, "side-effects.txt");
    try {
      // 基线 + 编辑进入新 digest + 播种 checkpoint 落盘后立即硬杀（同一子进程内）。
      const crashed = await runChild({ phase: "crash", window: "afterSeed", workspaceRoot, runId, sideEffectFile, seedFallbackTreatment: true });
      assert.equal(crashed.exitCode === null && crashed.signalCode === "SIGKILL" || crashed.exitCode === 137, true, `the child must die by SIGKILL (stderr: ${crashed.stderr.slice(-500)})`);
      const before = await readSideEffects(sideEffectFile);
      assert.deepEqual(
        before.filter((entry) => entry.startsWith("treatment:")),
        ["treatment:treatment-model-a", "treatment:treatment-model-b"],
        "the baseline run must have fallen back from model a to model b exactly once",
      );

      // 全新进程恢复：播种的构思产物带着候选 B 的 provenance 存活，构思不重跑。
      const recovery = await runChild({ phase: "recover", window: "afterSeed", workspaceRoot, runId, sideEffectFile });
      assert.equal(recovery.exitCode, 0, `recovery must succeed (stderr: ${recovery.stderr.slice(-800)})`);
      assert.ok(recovery.report);
      assert.equal(recovery.report.status, "needs_human", JSON.stringify(recovery.report.nodeStatuses));
      const after = await readSideEffects(sideEffectFile);
      assert.equal(countRoleCalls(after, "treatment:"), 2, "the seeded treatment must not re-run during recovery");
      // 构思和编剧输入身份未变，由 seed 恢复且不重跑；导演模型切换后只重跑导演。
      assert.equal(countRoleCalls(after, "screenwriter"), 1);
      assert.deepEqual(
        after.filter((entry) => entry.startsWith("director:")),
        ["director:director-model-one", "director:director-model-two"],
      );

      assert.equal(
        recovery.report.treatmentProvenance?.providerId,
        "deepseek",
        "the carried treatment's formal provenance must keep the fallback provider, not the model string or the first binding",
      );
      const treatmentStage = recovery.report.planningStageModels.find((stage) => stage.stageId === "treatment");
      assert.equal(
        treatmentStage?.effectiveModelId,
        "treatment-model-b",
        "the carried treatment stage must keep the actual fallback model provenance",
      );
      // 两次规划输入（旧 digest 基线 + 编辑后的当前 digest）各产生一套正式产物与一个 commit；
      // 当前 accepted 结果唯一：恰好一个 output version 拥有当前完整正式集合。
      assert.equal(recovery.report.commitCount, 2, "each planning digest must hold exactly one commit");
      const owners = recovery.report.outputVersionOwnerships.filter((version) => version.effective && version.artifactIds.length === FORMAL_KINDS.length);
      assert.equal(owners.length, 1, `exactly one output version must own the current formal set: ${JSON.stringify(recovery.report.outputVersionOwnerships)}`);
      // 当前 accepted 集合的每个 id 都必须是该 kind 的正式产物（唯一解析，无跨集/跨 kind 混用）。
      for (const id of owners[0]!.artifactIds) {
        const kinds = FORMAL_KINDS.filter((kind) => recovery.report!.artifactIdsByKind[kind]?.includes(id));
        assert.equal(kinds.length, 1, `current artifact '${id}' must resolve to exactly one formal kind, got ${JSON.stringify(kinds)}`);
      }
      for (const kind of FORMAL_KINDS) {
        assert.equal(recovery.report.artifactIdsByKind[kind]?.length, 2, `the baseline and current sets must each hold one ${kind}`);
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
