# 顺序实施方案：P0–P4

这些是五个完整工作批次，不是五次等用户审计；按依赖连续实施，最后统一核对。先核实再改；以下拟新增字段/状态明确是实施设计，不是声称源码已有。

## P0｜固定基线，保住已完成单审

**用户目标**：不会因为接管又恢复 GPT/双审或破坏已有作品。

**读取**：BASELINE；main.ts、role-agent-assembly.ts、production-studio.ts；codex-visual-review.ts、asset-pilot-review.ts；role-agent-assembly.test.ts；根与各 app 的 package.json。路径前缀分别为 apps/studio/src/server、packages/production-pipeline/src、apps/studio/test。

**步骤**：

1. 记录实际 HEAD、工作树与 Node/原生模块版本；不覆盖旧修改。建议产品修改前创建 codex/ 前缀工作分支，保持未提交；不要求用户先清空工作树。
2. 跑已有单审 assembly/试片合同聚焦测试，验证 mode=single、真实 executed model、有效 output，而非仅“数组长度为 1”。
3. 核对 main/launcher/目录/创建/恢复入口，不应产生 GPT 执行。保留历史 mode=dual 的只读解释和强校验，不削弱旧独立性 guard。
4. 修当前正常单审路径的误导文案：NewRunDialog 约 568 行、production-studio 双审提示、RunWorkbench 的审片结果标题/计数。按当前报告模式展示，历史双审仍诚实显示双审。不要全仓替换“双审”二字。
5. 不重写已改单审的 12 个历史子测试；只补遗漏的当前行为和失败路径证据。

**验收**：A01/A02。非目标：重命名所有 codex 类/目录、迁移历史数据库、卸载用户本机 Codex。

## P1｜让完整负面意见真正交还用户；接通缺结果恢复

**用户目标**：有完整意见时能决定改或继续；没有意见时能重试审查，已买画面不重买。

### 当前代码落点（必须读完整上下文）

- packages/production-pipeline/src/generative-asset-worker.ts：
  AssetPilotReviewError、reviewPilot、direct 与逐镜 router 两条执行分支、各自 catch/WorkerResponse、closeUnsubmittedItemsAfterTerminalOperation。
- packages/production-pipeline/src/asset-pilot-review.ts：
  SourceAssetPilotReviewer.review、缓存键、report.reviewScope。
- packages/production-pipeline/src/production-pipeline.ts：
  createWorkflow/workerNode、dispatchDecision、retryFailedNode 相关调度、finalReviewEvidenceId、withBoundaryGate。
- packages/workflow-core/src/types.ts / workflow-runner.ts：
  HumanInterventionDraft、HumanDecisionDraft、resume、retryFailedNode、checkpoint。
- packages/production-pipeline/src/python-worker-client.ts：WorkerResponse 合同及消费端。
- apps/studio/src/shared/api.ts / server/app.ts / server/production-studio.ts：
  决策/重试解析、API、持久化命令观察与 run 投影。
- apps/studio/src/client/components/RunWorkbench.tsx：
  source_review_retry 专用面板、普通干预、审查展示。

### P1.1 先建立两条“真实生产内层”失败测试

1. **完整负面**：正式 GenerativeAssetWorkerClient + 受控媒体 adapter/reviewer transport，首镜生成物化后审查返回合法低分/repair，随后通过真实 worker response、正式 pipeline、隔离 store 和 HTTP 观察状态。
2. **审查无结果**：同链，但审查服务抛结构化不可用错误。不能仅注入 sourceReviewIncompleteError 给最外 provider，跳过 worker 自己的 catch。

本次静态核查发现，内层 reviewIncomplete 异常会被 worker 分支捕获并转成 failed/rejected + ASSET_PILOT_REVIEW_FAILED；上层 workerNode 当前用 catch 识别抛出型 isSourceReviewIncompleteError。**必须检查实际转换是否丢掉“审查未完成”语义**。两个分支都测；不能只让人工构造异常的旧测试变绿。

同时记录：首镜 create=1、素材 SHA、provider task ID、已物化账本、剩余 create=0、report 完整性。先留失败证据再动实现。

### P1.2 使用现有状态机的小扩展，不造新状态服务

复用 needs_human。建议在现有 intervention.kind 联合中新增 `source_review_decision`，专指**已有完整负面试片报告**。既有 `source_review_retry` 保留专指没有有效回执。WorkerResponse 增加/复用可序列化的明确审查结果字段，把 complete_negative/incomplete 语义带到 pipeline；不要靠中文报错字符串识别，不能丢掉 artifacts 和费用事实。沿一个正式消费点转换干预，两种 worker 路线共用该合同。

