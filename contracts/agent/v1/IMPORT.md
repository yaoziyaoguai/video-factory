# Frame Agent v1 接口索引

工作台 API 前缀是 `/api/agent/v1`。当前契约修订 **0.1.42**；HTTP 操作以 [OpenAPI](openapi.json) 为准，HTTP、SSE、Pi 工具和领域对象的结构以 [JSON Schema](contracts.schema.json) 为准。

| 文件 | 用途 |
| --- | --- |
| [agreement.md](agreement.md) | 请求、交付、授权、快照与事件的语义 |
| [openapi.json](openapi.json) | 各路由的方法、参数、状态码与响应引用 |
| [contracts.schema.json](contracts.schema.json) | 领域对象、命令、错误与工具输入输出 |
| [examples.json](examples.json) | 合法与拒绝的固定示例（合成数据） |
| [consumer-example.ts](consumer-example.ts) | 使用派生类型的示例 |
| [ports.ts](../../../apps/studio/src/shared/agent/ports.ts) | TypeScript 端口与调用边界 |

在**仓库根目录**运行 `npm run contracts:check`。改动 Schema 后运行 `npm run contracts:generate`，提交权威文件和 [派生类型及运行时 Schema](../../../apps/studio/src/shared/agent/generated/)；不要直接编辑生成文件。检查是离线的，不验证真实供应商的帐号或计费。

日常操作先读 `GET /bootstrap`，再读取会话快照。设置、素材、作品库和制作记录各有独立操作，订阅则使用会话的 `/events`。登录走 `/api/auth/session` 和 `/api/auth/login`；部署探针走 `/api/health`，不属于此业务协议。

本次跨边界类型均从同一个 Schema 派生：

| 边界 | 导出类型与含义 |
| --- | --- |
| 审阅事实 | `Work`、`ReviewGroup`、`ReviewItem`、`ReviewConfirmation`；新写入不再携带 stage/stages |
| 来源绑定 | `CreationBinding`、`ReviewInput`、`ReviewInputInput`、`CreationPurpose`；实际输入与必要认可分开 |
| 交付与目标 | `ToolDelivery`、`LocalOutputInput`、`ReviewGroupTarget`、`ReviewItemTarget`、`ReviewTarget`、`FrozenReviewTarget`；同次分配新身份 |
| 工程工具 | `CreativeProjectContent`、`ProjectFile`、`ToolPublishProject`、`CodeProjectParameters`、`ToolRenderProject`、`LocalCreationReceipt` |
| 运行与快照 | `RunOrigin`、`ProductionSpec`、`LocalCreationSpec`、`ExecutionSnapshotSpec`、`StoredExecutionSnapshot`、`ExecutionInput`；本地财务为 null |
| 作品库引用 | `LibraryVideo`、`LibraryMaterial`、`LibrarySelection`、`LibrarySelectionSource`；Message 持久回传准确选材 |
| 可操作状态 | `SkillPackage.runtimeStatus/runtimeMissing`、`Proposal.acceptanceBlocker` 与 `AcceptanceBlocker` |
| 免费配音 | `ToolDubFree`、`DubFreeResult`、`DubbedSpeechMeta`、`SpeechBoundary`；准确音频修订保存原文、生成参数与源时间边界 |

0.1.42 付费制作意图与快照增加可选 nullable `outputTarget`（`ReviewTarget`）：新的最终视频提案必须显式声明交付到的组/事项，受理时冻结为 `frozen_target_json`；消息增加可选 nullable `reviewContext`（`ReviewContext { workId, groupId }`）表达本条消息指向的创作与审阅组，与 `reviewConfirmation`/`proposalRef`/artifact `target` 互斥。仅新增 `messages.review_context_json` 一列。

0.1.41 修正 `ToolDubFree.rate` 为完整匹配，与 `DubbedSpeechMeta.rate` 一致：`+0%`、`+10%`、`-10%` 保持合法，`+10%extra` 在工具入口拒绝；不新增字段或 migration。

新回合使用 `confirm_review`、`publish_project`、`render_project`。`ToolConfirmStage` 等旧类型仅用于历史读取，工具映射不注册旧确认名；`LegacyProductionSpec` 保留无 type 的历史快照原形，`PaidProductionSnapshot` 允许提案回看旧快照，新的 `ProductionSpec` 必须有 `type=paid_production`。`LegacyMessageInput`、`LegacyToolDelivery`、`LegacyPrepareProposal` 等固定样例只检验历史可读性，不是新 HTTP/工具入口的兼容分支。

`examples.json` 使用外部 JSON 形状覆盖精确单项确认、局部试做、工程三种媒体、本地无财务、源文件/素材复用与拒绝案例。`consumer-example.ts` 同时检验消费方静态类型。离线检查不等于真实 provider、迁移、隔离执行或端到端验收；这些证据由对应实现测试提供。
