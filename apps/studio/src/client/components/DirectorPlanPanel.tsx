import { Clapperboard, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { STUDIO_DIRECTOR_PROFILES } from "../../shared/director-profiles.js";
import { providerLabel } from "../presentation.js";

interface DirectorPlanPanelProps {
  contentUrl: string;
}

interface DirectorPlanView {
  resolvedProfileId: string;
  profileRationale: string;
  visualBible: {
    narrativeApproach: string;
    pacing: string;
    composition: string;
    camera: string;
    color: string;
    sound: string;
  };
  shots: Array<{
    scenePosition: number;
    narrativeRole: string;
    authenticityPolicy: "evidence" | "illustrative" | "expressive";
    preferredProviderId: string;
    rationale: string;
    continuityNote: string;
  }>;
}

export function DirectorPlanPanel({ contentUrl }: DirectorPlanPanelProps) {
  const [plan, setPlan] = useState<DirectorPlanView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setPlan(undefined);
    setError(undefined);
    void fetch(contentUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseDirectorPlan(await response.json());
      })
      .then(setPlan)
      .catch((caught: unknown) => {
        if ((caught as Error).name !== "AbortError") setError("导演方案暂时无法读取，可从产物列表下载原始文件。");
      });
    return () => controller.abort();
  }, [contentUrl]);

  if (error) return <p className="director-plan-error">{error}</p>;
  if (!plan) return <div className="director-plan-loading"><LoaderCircle aria-hidden="true" size={15} />正在读取导演方案...</div>;

  const profile = STUDIO_DIRECTOR_PROFILES.find((item) => item.id === plan.resolvedProfileId);
  return (
    <section className="director-plan-panel" aria-label="导演方案">
      <header>
        <span><Clapperboard aria-hidden="true" size={16} />导演手记</span>
        <strong>{profile?.label ?? plan.resolvedProfileId}</strong>
      </header>
      <p>{plan.profileRationale}</p>
      <dl className="visual-bible-grid">
        <div><dt>叙事</dt><dd>{plan.visualBible.narrativeApproach}</dd></div>
        <div><dt>节奏</dt><dd>{plan.visualBible.pacing}</dd></div>
        <div><dt>构图</dt><dd>{plan.visualBible.composition}</dd></div>
        <div><dt>镜头</dt><dd>{plan.visualBible.camera}</dd></div>
        <div><dt>色彩</dt><dd>{plan.visualBible.color}</dd></div>
        <div><dt>声音</dt><dd>{plan.visualBible.sound}</dd></div>
      </dl>
      <div className="director-shot-list">
        {plan.shots.map((shot) => (
          <article key={shot.scenePosition}>
            <span>{String(shot.scenePosition).padStart(2, "0")}</span>
            <div>
              <strong>{shot.narrativeRole}<em>{authenticityLabel(shot.authenticityPolicy)}</em></strong>
              <p>{shot.rationale}</p>
              <small>{creatorProviderLabel(shot.preferredProviderId)} · {shot.continuityNote}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function creatorProviderLabel(providerId: string): string {
  const label = providerLabel(providerId);
  return label ?? "未识别的画面来源";
}

function parseDirectorPlan(value: unknown): DirectorPlanView {
  if (!value || typeof value !== "object") throw new Error("invalid director plan");
  const plan = value as DirectorPlanView;
  if (!plan.visualBible || !Array.isArray(plan.shots) || typeof plan.resolvedProfileId !== "string") {
    throw new Error("invalid director plan");
  }
  return plan;
}

function authenticityLabel(value: DirectorPlanView["shots"][number]["authenticityPolicy"]): string {
  return ({ evidence: "事实镜头", illustrative: "说明镜头", expressive: "表现镜头" })[value] ?? value;
}
