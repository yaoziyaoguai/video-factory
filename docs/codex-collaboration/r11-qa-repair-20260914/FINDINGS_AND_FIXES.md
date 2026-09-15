# 已复现问题与最小修正

本包核对当前源码、R11最终QA/RESULT及已有脱敏运行快照；本次补充只做了一次无模型/无外网的Node网络接口诊断，未跑产品回归或真实QA。下列“源码依据”说明已有证据支持什么，不将代码推测冒充已执行的红绿测试。F01～F11与QA-R11-001～011一一对应。

原始报告：[R11 真实 QA](../../qa/videofactory-real-local-qa-20260914-r11.md)。原截图均在 `docs/qa/videofactory-real-local-qa-20260914-r11-assets/`。详细任务/命令身份见 [快照](EVIDENCE_SNAPSHOT.json)。路径/行号供导航，实施前看当前文件。

## F01 / P1：预算意向在正式创建合同被拒绝

对应 QA-R11-001；D11-01/39、Q11-02。

- 行为：新建制作填写预算意向 35 后 POST /api/runs 返回 400；两个 Broker 无调用。清空该选填项只是测试时绕开阻断，不是最终修复。
- 已核实：`NewRunDialog.tsx:634` 提交 budgetIntentionCny，shared/api.ts 有该字段；`contracts.ts:375–397` 白名单没有它，parseBrief 拒绝未知字段；`production-studio.ts:3987` 将错误压成泛化文案。
- 证据：08-create-run-400.png；HTTP 与 Broker 零调用记在原报告。

固定修正：把已有 `budgetIntentionCny?: number` 纳入正式 `ProductionBrief`，不再另建Studio私有预算。沿 brief/规划投影贯穿解析、持久化、恢复及真正需要它的角色上下文。省略＝未表达偏好；0＝希望尽量不产生现金（不保证一定可制作，更不等于批准）；合法正数＝目标意向而非硬付款限额；负数、非有限值和超出现有金额安全精度的值给字段错误。UI不能把输入0或非法输入默默丢弃。沿已有金额精度规则校验，不把本轮测试¥50写成产品字段上限。已有economics只复用相应推导，不增加第二个可独立编辑的同义值。

预算意向是规划偏好，不能自动现金授权、不能静默改用户承诺。不能删除界面功能、提交时悄悄丢字段或打开任意字段通过来求成功。与用户可改字段有关的错误提供安全字段位置和可行动提示，不直接把任意错误/密钥回给前端。涉及 Broker 输入的变更要同步 parser、schema、normalizer、digest、实际 adapter 和审计上下文。

## F02 / P1：采用已完成，页面仍显示处理原操作

对应 QA-R11-002；D11-12/14/16/19/21、Q11-02/10。

- 采用命令：88cfae87-34e9-4c3a-b5a0-eb061e83e078；开始 00:27:35.807Z，完成 00:27:35.893Z，约 86ms。
- adopted draft SHA 从 f102c0db… 变为 3865aba4…；currentDocument、previousDraft、effectiveUserInstructions 已更新，服务端 command completed；页面超过15秒仍“正在处理原操作”。这不是慢模型，采用操作本来零模型调用。
- 证据：10-director-alternative.png、原报告、快照中的 completed 命令。

当前源码接缝：

1. `RunPage.tsx:112–124` 只随 run revision/intervention kind 刷新 creativeReview。
2. `RunPage.tsx:173–198` 命令终态观察只刷新 run，不显式收敛 review；observe 以 detached promise 运行，外层提前返回。
3. `CreativeDiscussionPanel.tsx:37–51` 把 onCommand resolve 当作可以清除 pending/输入的时点，实际它可能只表示命令已受理。
4. `production-studio.ts:1490` 只要 run 中任何命令 running 就投影 checking；阶段、操作类型、终态更新需要统一。
5. Pipeline 将命令 completed checkpoint 与之前等待投影分次写入，需验证同 revision 内更新和 HTTP/SSE 到达顺序。