| 情况 | 状态/动作 | 禁止 |
|---|---|---|
| 完整正面试片 | 在原授权、原执行范围内继续该素材节点；完成后停既有节点边界 | 自动越过其它节点确认 |
| 完整负面试片 | needs_human/source_review_decision；查看报告、调整方案、明确承担继续、终止 | 直接判整条 run 失败；无提示继续花钱 |
| 没有有效回执 | needs_human/source_review_retry；重试本次审查或终止 | 普通 approve 跳过；把空报告当完整负面 |
| 缺媒体/非法 plan/扣费 unknown | 保留对应现有恢复/核账出口 | 通过质量承担绕开资产、合同、资金守卫 |

低分质量建议不是硬否决；缺实际素材、合同不合法或越权付款仍为硬边界。不要把所有 blocked 字段改成 warning。

### P1.3 承担继续必须绑定真实证据

优先沿现有 HumanDecision + 持久化 transition + revision 检查，不新建授权系统：

- 复用 reviewEvidenceId，并让其指向服务端完整报告快照身份：报告内容/规则版本、实际 reviewer、media SHA、inputFingerprint、方案身份；不能只有媒体 SHA，同一媒体两次不同意见也必须区分。
- 服务端从当前 artifacts、输入和当前干预算身份；客户端只提交当前 intervention、revision、evidence ID、承担动作及必要说明，不提交可生效的 score/pass/report。
- 接受记录和回执进入现有 run/checkpoint，恢复时从服务端读取。给 worker 的已接受试片证据应由编排层构造并验证，不允许普通 input override 伪造 bypass 标志。
- **泛用 resume(approve) 可能把等待节点直接视为已完成。不能这样处理半完成 assets。** 专门分派该 kind：在同一受锁 transition 中验证→记录人类决定→恢复同一 assets 未完成操作，复用 retry/checkpoint/ledger。若需扩 retry 选项，仅为该 kind 加受控准入，不放宽所有 needs_human。
- 同一决定双击/并发最多推进一次。复用已有 revision/操作身份；可返回同一结果或无副作用 stale/conflict，不必另建通用幂等平台。
- 成功消费后只放行该试片分组；其它 provider/model/参考路线分组仍须各自试片。不是整片免审。
- 方案、媒体、输入、审查规则或报告更新使接受失效；历史记录保留。

### P1.4 修复账本生命周期，不把恢复变成新购买

目前两条 worker 路线 failedJob 收尾会 closeUnsubmittedItemsAfterTerminalOperation。审查暂停不是生成终止，不应顺手把剩余原操作全部不可逆关闭。

- 审查暂停时保存 plan、jobs、review、产物与操作进度，已 materialized 项保持真实状态；区分“媒体已成功，审查暂停”与“媒体生成失败”，不增加失败生成次数。
- 剩余尚未提交项保留可恢复事实；恢复同一 operation、有效 scope、相同输入与尝试限额时才继续。若原授权不再有效，回到现有报价确认，不复活旧授权。
- 旧已关闭条目不为了省步骤直接改回可采购；沿既有重新报价/复用机制恢复，显示原因。
- 重试审查/承担意见不调用已成功镜头的 create，不重复扣款，不重置 unknown。试片分组内尚未生成部分只有合法授权才可调用。
- 单审报告缓存身份应包含实际模式/规则/候选等有影响的事实。已包含的字段复用；不全删历史缓存，改变身份自然失效。
- UI 明确“保留现有试片，接受这些意见后继续剩余素材；是否产生费用取决于当前报价授权”，无新授权不得写“免费继续”。

**验收**：A03–A10；旧 R01–R11 及 M09/M10/M14 迁移语义。风险重点是资产节点半完成恢复，不是按钮改名。

## P2｜故障分类、有限重试、长耗时可解释

**用户目标**：失败能说明原因、保留工作、正确恢复，不换无效备用或无限等。

**读取**：
- apps/codex-broker/src/chat-completions-executor.ts（failureCategoryFor、provider error 解析、SSE 上限、取消）。
- packages/production-pipeline/src/model-fallback.ts、fallback-task-client.ts、fallback-role-agents.ts、role-agent-loop.ts、codex-chat.ts。
- Studio 的 text-task recovery 实现、production-studio 投影、provider-catalog.ts、codex-provider-settings.ts。
- 相应 fallback-role-agents/fallback-task-client/chat-completions-executor/deepseek-fallback-integration/text-task-production-recovery 测试。

