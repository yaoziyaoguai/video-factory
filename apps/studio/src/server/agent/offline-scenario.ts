import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type FauxContentBlock, type FauxResponseFactory, type JsonObject, type Message, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ArtifactRevision } from "../../shared/agent/generated/contracts.js";

// 离线默认体验的 Faux 场景表：响应永远带【离线测试回放】标识，不冒充真实模型理解。
// 可触发的测试输入只有下面三条精确句子（记录在 contracts/agent/v1/IMPORT.md）；
// 任何其他输入都返回测试边界说明，这是 ACCEPTANCE 对“输入不在替身能力范围时显示测试边界”的要求。
// 不做关键词模糊匹配，不把它当作真实 Agent 的语义能力。

export const SCENARIO_DELIVER_BATCH = "给我三个不同方向的脚本，先不要制作";
export const SCENARIO_REVISE = "保留意思，语气安静一点";
export const SCENARIO_PROPOSAL = "按这份准备制作提案，先不要开始";

const LABEL = "【离线测试回放】";
const BOUNDARY_HINT = `离线替身只回放固定场景，可触发输入：
1）新话题发送「${SCENARIO_DELIVER_BATCH}」（未绑定修改目标时交付三个独立脚本）；
2）在预览里点“提意见”绑定目标后发送「${SCENARIO_REVISE}」（生成该产物的 v2）；
3）绑定一份脚本 后发送「${SCENARIO_PROPOSAL}」（只准备模拟制作提案，等待明确确认）。
其他输入不在替身能力范围内，只返回本说明。此入口不验证真实模型的自由问答效果。`;

interface FrameContext {
  target: { artifactId: string; revisionId: string } | null;
  artifacts: { artifactId: string; title: string; kind: string; headRevisionId: string | null }[];
  deliveryClosed: boolean;
}

/** 仅消费投影末尾的系统业务帧；不扫描或清洗任何历史用户文字。 */
export function offlineTurn(messages: Message[]): { frame: FrameContext | null; userText: string; messages: Message[] } {
  const marker = "[frame-current-state]";
  const last = messages.at(-1);
  const raw = last?.role === "system" ? textOf(last.content) : "";
  let frame: FrameContext | null = null;
  if (raw.startsWith(marker)) {
    const newline = raw.indexOf("\n");
    if (newline === -1) throw new Error("[frame-current-state] 帧缺少换行分隔，离线回放装配错误。");
    frame = JSON.parse(raw.slice(marker.length, newline)) as FrameContext;
    messages = messages.slice(0, -1);
  }
  const user = [...messages].reverse().find(message => message.role === "user");
  return { frame, userText: user ? textOf(user.content).trim() : "", messages };
}

function textOf(content: string | { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.map(block => block.text ?? "").join("");
}

/** 上一轮工具调用及其真实结果：仅当会话以 toolResult 结尾时存在，按 toolCallId 回配调用方。
 *  历史同名工具结果不算当前调用的成功凭据。 */
function pendingToolRound(messages: Message[]): { call: ToolCall; result: ToolResultMessage } | null {
  const last = messages.at(-1);
  if (last?.role !== "toolResult") return null;
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const call = message.content.find(block => block.type === "toolCall" && block.id === last.toolCallId);
    if (call && call.type === "toolCall") return { call, result: last };
  }
  return null;
}

function toolFailureMessage(pending: { call: ToolCall; result: ToolResultMessage }): AssistantMessage {
  const action = pending.call.name === "deliver_artifacts" ? "交付产物"
    : pending.call.name === "prepare_production" ? "准备提案" : "读取产物";
  const reason = textOf(pending.result.content).trim() || "工具返回错误";
  return fauxAssistantMessage(`${LABEL}离线回放失败：${action}工具返回错误，未创建产物或提案。原因：${reason}`);
}

