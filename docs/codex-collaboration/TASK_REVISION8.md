# 当前执行任务

- taskId: VF-R3-CLOSURE-20260912-01
- revision: 8
- status: CHANGES_REQUIRED
- 仓库：/Users/jinkun.wang/work_space/veidofactory
- 协作目录：/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration
- 审查窗口维护 TASK/REVIEW；执行窗口实现、验证并追加 RESULT。尚未自动启动执行窗口。
- 上一任务原文已归档 TASK_REVISION7.md，不重新实施其中已通过的修复。

## 目标与工作方式

目标不是让两个特定题目过审，而是让合法配置能启动、质量规则不互相抵消、不可在当前角色解决的问题及时交回用户，并用一条真正可制作的新片验证共享后半程。

一次完成四个共同根因的修复，集中回归、最终构建、真实本地 QA，最后统一报告。不每完成一个文件或子项等待审计。QA 期间只记录，不能边测边改；确定性测试阶段允许正常红绿迭代。

不重做 A/B/C；不增加新框架、数据库、缓存、第三个审计模型或新顶层 run 状态。不能对题材/镜号/runId/某个模型名称打补丁；不降低模型、思考强度、事实要求和创作品质。

## 必读与开始基线

完整读取：

1. 本 TASK 与 REVIEW_REVISION7.md。
2. RESULT.md 的 Revision 7 执行记录及之后追加内容。
3. docs/qa/videofactory-real-local-qa-20260913-06.md。
4. ACCEPTANCE.md（重点 G01/G03/G05/G06、E01–E07）；PROMPT_REVISION.md 中相关角色职责按需核对。
5. evidence/r7-capability-contract-review.mjs、r7-series-trace-review.json、r7-review-checks.json。

基线：evidence/r8-start-baseline.json，324个产品/测试/配置路径；HEAD预期570fe6e。现场核对 git status/HEAD/当前源码，所有既有dirty修改保留。基线仅用于区分本轮变化，不能以整个HEAD diff冒充本轮工作。旧JOURNAL是历史背景，本协作阶段统一追加RESULT，不新建另一套进展记录。

原样重现：
```sh
VF_REVIEW_CAPTURE_RUN=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
```
审查时6项：3通过/3失败。两条是同一个画幅合同问题，一条是空Canon问题。源/dist一致。若历史QA run不存在，通用目录与Canon测试仍须跑；另建立去身份化的等价正式入口fixture，不伪造原记录。探针的测试替身只允许在隔离测试，不接到真实Studio。

## F01：正式能力目录与Broker三个规划入口闭合

允许主要修改：Broker输入校验/descriptor，pipeline对应pin，必要的能力类型/投影，正式目录与三个规划角色的组合测试。

事实：Studio和pipeline正式视频能力允许五种画幅；Broker requireProductionCapabilities 只接受三种。启用Seedance后连文字构思都会400。

实现：

- 区分“Provider支持的画幅集合”和“本次项目要输出的画幅”。能力集合接受当前正式目录支持的五种值；未知/非法比例仍拒绝。本任务不扩展产品可创建的输出画幅。
- 核对同族deliveryTypes、时长边界、reference支持和可选模型字段在正式目录→能力摘要→treatment/script/director→parser的真实传递。不借机扩大合法值。
- 规则变化同步task边界语义版本、descriptor、health、pipeline pin、相关role合同/阶段身份。不能只修改hash或动态信任服务端hash。
- 不禁用Seedance、不删掉合法能力、不用任意字符串绕过校验。不要将诊断对照里的“移除Provider”当修法。
- 旧durable/checkpoint不改写；合同升级按已通过的原操作结清、当前标准重审机制处理。

红灯/验收 V8-01：

- 正式目录全部已声明模型画像，空/单Provider/混合选择；经过三个正式角色适配器及正式parser。矩阵从目录遍历，不复制一套测试画像。
- 实际QA原始input经ProductionPipeline/client/真socket，最终进入隔离executor恰好一次；移除Provider只作对照，原选择也必须成功。
- 3:4/4:3能力合法，未知比例失败且executor=0；错误digest/绑定仍拒绝。
- 十类任务保留现有正式边界覆盖。source及最终dist各跑关键组合，不用health200代替发起合法任务。

