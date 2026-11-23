import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type FauxContentBlock, type FauxResponseFactory, type JsonObject, type Message, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ArtifactRevision } from "../../shared/agent/generated/contracts.js";
import type { DemoMediaSeeds, DemoSeedRef } from "./offline-demo-media.js";

// 离线默认体验的 Faux 场景表：响应永远带【离线测试回放】标识，不冒充真实模型理解。
// 可触发的测试输入只有下面四条精确句子（与 BOUNDARY_HINT、FrameWelcome 离线示例一致）；
// 任何其他输入都返回测试边界说明，这是 ACCEPTANCE 对“输入不在替身能力范围时显示测试边界”的要求。
// 不做关键词模糊匹配，不把它当作真实 Agent 的语义能力。

export const SCENARIO_DELIVER_BATCH = "给我三个不同方向的脚本，先不要制作";
export const SCENARIO_REVISE = "保留意思，语气安静一点";
export const SCENARIO_PROPOSAL = "按这份准备制作提案，先不要开始";
export const SCENARIO_WORK_DEMO = "演示多作品总览与审片工作台";

// 演示口令一次建立的三件作品：前两件带可播放样片成片，第三件只建内容稿。
const DEMO_WORK_TITLES = ["山径晨光", "城市夜色", "咖啡手记"] as const;

const LABEL = "【离线测试回放】";
const BOUNDARY_HINT = `离线替身只回放固定场景，可触发输入：
1）新话题发送「${SCENARIO_DELIVER_BATCH}」（未绑定修改目标时交付三个独立脚本）；
2）在预览里点“提意见”绑定目标后发送「${SCENARIO_REVISE}」（生成该产物的 v2；演示成片换静音样片，其余为安静版文稿）；
3）绑定一份脚本 后发送「${SCENARIO_PROPOSAL}」（只准备模拟制作提案，等待明确确认）；
4）发送「${SCENARIO_WORK_DEMO}」（用真实业务工具一次建立三件对齐作品：脚本与可播放样片成片，均在总览查看）。
其他输入不在替身能力范围内，只返回本说明。此入口不验证真实模型的自由问答效果。`;

interface FrameContext {
  target: { artifactId: string; revisionId: string } | null;
  artifacts: { artifactId: string; title: string; kind: string; headRevisionId: string | null }[];
  // 新字段由宿主帧提供；旧测试帧未携带，按缺省处理（works 视为空）。
  conversationId?: string;
  works?: { id: string; title: string; reviewGroups: unknown[] }[];
  deliveryClosed: boolean;
}

/** 离线演示口令的样片存取：plant 落库并缓存，seedsOf 只读；未装配媒体替身时整个对象为 null。 */
export interface DemoMediaAccess {
  seedsOf(conversationId: string | undefined): DemoMediaSeeds | null;
  plant(conversationId: string): DemoMediaSeeds | null;
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
export function offlineScenarioFactory(options: { selfAppend: () => void; demoMedia?: DemoMediaAccess | null }): FauxResponseFactory {
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
          workId: null, title: "模拟配音",
          inputSources: [{ kind: "artifact_revision", artifactId: revision.artifactId, revisionId: revision.revisionId, digest: revision.digest }],
          reviewInputs: [], purpose: "production", scope: "离线模拟配音全流程验证",
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
    if (userText === SCENARIO_WORK_DEMO) {
      return demoWorkReply({ frame, userText, pending }, options.demoMedia ?? null);
    }
    return scenarioReply({ frame, userText, pending, demo: options.demoMedia ?? null });
  };
}

// 演示口令状态机只看帧里的当前作品数：0/1/2→start_work，3→种样片运行+一次性交付。
// 样片在第 3 件作品建好、交付前才落库（底层运行输出，不插顶层产物），演示旅程中段不再出现种子。
// 延续回合按真实 toolResult 成败推进；重复口令（作品已齐且无挂起调用）不再重建。
function demoWorkReply(state: {
  frame: FrameContext | null;
  userText: string;
  pending: { call: ToolCall; result: ToolResultMessage } | null;
}, demo: DemoMediaAccess | null): AssistantMessage {
  const frame = state.frame;
  if (!frame) {
    return fauxAssistantMessage(`${LABEL}演示场景需要宿主业务帧，本次调用没有提供，未建立任何作品。${BOUNDARY_HINT}`);
  }
  if (state.pending) {
    if (state.pending.result.isError) return toolFailureMessage(state.pending);
    if (state.pending.call.name === "deliver_artifacts") {
      return fauxAssistantMessage(`${LABEL}三件演示作品已建立：脚本挂在各作品的内容事项上，两条可播放成片来自本机演示样片，全部是未认可草稿。切到总览即可逐件查看；想看修订链，在预览里点“提意见”绑定某条成片后发送「${SCENARIO_REVISE}」。`);
    }
    // start_work 成功：帧中 works 已增长，按数量继续推进。
  }
  const works = frame.works ?? [];
  if (works.length >= DEMO_WORK_TITLES.length) {
    if (!state.pending) {
      return fauxAssistantMessage(`${LABEL}演示作品已建立过，不再重复创建。总览里应能看到「${DEMO_WORK_TITLES.join("」「")}」；如需重新演示，请新建会话。${BOUNDARY_HINT}`);
    }
    if (!frame.conversationId) {
      return fauxAssistantMessage(`${LABEL}演示场景需要帧携带会话标识，未交付内容。${BOUNDARY_HINT}`);
    }
    return demoDeliverReply(frame, demo);
  }
  if (works.length === 0 && !demo) {
    return fauxAssistantMessage(`${LABEL}本次装配没有启用媒体替身，演示口令需要可播放样片才能建立对齐作品，未创建任何内容。${BOUNDARY_HINT}`);
  }
  const index = works.length;
  const title = DEMO_WORK_TITLES[index]!;
  return fauxAssistantMessage([
    fauxToolCall("start_work", { title } satisfies JsonObject),
    { type: "text", text: `${LABEL}建立第 ${index + 1} 件作品「${title}」，三件齐后一次性交付脚本与样片成片。` },
  ]);
}

