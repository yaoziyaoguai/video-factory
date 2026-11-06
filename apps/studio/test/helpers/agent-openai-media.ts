import type { RealtimeTransport, RealtimeTransportFactory } from "../../src/server/agent/openai-speech.js";

// OpenAI Realtime 配音通道的本地进程内替身：不走网络，按已验证 wire 序列与端口对演，
// 记录客户端发出的全部事件供 payload 断言。音频字节是 PCM16/24kHz/mono 静音，由端口自身经
// 真实 FFmpeg 转 MP3 后再探测验收，不以替身声明供应商通过。

export type FakeRealtimeMode =
  | "completed"            // 正常完成（转写逐字回显）
  | "transcriptMismatch"   // 完成但转写多读一句 → 内容未通过
  | "incomplete"           // response.done status=incomplete
  | "serverError"          // 会话内 error 事件
  | "closeMidResponse"     // 部分音频后连接关闭
  | "hang"                 // 首个音频分片后不再有事件
  | "handshake401"         // 握手期 401
  | "waitCancel"           // 首个音频分片后停住，只对 response.cancel 回 done(cancelled)
  | "connectFail"          // 连接从未建立：onError("连接错误", null)，无 session.created、零发送
  | "closeBeforeAny";      // 未收到任何服务端事件连接即关闭：onClose 立即触发、零发送

export interface FakeRealtimeOptions {
  mode?: FakeRealtimeMode;
  audioSeconds?: number;
  toneHz?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface FakeRealtimeSession {
  url: string;
  authorization: string;
  sent: Record<string, unknown>[];
  itemText: string | null;
  cancelled: boolean;
}

const DEFAULT_USAGE = { input_tokens: 55, output_tokens: 176 };

/** PCM16/24kHz/mono 正弦音（默认 440Hz，幅值约 0.3）：既可探测时长，也可用带通音量证明进入成片。 */
export function tonePcm(seconds: number, frequencyHz = 440): Buffer {
  const samples = Math.round(seconds * 24_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequencyHz * index) / 24_000) * 9_600), index * 2);
  }
  return pcm;
}

export class FakeRealtimeHub {
  readonly sessions: FakeRealtimeSession[] = [];
  private readonly options: Required<Pick<FakeRealtimeOptions, "mode" | "audioSeconds">> & FakeRealtimeOptions;

  constructor(options: FakeRealtimeOptions = {}) {
    this.options = { mode: "completed", audioSeconds: 1, toneHz: 440, ...options, usage: options.usage ?? DEFAULT_USAGE };
  }

  readonly factory: RealtimeTransportFactory = (url, authorization) => {
    const session: FakeRealtimeSession = { url, authorization, sent: [], itemText: null, cancelled: false };
    this.sessions.push(session);
    const messageListeners: ((text: string) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let closed = false;
    const emit = (event: Record<string, unknown>): void => {
      if (closed) return;
      for (const listener of messageListeners) listener(JSON.stringify(event));
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      for (const listener of closeListeners) listener();
    };
    const schedule = (fn: () => void): void => { setTimeout(() => { if (!closed) fn(); }, 0); };
    return {
      send: text => {
        if (closed) return;
        const event = JSON.parse(text) as Record<string, unknown>;
        session.sent.push(event);
        switch (event.type) {
          case "session.update":
            schedule(() => emit({ type: "session.updated" }));
            return;
          case "conversation.item.create": {
            const content = (event.item as { content?: { text?: unknown }[] } | undefined)?.content;
            session.itemText = typeof content?.[0]?.text === "string" ? content[0].text : null;
            return;
          }
          case "response.create": {
            const pcm = tonePcm(this.options.audioSeconds!, this.options.toneHz);
            const chunks = Math.ceil(pcm.length / 24_000);
            const transcript = session.itemText ?? "";
            const mismatch = this.options.mode === "transcriptMismatch";
            if (this.options.mode === "serverError") {
              schedule(() => emit({ type: "error", error: { type: "server_error_simulation" } }));
              return;
            }
            if (this.options.mode === "handshake401") return;
            for (let index = 0; index < chunks; index++) {
              const slice = pcm.subarray(index * 24_000, (index + 1) * 24_000);
              schedule(() => emit({ type: "response.output_audio.delta", delta: slice.toString("base64") }));
            }
            if (this.options.mode === "hang" || this.options.mode === "waitCancel") return;
            if (this.options.mode === "closeMidResponse") {
              schedule(close);
              return;
            }
            schedule(() => emit({ type: "response.output_audio_transcript.delta", delta: mismatch ? `${transcript}还有一句。` : transcript }));
            schedule(() => emit({
              type: "response.done",
              response: {
                status: this.options.mode === "incomplete" ? "incomplete" : "completed",
                usage: this.options.usage,
              },
            }));
            return;
          }
          case "response.cancel":
            session.cancelled = true;
            schedule(() => emit({ type: "response.done", response: { status: "cancelled", usage: this.options.usage } }));
            return;
          default:
            return;
        }
      },
      close: () => { closed = true; },
      terminate: () => { closed = true; },
      onMessage: listener => {
        messageListeners.push(listener);
        const silent = this.options.mode === "handshake401" || this.options.mode === "connectFail" || this.options.mode === "closeBeforeAny";
        if (!silent) schedule(() => emit({ type: "session.created" }));
        if (this.options.mode === "closeBeforeAny") schedule(close);
      },
      onError: listener => {
        if (this.options.mode === "handshake401") schedule(() => listener("HTTP 401", 401));
        if (this.options.mode === "connectFail") schedule(() => listener("连接错误", null));
      },
      onClose: listener => { closeListeners.push(listener); },
    };
  };
}
