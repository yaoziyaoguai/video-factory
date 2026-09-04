import { describe, expect, it } from "vitest";
import { creatorFacingTechnicalText, humanizeCreativeText, providerLabel, providerModelLabel } from "../src/client/presentation.js";

describe("creator-facing presentation labels", () => {
  it("does not expose internal provider ids or director routing codes", () => {
    expect(providerLabel("human-editor")).toBe("人工编辑");
    expect(providerLabel("unknown-provider-v1")).toBeUndefined();
    expect(providerModelLabel(undefined, "internal-model-id")).toBe("未识别模型");
    expect(humanizeCreativeText("knowledge-failed-intuition：generated_image，REUSE_ONLY scene 2"))
      .toBe("打破直觉：AI 图片生成，复用镜头 2");
  });

  it("turns system diagnostics into creator language without rewriting creative copy", () => {
    const technical = creatorFacingTechnicalText("Agent Provider Broker schema manifest fallback taskId api-visual-director-v1 primary provider timed out");
    expect(technical).toBe("AI 服务 AI 服务 数据格式 资源清单 备用方案 任务编号 内部能力 首选服务响应超时");
    expect(technical).not.toMatch(/Agent|Provider|Broker|schema|manifest|fallback|taskId|api-visual-director-v1/i);

    const creatorCopy = "我的 Provider 不是故事主角，Agent 也不是标题。";
    expect(humanizeCreativeText(creatorCopy)).toBe(creatorCopy);
  });
});