这里已有多个可解释竞态的代码依据，但尚未通过本轮组合红灯证明哪一条是现场第一处丢失。不要只加 setTimeout、强制整页刷新或延长等待。

修正：让当前命令终态驱动原命令与 review 的一致观察；处理快速完成、202 后响应丢失、同 revision 更新、刷新/离页/返回、晚到旧 GET。受理、仍执行、完成/失败分开，保存用户尚未发送的输入；观察失败不能把原已受理操作当作未发送换 ID。adopt/undo 均无模型/媒体调用，零重复采用。

## F03 / P1 主链阻断：OpenAI 构思确认审计失败，具体拒绝原因丢失

原报告 QA-R11-003 标 P0；本包保留原编号，按“主链不可完成”处理。未观察到该项引起未授权付款或数据泄漏，不扩充其影响。
对应 D11-13/16/17/39/40；Q11-02/07。

- 命令：9cb08605-9608-4c23-b763-e99a279cb8ec。
- Broker request：agent-0c584891a93352dede5b6543ae8f4702a4a57ed83f96802cce5e136d067c6236，kind role-audit。
- durable 文件：`.local/runtime/qa-r11-20260914-001/openai/tasks/.video-factory/codex-idempotency/openai/ab3894b362ac9d0186b48fc547461928b4692c2770915ea48512b45cfa1d0894.json`。
- outcome：status 422、message “The model could not complete this step.”、category/reasonCode invalid_request、providerWaitMs 7742、queueWaitMs 0；producer=0，audit=1，pendingCandidate 保留。
- 证据：11-treatment-audit-failure.png；run 下 `nodes/creative-planning/attempt-5/agent_loop_trace.json`。

必须纠正的诊断口径：

`broker-server.ts:1093` 的 failureOutcome 把已受理 CodexExecutorError 通常统一返回422。因此这个422是 Broker outcome，不是已证实的上游 HTTP 422。`codex-executor.ts:980` 有错误摘录但只把分类放入 details；随后 publicExecutorMessage 丢掉具体摘录。未知的是 CLI/schema/会话/路由/上游的具体拒绝原因，不能把它写成“模型不支持”或“网络问题”。digest 相同只证明两端声明相同，不证明实际发出的请求被服务接受。

固定定位顺序：

1. 使用原 durable、任务目录/已存在 schema、trace 和安全日志；不为复制报错无条件重投。
2. 核对正式确认路径 actual candidate/context→role-audit adapter→Broker parser→executor 最终 CLI 参数/strict schema/模型与会话绑定→结果解析→failureOutcome→client/role checkpoint→Studio，找到第一处拒绝及第一处诊断丢失。
3. 在现有 error/diagnostic 合同中增加必要的有界安全依据：拒绝层级、受理状态、providerErrorCode（仅真实可取时）、安全字段路径/摘要、子进程退出码等；未知留空。分别保留 Broker status 与上游 status，禁止凭分类反推上游原码。不加全量 stdout/stderr、prompt、凭据、任意本地路径或上游响应回显。
4. 用真实 executor 的受控子进程/transport 复现错误并验证脱敏、持久化和传播；再修真正的请求/参数/合同问题。测试要包含有害诊断字符串不泄漏。`CodexExecutor.runTask()` finally会清理taskDir，不能假定旧output-schema文件一定还在，也不能为诊断取消清理、永久存原始prompt/stdout。
5. source/dist 通过后，通过真实 Studio 三阶段确认链验证 OpenAI 和 GLM；不能让测试脚本直接调用模型的成功替代正式确认消费。一次诊断 canary 成功只能证明该边界。

如果历史记录确实没有足够信息，明确“历史原因不可恢复”。允许修正安全诊断后一次有界正式真实调用取证；仍失败则保留具体证据交回，不能声称 F03 已修。不要靠换模型、禁审、缩减质量或增加超时掩盖它。

