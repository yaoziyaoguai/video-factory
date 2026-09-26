# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6ab3afd2-1284-83ea-9f1f-84a2f1b3e629

## Prompt

请完整读取附件 ORACLE_REQUEST.md 并按其中格式审计 VideoFactory 全站用户可见文案。COPY_INVENTORY.md 是全客户端机械清单；DYNAMIC_CONTEXT.md 为业务约束；源码附件用于核对动态字段。只输出审计与可执行资料包，不修改文件。

## Answer

coverage
审计结论与证据范围

需要修正文案及其显示投影，优先处理费用判断、失败恢复、人工确认和原文保真问题。 当前材料不足以证明存在扣费或权限绕过，也不能据此对整站运行安全作出放行结论。

已完整审阅任务要求、业务约束和机械清单，并核对两份完整源码。按清单中的源码路径去重，共涉及 46 个文件、3,176 条抽取记录；这是清单覆盖量，不是实际可见文案数量。任务明确要求区分条件分支、不可见配置词与重复文本，因此下文不把不同分支写成“当前同屏冲突”。
ORACLE_REQUEST
COPY_INVENTORY

另外，对附件中提取的纯函数执行了 17 组隔离输入验证，复现了原文被改写、错误提示变为空、停止状态仍显示生成中、未知来源被认作模型提案等输出。这些是函数级验证，不是 React 页面、读屏或服务端端到端验证。

以下定位均相对 apps/studio/src/client/；例如 components/CostDashboard.tsx:30 是源码行号，引用标记中的行号属于附件。

evidence_status 的含义：

CONFIRMED：源码或清单中的问题已能确认；不等于已经在真实页面看到该分支。
NEEDS_CONTRACT_CHECK：定位和核对目标明确，但替换前必须核对调用条件、字段含义或服务端动作，不能直接据清单推定业务行为。
按页面与状态覆盖
页面／状态	已审阅文件	审计重点及运行时核对项
登录、站点框架、首页	components/AuthGate.tsx、components/AppShell.tsx、pages/HomePage.tsx	登录失败、服务连接状态、首页行动入口、桌面与移动导航。核对首页卡片是否区分“等待授权”和“已经消费”。
选题与来源核验	pages/TodayPage.tsx、components/TopicEntryWorkspace.tsx、HotTopicBoard.tsx、DirectorPanel.tsx、OpportunityFocus.tsx、OpportunityRail.tsx、OpportunityDialog.tsx、CandidateVerificationDialog.tsx、SourceSupplementDialog.tsx	正常候选、规则保底、来源不足、人工核验、缓存更新失败、无候选。核对“来源提醒”与真实人工核验要求，不把两者一起删掉。
系列策划	components/SeriesDialog.tsx、components/SeriesEpisodeDialog.tsx；同时覆盖 TopicEntryWorkspace.tsx 系列分支	新建、人工修订、等待前集、关联历史成片、已定版与已发布。核对“系列已确认内容”是否被误写成外部事实已经验证。
案例与脚本参考	pages/CasesPage.tsx	来源读取失败、正文缺失、参考内容与成片素材的区分、移动端详情引导。
新建与返工准备	components/NewRunDialog.tsx	配置失效、预算意向、画面策略、声音计费、审片不可用、重新制作、放弃填写。重点核对不同计费分支。
规划、讨论与导演方案	components/CreativeDiscussionPanel.tsx、PlanningStagesPanel.tsx、DirectorPlanPanel.tsx	草稿未保存、保存失败、版本变化、复核未完成、质量风险接受、保存模型是否立即执行。
节点输入、产物及编辑	components/NodeWorkspace.tsx、NodeDeliveryPreview.tsx、NodeStructuredEditor.tsx	未知字段、字段语境、枚举、单位、文件引用、候选截断、只读结果、版本失效、费用确认。NodeDeliveryPreview.tsx 已核对完整实现。
配音与声音审片	components/VoiceStudio.tsx、AudioReviewPanel.tsx	本地／云端配音、相对语速、未审听、报告不可验证。保留“视觉意见不能证明声音质量”的区分。
制作列表与详情	pages/ProductionPage.tsx、pages/RunPage.tsx、components/ProductionQueue.tsx、ProductionStrip.tsx、RunWorkbench.tsx、StatusBadge.tsx	运行、暂停、等待决定、失败、原任务恢复、费用未知、历史只读、归档与永久删除。重点检查状态摘要、按钮和恢复说明是否一致。
费用	components/CostDashboard.tsx；同时覆盖新建、节点、恢复面板中的费用文案	预计费用、单次授权上限、历史累计授权、已记录费用、服务商账单确认、未知扣费。
素材、授权与设置	pages/AssetsPage.tsx、pages/ResourcesPage.tsx、components/StockAttribution.tsx、UnsplashAttribution.tsx、ModelLibrary.tsx	复用范围、授权待确认、统计缺口、来源身份、模型接入与实际执行身份、配置未实测、无障碍名称。
模板	pages/TemplatesPage.tsx、templates/TemplateGallery.tsx	草稿、正式版本、删除／隐藏、历史记录，以及“当前不参与制作”与操作说明的一致性。清单末尾的模板组件也已纳入。
COPY_INVENTORY

发布	components/MultiPlatformPublishDialog.tsx；同时覆盖 RunWorkbench.tsx、ResourcesPage.tsx 发布分支	导出发布包、提交平台审核、发送失败、混合平台结果。核对“处理完成”是否被读成“已经公开发布”。
制作复盘	pages/ExperimentsPage.tsx	统计读取失败、无样本、终审结果、制作故障与传播效果区分。当前“未接入平台数据，不推断爆款”的说明应保留。
新手向导	onboarding/GuideDock.tsx、creator-tour-steps.ts、use-creator-tour.ts	向导中的旧流程、过时按钮名、固定步骤数、只提醒终审而忽略其他人工停点。
共用动态入口	api.ts、presentation.ts、scene-narration.ts	动态错误、文本清洗、节点／来源／模型标签、创作轮次、脚本读取错误。presentation.ts 已核对完整实现。
静态清单盲点与必须运行时核对的情形

清单不能证明各句的显示条件、控件是否禁用、实际读屏名称、动态插值内容或服务端返回含义。尤其是 api.ts、RunWorkbench.tsx 和服务端 normalizeFailure()，当前只有清单或定位摘要，没有完整实现；不能据此确认恢复动作的真实副作用。
DYNAMIC_CONTEXT

NodeDeliveryPreview.tsx 还依赖未附带的 creator-document-policy.js。因此，未知键回退、字段截断等问题可以确认其实现，但具体字段能否经过展示白名单进入页面，必须在仓库中补查，不能为了显示更多内容扩大白名单。
NodeDeliveryPreview
NodeDeliveryPreview

必须使用本地假数据覆盖：不同计费模式、请求受理状态未知、历史只读、模型目录缺项、纯诊断错误、无复核报告、不同轮次上限、缺失单位、候选超过六个、单项字段超过五个、授权统计不完整，以及桌面／移动端／读屏名称。

findings
高风险：费用、授权与操作后果
COPY-01｜新建制作中的费用说明没有稳定绑定实际服务与计费方式

id / priority / surface+state / evidence_status
COPY-01 / P1 / 新建制作：选择配音、画面方案和视觉审片 / NEEDS_CONTRACT_CHECK

file:line
components/NewRunDialog.tsx:289,1179-1180,1323,1331-1332。清单同时存在“配音报价确认后执行”和“配音自动记账、不弹报价”，另有固定 DeepSeek、固定订阅计费及“画面方案本身不收费”的说明。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“配音：按实际方案报价，确认后才执行”；“配音自动计入已记录费用，不弹现金报价”；“画面方案本身不收费”；“视觉审片 · DeepSeek”；“视觉审片使用订阅额度”。

why_confusing_or_false
不能认定这些句子同屏出现，但必须核对它们是否由同一份实际选择和计费事实驱动。“不弹报价”不等于“不收费”；画面规划不购买图片，也不代表规划所用模型没有费用。

