# Revision 9 实现方案：现有主流程收口

本文件与 TASK.md、VALIDATION_REVISION9.md 一起执行。仓库根：`/Users/jinkun.wang/work_space/veidofactory`。下列位置是2026-09-13源码导航；改动前读取函数完整上下文。命名以本文件为准，现有同职责实现可以复用，但不得另选产品语义。

## 0. 总体边界和顺序

仍用现有 joint-v1、LangGraph + SQLite checkpoint、WorkflowRunner + FileRunStore、Broker durable accept/poll。不得加数据库、缓存、队列服务、总监督Agent、新生产路线或新顶层run状态。不得保留新旧两套可继续生产的流程。

一次任务三个工作组，连续实现，不中途请求审计：

1. **W1 要求优先级与模板适配** → 修输入/合同，而不是调一个题目的措辞。
2. **W2 制作前提与实际质量边界** → 复用现有构思和独立审计，不增加模型调用层。
3. **W3 故障闭环与真实展示** → 模型切换、完成失败消费、重启进度、统计、查询竞态一起修。

每组允许聚焦红绿测试；全部完成后统一回归、生产构建、真实本地QA。未授权付费时仍可完成前面的代码和无外部调用验证。QA同轮只记录，随后集中修复范围内问题并重建回归；不要一个小修就重新部署。

## 1. 统一产品合同（全部代码和prompt服从）

### 1.1 优先级

不是把所有来源简单排一条“后者覆盖前者”的字符串链，而是两类：

- **必须同时满足的约束**：事实真实性、版权与授权、真实执行能力；用户/系列明确的核心承诺和限制；确认过的方案、时长范围、媒体付费范围。它们冲突时不能任选一个覆盖另一个，须具体needs_source/needs_user。
- **可适配建议**：模板默认镜数/段长/素材配比/具体槽位实现，自动视觉计划、参考视频语法。保留叙事目的与合理质量目标，在硬约束内调整；不可擅自把知识解释换成无内容空镜。

创作方法的自动调整限于用户已允许的素材池和制作方式；不等于用户已批准新购买。报价、scope/plan digest、追加授权、审片与局部返工边界保持。

### 1.2 共同禁止项

不删用户句子来消除冲突；不把否定句按肯定词匹配；不把每个建议变成用户锁定；不声称任意AI模型能精确保证跨镜身份。不可用图库/未授权生成补伪事实，不用内部说明卡兜底，不降低分数阈值或模型强度。没有足够证据的供应商失败不自动解锁新请求。

## 2. W1：输入与模板适配

### 2.1 需要修改的模块

- Studio：`src/client/components/NewRunDialog.tsx`，`src/shared/visual-plan.ts`、`visual-source-compatibility.ts`、`api.ts`，`src/server/production-studio.ts`及正式输入parser。
- Pipeline：`contracts.ts`、三个角色适配器、`production-pipeline.ts`中的阶段输入身份；必要时新增一个窄的纯函数模块 `planning-guidance.ts`，只负责现有输入投影，不保存数据、不执行模型。
- Broker：`task-definitions.ts`内相关输入白名单、Schema/descriptor、directive/outputRules；对应digest pin。
- Template core 仅在既有snapshot来源字段无法保真时作必要类型/投影修正；不要重写模板CRUD、重做六个内置模板或迁移历史模板。

### 2.2 不再伪造用户未写过的镜头约束

新增可选 `visualIntent?: string`（trim，非空时最多1000字符）到正式 StudioProductionInput/ProductionBrief，以及 treatment/script/director 的brief输入投影。它存“你希望怎么呈现”的用户原文。超限显式错误，不截断。原有visualProof继续存必须看到/不能伪造的要求。

NewRunDialog提交：

1. 现有strategy文本框写入visualIntent。
2. 有上游真实给出的visualPlan时可以保留作**建议**，但不得用它覆盖visualIntent/visualProof。
3. 没有上游visualPlan时，**不要为了填字段而在提交时调用planVisualDirection(title,angle)制造beats**。visualPlan原本就是可选，省略即可，交现有构思角色生成真正相关的方向。
4. 不调用resolveExecutableVisualPlan静默删用户策略或把creator/screen要求改成stock。现有能力摘要如实传递；无法取得专属素材由W2处理。
5. planVisualDirection仍可在展示层提供明确标注的建议。若有正式调用方仍会把其结果当已接受要求，一并修到这条边界；不要仅修NewRunDialog而让热点/系列/返工重新注入。
6. 打回草稿中，旧visualPlan.strategy可以预填到可编辑visualIntent供用户确认；历史run只读不批量改写。旧beats作为历史建议，不推断它们曾被用户逐镜锁定。已确认可执行方案中的真实镜头约束仍受版本/授权保护。

