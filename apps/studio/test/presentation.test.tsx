import { describe, expect, it } from "vitest";
import { buildProviderCatalog } from "../src/server/provider-catalog.js";
import { RUN_NODE_ORDER, catalogModelLabel, creatorFacingTechnicalText, humanizeCreativeText, providerLabel, providerModelLabel, runNodeLabel } from "../src/client/presentation.js";

describe("creator-facing presentation labels", () => {
  it("does not expose internal provider ids or director routing codes", () => {
    expect(providerLabel("human-editor")).toBe("人工编辑");
    expect(providerLabel("human-editor-private-state")).toBe("人工编辑记录");
    expect(providerLabel("human-validated-director-plan-v1")).toBe("人工确认导演方案");
    expect(providerLabel("multiple")).toBe("多来源制作记录");
    expect(providerLabel("codex-role-auditor-v1")).toBe("AI 独立质量复核");
    expect(providerLabel("unknown-provider-v1")).toBeUndefined();
    expect(providerModelLabel(undefined, "internal-model-id")).toBe("未识别模型");
    expect(humanizeCreativeText("knowledge-failed-intuition：generated_image，REUSE_ONLY scene 2"))
      .toBe("打破直觉：AI 图片生成，复用镜头 2");
  });

  it("maps catalog model ids to labels and leaves unmapped ids to the caller", () => {
    const providers = [{ modelProfiles: [{ id: "glm-5.3-flash", label: "GLM-5.3-Flash" }] }];
    expect(catalogModelLabel(providers, "glm-5.3-flash")).toBe("GLM-5.3-Flash");
    expect(catalogModelLabel(providers, "secret-internal-model")).toBeUndefined();
    expect(catalogModelLabel(providers, undefined)).toBeUndefined();
  });

  it("declares official console entries only for metered providers that can require reconciliation", () => {
    const catalog = buildProviderCatalog({ python: true, ffmpeg: true, ffprobe: true, say: true }, {});
    const consoleUrl = (id: string) => catalog.find((provider) => provider.id === id)?.consoleUrl;
    expect(consoleUrl("minimax-tts-v1")).toBe("https://platform.minimaxi.com/");
    expect(consoleUrl("hailuo-video-v1")).toBe("https://platform.minimaxi.com/");
    expect(consoleUrl("seedance-video-v1")).toBe("https://console.volcengine.com/ark");
    expect(consoleUrl("seedream-image-v1")).toBe("https://console.volcengine.com/ark");
    expect(consoleUrl("wan-video-v1")).toBe("https://bailian.console.aliyun.com/");
    expect(consoleUrl("pexels-stock-v1")).toBeUndefined();
    expect(consoleUrl("pixabay-stock-v1")).toBeUndefined();
    expect(consoleUrl("kling-video-v1")).toBeUndefined();
  });

  it("places the source-asset gate between paid visuals and voice", () => {
    expect(runNodeLabel("asset-source-review")).toBe("生成画面预检");
    expect(RUN_NODE_ORDER.indexOf("asset-source-review")).toBe(RUN_NODE_ORDER.indexOf("assets") + 1);
    expect(RUN_NODE_ORDER.indexOf("voice")).toBe(RUN_NODE_ORDER.indexOf("asset-source-review") + 1);
  });

  it("turns system diagnostics into creator language without rewriting creative copy", () => {
    const technical = creatorFacingTechnicalText("Agent Provider Broker schema manifest fallback taskId api-visual-director-v1 primary provider timed out blocking");
    expect(technical).toBe("AI 服务 AI 服务 数据格式 资源清单 备用方案 任务编号 内部能力 首选服务响应超时 必须修改的问题");
    expect(technical).not.toMatch(/Agent|Provider|Broker|schema|manifest|fallback|taskId|api-visual-director-v1|blocking/i);
    expect(creatorFacingTechnicalText("Codex 独立质量审计 · xhigh 推理 · 阻断门禁"))
      .toBe("Codex 独立质量复核 · 深入推理 · 不通过则要求修改");
    expect(creatorFacingTechnicalText("Codex 独立质量审计 Agent")).toBe("Codex 独立质量复核");

    const creatorCopy = "我的 Provider 不是故事主角，Agent 也不是标题。";
    expect(humanizeCreativeText(creatorCopy)).toBe(creatorCopy);
  });

  it("publishes the independent reviewer catalog in creator language", () => {
    const catalog = buildProviderCatalog({ python: true, ffmpeg: true, ffprobe: true, say: true }, {});
    const reviewer = catalog.find((provider) => provider.id === "codex-role-auditor-v1");
    expect(reviewer?.label).toBe("AI 独立质量复核");
    expect(reviewer?.description).toContain("创作依据");
    expect(reviewer?.modes).toEqual(["独立复核", "深入核对", "最多三轮", "不通过则要求修改"]);
    expect([reviewer?.label, reviewer?.description, ...(reviewer?.modes ?? [])].join(" "))
      .not.toMatch(/Codex|审计|xhigh|门禁|角色合同|下游边界/);
  });

  it("hides internal actor and local service connection details", () => {
    const diagnostics = [
      "studio-owner：需要宿主机 Codex bridge 服务正在监听，并将 VIDEO_FACTORY_CODEX_SOCKET_PATH 指向该 Unix socket。 当前：未找到 Codex bridge socket '/run/video-factory-codex/worker.sock'；请确认宿主机 broker 已启动。",
      "需要 ZAI Code Plan broker 正在监听，并将 VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH 指向该 Unix socket。 当前：未找到 Codex bridge socket '/run/video-factory-zai-codex/worker.sock'；请确认宿主机 broker 已启动。",
    ];

    for (const diagnostic of diagnostics) {
      const technical = creatorFacingTechnicalText(diagnostic);
      expect(technical).toContain("AI 创作服务尚未连接");
      expect(technical).not.toMatch(/studio-owner|VIDEO_FACTORY_|\/run\/video-factory|socket|宿主机|bridge|broker/i);
    }
    expect(creatorFacingTechnicalText(diagnostics[0])).toContain("由你确认");
    expect(creatorFacingTechnicalText("已按 hook_and_scene_midpoints 的稀疏证据逐场核对。请调整 source_assets 或画面 Provider。"))
      .toBe("已抽查各镜头关键帧，未覆盖逐帧运动与声音。请调整源素材预检或画面服务。");
  });

  it("drops machine diagnostics and candidate identities from a failure narrative", () => {
    // 落过盘的那句原文（candidate-cache 的形态）：候选身份、"输出未通过合同（reasonCode）"，
    // 尾巴上还挂着一串 stage=/httpStatus= 的诊断。
    const diagnostic = "2 个候选模型均未能完成：1. gpt-5.6-sol 暂时不可用；2. glm-5.3 输出未通过合同（invalid_json）。\n诊断：stage=completed_failure；httpStatus=422；reasonCode=invalid_json";
    const shown = creatorFacingTechnicalText(diagnostic) ?? "";

    expect(shown).toBe("候选模型都没能给出可用结果。");
    expect(shown).not.toMatch(/诊断：|stage=|httpStatus=|reasonCode=|invalid_json|gpt-5\.6-sol|glm-5\.3/);
    // 审片侧的同类叙述带"视觉审片的"前缀，前缀是创作者需要的语境，要留住。
    expect(creatorFacingTechnicalText("视觉审片的 2 个候选模型均未能完成：1. glm-5.3 输出未通过合同（invalid_json）。"))
      .toBe("视觉审片的候选模型都没能给出可用结果。");
    expect(creatorFacingTechnicalText("前 1 个候选模型调用失败，已自动切换到 glm-5.3-flash。"))
      .toBe("已自动换用下一个可用模型。");
  });

  it("translates persisted worker provenance into clear Chinese", () => {
    expect(creatorFacingTechnicalText("从未完成任务恢复：Pexels free stock license; review current provider license before publishing."))
      .toBe("从未完成任务恢复：Pexels 免费图库素材；发布前需核对当前授权条款。");
    expect(creatorFacingTechnicalText("从未完成任务恢复：Pixabay Content License; cache API responses for 24h and avoid systematic mass downloads."))
      .toBe("从未完成任务恢复：Pixabay 内容许可；接口结果最多缓存 24 小时，禁止系统性批量下载。");
    expect(creatorFacingTechnicalText("Human-selected media retained with immutable bytes and run-local provenance."))
      .toBe("保留人工选中的原始素材，并记录本次制作中的来源信息。");
    expect(creatorFacingTechnicalText("Human-edited derivative retained as an immutable revision."))
      .toBe("保留人工编辑后的素材版本，便于追溯修改记录。");
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