## F04 / P1：同一失败的阶段、状态与耗时互相矛盾

对应 QA-R11-004；准确关联 D11-10/19/43/44、Q11-10/12。原报告关联的 D11-36～38 是正文获取验收，不是这项状态问题，本包不沿用该误映射。

- 页面同时出现“脚本未通过”“导演前期构思独立审计失败”“第1轮AI创作中”。
- confirm operation failed，但 node.output.continuationOperation 仍 running；现场对应 Broker 已 idle。
- 创作0/审计1 与此前3次讨论/生成工作缺少统一解释。
- `WorkflowRunner.continueWaitingNode()` 会把 output 替换成 running continuationOperation；Pipeline 完成路径更新 creativeReviewOperations。失败路径、投影与读接口须对照同一个操作核实。

与 F02 合并治理终态，但分别证明失败归属。以真实 stage+phase+original command/request/checkpoint 为事实，不根据“下一步本来是脚本”给 treatment 审计改名。既有 run projection 应从权威 checkpoint/操作补齐，不能再建第三份独立状态。失败后可查看当前稿、原因与可用恢复动作；等待用户时不说模型运行中。

统计按物理 request 去重，区分初稿/解释/备选/修订/确认审计/结构修复/恢复查询，分别展示阶段、本次操作和历史累计。adopt/undo/只读查询为0新调用；并发时间不能简单相加，缺失时间戳标未知。只改文字或测试计数断言不算完成。

## F05 / P0 作品回退：脚本模型切换丢失当前已采用构思

对应 QA-R11-005；准确关联 D11-10/12/28/30/32、Q11-02/09/10。原报告的 D11-24/27 是鉴权/声音UI，不能当作该回归证据。

- 序列：treatment 初稿→解释→备选→采用→点击确认、独审失败→只改 script model→保存→按人工版本继续生成。
- 当前稿从 3865aba4… 回到 f102c0db…，讨论/提案/采用记录从当前 review 消失，页面仍宣称“改脚本保留构思”。
- 证据：12-script-model-change-invalidates-treatment.png；快照保留原 completed 采用与 failed confirm 命令。

状态语义必须准确：用户发起 confirm 已证实，但该次审核失败，没有有效 StageConfirmation。修复必须保留“已采用但检查失败”的当前稿/历史/失败依据，不能补造已审核通过。另加“审核和确认已经成功”的对照场景，证明有效上游确认也不会因只改脚本模型失效。

源码核对：`production-pipeline.ts` 的 stage inputs、`seedJointPlanningThread()`、`confirmedCreativeReviewStage()` 和 `carriedCreativeReviewState()` 是主要检查点。当前 carry 路径要求 treatment 已 confirmed，不满足便放弃 seed；这对阻止未经批准推进是合理安全边界，但不能同时让同 run 失去仍合法的讨论草稿。是否因此退回旧初稿还须由“保存模型→新 input/thread→恢复→实际 stage 文档”组合测试完整定因。

修正：区分同 run 保留工作稿/历史与是否允许推进，按有效输入/上游依赖只失效实际受影响阶段。同 run 未变 treatment 的采用稿、消息、有效用户指令、上一稿和提案应可读且保持当前稿；原 audit 失败仍未通过。script 模型真的被保存后，下一个 script 调用才使用新模型，不自动重做 treatment。不将跨 run 草稿复用当作跨 run 确认/费用授权，也不拷贝不匹配 checkIdentity。

必须覆盖：等待态、检查失败态、有效确认态；仅 script/director 模型变化；核心要求/系列来源/对应 treatment 模型变化应正确失效；unknown 在途禁止切换重发；刷新/重启及两窗口并发。不能用手写确认记录或清 checkpoint 让测试通过。

## 尚未验证，不等于已复现缺陷

