import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { TemplatesPage } from "../src/client/pages/TemplatesPage.js";
import type { StudioTemplate } from "../src/shared/api.js";

const published = template("knowledge-explainer", "知识解释", "published", true);
const draft = template("my-series", "我的系列", "draft", false);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(studioApi, "templates").mockResolvedValue({ storeRevision: 3, templates: [draft, published] });
  vi.spyOn(studioApi, "templateExperiments").mockResolvedValue([]);
  vi.spyOn(studioApi, "providers").mockResolvedValue([{
    id: "ark-seedance-video-v1",
    providerFamily: "ark",
    capability: "asset.generate.video",
    label: "火山方舟视频生成",
    available: true,
    kind: "external",
    defaultModelId: "seedance-2-5-pro",
    modelProfiles: [
      { id: "seedance-2-5-pro", label: "Seedance 2.5 Pro", providerId: "ark-seedance-video-v1", providerFamily: "ark", available: true, recommended: true, description: "高质量默认", taskTypes: ["text-to-video"] },
      { id: "seedance-2-0-lite", label: "Seedance 2.0 Lite", providerId: "ark-seedance-video-v1", providerFamily: "ark", available: true, description: "经济测试", taskTypes: ["text-to-video"] },
    ],
  }]);
  vi.spyOn(studioApi, "saveTemplateDraft").mockImplementation(async (value) => ({ storeRevision: 4, template: value }));
  vi.spyOn(studioApi, "createTemplate").mockImplementation(async (input) => ({
    storeRevision: 4,
    template: { ...draft, id: input.id, name: input.name, description: input.description ?? "默认说明" },
  }));
  vi.spyOn(studioApi, "publishTemplate").mockResolvedValue({ storeRevision: 5, template: { ...draft, status: "published" } });
});

describe("TemplatesPage", () => {
  it("creates a new editable template from a minimal blank grammar", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("12345678-1234-4123-8123-123456789abc");
    render(<TemplatesPage />);

    await screen.findByRole("heading", { name: "知识解释" });
    await user.click(screen.getByRole("button", { name: "新建空白模板" }));
    const dialog = screen.getByRole("dialog", { name: "创建空白模板" });
    await user.type(within(dialog).getByLabelText("模板名称"), "城市人物微纪录");
    await user.type(within(dialog).getByLabelText("适用说明"), "面向城市青年的人物观察");
    await user.click(within(dialog).getByRole("button", { name: "创建并编辑" }));

    expect(studioApi.createTemplate).toHaveBeenCalledWith({
      id: "custom-12345678-123",
      name: "城市人物微纪录",
      description: "面向城市青年的人物观察",
      expectedRevision: 3,
    });
    expect(await screen.findByDisplayValue("城市人物微纪录")).toBeInTheDocument();
  });

  it("protects unsaved changes when selecting another template or refreshing", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TemplatesPage />);

    await screen.findByRole("heading", { name: "知识解释" });
    await user.click(screen.getByRole("radio", { name: /我的系列/ }));
    await user.clear(screen.getByLabelText("模板名称"));
    await user.type(screen.getByLabelText("模板名称"), "未保存的新名称");
    expect(screen.getByText("有未保存修改")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /知识解释/ }));
    expect(screen.getByLabelText("模板名称")).toHaveValue("未保存的新名称");
    await user.click(screen.getByTitle("刷新模板"));
    expect(studioApi.templates).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("uses collision-resistant clone ids", async () => {
    const user = userEvent.setup();
    const clone = vi.spyOn(studioApi, "cloneTemplate").mockImplementation(async (input) => ({
      storeRevision: 4,
      template: { ...published, id: input.newId, name: input.name, status: "draft", builtIn: false },
    }));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("12345678-1234-4123-8123-123456789abc");
    render(<TemplatesPage />);

    await screen.findByRole("heading", { name: "知识解释" });
    await user.click(screen.getByRole("button", { name: "创建可编辑副本" }));

    expect(clone).toHaveBeenCalledWith(expect.objectContaining({ newId: "knowledge-explainer-copy-12345678" }));
  });

  it("stores a template model override without hard-coding it into the provider", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(studioApi, "saveTemplateDraft");
    render(<TemplatesPage />);

    await screen.findByRole("heading", { name: "知识解释" });
    await user.click(screen.getByRole("radio", { name: /我的系列/ }));
    await user.selectOptions(screen.getByLabelText("火山方舟视频生成 模板模型"), "seedance-2-0-lite");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      modelDefaults: { "ark-seedance-video-v1": "seedance-2-0-lite" },
    }), 3);
  });

  it("requires an explicit confirmation before publishing a template", async () => {
    const user = userEvent.setup();
    render(<TemplatesPage />);

    await screen.findByRole("heading", { name: "知识解释" });
    await user.click(screen.getByRole("radio", { name: /我的系列/ }));
    await user.click(screen.getByRole("button", { name: "发布新版本" }));

    expect(studioApi.publishTemplate).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "确认发布“我的系列”" });
    await user.click(within(dialog).getByRole("button", { name: "确认发布" }));
    expect(studioApi.publishTemplate).toHaveBeenCalledWith("my-series", 3);
  });
});

function template(id: string, name: string, status: StudioTemplate["status"], builtIn: boolean): StudioTemplate {
  return {
    id,
    version: 1,
    status,
    name,
    description: `${name}说明`,
    category: "knowledge",
    platforms: ["douyin"],
    durationSeconds: 24,
    automationLevel: "assisted",
    storyStructure: [
      { id: "hook", label: "开场", purpose: "抓住注意", required: true },
      { id: "body", label: "正文", purpose: "展开内容", required: true },
    ],
    shotSlots: [{ id: "shot", beatId: "hook", purpose: "开场", durationSeconds: 4, allowedCapabilities: ["asset.search"], manualReplacement: true }],
    visualSystem: { composition: "主体清晰", colorIntent: "自然", subtitleDensity: "medium", pacing: "measured" },
    soundSystem: { voiceIntent: "可信", pace: "medium", musicIntent: "克制" },
    qualityRules: [{ id: "facts", label: "事实", dimension: "factual", required: true, threshold: 80 }],
    capabilityRequirements: [{ capability: "script.draft", required: true }],
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    builtIn,
  };
}
