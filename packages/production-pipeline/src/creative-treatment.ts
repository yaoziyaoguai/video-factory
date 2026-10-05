export const CREATIVE_TREATMENT_VERSION = "video-factory/creative-treatment-v2" as const;
export const CREATIVE_TREATMENT_TASK_KIND = "creative-treatment" as const;
// capability 标识：Studio provider catalog 通过该常量识别构思能力；目录卡片仅在构思接入正式生产图时登记。
export const CREATIVE_TREATMENT_CAPABILITY = "creative.treatment" as const;
// 构思模型选择在 brief.models 中的能力键：与 codex-creative-treatment-v1 角色绑定同 id，
// 供 Studio 模型选择校验与 joint-v1 规划的阶段绑定模型显示共用。
export const CREATIVE_TREATMENT_PROVIDER_ID = "codex-creative-treatment-v1" as const;

const MAX_PROGRESSION_BEATS = 12;
const MIN_PRINCIPLES = 1;
const MAX_PRINCIPLES = 8;
const MAX_EVIDENCE_REQUIREMENTS = 24;
const MAX_FEASIBILITY_QUESTIONS = 24;

export interface CreativeTreatment {
  version: "video-factory/creative-treatment-v2";
  viewerPromise: string;
  hook: { narrationIntent: string; visualIntent: string };
  progression: Array<{ beatId: string; purpose: string; viewerGain: string }>;
  payoff: string;
  visualPrinciples: string[];
  soundPrinciples: string[];
  evidenceRequirements: Array<{
    beatId: string;
    claim: string;
    requirement: "factual_support" | "illustration_only";
    suppliedSourceIds: string[];
    critical: boolean;
    acquisition: "supplied" | "pipeline_retrievable" | "pipeline_generated" | "external_required" | "not_needed";
    // 保留既有字段名；检索与生成两种路线都显式绑定 Provider，不把可生成误写为已取得素材。
    retrievalProviderId: string | null;
  }>;
  feasibilityQuestions: Array<{ beatId: string; question: string }>;
}

export function parseCreativeTreatment(
  value: unknown,
  suppliedSourceIds: readonly string[],
): CreativeTreatment {
  const input = record(value, "Creative treatment");
  if (input.version !== CREATIVE_TREATMENT_VERSION) {
    throw new Error(`Creative treatment version must equal ${CREATIVE_TREATMENT_VERSION}.`);
  }
  const allowedSourceIds = new Set(suppliedSourceIds.map((sourceId) => sourceId.trim()));
  const hookInput = record(input.hook, "Creative treatment hook");
  if (!Array.isArray(input.progression)
    || input.progression.length < 1
    || input.progression.length > MAX_PROGRESSION_BEATS) {
    throw new Error(`Creative treatment progression must contain 1 to ${MAX_PROGRESSION_BEATS} beats.`);
  }
  const beatIds = new Set<string>();
  const progression = input.progression.map((entry, index) => {
    const beat = record(entry, `Creative treatment progression[${index}]`);
    const parsed = {
      beatId: text(beat.beatId, `Creative treatment progression[${index}].beatId`),
      purpose: text(beat.purpose, `Creative treatment progression[${index}].purpose`),
      viewerGain: text(beat.viewerGain, `Creative treatment progression[${index}].viewerGain`),
    };
    if (beatIds.has(parsed.beatId)) {
      throw new Error(`Creative treatment progression[${index}].beatId duplicates an earlier beatId.`);
    }
    beatIds.add(parsed.beatId);
    return parsed;
  });
  const evidenceRequirements = referenceArray(
    input.evidenceRequirements,
    "Creative treatment evidenceRequirements",
    MAX_EVIDENCE_REQUIREMENTS,
    (entry, index, beatId, beatIds) => {
      if (!beatIds.has(beatId)) {
        throw new Error(`Creative treatment evidenceRequirements[${index}].beatId must reference a progression beat.`);
      }
      const requirement = requirementValue(entry.requirement, `Creative treatment evidenceRequirements[${index}].requirement`);
      const supplied = stringArray(entry.suppliedSourceIds, `Creative treatment evidenceRequirements[${index}].suppliedSourceIds`);
      if (typeof entry.critical !== "boolean") {
        throw new Error(`Creative treatment evidenceRequirements[${index}].critical must be a boolean.`);
      }
      const acquisition = acquisitionValue(
        entry.acquisition,
        `Creative treatment evidenceRequirements[${index}].acquisition`,
      );
      const retrievalProviderId = nullableProviderId(
        entry.retrievalProviderId,
        `Creative treatment evidenceRequirements[${index}].retrievalProviderId`,
      );
      const pipelineAcquisition = acquisition === "pipeline_retrievable" || acquisition === "pipeline_generated";
      if (pipelineAcquisition && retrievalProviderId === null) {
        throw new Error(`Creative treatment evidenceRequirements[${index}].retrievalProviderId is required for ${acquisition}.`);
      }
      if (!pipelineAcquisition && retrievalProviderId !== null) {
        throw new Error(`Creative treatment evidenceRequirements[${index}].retrievalProviderId must be null unless acquisition is pipeline_retrievable or pipeline_generated.`);
      }
      if (requirement === "factual_support" && acquisition === "pipeline_generated") {
        throw new Error(`Creative treatment evidenceRequirements[${index}] cannot use pipeline_generated for factual_support.`);
      }
      if (requirement === "factual_support" && acquisition === "not_needed") {
        throw new Error(`Creative treatment evidenceRequirements[${index}] cannot mark factual_support as not_needed.`);
      }
      for (const sourceId of supplied) {
        if (!allowedSourceIds.has(sourceId)) {
          throw new Error(
            `Creative treatment evidenceRequirements[${index}].suppliedSourceIds references source id '${sourceId}' outside the supplied source set.`,
          );
        }
      }
      return {
        beatId,
        claim: text(entry.claim, `Creative treatment evidenceRequirements[${index}].claim`),
        requirement,
        suppliedSourceIds: supplied,
        critical: entry.critical,
        acquisition,
        retrievalProviderId,
      };
    },
    beatIds,
  );
  const feasibilityQuestions = referenceArray(
    input.feasibilityQuestions,
    "Creative treatment feasibilityQuestions",
    MAX_FEASIBILITY_QUESTIONS,
    (entry, index, beatId, beatIds) => {
      if (!beatIds.has(beatId)) {
        throw new Error(`Creative treatment feasibilityQuestions[${index}].beatId must reference a progression beat.`);
      }
      return {
        beatId,
        question: text(entry.question, `Creative treatment feasibilityQuestions[${index}].question`),
      };
    },
    beatIds,
  );
  return {
    version: CREATIVE_TREATMENT_VERSION,
    viewerPromise: text(input.viewerPromise, "Creative treatment viewerPromise"),
    hook: {
      narrationIntent: text(hookInput.narrationIntent, "Creative treatment hook.narrationIntent"),
      visualIntent: text(hookInput.visualIntent, "Creative treatment hook.visualIntent"),
    },
    progression,
    payoff: text(input.payoff, "Creative treatment payoff"),
    visualPrinciples: principles(input.visualPrinciples, "Creative treatment visualPrinciples"),
    soundPrinciples: principles(input.soundPrinciples, "Creative treatment soundPrinciples"),
    evidenceRequirements,
    feasibilityQuestions,
  };
}