/** 持久场景工厂：每次被消费前把自己补回队列，队列永不枯竭；并发会话各自消费互不占用。 */
export function offlineScenarioFactory(options: { selfAppend: () => void }): FauxResponseFactory {
  return (context): AssistantMessage => {
    options.selfAppend();
    const { frame, userText, messages } = offlineTurn(context.messages);
    const pending = pendingToolRound(messages);
    if (userText === SCENARIO_PROPOSAL && frame?.target) {
      // 延续回合按当前挂起调用的实际 toolResult 决定推进还是如实报失败。
      if (pending?.call.name === "read_artifact") {
        if (pending.result.isError) return toolFailureMessage(pending);
        const revision = JSON.parse(textOf(pending.result.content)) as ArtifactRevision;
        // 提案走配音：B04 后视频终稿必须落在已正式开始的事项上，离线回放没有这一步；
        // 模拟配音只需绑定脚本即可全流程验证 准备→确认→后台→交付。工具入参按合同不带定价字段。
        return fauxAssistantMessage([fauxToolCall("prepare_production", { spec: {
          workId: null, title: "模拟配音", inputRevisions: [{ artifactId: revision.artifactId, revisionId: revision.revisionId }],
          operations: [{ operationId: "speech-1", outputSlot: "voiceTrack", kind: "speech",
            model: { providerId: "fixture-text", modelId: "faux-speech", connectionId: "offline-fixture", configurationRevisionId: "increment-a-offline" },
            inputs: [{ kind: "artifact_revision", artifactId: revision.artifactId, revisionId: revision.revisionId, digest: revision.digest }],
            parameters: { voiceId: "narrator-main", format: "mp3" } }],
          finalOutput: { operationId: "speech-1", outputSlot: "voiceTrack" }, maxSpend: { currency: "CNY", amountMinor: 1200 },
        } } satisfies JsonObject)]);
      }
      if (pending?.call.name === "prepare_production") {
        if (pending.result.isError) return toolFailureMessage(pending);
        return fauxAssistantMessage(`${LABEL}提案已准备，先停在这里。只有点“确认制作”，或回复这份提案发送“确认制作”，才会受理模拟后台任务。`);
      }
      return fauxAssistantMessage([fauxToolCall("read_artifact", { artifactId: frame.target.artifactId, revisionId: frame.target.revisionId })]);
    }
    return scenarioReply({ frame, userText, pending });
  };
}

export function scenarioReply(state: {
  frame: FrameContext | null;
  userText: string;
  pending: { call: ToolCall; result: ToolResultMessage } | null;
}): AssistantMessage {
  const blocks: FauxContentBlock[] = [];
  if (state.pending) {
    // 延续回合：交付成功才报“已放到右边”；失败如实显示，不拿历史 toolCall 冒充成功。
    if (state.pending.call.name === "deliver_artifacts" && !state.pending.result.isError) {
      return fauxAssistantMessage(`${LABEL}内容已放到右边了。先慢慢看，想调整哪份可以点“提意见”。`);
    }
    return toolFailureMessage(state.pending);
  }
  if (state.userText === SCENARIO_DELIVER_BATCH && state.frame && !state.frame.deliveryClosed) {
    if (state.frame.target) {
      return fauxAssistantMessage(`${LABEL}当前消息绑定了修改目标，批次场景要求未绑定状态。请先解除输入框上方的“修改目标”，再发送「${SCENARIO_DELIVER_BATCH}」。${BOUNDARY_HINT}`);
    }
    blocks.push(fauxToolCall("deliver_artifacts", {
      items: [
        {
          mode: "create", title: "城市夜景延时开场脚本", kind: "script",
          content: { format: "markdown", text: "以夜间城市天际线的延时镜头开场……（离线测试内容一）" },
        },
        {
          mode: "create", title: "第一人称晨跑独白脚本", kind: "script",
          content: { format: "markdown", text: "以第一人称跟拍晨跑者的独白贯穿……（离线测试内容二）" },
        },
        {
          mode: "create", title: "数据卡片式对比脚本", kind: "script",
          content: { format: "markdown", text: "用数据卡片对比白天与夜晚的城市节奏……（离线测试内容三）" },
        },
      ],
    } satisfies JsonObject));
    blocks.push({ type: "text", text: `${LABEL}按场景交付三个独立方向的脚本。` });
    return fauxAssistantMessage(blocks);
  }
  if (state.userText === SCENARIO_REVISE) {
    const target = state.frame?.target ?? null;
    if (!target) {
      return fauxAssistantMessage(`${LABEL}修订场景需要先绑定修改目标：在右侧预览打开某一版，点“提意见”，再发送「${SCENARIO_REVISE}」。${BOUNDARY_HINT}`);
    }
    const base = state.frame?.artifacts.find(artifact => artifact.artifactId === target.artifactId) ?? null;
    blocks.push(fauxToolCall("deliver_artifacts", {
      items: [{
        mode: "revise", artifactId: target.artifactId, baseRevisionId: target.revisionId,
        title: `${base?.title ?? "指定产物"}（安静版）`, kind: "script",
        content: { format: "markdown", text: "保留原意，把语气调整为更安静、克制的叙述。（离线测试修订内容）" },
      }],
    } satisfies JsonObject));
    blocks.push({ type: "text", text: `${LABEL}按场景对绑定目标生成新版本，基线是你在输入框里绑定的那一版。` });
    return fauxAssistantMessage(blocks);
  }
  return fauxAssistantMessage(`${LABEL}这条输入不在替身能力范围内，没有发起任何模型语义处理或正式交付。${BOUNDARY_HINT}`);
}
