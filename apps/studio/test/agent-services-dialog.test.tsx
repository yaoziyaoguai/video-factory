import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameSettings } from "../src/client/agent/FrameSettings.js";
import { MediaPreview } from "../src/client/agent/ProductionCards.js";
import type { Bootstrap, MediaContent, NewsNowSettings, PexelsSettings, KeyedMaterialSettings, KeylessMaterialSettings, SaveFreeServiceSettingsReceipt } from "../src/shared/agent/generated/contracts.js";

// T3-11 等免费服务 UI：列表行/开关/配置面板沿既有编辑模式——读取失败不出表单、
// 冲突重读保留草稿、同命令重试、清 Key。按 kinds 分四个页签，同 provider 共用配置：
// keyed（Pexels/Pixabay/Unsplash/Coverr）首启需 Key，keyless 只启停，热点只留 NewsNow。
// 来源署名显示见本文件 MediaSources 用例。

interface FetchCall { url: string; method: string; body: unknown }

const BOOTSTRAP: Bootstrap = {
  ownerId: "owner-1", displayName: "本地用户",
  models: [{ binding: { providerId: "pi-faux", modelId: "faux-text-1", connectionId: "conn-1", configurationRevisionId: "cfg-1" }, name: "Faux 文本", kind: "text",
    features: [], availability: "configured", verificationNote: "离线验证。", isDefault: true }],
  skills: [], defaultModelId: "faux-text-1", textConfigured: true,
} as unknown as Bootstrap;

const UNCONFIGURED_PEXELS: PexelsSettings = {
  serviceId: "pexels", revision: 0, enabled: false, credentialConfigured: false,
  endpoint: "https://api.pexels.com/v1", writeUnavailableReason: null,
};
const UNCONFIGURED_NEWSNOW: NewsNowSettings = {
  serviceId: "newsnow", revision: 0, enabled: false, endpoint: null, sourceIds: [], topics: [],
};
const unconfiguredKeyed = (serviceId: "pixabay" | "unsplash" | "coverr"): KeyedMaterialSettings =>
  ({ serviceId, revision: 0, enabled: false, credentialConfigured: false, writeUnavailableReason: null });
const unconfiguredKeyless = (serviceId: KeylessMaterialSettings["serviceId"]): KeylessMaterialSettings =>
  ({ serviceId, revision: 0, enabled: false, writeUnavailableReason: null });

const SERVICE_IDS = ["pexels", "pixabay", "unsplash", "coverr", "wikimedia", "nasa", "met", "cleveland", "archive", "freetouse", "incompetech", "douyin-music", "tiktok-sounds", "newsnow"] as const;
type ServiceId = (typeof SERVICE_IDS)[number];
type AnyServiceSettings = PexelsSettings | KeyedMaterialSettings | KeylessMaterialSettings | NewsNowSettings;

type RouteHandler = (call: FetchCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> | undefined;

interface ServiceState { settings: Record<ServiceId, AnyServiceSettings> }

function installRoutes(handlers: Partial<Record<ServiceId, RouteHandler>> = {}) {
  const calls: FetchCall[] = [];
  const state: ServiceState = { settings: {
    pexels: UNCONFIGURED_PEXELS,
    pixabay: unconfiguredKeyed("pixabay"),
    unsplash: unconfiguredKeyed("unsplash"),
    coverr: unconfiguredKeyed("coverr"),
    wikimedia: unconfiguredKeyless("wikimedia"),
    nasa: unconfiguredKeyless("nasa"),
    met: unconfiguredKeyless("met"),
    cleveland: unconfiguredKeyless("cleveland"),
    archive: unconfiguredKeyless("archive"),
    freetouse: unconfiguredKeyless("freetouse"),
    incompetech: unconfiguredKeyless("incompetech"),
    "douyin-music": unconfiguredKeyless("douyin-music"),
    "tiktok-sounds": unconfiguredKeyless("tiktok-sounds"),
    newsnow: UNCONFIGURED_NEWSNOW,
  } };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const call: FetchCall = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
    calls.push(call);
    const service = SERVICE_IDS.find(id => url.endsWith(`/settings/services/${id}`)) ?? null;
    if (service) {
      const handler = handlers[service];
      const result = await (handler?.(call) ?? defaultRoute(state, service, call));
      return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
    }
    throw new Error(`测试未模拟的请求：${call.method} ${url}`);
  }));
  return { calls, state };
}

