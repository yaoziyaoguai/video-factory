# Revision 10 验收与有界测试

任务：`VF-DIRECTOR-CLOSURE-20260914`。以下是待执行的验收要求，不是已经通过的报告。仓库根 `/Users/jinkun.wang/work_space/veidofactory`。

## 1. 三层证据，不能互相代替

1. **确定性行为**：真实 Studio/Pipeline/Broker/socket/checkpoint 组合，外部模型/媒体执行依赖可使用隔离替身。证明合同、路由、授权、恢复和时间轴。
2. **真实模型语义**：正式构思/编剧/导演及其独立审计实际理解了正负输入；替身返回 pass 不能证明这一点。
3. **真实产品体验**：当前 production build 经浏览器生成一条新片，实际媒体、配音、渲染、双审与受控返工有证据。旧样片、只有 health 或全部单测绿色不等于完成。

每项记录 PASS / FAIL / PARTIAL / NOT_VERIFIED / WAITING_AUTHORIZATION，带证据路径和限制。不允许为消除红灯修改验收预期。新产品决定导致的旧测试变化须逐项解释。

## 2. S0 与模板停用

### V10-01：当前半成品收口

- 记录开始 HEAD、status、staged diff，与 evidence/r10-handoff-baseline.json 比较。缺失或不同先读实际差异，不回滚。
- 对 S0 列出的悬空引用、被删 service option、模板回注分别记录真实编译或行为失败。保留 R9 与上窗口修改。
- 本轮结束不得遗留引用不存在的导出、只在测试里恢复已停用选项、或只改 source 不构建 dist。

### V10-02：三入口不依赖模板

- 热点、系列、自有想法各验证：模板目录正常、空、读取失败，新制作均不请求/依赖模板选定；实际请求没有 template/templateSnapshot/templateGuidance。
- 无 visualPlan 时不制造默认硬 beats；visualIntent/visualProof 原样传至对应 produce/audit。建议与原文冲突时不覆盖。
- 真实缺来源、无就绪画面能力仍按原规则阻断；禁止为过此项把整个入口门禁删掉。

### V10-03：直接调用也无模板暗路

- UI 以外的 Studio API 与 Pipeline 新任务输入含旧 template/templateSnapshot，也不能触发模板查库、角色指导、身份绑定或默认声音/模型变化；有效输入投影不含模板，并有诚实未应用提示。
- 除已知模板弃用字段外，未知键/非法值仍拒绝。Broker 新 POST 不再接受旧模板指导字段；producer、audit、修订请求没有残留。

### V10-04：原功能与历史保留

- 模板创建/编辑/删除的原安全交互仍在，制作入口提示暂不应用。此测试只用隔离测试数据，不删真实用户模板。
- 历史快照只读可显示，原文件/账本 SHA 不变。已有系列 bible/canon、用户模型/声音选择、技能下拉、参考语法、搜索/素材库仍可用。
- 静态正式片尾/文字卡可被主动规划；stock/generated/reuse 失败绝不降级成内部说明卡。

### V10-05：在途与局部返工

- 旧合同任务 accepted/unknown 时模板退出或服务升级：仅观察原 requestId/binding，新增 POST/create=0；迟到成功/失败各能被持久化消费且并发只推进一次。
- 旧产物不自动取得新规则通过资格；下一新执行用新规则，不运行第二套旧流程。
- 新派生返工不继承模板指导，但 sourceRun/revision/findings/previousScript/directorPlan/affectedScenePositions/source SHA 的校验仍在。
- 文字要求总时长改变但未勾选相关镜头：不扩大 scope、不改未选镜；UI说明保留时长并允许用户重新选择。母片缺证据不自动新购。

## 3. 角色与语义

### V10-06：同一依据和依赖身份

- 捕获三个正式 adapter 的 produce/audit 请求；双方看到同版本用户要求、时长、真实能力、上游构思/脚本、相关返工范围。不要只测 payload 字段存在，要断言具体值与当前用户保存值一致。
- visualIntent、真实模型或被消费的能力改变时正确失效；字段顺序、实时计数、无关模板管理变更不改变创作输入 identity。
- 至少从正式 ProductionStudio → ProductionPipeline port 捕获一次，而非只手写一个 adapter 输入。

