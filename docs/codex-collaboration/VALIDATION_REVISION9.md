# Revision 9 验收与有界真实 QA

任务：VF-R3-CLOSURE-20260912-01，revision 9。以下全部是要求，不是通过声明。仓库根：/Users/jinkun.wang/work_space/veidofactory。

## 1. 验证顺序

1. 核对TASK、开始基线与当前源码，建立确定性失败证据。
2. 连续完成W1、W2、W3；正常聚焦红绿测试，不逐项等人工或Oracle审计。
3. 集中运行合同、恢复、付费安全、后半程组合及全量检查；最后源码构建后再跑source/dist边界。
4. 更新正式本地服务，用当前QA/浏览器技能进行一轮有界真实测试，期间只记录，不改产品。
5. 测完可测范围后，集中修复本任务范围内问题，再集中回归及一次必要的真实复验。需要新能力、改变产品原则或额外费用授权，带证据交回，不自行扩大范围。
6. 一次统一交RESULT供审查。不能把重复同因尝试算进度，也不能因一个负例正确停止就不测正例。

## 2. 确定性验收矩阵

每项在RESULT记录：修改前可复现行为、正式测试名/路径、修改后结果、退出码。已有测试继续保护旧安全合同。没有红灯的新增能力先写行为用例，注明新增合同，不能编造失败记录。

| ID | 对应问题 | 必须证明的行为 |
| --- | --- | --- |
| V9-01 | F01 / W1 输入 | 三入口与返工保留visualIntent/visualProof原意；缺visualPlan不制造硬beats；否定句、类比、示意不按关键词变实测；建议冲突不删用户原文。1000字符合法，1001显式拒绝，空白省略；HTTP→brief→producer/audit→digest完整传递。 |
| V9-02 | F01 / W1 模板 | 同一默认模板配图库/已支持生成能力均能进入规划；叙事职责保留但不强制一槽一镜；明确series/run限制不放松；来源不明且实质改变须确认；真无能力仍前后端一致阻断。不能仅删前端禁用。 |
| V9-03 | F02 / W2 前提 | critical+external_required首次audit后停止，即使audit为96/pass；保留原audit；script/director/media增量0；仅部分来源仍停；普通示意缺source不误拦；不存在/不支持图库的retrievalProviderId不冒充可取得；factual_support不借图库或生成证明实验。 |
| V9-04 | F02 / W2 恢复 | 同输入重复继续、刷新、重建不重做produce/audit；hostReadiness与audit分别保存、绑定当前operation并显示具体缺口；真实补材料/合法改承诺后按依赖恢复；不能改存量JSON补字段伪通过。 |
| V9-05 | F03 / W2 时序 | 视频/静态单持续beat及多段均合法；起点非0、间隙、重叠、尾部未覆盖、越界均拒绝；静态源起点/错误复用范围等原安全用例仍有效；30fps量化与scene实际时长一致。 |
| V9-06 | F04 / W3 换模型 | 草稿≠生效；未确认终态编辑被服务端拒绝；保存携带revision/确认；失败可见且不允许“重试旧模型、显示新模型”；保存后合法动作真用新路由；只换导演不重跑构思/编剧；unknown仍绑定原Provider。 |
| V9-07 | F05 / W3 失败 | 真socket+正式pipeline：构思已通过、编剧首produce无trace时终态失败，被消费到run failed、失败原因、lease释放和可操作UI；覆盖有/无候选、produce/audit、即时/受理后失败；持久化失败不伪成功、不吞后台异常。 |
| V9-08 | F06 / W3 重启 | 正式流程checkpoint重建后保留当前已过阶段及原失败原因；同输入字段次序变化不丢进度；真修改按依赖stale；错误operation/thread不串成果；禁止mtime找最新passed冒充当前。 |
| V9-09 | F07 / W3 统计 | 多角色/多checkpoint按物理任务去重；produce+audit执行与结构修复子集不双算；failed/halt/success/restart一致；首次produce失败计已证实执行；查询0调用；unknown单列；剩余时间不冒充本地计算。 |
| V9-10 | F08 / W3 查询 | 无pending或同operation观察时完成，返回最新状态、不执行模型；用户改输入后旧结果不得附回；错误绑定仍拒绝；query不解暂停/推进/支付；显式继续并发一次。 |
| V9-11 | 全部 / 合同 | 三规划producer、audit、修订/结构纠正实际请求交正式Broker parser；新字段完整嵌套且source/dist合法；错digest/非法引用/未知字段在executor前拒绝；v1历史显示与在途结清不赋予v2生产资格。 |
| V9-12 | 全部 / 下游 | 正式方案→报价三动作→授权→媒体/TTS/渲染→双审→局部返工的隔离组合通过；未授权create=0、unknown不新买、缺素材不用卡片、局部返工不扩全片、双审同SHA/独立身份、时间轴/母片绑定不变。 |