没有新增“某题材/某关键词优先”的分类器。不要尝试完善argumentFormFor来解决所有自然语言，它不能承担硬语义路由。

### 2.3 模板投影：默认方法不等于硬能力要求

复用snapshot的 `storyStructure`、`qualityRules`、`fieldSources`、`sourceLayers`。为规划角色生成统一的 `templateGuidance` 投影，并让producer和audit共用；不要把原始模板硬合同和新建议各塞一份。

投影的固定语义：

- `storyStructure`的required职责及观看逻辑保留；一个职责可由一个或多个镜头承担，相关职责可在同镜连续兑现。**不要求每个shotSlot对应一个scene**。脚本现有3–24场等真正技术边界不变。
- 原默认shotSlots以 `suggestedShots` 提供，保留id/beatId/purpose，`durationSeconds`标为建议时长、`allowedCapabilities`在该投影重命名为`suggestedCapabilities`。这不改变Provider目录实际能力。
- 模板默认的素材配比不得构成提前拒绝；用户/系列明确限制和当前真实能力仍是独立hard constraints。不要简单把所有slot.allowedCapabilities改成全能力列表，避免伪造事实。
- 明确run/series层人工覆盖的约束不因模板自适应被忽略。用现有fieldSources识别来源；若不能确定来源，保留并让用户确认实质改变，不能假定全部可丢弃。
- 不自动改模板选项/名称/质量规则；本次只改变默认方法的解释和输入投影。

`visualSourceCompatibilityIssue`目前逐slot硬匹配。修改其调用合同：模板默认不匹配变为可理解的建议，不禁用制作；素材池完全没有画面能力、真正执行要求不支持仍阻断。服务端与前端同义，直接API不能绕过真能力校验。

通用事实规则仍覆盖真实性：选择“热点事实解读”不代表允许AI伪新闻；选择“实证演示”不代表有实验材料。模板适配不能通过删质量目标或重写用户承诺完成。

固定投影形状（只存在于角色输入，不新增一套模板存储）：

```ts
type GuidanceBinding = 'suggested' | 'explicit' | 'unverified';
interface TemplateGuidance {
  automationLevel: ProductionBlueprint['automationLevel'];
  storyStructure: ProductionBlueprint['storyStructure'];
  suggestedShots: Array<{
    id: string; beatId: string; purpose: string;
    suggestedDurationSeconds: number;
    suggestedCapabilities: string[];
  }>;
  shotBinding: GuidanceBinding;
  capabilityGuidance: ProductionBlueprint['capabilityRequirements'];
  capabilityBinding: GuidanceBinding;
  visualSystem: ProductionBlueprint['visualSystem'];
  soundSystem: ProductionBlueprint['soundSystem'];
  qualityRules: ProductionBlueprint['qualityRules'];
}
```

`shotBinding`与`capabilityBinding`分别由snapshot中对应字段来源计算：template/system默认为suggested；可证明的series/run/node明确覆盖为explicit；来源缺失、不一致或不能证明为unverified。平台真正的输出限制仍由既有平台合同保护，不在本投影里降为建议。explicit不要求机械的一槽一镜，但其中明确的素材限制/职责不得擅改；unverified仅在拟改变该约束时要求确认，不使所有旧记录一律不能查看。来源数组只用于宿主投影，不将全部snapshot重复发给模型。

字段验证复用现有蓝图的枚举、字符串、数组、时长与引用规则，不另造一套更窄长度限制；三个binding枚举外的值拒绝。生产内部仍保存原templateSnapshot，用它生成投影；不新增让HTTP调用者自报`shotBinding='suggested'`的权限。正式角色模型输入及审计上下文只接收此投影，不再同时传`templateBlueprint.shotSlots`旧硬规则。角色适配器所有初始/修订/结构纠正入口同样处理，不能只清理首次prompt。

### 2.4 必须同步的传递路径

visualIntent和templateGuidance进入：HTTP解析 → ProductionBrief → 有效brief合并 → treatment/script/director producer → 各自audit上下文 → 阶段输入digest/合同identity → 返工草稿。

审计未收到新字段、Broker归一化丢字段、模板原数组从另一个上下文重新变成硬限制，均算未完成。生成/审计共享同一纯投影；Broker保留独立严格校验，不import未打包的Studio代码。