### V10-07：纯示意可制作、真实举证不放水

测试输入作为数据成对变化，至少覆盖艺术隐喻、普通机制示意、生活技巧说明三个不同领域；每类都有“不冒充真实结果”和“声称真实专属记录”版本。再变换中文否定、同义改写、是否出现相同题材词，不能按词命中来放行。

- 纯 illustration_only/not_needed、来源为空、允许的生成能力存在，不被 sourceIds=[] 拦住；仍需质量审计。
- 用户只允许生成，候选误选不存在/不允许的图库：host revise_here，当前角色修订；不是询问上传实验材料，也不能当 pass 直接进编剧。
- critical factual/external 或缺真实 supplied 绑定：即使模型96/pass，也首次审计后停在明确缺料，script/director/media 增量0。只有部分材料仍不满足核心事实。
- factual_support/not_needed、越界 sourceId、伪造 retrievalProviderId 的结构/路线分别拒绝或修订，不由归一化捏造来源。

### V10-08：审计纠错不等于绕过宿主

- 候选误分类 → host needs_source → audit repair/revise_here + 有效 misclassifiedIssueIds → 只发生有界候选修订；新候选同时经 host ready+audit pass 才继续。
- 未覆盖全部 source/user 阻断、用户核心承诺仍需外部材料、audit needs_user/needs_source：不得继续。单纯高分/空理由不能绕过；语义证据由真实样本另验证。
- host revise_here+audit pass：原 audit 保存不变，生产者收到明确宿主修订反馈；无直接放行。
- 非空纠错数组配 pass、未知/重复id、错误角色使用、字段遗漏/格式错：新合同拒绝，结构修复有界，不随机转 ready。
- 持续误分类耗尽现有次数即停止；不新增3轮、不删用户要求、不复制 run 重试。

### V10-09：新增纠错信息可恢复

- 分别在 candidate 持久化后、audit accepted 后、audit 已完成但消费前、需修订尚未开始时重建实例。
- hostReadiness/hostReadinessReview、原始审计、有效反馈和剩余轮数完整保留；同输入不重做已完成物理调用。旧原审计不伪装新字段已经通过。
- 使用真实 socket、持久化和正式 role loop 的组合测试，不能只 JSON 序列化一份手工通过状态。

### V10-10：付费前全片导演检查

至少三类方案：

- 必须同对象连续变化：有合法母片/源区间关系才可编译；没有实际机制的“风格一致”声明不足。跨母片仅免责声明不能放行。
- 同风格独立镜头：可分别生成，但具体提示落实视觉圣经，不能要求精确身份。
- 连续主片 + 独立静态结尾：无身份依赖时可行；改用其它时长和场景序号同样成立，不针对15+5秒加规则。

确定性层验证实际导演上下文、关系/范围/能力校验和 audit 处置进入正式规划；自然语言是否判断正确由 E10-01 验。不能用手工写好的“正确导演回复”声称模型已学会。

### V10-11：既有时间轴与引用安全

单/多 temporalBeat 均可；覆盖合法、无空洞/重叠/越界、payoff位于实际使用区间；静态 sourceIn=0。非零源起点、跨镜复用最远终点、额外生成尾部裁切遵守原合同。超出能力的参考关系不因 supportsReferenceImage=true 泛化放行。局部返工保留未修改镜头/产物绑定。

### V10-12：归因与卡片禁令

图库 no-match → 池内有界改案/明确能力不足；不凭空 needs_source 说缺专属实验。方案整体无一致性机制 → 上推导演；可行方案单镜偏离 → 素材返工；not_observed → 补看已有媒体。三类反馈预填对应节点并保留 scope，任何分支都不自动扩大购买或偷偷塞卡片。

## 4. 声音、恢复和性能

### V10-13：音频能力诚实且保留功能

