import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteErrorBoundary } from "../src/client/components/RouteErrorBoundary.js";

describe("route loading recovery", () => {
  it("keeps the page readable and offers reload when a page chunk fails", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenPage(): never { throw new Error("Failed to fetch dynamically imported module"); }
    render(<RouteErrorBoundary><BrokenPage /></RouteErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("页面文件未能加载");
    expect(screen.getByRole("button", { name: "重新加载页面" })).toBeEnabled();
    logged.mockRestore();
  });
  it("preserves normal children without adding another visible surface", () => {
    render(<RouteErrorBoundary><main>当前有效稿</main></RouteErrorBoundary>);
    expect(screen.getByRole("main")).toHaveTextContent("当前有效稿");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