### 已有红灯

```sh
node --test --import tsx docs/codex-collaboration/evidence/r9-director-contract.test.mjs
```

审查窗口修改产品前得到5项中2 pass / 3 fail，exit 1：视频单beat误拒两项、遗漏尾部覆盖一项。执行者把等价行为纳入正式测试，保留探针目的；修后5/5才算V9-05这部分通过。其余问题见REVIEW源码/真实记录，不冒充全部已独立重放。

### 正式测试落点

优先扩充以下已有文件及相邻用例，不另建生产fake路径：

- W1：Studio的client.test.tsx、visual-plan.test.ts、api-contract.test.ts；pipeline的codex-screenwriter.test.ts、codex-visual-director.test.ts；Broker task-definitions.test.ts及跨进程合同测试。
- W2：packages/production-pipeline/test/creative-treatment.test.ts、role-agent-loop.test.ts、creative-planning.test.ts、production-planning-closure.test.ts、visual-director.test.ts。
- W3：apps/studio/test/text-task-production-recovery.test.ts、production-planning-stages.test.ts、production-planning-editing.test.ts、task-recovery-ui.test.tsx、node-workspace.test.tsx、run-observability.test.tsx；Broker codex-bridge-recovery.cross.test.ts及workflow-core持久化测试。
- V9-12：production-planning-publication.test.ts、production-authorization.test.ts、executable-timeline.test.ts、executable-production-plan.test.ts及Studio授权/返工用例。

使用真socket/持久化/正式调用链，仅外部executor或媒体依赖用隔离测试替身，不接正式Studio。断言行为与调用计数，不只有字符串包含、throws或手写状态。

F05完整根因尚未定位：找到第一处失败丢失边界后最小修复。若相邻诊断修复已绿但未证明历史running问题消除，V9-07标PARTIAL；不能用延长超时或generic finally标failed代替证据。

## 3. 集中检查

仓库根使用同一Node/ABI，记录版本、完整命令、退出码、测试数和skip原因。缺日志尾部或超时不算通过。以下package scripts已核对存在：

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

最后build后再检查协议组合。旧探针若需更新，说明新合同差异，不删行为断言：

```sh
node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --test --test-concurrency=1 --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_CAPTURE_RUN=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
VF_REVIEW_CAPTURE_RUN=1 VF_REVIEW_DIST=1 node --test --import tsx docs/codex-collaboration/evidence/r7-capability-contract-review.mjs
```

V9-11的新字段及全部变体需正式测试，旧15项/6项不自动覆盖。Broker release smoke复用现有临时目录方式，不上云。核对package实际收录本轮测试；相关孤儿测试也要跑并如实报告。不同构建命令不要并发清理同一dist。

旧ACCEPTANCE.md的A01–A12、G01–G08为不可破坏边界，不要求再逐条外部审计。机械的一槽一镜、视频至少两beat以本轮决定为准；CAS/lease、原任务结清、媒体授权、双审等不变。

## 4. 正式本地环境

- 最新build启动Studio及OpenAI/ZAI Broker；核对实际PID/cwd、产物hash或时间、socket、合同digest、真实模型身份与effort。不照抄旧PID，不降低用户配置。
- 重启前查在途与归属，正常停止；不杀付费任务制造故障，不删durable/checkpoint/workspace让服务“干净”。
- 现有授权配置加载凭据，文档/截图/控制台不暴露值，只记配置来源、模型身份与就绪结果。
- 不装生产fake broker、不手改run解锁。health正常只是启动通过，合法真实任务才能验证模型链。
- 身份/合同不匹配先记录并停止受影响调用，继续独立无副作用UI检查，不跳门禁。

## 5. 有限样本：正向出片与反向早停

### 5.1 真实语义成对验证，不再只注入needs_source

给当前OpenAI、GLM各一组同结构正负输入，走正式构思及独立审计。正例允许机制示意/通用画面、不承诺受控实测；负例锁定用户专属真实记录且确实缺材料。调用前在QA计划写输入、预期，不看结果后改预期。

