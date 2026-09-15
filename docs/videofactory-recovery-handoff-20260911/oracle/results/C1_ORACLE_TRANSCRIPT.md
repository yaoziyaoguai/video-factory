# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6aa388ac-c240-83eb-8ebc-b038df41912c

## Prompt

# VideoFactory 恢复审计：C1（Batch 3/4）

你是独立的架构、安全和实现审计者。你只提供分析、规划、审计和执行建议，不修改文件、不调用付费 Provider、不部署。当前主 Codex 会核对结论并整理为供 Claude Code + GLM 5.3 Flash 执行的资料包。允许内部多视角并行分析，最终必须给一份统一结论。

## 项目与基线

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 当前有大规模累计未提交实现：86 tracked + 22 untracked，不能按旧日志推断完成度。
- A 已确认；B4/B5 仍在独立恢复审计。请把前置依赖与 C1 自身缺陷分开。
- 本轮只读，不 reset/stash/clean，不 commit/push/deploy，不读密钥，不调用真实 Provider。

## Batch 边界

Batch: 3/4

范围仅为 C1：制作范围授权（production authorization）如何安全派生到现有逐请求 spend authorization/ledger，包括：

1. `ProductionAuthorizationScope` 的 run、revision、accepted plan、quality contract、金额、permitted assets/models、attempts 和 supersession。
2. `resolveProductionSpendDecision` 的 `reuse/resume_existing/execute/request_approval/needs_replan` 优先级和真实消费状态。
3. 授权内自动继续：可信宿主读取当前 scope，为当前精确 spend plan 派生子授权，并继续已有工作流。
4. superseded/current scope、exact cents、累计 settled/reserved/unknown、create attempts、backup model 和 effect/quality identity。
5. 预留必须先于 Provider create，accepted/unknown 只能 reconcile，不重复 create；run lease/CAS/幂等和 crash window。
6. quote/授权 issuer 与 generative worker consumer 对 quality/intent/plan 的投影必须是同一合同。
7. denial/funding request 所需的结构化原因要保留给 C2，但本批不做 UI。

排除范围：

- 不实现 C2 HTTP/UI/三动作，只定义 C1 必须暴露的服务合同。
- 不审 B4/B5 业务细节，只指出其 artifact/plan identity 是否使 C1 无法安全判断。
- 不审 C3-C6、部署、真实扣费、钱包/充值/全局预算系统。
- 不放宽现有 exact authorization matcher，不允许 `hasBudget`、role 名或客户端字段成为绕过条件。

## 用户已确认的费用原则

- 没有全局硬上限，也不默认强加单视频预算意向；预算意向可选。
- 文本/订阅审片不弹现金确认；TTS 自动执行但后台仍可记账。
- 图片/视频在方案和报价可见后由人工授权最高金额；授权额是边界，不是花费目标。
- 授权内首先保证已确认质量，再在达标路线里复用/省钱；不能因便宜静默降质。
- 额度不足应生成可解释反馈：已完成什么、还缺什么、追加金额/最高金额、为何值得、调整方案差异；用户可追加、改方案或暂停。
- 拒绝追加不等于允许降质；说明卡绝不能作为失败 fallback。

## 当前确定性证据

- `production-authorization.test.ts`：25 tests，24 pass，1 fail。
- 失败：`auto-continues a covered quote with a derived sub-authorization`；run 仍停在 `awaiting_spend_approval`。
- authorization + workflow runner + asset worker 组合为 184 tests，180 pass，另外 3 个失败属于 B5 媒体复用。
- scope/decision/安全整数/并发 fold/原型键/authorization host acceptance 等纯合同测试已通过；这不能代替真实 host 自动继续、预留与 Provider 调用边界。
- 当前 `npm run typecheck` 失败，需只归因真正属于 C1 的合同错位。

附件中的旧 C1 Oracle transcript 是历史 finding。当前代码此后被修改。请对旧 F1-F11 逐项标 `RESOLVED/PARTIAL/OPEN/OBSOLETE`，用当前源码证据复核，不复制旧结论。

## 必须重点构造的失败场景

- grant artifact 写入但 run CAS/引用未提交时崩溃；重启不得形成幽灵授权或双重 delta。
- scope A 被 scope B supersede 后，A 不能再签发子授权。
- approved=1000 cents，settled=250，reserved/unknown=200，新请求=600：必须请求精确 50 cents，Provider create 计数为 0。
- 金额恰好够、差 1 cent、重复追加、并发余额变化、unknown 占用、次数耗尽、未授权 backup、质量/效果改变、无新费用复用、voice-only。
- 同一个已 accepted 请求恢复只能 reconcile；不能因为刷新、重试或模型 fallback 创建第二次。
- 子授权的 plan/inputs/model/max/attempts 与原 runner matcher 必须一致，不能签一个 worker 必然拒绝的凭证。

## 要求输出

用中文输出并保留标识符，按以下结构：

