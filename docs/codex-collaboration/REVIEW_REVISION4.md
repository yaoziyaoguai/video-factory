# revision 4 统一复审

裁定：**CHANGES_REQUIRED**。本轮审查只针对当前恢复/止损修复，不重开 A/B/C、不重新选型。

## 结论与已验证部分

执行端的修复有实效。审查窗口直接检查了源码与 revision 4 起始 SHA 基线：12 个已有产品/测试文件变化，新增 apps/studio/test/text-task-production-recovery.test.ts；其它大量 dirty changes 属于已有工作，未归到本轮。

独立检查：恢复/规划/Studio/原探针 221 项、Broker 生命周期与付费授权 61 项、界面 67 项，合计 **349 项通过、0 失败**；pipeline 与 Studio server/client 三个类型检查和 git diff --check 均 exit 0。

新增边界探针另计：**2 个对照通过，3 个行为断言失败**。不是环境错误、超时或实际模型随机失败。前两个在正式 role-loop 中复现，第三个在两个操作系统进程的正式 Studio 查询/持久化路径复现。全部使用隔离数据，没有真实模型/媒体调用。

保留已修好的：原 produce 请求查询接续、普通失败的人工动作、顺序查询的可信时间、同义导演描述不重置止损、授权安全回归。当前证据不足以接受整个恢复合同。没有证据要求换框架、数据库、工作流平台或推倒重做。

## R4-F01 / P1：一次人工恢复权限变成持续自动重试

位置：
- packages/production-pipeline/src/role-agent-loop.ts:753，completed_failure 分支。
- packages/production-pipeline/src/production-pipeline.ts:10182，按节点设置 resumeCompletedFailure。
- packages/production-pipeline/src/codex-screenwriter.ts:144、codex-creative-treatment.ts:118，正式角色没有提供 maxPhaseAttempts。

复现：先保存已受理但未知的 produce；人工核验其迟到失败后开启恢复。观察原请求 1 次，然后新的请求连续失败，仍依次创建 **4 个不同 ID**。第四次由测试保险丝主动停止；产品没有在该分支停住，质量轮数仍是 0。maxIterations 不限制这个内部 while 循环，角色未配置的 maxPhaseAttempts 也不生效。

原因：resumeCompletedFailure 是整个节点/执行期间持续为 true 的布尔量，不绑定用户核验的原 pending。它既允许跨过原失败，也允许跨过后续新失败，甚至可能流到同节点后续角色/phase。

影响：用户只点一次重试仍可能长时间反复请求，消耗订阅额度并占用执行资源。此次没有实际调用 Provider，不能把测试中的次数写成真实账单。

违反：上一轮 F03、R01/G03/G05 的“先核验原终态，执行分类相符的人工动作”；不能借一次人工操作无界自动重试。

最小修正：
1. 用已有 pending/request/operation 身份限定本次恢复，只消费用户核验的那个失败；不要增加全局任务系统或全局费用硬上限。
2. 原失败结清后允许一次新尝试；该新尝试再次 completed_failure 必须保存成果、停止并显示真实失败。不能把节点级许可传给后续独立角色/phase。
3. unknown/conflict/contract_rejected 仍不可因此换 ID/backup。保留已有语义修订与结构修复边界，不为了停止基础设施重试而降低创作质量。
4. 消费与推进继续受已有持久化/lease 边界保护；进程重建或并发操作不恢复已经消费的自动重试许可。

必须先补红灯：produce 和 audit 各一例“原失败→人工恢复→新失败”，实际调用数与最终停态；再加“恢复完成后下一角色失败不能继承许可”的对照。测试保险丝只防卡死，不能算产品止损。

## R4-F02 / P1：旧审计结果直接认证了新合同

位置：
- packages/production-pipeline/src/role-agent-loop.ts:550、:608，restoreCheckpoint 换当前 contractDigest 同时保留旧 pending audit。
- 同文件 :304、:320、:365，取回旧 audit 后只校验通用格式，pass 直接结束。
- 角色 adapter 的 preparedOperation 分支按原请求观察，这部分应保留。

复现：
- 原合同 v1 的候选已生成，audit 已受理但观察中断。
- 只升级合同/criteria 到 v2，再恢复。
- 旧 audit observe=1，新 audit=0，produce 累计=1；返回 status=passed、contractVersion=v2。
- 同合同对照复用旧审计正常通过。

原因：恢复原任务事实与“当前合同已验收”仍未分开。通用 validateRoleAudit 检查 score/verdict/结构，不能证明旧模型曾按新 criteria 审过。

影响：提示词/审计标准升级后，旧标准通过可被冒充为新标准通过，削弱质量门。它不是“模型质量不好”，而是通过依据错配。