function demoDeliverReply(frame: FrameContext, demo: DemoMediaAccess | null): AssistantMessage {
  // 交付前才种样片运行（幂等）：三件作品已建好，种子以底层运行输出落库，不产生顶层产物。
  const seeds = demo?.plant(frame.conversationId!) ?? null;
  if (!seeds) {
    return fauxAssistantMessage(`${LABEL}当前装配没有启用媒体替身，演示样片未能登记，未交付成片。${BOUNDARY_HINT}`);
  }
  const workId = (title: string): string => {
    const work = (frame.works ?? []).find(candidate => candidate.title === title);
    if (!work) throw new Error(`演示交付前提不成立：找不到作品「${title}」。`);
    return work.id;
  };
  // 成片按运行输出交付（run_output），字节来自演示运行的操作槽。
  const runOutput = (seed: DemoSeedRef) => ({ kind: "run_output", runId: seed.runId, operationId: seed.operationId, outputSlot: seed.outputSlot });
  return fauxAssistantMessage([
    fauxToolCall("deliver_artifacts", {
      items: [
        { mode: "create", title: "山径晨光 · 脚本", kind: "script", content: { format: "markdown", text: "晨光穿过山径树影，脚步声与鸟鸣交替收进同期声……（离线演示脚本一）" } },
        { mode: "create", title: "城市夜色 · 脚本", kind: "script", content: { format: "markdown", text: "入夜后的城市灯牌与车流延时，配克制的旁白……（离线演示脚本二）" } },
        { mode: "create", title: "咖啡手记 · 脚本", kind: "script", content: { format: "markdown", text: "手冲咖啡的蒸汽特写与慢节奏旁白，落在一句收尾……（离线演示脚本三）" } },
        { mode: "create", title: "山径晨光 · 成片 v1", kind: "video",
          content: { format: "local_output", source: runOutput(seeds.trail) } },
        { mode: "create", title: "咖啡手记 · 成片 v1", kind: "video",
          content: { format: "local_output", source: runOutput(seeds.coffee) } },
      ],
      reviewGroups: [
        { workId: workId("山径晨光"), group: { mode: "create", key: "demo-main", title: "内容与成片", nextIntent: "认可脚本或成片后再继续制作" }, items: [
          { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" },
          { item: { mode: "create", key: "cut", label: "成片", role: "video", required: true }, itemIndex: 3, inputSources: [], reviewInputs: [], purpose: "draft" },
        ] },
        { workId: workId("城市夜色"), group: { mode: "create", key: "demo-main", title: "内容", nextIntent: "认可脚本后再继续画面方案" }, items: [
          { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" },
        ] },
        { workId: workId("咖啡手记"), group: { mode: "create", key: "demo-main", title: "内容与成片", nextIntent: "认可脚本或成片后再继续制作" }, items: [
          { item: { mode: "create", key: "script", label: "脚本", role: "content", required: true }, itemIndex: 2, inputSources: [], reviewInputs: [], purpose: "draft" },
          { item: { mode: "create", key: "cut", label: "成片", role: "video", required: true }, itemIndex: 4, inputSources: [], reviewInputs: [], purpose: "draft" },
        ] },
      ],
    } satisfies JsonObject),
    { type: "text", text: `${LABEL}一次性交付三件作品的脚本草稿与两条成片草稿，全部未认可；下一步由你在总览或预览里明确操作。` },
  ]);
}

// 演示成片的 v2 用静音孪生样片：字节不同、时长一致，修订差异可证明；按标题认族。
function twinSeedOf(title: string, seeds: DemoMediaSeeds | null): DemoSeedRef | null {
  if (!seeds) return null;
  if (title.includes("山径")) return seeds.trailSilent;
  if (title.includes("咖啡")) return seeds.coffeeSilent;
  return null;
}

export function scenarioReply(state: {
  frame: FrameContext | null;
  userText: string;
  pending: { call: ToolCall; result: ToolResultMessage } | null;
  demo?: DemoMediaAccess | null;
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
    if (base?.kind === "video") {
      // 演示成片的 v2 换静音孪生样片：两版字节不同、时长一致，编辑差异可证明。
      const twin = twinSeedOf(base.title, state.demo?.seedsOf(state.frame?.conversationId) ?? null);
      if (!twin) {
        return fauxAssistantMessage(`${LABEL}视频修订演示只覆盖演示成片（山径晨光 / 咖啡手记）；当前绑定目标没有对应样片，未生成修订。${BOUNDARY_HINT}`);
      }
      // 标题先去掉尾缀版本号再接「· 静音版」，杜绝「（有声）（静音版）」式叠拼。
      const cleanTitle = base.title.replace(/\s*(?:·\s*)?v\d+$/, "");
      blocks.push(fauxToolCall("deliver_artifacts", {
        items: [{
          mode: "revise", artifactId: target.artifactId, baseRevisionId: target.revisionId,
          title: `${cleanTitle} · 静音版`, kind: "video",
          content: { format: "local_output", source: { kind: "run_output", runId: twin.runId, operationId: twin.operationId, outputSlot: twin.outputSlot } },
        }],
      } satisfies JsonObject));
      blocks.push({ type: "text", text: `${LABEL}按场景对绑定成片交付静音 v2，基线是你在输入框里绑定的那一版。` });
      return fauxAssistantMessage(blocks);
    }
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
