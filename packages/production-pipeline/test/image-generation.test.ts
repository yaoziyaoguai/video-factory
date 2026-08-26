import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SeedreamImageAdapter } from "../src/index.js";

describe("SeedreamImageAdapter", () => {
  it("requests one vertical image through the official Ark endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-test",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({
          model: "doubao-seedream-test",
          created: 123456,
          data: [{ url: "https://example.com/seedream.png", size: "1440x2560" }],
          usage: { generated_images: 1 },
        });
      },
    });

    const result = await adapter.generate({ prompt: "雨夜中的城市便利店，纪实电影光线", ratio: "9:16" });

    assert.equal(result.providerId, "seedream-image-v1");
    assert.equal(result.imageUrl, "https://example.com/seedream.png");
    assert.match(result.taskId, /^seedream-123456-/);
    assert.equal(calls[0]?.url, "https://ark.cn-beijing.volces.com/api/v3/images/generations");
    assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret-ark-key");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      model: "doubao-seedream-test",
      prompt: "雨夜中的城市便利店，纪实电影光线",
      size: "1440x2560",
      sequential_image_generation: "disabled",
      response_format: "url",
      watermark: false,
    });
  });

  it("rejects malformed provider responses", async () => {
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-test",
      fetch: async () => Response.json({ data: [] }),
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "竖屏画面", ratio: "9:16" }),
      /image data is missing/i,
    );
  });
});
