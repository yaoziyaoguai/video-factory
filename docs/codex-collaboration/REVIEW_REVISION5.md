# revision 5 统一复审

裁定：**CHANGES_REQUIRED**，只剩下文一个已复现的组合分支；不是重开上轮三项全部实现，也不是新架构任务。

## 已确认的进展

相对 r5-start-baseline.json：8 个已有产品/测试文件变化、0 缺失，新增 text-task-recovery-receipt.cross.test.ts。与 RESULT 一致；TASK 未被执行端修改。上轮证据脚本的 barrier 位置调整也已说明，没有隐瞒。

本窗口独立运行：
- 原探针、role-loop、正式恢复与两进程 receipt：34/34，exit 0。
- Studio service、规划、Broker 生命周期/owner/合同与付费授权：254/254，exit 0。
- 恢复/节点/观测界面：67/67，exit 0。
- pipeline、Studio server/client 三个类型检查各 exit 0；git diff --check exit 0。

合计 **355 项现有/补充回归通过**，但下文新增组合探针 **1/1 失败、exit 1**。本窗口没有独立重复全仓全量、Python、正式 release smoke 或真实 E2E；这些通过信息仍属于执行端 RESULT 的证据。

上轮三项的基本场景确实已修：
1. 正式 Studio/Pipeline 链传递精确的 resumeCompletedFailureRequestId，新请求/后续 phase/角色不再继承许可；旧布尔入口仅为现有测试兼容，不是第二条生产流程。
2. pending audit 保存提交时适用的 contractDigest；取回旧成功后会按当前标准重审，同合同不多审。
3. receipt 的 read/merge/commit 在 proper-lockfile 跨进程短锁内，网络请求在锁外；临时文件唯一化，已确认终态不会被旧 running 落盘覆盖。
4. 新恢复测试真正进入 Broker parser/durable store，可控 executor 是模型替身；不是手工标 accepted。相关测试与 editorial-decision 已进入默认 studio:test。

receipt 原始“旧写持锁却要求新写先完成”的固定顺序，在正确互斥下无法成立，因此旧探针不能原样要求此顺序。执行端改到网络回包 barrier，属于合理的测试适配；当前源码锁住了原读改写竞态段。不能把原探针等待锁导致超时误判成原缺陷仍存在。网络外锁、身份复核和最终终态均已检查。

## R5-F01 / P2：跨合同恢复旧失败时，丢弃了当前合同的新审计

位置：
- packages/production-pipeline/src/role-agent-loop.ts:313–317，在调用 executeOperation 前记住 pendingAuditContractDigest。
- 同文件 :318、:333–348，执行后仍用上述旧值判断返回结果属于哪个合同。
- 同文件 :794–804，executeOperation 可以结清旧失败，并在同一调用内进入下一 generation，返回新请求的成功结果。

触发条件：旧合同 audit 在途时升级，之后核验原任务为 completed_failure，用户人工恢复。这是本轮 F01 与 F02 的叠加，不代表每个正常视频都会触发。

独立复现：
- producer=1，旧 audit observe=1；
- 新标准 audit 第一次已返回 pass；
- 当前新 audit 实际执行 **2 次**，最后 passed。
- 正确值应为新 audit=1；断言 2 !== 1，exit 1。

原因：外层在恢复前捕获了旧合同身份，但内层返回的已经是新 generation 的审计。外层将这份新成功误判为旧结果，丢弃并再次调用模型。上轮危险的无限重试已消除；这里是一次有限的多余调用。若多余调用失败，原本已通过的步骤还可能被阻断；此后一影响是控制流推导，本轮实际探针使用两次 pass。

违反：REVIEW_REVISION4 的 F01/F02，“旧任务先结清、新合同正确验收；成功的新结果不能继续当作旧请求处理”。也不符合减少异常长等待而不降低质量的目标。

### 最小修正（唯一剩余产品范围）

