import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildStudioApp, type StudioServicePort } from "../src/server/app.js";
import { StudioInputError } from "../src/shared/api.js";
import type { StudioCaseCatalog, StudioCaseDetail, StudioCaseSelection } from "../src/shared/api.js";

const catalog: StudioCaseCatalog = {
  items: [{
    id: "ted:a_real_talk",
    sourceId: "ted",
    sourceLabel: "TED",
    title: "一条真实存在的谈论",
    originalUrl: "https://www.ted.com/talks/a_real_talk",
    author: "某位讲者",
    topics: ["science"],
    contentState: "transcript",
    contentTypeLabel: "原站逐字稿",
    language: "en",
    metrics: [{ label: "播放量", value: 46677589 }],
    metricsFetchedAt: "2026-09-16T00:00:00.000Z",
    usageNote: "CC BY-NC-ND 4.0",
  }],
  facets: { sources: { TED: 1 }, topics: { science: 1 }, languages: { en: 1 }, contentStates: { transcript: 1 } },
  sources: [{ sourceId: "ted", label: "TED", state: "ready", itemCount: 1, detail: "已取得 1 条真实内容。", fetchedAt: "2026-09-16T00:00:00.000Z" }],
  generatedAt: "2026-09-16T00:00:00.000Z",
  loading: false,
};

const detail: StudioCaseDetail = {
  item: catalog.items[0]!,
  transcript: {
    state: "read",
    language: "en",
    fetchedAt: "2026-09-16T00:00:00.000Z",
    paragraphs: [{ id: "p1", text: "原站逐字稿的第一段。" }],
    truncated: false,
    usageNote: "CC BY-NC-ND 4.0",
  },
};

function app(overrides: Partial<StudioServicePort> = {}) {
  const service = {
    listCases: async () => catalog,
    readCase: async (caseId: string) => (caseId === "ted:a_real_talk" ? detail : undefined),
    caseSelection: async (): Promise<StudioCaseSelection | undefined> => undefined,
    selectCase: async (input: { caseId: string; intent: string; borrowIntent: string[] }): Promise<StudioCaseSelection> => ({
      caseId: input.caseId,
      sourceId: "ted",
      sourceLabel: "TED",
      title: "一条真实存在的谈论",
      originalUrl: "https://www.ted.com/talks/a_real_talk",
      contentState: "transcript",
      contentTypeLabel: "原站逐字稿",
      borrowIntent: input.borrowIntent,
      intent: input.intent,
      selectedAt: "2026-09-16T00:00:00.000Z",
    }),
    clearCaseSelection: async () => undefined,
    ...overrides,
  } as unknown as StudioServicePort;
  return buildStudioApp({ service });
}

describe("case routes", () => {
  it("serves the catalog, and passes the filters and the explicit refresh through", async () => {
    const seen: unknown[] = [];
    const instance = app({
      listCases: (async (query: unknown, force?: boolean) => {
        seen.push({ query, force });
        return catalog;
      }) as StudioServicePort["listCases"],
    });
    const plain = await instance.inject({ method: "GET", url: "/api/cases" });
    assert.equal(plain.statusCode, 200);
    assert.equal(plain.json().items[0].id, "ted:a_real_talk");
    const filtered = await instance.inject({ method: "GET", url: "/api/cases?keyword=逐字稿&source=ted&contentState=transcript&refresh=1" });
    assert.equal(filtered.statusCode, 200);
    assert.deepEqual(seen[1], {
      query: { keyword: "逐字稿", sourceId: "ted", contentState: "transcript" },
      force: true,
    });
  });

  it("reports an unknown case as 404 and refuses an unsafe route id", async () => {
    const instance = app();
    const missing = await instance.inject({ method: "GET", url: "/api/cases/ted:nope" });
    assert.equal(missing.statusCode, 404);
    const unsafe = await instance.inject({ method: "GET", url: "/api/cases/..%2F..%2Fetc" });
    assert.equal(unsafe.statusCode, 400);
  });

  it("returns 204 when nothing is selected and 201 with the saved projection when it is", async () => {
    const instance = app();
    const empty = await instance.inject({ method: "GET", url: "/api/cases/selection" });
    assert.equal(empty.statusCode, 204);
    const saved = await instance.inject({
      method: "POST",
      url: "/api/cases/selection",
      headers: { "content-type": "application/json" },
      payload: { caseId: "ted:a_real_talk", intent: "讲清楚它为什么重要", borrowIntent: ["开场方式"] },
    });
    assert.equal(saved.statusCode, 201);
    assert.equal(saved.json().intent, "讲清楚它为什么重要");
    const removed = await instance.inject({ method: "DELETE", url: "/api/cases/selection" });
    assert.equal(removed.statusCode, 204);
  });

  it("rejects a request that is not shaped like a selection instead of storing it", async () => {
    const instance = app();
    // 意图为空、借鉴方式不在选项表里，都由 CaseStudio 拒绝（见 case-source.test.ts）。
    // 路由这一层只管形状：编号缺失、字段类型不对，不该走到领域层。
    for (const payload of [
      { caseId: "", intent: "有效意图", borrowIntent: [] },
      { caseId: "   ", intent: "有效意图", borrowIntent: [] },
      { caseId: "ted:a_real_talk", intent: "有效意图", borrowIntent: "开场方式" },
      { caseId: "ted:a_real_talk", intent: "有效意图", borrowIntent: [1, 2] },
      { caseId: "..%2F..", intent: "有效意图", borrowIntent: [] },
    ]) {
      const response = await instance.inject({ method: "POST", url: "/api/cases/selection", headers: { "content-type": "application/json" }, payload });
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
    }
  });

  it("says the case sources are off rather than pretending there is no content", async () => {
    const instance = app({ listCases: undefined });
    const response = await instance.inject({ method: "GET", url: "/api/cases" });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /案例来源/);
    assert.ok(new StudioInputError("x") instanceof Error);
  });
});
