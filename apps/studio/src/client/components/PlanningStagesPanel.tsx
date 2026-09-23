import { CircleAlert, Cpu, FilePenLine, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { StudioNodeExecutionConfigurationDraft, StudioPlanningEditableStage, StudioPlanningStage, StudioProvider } from "../../shared/api.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { creatorFacingTechnicalText } from "../presentation.js";

function isEditablePlanningStage(stageId: StudioPlanningStage["id"]): stageId is StudioPlanningEditableStage {
  return stageId === "treatment" || stageId === "script" || stageId === "director";
}

// joint-v1 创作规划阶段面板：显示真实状态、当前实际模型与允许操作；阶段编辑/换模型走
// planningStageId 白名单 API。文案面向创作者，不出现 checkpoint/lease/审计耗尽等内部术语。

interface PlanningStagesPanelProps {
  stages: StudioPlanningStage[];
  providers: StudioProvider[];
  busy: boolean;
  readOnly: boolean;
  /** 宿主节点当前没有可编辑的输入版本时不传：此时给按钮只会点了没反应。 */
  onEditStageInput?: (stageId: StudioPlanningStage["id"]) => void;
  /** 面板只构造草稿；wire DTO 的并发基线由宿主在用户点击时补齐。 */
  onConfigureStage: (input: StudioNodeExecutionConfigurationDraft) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}

const STAGE_LABELS: Record<StudioPlanningStage["id"], string> = {
  treatment: "前期构思",
  script: "脚本",
  director: "导演方案",
  candidates: "候选画面",
  rank: "候选排序",
  integrate: "画面整合",
  compile: "正式方案",
};

const STAGE_STATUS_LABELS: Record<StudioPlanningStage["status"], string> = {
  pending: "待开始",
  running: "进行中",
  completed: "已产出",
  failed: "执行中断",
};

function stageStateLabel(stage: StudioPlanningStage): string {
  if (stage.decisionStatus === "waiting_user") return stage.reviewPurpose === "direction" ? "初稿已生成 · 等你确认" : "方案已生成 · 等你确认";
  if (stage.decisionStatus === "checking") return "正在复核你采用的这一版";
  if (stage.decisionStatus === "confirmed") return stage.reviewPurpose === "direction" ? "初稿已采用 · 接下来选材" : "已由你采用";
  return STAGE_STATUS_LABELS[stage.status];
}

const STAGE_CAPABILITY: Partial<Record<StudioPlanningStage["id"], string>> = {
  treatment: "creative.treatment",
  script: "script.draft",
  director: "storyboard.plan",
};

/** 保存只更新配置；已完成的阶段会失效，但模型调用仍由后续继续制作动作触发。 */
function stageModelNote(status: StudioPlanningStage["status"]): string {
  return status === "pending"
    ? "保存只记录模型选择；继续制作时才会使用，不会立即调用模型。"
    : "保存后受影响的阶段会标为待重做；由你继续制作时才重新执行，不会立即调用模型。";
}

function planningStageProvider(providers: StudioProvider[], stageId: StudioPlanningStage["id"]): StudioProvider | undefined {
  const capability = STAGE_CAPABILITY[stageId];
  if (!capability) return undefined;
  return providers.find((provider) => provider.capability === capability && provider.available);
}

export function PlanningStagesPanel({ stages, providers, busy, readOnly, onEditStageInput, onConfigureStage, onPendingChange }: PlanningStagesPanelProps) {
  const [stageModelDrafts, setStageModelDrafts] = useState<Record<string, string>>({});
  const [stageError, setStageError] = useState<string>();
  const [savingStageId, setSavingStageId] = useState<StudioPlanningEditableStage>();
  const hasPendingModelDraft = stages.some((stage) => isEditablePlanningStage(stage.id)
    && Boolean(stageModelDrafts[stage.id])
    && stageModelDrafts[stage.id] !== stage.effectiveModelId);
  const currentStage = stages.find((stage) => stage.decisionStatus === "waiting_user")
    ?? stages.find((stage) => stage.status === "failed" || stage.status === "running")
    ?? stages.find((stage) => stage.status === "pending")
    ?? stages.at(-1);

  useEffect(() => {
    onPendingChange?.(hasPendingModelDraft);
  }, [hasPendingModelDraft, onPendingChange]);

  async function changeStageModel(stageId: StudioPlanningEditableStage, providerId: string, modelId: string) {
    setStageError(undefined);
    setSavingStageId(stageId);
    try {
      await onConfigureStage({
        planningStageId: stageId,
        modelSelections: { [providerId]: modelId || null },
      });
      setStageModelDrafts((current) => {
        const next = { ...current };
        delete next[stageId];
        return next;
      });
    } catch (caught) {
      setStageError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingStageId(undefined);
    }
  }

  return (
    <section className="node-planning-stages" aria-label="创作规划阶段">
      <header><div><strong>当前工作</strong><p>{currentStage ? `${STAGE_LABELS[currentStage.id]} · ${stageStateLabel(currentStage)}` : "等待创作规划开始"}</p></div></header>
      {currentStage?.issue ? <p className="planning-stage-issue" role="status"><CircleAlert aria-hidden="true" size={15} />{creatorFacingTechnicalText(currentStage.issue)}</p> : null}
      <details className="planning-stage-details"><summary>查看制作细节</summary>
      <ul className="planning-stage-list">
        {stages.map((stage) => {
          const editable = !readOnly && !busy && stage.allowedActions.includes("edit_input")
            && isEditablePlanningStage(stage.id) && onEditStageInput !== undefined;
          return (
            <li key={stage.id} className={`planning-stage planning-stage-${stage.status}`}>
              <div className="planning-stage-head">
                <span className="planning-stage-name">{STAGE_LABELS[stage.id]}</span>
                <span className={`planning-stage-status status-${stage.status}`}>{stageStateLabel(stage)}</span>
              </div>
              {stage.issue ? <p className="planning-stage-issue"><CircleAlert aria-hidden="true" size={13} /> {creatorFacingTechnicalText(stage.issue)}</p> : null}
              {editable && isEditablePlanningStage(stage.id) ? (
                <button className="button button-ghost" type="button" onClick={() => onEditStageInput?.(stage.id)}>
                  <FilePenLine aria-hidden="true" size={14} /> 编辑这一阶段的输入
                </button>
              ) : null}
            </li>
          );
        })}
      </ul></details>
      <details className="planning-stage-settings"><summary>制作设置{hasPendingModelDraft ? " · 有未保存的模型选择" : ""}</summary>
        <p>修改只重做受影响的阶段：改构思会重做后续全部；改脚本保留构思；改导演方案保留构思和脚本。</p>
        {stages.filter((stage) => isEditablePlanningStage(stage.id)).map((stage) => {
          const provider = providers.find((candidate) => candidate.id === stage.providerId && candidate.available)
            ?? planningStageProvider(providers, stage.id);
          const models = provider ? selectableModelsForCapability(provider.modelProfiles, provider.capability) : [];
          const canChangeModel = !readOnly && !busy && stage.allowedActions.includes("change_model") && Boolean(provider) && models.length > 0;
          const draftModel = stageModelDrafts[stage.id] ?? "";
          return <div key={stage.id} className="planning-stage-setting">
            <strong>{STAGE_LABELS[stage.id]}</strong>
            {stage.effectiveModelId ? <span className="planning-stage-model"><Cpu aria-hidden="true" size={13} />{stage.effectiveModelId}</span> : null}
            {canChangeModel && provider ? (
                <label className="field planning-stage-model-select">
                  <span>{stage.id === "treatment" ? "构思" : stage.id === "script" ? "脚本" : "导演方案"}阶段模型</span>
                  <select
                    value={draftModel || stage.effectiveModelId || provider.defaultModelId || ""}
                    onChange={(event) => {
                      setStageModelDrafts((current) => ({ ...current, [stage.id]: event.target.value }));
                      setStageError(undefined);
                    }}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}{model.recommended ? "（推荐）" : ""}</option>
                    ))}
                  </select>
                  <small><RefreshCw aria-hidden="true" size={12} /> {stageModelNote(stage.status)}</small>
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={!draftModel || draftModel === stage.effectiveModelId || savingStageId === stage.id}
                    onClick={() => {
                      if (isEditablePlanningStage(stage.id)) {
                        void changeStageModel(stage.id, provider.id, draftModel);
                      }
                    }}
                  >
                    <Save aria-hidden="true" size={14} />{savingStageId === stage.id ? "保存中…" : "保存模型选择"}
                  </button>
                </label>
              ) : null}
          </div>;
        })}
      </details>
      {stageError ? <p className="form-error" role="alert">{stageError}</p> : null}
    </section>
  );
}