proposed_copy_exact
按已确认的计费合同选择对应文本，不以模型名字猜计费：

输入条件	输出
配音为已确认的自动按量执行模式	“配音按量计费，执行时自动调用并记账，不另弹报价确认。”
配音确实需要单独报价授权	“配音将在报价后等待你确认，确认前不执行。”
已确认本地配音无外部调用费	“本地配音不产生外部服务调用费。”
计费模式缺失	“配音计费方式尚未确认，请先检查所选服务。”
画面规划步骤	“此处生成画面方案，不购买图片或视频；规划模型的费用按所选接入规则计算。”
视觉审片已选模型	“视觉审片 · {所选模型显示名}”
视觉审片计费模式未知	“审片计费方式尚未确认；不弹报价不代表免费。”

visible_when
对应选择、继承、失效配置及费用摘要分支。若尚未执行，只能写“所选模型”，不能写“实际使用模型”。

regression_test
分别构造本地、按量、订阅、未知计费模式；切换模型后标题和费用说明同步变化。断言自动按量配音分支不出现“确认报价后才执行”，未知计费不出现“免费”。

COPY-02｜费用汇总缺少显性的金额性质，历史授权容易被当作当前额度

id / priority / surface+state / evidence_status
COPY-02 / P1 / 费用记录：汇总卡和账单明细 / CONFIRMED

file:line
components/CostDashboard.tsx:30,62-64,103-105。关键限定主要存在于 title，同时正文使用“只有外部任务结果不明确时才需确认是否扣费”。
COPY_INVENTORY

original
“报价授权金额（非消费）”；“已记录费用”；“只有外部任务结果不明确时才需确认是否扣费”。

why_confusing_or_false
历史累计授权不是当前可用额度，也不是单次授权上限。已记录费用中包含按配置费率登记、尚未由服务商账单确认的金额。仅靠悬浮提示，不足以让触屏用户理解这些区别。

proposed_copy_exact
金额不变，仅调整标题和常驻说明：

“历史累计报价授权额”
“累计授权记录，不代表实际消费，也不是当前可用额度。”
“已记录费用”
“包含服务商回传金额和按配置费率登记的金额，部分金额尚未由账单确认。”
“报价和授权不等于实际消费。结果不明确的调用需要核对是否扣费；按配置费率登记的金额仍需与服务商账单核对。”

visible_when
对应汇总卡显示时；来源说明保留在每笔记录中，不能只放进 tooltip。

regression_test
同一制作同时包含服务商回传、配置估算、人工登记及未知扣费记录；断言金额计算不变，金额性质在普通文本及可访问描述中均可读取，历史累计授权不标成“剩余额度”。

COPY-03｜“逐笔确认”与“授权范围内有限修复”表达的授权粒度不一致

id / priority / surface+state / evidence_status
COPY-03 / P1 / 付费画面：报价与最终授权确认 / NEEDS_CONTRACT_CHECK

file:line
components/NewRunDialog.tsx:96,1179；components/NodeWorkspace.tsx:578,635,645,1015。一处承诺每次调用前确认，另一处明确有限修复共用本次授权。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“每次调用前都会给出报价并等你确认”；“每次生成付费图片或视频前逐笔人工确认”；“范围内的有限修复共用此额度”；“试片会直接用于成片，只计费一次”；“确认并执行”。

why_confusing_or_false
用户可能理解成“一次授权只执行一次调用”，实际却可能授权一个包含有限修复的范围。试片能否最终入片也不应作无条件保证。

proposed_copy_exact
核对现有授权合同后，若确实是范围授权：

“付费生成按本次报价范围授权。范围内已列明的有限修复共用本次额度；超出范围、金额或重试上限时，需要重新确认。”

确认按钮：

“授权本次最高 ¥{最高授权额} 并执行”

试片说明：

“先生成试片并检查，再决定后续制作。试片通过适用性检查后可用于成片；是否继续、是否需要修复及对应费用，以本次报价和授权范围为准。”

不得仅因改文案取消现有逐项确认。

visible_when
仅在有效、可授权的当前报价中显示金额按钮；历史报价、失效报价不能使用可执行措辞。

regression_test
覆盖授权范围内修复、超额、超重试次数、报价变化、模型变化、历史报价。文案与原有授权对象一致，按钮不能改变授权粒度或新增默认同意。

COPY-04｜配音未知结果后的重新执行，没有直说“可能再产生一笔费用”

id / priority / surface+state / evidence_status
COPY-04 / P1 / 配音恢复：原调用结果与扣费未知 / CONFIRMED

file:line
components/RunWorkbench.tsx:987-999,1051。现有文案已明确“记账后创建新任务”，但没有直接说明可能再次计费；查询说明又使用“不产生新费用”的绝对表述。
COPY_INVENTORY
COPY_INVENTORY

original
“按预估费用保守记账”；“不点击就不会记录费用，也不会重试”；“按预估记账并重新配音”；“只继续查询原任务……也不会产生新费用”。

why_confusing_or_false
本地未登记费用，不代表服务商未扣费。登记估算也不代表已核实账单。创建新配音任务应显式提示可能再次计费。

proposed_copy_exact
未知配音结果分支：

“上一笔配音是否扣费仍未确认。继续后，系统会先按原预估金额登记上一笔，再创建新的配音任务；新任务可能再次产生费用。预估登记不等于服务商账单确认。不继续只是不登记和不重试，不能据此判断服务商未扣费。”

按钮：

“登记预估费用并新建配音任务”

原任务查询分支：

“此操作查询原任务，不重新提交生成任务。原任务是否扣费仍以服务商账单为准。”

后一句只在查询处理器确实不创建任务时采用。

visible_when
仅未知结果恢复分支。明确拒绝且有未扣费证据的零费用分支继续保留，不一律改成未知。

regression_test
未知结果不能显示“未扣费”；预估登记不能显示“账单已确认”；创建新任务入口明确提示可能再次计费。查询入口不得调用新建任务处理器；旧版只读流程不出现继续制作承诺。

COPY-05｜“保存模型”可能立即开始执行，按钮未表达调用后果

id / priority / surface+state / evidence_status
COPY-05 / P1 / 创作规划：更换阶段模型 / NEEDS_CONTRACT_CHECK

file:line
components/PlanningStagesPanel.tsx:57-58,136,159。说明写保存后开始或重新执行，按钮却只写“保存模型”，另有“下次使用”。
COPY_INVENTORY

original
“保存后这一步会按你选的模型开始执行”；“保存后才会重新执行这一阶段开始的后续部分”；“下次使用”；“保存模型”。

why_confusing_or_false
普通“保存”容易被理解为仅持久化设置。若实际会调用模型，用户需要在点击前知道。

proposed_copy_exact
依据处理器的真实行为选用：

实际行为	按钮及说明
只保存选择	“保存模型选择”／“仅保存选择，继续制作时才会使用。”
保存后立即执行本阶段	“保存并开始本阶段”／“将调用 {模型名}，费用按所选接入规则计算。”
保存后重跑受影响阶段	“保存并重新执行受影响阶段”／“将从 {阶段名} 开始重新执行，后续人工确认点保留。”

visible_when
编辑模型且选择发生变化时；“下次使用”只用于不会立即调用的分支。

regression_test
分别断言保存型与执行型分支的按钮名称、提示和实际 handler；不能为配合按钮改名，把保存动作改成执行动作。

高风险：动态文本、失败状态与人工判断
COPY-06｜通用“人话化”会改写创作原文和授权原文

id / priority / surface+state / evidence_status
COPY-06 / P1 / 所有调用通用清洗的创作文本、作者信息和许可说明 / CONFIRMED

file:line
presentation.ts:204-242,264；components/NodeDeliveryPreview.tsx:399-400,491-496。
presentation
presentation
NodeDeliveryPreview
NodeDeliveryPreview

