// 第一阶段专用的有限场景回放。这里的短句匹配不是意图路由，不能接到真实 Pi 或制作服务。
export type PreviewStage = "script" | "plan" | "video";
export type PreviewTopic = "trail" | "coffee";
export interface ScriptDraft {
  version: number;
  opening: string;
  ending: string;
  change: string;
}
export interface PreviewPlan {
  version: number;
  scriptVersion: number;
  choices: string[];
  voice: boolean;
  approved: boolean;
}
export interface PreviewRun {
  version: number;
  scriptVersion: number;
  planVersion: number;
  choices: string[];
  voice: boolean;
  status: "running" | "completed";
  notes: string[];
}
export interface PreviewWork {
  id: string;
  topic: PreviewTopic;
  title: string;
  scripts: ScriptDraft[];
  confirmedScript: number | null;
  plan: PreviewPlan | null;
  runs: PreviewRun[];
  phase: "script" | "plan" | "running" | "video" | "done";
}
export interface PreviewMessage {
  role: "user" | "assistant";
  text: string;
  selectedSkill?: string;
  card?: { workId: string; stage: PreviewStage; version: number };
}
export interface PreviewConversation {
  id: string;
  title: string;
  messages: PreviewMessage[];
  works: PreviewWork[];
  selected: string | null;
  draft: string;
}
export interface PreviewState {
  conversations: PreviewConversation[];
  active: string;
  nextId: number;
}

export const topics = {
  trail: {
    title: "去山里，慢下来",
    opening:
      "周末，想暂时离开城市。收起手机，从一条蜿蜒的小路开始，把脚步交还给自己。",
    ending: "不必走得很远。把赶路的心情留在山外，慢一点，就很好。",
    middle:
      "山脊在远处展开。风经过树梢，阳光落在脚边；镜头不追赶，只跟着行走的呼吸。",
    choices: ["ridge", "forest", "rest"],
  },
  coffee: {
    title: "给早晨留一点时间",
    opening: "清晨的厨房还很安静。先不看消息，给自己磨一杯咖啡。",
    ending: "一杯咖啡的时间，让今天慢慢开始。",
    middle:
      "水流穿过咖啡粉，杯口升起薄薄的热气。把镜头留给手、光线和细小的日常。",
    choices: ["kitchen", "detail", "office"],
  },
} satisfies Record<
  PreviewTopic,
  {
    title: string;
    opening: string;
    ending: string;
    middle: string;
    choices: string[];
  }
>;

export function createWork(id: string, topic: PreviewTopic): PreviewWork {
  return {
    id,
    topic,
    title: topics[topic].title,
    scripts: [
      {
        version: 1,
        opening: topics[topic].opening,
        ending: topics[topic].ending,
        change: "第一版内容草稿",
      },
    ],
    confirmedScript: null,
    plan: null,
    runs: [],
    phase: "script",
  };
}
export function createPreviewState(): PreviewState {
  const work = createWork("trail-1", "trail");
  return {
    active: "conversation-1",
    nextId: 2,
    conversations: [
      {
        id: "conversation-1",
        title: "周末的创作",
        selected: work.id,
        draft: "",
        works: [work],
        messages: [
          {
            role: "user",
            text: "开始做一条 20 秒的周末徒步短片，想让人看完放松一点。先给我脚本。",
          },
          {
            role: "assistant",
            text: "先把感觉定下来：少一点赶路，多一点风、树影和停留。脚本放在右边了，你可以慢慢看、直接提意见，也可以先聊点别的。",
            card: { workId: work.id, stage: "script", version: 1 },
          },
        ],
      },
    ],
  };
}
export function currentConversation(state: PreviewState): PreviewConversation {
  return state.conversations.find((item) => item.id === state.active)!;
}
export function currentWork(state: PreviewState): PreviewWork | undefined {
  const conversation = currentConversation(state);
  return conversation.works.find((item) => item.id === conversation.selected);
}

export type PreviewAction =
  | { type: "draft"; text: string }
  | { type: "select"; workId: string }
  | { type: "conversation"; id: string }
  | { type: "new-conversation" }
  | { type: "rename"; title: string }
  | { type: "send"; text: string; skillName?: string }
  | { type: "confirm-script"; workId: string; version: number }
  | { type: "approve-plan"; workId: string }
  | { type: "choose"; workId: string; slot: number; candidate: string }
  | { type: "voice"; workId: string; enabled: boolean }
  | { type: "start"; workId: string }
  | { type: "complete"; workId: string; conversationId: string }
  | { type: "finalize"; workId: string }
  | { type: "next-version"; workId: string };