1. Verdict：`ACCEPTED` 或 `CHANGES_REQUIRED`。
2. C1 合同完成矩阵：`PROVEN/PARTIAL/CONTRADICTED/UNVERIFIED`。
3. 旧 F1-F11 复核表：`RESOLVED/PARTIAL/OPEN/OBSOLETE`，当前证据、剩余场景、阻断级别。
4. 新增 P0/P1/P2 findings；把 issuer/consumer identity、ledger aggregation、supersession、automatic continuation、crash idempotency 的共同根因合并说明。
5. 给出唯一推荐的数据和调用顺序，从已验证 reuse/accepted/unknown 到 reserve、derive、execute、receipt、reconcile；明确哪个存储是权威。
6. 对唯一失败测试给出根因链，说明是测试、实现还是二者问题；不允许为了让 run 前进而削弱 matcher。
7. 适合 Claude Code + GLM 5.3 Flash 的 C1 单阶段执行计划：允许模块、non-goals、失败测试、实现顺序、通过证据。
8. 精确验证矩阵，包含真实 service/runner/store 与 fake external transport、进程 crash、并发、金额、attempt、backup、unknown 和零媒体费用。
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

Oracle 建议不是授权；不要要求修改文件、花钱、部署或升级工具。

## Answer

## 1. Verdict：`CHANGES_REQUIRED`

**当前唯一失败测试存在确定性的旧 `intentDigest` 夹具问题，但修正该测试不足以通过 C1。** 当前源码仍存在授权派发前的父授权时效缺口、ledger 聚合丢失占用、收窄后的子授权与原 `SpendPlan` 不一致，以及结构化拒绝原因丢失等问题。

本轮基于附件中的当前源码、累计 diff 和测试审阅，并对当前纯函数、从 diff 提取的完整宿主方法进行了**内存探针**。探针中的文件存储、CAS 失败和派发边界是替身；没有修改文件、运行真实 Provider，也没有重跑仓库测试或执行进程级 crash 测试。`25/24/1` 和 `184/180/4` 是用户提供的当前测试结果，不是本轮独立重跑结果。

另一个重要证据边界是：**当前包没有完整的 Studio 授权签发实现、未修改的 runner matcher 正文，以及 worker 创建请求与 ledger parser 的完整正文。** 对这些边界，下文明确区分源码已证实的问题和仍需补齐的集成证明，不继承旧 transcript 的“已证明”结论。

---

## 2. C1 合同完成矩阵

这里的 `PROVEN` 只表示所列局部合同已有当前源码或本轮探针支持，不表示整个生产调用链通过。

| C1 合同                                          | 状态               | 当前判断                                                                                       |
| ---------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| scope 金额使用正安全整数；模型、资产、有限次数有结构校验                | **PROVEN**       | 当前 parser 保留这些检查；纯决策对请求金额、消费金额和当前资产计数有 fail-closed 检查。并不等于整个金额链均已安全。                       |
| 字面量 `1000 / 250 / 200 / 600` 返回精确缺口 `50 cents` | **PROVEN**       | 本轮直接调用当前纯函数得到 `request_approval(amount, 50)`；宿主反馈链另见下项。                                    |
| 未提交到 run 的 grant 文件不能成为有效授权                    | **PROVEN**       | 当前 reader 只读取 run 中已提交的授权 artifact 引用并核验 SHA；模拟 grant 写入后、run CAS 前失败，未出现幽灵授权。             |
| 当前授权链严格验证，损坏不能解释为首次授权                          | **CONTRADICTED** | acceptance helper 仍把损坏、外 run、非唯一幸存者返回为 `undefined`，与正常空链混淆。                                |
| coverage、当前父授权、余额、预留、子授权提交处于同一受保护边界            | **CONTRADICTED** | continuation 先读取 scope、ledger，再派发不带结构化父授权证明的 draft；其读取结果没有在当前可见调用合同中绑定到派发事务。               |
| ledger 按物理请求累计费用、占用与 create attempts           | **PARTIAL**      | 已修复部分旧问题，但 alias 顺序依赖、未定价终止请求占用归零等仍存在。                                                     |
| issuer、host、worker 使用同一质量／效果／实际请求合同            | **PARTIAL**      | host 不再从 scope 自取 intent，但当前效果键仍是 `planDigest + assetKey`；测试签发端使用旧键，正式 service 签发端缺完整当前证据。 |
| 收窄后的内部子授权仍能通过原 exact matcher                   | **CONTRADICTED** | 当前宿主收窄 `maxCostCny/maxAttempts`，却继续引用原 `spendPlanId` 和原 plan；与用户要求保留的精确匹配合同不一致。            |
| retry、stale-resume 接入 scope continuation       | **PROVEN**       | 两个旧缺失入口均已补上；实际继续成功仍受其他 C1 问题阻断。                                                            |
| 已验证 reuse／accepted／unknown 优先于新购买              | **PARTIAL**      | 纯函数有两个优先分支，但货币检查在它们之前；宿主 plan coverage 不传入这两类证据。不能据此断言 worker 已发生重复 create，也不能认定宿主合同闭合。    |
| 预留先落盘，再 Provider create；accepted/unknown 恢复不重建 | **UNVERIFIED**   | 当前片段保留 ledger 与恢复相关边界，但缺完整提交函数和真实进程恢复证明。旧 transcript 的探针不能作为当前端到端证明。                       |
| C1 向 C2 保留精确拒绝原因、缺口与缺失目标                       | **CONTRADICTED** | 当前 coverage 压缩成布尔值，continuation 返回原 run，没有保留对应结构化决策。                                       |
| 重复追加、提交后响应丢失、认证 actor 来源                       | **UNVERIFIED**   | C1 能防止同 ID 再次提交为第二条记录；service 级 idempotency replay、delta 和 actor 来源需要当前签发端证据。              |
| 零媒体费用、TTS 自动记账、文本／订阅审片免媒体确认                    | **PARTIAL**      | `WorkerProvider.run` 的 no-spend 与 automatic 分支仍在；完整零媒体费用组合尚未验证。                            |

