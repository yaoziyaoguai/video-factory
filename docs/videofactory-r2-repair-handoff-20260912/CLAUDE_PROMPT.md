# 可直接发送给全新 Claude Code session 的完整 Prompt

你是 VideoFactory 当前集中修复任务的代码执行者。请直接接管本地共享仓库：

`/Users/jinkun.wang/work_space/veidofactory`

首先完整读取本轮资料包：

`/Users/jinkun.wang/work_space/veidofactory/docs/videofactory-r2-repair-handoff-20260912/`

按顺序阅读：`README.md`、`CURRENT_STATE.md`、`ORACLE_SYNTHESIS.md`、`EXECUTION_CARD.md`、`ACCEPTANCE.md`、`VERIFICATION.md`、`MATERIAL_MANIFEST.md`、`JOURNAL.md`。再完整阅读资料包列出的两轮 QA 报告、Oracle transcript 和当前相关源码。资料包的文件/行号只是导航；必须以当前源码和可复现证据重新核验。

这是全新 session，必须先建立真实基线。当前已知基线 HEAD 为 `570fe6e59e072c4965c86769bf2096825f003383`，分支为 `codex/final-dual-review-cloud-acceptance`，工作树包含 A/B/C 与两轮 QA 的大量未提交修改。严禁使用 `git reset`、`git stash`、`git checkout`、`git clean`，严禁覆盖或删除现有修改和 untracked 产品文件。不要把旧聊天中的授权当作事实，只使用本 prompt 的权限。

你的任务不是只修某一个 run，也不是每修一点就停下来审计。请一次集中完成资料包内 R2-ISSUE-001～004 及同根因问题：

1. 统一 `topic-ideas` 的 Studio/Broker 合同族：canonical 字段为 `strategy`；`generationNonce` 不进入模型 payload；统一长度、schema、validator、descriptor、digest；加入真实 Studio payload × Broker parser 的跨进程合同测试；模型失败的规则回退必须留下结构化诊断，不能冒充模型成功。
2. 在现有 Broker queue、durable idempotency record、session 和 executor 上实现最小 `accept/poll`。POST 只有 durable acceptance 落定后才返回 accepted/202；查询原 requestId 的端点只能读取同一 durable record，不能提交 executor、切 backup 或创建新任务。不要引入 Redis、微服务、通用工作流框架或第二套生产流程。
3. 修正 durable lookup 顺序：可验证的原 completed record 不能因为临时 session registry 缺失而被误报成未受理。
4. `CodexBridgeClient`、fallback、role loop/checkpoint、ProductionPipeline、Studio service/API/shared DTO/UI 必须形成 `submit once + observe original task` 的完整恢复闭环。accepted/unknown 时禁止新 requestId 和 backup；只有 Broker 权威确认 `not_accepted` 才允许现有有界重试。
5. 结构化区分任务事实与本次观察错误。覆盖 not accepted、accepted/running、completed success/failure、accepted unknown、query failure、transport reset、timeout、partial response、parse error、binding conflict。服务端提供结构化 allowed actions，前端不得匹配中文字符串决定按钮。
6. 修复热点恢复面板：来源阻断与是否总编评估是独立维度；`blocked + pendingEditorReview` 不能显示“总编已评估”。把 capability ready 与最近一次真实任务 outcome/规则回退分开显示。

开始实现前，先用四条失败 run（`run-b0440c8f`、`run-64be4d66`、`run-091ae38e`、`run-c555c789`）关联真实 Broker durable record，记录 kind、canonical payload hash、request digest、contract digest、session 和 outcome，确认秒败的真实绑定差异。不能把 QA 报告关于“第三方摧毁 socket”的推测当成已证实根因；也不能把 `sessionRebuilds=0` 误读为预算耗尽。

必须先建立稳定变红测试，再实现。测试必须使用真实 `CodexBridgeClient`、真实 `CodexBrokerServer`、真实 Unix socket、真实 durable directory、真实 role loop/checkpoint；只替换外部 executor。至少覆盖：Studio payload × Broker parser、durable completed 后响应丢失、accepted/running 查询、session registry 缺失但 completed record 完整、同 requestId 不同 digest/session/kind/contract、查询失败不改变任务事实、HTTP/transport/解析错误分类、服务端 allowed actions 和 1440/390 UI。新测试必须纳入正式 npm 测试脚本，不能成为孤儿。

保持以下安全不变量：同一物理请求最多调用一次；accepted/unknown 不切 backup；未授权媒体 create=0；暂停不能被查询自动解除；双审是两个不同真实模型且共享同一不可变 evidence；补审只补失败分支；局部返工不扩大；素材失败绝不能用说明卡伪装成功；不恢复 legacy 新生产流程。

实现后集中运行并记录完整 exit code：

```bash
npm run build:pipeline
npm run test:ts
npm run studio:test
npm run test:broker
npm run test:package
npm run build
npm run typecheck
uv run pytest tests/
git diff --check
```

不要把 timeout、截断输出、旧日志或只跑部分测试算作通过。若发现同根因回归，集中修完再统一回归，不要每改一点就停下来请求审计。

确定性测试全部通过后，核对并安全重启正式本地环境：正式 Codex Broker、ZAI Broker、Studio production build、真实持久化 workspace 和现有 Provider 配置。不得创建 fake broker、fake transport 或第二套组合根；不得删除真实 run、checkpoint、Broker record 或用户数据。

然后使用已经安装的 QA 技能，通过真实 Web 点击完成第三轮本地 E2E。三个入口（热点、系列、自有想法）都要覆盖，并尽量走完规划、报价、人工确认、媒体、配音、渲染、双模型审片、打回、建议预填和局部返工。先尽量把整条链的问题和原因记录完，再按共同根因集中修；除非完全阻塞后续覆盖，否则不要边测边碎修。

本轮允许你在确定性回归全绿后，为真实本地 E2E 自行确认合理的小额图片/视频/素材/配音费用。每笔先核对报价、范围和可复用成果；不要通过重复真实购买测试幂等性。若单笔或累计出现数百元级异常预估，立即停止并报告。文本模型和审片按现有订阅配置执行。

完成后：

- 更新 `/Users/jinkun.wang/work_space/veidofactory/docs/videofactory-r2-repair-handoff-20260912/JOURNAL.md`。
- 新增完整第三轮 QA 报告，建议路径 `docs/qa/videofactory-real-local-qa-20260912-03.md`，保留截图与 run/request/outcome/费用证据，但不得记录凭据、完整 prompt 或私人数据。
- 如实列出通过、失败、未验证项和外部副作用。
- 不得 commit、push、云端部署。

普通测试失败、实现困难或上下文变长都不是停止理由。只有需要新的产品决定、破坏性操作、数百元级异常费用、无法替代的外部阻塞，或实际模型/effort 被降级且影响结果时才停下来报告。完成全部任务后再停止，不要进入下一轮 Oracle 审计。