function confirmScript(
  conversation: PreviewConversation,
  work: PreviewWork,
  version: number,
): void {
  const head = work.scripts.at(-1)!;
  if (head.version !== version) {
    conversation.messages.push({
      role: "assistant",
      text: "这是之前的脚本。先看最新一版，再决定是否继续。",
    });
    return;
  }
  if (work.confirmedScript === version && work.plan?.scriptVersion === version)
    return;
  work.confirmedScript = version;
  work.plan = {
    version: (work.plan?.version ?? 0) + 1,
    scriptVersion: version,
    choices: [...topics[work.topic].choices],
    voice: true,
    approved: false,
  };
  work.phase = "plan";
  conversation.messages.push({
    role: "assistant",
    text: `脚本 v${version} 就按这版。我把三段画面、素材和声音一起整理好了。先看画面是否合适；你认可方案后，可以暂时放着，也可以明确开始制作。`,
    card: { workId: work.id, stage: "plan", version: work.plan.version },
  });
}
export function hasReusableVoice(work: PreviewWork): boolean {
  const plan = work.plan;
  return Boolean(
    plan &&
    work.runs.some(
      (run) =>
        run.status === "completed" &&
        run.voice &&
        run.planVersion < plan.version &&
        run.scriptVersion === plan.scriptVersion,
    ),
  );
}
function startRun(conversation: PreviewConversation, work: PreviewWork): void {
  const plan = work.plan;
  if (
    work.phase !== "plan" ||
    !plan ||
    plan.scriptVersion !== work.scripts.at(-1)!.version ||
    work.confirmedScript !== plan.scriptVersion
  ) {
    conversation.messages.push({
      role: "assistant",
      text: "先确认当前脚本和对应的画面方案，再开始制作。",
    });
    return;
  }
  const reusesVoice = hasReusableVoice(work);
  plan.approved = true;
  work.runs.push({
    version: work.runs.length + 1,
    scriptVersion: plan.scriptVersion,
    planVersion: plan.version,
    choices: [...plan.choices],
    voice: plan.voice,
    status: "running",
    notes: [],
  });
  work.phase = "running";
  conversation.messages.push({
    role: "assistant",
    text: `这次按脚本 v${plan.scriptVersion}、方案 v${plan.version} 制作：使用现有素材，${plan.voice ? (reusesVoice ? "沿用已有配音，不增加配音费用" : "只包含配音这一项付费范围") : "不加付费配音"}。你可以继续聊，制作中的版本保持不变；新意见留给下一版。`,
  });
}
function applyRequestedEdit(
  conversation: PreviewConversation,
  work: PreviewWork,
  text: string,
): void {
  const run = work.runs.at(-1);
  if (work.phase === "running" && run) {
    run.notes.push(text);
    conversation.messages.push({
      role: "assistant",
      text: "记给下一版了。正在制作的这一版不变，等结果出来后，我们再一起看怎么改。",
    });
    return;
  }
  const previous = work.scripts.at(-1)!;
  if (
    (work.phase === "video" || work.phase === "done") &&
    run &&
    !text.includes("脚本")
  ) {
    run.notes.push(text);
    conversation.messages.push({
      role: "assistant",
      text: "这条视频的意见记下了，现有文件保留。可以先看完，再准备下一版方案；不需要把未改动的脚本重写一遍。",
    });
    return;
  }
  const short = /开头|开场|短|精简/.test(text);
  const quiet = /结尾|安静|留白/.test(text);
  work.scripts.push({
    version: previous.version + 1,
    opening: short
      ? work.topic === "trail"
        ? "收起手机，走进山里。让风带路，慢下来。"
        : "先别看消息。给自己磨一杯咖啡。"
      : previous.opening,
    ending: quiet
      ? "旁白在这里停下。让风声和最后一个画面，再多留一会儿。"
      : previous.ending,
    change: short ? "缩短开场，直接进入画面" : "结尾留白，收住旁白",
  });
  work.phase = "script";
  conversation.messages.push({
    role: "assistant",
    text: `${short ? "开头缩短了，直接进入画面" : "结尾安静下来，给环境声留了位置"}。${work.plan ? "已有的画面方案先保留，等你确认新稿后再更新。" : "先看这一版，确认后我再整理画面。"}`,
    card: { workId: work.id, stage: "script", version: previous.version + 1 },
  });
}

