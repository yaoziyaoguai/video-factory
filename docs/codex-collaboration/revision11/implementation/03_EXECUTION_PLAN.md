# 03 执行顺序、源码导航与验证命令

按 S0→S1→S2→S3→S4→S5→S6 连续完成。步骤是检查点，不是每步停下来等审计；未完成全部实现不要提前跑付费 QA。只在真实权限/破坏性变更/产品歧义无法在本包内处理时询问用户。

## 0. 开工与共同约束

先核实磁盘目录、HEAD、工作树、暂存区、`../RESULT.md` 最新进度与 BASELINE；代码可能被另一窗口更新。差异不等于破坏：比较实际内容，不 reset/stash/clean、不覆盖既有工作。相同文件有执行者同时修改时先协调，不开多个写同一模块的 subagent。

首次记录：开始时间、HEAD/branch、dirty 摘要、当前执行模型/effort（不可见则记未知）、Node/Python 路径版本、当前任务步骤。只为本任务读取所需内容，不打印凭据。

本文路径均相对仓库根。下列已有文件的导航经过本次读取；`creative-review*`、`trend-article-reader*` 为本轮计划新增名称，不能假称已存在。

## S0：冻结证据与最小架构接缝

目标：把“旧问题证据”和“新交互原本不存在”分开；证明新确认机制能接入现有图而非补前端暂停。

先读：

- `../REVIEW_REVISION10.md` 全文及其中四份 evidence。
- `creative-planning.ts` 的 createCreativePlanningGraph、planningNodeActions、runCreativePlanning、planningOutcome、seed 边界。
- `production-pipeline.ts` 的 creative-planning execute、seedJointPlanningThread、continue/retry/recoverInterruptedRuns、FileRunStore lease。
- `packages/workflow-core/src/workflow-runner.ts` 的 resume/runNode/executeWorkflow，及 `types.ts` 的 intervention、result/status。
- 最近相关测试：`creative-planning.test.ts`、Studio 的 `production-planning-stages.test.ts`、`text-task-production-recovery.test.ts`。

先建立失败证据：F02 原探针会首次成功、同 checkpoint 恢复失败；F03/F04 探针 exit 0 是缺陷被复现而非正确；F01/F06 探针展示污染/等义拒绝。不要为了基线重跑全库。把对应现象转成正式行为测试，保留归档探针历史。

新增无外部调用的正式组合测试：完整 Pipeline/Studio + SQLite + FileRunStore + 注入角色 transport，验证初案等待、generic approve 不越权、confirm 只到脚本等待。先红后做最小贯通；不得假造已确认字段跳过 HTTP/领域入口。验收 D11-01～03、10、14。

## S1：集中修 R10 交接缺陷（不重做 R10）

| 项目 | 已确认入口/落点 | 必须看完的相邻上下文 | 先建立的失败测试 |
| --- | --- | --- | --- |
| F01 | TodayPage→shared/visual-plan→NewRunDialog | parseStudio 输入、ProductionBrief、角色 payload/identity | 无建议/未触碰建议/用户修改/明确采用/否定句；捕获正式输入 |
| F02/F03 | role-agent-loop restoreCheckpoint、revisionAuditForHost | treatment-readiness、role-agent-checkpoint、planning halt、Studio loadAgentLoopProgress | 真实 assessTreatmentReadiness 输出进入真实 loop；空/非空误判列表、部分真缺料、恢复 |
| F04 | creative-planning defaultAvailabilityReviewer；visual-director validator | production-pipeline visualDirectorPlanValidation、编译与素材请求 | stock no-match→导演合法改路→新报价；真取证和禁止生成负例 |
| F05/F08 | ProductionPipeline 声音输入编辑；VoiceStudio | workflow-runner 输入覆盖、voiceTimingFor、voiceover.py 真实消费参数 | 改 rate/pause 后正式角色输入/receipt/返工一致，未影响媒体保留 |
| F06 | editorial-decision、candidate-inbox-studio、series-planner | 模型机会输出与采用门，不只改展示 | 相同语义问号/陈述、中文/阿拉伯数字不改裁决；真正无内容仍拒绝 |
| F07 | treatmentStageInputIdentity 与 treatment port | 编剧/导演 seriesContext 投影、当前 series parser | 系列约束真正入前期；变更影响身份、无关数据不影响 |

