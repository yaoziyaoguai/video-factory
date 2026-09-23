import type { StudioAgentLoopProgress, StudioCandidateInboxItem, StudioOpportunity, StudioRunFailure, StudioRunSummary } from "../shared/api.js";

export const RUN_NODE_LABELS: Record<string, string> = {
  brief: "内容简报",
  "creative-planning": "创作规划",
  script: "脚本",
  "reference-grammar": "参考视频风格分析",
  "visual-direction": "导演方案",
  "asset-candidates": "候选素材",
  "asset-semantic-rank": "候选画面排序",
  assets: "画面",
  "asset-source-review": "生成画面预检",
  voice: "配音",
  render: "渲染",
  "technical-review": "机器质检",
  "visual-review": "视觉审片",
  "final-review": "人工终审",
  "publish-package": "发布文案与发布包",
};

/**
 * 旧版线性流程的固定工序（不含 joint-v1 收敛出来的创作规划节点）。写成字面量而不是
 * `Object.keys(RUN_NODE_LABELS)`：后者意味着"给某个节点补一个中文名"会顺手改掉旧 run 进度条的
 * 格子数，而这两件事没有关系——补名字不该动顺序，动顺序也不该靠加名字。
 */
export const RUN_NODE_ORDER: readonly string[] = [
  "brief",
  "script",
  "reference-grammar",
  "visual-direction",
  "asset-candidates",
  "asset-semantic-rank",
  "assets",
  "asset-source-review",
  "voice",
  "render",
  "technical-review",
  "visual-review",
  "final-review",
  "publish-package",
];

export function runNodeLabel(nodeId: string): string {
  return RUN_NODE_LABELS[nodeId] ?? "当前步骤";
}

/** 列表和详情共用服务端阶段，不把所有人工停点都称为成片审片。 */
export function creatorRunStatusLabel(run: Pick<StudioRunSummary, "status" | "currentNodeId" | "continuation">): string | undefined {
  if (isHistoricalReadOnlyRun(run)) return "历史只读";
  if (run.status !== "needs_human") return undefined;
  if (run.currentNodeId === "final-review") return "等你审片";
  return `等你确认${runNodeLabel(run.currentNodeId)}`;
}

export function creatorReviewAction(run: Pick<StudioRunSummary, "currentNodeId">): string {
  return run.currentNodeId === "final-review" ? "进入审片" : RUN_NODE_LABELS[run.currentNodeId] ? "查看并确认方案" : "查看本步骤并决定是否继续";
}

export function isHistoricalReadOnlyRun(run: Pick<StudioRunSummary, "continuation">): boolean {
  return run.continuation?.supported === false;
}

export function runNeedsCreatorAction(run: Pick<StudioRunSummary, "status" | "continuation" | "archivedAt">): boolean {
  if (run.archivedAt || isHistoricalReadOnlyRun(run)) return false;
  return [
    "needs_human",
    "awaiting_spend_approval",
    "approval_invalidated",
    "failed",
    "stale",
    "rejected",
  ].includes(run.status);
}

export interface SourceAssetReviewBreakdown {
  conclusion: string[];
  sceneFindings: string[];
  preservedContent: string[];
  nextSteps: string[];
}

export function sourceAssetReviewBreakdown(failure: StudioRunFailure): SourceAssetReviewBreakdown {
  const detail = (creatorFacingTechnicalText(failure.technicalDetail) ?? "").replace(/\s+/g, " ").trim();
  const sceneMarkers = [...detail.matchAll(/镜头\s*(\d+)[：:]\s*/g)];
  const prefix = sceneMarkers.length > 0 ? detail.slice(0, sceneMarkers[0]!.index).trim() : detail;
  const conclusion = uniqueText([
    failure.summary,
    ...splitSentences(prefix),
  ]);
  const sceneFindings: string[] = [];
  const detailNextSteps: string[] = [];
  for (const [index, marker] of sceneMarkers.entries()) {
    const contentStart = (marker.index ?? 0) + marker[0].length;
    const contentEnd = sceneMarkers[index + 1]?.index ?? detail.length;
    let content = detail.slice(contentStart, contentEnd).trim();
    if (index === sceneMarkers.length - 1) {
      const nextStep = content.match(/(?:^|\s)(请(?:调整|切换|重新|先到)[\s\S]*)$/)?.[1]?.trim();
      if (nextStep) {
        content = content.slice(0, content.lastIndexOf(nextStep)).trim();
        detailNextSteps.push(nextStep);
      }
    }
    if (content) sceneFindings.push(`镜头 ${marker[1]}：${content}`);
  }
  return {
    conclusion,
    sceneFindings: uniqueText(sceneFindings),
    preservedContent: uniqueText([
      failure.impact,
      `已保留前面 ${failure.savedNodeCount} 个步骤的结果`,
    ]),
    nextSteps: uniqueText([
      ...detailNextSteps,
      ...failure.recoveryActions.map((action) => creatorFacingTechnicalText(action) ?? action),
    ]),
  };
}