每模型先一个正例、一个负例；正例复用继续生产，不另建同内容run。负例首次有效candidate+audit后不得进入编剧或继续无效produce；保留模型判断及host决定，漏判记FAIL，不用人工注入冒充正确识别。正例不可因空source、默认stock或单beat被拒；质量欠缺可用既有有界修订，不降低阈值。

新增构思/审计层=0。记录物理调用、结构修复和耗时，逻辑produce/audit的额外调用逐项说明。

### 5.2 样本分配

| 样本 | 到达目标 | 复用覆盖 |
| --- | --- | --- |
| 正例A：支持的生成/示意路线 | 到真实报价；选为主片后继续完整出片 | 原要求、模板适配、单beat、精确授权 |
| 正例B：图库路线 | 到真实报价；缺候选no-match诚实记录，不用卡片 | 不同路线、调整方案、选片质量、报价前不买 |
| 系列/热点入口 | 尽量将A/B分配其中；剩余入口用一个样本到方案/报价 | Canon与来源；无合格热点来源记BLOCKED及缺口 |
| 两模型负例 | 首次有效构思审计后needs_source | 无编剧/媒体增量、建议预填、同输入不重做 |

A/B到报价不是承诺任何题目成功。真实图库不足要区分能力缺口与代码错误；不能换十个题直到通过就宣称通用可用。共享后半程至少一条当前新run真实完成，不拿旧成片代替。

### 5.3 E01–E07

- E01：三入口真实输入、模板、模型、方案、报价；缺来源入口不涂绿。
- E02：报价及追加的“同意追加并继续/调整方案/暂不继续”；未同意create=0。有限样本分配动作，不反复购买只为截图。
- E03：代表主片媒体→TTS→渲染，核对taskId、授权计划、文件、账本；TTS自动且后台记账。
- E04：不同实际模型、隔离意见、同成片/evidence SHA；报告通过≠作品通过，不伪造第二份审片。
- E05：建议真预填相关节点；局部返工的计划/产物依赖集合与母片复用，必要新增媒体再次精确授权，不全片重买。
- E06：模型保存/失败提示、暂停/继续、查询竞态、刷新、Studio重启、1440/390与键盘；危险故障先隔离验证，不制造真实媒体unknown。
- E07：逐段视频/音频检查，当前动态时间轴、全程画面、音画/字幕同步、视觉一致性、文字干扰、开头吸引/中段推进/结尾兑现。不能只看分数或错抽帧判黑屏；验证爆款创作潜力，不承诺播放量。

已通过且未改的模板CRUD/搜索短冒烟即可，不重复无关截图。

## 6. 重试、费用与停止

- 同路径同根因仅在输入、修复版本或证据变化后做一次受控恢复；再同因失败停该链，继续独立项。accepted_unknown只观察原任务，不换ID/模型重投。
- 长调用按真实事件拆排队/首输出/生成/结构修复/观察；没事件标未知。不得扩大超时、压低质量或不停重试制造速度提升。
- 真实QA须执行窗口收到用户明确授权。本包不启动任务，也不是付费凭证。沿用上轮授权时，新增媒体+TTS以¥50为QA止损，不是产品默认上限；RESULT记录授权消息依据与起始累计。
- 每笔核对精确报价/范围；已发生+拟执行预估+未结清最大暴露不超授权。unknown不当未扣费；超过要说明验收目的和所需金额等追加，不能花几百元。
- 文本/订阅审片不增加现金审批，仍记调用；不研究无关模型或改订阅配置。
- 一轮QA结束再集中修同范围问题；必要复验仍失败如实交回，不无限第N轮。

## 7. 交付

沿用docs/codex-collaboration/RESULT.md追加Revision 9，不抹旧结果；新QA报告使用docs/qa/videofactory-real-local-qa-<日期>-r9.md及对应assets目录。

记录：开始HEAD与r9-start-baseline差异（本地checkpoint另列，既有改动不算本轮贡献）；V9-01–12/E01–07状态及证据；F05首个失败丢失边界，未定位照实说；QA复现/影响/根因与假设/排除项/受控恢复/调用费用；当前构建/在途状态/账本/成片/双审/返工。

“代码回归通过”“QA执行结束”“产品通过”分别报告。READY_FOR_REVIEW只表示可审查。本轮必做未完成不能称完成；可带明确阻断交审查。没有新成片、双真实审片或返工证据，产品验收仍未通过。
