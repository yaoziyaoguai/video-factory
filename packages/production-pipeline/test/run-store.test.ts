import assert from "node:assert/strict";
import fs, { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { WorkflowRun } from "@video-factory/workflow-core";
import * as pipeline from "../src/index.js";

function waitingRun(): WorkflowRun<{ title: string }> {
  return {
    id: "run-20260821",
    revision: 0,
    workflowId: "daily-production",
    workflowVersion: "1.0.0",
    status: "needs_human",
    initialInput: { title: "A useful checklist" },
    startedAt: "2026-08-21T10:00:00.000Z",
    finishedAt: "2026-08-21T10:05:00.000Z",
    nodeRuns: [],
    artifacts: [],
    interventions: [],
    decisions: [],
  };
}

describe("FileRunStore", () => {
  it("persists and reloads a run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const FileRunStore = (pipeline as { FileRunStore?: new (root: string) => {
      create: (run: WorkflowRun) => Promise<void>;
      load: (id: string) => Promise<WorkflowRun>;
    } }).FileRunStore;
    assert.equal(typeof FileRunStore, "function");
    const store = new FileRunStore!(root);

    await store.create(waitingRun());
    const loaded = await store.load("run-20260821");

    assert.deepEqual(loaded, waitingRun());
  });

  it("rejects run identifiers that could escape the store root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);

    await assert.rejects(() => store.load("../outside"), /Unsafe run id/);
    await assert.rejects(() => store.load("run/child"), /Unsafe run id/);
  });

  it("uses compare-and-swap revisions to reject stale decisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const FileRunStore = (pipeline as { FileRunStore?: new (root: string) => {
      create: (run: WorkflowRun) => Promise<void>;
      save: (run: WorkflowRun, expectedRevision: number) => Promise<void>;
      load: (id: string) => Promise<WorkflowRun>;
    } }).FileRunStore;
    assert.equal(typeof FileRunStore, "function");
    const store = new FileRunStore!(root);
    const initial = waitingRun();
    await store.create(initial);
    const approved = { ...initial, revision: 1, status: "succeeded" as const };

    await store.save(approved, 0);
    await assert.rejects(() => store.save({ ...approved, revision: 2 }, 0), /Stale run revision/);
  });

  it("creates run.json after node artifacts have already created the run directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const FileRunStore = (pipeline as { FileRunStore?: new (root: string) => {
      create: (run: WorkflowRun) => Promise<void>;
      load: (id: string) => Promise<WorkflowRun>;
    } }).FileRunStore;
    assert.equal(typeof FileRunStore, "function");
    const store = new FileRunStore!(root);
    await mkdir(path.join(root, "run-20260821", "nodes", "script"), { recursive: true });

    await store.create(waitingRun());

    assert.deepEqual(await store.load("run-20260821"), waitingRun());
  });

  it("rejects an active lock and reclaims an orphaned lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const FileRunStore = (pipeline as { FileRunStore?: new (root: string) => {
      create: (run: WorkflowRun) => Promise<void>;
      save: (run: WorkflowRun, expectedRevision: number) => Promise<void>;
      load: (id: string) => Promise<WorkflowRun>;
    } }).FileRunStore;
    assert.equal(typeof FileRunStore, "function");
    const store = new FileRunStore!(root);
    const initial = waitingRun();
    await store.create(initial);
    const lockPath = path.join(root, initial.id, "run.lock");

    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
    await assert.rejects(
      () => store.save({ ...initial, revision: 1, status: "succeeded" }, 0),
      /locked by another writer/,
    );

    await writeFile(lockPath, `${JSON.stringify({ pid: 999_999_999, createdAt: 0 })}\n`, "utf8");
    await store.save({ ...initial, revision: 1, status: "succeeded" }, 0);
    assert.equal((await store.load(initial.id)).revision, 1);
  });

  it("lists persisted runs newest first and ignores unrelated directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const older = {
      ...waitingRun(),
      id: "run-older",
      startedAt: "2026-08-20T10:00:00.000Z",
    };
    const newer = {
      ...waitingRun(),
      id: "run-newer",
      startedAt: "2026-08-21T10:00:00.000Z",
    };
    await store.create(older);
    await store.create(newer);
    await mkdir(path.join(root, "worker-scratch"), { recursive: true });

    const runs = await store.list<{ title: string }>();

    assert.deepEqual(runs.map((run) => run.id), ["run-newer", "run-older"]);
  });

  it("removes a run and all files stored below it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    await store.create(waitingRun());
    await mkdir(path.join(root, "run-20260821", "nodes", "render"), { recursive: true });
    await writeFile(path.join(root, "run-20260821", "nodes", "render", "final.mp4"), "video", "utf8");

    await store.remove("run-20260821");

    await assert.rejects(() => store.load("run-20260821"), { code: "ENOENT" });
    assert.deepEqual(await store.list(), []);
  });

  it("scans around corrupt records: good runs stay readable, bad bytes untouched, complete=false", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    await store.create(waitingRun());
    const truncated = `{"id":"run-truncated","revision":0,"startedAt":"2026-08-`;
    await mkdir(path.join(root, "run-truncated"), { recursive: true });
    await writeFile(path.join(root, "run-truncated", "run.json"), truncated, "utf8");
    await mkdir(path.join(root, "run-wrong-shape"), { recursive: true });
    await writeFile(path.join(root, "run-wrong-shape", "run.json"), JSON.stringify({ id: "run-wrong-shape" }), "utf8");

    const scan = await store.scan<{ title: string }>();

    assert.deepEqual(scan.runs.map((run) => run.id), ["run-20260821"]);
    assert.equal(scan.complete, false);
    const byId = new Map(scan.issues.map((issue) => [issue.runId, issue.problem]));
    assert.equal(byId.get("run-truncated"), "invalid_json");
    assert.equal(byId.get("run-wrong-shape"), "invalid_structure");
    // 坏文件原字节不变；诊断不包含原正文片段（字段名属于诊断元数据）。
    assert.equal(await readFile(path.join(root, "run-truncated", "run.json"), "utf8"), truncated);
    for (const issue of scan.issues) {
      assert.equal(JSON.stringify(issue).includes("2026-08-"), false);
    }
    // 直接load坏记录显式失败（不返回替代结构）。
    await assert.rejects(() => store.load("run-truncated"));
    await assert.rejects(() => store.load("run-wrong-shape"), /structurally invalid/);
    // 严格 list() 合同保持：坏记录仍使整批失败。
    await assert.rejects(() => store.list());
  });

  it("isolates malformed collection elements and nested version state without rewriting records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const healthy = { ...waitingRun(), id: "run-a-healthy" };
    const node = {
      nodeId: "brief", status: "running", startedAt: healthy.startedAt,
      artifactIds: [], qualityGateResults: [],
    };
    const objectCollections = [
      "artifacts", "interventions", "decisions", "executionPlan", "executionReceipts",
      "spendAuthorizations", "creativeReviewOperations", "reviewContinuationOperations",
    ];
    const malformed: Array<Record<string, unknown>> = [
      { nodeRuns: [null] },
      { nodeRuns: [7] },
      { nodeRuns: [[]] },
      { nodeRuns: [{ ...node, nodeId: null }] },
      { nodeRuns: [{ ...node, status: {} }] },
      ...objectCollections.flatMap((field) => [
        { [field]: {} }, { [field]: null }, { [field]: [null] }, { [field]: [[]] },
      ]),
      { consumedSpendAuthorizationIds: {} },
      { consumedSpendAuthorizationIds: [null] },
      ...["artifactIds", "outcomeUncertainOperationIds"].flatMap((field) => [
        { nodeRuns: [{ ...node, [field]: {} }] },
        { nodeRuns: [{ ...node, [field]: [null] }] },
      ]),
      ...["qualityGateResults", "optionalReviewOperationRefs"].flatMap((field) => [
        { nodeRuns: [{ ...node, [field]: {} }] },
        { nodeRuns: [{ ...node, [field]: [null] }] },
      ]),
      { nodeRuns: [{ ...node, qualityGateResults: [{ reasons: {} }] }] },
      ...["inputState", "outputState"].flatMap((field) => [
        { nodeRuns: [{ ...node, [field]: null }] },
        { nodeRuns: [{ ...node, [field]: [] }] },
        { nodeRuns: [{ ...node, [field]: {} }] },
        { nodeRuns: [{ ...node, [field]: { versions: {} } }] },
        { nodeRuns: [{ ...node, [field]: { versions: [null] } }] },
      ]),
      { nodeRuns: [{ ...node, outputState: { versions: [{ artifactIds: {} }] } }] },
      { nodeRuns: [{ ...node, outputState: { versions: [{ inputVersionIds: [null] }] } }] },
      { nodeRuns: [{ ...node, inputState: { versions: [{ upstreamVersionIds: {} }] } }] },
    ];
    await store.create(healthy);
    const originals = new Map<string, string>();
    for (const [index, fields] of malformed.entries()) {
      const id = `run-z-invalid-${index}`;
      const bytes = JSON.stringify({
        ...healthy, id, status: "running", nodeRuns: [node], ...fields,
        initialInput: { title: "PRIVATE_RECORD_CONTENT" },
      });
      await mkdir(store.runDirectory(id));
      await writeFile(store.runPath(id), bytes, "utf8");
      originals.set(id, bytes);
    }

    const scan = await store.scan();
    assert.equal(scan.complete, false);
    assert.deepEqual(scan.runs, [healthy]);
    assert.equal(scan.issues.length, malformed.length);
    assert.deepEqual(new Set(scan.issues.map((issue) => issue.runId)), new Set(originals.keys()));
    for (const issue of scan.issues) {
      assert.equal(issue.problem, "invalid_structure");
      assert.ok(issue.detail);
      assert.equal(JSON.stringify(issue).includes("PRIVATE_RECORD_CONTENT"), false);
      await assert.rejects(() => store.load(issue.runId), /structurally invalid/);
      assert.equal(await readFile(store.runPath(issue.runId), "utf8"), originals.get(issue.runId));
    }
    await assert.rejects(() => store.list(), /structurally invalid/);
    assert.deepEqual(await store.load(healthy.id), healthy);
    assert.deepEqual(await store.scan(), scan);
  });

  it("treats scratch directories without run.json as noise, but formal data without run.json as incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    await store.create(waitingRun());
    await mkdir(path.join(root, "worker-scratch", "tmp"), { recursive: true });
    await writeFile(path.join(root, "run-20260821", "run.json.tmp-1-abc"), "leftover atomic residue", "utf8");

    const quiet = await store.scan();
    assert.deepEqual(quiet.runs.map((run) => run.id), ["run-20260821"]);
    assert.deepEqual(quiet.issues, []);
    assert.equal(quiet.complete, true);

    // 已有正式 ledger/产物但缺 run.json：扫描不完整，且原目录不删不重建。
    await mkdir(path.join(root, "run-formal", "nodes", "assets"), { recursive: true });
    await writeFile(path.join(root, "run-formal", "nodes", "assets", "ledger.json"), "{}", "utf8");
    const afterFormal = await store.scan();
    assert.equal(afterFormal.complete, false);
    assert.deepEqual(afterFormal.issues.map((issue) => issue.runId), ["run-formal"]);
    assert.equal(afterFormal.issues[0]?.problem, "missing_run_json");
    assert.equal(await readFile(path.join(root, "run-formal", "nodes", "assets", "ledger.json"), "utf8"), "{}");
  });

  it("marks every non-scratch orphan incomplete, including publishing, reconciliation and media data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const tempName = "run.json.tmp-123-01234567-89ab-4cde-8f01-23456789abcd";
    await mkdir(path.join(root, "worker-scratch", "tmp"), { recursive: true });
    await mkdir(path.join(root, "run-create-residue"));
    await writeFile(path.join(root, "run-create-residue", tempName), "partial create", "utf8");
    assert.deepEqual(await store.scan(), { runs: [], issues: [], complete: true });

    const files = [
      "publishing/request.json", ".paid-reconciliations/request.json",
      ".audio-review-requests/request.json", "nodes/assets/ledger.json", "media/final.mp4",
      "ledger.json", ".new-business-data/receipt.json", "unknown/result.json",
      "tmp/ledger.json", "run.json.tmp-1-not-a-uuid",
    ];
    const originalFiles = new Map<string, string>();
    const orphanIds = [];
    for (const [index, relativePath] of files.entries()) {
      const id = `run-orphan-${index}`;
      const filePath = path.join(store.runDirectory(id), relativePath);
      const bytes = `preserved business data ${index}`;
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes, "utf8");
      originalFiles.set(filePath, bytes);
      orphanIds.push(id);
    }
    // 空的正式/未知目录仍是存在性证据；符合临时文件名字的目录也不是本 store 产物。
    for (const [index, directory] of ["nodes", "publishing", "unknown", tempName].entries()) {
      const id = `run-empty-business-${index}`;
      await mkdir(path.join(store.runDirectory(id), directory), { recursive: true });
      orphanIds.push(id);
    }
    // 临时文件共存不能掩盖正式数据，scratch 名称也不能豁免其中的账本。
    await mkdir(path.join(root, "run-create-residue", "publishing"));
    await writeFile(path.join(root, "worker-scratch", "ledger.json"), "ledger", "utf8");
    orphanIds.push("run-create-residue", "worker-scratch");

    const scan = await store.scan();
    assert.equal(scan.complete, false);
    assert.deepEqual(scan.runs, []);
    assert.deepEqual(new Set(scan.issues.map((issue) => issue.runId)), new Set(orphanIds));
    assert.ok(scan.issues.every((issue) => issue.problem === "missing_run_json"));
    assert.deepEqual(await store.scan(), scan);
    for (const id of orphanIds) await assert.rejects(() => store.load(id), { code: "ENOENT" });
    for (const [filePath, bytes] of originalFiles) assert.equal(await readFile(filePath, "utf8"), bytes);
    assert.equal(await readFile(path.join(root, "run-create-residue", tempName), "utf8"), "partial create");
    assert.equal(await readFile(path.join(root, "worker-scratch", "ledger.json"), "utf8"), "ledger");
  });

  it("propagates EIO from root reads, run reads and orphan inspection", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const run = waitingRun();
    await store.create(run);
    const orphanDirectory = path.join(root, "run-orphan");
    await mkdir(orphanDirectory);

    for (const [method, failingPath] of [
      ["readdir", root], ["readFile", store.runPath(run.id)], ["readdir", orphanDirectory],
    ] as const) {
      const original = fs[method];
      const failure = Object.assign(new Error("injected read failure"), { code: "EIO" });
      const patched = t.mock.method(fs, method, async (...args: unknown[]) => {
        if (args[0] === failingPath) throw failure;
        return Reflect.apply(original, fs, args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(() => store.scan(), (error) => error === failure);
        if (failingPath !== orphanDirectory) {
          await assert.rejects(() => store.list(), (error) => error === failure);
        }
        if (method === "readFile") {
          await assert.rejects(() => store.load(run.id), (error) => error === failure);
        }
      } finally {
        patched.mock.restore();
        syncBuiltinESMExports();
      }
    }
  });

  it("propagates unreadable store roots instead of returning an empty scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(path.join(root, "missing-root"));
    assert.deepEqual(await store.scan(), { runs: [], issues: [], complete: true });

    const locked = path.join(root, "locked");
    await mkdir(path.join(locked, "run-a"), { recursive: true });
    await writeFile(path.join(locked, "run-a", "run.json"), "{}", "utf8");
    await chmod(locked, 0o000);
    try {
      const denied = new pipeline.FileRunStore(locked);
      await assert.rejects(() => denied.scan(), (error: NodeJS.ErrnoException) => error.code === "EACCES");
      await assert.rejects(() => denied.list(), (error: NodeJS.ErrnoException) => error.code === "EACCES");
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("still scans legitimate legacy records that predate optional run fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const legacy = {
      id: "run-legacy",
      revision: 3,
      workflowId: "daily-production",
      status: "succeeded",
      startedAt: "2026-01-02T08:00:00.000Z",
      nodeRuns: [],
    };
    await mkdir(path.join(root, "run-legacy"), { recursive: true });
    await writeFile(path.join(root, "run-legacy", "run.json"), JSON.stringify(legacy), "utf8");

    const legacyNode = {
      ...legacy, id: "run-legacy-node", startedAt: "2026-01-01T08:00:00.000Z",
      nodeRuns: [{ nodeId: "old-custom-node", status: "succeeded", output: { historical: true } }],
    };
    await mkdir(store.runDirectory(legacyNode.id));
    const original = JSON.stringify(legacyNode);
    await writeFile(store.runPath(legacyNode.id), original, "utf8");

    const scan = await store.scan();

    assert.deepEqual(scan, { runs: [legacy, legacyNode], issues: [], complete: true });
    assert.deepEqual(await store.list(), [legacy, legacyNode]);
    assert.deepEqual(await store.load(legacyNode.id), legacyNode);
    assert.equal(await readFile(store.runPath(legacyNode.id), "utf8"), original);
  });

  it("accepts populated optional collections and version states without validating opaque outputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);
    const run = {
      ...waitingRun(),
      nodeRuns: [{
        nodeId: "brief", status: "succeeded", artifactIds: ["artifact-1"],
        qualityGateResults: [{ gateId: "legacy-check", status: "passed", reasons: ["accepted"] }],
        optionalReviewOperationRefs: [{ operationId: "review-1" }],
        outcomeUncertainOperationIds: ["review-1"],
        inputState: { versions: [{ id: "input-1", upstreamVersionIds: [], value: null }] },
        outputState: { versions: [{ id: "output-1", artifactIds: ["artifact-1"], inputVersionIds: ["input-1"], output: [null] }] },
      }],
      artifacts: [{ id: "artifact-1" }], interventions: [{ id: "intervention-1" }], decisions: [{ id: "decision-1" }],
      executionPlan: [{ nodeId: "brief" }], executionReceipts: [{ nodeId: "brief" }],
      spendAuthorizations: [{ id: "authorization-1" }], consumedSpendAuthorizationIds: ["authorization-1"],
      creativeReviewOperations: [{ commandId: "review-1", status: "completed" }],
      reviewContinuationOperations: [{ commandId: "continue-1", status: "applied" }],
    };
    await mkdir(store.runDirectory(run.id));
    const original = JSON.stringify(run);
    await writeFile(store.runPath(run.id), original, "utf8");

    assert.deepEqual(await store.load(run.id), run);
    assert.deepEqual(await store.scan(), { runs: [run], issues: [], complete: true });
    assert.equal(await readFile(store.runPath(run.id), "utf8"), original);
  });

  it("publishes initial runs atomically: no overwrite, no half files, single concurrent winner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    const store = new pipeline.FileRunStore(root);

    // 目标已存在：发布失败且原字节不被覆盖。
    await mkdir(path.join(root, "run-20260821"), { recursive: true });
    const original = "pre-existing bytes";
    await writeFile(path.join(root, "run-20260821", "run.json"), original, "utf8");
    await assert.rejects(() => store.create(waitingRun()), /already exists/);
    assert.equal(await readFile(path.join(root, "run-20260821", "run.json"), "utf8"), original);

    // 并发同ID：只有一个成功发布。
    const second = { ...waitingRun(), id: "run-race" };
    const outcomes = await Promise.allSettled([
      store.create(second),
      store.create(second),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /already exists/);
    assert.deepEqual(await store.load("run-race"), second);

    // 写入期失败（序列化抛错）：不留半个最终文件，也不留临时残留。
    const circular: Record<string, unknown> = { id: "run-circular" };
    circular.self = circular;
    await assert.rejects(() => store.create(circular as unknown as WorkflowRun));
    await assert.rejects(() => store.load("run-circular"), { code: "ENOENT" });
    const residue = (await readdir(root, { recursive: true })).filter((entry) => entry.includes("tmp-"));
    assert.deepEqual(residue, []);
  });

  for (const stage of ["write", "sync", "link"] as const) {
    it(`leaves no final or temporary file after ${stage} fails during atomic creation`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "vf-create-boundary-"));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const store = new pipeline.FileRunStore(root);
      const failure = Object.assign(new Error(`injected ${stage} failure`), { code: stage === "write" ? "ENOSPC" : "EIO" });
      const originalOpen = fs.open;
      const originalLink = fs.link;
      const patched = stage === "link"
        ? t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
          if (args[1] === store.runPath(waitingRun().id)) throw failure;
          return originalLink(...args);
        })
        : t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (typeof args[0] === "string" && args[0].startsWith(`${store.runPath(waitingRun().id)}.tmp-`)) {
            if (stage === "write") {
              const write = handle.writeFile.bind(handle);
              t.mock.method(handle, "writeFile", async () => {
                await write('{"partial":', "utf8");
                throw failure;
              });
            } else t.mock.method(handle, "sync", async () => { throw failure; });
          }
          return handle;
        });
      syncBuiltinESMExports();
      try {
        await assert.rejects(() => store.create(waitingRun()), error => error === failure);
        await assert.rejects(() => readFile(store.runPath(waitingRun().id)), { code: "ENOENT" });
        assert.deepEqual(await readdir(store.runDirectory(waitingRun().id)), []);
      } finally {
        patched.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }

  it("keeps the fully published final file when the post-publish directory sync fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-run-store-"));
    class FailingSyncStore extends pipeline.FileRunStore {
      protected override async syncPublishedDirectory(): Promise<void> {
        throw new Error("simulated directory fsync failure");
      }
    }
    const store = new FailingSyncStore(root);

    await assert.rejects(() => store.create(waitingRun()), /fully written but publishing it durably failed/);
    // 完整最终文件保留，不回滚删除。
    assert.deepEqual(await store.load("run-20260821"), waitingRun());
  });
});
