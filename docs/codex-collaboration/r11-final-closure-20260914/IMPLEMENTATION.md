# 已定技术修正路线

本轮只做K1–K6，按以下顺序集中实现。不为每个子项暂停外审；每项先保存失败证据。所有修改都须能对应本文件或真实同根因遗漏，不重做整个A/B/C。

## K1：分镜校验与单次有界修正（首先解除主片阻断）

### 责任划分

保留Broker严格输出校验，**不把非法候选包装成成功**。在Broker内给 `director-plan` 增加一次明确的合同修正机会，OpenAI/ZAI同政策；不在Studio、fallback、role-loop各加一套重试。复用现有executor和ZAI format-repair结构，必要时提取一个两实现共用的纯修正策略/提示函数，不另建服务。

1. 一次Broker请求的候选尝试最多2次（原始+一次修正），ZAI原schema修正和新增语义修正共用这一上限，不出现schema两次后再semantic两次。合法首稿只1次。
2. 仅已得到完整、大小合规、可解析候选，且确定是director合同问题时才修正。结构错误、重复/缺失位置、引用关系错误不能当网络故障。网络/timeout/accepted_unknown、权限、上游输入合同拒绝不进入此修正。
3. 修正输入是同次原任务的完整可信上游、上一候选、校验器安全code/fieldPath及修改约束。候选只在原有受控任务内存/临时目录使用，不进公开error、UI、额外外传报告。使用已有prompt/output大小护栏，超限不偷偷截正文。
4. 明确 `scenes[].position` 是权威集合；每个position恰好一个shot，场景内部节拍用temporalBeats，不复制scenePosition当子镜头ID。脚本/时长/真实性/用户要求不许改。无法容纳则报需要回脚本讨论，而不是模型或宿主重新编号、丢镜头、改duration。
5. 第二份输出仍走原完整schema/semantic校验，再由Pipeline完整导演validator/时间轴/授权检查；不能以“修过了”放行。质量审计仍在用户确认时，对当前稿做，不用格式修正代替独审。
6. 修正是草稿候选修订，不是成片事实修改；不能套用“修正前后编号也必须完全相同”导致重复编号永远不可修。必须保护已确认上游，未受问题影响的原候选镜头保留；关联错误牵涉哪些镜头就明确约束哪些字段/关系。修正后仍矛盾则诚实失败，不再自动新任务。

### 生命周期与计数

- 同一次Broker request下执行；原请求已受理后崩溃/断网仍只查原ID，不靠启动新request续一次修正。已有durable不能证明执行终止时保持unknown。不要新增“重启自动重跑已accepted”的路径。
- 保留现有role-loop宿主验证上限；不能把Broker修正再误归网络fallback。两层上限必须说明：单Broker至多2次，既有宿主至多2个结构候选时理论上限4次模型执行，不可伪报2次。不得另加第三层重试；必要时由共享剩余预算进一步收紧，不扩大既有phase上限。
- trace/error安全元数据记录本请求 `modelAttemptCount`、`structuredRepairCount`、各attempt实际模型/耗时和最终原因；由K4消费。失败也保留计数，不能只成功有trace。deadline是整次逻辑请求共用，不每次重置到完整20分钟。
- OpenAI每次尝试使用独立临时子目录，避免第二次mkdir同名失败或读取第一份last-message；原最终清理仍仅清自己的目录。模型、effort和隔离策略不变；若复用session，必须有已证实session身份，否则修正prompt自包含，不误接别的角色。
- 合同说明/提示改变按现有descriptor、promptVersion和adapter合同版本更新；不能只改hash而不跑source/dist正式请求。旧失败request保留，用户明确恢复当前失败节点可开新合法任务，上游不重做。

修改模块：Broker task-definitions、两个executor、必要trace DTO/安全投影；已有tests。不得修改媒体Provider重试政策。

## K2：局部修订基线＋无匹配时的分镜讨论

### A. 不再带着单个问题从头重写全片

新增一个窄的导演输入 `brief.planningRevision`（名称统一采用此名，避免复用成片rework伪身份）：

```ts
{
  previousPlan: VisualDirectorPlan;
  previousPlanDigest: string;
  affectedScenePositions: number[];
  availabilityHistory: /* 现有有界 availabilityBlockerObservations 的模型可读投影 */;
}
```