original
全局替换 fast → 明快、合同约束 → 创作约束 等；许可说明也经过同一标量格式化。

why_confusing_or_false
显示层改变了用户写作、名称或条款的含义。不是简单“不够通俗”，而是展示内容失真。

proposed_copy_exact
已复现的输入与目标：

输入	当前输出	修正后输出
旁白原文：Learn fast；请遵守合同约束。	旁白原文：Learn 明快；请遵守创作约束。	原样显示输入
license_note="合同约束：不得商用"	创作约束：不得商用	合同约束：不得商用
受信任的节奏枚举 pacing="fast"	明快	明快，只在确认是枚举字段时翻译

另将本地固定英文 cache API responses for 24h and avoid systematic mass downloads 的翻译改为：

“接口响应缓存 24 小时，并避免系统性批量下载。”

原文没有表达“最多”，不能擅加上限。此处仅纠正本地翻译，不宣称已核验服务商现行条款。

visible_when
自由文本、原文引文、作者／模型名称、许可说明进入展示时。不得把修复简化为全站停止翻译；应保留受信任枚举的精确映射。

regression_test
标题、旁白、字幕、提示词、作者名、许可文本包含 fast、Canon、blocking、合同约束 时原样保留；受信任枚举仍能翻译；复制、编辑保存、下载和审计原文均不被显示层改写。

COPY-07｜清洗整行诊断会删除恢复动作，纯诊断错误会变成空白

id / priority / surface+state / evidence_status
COPY-07 / P1 / 失败说明、候选模型失败、创作轮次提示 / CONFIRMED

file:line
presentation.ts:250-256,308,358-363；sourceAssetReviewBreakdown():82-114。
presentation
presentation
presentation

original
删除“诊断：”后的整行；删除候选失败冒号后的整行；清洗结果使用 ?? reason 回退。

why_confusing_or_false
恢复动作可能与诊断写在同一行，一并消失；空字符串不是 null/undefined，不会触发 ?? 回退。

proposed_copy_exact
已复现：

输入：诊断：stage=submit；reasonCode=unknown。当前提示为 ""。
用户摘要改为：“本次调用未完成，当前记录没有可读的失败说明。请查看本步骤的状态和可用处理方式。”
输入：2 个候选模型均未能完成：A 超时；B 结果未知。请先核对原任务，不要重复提交。
当前只剩：“候选模型都没能给出可用结果。”
目标应保留已提供的动作：“已尝试 2 个模型，未获得可用结果。请先核对原任务，不要重复提交。”

技术详情保留服务端已允许展示的诊断字段和原始安全文本，不要再使用会删除事实的同一清洗函数。

visible_when
失败摘要进入通用格式化，尤其 phase="failed" 且原因只有机器诊断时。

regression_test
诊断清洗后为空、仅空白、同一行带恢复动作、多个模型分别失败／未知，都有非空摘要；“不要重复提交”等限制不消失。技术详情不引入未脱敏响应、凭据或原始服务日志。

COPY-08｜停止状态仍提示生成中，轮次上限被写死为三轮

id / priority / surface+state / evidence_status
COPY-08 / P1 / 创作轮次：无可展示复核报告 / CONFIRMED

file:line
presentation.ts:281,333-365。
presentation
presentation

original
agentLoopPendingNote() 除失败和停住外统一返回“正在生成本轮方案”；exhausted 固定显示“三轮复核未通过”。

why_confusing_or_false
latestAudit 缺失不代表正在执行。函数级验证已复现：exhausted, iteration=2, maxIterations=2 同时输出“第 2 / 2 轮 · 三轮复核未通过”和“正在生成”。

proposed_copy_exact

输入状态	缺少报告时的说明
auditing	“独立质量复核正在进行，尚未返回本轮结论。”
repairing	“正在按复核意见修订本轮方案。”
exhausted	“自动修订已停止。请查看已有结果和复核意见，再决定下一步。”
awaiting_user	“正在等待你的决定，没有继续自动修订。”
passed	“本轮状态记录为复核通过，当前未附可展示的报告详情。”
未识别阶段	“当前阶段暂无法识别，请查看最新制作状态。”

阶段标题使用传入上限，例如：

第 2 / 2 轮 · 自动修订已停止

“bounded repair history”翻译为“有限轮次修订记录”，不从这句英文推导“最多三轮”。

visible_when
轮次卡、缺失报告说明、历史轮次记录。当前生产是否允许非三轮上限仍需核对，但停止状态的错误提示已经可以确认。

regression_test
所有已知 phase 分别测试；停止、等待用户、通过和未知阶段不得出现“正在生成”。验证传入上限为 2、3、5 的格式化结果，不改变实际轮次控制。

COPY-09｜失败兜底无条件建议“放行／换模型重做”，缺少恢复合同依据

id / priority / surface+state / evidence_status
COPY-09 / P1 / 模型失败、通用请求错误、历史失败恢复 / NEEDS_CONTRACT_CHECK

file:line
presentation.ts:363；api.ts:492-497；components/RunWorkbench.tsx:1795,1851-1856。源码中的失败兜底直接推荐放行和重做，而通用 API 与恢复卡的完整条件未提供。
presentation
DYNAMIC_CONTEXT
COPY_INVENTORY

original
“可以按现在的结果放行……改这一步的模型，再让它重做”；“请回到今日机会重新发起制作”；“请检查对应能力后重试”。

why_confusing_or_false
单凭 phase="failed"，无法确认能否采用现有结果、是否允许新任务、是否存在未知扣费。泛化重试还可能与原任务查询卡同时出现相反建议。

proposed_copy_exact
无合同依据的默认文本：

“本次调用未完成。请先查看本步骤的状态和可用恢复操作。”

只有已有动作事实支持时，才追加：

已确认的恢复条件	输出
原请求可能已受理、结果未知	“请先查询原任务或核对账单，暂不要重复生成。”
已确认允许重试	“修正页面指出的配置后，可选择‘重试失败步骤’。”
仅可基于旧版新建	“这条记录仅供查看。需要继续调整时，选择‘基于这版重新制作’。”
有合法的质量风险接受动作	使用该动作已有风险说明，不从“失败”推导“可以放行”。

通用请求错误应优先展示已知、可执行的安全错误信息；未知错误不得自动建议重试，也不得把未经筛选的响应全文塞入技术详情。

visible_when
无可读失败说明、未知 API 错误、历史只读及原任务恢复分支。

regression_test
读取并核对 normalizeFailure()、共享 API 类型和真实 handler；对明确未执行、已受理未知、可恢复、历史只读分别测试。相同故障不得同时引导“查询原任务”和“直接换模型重做”。

COPY-10｜将 blocking 一律翻译成“必须修改”，把质量意见写成硬门

id / priority / surface+state / evidence_status
COPY-10 / P1 / 动态复核意见和结构化审片结果 / CONFIRMED

file:line
presentation.ts:233,300,319；components/NodeDeliveryPreview.tsx:481-482。
presentation
presentation
NodeDeliveryPreview

original
blocking → 必须修改的问题；warning → 需修改；“阻断门禁 → 不通过则要求修改”。

why_confusing_or_false
字符串本身没有区分模型质量建议、用户已采纳的返修要求和费用／来源／技术限制。统一替换会改变用户对决定权的理解。

proposed_copy_exact
按可信的结构化来源显示：

质量建议：“需你判断的质量问题”
用户已采纳的返修项：“你已选择先修改此项”
已确认的费用限制：“费用授权尚未满足，暂不能继续”
已确认的来源限制：“来源或使用权尚未确认，暂不能继续”
无法判断性质：“此项是否影响继续制作，需结合本步骤状态核对”

原始 blocking、严重程度和报告结论保留在报告详情中。不能根据自然语言含有某个词，决定使用哪个分支。

visible_when
这些值确实来自系统枚举或报告字段时；用户创作原文中的同名词不翻译。