// 缺省路由：GET 回当前事实；PATCH 按服务形状推进 revision 并回公开回执（Keyed 保存的 Key 会存回状态）。
function defaultRoute(state: ServiceState, service: ServiceId, call: FetchCall) {
  const current = state.settings[service];
  if (call.method === "GET") return { status: 200, body: current };
  const input = call.body as { enabled: boolean; apiKey?: string | null; endpoint?: string | null; sourceIds?: string[]; topics?: string[] };
  let next: AnyServiceSettings;
  if ("credentialConfigured" in current) {
    next = { ...current, revision: current.revision + 1, enabled: input.enabled,
      credentialConfigured: input.apiKey ? true : current.credentialConfigured,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}) };
  } else if (current.serviceId === "newsnow") {
    next = { ...current, revision: current.revision + 1, enabled: input.enabled,
      endpoint: input.endpoint ?? null, sourceIds: input.sourceIds ?? [], topics: input.topics ?? [] };
  } else {
    next = { ...current, revision: current.revision + 1, enabled: input.enabled };
  }
  state.settings[service] = next;
  return { status: 200, body: { settings: next, replayed: false } satisfies SaveFreeServiceSettingsReceipt };
}

function renderServicesPage() {
  return render(<FrameSettings page="services" bootstrap={BOOTSTRAP} conversations={[]} onConversation={() => {}}
    onPage={() => {}} onCatalogRefresh={vi.fn(async () => {})} />);
}

