import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanningStagesPanel } from "../src/client/components/PlanningStagesPanel.js";
import type { StudioPlanningStage, StudioProvider } from "../src/shared/api.js";

const provider: StudioProvider = {
  id: "codex-screenwriter-v1",
  capability: "script.draft",
  label: "AI 编剧",
  available: true,
  kind: "external",
  billing: "subscription",
  status: "ready",
  defaultModelId: "deepseek-flash",
  modelProfiles: [
    {
      id: "deepseek-flash",
      label: "deepseek-flash",
      providerId: "codex-screenwriter-v1",
      providerFamily: "deepseek",
      available: true,
      recommended: true,
      description: "DeepSeek 首选模型。",
      taskTypes: ["text"],
    },
  ],
};

function stage(id: StudioPlanningStage["id"], overrides: Partial<StudioPlanningStage> = {}): StudioPlanningStage {
  return {
    id,
    status: "pending",
    effectiveModelId: "deepseek-flash",
    providerId: "codex-screenwriter-v1",
    artifactIds: [],
    allowedActions: ["edit_input", "change_model"],
    ...overrides,
  };
}

function modelSelect(): HTMLElement {
  return screen.getByRole("combobox");
}

describe("PlanningStagesPanel model switching copy", () => {
  it("promises a first run, not a redo, for a stage that has not run yet", () => {
    // 停在简报边界时创作规划三个阶段都还是"待开始"，此时改模型没有任何产出会被重做——
    // 保存只是给它选一台模型然后开始跑。这里曾经一律说"重新执行"，用户会以为已经做好的
    // 一版产出会被丢掉，于是不敢改模型。
    render(<PlanningStagesPanel
      stages={[stage("script")]}
      providers={[provider]}
      busy={false}
      readOnly={false}
      onConfigureStage={vi.fn(async () => undefined)}
    />);

    expect(screen.getByText(/继续制作时才会使用，不会立即调用模型/)).toBeInTheDocument();
    expect(screen.queryByText(/重新执行/)).not.toBeInTheDocument();
  });

  it("warns about the redo once that stage already produced something", () => {
    render(<PlanningStagesPanel
      stages={[stage("script", { status: "completed" })]}
      providers={[provider]}
      busy={false}
      readOnly={false}
      onConfigureStage={vi.fn(async () => undefined)}
    />);

    expect(screen.getByText(/由你继续制作时才重新执行，不会立即调用模型/)).toBeInTheDocument();
  });

  it("keeps the model selector reachable at a boundary stop", () => {
    // 边界停点上 run 不是 running，面板必须是可编辑的——这是「用户说的算」的落点：
    // 停在等人时改模型再继续，而不是让模型自己决定换哪个。
    render(<PlanningStagesPanel
      stages={[stage("script")]}
      providers={[provider]}
      busy={false}
      readOnly={false}
      onConfigureStage={vi.fn(async () => undefined)}
    />);

    expect(modelSelect()).toBeEnabled();
    expect(screen.getByRole("button", { name: /保存模型/ })).toBeDisabled();
  });

  it("does not offer the model selector when the caller is read-only", () => {
    render(<PlanningStagesPanel
      stages={[stage("script")]}
      providers={[provider]}
      busy={false}
      readOnly
      onConfigureStage={vi.fn(async () => undefined)}
    />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