## 3. W2：构思质量与开工前提分开

### 3.1 不再仅靠一段“有缺口请停止”的提示

复用CreativeTreatment.evidenceRequirements，增加以下必填结构化信息（当前新合同）：

```ts
critical: boolean;
acquisition: 'supplied' | 'pipeline_retrievable' | 'external_required' | 'not_needed';
retrievalProviderId: string | null;
```

原beatId/claim/requirement/suppliedSourceIds保留；不得把它们移到自由文本或删除来源引用校验。

定义：

- `critical`：该项缺失是否使核心承诺不能兑现，而不只是锦上添花。
- `supplied`：所需来源已经由当前输入的可信来源集合提供；sourceId存在不代表内容支持所有claim，仍由独立审计核对。
- `pipeline_retrievable`：当前已接线素材搜索能取得的通用示意素材。本轮仅适用于illustration_only，必须给retrievalProviderId；宿主核对它属于当前允许、就绪的assetProviders且支持stock_video。当前ProductionCapabilities没有事实检索、实验采集能力，因此不能用该值证明factual_support，也不把生成模型当证据检索。未来新增检索不是本轮任务。
- `external_required`：需要用户实验、专属拍摄、授权文件等当前流水线不能取得的输入。不能写“以后再说”放行。
- `not_needed`：纯机制/情绪示意，不承担现实事实举证；不能与factual_support组合。画面制作本身仍须有已支持路线。

除pipeline_retrievable外，retrievalProviderId必须为null。未知Provider或不具备搜索能力由宿主给needs_source，不让结构修复随机改写成现成证据。非空Provider id使用现有Provider ID格式校验。supplied必须有真实绑定来源才能判ready；空数组本身可解析，由hostReadiness指出缺口，不通过结构纠正逼模型编造sourceId。external_required若已有部分来源仍表示依赖尚未满足，不能因为数组非空就解除核心阻断，须在输入更新后的新构思中核验并改为supplied。

每个核心事实依赖必须覆盖；同一项可以关联一个已有beat，不把每句修辞变成来源任务。诚实缺来源是**合法候选内容**，不能用parser throw触发结构修复逼模型编造。parser只查结构、引用、枚举和逻辑关系。

### 3.2 宿主前提结论独立于模型分数

新增窄的 `assessTreatmentReadiness(treatment, suppliedSources, capabilities)` 纯函数。返回 `{ status: 'ready' | 'needs_source', issues: [...] }`，issues能映射现有PlanningIssue，保存涉及beatId、sourceId、原因、所需补充。它不调用模型，不猜题材，不改候选，不评价审美。

固定规则：

| 条件 | 宿主行为 |
| --- | --- |
| critical + external_required（含仅有部分来源） | needs_source |
| critical + supplied，但所需来源缺失/绑定不可证明 | needs_source；非法引用仍按合同拒绝 |
| illustration_only + pipeline_retrievable且声明的Provider支持当前图库路线 | 可继续规划；后续仍需检查实际取得结果，不提前视作证据通过 |
| pipeline_retrievable但没有对应现有检索/取得能力 | critical时needs_source；非核心项标未满足并不得使用该未取得素材兑现；不新建检索服务 |
| illustration_only + not_needed，画面能力相容 | 不因sourceIds=[]阻断 |
| 仅非核心补充来源缺失 | 提醒；未补齐前不得用于事实断言，独立审计核对其确非核心 |

获取方式是模型对完整用户输入的语义解释，因此仍可能错；独立审计必须核对分类、critical以及是否漏列核心依赖。**不要宣称加了枚举就保证模型判断正确。**实际Codex/GLM成对正负语义验证见验收文件。

### 3.3 接到现有循环，保证第一次审计后就停

在runRoleAgentLoop添加可选、仅规划角色可用的宿主前提检查入口（可命名assessPlanningReadiness）。计算当前candidate的宿主前提结论，传给本次audit.context；首次审计完成后，**在决定pass返回或再次produce之前**消费宿主前提和审计处置。

