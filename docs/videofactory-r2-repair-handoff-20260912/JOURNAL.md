# VF-R2 集中修复执行日志

执行者按时间追加，不删除旧记录。

## 开始基线

- 日期：
- 执行者实际模型/effort：
- HEAD / branch：
- tracked/untracked 状态摘要：
- `git diff --check`：
- Studio/Broker PID、构建和 health：
- 与报告不一致之处：

## 四条失败 run 关联

对每条 run 记录：

- runId / node / operationKey：
- requestId / kind：
- requestDigest / taskContractDigest：
- 输入 session key/handle hash：
- Broker identity：
- durable accepted/completed/outcome：
- Studio checkpoint 最后事实：
- 真实不一致点或仍未证实项：

## 失败测试

- 验收 ID：
- 测试文件/名称：
- 旧实现失败证据：
- 分类：PRODUCT_BUG / STALE_TEST / BOTH / ENVIRONMENT / UNVERIFIED

## 实现批次

- 修改文件与 symbol：
- 保护的合同：
- 为什么是共同根因而非单 case 补丁：
- 是否偏离资料包：
- 聚焦测试：

## 全量验证

- `build:pipeline`：
- `test:ts`：
- `studio:test`：
- `test:broker`：
- `test:package`：
- `build`：
- `typecheck`：
- Python：
- `git diff --check`：
- timeout/skip/stale/未验证：

## 真实本地 QA

- 正式环境与实际模型：
- 三入口覆盖：
- 真实费用与授权：
- Provider create/reconcile：
- 渲染/ffprobe/逐段画面：
- 双审 identity/evidence：
- 打回/局部返工：
- 1440/390：
- 新问题及共同根因：

## 最终结果

- 已满足验收 ID：
- 未满足/未验证：
- 外部副作用：
- commit/push/deploy：必须为未执行
- 下一步：


## 开始基线（2026-09-12，第二段会话）

