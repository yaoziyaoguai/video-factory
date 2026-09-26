# 验收与失败测试清单

所有项初始为 NOT_RUN；本包只做静态核查。执行者在 RESULT 用真实证据更新，不能从提交说明复制通过数量。

## 1. 分层原则

- L1：纯逻辑/模块行为。可替换外部 transport，但不能用预制“通过对象”证明它自己的 validator/assembly。
- L2：正式 API、ProductionPipeline、WorkflowRunner、真实本地隔离 store/ledger；只在外部模型/媒体/网络边界提供受控响应。必须有测试出网拒绝保护，不能使用用户真实付费 key。
- L3：权限允许下正式本地服务的真实浏览器/模型/媒体链。测试替身不算真实模型链；免费素材搜索也属于真实外部请求，遵守许可。
- 作品验收：真实播放并听声音、用户决定。技术测试通过不能代替。

先写能触发旧缺口的失败测试，再修代码。测试须断言产物/状态/真实外部调用计数/账本与权威输入，不只断言字段存在。并发用 barrier，重启用明确落盘断点和隔离子进程，不能靠长 sleep 碰运气。

## 2. 当前执行验收 ID（A01–A30）

| ID / 批次 | 输入与动作 | 必须证明 |
|---|---|---|
| A01 / P0 | 正式 DeepSeek assembly 单审成功/失败 | 一份真实有效报告、实际模型身份；缺回执不伪完整，不再要求第二模型 |
| A02 / P0 | 新建/直接 API/旧 GPT 配置恢复 | 无退役生产请求；历史事实可读、不可静默迁移；UI 单审文案一致 |
| A03 / P1 | 首镜成功+完整负面试片，经真实 worker/HTTP | assets 处于有报告的用户决定停点；未生成其余镜头，不判全片失败 |
| A04 / P1 | 接受当前完整负面报告 | 同一资产操作只继续尚未完成部分；首镜 create 不增加、SHA不变、剩余合法授权校验保留 |
| A05 / P1 | scope撤销/过期/金额或方案变化后承担 | 不借质量确认购买；需要时回到报价，旧媒体保留 |
| A06 / P1 | 内层 reviewer 不可用/畸形输出 | 两条真实 worker 路线均到 source_review_retry；不是注入外层异常才过 |
| A07 / P1 | 重试审查；普通 approve；错节点重试 | 恢复原素材、无重购；approve 与错节点请求拒绝且无状态/资金副作用 |
| A08 / P1 | 同一确认双击、旧revision、两个页面并发 | 至多一次推进；无陈旧报告接受、无重复采购 |
| A09 / P1 | 暂停/确认落盘前后重启；报告或SHA或规则变更 | 原媒体/账本/有效决定恢复；失效决定不能继续生效；同素材不同报告可区分 |
| A10 / P1 | 非法plan/缺母片证据/媒体结果unknown | 原安全线保留；无确认绕过、无伪成功、无新create |
| A11 / P2 | 明确model_not_found、裸404、错endpoint、400合同 | 只对有可靠证据的模型失效有限切换；其它后续候选调用0 |
| A12 / P2 | 402、账户级429、401/403 | 不把同账户别名当有效backup；可操作原因与已完成工作保留 |
| A13 / P2 | role/repair/candidate/transport嵌套 | 同一总deadline和真实请求上限；无指数放大；统计等于transport spy实数 |
| A14 / P2 | uncertain、迟到完成、cancel竞态、重启 | 观察原requestId，无双跑、无重复结算；完成只消费一次 |
| A15 / P2 | 长中文reasoning+短JSON、UTF-8/SSE分块、合法重复 | 不混正文，不误伤有效输出；边界前成功、越界终止且有原因 |
| A16 / P2 | EOF/length/空心跳/超限/abort | 无有效完成假回执；有界退出、资源释放、可恢复状态 |
| A17 / P2 | 手选候选/推理参数与阶段耗时 | 实际请求、记录和UI对应；人工等待不算模型耗时，不静默降级 |
| A18 / P3 | 新稿/保存后已有pass或repair，再确认 | 每版本默认一轮；确认不再审；repair需承担；允许用户主动再次讨论 |
| A19 / P3 | 同稿两回执、A审查中保存B、重复保存 | 旧页不能确认新意见、迟到A不盖B；无重复复核、无丢稿 |
| A20 / P3 | HTTP伪造score/issues/checkIdentity/媒体或费用字段 | 不得建立权威结果或越权改变参数；其它旧确认入口遵循同一合同 |
| A21 / P3 | 改语速/停顿、审片模型、导演路线、局部返工 | 依赖精确失效；规划与声音一致；不重买无关素材；新采购重新报价 |
| A22 / P3 | 全局保存→无模型字段的API新建→改全局→节点覆盖/清除→重启 | 新run冻结默认；旧run不暗改；清除覆盖恢复其run继承值；来源可信 |
| A23 / P3 | 五类模型设置，保存其中一类 | 一个canonical身份、多视图引用；保留其它类与非模型设置；UI/API/实际候选一致 |
| A24 / P3 | 四入口新建与节点工作区 | 内容/平台/时长/参考/系列信息保留；预算不是付款；低分合法内容能创建 |
| A25 / P3 | 同协议新测试候选、测试规则版本变更 | 目录→校验→执行→回执→UI贯通；不改runner/授权；旧回执失效而不抹历史 |
| A26 / P4 | 四入口正式图、joint各阶段、可达后继 | 每边界未确认时后继调用0；批准只推进一次；专用干预不被普通gate包掉 |
| A27 / P4 | 正常全链与一条通用局部返工 | 通过素材/声音/渲染/技术检查/单审/终审/本地包；未变媒体hash不变；模拟和真实分开记 |
| A28 / P4 | 390/1440布局、刷新/重启、编辑冲突、费用提示 | 动作与服务端允许一致；恢复/确认清楚，不声称未发生的自动修改 |
| A29 / P4 | 完整回归/构建/package/Python | 原始命令与退出码齐全，skip与失败逐项解释；新增测试进入runner |
| A30 / P4 | 最终交付 | 真实范围/未测/费用/产品剩余问题/用户未验收分开；无commit/push/云端操作 |

