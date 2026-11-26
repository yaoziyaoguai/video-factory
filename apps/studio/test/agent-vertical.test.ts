import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent, type OfflineAgentAssembly } from "../src/server/agent/offline.js";

// 纵向路径：真实 HTTP + SQLite + Pi SDK 1.4.0；Faux 只替换模型响应。
// 覆盖 A-01（对话可聊任意话题）、A-02/A-03（排队/执行/完成）、A-04（整批交付）、
// A-08（SSE 暂态+持久事件）、A-13（发送幂等重放）的核心路径。

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe("agent vertical (HTTP + SQLite + Pi Faux)", () => {
  let assembly: OfflineAgentAssembly;
  let baseUrl: string;
  let directory: string;
  const headers = {
    "content-type": "application/json",
    origin: "",
    "x-video-factory-request": "studio",
  };

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vf-agent-vertical-"));
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    headers.origin = baseUrl;
    assembly = await assembleOfflineAgent({ dataDir: directory, uiOrigin: baseUrl });
    await assembly.app.listen({ port, host: "127.0.0.1" });
  });

  after(async () => {
    await assembly.close();
    await rm(directory, { recursive: true, force: true });
  });

  type JsonFetchResult = { status: number; body: any };
  const json = async (method: string, url: string, body?: unknown, extra?: Record<string, string>): Promise<JsonFetchResult> => {
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const waitFor = async (check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(false, "condition not met before timeout");
  };

  it("bootstrap 暴露离线模型与技能，不出现真实供应商", async () => {
    const result = await json("GET", "/api/agent/v1/bootstrap");
    assert.equal(result.status, 200);
    assert.equal(result.body.models.length, 1);
    assert.equal(result.body.models[0].availability, "configured");
    assert.ok(result.body.models[0].verificationNote.includes("离线"));
    assert.ok(result.body.skills.some((skill: { id: string }) => skill.id === "travel-prompt-kit"));
    assert.equal(result.body.ownerId, "local-owner");
  });

  it("创建会话、发送普通聊天并等待完成（A-01/A-02/A-03）", async () => {
    assembly.faux?.setResponses([fauxAssistantMessage("当然可以，先聊聊你的想法。")]);
    const created = await json("POST", "/api/agent/v1/conversations", { commandId: "cmd-create-1", title: "闲聊与创作" });
    assert.equal(created.status, 201);
    const conversationId = created.body.id;

    const sent = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-1", text: "今天天气怎么样？", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.state, "queued");
    const requestId = sent.body.requestId;

    await waitFor(async () => {
      const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant");
      return Boolean(assistant && assistant.state === "completed" && assistant.text.includes("先聊聊"));
    });

    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    assert.equal(snapshot.body.activeRequestId, null);
    const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant");
    assert.equal(assistant.requestId, requestId);
    assert.deepEqual(assistant.references, { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] });
  });

  it("第二次请求触发整批交付：产物、引用、事件、新输出提示（A-04/A-08）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;

    assembly.faux?.setResponses([
      fauxAssistantMessage([
        fauxToolCall("deliver_artifacts", {
          items: [{
            mode: "create", title: "旅行开场 Prompt", kind: "prompt",
            content: { format: "markdown", text: "# 旅行开场\n\n- 镜头：清晨的巷口\n- 口播：这条路往海的方向" },
          }],
        }),
      ]),
      fauxAssistantMessage("已交付《旅行开场 Prompt》，看看要不要调整。"),
    ]);

    // 发送前的快照游标：回合（含交付）的全部业务事件必然落在它之后。
    // 发送后再取会与执行竞态——Faux 回合极快，交付事件可能先于快照落库而被游标跳过。
    const preRunSnapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const preRunCursor = preRunSnapshot.body.eventCursor;

    const sent = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-2", text: "帮我写一个旅行视频的开场 Prompt", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(sent.status, 202);
    deliveryRequestId = sent.body.requestId;

    await waitFor(async () => {
      const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
      return snapshot.body.artifacts.items.length === 1;
    });

    const snapshot = await json("GET", `/api/agent/v1/conversations/${conversationId}/snapshot`);
    const artifact = snapshot.body.artifacts.items[0];
    assert.equal(artifact.kind, "prompt");
    assert.equal(artifact.revisionNumber, 1);

    const assistant = snapshot.body.messages.items.find((item: any) => item.role === "assistant" && item.text.includes("已交付"));
    assert.ok(assistant, "assistant 交付说明已落库");
    assert.equal(assistant.references.artifacts.length, 1);
    assert.equal(assistant.references.artifacts[0].revisionId, artifact.revisionId);

    const revision = await json("GET", `/api/agent/v1/artifacts/${artifact.id}/revisions/${artifact.revisionId}`);
    assert.equal(revision.status, 200);
    assert.ok(revision.body.content.text.includes("旅行开场"));

    const events = await collectEvents(conversationId, preRunCursor);
    assert.ok(events.some((event: any) => event.kind === "artifact.delivered" && event.notification === "new_output"));
    assert.ok(events.some((event: any) => event.kind === "message.changed"));
  });

  it("同一 commandId 重放返回原回执且不产生新消息（A-13）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;
    const before = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`, undefined);

    const replay = await json("POST", `/api/agent/v1/conversations/${conversationId}/messages`, {
      commandId: "cmd-send-2", text: "帮我写一个旅行视频的开场 Prompt", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.requestId, deliveryRequestId);

    const after = await json("GET", `/api/agent/v1/conversations/${conversationId}/messages`, undefined);
    assert.equal(after.body.items.length, before.body.items.length);
  });

  it("缺少 Origin 或安全头的变更请求被拒绝（A-16 边界）", async () => {
    const listed = await json("GET", "/api/agent/v1/conversations");
    const conversationId = listed.body.items[0].id;
    const payload = { commandId: "cmd-origin-1", text: "hi", target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null };

    const noOrigin = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-video-factory-request": "studio" }, body: JSON.stringify(payload),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await noOrigin.json()).code, "FORBIDDEN");

    const noHeader = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", origin: baseUrl }, body: JSON.stringify(payload),
    });
    assert.equal(noHeader.status, 403);
  });

  let deliveryRequestId = "";

  async function collectEvents(conversationId: string, cursor: string): Promise<any[]> {
    const response = await fetch(`${baseUrl}/api/agent/v1/conversations/${conversationId}/events?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: any[] = [];
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && events.length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const dataLine = block.split("\n").find(line => line.startsWith("data: "));
        if (dataLine && block.includes("event: business")) events.push(JSON.parse(dataLine.slice(6)));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
    }
    await reader.cancel();
    return events;
  }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildLocalRuntime } from "./helpers/native-render.js";