09:28最终报告已有三入口、模板CRUD、声音页面、390/1440布局、刷新等部分证据，不再写“Q11-03～12全部未测”。真正缺口是：真实报价三动作、媒体/预检/TTS/渲染、新成片、双真实审片、局部返工、热点正文成功并进入制作、系列第二模型完整正链、真实缺料负例、声音实际执行及依赖、双窗口/安全重启、真实素材和交付。逐项按最新Q11矩阵补测，不把已测UI或旧成片替代后半程。

R9 的模板强制职责、示意来源/连续性误判、视觉一致性与长耗时是历史回归种子。R10/R11 已改模板和讨论机制，不要求重复实施旧修复；当前是否仍出现必须由新构建真实正负样本和成片验证。旧素材 ¥8.75 不能当新片证据。

R11 已明确自然讨论没有产品总次数门。R9“单视频每角色终身三次”是历史待议方向，不能用旧记录覆盖新产品合同。

旧R10三个审计/临时probe只作回归导航：其规划补料和恢复问题已有后续修复证据；不能因为旧日志仍有错误文本就重新列为本轮已复现缺陷。以本包11项及当前新证据为范围。

## F06 / P1：同步模型任务结果不明，诊断未落盘，本地观察约43分钟

最新追加 QA-R11-006；D11-16/17/43/44、Q11-02/10/12。本包编写期间补读，不能遗漏。

- GLM 构思 producer 与独审成功，随后 script-draft 原请求 `agent-e9fc146b34379bc729eb6f0cfcce4ff30586ce59be714157986fc13d6287ed60` 进入不确定结果。
- durable：`.local/runtime/qa-r11-20260914-001/zai/tasks/.video-factory/codex-idempotency/zai/7942e4d5cb03394688f2cb63df9a3d00065417b968f68b6196bc7ef730f3e842.json`，state=accepted，无 outcome。
- 09:28最终报告：ZAI active/queued=0/0、completed/failed=2/1；run revision9已failed，confirm由08:38:08到09:21:07，42分59秒后本地停止。截图 `13-glm-script-accepted-unknown.png`、`38-desktop-run-recovered.png`。08:57快照中的running已过时；底层durable仍accepted/无outcome。
- `zai-code-plan-executor.ts:310–329` catch 路径仅把特定 ENOTFOUND/ECONNREFUSED 且未获响应头视为明确未受理，其它异常标 outcomeUncertain；`broker-server.ts:667–670` 收到 uncertain 直接返回，原accepted记录不保存此次failureDetails。查询知道“未知”，却没有原因、执行结束时间和可行下一动作。
- 已证实的是本地执行退出、durable丢失不确定失败诊断、本地约43分钟才终止观察且远端无终态；底层实际错误码与远端是否受理/完成仍未证实。不能写Studio永久running，也不能以Broker idle判断远端失败。

最小修正按 F03/F04 的同一诊断/状态链完成：

1. 核对已配置同步 API 的实际语义、是否提供可查询/幂等的远端请求身份；只用官方能力，不虚构查询端点或用散列requestId当远端taskId。
2. 保存不确定失败的安全分类、请求阶段、可取的底层code、headersReceived、执行起止、原request/binding与可查询性；保留现有accepted事实，不删除或伪造outcome。
3. “本地执行结束”“远端结果未知”“停止自动观察/等待人工处理”分开表达；用现有needs_human/干预与错误投影提供有界停止等待状态，保留原稿/当前版本，不占运行lease、不继续下游。不得只是再加一段更长超时；适用现有执行/观察边界，并记录为什么已无法继续自动获得证据。
4. 能查远端就只查询原任务；已证实未受理/明确失败走正式失败恢复；不能确定远端执行时禁止自动换ID、换模型重投或把unknown费用写0。历史没有诊断的accepted记录仍诚实显示未知。
5. 原报告建议“deadline后写terminal failure并允许新ID”，这只在能证明原执行已终止/未受理或产品明确提供承担重复执行风险的人工动作时才成立。**本包不授权把超时等同于远端失败；没有证据时先安全收口和报告。**若要新增“放弃未知并重新付费/提交”的产品能力，需要单独给出具体风险与最小产品决定，不在此偷偷实现。
6. 保留晚到成功/失败的原身份绑定：若本地已等待人工，迟到结果可被保存/展示，但不覆盖用户新稿、不自动解除暂停或触发新付款。