违反：上一轮 F01/G03 明确要求“可以取回旧结果，但不能假称满足新合同”。

最小修正：
1. 保留原不可变 operation/binding 并先结清旧任务，不重新提交原请求。
2. 若验收合同已变化，保留旧结果作为旧证据；在当前候选通过适用校验后，进入当前标准的独立 audit，或明确安全停止等待调整。不能直接标新合同 passed。
3. 持久化区分旧审计适用的合同与当前验收目标，避免升级信息在第一次保存时消失；恢复中再次中断/重启仍保持边界。
4. 同合同恢复不额外重审；仅改文件位置而验收标准未变时，不应机械重买/重生成。结构不兼容需停止，不能丢掉未结清原请求。

必须先补红灯：pending audit 的 contractVersion 与 criteria-only 两种变化；同合同对照；原结果取回后新 audit 失败/中断再恢复。旧 producer 成果可保留，不能为了重审让上游全跑一遍。

## R4-F03 / P2：并发读改写仍会回退终态

位置：
- apps/studio/src/server/production-studio.ts:2023–2033，read/merge/write 未处于同一跨进程互斥或 CAS 边界。
- 同文件 :2642 起的 mergeTextTaskRecoveryReceipt 仅保护读到最新值的情况。
- 同文件 :4232，临时文件名只有 PID，同进程并发还存在名称冲突风险；此相邻风险需回归，不冒称为本次已复现。

复现用两个独立 Node 进程：
1. 旧查询已取得 running、读取 receipt、完成 merge；在最终 rename 前用文件 I/O barrier 延迟。
2. 新进程查询到 completed_failure 并成功写入、返回 completed_failure。
3. 放行旧进程落盘，最终文件及旧请求返回值都退回 running。POST=0。

测试只延迟真实文件 I/O；没有替换 Studio 的读取、合并或保存函数。现有单测把延迟放在 HTTP 返回之前，终态已经写入才让旧请求读取，所以没有覆盖这段读改写竞态。

影响：已确认任务结束却显示仍运行，恢复动作可能重新隐藏；与用户看到的长等待、反复查询直接相关。

违反：上一轮 F04/G04/G05 要求“同一任务旧响应不得覆盖已确认终态”。

最小修正：
1. 只在 receipt 的短暂读取/合并/提交段使用已有合适的跨进程互斥或 CAS；网络请求不要持锁，不要锁住整个正在运行的制作。
2. 在提交边界重新核对 run revision、pending identity；不同任务/不同版本隔离。
3. 不用单实例 Map 代替跨进程保证；同进程并发临时文件也不能冲突。复用现有锁/原子写工具，不新增状态平台。
4. 已确认终态不可回退；查询失败不能刷新可信时间，暂停不能被查询解除。

必须先补红灯：本轮 barrier 两进程复现；同进程并发查询；terminal→query_failure、旧 running 迟到、编辑/更换任务后旧回包不覆盖新任务。

## 测试覆盖需要同时收口（不是新产品大项）

新增正式恢复测试确实走了 Studio、ProductionPipeline、编剧 role-loop 和 client 观察 parser，不能否定其有效性。但它的实际范围是：
- treatment/director 仍是角色替身；只有编剧走真实 role-loop。
- runTaskDetailed 被覆写，受理是测试手工设置；HTTP fixture 不是正式 Broker/durable server，POST 会返回 500。
- 只测 produce 的迟到成功/失败，未测 pending audit；两个实例争用不是两个 OS 进程。
- “换旧合同文件”改的是 checkpoint key/digest，未改变真实角色 criteria。

因此 G03/G05 的全链路 PASS 需收窄。补测应复用已有正式 Broker + 可控模型 executor、真实角色 adapter/文件 checkpoint/Studio/Pipeline；将替身限制在模型与媒体边界。至少覆盖本轮两个 phase 和后续角色不继承恢复许可，不扩成全角色×全模型的笛卡尔积。

apps/studio/package.json 的 test 显式列表尚未收录新恢复文件，Vitest 只选 *.test.tsx。执行端说“手跑过孤儿测试”是实情，但不能防未来回归。把本次相关新增测试及已修的 editorial-decision.test.ts 接入正常命令；其他孤儿先核实当前收录与结果，不借机改测试框架。保持旧回归，不反转断言凑绿。

本轮 editorial-decision 的修改是已有规则分组，不是这三个失败的根因；没有因此要求继续扩充题材词表，也不重新做选题系统。

## 独立证据与复跑

从仓库根运行（UI 命令注明例外）：

~~~sh
node --test --import tsx docs/codex-collaboration/evidence/r4-boundary-probes.mjs
# 原始证据：2 pass / 2 fail，exit 1
node --test --import tsx docs/codex-collaboration/evidence/r4-receipt-race.mjs
# 原始证据：0 pass / 1 fail，exit 1；会启动两个测试子进程，最长 10 秒

