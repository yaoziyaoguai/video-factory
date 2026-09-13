# Revision 8 审查结论与 revision 9 修复依据

日期：2026-09-13。结论：**CHANGES_REQUIRED**。不是推翻 A/B/C，也不是要求重新执行所有历史任务。

## 1. 三种结论不能混用

- 执行端报告的 TS 791、Broker 193、Studio 380+509、Python 131 等是其回归证据；审查窗口本轮没有重新执行这些全量检查。
- planningDisposition 的实际 needs_user、revise_here 已在 QA 中被消费，不能说上一轮完全没做事。
- R8 四个新 run 没有任何一个到报价。真实媒体、声音、渲染、双模型审片、返工未完成，**产品不通过**。
- F04 的节点总调用/耗时仍错误，是上轮要求未完成，不包装成全新需求。F03 证明了“收到正确处置会停”，没有证明“真实语义能正确识别且错误放行不会绕过已知前提”。

## 2. 用户本轮已决定的产品原则

1. 模板默认是可适配创作配方。保留叙事职责、真实性和质量目标；默认镜数、段长、素材路线不自动成为用户硬限制。
2. 导演可在用户承诺、明确限制、时长范围、实际能力和付费授权内优化制作方法。改变真实实验为教程、实拍为生成、核心主题或已确认方案实质内容，必须交用户确认。
3. 自动建议不能覆盖明确要求。未提供专属来源不得造假；不得用说明卡兜底。
4. 一起完成：要求优先级；规划/审计及机械限制；模型切换、失败恢复、重启进度、调用/耗时。
5. 不增加框架、数据库、角色、生产路线或爆款评分平台。不降低模型、强度、审片质量门。

## 3. 证据与根因置信度

### R9-F01：自动补全与模板限制污染实际输入（已证实）

- `apps/studio/src/client/components/NewRunDialog.tsx:720`：用户填写 strategy 后，合并 `initialValues.visualPlan ?? planVisualDirection(title,angle)` 的 beats，再套 `resolveExecutableVisualPlan`。
- `apps/studio/src/shared/visual-plan.ts:31`：缺上下文时生成通用 stock beats；`:202` 的 argumentFormFor 仅根据标题/钩子的自然语言正则推断受控实验。
- 城市 run 的 visualProof 明确允许不同地点示例，持久化 context beat 却要求同一主体、机位、条件、连续过程；当前函数重放完全一致。
- `resolveExecutableVisualPlan` 会删含创作者拍摄的策略句并替换来源。它不知道一句话是用户限制还是自动建议，不可继续在提交入口静默改写要求。
- `apps/studio/src/server/template-catalog.ts:86` 的知识解释槽位文字允许示意，allowedCapabilities 却仅 asset.search。`visual-source-compatibility.ts`、编剧/导演审计仍把它作为硬要求。
- 抽象 run 的编剧审计真实指出两个 stock-only 槽位，要求混入实拍。并非所有负反馈都是模型幻觉。
- **边界**：城市最终 no-match 的全部原因还不能仅由此解释；合法图库本来也可能不足。修好输入仍需验证搜索/排序。

### R9-F02：高创作分与制作前提混合（已证实）

- `codex-creative-treatment.ts:130,271` 和 Broker role-audit directive 允许前期未拿到素材，未足够区分“当前流水线可取得”与“必须用户提供”。
- 负例 `run-266b6ff4-8b0f-4989-be30-f27c2d82139a` 没有实验记录；构思审计96/pass，理由明确为后续取得后可兑现，issues=[]、planningDisposition=null。
- `creative-treatment.ts:23` 现有证据只有 factual_support/illustration_only 和 sourceIds，没有核心依赖的获取责任。`role-agent-loop.ts:1186` 的 pass/null 规则只能检查审计自洽，不能消除已知缺前提。
- `role-agent-loop.test.ts:1198` 的停止测试注入 needs_source，证明的是执行，不是识别。测试有价值，但不能替代真实语义验证。

### R9-F03：文件类型被误当动作数量（已独立重放）

- `visual-director.ts:699` 对任何 stock_video/generated_video 要求至少两段；真实 adjusted run 的第二镜是复用母片中的5秒持续静止状态，合法意图被拒。
- 当前 probe 还发现两段只覆盖0–4秒而 scene 为5秒却通过。应保护连续、完整时长，不应凑两个动作。
- 已运行：`node --test --import tsx docs/codex-collaboration/evidence/r9-director-contract.test.mjs`，5 tests，2 pass / 3 fail，exit 1，约0.55秒。无模型/媒体/服务变更。
- 此探针是纯校验边界证据，不证明整份导演计划和生成媒体合格。

### R9-F04：阶段换模型并未成功保存（源码缺口已证实）

