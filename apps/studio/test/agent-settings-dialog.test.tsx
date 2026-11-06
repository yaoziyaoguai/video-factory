import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FrameSettings } from "../src/client/agent/FrameSettings.js";
import type { AvailableProviderModels, ProviderConnectionSettings, SaveProviderConnection } from "../src/shared/agent/generated/contracts.js";

// S3-01 模型页：OpenAI 承载文本/图片/配音，MiniMax 也可承载配音，每类一个当前具体型号；
// 视频保留原供应商连接（可多条）。浏览不写库、应用单事务切换、备选管理与目录同步独立。

const fixture = (): ProviderConnectionSettings => ({ revision: 1, connections: [
  { id: "provider-openai", name: "我的 OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "synthetic-shared-key", enabled: true, models: [
    { id: "first", name: "型号甲", modelId: "alpha", kind: "text", features: ["适合长文"], contextWindowTokens: 32000, maxOutputTokens: 1000, enabled: true, isDefault: true, thinkingLevel: "default" },
    { id: "second", name: "型号乙", modelId: "beta", kind: "text", features: [], contextWindowTokens: 32000, maxOutputTokens: 1000, enabled: true, isDefault: false, thinkingLevel: "default" },
    { id: "third", name: "型号丙", modelId: "gamma", kind: "text", features: [], contextWindowTokens: 64000, maxOutputTokens: 2000, enabled: true, isDefault: false, thinkingLevel: "default" },
  ] },
  { id: "provider-ark", name: "火山引擎", protocol: "ark", baseUrl: "https://ark.example.com/v1", apiKey: "synthetic-ark-key", enabled: true, models: [
    { id: "video-one", name: "视频甲", modelId: "faux-video", kind: "video", features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: false },
  ] },
  { id: "provider-ark2", name: "另一家视频", protocol: "ark", baseUrl: "https://two.example.com/v1", apiKey: "synthetic-ark2-key", enabled: true, models: [
    { id: "video-two", name: "视频乙", modelId: "faux-video-2", kind: "video", features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: false },
  ] },
], modelStatuses: [
  { modelEntryId: "first", unavailableReason: null, thinking: null },
  { modelEntryId: "second", unavailableReason: null, thinking: null },
  { modelEntryId: "third", unavailableReason: null, thinking: null },
  { modelEntryId: "video-one", unavailableReason: null, thinking: null },
  { modelEntryId: "video-two", unavailableReason: null, thinking: null },
] });

const directory = (): AvailableProviderModels => ({ models: [
  { id: "alpha", name: "甲目录名", kinds: ["text"], status: "listed", contextWindowTokens: 32000, maxOutputTokens: 4000 },
  { id: "from-supplier", name: "来自供应商", kinds: ["text"], status: "listed", contextWindowTokens: 128000, maxOutputTokens: 8000 },
  { id: "retired-one", name: "已下线", kinds: ["text"], status: "retired", contextWindowTokens: null, maxOutputTokens: null },
  { id: "faux-video-2", name: "视频乙", kinds: ["video"], status: "listed", contextWindowTokens: null, maxOutputTokens: null },
], hasMore: false, syncedAt: "2026-10-31T06:00:00Z" });