### P2.1 先完善错误分类表

| 证据 | 预期动作 |
|---|---|
| 明确受支持的 provider 结构化 model_not_found/模型停用码 | 在已知未受理/确定失败前提下，切合格候选 |
| 裸 404/http_404 或错误 endpoint | 不推断模型下线，不盲切；保留诊断并暂停 |
| 400 合同字段错误、拒绝、conflict | 暴露合同问题，不拿第二模型掩盖 |
| 401/403 | 凭据/权限出口，不同账户前提未经证实则暂停 |
| 402/明确账户余额耗尽 | 同账户共享故障，不遍历该账户所有 modelId |
| 429/503/timeout | 先分作用范围与 acceptance 状态，按既有预算有限恢复 |
| uncertain/已受理仍在运行 | 观察原 requestId、原 Broker，不发 backup 新请求 |
| 媒体付费 unknown | 既有核账，不通用重试，不标未扣费 |

优先扩现有 failureDetails 的分类/原因（必要时增加 account scope），同步 Broker 输出、client parser、健康/恢复展示和合同测试，不造第二套错误包装器。原始 HTTP/code 与脱敏诊断保留。未知码保守暂停，不凭中文或模型名称猜。

当前同账户 DeepSeek 候选不是跨账户 backup；没有其它合格且已配置的供应商时暂停是正确结果。不新增订阅或恢复 GPT。

### P2.2 有界执行与统计

已有共享 stage deadline 和 pendingCandidate 恢复逻辑，先测试再补缺口。建立一个完整逻辑操作的物理请求账：role produce/audit、schema repair、候选、transport 各次都可追溯；共同 deadline/call budget 不被嵌套重置。使用现有预算配置并记录实际数值，不为图快偷偷降低档位/上下文/正常输出上限。

失去请求结果先查询原任务；取消/进程重启不得并发发第二条同义任务。真实 SSE 字节上限保持现有 32MiB，结构化正文 1MiB 等边界区分记录；reasoning 不混进正文 JSON。覆盖 UTF-8 分块、心跳、EOF/length、abort/最后一帧竞态，防双结算/泄漏。

把排队、首输出、模型生成、repair/候选、持久化/轮询和人工等待分开；用户等待不是模型耗时。展示逻辑复核数和真实物理尝试，不用节点次数冒充 API 调用。不要创建新性能监控平台。

**提示词与重复检测**：先比较现有实际 prompt 的重复部分，仅删除可证明重复内容，保留用户要求/证据/输出合同；没证据就不改。重复终止检测没有正常长报告和合法重复反例时记 deferred_not_enabled。不要以“优化”新增一个误杀主线的机制。

**验收**：A11–A17、M01–M14、O01–O10（迁移和允许延期见验收表）。

## P3｜一次复核、明确生效设置、简化交互

**用户目标**：知道自己确认的是哪一版；新建轻；模型配置在哪改、影响什么一眼能看懂。

### P3.1 先校正触发和身份，再改 UI

读取 packages/production-pipeline/src/creative-review.ts、role-agent-loop.ts、production-pipeline.ts；Studio production-studio、CreativeDiscussionPanel、RunWorkbench 及相应测试。

- 一次创建/保存至多触发一次默认逻辑复核；同一请求重放不触发第二次。用户主动讨论改稿或重审可再运行，次数不限制为固定三轮。
- 有效 pass/repair 回执已存在时确认只绑定该回执，repair 必须明确承担，不再次调模型。
- 第一次确认若缺回执，先执行一次；结果出来留给用户看并确认，不将第一次点击自动套用到后来不同意见。
- A 在审查时保存 B，A 迟到结果只能进历史，不覆盖 B。相同草稿第二次审查意见不同也要换 checkIdentity。
- 复用当前 stage/reviewRevision/draftSha/checkIdentity 的服务端检查，覆盖真实 HTTP、重启、两个标签页，不只测纯函数。
- 无损识别已约定 severity 别名；畸形回执不能默认 pass。误判反馈保留历史，但下一轮有效要求只取当前已采纳集合。
- 声音语速/停顿改动同步规划与合成；换审片模型只重审、不重买；改稿/素材/生成路线按真实依赖失效；已付可用媒体保留。付费路线可以选，新的购买仍先报价。
- 不把 maxProducerCalls/schema repair 次数机械等同“作品自动改稿轮数”；在 trace 上证明没有质量驱动的未授权自改循环。

