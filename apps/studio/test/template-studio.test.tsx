import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StudioTemplate } from "../src/shared/api.js";
import { TemplateGallery } from "../src/client/templates/TemplateGallery.js";

const templates: StudioTemplate[] = [
  template("knowledge-explainer", "知识解释", "knowledge", 42, "assisted"),
  template("photo-story", "照片故事", "photo", 30, "manual"),
];

describe("TemplateGallery", () => {
  it("shows production grammar and selects a template without triggering generation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TemplateGallery templates={templates} selectedId="knowledge-explainer" onSelect={onSelect} />);

    expect(screen.getByRole("radio", { name: /知识解释/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("开场 / 解释 / 收束")).toHaveLength(2);
    expect(screen.getAllByText("付费逐项确认")).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: /照片故事/ }));
    expect(onSelect).toHaveBeenCalledWith(templates[1]);
  });
});

function template(
  id: string,
  name: string,
  category: string,
  durationSeconds: number,
  automationLevel: StudioTemplate["automationLevel"],
): StudioTemplate {
  return {
    id,
    version: 1,
    status: "published",
    name,
    description: `${name}模板说明`,
    category,
    platforms: ["douyin"],
    durationSeconds,
    automationLevel,
    storyStructure: [
      { id: "hook", label: "开场", purpose: "抓住注意", required: true },
      { id: "body", label: "解释", purpose: "展开内容", required: true },
      { id: "close", label: "收束", purpose: "留下结论", required: true },
    ],
    shotSlots: [
      { id: "shot-hook", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true },
      { id: "shot-body", beatId: "body", purpose: "解释", durationSeconds: 8, allowedCapabilities: ["asset.search"], manualReplacement: true },
      { id: "shot-close", beatId: "close", purpose: "收束", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true },
    ],
    visualSystem: { composition: "主体清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
    qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    builtIn: true,
  };
}
