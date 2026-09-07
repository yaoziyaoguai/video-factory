import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import type { StudioProductionInput } from "../src/shared/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("source supplement client API", () => {
  it("posts candidate and opportunity urls with the trusted studio mutation header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "trend-1" }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "opportunity-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await studioApi.supplementCandidateSources("trend/1", { evidenceUrls: ["https://example.com/a"] });
    await studioApi.supplementOpportunitySources("opportunity 1", { evidenceUrls: ["https://example.org/b"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/candidate-inbox/trend%2F1/sources");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/opportunities/opportunity%201/sources");
    const candidateInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const opportunityInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(candidateInit.method).toBe("POST");
    expect(opportunityInit.method).toBe("POST");
    expect(new Headers(candidateInit.headers).get("x-video-factory-request")).toBe("studio");
    expect(new Headers(opportunityInit.headers).get("x-video-factory-request")).toBe("studio");
    expect(JSON.parse(String(candidateInit.body))).toEqual({ evidenceUrls: ["https://example.com/a"] });
    expect(JSON.parse(String(opportunityInit.body))).toEqual({ evidenceUrls: ["https://example.org/b"] });
  });
});

describe("studioApi production start", () => {
  it("reuses one idempotency key after a transport failure and releases it after success", async () => {
    const requests: RequestInit[] = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      call += 1;
      if (call === 1) throw new TypeError("network disconnected after request upload");
      return new Response(JSON.stringify({ runId: `run-${call}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const input = { title: "幂等重试测试" } as StudioProductionInput;

    await expect(studioApi.start(input)).rejects.toThrow(/network disconnected/);
    await expect(studioApi.start(input)).resolves.toEqual({ runId: "run-2" });
    await expect(studioApi.start(input)).resolves.toEqual({ runId: "run-3" });

    const keys = requests.map((request) => new Headers(request.headers).get("idempotency-key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});
