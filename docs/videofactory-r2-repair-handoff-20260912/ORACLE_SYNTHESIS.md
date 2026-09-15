# Oracle Web 第 5 档审计综合

## 会话证据

- slug：`vf-r2-transport-contract-repair-audit-20260912-01`
- 状态：completed
- 网页实际强度：`Pro，第 5 项，共 5 项`
- 新独立 conversation：`https://chatgpt.com/c/6aa4cb4f-fd18-83eb-b618-b54c77d39015`
- 附件：25 个，约 440.51k 输入 token
- transcript：`/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-r2-transport-contract-repair-audit-20260912-01/artifacts/transcript.md`
- transcript SHA-256：`9cc84c227ac0df1a88dd13f971e9e0f908936e3ce8274f3bd6a75e0e08e5b257`
- 结果：`CHANGES_REQUIRED`
- Oracle Chrome PID 97108 已退出；临时 userDataDir `/var/folders/0y/bqp593v95dqdf62qylfn92ch0000gq/T/oracle-browser-7jegCf` 已删除。

## Findings

### F-01 / P1：topic 合同是合同族漂移

不是只改一个字段：字段名、`generationNonce`、长度限制、输入 validator、descriptor、digest 和测试都不一致。

裁定：

- canonical 字段统一为 `strategy`，不保留永久双字段兼容。
- `generationNonce` 只参与生成轮次、checkpoint 和 request identity，不进入模型 payload。
- 建立共享、无副作用的 `topic-ideas` 合同模块；Studio 构造的真实 payload 必须经过 Broker 使用的真实 parser/validator。
- `topic-ideas` 必须纳入合同摘要保护。
- 测试必须实际跨越 Studio payload builder × Broker parser，不能只让两端导入同一个硬编码 digest 后互相“证明”。

### F-02 / P1：已受理任务没有查询/恢复闭环

已有 durable record、queue 和 executor 足以修复，不需新基础设施。最小方案为 `accept/poll`：

```text
Studio 冻结请求绑定并落 checkpoint
  → POST /v1/tasks 只提交一次
  → Broker durable acceptance 落定后返回 accepted/202
  → Studio 通过短请求查询同一 requestId
  → completed 后校验并消费同一 outcome
```

查询接口只能读取原 durable task，不能调用 `queue.submit`、不能触发 fallback、不能创建新 requestId。

### F-03 / P1：durable lookup 顺序错误

当前 Broker 在 `runIdempotent()` 前先解析 session。若原任务已 completed，但派生 session registry 缺失，恢复可能在读取完成记录前被拒绝，并被误认为 `not_accepted`。

裁定：同一 requestId 的 durable record 核验应先于依赖临时 session registry 的恢复检查。完整的 completed record 是原任务结果的权威证据。

### F-04 / P2：错误分类混淆

必须区分两组维度：

- 任务事实：`not_accepted`、`accepted/running`、`completed_success`、`completed_failure`、`accepted_unknown`。
- 本次观察：成功、timeout/disconnect、HTTP error、incomplete response、parse error、query failure、binding conflict。

一次查询失败不能把原本 accepted/unknown 的任务降级为 not accepted。按钮和权限必须由服务端结构化状态决定，不能匹配中文错误字符串。

### F-05 / P2：缺少正式 durable 跨进程恢复测试

测试需使用真实 `CodexBridgeClient`、真实 `CodexBrokerServer`、真实 durable 文件和真实 role loop/checkpoint；只替换 executor。至少覆盖：

- accepted 后响应丢失，executor 仍只调用一次，查询取回结果。
- running 查询。
- completed record 完整但 session registry 缺失。
- 同 requestId 不同 digest/session/kind 的 conflict。
- 查询连接自身失败，不改变原任务事实。

### F-06 / P3：选题状态维度混淆

`pendingEditorReview` 与 `verification.status=blocked` 可以同时存在。恢复面板和健康状态需分别投影“是否总编评估”“是否来源阻断”“能力配置是否 ready”“最近一次真实任务结果”。

## 推荐的最小架构

### Broker

- 保留现有 queue、executor、durable idempotency 和 session registry。
- 抽出单一 `acceptTask`/durable record 状态机，POST 和兼容等待形式都复用它。
- 新增查询原任务的只读端点，例如 `GET /v1/tasks/:requestId`。
- POST 返回 202 前必须已经完成 durable acceptance；202 不可只是内存排队成功。
- completed outcome 可重复读取；query 不修改任务事实。
- record 保存 kind、requestDigest、taskContractDigest、输入 session 绑定、实际 executor identity、accepted/completed 时间和 terminal outcome。

### Studio / pipeline

- `runTaskDetailed()` 外部签名可保持不变，内部改为 `submit once + observe original task`。
- 首次网络提交前，把不可变请求绑定写入 checkpoint。
- uncertain/accepted pending 时，恢复优先查询原任务，不重新 produce、不换 backup、不增加 generation/attempt/sessionRebuilds。
- 只有 Broker 权威确认 `not_accepted`，才可按现有有界策略产生新 requestId。
- completed success 取回原 output/trace/session 并继续；completed failure 展示真实终态，不无限查询。
- digest/session/kind conflict 停止自动执行并提供可行动诊断。

### UI

- unknown：`核对原任务`
- running：`刷新状态` / `继续等待`
- completed success：`取回结果并继续`
- query failure：`再次核对`
- 明确 not accepted 的瞬态失败：`重新尝试`
- 配置/合同错误：`查看诊断` / `调整配置`
- binding conflict：停止自动继续，不能提供普通重试按钮。

暂停是用户意图，查询结果不能自动解除暂停。服务端 DTO 必须给出结构化 `allowedActions`。

## 明确拒绝的方案

- 仅增加 timeout。
- 断连后提交新 requestId。
- accepted/unknown 时切到 backup 模型。
- Redis、第二个队列、第二个 production runner 或通用 workflow framework。
- 清 checkpoint、重算当前模型 digest 后把旧任务当新任务。
- 用中文文案判断恢复权限。
- 只测 mock client，不测真实 Unix socket + durable 文件。

