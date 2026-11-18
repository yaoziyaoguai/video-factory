import { channel } from "node:diagnostics_channel";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export const turnDiagnostics = channel("frame.agent.turn");

type NativeTiming = { offsetMs: number } & (
  | { event: "turn_start" | "turn_end" | "assistant_start" | "assistant_first_text_delta" }
  | { event: "assistant_end"; sdkDurationMs: number | null; stopReason: string }
  | { event: "tool_execution_start" | "tool_execution_end"; ordinal: number; label?: string; sdkDurationMs?: number | null; failed?: boolean }
  | { event: "compaction_start" | "compaction_end"; reason: string; outcome?: "completed" | "failed" | "stopped"; willRetry?: boolean }
);

export interface TurnDiagnostic {
  requestId: string;
  messageId: string;
  epoch: number;
  acceptedAt: string;
  claimedAt: string;
  finalizedAt: string;
  queueMs: number;
  outcome: "completed" | "failed" | "stopped";
  abortReason: string | null;
  promptStartedAt: string | null;
  turnElapsedMs: number | null;
  native: NativeTiming[];
}

// 收集的是 Pi 事件的到达时间和原生 duration，队列和终态则用持久化时钟。
// 不保留文本、工具参数或结果。无订阅时不收集；不增加 SSE 事件或持久化状态。
export class NativeTurnTiming {
  private promptStart: number | null = null;
  promptStartedAt: string | null = null;
  readonly native: NativeTiming[] = [];
  private textObserved = false;
  private nextTool = 0;
  private readonly tools = new Map<string, number>();

  startPrompt(at: number): void {
    this.promptStart = at;
    this.promptStartedAt = new Date().toISOString();
  }

  observe(event: AgentSessionEvent, toolLabel?: string): void {
    if (this.promptStart === null) return;
    const offsetMs = Math.round(performance.now() - this.promptStart);
    switch (event.type) {
      case "turn_start":
      case "turn_end":
        this.native.push({ event: event.type, offsetMs });
        break;
      case "compaction_start":
        this.native.push({ event: event.type, offsetMs, reason: event.reason });
        break;
      case "compaction_end":
        this.native.push({ event: event.type, offsetMs, reason: event.reason, willRetry: event.willRetry,
          outcome: event.aborted ? "stopped" : event.result ? "completed" : "failed" });
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.textObserved = false;
          this.native.push({ event: "assistant_start", offsetMs });
        }
        break;
      case "message_update":
        if (!this.textObserved && event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) {
          this.textObserved = true;
          this.native.push({ event: "assistant_first_text_delta", offsetMs });
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          this.native.push({ event: "assistant_end", offsetMs, sdkDurationMs: event.message.durationMs ?? null, stopReason: event.message.stopReason });
        }
        break;
      case "tool_execution_start":
      case "tool_execution_end": {
        const ordinal = this.tools.get(event.toolCallId) ?? ++this.nextTool;
        if (event.type === "tool_execution_start") this.tools.set(event.toolCallId, ordinal);
        else this.tools.delete(event.toolCallId);
        this.native.push({ event: event.type, offsetMs, ordinal, ...(toolLabel ? { label: toolLabel } : {}),
          ...(event.type === "tool_execution_end" ? { sdkDurationMs: event.durationMs ?? null, failed: event.isError } : {}) });
        break;
      }
    }
  }
}
