# 审计结论与根因证据

## 结论

当前仍为 **CHANGES_REQUIRED / PRODUCT_NOT_ACCEPTED**。上一轮修复并非没有成果：预算往返、三阶段的前两阶段、采用/撤销、诊断、队列拒绝恢复、正文读取、声音设置保留等已有证据。但媒体之后全链尚未到达，不能由上千测试通过推定已完成。

本次不改产品、不发模型/媒体请求；读取原 durable、checkpoint、当前源码，运行只读回放。诊断技能用于“先复现再定因”；Graphify仅只读导航（图谱不是最新源码的正确性证明，未重建/升级）。不存在必须换框架/数据库或推翻三阶段工作流的证据。主要是边界职责未对齐、修订基线丢失及用户恢复入口未闭合。

## K1（P1）分镜错误在修正循环外被截断

真实主片 `run-25b4c195-a50c-4344-98fd-197d1bf58438` 的导演初案95分、脚本96分通过。最后一次 director request `agent-c1381e9b8b425cd092ea96333ba30c4be665b388a5519c930bc7aac3d2373915` 实际模型183185ms、排队0，以 `duplicate_scene_position / output.shots[2].scenePosition` 结束。不是网络超时。

已证实链：

1. `apps/codex-broker/src/codex-executor.ts:1037` 与 `zai-code-plan-executor.ts:249` 在返回前验证语义，直接抛终态错误。
2. ZAI现有一次 format repair 只处理 schema；语义校验在该分支之后。OpenAI也没有这条语义修正路径。
3. `packages/production-pipeline/src/role-agent-loop.ts:313` 收到执行异常立即 failedLoopError；只有后面的 `timedValidate(candidateExecution.output)` 失败才进入结构修正。因而正确存在的 loop 没机会处理该失败。
4. 本次受控 ZAI transport + 正式 executor + role-loop 探针：重复位置候选 → transportCalls=1、validateCalls=0、duplicate_scene_position。外部网络调用0。不是只测validator报错。

不能确定：失败原候选临时文件已清理，无法判断模型为什么重复编号；不能声称已证明是脚本内部两次取景导致。现有一场景一计划项的时间轴/复用合同继续保留；确需拆场景应回脚本讨论，不能自动拆/改已确认上游。

## K2（P1）图库回退收到问题，却没有上一版方案；停止又丢讨论入口

纠正旧报告的三轮顺序，以本次原 payload/output 为准（旧文件名排序不是执行顺序）：

| 轮次/request前缀 | 收到的缺项 | 实际分镜 |
| --- | --- | --- |
| 初次 `agent-5321b` | 无 | 图库1/2，生成3/4，5复用3 |
| 调整1 `agent-e6194` | 1/2图库不足，明确 illustrative | 1/2改生成，但4改图库 |
| 调整2 `agent-8acfd` | 4图库不足，明确 illustrative | 4改生成，但1/2又回图库 |

这三次模型执行分别212223、262258、179329ms；仅三次导演就累计653810ms（10m53.810s），不能把21m13.735s全算网络或单模型等待。

根因证据：`creative-planning.ts:1493 contextFor` 有 directorPlan，但 `production-pipeline.ts:6362` 的正式director port只把当前issues加入brief，没有把上一方案与先前不可得记录交给本次新候选。三份真实payload均无上一方案；不是“模型没有看反馈”，而是每次带局部反馈重新做全案。不能断言模型心理原因，但输入缺口及来回改路线已证实。

另外：`creative-planning.ts:778` 图库路径未发布director草稿；`evaluateNode`重复无改善转needs_source/END；`production-pipeline.ts:6793`将halt抛为普通失败。`production-studio.ts:1424`只在creative_review intervention读取讨论。故该中间合法方案没有被交给用户继续讨论。`run-observability.ts:236`又将所有needs_source统一写成真实实验补实拍，覆盖了内层已区分illustrative的建议。**只改文案或再加“允许生成”提示不够。**

已有来源阈值40不可降低；候选分数低并不证明图库永远没有素材，也不意味着允许自动强选。真实缺实证负例仍须阻断。

## K3（P1）机器越权做事实语义判断，模型成果被静默归零

真实最终6ideas来自 `agent-f9b090...`；首轮 `agent-7d5c874...` 提供完整signals/articleSources，续轮仅revision，回放必须配对两份，不能拿续轮当完整输入。

正式TrendOpportunityAgent原数据离线回放得到0候选；6/6引用均合法。`evidence/probe-before.json`给出每个字段及实际规则：全部六项都有引号词面拒绝；第4项还因为audience/rationale中的AI；第6项还因为演算28。典型误判包括“机制示意，非真实芯片剖面”“待官方核对”“角色如何被交接”等创作/披露标签。

