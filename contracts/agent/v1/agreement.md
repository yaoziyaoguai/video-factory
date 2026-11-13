# Frame v1 的行为约定

本文件解释 [OpenAPI](openapi.json) 和 [JSON Schema](contracts.schema.json) 的使用语义。当前修订为 **0.1.42**；接口字段、错误码及可选项以这两份机器可读文档为准。Schema 是 HTTP、SSE、工具和执行端口的同一形状来源。

1. **会话、作品和版本分开。** 一个会话可容纳闲聊和多件作品。正式开始作品才建 work；选择素材、索要 Prompt、发布工程都不自动建作品或启动制作。新 Work 只写有序 `reviewGroups`，每组有稳定 item 身份与准确 draft/approved。role 表示用途，媒体类型看 ArtifactHead.kind，不以标题猜类型。
2. **认可精确到单项版本。** ReviewConfirmation 显式列出 group、item 与 ContentSourceInput；不加整组版本锁阻止未变化单项。只提交本次实际认可的项，空 items 不是“继续”。认可不改其他项，也不把新 draft 自动加入确认区；所需当前稿是否已认可从这些事实推导。调整组成员、required 或建议内容要发布用户可见的后继组版本。
3. **认可与继续分别处理。** `approve` 只记录事实；按钮的 `approve_and_continue` 记录后只排一次普通请求。`confirm_review` 从当前真实请求读取认可来源，只记事实，在同回合继续处理用户其余意图。全组已认可后“继续”是普通消息。`finalize_video` 只作用于准确最终视频当前修订并入库；role=clip 的局部预览、普通 approve 均不定稿。模型不能自报 owner/sourceMessageId。
4. **命令与边界。** HTTP 写请求携带工作台安全头和匹配的 Origin。命令按身份与正文重放；幂等冲突沿既有错误语义。消息/工具入口校验外部形状一次，随后内部类型化传递。受理时重新核对真实认可、当前范围、费用和有效期，这是状态/授权边界，不在 route/service/store 重复校验同一形状。
5. **实际输入与认可依据分开。** CreationBinding 和新制作快照冻结 `inputSources`、`reviewInputs`、purpose/scope。前者为实际执行来源，后者只列本次必须取得的创作认可及准确 confirmationId；服务端核实该确认事实存在且 subject/source 相同；认可的 group/item 属于上游来源，新产出可交付到同一 work 的另一组，完整保留这份引用。工程文件、素材选择、试做请求不自行变成认可。用户原消息可直接作为来源，不强制先发布成脚本。只保存实际用到的直接绑定，不从最新 head 反推历史。
6. **局部试做与正式制作。** draft/preview 只取得当前明确目标及范围，允许使用此次试做的未认可稿；不能把许可扩成整片制作，或以 preview/clip 绕过正式范围必要依据。正式制作沿直接 binding 核对准确认可，初始样张可按范围具有空 reviewInputs。付费操作继续使用现有提案授权；纯本地动作不增加“确认 ¥0”卡。准备与受理共用判断，admit 不补造认可。
7. **运行来源与财务。** Run.origin 只有 proposal 或 local_request 两个真实分支，不另双写顶层 proposalId。新 ProductionSpec 标记 `paid_production` 并保留费用；LocalCreationSpec 标记 `local_creation`，保存真实 request/message、范围、来源、目标及仅本地 render operations。local run.finance 必须为 null，不伪造提案、user_action、authorization、预留或账单。生成、取消、供应商费用和最终产物是不同事实，unknown 不触发猜测性重发付费创建。
8. **工程先封存再渲染。** `publish_project` 持久化选定源码、模板、字体、锁文件、时间线、来源修订和宿主固定镜像，返回 kind=project 修订；它不认可、不执行、不逐文件交付 UI 卡。`render_project` 只从冻结工程受理，复用 kind=render、assembly=code_project 和既有 Worker。每操作一个主要输出；image/audio/video 分支使用各自参数，PNG/音频没有 fps。ExecutionInput.resolvedProject 是宿主核对过的 blob 文件清单，不是任意脚本或宿主路径。正式代码样张和短预览也走这条路径，定稿只引用生成时工程。
9. **同次分配目标与交付。** 已有目标引用准确 group/item；新目标在同次交付或受理参数声明并由服务端分配稳定身份，返回 reviewTargets，不先造空媒体。`local_output` 只引用已登记落盘的 run/operation/outputSlot 或可信免费工具结果修订；目标由同次 reviewGroups 绑定，修订带准确 baseRevisionId，不能用可变裸路径补推来源。worker 直接使用同职责发布逻辑，完成批次等待用户，不再拉一次 Pi、不自动认可/继续/审计。
10. **后台生命周期与版本。** 运行输入不可变；聊天切到其他 work、回合结束、继续讨论新稿不改变在途归属。沿用每 work 在途受理限制；保存后继稿与独立认可仍可继续。明确取消只停止对应 run。旧运行回来时若目标已有后继稿，保留其可查看输出但不覆盖当前 draft。事件继续复用 artifact.delivered/work.changed/run.changed，进度来自实际 worker，不制造无来源百分比。
11. **作品库与持久选材。** LibraryVideo 以准确已定稿视频修订为身份并去重，保留既有 plan/content/originMessageId 含义，扩展冻结 project、实际使用 materials 和 reviewSources。明确保留工程资源与成片采用素材分开；历史缺项返回 null/[] 与 `provenanceStatus=not_recorded`，不拿新 head 补齐。librarySelections 在 MessageInput 发送时建立使用上下文并持久回传 Message，保留 sourceVideo 与 artifact_revision 或 project RevisionRef+relativePath。按钮认可不得同时携带选材；选择本身不制作，也不更改原作。
12. **媒体、工程下载与能力状态。** 二进制复用鉴权 blob 入口；工程文件用下载语义、受控 Content-Type 和 nosniff，JS/HTML/SVG 源文件不作为顶层同源网页执行，不新增公开上传。read_artifact 的图片/视频反馈帧作为真实 image blocks，时间用毫秒；只返回元数据不等于看过，转写/信号分析不冒充试听，未验证音频适配不注册空工具。Skill 发现 status 与 runtimeStatus 分开；未知依赖为 unchecked，ready 需要实际探测证据。普通聊天、健康检查、事件和创作环境不回显或持有真实 Key。
13. **可操作的受理缺口。** Proposal 与索引返回只读 acceptanceBlocker，缺认可、输入已变、能力不可用分别给 review_inputs/prepare_again/configure_capability。它从同一受理条件即时推导，不另外存状态。只有 state=ready 且 blocker=null 展示确认制作；明确拒绝后刷新事实，过期或缺项时不继续引导用户“回复确认就能制作”。
14. **一次历史读取兼容。** LegacyWork、旧 StageDraft/StageConfirmation/ToolConfirmStage、LegacyCreationBinding 与无 type 的 LegacyProductionSpec 仅为旧不可变记录和旧测试读取保留。旧 binding、plan_source、快照在共同读取边界一次规范化，保留原 JSON/digest/真实认可；不能回填缺失事实、重写旧 Pi 历史或让每个消费者各猜一遍。新消息/交付/制作意图不接收固定阶段双写字段；新回合只挂 confirm_review，不同时挂 confirm_stage。旧素材/工程缺项明确显示“当时未记录”。

免费配音的 `rate` 是生成语速，必须完整匹配带符号百分比；边界已对应生成后的准确音频字节。当前 narration 只支持增益、起播与补尾，时间线 cue 等于源边界加 `timelineStartMs`，不再次按 rate 缩放。同字节 `local_output/artifact_revision` 正式交付保留该准确修订已有的 `dub/sources`；跨会话作品库选择按当前修订的既有关联共享同 owner blob，不修改原归属。未记录的元数据不按 blob 全库猜配，普通工程文件没有准确绑定时不补造配音信息。

离线 contracts:generate/check 验证本地引用、外部 JSON 正反例、HTTP 连接和派生 TypeScript；它不证明实现 provider、真实沙盒、数据库迁移、付费服务或端到端旅程已通过。