- `PlanningStagesPanel.tsx:55` 只发 planningStageId/modelSelections；`production-studio.ts:1673` 要求结束态编辑显式 confirmTerminalEdit。
- `NodeWorkspace.tsx:476` 外层 catch 只 setError 不再抛出，子面板无法知道保存失败；子面板 draft 仍显示新模型。
- R8 QA：PUT409、retry200、继续旧 OpenAI。不能通过取消 CAS/终态保护修复。
- 完整恢复必须区分新绑定与旧在途任务路由；accepted_unknown 仍只能查询原 Provider。

### R9-F05：超时后终态没有形成完整用户闭环（现象证实，全部根因未定）

- 负例编剧 checkpoint 为 failed，phaseDurationsMs.produce=1200502，Broker 最终空闲；QA 期间 run 仍 running，重启才failed。
- `executeLoopPhase` 的 completed_failure 包装成普通 Error；`failedLoopError` 仅从直接 CodexBridgeError 提取结构化 failure。存在诊断丢失的明确风险，但**不能直接宣布这是 run 卡住的唯一原因**。
- `dispatchRun`/WorkflowRunner/图异常/节点失败产物持久化/最终 checkpoint 是必须验证的完整链。服务日志未找到有定位价值的 error，不能据此猜网络、SQLite死锁或 LangGraph bug。
- R9 的实现文档指定正式组合红灯场景和定位顺序，禁止通过 watchdog 一律把 running 改failed，禁止再扩大超时“解决”。

### R9-F06：重启后的进度与诊断不忠实（现象及覆盖代码证实）

- `recoverInterruptedRuns:750` 对遗留 running/pending 写通用 INTERRUPTED_RUN_ERROR。
- `inspectCreativePlanningStages:2393` 多条分支直接 allPending（输入缺失/stale、SQLite无文件、查不到当前thread）。不能直接取mtime最新文件绕过身份。
- 负例 passed treatment checkpoint 和 planning-history 都在，重启UI全部pending。
- 需核对执行与检视的 brief规范化/inputDigest/thread 与 operation 绑定。`jointPlanningInputDigest` 注释说剔除 runtime 字段，但函数直接 JSON.stringify({brief,...})，目前尚未证明它是该run错配原因。

### R9-F07：节点统计只取最后角色（已证实）

- adjusted run 三角色物理调用4+5+5=14，结构修复0+1+2=3，节点receipt却 modelCallCount=5、retryCount=2。
- `failedAgentLoopNodeResult:9870` 只取失败角色；`modelTraceReceipt:9090` 丢了结构修复专属字段，耗时部分仅累加已留存iteration trace。
- `NodeWorkspace:1161` 用节点总耗时减这一部分的排队/Provider耗时，剩余全部称本地处理。
- 必须按当前operation内不同checkpoint与物理requestId去重聚合，不能把同一checkpoint的累计快照多次相加。

### R9-F08：只读查询完成竞态报冲突（源码/QA一致）

- `queryOriginalTextTask:1965` 无pending即409，观察后revision变化也一律409。
- 相同输入/operation内正常完成或阶段前进应返回最新详情；真正编辑换计划时仍禁止附旧结果。不得简单吞掉全部409。

## 4. 真实记录导航（仅用于诊断，不写进产品分支）

根目录 `workspace/factory/runs/`：

| run | 用途 | R8结果 |
| --- | --- | --- |
| run-2344bb51-be40-4dce-b8e4-d7ed5e42223a | 抽象对照 | 模板冲突，6次，约6m10s |
| run-32ba953d-e44b-4b44-9ae0-882e80951928 | 城市情绪图库 | 17尝试，约23m58s，换模型失败，最终no-match |
| run-eb552d6d-4c73-4e54-9e60-4841d332dd9e | 系统建议调整后的正例 | 14次，约15m19s，节拍校验失败 |
| run-266b6ff4-8b0f-4989-be30-f27c2d82139a | 缺来源负例 | 构思通过，编剧20分钟超时 |

每条的 `run.json`、`nodes/creative-planning/planning-history.json`、`agent-loop-checkpoints/*.json` 是证据。不要把整份prompt/trace塞进RESULT；只提取相关字段和安全诊断。
QA：`docs/qa/videofactory-real-local-qa-20260913-07.md`；完成报告：`RESULT.md` Revision8。

## 5. 审查方责任与后续门槛

上一包对结构安全的描述较细，对规则优先级和正向制作能力的验证不足；F04用单角色统计测试代表节点汇总亦不足。不能靠换执行模型或增加审计次数弥补。
R9必须按本次用户已决定原则修正，而不是原样追加更多禁止条款。资料包入口TASK.md，方案IMPLEMENTATION_REVISION9.md，验收VALIDATION_REVISION9.md。不以任何文档保证下一轮必然产出合格成片；必须给真实结果。