export function previewReducer(
  state: PreviewState,
  action: PreviewAction,
): PreviewState {
  const next = structuredClone(state);
  const conversation =
    action.type === "complete"
      ? next.conversations.find((item) => item.id === action.conversationId)!
      : currentConversation(next);
  const work =
    "workId" in action
      ? conversation.works.find((item) => item.id === action.workId)
      : currentWork(next);
  switch (action.type) {
    case "draft":
      conversation.draft = action.text;
      break;
    case "select":
      conversation.selected = action.workId;
      break;
    case "conversation":
      next.active = action.id;
      break;
    case "rename":
      conversation.title = action.title.trim() || conversation.title;
      break;
    case "new-conversation": {
      const id = `conversation-${next.nextId++}`;
      next.conversations.push({
        id,
        title: "新的对话",
        messages: [],
        works: [],
        selected: null,
        draft: "",
      });
      next.active = id;
      break;
    }
    case "confirm-script":
      if (work && work.phase !== "running")
        confirmScript(conversation, work, action.version);
      break;
    case "approve-plan":
      if (work?.plan && work.phase === "plan") {
        work.plan.approved = true;
        conversation.messages.push({
          role: "assistant",
          text: "画面和声音方案已认可，先停在这里。没有开始制作，你随时可以回来继续。",
        });
      }
      break;
    case "choose":
      if (work?.plan && work.phase === "plan") {
        work.plan.choices[action.slot] = action.candidate;
        work.plan.approved = false;
      }
      break;
    case "voice":
      if (work?.plan && work.phase === "plan") {
        work.plan.voice = action.enabled;
        work.plan.approved = false;
      }
      break;
    case "start":
      if (work) startRun(conversation, work);
      break;
    case "complete":
      if (work?.phase === "running") {
        work.runs.at(-1)!.status = "completed";
        work.phase = "video";
        conversation.messages.push({
          role: "assistant",
          text: `“${work.title}”的初稿可以看了。先听听声音、看看节奏，满意后定稿；要改也可以直接告诉我。`,
          card: {
            workId: work.id,
            stage: "video",
            version: work.runs.at(-1)!.version,
          },
        });
      }
      break;
    case "finalize":
      if (work?.phase === "video") {
        work.phase = "done";
        conversation.messages.push({
          role: "assistant",
          text: "就以这一版定稿，视频文件没有重新生成。你可以下载，也可以继续做别的。",
        });
      }
      break;
    case "next-version":
      if (work && work.phase !== "running") {
        const previousRun = work.runs.at(-1);
        if (previousRun?.notes.length && work.plan) {
          work.plan = {
            ...work.plan,
            version: work.plan.version + 1,
            approved: false,
          };
          work.phase = "plan";
          conversation.messages.push({
            role: "assistant",
            text: "下一版先按这些意见调整方案。脚本和可用素材保留，已有配音能沿用就沿用；你看过新方案后再制作。",
            card: {
              workId: work.id,
              stage: "plan",
              version: work.plan.version,
            },
          });
          break;
        }
        const previous = work.scripts.at(-1)!;
        work.scripts.push({
          ...previous,
          version: previous.version + 1,
          change: "下一版草稿，上一版视频保留",
        });
        work.phase = "script";
        conversation.messages.push({
          role: "assistant",
          text: "下一版草稿已展开。上一版视频保留，你想先改哪里？",
          card: {
            workId: work.id,
            stage: "script",
            version: previous.version + 1,
          },
        });
      }
      break;
    case "send": {
      const text = action.text.trim();
      if (!text) return state;
      conversation.messages.push({
        role: "user",
        text,
        ...(action.skillName ? { selectedSkill: action.skillName } : {}),
      });
      conversation.draft = "";
      const named = /咖啡/.test(text)
        ? conversation.works.find((item) => item.topic === "coffee")
        : /徒步|山里/.test(text)
          ? conversation.works.find((item) => item.topic === "trail")
          : undefined;
      const target = named ?? work;
      if (/prompt|提示词/i.test(text) && !/开始制作/.test(text)) {
        conversation.messages.push({
          role: "assistant",
          text: "可以，先给你一段能直接复制使用的 Prompt：\n\n一条关于周末徒步的短片。远山、小路、树林和行走的背影，光线自然，镜头克制，节奏从容。保留脚步和风声，避免密集转场，结尾让画面安静停留。\n\n你可以继续改这段文字，暂时不进入制作。",
        });
      } else if (
        /聊|热点|最近|为什么|话题|你好|谢谢|睡眠/.test(text) &&
        !/改|开始做|再做/.test(text)
      ) {
        conversation.messages.push({
          role: "assistant",
          text: /热点|最近/.test(text)
            ? "可以先聊。热点需要实时来源，这份交互样稿没有联网，不把示例说成最新消息。比如‘为什么大家周末越来越想去户外’，就值得从情绪和生活节奏聊起。原来的稿件会留在这里。"
            : "当然。聊别的不会改变正在看的稿件。像‘为什么周末总想离开城市’，可以从休息、好奇和重新找回节奏慢慢聊，不必马上把它做成视频。",
        });
      } else if (
        /(开始做|再做|另做|新开|来一条|做一条)/.test(text) &&
        /咖啡|徒步|山里/.test(text)
      ) {
        const topic = /咖啡/.test(text) ? "coffee" : "trail";
        const created = createWork(`${topic}-${next.nextId++}`, topic);
        conversation.works.push(created);
        conversation.selected = created.id;
        conversation.messages.push({
          role: "assistant",
          text: `我们先做“${created.title}”的内容草稿。${conversation.works.length > 1 ? "另一条的进度保留，随时可以切回去。" : ""}先看表达是否对，再继续画面和声音。`,
          card: { workId: created.id, stage: "script", version: 1 },
        });
      } else if (target && /先别|暂不|不要制作|不要改|不开始/.test(text)) {
        if (
          target.phase === "plan" &&
          target.plan &&
          /认可|可以|确认/.test(text)
        ) {
          target.plan.approved = true;
        }
        conversation.messages.push({
          role: "assistant",
          text: "好，先停在这版，不开始制作。你可以继续看、继续聊。",
        });
      } else if (target && /改|缩短|短一点|安静|精简/.test(text)) {
        conversation.selected = target.id;
        applyRequestedEdit(conversation, target, text);
      } else if (
        target?.phase === "plan" &&
        /确认.*(开始|制作)|按.*(方案|这份).*开始|开始制作/.test(text)
      ) {
        startRun(conversation, target);
      } else if (
        target?.phase === "script" &&
        /确认|可以.*继续|继续.*分镜|按这版.*分镜/.test(text)
      ) {
        confirmScript(conversation, target, target.scripts.at(-1)!.version);
      } else if (
        target?.phase === "plan" &&
        /认可|确认.*方案|方案.*可以/.test(text)
      ) {
        target.plan!.approved = true;
        conversation.messages.push({
          role: "assistant",
          text: "这份方案已认可。还没有开始制作，等你明确开始。",
        });
      } else if (target?.phase === "plan" && /第二个|第二项/.test(text)) {
        target.plan!.choices[0] = topics[target.topic].choices[1]!;
        target.plan!.approved = false;
        conversation.messages.push({
          role: "assistant",
          text: "选用了这条短片原素材列表里的第二项，已放到第一个镜头。其他安排保留，先看是否合适。",
        });
      } else if (named && /回到|看看|切回|继续看/.test(text)) {
        conversation.selected = named.id;
        conversation.messages.push({
          role: "assistant",
          text: `回到“${named.title}”，还是你之前停下的那一步。`,
        });
      } else if (target && text === "继续") {
        conversation.messages.push({
          role: "assistant",
          text:
            target.phase === "script"
              ? "你是认可这版脚本、继续整理分镜吗？可以直接说‘这版可以，继续分镜’，或在稿件旁确认。"
              : "要继续修改方案，还是按当前方案开始制作？确认前我先停在这里。",
        });
      } else if (/想做|想拍/.test(text)) {
        conversation.messages.push({
          role: "assistant",
          text: "先聊想表达什么、给谁看、希望留下什么感觉。你也可以先要 Prompt。等你明确开始这条视频，我再带你从草稿往下做。",
        });
      } else {
        conversation.messages.push({
          role: "assistant",
          text: "这份样稿还没有接真实模型，暂时不能理解所有自由输入。你可以用下方示例体验改稿、聊别的和新开短片；刚才的内容不会触发制作。",
        });
      }
      break;
    }
  }
  return next;
}
