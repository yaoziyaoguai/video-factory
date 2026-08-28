import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import type { StudioProductionInput } from "../src/shared/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
