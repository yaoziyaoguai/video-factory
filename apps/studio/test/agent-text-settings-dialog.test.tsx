import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameSettings } from "../src/client/agent/FrameSettings.js";
import type { Bootstrap, Conversation } from "../src/shared/agent/generated/contracts.js";


interface FetchCall { url: string; method: string; body: unknown }
type RouteResult = { status: number; body: unknown };
const BOOTSTRAP = { ownerId: "owner-1", displayName: "本地用户", models: [], skills: [], defaultModelId: "", textConfigured: true } as unknown as Bootstrap;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("用户页资料 (T2-08/T2-10)", () => {
  function installProfileRoutes(profileSource: () => { revision: number; displayName: string; bio: string }, onPatch?: (call: FetchCall) => RouteResult | Promise<RouteResult>) {
    const calls: FetchCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const call: FetchCall = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined };
      calls.push(call);
      if (url.endsWith("/api/agent/v1/profile") && call.method === "GET") return new Response(JSON.stringify(profileSource()), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/agent/v1/profile") && call.method === "PATCH") {
        const result = await (onPatch?.(call) ?? { status: 200, body: { profile: profileSource(), replayed: false } });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
      }
      throw new Error(`测试未模拟的请求：${call.method} ${url}`);
    }));
    return calls;
  }

  function renderProfilePage(onCatalogRefresh = vi.fn(async () => {})) {
    return render(<FrameSettings page="profile" bootstrap={BOOTSTRAP} conversations={[] as Conversation[]} onConversation={() => {}}
      onPage={() => {}} onCatalogRefresh={onCatalogRefresh} />);
  }

  it("读取失败不出表单；重试后可编辑", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/api/agent/v1/profile") && fail) { fail = false; throw new Error("读不出来"); }
      return new Response(JSON.stringify({ revision: 2, displayName: "山中创作者", bio: "第一行" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    renderProfilePage();
    expect(await screen.findByText("资料读取失败，无法编辑。")).toBeVisible();
    expect(screen.queryByLabelText("显示名称")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByLabelText("显示名称")).toHaveValue("山中创作者");
  });

  it("空名称不发命令；保存成功后同步公开目录", async () => {
    const onCatalogRefresh = vi.fn(async () => {});
    const calls = installProfileRoutes(() => ({ revision: 2, displayName: "本地用户", bio: "" }));
    renderProfilePage(onCatalogRefresh);
    await screen.findByLabelText("显示名称");
    await userEvent.clear(screen.getByLabelText("显示名称"));
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("请填写显示名称。")).toBeVisible();
    expect(calls.filter(call => call.method === "PATCH")).toHaveLength(0);

    await userEvent.type(screen.getByLabelText("显示名称"), "  山中创作者  ");
    await userEvent.type(screen.getByLabelText("个人简介"), "第一行\n第二行");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText("个人资料已保存。")).toBeVisible();
    expect(onCatalogRefresh).toHaveBeenCalledTimes(1);
    const sent = calls.filter(call => call.method === "PATCH").at(-1)!.body as { commandId: string; expectedRevision: number; displayName: string; bio: string };
    expect(sent).toEqual({ commandId: sent.commandId, expectedRevision: 2, displayName: "山中创作者", bio: "第一行\n第二行" });
  });

  it("保存冲突：重读并提示；响应不明保留同命令重试", async () => {
    let mode: "conflict" | "lost" | "ok" = "conflict";
    const profile = { revision: 2, displayName: "本地用户", bio: "" };
    const fresh = { revision: 5, displayName: "山中创作者", bio: "" };
    const calls = installProfileRoutes(() => (mode === "conflict" ? profile : fresh), call => {
      if (call.method === "PATCH" && mode === "conflict") {
        mode = "lost";
        return { status: 409, body: { code: "STALE_REVISION", message: "资料已被其他页面修改。", requestId: "r", retryAction: "refresh", currentRevisionId: null } };
      }
      if (call.method === "PATCH" && mode === "lost") {
        mode = "ok";
        throw new Error("lost response");
      }
      return { status: 200, body: { profile: fresh, replayed: false } };
    });
    renderProfilePage();
    await screen.findByLabelText("显示名称");
    await userEvent.clear(screen.getByLabelText("显示名称"));
    await userEvent.type(screen.getByLabelText("显示名称"), "山中创作者");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/已被其他页面修改/)).toBeVisible();
    expect(screen.getByLabelText("当前已保存资料")).toHaveTextContent("山中创作者");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/保存结果未知/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "重试保存" }));
    expect(await screen.findByText("个人资料已保存。")).toBeVisible();
    const sent = calls.filter(call => call.method === "PATCH").map(call => call.body as { commandId: string; expectedRevision: number });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.commandId).toBe(sent[1]!.commandId);
    expect(sent[1]!.commandId).not.toBe(sent[0]!.commandId);
    expect(sent[1]!.expectedRevision).toBe(5);
  });
  it("资料已保存但侧栏读取失败时不重写资料", async () => {
    const profile = { revision: 1, displayName: "名字", bio: "简介" };
    const calls = installProfileRoutes(() => profile, () => ({ status: 200, body: { profile, replayed: false } }));
    const refresh = vi.fn().mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(undefined);
    renderProfilePage(refresh); await screen.findByLabelText("显示名称");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByText(/资料已保存，侧栏刷新失败/)).toBeVisible();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await waitFor(() => expect(screen.queryByText(/侧栏刷新失败/)).toBeNull());
    expect(calls.filter(call => call.method === "PATCH")).toHaveLength(1);
  });

});