局部数值、优先级与 fold 的实现见当前决策核心；授权激活与 continuation 则已是不同的完成状态，不能用纯函数测试替代后者。

---

## 3. 旧 F1–F11 逐项复核

**`RESOLVED` 只解除原 finding 描述的具体问题，不自动解除同一模块的其他验收项。**

| 旧项                                        | 复核状态         | 当前源码证据与变化                                                                                                                                  | 剩余场景／阻断级别                                                                                    |
| ----------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **F1：grant 文件先于 run CAS 成为权威**            | **RESOLVED** | acceptance 已将授权记录的 URI、SHA、schema 等加入 run artifacts；reader 只读已提交引用。内存探针中，文件写入后 CAS 失败，active 为 `undefined`；相同 prepared payload 重试后只提交一条引用。 | 原“幽灵授权”P1 解除。真实进程 crash、提交成功后响应丢失的 service 幂等返回仍未验证。                                         |
| **F2：被 supersede 的 scope 继续签发子授权**        | **OPEN**     | continuation 的 scope／ledger 检查仍发生在调用 `dispatchSpendAuthorization` 之前；draft 只有文字 `approvedBy`，没有可验证父授权引用、head 或读取 revision。                 | **P1。** 本轮替身派发探针复现：读取 A 后切换 active 为 B，仍收到来源 A 的 draft。实际 runner/transport 是否最终阻止，必须补真实集成证明。 |
| **F3：ledger 错算费用、alias 与 attempts**       | **PARTIAL**  | 新 `foldProductionSpendLedger` 已将有实际费用的 `terminal_failed` 计入 settled；prepared 不再算 create；alias 按根分组。                                        | **P1。** 分组后选 `group.at(-1)` 仍可让 alias 覆盖真实结算；带 task 的未定价 terminal failure 当前占用归零。            |
| **F4：结构坏账被静默跳过**                          | **PARTIAL**  | `inspectPaidAssetLedger` 对 version／operationId／items 不合法已由 `continue` 改为抛错；历史扫描也改为调用 parser。                                               | 原 envelope 漏计路径已修。条目级 parser 正文不在当前包，不能确认金额、状态、重复身份和 lineage 的完整校验；该旧 P1 尚不能整体关闭。            |
| **F5：整元截断丢弃已批准的分**                        | **RESOLVED** | 当前为 `Math.max(0, approved - spent) / 100`，不再 `Math.floor(... / 100)`。本轮 240 分探针派生出 `maxCostCny: 2.4`。                                      | 原 P1 解除；不代表金额 checked sum、最大报价和 matcher 问题一起解决。                                              |
| **F6：子凭证收窄，原 exact plan 不变**              | **OPEN**     | draft 仍引用原 plan，同时对金额取 `min`、对 attempts 收窄。                                                                                                | **P1。** 本轮得到原 plan `4.8 / 2`、子授权 `3 / 1` 的具体反例。不得通过弱化 matcher 解决。                            |
| **F7：intent 比较 scope 与自身**                | **PARTIAL**  | host 已独立计算 `canonicalProductionAssetIntentDigest(planDigest, quoteItem.id)`，原自比较已去除。                                                       | **P1 残留。** 当前键不是独立的逐资产效果合同；可执行方案验证函数没有在该函数内验证实际被读取的 script/director 依赖内容。                    |
| **F8：签发与消费 quality projection 不同**        | **PARTIAL**  | 消费端完整投影可见，但 projection 仍为 pipeline 内部函数；当前正式签发端源码未附。                                                                                       | **证据阻断。** 不宣称旧 service 少字段问题仍然存在，也不能判已修。另已确认嵌套对象属性顺序会改变所谓 canonical digest。                  |
| **F9：retry、stale-resume 未接 continuation** | **RESOLVED** | 两个入口现在均先获得 dispatch，再返回 `continueCoveredSpendApproval(...)`。                                                                               | 原漏接入口 P1 解除。仍需验证修复后不会卡在其他 C1 条件；不能据此声称所有 reconciliation 出口都已接通。                              |
| **F10：精确拒绝反馈被布尔化**                        | **OPEN**     | `scopeCoversSpendPlan` 遇到任何非 execute 直接返回 false；宿主据此返回原 run。                                                                               | **P2，C1 必交合同阻断。** 金额不足、次数耗尽、效果变化和证据损坏不能只有同一个等待结果。                                            |
| **F11：损坏授权链当空链接受**                        | **OPEN**     | helper 对损坏／外 run 返回 `undefined`，也不对已提交引用核验 SHA；reader 与 acceptance 仍使用不同严格程度。                                                              | **P1。** 本轮复现已提交 A 损坏后，无 predecessor 的 B 仍提交成功，随后 reader 报损坏。应按当前恢复安全影响处理，而不保留旧 P2 的低优先级。     |

F1/F2/F5/F6 的现行代码可直接在授权接受、读取和 continuation 中核对。

F3/F4/F7/F8 的局部修复和残留分别来自当前 fold、ledger 扫描、intent 投影和方案验证边界。

F9 已有明确修复；F10/F11 则仍可在当前实现中直接定位。

---

## 4. 本轮合并 findings

没有建立 P0 证据。以下把旧残留与本轮新增问题合并为四项执行责任，避免把同一条调用链拆成重复修复任务。