隔离测试三种现有配音 Provider 的 audio 投影与真实 adapter调用相符；musicTrack/soundEffectsTrack 不伪 true。voiceTiming进入编剧/导演/审计，用户voiceDirection不被模板覆写。

不支持的可选音乐/音效不是硬门；模型擅加必需音效应在本角色修订，用户确需核心未支持能力要明确反馈。没有新增声音模型任务。音色/声音处理单独变更不重跑构思/视频；rate/pause与能力的变更按实际消费者失效。

### V10-14：真实 worker 交接到正确时间轴

使用正式 workerNode validator→worker 的录制边界，检查 executablePlanPath 是否保留，并用脚本原时长与 executable plan 不同的输入证明最终按已接受计划执行。不能只断言 getInput 返回了这个字段。

Python 测试验证每场自然语音、停顿、已有 mastering、计划总长与输出音轨；不靠音频截断/强制加速。缺文件/不匹配的产物绑定不能用旧声音冒充当前版本。

### V10-15：声音过长与恢复

超长语音返回 VOICE_DOES_NOT_FIT，raw audio路径/SHA、失败原因和可行动建议保留；没有继续渲染“成功片”。用户修改旁白/范围后走现有恢复，未受影响媒体不重购，追加需要素材才新报价。语音费用仍自动后台记录，不加人工核账流程。

### V10-16：模型切换是真执行切换

完整UI保存→服务端revision→stage失效→实际port调用证据：改编剧仅复用构思，新的编剧/导演按正确模型执行；改导演不重做上游。草稿未保存、保存失败、并发revision冲突、accepted_unknown均覆盖。仅看新模型标签或200响应不算通过。

### V10-17：终态与重启

生产组合覆盖编剧首produce无候选失败、audit失败、受理后迟到成功/失败、持久化异常、暂停与恢复。completion真正settle、run失败/暂停/成功状态准确、lease释放/保护有效、上游不重跑。查询刚好完成返回当前状态；输入身份变了仍拒绝旧结果，不能吞掉全部409。

### V10-18：统计和进行中费用

用多个角色、一次回退、多份累计快照与恢复后调用构造等价数据：按物理身份计数不漏不重复；结构修复是子集；查询0新增；unknown单列；历史/本轮/继承分清。进行中已物化一镜和已确认一笔费用就能显示，不等整个assets完成。重启后累计值一致。

### V10-19：性能无损、归因有据

- 记录发送前/后的 payload 文本字节、实际图像集合hash/数量/映射、模型及effort、生成/审计用时字段；证明没有删除必要证据与当前约束。
- 若移除重复base64/嵌套历史，断言一份视觉证据只通过正确通道发送一次，但两个独立审计请求仍各有完整证据。
- 无细分时间标 unknown；不能用phase墙钟和providerWait双加。accepted_unknown不报未受理，既有 deadline 到达时不重POST。
- 真实加速需要授权下的可比请求证据。最多一组同模型/同证据前后对照，不无限benchmark。无真实对照只能写“冗余减少/统计修正，实际提速未验证”；两次差异也不是统计SLA。

### V10-20：可用性

1440px/390px、键盘和屏幕焦点验证：三个入口、模板暂停提示、用户要求/素材方式/模型选择、制作进度、声音设置、报价/调整/暂停、返工范围和失败恢复。原主流程/技能下拉/声音自动执行保留。内部错误可展开，主要文案包含具体问题与可选下一步；不能出现不明所以的解锁扣费动作。

### V10-21：全部协议与正式组合

三个规划角色、role-audit、新audio/voiceTiming/hostReadinessReview、新旧任务查询边界的实际请求交正式 Broker，OpenAI/ZAI均覆盖。正常payload被接受且不丢字段，未知字段/错digest/错误引用在executor前拒绝。

COMMON_ROLE_PREAMBLE变化后10类task的descriptor、pin、health一致，source/dist一致；不能只验证一条health。新增样本覆盖首次、修订、结构修复和恢复。

