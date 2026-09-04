import { describe, expect, it } from "vitest";
import { RUN_NODE_ORDER, creatorFacingTechnicalText, humanizeCreativeText, providerLabel, providerModelLabel, runNodeLabel } from "../src/client/presentation.js";

describe("creator-facing presentation labels", () => {
  it("does not expose internal provider ids or director routing codes", () => {
    expect(providerLabel("human-editor")).toBe("人工编辑");
    expect(providerLabel("unknown-provider-v1")).toBeUndefined();
    expect(providerModelLabel(undefined, "internal-model-id")).toBe("未识别模型");
    expect(humanizeCreativeText("knowledge-failed-intuition：generated_image，REUSE_ONLY scene 2"))
      .toBe("打破直觉：AI 图片生成，复用镜头 2");
  });

  it("places the source-asset gate between paid visuals and voice", () => {
    expect(runNodeLabel("asset-source-review")).toBe("生成画面预检");
    expect(RUN_NODE_ORDER.indexOf("asset-source-review")).toBe(RUN_NODE_ORDER.indexOf("assets") + 1);
    expect(RUN_NODE_ORDER.indexOf("voice")).toBe(RUN_NODE_ORDER.indexOf("asset-source-review") + 1);
  });

  it("turns system diagnostics into creator language without rewriting creative copy", () => {
    const technical = creatorFacingTechnicalText("Agent Provider Broker schema manifest fallback taskId api-visual-director-v1 primary provider timed out");
    expect(technical).toBe("AI 服务 AI 服务 数据格式 资源清单 备用方案 任务编号 内部能力 首选服务响应超时");
    expect(technical).not.toMatch(/Agent|Provider|Broker|schema|manifest|fallback|taskId|api-visual-director-v1/i);

    const creatorCopy = "我的 Provider 不是故事主角，Agent 也不是标题。";
    expect(humanizeCreativeText(creatorCopy)).toBe(creatorCopy);
  });

  it("translates persisted worker provenance into clear Chinese", () => {
    expect(creatorFacingTechnicalText("VideoFactory generated script; human review required before publishing."))
      .toBe("AI 生成脚本；发布前需要人工核对事实与表述。");
    expect(creatorFacingTechnicalText("License snapshot is stored per scene asset in this plan."))
      .toBe("本方案按镜头保存了每项素材的授权记录。");
    expect(creatorFacingTechnicalText("Asset rights require review."))
      .toBe("素材使用权需要人工核对。");
    expect(creatorFacingTechnicalText("Locally generated narration; verify the selected voice provider terms."))
      .toBe("本机生成的配音；发布前需核对所选配音服务的使用条款。");
    expect(creatorFacingTechnicalText("VideoFactory voice timeline metadata."))
      .toBe("配音时间轴记录。");
    expect(creatorFacingTechnicalText("Composite output; see the linked asset and voiceover plans for source terms."))
      .toBe("合成成片；素材与配音的来源条款请查看关联的画面和配音方案。");
    expect(creatorFacingTechnicalText("VideoFactory render metadata."))
      .toBe("成片渲染记录。");
    expect(creatorFacingTechnicalText("VideoFactory technical review result."))
      .toBe("机器质检结果。");
  });
});