- 执行者实际模型/effort：glm-5.3-flash[1M]，最高可用 thinking。
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`；branch：`codex/final-dual-review-cloud-acceptance`（ahead 2）。
- 工作树：125 个 tracked 修改/untracked 条目（A/B/C + 两轮 QA 累计）；`git diff --check` exit 0。
- 服务：Studio PID 77872（4317，health 200）、Codex Broker PID 46372、ZAI Broker PID 46486（两 socket health 200）。
- Oracle transcript 已核验存在，SHA-256 与资料包一致（9cc84c22…b257）。

## 四条失败 run 关联（决定性证据）

对每条 run 的 `nodes/creative-planning/agent-loop-checkpoints/*` 与 Broker durable record（`.local/runtime/codex/tasks/.video-factory/codex-idempotency/openai/`）逐条核对：

| run | 原 treatment/audit 循环（checkpoint=33fd70ad…，status=passed） | Broker durable 记录 | 秒败的 produce（checkpoint=ae02efba…，新循环首个 produce） |
| --- | --- | --- | --- |
| run-b0440c8f | agent-093e(treatment)+agent-1167(audit=repair)+agent-8c09(treatment v2)+agent-967d(audit=pass) | 全部 completed ok=true | agent-f671… **不在 durable store**（受理前被拒） |
| run-64be4d66 | agent-d547(treatment)+agent-fc93(audit) | completed ok=true | agent-49fe… 不在 store |
| run-091ae38e | agent-c619(treatment)+agent-d223(audit) | completed ok=true | agent-e189… 不在 store |
| run-c555c789 | agent-e781(treatment)+agent-f5b1(audit) | completed ok=true | agent-9047… 不在 store |

判定（以证据修正第二轮 QA 报告的两处推测）：

1. **不存在"第三方摧毁 socket"**。treatment 循环在同一连接模型下长等待并成功；失败点是**下一个角色循环（script-draft 编剧）的首个 produce**，在 broker 解析/校验阶段被确定性拒绝（未写 durable acceptance），耗时 15ms。直连探针复现：`script-draft` payload 携带 `durationRange` → HTTP 400 `payload.brief.durationRange is not allowed`。Studio 侧编剧 brief 还会附带 `creativeTreatment` 与 `planningIssues`（同样不在 broker `requireScriptBrief` 白名单）。
2. **"连接中断，结果未知"文案是错误分类产物**：400 不属于 not_accepted（503/未知会话 409）也不属于 completed_failure（422），被压进 `uncertain` → creatorMessage "与模型服务的连接中断"。真实任务事实是"已确证未受理（合同拒绝）"。
3. **重试秒败不是 sessionRebuilds 预算耗尽**（0=已使用零次）：重试时 treatment 循环按 checkpoint 直接 passed 跳过，编剧循环以全新确定性 requestId 重发同一非法 payload → 再次 400。
4. **已完成的 treatment 成果并未丢失**：durable record + passed checkpoint 均在；修复编剧合同后，按确定性 requestId 重试将先 replay treatment（0 次新模型调用），再以修正后的 payload 执行编剧。
5. topic-ideas 漂移（R2-001）独立成立：creatorStrategy/generationNonce/长度 6000 vs 2000/无 digest 保护，直连 400 已证。

## 失败测试与实现（随批次追加）

## 失败测试与实现批次（2026-09-12）

失败证据（旧实现稳定变红）：
- 直连探针（会话记录）：`script-draft` payload 带 `durationRange` → 400 `payload.brief.durationRange is not allowed`（旧白名单拒绝）；
  `topic-ideas` payload 带 `creatorStrategy` → 400 `creatorStrategy is not allowed`。
- 四条失败 run 的 durable 关联：treatment/audit 全部 completed ok，编剧首个 produce 全部未进入 durable store（受理前被拒）。
- 分类：PRODUCT_BUG（topic/script 合同漂移 + uncertain 错误分类 + accept/poll 缺失）。

实现批次：
1. topic 合同（TC-01..05）：
   - 新增 `apps/studio/src/server/topic-ideas-payload.ts`：canonical payload 构造
     （只含 signals/strategy；strategy 上限 2000 与 broker 一致；generationNonce 只进生成身份）。
   - `trend-opportunity-agent.ts`：generate() 改用共享构造；produce 发 canonical payload；
     静默 catch 改为结构化诊断 `generationFallback`（category/reason）落到规则候选上。
   - `apps/codex-broker/src/task-definitions.ts`：topic-ideas semantics bump
     （topic-ideas-semantics-v4|canonical-strategy-v1 → 新 digest d5209510…）。
   - `codex-executor.ts`：topic-ideas 纳入 contract-protected（必须携带 expectedContractDigest）；
     `requireScriptBrief` 白名单扩展 durationRange/creativeTreatment/planningIssues（含边界校验）。
   - `codex-chat.ts`：REQUIRED_CODEX_TASK_CONTRACT_DIGESTS += topic-ideas；
     `contracts.ts` taskContractDigests 白名单改为从共享 digest 集合派生。
   - 跨进程合同测试 `apps/codex-broker/test/topic-script-contract.cross.test.ts`
     （Studio builder × Broker parser，6 用例）。
2. accept/poll（BR-01..07 / RC-02..06）：
   - broker-server.ts：durable 模式重构——durable lookup 先于 session registry（F-03）；
     POST 在 accepted record 落盘后返回 202（同 requestId 重放 completed/409 conflict）；
     新增只读 `GET /v1/tasks/:requestId`（404=权威 not_accepted；running；completed 用 200 信封）；
     后台执行独立落盘（503 撤回 record、uncertain 保持 accepted、其余写 completed）；
     非 durable 模式保留长轮询+断连取消。health taskContracts 暴露 topic-ideas。
   - `codex-chat.ts`：客户端改为 submit once + poll original task；
     查询失败（transport/5xx/半包/非信封）不改变任务事实，截止内继续轮询；
     截止后 uncertain（不再伪造“连接中断”）；新增 stage rejected/conflict 及其 creator 文案；
     404=权威 not_accepted 交还既有有界重试。
   - 新增跨进程恢复测试 `apps/codex-broker/test/codex-bridge-recovery.cross.test.ts`（4 用例：
     轮询到完成/丢失后重提交取回/查询故障容差/权威 not_accepted），全部走真实 socket+durable。
3. UX（UX-04..06）：
   - `TopicEntryWorkspace`：恢复面板统计改为“规则保底(含被阻断)”与“来源阻断”两个独立维度，
     全规则轮次不再谎称“总编已评估”。
   - `DirectorPanel`：新增 recentTopicGeneration 投影（editor-model/rule-fallback），
     “AI 选题总编可用”改为“已配置”+ 最近一轮真实生成来源提示；TodayPage 从收件箱 items 派生。

旧测试同步（STALE_TEST，保留安全断言）：broker-server.test.ts durable 用例改 202+轮询助手
（postTaskAwaitOutcome，解包完成信封）；topicTaskBody/executor 夹具带合同摘要；
ScriptedExecutor 默认补 trace.contractDigest（与真实 executor 一致）；
codex-chat.test.ts 两个 200 响应带 trace；creative-os 恢复面板零候选文案同步。

## 全量验证
（见下一条记录）

## 全量验证（第一轮，/opt/homebrew/bin/node v26.8.1）

- `test:ts`：764 项，763 pass / 0 fail / 1 已解释 skip，exit 0。
- `test:broker`：166 项全 pass，exit 0。
- `test:package`：3 pass，exit 0。
- `pytest`：131 passed，exit 0。
- `git diff --check`：exit 0。
- `studio:test`：vitest 374 全过；node --test 476 中 3 项失败（formatTopicStrategy 旧断言
  仍读 creatorStrategy 旧字段 + 截断保留补充原则行为被盲切破坏）。
  分类：STALE_TEST×2（字段名）+ PRODUCT_BUG×1（截断丢掉末尾补充原则）。
- 补充修复：formatTopicStrategy 在 2000 上限内从头丢弃可选段、保留最末“补充原则”；
  测试断言字段名同步为 strategy。
- `build:pipeline`：exit 0。

## 全量验证（第二轮，最终）
（见下一条记录）

## 全量验证（第二轮，最终）——全部 exit 0

- typecheck 0；studio:test 0（vitest 374 + node --test 476/476，含 STALE_TEST 同步后）
- test:ts：763 pass/0 fail/1 已解释 skip；test:broker 166/0；test:package 3/0
- build 0；pytest 131 passed；git diff --check 干净

## 真实本地 QA（第三轮）

- 正式环境：新 dist 重启三服务；topic-ideas 合同摘要已在 broker health 暴露（实测 True）。
- 真实模型选题：刷新后收件箱出现 api-topic-editor-v1 真实候选（produce_image_story, 48 分）
  ——R2-001 修复的真实环境实证。
- 来源门槛对模型候选如实拦截（1/2 来源）。
- 生产 run 浏览器全链未完成（浏览器会话重启后失效+上下文耗尽），编剧链修复由
  跨进程合同/恢复测试在真实 socket+durable 路径证明；列为下一轮第一优先。
- 费用：0 现金消费。

## 最终结果

- 已满足验收：TC-01..05、BR-01..07、RC-01..06/08、UX-04/05/06（组件级）、SF-01（文本）。
- 未满足/未验证：RC-07 显式回归（查询不触暂停，结构上不可能触发）、UX-03 1440/390 新截图、
  F 节完整媒体漏斗 E2E、SF-02..07（本轮无媒体任务）。
- 外部副作用：gpt-5.6-sol 订阅用量（选题轮×2 + 恢复测试 0 真实调用——测试用受控 executor）；
  workspace 新增 1 条模型候选机会的采用拦截记录；无删除/迁移。
- commit/push/deploy：未执行。
- 下一步：真实 Web 完整漏斗走查（第一优先）。