function splitSentences(value: string): string[] {
  return value.match(/[^。！？!?]+[。！？!?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function uniqueText(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value, index, items) => value.length > 0 && items.indexOf(value) === index);
}

export { platformLabel } from "../shared/platform-label.js";

export function providerLabel(providerId?: string): string | undefined {
  if (!providerId) return undefined;
  return ({
    "inline:brief": "VideoFactory 制片",
    "inline:final-review": "人工终审",
    "inline:publish-package": "本地发布编排",
    "human-editor-private-state": "人工编辑记录",
    "human-validated-director-plan-v1": "人工确认导演方案",
    multiple: "多来源制作记录",
    "video-factory-ts-v1": "VideoFactory 本地编排",
    "python-template-v1": "本地模板脚本",
    "codex-screenwriter-v1": "AI 编剧",
    "api-visual-director-v1": "AI 视觉导演",
    "codex-reference-grammar-v1": "AI 参考视频分析",
    "codex-asset-ranker-v1": "AI 候选画面排序",
    "asset-candidate-search-v1": "图库候选搜索",
    "codex-publish-copy-v1": "AI 发行编辑",
    "ai-shot-router-v1": "AI 逐镜选择画面来源",
    "human-editor": "人工编辑",
    "local-editorial-v1": "本地编辑画面",
    "pexels-stock-v1": "Pexels 图库",
    "pixabay-stock-v1": "Pixabay 图库",
    "unsplash-stock-v1": "Unsplash 图片",
    "coverr-stock-v1": "Coverr 视频",
    "wikimedia-stock-v1": "Wikimedia 图片与视频",
    "met-stock-v1": "Met 开放馆藏图片",
    "cleveland-stock-v1": "Cleveland 开放馆藏图片",
    "archive-stock-v1": "Internet Archive 开放视频",
    "nasa-stock-v1": "NASA 科学图片与视频",
    "openverse-stock-v1": "Openverse 开放图片",
    "seedream-image-v1": "Seedream 图片生成",
    "seedance-video-v1": "Seedance 视频生成",
    "wan-video-v1": "百炼 · 通义万相视频",
    "hailuo-video-v1": "MiniMax 视频生成",
    "macos-say-v1": "macOS 系统配音",
    "python-ffmpeg-v1": "FFmpeg 本地渲染",
    "python-technical-review-v1": "本地机器质检",
    "codex-visual-review-v1": "AI 视觉审片",
    "deepseek-visual-review-v1": "视觉审片员",
    "codex-role-auditor-v1": "AI 独立质量复核",
    openai: "AI 创作服务",
    pexels: "Pexels 图库",
    pixabay: "Pixabay 图库",
    unsplash: "Unsplash 图片",
    coverr: "Coverr 视频",
    wikimedia: "Wikimedia 图片与视频",
    met: "Met 开放馆藏图片",
    cleveland: "Cleveland 开放馆藏图片",
    archive: "Internet Archive 开放视频",
    nasa: "NASA 科学图片与视频",
    openverse: "Openverse 开放图片",
    local: "本地编辑画面",
    minimax: "MiniMax",
    "minimax-tts-v1": "MiniMax 中文配音",
    seedance: "Seedance",
  } as Record<string, string>)[providerId] ?? `服务名称未收录（${displayIdentifier(providerId)}）`;
}

export function providerModelLabel(
  provider: { defaultModelId?: string; modelProfiles?: Array<{ id: string; label: string }> } | undefined,
  modelId?: string,
): string {
  if (!modelId) return "自动选择";
  return provider?.modelProfiles?.find((model) => model.id === modelId)?.label ?? `模型名称未收录（${displayIdentifier(modelId)}）`;
}

function displayIdentifier(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80) || "标识未记录";
}

export function catalogModelLabel(providers: Array<{ modelProfiles?: Array<{ id: string; label: string }> }>, modelId?: string): string | undefined {
  if (!modelId) return undefined;
  for (const provider of providers) {
    const label = provider.modelProfiles?.find((model) => model.id === modelId)?.label;
    if (label) return label;
  }
  return undefined;
}

