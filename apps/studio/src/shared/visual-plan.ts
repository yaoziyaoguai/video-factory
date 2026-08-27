import type { StudioTopicCategory, StudioVisualPlan, StudioVisualSource } from "./api.js";

export interface VisualDirectionInput {
  title: string;
  hook: string;
  category?: StudioTopicCategory;
  visualStyle?: string;
}

export function planVisualDirection(input: VisualDirectionInput): StudioVisualPlan {
  const topic = compactTopic(input.title);
  const category = input.category ?? inferVisualCategory(`${input.title} ${input.hook}`);
  const direction = input.visualStyle?.trim() || defaultDirection(category);
  const contextSource = contextSourceFor(category);

  return {
    strategy: `${direction}。优先使用创作者可拍画面与可验证素材，缺口再由素材库或生成模型补齐。`,
    beats: [
      {
        id: "hook",
        role: "冲突钩子",
        duration: "0-3 秒",
        description: `用一个具体动作或结果先呈现：${shorten(input.hook, 42)} 画面先于解释。`,
        searchQuery: `${topic} 真实反应 特写 竖屏`,
        source: "creator",
      },
      {
        id: "context",
        role: "证据与语境",
        duration: "3-14 秒",
        description: contextDescription(category, topic),
        searchQuery: contextQuery(category, topic),
        source: contextSource,
      },
      {
        id: "payoff",
        role: "结论收束",
        duration: "14-24 秒",
        description: `回到人物、结果或前后对照，用一个可验证变化回答“${topic}”并留出评论问题。`,
        searchQuery: `${topic} 前后对比 结果 人物反应`,
        source: "local-card",
      },
    ],
  };
}

function contextSourceFor(category: StudioTopicCategory): StudioVisualSource {
  if (category === "technology" || category === "finance-career" || category === "education") return "screen";
  if (category === "society" || category === "health-sports" || category === "entertainment" || category === "gaming" || category === "automotive") return "stock";
  return "creator";
}

function contextDescription(category: StudioTopicCategory, topic: string): string {
  if (category === "technology") return `录制真实操作、界面反馈和失败步骤，让“${topic}”能被复现，而不是只放科技空镜。`;
  if (category === "finance-career") return `用真实页面、账单或工作动作解释“${topic}”，敏感数据必须打码。`;
  if (category === "society") return `只使用有来源的现场环境、公开资料和时间线，不把无关画面包装成事件现场。`;
  if (category === "health-sports") return `交替使用动作细节、场地环境和公开数据，避免用素材替代事实证据。`;
  if (category === "education") return `用纸面推演或屏幕演示呈现步骤，让观众看见方法如何完成。`;
  return `用人物动作、生活环境和关键物件建立语境，让“${topic}”发生在真实场景里。`;
}

function contextQuery(category: StudioTopicCategory, topic: string): string {
  const suffix: Record<StudioTopicCategory, string> = {
    society: "公开资料 城市环境 新闻现场",
    "finance-career": "工作桌面 数据页面 操作录屏",
    technology: "真实操作 屏幕录制 使用过程",
    lifestyle: "生活场景 人物动作 环境细节",
    "health-sports": "训练动作 场地 数据",
    education: "步骤演示 笔记 屏幕录制",
    entertainment: "公开活动 舞台 观众反应",
    "local-culture": "街区 人物 手艺 环境声",
    food: "制作过程 食材细节 成品反应",
    travel: "真实路线 地标 交通 环境细节",
    gaming: "游戏实录 赛事画面 玩家操作",
    automotive: "车辆实拍 驾驶场景 功能细节",
    "fashion-beauty": "上身实测 使用步骤 前后对比",
    parenting: "家庭场景 亲子互动 用品细节",
    "agriculture-rural": "田间生产 农机操作 村庄环境",
  };
  return `${topic} ${suffix[category]}`;
}

function defaultDirection(category: StudioTopicCategory): string {
  if (category === "technology") return "真实屏幕操作配人物反应";
  if (category === "finance-career") return "工作现场、数据证据与人物选择";
  if (category === "health-sports") return "动作特写、场地关系与数据卡片";
  if (category === "local-culture") return "人物、街区细节与同期环境声";
  if (category === "food") return "制作动作、食材质感与真实试吃反应";
  if (category === "travel") return "真实路线、空间关系与现场环境声";
  if (category === "automotive") return "车辆实拍、功能验证与驾驶语境";
  if (category === "fashion-beauty") return "自然光实测、步骤细节与前后对照";
  if (category === "parenting") return "克制的家庭观察、亲子互动与物件细节";
  if (category === "agriculture-rural") return "生产动作、田间关系与真实劳动细节";
  if (category === "society") return "来源明确的公开资料与克制现场语境";
  return "人物近景、生活动作与环境细节";
}

function inferVisualCategory(value: string): StudioTopicCategory {
  if (/亲子|育儿|母婴|家长|宝宝/.test(value)) return "parenting";
  if (/汽车|新车|新能源车|电动车|智驾|车企/.test(value)) return "automotive";
  if (/游戏|电竞|手游|主机|玩家/i.test(value)) return "gaming";
  if (/时尚|穿搭|美妆|护肤|口红|防晒/.test(value)) return "fashion-beauty";
  if (/美食|早餐|小吃|餐厅|菜谱|做饭|咖啡/.test(value)) return "food";
  if (/旅行|旅游|文旅|景区|酒店|民宿/.test(value)) return "travel";
  if (/三农|农业|农机|粮食|丰收|乡村振兴/.test(value)) return "agriculture-rural";
  if (/\bAI\b|人工智能|模型|科技|软件|应用|手机|电脑/i.test(value)) return "technology";
  if (/职场|工作|工资|就业|消费|财经|收入/.test(value)) return "finance-career";
  if (/比赛|体育|足球|篮球|训练|健康|运动|冠军|赛事|联赛|球队|TYL/i.test(value)) return "health-sports";
  if (/学校|学习|教育|考试|课程/.test(value)) return "education";
  if (/电影|音乐|明星|综艺|娱乐/.test(value)) return "entertainment";
  if (/城市|社区|文化|华人|街区|地方/.test(value)) return "local-culture";
  if (/警方|法院|通报|事故|伤亡|死亡|去世|逝世|病逝|身亡|遇难|社会|空袭|战争|冲突|外交|制裁/.test(value)) return "society";
  return "lifestyle";
}

function compactTopic(value: string): string {
  return shorten(value.replace(/[？?！!。]/g, "").trim(), 28);
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
