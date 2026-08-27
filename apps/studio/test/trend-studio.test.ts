import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudioTrendCandidate } from "../src/shared/api.js";
import { TrendStudio } from "../src/server/trend-studio.js";

describe("TrendStudio", () => {
  it("queues an explicit refresh behind an ordinary in-flight read", async () => {
    const resolvers: Array<(value: StudioTrendCandidate[]) => void> = [];
    let calls = 0;
    const studio = new TrendStudio({
      repositoryRoot: "/repo",
      environment: {},
      now: () => new Date("2026-08-26T12:00:00.000Z"),
      trendGateway: { listServices: async () => [], listSignals: async () => [] },
      trendAgent: {
        listCandidates: async () => {
          calls += 1;
          return new Promise<StudioTrendCandidate[]>((resolve) => resolvers.push(resolve));
        },
      },
    });

    const ordinary = studio.listCandidates();
    const forced = studio.listCandidates({ forceRefresh: true });
    assert.equal(calls, 1);
    resolvers.shift()!([]);
    await ordinary;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    resolvers.shift()!([]);
    await forced;
  });
});
