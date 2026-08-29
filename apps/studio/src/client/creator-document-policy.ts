const TOP_LEVEL_FIELDS: Record<string, ReadonlySet<string>> = {
  brief: new Set(["title", "angle", "audience"]),
  script: new Set(["title", "hook", "structure", "duration_target", "disclosure_required", "platform_notes", "quality_checks", "hashtags", "scenes"]),
  "reference-grammar": new Set(["summary", "pacing", "composition", "camera", "color", "transitions", "sound", "confidence", "beats", "reusableRules", "avoidCopying"]),
  "visual-direction": new Set(["requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]),
  "asset-candidates": new Set(["scene_candidates"]),
  "asset-semantic-rank": new Set(["summary", "fallbackReason", "scenes"]),
  assets: new Set(["director_routing"]),
  voice: new Set(["voice", "rate", "direction", "duration", "scenes"]),
  "visual-review": new Set(["summary", "scores", "findings", "confidence", "recommendation"]),
  "publish-package": new Set(["title", "copy"]),
};

const INPUT_CONTAINERS = new Set(["brief", "script", "directorPlan", "assetPlan", "voiceoverPlan"]);
const CONTAINER_VIEW_IDS: Record<string, string> = {
  brief: "brief",
  script: "script",
  directorPlan: "visual-direction",
  assetPlan: "assets",
  voiceoverPlan: "voice",
};

export const SYSTEM_ONLY_FIELDS = new Set([
  "protocolVersion",
  "schemaVersion",
  "templateSnapshot",
  "templateBlueprint",
  "sourceLayers",
  "fieldSources",
  "providers",
  "economics",
  "director",
  "voiceDirection",
  "generation",
  "mastering",
  "audio",
  "upstreamVersionIds",
  "createdAt",
  "created_at",
  "updatedAt",
  "updated_at",
  "createdBy",
  "job_id",
  "requires_ffmpeg",
  "rendered",
  "fallback_used",
  "generation_pending",
  "source_speech_duration",
  "speech_duration",
  "tempo",
  "media_type",
  "width",
  "height",
  "filter",
  "target_lufs",
  "true_peak_db",
]);

const LOCKED_FIELD = /(?:^|_)(?:id|path|url|sha256|version|provider)(?:_|$)|(?:Id|Path|Url|URL|Sha256|Version|Provider)$/;
const EXPLICIT_LOCKED_FIELDS = new Set(["originalRank", "semanticScore", "timecodeMs"]);
const CREATOR_EDITABLE_ID_FIELDS = new Set(["preferredProviderId"]);

// 创作者界面只接受已经定义过语义和编辑行为的字段。新增工作流字段时，
// 必须先在这里声明用途，避免内部参数因为“尚未禁止”而意外进入 UI。
const CREATOR_NESTED_FIELDS = new Set([
  "angle",
  "audience",
  "authenticityPolicy",
  "beats",
  "camera",
  "cameraMovement",
  "candidate_shortlist",
  "candidates",
  "category",
  "color",
  "composition",
  "confidence",
  "continuity",
  "continuityNote",
  "description",
  "direction",
  "disclosure_required",
  "duration",
  "duration_target",
  "failure_conditions",
  "findings",
  "generationPrompt",
  "hashtags",
  "hook",
  "intent",
  "legibility",
  "lighting",
  "locked",
  "mastering_preset",
  "materialization_notes",
  "message",
  "narration",
  "narrativeApproach",
  "narrativeArc",
  "narrativeFunction",
  "narrativeRole",
  "on_screen_text",
  "pacing",
  "pause_scale",
  "platform",
  "platform_notes",
  "position",
  "preferredProviderId",
  "purpose",
  "quality_checks",
  "query",
  "rank",
  "rate",
  "rationale",
  "recommendation",
  "reusableRules",
  "safety",
  "scenes",
  "score",
  "search_terms",
  "selected",
  "severity",
  "shotSize",
  "shots",
  "sound",
  "sound_cue",
  "soundRole",
  "scores",
  "structure",
  "subject",
  "subjectMovement",
  "subtitle",
  "success_criteria",
  "suggestion",
  "summary",
  "title",
  "transitionIn",
  "transitions",
  "viewerPromise",
  "visible_action",
  "visualBible",
  "visual_description",
  "visual_prompt",
  "visual_strategy",
  "voice",
]);

export function creatorViewId(nodeId: string): string {
  return nodeId.endsWith("-input") ? nodeId.slice(0, -"-input".length) : nodeId;
}

export function isCreatorTopLevelField(nodeId: string, key: string, value: unknown): boolean {
  const viewId = creatorViewId(nodeId);
  const policy = TOP_LEVEL_FIELDS[viewId];
  if (!policy) return isCreatorNestedField(key);
  if (policy.has(key)) return true;
  return nodeId.endsWith("-input") && INPUT_CONTAINERS.has(key) && isRecord(value);
}

export function isCreatorNestedField(key: string): boolean {
  return CREATOR_NESTED_FIELDS.has(key)
    && !SYSTEM_ONLY_FIELDS.has(key)
    && (!LOCKED_FIELD.test(key) || CREATOR_EDITABLE_ID_FIELDS.has(key))
    && !EXPLICIT_LOCKED_FIELDS.has(key);
}

export function creatorContainerViewId(key: string): string | undefined {
  return CONTAINER_VIEW_IDS[key];
}

export function hasCreatorDocumentContent(nodeId: string, value: unknown): boolean {
  const record = isRecord(value) ? value : undefined;
  if (!record) return false;
  return Object.entries(record).some(([key, item]) => (
    isCreatorTopLevelField(nodeId, key, item) && hasCreatorValue(item, creatorContainerViewId(key))
  ));
}

function hasCreatorValue(value: unknown, nestedViewId?: string): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.some((item) => hasCreatorValue(item, nestedViewId));
  if (!isRecord(value)) return true;
  return Object.entries(value).some(([key, item]) => {
    const visible = nestedViewId ? isCreatorTopLevelField(nestedViewId, key, item) : isCreatorNestedField(key);
    return visible && hasCreatorValue(item, creatorContainerViewId(key));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
