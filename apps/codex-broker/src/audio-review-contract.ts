import { AUDIO_REVIEW_CHECKS } from "@video-factory/production-pipeline/audio-review";

export const AUDIO_REVIEW_PROMPT = {
  version: "video-factory/audio-review-v1",
  directive: "你是成片声音审片员。必须真正听取随请求提供的音轨；旁白稿只是对照，不是听觉证据。",
  task: "结合完整音轨与带时间码的画面，检查发音、语气情绪、停顿、噪声、声音层次及音画配合。提供定位准确、可行动的修改建议，推进仍由用户决定。",
  outputRules: [
    "输出 JSON，包含 audioSha256、summary、checks、findings。audioSha256 必须逐字使用输入证据摘要。",
    "checks 必须覆盖 pronunciation、performance、pauses、noise、balance、audiovisual_alignment；每项使用 pass / issue / not_observed / not_applicable。",
    "模型未能听到音频、只有旁白文字、或证据不够时必须使用 not_observed，不得推断通过或编造听感。",
    "没有人声时 pronunciation 可以 not_applicable；没有音乐不等于声音层次不合格。声音的风格目标以创作者方案为准，不强行改成某种情绪。",
    "稀疏抽帧只能支持粗粒度音画对应，不能确认逐帧口型同步；无法判断的部分明确 not_observed。",
    "findings 每项包含 startMs、endMs、category、observation、suggestion，时间为成片时间轴，category 对应 checks 中的 issue；不得给转写服务、重新生成或付费执行指令。",
    "每个 issue 必须有具体问题及时间范围；没有问题时 findings 为空，不为满足数量编造问题。",
  ], examples: [],
};

export const AUDIO_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["audioSha256", "summary", "checks", "findings"],
  properties: {
    audioSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, summary: { type: "string", minLength: 1, maxLength: 2000 },
    checks: { type: "object", additionalProperties: false, required: [...AUDIO_REVIEW_CHECKS], properties: Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, { type: "string", enum: ["pass", "issue", "not_observed", "not_applicable"] }])) },
    findings: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
      required: ["startMs", "endMs", "category", "observation", "suggestion"], properties: {
        startMs: { type: "integer", minimum: 0 }, endMs: { type: "integer", minimum: 1 },
        category: { type: "string", enum: [...AUDIO_REVIEW_CHECKS] },
        observation: { type: "string", minLength: 1, maxLength: 2000 }, suggestion: { type: "string", minLength: 1, maxLength: 2000 },
      },
    } },
  },
};
