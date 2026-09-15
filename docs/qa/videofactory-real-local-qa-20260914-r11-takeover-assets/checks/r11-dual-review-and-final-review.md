# R11 续轮：双模型同片复审验收证据 + 成片终审操作员记录

run：`run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08`
记录时间：2026-09-14T17:58–18:12Z（本地 09-15 01:58–02:12）

## 1. 主线推进结果（真实付费路径）

| 节点 | 结果 |
|---|---|
| brief | succeeded |
| creative-planning | succeeded |
| assets | succeeded（4 个付费镜头全部 materialized） |
| asset-source-review | succeeded |
| voice | succeeded（7 镜 + narration，free/macos-say） |
| render | succeeded（final.mp4） |
| technical-review | succeeded |
| **visual-review** | **succeeded（双模型同片复审）** |
| final-review | needs_human → 操作员补查后 rev 12 running |

成片规格（`nodes/render/attempt-1/renders/1/final.mp4`）：

```
codec h264 / 1080x1920 / 30fps / duration 24.000000 / 7,231,304 bytes / 含 aac 音轨
```

## 2. 验收标准：同片由两个不同真实视觉模型复审

**权威证据** —— `nodes/visual-review/attempt-1/visual_review.json` → `reviewScope.actualModels`：

| providerId | modelId | evidenceId | producerContractDigest | producer | audit |
|---|---|---|---|---|---|
| `zai-bigmodel-api` | `glm-5.3-flash` | `b919323236ccd69ea1b4956023f03744f911a406fcd846f2da0e53ae0471928f` | `81f76a8f…97f997` | true | true |
| `openai` | `gpt-5.6-sol` | `b919323236ccd69ea1b4956023f03744f911a406fcd846f2da0e53ae0471928f` | `81f76a8f…97f997` | true | true |

判定要点：

- 两项的 `providerId` 与 `modelId` **两两不同** → 是两个不同真实模型。
- 两项 `evidenceId` **完全相同** → 复审的是同一份成片证据，而非各审各的。
- 两项 `producerContractDigest` / `auditContractDigest` 相同且 `producerCompleted`/`auditCompleted` 均为 true。
- `independentReviews.length === 2`。

**旁证**：

- 该节点下同时存在两个并行的 `视觉审片员` agent loop 检查点，分别只含 `zai-bigmodel-api`/`glm-5.3-flash` 与 `openai`/`gpt-5.6-sol`。
- 产物 `agent_loop_trace-1.json`（269,831 B）与 `agent_loop_trace-2.json`（193,018 B）为两条独立轨迹。
- 操作员界面显示 **「成片双审：2/2 已完成」**。
- 两个 broker `/health` 均在 `taskKinds` 中声明 `visual-review`：openai → `gpt-5.6-sol`，zai → `glm-5.3-flash`。
- `assertProductionVisualReviewReady` 在 `dispatch()` 内、建 run 之前断言 `mode==="dual"`、`reviewers.length===2`、providerId/modelId 去重后各为 2——**fail-closed**，不双模型即抛错，不会静默降级为单模型。
  - 实现：`packages/production-pipeline/src/production-pipeline.ts:9773-9794`，调用点 `:659`（建 run 之前），且额外要求两名审片员的 `independentRoleAudit === true`。
  - **有测试保护**：`packages/production-pipeline/test/production-pipeline.test.ts:1553`「rejects formal production before any worker runs when dual visual review is incomplete」（断言在任何 worker 启动前就抛错）与 `:1590`「requires complete current dual-review proof before final publication」（发布前仍要求**当前**双审证明，`two distinct actual visual-review providers and models`）。

**结论：用户第 5 条要求的"同片由两个不同真实视觉模型复审"已完成，且有磁盘可核验证据。**

## 3. 复审结论（实质否决，非咨询项）

原始报告：`recommendation: revise`，`scores {composition:82, continuity:74, pacing:72, legibility:86, safety:92}`（min 72），`confidence: 0.73`，findings 18 条。