function routes(options: { directory?: () => Response; failRead?: boolean; settings?: ProviderConnectionSettings; post?: (body: SaveProviderConnection) => Response | Promise<Response> } = {}) {
  let value = options.settings ?? fixture(); const posts: SaveProviderConnection[] = []; let reads = 0; let syncs = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) { syncs++; return options.directory?.() ?? Response.json(directory()); }
    if (url.endsWith("/settings/model-connections")) {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as SaveProviderConnection; posts.push(body);
        if (options.post) return options.post(body);
        // 与服务端同语义：跨连接同类默认在同一事务内清掉，旧默认保留为备选。
        const kinds = body.connection.models.filter(model => model.isDefault).map(model => model.kind);
        value = { ...value, revision: value.revision + 1, connections: [...value.connections
          .filter(item => item.id !== body.connection.id)
          .map(item => ({ ...item, models: item.models.map(model => kinds.includes(model.kind) ? { ...model, isDefault: false } : model) })),
          body.connection] };
        return Response.json({ revision: value.revision, replayed: false });
      }
      reads++;
      if (options.failRead) return Response.json({ code: "TEMPORARILY_UNAVAILABLE", message: "暂不可用" }, { status: 503 });
      return Response.json(value);
    }
    throw new Error(`Unexpected route ${url}`);
  }));
  return { posts, get reads() { return reads; }, get syncs() { return syncs; }, options };
}
function page(refresh = vi.fn(async () => {})) { return render(<FrameSettings page="models" bootstrap={null} conversations={[]} onConversation={() => {}} onPage={() => {}} onCatalogRefresh={refresh} />); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("每类一个当前；页面不再明文展示 Key，备选按连接标注", async () => {
  routes(); page();
  expect(await screen.findByText("用于新的请求和方案")).toBeVisible();
  expect(screen.getByText("型号甲")).toBeTruthy();
  expect(screen.queryByDisplayValue("synthetic-shared-key")).toBeNull();
  expect(screen.getByText("备选模型", { exact: false }).textContent).toMatch(/2/);
  expect(screen.getByText("型号乙").closest(".agent-backup-row")!.textContent).toContain("我的 OpenAI");
  expect(screen.getByText("型号丙").closest(".agent-backup-row")!.textContent).toContain("我的 OpenAI");
});

it("进入与切换用途预选当前型号；MiniMax 配音当前与 OpenAI 备选一致且浏览不写库", async () => {
  const settings = fixture();
  settings.connections[0]!.models.push({ id: "speech-backup", name: "OpenAI 配音备选", modelId: "gpt-realtime-2.1-mini", kind: "speech", features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: false });
  settings.connections.push({ id: "provider-minimax", name: "我的 MiniMax", protocol: "minimax", baseUrl: "https://api.minimax.cn", apiKey: "synthetic-minimax-key", enabled: true,
    models: [{ id: "speech-current", name: "MiniMax 当前配音", modelId: "speech-2.8-turbo", kind: "speech", features: [], contextWindowTokens: null, maxOutputTokens: null, enabled: true, isDefault: true }] });
  const { posts } = routes({ settings }); page();
  await screen.findByText("用于新的请求和方案");
  expect(screen.getByLabelText("具体型号")).toHaveValue("first");
  expect(screen.getByRole("button", { name: "应用选择" })).toBeDisabled();
  await userEvent.click(screen.getByRole("tab", { name: /配音模型/ }));
  expect(within(screen.getByRole("article", { name: "当前配音模型" })).getByRole("heading", { name: /MiniMax 当前配音/ })).toBeVisible();
  expect(screen.getByLabelText("供应商连接")).toHaveValue("provider-minimax");
  expect(screen.getByLabelText("具体型号")).toHaveValue("speech-current");
  expect(screen.getByRole("button", { name: "应用选择" })).toBeDisabled();
  await userEvent.selectOptions(screen.getByLabelText("供应商连接"), "provider-openai");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "speech-backup");
  expect(screen.getByRole("button", { name: "应用选择" })).toBeEnabled();
  await userEvent.click(screen.getByRole("tab", { name: /视频模型/ }));
  await userEvent.click(screen.getByRole("tab", { name: /配音模型/ }));
  expect(screen.getByLabelText("供应商连接")).toHaveValue("provider-minimax");
  expect(screen.getByLabelText("具体型号")).toHaveValue("speech-current");
  expect(posts).toHaveLength(0);
});

it("浏览与取消不写库；应用选择才单次保存并切换当前", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "second");
  expect(posts).toHaveLength(0);
  await userEvent.click(screen.getByRole("tab", { name: /图片模型/ }));
  await userEvent.click(screen.getByRole("tab", { name: /文本大模型/ }));
  expect(posts).toHaveLength(0);
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "second");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText(/当前模型已切换到 型号乙/)).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.id).toBe("provider-openai");
  expect(posts[0]!.connection.models.filter(model => model.kind === "text").map(model => model.isDefault)).toEqual([false, true, false]);
  expect(posts[0]!.expectedRevision).toBe(1);
});

