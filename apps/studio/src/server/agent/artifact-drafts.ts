import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ArtifactDraft, ArtifactDraftItem } from "../../shared/agent/generated/contracts.js";
import { newAgentId } from "./util.js";

interface DraftStream {
  id: string;
  toolCallId: string;
  raw: string;
  items: ArtifactDraftItem[];
  timer?: ReturnType<typeof setTimeout>;
}

// 每个产品请求一个实例；定时器只捕获这个请求，不能把旧稿送到下一回合。
export class ArtifactDraftStream {
  private sequence = 0;
  private closed = false;
  private readonly blocks = new Map<number, DraftStream>();
  private readonly open = new Set<DraftStream>();

  constructor(private readonly requestId: string, private readonly emit: (draft: ArtifactDraft) => void) {}

  accept(event: AgentSessionEvent): void {
    if (this.closed) return;
    if (event.type === "message_start" && event.message.role === "assistant") this.blocks.clear();
    if (event.type === "tool_execution_end" && event.toolName === "deliver_artifacts") {
      for (const stream of this.open) if (stream.toolCallId === event.toolCallId) this.clear(stream);
    }
    if (event.type !== "message_update") return;
    const update = event.assistantMessageEvent;
    if (update.type !== "toolcall_start" && update.type !== "toolcall_delta" && update.type !== "toolcall_end") return;
    const block = update.partial.content[update.contentIndex];
    if (block?.type !== "toolCall" || block.name !== "deliver_artifacts") return;
    let stream = this.blocks.get(update.contentIndex);
    if (!stream) {
      stream = { id: newAgentId("drf"), toolCallId: block.id, raw: "", items: [] };
      this.blocks.set(update.contentIndex, stream);
      this.open.add(stream);
    }
    stream.toolCallId = block.id;
    if (update.type === "toolcall_delta") stream.raw += update.delta;
    // Faux 的 partial.arguments 到 end 才填充；采用 SDK 自己的增量 JSON 解析。
    // 仅用于显示，执行工具仍只用完整参数和既有事务校验。
    const args = update.type === "toolcall_end" ? update.toolCall.arguments
      : Object.keys(block.arguments).length ? block.arguments : parseStreamingJson(stream.raw);
    stream.items = projectDraftItems(args);
    if (update.type === "toolcall_end") {
      clearTimeout(stream.timer); delete stream.timer;
      this.snapshot(stream, "streaming");
    } else if (!stream.timer) {
      stream.timer = setTimeout(() => {
        delete stream.timer;
        if (!this.closed && this.open.has(stream)) this.snapshot(stream, "streaming");
      }, 200);
    }
  }

  close(): void {
    this.closed = true;
    for (const stream of this.open) this.clear(stream);
    this.blocks.clear();
  }

  private clear(stream: DraftStream): void {
    clearTimeout(stream.timer);
    this.open.delete(stream);
    this.snapshot(stream, "cleared");
  }

  private snapshot(stream: DraftStream, state: ArtifactDraft["state"]): void {
    this.emit({ requestId: this.requestId, messageId: `msg-${this.requestId.slice(4)}`,
      draftId: stream.id, sequence: this.sequence++, state, items: state === "cleared" ? [] : stream.items });
  }
}

// 展示用的宽松全文：与 shared/agent/markdown.ts 的 markdownFullText 同一拼接形态，
// 但容错半成品流式 JSON（title/text 未到位的段落跳过，不抛错）。
function draftFullText(content: Record<string, unknown>): string {
  const parts: string[] = [];
  const intro = typeof content.text === "string" ? content.text : "";
  if (intro.trim()) parts.push(intro);
  if (Array.isArray(content.sections)) {
    for (const entry of content.sections) {
      if (!entry || typeof entry !== "object") continue;
      const section = entry as Record<string, unknown>;
      if (typeof section.title !== "string" || typeof section.text !== "string") continue;
      parts.push(`## ${section.title}\n\n${section.text}`);
    }
  }
  if (typeof content.narrationText === "string") parts.push(`## 旁白原文\n\n${content.narrationText}`);
  return parts.join("\n\n").slice(0, 128_000);
}

export function projectDraftItems(args: unknown): ArtifactDraftItem[] {
  if (!args || typeof args !== "object" || !("items" in args) || !Array.isArray(args.items)) return [];
  return args.items.slice(0, 8).map((entry: unknown, itemIndex): ArtifactDraftItem => {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const content = item.content && typeof item.content === "object" ? item.content as Record<string, unknown> : {};
    return { itemIndex, title: typeof item.title === "string" ? item.title.slice(0, 120) : null,
      kind: item.kind === "prompt" || item.kind === "script" || item.kind === "analysis" ? item.kind : null,
      text: draftFullText(content) };
  });
}