### C1-N1 — P1：父授权有效性、授权链完整性与派发事务没有闭合

**位置：**`production-pipeline.ts::acceptProductionAuthorization`、`readProductionAuthorizationHeadId`、`continueCoveredSpendApproval`。

当前已经解决“目录里有文件就算授权”，但尚未解决“当前派发究竟由哪份已提交、仍有效的授权允许”。

本轮探针得到两个结果：

| 场景                                             | 当前观察                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| scope A 已被读取，随后 active 改为金额更小的 B，再继续原 coverage | 派发边界仍收到 `approvedBy` 标记 A 的 draft，没有结构化 A/B head 核验信息。 |
| run 已提交 A 的引用，但 A 文件损坏，再接受无 predecessor 的 B    | acceptance 提交 B；之后 reader 因 A 损坏而失败。                   |

第一项证明**旧 A 的派发草稿仍能越过当前 continuation 边界**，不是本轮已经完成真实扣费复现。第二项则直接证明 acceptance 与 reader 的完整性合同不一致。当前 helper 的错误转 `undefined`，以及 draft 的父授权信息缺失，都在源码中明确可见。

**唯一修复方向：**接受与读取共用严格 committed-chain validator；把当前 head、实际输入身份、ledger 状态以及子授权／预留提交放到**同一现有 execution lease 内**核验。父授权来源应是宿主核验的 artifact ID、SHA 和提交身份，不能只存在于展示字符串中。

应保留一个区别：**A 已经产生的 accepted/unknown 请求仍需按原请求核账；A 被替换后不能再为尚未开始的新请求产生权限。**

### C1-N2 — P1：新 ledger fold 仍可能抹掉真实费用或未结清占用

**位置：**`production-authorization.ts::foldProductionSpendLedger`。

新 fold 的方向正确，但它把“物理请求”“继承别名”“费用结算”和“媒体状态”混在同一次行选择中：先按物理根分组，再把输入数组最后一行当成权威状态。输入来自按文件名排序的扫描，不能代表结算的新旧顺序。

本轮对当前函数的实际结果：

| 输入                                             | 当前结果                               | 必须达到的合同                    |
| ---------------------------------------------- | ---------------------------------- | -------------------------- |
| root 已记实际费用 9 元，alias 保留旧费用 1 元；顺序为 root、alias | settled = **100 分**                | alias 不能覆盖物理请求的 900 分真实结算。 |
| 同一组记录，仅交换输入顺序                                  | settled = **900 分**                | 聚合必须对文件／行遍历顺序不敏感。          |
| `terminal_failed`，有已受理 task，估价 9 元，但尚无实际费用     | settled、reserved、unknown **全部为 0** | 生成失败不证明未收费；计费未结清时必须保留保守占用。 |
| 同一 `itemRequestId` 两条冲突记录                      | 不拒绝，后行生效                           | 冲突证据不能按数组顺序覆盖。             |

另外，当前 fold 的输入合同没有保留 `actualCostSource`、请求最高占用或明确的 create-start 证据。占用依据仍是 `estimatedCostCny`；这不足以证明可变价格场景下使用的是保守最高价。

**修复方向：**每个物理请求只能有一份权威费用／提交事实；alias 只证明复用关系，不成为结算事实来源。生成状态与计费状态分开解释；明确未受理、已受理未结清、已结清有费用、已证明零费用，不能仅靠 `terminal_failed` 推导。attempt 也应由持久化的 create 事实决定，而不是仅凭 task ID 或费用字段猜测。

**不是问题的部分要保留：**prepared 不再计为已发生 create；有实际费用的 terminal failure 已按实际费用计入；原型安全计数已保留。

### C1-N3 — P1：业务效果身份、实际执行身份与子授权 plan 仍有多套不一致投影

**位置：**`canonicalProductionAssetIntentDigest`、`qualityContractProjection`、`verifyExecutablePlanInput`、`continueCoveredSpendApproval`、测试 `scopeForCurrentQuote`。

这里应合并修复三个层次，而不是分别加兼容判断。

**第一层：签发／消费不一致。**测试签发端使用 `SHA256(item.id)`，host 消费端使用版本化的 `planDigest + assetKey`。本轮探针中，旧夹具 coverage 为 false，当前 helper 生成的 intent coverage 为 true。正式 service 是否已同步，当前附件不能证明。

**第二层：业务效果与文件身份未分清。**当前 intent helper 只编码整份方案 SHA 与资产键：它不能独立解释“这个资产的效果是否改变”，也会把整份方案 bytes 的任何变化传播到所有资产。与此同时，当前 `verifyExecutablePlanInput` 核验的是 executable-plan artifact 本身，没有在该函数内验证 worker 实际读取的 script/director 内容与方案引用一致。

这需要 B4 提供可验证的当前正式产物关系，但**C1 仍有自己的消费责任：无法证明实际请求符合已批准效果时，不能签发新权限。**无需重做 B4/B5 业务逻辑。

此外，`canonicalQualityContractDigest` 对嵌套对象直接 `JSON.stringify`。本轮仅交换 `durationRange` 的属性插入顺序，digest 就不同。需要共享**投影与规范序列化**，不只是共享一个哈希函数；有语义的数组顺序不能随意排序。

**第三层：派生出来的凭证不可执行。**当前宿主可从：

```text
原 SpendPlan：maxCostCny = 4.8，maxAttempts = 2
scope 余量：300 cents，剩余 create attempts = 1
```