## F02：空事实的系列合同一致到终审

允许主要修改：codex-screenwriter、task-definitions、production-pipeline中脚本物化/最终review校验、确需的系列事实提取及对应测试。

语义已明确：系列canonFacts必须是数组，可以0–8条已建立事实。没有新增事实就返回[]，不能编造或把计划当事实凑一条；非系列保持既有空数组行为。空本集新增事实不能清掉以前已定版Canon。

- 同步生成提示、Schema、host validator、审计上下文及下游脚本/终审守卫。
- REVIEW已指出约9000、9216行两处后段非空守卫；必须查完整调用链，不能只解除编剧的一处限制。
- 原有1–8条有效事实仍正常；不接收缺字段/null/非数组/超上限/虚构事实。不得为了空数组绕过终审、清空系列历史或解除来源要求。
- 更新相关合同摘要/身份，保留旧产物，不迁移用户记录。

红灯/验收 V8-02：

- 系列输入accepted Canon为空且本集是无新增事实的表达，[]合法，不触发validation-repair额外调用。
- 同一内容按非系列/系列两种入口验证，不依赖具体题材。
- 0/1/8/9条、缺字段/null/非法项边界；脚本文件→物化→最终审查→系列记忆提取的正式行为验证。
- 无新增事实的本集完成不会删除上一集事实；有新事实仍只能在既有正式接受边界进入Canon。
- 本次真实日志里的“至少1条”结构修复不再复现；不能直接抹掉历史错误来证明。

## F03：让非局部质量阻断进入现有规划控制流

允许主要修改：role audit的合同/解析、role-agent-loop；treatment/script/director适配器；creative-planning与production-pipeline窄接线；现有规划展示/编辑/动作投影及对应测试。不改媒体执行器，不新建工作流平台。

技术方案：

1. 复用已有独立role-audit，不再增加模型调用。为规划角色的审计增加可机器读取的处置，例如 `planningDisposition: null | {action: "revise_here" | "needs_source" | "needs_user", issueIndexes: number[]}`。名称可按代码风格微调，语义不能另选。
   - pass时null；repair时明确是当前角色可修还是需要外部前提。
   - 指向非局部处置的issue必须存在、为blocking，且范围由宿主限定在规划角色。普通非规划角色不因此新增自动路由权限。
   - Schema、validateRoleAudit、trace/checkpoint、客户端类型、prompt/criteria版本同步。规划当前合同必须有显式处置；历史缺字段不能伪造为新合同已认证。其它角色保持原有职责。
2. 宿主消费处置，不用匹配“上游”“手机”“实验”等自然语言关键字来决定路由。
   - revise_here：继续现有有界质量修订。
   - needs_source：当前核心兑现依赖尚未具备/不可取得的事实或专属媒体来源。
   - needs_user：需要更改用户已锁定承诺、路线或作出其它不可代替用户的选择。
3. 非局部处置在**再次调用同角色produce前**保存候选、审计与原任务身份，并传播到现有PlanningIssue/PlanningHalt。复用needs_source/needs_user和现有规划编辑入口；不当网络失败、不切backup、不重跑上游，也不能把候选伪登记为已通过的完整制作方案。
4. 构思仍可表达有条件方向，但独立审计必须区分普通后续可得性与无法由现有流水线解决的核心前提。已明确需要用户真实采集但没有相应输入/能力的方案应提前停；不能仅把问题塞进feasibilityQuestions就继续生成数轮完整脚本。
5. 构思的produce/audit使用相同版本的必要用户约束。补齐当前漏掉的visualProof/visualPlan等已存在输入的精简明确投影，并将其纳入阶段身份；不要再复制整份庞大模板。事实来源只传当前确有依据的记录；没有来源就明确空缺，不新增上传/搜索服务、不把来源标签或参考风格当证据。
6. 页面显示具体缺什么、谁来决定、原承诺和建议；“调整方案”使用现有编辑入口预填建议供确认。不得自动把实测改教程；同输入/同未解决前提的“重试”不再新增模型任务。用户真实修改输入后按既有依赖闭包推进，不能永久禁用恢复。
7. 暂停、accepted/unknown只观察原任务、合同升级结清、lease/CAS、局部返工绑定都保持。不要新增终身调用限额，也不把用户等待时间限制变成质量缩水。