- 只在当前图已有directorPlan、因planningIssues回退时由宿主生成；不从客户端任意接收。当前issues保留在brief.planningIssues，不复制成三套反馈。
- `affectedScenePositions`来自当前issues及真实reuse/reference依赖闭包；上游脚本/用户全局修改走现有失效规则，不靠模型自己宣称“全部受影响”。历史仅保留同一当前输入下已证实不可得镜头的必要证据，不塞全部原日志。
- previousPlan来自`planningContext.directorPlan.output`，此前可行镜头/visualBible明确保留。相同输入的失败图库路线不能因另镜需调整而暗中复活。不是永久禁用某检索词：有新的真实素材证据、用户明确变更目标，才可以重新评估。
- 同步contracts/normalizer/Broker require与descriptor/prompt、`codex-visual-director.ts`投影、adapter checkpoint identity。完整计划加上该字段后仍在已有输入上限内；不能截掉用户要求换空间。
- 暂保留完整plan输出协议，不新建另一种partial响应。宿主比较未受影响镜头与方案级合同；越界修改不静默采用，也不悄悄覆盖成“模型成功”。交现有有界校验修正，耗尽则保留最后合法草稿让用户讨论。受影响范围内路线变化由导演决定，不强制全生成、不强制图库配额。

### B. 有界停止必须可操作，不能只有报错

- 保留当前无改善/跨角色次数上限。区别：自动调整停止 ≠ 用户不能继续讨论。
- R11交互图中，若存在完整合法directorPlan，但图库availability仍阻断：把该方案发布为当前未确认director草稿，关联结构化issues及证据，进入**现有director_review interrupt**，用户可解释/备选/修改/返回上游/暂停。不要新建独立needs_evidence产品状态机。
- 没有合法方案（例如K1耗尽）不能伪造草稿；保留已确认script与具体错误，可返回脚本讨论/修后恢复。真实来源缺口仍存在，不给confirm通行证。
- `creativeReview`输出与intervention持久化走原同一图/RunStore通道。旧R11已halt且有合法稿的原run，在用户显式恢复时，通过正式域入口把保存的当前稿和issues接到等待点；不直接改SQLite或伪造旧confirmation。旧非R11生产链不恢复自动生产。
- `run-observability.ts`不再按字符串needs_source统一推断“实验”；使用结构化availability与真实性：illustrative提示可讨论生成/复用/检索，evidence提示补真实来源。无结构化旧记录只给中性缺料描述，不猜题材。

### C. 一起关掉相邻的确认缺口

当前`creativeDocumentArtifactUpdate`修改director会失效ranking，而`routeAfterReview`可在confirmed后直接compile。不能仅把halt连到review然后放行。

1. director讨论的revise/adopt/undo实际改动当前方案时，使用既有指纹规则判定需要candidate/rank/evaluate（真实复用引用变化也算），不每句explain重搜。
2. 重用现有候选/排序/evaluate/integrate节点；通过后回director_review，展示最终整合稿。整合若改变内容/SHA，必须再由用户确认这个可见版本。
3. confirm只能对当前SHA且可得性证据仍匹配的稿件做独审/确认；未通过可得性时不触发compile/quote。服务端强制，不能只disabled按钮。
4. 当前证据已经匹配时不重复搜索/整合/独审；检查结果复用严格按原checkIdentity。issues当前有效集合重新计算，原历史留存，不一直携带已修复补料命令。
5. 超过自动调整上限后，用户显式讨论允许修草稿；不会因为打开页面/confirm原稿重置预算并偷偷开始自动三轮回退。新草稿执行必要可得性检查后再次等待，不把用户消息当自动跑到底许可。

最低证明：图库1/2不足→只修1/2→出现4的新缺项→只修4且1/2保持→到分镜讨论→修改路线→新证据匹配→用户确认→报价；真取证同样序列必须停住。全程授权前媒体create=0。

修改模块：creative-planning、production-pipeline、codex-visual-director、共享合同/Broker输入、creative-review、production-studio/run-observability及原工作台；禁止另建平行图。

## K3：热点安全边界恢复为机器结构＋模型语义

- `groundModelIdea`保留合法signal、sourceId/paragraphId、read/partial、结构大小、真实来源绑定与下游采用门；删除用引号/英文词/数字形式/归因动词直接判定整idea造假的硬否决。不通过扩大词库或给AI、28、“机制示意”等写白名单修六例。
- 正文引用存在只证明可追溯，不证明主张成立。现有独审的criteria/currentRoleContract要明确审**所有候选字段**：正文是否支持facts/引语/因果、标题和hook是否把猜测包装事实、画面表达是否冒充现场；创作标签、假设演算、受众描述和不确定披露不要求原文逐字出现。沿用当前候选/正文/独审，一轮而非每篇另起模型。
- 同一文章包含错误/传闻也必须按来源性质表达，不自动标verified；转载数量门/采用权限/事实缺证拦截不变。无支持确定性断言应由独审repair或下游来源合同阻断；不要因为有一份pass就给客户端免检权限。
- 不把 `conservativeHighRiskIdea`的规则改写输出伪装成独审通过后的原创成果。高风险未审的新改写不得直接推荐；保留真实模型建议与缺证状态，或者明确拒绝并说明原因。
- 添加简单生成结果诊断：模型产出数、引用无效/结构无效/重复/用户排除等宿主筛掉数和安全原因。合法空结果与宿主全过滤必须区分，不再说“总编认为无选题”。不建可观测平台；现有generationReceipt/候选状态即可承载。
- 原6ideas回放用于定位，不要求6全通过。新增跨题材语义对照和真实独审失败的正式接缝：错误引用0采用、真实不支持的因果仍不能开拍；同一创作表达有无引号不改变宿主是否接受。