派生：

```text
同一个 spendPlanId
maxCostCny = 3
maxAttempts = 1
```

这正是与原 exact matcher 合同冲突的凭证。本轮证明了该 draft 的确会被生成；没有把替身派发成功冒充真实 matcher 通过。

**修复方向：**先形成宿主确定的、有限且可执行的 `SpendPlan` 与对应 effective execution configuration，再签发与它完全一致的子授权。这个内部消费计划的收窄不能改变用户已批准的画面质量，也不能靠把旧 matcher 的相等比较改成宽松覆盖来实现。

### C1-N4 — P2：拒绝反馈被丢弃，部分金额反馈还会低报追加需求

**位置：**`resolveProductionSpendDecision`、`scopeCoversSpendPlan`、`productionScopeCoversPendingQuote`。

本轮字面量短缺场景中，纯函数得到 50 分；宿主探针却只返回原 `awaiting_spend_approval`，没有对应结构化原因。次数耗尽、模型越界、效果变化、ledger 不可读也会被压成类似结果。

本轮还发现一个新的数值残留：

```text
approved = 1000
已占用 = 1100
新请求 = 100
```

当前返回 `additionalCents = 100`，因为对负余额做了 `Math.max(availableCents, 0)`；若这是累计授权上限，达到总需求 1200 实际需要追加 **200**。也可以明确返回超占用完整性／结算异常，但不能给出追加 100 即足够的反馈。

还有一个优先级问题需要一起处理：当前函数在 reuse／resume 分支前验证货币状态。新购买应因坏账停止，但已经验证身份的原任务查询、账单确认，不应被“暂时无法计算新购买余额”一并禁止。当前 host 的 plan coverage 也没有承接这些已验证状态。**这是宿主恢复合同未闭合，不是已证明 worker 会重复创建。**

---

## 5. 唯一推荐的数据与调用顺序

### 5.1 权威存储

维持现有存储，不新增账务数据库或第二套执行器。

| 数据                               | 权威                                       |
| -------------------------------- | ---------------------------------------- |
| run revision、当前状态、正式方案引用、已接受授权引用 | **`FileRunStore` 中已提交的 run**             |
| scope 内容                         | 不可变授权 artifact；只有被 run 提交引用且 SHA 验证成功才生效 |
| 物理 create、task ID、未结清占用、实际费用来源   | **现有 paid operation ledger**             |
| 可复用媒体                            | 已注册 artifact、实际文件 SHA、使用要求及合法来源证据        |
| node receipt、C2 funding 展示       | 上述权威记录的投影，不再独立累计一次钱或次数                   |

这与现有定案一致：SQLite 仅管理规划检查点，不成为授权或付费状态的第二个真相。

`FileRunStore.save` 的 revision CAS 和原子替换是必要基础，但它本身不会把另外一个 ledger 文件和 Provider 调用自动变成事务。需要在现有 execution lease 上完成跨文件的幂等提交协议。

### 5.2 调用顺序

1. **进入现有 run execution lease，读取同一份当前状态。**
   加载 run、严格验证 committed scope 链、读取当前 head、effective inputs 和正式方案引用。准备文件不算授权；损坏状态不算“尚无授权”。不要在 lease 外先作可执行决定，再把结果交给另一次 lease。

2. **先分类已存在的物理请求和已验证复用。**
   已有合格媒体走 reuse，新增媒体金额和 create 次数均为零。已 accepted 的请求只按同一个 `itemRequestId/taskId` reconcile。unknown 无法定位 task 时保留占用、等待恢复身份或核账，不能通过刷新、换模型或 fallback 新建替代请求。原请求核账不要求获得一份“新的购买授权”。

3. **仅对明确的新 create 构造真实执行合同。**
   从验证过的当前产物得到逐资产效果／质量合同，再解析实际 Provider、model、规格、参考 SHA 和请求 digest。业务效果 digest 与具体生成请求 digest 分开。备选必须同时满足父授权模型集合和已确认质量要求；便宜不构成豁免。

4. **生成有限、可执行的消费计划，计算最高占用。**
   用服务端当前报价形成精确 `SpendPlan` 和匹配的 effective execution configuration。只包含本次明确允许的有限 create 集合；未规划的 retry/fallback 不获得隐含许可。折叠所有属于该 run 媒体授权范围的物理请求，计算金额与剩余次数，不能把同一 alias 当新消费。
   这里不要求把自动 TTS、文本订阅费用扣进图片／视频 scope；它们继续按自身账本记账。

5. **先把 reservation 持久化到原 ledger。**
   reservation 绑定稳定的物理请求／派生操作 key、父授权引用、精确 plan 身份、最高占用与有限尝试。prepared reservation 不是“已经 create”，也不是独立执行权限。重复进入恢复的是同一记录。

6. **同一 lease 内提交精确子授权与执行引用。**
   通过 run CAS 发布本次有效 plan、子授权和 operation 引用；子授权与 runner matcher 使用的 plan／inputs／provider／model／max／attempts 完全一致，并包含宿主验证的 `sourceAuthorizationArtifactId` 等最小来源证明。
   reservation 已写但 CAS 未提交时，不得执行；恢复应复用同一准备事务，或在证明确未发起后撤销准备占用，不能换 key 再预留一次。