// 宿主锁定唯一观众承诺：锁定值直接覆盖模型字段，不要求模型逐字重复；
// 构思内容与承诺的实质一致性由独立 role-audit 审查。
export function lockCreativeTreatmentViewerPromise(
  treatment: CreativeTreatment,
  lockedViewerPromise: string,
): CreativeTreatment {
  const locked = lockedViewerPromise.trim();
  if (!locked) throw new Error("Locked viewerPromise must be a non-empty string.");
  return { ...treatment, viewerPromise: locked };
}

/** CLOUD-11/P5.1：素材安排缺画面服务的结构化问题码；path/index 参数化，不硬编码数组位。 */
export type CreativeTreatmentIssueCode = "missing_retrieval_provider";

export interface CreativeTreatmentIssue {
  code: CreativeTreatmentIssueCode;
  /** 结构化定位，如 evidenceRequirements[4].retrievalProviderId。 */
  path: string;
  /** 该项在 evidenceRequirements 中的 0 基序号；界面用它说“第 N 项”。 */
  index: number;
  /** 该项的素材主张，作为定位线索；原稿缺失时省略。 */
  claim?: string;
  acquisition: "pipeline_generated" | "pipeline_retrievable";
  /** 人话说明：告诉用户缺什么、能做什么，不把代码 path 当主说明。 */
  message: string;
  /** 原英文诊断（parseCreativeTreatment 同款），供开发者详情/日志使用。 */
  technicalDetail: string;
}

/**
 * 只读诊断（不抛错）：列出 evidenceRequirements 中 acquisition 为
 * pipeline_generated/pipeline_retrievable 而 retrievalProviderId 为 null/缺失的项。
 * null（"is required for"腿）与 undefined/缺失（"must be null or a valid provider id"腿）
 * 都覆盖。解析不出的稿（缺数组/非对象）返回空——那是整体结构问题，交给硬校验拒绝。
 */
