# C1 单阶段执行卡：制作范围授权与精确消费闭环

任务编号：`VF-RECOVERY-C1`

执行者：Claude Code + GLM 5.3 Flash 最高可用 thinking。只在 B4、B5 均 `ACCEPTED` 后执行；完成 C1 后停止等待主 Codex + Oracle Web 审计。

## 1. 用户可观察目标

用户确认方案和图片/视频最高授权后，系统在该质量、模型、金额和有限尝试范围内自动制作；优先复用、同质量下省钱。余额或范围不足时在任何新 Provider create 前停止并给出准确原因。刷新、崩溃、重试和 backup 不重复花钱，也不把损坏账本解释成零消费。

## 2. 当前已确认事实

- C1 授权测试 24/25；唯一红测停在 `awaiting_spend_approval`。
- 该红测直接使用旧 `intentDigest` fixture，这是当前停住的第一原因；只改 fixture 不足以完成 C1。
- grant 文件未被 run 引用时不会成为 active；整元截断已修；retry/stale-resume 已接 continuation。
- 纯 `resolveProductionSpendDecision` 能计算 1000−250−200−600 的 50 分缺口。
- 当前仍有父授权时效/损坏链、ledger fold、quality/intent/plan identity、exact child plan、结构化拒绝和真实 crash/并发边界。

详见 `oracle/results/C1_ORACLE_TRANSCRIPT.md`。

## 3. 允许修改范围

- `packages/production-pipeline/src/production-authorization.ts`
- `production-pipeline.ts` 中 scope 接受/读取、continuation、派生/预留和正式消费验证
- `generative-asset-worker.ts` 中现有 ledger parser、prepare/submit/reconcile
- `run-store.ts` 仅在现有 CAS 接缝确有必要时
- `packages/workflow-core/src/types.ts`、`workflow-runner.ts` 的最小内部来源字段和可信宿主接入；exact matcher 不放宽
- `apps/studio/src/server/production-studio.ts` 仅统一正式 issuer 使用的 quality/intent/plan 投影，不实现 C2 UI/API
- 对应授权、worker、runner、service 集成测试

## 4. Non-goals

- 不实现 C2 报价页面、三动作、HTTP 产品流程、钱包、充值或全局预算系统。
- 不重做 B4/B5，只消费它们已证明的正式 plan/artifact/reuse identity。
- 不新增数据库、Redis、微服务或第二执行循环。
- 不弱化 `authorizationMatchesPlan`/`spendPlanMatchesExecution`，不以 `hasBudget`、role、`approvedBy` 文案或客户端 digest 绕过。
- 不把图片/视频 scope 扩到文本/订阅审片或新增 TTS 现金审批。
- 不调用真实 Provider、读取密钥、commit/push/deploy。

## 5. 必须先建立的失败证据

### C1-R1：strict authorization chain

- grant file 写入后、run CAS 前真实进程退出：active 不变，无幽灵授权。
- run CAS 成功、响应/receipt 前退出：同 key 返回同接受结果，不重复 delta。
- scope A 读取后 barrier，scope B 成为 current head；释放 A 后不得签发新子权限。A 已 accepted/unknown 的旧请求仍只 reconcile。
- SHA 损坏、外 run、缺 predecessor、环、分叉和多个不唯一 head 均 fail closed；不能当作 `undefined/absent` 接受新首授权。

### C1-R2：physical request ledger fold

- root 实际 900 分 + alias 旧 100 分，任意文件/输入顺序结果都为 900，alias 不新增费用/attempt。
- `terminal_failed` 有实际费用：settled 保留；已有 accepted task 但未定价：按最高报价保守 reserved/unknown，不归零。
- prepared 不算 create；create-started/accepted 才消耗 attempt；明确未受理可释放，unknown 不释放。
- 同一 `itemRequestId` 冲突记录、非法金额、坏 lineage 拒绝，不按数组最后一行覆盖。
- 金额用 checked integer cents，溢出拒绝。

### C1-R3：统一 identity 与可执行 child plan

- service issuer、host 和 worker 使用同一 canonical quality projection 和逐资产 intent projection；嵌套对象 key 插入顺序不改变 digest，有语义数组顺序保留。
- 业务效果 identity 与 Provider execution request identity 分离；纯显示/无关镜头变更不失效无关资产。
- 原 plan 4.8 元/2 次、当前 scope 只允许 2.4 元/1 次：必须形成新的 bounded `SpendPlan` + matching execution configuration + child authorization，三者通过原 exact matcher；不能继续引用原 plan ID 后只改 draft 上限。
- 未授权 backup、质量/效果变化、attempt 用尽在 create 前阻断。

