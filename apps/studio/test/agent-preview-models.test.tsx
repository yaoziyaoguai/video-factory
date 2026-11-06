import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PreviewSettings } from "../src/client/agent/preview/PreviewSettings.js";

function renderModels() {
  render(
    <PreviewSettings
      page="models"
      skills={[]}
      onSkillsChange={() => undefined}
      onPage={() => undefined}
    />,
  );
  return userEvent.setup();
}

describe("第一阶段：按供应商选择具体型号", () => {
  it("同一连接能切换型号，应用前保持当前项，应用后原型号留作备选", async () => {
    const user = renderModels();
    expect(screen.getByLabelText("供应商连接")).toHaveValue("阿里云百炼");
    await user.selectOptions(screen.getByLabelText("具体型号"), "qwen-max");
    expect(
      screen.getByRole("heading", { name: "通义千问 Plus" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "应用选择" }));
    expect(screen.getByRole("heading", { name: "通义千问 Max" })).toBeVisible();
    const original = screen.getByText("通义千问 Plus", { selector: "strong" });
    expect(original).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "移除 通义千问 Plus" }),
    );
    expect(original).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通义千问 Max" })).toBeVisible();
  });

  it("切换供应商后要选具体型号，不会擅自将第一个型号设为当前", async () => {
    const user = renderModels();
    await user.selectOptions(screen.getByLabelText("供应商连接"), "DeepSeek");
    expect(screen.getByLabelText("具体型号")).toHaveValue("");
    expect(screen.getByRole("button", { name: "应用选择" })).toBeDisabled();
    expect(
      screen.getByRole("heading", { name: "通义千问 Plus" }),
    ).toBeVisible();
    expect(
      within(screen.getByLabelText("具体型号")).queryByRole("option", {
        name: /通义千问/,
      }),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("具体型号"), "deepseek-pro");
    await user.click(screen.getByRole("button", { name: "应用选择" }));
    expect(
      screen.getByRole("heading", { name: "DeepSeek V4 Pro" }),
    ).toBeVisible();
    expect(screen.getByLabelText("供应商连接")).toHaveValue("DeepSeek");
  });

  it.each([
    ["图片模型", "seedream-3", "Seedream 3.0"],
    ["视频模型", "seedance-lite", "Seedance 1.0 Lite"],
    ["配音模型", "minimax-hd", "MiniMax Speech 2.8 HD"],
  ])(
    "%s 也能选择同一供应商下的具体型号，各类当前项独立",
    async (tab, id, name) => {
      const user = renderModels();
      await user.click(screen.getByRole("tab", { name: tab }));
      await user.selectOptions(screen.getByLabelText("具体型号"), id);
      await user.click(screen.getByRole("button", { name: "应用选择" }));
      expect(screen.getByRole("heading", { name })).toBeVisible();
      await user.click(screen.getByRole("tab", { name: "文本大模型" }));
      expect(
        screen.getByRole("heading", { name: "通义千问 Plus" }),
      ).toBeVisible();
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(screen.getByLabelText("具体型号")).toHaveValue(id);
    },
  );

  it("目录按供应商分组；同步不改当前型号，移除当前型号后不自动回退", async () => {
    const user = renderModels();
    await user.click(screen.getByRole("button", { name: "管理备选" }));
    const directory = screen.getByRole("group", { name: "从目录选择" });
    expect(
      within(directory).getByRole("heading", { name: "DeepSeek" }),
    ).toBeVisible();
    await user.click(
      within(directory).getByRole("button", { name: "同步目录" }),
    );
    expect(screen.getByLabelText("具体型号")).toHaveValue("qwen");
    await user.click(
      within(directory).getByRole("checkbox", { name: /通义千问 Plus/ }),
    );
    await user.click(screen.getByRole("button", { name: "移除并暂不配置" }));
    expect(
      screen.getByRole("heading", { name: "还没有当前模型" }),
    ).toBeVisible();
    expect(screen.getByLabelText("具体型号")).toHaveValue("");
    await user.selectOptions(screen.getByLabelText("具体型号"), "qwen-max");
    await user.click(screen.getByRole("button", { name: "应用选择" }));
    expect(screen.getByRole("heading", { name: "通义千问 Max" })).toBeVisible();
  });
});
