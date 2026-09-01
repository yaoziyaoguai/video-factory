import type { StudioModelProfile } from "./api.js";

type ModelTaskType = StudioModelProfile["taskTypes"][number];

const TASK_TYPES_BY_CAPABILITY: Record<string, ModelTaskType[]> = {
  "script.draft": ["text"],
  "storyboard.plan": ["text"],
  "asset.prepare": ["text-to-video", "text-to-image"],
  "quality.review.visual": ["visual-review"],
  "avatar.generate": ["digital-human"],
};

export function modelSupportsCapability(model: StudioModelProfile, capability: string): boolean {
  const accepted = TASK_TYPES_BY_CAPABILITY[capability];
  return accepted === undefined || model.taskTypes.some((taskType) => accepted.includes(taskType));
}

export function selectableModelsForCapability(
  models: StudioModelProfile[] | undefined,
  capability: string,
): StudioModelProfile[] {
  return (models ?? []).filter((model) => model.available && modelSupportsCapability(model, capability));
}
