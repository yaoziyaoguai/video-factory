import { ArrowRight, CheckCircle2, CircleDashed, WandSparkles } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudioOpportunity, StudioProvider } from "../../shared/api.js";
import { platformLabel } from "../presentation.js";

interface DirectorPanelProps {
  opportunity: StudioOpportunity;
  providers: StudioProvider[];
  providerError?: string;
  onProduce: () => void;
}

const REQUIRED_CAPABILITIES = [
  ["script.draft", "脚本"],
  ["storyboard.plan", "导演"],
  ["asset.prepare", "画面"],
  ["voice.synthesize", "配音"],
  ["video.render", "渲染"],
  ["quality.review", "机器质检"],
] as const;

export function DirectorPanel({ opportunity, providers, providerError, onProduce }: DirectorPanelProps) {
  const capabilities = REQUIRED_CAPABILITIES.map(([capability, label]) => ({
    capability,
    label,
    available: providers.some((provider) => provider.capability === capability && provider.available && provider.kind !== "test"),
  }));
  const productionReady = !providerError && capabilities.every((item) => item.available);
  const hasTopicAgent = providers.some((provider) => provider.capability === "topic.intelligence" && provider.available && provider.kind !== "test");
  const topicIntelligenceCopy = opportunity.origin === "trend"
    ? "热点转译、机会评分与证据门禁由 Codex 执行"
    : opportunity.origin === "series"
      ? "系列选题、连续性检查与开拍审计由 Codex 执行"
      : "自定义命题复核、机会评分与证据门禁由 Codex 执行";

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
        <h3>生产链路</h3>
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
        <strong>{hasTopicAgent ? "Codex 选题总编已接入" : "规则总编可用"}</strong>
        <small>{hasTopicAgent ? topicIntelligenceCopy : "当前使用可追溯规则评分，仍由你确认最终叙事"}</small>
      </div>

      <div className="director-actions">
        <button className="button button-director" type="button" onClick={onProduce} disabled={!productionReady} data-tour="create-production">
          新建制作<ArrowRight aria-hidden="true" size={17} />
        </button>
        {!productionReady ? <Link className="director-resource-link" to="/resources">查看缺失能力</Link> : null}
      </div>
    </aside>
  );
}
