import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestRejectedError, SeedreamImageAdapter } from "../src/index.js";

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
    assert.equal(adapter.modelId, "doubao-seedream-test");
    assert.equal(adapter.supportsReferenceImage, false);
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

  it("passes one or more reference images through Seedream's image field", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-4-0-250828",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ created: 1, data: [{ url: "https://example.com/result.png" }] });
      },
    });
    const references: [string, ...string[]] = [
      "data:image/png;base64,aW1hZ2U=",
      "https://example.com/reference.webp",
    ];

    await adapter.generate({ prompt: "保持主体一致", ratio: "9:16", referenceImages: references });

    assert.equal(adapter.supportsReferenceImage, true);
    assert.deepEqual(body?.image, references);
  });

  it("rejects an empty or unsupported reference image before calling Seedream", async () => {
    let calls = 0;
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-test",
      fetch: async () => {
        calls += 1;
        return Response.json({ created: 1, data: [{ url: "https://example.com/result.png" }] });
      },
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "保持主体一致", ratio: "9:16", referenceImages: [] as never }),
      /at least one image/i,
    );
    await assert.rejects(
      () => adapter.generate({ prompt: "保持主体一致", ratio: "9:16", referenceImages: ["file:\/\/private.png"] }),
      /HTTP\(S\) URL or image data URL/i,
    );
    assert.equal(calls, 0);
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

  it("marks an explicit HTTP rejection as a definitive pre-submission failure", async () => {
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-test",
      fetch: async () => Response.json({
        error: { message: "The input may contain sensitive information: data:image/png;base64,UElJ" },
      }, { status: 400 }),
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "竖屏画面", ratio: "9:16" }),
      (error: unknown) => error instanceof ProviderRequestRejectedError
        && /sensitive information/i.test(error.message)
        && /\[redacted image data\]/i.test(error.message)
        && !/data:image|UElJ/i.test(error.message),
    );
  });

  it("keeps a gateway failure uncertain because the create request may have been accepted", async () => {
    const adapter = new SeedreamImageAdapter({
      apiKey: "secret-ark-key",
      model: "doubao-seedream-test",
      fetch: async () => Response.json({ error: { message: "upstream unavailable" } }, { status: 502 }),
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "竖屏画面", ratio: "9:16" }),
      (error: unknown) => error instanceof Error
        && !(error instanceof ProviderRequestRejectedError)
        && /upstream unavailable/i.test(error.message),
    );
  });
});