分类矩阵（必须同时测反例，防止全部误拦）：

| 条件 | 预期 |
| --- | --- |
| 普通可搜索图库尚未下载，核心承诺可由现有路线兑现 | 可继续，不因为“还没素材”一概停 |
| 机制示意/情绪表达允许AI，不声称真实实验 | 可继续，不强制搜新闻或提交真实采集 |
| 真实受控实测承诺，无专属证据/采集能力 | 首次明确识别后needs_source，同角色不再produce |
| 改成教程会改变用户锁定收益 | needs_user，编辑预填但必须由用户确认 |
| 仅措辞/节奏/镜头职责可修 | 保持本地有界修订，不把工作推给用户 |
| 已有有效来源和相容能力 | 正常通过；有来源并不自动证明所有声称 |
| 调整方案确实解决外部前提 | 仅失效真实受影响阶段，保留可复用产物 |
| 同输入重试/刷新/进程重启/重复点击 | 原halt与理由保留，不重复模型或购买 |

失败证据/验收 V8-03：

- 先用本次persisted checkpoint重放或等价有限fixture证明：当前收到非局部反馈后仍会produce到第三轮。不要真实重复跑13分钟来建立红灯。
- 新行为从正式角色适配器→role loop→规划图→ProductionPipeline→Studio状态/动作被消费；不是只测裸parser/给FakePipeline抛一个错误。
- 非局部首次审计完成后后续produce增量=0、backup=0、media/TTS=0；重建后仍0。
- pause/查询和用户改输入后恢复不受破坏；pending原请求必须先结清，不能遇到新合同直接遗忘。
- 缺来源的构思即使表达质量评分高也不能推进到不可执行脚本；同时可制作正例必须正常推进，不能用一律fail-closed假通过。

## F04：失败详情与耗时解释不再丢失

允许主要修改：Broker安全错误元数据、client/role-loop/节点receipt、Studio现有诊断投影及小范围文案；不新建日志系统。

- 保留受限脱敏诊断：reasonCode、已知字段路径、HTTP状态、kind/requestId、执行是否已受理。用户摘要仍通俗，技术详情可展开。
- 不记录凭据、整份prompt/图片/任意原始上游响应；未知用户字段名等也不能未经限制透传。
- 400字段错误经过完整管线并刷新/重启后仍可定位；不能让“请查看诊断”指向空信息。与503可重试、accepted_unknown、completed_failure分开，不能改变安全分类。
- 当前UI区分“质量轮数”和实际produce/audit/结构修复调用，使用已有phaseAttempts/trace，不写虚假预计完成时间。
- 编剧审计上下文提供宿主计算的候选总时长、场数、范围合法性、当前Canon规则等确定性事实。数值合规由代码判断，模型集中判断信息密度/可读性等语义，不再手算制造返工；不能按审计中文措辞自动忽略blocking，也不新增审计模型。
- 暂停仍以当前既定节点边界工作，本轮明确说明其边界；不要另做中断Provider/终身三次预算。后续是否改细粒度暂停单列风险，不借本包扩大范围。

验收 V8-04：

- 故意非法比例在正式client/role/节点/Studio保留字段级安全诊断，executor=0；错误信息中植入伪造密钥/路径的脱敏反例。
- 34秒候选的host时长事实精确为34，两端使用同一durationRange；超范围由现有硬校验拒绝。
- 1 produce+1 audit、结构修复、原任务查询、恢复几个场景调用统计一致；观察/查询不增加执行次数。
- 这些信息不替代真正成片质量门，不保证模型所有语义审计都会正确。

## 集中验证，不用多一轮审计代替测试