正文证据不足不能通过改 score、删 hard gate、转说明卡、改主题解决。自动建议不能换字段名继续强制用户。验收 D11-04～09、25～28。

## S2：三阶段可恢复等待 + 单次生成/单次检查

目标：不用 UI/API 也不能越过用户确认；用户不确认就不启动下个创作角色。

范围：`creative-review.ts`（新）、creative-planning/store、production-pipeline、workflow-core 必要 continuation 类型与恢复方法；三个 codex role adapters、role-agent-loop/checkpoint；Studio production service/interface、shared/api。

实施顺序：

1. 先建窄状态/命令 parser、确认身份与失效纯函数，按 02 文档固定语义。
2. 接 LangGraph 三 gate 和 typed waiting outcome；处理零副作用 interrupt、在途操作 checkpoint、确认绑定、重复恢复。
3. 分离现有 Detailed 路径的草稿与当前候选检查。共用 transport/durable 工具；不引入无恢复的直接模型快捷调用。结构修复仍走既有上限；普通讨论不触全套独审。
4. FileRunStore 投影为 needs_human/creative_review；generic decisions、retry、resume、override 拦截非法跨阶段动作。正常确认由专门 continuation 路径继续图，不能把 creative-planning 整个设 succeeded。
5. 修复依赖闭包：确认前不能 seed/compile 未确认产物；旧 run 的媒体可复用，确认不可伪造。上游修改、模型/能力变更按矩阵失效。
6. 补崩溃窗口/并发正式测试，再进入 UI。不为了兼容保留可继续生产的旧自动路径。

验收 D11-01～03、10～18、29～32、39。

## S3：讨论协议、API 与统一工作台

目标：普通人能看懂方案、自然讨论、多轮修改/采用/撤销、明确确认，不需要看日志或 JSON。

范围：新 `creative-discussion` task 和窄 adapter（优先 `codex-creative-discussion.ts`）；Broker task-definitions/codex-executor/ZAI validator、codex-chat task kinds/digest、role-agent-assembly 与 capability 设置；Studio `app.ts`/studio-service/production-studio/shared/api/client/api；现有 RunWorkbench/NodeWorkspace/PlanningStagesPanel 及一个窄 CreativeDiscussionPanel。

实施顺序：

1. 按 04 提示词落地严格 envelope 和当前角色路由；客户端不能传模型运行参数绕开配置。
2. POST 命令立即 durable accepted 后 202，GET 观察结果；在 UI 发送前后保持 commandId。旧页面/旧提案不覆盖新稿；出错保留输入和可行动解释。
3. 把方案渲染接到真实文档，不只输出聊天气泡。点选段落/镜头范围以稳定 id 和当前内容 SHA 绑定。
4. 实现解释不改稿、备选不覆盖、明确修改出新稿、采用备选、撤销本轮、确认当前版本、返回上游的影响提示。
5. 1440/390、键盘/中文输入法、刷新/重新进入、长文/空态/加载/模型失败/冲突等组件覆盖。
6. 更新受影响 API/测试脚本。新增的 Studio Node 测试当前不会自动被 script glob 收录：必须加入 `apps/studio/package.json` 的明确列表，否则会再出现孤儿测试。

验收 D11-19～24、30～34、39～40。保留模型/备选/技能/声音设置，不把它们因新讨论 UI 隐藏掉。

## S4：热点原文阅读、证据交接和推荐

目标：真正读原文再发散，候选与后续角色知道事实出处和未核实项。

范围：`trend-article-reader.ts`（新）、trend-opportunity-agent/trend-studio/topic-ideas-payload、机会/来源持久化、shared/api、TodayPage/OpportunityFocus/Candidate 展示；现有总编 prompt/schema；ProductionBrief 与三角色实际来源投影。

顺序：