- 继续条件：结构有效、宿主readiness ready、独立audit通过。高分不能覆盖needs_source。
- 宿主needs_source优先停止无效继续，即使模型给96/pass或要求先修文风。保存原候选、原始模型audit、独立hostReadiness；不篡改模型verdict/score/issue列表制造“模型已正确识别”。
- 审计发现漏掉的核心前提或需要改变用户承诺，沿用planningDisposition needs_source/needs_user。
- 两者都无外部阻断而audit repair/revise_here，才继续现有有界质量修订。
- 如模型误列了external_required，不能悄悄改为ready；记录冲突/让用户调整，配对真实语义评估必须暴露误拦。不能靠默认false绕过这条检查。
- 将hostReadiness保存到同一role checkpoint并传到PlanningHalt/Studio。扩展现有RoleAgentPlanningHaltError以承载host来源的issues，不能伪造audit issueIndexes引用。
- 恢复同输入时重放halt，produce/audit/media新增均为0；输入真实改变才按现有阶段依赖闭包恢复。readiness字段不可成为客户端绕过权限的参数。

不新增“预审节点”、不增加模型调用、不撤销独立审计；不改变现有顶层状态。质量评分仍用当前阈值，页面分别展示“创作评估”和“继续制作所缺条件”。

### 3.4 同步合同与版本，不再出现第九轮白名单400

CreativeTreatment的TypeScript类型、parser、Broker输出Schema/语义validator、treatment输入嵌套于编剧/导演的白名单、checkpoint序列化/恢复、阶段输入identity全部同步。更新受影响prompt/role合同版本、descriptor和REQUIRED_CODEX_TASK_CONTRACT_DIGESTS，测试从正式适配器捕获。

当前新产物不得缺省critical/acquisition/retrievalProviderId并自动当ready。新构思产物使用`video-factory/creative-treatment-v2`，受影响角色合同及digest一起更新，不能仅换产物version而不更新嵌套Schema。历史v1产物只读可显示；不能改写历史JSON补值或伪称新合同已通过。旧pending仍按其原始binding观察结清，旧结果若未满足当前合同则保留为历史候选，按现有升级机制复核后再继续生产。不要扩展为历史迁移工程或第二套旧生产流程。

### 3.5 导演时序硬校验改回真正技术含义

`validateTemporalBeats`：所有交付允许1–10段；每段start/end合法且end>start，起点0、无重叠/空洞，最后结束覆盖scene实际时长。采用项目现有帧量化/数值容差约定（30fps）；不得用1秒级容差掩盖尾段缺失。

单一持续状态和多段动作都合法；动作是否有观看价值、是否兑现承诺由审计看内容。不可为了通过拆成两个完全相同描述。

保持源区间覆盖、媒体类型、非零静态起点拒绝、母片长度、跨镜引用、生成不能冒充实证、字幕安全等已有校验。审计建议中的复用路线也应经过正式validator的隔离回归；不能只改producer提示。

把原测试 `requires motion deliveries to describe at least two timed states` 改为新产品语义的正反测试，并在RESULT说明用户本轮决定改变了哪个旧合同，不能偷偷删测试。

## 4. W3：工程闭环（五项都必须完成）

### 4.1 阶段换模型与重试

触点：PlanningStagesPanel、NodeWorkspace、RunPage、ProductionStudio.applyNodeExecutionConfiguration、pipeline阶段失效/路由。

1. 下拉变化只代表草稿。增加现有样式的明确“保存模型”动作；不要选择即默默执行重规划。
2. 结束态显示“将从这一阶段重新规划，保留未受影响阶段”；用户点击保存是这次编辑确认，发送confirmTerminalEdit=true及点击时最新expectedRunRevision。不能全局默认true绕过其他调用权限。
3. 外层保存失败必须继续reject，子面板显示未保存/错误；成功前当前生效模型不改。冲突刷新当前run，保留草稿但不能自动写入，用户再确认。
4. 存在未保存变更或保存失败时，不允许“重试”被理解为采用草稿。可阻止重试并指向保存，或显式取消草稿后使用已保存模型；本轮采用前者，减少误解。
5. 保存成功后，依据服务端真实状态显示“继续重新规划”或已有合法恢复动作，不能固定调用只接受failed的retry API而把stale/editing状态卡住。
6. 改导演模型仅失效director及后续，treatment/script不重跑。pending/accepted_unknown未结清时仍不能换原物理任务的路由；界面显示具体原因，不能通过清空checkpoint实现换模型。
7. 组件、HTTP、正式pipeline路由计数都验证。仅成功返回200或显示GLM名字不够，下一次真实调用要来自选中的实际模型。

### 4.2 无输出Provider失败必须到达run终态

已知症状见REVIEW，run长期running的完整原因尚未证实。执行者不得选择任意猜测改超时或库配置。按下面固定顺序定位：