`trend-opportunity-agent.ts:587 groundModelIdea`把audience/hook/rationale/visualPlan全部送入 `unsupportedClaim:777`；任何引号逐字查来源、归因动词无条件拒绝，数字/英文同样词面判断。之后成功返回0被标成总编最终取舍，用户看不见宿主筛掉的原因。

现有CodexTopicIdeaModel独审已拥有候选全部字段和upstreamFacts（包括正文），但criteria还写“原信号没有的事实”，应明确以提供的read/partial正文为支持边界。修的是**机器验证引用真实性，独审判断事实是否有支持、创作表达是否冒充事实**，不是取消事实安全。6项引用合法不代表6项都值得推荐或全都事实充分；不可把“固定输出6项”写成验收。

## K4（P2）本次/历史按可变容器归属；模型时间用了墙钟

`production-pipeline.ts:9909 summarizeJointPlanningExecution`用整个checkpoint当前recoveryOwner分组。恢复换owner，但 `attemptedRequestIds`保留两次任务；本次正式summary复现2次、producerMs=439225，实际本次只一个新request/模型183185ms。

`role-agent-loop.ts:1087`的phaseDurationsMs累加整个execute等待墙钟（包含排队/查询/本地过程），summary直接命名producerMs。上一导演排队20333ms也可混入“内容生成”。不能通过数字除2或清历史修好。按物理request归属统计；Broker内部一次格式/语义修正的模型attempt与Broker任务数分开。旧证据缺归属/时间应标历史或未知，不编造。

## K5（P2）SSE/操作回包与详情GET不是同等完整快照

`production-studio.ts:245 get`附加withAgentLoopProgress/withPlanningStages/withTaskRecovery；多处publish用同步 `toDetail`，没有上述异步增强。`RunPage.tsx:11`接受同revision覆盖；收到failed后取消订阅，末次简略快照可覆盖完整详情而再无heartbeat补读。与“刷新后才看到分镜具体错误”的实证吻合。

已证实代码接缝及现场症状；本次抽取当前源码中的preferRunSnapshot原函数运行，同revision简略终态事件确实丢掉planningStages。尚未捕获原事件到达完整序列，所以不能声称本次完成了精确浏览器竞态复演。执行端必须先建立终态简略事件/乱序GET的确定性失败测试，不能以任意延时刷页面当修复。

## K6（P2）手机sticky动作遮住发送

旧真实截图15及DOM命中：390×844发送按钮中心命中“撤销本轮修改”，而不是发送。`studio-v3.css:1235` bottom72/z-index2的sticky区覆盖正常流内容；无横向滚动不等于可用。本轮没有重新操作浏览器，不冒称重新测了软键盘。

## 慢的问题如何处理

本轮能证明的放大因素：无效全案回退的多次导演调用；共享队列的等待（旧主片一次讨论排队331112ms）；执行墙钟误记成模型耗时。无法仅凭这些数据证明Provider内部具体哪里慢，也不要求换模型/降低质量。K1/K2减少无效工作，K4让剩余真实耗时可解释；QA按排队/模型/本地/人工等待分别取证，不宣称必然降到某个秒数。

## 尚未覆盖及范围

原R11负例缺本人实拍正确停止、仅切脚本模型保留构思SHA/repair76、零新增调用，必须保护。手机遮挡与终态快照之外的全站美化不在范围；系列默认路线图模板化已见风险但本轮未系统诊断，记录为独立内容质量观察，不趁机重做系列产品。

媒体/TTS/渲染/同片双真实视觉审片/局部返工/交付仍未验证。K1–K6解决已证实前半程阻断，不是保证后半程没有缺陷。后半程必须按REAL_QA取证，遇到新问题按根因集中记录。

## 本次证据等级

- `evidence/probe.mjs`执行退出0，正式函数回放；读取本地原数据，不产生网络或产品写入。私有函数通过内存转译导出仅供诊断，不改产品导出。
- `evidence/probe-before.json`保留机器结果；synthetic transport只是接缝证据，绝不是真实模型成功。
- 最初尝试CJS内存加载因ESM-only workspace export失败，已改ESM只读加载，未改依赖/产品。先前失败不算通过。
- 原Broker安全诊断聚焦用例独立运行1/1、退出0；证明原诊断修复仍有效，不代表本次规划的新语义修正已经实现。探针合法原分镜对照1次成功，只改变一个scenePosition后1次拒绝、宿主validate调用0。
- 原报告与截图/真实任务是历史实证，本轮不重新伪造。旧报告三轮顺序本次已更正；保留原文不抹历史。
