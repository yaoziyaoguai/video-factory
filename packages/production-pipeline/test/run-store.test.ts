import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
});