1. 在现有 `apps/studio/test/text-task-production-recovery.test.ts` 组合夹具增加场景：构思真正通过；编剧**第一次produce、没有candidateTrace/候选**；真实socket Broker executor在barrier释放后抛带timeout/details的CodexExecutorError。使用几十毫秒的隔离测试时钟/事件，不等真实20分钟。
2. 断言Broker completed_failure已经落盘；同一execution completion Promise必须settle；role checkpoint failed；图异常传出；NodeRun失败产物/receipt持久化；run变failed；lease释放；页面动作可用。可在测试边界记录步骤，不向用户日志输出完整prompt。
3. 比较有lastTrace/无lastTrace、produce失败/audit失败、即时失败/受理后失败。逐边界定位**第一处未settle或失败事实丢失的位置**。若仍不能重现历史stuck，保持历史结论未定位，不把相邻修复当成已经消除；用最小正式组合继续隔离，不加全局watchdog。
4. 已明确需修的诊断链：executeLoopPhase把CodexBridgeError包装后，不应让failedLoopError丢stage、failureKind、details、request身份。用受限类型化cause提取，不遍历任意用户对象泄露数据。checkpoint需保存终态失败的安全摘要；重启不依赖内存Error对象。
5. generic failure、持久化失败与Provider失败分开：写盘失败不能伪称已保存；但必须有可观察错误/恢复状态，不能只吞掉completion rejection。不得接管仍活跃的owner，不放宽lease/CAS。

当前模型超时配置保持，不降模型/effort/输出上限。对真实慢调用只能根据已有事件区分排队、进程启动、首输出、生成、结构修复、查询等待；无细分事件就标未知。禁止“把max tokens再砍小”和无限延长超时。

### 4.3 重启进度投影与原始错误

触点：inspectCreativePlanningStages、jointPlanningInputDigest/有效brief规范化、planning-history、role checkpoint、recoverInterruptedRuns。

1. 先复现“构思已通过、编剧失败”的正式快照重启后应保留完成状态；从现有pipeline生产checkpoint，不手写全部成功状态当证据。
2. 按顺序检查：有效inputState是否保存/stale → 执行和检视brief是否一致 → 输入digest/thread是否一致 → 图checkpoint是否含treatmentArtifact → role checkpoint所属operation是否一致。
3. 不以 `mtime最新`、只有role名、所有checkpoint扫描取第一个passed 修进度。用runId + workflowOperationRequestId + input/stage identity绑定；无法证明属于当前版本时显示历史已完成/待重新核对，不能当当前完成继续生产。
4. 仅字段顺序变化不能让同一输入丢失进度；运行期统计不能改变创作输入身份。若修改digest算法，必须版本化定位并保留旧task结清，禁止扫描拼接不同thread成果。
5. 已确认Provider终态失败优先展示它的安全原因；重启是发生的事件，不应覆盖它。没有可证明终态的中断仍保留unknown/原任务查询，不臆称未受理。
6. 真正改变用户输入时，旧成果标stale并按依赖闭包失效；不能为了显示绿灯把所有历史成果都恢复到当前版本。

### 4.4 调用与耗时：整节点聚合，不是最后一名角色

复用现有AgentLoopTrace、checkpoint phaseAttempts/unacceptedPhaseAttempts/phaseDurationsMs、Brokertrace及planning-history。允许增加一份**有明确身份的紧凑节点汇总**到现有receipt；不新建日志平台或账本。

定义：

- 已证实模型执行总数 = 有执行证据的produce + audit；结构修复是其中子集，不再次加到总数。提交次数、受理次数不自动等于实际执行数；accepted_unknown无执行证据时另列“执行情况待确认”，确证未受理不计模型执行，不能把未知强记0次或1次。
- Provider自动重试、用户明确重试、结构修复是不同概念，单列；查询/刷新/等待=0次模型执行。
- 当前执行、此前重试累计、跨run继承分别标识。复用上游产物本次增量0，但可查看来源历史；不能把来源历史又算本次费用。
- 以当前operation所属的checkpoint key/物理requestId去重。不能将每次更新的累计快照相加；同一角色在图回退中可能有多个真实执行key，不能只取最后一个。
- 节点总时长与阶段耗时口径一致。phaseDurations可能包含等待/轮询，Broker providerWait只是一部分，不可互相相加双算。
- 没有完整queue/provider细分时，剩余称“未细分等待/处理”，不要全部称本地计算。缺值是unknown，不是0。
- 成功、模型失败、质量halt、结构失败和重启都生成一致的汇总；不仅补成功分支。