先聚焦V8-01–04建立红灯再集中修复；测试纳入正式package scripts。所有相关旧失败必须如实报告。随后统一：

```sh
npm run test:ts
npm run test:broker
npm run studio:test
npm run typecheck
npm run build
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_CAPTURE_RUN=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
VF_REVIEW_CAPTURE_RUN=1 VF_REVIEW_DIST=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
npm run test:package
git diff --check
```

原39项恢复安全门与52项四适配器测试保持通过；具体命令见r7-review-checks.json。同一Node/ABI，不删除数据库解锁。Python未变可引用已有131/131并注明；如改媒体/Python则运行既有unittest，不额外安装测试框架。

必须在真实QA前独立覆盖共享后半段：从经正式接口/流程获得的合法规划开始，用隔离依赖验证报价三动作、授权范围变化、媒体/TTS/渲染边界、双审结果消费和局部返工。复用现有合同fixture与正式管线，不手工修改生产状态，不把这种组合测试叫真实E2E。

## 最终真实本地QA：正例贯通，负例早停

确定性门和最终dist组合通过后，部署真实本地环境再进行一轮qa-only。没有中间人工审计关卡。完整读取当前QA/浏览器Skill；现场核对三服务PID/cwd、两个socket、dist、在途任务，安全正常重启，保留历史workspace/durable/登录，不打印密钥。不能照抄RESULT里的PID。

有限样本分工：

1. **正例主片**：先选择当前真实能力足以兑现的创作方向和匹配模板（可为机制示意、视觉表达等，不依赖并不存在的专属实测素材）。仍要求明确观看价值、开头吸引/中段推进/结尾兑现。走到真实报价、精确授权、媒体、TTS、渲染、同SHA两个真实模型审片及必要局部返工。不能手写导演结果、关闭质量门或用纯说明卡过关。
2. **负例**：缺真实实验来源但锁定实测承诺的方案，验证及时反馈和零额外无效重写。不能要求此输入无条件出片。
3. **另两入口**：系列/热点到真实方案和报价；热点先检查合法来源样本，来源不足是正确阻断。若当前确无合格来源，准确记录不可验证，不反复刷新凑样本。
4. 用上述少量run分配覆盖E02报价三动作、E06暂停/查询/刷新/重启/1440与390、E05建议预填与实际依赖范围。已过且未改的模板CRUD/搜索只短冒烟，不重拍几十张无关截图。

费用继续既定授权：可自行确认合理小样本精确报价；新增媒体+TTS按¥50测试止损（不是产品硬上限），每笔记录价格、范围、Provider taskId/结果及累计费用。超过止损报告覆盖目的与所需金额；不擅自花几百元。文本/订阅审片不额外现金审批，TTS自动但后台记账。

同路径同根因失败最多验证一次受控恢复（必须前置条件或证据已改变）；再次同因失败停止该链，继续可独立项。accepted_unknown只查原任务，不换ID/backup。不能无限建run、换题/模型碰运气，也不能因为一个负例正确停住就结束整轮。

报告每个问题：复现步骤、实际与预期、错误字段/码、已证实原因与假设、已排除项、受影响路径、模型/媒体次数与费用、截图/日志位置。耗时拆到queue/produce/audit/validation/观察，内部阶段没测到就写未知。真实质量失败仍如实失败。

## 完成与停止

- RESULT追加Revision 8：相对基线的真实文件变化、V8-01–04证据、集中检查退出码、E01–E07各状态、每笔费用、未验证/新风险，附唯一新QA报告。
- “指定修复完成”“QA执行完”“产品验收通过”是三件事；READY_FOR_REVIEW不是ACCEPTED。没有新成片时绝不能说全流程完成。
- 产品/测试实现及本轮QA全部完成后停止，交审查窗口一次审查。真实QA里发现的新问题集中交回，不边测边改。
- 未经当前用户新的明确授权，不commit/push/云部署/外部发布、不删迁移用户数据；不改TASK/REVIEW或历史完成记录。
- 不重开pi/Claude/Copilot协作或修改工具；执行端使用用户当前配置，不擅自降低模型/思考强度。