7. **worker 在新 create 前消费同一合同。**
   再核对实际请求与已提交子授权／reservation 的一致性，先写入“已进入 create、结果可能未知”的持久化事实，再调用外部 transport。不能在运行到 worker 后自行换成未经授权的 backup。发生边界间隙时必须重新验证父授权有效性；不要再次递归获取同一 execution lease。

8. **receipt／reconcile 更新同一物理请求，再由原工作流继续。**
   accepted task 恢复不产生第二次 create 或第二次消费；结算使用实际来源，未知占用只有在有证据时释放。run receipt 只是同步投影。start、retry、stale-resume，以及可能重新产生 spend checkpoint 的 reconciliation 出口，统一复用现有 continuation，不新增业务执行循环。

### 5.3 C1 必须交给 C2 的服务合同

建议 C1 返回并持久化一个带当前身份的 assessment，而不是 bool。至少保留：

```text
action / reason
runId / runRevision
sourceAuthorizationArtifactId / scopeId
acceptedPlanDigest / qualityContractDigest
spendPlanId / 实际请求身份
blockedAssetKeys / completedArtifactIds / 缺失目标
approvedAmountCents
settledCents / reservedCents / pendingUnknownCents
requestedMaximumCents
additionalCents / resultingMaximumCents
质量或能力证据引用 / 需要用户重新确认的差异
```

其中金额、历史消费、身份和原因均由服务端产生；C2 负责展示与用户选择，不负责重算。

对要求的场景，assessment 必须明确：

```text
已批准：1000 cents
已结算：250 cents
reserved + unknown：200 cents
本次最高新增：600 cents
还需追加：50 cents
满足本次需求后的最低累计授权上限：1050 cents
新增 Provider create：0
```

`reason=scope/attempts/quality/evidence` 时，不应仅给出“再加多少钱”；金额足够不代表可行性成立。

---

## 6. 唯一失败测试的根因链

**直接原因是测试夹具仍签发旧 intent，而不是 matcher 太严格。**

当前 `scopeForCurrentQuote`：

```ts
intentDigest: createHash("sha256").update(item.id).digest("hex")
```

当前 host：

```ts
intentDigest: canonicalProductionAssetIntentDigest(planDigest, quoteItem.id)
```

因此存在以下确定性链路：

```text
旧测试 intent ≠ 当前宿主 intent
    ↓
resolveProductionSpendDecision
返回 needs_replan：intent after approval changed
    ↓
scopeCoversSpendPlan 返回 false
    ↓
continueCoveredSpendApproval 提前 return run
    ↓
run 仍为 awaiting_spend_approval
```

这条链在进入 `dispatchSpendAuthorization` 之前就发生。本轮用当前函数复现了旧夹具 false、当前 helper true；这足以解释现有断言，但不代表更正后不会暴露下一层失败。

**归因应分两层：**

* **这一个失败的直接触发：测试夹具过时。**应通过统一的可信签发投影生成 scope，不能把消费端退回旧 hash、自比较或跳过 intent。
* **C1 整体未通过：实现与测试均有问题。**测试自行复制投影正说明 issuer/consumer 缺统一入口；更正 hash 后，金额／attempt 收窄、ledger 和父授权事务缺口仍需处理。

当前测试还存在验收强度不足：使用 `AuthWorker` 直接制造产物，配置 `maxAttempts: 1` 并额外授权 10,000 分；主断言只是“不再 awaiting”，所以进入 `failed` 也可能满足这个断言。它没有证明 generative worker 的真实预留与 create 边界。

应将成功断言改为该 fixture 的**明确预期终点**，并核对父子授权、实际 operation、ledger、create 次数和没有意外失败；不能仅断言 run “向前走了”。

---

## 7. C1 单阶段执行计划

**阶段目标：闭合 committed scope → 精确消费计划 → reservation → 原 runner／worker create 的唯一链路。**

### 允许模块

| 模块                                            | 本阶段允许范围                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `production-authorization.ts` 及测试             | 规范身份、严格金额计算、physical ledger fold、结构化 assessment                 |
| `production-pipeline.ts`                      | scope 接受／读取、统一 validator、leased derivation、continuation、消费侧产物验证 |
| `generative-asset-worker.ts`                  | 现有 ledger parser、准备／提交／reconcile、权威费用与物理请求证据                    |
| `run-store.ts`                                | 仅在现有 CAS 无法承载提交引用时作最小调整，不迁移存储                                   |
| `workflow-core/types.ts`、`workflow-runner.ts` | 最小内部来源字段与必要的受信宿主接入；保留 exact matcher                             |
| `production-studio.ts` 及直接服务测试                | **仅**统一签发所用的质量／效果／plan 投影与内部调用合同，不扩展 C2 HTTP/UI                 |

### 实现顺序

1. **先加入本轮反例测试。**保留唯一失败测试的旧输入作为拒绝用例；另加正确签发的成功用例、收窄 plan、过期 head、坏链、alias 顺序、未定价终止请求、精确 50 分和 overcommit。
2. **统一权威身份与接受读取。**共享严格 committed-chain validator；明确 prepared／committed；共享质量和逐资产效果投影及规范序列化，禁止客户端提供权威 digest。
3. **修复账本聚合与金额合同。**权威 physical request 去重、费用来源、最高占用、明确 create 事实、checked integer sums；不清零历史消费。
4. **接入同一 leased derivation/reservation。**先形成一致的 bounded plan/config，再预留、提交精确子授权、通过原 matcher，最后进入原 worker。
5. **统一 assessment 与 continuation 出口。**保留拒绝原因；覆盖 start、retry、stale-resume，以及会重新到达报价等待的 reconcile 路径；避免重复 wrapping 和嵌套 lease。
6. **使用真实 service/runner/store/worker 完成集中验证。**只替换外部传输与外部模型服务，不替换业务授权、matcher、账本或 artifact 校验。