红灯样本：R8 adjusted current operation有4+5+5=14次、结构修复3次，receipt仅5。建立去身份化等价fixture覆盖这三个角色，不硬编码14为产品逻辑。另测第三角色首次produce无trace失败，不能漏掉已经消耗的调用。

### 4.5 查询完成竞态

queryOriginalTextTask本质是观察，不拥有推进/支付权限。

- 请求进入时已无pending，若当前同一任务已完成/推进，返回最新run详情，模型增量0。
- 网络观察期间同一operation正常完成，不把良性竞态显示为“操作冲突”；返回最新状态，不将旧receipt附到新阶段。
- 用户编辑改变输入身份、run/请求绑定错配仍拒绝旧结果关联。区分“正常前进”与“方案改变”，不能吞掉全部409。
- 查询与显式retrieve_and_continue的权限仍分开，暂停不自动解除。

## 5. 提示词的精确修订范围

不要把本文件整份放进模型prompt；只替换对应的旧矛盾条款，保持公共前言一次。

### 5.1 三规划角色共同新增/替换规则

```text
用户明确的观众承诺、visualProof、visualIntent及系列已确认限制是创作边界；实际Provider/编辑能力与事实、授权边界必须同时满足。它们冲突时指出需补充的条件或用户决定，不自行覆盖。
templateGuidance、默认镜头建议和referenceGrammar是服务目标的方法参考。保留叙事职责和质量目标，可调整默认镜数、段长和素材实现；不把建议素材配比解释为用户禁止其他已允许路线。
不因题材名、否定句或类比词语判定必须实测。看完整承诺和实际画面用途：事实举证、机制示意、情绪表达分别处理。
在用户允许范围内主动选择可执行且质量优先的制作方法，再优化复用和成本；需要改变用户承诺或实质修改已确认方案时交用户确认。选择Provider只形成规划和报价，不代表已获购买授权。
```

### 5.2 构思与构思审计

替换“风险如实列出即可/不得要求前期已拿素材”的笼统规则：

```text
当前不要求提前下载普通素材或生成付费画面，但必须明确每个核心兑现依赖由谁、经哪条现有路线取得。当前流水线不能取得的用户专属实验或拍摄，不得以“后续取得”作为可以继续编剧的理由。
对evidenceRequirements完整标注critical、acquisition和retrievalProviderId；缺材料本身不是结构错误，诚实保留缺口。不把来源线索、风格参考或文字说明当作已取得的实验材料。当前只有通用素材搜索能声明pipeline_retrievable，它不能作为真实实验或事实检索的替身。
独立审计既看作品方向，又核对是否漏列核心依赖、获取责任是否可信。hostReadiness是宿主核对实际输入所得，不是生产者自评。高创作评分不能豁免已知外部前提。
```

### 5.3 编剧/导演及其审计

删除逐slot固定对应scene和模板默认stock-only的绝对要求；改为落实required叙事职责、时长范围、真实来源边界。保留现有前两秒吸引/前六秒部分兑现的创作指导，不在本轮另设硬秒数算法或改审美标准。
导演条款明确：“视频也允许一个连续状态节拍；节拍按真实观看内容划分。硬校验检查时间完整性与可执行关系，不用凑两段来证明质量。”
审计修复建议不得越过当前执行能力；保留不受影响段落。普通风格偏好advisory，事实造假、核心兑现缺失和明确不可执行blocking。

### 5.4 其它角色

热点/系列仅修新输入传递或同一优先级冲突；不重写选题系统。选片师继续诚实no-match；双视觉审片保持独立模型、同证据SHA、报告质量与作品质量分开。发布角色、TTS、媒体执行器不主动改；集成发现范围内阻断时按证据最小修复，涉及新产品能力则报告。

## 6. 不能留给执行者自行发挥的选择

- 不换工作流框架，不拆大文件作为独立目标，不安装/升级工具解业务问题。
- 不用关键词增加主题/镜头/runId白名单，不把真实失败用fake broker包装成成功。
- 不通过减少标准或增加质量循环次数让样本碰运气过关。
- 不把host强制停止的原始audit改写为repair；同时保留模型意见和宿主决定。
- 不把术语“兼容”当理由让缺字段旧产物自动具有新合同资格。
- 新发现先记录已证实事实，完成当轮可测范围后集中修。通过验收前，不以全量绿灯宣布成片已完成。
