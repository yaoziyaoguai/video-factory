import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MiniMaxVideoAdapter, SeedanceVideoAdapter, WanVideoAdapter } from "../src/index.js";

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
      model: "test-wan-model",
      workspaceId: "workspace-1",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({ prompt: "雨夜窗边的热茶", durationSeconds: 6, ratio: "9:16" });

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
      model: "test-wan-model",
      input: { prompt: "雨夜窗边的热茶" },
      parameters: {
        resolution: "720P",
        ratio: "9:16",
        duration: 6,
        prompt_extend: true,
        watermark: false,
      },
    });
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
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return responses.shift()!;
      },
      sleep: async () => undefined,
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    const result = await adapter.generate({ prompt: "雨夜里的霓虹街道", durationSeconds: 8, ratio: "9:16" });

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

  it("marks a polling timeout as failed", async () => {
    const progress: string[] = [];
    const adapter = new WanVideoAdapter({
      apiKey: "test-key",
      model: "test-wan-model",
      workspaceId: "workspace-1",
      fetch: async (url) => String(url).includes("video-synthesis")
        ? jsonResponse({ output: { task_id: "wan-task-timeout" } })
        : jsonResponse({ output: { task_status: "RUNNING" } }),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 2)),
      pollIntervalMs: 0,
      timeoutMs: 1,
    });

    await assert.rejects(
      () => adapter.generate(
        { prompt: "测试超时状态", durationSeconds: 5, ratio: "9:16" },
        (event) => { progress.push(event.status); },
      ),
      /timed out/,
    );
    assert.equal(progress.at(-1), "failed");
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