V10 同时验证四种前因：确实未发送、发送后无响应、已接响应头后断开、Broker完成落盘失败。不是所有 unknown 都属于同根因，不能统一降为可重试失败。真实复验只消费原任务或在证实输入/环境变化后按授权有界进行，不为造一次网络断连杀真实请求。

## F07 / P1：共享结构化执行故障同时阻断热点和系列

对应QA-R11-007；D11-01/39/40/42、Q11-06/07/12；与F03共用修复，不新增另一套executor。

- 热点request `agent-b46a59e555925e3cce731c7c85ee8fc6a1059caad63794d11338173067d529a2`，kind `topic-ideas`，Broker包装422/invalid_request，约11.543秒；系列首集采用的`role-audit`约10.502秒同类失败，HTTP采用接口500。
- 原图15/17/18；真实热点仅规则回退，已有`generationFallback=model_error`应保留；系列仍待采用。不能把规则候选写作真实总编已评估。
- 源码：`apps/codex-broker/src/task-definitions.ts:483`的TOPIC schema和`:939`的ROLE_AUDIT schema均含`uniqueItems`；`codex-executor.ts:884–903`将原schema直接写入并传CLI。当前`task-definitions.test.ts`所谓strict兼容检查主要验证object required/额外字段，不证明全部schema关键字被实际服务支持。**这是需验证的共同嫌疑，不是已经拿到上游拒绝码的定论。**

固定路径：

1. 沿F03保存安全拒绝依据，检查当前配置模型/CLI实际接受的structured-output能力，核对完整schema而非只查顶层required。只研究项目当前用到的模型，不升级工具。
2. 若证实某关键字/nullable形式只是不被服务端支持：在实际Provider输出约束边界转换，领域parser/validator保留原有唯一性、引用、容量与质量限制。不要删除业务约束来换取200。若原schema在通用来源处调整，显式证明宿主仍拒绝相同非法payload；更新受影响的descriptor/digest双端。
3. 对全部11类任务做离线输出schema/正式executor参数组合扫描，深层嵌套也覆盖；真实调用只用已计划的role-audit/topic-ideas复验，不为11类各发hello任务。
4. 热点/系列HTTP错误传到页面时显示实际失败环节、实际模型、安全原因、是否可重试与配置入口。对于确定合同拒绝不建议“稍后重试”；unknown只查原任务。沿现有Studio错误分类处理，不在UI按错误字符串重新猜类别。
5. 覆盖“生成部分成功但开拍复核失败”：候选/系列路线图保留、不自动采用、不丢原输入、不把500当可再次创建。主片的role-audit成功不替代topic-ideas正链。

允许模块：F03所列Broker/bridge/role边界及其正式测试；`candidate-inbox-studio.ts`、`trend-opportunity-agent.ts`、`app.ts`的相关错误投影、现有候选/系列面板。用V03/V04/V11证明；不另增Agent或放宽采用门。

## F08 / P1：正文网络callback与当前Node合同不符

对应QA-R11-008；D11-35～38/41/42、Q11-06。涉及安全网络边界，不能通过停用SSRF防护解决。

已核实的源码与新增定位证据：

- `trend-article-reader.ts:150–161`先通过默认`dns.lookup(all:true)`获取并校验所有地址，再固定首个通过的地址进入`requestPinned`。
- `trend-article-reader.ts:244`自定义lookup忽略`_options`，总是`callback(null, address.address, address.family)`。
- 本机Node v26.8.1的真实连接层调用lookup时传`{hints:1024,all:true}`，要求数组`[{address,family}]`；当前返回string产生`ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`，与9份缓存一致。下面是本次执行过的最小诊断（不访问外网、不调用模型；保留为失败证据，不写产品特判）：

