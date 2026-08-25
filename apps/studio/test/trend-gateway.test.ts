import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrendGateway } from "../src/server/trend-gateway.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TrendGateway", () => {
  it("reports local services from real health evidence", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes(":6688/douyin")) {
        return jsonResponse({ code: 200, data: [{ title: "抖音热点" }] });
      }
      if (url.includes(":4444/api/s")) {
        return jsonResponse({ status: "success", items: [{ title: "微博热点" }] });
      }
      if (url.includes(":1200/")) {
        return new Response("RSSHub is running", { status: 200 });
      }
      if (url.includes(":8080/")) {
        return new Response("TrendRadar", { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const gateway = new TrendGateway({ fetcher, now: () => new Date("2026-08-24T08:00:00.000Z") });

    const services = await gateway.listServices();

    assert.equal(services.length, 4);
    assert.equal(services.every((service) => service.status === "ready"), true);
    assert.deepEqual(services.map((service) => service.id), ["trendradar", "newsnow", "dailyhot", "rsshub"]);
    assert.equal(services[2]?.itemCount, 1);
    assert.equal(services[0]?.lastCheckedAt, "2026-08-24T08:00:00.000Z");
  });

  it("falls back to valid local URLs when environment values are blank", async () => {
    const requested: string[] = [];
    const gateway = new TrendGateway({
      environment: {
        VIDEO_FACTORY_TRENDRADAR_URL: " ",
        VIDEO_FACTORY_NEWSNOW_URL: "",
        VIDEO_FACTORY_DAILYHOT_URL: "",
        VIDEO_FACTORY_RSSHUB_URL: " ",
      },
      fetcher: async (input) => {
        requested.push(String(input));
        return jsonResponse({ code: 200, status: "success", data: [], items: [] });
      },
    });

    await gateway.listServices();

    assert.equal(requested.some((url) => url.startsWith("http://127.0.0.1:8080/")), true);
    assert.equal(requested.some((url) => url.startsWith("http://127.0.0.1:4444/")), true);
  });

  it("marks an unreachable service stopped without hiding healthy services", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes(":1200/")) throw new Error("connection refused");
      return jsonResponse({ code: 200, status: "success", data: [], items: [] });
    };
    const gateway = new TrendGateway({ fetcher });

    const services = await gateway.listServices();

    assert.equal(services.find((service) => service.id === "rsshub")?.status, "stopped");
    assert.match(services.find((service) => service.id === "rsshub")?.detail ?? "", /connection refused/);
    assert.equal(services.find((service) => service.id === "dailyhot")?.status, "ready");
  });

  it("normalizes signals without discarding independent evidence for the same trend", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.port === "6688") {
        const platform = url.pathname.slice(1);
        return jsonResponse({
          code: 200,
          updateTime: "2026-08-24T07:58:00.000Z",
          data: [
            { id: `${platform}-1`, title: "同一个热点", hot: 9988, url: `https://daily.example/${platform}` },
            { id: `${platform}-2`, title: `${platform} 第二条`, hot: 8000, url: `https://daily.example/${platform}/2` },
          ],
        });
      }
      const platform = url.searchParams.get("id") ?? "unknown";
      return jsonResponse({
        status: "success",
        updatedTime: 1_777_000_000_000,
        items: [
          { id: `${platform}-1`, title: "同一个热点", url: `https://newsnow.example/${platform}` },
          { id: `${platform}-2`, title: `${platform} 新信号`, url: `https://newsnow.example/${platform}/2` },
        ],
      });
    };
    const gateway = new TrendGateway({ fetcher });

    const signals = await gateway.listSignals({ platforms: ["douyin", "weibo"], limit: 20 });

    assert.equal(signals.filter((signal) => signal.title === "同一个热点").length, 4);
    assert.equal(signals.length, 8);
    assert.equal(signals[0]?.sourceId, "dailyhot");
    assert.equal(signals[0]?.platform, "douyin");
    assert.equal(signals[0]?.rank, 1);
    assert.equal(signals[0]?.heat, 9988);
    assert.equal(signals.every((signal) => Boolean(signal.collectedAt)), true);
  });

  it("covers a broad Chinese trend source set by default and balances platforms by rank", async () => {
    const requested = new Set<string>();
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const source = url.port === "6688" ? "dailyhot" : "newsnow";
      const platform = url.port === "6688" ? url.pathname.slice(1) : url.searchParams.get("id") ?? "unknown";
      requested.add(`${source}:${platform}`);
      return url.port === "6688"
        ? jsonResponse({ code: 200, data: [{ title: `${platform} 热点` }] })
        : jsonResponse({ status: "success", items: [{ title: `${platform} 新鲜信号` }] });
    };
    const gateway = new TrendGateway({ fetcher });

    const signals = await gateway.listSignals({ limit: 200 });

    assert.equal(new Set(signals.map((signal) => signal.platform)).size, 14);
    assert.equal(requested.has("dailyhot:kuaishou"), true);
    assert.equal(requested.has("newsnow:toutiao"), true);
    assert.equal(requested.has("dailyhot:guokr"), true);
    assert.equal(signals.every((signal) => signal.rank === 1), true);
  });
});