### C1-R4：金额、并发、reservation 与恢复

- 1000/250/200/600：`additionalCents=50`、最低累计 1050、create=0。
- 已有占用 450，新 550 恰好够并先 reserve 后 create；551 缺 1 分且 create=0。
- approved 1000、已占用 1100、新请求 100：返回总增量 200 或明确完整性错误，不能只报 100。
- 两个各自可用但合计超限的并发请求，只有一个 reservation 成功。
- reservation 后、child/run reference 前退出：create=0；恢复复用同 key，不重复占用。
- Provider accepted 前后退出、receipt 前退出：外部 fake transport 物理 create 始终 1，同 task reconcile。

### C1-R5：结构化 assessment 与入口覆盖

从 `resolveProductionSpendDecision` 到 host 不再压成 bool。至少保留 action/reason、run/revision、scope/head、plan/intent/quality、已批/settled/reserved/unknown、requested maximum、additional/resulting maximum、blocked assets、保留成果、缺失目标和证据。

覆盖 initial、scope accept、retry、stale-resume、reconcile 后重新等待。reason=amount/scope/attempts/quality/evidence 必须可区分；无可行质量路线不只给钱的动作。

## 6. 推荐实现顺序

1. **修测试签发入口。** 保留旧 intent fixture 为拒绝用例；合法成功 fixture 必须调用与正式 issuer 相同的 helper。成功断言明确终点、scope/child/ledger/create，不只检查离开 awaiting。
2. **统一 committed-chain validator。** 接受、读取和执行共用；返回 absent/prepared/committed/integrity_error，不吞错误。
3. **重做 physical-request fold。** alias、费用来源、最高占用、create 事实、unknown 和 checked cents 各自明确。
4. **共享 canonical quality/intent projections。** 不能由测试或客户端复制 hash 规则。
5. **在现有 execution lease 内重新读取。** current head、plan/artifacts、真实 quote、ledger、attempts 同边界核验；先决定 reuse/resume/needs_replan，再为新 create 计算余额。
6. **形成一致 bounded plan/config/child 后预留。** reservation 先持久化，run CAS 提交精确 child 和 operation reference 后，worker 才能 create。
7. **worker 消费同一合同并恢复同一物理请求。** accepted/unknown 只 reconcile，结算和 receipt 不重复。
8. **把 coverage bool 替换为内部结构化 assessment。** 供 C2 展示，但本阶段不做 UI。
9. **集中集成、进程 crash、并发和类型验证后停止。**

## 7. 必须运行的检查

```bash
cd /Users/jinkun.wang/work_space/veidofactory

npm run build:pipeline

node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/production-authorization.test.ts \
  packages/production-pipeline/test/generative-asset-worker.test.ts \
  packages/workflow-core/test/workflow-runner.test.ts

# 运行当前 repo 中 production authorization service/host 的真实集成测试。
# 只 fake 外部 transport，不 fake ProductionStudio/ProductionPipeline/WorkflowRunner/FileRunStore。

npm run typecheck
git diff --check
```

同时回归 B4 formal plan/artifact closure 与 B5 reuse identity；若前置回归，C1 不得放行。

## 8. 对应验收

- `B01-B10` 中 C1 底层部分，重点 B03-B05、B07-B10。
- C1 专项 `C1-R1..R5`。
- `R02-R03/R05/R07` 的 reuse/新 create 分类输入。
- `M02-M03` 的未受理、429、accepted unknown、schema/业务失败分类。

## 9. 完成与停止条件

- 原 25 项恢复通过，并补齐 strict chain、physical ledger、bounded exact plan、reservation/crash/并发、assessment 红测。
- 真实 service→pipeline→runner→store→worker（只 fake 外部 transport）通过。
- 字面量分值、scope supersession、unknown、attempt、backup、zero media cost/voice-only 均有 provider create 计数证据。
- 不放宽 exact matcher、不重置历史消费、不静默降质。
- typecheck 和 B4/B5 关键回归通过。

更新 `JOURNAL.md` 后停止，不进入 C2。等待主 Codex + Oracle Web 审计。