| 维度 | 分布 |
|---|---|
| severity | info 17 / **warning 1** |
| evidenceStatus | satisfied 12 / not_observed 5 / **failed 1** |
| nextAction | none 12 / inspect_existing_media 5 / **rework_asset 1** |

唯一实质缺陷（scene4）：`warning | failed | rework_asset | composition`
> 三个采样状态中杯体清楚，但蒸汽轮廓极弱，未形成旁白和成功条件要求的清晰暖色亮边，核心观察对象被背景虚化吞没。

5 条 `not_observed` 咨询项：scene2 按键金属暖光节拍、scene5 叶影连续摇曳等，报告明确写"不据此重购或重生成"。

## 4. 操作员亲眼看片核对（抽帧，非采信报告）

抽帧自 `final.mp4`：t=1.5 / 5.0 / 8.5 / 9.9 / 10.6 / 11.6 / 13.0 / 16.0 / 21.0 s。

- **scene4 缺陷属实**：9.9s 蒸汽仅一线微光，10.6s 与 11.6s 几乎不可见；画面中真正的暖色亮边在**杯口**而非**蒸汽**，而字幕写"蒸汽有了亮边"。画面与文案实质不符。
- scene1 钩子成立（湿地面暖色反光 + 鞋步掠过），「AI 辅助创作」披露标签可见。
- scene2 表盘无文字无品牌；scene3 水洼暖光与波纹成立；scene5 叶影与墙面光影成立；scene6 同一人物同一树影墙，侧面视角无清晰正脸。
- **scene7 复现成立**：与 scene1 母片同源（同 `asset_key`，不同入点），收束呼应有效。
- 各镜字幕与 renderManifest 文案一致，无裁切。

## 5. 操作员动作：补查现有成片（不重买素材）

| 项 | 点击前 | 点击后 |
|---|---|---|
| `run.status` | `needs_human` | **`running`** |
| `revision` | 11 | **12** |
| metered 收据 | 2 笔，合计 **¥17.00** | 2 笔，合计 **¥17.00** |
| 花钱授权 | 2 笔（均已 consumed） | 2 笔（未变） |
| 最后一笔付费结束 | `2026-09-14T17:24:34.504Z` | 同左（未变） |

补查动作于 `2026-09-14T17:58Z` 前后执行，**晚于本 run 最后一笔付费 34 分钟**；收据笔数、授权笔数与最后一笔付费时刻三项均未变化 → 该动作没有新增任何付费敞口。

> **证据更正（自行发现并修正）**：`step-r12-reinspect.mjs` 早期版本用 `GET /api/runs/:id` 的响应体统计计费，但该响应**不含 `executionReceipts` / `spendAuthorizations`**，于是恒得 ¥0.00 并写成"增量 ¥0.00"——那是"字段不存在"，不是"没有花钱"，**该读数无效**。现已改为从 run 目录的 `run.json` 磁盘文件核算，并新增可复跑的只读核算步骤 `harness/step-r12c-budget-audit.mjs`（产出 `checks/step-r12c-budget-audit.txt` 与 `checks/step-r12-budget-after.json`）。上表数字来自该核算。此外 `step-r12-run-before/after.json` 仍保留，但它们只是 API 响应快照，**不能用于计费判断**。产品另有权威成本入口 `GET /api/runs/:id/costs`（`app.ts:505` → `studio-service.runCostDetail` → `cost-studio.runDetail`），已用它做独立交叉核对：

| 来源 | metered 合计 | metered 笔数 | 花钱授权 | 末次付费 |
|---|---|---|---|---|
| 官方端点 `totals.actualCostCny` | **¥17** | 2 | 2 | — |
| 磁盘 `run.json` 独立核算 | **¥17.00** | 2 | 2 | `2026-09-14T17:24:34.504Z` |