export function creatorFacingTechnicalText(value?: string): string | undefined {
  if (!value) return undefined;
  const text = value
    // 桥接失败消息尾部的机器诊断（`\n诊断：stage=…；reasonCode=…`）。它和下面那串
    // key=value 一样，是给操作员定位用的：创作者读不懂，也不该读到。
    .replace(/诊断：(?:[A-Za-z][A-Za-z0-9]*=[^；。\n]*(?:[；。]|$))+/g, "")
    .replace(/\b(?:stage|httpStatus|failureKind|reasonCode|fieldPath|taskKind|requestIdHash|accepted)=[^\s；，。]*[；，]?/g, "")
    // 候选耗尽的叙述整段换掉：后面跟着的逐个候选是操作员的定位信息（模型身份、
    // "输出未通过合同（reasonCode）"）。只翻译开头那句会把模型名与合同术语留在屏幕上，
    // 而创作者需要知道的只有"都试过了、都没成"。
    .replace(/([^\n；。]*?)\s*\d+\s*个候选模型均未能完成[:：][^。\n]*。?/g, "$1候选模型都没能给出可用结果。")
    .replace(/([^\n；。]*?)前\s*\d+\s*个候选模型调用失败，已自动切换[^\n]*/g, "$1已自动换用下一个可用模型。")
    // 没有明细可带的短句（缓存里的历史文案）只翻这一句。
    .replace(/(\d+)\s*个候选模型均未能完成/g, "已尝试 $1 个模型，都没能给出可用结果")
    .replace(/已按\s+hook_and_scene_midpoints\s+的稀疏证据逐场核对。?/gi, "已抽查各镜头关键帧，未覆盖逐帧运动与声音。")
    .replace(/画面\s+Provider/gi, "画面服务")
    .replace(/\bstudio-owner\b/gi, "由你确认")
    .replace(/需要[^。]*VIDEO_FACTORY_[A-Z0-9_]+[^。]*。?\s*当前：[^。]*。?/gi, "AI 创作服务尚未连接，请到“创作设置 → 制作分工”检查服务状态。")
    .replace(/Pexels free stock license; review current provider license before publishing\.?/gi, "Pexels 免费图库素材；发布前需核对当前授权条款。")
    .replace(/Pixabay Content License; cache API responses for 24h and avoid systematic mass downloads\.?/gi, "Pixabay 内容许可；接口响应缓存 24 小时，并避免系统性批量下载。")
    .replace(/Human-selected media retained with immutable bytes and run-local provenance\.?/gi, "保留人工选中的原始素材，并记录本次制作中的来源信息。")
    .replace(/Human-edited derivative retained as an immutable revision\.?/gi, "保留人工编辑后的素材版本，便于追溯修改记录。")
    .replace(/VideoFactory generated script; human review required before publishing\.?/gi, "AI 生成脚本；发布前需要人工核对事实与表述。")
    .replace(/License snapshot is stored per scene asset in this plan\.?/gi, "本方案按镜头保存了每项素材的授权记录。")
    .replace(/Asset rights require review\.?/gi, "素材使用权需要人工核对。")
    .replace(/Locally generated narration; verify the selected voice provider terms\.?/gi, "本机生成的配音；发布前需核对所选配音服务的使用条款。")
    .replace(/VideoFactory voice timeline metadata\.?/gi, "配音时间轴记录。")
    .replace(/Composite output; see the linked asset and voiceover plans for source terms\.?/gi, "合成成片；素材与配音的来源条款请查看关联的画面和配音方案。")
    .replace(/VideoFactory render metadata\.?/gi, "成片渲染记录。")
    .replace(/VideoFactory technical review result\.?/gi, "机器质检结果。")
    .replace(/Immutable execution trace containing the exact prompt, prompt pack, provider, and model; no credentials are stored\.?/gi, "保存了本次使用的提示、配置、服务和模型，不包含任何密钥。")
    .replace(/AI-directed per-shot asset plan with actual provider provenance\.?/gi, "按导演逐镜方案生成的画面清单，并保留每个镜头的实际来源。")
    .replace(/External generation task IDs retained for audit\.?/gi, "保留生成任务编号，便于核对服务状态与账单。")
    .replace(/AI-generated (?:image|video) selected by the director plan; review terms, likeness rights, and AIGC disclosure\.?/gi, "由导演方案选中的 AI 画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/AI-generated (?:image|video); review provider terms, likeness rights, and AIGC disclosure before publishing\.?/gi, "AI 生成画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/AI-generated script; facts and claims require human review before publication\.?/gi, "AI 生成脚本；发布前需要人工核对事实与表述。")
    .replace(/Independent role audit and bounded repair history; credentials and hidden reasoning are not stored\.?/gi, "保存独立质量复核与有限轮次修订记录，不包含密钥或模型内部推理。")
    .replace(/Preview-only candidate metadata; no media was downloaded by this node\.?/gi, "只保存候选素材信息，这一步没有下载素材。")
    .replace(/Candidate ranking only; no source media was downloaded or altered\.?/gi, "只保存候选排序结果，没有下载或修改原始素材。")
    .replace(/Series Bible/gi, "系列设定")
    .replace(/\bCanon\b/gi, "已确认内容")
    .replace(/Codex\s*独立质量审计(?:\s*Agent)?/gi, "Codex 独立质量复核")
    .replace(/独立质量审计\s*Agent/gi, "AI 独立质量复核")
    .replace(/独立质量审计/g, "独立质量复核")
    .replace(/独立审计/g, "独立复核")
    .replace(/质量审计/g, "质量复核")
    .replace(/审计意见/g, "复核意见")
    .replace(/审计结论/g, "复核结论")
    .replace(/\bAgent\b/gi, "AI")
    .replace(/\bProvider\b/gi, "服务")
    .replace(/\bBroker\b/gi, "AI 服务")
    .replace(/\bSchema\b/gi, "数据格式")
    .replace(/\bManifest\b/gi, "资源清单")
    .replace(/\bFallback\b/gi, "备用方案")
    .replace(/\btaskId\b/gi, "任务编号")
    .replace(/\s*\bhook_and_scene_midpoints\b\s*/gi, "逐镜关键画面抽查")
    .replace(/\s*\bscene_triplets\b\s*/gi, "逐镜首中尾抽查")
    .replace(/\s*\bscene_change_keyframes\b\s*/gi, "场景变化关键画面抽查")
    .replace(/\s*\bsource_assets\b\s*/gi, "源素材预检")
    .replace(/manualReplacement/gi, "人工补充素材")
    // 上面几条具名的内部键都翻译完了，剩下的裸 snake_case 就是失败原因码（如 invalid_json），
    // 对创作者没有意义，连同括号一起去掉。
    .replace(/（[a-z][a-z0-9]*(?:_[a-z0-9]+)+）/g, "")
    .replace(/primary\s+服务\s+timed\s+out/gi, "首选服务响应超时")
    .replace(/服务\s+timed\s+out/gi, "服务响应超时")
    .replace(/服务\s+unavailable/gi, "服务暂时不可用")
    .replace(/\b[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)+-v\d+\b/gi, "内部能力")
    .replace(/\bMCP\b/gi, "标准接口")
    .replace(/\bCode Plan\b/gi, "订阅额度")
    .replace(/\bTTS API\b/gi, "云端配音服务")
    .replace(/\bAPI\b/gi, "服务接口")
    .replace(/\bSQLite\b/gi, "本地历史记录")
    .replace(/xhigh\s*推理/gi, "深入推理")
    .replace(/阻断门禁/g, "不通过则要求修改")
    .replace(/技术门禁/g, "技术检查")
    .replace(/产物校验/g, "文件校验")
    .replace(/结构化输出/g, "按固定格式交付")
    .replace(/绿灯审计/g, "开拍前复核")
    .replace(/本地生成/g, "在本机生成")
    .replace(/异步生成/g, "后台生成")
    .replace(/统一任务协议/g, "统一调用")
    .trim();
  return text || "本次调用未完成，当前记录没有可读的失败说明。请查看本步骤的状态和可用处理方式。";
}

