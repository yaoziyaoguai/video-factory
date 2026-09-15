import assert from "node:assert/strict";
import { test } from "node:test";

// Revision 9 source/dist 合同探针：只走正式 parser 与正式构建产物，不执行外部模型。
const layer = process.env.VF_REVIEW_DIST === "1" ? "dist" : "src";
const ext = layer === "dist" ? "js" : "ts";
const root = new URL("../../../", import.meta.url);
const load = (path) => import(new URL(path, root));
const { parseTaskRequest } = await load(`apps/codex-broker/${layer}/codex-executor.${ext}`);
const { taskContractDescriptorFor } = await load(`apps/codex-broker/${layer}/task-definitions.${ext}`);
const { REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } = await load(`packages/production-pipeline/${layer}/codex-chat.${ext}`);
const { parseCreativeTreatment } = await load(`packages/production-pipeline/${layer}/creative-treatment.${ext}`);

const identity = {
  profileId: "openai",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  taskKinds: ["creative-treatment", "script-draft", "director-plan", "role-audit"],
};
const capabilities = {
  assetProviders: [{
    id: "pexels-stock-v1",
    deliveryTypes: ["stock_video", "stock_image"],
    supportsReferenceImage: false,
    strengths: ["通用纪实素材"],
    constraints: ["不能证明用户专属实验"],
  }],
  editing: { sourceRangeReuse: true, staticEditorialCard: false },
  audio: { narration: true, pauseControl: "text_hint", musicTrack: false, soundEffectsTrack: false },
};
const treatment = parseCreativeTreatment({
  version: "video-factory/creative-treatment-v2",
  viewerPromise: "学会识别资料支持的结论边界",
  hook: { narrationIntent: "提出核对问题", visualIntent: "展示来源差异" },
  progression: [
    { beatId: "question", purpose: "建立问题", viewerGain: "知道核对目标" },
    { beatId: "evidence", purpose: "核对资料", viewerGain: "区分事实与推测" },
    { beatId: "payoff", purpose: "给出方法", viewerGain: "能够自行判断" },
  ],
  payoff: "给出有条件的结论和下一步",
  visualPrinciples: ["来源画面优先"],
  soundPrinciples: ["自然语速"],
  evidenceRequirements: [{
    beatId: "evidence",
    claim: "原始资料的陈述",
    requirement: "factual_support",
    suppliedSourceIds: ["source-1"],
    critical: true,
    acquisition: "supplied",
    retrievalProviderId: null,
  }],
  feasibilityQuestions: [{ beatId: "evidence", question: "来源画面是否可读" }],
}, ["source-1"]);
const planningIssues = [{
  id: "planning-issue-1",
  target: "director",
  beatIds: ["evidence"],
  scenePositions: [2],
  reason: "素材只承担机制示意。",
  requiredChange: "不得把通用素材描述成用户实测。",
  evidenceArtifactIds: [],
}];
const brief = {
  title: "资料结论怎么核对",
  angle: "用通用示意解释核对方法",
  audience: "普通观众",
  nicheSlug: "evidence-basics",
  platform: "douyin",
  durationSeconds: 24,
  durationRange: { minSeconds: 20, maxSeconds: 34 },
  visualProof: "不能把示意画面说成用户实测。",
  visualIntent: "用自然生活画面解释核对动作。",
  productionCapabilities: capabilities,
};
const { nicheSlug: _nicheSlug, ...directorBrief } = brief;
const reworkInstruction = "保留明确示意边界，不再要求不存在的用户专属实验画面。";

function parse(kind, payload) {
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: `r9-${layer}-${kind}`,
    kind,
    payload,
    expectedContractDigest: taskContractDescriptorFor(kind).digest,
  }, identity);
}