regression_test
同一个 blocking 词分别放入质量建议、费用限制和创作原文：输出不同且原状态、按钮权限、评分完全不变。硬限制不得被改成“可忽略建议”。

COPY-11｜模型和服务回退标签抹掉了可区分身份

id / priority / surface+state / evidence_status
COPY-11 / P1 / 模型选择、产物来源、调用与费用追溯 / CONFIRMED

file:line
presentation.ts:129-192,312；components/NodeDeliveryPreview.tsx:476-478。
presentation
presentation
NodeDeliveryPreview

original
未匹配模型统一“未识别模型”；未匹配服务统一“未识别的制作服务”；版本化能力 ID 被替换为“内部能力”。

why_confusing_or_false
两个不同模型或服务会变成同一个名称，用户无法选替代项、核对账单或追踪历史。反过来，能力名称也不能冒充实际执行服务。

proposed_copy_exact
输入 → 输出：

已记录 modelId="my-model-2026"，目录无显示名 → “模型名称未收录（my-model-2026）”
已记录未知服务 ID → “服务名称未收录（{服务标识}）”
执行记录未保存模型 → “实际模型未记录”
选择控件确实采用自动选择 → “自动选择”

正文允许“AI 编剧”等角色称谓；选择、费用和追溯区域需分别保留“制作角色／能力”和“所选或实际服务／模型”。

不得把 openai 直接改写为实际供应商 OpenAI：该值究竟代表服务商还是兼容协议，必须核对合同后再决定。

visible_when
模型目录缺项、旧记录、用户自定义接入及服务身份详情。展示标识须经过既有安全筛选，并以文本方式转义。

regression_test
两个未知模型、两个未知服务不显示成相同无差别名称；失效模型仍可辨认；选择状态与执行记录的缺失含义不同；供应商名称不由协议名或能力 ID 猜测。

COPY-12｜未知提案来源被当作 AI 总编，未知参数被当作自动选择

id / priority / surface+state / evidence_status
COPY-12 / P2 / 选题来源、推理强度说明 / CONFIRMED

file:line
presentation.ts:382-394。
presentation

original
proposalSourceLabel() 未匹配返回“API 总编提案”；reasoningEffortLabel() 未匹配返回“由服务自动选择”。

why_confusing_or_false
“无法识别”不能升级为“模型生成”，显式配置的未知值也不是“没有配置”。

proposed_copy_exact

输入	当前输出	修正后输出
提案来源 custom-planner-v2	API 总编提案	“提案来源名称未收录（custom-planner-v2）”
推理强度 future-effort	由服务自动选择	“推理强度值未识别：future-effort；是否支持待核对。”
推理强度未设置	由服务自动选择	“使用服务默认推理设置”

visible_when
来源和参数不在已知映射内时；不得推断它是规则提案还是模型提案。

regression_test
未知来源不包含 AI／总编背书；显式未知参数与空值输出不同；已知来源和已知参数映射保持兼容。

COPY-13｜选题建议仍被称为“开工门槛／准入”，与当前建议性质不一致

id / priority / surface+state / evidence_status
COPY-13 / P1 / 选题来源不足、总编不推荐、补充来源 / CONFIRMED

file:line
components/SourceSupplementDialog.tsx:78；pages/TodayPage.tsx:490；components/HotTopicBoard.tsx:234；pages/ResourcesPage.tsx:399-401；onboarding/creator-tour-steps.ts:44。共用函数明确说明选题判断只是建议，不能据此禁用开工。
presentation
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“重算开工门槛”；“暂不生产”；“视频选题准入标准”；“证据不足的高风险热点会被阻止”。

why_confusing_or_false
这些措辞把建议、来源检查和真正需要人工完成的核验混在一起。不能靠全局替换“门槛”来处理，因为真实核验和运行限制仍存在。

proposed_copy_exact
对应入口分别替换：

“来源已保存；来源核验结果与制作建议已更新。”
“暂不建议制作”
“选题评估参考”
“补充后会重新评估来源与制作建议；需要人工核验的内容仍须由你确认。”
向导：“先查看来源提醒并核对关键事实。选题建议供你判断；页面要求的人工核验仍需完成。”

仅将评估说明中的“必需”改成“重点评估”；表单真正必填项、来源权利限制和人工核验勾选不改。

visible_when
来源评估和总编建议区域，不覆盖真正的费用、安全与来源权利错误。

regression_test
来源不足／不推荐仍显示真实原因；文案不宣称“禁止制作”。人工核验未完成、来源权利不明等实际限制继续保持原有行为。

COPY-14｜设置页对审片能力缺失作绝对禁开工说明，返工“必改”也需核对来源

id / priority / surface+state / evidence_status
COPY-14 / P1 / 设置与新建返工：审片不可用、镜头必改 / NEEDS_CONTRACT_CHECK

file:line
pages/ResourcesPage.tsx:101；components/NewRunDialog.tsx:774,790,1189,1319-1320。设置页写“未就绪时不能开工”，新建页却有明确的首版风险接受路径；返工又把审片或失败记录中的镜头统一描述为不可移除。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“未就绪时不能开工”；“开工前请先恢复独立质量复核能力”；“审片或失败记录明确要求的镜头标为必改，不能移除”。

why_confusing_or_false
视觉审片不可用与其他必要复核能力缺失不一定是同一个条件；“模型建议修改”和“用户已经采纳必须返修”也不是同一状态。

proposed_copy_exact
仅针对已存在的视觉审片首版路径：

“视觉审片暂不可用。可在新建制作中选择‘先生成首版，稍后审片’；首版可播放，不代表正式审片通过。”

返工镜头根据已确认原因分别显示：

“你已选择先修改”
“完成此步骤所必需的修复”
“模型建议修改”

缺少原因字段时使用：

“本轮固定重做镜头；固定原因待核对。”

不能仅为使“模型建议修改”可取消而改动真实锁定逻辑。

visible_when
对应能力缺失及返工范围分支；独立质量复核的其他必要条件不套用视觉审片文案。

regression_test
首版路径可用／不可用分别测试；用户采纳的返修、技术必要修复、普通质量建议分别验证标签和原有权限。

COPY-15｜向导仍把整个流程描述为“自动跑完，最后审片”

id / priority / surface+state / evidence_status
COPY-15 / P1 / 新手向导、制作记录讲解、制作详情讲解 / CONFIRMED

file:line
onboarding/GuideDock.tsx:103；onboarding/creator-tour-steps.ts:114,181,188,197,206,233,260。这些提示与共用 runNeedsCreatorAction() 中多种需要处理的状态不一致。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
presentation

original
“只有‘等你审片’时才需要操作”；“其余状态无需操作”；“系统随后自动执行脚本、画面、配音……”；“九段进度”。

why_confusing_or_false
用户会错过前期构思、脚本、导演方案、费用确认和失败恢复。固定九段也不适用于当前不同流程。

proposed_copy_exact
记录页说明：

“先查看‘待你处理’的制作。方案确认、费用授权、失败恢复和人工终审，都可能需要你操作。”

新建向导：

“点击‘开始前期构思’后，先查看并讨论方案。脚本与导演方案会按流程等待你确认；付费画面另行报价，成片完成后再进行人工终审。”

进度说明：

“进度条显示这条制作实际包含的步骤，每一步都会标明当前状态。”

详情说明：

“先看当前状态和下一步提示。等待确认时由你决定；失败时先查看恢复方式，不要直接重复创建任务。”

筛选引导使用实际已有“待你处理”的入口或状态集合，不要求新增筛选功能来适配文案。

visible_when
完整导览及页面讲解；不改变向导自动操作范围。

regression_test
对 needs_human 的非终审节点、费用待确认、授权失效、失败、待重新生成、历史只读逐项测试。向导不能再出现“只有终审需要操作”或固定步骤数量。

高风险：产物真实性、信息遗漏与发布状态
COPY-16｜仅有文件路径，就显示“已连接上游产物”

