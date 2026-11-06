import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assembleOfflineAgent } from "../../src/server/agent/offline.js";
import { offlineTurn } from "../../src/server/agent/offline-scenario.js";

// F7 崩溃窗口子进程：按场景预装 Faux 响应；命中指定崩溃点时输出 JSON 标记后
// 同步永久阻塞（Atomics.wait），由父进程 SIGKILL 结束——业务事务已提交、
// Pi 会话历史尚未保存工具结果，正是回执窗口。

interface RawArgs {
  scenario: string;
  crashPoint: string;
  dataDir: string;
  port: string;
}

function parseArgs(argv: readonly string[]): RawArgs {
  const values = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 2) {
    values.set(argv[index]!.replace(/^--/, ""), argv[index + 1]!);
  }
  return {
    scenario: values.get("scenario") ?? "",
    crashPoint: values.get("crash-point") ?? "",
    dataDir: values.get("data-dir") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".crash-data"),
    port: values.get("port") ?? "0",
  };
}

const args = parseArgs(process.argv);

function emit(event: string, payload: Record<string, unknown>): void {
  writeSync(1, `${JSON.stringify({ event, ...payload })}\n`);
}

function block(): never {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

const deliverStep: FauxResponseStep = () => fauxAssistantMessage([
  fauxToolCall("deliver_artifacts", {
    items: [{
      mode: "create", title: "旅行开场 Prompt", kind: "prompt",
      content: { format: "markdown", text: "# 旅行开场\n\n- 镜头：清晨的巷口" },
    }],
  }, { id: "call-deliver-1" }),
]);

const prepareStep: FauxResponseStep = (context) => {
  const artifact = offlineTurn(context.messages).frame?.artifacts[0] as { artifactId: string; headRevisionId: string; digest: string } | undefined;
  if (!artifact) throw new Error("prepare 场景缺少 artifact 上下文");
  return fauxAssistantMessage([
    fauxToolCall("prepare_production", {
      spec: {
        workId: null,
        title: "旅行开场配音",
        inputRevisions: [{ artifactId: artifact.artifactId, revisionId: artifact.headRevisionId }],
        operations: [{
          operationId: "opVoice1",
          outputSlot: "voiceTrack",
          inputs: [{ kind: "artifact_revision", artifactId: artifact.artifactId, revisionId: artifact.headRevisionId, digest: artifact.digest }],
          kind: "speech",
          model: {
            providerId: "fixture-text", modelId: "faux-speech",
            connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline",
          },
          parameters: { voiceId: "narrator-main", format: "mp3" },
        }],
        finalOutput: { operationId: "opVoice1", outputSlot: "voiceTrack" },
        maxSpend: { currency: "CNY", amountMinor: 500 },
      },
    }, { id: "call-prepare-1" }),
  ]) as AssistantMessage;
};

const responses: FauxResponseStep[] = (() => {
  switch (args.scenario) {
    case "deliver":
      return [deliverStep, () => fauxAssistantMessage("已交付开场 Prompt。")];
    case "prepare":
      return [deliverStep, () => fauxAssistantMessage("先交付草稿。"), prepareStep, () => fauxAssistantMessage("提案已准备。")];
    case "send":
      return [deliverStep, () => fauxAssistantMessage("已交付开场 Prompt。")];
    case "auto-compact": {
      const steps: FauxResponseStep[] = [deliverStep, () => fauxAssistantMessage("先保留已完成的交付，等用户阅读。".repeat(250))];
      const next: FauxResponseStep = (context, options, state, model) => {
        assembly.faux!.appendResponses([next]);
        if (!context.messages.some(message => message.role === "system" && JSON.stringify(message).includes("帧间 Frame"))) return fauxAssistantMessage("保留早先的讨论。已交付，等待下一条请求。");
        const step = steps.shift();
        if (typeof step === "function") return step(context, options, state, model);
        throw new Error("意外的额外对话调用");
      };
      return [next];
    }
    case "verify-history":
      return [ctx => fauxAssistantMessage(`history-present:${JSON.stringify(ctx.messages).includes("保留早先的讨论")}`)];
    case "verify-safe-history":
      return [ctx => fauxAssistantMessage(`safe-history:${JSON.stringify(ctx.messages).includes("保留早先的讨论") && !JSON.stringify(ctx.messages).includes("不得续接的中断回合")}`)];
    case "continue":
      return [() => fauxAssistantMessage("恢复后的新回合正常完成。")];
    default:
      throw new Error(`未知场景: ${args.scenario}`);
  }
})();

const assembly = await assembleOfflineAgent({
  dataDir: args.dataDir,
  uiOrigin: `http://127.0.0.1:${args.port}`,
  // 预装在装配期：recover() 会立刻唤醒排队请求，事后 setResponses 会输掉竞态。
  fauxResponses: responses,
  ...(args.scenario === "auto-compact" ? { fauxContextWindow: 6000, compaction: { reserveTokens: 4800, keepRecentTokens: 200 } } : {}),
  crashPoint: point => {
    if (point !== args.crashPoint) return;
    emit("crash-point", { point });
    block();
  },
});
await assembly.app.listen({ port: Number(args.port), host: "127.0.0.1" });
if (args.scenario === "auto-compact") {
  const conversations = assembly.database.prepare("SELECT id FROM conversations").all() as { id: string }[];
  for (const { id } of conversations) assembly.service.hub().subscribeContextStatus(id, status => emit("context", { ...status }));
}
const address = assembly.app.server.address();
emit("listening", { port: typeof address === "object" && address ? address.port : Number(args.port) });