it("视频跨连接设当前是一次请求；当前换回同样一次", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("tab", { name: /视频模型/ }));
  await userEvent.selectOptions(screen.getByLabelText("供应商连接"), "provider-ark2");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "video-two");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText(/当前模型已切换到 视频乙/)).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.id).toBe("provider-ark2");
  expect(posts[0]!.connection.models[0]!.isDefault).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText("供应商连接"), "provider-ark");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "video-one");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText(/当前模型已切换到 视频甲/)).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.connection.id).toBe("provider-ark");
});

it("备选行设为当前与移除都生效；移除不碰其他型号", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号乙");
  await userEvent.click(screen.getByRole("button", { name: "移除 型号乙" }));
  expect(await screen.findByText("已从备选移除，连接和历史记录保留。")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.id).toBe("provider-openai");
  expect(posts[0]!.connection.models.map(model => model.id)).toEqual(["first", "third"]);
  await userEvent.click(within(screen.getByText("型号丙").closest(".agent-backup-row")!).getByRole("button", { name: "设为当前" }));
  expect(await screen.findByText(/已切换到 型号丙/)).toBeVisible();
  expect(posts[1]!.connection.id).toBe("provider-openai");
  expect(posts[1]!.connection.models.map(model => model.isDefault)).toEqual([false, true]);
});

it("移除当前必须内联确认；保留不写库，确认后清空到 0", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("button", { name: "管理备选" }));
  expect(screen.getByRole("checkbox", { name: /型号甲/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "编辑型号" }));
  await userEvent.click(screen.getByRole("button", { name: "移除当前型号" }));
  expect(screen.getByRole("alert").textContent).toContain("移除后，此类暂时不可用");
  await userEvent.click(screen.getByRole("button", { name: "保留" }));
  expect(posts).toHaveLength(0);
  expect((screen.getByRole("checkbox", { name: /型号甲/ }) as HTMLInputElement).checked).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "编辑型号" }));
  await userEvent.click(screen.getByRole("button", { name: "移除当前型号" }));
  await userEvent.click(screen.getByRole("button", { name: "移除并暂不配置" }));
  expect(await screen.findByText("已移除。此类当前未配置，其他类别和历史保留。")).toBeVisible();
  expect(screen.getByText("还没有当前模型")).toBeTruthy();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.models.map(model => model.id)).toEqual(["second", "third"]);
  expect(posts[0]!.connection.models.some(model => model.isDefault)).toBe(false);
});

it("不可执行的型号如实展示：选择器禁用，备选行不能设为当前", async () => {
  const settings = fixture();
  settings.modelStatuses = settings.modelStatuses.map(item => item.modelEntryId === "second"
    ? { ...item, unavailableReason: "请填写型号的上下文窗口和最大输出" } : item);
  routes({ settings }); page();
  await screen.findByText("型号乙");
  const option = within(screen.getByLabelText("具体型号") as HTMLSelectElement).getByRole("option", { name: /型号乙/ }) as HTMLOptionElement;
  expect(option.disabled).toBe(true);
  expect(option.textContent).toContain("请填写型号的上下文窗口和最大输出");
  const row = screen.getByText("型号乙").closest(".agent-backup-row") as HTMLElement;
  expect(within(row).queryByRole("button", { name: "设为当前" })).toBeNull();
  expect(row.textContent).toContain("请填写型号的上下文窗口和最大输出");
});

it("视频当前在独立供应商连接；设置后文本默认不变", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("tab", { name: /视频模型/ }));
  await screen.findByText("还没有当前模型");
  await userEvent.selectOptions(screen.getByLabelText("供应商连接"), "provider-ark");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "video-one");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText(/当前模型已切换到 视频甲/)).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.id).toBe("provider-ark");
  expect(Object.fromEntries(posts[0]!.connection.models.map(model => [model.id, model.isDefault]))).toEqual({ "video-one": true });
  await userEvent.click(screen.getByRole("tab", { name: /文本大模型/ }));
  expect(screen.getByText("型号甲")).toBeTruthy();
  expect(screen.getByText("用于新的请求和方案")).toBeTruthy();
});

