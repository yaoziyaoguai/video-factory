import type { DriveStep, DriverHook } from "driver.js";

const actionAdvanceListeners = new WeakMap<Element, EventListener>();

const reliableActionAdvance: Pick<DriveStep, "onHighlightStarted" | "onDeselected"> = {
  onHighlightStarted: (element, step, opts) => {
    if (!element) return;
    removeActionAdvanceListener(element);
    const listener: EventListener = () => {
      removeActionAdvanceListener(element);
      advanceAfterHighlightSettles(step, opts);
    };
    actionAdvanceListeners.set(element, listener);
    element.addEventListener("click", listener, { once: true });
  },
  onDeselected: (element) => {
    if (element) removeActionAdvanceListener(element);
  },
};

export const FULL_CREATOR_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: "欢迎来到今日创作",
      description: "完整流程有六步：选选题、定方案、跑制作、做审片、多端发布、看复盘。有可用候选时会跟随页面实际控件走到制作弹窗；空状态会说明下一步。导览不会替你启动生产或花钱。",
    },
  },
  {
    element: '[data-tour="topic-inbox"]',
    popover: {
      title: "第一步：选择选题入口",
      description: "热点、系列和自定义创作是三个并列入口。热点候选可按分类与平台筛选；系列会持续给出下一集；采用后统一进入下方制作区。",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="candidate-adopt"]:not(:disabled)',
    ...reliableActionAdvance,
    disableActiveInteraction: false,
    waitForElement: 5_000,
    popover: {
      title: "采用候选，才会进入制作区",
      description: "先看原始来源与证据门禁。常规候选可直接采用；敏感候选需要确认核验，证据不足的高风险热点会被阻止。",
      side: "top",
      align: "end",
      showButtons: ["previous", "close"],
    },
  },
  {
    element: '[data-tour="opportunity-focus"]',
    popover: {
      title: "判断它值不值得拍",
      description: "这里集中展示开场钩子、受众、评分维度和信号证据。先看证据，再决定是否消耗制作时间。",
      side: "top",
      align: "center",
    },
  },
  {
    element: '[data-tour="visual-direction"]',
    popover: {
      title: "先看镜头方向",
      description: "三段镜头计划依次负责停留、语境和收束。它是开拍前的可执行视觉草图，不是最终成片。",
      side: "top",
      align: "center",
    },
  },
  {
    element: '[data-tour="director-panel"]',
    popover: {
      title: "导演台检查生产边界",
      description: "这里确认叙事、制作能力与成本边界。缺少必要能力时，系统会明确阻止开拍。",
      side: "left",
      align: "start",
    },
  },
  {
    element: () => visibleTourElement("projects-nav"),
    popover: {
      title: "开始后，从制作记录继续",
      description: "制作会出现在“制作记录”。点进记录可看节点进度、成片预览和人工终审。",
      side: "right",
      align: "center",
    },
  },
  {
    element: '[data-tour="create-production"]',
    ...reliableActionAdvance,
    disableActiveInteraction: false,
    waitForElement: 5_000,
    popover: {
      title: "第二步：点击新建制作",
      description: "打开制作配方。导览只带你进入弹窗，不会替你花钱或启动生产。",
      side: "top",
      align: "center",
      showButtons: ["previous", "close"],
    },
  },
  {
    element: '[data-tour="production-recipes"]',
    waitForElement: 8_000,
    popover: {
      title: "先选经济边界",
      description: "“经济日更”优先使用已就绪的低成本能力。付费模型配方会明确展示镜头数与预算上限。",
      side: "right",
      align: "start",
    },
  },
  {
    element: '[data-tour="production-start"]',
    waitForElement: 8_000,
    popover: {
      title: "检查完，再亲自开拍",
      description: "确认标题、声音和配方后点击开始制作。系统随后自动执行脚本、画面、配音、渲染和机器质检。",
      side: "top",
      align: "end",
    },
  },
  {
    popover: {
      title: "第三步：等待自动制作",
      description: "启动后会进入制作详情并实时更新节点；断线时页面会提示并自动重连。记录和已生成产物会保留。",
    },
  },
  {
    popover: {
      title: "第四步：成片后回来审片",
      description: "看到“需要你的判断”时，请完整检查画面、字幕、声音与事实。满意就批准进入发布包；不满意则写明原因后打回。",
    },
  },
  {
    popover: {
      title: "第五步：发布或取包",
      description: "批准后可下载发布包，也可进入多平台发布。只有官方开放能力、账号授权和合规检查都通过的平台才会发送。",
    },
  },
  {
    popover: {
      title: "第六步：平台结果接入后复盘",
      description: "当前制作复盘只汇总制作事实。平台导出或授权连接器接入后，才能比较播放、完播、互动和涨粉，并让结果影响下一次选题。",
    },
  },
  {
    element: '[data-tour="creator-guide"]',
    popover: {
      title: "忘了下一步，就从这里回来",
      description: "右下角的创作向导会一直保留。它既能重走完整流程，也能只讲解你当前所在的页面。",
      side: "left",
      align: "end",
    },
  },
];