test(`${layer}: current planning fields and treatment v2 survive every producer parser without template guidance`, () => {
  const producerPayloads = {
    "creative-treatment": { brief: { ...brief, reworkInstruction }, suppliedSources: [{ sourceId: "source-1", label: "原始资料" }] },
    "script-draft": { brief: { ...brief, creativeTreatment: treatment, planningIssues } },
    "director-plan": {
      directorProfiles: [{ id: "documentary-observer" }],
      brief: { ...directorBrief, creativeTreatment: treatment, planningIssues, requestedProfileId: "auto" },
      scenes: [{ position: 1, narration: "解释核对动作。", duration: 24, visualPrompt: "查看资料", visualStrategy: "stock" }],
      assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", deliveryTypes: ["stock_video", "stock_image"], estimatedCnyPerClip: 0 }],
      economics: { allowMeteredProviders: false },
    },
  };
  for (const [kind, payload] of Object.entries(producerPayloads)) {
    const parsed = parse(kind, payload);
    assert.equal(parsed.payload.brief.visualIntent, brief.visualIntent);
    if (kind === "creative-treatment") {
      assert.equal(parsed.payload.brief.reworkInstruction, reworkInstruction);
    }
    assert.equal("templateGuidance" in parsed.payload.brief, false);
    assert.deepEqual(parsed.payload.brief.productionCapabilities, capabilities);
    if (kind !== "creative-treatment") {
      assert.deepEqual(parsed.payload.brief.creativeTreatment, treatment);
      assert.deepEqual(parsed.payload.brief.planningIssues, planningIssues);
    }
  }
});

test(`${layer}: deprecated template guidance is rejected at every new producer request boundary`, () => {
  const legacyGuidance = { automationLevel: "assisted" };
  const producerPayloads = {
    "creative-treatment": {
      brief: { ...brief, templateGuidance: legacyGuidance },
      suppliedSources: [{ sourceId: "source-1", label: "原始资料" }],
    },
    "script-draft": {
      brief: { ...brief, creativeTreatment: treatment, planningIssues, templateGuidance: legacyGuidance },
    },
    "director-plan": {
      directorProfiles: [{ id: "documentary-observer" }],
      brief: {
        ...directorBrief,
        creativeTreatment: treatment,
        planningIssues,
        requestedProfileId: "auto",
        templateGuidance: legacyGuidance,
      },
      scenes: [{ position: 1, narration: "解释核对动作。", duration: 24, visualPrompt: "查看资料", visualStrategy: "stock" }],
      assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", deliveryTypes: ["stock_video"], estimatedCnyPerClip: 0 }],
      economics: { allowMeteredProviders: false },
    },
  };
  for (const [kind, payload] of Object.entries(producerPayloads)) {
    assert.throws(() => parse(kind, payload), /templateGuidance|unknown field/i);
  }
});

test(`${layer}: validation repair keeps the same formal producer contract`, () => {
  const revision = {
    mode: "validation-repair",
    invalidCandidate: { incomplete: true },
    invalidCandidateHash: "a".repeat(64),
    validationError: "candidate is incomplete",
  };
  for (const kind of ["creative-treatment", "script-draft", "director-plan"]) {
    const base = kind === "creative-treatment"
      ? { brief, suppliedSources: [{ sourceId: "source-1", label: "原始资料" }] }
      : kind === "script-draft"
        ? { brief: { ...brief, creativeTreatment: treatment, planningIssues } }
        : {
            directorProfiles: [{ id: "documentary-observer" }],
            brief: { ...directorBrief, creativeTreatment: treatment, planningIssues, requestedProfileId: "auto" },
            scenes: [{ position: 1, narration: "解释核对动作。", duration: 24, visualPrompt: "查看资料", visualStrategy: "stock" }],
            assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", deliveryTypes: ["stock_video"], estimatedCnyPerClip: 0 }],
            economics: { allowMeteredProviders: false },
          };
    assert.deepEqual(parse(kind, { ...base, revision }).payload.revision, revision);
  }
});

test(`${layer}: audit and audit-structure-repair retain bounded revision 9 context`, () => {
  const context = { upstreamFacts: { ...brief, creativeTreatment: treatment, planningIssues } };
  const validationFailure = {
    invalidCandidate: { version: "broken" },
    invalidCandidateHash: "b".repeat(64),
    validationError: "Role audit version is invalid.",
  };
  const parsed = parse("role-audit", {
    role: "编剧",
    iteration: 1,
    criteria: ["核对用户要求、制作前提与下游合同"],
    context,
    candidate: { scenes: [] },
    validationFailure,
  });
  assert.deepEqual(parsed.payload.context, context);
  assert.deepEqual(parsed.payload.validationFailure, validationFailure);
});

test(`${layer}: broker and pipeline digest pins match for all revised planning tasks`, () => {
  for (const kind of ["creative-treatment", "script-draft", "director-plan", "role-audit"]) {
    assert.equal(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind], taskContractDescriptorFor(kind).digest);
  }
});
