import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "../src/client/auth-api.js";
import { agentApi } from "../src/client/agent/api.js";
import { AuthGate } from "../src/client/components/AuthGate.js";

describe("AuthGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("turns a signed-out session into an accessible login and resumes the studio", async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, "authSession").mockResolvedValue({ enabled: true, authenticated: false });
    const login = vi.spyOn(authApi, "login").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });

    render(<AuthGate>{({ username }) => <div>创作台 {username}</div>}</AuthGate>);

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "暗房里投影机映出的光束" })).toHaveAttribute("src", "/media/atelier/projector.webp");
    await user.type(screen.getByLabelText("用户名"), "owner");
    await user.type(screen.getByLabelText("密码"), "correct password");
    await user.click(screen.getByRole("button", { name: "进入 帧间 Frame" }));

    expect(login).toHaveBeenCalledWith("owner", "correct password");
    expect(await screen.findByText("创作台 owner")).toBeInTheDocument();
  });

  it("does not interrupt local development when authentication is disabled", async () => {
    vi.spyOn(authApi, "authSession").mockResolvedValue({ enabled: false, authenticated: true });
    render(<AuthGate>{({ logout }) => <div>{logout ? "可退出" : "本地创作台"}</div>}</AuthGate>);
    expect(await screen.findByText("本地创作台")).toBeInTheDocument();
  });

  it("returns to login immediately when an authenticated API request reports an expired session", async () => {
    vi.spyOn(authApi, "authSession").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });
    render(<AuthGate>{({ username }) => <div>创作台 {username}</div>}</AuthGate>);
    expect(await screen.findByText("创作台 owner")).toBeInTheDocument();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "请先登录 Frame。" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));
    await expect(agentApi.bootstrap()).rejects.toThrow("请先登录 Frame。");

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
  });

  it("returns to login when concurrent artifact reads both report 401", async () => {
    vi.spyOn(authApi, "authSession").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });
    render(<AuthGate>{({ username }) => <div>制作路由 {username}</div>}</AuthGate>);
    expect(await screen.findByText("制作路由 owner")).toBeInTheDocument();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "请先登录 Frame。" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));

    await Promise.allSettled([
      agentApi.readRevision("art-a", "rev-a"),
      agentApi.readRevision("art-b", "rev-b"),
    ]);

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
  });

  it("clears only local creative drafts and pending commands after logout succeeds", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        get length() { return values.size; },
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => Array.from(values.keys())[index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const user = userEvent.setup();
    vi.spyOn(authApi, "authSession").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });
    vi.spyOn(authApi, "logout").mockResolvedValue(undefined);
    window.localStorage.setItem("vf:agent-draft:conversation-1", "未发送草稿");
    window.localStorage.setItem("vf:agent-send:conversation-1", "待观察命令");
    window.localStorage.setItem("vf:unrelated", "保留");
    render(<AuthGate>{({ logout }) => <button type="button" onClick={() => void logout?.()}>退出</button>}</AuthGate>);

    await user.click(await screen.findByRole("button", { name: "退出" }));
    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
    expect(window.localStorage.getItem("vf:agent-draft:conversation-1")).toBeNull();
    expect(window.localStorage.getItem("vf:agent-send:conversation-1")).toBeNull();
    expect(window.localStorage.getItem("vf:unrelated")).toBe("保留");
  });
});
