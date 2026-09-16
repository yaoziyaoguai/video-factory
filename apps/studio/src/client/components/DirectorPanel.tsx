import { ArrowRight, CheckCircle2, CircleDashed, WandSparkles } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioOpportunity, StudioProvider } from "../../shared/api.js";
import { opportunityProductionAdvice, platformLabel } from "../presentation.js";

interface DirectorPanelProps {
  opportunity: StudioOpportunity;
  providers: StudioProvider[];
  providerError?: string;
  onProduce: () => void;
  /** 最近一轮热点候选的真实生成来源：配置就绪不等于最近一次模型任务成功。 */
  recentTopicGeneration?: "editor-model" | "rule-fallback";
}

const REQUIRED_CAPABILITIES = [
  ["script.draft", "脚本"],
  ["storyboard.plan", "导演"],
  ["asset.prepare", "画面"],
  ["voice.synthesize", "配音"],
  ["video.render", "渲染"],
  ["quality.review", "机器质检"],
] as const;

export function DirectorPanel({ opportunity, providers, providerError, onProduce, recentTopicGeneration }: DirectorPanelProps) {
  const capabilities = REQUIRED_CAPABILITIES.map(([capability, label]) => ({
    capability,
    label,
    available: providers.some((provider) => provider.capability === capability && provider.available && provider.kind !== "test"),
  }));
  const topicAdvice = opportunityProductionAdvice(opportunity);
  const productionReady = !providerError && capabilities.every((item) => item.available);
  const missingCapabilities = capabilities.filter((item) => !item.available).map((item) => item.capability);
  const hasTopicAgent = providers.some((provider) => provider.capability === "topic.intelligence" && provider.available && provider.kind !== "test");
  const topicIntelligenceCopy = opportunity.origin === "trend"
    ? "AI 提出热点角度；系统检查来源链接；关键事实仍需按来源核对"
    : opportunity.origin === "series"
      ? "系列选题、连续性检查与开拍前复核由 AI 系列总编完成"
      : "AI 提出自定义选题角度；系统检查来源链接；关键事实仍需按来源核对";

  return (
    <aside className="director-panel" aria-label="导演控制台" data-tour="director-panel">
      <header className="panel-heading">
        <div>
          <span>导演台</span>
          <h2>创意决策</h2>
        </div>
        <WandSparkles aria-hidden="true" size={19} />
      </header>

      <section className="director-brief">
        <span>主叙事</span>
        <strong>{opportunity.hook}</strong>
        <dl>
          <div><dt>受众</dt><dd>{opportunity.audience}</dd></div>
          <div><dt>平台</dt><dd>{platformLabel(opportunity.platform)}</dd></div>
          <div><dt>内容线</dt><dd>{opportunity.seriesName ?? (opportunity.origin === "trend" ? "热点选题" : opportunity.origin === "series" ? "系列内容" : "独立选题")}</dd></div>
        </dl>
      </section>

      <section className="capability-check">
        <h3>制作步骤</h3>
        {providerError ? <p className="director-inline-error">{providerError}</p> : null}
        {capabilities.map((item) => (
          <div key={item.capability}>
            {item.available ? <CheckCircle2 aria-hidden="true" size={15} /> : <CircleDashed aria-hidden="true" size={15} />}
            <span>{item.label}</span>
            <small>{providerError ? "未知" : item.available ? "可用" : "未配置"}</small>
          </div>
        ))}
      </section>

      <div className="model-state">
        <span>选题智能</span>
        <strong>{hasTopicAgent ? "AI 选题总编已配置" : "规则选题可用"}</strong>
        <small>{hasTopicAgent ? topicIntelligenceCopy : "当前使用可追溯规则评分，仍由你确认最终叙事"}</small>
        {hasTopicAgent && recentTopicGeneration === "rule-fallback" ? (
          <small>最近一轮热点生成使用了规则保底（总编模型轮未成功），候选会如实标注“待总编评估”。</small>
        ) : null}
      </div>

      <div className="director-actions">
        {topicAdvice ? <p className="director-topic-advice" role="note">提醒（仅供参考，不影响你开工）：{topicAdvice}</p> : null}
        <button className="button button-director" type="button" onClick={onProduce} disabled={!productionReady} data-tour="create-production">
          新建制作<ArrowRight aria-hidden="true" size={17} />
        </button>
        {!productionReady ? <Link className="director-resource-link" to={`/resources?missing=${encodeURIComponent(missingCapabilities.join(","))}#production-roles`}>查看缺失能力</Link> : null}
      </div>
    </aside>
  );
}
