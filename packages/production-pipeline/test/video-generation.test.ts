import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MiniMaxVideoAdapter, SeedanceVideoAdapter, WanVideoAdapter } from "../src/index.js";
import type { VideoGenerationAdapter } from "../src/index.js";

describe("metered video generation adapters", () => {
  it("normalizes the Seedance asynchronous task lifecycle", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ id: "seedance-task-1" }),
      jsonResponse({ id: "seedance-task-1", status: "running" }),
      jsonResponse({
        id: "seedance-task-1",
        status: "succeeded",
        content: { video_url: "https://example.com/seedance.mp4" },
      }),
    ];
    const adapter = new SeedanceVideoAdapter({
      apiKey: "test-key",
      model: "test-seedance-model",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({ prompt: "安静的夜班地铁", durationSeconds: 5, ratio: "9:16" });

    assert.deepEqual(result, {
      providerId: "seedance-video-v1",
      taskId: "seedance-task-1",
      videoUrl: "https://example.com/seedance.mp4",
    });
    assert.equal(requests[0]?.url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
    assert.equal(requests[1]?.url, "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance-task-1");
    assert.match(String(requests[0]?.init?.headers && JSON.stringify(requests[0].init.headers)), /Bearer test-key/);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: "test-seedance-model",
      content: [{ type: "text", text: "安静的夜班地铁" }],
      ratio: "9:16",
      duration: 5,
      watermark: false,
      generate_audio: false,
    });
  });

  it("continues a Seedance task by taskId without submitting a second create request", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = new SeedanceVideoAdapter({
      apiKey: "test-key",
      model: "test-seedance-model",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          id: "seedance-task-existing",
          status: "succeeded",
          content: { video_url: "https://example.com/existing.mp4" },
        });
      },
      sleep: async () => undefined,
    });

    const result = await adapter.reconcile!(
      "seedance-task-existing",
      { prompt: "原请求", durationSeconds: 5, ratio: "9:16" },
    );

    assert.equal(result.taskId, "seedance-task-existing");
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance-task-existing",
    );
    assert.equal(requests[0]?.init?.method, undefined);
  });

  it("selects an allowlisted Seedance model per request and sends bounded quality parameters", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const adapter = new SeedanceVideoAdapter({
      apiKey: "test-key",
      model: "seedance-default",
      allowedModels: ["seedance-default", "seedance-2.5"],
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return requests.length === 1
          ? jsonResponse({ id: "seedance-task-model" })
          : jsonResponse({ id: "seedance-task-model", status: "succeeded", content: { video_url: "https://example.com/model.mp4" } });
      },
      sleep: async () => undefined,
    });

    await adapter.generate({
      prompt: "受控样片",
      durationSeconds: 4,
      ratio: "9:16",
      modelId: "seedance-2.5",
      resolution: "480p",
      generateAudio: false,
    });

    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: "seedance-2.5",
      content: [{ type: "text", text: "受控样片" }],
      ratio: "9:16",
      duration: 4,
      watermark: false,
      generate_audio: false,
      resolution: "480p",
    });
    await assert.rejects(() => adapter.generate({
      prompt: "越权模型",
      durationSeconds: 4,
      ratio: "9:16",
      modelId: "unknown-model",
    }), /not allowed/);
  });

  it("normalizes the Wan asynchronous task lifecycle", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ output: { task_id: "wan-task-1", task_status: "PENDING" } }),
      jsonResponse({ output: { task_id: "wan-task-1", task_status: "RUNNING" } }),
      jsonResponse({
        output: {
          task_id: "wan-task-1",
          task_status: "SUCCEEDED",
          video_url: "https://example.com/wan.mp4",
        },
      }),
    ];
    const adapter = new WanVideoAdapter({
      apiKey: "test-key",
      model: "wan2.7-t2v",
      allowedModels: ["wan2.7-t2v", "wan3.0-video"],
      workspaceId: "workspace-1",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({ prompt: "雨夜窗边的热茶", durationSeconds: 6, ratio: "9:16", modelId: "wan3.0-video" });

    assert.deepEqual(result, {
      providerId: "wan-video-v1",
      taskId: "wan-task-1",
      videoUrl: "https://example.com/wan.mp4",
    });
    assert.equal(
      requests[0]?.url,
      "https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    assert.equal(
      requests[1]?.url,
      "https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/tasks/wan-task-1",
    );
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: "wan3.0-video",
      input: { prompt: "雨夜窗边的热茶" },
      parameters: {
        resolution: "720P",
        ratio: "9:16",
        duration: 6,
        watermark: false,
      },
    });
    await assert.rejects(() => adapter.generate({
      prompt: "不受支持的模型",
      durationSeconds: 6,
      ratio: "9:16",
      modelId: "wan2.7-i2v",
    }), /not allowed/);
  });

  it("continues a Wan task by taskId without submitting a second create request", async () => {
    const requests: string[] = [];
    const adapter = new WanVideoAdapter({
      apiKey: "test-key",
      model: "wan3.0-video",
      workspaceId: "workspace-1",
      fetch: async (url) => {
        requests.push(String(url));
        return jsonResponse({ output: {
          task_id: "wan-existing",
          task_status: "SUCCEEDED",
          video_url: "https://example.com/wan-existing.mp4",
        } });
      },
      sleep: async () => undefined,
    });

    const result = await adapter.reconcile!(
      "wan-existing",
      { prompt: "原请求", durationSeconds: 6, ratio: "9:16" },
    );

    assert.equal(result.videoUrl, "https://example.com/wan-existing.mp4");
    assert.deepEqual(requests, ["https://workspace-1.cn-beijing.maas.aliyuncs.com/api/v1/tasks/wan-existing"]);
  });

  it("keeps prompt extension only for pre-Wan-3 models", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ output: { task_id: "wan27-task-1" } }),
      jsonResponse({ output: { task_status: "SUCCEEDED", video_url: "https://example.com/wan27.mp4" } }),
    ];
    const adapter = new WanVideoAdapter({
      apiKey: "test-key",
      model: "wan2.7-t2v",
      allowedModels: ["wan2.7-t2v", "wan3.0-video"],
      workspaceId: "workspace-1",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
    });

    await adapter.generate({ prompt: "一束晨光落在书桌上", durationSeconds: 6, ratio: "9:16" });

    const body = JSON.parse(String(requests[0]?.init?.body)) as { parameters: Record<string, unknown> };
    assert.equal(body.parameters.prompt_extend, true);
  });

  it("normalizes the MiniMax task and file retrieval lifecycle", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ task_id: "minimax-task-1", base_resp: { status_code: 0, status_msg: "success" } }),
      jsonResponse({ task_id: "minimax-task-1", status: "Processing", base_resp: { status_code: 0, status_msg: "success" } }),
      jsonResponse({
        task_id: "minimax-task-1",
        status: "Success",
        file_id: "minimax-file-1",
        base_resp: { status_code: 0, status_msg: "success" },
      }),
      jsonResponse({
        file: { file_id: "minimax-file-1", download_url: "https://example.com/minimax.mp4" },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    ];
    const adapter = new MiniMaxVideoAdapter({
      apiKey: "test-key",
      model: "MiniMax-Hailuo-2.3",
      modelProtocols: { "MiniMax-Hailuo-2.3": "v1" },
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({ prompt: "雨夜里的霓虹街道", durationSeconds: 6, ratio: "9:16" });

    assert.deepEqual(result, {
      providerId: "hailuo-video-v1",
      taskId: "minimax-task-1",
      videoUrl: "https://example.com/minimax.mp4",
    });
    assert.equal(requests[0]?.url, "https://api.minimaxi.com/v1/video_generation");
    assert.equal(requests[1]?.url, "https://api.minimaxi.com/v1/query/video_generation?task_id=minimax-task-1");
    assert.equal(requests[3]?.url, "https://api.minimaxi.com/v1/files/retrieve?file_id=minimax-file-1");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: "MiniMax-Hailuo-2.3",
      prompt: "竖屏 9:16 构图。雨夜里的霓虹街道",
      duration: 6,
      resolution: "768P",
      prompt_optimizer: true,
      aigc_watermark: false,
    });
  });

  it("continues a MiniMax task by taskId without submitting a second create request", async () => {
    const requests: string[] = [];
    const responses = [
      jsonResponse({
        task_id: "minimax-existing",
        status: "Success",
        file_id: "minimax-file-existing",
        base_resp: { status_code: 0, status_msg: "success" },
      }),
      jsonResponse({
        file: { file_id: "minimax-file-existing", download_url: "https://example.com/minimax-existing.mp4" },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    ];
    const adapter = new MiniMaxVideoAdapter({
      apiKey: "test-key",
      model: "MiniMax-Hailuo-2.3",
      modelProtocols: { "MiniMax-Hailuo-2.3": "v1" },
      fetch: async (url) => {
        requests.push(String(url));
        return responses.shift()!;
      },
      sleep: async () => undefined,
    });

    const result = await adapter.reconcile!(
      "minimax-existing",
      { prompt: "原请求", durationSeconds: 6, ratio: "9:16", modelId: "MiniMax-Hailuo-2.3" },
    );

    assert.equal(result.videoUrl, "https://example.com/minimax-existing.mp4");
    assert.deepEqual(requests, [
      "https://api.minimaxi.com/v1/query/video_generation?task_id=minimax-existing",
      "https://api.minimaxi.com/v1/files/retrieve?file_id=minimax-file-existing",
    ]);
  });

  it("routes MiniMax H3 through the V2 multimodal protocol", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      jsonResponse({ task_id: "h3-task-1" }),
      jsonResponse({ task: { id: "h3-task-1", status: "running" } }),
      jsonResponse({
        task: {
          id: "h3-task-1",
          status: "succeeded",
          content: { url: "https://example.com/h3.mp4" },
        },
      }),
    ];
    const adapter = new MiniMaxVideoAdapter({
      apiKey: "test-key",
      model: "MiniMax-Hailuo-2.3",
      modelProtocols: { "MiniMax-Hailuo-2.3": "v1", "MiniMax-H3": "v2" },
      baseUrl: "https://minimax.example/v1/",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({
      prompt: "雨滴沿玻璃滑落，城市霓虹散成流动色块",
      durationSeconds: 5,
      ratio: "9:16",
      resolution: "768P",
      modelId: "MiniMax-H3",
    });

    assert.deepEqual(result, {
      providerId: "hailuo-video-v1",
      taskId: "h3-task-1",
      videoUrl: "https://example.com/h3.mp4",
    });
    assert.equal(requests[0]?.url, "https://minimax.example/v2/video_generation");
    assert.equal(requests[1]?.url, "https://minimax.example/v2/query/video_generation/h3-task-1");
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      model: "MiniMax-H3",
      content: [{ type: "text", text: "雨滴沿玻璃滑落，城市霓虹散成流动色块" }],
      resolution: "768P",
      duration: 5,
      ratio: "9:16",
      aigc_watermark: false,
    });
    await assert.rejects(() => adapter.generate({
      prompt: "未知模型",
      durationSeconds: 5,
      ratio: "9:16",
      modelId: "MiniMax-Unknown",
    }), /not allowed/);
  });

  it("surfaces MiniMax application-level errors returned with HTTP 200", async () => {
    const adapter = new MiniMaxVideoAdapter({
      apiKey: "test-key",
      model: "MiniMax-Hailuo-2.3",
      fetch: async () => jsonResponse({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }),
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "测试余额错误", durationSeconds: 6, ratio: "9:16" }),
      /insufficient balance/,
    );
  });

  it("surfaces a failed provider task and emits failed progress", async () => {
    const progress: string[] = [];
    const responses = [
      jsonResponse({ id: "seedance-task-failed" }),
      jsonResponse({ id: "seedance-task-failed", status: "failed", error: { message: "内容审核未通过" } }),
    ];
    const adapter = new SeedanceVideoAdapter({
      apiKey: "test-key",
      model: "test-seedance-model",
      fetch: async () => responses.shift()!,
      sleep: async () => undefined,
      pollIntervalMs: 0,
      timeoutMs: 100,
    });

    await assert.rejects(
      () => adapter.generate(
        { prompt: "测试失败状态", durationSeconds: 5, ratio: "9:16" },
        (event) => { progress.push(`${event.status}:${event.error ?? ""}`); },
      ),
      /内容审核未通过/,
    );
    assert.deepEqual(progress, ["submitted:", "failed:内容审核未通过"]);
  });

  it("keeps a polling timeout uncertain so the accepted task cannot be recreated", async () => {
    const timeoutOptions = { sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 2)), pollIntervalMs: 0, timeoutMs: 1 };
    const cases: Array<{ label: string; adapter: VideoGenerationAdapter }> = [{
      label: "Seedance",
      adapter: new SeedanceVideoAdapter({
        apiKey: "test-key",
        model: "test-seedance-model",
        fetch: async (_url, init) => init?.method === "POST"
          ? jsonResponse({ id: "seedance-task-timeout" })
          : jsonResponse({ status: "running" }),
        ...timeoutOptions,
      }),
    }, {
      label: "MiniMax v1",
      adapter: new MiniMaxVideoAdapter({
        apiKey: "test-key",
        model: "MiniMax-Hailuo-2.3",
        modelProtocols: { "MiniMax-Hailuo-2.3": "v1" },
        fetch: async (_url, init) => init?.method === "POST"
          ? jsonResponse({ task_id: "minimax-v1-timeout", base_resp: { status_code: 0 } })
          : jsonResponse({ status: "Processing", base_resp: { status_code: 0 } }),
        ...timeoutOptions,
      }),
    }, {
      label: "MiniMax v2",
      adapter: new MiniMaxVideoAdapter({
        apiKey: "test-key",
        model: "MiniMax-H3",
        modelProtocols: { "MiniMax-H3": "v2" },
        fetch: async (_url, init) => init?.method === "POST"
          ? jsonResponse({ task_id: "minimax-v2-timeout" })
          : jsonResponse({ task: { status: "running" } }),
        ...timeoutOptions,
      }),
    }, {
      label: "Wan",
      adapter: new WanVideoAdapter({
        apiKey: "test-key",
        model: "test-wan-model",
        workspaceId: "workspace-1",
        fetch: async (url) => String(url).includes("video-synthesis")
          ? jsonResponse({ output: { task_id: "wan-task-timeout" } })
          : jsonResponse({ output: { task_status: "RUNNING" } }),
        ...timeoutOptions,
      }),
    }];

    for (const testCase of cases) {
      const progress: string[] = [];
      await assert.rejects(
        () => testCase.adapter.generate(
          { prompt: "测试超时状态", durationSeconds: 5, ratio: "9:16" },
          (event) => { progress.push(event.status); },
        ),
        /timed out/,
      );
      assert.equal(progress.at(-1), "unknown", testCase.label);
    }
  });

  it("keeps Wan's UNKNOWN provider status queryable by its original task id", async () => {
    const progress: string[] = [];
    const responses = [
      jsonResponse({ output: { task_id: "wan-task-unknown" } }),
      jsonResponse({ output: { task_status: "UNKNOWN" } }),
    ];
    const adapter = new WanVideoAdapter({
      apiKey: "test-key",
      model: "test-wan-model",
      workspaceId: "workspace-1",
      fetch: async () => responses.shift()!,
    });

    await assert.rejects(
      () => adapter.generate(
        { prompt: "测试未知状态", durationSeconds: 5, ratio: "9:16" },
        (event) => { progress.push(event.status); },
      ),
      /UNKNOWN/,
    );
    assert.equal(progress.at(-1), "unknown");
  });

  it("surfaces non-success HTTP responses before polling", async () => {
    const adapter = new SeedanceVideoAdapter({
      apiKey: "test-key",
      model: "test-seedance-model",
      fetch: async () => jsonResponse({ error: { message: "quota exceeded" } }, 429),
    });

    await assert.rejects(
      () => adapter.generate({ prompt: "测试请求错误", durationSeconds: 5, ratio: "9:16" }),
      /quota exceeded/,
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