### P3.2 模型目录与配置

读取 apps/studio/src/server/provider-catalog.ts、codex-provider-settings.ts、role-agent-assembly.ts、creator-settings-store.ts、studio-service.ts；shared/api.ts；client/pages/ResourcesPage.tsx。

不新增数据库。复用现有 JSON store 的原子写与串行更新、现有 brief.models/modelSelectionSources 和执行参数。有效模型身份从同一目录产生，UI/API 校验/assembly 一致，不能再各写一张候选表。

冻结规则：

1. 新建时：用户输入 > 已保存且合格的默认 > 系统默认。
2. 执行时：当前节点明确覆盖 > run 创建时冻结的设置。
3. 全局设置后改，不暗改进行中的 run；删除节点覆盖恢复**该 run**继承值，不从今天全局偷取另一个模型。
4. 实际 fallback 记录真实尝试，不把用户选择抹掉。推理档位如协议不支持，诚实展示，不静默伪称已经使用。
5. 客户端不可信：直接 API 创建也满足以上规则；过滤错误 provider/model/能力组合和假 modelSelectionSources。退役身份不能被旧默认复活。
6. creator-settings-store 的 modelDefaults/roleProviderDefaults 更新可能整张替换：五类页面保存单类不能清空其它类。优先复用现有完整快照更新方式，不随手改全系统 patch 语义。

如当前模型 map 无法恢复 run 继承值，最小补充冻结继承快照并在 existing run parsing 中兼容缺失；不能引入另一套配置存储。保留“不存在的模型不可执行”安全限制，不盲信快照。

### P3.3 设置页与新建页面具体形态

设置里的模型导航固定五类：文本、多模态、图片生成、视频生成、声音生成。同一模型可在多类引用一个 canonical identity，不复制五份。按能力分组，不按 provider 强迫用户理解供应商；每项标角色适用范围、当前选择、可用性/费用提示。

原有选题策略、热点信号、声音参数、画面来源偏好、版权/来源、发布配置仍保留为相邻设置区域。声音“演员”和声音“模型”不是同一东西，不能删语速/停顿设置。付费服务仍可看到/选择，选择不等于采购。

NewRunDialog 主区保留：
- 当前入口带入的内容与可编辑目标；
- 必需平台/时长范围（可继承并清楚展示）；
- 可选预算意向；
- 可选参考资料；
- “继承制作设置”折叠摘要，显示免费优先/收费未授权。

不在新建主区堆全角色/逐节点模型/素材池；相关覆盖保留在实际节点工作区。需要的高级内容通过折叠或节点入口可找回，不删掉原本有效能力。案例入口资料绑定与系列约束不能因精简消失。

停点页面按五件事展示：当前版本及产物、意见、可用动作、下一步影响、费用。保存冲突保留草稿并提示刷新，不以通用红条丢输入。RunWorkbench 单审展示按当前报告模式，不显示“1/2缺一份”。

**扩展性验证**：用测试配置加入一个同协议文本候选，贯穿目录/API/执行/恢复/显示；测试注入一个审查规则版本变化，使旧回执失效并正确显示未覆盖。不是新增线上模型、动态插件平台或产品评分维度。新协议未来仍需 adapter。

**验收**：A18–A25、C01–C14、E11/E12/E14。

## P4｜集中验证、本地 QA、统一收口

依赖 P0–P3 的合同已稳定。先集中修完确定性失败，再统一全量测试；有失败不能标阶段通过。构建类命令串行运行，避免清 dist 与运行服务互撞。

按 03_ACCEPTANCE 与 04_LOCAL_QA 完成四入口、全可达边界、素材、声音、渲染、单审、人工终审、本地下载包的分层验证。没有真实付费授权不伪装完成真实模型链；做完免费与离线项后报告最小所需授权。

不重新启动 Oracle 外部审计、不外传私有代码；本轮明确任务是本地执行。未来用户要求 Oracle 时另按最新技能操作。

最终仅更新本目录 RESULT 与确有必要的项目使用说明；不维护第二份相互冲突的进度表，不改旧报告历史事实。Graphify 只在产品代码完成后按可用命令常规更新一次；环境缺失则记录，不修工具、不阻断交付。

**验收**：A26–A30；用户是否接受作品单列，不代签。