export function pageTourSteps(pathname: string): DriveStep[] {
  if (pathname === "/projects") return PROJECT_TOUR_STEPS;
  if (pathname.startsWith("/projects/")) return RUN_TOUR_STEPS;
  if (pathname === "/resources") return RESOURCE_TOUR_STEPS;
  if (pathname === "/experiments") return EXPERIMENT_TOUR_STEPS;
  return HOME_TOUR_STEPS;
}

const HOME_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: "今天从哪里开始",
      description: "先在热点、系列或自定义创作中选择入口；采用候选后，核对证据和镜头方向，再在导演台创建制作配方。",
    },
  },
  FULL_CREATOR_TOUR_STEPS[1]!,
  FULL_CREATOR_TOUR_STEPS[2]!,
  FULL_CREATOR_TOUR_STEPS[3]!,
  FULL_CREATOR_TOUR_STEPS[4]!,
  FULL_CREATOR_TOUR_STEPS[5]!,
  FULL_CREATOR_TOUR_STEPS[7]!,
];

const PROJECT_TOUR_STEPS: DriveStep[] = [
  {
    popover: {
      title: "到了制作记录，接下来这样做",
      description: "先看状态，再打开具体记录；只有“等你审片”的制作需要马上处理。",
    },
  },
  {
    element: '[data-tour="project-overview"]',
    popover: {
      title: "先看今天卡在哪一步",
      description: "制作中会自动推进；等你审片需要你决策；已完成表示发布包已准备好，可以下载或进入多平台发布。",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="project-controls"]',
    popover: {
      title: "按下一步动作筛选",
      description: "时间紧时直接筛“等你审片”。也可以按标题搜索，不必逐条翻找。",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="project-queue"]',
    popover: {
      title: "每个项目都保留完整进度",
      description: "九段进度对应内容简报、脚本、导演方案、画面、配音、渲染、机器质检、人工终审和发布包。每一段都标出对应制作角色。",
      side: "top",
      align: "center",
    },
  },
  {
    element: '[data-tour="project-item"]',
    popover: {
      title: "打开任务，进入生产现场",
      description: "点击“打开制作记录”“进入审片”或“查看成片”。下一页会告诉你现在要等、要审，还是可以下载发布包。",
      side: "top",
      align: "start",
    },
  },
  {
    popover: {
      title: "完整闭环还剩三步",
      description: "进入记录做人工终审 → 批准后下载发布包或发往已接通的平台 → 再到制作复盘比较表现。",
    },
  },
];