it("同步目录只更新可选目录：不写库、不换当前", async () => {
  const state = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("button", { name: "管理备选" }));
  expect(await screen.findByRole("checkbox", { name: /来自供应商/ })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /来自供应商/ }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText(/个文本大模型目录条目/).textContent).toContain("2");
  expect(screen.getAllByText("型号甲").length).toBeGreaterThan(0);
  expect(screen.getByText("用于新的请求和方案")).toBeTruthy();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索型号" }), "supplier");
  expect(screen.queryByRole("checkbox", { name: /型号甲/ })).toBeNull();
  expect(screen.getByRole("checkbox", { name: /来自供应商/ })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(state.syncs).toBe(1);
});

it("目录勾选登记备选，容量来自目录；下线条目不默认勾选", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("button", { name: "管理备选" }));
  await screen.findByRole("checkbox", { name: /来自供应商/ });
  expect(screen.queryByRole("checkbox", { name: /已下线/ })).toBeNull();
  await userEvent.click(screen.getByRole("checkbox", { name: /来自供应商/ }));
  expect(await screen.findByText(/来自供应商 已加入备选/)).toBeVisible();
  expect(posts).toHaveLength(1);
  const added = posts[0]!.connection.models.at(-1)!;
  // 备选直接使用该型号支持的输出上限。
  expect(added).toMatchObject({ modelId: "from-supplier", kind: "text", isDefault: false, enabled: true, contextWindowTokens: 128000, maxOutputTokens: 8000 });
});

it("空的视频供应商连接也有目录区：先空状态提示，同步后即可勾选登记", async () => {
  const settings = fixture();
  settings.connections.push({ id: "provider-fresh", name: "新连接", protocol: "ark", baseUrl: "https://fresh.example.com/v1", apiKey: "synthetic-fresh", enabled: true, models: [] });
  const state = routes({ settings }); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("tab", { name: /视频模型/ }));
  await userEvent.click(screen.getByRole("button", { name: "管理备选" }));
  await userEvent.selectOptions(screen.getByLabelText("目录连接"), "provider-fresh");
  const fresh = screen.getByRole("heading", { name: /新连接/ }).closest(".agent-directory-provider") as HTMLElement;
  await userEvent.click(await within(fresh).findByRole("checkbox", { name: /视频乙/ }));
  expect(await screen.findByText(/视频乙 已加入备选/)).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]!.connection.id).toBe("provider-fresh");
  expect(state.posts[0]!.connection.models[0]).toMatchObject({ modelId: "faux-video-2", kind: "video" });
  expect(state.syncs).toBe(2);
});

it("保存结果未知保留原命令重试；不重复提交另一份修改", async () => {
  let failures = 0;
  const { posts } = routes({ post: body => { failures++; if (failures === 1) throw new Error("network lost"); return Response.json({ revision: 99, replayed: false, saved: body }); } });
  page(); await screen.findByText("型号甲");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "second");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText("保存结果未知，请重试同一命令。")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "重试保存" }));
  expect(await screen.findByText(/当前模型已切换到 型号乙/)).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]!.commandId).toBe(posts[0]!.commandId);
});

it("版本冲突重读最新状态，可再次操作", async () => {
  const state = routes({ post: () => Response.json({ code: "STALE_REVISION", message: "配置已更新，请重新读取后再保存。" }, { status: 409 }) });
  page(); await screen.findByText("型号甲");
  const before = state.reads;
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "second");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText(/已重新读取最新状态/)).toBeVisible();
  expect(state.reads).toBeGreaterThan(before);
  expect(screen.getAllByText("型号甲").length).toBeGreaterThan(0);
  expect(state.posts).toHaveLength(1);
});

it("连接配置共用一份 Key；改 Key 不重建型号，明文只在弹窗可见", async () => {
  const { posts } = routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("button", { name: "连接配置" }));
  const dialog = screen.getByRole("dialog", { name: "连接配置" });
  const key = within(dialog).getByLabelText("API Key") as HTMLInputElement;
  expect(key.value).toBe("synthetic-shared-key");
  await userEvent.clear(key);
  await userEvent.type(key, "synthetic-updated-key");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect(await screen.findByText("配置已保存，未发起生成调用。")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.apiKey).toBe("synthetic-updated-key");
  expect(posts[0]!.connection.id).toBe("provider-openai");
  expect(posts[0]!.connection.models.map(model => model.id)).toEqual(["first", "second", "third"]);
  expect(screen.queryByDisplayValue("synthetic-updated-key")).toBeNull();
});

