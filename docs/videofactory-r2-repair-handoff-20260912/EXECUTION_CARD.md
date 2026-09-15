# 集中修复执行卡

任务编号：`VF-R2-TRANSPORT-CONTRACT-REPAIR-20260912`

执行者：Claude Code。目标是一次集中修复本包内全部问题；不要在单个小修后停下等待审计。

## 用户可观察目标

1. 热点入口真实调用选题总编；合同出错时不静默冒充成功。
2. 长模型任务即使观察连接断开，也能核对并取回原任务结果，绝不重复调用付费或订阅 Provider。
3. 失败页面准确告诉用户任务事实和下一步；按钮真正可用。
4. 热点恢复面板不再谎称总编已评估；能力 ready 与最近一次任务健康分开。
5. 修复后正式本地 E2E 能走到报价、媒体、渲染、双审、打回和局部返工。

## 开始前

1. 完整读取本资料包、两轮 QA 报告和 Oracle transcript。
2. 记录 `git rev-parse HEAD`、`git status --short --branch`、tracked/untracked 列表、`git diff --check`。
3. 核对当前三个服务 PID、工作目录、命令、socket、health、构建时间；不要盲杀进程。
4. 对四条失败 run，从 run/checkpoint 提取原 requestId，并关联 Broker durable record。记录 kind、canonical payload hash、requestDigest、taskContractDigest、输入/输出 session、Broker identity、accepted/completed 状态和时间。
5. 不读取或输出密钥内容；只核对是否配置、进程是否实际加载。

## 必须先建立的失败证据

### R2-R1：真实 topic 跨进程合同

使用 Studio `CodexTopicIdeaModel` 的真实 payload 构造路径和 Broker 的真实 parser/validator。断言：

- 只有 canonical `strategy`。
- 没有 `creatorStrategy` 和 payload-level `generationNonce`。
- strategy 长度、schema、descriptor 与 digest 统一。
- 合法 payload 通过；未知字段、过长字段、digest 不符被结构化拒绝。
- force refresh 改变生成 identity，但不污染模型 payload。

旧实现必须稳定变红。

### R2-R2：accepted/completed 后观察连接丢失

使用子进程 Broker、真实 Unix socket、真实 durable directory、真实 `CodexBridgeClient`、真实 role loop/checkpoint；只用 barrier executor 替代外部模型：

1. 首次请求 durable accepted。
2. executor 返回合法 outcome，Broker durable completed。
3. 测试代理丢弃首次结果交付连接。
4. Studio 用正式恢复动作查询同一 requestId。
5. 原 outcome 进入 checkpoint，executor 调用数严格为 1。

恢复查询不得增加 generation、模型尝试、session rebuild、fallback 或新 requestId。

### R2-R3：running 和查询失败

- accepted/running 可重复查询，结果一致。
- 查询连接失败后任务事实仍为 accepted/unknown，动作仍是核对原任务。
- 查询本身不能提交 executor。
- completed success/failure 可重复读取。

### R2-R4：session registry 缺失

创建两步真实 session 任务，保留第二步 completed record，仅删除测试临时目录内的派生 session registry，再查询第二步原任务。应返回 completed outcome，executor 增量为 0。

### R2-R5：绑定冲突

同 requestId 分别改变 digest、kind、输入 session 或 contract digest，必须返回结构化 conflict；不得执行、不得切 backup、不得清 checkpoint。

### R2-R6：错误分类和 UI 动作

覆盖 HTTP 400/409/500、transport reset、timeout、partial response、parse error、query failure、not accepted、running、completed failure。断言服务端 `taskRecovery` 与 `allowedActions`，以及 UI 按钮/文案；禁止按中文字符串推断权限。

### R2-R7：总编统计和健康

- 12 条 `blocked + pendingEditorReview`：显示“规则保底/待总编评估”，不得声称已评估。
- 来源阻断数量与总编评估数量独立。
- capability ready 与 recent task outcome 分开显示。
- 模型失败后规则回退必须有结构化诊断，同时仍可按产品合同展示候选；不能静默冒充模型成果。

## 推荐实现顺序

1. 关联四条失败 run 与 durable records，先裁定真实绑定差异；不能拿报告推测代替证据。
2. 建立上述失败测试并确认旧实现变红。
3. 抽取共享 `topic-ideas` 无副作用合同，统一 builder、parser、长度、descriptor 和 digest；更新旧错误测试。
4. 调整 Broker durable lookup 顺序，先恢复可验证的原 record，再处理临时 session registry。
5. 在现有 queue/record 上实现最小 accept/poll；不要新增第二套 executor 或业务队列。
6. 将 `CodexBridgeClient` 改为 submit once + 短查询观察；保留对调用方稳定的 `runTaskDetailed()` 语义。
7. 把 pending request binding 落入现有 role-loop/checkpoint；恢复时先 reconcile，只有权威 not accepted 才能按原有界策略重试。
8. 贯通 production pipeline、Studio service/API/shared DTO 和 UI 的结构化任务事实、观察错误与 allowed actions。
9. 修正热点回退诊断、总编统计和 recent task health 投影。
10. 集中运行聚焦、跨进程、故障注入和全量回归；修完同轮发现的问题。
11. 确定性测试全绿后，停止旧服务并以正式构建重启真实本地环境。
12. 使用 QA 技能完成真实浏览器 E2E。第一遍先尽量测全、完整记录，再集中修复，不要边测边改。

## 允许修改的最小范围

- `apps/codex-broker/src/`：task contract、Broker route、durable record/lookup、结构化状态。
- `packages/production-pipeline/src/`：Codex client、fallback、role loop/checkpoint、pipeline 恢复投影。
- `apps/studio/src/server/`、`src/shared/`、`src/client/`：topic payload、service/API DTO、恢复动作和用户文案。
- 上述模块对应测试及正式 package scripts。
- `docs/qa/`：只新增本轮报告/截图或修正明确的事实错误；保留旧证据。
- 本目录 `JOURNAL.md`。

实际改动可比此更小。若需要扩展到明显无关模块，先记录原因并证明合同跨越该边界。

## 不可破坏的不变量

- accepted/unknown 不切 backup，不创建新 requestId。
- 同一物理文本/媒体请求最多执行一次。
- 未授权媒体 create 必须为 0。
- 已授权媒体逐笔核对，优先保证质量并合理节省；异常到数百元停止。
- 双审必须是两个实际不同模型，同一不可变证据，互不可见。
- 单审失败只补失败分支，不重买素材、不重配音、不重渲染。
- 局部返工不扩大到全片；未受影响的计划、母片和 evidence 保留。
- 用户暂停不会被后台查询自动解除。
- 素材失败停在可操作状态，绝不使用说明卡伪装成功。
- 不恢复 legacy 新生产流程，不删除历史兼容读取。

## 权限

- 可以修改本地产品代码、测试和本包日志。
- 可以重启正式本地服务。
- 确定性回归全绿后，可以在真实本地 E2E 中自行确认合理的小额图片/视频/素材支出；每笔先看报价与范围，复用已购买成果，禁止用重复购买测试幂等性。
- 文本模型、审片和配音按当前产品规则执行。
- 不得 commit、push、云端部署、删除/迁移用户数据或清理 durable 证据。

## 停止条件

只有以下情况中途停下：需要新的产品决定、破坏性操作、数百元级异常报价、无法替代的真实服务阻塞，或模型/环境实际被降级且影响结果。普通测试失败、实现困难和上下文较长都不是停止理由。

完成后必须更新 `JOURNAL.md` 和新的真实 QA 报告，如实列出未验证项；不得只说“已完成”。