import { finalVideoTarget, seedConfirmedWork } from "./helpers/creative-work-fixture.js";
import { admitLocalIntent } from "./helpers/tool-args.js";
import type { InputRef, ProductionIntent, RenderInputParameters } from "../src/shared/agent/generated/contracts.js";
import { probeVideoFile } from "../src/server/agent/media-probe.js";
import { resolveRenderCanvas } from "../src/server/agent/render-inputs.js";
import { validatorFor } from "../src/server/agent/validate.js";

const mediaCommand = promisify(execFile);

it("ISS-05 / CAP-01：四种真实合成在 720p 与 1080p 竖屏输出，三种画幅策略及静帧运动通过解码验证", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "frame-native-canvas-"));
  const runtime = await buildLocalRuntime(dir);
  try {
    const scope = { ownerId: "local-owner", conversationId: runtime.service.createConversation("local-owner", { commandId: "portrait", title: "竖屏审片" }).conversation.id };
    const work = seedConfirmedWork(runtime.database, "2026-10-28T00:00:00.000Z", scope);
    const media = async (name: string, mime: string, ms: number | null, args: string[]): Promise<InputRef> => {
      const file = path.join(dir, name);
      await mediaCommand("ffmpeg", ["-v", "error", "-y", ...args, file]);
      const blob = await runtime.production!.blobs.persistFromFileAsync(scope.ownerId, scope.conversationId, file, mime, ms);
      return { kind: "blob", blobId: blob.id, digest: blob.digest };
    };
    const visual = await media("portrait.mp4", "video/mp4", 600, ["-f", "lavfi", "-i", "color=c=red:s=720x1280:r=30:d=0.6", "-c:v", "libx264", "-preset", "ultrafast"]);
    const voice = await media("voice.mp3", "audio/mpeg", 350, ["-f", "lavfi", "-i", "sine=frequency=660:duration=0.32", "-c:a", "libmp3lame"]);
    const session = async (parameters: RenderInputParameters, inputs: [InputRef, ...InputRef[]]) => {
      const intent: ProductionIntent = { workId: work.workId, title: parameters.assembly, scope: "多画幅成片", purpose: "production",
        inputSources: [], reviewInputs: [work.reviewInput], outputTarget: finalVideoTarget(),
        operations: [{ kind: "render", model: null, operationId: "render", outputSlot: "final", maxCreateAttempts: 1, inputs, parameters }],
        finalOutput: { operationId: "render", outputSlot: "final" }, maxSpend: { currency: "CNY", amountMinor: 0 } };
      const start = performance.now();
      const { run: admitted } = await admitLocalIntent(runtime, scope, intent);
      for (let i = 0; i < 8 && runtime.service.getRun(scope.ownerId, admitted.id).state !== "succeeded"; i++) await runtime.worker!.pollOnce();
      const run = runtime.service.getRun(scope.ownerId, admitted.id);
      assert.equal(run.state, "succeeded", JSON.stringify(run.operations));
      const ref = run.outputRevisions.at(-1)!;
      const revision = runtime.service.readRevision(scope.ownerId, ref.artifactId, ref.revisionId);
      assert.ok(revision.content.format === "media");
      const file = runtime.service.readBlob(scope.ownerId, revision.content.blobId).path;
      return { file, ms: performance.now() - start, facts: await probeVideoFile(file) };
    };
    const pixels = async (file: string, time: number, filter: string) => (await mediaCommand("ffmpeg",
      ["-v", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
      { encoding: "buffer", maxBuffer: 256 * 1024 })).stdout;
    for (const [width, height] of [[720, 1280], [1080, 1920]] as const) {
      const canvas = { width, height, fps: 30 as const, format: "mp4" as const };
      const segments = [{ kind: "video" as const, inputSlot: 0, startMs: 0, durationMs: 600 }] as const;
      for (const [parameters, inputs] of [
        [{ ...canvas, assembly: "ordered_concat" }, [visual]],
        [{ ...canvas, assembly: "narrated_concat", videoInputSlots: [0], narrationInputSlot: 1, durationPolicy: "preserve_all" }, [visual, voice]],
        [{ ...canvas, assembly: "timed_narrated_concat", segments: [...segments], narrationInputSlot: 1 }, [visual, voice]],
        [{ ...canvas, assembly: "mixed_concat", segments: [...segments], segmentIds: ["segment-portrait"] }, [visual]],
      ] satisfies [RenderInputParameters, [InputRef, ...InputRef[]]][]) {
        const { file, facts } = await session(parameters, inputs);
        assert.deepEqual([facts.width, facts.height, facts.nominalFrameRate], [width, height, 30]);
        for (const corner of ["0:0", "iw-4:ih-4"]) assert.ok((await pixels(file, 0.2, `crop=4:4:${corner},scale=1:1`))[0]! > 180, "同画幅边角出现黑边");
        console.log(JSON.stringify({ native: parameters.assembly, width, height, fps: facts.nominalFrameRate }));
      }
    }
    const inherited = await session({ format: "mp4", assembly: "ordered_concat", fps: 25 }, [visual]);
    assert.deepEqual([inherited.facts.width, inherited.facts.height, inherited.facts.nominalFrameRate], [720, 1280, 25]);
    const landscape = await media("land.mp4", "video/mp4", 10000, ["-stream_loop", "-1", "-i", process.env.FRAME_BENCH_LANDSCAPE_VIDEO ?? path.resolve("src/client/agent/preview/assets/coffee-preview.mp4"), "-t", "10", "-an", "-vf", "scale=640:360", "-c:v", "libx264", "-preset", "ultrafast"]);
    const tall = await media("tall.mp4", "video/mp4", 10000, ["-stream_loop", "-1", "-i", process.env.FRAME_BENCH_GENERATED_VIDEO ?? path.resolve("src/client/agent/preview/assets/trail-preview-silent.mp4"), "-t", "10", "-vf", "scale=360:640:force_original_aspect_ratio=increase,crop=360:640", "-c:v", "libx264", "-preset", "ultrafast"]);
    const imagePath = path.resolve("src/client/agent/preview/assets/coffee-detail.png");
    const imageBlob = await runtime.production!.blobs.persistFromFileAsync(scope.ownerId, scope.conversationId, imagePath, "image/png", null);
    const still: InputRef = { kind: "blob", blobId: imageBlob.id, digest: imageBlob.digest };
    for (const kenBurns of ["none", "zoom_in", "zoom_out", "pan"] as const) {
      const output = await session({ assembly: "mixed_concat", format: "mp4", width: 720, height: 720, fps: 60,
        segments: [{ kind: "image", inputSlot: 0, durationMs: 650, fitMode: "cover_crop", kenBurns }], segmentIds: ["photo"] }, [still]);
      const first = await pixels(output.file, 0.05, "scale=32:32"), last = await pixels(output.file, 0.55, "scale=32:32");
      const meanChange = first.reduce((sum, value, i) => sum + Math.abs(value - last[i]!), 0) / first.length;
      assert.ok(kenBurns === "none" ? meanChange < 1 : meanChange > 2, `${kenBurns}: ${meanChange}`);
      console.log(JSON.stringify({ kenBurns, meanChange, fps: output.facts.nominalFrameRate }));
    }
    const mixed = await session({ assembly: "mixed_concat", format: "mp4", width: 1080, height: 1920, fps: 30,
      segments: [{ kind: "video", inputSlot: 0, startMs: 0, durationMs: 10000, fitMode: "blur_backdrop" },
        { kind: "video", inputSlot: 1, startMs: 0, durationMs: 10000, fitMode: "cover_crop" },
        { kind: "image", inputSlot: 2, durationMs: 10000, fitMode: "contain_pad", kenBurns: "zoom_in" }],
      segmentIds: ["wide", "tall", "still"] }, [landscape, tall, still]);
    assert.deepEqual([mixed.facts.width, mixed.facts.height, mixed.facts.nominalFrameRate], [1080, 1920, 30]);
    const probe = JSON.parse((await mediaCommand("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", mixed.file])).stdout) as { streams: { codec_type: string; start_time: string; duration: string }[] };
    const lengths = probe.streams.map(s => Number(s.start_time) + Number(s.duration));
    assert.equal(lengths.length, 2);
    const driftMs = Math.abs(lengths[0]! - lengths[1]!) * 1000;
    assert.ok((await pixels(mixed.file, 2, "crop=32:32:32:32,scale=1:1")).some(v => v > 8), "模糊底图边缘须有真实画面");
    assert.notDeepEqual(await pixels(mixed.file, 21, "scale=64:96"), await pixels(mixed.file, 28, "scale=64:96"), "静帧须有移动");
    console.log(JSON.stringify({ mixed30sMs: mixed.ms, durationMs: mixed.facts.durationMs, driftMs }));
    assert.equal(mixed.facts.durationMs, 30_000);
    assert.ok(driftMs < 40); assert.ok(mixed.ms < 25000, `实际受理至落库 ${mixed.ms}ms`);
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }); }
});

