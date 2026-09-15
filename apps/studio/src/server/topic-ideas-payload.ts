import type { StudioTopicStrategy } from "../shared/api.js";
import type { TrendModelSignal } from "./trend-opportunity-agent.js";

// topic-ideas 的 canonical 模型 payload 合同在 Studio/Broker 两个独立部署边界各自声明，
// 并由跨包合同测试锁定一致性；generationNonce 只参与生成身份，绝不进入模型 payload。
export const TOPIC_IDEAS_STRATEGY_MAX_LENGTH = 6_000;

export type TopicIdeasModelPayload = {
  signals: Array<Record<string, unknown>>;
  strategy?: string;
};

export type TopicIdeasIdentityInputs = {
  payload: TopicIdeasModelPayload;
  generationNonce?: string;
};

export function formatTopicStrategy(strategy: StudioTopicStrategy | undefined): string {
  const sections = [
    strategy?.positioning ? `内容定位：${strategy.positioning}` : undefined,
    strategy?.targetAudience ? `核心受众：${strategy.targetAudience}` : undefined,
    strategy?.preferredDirections ? `优先题材：\n${strategy.preferredDirections}` : undefined,
    strategy?.excludedDirections ? `明确避开：\n${strategy.excludedDirections}` : undefined,
    strategy?.sourcePolicy === "traceable_source"
      ? "来源工作流：来源开工门槛由下游执行；总编不得按来源数量淘汰角度。来源不足但内容与视觉潜力成立的角度仍须输出，供创作者补充原始来源；下游通常要求至少一个有效原始来源，高风险事实仍需额外核验。"
      : "来源工作流：来源开工门槛由下游执行；总编不得按来源数量淘汰角度。来源不足但内容与视觉潜力成立的角度仍须输出，供创作者补充来源；下游再核对原始来源或两个不同域名的独立来源。",
    strategy?.customInstruction.trim()
      ? `补充原则：${strategy.customInstruction.trim()}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  const text = sections.join("\n\n");
  if (text.length > TOPIC_IDEAS_STRATEGY_MAX_LENGTH) {
    throw new Error(`Topic strategy exceeds ${TOPIC_IDEAS_STRATEGY_MAX_LENGTH} characters.`);
  }
  return text;
}

function modelSignal(item: TrendModelSignal): Record<string, unknown> {
  return {
    id: item.id,
    sourceId: item.sourceId,
    platform: item.platform,
    rank: item.rank,
    title: item.title,
    heat: item.heat ?? null,
    ...(item.url ? { url: item.url } : {}),
    collectedAt: item.collectedAt,
    relatedSignals: item.relatedSignals.map((related) => ({
      id: related.id,
      sourceId: related.sourceId,
      platform: related.platform,
      rank: related.rank,
      title: related.title,
      heat: related.heat ?? null,
      ...(related.url ? { url: related.url } : {}),
      collectedAt: related.collectedAt,
    })),
    ...(item.articleSources?.length ? { articleSources: item.articleSources.map((source) => ({
      sourceId: source.sourceId,
      originalUrl: source.originalUrl,
      finalUrl: source.finalUrl,
      pageTitle: source.pageTitle,
      fetchedAt: source.fetchedAt,
      contentSha256: source.contentSha256 ?? null,
      extractorVersion: source.extractorVersion,
      readStatus: source.readStatus,
      reason: source.reason ?? null,
      paragraphs: source.paragraphs,
      truncated: source.truncated,
    })) } : {}),
  };
}

// 换一批（generationNonce）改变生成身份，但不改变模型 payload 的内容合同。
export function topicIdeasModelPayload(
  signals: TrendModelSignal[],
  strategy?: StudioTopicStrategy,
  generationNonce?: string,
): TopicIdeasIdentityInputs {
  const payload: TopicIdeasModelPayload = {
    signals: signals.map(modelSignal),
    ...(strategy ? { strategy: formatTopicStrategy(strategy) } : {}),
  };
  return {
    payload,
    ...(generationNonce ? { generationNonce } : {}),
  };
}