const RUN_TOUR_STEPS: DriveStep[] = [
  {
    element: '[data-tour="run-header"]',
    popover: {
      title: "这是这条视频的生产现场",
      description: "标题旁的状态决定现在要做什么：制作中就等待，等你审片就做人工终审，已完成就取发布包或做多平台发布。",
      side: "bottom",
      align: "start",
    },
  },
  {
    element: '[data-tour="run-workflow"]',
    popover: {
      title: "逐节点看真实进度",
      description: "绿色表示完成，黄色表示进行中或等你判断，红色表示失败或被打回。页面会实时刷新。",
      side: "bottom",
      align: "center",
    },
  },
  {
    element: '[data-tour="run-preview"]',
    popover: {
      title: "先看完整成片",
      description: "渲染结束后在这里播放和下载。没有成片时继续看节点状态，不需要重复创建任务。",
      side: "right",
      align: "start",
    },
  },
  {
    element: '[data-tour="run-review"]',
    popover: {
      title: "系统会明确告诉你是否要动手",
      description: "出现“需要你的判断”时，满意就批准；不满意就打回并写清画面、节奏或内容问题。其余状态无需操作。",
      side: "left",
      align: "start",
    },
  },
  {
    element: '[data-tour="run-artifacts"]',
    popover: {
      title: "所有产物都可追溯",
      description: "脚本、画面计划、配音、成片、质检报告和最终发布包都在这里。批准后，从发布包完成交付。",
      side: "left",
      align: "start",
    },
  },
  {
    popover: {
      title: "发布后别忘了复盘",
      description: "当前只展示制作侧事实。平台导出或授权连接器接入后，再回到“制作复盘”比较播放、完播、互动和涨粉。",
    },
  },
];

const RESOURCE_TOUR_STEPS: DriveStep[] = [
  {
    element: '[data-tour="resource-overview"]',
    popover: { title: "先看整套工厂是否可用", description: "这里汇总热点服务、画面来源、生产岗位和发布出口。", side: "bottom", align: "start" },
  },
  {
    element: '[data-tour="configuration-defaults"]',
    popover: { title: "把常用选择保存为默认", description: "成本策略、导演角色、平台、时长和终审方式会自动带入下一条新制作，创建时仍可单独修改。", side: "bottom", align: "center" },
  },
  {
    element: '[data-tour="resource-trends"]',
    popover: { title: "热点必须有来源", description: "热点采集服务、最近采集结果和原始链接都在这里；离线或需要配置会明确标出。", side: "top", align: "center" },
  },
  {
    element: '[data-tour="resource-voice"]',
    popover: { title: "先试听，再定声音", description: "选择声音、语速、停顿和母带风格。试听不会启动整条视频生产。", side: "top", align: "center" },
  },
  {
    element: '[data-tour="resource-visual"]',
    popover: { title: "画面来源可以替换", description: "免费图库、自托管能力和付费生成模型都通过统一能力接口接入；不可用项会说明配置要求。", side: "top", align: "center" },
  },
  {
    element: '[data-tour="configuration-publishing"]',
    popover: { title: "发布能力以官方权限为准", description: "能自动发布、需要授权或只能导出发布包都会如实显示；系统不会绕过平台审核。", side: "top", align: "center" },
  },
];

const EXPERIMENT_TOUR_STEPS: DriveStep[] = [
  {
    element: '[data-tour="experiment-metrics"]',
    popover: { title: "先看可验证的制作事实", description: "这里统计制作总数、已完成和等你审片的记录。", side: "bottom", align: "start" },
  },
  {
    element: '[data-tour="experiment-outcomes"]',
    popover: { title: "平台结果尚待接入", description: "播放、完播、互动和涨粉需要平台导出或授权连接器；当前页面还不能手工录入这些指标。", side: "top", align: "center" },
  },
  {
    popover: { title: "让结果回到下一次选题", description: "平台结果接入后，再比较不同选题、钩子、画面和配方的表现。" },
  },
];

function visibleTourElement(name: string): Element {
  const elements = [...document.querySelectorAll(`[data-tour="${name}"]`)];
  return elements.find((element) => element.getClientRects().length > 0) ?? elements[0] ?? document.body;
}

function removeActionAdvanceListener(element: Element): void {
  const listener = actionAdvanceListeners.get(element);
  if (!listener) return;
  element.removeEventListener("click", listener);
  actionAdvanceListeners.delete(element);
}

// driver.js 会忽略高亮动画期间的点击；等待动画状态清空后再推进，业务按钮本身仍立即响应。
function advanceAfterHighlightSettles(step: DriveStep, opts: Parameters<DriverHook>[2]): void {
  if (opts.driver.getActiveStep() !== step) return;
  if (opts.driver.getState("__transitionCallback")) {
    window.requestAnimationFrame(() => advanceAfterHighlightSettles(step, opts));
    return;
  }
  opts.driver.moveNext();
}
