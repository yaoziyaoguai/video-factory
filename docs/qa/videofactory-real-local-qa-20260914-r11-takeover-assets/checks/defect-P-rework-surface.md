# 缺陷 P（暂定，待用户裁决）：已确认素材缺陷的返修面无法修复它自己指出的缺陷

发现于 R11 续轮成片终审（`run-f8e2635f-…`，revision 11 `needs_human`）。

## 现象

双模型复审给出**唯一一条实质缺陷**（其余 17 条为 info 级）：

```
scene4 | severity=warning | evidenceStatus=failed | nextAction=rework_asset | category=composition
三个采样状态中杯体清楚，但蒸汽轮廓极弱，未形成旁白和成功条件要求的清晰暖色亮边，
核心观察对象被背景虚化吞没。
建议：重剪或替换为侧逆光更明确、连续蒸汽卷曲可辨且无品牌文字的现有素材。
```

宿主确实为它渲染了返修控件（「用已有镜头替换」+「修改说明」+「替换后重新审片」），但候选下拉框只有 **镜头 1 / 镜头 2 / 镜头 3**——三个都是付费生成的镜头，没有一个是蒸汽画面。

## 代码依据

`apps/studio/src/client/components/RunWorkbench.tsx:925-928`：

```ts
const canReplaceAsset = finding.targetNodeId === "assets" && finding.nextAction === "rework_asset";
const sourceOptions = canReplaceAsset && finding.scenePosition
  ? Array.from({ length: Math.max(0, finding.scenePosition - 1) }, (_, index) => index + 1)
  : [];
```

候选集合恒等于 `1 … scenePosition-1`。由此产生三个确定性后果：

1. **候选只允许"复制一条更早的镜头"**，且只换画面、不改字幕/旁白（`requestSceneRevision` 只改 asset plan；`reviseAssetPlanByReuse` 的产物来源标注为 `"Creator-requested reuse of an existing run asset; no new Provider call was made."`）。因此对 scene4 而言，任何可选替换都会让字幕"蒸汽有了亮边"与画面直接矛盾——**一个缺陷换成两个缺陷**。选镜头 3（水面暖光）还会与 scene3 连续两镜同景。
2. **对素材来自免费图库的镜头，产品不提供"另选一条同源素材"的路径。** scene4 是 `pexels 7577435`、scene5 是 `pexels 6666665`；这类镜头缺陷的正确零成本修法是重新挑选图库素材，而返修面根本不暴露该能力。
3. **scene1 永远无法返修**：`scenePosition - 1 = 0`，`sourceOptions` 恒为空数组，控件整块不渲染（`RunWorkbench.tsx:938` 的 `sourceOptions.length > 0` 守卫）。

## 与相邻设计的自相矛盾

同一文件 `RunWorkbench.tsx:937` 对 `replan_upstream` 类缺陷明确写着：

> 这项问题需要先调整脚本/导演方案，**不能用任意旧素材替代。**

即设计者已知道"任意旧素材替代"在某些情形下是错的；但 `rework_asset` 类缺陷的**唯一**通道恰恰就是它。

## 定性：产品缺陷，不是模型输出错误

- 审片员给出的 `rework_asset` 是**证据合同强制**的取值（`assertFindingEvidenceContract`：`failed` → severity ≠ info 且 nextAction ∈ {replan_upstream, rework_asset}）。模型没有越界。
- 缺陷本身经操作员独立看片确认属实（09-15 抽帧：10.6s / 11.6s 蒸汽几乎不可见，暖色亮边落在杯口而非蒸汽）。
- 因此矛盾不在提示词与验证契约之间，而在**宿主向操作员暴露的返修能力**与**它自己产出的返修建议**之间。

## 当前操作员处境（三条路都有代价）

| 可选动作 | 后果 |
|---|---|
| 替换后重新审片 | 画面与字幕矛盾，scene3/scene4 同景 |
| 补查现有成片 | 契约明确只重审当前成片；面板自述"已确认缺陷才进入调整方案"，不修已确认缺陷 |
| 仍要批准（说明理由） | 覆盖审片建议 → 等于降低质量门槛 |
| 修改后再审 | 同样落在 `requestSceneRevision` 上，受同一候选集约束 |

## 待用户裁决的形状（不擅自实施）

可能的修法（未实施、未获批准）：

- `a`：候选集扩展——对素材来自图库的镜头，允许"从同一图库重新挑选并复用"（零成本，但需要 assets 侧支持单镜重选）。
- `b`：为 `assets` 类缺陷开放 `replan_upstream` 建议位，允许把"文案承诺了图库难以稳定交付的具体画面"上溯到脚本调整。
- `c`：仅在返修面显式提示"当前候选无法满足该建议"，避免操作员误以为替换可行。

本记录不预判采用哪一条；它涉及产品行为与返修能力边界，属用户决策。

## 补正（抽帧核实后，2026-09-15 02:1x）

后续抽帧（`frames/scene4-source-4-frames.png`、`frames/scene4-source-vs-final.png`）把这条缺陷的性质钉得更准：

- 源素材与成片同刻画面**除字幕外完全一致** → 渲染没有劣化，问题在素材本身。
- 蒸汽**确实存在但间歇可见**：源素材 0.0s 与 2.4s 有清晰白色蒸汽丝，1.1s 与 2.1s 几乎不可见。
- 画面里的**暖色亮边落在杯口边缘与杯身高光上，不在蒸汽上**；蒸汽本身是白色的。
- 因此字幕「**蒸汽有了亮边**」是**文案过度承诺**——四帧中没有任何一帧成立。**画面本身可看**（杯体清楚、无品牌、无文字、构图成立）。

这改变了"最便宜的修法是什么"：

| 修法 | 成本 | 产品是否支持 |
|---|---|---|
| **a2：改该镜字幕措辞**（如"杯口升起细弱的白汽"） | **¥0** | **不支持**——`requestSceneRevision` 只改 asset plan，不改脚本/字幕；返修面没有"改单镜文案"的入口 |
| a1：重选同源图库素材（同一 `query` 已在 `asset_plan.json` 中保存） | ¥0（Pexels 免费） | **不支持**——返修面只暴露"复用更早镜头" |
| 替换为更早镜头（现有唯一通道） | ¥0 | 支持，但会让字幕与画面矛盾、scene3/scene4 同景（本记录开头已论证） |
| 重新生成该镜 | 付费 | 支持（需新授权），但审片员建议里并未要求重生成 |

即：**画面基本合格、文案过度承诺**这一类缺陷，产品给出的唯一出口是"换掉一个本来合格的画面"。这与 `RunWorkbench.tsx:937` 对 `replan_upstream` 的提示（"不能用任意旧素材替代"）同源——设计者知道旧素材替代不总是对的，却没有为这类缺陷留出"改文案"的路。

**修法清单据此更新为 a1 / a2 / b / c**，其中 **a2 是最贴合本案的零成本正解**。仍未实施，属用户决策。

## 关联：缺陷 Q

同一条 scene4 缺陷在上游还有一次被廉价发现的机会（素材试片审查），但该阶段是单模型且恰好用了判 `satisfied` 的那个模型——见 `defect-Q-source-review-single-model.md`。两条缺陷合起来才是完整根因链：**上游漏检 → 下游才发现 → 下游无低成本修法**。
