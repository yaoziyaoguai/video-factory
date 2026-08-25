import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TopicCandidate } from "@video-factory/workflow-core";
import {
  JsonOpportunityStore,
  OpportunityStoreConflictError,
  OpportunityStoreNotFoundError,
  type OpportunityRecord,
} from "../src/server/opportunity-store.js";

function record(id: string, final: number, status: TopicCandidate["status"] = "shortlisted"): OpportunityRecord {
  return {
    title: `选题 ${id}`,
    createdAt: `2026-08-22T10:0${id}.000Z`,
    updatedAt: `2026-08-22T10:0${id}.000Z`,
    candidate: {
      id,
      platform: "douyin",
      track: "ordinary-life",
      audience: "普通上班族",
      painPoint: "下班后没有精力",
      hook: "你不是懒，只是累了。",
      status,
      evidence: [{ source: "manual", platform: "douyin", keyword: "下班后", strength: 78 }],
      score: {
        audienceReach: final,
        visualFeasibility: final,
        productionCostEfficiency: final,
        novelty: final,
        monetization: final,
        seriesPotential: final,
        complianceRisk: 10,
        final,
      },
    },
  };
}

describe("JsonOpportunityStore", () => {
  it("returns an empty collection before the store file exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-opportunities-"));
    const store = new JsonOpportunityStore(path.join(root, "opportunities.json"));

    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get("missing"), undefined);
  });

  it("persists records and orders them by score then freshness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-opportunities-"));
    const filePath = path.join(root, "nested", "opportunities.json");
    const store = new JsonOpportunityStore(filePath);

    await Promise.all([
      store.create(record("1", 72)),
      store.create(record("2", 91)),
      store.create(record("3", 91)),
    ]);

    assert.deepEqual((await store.list()).map((item) => item.candidate.id), ["3", "2", "1"]);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { version: number; opportunities: OpportunityRecord[] };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.opportunities.length, 3);
  });

  it("rejects duplicate ids and invalid status transitions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-opportunities-"));
    const store = new JsonOpportunityStore(path.join(root, "opportunities.json"));
    await store.create(record("1", 80, "shortlisted"));

    await assert.rejects(
      () => store.create(record("1", 90)),
      (error: unknown) => error instanceof OpportunityStoreConflictError && /already exists/.test(error.message),
    );
    await assert.rejects(
      () => store.updateStatus("1", "tested", "2026-08-22T11:00:00.000Z"),
      (error: unknown) => error instanceof OpportunityStoreConflictError && /shortlisted.*tested/.test(error.message),
    );
  });

  it("updates allowed editorial states and reports missing ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vf-opportunities-"));
    const store = new JsonOpportunityStore(path.join(root, "opportunities.json"));
    await store.create(record("1", 80, "shortlisted"));

    const approved = await store.updateStatus("1", "approved", "2026-08-22T11:00:00.000Z");

    assert.equal(approved.candidate.status, "approved");
    assert.equal(approved.updatedAt, "2026-08-22T11:00:00.000Z");
    await assert.rejects(
      () => store.updateStatus("missing", "approved", "2026-08-22T11:00:00.000Z"),
      (error: unknown) => error instanceof OpportunityStoreNotFoundError,
    );
  });
});
