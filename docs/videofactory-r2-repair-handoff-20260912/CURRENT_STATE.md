# 当前状态与已确认事实

## 仓库

- 路径：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- 基线 HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 分支相对远端：ahead 2
- 当前工作树包含 A/B/C 以及两轮 QA 的大量未提交修改和新增文件。
- 创建本包前 `git diff --check`：exit 0。

严禁 `reset`、`stash`、`checkout`、`clean`。不能覆盖当前修改，也不能把 untracked 产品文件当临时垃圾删除。

## 已完成

- A/B/C 功能开发及 C 阶段 Oracle 第 5 档统一审计修复已经完成。
- 第一轮 QA 的 5 个问题已集中修复，并在第二轮真实浏览器中验证：搜索覆盖与深链、保存机会反馈、缺失能力定位、高亮和焦点、移动端 skip-link、`pendingEditorReview` 基础投影。
- 第二轮修复前确定性回归：
  - `test:ts`：763 pass / 0 fail / 1 已解释 skip
  - Studio：476/476
  - Broker：156/156
  - Python：131 passed
  - build、typecheck、`git diff --check`：exit 0

这些数字只是上一轮证据，不是本轮完成证明。执行者必须重新运行。

## 正式本地环境

2026-09-12 本包创建时再次核对：

- Studio：PID 77872，`http://127.0.0.1:4317`，`/api/health` 返回 ok。
- Codex Broker：PID 46372，socket `.local/runtime/codex/worker.sock`。
- ZAI Broker：PID 46486，socket `.local/runtime/zai-codex/worker.sock`。
- Codex：`gpt-5.6-sol`，xhigh。
- GLM：`glm-5.3`，max；部分子任务按现有目录使用 `glm-5.3-flash`。
- workspace：`/Users/jinkun.wang/work_space/veidofactory/workspace/factory`。
- Python、ffmpeg、ffprobe、say：ready。

继续执行前仍须重新核对 PID、命令、socket、health 和构建时间，不能因为这里记录过就假定仍有效。

## 第二轮真实 QA 问题

### R2-ISSUE-001 / P1：热点选题合同漂移

- Studio `CodexTopicIdeaModel` 发送 `creatorStrategy`，Broker 只接受 `strategy`。
- Studio 还把 `generationNonce` 放进模型 payload，Broker 不接受。
- Studio 的策略长度上限约 6000，Broker 为 2000。
- `topic-ideas` 未进入 `REQUIRED_CODEX_TASK_CONTRACT_DIGESTS` 的保护集合。
- Studio 单元测试断言了错误的单端 payload，导致错误被测试固化。
- `TrendOpportunityAgent.listCandidates()` 的空 `catch {}` 把合同错误静默变成规则候选。

真实影响：热点候选 12/12 为 `trend-heuristic-v1`，用户无法从热点入口进入生产。

### R2-ISSUE-002 / P1：长任务完成但结果未交付

- 4 条真实 run 均在 `creative-planning` 显示 uncertain。
- Broker 侧相关任务实际成功完成，Studio 未消费结果。
- 失败 run：`run-b0440c8f`、`run-64be4d66`、`run-091ae38e`、`run-c555c789`。
- QA 已证明“结果交付/消费链路失效”，但没有证明具体是谁销毁 socket。
- 正式客户端 timeout 为约 41 分钟，不能把库默认超时当根因，也不能用继续加 timeout 作为修复。

### R2-ISSUE-003 / P1：uncertain 后无恢复闭环

- “重试失败步骤”很快再次失败，已完成 Broker outcome 无法通过 UI 取回。
- 当前 Broker 已有同 requestId 的在途合并、completed 重放和 digest conflict；若绑定完全相同且请求到达同一 Broker，理论上应能拿到旧结果。
- 秒败意味着 kind、canonical payload、request digest、contract digest、session 或 Broker identity 至少有一个不一致，或请求没有抵达 Broker。
- 当前错误分类把多类 HTTP、解析、transport 和 acceptance 状态压成“连接中断”，造成误导。

### R2-ISSUE-004 / P3：总编统计文案错误

当候选全部是 `blocked + pendingEditorReview` 时，恢复面板仍称“选题总编本轮评估了 12 条”。来源阻断和是否总编评估是两个独立维度，不应互相过滤。

### OBS-R2-01 / P3：ready 与真实健康混淆

页面“AI 选题总编可用”只证明 Broker/合同探针可达，并不证明最近一次真实任务成功；应分别展示配置/能力 ready 与最近一次任务成功、失败或规则回退。

## 不得误读的现有行为

- `sessionRebuilds` 是已使用次数；0 不是预算耗尽。
- durable 分支不随 HTTP observer 断开取消执行，这是避免重复调用所需的行为，不应随手删除。
- `health.completed` 只是队列计数，不等于 outcome 已持久化且 Studio 已消费。
- 文本模型和审片使用订阅，不需要现金确认；配音按现有自动执行和记账规则不变。
- 图片、视频、图库等媒体在报价后由人工确认；本轮真实 QA 已授权合理小额消费，但每笔仍需核对，异常到数百元必须停下。