### 类型检查归因

当前状态文件明确指出：pipeline 构建和前置检查通过，失败发生在 Studio；错误包括并发 revision/version 参数、`acceptedPlanDigest` fixture 和重复 JSX 属性。**不能把整个 `npm run typecheck` 失败归为 C1 实现错误。**

本阶段只负责 C1 直接消费的身份／凭证／服务类型错位及其调用点。B4 编辑 revision 合同、B5 三项复用失败、C2 页面问题分别保留归因；既不能顺手扩大修改，也不能删掉必填字段来消红。

---

## 8. 精确验证矩阵

所有集成用例应走：

```text
真实授权 service
→ ProductionPipeline
→ WorkflowRunner
→ FileRunStore
→ GenerativeAssetWorkerClient
→ fake external transport
```

fake transport 的 create 计数和 task 状态应独立于被 crash 的应用进程存活。正式 plan 编译、artifact 注册／SHA 验证、matcher、ledger 和业务 CAS 不得换成恒成功替身。

| 验证项                             | 场景／注入点                                                                | 必须留下的证据                                                                    |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **字面量 50 分**                    | approved=1000，settled=250，reserved=100，unknown=100，新请求最高600           | create=0；`additionalCents=50`；`resultingMaximumCents=1050`；两个占用桶不重复累计。     |
| **恰好够／差一分**                     | 同样已有占用450；新请求550／551                                                  | 550：先预留再 create；551：create=0、缺口1。                                          |
| **精确小数元**                       | scope240，无历史消费，最高报价240                                                | 子凭证允许2.40元，不截成2元；实际 matcher 与 worker 均通过。                                  |
| **重复追加**                        | 同 key 批准 delta100，刷新与重试多次                                             | 累计上限1100而非1200；历史450保留；执行600后剩余50；同一接受结果与引用。                               |
| **已超占用**                        | approved1000，已占用1100，新请求100                                           | 返回所需总增量200或明确异常；不能反馈100即足够；create=0。                                       |
| **grant 准备后 crash**             | 授权文件写入后、run CAS 前 kill                                                | 重启 active 不变；无幽灵授权；同事务恢复只提交一次，无双重 delta。                                   |
| **grant 提交后响应丢失**               | run CAS 成功、service 返回前 kill                                           | 同 idempotency key 返回原接受结果；不能再追加一次，也不能永久卡死在 duplicate/stale。                |
| **reservation 与 child 间 crash** | reservation 已持久化、run 引用提交前 kill                                       | create=0；prepared 不具有执行权限；重启复用同 reservation key，无重复占用。                     |
| **create 受理后 crash**            | fake transport 已受理，响应或 task 持久化前后分别 kill                              | 外部 create 总数始终1；有 task 则同 task reconcile；无可恢复身份则保守 unknown，不重发。            |
| **结算与 receipt 间 crash**         | ledger 已结算、run receipt 尚未写完                                           | 重启不再结算一次，不再计算一次 attempt，不重新 create。                                        |
| **scope supersession 竞争**       | A coverage 后设置 barrier，B 成为 head，再释放 A                                | A 不再提交新子授权或 create；已 accepted 的 A 请求只 reconcile。                           |
| **余额并发变化**                      | 两个候选分别够、合计不足；在检查与预留之间竞争                                               | 只有合法的一份 reservation 成功；另一份重读后给精确缺口；不能靠测试手工传入新余额证明并发。                       |
| **坏链／坏账**                       | SHA 损坏、外 run、缺前驱、环、分叉、非法 ledger envelope、冲突 item ID                   | 接受和执行均 fail closed；不当空链、空账或零消费。                                            |
| **终止请求费用**                      | terminal_failed 实际900；或有 accepted task、尚未定价、最高占用900                   | 已知费用保留900；未结清仍保守占用900；approved1000下新240须缺140、create=0。                     |
| **alias 与跨 run 复用**             | root/alias 各种文件顺序、后续结算更新、缺父／循环                                        | 相同物理消费结果与输入顺序无关；alias 不增费增次；跨 run 只继承合法媒体，不继承花费权限，来源费用不变成当前 run 的新消费。      |
| **attempt**                     | prepared、create-started、accepted、已证明未发起、次数耗尽                          | prepared 不冒充已发生 create；并发待执行不能抢同一剩余次数；达到上限后 create=0；追加金额不重置 attempts。     |
| **backup 与质量**                  | 未授权 backup；已授权但不达质；同质量合法 backup；旧请求 unknown                           | 前两项和 unknown 替换均 create=0；合法 backup 用新请求身份、占用与次数；不能因便宜静默降质。                |
| **身份与依赖变化**                     | 更改效果／最低规格／参考 SHA；只改对象 key 顺序；允许的同效果实现变化                               | 真变化阻断或重新确认；key 顺序不改变 canonical 身份；同效果变化不靠忽略实际请求校验获准。                       |
| **收窄子计划**                       | 原 max4.8/attempt2，当前仅允许一次2.4                                          | 形成匹配的新 bounded SpendPlan/config/child；原 exact matcher 不变；不能仅把 draft 改成3/1。 |
| **入口覆盖**                        | initial、scope acceptance、retry、stale-resume、reconcile 后产生 fresh quote | 同一 assessment／派生机制；有覆盖不重复问人，无覆盖保留具体原因；无重复 continuation。                    |
| **零媒体费用**                       | 已购媒体复用、voice-only、纯文本／订阅审片                                            | 不伪造正金额 scope；媒体 create=0；TTS 自动且自身记账；坏媒体不变成说明卡 fallback。                   |