/**
 * 角色循环的轮次与阶段说明。停在用户面前的那一版和节点工作区里显示的是同一件事，
 * 两处必须说同一句话——各写一份迟早会漂移成两种说法。
 */
export function agentLoopPhaseLabel(progress: StudioAgentLoopProgress): string {
  const phase = progress.phase === "auditing"
    ? "独立复核中"
    : progress.phase === "repairing"
      ? "按复核意见修订中"
      : progress.phase === "passed"
        ? "独立复核已通过"
        : progress.phase === "exhausted"
        ? "自动修订已停止"
          : progress.phase === "awaiting_user"
            ? "自动修订轮次已用尽，这一版与复核意见交给你裁决"
          : progress.phase === "halted"
            ? "发现当前角色无法解决的前提，已停住"
          : progress.phase === "failed"
            ? progress.failureSummary?.trim() ? "模型调用已停止，请查看失败原因" : "模型调用已停止"
          : "AI 创作中";
  return `第 ${progress.iteration} / ${progress.maxIterations} 轮 · ${phase}`;
}

/**
 * 复核结论还没出来时，`latestAudit` 那一格该说什么。它缺失并不代表"还在跑"：`latestAudit`
 * 取自已完成轮次里的审计，所以调用失败、还没产出、以及被人工处理过的历史节点都会走到这里。
 * 这里曾经一律用现在进行时，于是「模型调用已停止」下面紧跟一句「正在生成本轮方案」——
 * 用户会以为系统还在工作，只是暂时没结果，而实际上它已经停了。
 */