同时运行正式计划→报价三动作→授权→媒体/TTS/渲染→双审→局部返工的隔离组合：未授权create=0、unknown不能新买、同证据不同模型、未受影响资产不变、局部不变全片。不得用只支持新fixture的fake流水线代替正式链路。

## 5. 测试落点和命令

优先扩充现有文件，不增加生产替身路线：

- 模板/入口：`apps/studio/test/client.test.tsx`、`studio-service.test.ts`、`api-contract.test.ts`、`production-joint-rework.test.ts`。
- 角色/语义宿主/身份：`packages/production-pipeline/test/creative-treatment.test.ts`、`role-agent-loop.test.ts`、`creative-planning.test.ts`、`production-planning-closure.test.ts`、`visual-director.test.ts`、相应codex adapter测试。
- 恢复/配置/统计：`apps/studio/test/text-task-production-recovery.test.ts`、`production-planning-editing.test.ts`、`production-planning-stages.test.ts`、`node-workspace.test.tsx`及现有恢复UI测试。
- 合同：`apps/codex-broker/test/task-definitions.test.ts`、`codex-executor.test.ts`、`zai-code-plan-executor.test.ts`、`topic-script-contract.cross.test.ts`及既有durable测试。
- 声音/下游：`tests/test_voiceover.py`、`packages/production-pipeline/test/production-authorization.test.ts`、`production-planning-publication.test.ts`、时间轴/渲染相邻测试。

聚焦命令按实际修改的测试选择；Node测试可用 `node --test --test-concurrency=1 --import tsx <正式测试路径>`。Studio Vitest必须使用该workspace配置，不能从根目录裸跑而错判document不存在。记录实际Node/Python与native ABI，环境不匹配不能统称产品失败。

全部实现后串行执行会清同一dist的检查，不改package scripts来隐藏失败：

```sh
npm run build:pipeline
npm run test:ts
npm run test:broker
npm run studio:test
npm run typecheck
npm run build
npm run test:package
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests
git diff --check
```

最终build后运行已有source/dist探针，并补齐V10新合同正式用例：

```sh
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_CAPTURE_RUN=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
VF_REVIEW_CAPTURE_RUN=1 VF_REVIEW_DIST=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
node --test --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
VF_REVIEW_DIST=1 node --test --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
```

R9探针含旧templateGuidance合同，应将对应预期明确改成“新生产不传/不接受模板指导”，保留其它边界。旧15/6/4项通过不等于新字段被覆盖。相关未被package收录的测试补跑并列明，不扩大到清理全库孤儿测试。

每条检查保存完整终态/退出码，超时、截断、未知退出码不算PASS。已有skip说明原因，不用新增skip消红灯。

## 6. 授权后的真实本地 QA

使用执行窗口当前安装的 QA 技能（测试阶段用只报告模式）；执行前完整读取该Skill。若Skill默认边测边修，本任务优先：同轮只记录，集中修复后再复验。不得据旧对话推断新媒体金额授权。

### 6.1 部署前门

先核对当前PID/cwd、在途任务及归属；不要杀在途媒体任务或删workspace“干净启动”。使用最终production build、现有正式启动配置、**绝对**workspace和两个socket，核对真实模型/effort和10类合同。凭据只在获授权的配置加载路径使用，不打印/附到报告。

健康不等于角色可用；一条正式合法任务才验证模型链。合同/模型身份不符就停该链并记证据，独立UI项继续。不部署fake broker，不手改run文件解锁。

### 6.2 最少但有代表性的样本

- 两个真实文本模型各一组正/负语义输入，提前写预期。正例选不同领域，允许示意/实际支持的制作方式；负例明确要求缺失的用户专属事实。正例之一作为主片继续，不为每个节点再开一个新run。
- 三入口尽量分配到上述样本；额外最多一个入口样本只到方案/报价。热点确无合格来源则如实BLOCKED，不伪造新闻数据。
- 主片覆盖已支持的生成视频、生成图片或母片复用关系中的实际需要，不为覆盖率硬塞媒体类型。缺的执行分支先以确定性组合验证，必要的额外真实调用须在本轮QA计划和额度内说明。
- 独立结尾与连续身份的对比可先在报价前验证，不强迫购买两部片。真实图库无候选记录路线问题，不反复换十个题直到过关。