it("连接弹窗未保存切换先确认；可新建连接", async () => {
  routes(); page();
  await screen.findByText("型号甲");
  await userEvent.click(screen.getByRole("button", { name: "连接配置" }));
  const dialog = screen.getByRole("dialog", { name: "连接配置" });
  await userEvent.type(within(dialog).getByLabelText("连接名称"), "草稿");
  await userEvent.selectOptions(within(dialog).getByLabelText("使用连接"), "provider-ark");
  expect(within(dialog).getByText(/当前连接有未保存的更改/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "继续编辑" }));
  expect((within(dialog).getByLabelText("连接名称") as HTMLInputElement).value).toBe("我的 OpenAI草稿");
  await userEvent.selectOptions(within(dialog).getByLabelText("使用连接"), "provider-ark");
  await userEvent.click(within(dialog).getByRole("button", { name: "放弃更改并切换" }));
  expect((within(dialog).getByLabelText("连接名称") as HTMLInputElement).value).toBe("火山引擎");
  await userEvent.selectOptions(within(dialog).getByLabelText("使用连接"), "__new__");
  expect((within(dialog).getByLabelText("连接名称") as HTMLInputElement).value).toBe("");
});

it("空状态从添加连接开始", async () => {
  const { posts } = routes({ settings: { revision: 0, connections: [], modelStatuses: [] } });
  page();
  expect(await screen.findByText("添加你的第一个模型连接")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "添加连接" }));
  const dialog = screen.getByRole("dialog", { name: "添加连接" });
  await userEvent.type(within(dialog).getByLabelText("连接名称"), "新供应商");
  await userEvent.type(within(dialog).getByLabelText("接口地址"), "https://new.example.com/v1");
  await userEvent.type(within(dialog).getByLabelText("API Key"), "synthetic-new-key");
  await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect(await screen.findByText("配置已保存，未发起生成调用。")).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection).toMatchObject({ name: "新供应商", baseUrl: "https://new.example.com/v1", apiKey: "synthetic-new-key", models: [] });
});

it("未核实身份不显示假档位，只说明使用默认", async () => {
  routes(); page();
  expect(await screen.findByText("推理能力未核实，使用默认档位。")).toBeVisible();
  expect(screen.queryByLabelText("推理强度")).toBeNull();
});

it("R12 已核实推理档位可保存；已知非推理不显示假档位", async () => {
  const settings = fixture();
  settings.modelStatuses = settings.modelStatuses.map(item => item.modelEntryId === "first"
    ? { ...item, thinking: { levels: ["off", "low", "high", "max"], defaultLevel: "high" } } : item);
  const { posts } = routes({ settings });
  page();
  const select = await screen.findByLabelText("推理强度") as HTMLSelectElement;
  expect(select.value).toBe("default");
  expect(within(select).getByRole("option", { name: "跟随模型默认（高）" })).toBeTruthy();
  await userEvent.selectOptions(select, "high");
  expect(await screen.findByText(/推理档位已保存为“高”/)).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.connection.models[0]!.thinkingLevel).toBe("high");
});

it("读取失败不出可编辑配置；重试后恢复；弹窗 Escape 关闭返回焦点", async () => {
  const state = routes({ failRead: true }); page();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "连接配置" })).toBeNull();
  state.options.failRead = false;
  await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(await screen.findByText("型号甲")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "连接配置" }));
  const dialog = screen.getByRole("dialog", { name: "连接配置" });
  expect(within(dialog).getByLabelText("API Key")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "连接配置" })));
});

it("工作台状态刷新失败不再写配置", async () => {
  const { posts } = routes(); page(vi.fn(async () => { throw new Error("refresh failed"); }));
  await screen.findByText("型号甲");
  await userEvent.selectOptions(screen.getByLabelText("具体型号"), "second");
  await userEvent.click(screen.getByRole("button", { name: "应用选择" }));
  expect(await screen.findByText("配置已保存，但工作台状态刷新失败，请刷新页面。")).toBeVisible();
  expect(posts).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(posts).toHaveLength(1);
});
