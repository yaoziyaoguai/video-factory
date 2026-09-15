# 审计证据说明

这里只包含隔离故障测试和 2026-09-12 的原始日志，不是 Fake Broker 服务，不得接到正式 Studio。

- `transport-audit.test.mjs`：12 个初始红灯探针，真实 Broker/client/socket，executor 为依赖注入的受控替身。
- `completion-failure-child.mjs`：仅在调用者提供的 mkdtemp 目录注入完成落盘失败；用于验证 Node 进程是否因后台 rejection 退出。
- `audit-red-baseline.txt`：12 fail / 0 pass，exit 1。最新 P02 同 ID 并发 12 次、executor 12 次。
- `existing-contract-recovery.txt`：原新增测试 10/10 pass，exit 0。
- `existing-session-idempotency.txt`：原 session/idempotency/lifecycle 聚焦 7/7 pass，exit 0。
- `r3-review-existing-green.txt`：执行 revision 1 后复审，原探针与正式跨进程/owner 测试 29/29 pass，exit 0；此前红灯日志仍保留作历史。
- `r3-review-probes.mjs`：本次新增的运行中 UI、健康任务观察、否定句校验三个隔离探针。
- `r3-review-red.txt`：三个新增探针 3 fail / 0 pass，exit 1。修复方向和允许的测试迁移见 `../REVIEW.md`，不能只加否定关键词让探针变绿。

测试日志中的 session handle、Provider 名和路径均来自隔离夹具，不是真实用户凭据。测试未调用模型、未产生媒体费用。

从仓库根运行：

```sh
node --test --import tsx docs/codex-collaboration/evidence/transport-audit.test.mjs
```

这是初始复现工具，不是最终正式回归套件：

1. 修复时将行为测试迁入相应 broker/pipeline/studio 正式测试目录，并增加屏障、并发和子进程验证。原始日志保留不改。
2. 新查询协议引入绑定后，必须更新正式测试的请求 helper 和代理 headers，使其通过新合法协议完成前置受理/查询。否则 P03 会使其他测试因旧 helper 提前失败，不能据此判修复退化。
3. P07 允许改成“无派生索引时仍能恢复同一会话、executor 不重跑”的行为断言，不绑定某种索引修复时机。
4. P04 需区分有完整新绑定的 orphan 与旧版本证据不足；两者都不得假称 running 或自动重买，旧版本可安全显示无法核验，而非强行返回某个新状态。
5. P08 正式测试分别覆盖 rejected/conflict，不能因循环第一项失败而漏掉第二项。
6. 并发不要仅靠 sleep；正式用 barrier 控制争用窗口。原探针只证明当前存在竞态，不保证每次重复次数一致。
7. 在 RESULT 标明每个探针对应的新正式测试。不得删除或反转核心断言，只为把红灯改绿；不得把这一目录从读取中排除来声称无问题。