const patches = (calls: FetchCall[]) => calls.filter(call => call.method === "PATCH");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("T3 免费服务列表与配置面板", () => {
  it("F2 NewsNow 保存中锁定草稿，未知且未编辑时重试原命令", async () => {
    let rejectSave!: (reason: Error) => void;
    const pendingSave = new Promise<{ status: number; body: unknown }>((_resolve, reject) => { rejectSave = reject; });
    const { calls } = installRoutes({ newsnow: call => call.method === "GET" ? { status: 200, body: UNCONFIGURED_NEWSNOW }
      : patches(calls).length === 1 ? pendingSave : { status: 200, body: { settings: { ...UNCONFIGURED_NEWSNOW, revision: 1 }, replayed: false } } });
    renderServicesPage();
    await userEvent.click(screen.getByRole("tab", { name: /热点/ }));
    await userEvent.click(await screen.findByRole("button", { name: /配置 NewsNow/ }));
    const dialog = await screen.findByRole("dialog", { name: "配置 NewsNow" });
    const endpoint = within(dialog).getByLabelText(/实例地址/);
    await userEvent.type(endpoint, "https://draft.example");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(endpoint).toBeDisabled();
    expect(within(dialog).getByLabelText(/已配置来源 ID/)).toBeDisabled();
    expect(within(dialog).getByLabelText(/关注主题/)).toBeDisabled();
    await act(async () => { rejectSave(new Error("response lost")); });
    await within(dialog).findByText(/保存结果未知/);
    await userEvent.click(within(dialog).getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(patches(calls)[1]!.body).toEqual(patches(calls)[0]!.body);
  });

  it("四个页签按 kinds 过滤，共用 Pexels 配置；音乐默认停用且不冒称已验证", async () => {
    const { calls, state } = installRoutes();
    state.settings.pexels = { ...UNCONFIGURED_PEXELS, revision: 2, credentialConfigured: true, apiKey: "shared-key" };
    renderServicesPage();
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["热点资讯", "图片素材", "视频素材", "音乐素材"]);
    for (const name of ["Pexels", "Pixabay", "Unsplash", "Wikimedia Commons", "NASA", "The Met", "Cleveland"]) {
      expect(await screen.findByRole("switch", { name: `允许 Agent 使用 ${name}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole("switch", { name: "允许 Agent 使用 Coverr" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "允许 Agent 使用 Internet Archive" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "允许 Agent 使用 FreeToUse" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("switch", { name: "允许 Agent 使用 Pexels" })).toBeEnabled());
    await userEvent.click(screen.getByRole("switch", { name: "允许 Agent 使用 Pexels" }));
    await screen.findByText("1 个来源已选用");
    await userEvent.click(screen.getByRole("tab", { name: "视频素材" }));
    expect(screen.getByRole("switch", { name: "允许 Agent 使用 Pexels" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Pexels API Key")).toHaveValue("shared-key");
    expect(screen.getByRole("switch", { name: "允许 Agent 使用 Coverr" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "允许 Agent 使用 Internet Archive" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "允许 Agent 使用 Unsplash" })).toBeNull();
    expect(screen.queryByRole("button", { name: "配置 Internet Archive" })).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "允许 Agent 使用 Pexels" }));
    await screen.findByText("0 个来源已选用");
    expect(patches(calls).map(call => call.body)).toEqual([
      { commandId: expect.any(String), expectedRevision: 2, enabled: true, apiKey: null },
      { commandId: expect.any(String), expectedRevision: 3, enabled: false, apiKey: null },
    ]);
    expect(calls.filter(call => call.method === "GET" && call.url.endsWith("/services/pexels"))).toHaveLength(1);
    await userEvent.click(screen.getByRole("tab", { name: "音乐素材" }));
    expect(screen.getByRole("switch", { name: "允许 Agent 使用 FreeToUse" })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "配置 FreeToUse" })).toBeNull();
    expect(screen.getAllByRole("switch").map(item => item.getAttribute("aria-label")).sort()).toEqual(
      ["FreeToUse", "Incompetech", "Wikimedia Commons", "抖音热歌榜", "TikTok 热门原声"].map(name => `允许 Agent 使用 ${name}`).sort(),
    );
    for (const removed of ["Openverse", "TrendRadar", "DailyHotApi", "RSSHub", "音乐生成"]) expect(screen.queryByText(removed)).toBeNull();
  });

  it("Keyless 来源无需 Key 直接开关保存；初始状态如实展示未选用", async () => {
    const { calls } = installRoutes();
    renderServicesPage();
    const toggle = await screen.findByRole("switch", { name: "允许 Agent 使用 Wikimedia Commons" });
    await waitFor(() => expect(toggle).toBeEnabled());
    const row = screen.getByText("Wikimedia Commons").closest(".agent-service-row") as HTMLElement;
    expect(within(row).getByText("未选用")).toBeVisible();
    await userEvent.click(toggle);
    await waitFor(() => expect(within(row).getByText("已选用 · 未验证")).toBeVisible());
    const patch = patches(calls).find(call => call.url.endsWith("/settings/services/wikimedia"))!;
    expect(patch.body).toEqual({ commandId: expect.any(String), expectedRevision: 0, enabled: true });
  });

  it("Pixabay 首次启用需 Key；配置面板无 endpoint 字段，保存后行内展示 Key 与启用状态", async () => {
    const { calls } = installRoutes();
    renderServicesPage();
    const toggle = await screen.findByRole("switch", { name: "允许 Agent 使用 Pixabay" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(await screen.findByText(/首次启用 Pixabay 需要先在配置里填写 API Key/)).toBeVisible();
    expect(patches(calls).length).toBe(0);

    await userEvent.click(screen.getByRole("button", { name: "配置 Pixabay" }));
    const dialog = await screen.findByRole("dialog", { name: "配置 Pixabay" });
    expect(within(dialog).queryByLabelText("服务地址（固定）")).toBeNull();
    await userEvent.click(within(dialog).getByLabelText("允许 Agent 使用这个来源"));
    await userEvent.type(within(dialog).getByLabelText("API Key"), "pix-key-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置 Pixabay" })).toBeNull());
    expect(await screen.findByLabelText("Pixabay API Key")).toHaveValue("pix-key-1");
    const row = screen.getByText("Pixabay").closest(".agent-service-row") as HTMLElement;
    expect(within(row).getByText("已选用 · 未验证")).toBeVisible();
    const patch = patches(calls).find(call => call.url.endsWith("/settings/services/pixabay"))!;
    expect(patch.body).toEqual({ commandId: expect.any(String), expectedRevision: 0, enabled: true, apiKey: "pix-key-1" });
  });

  it("热点页显示 NewsNow 行；开关停用提交原配置不清空", async () => {
    const { calls, state } = installRoutes({
      newsnow: call => {
        if (call.method === "GET") return { status: 200, body: state.settings.newsnow };
        return undefined as never;
      },
    });
    state.settings.newsnow = { serviceId: "newsnow", revision: 3, enabled: true, endpoint: "https://news.example", sourceIds: ["zhihu", "weibo"], topics: ["科技"] };
    renderServicesPage();
    await userEvent.click(screen.getByRole("tab", { name: /热点资讯/ }));
    const toggle = await screen.findByRole("switch", { name: "允许 Agent 使用 NewsNow" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("已停用")).toBeVisible());
    const patch = patches(calls).find(call => call.url.endsWith("/settings/services/newsnow"))!;
    expect(patch.body).toEqual({ commandId: expect.any(String), expectedRevision: 3, enabled: false, endpoint: "https://news.example", sourceIds: ["zhihu", "weibo"], topics: ["科技"] });
  });

  it("Pexels 首次启用无 Key 只提示，不发命令；有 Key 后刷新页面开关直接保存", async () => {
    const { calls, state } = installRoutes();
    renderServicesPage();
    const toggle = await screen.findByRole("switch", { name: "允许 Agent 使用 Pexels" });
    await userEvent.click(toggle);
    expect(await screen.findByText(/首次启用 Pexels 需要先在配置里填写 API Key/)).toBeVisible();
    expect(patches(calls).length).toBe(0);

    // 另一页面保存 Key 后刷新本页：读取到已配置事实，开关启用直接保存（apiKey=null 保留）。
    state.settings.pexels = { serviceId: "pexels", revision: 1, enabled: false, credentialConfigured: true, endpoint: "https://api.pexels.com/v1", writeUnavailableReason: null };
    cleanup();
    renderServicesPage();
    await waitFor(() => expect(screen.getByText("已停用")).toBeVisible());
    await userEvent.click(screen.getByRole("switch", { name: "允许 Agent 使用 Pexels" }));
    await waitFor(() => expect(screen.getByText("已选用 · 未验证")).toBeVisible());
    const patch = patches(calls).find(call => call.url.endsWith("/settings/services/pexels"))!;
    expect(patch.body).toEqual({ commandId: expect.any(String), expectedRevision: 1, enabled: true, apiKey: null });
  });

  it("Pexels 配置面板：读取失败只显示重试；首次启用必须填 Key；保存成功清 Key 并更新行状态", async () => {
    let gets = 0;
    const { calls } = installRoutes({
      pexels: call => {
        // 页面首次 GET 成功；配置面板打开时的 GET 失败一次，重试成功。
        if (call.method === "GET" && ++gets === 2) return { status: 503, body: { code: "TEMPORARILY_UNAVAILABLE", message: "服务暂不可用。", requestId: "r", retryAction: "wait", currentRevisionId: null } };
        return undefined as never;
      },
    });
    renderServicesPage();
    await userEvent.click(await screen.findByRole("button", { name: /配置 Pexels/ }));
    expect(await screen.findByText("配置读取失败，无法编辑。")).toBeVisible();
    expect(screen.queryByLabelText("API Key")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    const keyInput = await screen.findByLabelText("API Key");
    expect((screen.getByLabelText("服务地址（固定）") as HTMLInputElement).value).toBe("https://api.pexels.com/v1");

    await userEvent.click(screen.getByLabelText("允许 Agent 使用这个来源"));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("首次启用 Pexels 必须填写 API Key。")).toBeVisible();
    expect(patches(calls).length).toBe(0);

    await userEvent.type(keyInput, "px-key-1");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置 Pexels" })).toBeNull());
    expect(await screen.findByText("已选用 · 未验证")).toBeVisible();
    const patch = patches(calls).find(call => call.url.endsWith("/settings/services/pexels"))!;
    expect(patch.body).toEqual({ commandId: expect.any(String), expectedRevision: 0, enabled: true, apiKey: "px-key-1" });
  });

  it("NewsNow 配置面板：启用校验来源与地址；409 冲突展示最新事实并保留草稿，重存成功", async () => {
    const { calls, state } = installRoutes({
      newsnow: call => {
        if (call.method === "PATCH" && (call.body as { expectedRevision: number }).expectedRevision === 0) {
          // 模拟另一页面先保存：返回 409，下一次 GET 给出新事实。
          state.settings.newsnow = { serviceId: "newsnow", revision: 5, enabled: false, endpoint: "https://other.example", sourceIds: ["hackernews"], topics: [] };
          return { status: 409, body: { code: "STALE_REVISION", message: "设置已被其他页面修改，请读取最新状态后重试。", requestId: "r", retryAction: "reread", currentRevisionId: null } };
        }
        return undefined as never;
      },
    });
    renderServicesPage();
    await userEvent.click(screen.getByRole("tab", { name: /热点资讯/ }));
    await userEvent.click(await screen.findByRole("button", { name: /配置 NewsNow/ }));
    const dialog = await screen.findByRole("dialog", { name: "配置 NewsNow" });

    // 启用但缺地址与来源：字段错误，不发命令。
    await userEvent.click(within(dialog).getByLabelText("允许 Agent 使用这个来源"));
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("启用 NewsNow 需要实例地址和 1–5 个来源 ID。")).toBeVisible();
    expect(patches(calls).length).toBe(0);

    await userEvent.type(within(dialog).getByLabelText("实例地址"), "https://news.example");
    await userEvent.type(within(dialog).getByLabelText(/已配置来源 ID/), "zhihu、weibo");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    // 409：展示最新公开值并保留草稿输入。
    expect(await within(dialog).findByText("设置已被其他页面修改；你的输入已保留，请对照当前配置后再次保存。")).toBeVisible();
    expect(within(dialog).getByLabelText("实例地址")).toHaveValue("https://news.example");
    const latest = within(dialog).getByLabelText("当前已保存 NewsNow 配置");
    expect(latest).toHaveTextContent("https://other.example");
    expect(latest).toHaveTextContent("hackernews");
    const patch1 = patches(calls).at(-1)!;
    expect(patch1.body).toEqual({ commandId: expect.any(String), expectedRevision: 0, enabled: true, endpoint: "https://news.example", sourceIds: ["zhihu", "weibo"], topics: [] });

    // 重存走新 revision 成功，对话框关闭。
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置 NewsNow" })).toBeNull());
    const patch2 = patches(calls).at(-1)!;
    expect((patch2.body as { expectedRevision: number }).expectedRevision).toBe(5);
    expect(await screen.findByText("已选用 · 未验证")).toBeVisible();
  });

  it("行开关保存中禁重复，响应丢失后重试原命令", async () => {
    let rejectSave!: (error: Error) => void;
    let count = 0;
    const { calls, state } = installRoutes({
      pexels: call => {
        if (call.method === "PATCH" && ++count === 1) return new Promise((_resolve, reject) => { rejectSave = reject; });
        return undefined as never;
      },
    });
    state.settings.pexels = { ...UNCONFIGURED_PEXELS, revision: 1, credentialConfigured: true };
    renderServicesPage();
    const toggle = await screen.findByRole("switch", { name: "允许 Agent 使用 Pexels" });
    await waitFor(() => expect(toggle).toBeEnabled());
    await userEvent.click(toggle);
    expect(toggle).toBeDisabled();
    rejectSave(new Error("response lost"));
    await userEvent.click(await screen.findByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(screen.getByText("已选用 · 未验证")).toBeVisible());
    expect(patches(calls)).toHaveLength(2);
    expect(patches(calls)[1]!.body).toEqual(patches(calls)[0]!.body);
  });

  it("搜索只筛当前页签；无结果可清除恢复", async () => {
    installRoutes();
    renderServicesPage();
    await screen.findByRole("switch", { name: "允许 Agent 使用 Pexels" });
    await userEvent.type(screen.getByLabelText("搜索服务"), "zzz不存在");
    expect(await screen.findByText("没有匹配的服务")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(await screen.findByRole("switch", { name: "允许 Agent 使用 Pexels" })).toBeVisible();
    // 切到热点页签后搜索词不串页。
    await userEvent.type(screen.getByLabelText("搜索服务"), "zzz不存在");
    await userEvent.click(screen.getByRole("tab", { name: /热点资讯/ }));
    expect(await screen.findByRole("switch", { name: "允许 Agent 使用 NewsNow" })).toBeVisible();
  });
});

describe("T3 产物来源署名显示", () => {
  it("音乐音频按真实来源标注并保留署名，未知用途的音频用中性预览名", () => {
    const music: MediaContent = { format: "media", blobId: "music-blob", mimeType: "audio/mpeg", durationMs: 3000, sources: [{
      provider: "freetouse", assetId: "track-1", title: "Rain", creatorName: "作者甲、作者乙", creatorUrl: null,
      sourceUrl: "https://freetouse.com/music/track-1", licenseUrl: "https://freetouse.com/license", licenseName: "FreeToUse Non-Premium",
      acquiredAt: "2026-01-01T00:00:00Z", usageScope: "个人社交平台 UGC，需署名", attributionText: "Rain by 作者甲、作者乙 — https://freetouse.com/music",
    }] };
    const ui = render(<MediaPreview content={music} simulated={false} />);
    expect(screen.getByLabelText("音乐预览")).toHaveAttribute("controls");
    expect(screen.getByRole("textbox", { name: "发布署名" })).toHaveValue(music.sources![0]!.attributionText);
    expect(screen.getByRole("link", { name: "FreeToUse Non-Premium" })).toHaveAttribute("href", "https://freetouse.com/license");
    ui.rerender(<MediaPreview content={{ format: "media", blobId: "unknown-audio", mimeType: "audio/mpeg", durationMs: 3000 }} simulated={false} />);
    expect(screen.getByLabelText("音频预览")).toHaveAttribute("src", "/api/agent/v1/blobs/unknown-audio/content");
    expect(screen.queryByLabelText("配音预览")).toBeNull();
  });

  const content = (sources: MediaContent["sources"]): MediaContent => sources
    ? { format: "media", blobId: "blob-1", mimeType: "image/jpeg", durationMs: null, sources }
    : { format: "media", blobId: "blob-1", mimeType: "image/jpeg", durationMs: null };

  it("有来源时显示作者、原素材与许可链接；无来源不造署名", () => {
    const { container } = render(<MediaPreview content={content([{
      provider: "pexels", assetId: "12345", sourceUrl: "https://www.pexels.com/photo/12345/",
      creatorName: "Ada Lens", creatorUrl: "https://www.pexels.com/@ada", licenseUrl: "https://www.pexels.com/license/",
      acquiredAt: "2026-10-27T00:00:00Z",
    }])} simulated={false} />);
    expect(container.querySelector(".agent-media-sources")!.textContent).toContain("Ada Lens");
    expect(container.querySelector('.agent-media-sources a[href="https://www.pexels.com/photo/12345/"]')).not.toBeNull();
    expect(container.querySelector('.agent-media-sources a[href="https://www.pexels.com/license/"]')).not.toBeNull();

    const bare = render(<MediaPreview content={content(undefined)} simulated={false} />);
    expect(bare.container.querySelector(".agent-media-sources")).toBeNull();
  });
});

it("已保存的素材 Key 直接展示在行内；Pexels Key 可在配置面板查看编辑；占位热点不再渲染", async () => {
  const { state } = installRoutes();
  state.settings.pexels = { ...UNCONFIGURED_PEXELS, apiKey: "pexels-visible", credentialConfigured: true };
  state.settings.pixabay = { serviceId: "pixabay", revision: 2, enabled: true, credentialConfigured: true, apiKey: "pixabay-visible", writeUnavailableReason: null };
  renderServicesPage();
  expect(await screen.findByLabelText("Pexels API Key")).toHaveValue("pexels-visible");
  expect(await screen.findByLabelText("Pixabay API Key")).toHaveValue("pixabay-visible");
  expect(screen.queryByRole("switch", { name: "允许 Agent 使用 Pixabay" })).not.toBeNull();
  expect(await screen.findByText("1 个来源已选用")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "配置 Pexels" }));
  expect(await screen.findByLabelText("API Key")).toHaveValue("pexels-visible");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "text");
  await userEvent.click(screen.getByRole("button", { name: "关闭配置" }));
  await userEvent.click(screen.getByRole("tab", { name: "热点资讯" }));
  expect(await screen.findByRole("switch", { name: "允许 Agent 使用 NewsNow" })).toBeInTheDocument();
  expect(screen.queryByText("RSSHub")).toBeNull();
  expect(screen.queryByLabelText("RSSHub API Key")).toBeNull();
});