### 6.3 E10 产品验收

| ID | 必须留下的真实证据 |
| --- | --- |
| E10-01 | 正例不被模板/误分类/假连续性阻断，负例首次有效构思审计后真缺料早停；保留实际输入、候选、audit、host处置与调用身份。 |
| E10-02 | 三入口正确表达用户要求/系列/来源，模板缺失不挡路；至少主片有正式已接受方案与报价。 |
| E10-03 | 报价未确认create=0；调整方案、暂不继续、确认后继续三动作按真实状态可用；增购重新报价。费用授权与消费分列。 |
| E10-04 | 主片正式媒体→配音→渲染，各产物/taskId/账本/使用区间绑定，保留运行中完成进度；不是只在Provider平台成功。 |
| E10-05 | 当前新成片，同一证据集合/SHA由两个不同真实审片模型独立评审，技术检查和人工终审入口有效；不伪造第二模型或把报告pass当作品pass。 |
| E10-06 | 实际审片建议预填到责任节点、范围可理解；若新片没有缺陷，用明确标为QA编辑的局部修改测试恢复，不伪造finding。未改素材复用，新增购买有新授权。 |
| E10-07 | 模型保存后实际路由、暂停/继续、一次合法原任务查询、刷新/Studio安全重启保持状态，1440/390布局及关键文案可理解。危险竞态只在隔离测试制造。 |
| E10-08 | 实际播放完整新片及音轨，核验全程画面、动态总长、字幕/声画同步、旁白完整、视觉一致性、文字污染、开头吸引/推进/结尾兑现；无听觉能力则听感NOT_VERIFIED。 |
| E10-09 | 各阶段调用/耗时/费用能与持久化证据对齐；无损精简有前后可比数据，若实际仍慢如实列出，不改模型强度/删证据冒充改善。 |

### 6.4 止损

- 同输入/版本/证据未变，不重复生成碰运气。正常产品有界修订允许；人工重试必须有条件变化和原因。同路径同根因再次出现，停该链并继续独立可测项。
- accepted_unknown只观察原任务，不能换ID/模型重提；不要靠重启“确认没扣费”。已运行任务按现有deadline观察并保留未知状态。
- 新增费用上限由执行窗口本次明确授权决定；已发生+拟购买+未结清最大暴露不得超出。历史¥50不是本轮授权，也不是产品默认上限。文本订阅/审片不额外弹现金审批；TTS自动记账但计入本轮QA现金暴露。
- 一轮QA先汇总，再集中修本范围问题，回归后一次必要复验；仍同因失败带证据交回，不无限新轮。若需要新产品能力/改核心语义/额外权限，说明最小决定并停受影响工作。

## 7. 交付格式

RESULT.md 末尾追加 Revision 10，统一记录，不覆盖历史、不另起第二份状态台账：

```text
taskId / revision / status
开始HEAD、分支、基线差异；实际模型/effort、Node/Python
S0–S5：根因、修改文件、保留的旧能力、必要偏离
V10-01–21：状态、测试名/完整命令、终态/exit、证据路径
E10-01–09：状态、run/operation/request身份、真实证据或未验证原因
费用：实际、新增在途/未知、最大暴露、授权依据
QA问题：复现、影响、已证实根因/假设、排除项、是否条件变化后复验
最后build和服务/在途状态；当前成片/审片/返工证据
CODE_VALIDATED / QA_DONE_WITH_CONCERNS / PRODUCT_ACCEPTED 分别说明
```

新QA报告：`docs/qa/videofactory-real-local-qa-<实际日期>-r10.md`，截图/安全日志放同名assets目录；不覆盖R9证据，不包含秘密。

没有权限可以完成代码和确定性验收后标真实QA WAITING_AUTHORIZATION；没有完整新片、双真实审片、必要声音/返工证据，产品验收不能写通过。READY_FOR_REVIEW只表示交回审查，不代表全部验收通过。
