import { CircleAlert, Cpu, FilePenLine, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { StudioNodeExecutionConfigurationDraft, StudioPlanningEditableStage, StudioPlanningStage, StudioProvider } from "../../shared/api.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";

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
  onEditStageInput: (stageId: StudioPlanningStage["id"]) => void;
  /** 面板只构造草稿；wire DTO 的并发基线由宿主在用户点击时补齐。 */
  onConfigureStage: (input: StudioNodeExecutionConfigurationDraft) => Promise<void>;
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
  completed: "已完成",
  failed: "未通过",
};

const STAGE_CAPABILITY: Partial<Record<StudioPlanningStage["id"], string>> = {
  treatment: "creative.treatment",
  script: "script.draft",
  director: "storyboard.plan",
};

function planningStageProvider(providers: StudioProvider[], stageId: StudioPlanningStage["id"]): StudioProvider | undefined {
  const capability = STAGE_CAPABILITY[stageId];
  if (!capability) return undefined;
  return providers.find((provider) => provider.capability === capability && provider.available);
}

export function PlanningStagesPanel({ stages, providers, busy, readOnly, onEditStageInput, onConfigureStage }: PlanningStagesPanelProps) {
  const [stageModelDrafts, setStageModelDrafts] = useState<Record<string, string>>({});
  const [stageError, setStageError] = useState<string>();

  async function changeStageModel(stageId: StudioPlanningEditableStage, providerId: string, modelId: string) {
    setStageError(undefined);
    try {
      await onConfigureStage({
        planningStageId: stageId,
        modelSelections: { [providerId]: modelId || null },
      });
    } catch (caught) {
      setStageError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="node-planning-stages" aria-label="创作规划阶段">
      <header>
        <div>
          <strong>创作规划阶段</strong>
          <small>修改只重做受影响的阶段：改构思会重做后续全部；改脚本保留构思；改导演方案保留构思和脚本。</small>
        </div>
      </header>
      <ul className="planning-stage-list">
        {stages.map((stage) => {
          // 模型选择解析“当前制作绑定的提供者”，不按能力目录顺序取第一个可用者——
          // 同一能力可能有多个提供者，绑定错了服务端会拒绝一次正常操作。
          const provider = providers.find((candidate) => candidate.id === stage.providerId && candidate.available)
            ?? planningStageProvider(providers, stage.id);
          const models = provider ? selectableModelsForCapability(provider.modelProfiles, provider.capability) : [];
          const editable = !readOnly && !busy && stage.allowedActions.includes("edit_input")
            && isEditablePlanningStage(stage.id);
          const canChangeModel = !readOnly && !busy && stage.allowedActions.includes("change_model")
            && isEditablePlanningStage(stage.id) && Boolean(provider) && models.length > 0;
          const draftModel = stageModelDrafts[stage.id] ?? "";
          return (
            <li key={stage.id} className={`planning-stage planning-stage-${stage.status}`}>
              <div className="planning-stage-head">
                <span className="planning-stage-name">{STAGE_LABELS[stage.id]}</span>
                <span className={`planning-stage-status status-${stage.status}`}>{STAGE_STATUS_LABELS[stage.status]}</span>
                {stage.effectiveModelId ? (
                  <span className="planning-stage-model"><Cpu aria-hidden="true" size={13} /> {stage.effectiveModelId}</span>
                ) : null}
              </div>
              {stage.issue ? <p className="planning-stage-issue"><CircleAlert aria-hidden="true" size={13} /> {stage.issue}</p> : null}
              {editable && isEditablePlanningStage(stage.id) ? (
                <button className="button button-ghost" type="button" onClick={() => onEditStageInput(stage.id)}>
                  <FilePenLine aria-hidden="true" size={14} /> 编辑这一阶段的输入
                </button>
              ) : null}
              {canChangeModel && provider ? (
                <label className="field planning-stage-model-select">
                  <span>下次使用{stage.id === "treatment" ? "构思" : stage.id === "script" ? "脚本" : "导演方案"}模型</span>
                  <select
                    value={draftModel || stage.effectiveModelId || provider.defaultModelId || ""}
                    onChange={(event) => {
                      setStageModelDrafts((current) => ({ ...current, [stage.id]: event.target.value }));
                      if (isEditablePlanningStage(stage.id)) {
                        void changeStageModel(stage.id, provider.id, event.target.value);
                      }
                    }}
                  >
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}{model.recommended ? "（推荐）" : ""}</option>
                    ))}
                  </select>
                  <small><RefreshCw aria-hidden="true" size={12} /> 换模型后会重新执行这一阶段开始的后续部分。</small>
                </label>
              ) : null}
            </li>
          );
        })}
      </ul>
      {stageError ? <p className="form-error" role="alert">{stageError}</p> : null}
    </section>
  );
}
