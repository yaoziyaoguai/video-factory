import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { studioApi } from "../src/client/api.js";
import { AuthGate } from "../src/client/components/AuthGate.js";

describe("AuthGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("turns a signed-out session into an accessible login and resumes the studio", async () => {
    const user = userEvent.setup();
    vi.spyOn(studioApi, "authSession").mockResolvedValue({ enabled: true, authenticated: false });
    const login = vi.spyOn(studioApi, "login").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });

    render(<AuthGate>{({ username }) => <div>创作台 {username}</div>}</AuthGate>);

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("用户名"), "owner");
    await user.type(screen.getByLabelText("密码"), "correct password");
    await user.click(screen.getByRole("button", { name: "进入 VideoFactory" }));

    expect(login).toHaveBeenCalledWith("owner", "correct password");
    expect(await screen.findByText("创作台 owner")).toBeInTheDocument();
  });

  it("does not interrupt local development when authentication is disabled", async () => {
    vi.spyOn(studioApi, "authSession").mockResolvedValue({ enabled: false, authenticated: true });
    render(<AuthGate>{({ logout }) => <div>{logout ? "可退出" : "本地创作台"}</div>}</AuthGate>);
    expect(await screen.findByText("本地创作台")).toBeInTheDocument();
  });

  it("returns to login immediately when an authenticated API request reports an expired session", async () => {
    vi.spyOn(studioApi, "authSession").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });
    render(<AuthGate>{({ username }) => <div>创作台 {username}</div>}</AuthGate>);
    expect(await screen.findByText("创作台 owner")).toBeInTheDocument();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "请先登录 VideoFactory。" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));
    await expect(studioApi.settings()).rejects.toThrow("请先登录 VideoFactory。");

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
  });

  it("returns to login when concurrent artifact reads both report 401", async () => {
    vi.spyOn(studioApi, "authSession").mockResolvedValue({ enabled: true, authenticated: true, username: "owner" });
    render(<AuthGate>{({ username }) => <div>制作路由 {username}</div>}</AuthGate>);
    expect(await screen.findByText("制作路由 owner")).toBeInTheDocument();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "请先登录 VideoFactory。" }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));

    await Promise.allSettled([
      studioApi.resourceJson("/api/runs/run-1/artifacts/a/content"),
      studioApi.resourceJson("/api/runs/run-1/artifacts/b/content"),
    ]);

    expect(await screen.findByRole("heading", { name: "回到创作现场" })).toBeInTheDocument();
  });
});