node --test --import tsx docs/codex-collaboration/evidence/r3-post-review-extra.mjs docs/codex-collaboration/evidence/r3-post-review-service-extra.mjs apps/studio/test/text-task-production-recovery.test.ts packages/production-pipeline/test/role-agent-loop.test.ts packages/production-pipeline/test/creative-planning.test.ts apps/studio/test/studio-service.test.ts
# 221 pass，exit 0

node --test --import tsx apps/codex-broker/test/task-lifecycle-v3.cross.test.ts apps/codex-broker/test/durable-owner-lifecycle.cross.test.ts apps/codex-broker/test/topic-script-contract.cross.test.ts packages/production-pipeline/test/production-authorization.test.ts
# 61 pass，exit 0

# 在 apps/studio 下：
../../node_modules/.bin/vitest run test/task-recovery-ui.test.tsx test/node-workspace.test.tsx test/run-observability.test.tsx
# 67 pass，exit 0

# 在仓库根：三条各自 exit 0
./node_modules/.bin/tsc -p packages/production-pipeline/tsconfig.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.server.json --noEmit
./node_modules/.bin/tsc -p apps/studio/tsconfig.client.json --noEmit
git diff --check
~~~

完整原始日志位于 evidence/r4-independent-core-green.txt、r4-independent-safety-green.txt、r4-independent-ui-green.txt、r4-boundary-red.txt、r4-receipt-race-red.txt。原始红灯在 /tmp 运行，日志位置保留原样；同内容的可移植脚本已纳入本目录，修复后从本目录复跑。r4-receipt-child.mjs 是受控测试子进程，不是正式服务。

审查基线 HEAD 570fe6e59e072c4965c86769bf2096825f003383。下一轮使用 evidence/r5-start-baseline.json 的 323 个文件 SHA，保留原 r4 基线。此次没有修改产品源码、RESULT、真实数据，没有真实模型/媒体调用、服务重启、commit/push/云端部署。Graphify 仅查询现有图，未更新。

未独立重复全仓全量、Python、package/release smoke 或真实视频 QA；这些通过信息来自执行端 RESULT，不能混作本窗口实测。当前三个失败与执行端全量绿灯可以同时成立，因为原测试没有覆盖这些时序/合同组合。

## 下一步与真实 QA 安排

revision 5 只集中修上述三个边界和必要测试接线；一轮完成后集中回归，RESULT 追加真实证据、READY_FOR_REVIEW 后停止。下一次复审聚焦这三个边界及受影响回归，不重新审整个 A/B/C，也不新增外部审计前置条件。

用户本次已经允许后续真实本地 QA 调用模型和花钱。不是缺付费授权；当前暂缓付费是因为 R4-F01 等安全门尚未通过。修复确认通过后再启动 QA，按以下范围下发执行卡：
- 读取执行环境安装的 QA 技能，以报告为主；先安全核对最终 build、三个真实服务、模型身份、在途任务与现有持久化数据，不接 fake Broker。
- E01：三个入口都到真实方案/报价；选一条代表性制作走 E03/E04 的媒体、声音、渲染和两个真实模型独立审片，其余入口不重复购买全片。
- E02/E05：报价三动作、暂停/恢复；一轮按真实审片建议预填并局部返工，证明未变媒体复用、增量调用和费用范围。
- E06/E07：刷新/安全重启、1440/390 界面、模板/素材/设置等主导航；按场景抽验成片帧数、声音同步、视觉一致性、内部文字污染和承诺兑现。质量未过不能人为盖章。
- 每次新支出先读实际报价、选最小有代表性的范围并记录费用；这只是本轮 QA 的资源止损，不新增产品全局费用硬上限。异常高报价、付费结果未知或同缺陷重复出现时停止该链，不继续花钱。
- 同根因同路径失败只允许一次有新证据/前置条件变化的恢复验证，不反复新建 run 或点重试。accepted/unknown 只查原任务，不能换 ID 重提。正常任务尚在规定等待窗内不算失败，不靠缩短模型超时假装提速。
- 慢的问题记录排队、执行、produce/audit、校验、重试与总耗时；已有日志能区分的才下因果结论，不把所有等待叫网络故障。未越过的节点写 NOT_VERIFIED，继续独立可测链。
- 每个问题记录 run/node/request、输入/合同身份、点击步骤、预期/实际、首次错误、可验证原因、调用与费用增量、证据路径、严重度；密钥不得入报告。能测的集中测完，再集中修复，不边测边部署。

本文件是审查与下轮依据；不要求执行端现在越过修复安全门开始真实付费 QA。