export function missingRetrievalProviderIssues(value: unknown): CreativeTreatmentIssue[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const requirements = (value as Record<string, unknown>).evidenceRequirements;
  if (!Array.isArray(requirements)) return [];
  const issues: CreativeTreatmentIssue[] = [];
  requirements.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const acquisition = record.acquisition;
    if (acquisition !== "pipeline_generated" && acquisition !== "pipeline_retrievable") return;
    const providerId = record.retrievalProviderId;
    if (providerId !== null && providerId !== undefined && providerId !== "") return;
    const claim = typeof record.claim === "string" && record.claim.trim() ? record.claim.trim() : "";
    issues.push({
      code: "missing_retrieval_provider",
      path: `evidenceRequirements[${index}].retrievalProviderId`,
      index,
      ...(claim ? { claim } : {}),
      acquisition,
      message: `第 ${index + 1} 项素材安排还没选择画面服务，暂不能采用这版。当前稿件和讨论已保留，请在素材安排里补齐后保存。`,
      technicalDetail: `Creative treatment evidenceRequirements[${index}].retrievalProviderId is required for ${acquisition}.`,
    });
  });
  return issues;
}

export interface RetrievalProviderSelectionChange {
  index: number;
  from: string | null;
  to: string | null;
  acquisition: "pipeline_generated" | "pipeline_retrievable";
}

/**
 * P5.2：比较两版 treatment 的 evidenceRequirements，列出本次编辑里 retrievalProviderId
 * 实际发生变化的项（按数组位置对齐；结构变化交给硬校验，这里不做猜测）。服务端边界
 * 只对“本次新补/改动”的字段核对目录兼容，不给旧有效稿追加新门禁。
 * CR3（2026-10-05 复审）：末尾新增行带出的新选择、以及取得方式改变（同一服务的交付
 * 类型兼容需重核）同样属于本次编辑引入的选择，不得绕过同一限制；新增行未选服务仍由
 * 结构校验拒绝，这里不产生记录。
 */
export function retrievalProviderSelectionChanges(current: unknown, next: unknown): RetrievalProviderSelectionChange[] {
  const currentRequirements = treatmentRequirementArray(current);
  const nextRequirements = treatmentRequirementArray(next);
  if (!currentRequirements || !nextRequirements) return [];
  const changes: RetrievalProviderSelectionChange[] = [];
  nextRequirements.forEach((entry, index) => {
    const acquisition = entry.acquisition;
    if (acquisition !== "pipeline_generated" && acquisition !== "pipeline_retrievable") return;
    const to = normalizedProviderValue(entry.retrievalProviderId);
    const previous = currentRequirements[index];
    if (!previous) {
      // 本次编辑新增的行：带服务的新选择受同一来源限制约束。
      if (to) changes.push({ index, from: null, to, acquisition });
      return;
    }
    const previousAcquisition = previous.acquisition;
    const from = normalizedProviderValue(previous.retrievalProviderId);
    if (from === to && previousAcquisition === acquisition) return;
    changes.push({ index, from, to, acquisition });
  });
  return changes;
}

function treatmentRequirementArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const requirements = (value as Record<string, unknown>).evidenceRequirements;
  if (!Array.isArray(requirements)) return undefined;
  return requirements.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry));
}

function normalizedProviderValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function referenceArray<T>(
  value: unknown,
  field: string,
  maximum: number,
  parseEntry: (entry: Record<string, unknown>, index: number, beatId: string, beatIds: Set<string>) => T,
  beatIds: Set<string>,
): T[] {
  // evidenceRequirements/feasibilityQuestions 是合同必填字段：缺失必须拒绝，
  // 与 Broker strict schema 及 checkpoint 恢复使用同一合法性定义；显式空数组仍然合法。
  if (value === undefined) {
    throw new Error(`${field} is required.`);
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${field} must be an array of at most ${maximum} entries.`);
  }
  return value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    return parseEntry(item, index, text(item.beatId, `${field}[${index}].beatId`), beatIds);
  });
}

function principles(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < MIN_PRINCIPLES || value.length > MAX_PRINCIPLES) {
    throw new Error(`${field} must contain ${MIN_PRINCIPLES} to ${MAX_PRINCIPLES} entries.`);
  }
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function requirementValue(value: unknown, field: string): "factual_support" | "illustration_only" {
  if (value !== "factual_support" && value !== "illustration_only") {
    throw new Error(`${field} must be factual_support or illustration_only.`);
  }
  return value;
}

function acquisitionValue(
  value: unknown,
  field: string,
): CreativeTreatment["evidenceRequirements"][number]["acquisition"] {
  if (value !== "supplied"
    && value !== "pipeline_retrievable"
    && value !== "pipeline_generated"
    && value !== "external_required"
    && value !== "not_needed") {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function nullableProviderId(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())) {
    throw new Error(`${field} must be null or a valid provider id.`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => text(entry, `${field}[${index}]`));
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}