P1 的 A03–A10 必须覆盖 direct 与逐镜路由公共语义，不只选单一模型快照。无需对每个供应商做无意义笛卡尔积；涉及不同异步协议时再补该 adapter 边界。

## 3. 既有测试落点

优先扩现有文件；不能删除旧安全测试换成全成功。

- pipeline：`packages/production-pipeline/test/asset-pilot-review.test.ts`、`generative-asset-worker.test.ts`、`production-authorization.test.ts`、`production-planning-closure.test.ts`、`production-planning-publication.test.ts`、`creative-review.test.ts`、`fallback-role-agents.test.ts`、`fallback-task-client.test.ts`、`role-agent-loop.test.ts`、`codex-visual-review.test.ts`。
- core：`packages/workflow-core/test/` 中现有 runner/resume/授权测试，按符号定位。
- Studio：`apps/studio/test/role-agent-assembly.test.ts`、`production-authorization-api.test.ts`、`production-planning-stages.test.ts`、`production-planning-editing.test.ts`、`text-task-production-recovery.test.ts`、`text-task-recovery-receipt.cross.test.ts`、`creator-settings-store.test.ts`、`studio-service.test.ts`、`server.test.ts`、`api-contract.test.ts`，以及 client/creative-discussion-panel 的现有 Vitest 用例。
- Broker：`apps/codex-broker/test/chat-completions-executor.test.ts`、`deepseek-fallback-integration.test.ts`、`codex-bridge-recovery.cross.test.ts`、`task-definitions.test.ts`。
- Python：`tests/test_pipeline.py`、`test_worker.py`、`test_voiceover.py`、`test_visual_rendering.py`、`test_review_media.py`、`test_technical_review.py`。

Studio 的 npm test 是 Vitest 加**显式 Node 文件列表**；新增 Node 测试要进入 script。禁止构建失败或 Node 测试没跑却仅凭 Vitest 绿色称 Studio 全过。

## 4. 命令与运行顺序

