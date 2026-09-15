# 缺陷 Q：素材试片审查是单模型，成片审片是双模型——双审的检测优势无法在最便宜的阶段生效

发现于 R11 续轮（`run-f8e2635f-…`）。这是本轮最有价值的产品发现：它把缺陷 O、缺陷 P 串成一条根因链。

## 现象：同一镜头，两个阶段判定相反

| 阶段 | 模型 | 对 scene4 蒸汽的判定 |
|---|---|---|
| 素材试片审查 `asset-source-review` | **`zai-bigmodel-api` / `glm-5.3-flash`（单模型）** | `info / satisfied / none`：「杯口细薄蒸汽在 9875–11625ms **持续上升且形态逐帧变化**，侧后方暖光勾出**可辨轮廓**，**蒸汽亮边兑现成立**」→ 报告 `recommendation: approve` |
| 成片审片 `visual-review` 分支 1 | `zai-bigmodel-api` / `glm-5.3-flash` | `info / satisfied / none`（与素材阶段一致，failed **0** 条） |
| 成片审片 `visual-review` 分支 2 | **`openai` / `gpt-5.6-sol`** | `warning / failed / rework_asset`：「杯体清楚，但**蒸汽轮廓极弱**，未形成旁白和成功条件要求的**清晰暖色亮边**，核心观察对象被背景虚化吞没」 |

合并后的报告取并集：`recommendation: revise`，`failed 1`。**操作员抽帧亲看支持 gpt 一方**（见下）。

## 代码级根因：`source_assets` 阶段显式退化为单模型

`packages/production-pipeline/src/codex-visual-review.ts:332-335`：

```ts
async reviewDetailed(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
  if (input.reviewStage === "source_assets") {
    return runVisualReviewAgent(this.options.sourceAgent ?? this.options.primary, input);
  }
  // …只有 rendered_video 才走 Promise.allSettled([primary, secondary]) 的双模型分支…
}
```

`sourceAgent` 指向谁，由装配顺序决定（`apps/studio/src/server/role-agent-assembly.ts:151-183`）：

```ts
return [
  new IndependentDualVisualReviewAgent({ primary: glm,  secondary: codex, sourceAgent: glmWithSourceFallback,  media }),
  new IndependentDualVisualReviewAgent({ primary: codex, secondary: glm,  sourceAgent: codexWithSourceFallback, media }),
];
```

`IndependentDualVisualReviewAgent.id = options.primary.id`，而 `SourceAssetPilotReviewer.agent(providerId)`（`asset-pilot-review.ts:43-47`）只 `find` **一个** agent。本 run 的 `providers.visualReview = "glm-visual-review-v1"`，命中数组第 0 项 → 素材审查走 **glm**。

`asset-pilot-review.ts:88-91` 的 `actualModels` 被硬编码为**单元素数组**，与 `source_visual_review.json` 的实测一致（`actualModels.length === 1`）。**这是设计，不是 bug**——但它意味着：

> 素材试片审查用哪个模型，取决于 `providers.visualReview` 命中装配数组的哪一项，**而不是任何质量考虑**。本 run 恰好落在 glm——也就是两个模型里判 `satisfied` 的那一个。

## 抽帧核实（操作员亲看，非采信任何报告）

源素材 `scene_04_pexels_7577435.mp4`（1080×1920，2.5s，时间线起点 9.5s）四帧：`frames/scene4-source-4-frames.png`（t=0.0 / 1.1 / 2.1 / 2.4s）。

| 时点（源 / 时间线） | 蒸汽 | 暖色亮边 |
|---|---|---|
| 0.0s / 9.5s | 杯口左上方有**一条清晰白色蒸汽丝**斜向上 | 无（亮边在**杯口边缘**与杯身高光上） |
| 1.1s / 10.6s | **几乎不可见** | 同上 |
| 2.1s / 11.6s | **几乎不可见** | 同上 |
| 2.4s / 11.9s | 杯口上方有**一条明显白色蒸汽丝**斜向右上 | 同上 |

源素材与成片同刻对比（`frames/scene4-source-vs-final.png`）：**除字幕外画面完全一致**——渲染没有劣化，问题是素材固有的。

三点事实：

1. **蒸汽确实存在且形态变化**（glm 对了一半）：0.0s 与 2.4s 可见细丝，中间时段几乎不可见。
2. **"持续上升"不成立**（glm 错了一半）：四个采样点里有两帧几乎看不到蒸汽。
3. **字幕承诺"蒸汽有了亮边"在四帧中均不成立**（gpt 对）：蒸汽是**白色**的，画面里的暖色亮边落在**杯口边缘与杯身高光**上，不在蒸汽上。这是**文案过度承诺**，不是画面缺陷。

## 后果（三条，均为结构性）

1. **检测能力与修复成本倒挂**：双模型只在成片阶段生效，而此时唯一可用的返修工具是「用更早的镜头替换」（缺陷 P），**无法修复**该缺陷；而在素材阶段修（重选图库素材 / 改单镜文案）成本为 ¥0。
2. **判定分歧没有仲裁与呈现**：两个真实模型给出相反结论时，产品取并集（保守、正确），但**不向操作员暴露"这是分歧项"**——操作员只看到"revise + 一条 warning"，无从知道另一半模型判它合格、也无从知道分歧的原因。
3. **同一模型跨阶段不一致**：glm 在素材阶段审**源素材**判 `satisfied`、在成片阶段审**成片**也判 `satisfied`（自洽），而 gpt 只被允许在成片阶段发言。等于**是否引入第二个模型，决定了这个缺陷能否被发现**。

## 建议方向（未实施，待裁决）

- **I**：素材试片审查同样走双模型（复用已有的 `IndependentDualVisualReviewAgent`，仅需去掉 `source_assets` 的单模型退化，或为素材阶段单独装配双审）。代价：素材阶段多一次订阅调用（¥0 现金，属 subscription）。
- **II**：保留单模型以控成本，但在成片审片发现 `failed` 且该镜在素材阶段为 `satisfied` 时，**显式标注这是一条跨阶段分歧项**，并解释分歧来源。
- **III**：不动审查装配，改为给"文案与画面不符"提供零成本修法（改单镜字幕措辞），见缺陷 P 的修法 a2。

三者不互斥。本记录**不预判采用哪一条**：涉及成本、审查强度与产品行为边界，属用户决策。

## 与缺陷 O / P 的关系

- 缺陷 Q 是**上游**：素材阶段本可零成本发现/廉价修复的机会被单模型漏掉。
- 缺陷 P 是**下游**：缺陷流到成片阶段后，返修面无法修复它自己指出的问题。
- 缺陷 O 是**同一区段**的另一个已修缺陷（试片闸门死锁），与本条无因果，但同在 `assets`/`asset-source-review` 区间。
