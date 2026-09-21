import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ModelLibrary, modelLibraryItems } from "../src/client/components/ModelLibrary.js";
import { studioApi } from "../src/client/api.js";
import type { StudioProvider } from "../src/shared/api.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const provider = (id: string, capability: string): StudioProvider => ({
  id, capability, label: "角色", available: true, kind: "external", billing: "subscription", modes: [], latency: "seconds", description: "",
  modelProfiles: [{ id: "same-model", label: "同一个模型", providerId: id, providerFamily: "deepseek", available: true, taskTypes: ["text"], description: "" }],
});

test("one model reused by several roles is one library entry with overlapping capabilities", () => {
  const items = modelLibraryItems([provider("writer", "script.draft"), provider("director", "storyboard.plan"), provider("reference", "reference.grammar")], []);
  expect(items).toHaveLength(1);
  expect(items[0]!.groups).toEqual(["text", "understand"]);
  expect(items[0]!.capabilities).toEqual(["文本生成", "图像理解 / 视频抽帧"]);
});

test("runtime placeholders are not presented as configurable model identities", () => {
  const legacy = provider("legacy", "script.draft");
  legacy.modelProfiles![0]!.id = "codex-default";
  legacy.modelProfiles![0]!.label = "由 Codex 运行时决定";
  expect(modelLibraryItems([legacy], [])).toHaveLength(0);
});

test("adding a connection sends JSON content type through the real browser API adapter", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("x-video-factory-request")).toBe("studio");
    expect(JSON.parse(String(init.body)).modelId).toBe("qa-model");
    return new Response(JSON.stringify({ models: [] }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  await studioApi.addModel({ label: "QA", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "qa-model", apiKey: "test", maxOutputTokens: 32000, capabilities: ["text"] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("model library has no role selector and adding a model sends the real connection only once", async () => {
  vi.spyOn(studioApi, "models").mockResolvedValue({ models: [] });
  const add = vi.spyOn(studioApi, "addModel").mockResolvedValue({ models: [] });
  const reload = vi.fn(async () => {});
  render(<ModelLibrary providers={[provider("writer", "script.draft"), provider("director", "storyboard.plan")]} onChanged={reload} />);
  expect(within(screen.getByLabelText("全局模型目录")).queryByRole("combobox")).toBeNull();
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "添加模型" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "添加模型" }));
  for (const [name, value] of [["接入名称", "我的模型"], ["接口根地址（含版本路径）", "https://api.example.com/v1"], ["模型 ID（供应商原名）", "new-model"], ["API Key", "test-key"], ["最大输出 token（按模型文档填写）", "32768"]]) {
    fireEvent.change(screen.getByLabelText(name!), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "保存模型接入" }));
  await screen.findByText(/模型接入已保存/);
  expect(add).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ modelId: "new-model", apiKey: "test-key", maxOutputTokens: 32768, capabilities: ["text"] }));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("API Key")).toBeNull();
});