export function agentLoopPendingNote(progress: StudioAgentLoopProgress): string {
  const reason = progress.phase === "failed" ? progress.failureSummary?.trim() : undefined;
  if (reason) return creatorFacingTechnicalText(reason) ?? reason;
  // 旧记录里只存了机器诊断，没有面向人的那句说明。这里不能指向"诊断信息"之类并不存在于
  // 界面的东西——那正是原来那句「请查看失败原因」的毛病。只说清能做什么。
  if (progress.phase === "failed") return "本次调用已停止，但这条记录没有留下可读的原因记录。请根据本步骤显示的操作决定是否继续。";
  if (progress.phase === "halted") return "这一步停住了：它需要的前提当前角色给不出来，补上才能继续。";
  if (progress.phase === "auditing") return "独立质量复核正在进行，尚未返回本轮结论。";
  if (progress.phase === "repairing") return "正在按复核意见修订本轮方案。";
  if (progress.phase === "exhausted") return "自动修订已停止。请查看已有结果和复核意见，再决定下一步。";
  if (progress.phase === "awaiting_user") return "正在等待你的决定，没有继续自动修订。";
  if (progress.phase === "passed") return "本轮状态记录为复核通过，当前未附可展示的报告详情。";
  if (progress.phase === "producing") return "正在生成本轮方案，完成后由独立 AI 做质量复核。";
  return "当前阶段暂无法识别，请查看最新制作状态。";
}

// 返回"为什么建议先别做这条选题"的理由，供界面醒目标注。
// 它只是建议：调用方不得用它来禁用开工，否则模型的一票就变成了硬闸门。
export function opportunityProductionAdvice(
  opportunity: Pick<StudioOpportunity, "verification" | "editorialDecision">,
): string | undefined {
  if (opportunity.verification?.status === "blocked") {
    return opportunity.verification.reasons[0] ?? "来源证据未达到当前标准。";
  }
  if (opportunity.editorialDecision?.verdict === "skip") {
    return opportunity.editorialDecision.reasons[0] ?? "选题总编不建议现在做这条选题。";
  }
  return undefined;
}

export function reasoningEffortLabel(value: unknown): string {
  if (value === undefined || value === null || value === "") return "使用服务默认推理设置";
  if (value === "none" || value === "minimal" || value === "low") return "快速判断";
  if (value === "medium") return "标准推理";
  if (value === "high" || value === "xhigh") return "深入推理";
  if (value === "max" || value === "ultra") return "最高强度推理";
  return `推理强度值未识别：${displayIdentifier(String(value))}；是否支持待核对。`;
}

export function proposalSourceLabel(providerId: string): string {
  if (providerId === "series-planner-v1") return "系列策划器";
  if (providerId === "api-topic-editor-v1") return "AI 选题总编";
  if (providerId.includes("heuristic") || providerId.includes("deterministic")) return "本地规则提案";
  return `提案来源名称未收录（${displayIdentifier(providerId)}）`;
}

export const TOPIC_CATEGORY_LABELS = {
  society: "社会",
  "finance-career": "财经职场",
  technology: "科技",
  lifestyle: "生活",
  "health-sports": "健康体育",
  education: "教育",
  entertainment: "文娱",
  "local-culture": "华人地方",
  food: "美食",
  travel: "文旅出行",
  gaming: "游戏电竞",
  automotive: "汽车",
  "fashion-beauty": "时尚美妆",
  parenting: "亲子家庭",
  "agriculture-rural": "三农乡村",
} as const;

export function scoreSourceLabel(source: string): string {
  if (source.startsWith("人工维度评分") || source.startsWith("录入时估分")) return "录入时估分";
  if (source.startsWith("历史记录")) return "历史评分";
  return source.replace(/\s*·\s*[a-z0-9._:-]+$/i, "");
}