在仓库根先检查当前 scripts；以下已在本包基线确认存在。统一使用同一兼容 Node 与依赖环境。构建会清写 dist，禁止并行执行构建/类型检查/带前置构建的套件，也不在活跃模型任务期间边构建边启动服务。

聚焦示例（构建一次后按改动选择，单测不得真实出网）：

```bash
npm run build:pipeline
node --test --test-timeout=300000 --import tsx packages/production-pipeline/test/asset-pilot-review.test.ts packages/production-pipeline/test/generative-asset-worker.test.ts packages/production-pipeline/test/production-authorization.test.ts
node --test --test-timeout=300000 --import tsx apps/studio/test/role-agent-assembly.test.ts apps/studio/test/production-authorization-api.test.ts
node --test --test-timeout=300000 --import tsx apps/codex-broker/test/chat-completions-executor.test.ts apps/codex-broker/test/deepseek-fallback-integration.test.ts
```

集中全量按顺序分别运行并收集退出码：

```bash
npm run typecheck
npm run test:ts
npm run test:broker
npm run studio:test
npm run build
npm run test:package
python3 -m unittest discover -s tests
git diff --check
```

Python 命令使用现有项目环境中能 import video_factory 和 Pillow 的解释器；不要全局升级/盲装依赖。根 npm test 已包含前六项，可以使用它，但遇首项失败时后续未运行必须补跑、分开记录；不要 npm test 后重复统计同一全量。

`npm run test:e2e` 带真实环境开关，不属于默认免费确定性清单；先读测试、确认所有外部调用与授权后才能执行。不得因名字叫 test 就认为不花钱。

source/dist smoke 应验证正式打包组合根、单审配置、API 和恢复装配；引用已有 package/launcher smoke，缺口补在原测试，不增加另一套启动器。

## 5. 旧编号映射与允许延期

| 旧项 | 本轮对应与迁移 |
|---|---|
| S00/S01 | P0 基线；key轮换已被用户暂缓；收费授权另判，不阻断离线 |
| S02–S04 | P0/A01–A02；已实现只防回归，历史只读/安全停，不静默迁移 |
| S05–S06 | P1/A03–A10；真实worker→API与持久化 |
| S07–S10 | P2/A11–A14 + P1/A05/A10；全部收费出口检查，不建授权平台 |
| S11 | P2/A15–A16；保留32MiB修复 |
| S12–S13 | P2评估；无等价/反误杀证据则 deferred_not_enabled，不强做优化 |
| S14–S19 | P3/A18–A21/A24；默认一次、确认权、依赖失效 |
| S20–S25 | P3/A22–A25 + P4/A28；模型同源、冻结、五类和轻新建 |
| S26 | 仅本地启动安全/退役核验；Docker、云部署明确 out_of_scope |
| S27–S29 | P4/A26–A30；真实收费待新授权，作品验收留用户 |
| R01–R02 | 合法/非法plan保留守卫，A10/A26 |
| R03–R04/R09 | 旧双审→单审未完成恢复/完整负面人工承担，A03–A07 |
| R05–R08/R10–R11 | 专用入口、幂等/重启/unknown/失效保留，A07–A10 |
| M01–M07 | 错误作用范围、真实候选、能力过滤，A11–A14/A17/A25 |
| M08 | 新单审基数/真实身份，历史双审独立性不弱化，A01/A02 |
| M09–M10/M12–M14 | 单审恢复/失效/不可用/付款前就绪/unknown，A04–A10/A12 |
| M11 | 生产双腿互不泄漏已由单审决定替代，记 superseded；旧双审历史不改 |
| C01–C14 | 一轮/身份/并发/编辑/旧API/正常化/实际选择，A18–A22 |
| O01–O10 | A13–A17；O03若重复检测未启用，验证硬上界并注明检测专项延期；O10验证实际支持档位，不硬套退役GPT xhigh |
| E01–E10 | A02/A10/A22/A24/A26/A27；历史不复活退役调用，成片需用户验收 |
| E11–E14（9/18报告新增） | A19/A21/A25/A28，以及A06–A16的故障穿透 |

其它旧 G/N 条款已在 01 决策和本表承接。不因缺 R/M/C/O 名称的自动化断言就臆造通过；RESULT 写出测试全名与实际映射。
