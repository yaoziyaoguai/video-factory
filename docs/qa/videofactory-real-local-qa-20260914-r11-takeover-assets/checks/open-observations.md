# 本轮记录的低优先级观察（非阻断，未改代码）

## OBS-1 `requiredAffectedScenePositions` 字段名比 UI 语义窄

`GET /api/runs/:runId/rework-draft` 返回 `requiredAffectedScenePositions: [1,2,3,4]`，而"调整方案后重新制作"对话框把第 5 镜也标为"必改"且不可移除。

核对 `NewRunDialog.tsx:1493 requiredScenePositionsForRework`：UI 的必改集合 = `requiredAffectedScenePositions` ∪ **所有 `targetNodeIds` 含 `visual-direction` 或 `assets` 且场次合法的 findings**。第 5 镜的 finding 是 `{"scene":5,"next":"inspect_existing_media","targets":["assets"]}`，故必改。

**判断**：行为正确且与对话框规则一致（该镜必须进入本轮，好让画面素材步骤去补查已有素材），只是字段名只覆盖了"必须重新生成"的那部分。属命名与语义不齐，建议改名或补一个更宽的字段；**不是缺陷**，不影响报价与复用判断。

## OBS-2 导演方案与所携带指令不一致：场5被安排重新生成

返工 run 的第一版重规划里，场 5 被安排 `deliveryType: generated_video`、`preferredProviderId: hailuo-video-v1`、`estimatedCostCny: 2`（即**重新生成一条新母片**），而随返工带入的画面素材指令原文是：

> 镜头 5 · 00:23.062：…下一步：先补查已有素材，不进入新购买；建议：先调看该镜头源4.5秒至结尾的完整片段核实倒影移动；确认缺失后再决定是否更换素材，不要据此直接重买。

同时上一版场5母片已物化，交接文件明确"不得重复购买"。

**判断**：这是**方案选择与指令冲突**，由创作确认闸门拦下（`phase: waiting_user`，`allowedActions` 含 `discuss`），已通过产品自带讨论通道就"只改场5"提出一次有据的修改要求并要求保持场1至场4不变。是否把它算作产品缺陷取决于"导演是否必须无条件服从 findings 的 nextAction 文案"这一设计预期；本轮按"闸门按设计工作、由操作者纠正"记录，**未改代码**，待重规划结果出来再评估是否需要产品侧加固（例如对 `inspect_existing_media` 的镜头默认禁止新建购买线路）。

---

## OBS-1 / OBS-2 的后续结论（23:0x 更新，推翻 OBS-1 的判断，采纳 OBS-2 的加固建议）

两处观察在部署前的桌面复验里被证实是**同一条客户端缺陷**，OBS-1 的"行为正确、不是缺陷"结论不成立：

- 服务端 `recommendedReworkScenePositions`（`apps/studio/src/server/production-studio.ts:3833`）与执行层两处投影（`generative-asset-worker.ts:1305`、`production-pipeline.ts:3413`）都对 `action === "inspect_existing_media"` 的 finding 显式跳过；只有客户端 `NewRunDialog.tsx` 的 `defaultReworkScenePositions`（预选）和 `requiredScenePositionsForRework`（必改）没有跳过。所以服务端给的 `[1,2,3,4]` 才是权威值，UI 扩到 `[1,2,3,4,5]` 是缺陷，而不是"字段名比 UI 语义窄"。
- 后果不是命名问题而是可执行的合同矛盾：场 5 进入 `affectedScenePositions` 后，宿主不再逐字继承上一版母片（`codex-visual-director.ts:369` 的合并语义），模型被要求"重做场5"同时被要求"先补查已有素材、不进入新购买"，而合同里唯一的既有素材语法 `REUSE_ONLY scene N` 只能指向同一方案中更早的镜头——于是三次连续尝试都编造了 `EXISTING_ASSET_ONLY scene 5`，被独立 check 如实拦下。
- 已按 **OBS-2 建议的方向**加固：inspection-only finding 的镜头不再默认进入重做范围（也不标必改），但操作者仍可手动勾选。RED→GREEN 与线上复验见 `docs/codex-collaboration/RESULT.md` 的"23:0x 更新"一节；只读复验证据 `checks/step-19-rework-scope.json`。

由此新增一条开放观察（非阻断）：

## OBS-3 `source_assets` 阶段的补查要求没有可执行路径

产品只有 `POST /api/runs/:runId/reinspect-visual-review`（`apps/studio/src/server/app.ts:571` → `packages/production-pipeline/src/production-pipeline.ts:3002 dispatchVisualReinspection`），其 `finalVisualReviewScope` 与 evidenceId 都绑定 `visual-review`（成片审片）的 delivery。来自 `asset-source-review` 的 `evidenceStatus: "not_observed" + nextAction: "inspect_existing_media"` finding（本片场 5）**没有**对应的补查入口，只能等素材节点重跑时按既有采样策略再审一次。

本轮按"记录具体原因和证据、继续其他独立可测项"处理：场 5 的 finding 原样保留在返工载荷里，未删除、未降级、未改判为 satisfied；渲染完成后可用成片侧 `reinspect-visual-review` 对同一镜头补看。

---

## OBS-4 制作详情接口不返回计费字段，静默取值会得到"零花费"假象

`GET /api/runs/:id`（制作详情）的响应**不含** `executionReceipts`、`spendAuthorizations`、`consumedSpendAuthorizationIds`——磁盘 `run.json` 里有这三个字段，接口不投影它们。计费的权威接口是另一个：`GET /api/runs/:id/costs`（`apps/studio/src/server/app.ts:505`）。

**后果不是理论上的**：本轮 harness 有四个步骤从详情响应里取 `executionReceipts`/`spendAuthorizations`，全部**静默**得到空值并打印成"0 笔 / ¥0.00"或"[]"：

| 证据文件 | 假读数 | 真实情况 |
|---|---|---|
| `checks/step-r10-retry-assets.txt` | `metered 回执 0 笔 ¥0.00` | 当时 assets 已有 1 笔 ¥2 |
| `checks/step-r12-reinspect.txt` | `metered 合计 ¥0.00（增量 ¥0.00）` | 实为 ¥17，未变 |
| `checks/step-18b-confirm-rework.log` | `spendAuthorizations === []` | 字段缺失，非"无授权" |
| `checks/step-21*.log`（两处） | 同上 | 同上 |

空值被当成"没有花钱"与"没有授权"来读，而这恰是预算纪律最不能出错的两个结论。**这是接口易用性陷阱，不是计费逻辑错误**——官方端点数据正确，且与磁盘交叉核对完全一致（`harness/step-r12d-cost-endpoint.mjs`：两侧均 ¥17 / 2 笔 metered / 2 笔授权）。

建议方向（未实施）：详情接口要么投影计费摘要，要么让 `costs` 成为文档中唯一指明的计费入口；客户端与测试不应从详情响应里推断费用。本轮已修 harness 的四处取数（改为磁盘 `run.json` 或官方 `costs` 端点），并在四份证据文件内**保留原读数、就地追加更正标注**，未删除任何历史记录。

## OBS-5 成本明细里的历史 metered 行状态显示为 `unknown`

`GET /api/runs/:id/costs` 的两条 metered 行中，第一行 `status=unknown`，而该笔实际结局是 `rejected`（见 `run.json → executionReceipts[0].status`）。第二行正确显示 `succeeded`。

对"花了多少钱"没有影响（`actualCostCny` 与 `totals` 均正确），只影响明细行可读性。低优先级，未追查 `cost-studio.ts` 的状态投影分支。