修改模块：trend-opportunity-agent、共享receipt与前端展示、必要topic prompt/descriptor及对应tests；保留正文安全读取代码与缓存。

## K4：请求级归属和时间解释（不做新核账）

在原role checkpoint持久化一组窄执行记录，参照现有discussion-executions语义：requestId、首次所属workflowOperationRequestId、phase、结果事实、provider/queue/validation时间及K1模型attempt数。优先同checkpoint持久化，不新建数据库；版本升级时保留v8/v9读取，不能清历史。

- beforeSubmit记录首次归属；同request恢复查询只更新结果，不把归属改成当前operation。明确新物理request才新归属。completed_failure计已执行，not_accepted不计模型执行，accepted_unknown单列不编成功次数。
- 全局先按requestId去重，再分本次/此前；不能先按checkpoint分组再去重。复制同一checkpoint、不同时刻快照、fallback恢复、discussion记录均不得重复计算。
- 新数据只用实际receipt/trace里的providerWaitMs作为模型耗时；旧phaseDurationsMs保留为“历史执行等待总时长”，不能再叫纯模型时间。queue/模型/本地消费/人工等待分开，重叠不相加，缺值unknown而非0。若尚无逐attempt时长，只报告可证实总数与总耗时，不编分项。
- 旧数据的物理请求有证据可恢复归属则只读派生；无法证明的标“历史归属未确定”，不整块搬到本次或篡改原文件。真实旧主片的精确归属可在报告对照，不按runId硬编码导入。
- Studio阶段、工作台、费用页消费同一现有聚合函数/DTO，名字明确“Broker任务”和“模型执行（含结构修正）”差异，不能让两个页面同名却相差一倍。成本核算本身不扩张。

验收序列：一次失败→新operation明确恢复→仅一次新请求→刷新→重启；本次新任务1、历史失败保留；查询0新模型；K1内部修正有2次模型执行但只有1个Broker任务。

## K5：终态统一读权威详情，避免部分快照抹掉信息

选最小方案：SSE/操作回包继续作为运行状态通知；RunPage在操作结束/进入终态时立即GET完整detail，并刷新相关review/cost；**不是延时强刷页面**。同revision的简略通知不得覆盖已经完整的planningStages/recovery信息；新revision不保留旧确认资格来填空。

- 请求带客户端单调序号及runId校验；旧请求晚到不覆盖新run/新revision。相同revision补全只对明确完整GET结果生效，不能随意深merge互相矛盾的身份字段。
- 从running进入failed/needs_human/completed等终态/等待态时，确保最后一次权威读取完成，不因停止SSE丢补全。读取失败显示可行动读取提示，有界重读，不提交生产请求。
- 如改为服务端统一异步投影，也必须保留发布顺序与新revision保护；不要同时铺两种机制。默认采用上述客户端终态补读，执行前用失败测试验证足够。

修改模块：RunPage、必要共享快照标记/原GET投影及client tests。复验generic retry、creative command、pause/resume、保存配置四条入口，不能只测采用按钮。

## K6：手机讨论正常流布局

最小方案优先取消手机`.creative-review-actions`的悬浮覆盖，让主动作在正常文档流；保留工作台导航、清晰确认动作。若保留sticky，必须按实际动作区高度留安全空间，不写死针对844高的一块padding。

讨论输入/发送与确认/撤销互不遮挡；中文IME、长文、滚动、焦点、未发草稿不受影响。真实浏览器用elementFromPoint或等价hit-test验证按钮中心；仅截图/scrollWidth不足。

## 完成标准与不确定项

每项实施记录最初失败、最小改动、成功证据及回归风险。K5事件竞态要补确定性复演；K1原坏输出不可恢复，不编造；K2原run迁回讨论必须有正式持久化测试，不能现场手改数据库。若这些范围内证明失败，继续修；只有需要改变已确认产品合同才BLOCKED，不把工作量称为阻塞。
