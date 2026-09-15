# 返工购买前的费用与暴露复核（真实账本读数）

时间：2026-09-14 22:2x（本地）。来源：`/api/costs` 与 `/api/runs/:runId/costs`，经本地会话只读拉取；原始输出见同目录 `pre-rework-exposure.log`、`global-exposure.log`。

## 全工作区总量

| 指标 | 值 |
| --- | --- |
| `estimatedCostCny` | 36.5 |
| `authorizedCostCny` | 36.5 |
| `actualCostCny`（已确认现金） | **13.5** |
| `actualPendingCount`（未结清） | **2** |
| `meteredCalls` | 3 |
| `subscriptionCalls` | 74 |
| `freeCalls` | 8 |
| `failedMeteredCalls` | 0 |

按 Provider 聚合：`hailuo-video-v1` calls 3 / est 20 / actual 13.5 / pending 0；`seedance-video-v1` calls 0 / est 16.5 / actual 0 / **pending 2**。

**修正**：接管前记录的"在途 1 笔"不准确。逐 run 扫描后确认是 **2 笔**未结清回执，两笔都是 `seedance-video-v1`、`status: failed`、`estimatedCostCny 5`、`actualPending: true`：

| 回执 id | runId | 开始时间 | 结束时间 | 说明 |
| --- | --- | --- | --- | --- |
| `assets:2026-09-14T10:16:51.214Z:16` | `run-a7c42cc4…`（本轮主片） | 10:16:51.214Z | 10:16:51.801Z | 接管轮之前即已存在 |
| `assets:2026-09-14T07:17:02.437Z:23` | `run-25b4c195…`（同题更早的 run） | 07:17:02.437Z | 07:17:02.485Z | 早于接管轮，历史遗留 |

两笔都在 1 秒内失败（0.587s / 0.048s），即**在供应商边界就失败**，实际是否计费未知，故账本按"未结清"保留。按约束"不删除历史、不清理未知任务"，本轮**不动**这两笔，仅计入暴露。

## 暴露与预算判断

- 已确认现金：**¥13.50**
- 未结清（est，每笔 ¥5）：**最多 ¥10**，共 2 笔，均为历史遗留、非本轮新增
- 最坏情形暴露：**¥23.50**
- 本轮拟批准的返工报价：预计 **¥5.50**（重生成 1 条母片；场 5 按审片建议只调看、不新购）
- 计入后：已确认现金 ¥19.00；最坏情形 **¥29.00**，仍在累计 **¥50** 授权内

## 在途任务

购买前用只读方式确认两个 broker 均无在途：`openai` `active 0 / queued 0`，`zai` `active 0 / queued 0 / failed 0`。studio `/api/health` 正常（python / ffmpeg / ffprobe / say 均 true）。

## 结论

可以按"预算内、报价合理"自行确认本次返工；超过预算才需回问。本次不触碰两笔历史未结清回执。
