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
