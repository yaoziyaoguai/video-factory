# 02 固定技术方案与交接合同

以下是实现决定，不是待执行端重新选型的备选清单。若当前源码已实现等价边界，复用并证明，不重复造一份。

## A. 已验证的基础与改动边界

2026-09-14 核对：HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`，分支 `codex/final-dual-review-cloud-acceptance`。`BASELINE.json` 记录 316 个源码/测试/脚本/主要文档摘要及完整 dirty 清单，暂存区为空。

当前架构继续使用：

- React/Fastify Studio：薄 UI 与 API，生产业务协调在 ProductionStudio/ProductionPipeline。
- `creative-planning.ts`：固定 LangGraph 图，目前 treatment→script→director 自动前进；图库路线包含 candidates/rank/evaluate/integrate。
- `CreativePlanningStore`：`workspace/planning/checkpoints.sqlite`，官方 SqliteSaver；不得退回内存或换数据库。
- `WorkflowRunner` + `FileRunStore`：顶层运行状态、产物和版本、锁、执行 receipt、费用与人工动作。
- Broker durable accept/poll、role-agent checkpoint、现有 Provider/双审/素材复用继续使用。

关键已核实事实：

1. `runCreativePlanning()` 恢复使用 `graph.invoke(null)`；当前 outcome 仅 completed/halted。正常等待必须增加独立 outcome，不能抛异常冒充失败。
2. `production-pipeline.ts:6092` 把非 completed 规划结果直接抛错；这里必须处理正常等待且不得发布未确认的最终产物。
3. `WorkflowRunner.resume()` 对通用 approve 直接把整个等待节点设为 succeeded。**不能直接用它确认创作阶段，否则会跳过其余规划。**
4. 安装的 LangGraph 支持 `interrupt()` / `Command({resume})`；中断通过 GraphInterrupt 抛出，不能被业务 catch 吞掉。中断所在节点恢复会重入，所以中断前不得夹带模型调用或变更。
5. 当前各角色 Detailed 方法包着 producer+audit 自动循环。只加前端聊天无法实现“草稿先讨论，确认前再审”。

## B. 单一创作状态，不新建聊天系统

### B1. 状态归属

扩展现有 PlanningGraphState，新增窄领域字段 `creativeReview`。它是**草稿、讨论操作、阶段确认的唯一权威**，随同一 SQLite checkpoint 落盘。FileRunStore 只保存顶层等待投影/引用，不另存一套可独立批准的确认状态。

文档正文、完整消息可用已有 run 私有产物目录保存不可变 JSON；checkpoint 保存引用、SHA 与摘要。先原子写文件并验证 SHA，再把引用写入 checkpoint；中间崩溃最多留未引用文件，不产生确认。禁止文件原地覆盖、客户端提交任意绝对路径。单个消息可直接随 checkpoint 保存，实际较大正文才外置，不强制新存储框架。

建议新增窄模块 `packages/production-pipeline/src/creative-review.ts`：类型、解析、命令与状态转换规则、确认身份、影响范围。放这些真实职责，不把整个 Pipeline 搬进去。HTTP/UI 投影仍各在原层。

设计字段（与已有命名冲突时可重命名，但不得删语义）：

```ts
type CreativeStage = 'treatment' | 'script' | 'director';
type ReviewPhase = 'drafting' | 'waiting_user' | 'responding' | 'checking' | 'confirmed';
type DraftRef = {
  artifactId: string; sha256: string; revision: number;
  stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
};
type StageConfirmation = {
  draftSha256: string; stageInputDigest: string;
  upstreamConfirmedDigests: Partial<Record<CreativeStage, string>>;
  checkIdentity: string; actor: string; confirmedAt: string; commandId: string;
};
// 每阶段：phase、currentDraft、previousDraft、proposals、messages/引用、
// effectiveUserInstructions、confirmation、checkResult、lastFailure。
// 全局：version、activeStage、reviewRevision、operations（含在途与完成命令）。
```

- `reviewRevision` 是创作操作并发版本，区别于 whole-run revision、draft revision、stage input digest。读/轮询不递增；有效写入递增。
- `effectiveUserInstructions` 保存用户原文或明确采用的提案引用、message/commandId、阶段/镜头范围、active/superseded。不把助手回复、聊天总结或旧审计原文自动升为要求。
- 不维护分支树、通用文档版本平台。当前版、上一版、备选及审计证据已足够。
- 完整历史仍可查；模型上下文只取当前稿、有效要求、相关上游、最近最多 20 条讨论及必要引用。未发送的本地草稿不进入请求；消息分页与模型输入裁剪不同，不能丢掉有效用户决定。
- 超过已有字段容量时返回清楚限制，不能截断用户禁令/系列事实再调用。模型未能明确理解冲突时返回 clarification，不能由关键词补丁替用户裁决。

### B2. 固定图拓扑与等待

保留原 `creative-planning` 顶层节点，只在内部设置三个明确创作确认点。实现使用现有 LangGraph interrupt，不自造调度器。

```text
treatment 草稿 → treatment_review 等待 → script 草稿 → script_review 等待
→ director 草稿 → [必要的 candidates/rank/evaluate/integrate]
→ director_review 等待 → compile → 发布正式计划
```

三个 review 节点都是无副作用的 interrupt gate。模型生成、校验、候选物化引用写入必须在 gate 前后独立节点完成并 checkpoint；不能在 interrupt 之前重新调用 producer。

讨论命令走同一小组固定命令节点：登记操作 → 执行当前角色动作/检查 → 发布结果 → 返回对应 gate 或合法下一阶段。不要为每个角色复制一套恢复服务。客户端只能提交白名单动作，不能传 LangGraph 的 goto/node/任意 resume 对象。

图库检索和排序可在分镜讨论前执行一次，以便给出真正可行方案；改 query/素材路线才按现有身份重搜/重排。`integrateDirector` 当前仅确定性补排序理由，不应再调用一次导演。若可得性反馈需要改变已经确认的脚本/前期方向：保存待调整理由和提案，回到用户；禁止当前 `evaluate→script` 自动边悄悄推翻确认。同阶段、尚未确认的可执行细节仍可在现有有界预算内处理。

分镜最终确认对象是整合后的实际方案。确认之后若任何用户可见内容/路线发生变化，确认失效；只改变库存下载位置等不影响语义的执行细节不必重聊。已确认方案内合法备用模型的执行选择依旧遵守原报价范围。

### B3. 顶层等待映射与不可绕过

- 新增 `CreativePlanningRunOutcome.status='waiting_user'`，携带当前 stage、草稿及 gate 身份。
- 顶层复用 `needs_human`，intervention 增加可选 `kind:'creative_review'` 和受校验的 continuation 引用；普通历史/终审 intervention 保持原语义。
- `creative-planning` 在等待时不能生成可被 assets 消费的最终 outputState；草稿是讨论产物，不能伪装最终 scriptPath/executablePlanPath。
- **所有通用入口**（decisions approve、retry、resume、regenerate-stale、override、直接 Pipeline/CLI）必须识别创作 continuation。通用 approve 对此明确拒绝并指向创作确认入口，不能标 succeeded。普通 resume 只恢复到同一 gate，不能视作确认。
- ProductionPipeline 增加窄的创作命令入口：在执行 lease 下校验/恢复原 creative-planning 节点，保留其版本与已有产物，经图内部确认后再由原 WorkflowRunner 执行后续节点。必要时给 runner 增加“继续节点内部等待”的窄接口，不调用通用 approve；不得手工填 succeeded 跳过节点。
- SQLite 先保存权威确认/等待，顶层 run 再 checkpoint。两者之间崩溃，启动恢复/读取投影必须依据同一 gate 身份恢复显示；只有显式被受理的确认命令可以恢复推进。没确认的等待即使顶层残留 running，也不能被 `recoverInterruptedRuns` 误判成可自动继续。
- 用户等待不占用 Broker/执行 lease，不维持长 HTTP。正在执行的一条文本命令继续原 lease 心跳与 durable recovery；暂停不取消已经被 Provider 接受的任务，只阻止后续推进。

### B4. 操作与幂等

API/领域动作：`discuss`、`adopt_proposal`、`undo_draft`、`confirm`、`return_to_stage`。修改模型/声音/素材池继续走现有配置接口，但适用相同冲突和失效规则。

动作必须绑定：`commandId`、请求内容摘要、`expectedRunRevision`、`expectedReviewRevision`、`stage`、`baseDraftSha256`、当前 thread/input 身份。无草稿的生成阶段不可 confirm。

处理顺序固定：

1. 认证、授权访问当前 run；字段/大小/引用校验；actor 从当前登录身份取得。
2. 获取现有 run 执行/维护 lease，再读当前状态。
3. 先查相同 commandId 的持久化操作。相同请求返回原操作/结果；同 ID 不同内容返回 409，零新调用。重放成功不得因旧 expectedRevision 再执行一次。
4. 新命令核对所有预期身份；过期/跨 run/跨 stage 引用 409/400，零写入、零模型、零费用。
5. 把不可变命令与 original operation/request identity checkpoint 后才调用 Broker。命令受理返回 202；前端观察原 operation，不用重复 POST 轮询。
6. 已受理未知任务用原 `preparedOperation`/requestId 观察，不能换模型。迟到结果仅绑定原稿/原命令；当前身份变了不得覆盖新草稿或放行。
7. 发布响应、新草稿或检查结果，与命令完成状态在同一 checkpoint 更新。随后投影 run。崩溃重放只补发布/投影，不重新物理调用。

所有双击/两窗口/重启测试都针对这一正式链，而不是单测一个 reducer 后宣称幂等。

### B5. HTTP 合同（本轮新增目标）

在现有 `apps/studio/src/server/app.ts` 注册，沿用认证与错误映射；对应 service、client API 和 shared parser 一起添加：

| 接口 | 输入/输出与行为 |
| --- | --- |
| `GET /api/runs/:runId/creative-review` | 返回当前stage、reviewRevision、currentDraft/confirmed引用、可读文档、检查结果、allowedActions、消息与提案分页；无模型/写入副作用 |
| `POST /api/runs/:runId/creative-review/commands` | 白名单动作与并发身份；首次有效接受落盘后202，返回commandId/status/observationUrl；重复同命令返回原操作，不重新执行 |
| `GET /api/runs/:runId/creative-review/commands/:commandId` | 只读当前running/completed/failed/unknown及结果身份；未知ID为权威404，不冒充任务失败、不创建新任务 |

POST共用字段是B4列出的身份；action分支：

- discuss：非空message（本轮入口上限4,000字符；超长明确拒绝，不截断）、optional selection（全片或当前文档真实beatId/scenePosition）。
- adopt_proposal：当前stage中、基线仍匹配的proposalId；不能给其它run的文件路径。
- undo_draft：当前previousDraft引用，不能任意指定历史系统路径。
- confirm：只提交所见当前稿身份，没有客户端自报pass、confirmedAt、actor或spendApproved。
- return_to_stage：目标只能是当前或已到达的前期阶段，带`acknowledgeImpact=true`表示页面已明确展示失效/保留范围。影响由服务器计算，客户端不能指定“保留全部授权”。

请求未知字段400、超出大小413、身份冲突409、未登录401、无权限按现有API规则403/404。失败保持真实分类：合同拒绝、未受理、已受理失败、结果未知分开；不存在操作404不能把仍在途Broker任务清空。

浏览器响应丢失后查询同commandId。权威未接受时可补发**同ID同body**，仍经B4幂等检查；不能换新ID“重试一下”。refresh/poll只GET。202仅表示持久化接收了命令，不表示模型成功或已确认阶段。

StudioPlanningStage新增waiting_user/checking等所需投影及allowedActions，保留旧终态展示。普通run status仍needs_human；前端依据intervention kind显示创作工作台，不显示通用终审“通过制作”按钮。

### B6. 确认不是自动修稿

`confirm` 做：结构/当前能力/来源硬边界 → 同版本独立 role-audit → 核对当前版本未变 → 写 confirmation → 合法下一阶段。

- 初稿与普通讨论不循环独审。确认只审用户看过的稿件，不先 produce 一次新稿。
- 同一稿、用户约束、上游确认、有效配置、来源、审计模型/合同完全一致时，可复用**该 run 该阶段**已有检查；消息解释本身不改变稿件内容就不使检查无故失效。不得跨 run/模型复用审片结论。
- 检查发现质量问题/误分类/路线问题：保存原检查与有效修订要求，保持 waiting_user；“按建议修改”属于下一条显式创作命令。未修不能批准；修出新稿也未批准。
- 真正缺来源/需改用户承诺：同一工作台列缺项，不自动换题、改承诺或无限再审。用户可继续讨论；补材料/改明确要求后重新检查。
- `checkIdentity` 包含候选 SHA、有效指令、上游、来源/能力、voiceTiming（仅消费者）、审计模型和合同版本。不能只靠“已审过”布尔值。

## C. 模型、提示词与协议

### C1. 保留一套生成和校验

在现有三个角色 adapter 与 role-agent 执行工具中提取可复用的**单次候选执行/单次候选审计**能力，均沿用 CodexBridgeClient、prepared operation、结构校验和 trace。新交互规划采用它们；其它原角色的有界 loop 继续使用同样底层能力，不复制一套 Broker 客户端或“聊天版流水线”。

新增能力不是调用 `treat()` 无 checkpoint 快捷路径。每次草稿、讨论、确认检查都必须有 durable original request identity 和实际模型记录。禁止把新规划的“草稿”标成旧 role-loop 的 audit passed；可以新增明确的内部完成态/执行结果类型，读写两侧同步。

### C2. 一种窄讨论 task，不另加分类 Agent

新增 Broker task kind `creative-discussion`，使用当前阶段用户所选角色的实际模型与既有备选策略。一次调用同时解释意图和产生需要的完整草稿，不先调用一个模型“分类”再调用另一个模型“聊天”。

请求只含：stage、当前文档、有效用户指令、已确认上游、真实能力、必要来源/系列约束、voiceTiming（实际消费者）、本次消息与范围、最近相关讨论、当前有效审计反馈。不传整库/整份资料包、旧全部轮次或密钥。

输出为严格 envelope：

```ts
{
  stage: 'treatment' | 'script' | 'director',
  intent: 'explain' | 'propose' | 'revise' | 'clarify' | 'request_upstream_change',
  reply: string,
  changeSummary: string[],
  treatment: CreativeTreatment | null,
  script: ScriptDraft | null,
  director: VisualDirectorPlan | null,
  upstreamRequest: null | { stage: 'treatment' | 'script', reason: string }
}
```

- explain/clarify：三个文档均 null，宿主不得改稿或失效确认。
- propose/revise：仅本阶段文档非 null，必须经已有完整 validator；不是把 JSON patch 直接写进文件。propose 只存备选，revise 更新当前未确认稿并显示差异。
- request_upstream_change：不改已确认上游，展示建议；用户显式返回该阶段后处理。
- response 不能含 approve/spend/execute 指令，宿主也绝不解析聊天“同意”直接推进。
- `adopt_proposal` 不调用模型，核对提案的 base SHA 与用户权限后更新草稿；提案基线失效需重新讨论。
- 内容解释/审美判断由模型负责；代码验证可执行字段、引用、来源/权限与身份，不能 regex 识别“夜景/咖啡/实验”来决定意图。

保留现有三个 producer task 的原文档输出合同；新 envelope 不污染这些旧输出。复用其 Schema 定义，避免复制后字段漂移；OpenAI strict schema 支持情况以本地 executor 和 ZAI 实际转换为准，必须做全部字段的跨边界组合测试。

新增 task 后不再假设任务总数固定为 10；实际支持 kind、descriptor、normalizer、执行映射、健康摘要和 REQUIRED digest 必须完整一致。前期 `topic-ideas` 原文输入也要同步此链。不能把 requestedModel 当实际模型。保持已配置强度、输出上限、超时与独立审查标准。

## D. R10 八项缺陷的具体处理

### F01：建议与用户要求

NewRunDialog 的可编辑用户意图不得被未触碰的 visualPlan 自动填充并提交。上游没有计划则允许无计划；删除该生产路径的固定 fallback 注入，不新增题材例外。用户编辑或点击采用后，通过真实 UI/API 操作持久化来源明确的要求。角色/审计/identity 使用同一有效投影；不只改单条测试断言。

### F02：恢复校验

`restoreCheckpoint()` 先验证并取出**同条** hostReadiness，再传给 `validateRoleAudit`。存在非 null review 而 host 丢失/损坏仍拒绝。保存与恢复共用 validator；不能清空 review、删除 checkpoint、重置轮次换取恢复。新交互检查的保存/读取也按此合同。

### F03：有效审计反馈

修 `revisionAuditForHost()`：原 audit、host 原样留档；过滤已精确标识的误分类项的旧 requiredChange，用独审对应具体修正要求。未纠正的真实缺料继续阻断。反馈合成函数只能派生结果，不篡改原 score/verdict 伪造认同。与 planning halt、Studio 进度使用同一有效处置投影；部分误分类不可全部放行。

### F04：导演路线权

在现有 validation context 中传**用户来源许可与逐镜真实性合同**，不单凭 `sceneVisualStrategies=stock` 推出必须真实拍摄。普通示意改 generated 需要：允许该方式、Provider/交付支持、用户未锁定来源、无事实取证冒充、所需引用可证明。脚本文本不变时由导演更新 authoritative acquisition；编译/资产 worker 读导演最终路线，不能继续从旧脚本 stock 推翻它。真实要求冲突或脚本需改则回到用户的脚本讨论。报价绑定新方案，不继承旧不相符授权。

### F05：共同声音配置与失效

声音修改通过 ProductionPipeline 业务入口写入 `initialInput.voiceDirection` 的当前有效配置；node input override 仅作为可追溯编辑，不保留另一份优先级矛盾配置。`voiceTimingFor`、实际角色输入、receipt、返工继承读同一投影。

按**实际 Provider 消费的控制参数**判定影响。unsupported pause 的保留值不应触发假重规划。矩阵：

| 变化 | 保留 | 重新判断/失效 |
| --- | --- | --- |
| 问原因、未采用备选 | 全部稿件、检查、确认、媒体 | 仅新增讨论记录 |
| 前期方向/系列已确认事实/核心允许方式变更 | 历史与可复用媒体 | 从 treatment 起的受影响草稿/确认/编译/报价 |
| 脚本文字/叙事变更 | treatment；无关媒体 | script 当前确认、director、时间轴、报价及实际消费者 |
| 单镜画面/素材路线修改 | treatment/script、其它镜头 | director 对应范围、整合/编译/报价；下游依内容判断 |
| rate/有效 pause 变化 | treatment、已有媒体文件 | script/director 节奏复核、voice/render/review；需要改内容先回讨论 |
| voice/profile/mastering 单改 | treatment/script/director与媒体 | voice/render/review；若能力变了另按真实能力影响 |
| 文本模型选择改变 | 未受影响上游和历史 | 被指定阶段及其消费者；在途先结算原任务，旧稿仍可查看 |
| 媒体模型参数/能力改变 | 不受影响的上游/媒体 | 受影响分镜可行性、编译、报价；已授权 scope 严格重校验 |

输入身份变更要重新验证，但不等于一定要重生成完整稿件/全片媒体。节奏复核证明原内容仍成立，可绑定新输入重新请用户确认当前内容；不能保留旧 checkIdentity。只有真正改变媒体请求 fingerprint 的部分才新买。

### F06：通用选题质量

去掉 `viralReadinessIssues` 等用问号、中文数字、最小文案长度、ACTION 词决定跳过/强制实验的硬否决。保留字段非空、引用合法、来源/风险硬合同。视频适用性和吸引力由现有总编模型及独审作语义判断；若当前输出缺推荐理由/形式，扩展其既有输出，不新增总编节点。展示模型真实理由；规则回退仍标待总编评估，不能偷放行。既有采用权限不扩展为用户绕过纯质量判断的新产品模式。

### F07：系列前期一致性

提取 treatment 专用的实际 brief 投影供端口和 identity 共用，包含已确认 bible/canon/continuity 与 episode promise；不要额外包含整个系列历史。上下游均传同一版本摘要；保存、审计和重启校验相同。无关运营数据变更不能引发构思重跑。

### F08：声音界面

VoiceStudio 消费已有音频能力，显示实际相对语速/停顿支持说明。保留配置值，但 unsupported 控件禁用并解释，不假装应用成功。测试 MiniMax/Kokoro/macOS 各自实际消费参数；不新增音乐/SFX 生成，不把未听到的声音写为已审。

## E. 热点原文阅读：有界、可追溯，不做全网爬虫

### E1. 流程与模块

在 TrendOpportunityAgent 的 canonical 信号分组之后、现有总编生成之前，注入 `TrendArticleReader` 窄端口。新增 `apps/studio/src/server/trend-article-reader.ts`，负责安全获取、正文提取、内容快照与缓存；不让浏览器或 Broker 自行任意搜索网页。

使用现有热度/时效/用户策略对最多 160 条信号初筛为最多 **8 个事件组**，每组最多 **2 个不同来源 URL**。不要强制只读标题带某类词的事件。只访问这些明确 URL，不抓关联网页、不做全站/登录后抓取、不绕过付费墙。

总编一次请求同时产出“本事件事实摘要与不确定项 + 发散角度”；同一现有独审检查原文证据与角度。不给每篇文章再加一个 LLM 摘要节点。新组数是抓取/上下文预算，不是永远只给一个选题或固定模板。

### E2. 获取与缓存技术已定

- 使用 Node HTTP 客户端（可复用已安装 undici）+ `@mozilla/readability` + 当前 jsdom 解析 HTML。jsdom 禁脚本、外部资源、虚拟控制台外传；只取文本，不渲染原始 HTML。新增 readability 作为明确生产依赖，Studio 使用的 jsdom 从开发依赖调整为生产依赖并与已有 lockfile 版本对齐；不要趁机升级整个依赖树。
- 并发最多 3；每 URL 包含重定向共 15 秒、最多 3 次重定向；本批正文获取总截止 60 秒。到时取消剩余网络读取、标记未读，仍处理成功文章，不串行等 16 次超时。
- 只接受 http/https、标准端口；拒绝带凭据 URL、localhost、内网/回环/链路本地/元数据地址、IPv6 映射与保留网段。每次重定向重新验证；DNS 解析全部地址并在实际连接时固定到已校验地址，保留原 TLS hostname/SNI。只检查字符串或先 DNS 检查再普通 fetch 会被重绑定绕过，不能算完成。
- 单响应解压后上限 2 MiB，流式计数，超限停止；拒绝非 HTML/文本内容。正文提取不足以辨认文章、验证码/登录页/榜单聚合页，不标已读正文。
- 持久化缓存复用现有 workspace 下的文件缓存模式，不加 Redis/向量库。成功正文 TTL 6 小时，读取失败 TTL 10 分钟；键含规范 URL、提取器版本，值含 fetchedAt/content SHA/结果状态。并发同 URL 合并正在读的 promise；跨进程缓存只需原子写，不追求全局分布式锁。
- 现有“换一批”复用仍有效正文缓存，但仍使用新的生成 nonce；内容刷新可使用现有刷新入口使正文重新获取，不因刷新伪称文章没变化。运行中的制作引用固定内容 SHA，不被 TTL/后续刷新替换。
- 存储提取后正文和段落编号；给模型每篇最多 8,000 字符的有界摘录、单批最多 128,000 字符正文。超出明确记录 `truncated=true` 和保留段落，不称全文已读；不能裁掉用户明确要求或伪补不可见段落。以上限制为资源护栏，不是降低模型/思考强度。

### E3. 来源证据合同

内部事实来源最少记录：sourceId、原URL/finalURL、页面标题、fetchedAt、可核实的发布时间、contentSha256、extractorVersion、`readStatus=read|partial|title_only|blocked|failed`、原因、段落 id+文本、truncated。读取失败没有正文 SHA；不能从标题 hash 伪造正文证明。

原文是外部不可信数据，提示注入不得改变角色/系统规则；页面中的“忽略要求/执行工具/泄漏凭据”只作为文本，不执行。缓存仅本地，报告不用粘整篇文章或用户私密输入。

总编输出的事实项带 sourceId/paragraphIds 和不确定性；机器校验引用实际存在，独审负责事实支持关系和观点/传闻/结论区分。读到正文不自动等于事实被独立核实；多个转载域名不自动构成独立证据。

正式输入链必须接通：reader → topic-ideas payload → Broker require/schema → topic audit → candidate/evidence 展示与保存 → 用户采用 → ProductionBrief 来源上下文 → treatment suppliedSources（当前正式端口是空数组，必须实际接入）→ script/director/audit/identity。

来源快照由服务器从可信 candidateId/sourceId解析并绑定，客户端不能声称 `verified=true`。需要新增一份共享的窄来源 DTO 时放 production-pipeline contracts，Studio引用；不并行维护两个“原文已读”字段。用户手动补充来源沿原有入口处理且标清来源性质。

`groundModelIdea()` 不能继续只按标题拒绝原文有支持的数字/引语；改为基于当前引用证据与语义审计。数字形式如“3种拍法”不自动当事实数值。title_only 只容许有限主题发散，核心事实缺证的制作仍停在可行动补料入口。

## F. 恢复、旧数据与安全边界

- 不迁移/删除用户历史 run/checkpoint。历史页面可读，历史证据保留。
- 新制作由服务器强制启用本轮交互确认合同 `workflowFeatures.creativeReview='user-confirmed-v1'`，当前 joint workflow version 从1.6.1更新为1.7.0；客户端省略标记不能绕过。若开工时版本已被其它窗口占用，先核对真实实现而非盲覆盖。字段不是可公开关闭的自动模式开关。
- 旧 run 没有确认记录不能推断为已确认：保留只读；通过现有基于历史新建/返工入口进入新合同，验证后可复用媒体和草稿，但不能伪造历史用户确认。已接受在途任务只观察和保存原结果，不用新合同重新提交，不自动开启后续旧生产。
- 复用确认仅限同 run、同内容/输入/上游身份的合法恢复；跨 run 复用媒体与稿件不等于复用用户确认或现金授权。
- 不在新 source/对话功能中放宽路径、安全 URL、未知字段、授权范围、租约、媒体 SHA、时间轴或双审硬门。
- 新模块保留窄端口与纯验证，方便未来新增角色/交付，但本轮不实现动态节点插件、数字人、多轨、短剧等未来能力。

## G. 实施前必须证明的架构接缝

先做无需外部模型的正式最小组合测试：初案产出→SQLite gate→FileRunStore needs_human→普通 approve 被拒→有效 confirm→脚本产出→再次等待；中间重启、两次相同 confirm 都只推进一次。

该测试证明等待/恢复接口能落地后再铺开三阶段 UI 和完整协议。若安装依赖真实 API 与本设计不同，报告具体签名与失败证据，先在现有接口内调整适配；不得因此换框架或增加第二套生产链。这个聚焦红绿不是另一次外部审计，也不需要暂停等用户。