id / priority / surface+state / evidence_status
COPY-16 / P1 / 节点产物预览：上游文件引用 / CONFIRMED

file:line
components/NodeDeliveryPreview.tsx:490。
NodeDeliveryPreview

original
所有非空 *Path／*_path 字符串显示为“已连接上游产物”。

why_confusing_or_false
字符串存在不能证明文件存在、读取成功、版本一致或仍可复用。已验证 scriptPath="missing-script.json" 仍输出“已连接上游产物”。

proposed_copy_exact
仅有路径时：

“已记录文件引用，尚未在此处核验可用性。”

只有现有数据明确提供对应事实时，才使用“文件已读取”“文件读取失败”“引用版本已过期”等说明。不得为了这条文案新增自动读取或下载。

visible_when
文件引用字段经现有展示白名单允许显示时。

regression_test
不存在的路径、旧版本、未读取、读取失败和已验证文件分别测试；单纯非空字符串永远不能显示“已连接”“已验证”或“可复用”。

COPY-17｜产物预览静默截断候选和字段，用户不知道还有信息未看到

id / priority / surface+state / evidence_status
COPY-17 / P1 / 候选素材、排序结果、审片发现和结构化产物 / CONFIRMED

file:line
components/NodeDeliveryPreview.tsx:278,298-300,323-325,409-413。候选内层固定取六个；单项事实字段固定取五个，外层展开按钮并不能展开这些内层遗漏。
NodeDeliveryPreview
NodeDeliveryPreview
NodeDeliveryPreview

original
“9 个候选”可能仅渲染六个；单项第六个及以后的可展示字段没有提示。

why_confusing_or_false
未展示的信息可能包含问题说明、建议或其他判断依据。用户可能把“看见的六个”当作完整候选集。

proposed_copy_exact
候选九个、显示六个：

“共 9 个候选，当前显示 6 个。”

展开按钮：

“查看其余 3 个候选”

单项还有三个可展示字段：

“还有 3 项信息未展开”

按钮：

“查看完整条目”

优先保证风险摘要和问题说明可见；展开仍只显示原白名单允许的字段。

visible_when
实际截断发生时。计数应基于可展示数据，而不是对用户不可见的私有字段。

regression_test
候选数量为 0、6、7、13；单项可展示字段为 5、6、9；交换对象字段顺序。所有允许展示的信息最终可达，严重问题不因插入顺序丢失，展开不触发素材下载或改变选中项。

COPY-18｜素材“可用／可复用”与统计空状态缺少用途和覆盖范围

id / priority / surface+state / evidence_status
COPY-18 / P1 / 素材库与来源授权：复用、人工确认、部分统计 / NEEDS_CONTRACT_CHECK

file:line
pages/AssetsPage.tsx:153,389,393；pages/ResourcesPage.tsx:533-538,601,689。页面存在历史缺失、损坏隔离及最近 500 条统计范围，同时使用“当前没有需要确认或返工的素材”。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“可直接复用”；“授权素材”；“已确认可用”；“确认可用”；“当前没有需要确认或返工的素材”。

why_confusing_or_false
文件可再次取用、当前项目可用、跨作品可用和本次用途符合授权，不能用同一个“可用”代替。统计没有待办，也不表示被排除记录的授权已确认。

proposed_copy_exact
根据现有范围字段显示：

“可复用素材，使用范围见授权记录”
“仅当前项目可用”
“本次用途已人工确认”
确认按钮：“确认本次用途符合授权”

空状态：

“本页已读取记录中，没有待处理的授权确认或返工事项。”

存在统计缺口时追加：

“未纳入统计或缺少历史记录的素材，不在本次结论范围内。”

只有确实记录了“本次用途”，才能采用对应确认按钮；否则先核对该操作究竟确认什么，不能凭文案补出授权范围。

visible_when
对应素材状态、确认动作及部分数据汇总分支。

regression_test
当前项目限定、跨作品许可、授权缺失、历史无记录、清单损坏、超出统计范围分别测试；任何部分空状态都不暗示全库授权已核实，不新增或扩大使用许可。

COPY-19｜多平台发布的总标题和说明没有区分“导出材料”与“实际提交”

id / priority / surface+state / evidence_status
COPY-19 / P1 / 多平台发布：导出、提交审核、混合结果 / NEEDS_CONTRACT_CHECK

file:line
components/MultiPlatformPublishDialog.tsx:82,133,155,159,163。清单既有“各平台独立发送与审核”，也有“导出后人工上传”“发布包已准备”等不同路径。
COPY_INVENTORY

original
“发布到多个平台”；“一次确认，各平台独立发送与审核”；“发布任务已处理”；“相同请求不会重复发送”。

why_confusing_or_false
导出材料不是向平台提交，提交审核也不是已经公开发布。总说明不能把所有目标平台都描述成会发送。

proposed_copy_exact

目标平台实际动作	标题／摘要
全部仅导出	“准备各平台发布包”／“下载后，由你到目标平台上传和确认发布。”
全部通过已有授权提交	“提交到已授权平台”／“提交后仍需等待各平台处理或审核。”
混合	“提交与导出发布材料”／“{提交数} 个平台将提交，{导出数} 个平台仅生成发布包。”
一个平台已提交、一个已导出	“1 个平台已提交审核；1 个平台发布包已准备。”

“不会重复发送”只有经幂等合同确认，且明确限定同一请求时才保留；不能暗示重新创建发布请求也不会重复。

visible_when
目标平台能力已读取且实际动作已确定。读取失败时不得先显示“准备就绪”。

regression_test
全导出、全提交、混合、部分失败、等待审核、结果未知分别测试；没有明确平台发布结果时不显示“已发布”。

通用可读性、动态字段和无障碍
COPY-20｜未知步骤直接露出技术 ID，未知字段还可能失去区分

id / priority / surface+state / evidence_status
COPY-20 / P2 / 进度状态、节点产物、未知字段 / CONFIRMED

file:line
presentation.ts:43-56；components/NodeDeliveryPreview.tsx:545-546。
presentation
NodeDeliveryPreview

original
“等你确认custom-export-v2”；未知键仅将下划线、连字符替换为空格。

why_confusing_or_false
技术 ID 被当成普通步骤名；不同原键还可能显示成相同文本，例如 foo-bar 与 foo_bar。

proposed_copy_exact
未知步骤：

“等你确认当前步骤”

辅助详情：

“步骤标识：custom-export-v2”

非终审通用查看按钮：

“查看本步骤并决定是否继续”

未知但已被现有白名单允许展示的字段：

“附加信息（{原始字段名}）”

保留完整原键以区分，不推测中文业务含义，也不把所有值都命名为“未识别”。

visible_when
未知节点；或未知字段通过既有展示白名单。不能绕过 creator-document-policy.js。

regression_test
未知节点、两个归一化后同名的键、中文键、长键分别测试；原始标识可追溯，主状态不拼出裸技术 ID；添加标签不改变 RUN_NODE_ORDER。

COPY-21｜同一个字段名在不同产物中被标成错误业务含义

id / priority / surface+state / evidence_status
COPY-21 / P2 / 参考片分析、候选排序、素材、配音、系列内容 / CONFIRMED

file:line
components/NodeDeliveryPreview.tsx:15-23,78,83,96,108,160,237-245。
NodeDeliveryPreview
NodeDeliveryPreview
NodeDeliveryPreview
NodeDeliveryPreview

original
所有 summary 都是“审片摘要”；所有 provider 都是“配音方式”；beats 是“时间段语法”；canonFacts 是“拟写入系列正史的事实”。

why_confusing_or_false
参考片分析与候选排序不是审片，素材服务也不是配音。标签会误导用户理解字段来源和确认状态。

proposed_copy_exact

产物语境＋字段	推荐显示
reference-grammar.summary	“参考视频分析摘要”
asset-semantic-rank.summary	“候选排序摘要”
visual-review.summary	“视觉审片摘要”
配音产物的 provider	“配音服务”
素材产物的 provider	“素材来源”
无已知语境的 provider	“服务或来源”
参考片 beats	“分段表达结构”
草稿中的 canonFacts	“拟加入系列设定的内容”
未确认状态的通用 canonFacts	“系列内容记录”