it("CAP-01：所有画幅与帧率、成对尺寸、冻结形状与片段适配边界", () => {
  for (const [width, height] of [[1280,720],[1920,1080],[720,1280],[1080,1920],[720,720],[1080,1080],[960,720],[1440,1080],[720,960],[1080,1440]]) {
    for (const fps of [24, 25, 30, 60] as const) {
      const p = { format: "mp4" as const, assembly: "ordered_concat" as const, width: width!, height: height!, fps };
      assert.equal(validatorFor("RenderParameters")(p).ok, true);
      assert.deepEqual(resolveRenderCanvas(p, [{ kind: "text", text: "unused" }], [], new Map(), new Map()), {width, height, fps});
    }
  }
  const sources = [{ kind: "blob" as const, blobId: "camera", digest: "a".repeat(64) }];
  const facts = [{ kind: "blob" as const, blobId: "camera", mimeType: "video/mp4" }];
  const oriented = { ok: true as const, kind: "video" as const, width: 1920, height: 1080, displayWidth: 1080, displayHeight: 1920, durationMs: 2000, videoDurationMs: 2000, hasAudio: false };
  assert.deepEqual(resolveRenderCanvas({ format: "mp4", assembly: "ordered_concat" }, sources as [typeof sources[number]], facts, new Map(), new Map(), new Map([["camera", oriented]])),
    { width: 1080, height: 1920, fps: 24 });
  assert.throws(() => resolveRenderCanvas({ format: "mp4", assembly: "ordered_concat", visualStyles: [{ inputSlot: 1, fitMode: "cover_crop" }] }, sources as [typeof sources[number]], facts, new Map(), new Map()), /视觉输入槽/);
  assert.equal(validatorFor("RenderInputParameters")({format:"mp4", assembly:"ordered_concat", width:720}).ok, false);
  assert.equal(validatorFor("RenderParameters")({format:"mp4", assembly:"ordered_concat"}).ok, false);
});
