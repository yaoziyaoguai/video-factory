# Frame Agent v1 接口索引

工作台 API 前缀是 `/api/agent/v1`。当前契约修订 **0.1.61**；HTTP 操作以 [OpenAPI](openapi.json) 为准，HTTP、SSE、Pi 工具和领域对象的结构以 [JSON Schema](contracts.schema.json) 为准。

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

0.1.44 增加显式继续按钮的 `ReviewContext.intent=continue`：同一作品/组已有排队或运行中的继续请求时返回原回执，普通文字指令不合并；准确的 `approve_and_continue` 同样防重。SSE 增加暂态 `request.progress`（实际步骤、更新时间），`TextDelta.replace` 标明新的答复替换先前流式答复。不新增数据库迁移。

0.1.43 将确认动作区分为原作品项确认、独立文稿认可（`StandaloneArtifactConfirmation`）与预览采用定稿（`AdoptPreviewConfirmation`）。消息保留原始 `reviewConfirmation`，`start_work.adoptContent` 可采用已有文稿，`CreationBinding.adoptedFrom` 保留同字节采用的来源。纯本地制作沿 `render_project`，作品库可选择准确 `run_input` 原始素材；本地错误保留有界执行输出。具体语义见 [行为约定](agreement.md)。内部 migration23/24 保存确认事实及准确操作产出关联，不新增公共 HTTP 路由。

0.1.42 付费制作意图与快照增加可选 nullable `outputTarget`（`ReviewTarget`）：新的最终视频提案必须显式声明交付到的组/事项，受理时冻结为 `frozen_target_json`；消息增加可选 nullable `reviewContext`（`ReviewContext { workId, groupId }`）表达本条消息指向的创作与审阅组，与 `reviewConfirmation`/`proposalRef`/artifact `target` 互斥。仅新增 `messages.review_context_json` 一列。

0.1.41 修正 `ToolDubFree.rate` 为完整匹配，与 `DubbedSpeechMeta.rate` 一致：`+0%`、`+10%`、`-10%` 保持合法，`+10%extra` 在工具入口拒绝；不新增字段或 migration。

新回合使用 `confirm_review`、`publish_project`、`render_project`。`ToolConfirmStage` 等旧类型仅用于历史读取，工具映射不注册旧确认名；`LegacyProductionSpec` 保留无 type 的历史快照原形，`PaidProductionSnapshot` 允许提案回看旧快照，新的 `ProductionSpec` 必须有 `type=paid_production`。`LegacyMessageInput`、`LegacyToolDelivery`、`LegacyPrepareProposal` 等固定样例只检验历史可读性，不是新 HTTP/工具入口的兼容分支。

`examples.json` 使用外部 JSON 形状覆盖精确单项确认、局部试做、工程三种媒体、本地无财务、源文件/素材复用与拒绝案例。`consumer-example.ts` 同时检验消费方静态类型。离线检查不等于真实 provider、迁移、隔离执行或端到端验收；这些证据由对应实现测试提供。

0.1.45：`RequestProgress` 可选携带经同会话归属核对的 `workId` 和最多八条真实 `steps`。`RequestProgressStep` 只包含步骤 ID、受控标签、running/completed/failed、时间与可选作品归属，不含原始参数或工具输出。重连回放沿用原暂态帧，不制造历史持久事件。

0.1.47：Message.execution 可选携带原始用户请求的持久执行记录（开始/结束时间及最新 RequestProgress，最多八个实际工具步骤）。旧消息没有记录时为空，不回填推测步骤。SSE仍是无游标暂态流；终态消息的正常版本事件携带记录，不追加每步业务事件。

0.1.48 在业务事务内保留修订创建与用户消息的先后次序。作品库选材和免费配音完成后发送现有的 `artifact.delivered`。事件历史裁剪后仍可认可此前的准确稿件。作品库游标可顺序翻完新旧定稿。

0.1.49 的 Blob 读取按归属鉴权。媒体原件支持私有的 24 小时不可变缓存、ETag 和字节范围；`?download=1` 下载原件。工程文件作为附件，脚本按纯文本返回。Blob 路由设置 `nosniff` 和 `default-src 'none'; sandbox`。一次性工程执行只接收本轮选中的输入文件，只读目录为 `/inputs`；原有相对路径仍可使用。

0.1.50 中，Skill 的本地目录在 Pi 安装前核验，远程 Git 通过公共 HTTPS。Skill 可在 frontmatter 的 `metadata.frame.requires` 下提供 `bins` 和 `pythonModules` 字符串列表。工作台分别显示发现状态和实际沙箱的依赖检查结果。工作台登录、登出与业务写入共用已配置的页面 Origin 及 `x-video-factory-request: studio` 校验。登录与登出也校验公开入口的 Host。

0.1.51 中，用户带入的选材列在用户消息下。助手消息只列本轮正式交付或制作输出。已失去运行窗口的 steer 返回 409 REQUEST_NOT_RUNNING，消息、事件与命令回执均不落库。

0.1.52 增加当前用户的空间统计和过期媒体清理命令。定稿、已认可、在用媒体及有效制作输入会保留。已归档修订提供 archivedAt，下载返回 410 MEDIA_ARCHIVED。公开 /api/health 分别报告进程、数据库和创作宿主状态，供应商密钥仅在服务端执行边界解密。

0.1.53 开放 Pi 原生 Anthropic Messages 与 OpenAI 兼容 Chat Completions。连接保存只持久化配置。手动检查才向已保存的目录地址发送认证读取。普通 SSE 事件按实体版本合并，读回失败和断流恢复可重新取得快照。

0.1.54 的四种内置合成支持逐段画幅适配与静帧运动。准备阶段可省略成对宽高，按视觉来源继承，受理快照保存实际规格。工程文件可分段读取与单独下载；批次内视频的预览须验证所有者且不登记采用。

0.1.55 上传命令以文件摘要和版本核对重放。素材修订保存探测事实与用户权利声明，图片可通过 Pi 原生图片输入随消息提交。视频生成按槽位冻结首尾帧或有序参考图。

视频操作单独支持 31 个输入槽。Seedance 2.5 参考图最多 30 张，首尾帧采用首帧画幅，MiniMax H3 参考图最多 9 张，万相 3.0 最多 10 张。

0.1.56 新增基于来源边界的字幕审阅、导出与同一审阅事项的零费用本地微调。

0.1.57 新增冻结工程与非编时间线 ZIP、团队账号与预算，实际用量和逐笔对账事实。跨账号的作品库游标、来源视频和导出均返回 404 NOT_FOUND。

0.1.58 新增成员启停、角色调整与密码重置。成员列表修订递增，修改携带原修订与命令 ID。停用、重置密码或更换角色使该成员的旧登录失效。创作者通过 `GET /profile/budget` 读取个人和共享空间的预算用量，可附带自己的会话 ID。预算日、月按工作空间时区切分，在途预留跨期占用。附件响应包含 `nosniff` 和私有禁缓存头。

0.1.59 新增 `GET /settings/services` 目录快照：一条响应按固定顺序返回全部 15 项免费服务的当前配置，设置页挂载单次读取；单服务读取保留给重试与保存后回读。

0.1.61 新增 `POST /proposals/{proposalId}/rebind`（`RebindProposal`）、`ProposalDefaultsSnapshot`、`ProposalModelLabel`、`OperationSelectionSource` 与 `AcceptanceBlocker` 的 `MODEL_SELECTION_REQUIRED` 分支，`ModelEntry` 可选携带连接别名、音色清单、计费口径与能力摘要。