当前名称含“concurrent”的测试只是两次同步纯函数调用，第二次由测试主动提供已更新的 `reservedCents`，因此不能作为 lease／CAS 并发证明。

通过证据应同时包含：明确 run 终点、提交 revision、scope head、父子授权身份、physical request ID、task ID、create/reconcile 计数、账本金额桶、attempt 消耗及失败原因。原 25 项须恢复通过，并增加上述反例；组合测试的 B5 已知三项应单独列出，不能把带失败的总结果写成 C1 全链通过。

---

## 9. Codex 执行建议

```yaml
codex_execution_advice:
  implementation_plan:
    - "先固化当前附件对应基线与失败归因；不回退累计修改。为旧 intent 夹具、收窄子计划、stale head、坏链、alias 顺序、未定价 terminal failure 和精确缺口加入失败测试。"
    - "共享 committed authorization chain validator；以 run 已提交 artifact 引用及 SHA 为授权激活依据，区分 absent、prepared、committed 和 integrity_error。"
    - "统一 service issuer、host 和 worker 消费的质量与逐资产效果投影及规范序列化；将业务效果身份与实际 Provider request identity 分离。"
    - "重做现有 ledger 的权威 physical-request fold：alias 不提供结算事实，冲突身份拒绝，未知计费保留最高占用，费用来源与 create 事实可验证，所有金额计算使用 checked integer cents。"
    - "在既有 execution lease 内重读当前 head、run inputs、真实报价和账本；先形成一致的 bounded SpendPlan 与 execution configuration，再持久化 reservation。"
    - "通过原 run CAS 提交精确子授权和 operation 引用；增加最小内部 sourceAuthorizationArtifactId 等来源证明，保留原 exact matcher，避免嵌套 lease 或第二套执行循环。"
    - "让原 worker 在消费同一 reservation 和子授权后才进入 create；accepted/unknown 只恢复原请求，receipt 与 reconcile 更新同一物理记录。"
    - "将布尔 coverage 改为保留结构化 assessment 的内部合同，统一相关 continuation 出口；仅为 C2 提供原因、身份、已保留成果、精确缺口和效果差异，不实现 UI。"
    - "修正唯一失败测试的可信签发夹具并加强终点断言；集中运行真实 service、runner、store、worker 的 fake-transport 集成、进程 crash 和并发验证，最后提交统一 C1 复核证据。"

  non_goals:
    - "不修改仓库基线或清理现有工作树；不 reset、stash、clean、commit、push、deploy。"
    - "不调用真实付费 Provider，不读取密钥，不以 Oracle 建议代替用户授权。"
    - "不实现 C2 HTTP、确认面板、三动作、钱包、充值或全局预算系统。"
    - "不实施 C3-C6，不重写 B4/B5 业务；只消费和验证它们提供的正式产物与复用身份。"
    - "不新增业务数据库、Redis、服务或第二套工作流；SQLite 不保存授权和付费真相。"
    - "不弱化 authorizationMatchesPlan 或 spendPlanMatchesExecution，不使用 hasBudget、role、approvedBy 文本或客户端字段绕过。"
    - "不因追加金额、刷新、改 operationId、复用或模型 fallback 重置历史费用、unknown 占用或 create attempts。"
    - "不因拒绝追加而降低质量，不把说明卡作为媒体失败 fallback，不升级审计工具。"

  optional_subagents: []

  verification:
    - "原 production-authorization 25 项通过，并新增本轮反例；成功断言为明确预期状态，不只是离开 awaiting_spend_approval。"
    - "真实授权 service → ProductionPipeline → WorkflowRunner → FileRunStore → GenerativeAssetWorkerClient，仅外部 transport、模型和下载服务使用替身。"
    - "1000/250/200/600 返回精确 additionalCents=50、最低累计上限1050、create=0；550恰好够、551差1分；240分不被整元截断。"
    - "同 key 追加100只使累计上限变为1100；历史占用保留，响应丢失恢复不产生第二次 delta。"
    - "分别在 grant 准备、run CAS、reservation、child 提交、Provider 受理和 receipt 同步边界 kill 进程，核对重启后的唯一提交与物理 create 数。"
    - "barrier 并发验证 head supersession 和余额变化；stale A 不签发新权限，竞争失败方 create=0。"
    - "ledger 对 alias 顺序不敏感，terminal charged 和未定价 accepted 请求不丢占用；冲突记录与损坏链不能被当作空状态。"
    - "收窄后的 plan/config/child 通过未放宽的 exact matcher；未授权 backup、效果改变、次数耗尽均在 create 前阻断。"
    - "accepted/unknown 恢复保持同 itemRequestId/taskId，不因刷新、重试或 fallback 增加 create；已购复用和 voice-only 不消费新媒体授权。"
    - "运行 C1 直接相关包、service 与集成类型检查；全项目 typecheck 和 B5 既有失败分别归因，不将未通过的总门禁记为绿色。"
```