官方 `totals` 全量：`{estimatedCostCny:10, authorizedCostCny:32, actualCostCny:17, actualPendingCount:0, meteredCalls:4, subscriptionCalls:20, freeCalls:4, failedMeteredCalls:0}`。其中 `actualPendingCount:0` 表示**无在途未结算费用**；`authorizedCostCny:32` 是两笔授权上限之和（¥17+¥15）；`meteredCalls:4` 是 `meteredAttemptCount` 之和（1+3）。两侧完全一致 → 计费读数可信。步骤：`harness/step-r12d-cost-endpoint.mjs`（产物 `checks/step-r12d-cost-endpoint.{txt,json}`）。

契约依据 `dispatchVisualReinspection`：要求 run ∈ {needs_human, rejected}、`scope.evidenceId === draft.reviewEvidenceId`、报告存在 `not_observed` + `inspect_existing_media`（本 run 有 5 条，全部满足）；它写入新的审片轮次文件 `visualReinspectionCyclePath` 后 `rerunFromNode("visual-review")`，因此两个模型都会重新独立复审，且不复用上一轮结论。

### 5.1 补查确实开启了新轮次（代码级 + 磁盘级证据）

**代码级** —— `production-pipeline.ts:9064` 与 `:9084-9100`：审片节点在执行前读取 `currentVisualReinspectionCycle(runsRoot, runId)`，把轮次 UUID 拼进检查点契约键：

```ts
const checkpointCycle = await currentVisualReinspectionCycle(runsRoot, context.runId);
// …
agentLoopCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(
  runsRoot, context.runId, "visual-review", request,
  `${VISUAL_REVIEW_AGENT_CONTRACT_VERSION}|cycle:${checkpointCycle}`, modelId, …),
independentReviewCheckpointForModel: (modelId) => nodeAgentLoopCheckpoint(… 同上的契约键 …)
```

`currentVisualReinspectionCycle`（`:11480-11488`）读 `.reinspection-cycle`，文件缺失或格式不合法时回落为 `"initial"`。因此**两类检查点（agent loop 与独立复审结果缓存）的键都随轮次变化**，上一轮 `cycle:initial` 的结论不可能被新一轮命中。

**磁盘级** ——

| 检查点文件 | 时刻 | 类型 | 契约摘要 | 状态 |
|---|---|---|---|---|
| `8ec43393…` | 01:42 | agent-loop-v9 | `a090b0b1…` | passed |
| `ac59e5c8…` | 01:42 | agent-loop-v9 | `862ec5b7…` | passed |
| `5a1e7493…` | 01:58 | independent-review-result-v1（glm-5.3-flash） | — | — |
| `81fa268e…` | 01:58 | independent-review-result-v1（gpt-5.6-sol） | — | — |
| **`adee297b…`** | **02:01** | agent-loop-v9 | `a090b0b1…` | **running** |
| **`cd468078…`** | **02:03** | agent-loop-v9 | `862ec5b7…` | **running** |

- `.reinspection-cycle` = `a975e1a7-be16-4cbd-9090-1edc45015ad8`（新 UUID，非 `initial`）。
- 新一轮落在**两个全新的检查点文件**上（各约 2.6 MB，02:01 / 02:03），与 01:42 的旧文件**并存不覆盖**，旧文件状态仍为 `passed`。
- 两轮 `contractDigest` **相同**（`a090b0b1…` / `862ec5b7…`）——这正确：补查改变的是轮次而非审片契约，规则不应变。轮次隔离由**键**承担，不由摘要承担。
- 两个并行检查点分别对应两个审片员，与第 2 节的单模型结论一致。

**核对标准提醒（避免误判）**：补查只 `rerunFromNode("visual-review")`、**不重渲染**，成片文件不变，因此新一轮的 `reviewScope.evidenceId` 应当**仍是** `b9193232…1928f`——若它变了，反而说明成片被改动，需要追查。区分新旧轮次的依据是 **cycle UUID** 与检查点文件，不是 `evidenceId`。（`reviewScope` 本身不含轮次字段，见 `production-pipeline.ts:9179-9196`。）

`GET /api/runs/:id/rework-draft` 在 `needs_human` 下返回 `409 只有失败、已打回或已完成的制作才能生成新版本草稿。`——与 `reworkDraft` 的状态门一致，属预期，非缺陷。