```sh
node -e 'const net=require("node:net"); const s=net.connect({host:"vf-probe.invalid",port:9,lookup:(h,o,cb)=>{console.log(o);cb(null,"127.0.0.1",4);}}); s.on("error",e=>console.log(e.code,e.message));'
```

- `trend-article-reader.test.ts`现有用例注入整个`request`，绕过该lookup callback，故没有测到正式网络接缝。诊断脚本exit0只是成功捕获错误，不是产品通过。

固定实现：

1. 在现有requestPinned的lookup适配处按`options.all`返回Node要求的形状；地址只来自已经验证的固定集合。all=true即使仅一个固定地址也返回单元素数组，非all返回标量/族。保留原hostname/SNI，不能改为普通fetch重新DNS，不能全局关闭自动地址选择掩盖接口错配。
2. 保留全部解析结果的IP校验、每跳重定向重验、IPv4/IPv6/映射地址/内网拒绝、15秒/60秒截止、解压后2MiB限制、TTL及固定SHA。不要白名单测试域名或放宽端口/内网以跑本地测试。
3. 先补真实Node socket/HTTP callback形状红灯：可以控制DNS/底层测试连接，但必须执行生产lookup适配，不能又替换掉requestPinned。分别测all true/false、IPv4/IPv6、地址固定和TLS hostname；没有IPv6测试网卡时可用真实callback与受控socket，不把未建连接写成TLS全通过。
4. 响应/重定向/超限/取消后连接必须结束或安全释放；无效DNS结果应安全失败，不出现undefined内部异常。复用现有测试/端口，不造另一套爬虫。
5. 来源UI保留read/partial/title_only/blocked/failed含义；系统网络故障要有单独原因提示，不能只让用户反复“补来源”。成功读取也不等于事实核实通过。新获取不会修改旧run固定来源SHA，不清空历史缓存来制造通过；修正后正常TTL/force入口使用以实际接线为准。

允许模块：`trend-article-reader.ts`及测试、必要的`trend-opportunity-agent.ts`/来源DTO和现有来源展示组件；不加Redis/新爬虫/每文一模型。V12必须通过，真实Q11-06至少一篇正文核对与缓存复用；无法读取特定站点诚实列限制，不反复请求同URL。

## F09 / P2：声音节奏预设暗中改变演员

对应QA-R11-009；D11-25～27/34，Q11-09/11。

当前代码：`VoiceStudio.tsx:184–193`用`preferredProfileIds`选择可用声音，再经`update()`一并写profile/provider；两个预设都偏好Meijia，所以切回不恢复Tingting。`selectedPreset`只按rate/pause/mastering匹配，不代表用户明确选过演员。`template-voice-recommendation.ts`是现有预设数据，不因文件名包含template而整文件删除。

固定交互：

1. “内容声音方案”作为用户主动选择的节奏/处理预设，点击只改rate/pauseScale/mastering，不修改已经明确选定的profileId/provider。演员仍由现有演员卡独立选择；无需新增确认弹窗或撤销版本系统。预设文字改成“节奏建议，可调整”，无证据不能宣称已经专业校准。
2. 在现有演员卡/当前选择摘要显示实际Provider名称、执行方式（本机/已配置服务）及计费类型。MiniMax按量自动执行/后台记账，macOS本机；其它Provider按实际配置，不仅凭“云端”判现金。未知价格不编成免费，不引入逐句TTS审批。
3. **保留已有正确实现**：MiniMax已有相对语速说明、Kokoro已有停顿禁用/保留值说明。对照真实worker参数把摘要补齐，而不是新建另一份能力表；不写死所有Provider都精准字/分。声音质感如由本地后处理执行，应明确与TTS Provider控制项区分。
4. 保存前现有区域可读“谁来配/哪个服务/哪些参数有效/哪些未执行”；保存刷新、正在制作的配置应用/影响范围沿原入口，不一改声音就回退构思或重买媒体。未知/不可用演员不得静默写macOS默认来伪装保存成功；先证明现有不可用选择分支是否发生，再最小处理。