让标签函数接收已有节点／容器语境；不改字段名、存储结构或确认状态。

visible_when
对应字段实际展示时；“已确认”只由确认事实驱动，不由节点名字推断。

regression_test
同一个 summary/provider/status 放入多个节点，标签与语境一致。编辑器与预览使用同一口径，但不全局改变业务字段。

COPY-22｜时间和语速缺少可靠单位，置信度未经合同核对直接乘百分比

id / priority / surface+state / evidence_status
COPY-22 / P2 / 参考片时间、配音参数、审片置信度 / NEEDS_CONTRACT_CHECK

file:line
components/NodeDeliveryPreview.tsx:15,99-100,497-500；components/VoiceStudio.tsx:65,204。源码对所有 rate 数字追加“字/分钟”，但声音界面已区分相对语速。
NodeDeliveryPreview
NodeDeliveryPreview
NodeDeliveryPreview
COPY_INVENTORY
COPY_INVENTORY

original
durationMs=12500 显示 12500；rate=1.2 显示“1.2 字/分钟”；confidence 统一乘 100。

why_confusing_or_false
用户不知道时间单位；相对档位被误写成绝对语速。不能通过数值大小猜测单位或置信度量纲。

proposed_copy_exact
先核对对应字段合同：

毫秒时长 12500 → “参考视频时长：12.5 秒”
毫秒开始时间 2500 → “开始时间：2.5 秒”
已确认相对档位 rate=1.2 → “相对语速：1.2”
已确认绝对语速 rate=200 → “语速：200 字/分钟”
无单位记录 → “语速设置：1.2（单位未记录）”
若置信度合同为 [0,1]，0.8 → “模型自评把握程度：80%”
违反已确认置信度合同的值 → “置信度值异常，暂不显示百分比”

visible_when
对应字段通过白名单显示；仅更改展示，不改保存值。

regression_test
不同配音服务的单位分别测试；时间保留需要的精度；置信度边界、异常值和缺失值不被静默修正成正常百分比。

COPY-23｜缺失镜头编号时用数组序号冒充真实镜头编号

id / priority / surface+state / evidence_status
COPY-23 / P2 / 候选与排序、素材路线预览 / CONFIRMED

file:line
components/NodeDeliveryPreview.tsx:277,297,316-319,417-420。
NodeDeliveryPreview
NodeDeliveryPreview
NodeDeliveryPreview

original
镜头编号缺失时使用 index + 1，显示“镜头 1”或“分镜 1”。

why_confusing_or_false
展示位置不是制作中的镜头身份，尤其排序后容易把意见归到错误镜头。

proposed_copy_exact
真实镜头编号存在：

“镜头 7”

镜头编号缺失、当前是第三条记录：

“镜头编号未记录 · 第 3 条记录”

不能把这个回退序号用于后续定位、返工或确认。

visible_when
镜头编号缺失或无效。实际生产是否允许缺失仍需在数据合同中核对，但当前回退行为可确认。

regression_test
缺失编号、非连续编号、改变排序、局部候选列表分别测试；缺失值不显示为确定镜头 ID，交互引用仍使用真实身份。

COPY-24｜可访问名称可能与可见动作不一致，重复素材入口缺少对象

id / priority / surface+state / evidence_status
COPY-24 / P2 / 素材卡片、候选来源链接与缩略图 / NEEDS_CONTRACT_CHECK

file:line
pages/AssetsPage.tsx:253；components/NodeDeliveryPreview.tsx:390-401。清单同一源码行包含“查看作品／去确认授权”和“查看素材原始来源”的 aria 名称；具体绑定需看完整 JSX。
COPY_INVENTORY
NodeDeliveryPreview

original
“查看作品”／“去确认授权”；aria-label="查看素材原始来源"；重复“核验原始来源”；图片仅“候选素材 1”。

why_confusing_or_false
若 aria 标签覆盖了不同的可见动作，读屏用户会得到错误承诺。候选编号在多个镜头下重复，也难以分辨对象。

proposed_copy_exact
按实际控件分别命名：

“查看作品：{作品标题}”
“去确认授权：{素材名称或可靠标识}”
“核验原始来源：镜头 {真实编号}，候选 {序号}，{来源名称}（新窗口）”
图片无可靠内容描述时：“镜头 {真实编号} 的候选素材 {序号}”

不得编造画面内容作替代文本。存在明确图像描述时再使用该描述，并避免与旁边完整说明重复朗读。

visible_when
对应真实控件；未知镜头编号沿用 COPY-23，不编造编号。

regression_test
使用 DOM 可访问名称断言验证可见文字与读屏动作一致；通过链接列表能区分对象；键盘可达。不能只检查 JSX 是否出现了 aria-label。

COPY-25｜模板已暂停参与制作，局部说明仍像会影响新制作

id / priority / surface+state / evidence_status
COPY-25 / P2 / 模板资料：模型设置、新建草稿、正式版本 / CONFIRMED

file:line
pages/TemplatesPage.tsx:245,273,284,338,377,384-386；templates/TemplateGallery.tsx:43,76-78。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“新建制作时会预选系统推荐”；“可运行的三段式草稿”；“发布新版本”“确认发布”。

why_confusing_or_false
与页面“模板不参与新制作或返工”的明确定位不一致。“发布”也容易与视频外部分发混淆。

proposed_copy_exact
模型区：

“这里只记录模板的模型偏好，目前不会影响新制作或返工。”

新建草稿：

“创建一份三段式模板草稿，仅保存在模板资料库；不调用模型，也不会产生费用。”

版本操作：

“保存为模板正式版”
“确认保存正式版”
状态：“资料库正式版”

模板卡片若展示“自动优先／人机协作”等记录，补充：

“模板记录的创作模式，当前不影响制作。”

保留原有草稿、正式版和历史快照语义。

visible_when
当前暂停参与制作的模板资料区域。

regression_test
新建、保存草稿、保存正式版、历史模板与模板卡片中不暗示自动套用；操作不触发模型调用或修改制作配置。

COPY-26｜设置与恢复说明保留过多内部术语，部分提示对用户带有评判

id / priority / surface+state / evidence_status
COPY-26 / P2 / 模型设置、耗时说明、终止制作、选题错误 / CONFIRMED

file:line
components/ModelLibrary.tsx:119,121；components/NodeWorkspace.tsx:1269,1276,1283；components/RunWorkbench.tsx:743,746,749；components/HotTopicBoard.tsx:249-250。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original / proposed_copy_exact

原文	精确替换
最大输出 token（按模型文档填写）	“最大输出长度（token，按模型文档填写）”
Thinking budget（留空遵循服务商默认）	“推理预算（Thinking budget，留空使用服务商默认）”
Provider 执行	“服务执行”
Broker 任务	“模型服务调度任务”
结构与合同校验	“输出格式与使用要求检查”
终态操作	“终止制作”
说明为什么这条视频不值得继续制作	“说明终止原因，便于以后查看”
总编的产出没有通过合同校验	“选题结果未通过格式校验，本轮未能采用。”
总编的产出被任务合同拒绝	“选题结果未满足本次任务要求，本轮未能采用。”

终止说明：

“终止后，这条制作不会自动返修或生成发布包。只需修改某一镜时，请返回审片意见，选择对应返工方式。”

why_confusing_or_false
内部实现术语没有帮助普通创作者决定下一步；“不值得继续”把操作原因预设成了对作品价值的否定。格式问题与任务要求问题仍应保留区分。

visible_when
上述固定系统文案出现时；不全局替换诊断原文、用户内容或服务名称。

regression_test
仅指定字符串变化；技术详情仍保留原始类型和原因。终止与返工处理器、参数、权限不变。

COPY-27｜桌面与移动导航叫法不统一，案例详情依赖“左侧”位置