### 5.2 补查结果（revision 12）：双模型仍然成立，但否决项由 1 条变为 2 条

补查于 `2026-09-14T18:01:39Z` 起跑、`18:11:54Z` 结束（10m15s），产出 `nodes/visual-review/attempt-2/visual_review.json`（32,187 B）。四项核对：

**(a) 双模型验收仍然成立**——`reviewScope.actualModels` 两项 `providerId`/`modelId` 两两不同（`zai-bigmodel-api`/`glm-5.3-flash` 与 `openai`/`gpt-5.6-sol`），两项 `evidenceId` **仍是** `b9193232…1928f`（未变 → 成片未被改动，符合预期），`producerCompleted`/`auditCompleted` 均为 true，`independentReviews.length === 2`。

**(b) 判定结论变化**——

| 项 | attempt-1（rev 11） | attempt-2（rev 12） |
|---|---|---|
| `recommendation` | `revise` | `revise` |
| `confidence` | 0.73 | 0.78 |
| `scores` | 82 / 74 / 72 / 86 / 92 | 82 / **72** / **74** / **92** / **93** |
| findings | 18（glm 9 + gpt 9） | 15（glm 8 + gpt 7） |
| warning / failed | 1 / 1 | **2 / 2** |
| not_observed | 5 | 3 |

唯一否决（镜头 4 蒸汽亮边）**仍在**；**新增**一条否决：镜头 5 树影摇曳（仅 gpt）。

**(c) 咨询项**——5 条减为 3 条（镜头 2 两条保留、镜头 6 一条保留）。减掉的两条都属于镜头 5，且方向相反：glm 判 `satisfied`，gpt 判 `failed`。

**(d) 花费无增量**——metered 仍 2 笔 ¥17.00，授权仍 2 笔，末次付费仍为 `2026-09-14T17:24:34.504Z`（早于补查 37 分钟）；补查、双模型复审全程 ¥0（subscription）。

**新增否决项的依据不成立**：补查的输入与上一轮**逐字节相同**——主审提示词 sha256 前 16 位两轮均为 `66587f99663397c1`（25,708 字符），21 帧逐帧 sha256 与 02:01 重新抽出的帧文件全部一致（attempt-1 引用 13 帧，0 处不符；attempt-2 引用 15 帧，0 处不符）。在此前提下，两个模型各自推翻了自己上一轮的事实陈述（glm：「帧间位置与形态无可辨推进」→「帧间影子位置存在可见变化」；gpt：「影子位置和明暗状态近似」→「近乎一致」）。操作员独立量化（三相位 SSIM_Y = 0.6965 / 0.6958 / 0.5993，场景内相邻 0.25s 帧 SSIM 0.93）与源素材抽帧（相机基本静止、叶片明显转动）都表明**画面确有可见变化，gpt 的事实依据可被否证**。

完整记录见 `defect-R-reinspection-nondeterminism.md`。

## 6. 本段花费核对

| 尝试 | 授权 | 授权上限 | 实付 | metered 次数 | 实际模型 | 结局 |
|---|---|---|---|---|---|---|
| attempt-1 | `spend-authorization-bd6bef3f…` | ¥17 | **¥2** | 1 | MiniMax-H3 | rejected（缺陷 O） |
| attempt-2 | `spend-authorization-b8d76e9d…` | ¥15 | **¥15** | 3 | MiniMax-H3 + doubao-seedance-2-0-mini-260615 | succeeded |

- attempt-2 实付 ¥15 **恰好等于授权上限**，其中不含 scene-3 的 ¥2 → hailuo 未重买。
- 独立佐证：`attempt-1/scene_03_hailuo-video-v1.mp4` 与 `attempt-2/` 同名文件 sha256 均为 `59c7735c6f804a4e8e23995460d979d6c76d1d26730c815c3b595946fec986d5`。
- 本 run metered 累计 **¥17**（¥2 + ¥15），未越过各自授权上限；两笔授权均已 `consumedSpendAuthorizationIds`。
- 补查、双模型复审、配音、渲染、技术质检均为 ¥0（subscription / local_compute / free）。