让适用合同/请求身份随“真正返回该结果的 operation”判断，不要在一个可能跨 generation 的执行前固定旧标识。优先利用已有 pending operation/contractDigest/请求元数据；不新建身份平台、不重新设计返回协议，不用 always-re-audit 或跳过 audit 兜底。

保留：
- 同合同旧成功直接取回；
- 旧合同旧成功必须按新准则重审；
- 旧失败人工恢复后，新合同成功只认一次；
- 新失败仍停止，unknown/conflict 不换 ID，producer 不重跑。

### 红灯与完成判据

从仓库根运行：
~~~sh
node --test --import tsx docs/codex-collaboration/evidence/r5-combined-audit.mjs
~~~

原始日志 r5-combined-audit-red.txt。探针只使用正式 role-loop + 内存 checkpoint + 可控外部返回，不声称真实 Provider 调用；脚本最初在 /tmp 运行，日志保留该原始位置。

把该行为纳入正式 role-agent-loop.test.ts，并补以下小矩阵：
- contractVersion-only 与 criteria-only 升级 + 原 audit transient/no_output + 精确人工许可；
- 新 audit pass：只执行一次；新 audit 再失败：停止，不作额外调用；
- 新 audit 中断后恢复：只观察当前原请求，不重跑 producer；
- 上轮同合同、旧合同成功和后续角色权限隔离对照保持绿灯。

测试验证实际新调用数和适用准则，不只验证 status=passed。测试替身若模拟真实提交，也保留 beforeSubmit 的快照语义；不能依靠某个测试没提供元数据的特例过关。

## 验证记录

~~~sh
node --test --import tsx docs/codex-collaboration/evidence/r4-boundary-probes.mjs docs/codex-collaboration/evidence/r4-receipt-race.mjs packages/production-pipeline/test/role-agent-loop.test.ts apps/studio/test/text-task-production-recovery.test.ts apps/studio/test/text-task-recovery-receipt.cross.test.ts
# 34/34，exit 0
node --test --import tsx apps/studio/test/studio-service.test.ts packages/production-pipeline/test/creative-planning.test.ts apps/codex-broker/test/task-lifecycle-v3.cross.test.ts apps/codex-broker/test/durable-owner-lifecycle.cross.test.ts apps/codex-broker/test/topic-script-contract.cross.test.ts packages/production-pipeline/test/production-authorization.test.ts
# 254/254，exit 0
# apps/studio 下：
../../node_modules/.bin/vitest run test/task-recovery-ui.test.tsx test/node-workspace.test.tsx test/run-observability.test.tsx
# 67/67，exit 0
# 仓库根，三条各自 exit 0：
./node_modules/.bin/tsc -p packages/production-pipeline/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.server.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.client.json --noEmit
git diff --check
~~~

完整绿灯日志：evidence/r5-independent-focused-green.txt、r5-independent-regression-green.txt、r5-independent-ui-green.txt。下一轮基线 evidence/r6-start-baseline.json 共 324 个文件，HEAD 570fe6e59e072c4965c86769bf2096825f003383。

本窗口只新增审查/复现材料与更新 TASK，未改产品源码、RESULT、真实数据，未重启服务、调用真实模型/媒体或 commit/push/云端部署；Graphify 只查询现有图，未更新。

## 后续节奏

TASK revision 6 一次性安排：先收口 R5-F01，取得明确聚焦与受影响集中回归绿灯，然后直接进入约定的有界真实本地 QA；**不为这个小修复再单独等待一轮大审计**。这不是把当前失败裁定改成 ACCEPTED，也不允许跳过红转绿。

真实 QA 覆盖 E01–E07，按 TASK 的执行范围、费用和有限恢复规则进行。新问题先记录原因与证据，继续独立可测路径，整轮结束后交本窗口统一审查与集中修复。不因为单条成功就声称普遍提速、必出爆款或全部通过。