允许模块：`VoiceStudio.tsx`、必要的声音预设数据/现有shared DTO、ResourcesPage和现有新建/声音节点调用点；服务端仅在已有数据确实不足时补窄投影，不改TTS引擎/增加音乐音效。V13覆盖多个初始演员/不同预设而非仅Tingting特判；Q11-04验证真正执行参数。

## F10 / P2：模板暂停后复盘仍给错误行动建议

对应QA-R11-010；D11-19/34，Q11-11。

源码：`ExperimentsPage.tsx:76–112`首屏、下一轮行动、模板表现、空态、平台结果说明均仍把模板当当前生产变量。

固定修正：主要内容改为当前作品的终审、返工、制作阻塞及有证据的内容问题；技术中断与内容未过审分开，无成片样本显示“待样本”，不推断模板优劣/爆款率。不新增指标后端或平台数据接入。现有模板历史API/数据/CRUD保留；有真实历史样本才以“历史模板记录（暂停用于新制作）”次级区域展示，入口叫“查看模板资料”，无样本不放“调整模板提升下一条”的主引导。不把旧模板终审指标改名为全体作品指标，统计分母保持诚实。模板接口失败不能覆盖当前作品正常复盘。

允许模块：`ExperimentsPage.tsx`及现有组件测试，必要局部样式；无证据不改统计数据服务。V14覆盖无样本/纯技术中断/内容打回/有历史模板/历史接口失败。不得删除模板功能或恢复新生产模板使用。

## F11 / P2：设置搜索召回缺失

对应QA-R11-011；D11-19/23/34，Q11-11。

源码：`AppShell.tsx:87`按label/description/keywords包含查询；`:304`的SEARCH_DESTINATIONS只有宽泛/resources条目，没有声音关键词和子区域。实际入口已存在`ResourcesPage.tsx:409`的`voice-casting`，无需新页面。

固定修正：沿现有静态目的地索引补“声音演员与配音设置”→`/resources#voice-casting`，关键词覆盖声音/配音/音色/演员/语速/停顿；其它已有明确设置分区按其实际职责补必要索引，不制造全量搜索平台或模型搜索。素材库声音结果可以保留，但设置意图必须能找到实际设置。验证点击后对应分区激活、可见、焦点合理（尤其已在/resources同页改变hash时），返回/刷新正常；新增查询词不触发Provider调用。不写`if query === 声音`特判。

允许模块：`AppShell.tsx`目的地数据、ResourcesPage现有hash同步（仅测试证实有缺口才改）、已有搜索/页面测试。V15覆盖多个同义查询、无结果、键盘/Escape与390px，保留已有制作/机会/模板检索。

## 执行范围总则

优先扩展上述原模块和正式测试。F02/F04/F05允许必要的`production-studio.ts`、`production-pipeline.ts`、`creative-planning.ts`、`creative-review.ts`、`workflow-runner.ts`和当前UI；F03/F06/F07允许必要的Broker durable/client/role checkpoint合同联动。每个修改文件都要在RESULT关联F编号；不为了“小文件化”搬迁大模块。若当前源码已变，先核对并更新失败证据，不按本包行号机械修改。

已知架构问题是现有边界没有闭合（Provider协议/状态投影/草稿与确认身份/真实网络适配），**现有证据不要求推翻LangGraph、SQLite、WorkflowRunner或另造生产流程**。最慢的约43分钟主要是无结果后的观察等待，不等于模型持续推理43分钟。其它真实模型耗时必须拆阶段取证，不能缩prompt、降强度或硬裁镜头换速度。
