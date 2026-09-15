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