1. 在安全 HTTP port 和确定性 HTML 样本上先证明正文提取、限制/重定向、SSRF/注入、缓存、超时语义。测试不能访问真实内网或元数据。
2. 接现有信号分组→有界正文读取→总编同轮 facts+ideas→独审。记录真实读取状态，title_only 不冒充已读。
3. 当前 topic payload 只有标题/链接；扩展 Studio/Broker 双端并动态核对实际所有 task digests。不得再出现 require* 白名单漏新字段。
4. candidate 保存引用来源快照；采用后把可信来源传入 treatment 的 suppliedSources 及下游，不保留当前空数组。角色实际输入/检查/identity一致。
5. 无正文失败路径依然提供清楚的下一步，保留自有想法/系列入口独立可用，不因热榜失败关闭整个产品。

验收 D11-35～38、40～42。只新增本次明确的 extraction 依赖，不做 crawler、向量库或全网搜索。

## S5：合并边界、提示词与说明文档

目标：三个确认点、交接修复、来源能力一起工作，不各自单测绿却无法串起来。

- 跑正式组合：三入口→导演/脚本/分镜等待确认→当前方案编译/报价→拒绝/调整/暂停；付费执行使用隔离 transport，验证无批准零调用。
- 同一路径测试声音变更→计划依赖复核→重新确认→媒体保留；图库 no-match→允许池改路线→新确认/报价；审片反馈→最早负责阶段草稿预填→局部复用。
- 新动作必须出现在调用/耗时汇总，消息保存/GET/刷新不算模型调用；等待用户不算模型耗时。主片模型、取证集与独审标准不降低。
- 公共 prompt 的旧自动推进/模板硬要求、导演 stock 一律禁止生成、全局核账文案与新规则有冲突的句子要移除，不能两种规则叠加。
- 更新 README 与两份 production/web 指南中实际变更，不重写全库文档；旧 QA 事实不可改。Graphify 最后最多按既有规范一次 update；失败记录，不修图谱工具耽误主线。

验收 D11-25～34、39～46。

## S6：集中验证、自查、移交真实 QA

完成本轮全部代码后一次集中运行以下顺序，记录完整日志和退出码。失败先分类与聚焦修正，再重跑失败检查和可信影响范围，不每次全部重来。

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

这些是本次核对存在的命令。`npm test` 会重复调多项构建，已经逐项运行后不再叠加一次。新增文件必须被相应脚本收录。若实际受影响的孤儿用例仍存在，明确列出并单独运行，不能静默放弃。

source/dist 合同组合沿已存在的方式（读当前探针再执行，不按旧日志抄 SHA）：

```sh
node --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
VF_REVIEW_DIST=1 node --import tsx docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs
node --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
VF_REVIEW_DIST=1 node --import tsx docs/codex-collaboration/evidence/r9-planning-contract-boundary.mjs
```

新增 `r11-contract-boundary.mjs` 或正式等价测试，按同 source/dist 方式验证 creative-discussion 全部意图、topic 原文/引用、series/audio 当前输入、两个 executor 和 health/task registry。不得只断言摘要相等，不跑 parser/validator/恢复。

### 聚焦测试命令习惯

Node TS 文件从仓库根用 `node --test --test-concurrency=1 --import tsx <准确文件列表>`。Studio 组件从 apps/studio 用 `npx --no-install vitest run <文件> --reporter=dot`。跨 workspace 从包入口 import 的测试要先 build:pipeline；并行运行会写/清同一 dist 的脚本会互相干扰，构建串行，独立纯测试才并行。

历史曾有 better-sqlite3 ABI 与不同 Node 版本不匹配。先核对实际 Node 可执行路径和一次 sqlite 加载/测试错误；不要把 90 个相同 ABI 错报成90个产品 bug。不降级产品模型，不盲升级工具。需要重建已有本地依赖时只用当前锁定运行时/锁文件，并记录原因；不要改产品逻辑适配坏环境。

### 自查与移交

对照 05 的全部 D11 验收及新增 diff：确认没有题材特判、绕过批准、双旧新生产路径、无关重构、测试迎合错误实现或未计费副作用。

仅在代码验收通过后在 RESULT 标记 `CODE_VALIDATED`，直接进入 qa/01_RUNBOOK 的真实本地测试，本次用户已授权，不重复询问是否花这50元。未通过时继续范围内代码修正；不能把未实现的讨论/原文能力丢给 QA agent 自己补。

测试完成后集中提交结果给用户，不 commit/push，不自动开始下一轮产品优化。
