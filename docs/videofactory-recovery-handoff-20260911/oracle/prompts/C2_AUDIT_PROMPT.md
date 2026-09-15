# VideoFactory 恢复审计：C2（Batch 4/4）

你是独立的产品、API、安全和 UX 审计者。你只提供分析、规划、审计和执行建议，不修改文件、不调用付费 Provider、不部署。当前主 Codex 会核对结论并整理成供 Claude Code + GLM 5.3 Flash 执行的资料包。允许内部多视角并行分析，最终必须给统一结论。

## 项目与基线

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 工作树含 86 tracked + 22 untracked 的累计实现，旧日志和旧审计不能证明当前完成。
- A 已确认；B4/B5/C1 当前分别独立审计。请把 C2 自身问题与前置阻塞分开。
- 本轮只读，不 reset/stash/clean，不 commit/push/deploy，不读密钥，不调用真实 Provider。

## Batch 边界

Batch: 4/4

范围仅为 C2：普通创作者看到并操作的首次确认、追加、改方案、暂停和恢复，以及对应服务/API 安全闭环：

1. server-owned immutable quote：绑定当前 accepted plan、quality contract、catalog-valid models、真实规格报价、有限修复和 maximum；准备报价不得调用媒体 Provider。
2. 首次授权：用户必须先看见 quote，再接受同一个 quote identity；idempotency、authenticated actor、run ownership、revision/lease/CAS 和 response-loss recovery。
3. funding request/amendment：服务端计算差额和权限变化；不能由客户端提交 `additionalCents` 决定；URL authorization 与 request predecessor 必须核对。
4. 三个动作：`同意追加并继续`、`调整方案`、`暂不继续`；已完成成果、缺口、价值/差异、预计追加和最高追加必须可理解。
5. durable pause：阻止一切新的 media create/retry/backup，但允许 reconcile 已 accepted/unknown 请求；明确 resume。
6. 改方案或 scope/model/attempt 变化的 reapproval，包括可能为 0 元的 scope revision；历史 spend/reservation/attempt 不能归零。
7. UI 重开/reload 能恢复 active authorization、pending quote/funding request、pause/accepted command，不重新发明 quote 或 idempotency key。
8. `NewRunDialog` 的 duration range、可选 budget intention、模板推荐，以及确认面板/节点区的普通中文、移动端和键盘可用性。

排除范围：

- 不重做 C1 的底层授权策略，只指出 C2 依赖缺口。
- 不审 C3-C6、模板内容重写、部署或真实付费 E2E。
- 不引入钱包、充值、全站预算引擎、第二套前端状态机或强制的新页面。
- 不为了 UI 通过而放宽 authorization、unknown outcome、quality 或 attempt 边界。

## 当前确定性证据

- Studio service/API 组合：150 tests，142 pass，8 fail。
- 与 C2 直接相关：
  - 首次 immutable quote + authorization + idempotent replay 已通过；
  - stale revision 与 foreign quote 拒绝已通过；
  - amendment 实现签名已变为 `(runId, authorizationId, input, actor)`，测试仍按旧签名，出现 `input === undefined`；
  - HTTP amendment fake 仍按旧参数位置读取，得到 `amend:undefined`；
  - 通用 server 测试的节点编辑请求缺新 expected revision/version，200 预期变 400。
- UI 聚焦：175 tests，171 pass，4 fail；四项旧断言没有包含新 expected revision/version。
- `npm run typecheck` 失败：正式 UI 构造也存在缺 `expectedRunRevision/expectedVersionId`，test fixture 缺 `acceptedPlanDigest`，另有两处重复 JSX 属性。不能只改断言。
- `NewRunDialog.tsx` 已存在 duration range、可选 budget intention 和模板推荐，因此“C2 UI 完全没做”是错误结论。
- 仍未证明：quote 是否在批准前可见、三动作是否闭环、funding request 是否服务端权威、pause 是否阻止所有新 create、重开是否恢复、普通用户文案是否清晰、390px 移动端是否可操作。

附件中的旧 C2 Oracle transcript 是历史 finding。当前源码此后被修改。请对旧 C2-01 至 C2-12 逐项标 `RESOLVED/PARTIAL/OPEN/OBSOLETE`，依据当前文件，不复制旧结论。

## 产品语言与体验原则

- 主流程只让用户做必要决定：看方案和图片/视频最高授权；授权内自动制作；需要追加时三选一。
- 不能暴露 `fundingRequestId`、CAS、lease、provider deployment、核账锁等内部词作为主文案；技术详情可展开。
- “暂不继续”不是失败清空；保留成果并停止新花费。
- “调整方案”应预填已有 findings、保留成果和目标范围，不让用户从空表重来。
- 报价是估计/最高授权，不伪称厂商实际扣费；语音便宜但后台仍可记账，不弹媒体审批。
- 无费用方案也能确认内容并继续，不能伪造正金额授权。
- 普通用户不需要理解 provider，但高级设置仍可按能力类别选择模型和备选。

## 要求输出

用中文输出，保留代码标识符，并严格按以下结构：

1. Verdict：`ACCEPTED` 或 `CHANGES_REQUIRED`。
2. C2 合同完成矩阵：`PROVEN/PARTIAL/CONTRADICTED/UNVERIFIED`，区分 source-level、service-level、browser-level 证据。
3. 旧 C2-01..C2-12 复核表：`RESOLVED/PARTIAL/OPEN/OBSOLETE`，当前位置、剩余失败场景和阻断级别。
4. 新增 P0/P1/P2 findings；区分过时 test/fake、真实 product contract 漏接和 UX 未验证。
5. 推荐唯一 API/状态流：prepare quote → display → accept/recover → auto continue；以及 funding request → 三动作 → amend/replan/pause → reload/resume。明确 server/client 各自能决定什么。
6. 普通创作者信息架构与文案表：每种状态显示什么、主按钮、次按钮、技术详情；指出当前具体 title/copy 哪些不易理解。
7. 适合 Claude Code + GLM 5.3 Flash 的 C2 单阶段执行计划：允许文件、non-goals、先写失败测试、最小实现顺序、通过标准。不要让它趁机重做整个 Studio。
8. 验证矩阵：real route → StudioService → ProductionStudio → Pipeline（外部 transport 可 fake）、crash/idempotency/concurrency/security、quote/funding identities、exact cents、zero spend、pause/reconcile、reload，以及 1440/390、键盘、长内容滚动和错误恢复。
9. 末尾输出：

```yaml
codex_execution_advice:
  implementation_plan:
    - <有序具体步骤>
  non_goals:
    - <明确排除>
  optional_subagents: []
  verification:
    - <检查与预期证据>
```

证据不足写 `UNVERIFIED`。Oracle 建议不授权实现、花钱、部署或升级工具。