id / priority / surface+state / evidence_status
COPY-27 / P2 / 站点导航、移动端案例详情 / CONFIRMED

file:line
components/AppShell.tsx:113-118,156-160；pages/CasesPage.tsx:284。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
桌面“创作台／制作记录／创作设置”，移动端“首页／记录／配置”；“从左侧选一条参考内容”。

why_confusing_or_false
同一目的地使用不同名字会增加寻找成本；移动布局不一定有“左侧”。

proposed_copy_exact
移动导航采用：

“创作台”“制作记录”“素材库”“设置”

“设置”的可访问名称保留完整“创作设置”。

案例空状态：

“先选择一条参考内容，这里会显示它的正文或可用信息。”

visible_when
对应导航与未选中案例详情；不更改路由。

regression_test
移动和桌面对应入口目标一致；窄屏文字不裁切；页面引导不依赖左右位置；当前导航的可访问状态保持正确。

COPY-28｜审片报告、报告复核和人的最终决定需要更明确地标明主体

id / priority / surface+state / evidence_status
COPY-28 / P2 / 审片意见、报告复核、继续与终审按钮 / CONFIRMED

file:line
components/RunWorkbench.tsx:389-390,477,514,584,795,797；components/CreativeDiscussionPanel.tsx:247。
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY
COPY_INVENTORY

original
“有……份意见自己的独立审计没通过”；“承担这些质量意见后继续”；“项已确认缺陷”；“做完了，进入下一步”；“仍然确认”。

why_confusing_or_false
“报告本身的质量”“模型对作品的判断”“用户是否接受风险”是三件事。长句和泛化确认按钮容易混淆；“做完了”也没有说明只确认当前步骤。

proposed_copy_exact
报告复核说明：

“有 {数量} 份审片报告未通过报告质量复核。需要重点核对的是报告的依据，不等于作品已被否决。请结合成片判断各条意见；发布仍需满足页面列出的必要条件。”

模型意见计数：

“模型判定存在问题：{数量} 项”

按钮按实际决定分别显示：

“确认当前步骤，进入下一步”
“接受所列质量风险，继续制作”
“接受复核未完成的风险并采用本版”
“看过意见，仍采用本版”

技术质检说明：

“机器技术质检是必要检查，未通过时不能批准。本区处理需要人工判断的审片意见。”

保留“采纳后先返修”“不采纳需说明理由”“接受风险保留原评分”的三种不同语义。

visible_when
对应报告主体与人工决定分支，不能用同一个确认文本覆盖全部弹窗。

regression_test
报告复核失败不显示成作品技术质检失败；模型判定不显示成人工已确认；三种人工决定的按钮、说明和提交值一一对应，原始评分和报告不改写。

terminology

以下仅用于系统自有标签与固定说明，不应用于用户原文、模型自由创作、许可原文或审计证据。

原词／混用	推荐词	保留原词的场景
生产、跑制作、制作	制作	代码、诊断字段保留原名
机会、待制作机会	选题、待制作选题	数据实体名和导入字段不改
node、节点、节点放行	制作步骤、确认本步骤并继续	技术详情保留节点 ID
run、任务、项目混用	一条视频用 制作记录；外部调用用 服务商任务	制作编号与服务商任务编号必须分开
Provider	服务／来源，按上下文区分	服务名、供应商原名、接口字段保留
Broker	模型服务调度	技术详情保留 Broker 名称，不能冒充模型本身
审计、复核、审片	方案用 独立质量复核；画面用 视觉审片；报告本身用 报告质量复核	原报告术语保留在原文区
通过、完成、批准	执行完成／模型复核通过／人工批准／平台已发布 分别使用	不互相替代，不统一压缩为“成功”
免费、无现金报价	不产生外部调用费／不另弹报价／订阅额度／按量计费 按事实使用	“免费”仅用于已确认的对应范围，不能覆盖全片
授权金额	本次最高授权额／历史累计报价授权额	单次上限、历史累计、当前余额分别保留
未填写、未知、未完成	表单用 未填写；记录缺失用 未记录；结果不明用 待确认；执行未完成用 未完成	不用一个“暂无”覆盖所有状态
观众承诺、开场钩子	观众看完能得到什么／开场；必要时补简短解释	专业模板结构、原始提示词保留
内容支柱、正史／Canon	固定内容方向／系列已确认内容	不将系列设定解释为外部事实已核验
模板发布	保存为模板正式版	内部版本状态和历史事件不改
token、Thinking budget、模型 ID	中文名称后保留原词	模型配置、协议选择与精确追溯必须保留
implementation_batches
第一批：修复共用动态显示入口，先消除失真与错误状态

目标条目：COPY-06、07、08、10、11、12、16、17、20、21、23；COPY-22 只在单位合同核对完成后实施。

主要文件：presentation.ts、components/NodeDeliveryPreview.tsx；必要时同步 NodeStructuredEditor.tsx 的对应标签及现有测试。

先后顺序
先划分“原文／受信任枚举／系统状态／安全技术详情”，再修复清洗和空字符串回退；随后修复 phase、未知身份、文件引用、字段标签和截断提示。不要先扩大词汇替换表。

允许改动
显示函数的局部参数、按节点／字段的精确映射、非空兜底、已有展示结构中的展开提示和对应回归测试。

不碰
原始产物、用户稿件、报告证据、字段存储格式、展示安全白名单、节点执行顺序、实际状态和权限。creator-document-policy.js 先只读核对，不为本轮方便而扩大允许展示的数据。

验收标准
原文保真用例通过；停止状态不说正在生成；未知不冒充完成或已知身份；不存在的引用不说连接成功；内层截断有明确提示且内容可达；现有状态机和序列化测试无变化。

第二批：核对费用和操作合同，统一所有决定入口

目标条目：COPY-01～05、09、13～15、18、19、28。

主要文件：NewRunDialog.tsx、CostDashboard.tsx、NodeWorkspace.tsx、PlanningStagesPanel.tsx、RunWorkbench.tsx、CreativeDiscussionPanel.tsx、MultiPlatformPublishDialog.tsx、AssetsPage.tsx、ResourcesPage.tsx、选题补充来源相关组件及向导。

纯文案可先实施
金额性质显性化、未知扣费解释、向导补齐人工停点、来源评估改名、区分模型意见与人的决定。

必须先核对的合同
配音是否自动按量执行；授权按调用还是按范围；保存模型是否触发执行；原任务查询与重新创建的边界；恢复动作允许条件；素材确认范围；发布包与平台提交状态。结合仓库中的共享类型、处理器、normalizeFailure() 和现有测试读取证据，不由字符串推断。

不碰
计费计算、授权范围、重试次数、供应商设置、真实许可状态、原任务身份、历史 run、平台发送逻辑和人工确认点。发现后端行为与产品原则不一致时，单独保留 NEEDS_CONTRACT_CHECK，不得借文案任务修改后端。

验收标准
每一个会执行、重试、授权、确认风险或提交平台的按钮，都与实际动作一致；未知结果不会诱导重复生成；同一状态在列表、详情、弹窗和向导中不矛盾；合同未核对的条目不标为完成。

第三批：完成模板、移动端、无障碍与固定文案收口

目标条目：COPY-24～27；以及前两批引出的同义标签同步。

主要文件：TemplatesPage.tsx、TemplateGallery.tsx、AppShell.tsx、CasesPage.tsx、ModelLibrary.tsx，及已定位的耗时说明、终止提示、素材控件。

允许改动
固定标签、说明、可访问名称、必要的可访问描述及测试。沿用现有组件和文案组织方式。

不碰
路由结构、全站布局重写、国际化框架、模板执行能力、接口协议名和原始模型标识。

验收标准
可见动作与读屏名称一致；移动端不依赖左右位置；模板不暗示参与新制作；技术名在配置与追溯中仍可辨认。重新生成或检查机械清单，逐个核对本轮涉及的 46 个文件，不以“禁用词全局搜索为零”替代场景验证。

codex_execution_advice
implementation_plan:
  - batch: 1
    title: "修复共用动态投影"
    findings:
      - COPY-06
      - COPY-07
      - COPY-08
      - COPY-10
      - COPY-11
      - COPY-12
      - COPY-16
      - COPY-17
      - COPY-20
      - COPY-21
      - COPY-23
    conditional_findings:
      - id: COPY-22
        condition: "先核对时间、语速和置信度字段合同"
    primary_files:
      - apps/studio/src/client/presentation.ts
      - apps/studio/src/client/components/NodeDeliveryPreview.tsx
    paired_files:
      - apps/studio/src/client/components/NodeStructuredEditor.tsx
    actions:
      - "枚举相关格式化函数的调用点，区分自由原文、受信任枚举、系统摘要和安全技术详情。"
      - "停止对自由原文和许可原文进行全局语义替换。"
      - "修复清洗后的空字符串回退，并保留安全的恢复动作与技术证据。"
      - "按真实 phase 显示状态，不以报告缺失推断仍在运行。"
      - "未知身份保留可区分标识，不猜测供应商、提案来源或自动选择。"
      - "文件引用不再表示已读取或已验证。"
      - "标签使用已有节点和字段语境；增加内层截断提示与展开。"
    read_only_checks:
      - "creator-document-policy.js 的字段可见性规则"
      - "共享 API 类型与各产物字段定义"
      - "现有调用方对缺失值和未知枚举的处理"
    acceptance:
      - "原文内容及原始证据未改变。"
      - "停止状态、未知状态和缺失报告不误显示为正在生成或已完成。"
      - "未扩大展示白名单。"
      - "未改变 RUN_NODE_ORDER、状态机或权限。"

  - batch: 2
    title: "核对并统一费用及人工决定文案"
    findings:
      - COPY-01
      - COPY-02
      - COPY-03
      - COPY-04
      - COPY-05
      - COPY-09
      - COPY-13
      - COPY-14
      - COPY-15
      - COPY-18
      - COPY-19
      - COPY-28
    actions:
      - "先读取各费用、恢复、保存模型、授权和发布按钮的实际处理器。"
      - "记录显示条件、输入字段、动作副作用和已存在的回归证据。"
      - "依据现有计费模式显示费用说明，不按供应商品牌猜测计费。"
      - "区分本次授权上限、历史累计授权、已记录费用和服务商账单确认。"
      - "未知扣费后的新任务明确提示可能再次计费。"
      - "保存型与执行型按钮使用不同文案，但不改变处理器行为。"
      - "保留质量建议、用户已采纳返修和真实硬限制的区别。"
      - "同步列表、详情、确认弹窗与向导中的下一步说明。"
      - "按实际动作区分导出发布包、提交审核和已发布。"
    contract_checks:
      - "配音自动按量执行与单独报价分支"
      - "范围授权及范围内有限修复"
      - "原请求未执行、已受理未知和可恢复状态"
      - "normalizeFailure 的摘要、恢复动作与安全技术详情"
      - "保存模型是否立即调用"
      - "视觉审片不可用时的现有首版路径"
      - "返工镜头固定范围的来源"
      - "素材确认的用途范围和统计覆盖范围"
      - "发布提交状态、导出状态和请求幂等范围"
    unresolved_policy:
      - "无法核对的条目继续标记 NEEDS_CONTRACT_CHECK。"
      - "不得通过改按钮权限或服务端行为使建议文案成立。"
    acceptance:
      - "按钮描述与实际副作用一致。"
      - "未知结果不引导重复提交。"
      - "同一状态不存在互相矛盾的恢复建议。"
      - "费用、授权、来源权利及人工确认语义保持不变。"

  - batch: 3
    title: "完成术语、模板与无障碍收口"
    findings:
      - COPY-24
      - COPY-25
      - COPY-26
      - COPY-27
    actions:
      - "核对素材控件的可见名称与实际可访问名称。"
      - "为重复来源链接提供可靠的对象信息，不编造图像描述。"
      - "统一移动和桌面目的地名称，去除依赖左右位置的引导。"
      - "模板文案明确仅作为资料，不影响新制作或返工。"
      - "只替换已定位的固定系统文案，不全局替换用户文本。"
      - "逐文件复核机械清单覆盖，记录未验证的动态分支。"
    acceptance:
      - "可见动作与读屏名称一致。"
      - "窄屏标签可读，路由与控件行为不变。"
      - "模板版本操作不被描述为视频外部发布。"
      - "真实服务名、模型名、协议参数和追溯标识仍可辨认。"

non_goals:
  - "不改变业务状态机、操作权限、人工确认点或质量风险接受条件。"
  - "不改变报价计算、授权范围、费用登记、重试上限和付费语义。"
  - "不修改供应商配置、模型接入配置、历史制作或已有产物。"
  - "不修改原始稿件、模型自由文本、许可原文和审计证据。"
  - "不扩大服务端技术详情或客户端字段展示白名单。"
  - "不新增国际化框架，不全站重写，不用全局正则完成文案治理。"
  - "不部署，不调用真实模型、付费服务、素材下载或平台发布。"

optional_subagents: []

verification:
  baseline:
    - "先读取根目录及 Studio 的 package.json、锁文件和现有测试目录。"
    - "使用仓库已经提供的测试与构建命令，不假设测试框架或包管理器。"
    - "记录当前工作区已有改动，避免覆盖无关修改。"

  pure_function_regressions:
    - "自由文本中的 fast、Canon、blocking、合同约束等内容保持原样。"
    - "受信任枚举仍按字段语境翻译。"
    - "纯诊断和清洗后空白均返回非空用户说明。"
    - "同一行中的恢复动作、未知结果与禁止重试提示不被删除。"
    - "全部 phase、缺失报告和不同传入轮次上限分别测试。"
    - "未知模型、服务、节点、提案来源和参数不冒充已知状态。"
    - "仅有文件引用不能显示已连接、已验证或可复用。"
    - "缺失镜头编号不能由数组位置伪造。"

  component_regressions:
    - "真实字段展示策略参与测试；不能通过放宽 mock 白名单掩盖问题。"
    - "候选超过六个、单项字段超过五个时，截断提示与完整内容均可达。"
    - "相同字段在不同产物中使用正确标签。"
    - "语速单位与服务类型一致，置信度异常不被静默归一化。"
    - "模型选择改变后，对应名称和费用说明同步更新。"
    - "原文展示、复制、编辑与保存互不篡改。"

  decision_matrix:
    - "本地、按量、订阅及未知计费模式"
    - "明确未执行、已受理未知、明确失败及原任务可恢复"
    - "当前报价、失效报价、范围内修复及超出授权"
    - "仅保存选择、保存后执行及保存后重跑"
    - "质量建议、用户已采纳返修及真实硬限制"
    - "当前制作、历史只读及部分统计缺失"
    - "仅导出、仅提交、混合平台、部分失败及结果未知"

  accessibility_and_responsive:
    - "用 DOM 计算后的可访问名称验证，不只检查属性存在。"
    - "可见标签与读屏动作一致，重复链接可区分对象。"
    - "验证键盘操作及窄屏布局，不依赖悬浮提示解释关键费用事实。"
    - "说明文字与控件之间保留明确的可访问关联。"

  repository_checks:
    commands:
      - "git diff --check"
      - "git diff --name-only"
      - "git status --short"
    requirements:
      - "运行受影响的现有单元测试、组件测试、类型检查与构建。"
      - "核对 diff 未触及费用算法、生产协议、供应商配置和历史数据。"
      - "新文案必须有状态或输入依据；不能通过字符串替换修改业务结论。"

  reporting:
    - "每条分别记录：已修复、待合同核对、待运行时验证。"
    - "函数级测试通过不能写成整站或真实生产验证通过。"
    - "使用本地假数据完成验证，不执行真实付费或发布操作。"
