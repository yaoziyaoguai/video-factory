# B4+B5 里程碑合并 Oracle 审计 transcript（第 5 档，第 2 次尝试成功）

- slug：`vf-b4b5-milestone-audit-20260911-02`（全新会话；-01 因 Chrome 窗口被提前关闭作废，未采信任何结果）
- 31m33s；↑589.07k ↓11.02k tokens；35 文件单一 bundle；Verdict：**CHANGES_REQUIRED**（b4/b5 子判定均 CHANGES_REQUIRED）
- 档位证据：verified=yes，resolvedLabel=Pro，第 5 项，共 5 项（thinking-time-control，capturedAt 2026-09-11T10:57:21Z）

## Answer（完整）

Answer:
# 1. Verdict

**总体：CHANGES_REQUIRED**
**B4：CHANGES_REQUIRED**
**B5：CHANGES_REQUIRED**

不是 `BLOCKED`：当前不需要新的产品决定、付费权限或基础设施选型才能继续收口。阻断来自**仍存在的实现缺陷，以及尚未成立的阶段必需证据**。

本次不能接受“只剩双审 N4/N5、Python 离线物化和 accepted 后 kill 四项”的判断。当前源码还存在：`needs_scope` 的空数组绕过、返工范围与重生成集合混同、Studio 正常入口仍重跑无关规划角色、局部 REUSE 修订与 runner 依赖闭包冲突，以及发布恢复和 rank seed 的组合故障窗口。下文分别给出可定位的调用链。

**证据边界。**本次读取并交叉检查附件中的当前源码、测试和合同，另外执行了只读的纯函数隔离探针；未访问用户本地 Git 工作树，未独立重跑仓库 build、Node/Vitest、SQLite 子进程或 Python 测试。附件中的 `247/247、127/127、35/35、176/176、typecheck exit 0、231/237` 均属于执行者提供的结果，不是本次重新取得的结果。

下文的 `PROVEN` 仅表示指定机制有当前源码或对应测试正文支撑；`RESOLVED` 仅关闭旧 finding 的具体失败机制，不自动代表整项阶段验收通过。

---

# 2. 合同完成矩阵

## 2.1 B4：正式规划接入

| 合同点                                                    | 裁定                 | 当前文件、symbol 与结论                                                                                                                                                             |
| ------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 Studio production / derivative 使用 joint；历史 run 保持原拓扑 | **PARTIAL**        | `production-studio.ts::start/reworkDraft` 已为新制作补 `joint-v1`；`ProductionPipeline.show` 使用 persisted brief。未附 `contracts.ts` 和完整历史恢复测试，所有低层创建入口的行为仍为 **UNVERIFIED**。          |
| joint/legacy 拓扑互斥，joint 失败不 fallback                   | **PROVEN**         | `production-pipeline.ts::createWorkflow/creativePlanningNode` 使用互斥规划拓扑，非 completed outcome 直接失败，不启动 legacy。                                                                 |
| grammar、承诺、treatment、issues 进入共同创作                     | **PARTIAL**        | `treatmentStageInputIdentity`、`codex-creative-treatment.ts::treatmentPayload/treatmentAuditContext`、script/director ports 已传递相应字段。四角色真实 adapter → Broker 最终请求仍未核验。          |
| request / stage compatibility / checkpoint 身份一致        | **PARTIAL**        | 正常 rank 身份已进入两层 key；但 seed 携带排序时没有保存 `carriedStageInputIdentities.rank`，无 history 的恢复分支也不核对 rank，见 **BG-03**。                                                               |
| public report 与 private inventory 分离、恢复、可核验            | **PARTIAL**        | 不再用 report 代替 inventory；路径已随候选 checkpoint 保存。但 `candidateInventoryBinding` 仍是路径字符串，不是内容与候选身份绑定；真实物化 **UNVERIFIED**，见 **BG-09**。                                             |
| 唯一、当前、正式的规划输出投影                                        | **PARTIAL**        | `currentPlanningOutputPaths` 已覆盖 assets/voice/render/technical-review；source review、final visual review 仍自行选择 joint/legacy，且 `reviewScope.sourceNodeIds` 保留不存在的 legacy 节点名。 |
| prepared → accepted 发布、幂等与恢复                           | **PARTIAL**        | 正常 orphan、完整 prepared 和无 commit 的 partial leftovers 恢复有所修复；“partial registry → 恢复写 commit → CAS 前再崩溃”仍不能恢复，见 **BG-02**。                                                     |
| 当前 output version 的正式引用闭包                              | **CONTRADICTED**   | `verifyExecutablePlanReferenceClosure` 绑定当前 plan 路径，但支撑引用仍从全局历史 registry 解析；未按当前版本 membership 和 joint/library 路线强制引用基数，见 **BG-01**。                                         |
| caller revision/version 到持锁修改点                         | **PROVEN，限当前变更机制** | 两个 pipeline 编辑入口对 joint 强制 tokens，并在 `runPersistedTransition` 的 lease 内比较；Studio 原样传递。完整竞争和 UI 回归证据仍有缺口。                                                                    |
| 当前 running/failed/unknown 展示                           | **PARTIAL**        | 运行优先级、commit 核验失败映射 compile failed、已完成模型无 trace 显示 unknown 的修复成立；声音修订后的 stage artifact 投影仍可能指向原 commit，见 BG-01。                                                             |

这里需要保留两项有效修复：**不能再说“Studio 仍丢 caller revision”，也不能再说“plan 缺 digest 就完全跳过 joint 校验”**。当前实现分别已经传递 tokens，并要求支撑引用共享 digest、检查部分父关系；残留是其他边界没有闭合。

## 2.2 B5：返工、复用与双审

| 合同点                                       | 裁定                                   | 当前文件、symbol 与结论                                                                                                            |
| ----------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| finding / 用户反馈映射正确 owner、action、scope     | **PARTIAL**                          | `reworkFindings/buildReworkNodeInstructions` 保留了部分来源和动作，但执行仍大量依靠三个节点指令与镜号数组；voice/edit/review 等责任没有得到完整纵向证明。               |
| 无法定位反馈进入可操作 `needs_scope`                 | **CONTRADICTED**                     | DTO 有该状态，但 start 守卫只在 scope 为 `undefined` 时检查，正常草稿的 `[]` 走另一分支；否定全片措辞、越界和混合反馈也处理错误，见 BG-04。                                |
| `unmaterialized`                          | **PARTIAL**                          | 原 task 恢复、unknown 阻断机制存在；未证明所有返工入口都在选择新 create 前统一消费这些状态。                                                                  |
| `materialized_awaiting_review`            | **PARTIAL**                          | 已选中的 materialized item 可保留字节并补审；但进入该集合的资格仍受不一致 predicate 影响。                                                               |
| `actually_rejected`                       | **PARTIAL**                          | 明确 assets finding 能排除旧项，但“真实拒绝”“影响范围”“重新设计”仍未与重生成集合严格分离。                                                                   |
| `insufficient_evidence`                   | **CONTRADICTED**                     | 引用证明缺失会落入新生成集合，而非先补证/重新确认；第三项原失败测试还把该行为断言为成功，见 BG-05。                                                                      |
| old/new reference + REUSE 固定点             | **PROVEN，限算法**                       | `reworkSceneDependencyClosure/shotDependencyPosition` 已跨所有 shot sets 迭代，并识别显式 REUSE；闭包大小仍不能等同 create 数量。                   |
| 三代 reference 证明与来源链                       | **PARTIAL**                          | `paidItemWithReferenceIdentity` 修复了携带时丢 reference SHA/digest 的具体问题；ledger 仍未完整记录来源 run/version/artifact，测试也没有建立三个连续正式 run。 |
| media/director-only 保留无关 treatment/script | **CONTRADICTED**                     | 新增跨 run seed 存在，但正常 Studio 自动生成非空 script 指令，导致 `screenwriterReworkContext` 判为需要编剧，绕过 source seed，见 BG-06。                  |
| 素材/声音/补审的完整执行偏序                           | **PARTIAL；局部 REUSE 路径 CONTRADICTED** | 主 DAG 有 preflight→voice/render→technical→visual review；`dispatchSceneRevision` 的失效集合却违反该 DAG，见 BG-07。                      |
| 两个 reviewer、同证据、独立与碰撞恢复                   | **CONTRADICTED**                     | 实际 identity 去重和普通分支缓存存在；共同不可变 envelope、实际消费 snapshot 核验、collision 内层 checkpoint 恢复未闭合，见 BG-08。                             |
| 容量与影响摘要                                   | **PARTIAL**                          | aggregate 上限 100 的局部修复正确；多来源溢出仍 **UNVERIFIED**。joint receipt 存在时显示 unknown 已修，但执行中缺 receipt 时仍可能报 0/not_run。               |

固定点算法本身已经修复；当前问题是其结果如何进入返工、复用和购买判断，不能再通过增加一次遍历解决。

## 2.3 A 冻结边界

| A 边界                                 | 裁定                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 时间轴字段、整数帧连续性、总帧数与范围                  | **可见解析机制 PROVEN**。`parseExecutableProductionPlan` 仍检查 30fps、整数帧、连续 startFrame、总帧数和范围；真实 renderer 裁切/VFR/累计量化实现及媒体结果 **UNVERIFIED**。 |
| 合法媒体复用、无关修改不重买                       | **CONTRADICTED**。BG-04/BG-05 的范围混同、宽松/过严 matcher 直接影响该合同。                                                                           |
| 声音时长修订                               | **PARTIAL**。正确定位 joint owner、保留当前支撑 artifact membership 的修复成立；新的 current plan 与旧 graph commit/stage 投影仍未统一。                         |
| 逐请求授权、ledger、lease、CAS、exact matcher | **可见保护仍存在，完整回归 UNVERIFIED**。未发现 planning graph 新增媒体 create；不能据此签署 C1 金额安全或全量 A 回归通过。                                                |

因此，**本次不能签署“B4+B5 未破坏 A”**：至少局部 REUSE 修订被拒绝，以及返工范围被当成购买范围，已经触及 A 的已冻结行为。时间轴解析中保留的检查不能抵消这些回归。

---

# 3. 专项验收逐项核验

## 3.1 RB4-01..07

| ID         | 裁定                                  | 已有证据                                                                                                              | 尚缺或被反例推翻的部分                                                                                                                             |
| ---------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **RB4-01** | **PARTIAL**                         | `production-planning-editing.test.ts` 有真实 Studio/pipeline/store 输入编辑 barrier；代码在 lease 内复核 tokens；客户端输入草稿保存打开时基线。 | 配置编辑的同等 barrier、两类编辑真实 lease 占用、拒绝后 graph/artifacts/auth 完整零变更、409 后组件草稿保留未完整证明。`node-workspace.test.tsx` 未附。                           |
| **RB4-02** | **PARTIAL；最终 transport UNVERIFIED** | 宿主和 treatment adapter 已构造共同上下文；rank port 有当前 `rankingSemanticIntent`。                                             | fake `treatDetailed/draftDetailed/rankDetailed` 参数捕获不是四角色真实 Broker recording。`creative-planning.test.ts` 70 例未附，不能用 Journal 的“已覆盖”代替正文。 |
| **RB4-03** | **PARTIAL**                         | 新增 completed graph 排序后换 model 的回归，验证 rankCalls 增加、search/其他角色不增加、checkpoint key 变化。                               | fake ranker 只记录 `.key`，不 load/save 完成态；provider-only、contract-only、真实 lower role cache 未证明。seed-history 窗口存在 BG-03。                     |
| **RB4-04** | **PARTIAL；真实物化 UNVERIFIED**         | report/inventory 路径及 JSON 内容不同，assets 输入收到 private 路径；路径进入 checkpoint。                                            | 没有真实 Python 读取 private inventory、选择对应候选并产生媒体的证据；没有 durable inventory 内容绑定。                                                              |
| **RB4-05** | **PARTIAL**                         | 四个测试确实使用新子进程、SIGKILL、跨进程调用记录和真实 lease 过期。                                                                         | `afterCommit` 是 **commit 文件写入后、run CAS 前**，不是 accepted 后；`afterArtifacts` 是整组登记后，不是 partial registry；afterSeed 使用无图库路线。BG-02 的二次崩溃未覆盖。  |
| **RB4-06** | **CONTRADICTED**                    | 普通发布重绑正式 IDs；已检查引用存在性、kind、SHA、共同 digest 和部分父关系；有不存在 script ID 的负例。                                               | 当前版本 membership、joint 必需 treatment、library 必需两项候选引用、派生 plan 正式接受关系不完整；隔离探针存在通过反例。                                                       |
| **RB4-07** | **PARTIAL**                         | running 优先于旧 artifact completed；commit 核验失败能标 compile failed；completed 模型缺 trace 为 unknown。                       | stage 的正式 artifact 映射仍根据原 graph commit，而非当前 effective output version；声音修订后需要验证当前 compile artifact。                                      |

completed-rank 测试比上一轮确有加强，但其替身没有实现 lower checkpoint 的完成态读写，不能把“key 不同”升级成“真实 role-loop 缓存恢复已证明”。

四个 SIGKILL 测试也应保留，不能整体否定；只是它们没有覆盖合同要求的全部状态组合。

## 3.2 B5-R1..R6

| ID                        | 裁定                                | 证据核验                                                                                                                             |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **B5-R1：状态、责任、范围**        | **CONTRADICTED**                  | 物理 ledger 状态和部分 finding action 存在，但 `needs_scope` 没有闭合；`[]` 可避开守卫；未定位模型 finding 可以不进入待定位；没有证明四媒体状态统一驱动下一动作。                      |
| **B5-R2：逐母片复用证明**         | **PARTIAL**                       | reference SHA/digest 转存修复成立；当前 fixture 只建立源 run→新 worker operation，没有连续第三代正式 run。缺来源 artifact/version 的持久化与消费证明，缺摘要 matcher 仍宽松。 |
| **B5-R3：闭包与 create 集合分离** | **CONTRADICTED**                  | 固定点正确，但 `affectedScenePositions` 被整体排除 carry-forward；缺 SHA 的测试在只选 `[4]` 时创建 2/3/4，缺少补证或扩围确认状态。                                   |
| **B5-R4：无关规划不重跑**         | **CONTRADICTED**                  | 正常 Studio draft 的 script 指令非空，关闭跨 run seed；`production-joint-rework.test.ts` 仍明确期待新 run treatment/script 各执行一次。                  |
| **B5-R5：双审证据和恢复**         | **CONTRADICTED**                  | aggregate 100 可表示两个 50 条分支，但共同最终 envelope、分支消费 identity、collision 内层失效与持久化有界计数未闭合；多来源溢出 **UNVERIFIED**。                          |
| **B5-R6：复验偏序与摘要**         | **PARTIAL；REUSE 路径 CONTRADICTED** | 主 DAG 的顺序可见，补审有独立入口；局部 scene revision 的显式失效集合不满足 runner 闭包，完整素材/voice-only/review-only 集成事件证据不足。                                 |

B5-R2/R3 的现有 fixture 还直接手写一个简化 `run.json`，没有通过完整 FileRunStore/runner 生成来源 artifact/version 集合。因此它能测试 worker 的局部继承逻辑，不能证明正式来源链闭合。

## 3.3 关联验收 R01–R07、B03–B10、M05

| ID  | 裁定                                 | 本批边界内结论                                                                                             |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| R01 | **CONTRADICTED**                   | media-only 的正常 Studio 路径不能保证 script producer=0。                                                     |
| R02 | **CONTRADICTED**                   | located script work 可进入 affected scope，随后导致画面失去 carry-forward；同 run reference 还受整文件 fingerprint 约束。 |
| R03 | **PARTIAL**                        | 闭包算法正确；闭包、重验、重生成集合尚未分开。                                                                             |
| R04 | **PARTIAL**                        | 建议能预填，但自动生成的保留指令被当成重新调用编剧的依据，责任路由不可靠。                                                               |
| R05 | **CONTRADICTED**                   | 局部 REUSE 修订被现有 descendant 校验拒绝。                                                                     |
| R06 | **PARTIAL**                        | 单审不能满足最终门禁；实际碰撞能拒绝，但无法证明只重跑冲突分支的真实 producer。                                                        |
| R07 | **CONTRADICTED**                   | 证据不足仍可能直接转换为新生成，而非先补看/补证。                                                                           |
| B03 | **CONTRADICTED**                   | 合法已有媒体可能被宽泛 scope 排除；未知请求身份也可能被视为可复用。                                                               |
| B04 | **PARTIAL**                        | 逐请求身份有实现，但 quote/carry/prepare/execution 判据不一致；scope 内自动继续的 C1 部分不在本批放行。                            |
| B05 | **UNVERIFIED**                     | 金额、占用、缺口与追加属于 C1/C2，本批不重审。                                                                          |
| B06 | **UNVERIFIED**                     | funding 三动作与 pause UI 属 C2，本批不重审。                                                                   |
| B07 | **PARTIAL**                        | 可见 lease/CAS、caller token 和原 exact matcher 保留；授权并发全链不在本批签署。                                         |
| B08 | **PARTIAL**                        | worker 对匹配的 submitted/unknown 保留 reconcile 约束；跨 run/返工所有入口的同请求优先级尚无完整集成证明。                          |
| B09 | **PARTIAL**                        | 原逐请求 matcher 未见被本轮 planning 绕开；production scope/model/attempts 全链留给 C1。                             |
| B10 | **PARTIAL**                        | 有上游 replan/补查动作，但缺证明仍进入新生成，能力/证据不足时停止采购的合同未闭合。                                                      |
| M05 | **CONTRADICTED；真实视听验证 UNVERIFIED** | 两分支实际消费同一最终证据未成立；真实音频/连续动作与完整成片证明未提供，也不能用抽帧高分代替。                                                    |

当前最终门禁要求两个独立报告、两个实际 identity 和完整 producer/audit proof，这些保护应保留；问题在于共同 evidence ID 被宿主写进每个 proof，不能据此反证两个分支实际消费的证据相同。

---

# 4. 旧 findings 逐项重裁定

## 4.1 B4 F1–F10 + N1

| 旧 ID                                        | 当前裁定                      | 当前证据与剩余部分                                                                                                                                    |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** 发布/registry 持久化                      | **PARTIAL**               | `creativePlanningNode` 已能续齐无 commit 的 partial leftovers；但 partial registry 与新 commit 共存时仍只走完整 verifier，见 BG-02。                              |
| **F2** seed 与 provenance/compatibility 分开保存 | **RESOLVED**              | treatment/script/director 的 carried model/provider traces 与 stage identities 已随 `updateState` 保存。rank 缺失归 F5，不重新打开原 treatment provenance 窗口。 |
| **F3** 共同创作输入未进入真实请求                        | **PARTIAL**               | 宿主及 treatment adapter 已传递；四角色最终 Broker 请求与审计消费 **UNVERIFIED**。                                                                               |
| **F4** rerank 沿用旧语义                         | **PARTIAL**               | rank port 已增加当前 `rankingSemanticIntent`；真实 rank adapter 对该扩展字段的消费及语义变化对照仍 **UNVERIFIED**。                                                    |
| **F5** producer/model/contract identity 不完整 | **PARTIAL**               | 正常 stage/role key 已包含 ranker；seed 的 rank compatibility 缺失仍开放，见 BG-03。                                                                        |
| **F6** graph-only IDs / 引用闭包                | **PARTIAL**               | 正常正式 ID 重绑已修；current version membership、必需引用及派生 plan 接受关系未闭合，见 BG-01。                                                                        |
| **F7** stale-client 编辑                      | **RESOLVED，限具体变更机制**      | Studio 原样传 tokens，joint pipeline 强制 tokens，lease 内复核；完整 RB4-01 测试仍是 PARTIAL，不再描述为“HTTP 丢字段”。                                                 |
| **F8** 新 derivative 创建 legacy               | **RESOLVED，限旧 Studio 缺陷** | 新 derivative 补 joint 标记；所有低层创建/历史恢复入口仍需补证。                                                                                                   |
| **F9** 旧 artifact 覆盖 running/failed         | **RESOLVED，限该状态机制**       | 当前 cursor 优先、正式 commit 核验失败影响 compile 状态、completed model 缺 trace 显式 unknown。声音修订后旧 commit artifact 投影归 F6。                                   |
| **F10** report/inventory 替代、弱物化测试           | **PARTIAL**               | 正常 report 替代与 seed 路径丢失已修；inventory 内容身份和真实 Python 消费未闭合，见 BG-09。                                                                            |
| **N1** treatment provider 字段写 model ID      | **RESOLVED，限原失败机制**       | 正常/fallback/seed 使用实际 provider traces；partial recovery 的 provider 重新登记错误是另一残留机制，见 BG-02 的 P2 子项。                                             |

## 4.2 B4 实施后一轮“7 项 blocking 已修”的复核

| 声称修复项                               | 本次裁定                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| F1-r1 partial registry              | **PARTIAL**：第一次 partial 恢复有修复，恢复途中再次崩溃仍有洞。                |
| F5-r1 rank 两层身份                     | **PARTIAL**：正常 completed graph 路径修复，seed 无 history 路径未闭合。 |
| F6-r1 current output/closure/voice  | **PARTIAL**：当前路径和 retained siblings 已修，当前版本成员及派生接受身份未闭合。  |
| F7-r1 joint tokens 必填               | **RESOLVED**：当前两个 pipeline 入口确实强制。                        |
| F9-r1 commit failure/unknown        | **RESOLVED**：当前指定状态机制已修。                                  |
| F10-r1 inventory 进入 seed checkpoint | **RESOLVED，限路径存活**：内容绑定与真实消费仍不因此通过。                       |
| RB4-02 recording 证据                 | **UNVERIFIED**：关键测试和 adapters/Broker 材料未附。                |

不能把“路径已经写入 checkpoint”扩大成“库存内容和候选身份已绑定”，也不能把“新的 rank key 被记录”扩大成“真实完成态缓存已消费”。

## 4.3 B5 F1–F9 + N1–N7

| 旧 ID                                          | 当前裁定                      | 当前证据与剩余部分                                                                                                  |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **F1** voice timing 找旧节点                      | **RESOLVED**              | `requestVoiceTimingRevision` 正确选择 joint/legacy owner。                                                      |
| **F2** reuse 跳过 preflight、覆盖目标 cut            | **PARTIAL**               | 加入 source review 失效、保留目标 cut 字段均成立；新增失效集合不满足实际 DAG，见 BG-07。                                                |
| **F3** 新 joint 返工重跑无关规划角色                     | **PARTIAL**               | source seed 已增加，但正常 Studio 的默认 script 指令使其不适用；零 producer 合同仍不成立。                                           |
| **F4** 整计划身份与宽泛范围影响复用                         | **PARTIAL**               | 有逐项 request fingerprint；整文件 reference matcher 和 scope 整体排除仍存在，见 BG-04/BG-05。                               |
| **F5** 用户反馈扩大全片或丢失                            | **PARTIAL**               | 新 DTO 有 needs_scope；`[]` 绕过、否定措辞、越界和未定位 finding 仍未闭合。                                                      |
| **F6** 缺 REUSE 边、old/new 非固定点                 | **RESOLVED**              | 当前固定点与显式 REUSE 边实现成立。                                                                                      |
| **F7** planning issues 未进 producer payload    | **RESOLVED，限宿主调用链**       | script/director 的实际 `provider.run` 输入已有字段；最终 adapter/Broker 验证归 RB4-02。                                    |
| **F8** reviewer collision 永久重放缓存              | **PARTIAL**               | 外层 collision tombstone 已有；内层 checkpoint 与恢复身份未同步。                                                          |
| **F9** 合法双审超过返工容量                             | **PARTIAL**               | 双审 aggregate 100 已修；多来源合并及溢出状态 **UNVERIFIED**。                                                             |
| **N1** carried ledger 丢 reference 输入证明        | **RESOLVED，限原字段丢失机制**     | cross-run `carriedBase` 现在调用 `paidItemWithReferenceIdentity`，不再把已绑定 reference 请求退回未解析。完整来源链仍见 B5-R2/BG-05。 |
| **N2** carry/quote/matcher 判据不一致              | **OPEN**                  | 前置资格、最终 request matcher、同 run reference matcher 仍不同；缺摘要可以宽松匹配。                                             |
| **N3** voice revision 丢支撑 artifact membership | **RESOLVED，限 membership** | `retainedArtifactIds` 已保留当前版本除旧 plan 外的成员，runner 会挂入新有效版本；完整正式规划投影问题归 B4 F6。                               |
| **N4** 没有共同不可变最终 evidence envelope            | **OPEN**                  | 当前仍共享 `preparedMedia`，分支内再次读文件，汇总不核对实际 snapshot。                                                           |
| **N5** collision 内层 role checkpoint 未失效       | **OPEN**                  | 当前调用仍以原 model key 获取内层 checkpoint，缺真实 role-loop 恢复与有界计数证据。                                                 |
| **N6** aggregate 容量限制前移                       | **PARTIAL**               | 50→100 的具体上限修复成立；多来源容量和溢出处理不因此成立。                                                                          |
| **N7** joint script 调用显示零                     | **PARTIAL**               | 有 planning receipt 时改为 unknown；执行中尚无 receipt 时仍可报 0/not_run，见 BG-10。                                       |

N1 的具体字段转存修复应保留，但 ledger 当前仍主要通过 `carriedForwardFromItemRequestId` 表达继承，没有完整来源 run/version/artifact 字段。两者是不同结论。

---

# 5. 当前阻断 findings 与新暴露机制

以下 BG 编号用于合并同根因，不把旧 finding 的残留重复统计成新的独立问题。明确新增的失败机制在对应项内标注。

## BG-01 — P1 · PRODUCT_BUG

### 当前正式版本、支撑引用与 graph commit 仍是不同真相

**位置：**`production-pipeline.ts::verifyExecutablePlanReferenceClosure`、`planningCommitArtifactIds`、`requestVoiceTimingRevision`。

校验器只证明被消费 plan 的 URI 等于当前 node output 的 URI；随后支撑引用仍从 `context.artifacts` 全历史集合解析。它还允许 joint plan 不含 treatment、library plan 的候选引用为空；plan digest 只有存在时才与引用集比较，父关系校验在父节点缺失时直接跳过。

本次隔离探针使用当前函数，给定“字节已通过验证”的替身边界，构造当前 plan 路径、两个同旧 commit 的 script/director 引用，省略 treatment、候选和 plan digest，**函数接受**；破坏 storyboard→script 父关系的对照组则被拒绝。该探针证明身份/基数缺口，不是文件系统或完整 runner 复现。

合法声音修订已经保留 siblings，但只替换 node output 的 plan 路径；`planningCommitArtifactIds` 仍依据原 graph commit 取得正式 artifact 映射。因此需要验证“实际消费新 plan，compile 面板却展示旧 plan”的分裂，而不是只检查新版本里还有 script。

**最小修复：**由当前 `outputState.effectiveVersionId` 取得正式 plan 和支撑集合；按明确 joint/library 合同检查基数、membership、SHA 与父关系。声音修订使用显式派生版本关系，不能复制旧 commit key 冒充新接受，也不能依赖“plan 没 digest”获得宽松路径。review 和 Studio 使用同一当前投影。

## BG-02 — P1 · PRODUCT_BUG

### partial registry 恢复中再次崩溃，仍可能永久卡住

**位置：**`creativePlanningNode` 的 existing commit、leftovers、fresh registration 三个分支；`workflow-runner.ts::runNode/continueRun`。

当前无 commit 的 partial leftovers 可以续齐，这是有效修复。但仍存在下面的源码可达序列：

```text
非 plan artifacts 已 addArtifact
→ executable_plan.json 写入失败
→ runner 保存 failed run，留下 partial registry
→ retry 续齐 missing artifacts，写出完整 commit
→ run CAS 接受前硬崩溃
→ 下一次恢复：commit 存在，registeredCount > 0
→ 进入完整 commit verifier，而不是 partial 续齐
→ commit 中新增 artifact IDs 不在已持久化 registry，恢复失败
```

恢复分支写 commit 后直接返回，正式接受发生在后续 runner checkpoint；目前仅零登记和完整登记有明确分流，partial+commit 没有对应恢复协议。

**同一恢复分支的新 P2 provenance 问题：**补登记 `asset_ranking` 时写入 `"asset-candidate-search-v1"`，其他模型角色写 `"unknown"`，没有消费已经保留的真实 provider traces；因此已知来源仍可能在修复 partial registry 时丢失或写错。

**最小修复：**对 prepared commit 与 registry 的零/部分/完整组合统一进行受控补齐，再一次接受 current output；恢复补登记必须沿用实际执行 provenance。增加“普通 I/O partial + 恢复途中第二次 SIGKILL”的组合测试，不只是再跑现有四个窗口。

## BG-03 — P1 · PRODUCT_BUG

### rank seed 身份没有穿过 seed-history 崩溃窗口

**位置：**`seedJointPlanningThread`、`creativePlanningNode` 恢复守卫。

seed 可以携带 `ranking`、`rankingInputFingerprint`、rank model/provider traces，但 `carriedStageInputIdentities` 只写 treatment/script/director，**没有 rank**。恢复也只检查这三个 carried identities；rank 失效条件还要求当前 digest 的 history record 存在。

**失败场景：**候选与排序已 seed，history 尚未写时退出；恢复进程更换 ranker。此时没有当前 history record，也没有 carried rank identity，旧排序可以绕过外层失效；即使正常 rank port 的 lower key 已正确，端口不被调用也没有作用。

**最小修复：**rank 的 compatibility identity 与 ranking 一起原子写入 checkpoint；恢复不依赖 history 是否存在来决定身份核验，缺失身份不得默认为适用。补图库 seed→kill→换 ranker→恢复测试，断言真实 rank producer 重跑、search 和未变角色不重跑。

## BG-04 — P1 · BOTH

### `needs_scope` 是展示字段，还不是可靠的执行停顿

**位置：**`production-studio.ts::reworkScopeUnresolved/holisticReworkIntent/reworkSourceTemplateSnapshot`。

三个确定问题：

1. 正常 draft 可以返回 `scopeState="needs_scope"` 和 `affectedScenePositions=[]`；start 的拒绝检查却只放在 `submittedAffectedScenePositions === undefined` 分支。`[]` 会走集合包含检查，空 required/空 submitted 可以通过。
2. `holisticReworkIntent` 只搜索“整体/全部”等词。本次纯函数探针确认，**“不要整体重做，只修改第2镜”返回 true**，会扩大全片。
3. `reworkScopeUnresolved` 只要解析出任何数字镜号就返回 false，没有核对 universe；“第99镜”在四镜头方案里不进入 needs_scope。没有 manual note、只有未定位 finding 时也直接返回 false。

**最小修复：**scope resolution 必须由服务端根据全部反馈重新判定，独立于字段是缺失还是空数组；保留每条尚未定位的反馈 identity。全片必须是明确肯定选择，不是关键词命中。已解析的 voice/review-only 可有空媒体集合，但必须有明确非空动作，不能与 unresolved 共用 `[]`。

## BG-05 — P1 · BOTH

### 影响范围被当作重生成集合，且复用 predicate 仍不统一

**位置：**`findReworkCarryForwardItems`、`safelyCarriableReworkItems`、`paidExecutionParametersMatch`、`isMatchingReferencedPaidItem`、`WorkerProvider.quoteSpend`。

当前 `regenerationScope` 直接取整个 `affectedScenePositions`，将其中所有媒体排除 carry-forward。但上游推荐范围包含 located script work、director work 和依赖闭包；生成的用户指令还明确说“先补查或方案修改，只有确认需要新画面时才报价”。**同一字段在上游是影响上界，在下游却变成新生成意图。**

另外两种相反方向的 matcher 问题仍在：

* `paidExecutionParametersMatch` 在旧 `executionDigest/compiledPromptSha256` 缺失时允许宽松匹配。本次隔离探针确认：缺摘要的旧项可以接受无法证明相同的新 prompt。
* 同 run reference matcher 仍要求整文件 `sourceFingerprint` 相同，实际媒体请求不变的无关修改也可能失去复用。

第三项原失败测试尤其不能判为合同已通过：它篡改镜头 2 的 reference SHA，只提交范围 `[4]`，随后期待 **2/3/4 都重新生成且 succeeded**。这证明“拒绝错误继承”后直接进入购买，而不是补证或重新确认扩大范围。不能据此推断真实 C1 金额授权已被绕过，但 B5 的范围与下一动作合同已不成立。

**最小修复：**报价、carry、prepare 和执行消费同一逐母片分类结果；明确分开影响范围、重验集合、明确重生成根和唯一 create 集合。缺证明先补历史记录，仍不足则 needs_evidence/重新确认；不能通过重新购买掩盖证明缺失。

## BG-06 — P1 · BOTH

### 无关规划继承在正常 Studio 路径失效；新 source seed 缺正式接受锚点

**位置：**`buildReworkNodeInstructions`、`screenwriterReworkContext`、`creativePlanningNode` 跨 run seed。

`buildReworkNodeInstructions` 即使没有 script finding，也生成非空 script 指令；`screenwriterReworkContext` 将任何非空 script 指令视为实质编剧返工；跨 run seed 又仅在该 context 为 undefined 时启用。正常用户路径因此仍重跑 treatment/script。当前 joint rework 测试还明确期待这两个 producer 各执行一次，不是零次。

**新暴露的来源真实性缺口：**source seed 选择来源 `planning-history.json` 的最新记录，再读取 SQLite checkpoint；实际播种点没有将其绑定到所声明 `sourceRunRevision` 的 current accepted output/artifact 集合。Studio 较早的 source 预检查不能替代播种时的来源验证，尤其 history 本来允许记录部分完成/失败执行。

**最小修复：**默认“保留脚本”的说明不能被当成 script action；按结构化责任逐阶段决定继承，而非关闭整个 source seed。使用既有 source maintenance lease/FileRunStore，取得并核验正式来源快照，再从与其一致的 checkpoint 播种；不要从“最新 history”推断“已接受来源”。

## BG-07 — P1 · PRODUCT_BUG

### 局部 REUSE 的失效集合不满足现有 runner 合同

**位置：**`dispatchSceneRevision`、`createWorkflow`、`WorkflowRunner.applyNodeRevision`。

`dispatchSceneRevision` 现在失效 `asset-source-review/render/technical-review/visual-review/final-review/publish-package`，但不失效 `voice`；实际 DAG 中 `voice` 依赖 `asset-source-review`。runner 要求被失效节点的后代也在失效集合内，因此正常有 source review 的路径会因缺少 `voice` 被拒绝。没有 source review 的拓扑，固定放入不存在节点也需要处理。

这是当前调用链缺陷，不能因它属于“进入前已有 shared red”而排除出 B4+B5 合并验收。

**最小修复：**让“必须重新验证的节点”与“可保留的音频字节/任务结果”通过现有 revision/复用合同一致表达。不能删除 source preflight，也不能放松 runner 默认闭包检查；仅把 voice 加入后重新付费合成来换绿，同样不能证明保留无关成果。

## BG-08 — P1 · PRODUCT_BUG；真实 role-loop 恢复 UNVERIFIED

### 双审的证据身份与两层缓存身份均未贯通

**位置：**`IndependentDualVisualReviewAgent.reviewDetailed`、`CodexVisualReviewAgent.preparePayload`、`visualReviewModelProof`。

当前两分支接收同一个 `preparedMedia` 对象，分支内部再分别读取 script/director/render manifest 等文件组装最终 context；汇总不比较每个 execution 的 `evidenceSnapshotId`。随后 `visualReviewModelProof` 又把外层 evidence ID 写给两份 proof，最终 equality 检查验证的是宿主复制出来的一致值，而非实际消费证明。

identity collision 仍只给第二分支外层结果写 tombstone；内层 checkpoint 使用原 model key，没有贯通新的执行身份或完成态失效。真实 role-loop 未附，不能冒充已复现其所有缓存行为，但当前 wiring 缺口足以阻断 B5-R5。

**最小修复：**先构造完整不可变 envelope，再给两个 reviewer 独立副本；返回实际消费 hash 与实际执行 identity，汇总严格核对。collision 只使冲突分支的外层结果、内层完成态和恢复身份一致失效，并保留持久化有限次数；另一份合法报告、render、voice、media 全部保留。

## BG-09 — P1 · PRODUCT_BUG；真实消费 UNVERIFIED

### private inventory 的“binding”目前只绑定了路径

**位置：**`creative-planning.ts::PlanningGraphState/candidates`、`seedJointPlanningThread`、`validateJointPlanningOutput`。

`candidateInventoryBinding` 类型仍是 `string | null`。当前保存和恢复可以保证“路径没有忘记”，但没有绑定 inventory SHA、候选获取身份和当前候选集合；恢复后最终输出主要检查字符串存在。

**最小修复：**在现有私有 checkpoint/正式执行记录内保存可验证的 inventory descriptor，与候选/search identity 同源；恢复及物化前核验受控路径、SHA 和对应候选。该信息不进入公开 Studio DTO。随后用真实 Python 离线物化证明选中候选与产出一致，不能继续用路径传递测试替代。

## BG-10 — P2 · PRODUCT_BUG / UNVERIFIED

### 影响摘要仍以 receipt 存在性代替实际阶段状态

**位置：**`summarizeReworkImpact`。

有 `creative-planning` receipt 时返回 unknown 的修复成立；但新 run 正在执行、尚无节点终态 receipt 时仍返回 `scriptModel: 0`，`nodeSummary` 也可能因没有 receipt/generated artifact 报 `not_run`。已有模型调用发生但未结束时，这不是可靠的零调用证据。继承说明还依赖 provenance notes 前缀，不是阶段身份核验。

**最小修复：**从当前阶段 execution/继承记录投影；执行中或统计缺失显示 unknown/进行中，不把缺记录解释为零。多来源 findings 的溢出状态没有足够当前正文和测试，继续标 **UNVERIFIED**；aggregate 100 本身不应回退。

---

# 6. 根因图

```text
R1 正式规划的当前身份没有贯通
   run effective output/version
       ≠ graph checkpoint/history
       ≠ 外部 commit 文件
       ≠ 全历史 artifact registry
   ├─ BG-01：当前引用、声音修订、stage artifact 分裂
   ├─ BG-02：partial registry + prepared commit 的恢复组合缺口
   ├─ BG-03：rank seed 身份依赖尚未写入的 history
   └─ BG-09：inventory 只有路径，没有内容/候选绑定

R2 返工意图被压缩成指令字符串和镜号数组
   owner + action + unresolved feedback + evidence
       → affectedScenePositions / 非空 nodeInstructions
   ├─ BG-04：needs_scope 空数组绕过、错误全片识别
   ├─ BG-05：影响范围 = 重生成集合；缺证明 = 新购买
   └─ BG-06：保留指令触发 producer；最新 checkpoint 冒充来源接受结果

R3 编排依赖与修订失效使用不同定义
   source-review → voice → render
       ≠ scene revision 的显式失效集合
   └─ BG-07：合法局部 REUSE 被拒绝

R4 双审外层结果与分支实际执行没有同一证据身份
   preparedMedia / outer hash / result cache
       ≠ 最终 payload / consumed hash / inner role checkpoint
   └─ BG-08：同证据未证明、collision 恢复不闭合

R5 展示从“记录是否存在”猜测执行事实
   receipt 缺失 / provenance 文案
       → 0 / not_run / inherited
   └─ BG-10：影响摘要不可靠
```

这里不需要把所有 ID 合成一个万能 digest。revision、request、stage compatibility、output version、artifact、snapshot 分别解决不同问题；需要的是它们之间可验证的派生和接受关系。

---

# 7. 测试诚信检查

## 7.1 当前测试正文的结论

| 检查项                                          | 结论                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| treatment 原空 artifact 断言同步                   | **合理同步**：当前应保留唯一正式 treatment、provenance/closure 与 `view_artifacts`，不应删除产物恢复旧绿测。                         |
| 输入编辑 barrier                                 | **有效加强，但覆盖有限**：真实业务模块参与；仅输入路径，不等于配置竞争和真实 busy lease 已通过。                                                |
| running/unknown 展示                           | **部分有效加强**：相关 DTO 修复成立；不能代替 current version artifact 投影。                                                |
| completed rank 回归                            | **有效加强但不是完整 lower cache 回归**：旧排序已经完成；fake 只记录 key，没有缓存 load/save。                                       |
| treatment recording                          | **证据不足**：`treatmentCheckpointPresent.push(true)` 是常量记录，不能证明 checkpoint 被真实消费。                           |
| SIGKILL                                      | **测试层级真实，窗口不完整**：保留现有测试；不得把 pre-CAS `afterCommit` 改名成 accepted 后窗口。                                     |
| reference 三项测试                               | **不是三代正式来源链测试**：直接构造简化来源 run；结构断言有增加，但没有完整 reference SHA/resolved digest/source version 每代核验。           |
| `production-joint-rework.test.ts`            | **BOTH**：当前期待无关 treatment/script 重跑，违背零 producer 合同；而且直接调用 pipeline，不能验证 Studio start 的 needs_scope 守卫。 |
| `.skip/.only/@ts-nocheck`、fixture 特判         | 在已附测试正文及相关当前源码扫描中未发现为这些用例新增的此类逃逸。**累计 diff 未附，不能证明历史安全断言全部保留，也不能证明整个仓库没有特判。**                           |
| free editorial / `runPurpose:"test"` fixture | 可用于隔离发布协议；不能证明真实图库/生成媒体消费、生产双审、真实视听或付费全链。                                                               |

相关测试的当前限制是可直接看到的：ranker 仅记录 key，promise fixture 写常量 checkpoint 标志，publication worker 用 `"video"` / `"audio"` 字节代替真实媒体。

## 7.2 三项原失败测试的独立裁决

| 测试                                                                     | 本次分类     | 应保留的正确目标与必须改变的验证                                                                                                                 |
| ---------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `carries an unaffected multi-level reference chain…`，4/5               | **BOTH** | “明确重新生成独立母片 4 时，链 1/2/3 保留”是合理目标；但 fixture 只有 affected scope 和一般重做指令，没有把重验与明确 regenerate 分开。不能用该例授权生产代码把所有 scope 解释成 regenerate。 |
| `regenerates the full human-approved reference dependency closure`，4/7 | **BOTH** | 明确重生成根及 reference-derived 后代时，7 可是正确结果；当前没有 REUSE-only 消费者对照，也没有完整证明根意图、失效/重验/create 三集合。不能只保留总次数断言。                             |
| `refuses to inherit…reference SHA cannot be proven`，6/7                | **BOTH** | 拒绝错误证明的继承正确；但只选 `[4]` 后自动新建 2/3 并 succeeded 不符合补证/范围确认合同。应先断言停止和无额外 create，再在明确扩围/重生成确认后验证最终集合；不能把 7 直接当首轮应成功的合同。                |

这不是要求把 expected 改回 4/4/6。应先补足动作合同，然后保留与明确动作对应的计数；**数字不替代授权范围、复用证明和下一状态**。

## 7.3 共享 6 红项与缺失材料

最终证据文件只列出 `231/237` 和 stale-token/scene-revision 分类，**没有给出六条完整唯一测试名、当前失败堆栈和逐例断言**。前面的历史段也不是完整最终六例清单。因此逐例归因仍是 **UNVERIFIED**。

处理原则是按失败合同归属，不按“函数本轮没改”归属。stale-token fixture 涉及 B4 调用合同，scene-revision 涉及 B5/A；同步这些测试不等于扩展 C2 金额或 funding UI 范围。

必须补回的材料包括：当前 `creative-planning.test.ts`、`node-workspace.test.tsx`、`codex-visual-review.test.ts`、真实 ranker/script/director/fallback/role-loop/checkpoint/Broker 相关代码与 recording 测试、Python inventory consumer 与离线测试、六红项全文/日志，以及测试变更 diff。缺少这些时，相关结论保持 `UNVERIFIED`。

---

# 8. 最小实施顺序与验证矩阵

## 8.1 实施顺序

| Slice                                      | 允许集中处理的模块                                                         | 先建立的失败证据                                                                     | 完成标准                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **S1：正式当前规划与发布恢复**                         | pipeline 发布/closure/DTO helpers、runner/store 既有窄边界、voice revision | 缺 joint 必需引用；旧支撑成员；voice 修订后 current plan；partial registry→恢复 commit→二次 kill | registry、current output version、接受身份与消费者一致；任何恢复次数都不重复角色/正式集合；合法 voice revision 不依赖放松校验。 |
| **S2：rank 与 inventory 的 durable identity** | planning state/seed、真实 rank adapter、现有 Python inventory 边界        | 图库 seed kill 后换 ranker；缺 rank identity；inventory 同路径内容变化；真实离线物化              | ranking 与 compatibility 同 checkpoint；未知身份不复用；库存内容与候选一致，恢复和真实消费均可核验。                     |
| **S3：返工动作、scope 与逐母片分类**                   | 现有 rework contract、Studio draft/start、generative worker、quote 接缝  | `needs_scope + []`、否定全片、越界、混合反馈；标点变化；缺摘要/错误 SHA                              | unresolved 不开跑；影响/重验/regenerate/create 分离；quote/prepare/execution 使用同一分类；缺证据不直接新购。      |
| **S4：正式来源继承与局部复验**                         | cross-run seed/source snapshot、scene revision、现有 voice/media 复用   | Studio 默认指令下 media-only；source 在预检查后变化；REUSE 失效集合与 voice 后代                  | treatment/script 实际零调用；source run/version/artifact 可追溯；preflight 和后续复验正确，同时保留合法音频与媒体。   |
| **S5：双审 envelope、collision 与容量**           | visual review agent、既有 role checkpoint 接缝、确定性汇总                   | 分支改写对象、分支 hash 不同、实际 identity collision、内层 completed cache、50+50+其他来源        | 两个实际独立 reviewer 同最终 snapshot；只重跑失败/冲突分支；次数持久化有界；不重渲染/不重买；溢出保留完整问题并可操作。                  |
| **S6：DTO、测试与证据收口**                         | stage/impact projection、相关 tests、Journal/verification             | 执行中无 receipt、voice revision 当前 artifact、配置竞争/真实锁/409 草稿、共享六红项                | 不报错误零次或旧正式结果；所有必需门禁有同一快照行为证据；按合同分类红项，不以总 pass 数替代。                                      |

S1/S2 是 B5 正式继承和复验的前置，但 S3 的空范围拒绝与错误全片解析可以作为独立小修先阻止错误执行。无需重写整个 `production-pipeline.ts`，也无需新增任何工作流或数据库。

## 8.2 验证矩阵

| 验证编号                 | 必须使用的真实边界                                      | 必须观察到                                                                                                                       |
| -------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **V1 编辑并发**          | Studio → pipeline → FileRunStore/lease         | 输入、配置两路径均有双客户端预检查 barrier；stale 409；真实 lease 占用拒绝；run/graph/artifacts/auth 零意外变更。                                           |
| **V2 客户端基线**         | 当前组件测试                                         | props 刷新不换草稿基线；409 保留草稿；重新绑定必须由用户明确操作。                                                                                      |
| **V3 四角色 recording** | 真实 adapters/role-loop，只有 Broker transport fake | 最终 producer/auditor 请求包含适用承诺、grammar、treatment、issues、当前排序语义；实际 provider/model 可核验。                                         |
| **V4 rank 恢复**       | SQLite + 真实 lower checkpoint                   | 已完成缓存后分别只换 provider/model/contract；另测 seed-history kill；真实 rerank，不重搜、不重跑无关角色，未变对照不重排。                                      |
| **V5 inventory**     | 真实 Python 离线物化                                 | public/private 文件不同；消费 private binding；产出对应选中候选；缺失、篡改、候选错配拒绝。                                                               |
| **V6 publication**   | 子进程 + SQLite + FileRunStore                    | graph 前后、partial I/O、partial+commit 二次 kill、accepted 后退出、图库 seed 后退出；角色计数不增，唯一当前正式集合。                                       |
| **V7 引用/voice**      | 当前版本校验 + 实际 revision API                       | 缺 treatment/library refs、旧 membership、错 parent、跨 run/重复引用都拒绝；合法声音延长后新的 plan、支撑集合和 Studio compile 映射一致。                      |
| **V8 三代媒体继承**        | 三个真实正式 run + fake media transport              | 每代 reference SHA/resolved digest/source run/version/artifact 可核验；第二代只做明确新增工作，第三代不重买；REUSE 消费者不各买一份。                         |
| **V9 scope/四状态**     | Studio draft→start→pipeline→worker             | note-only、越界、中文未解析、混合 owner、`[]` 都得到正确动作；待审保字节，缺证据补查，拒绝后才按明确范围生成。                                                           |
| **V10 局部复验**         | 真实 runner DAG，事件记录                             | 素材 preflight→render→technical→dual→final；voice-only 媒体 create=0；review-only render/voice/media create=0；scene REUSE 不被闭包拒绝。 |
| **V11 双审恢复**         | 真实双审 wrapper + 真实 role-loop                    | 分支不可相互污染；实际 consumed hash 不同即拒绝；碰撞分支真实 producer 重执行；成功方不重做；次数有界且不因重启清零。                                                     |
| **V12 容量/摘要/共享回归**   | aggregate→rework→Studio                        | 26+25、50+50、多来源溢出保留所有原问题；未知计数不报零；六红项逐例有最终正文、堆栈和归属。                                                                          |

构建与现有关键入口沿用附件中实际使用的命令体系：

```bash
npm run build:pipeline

node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/production-planning-publication.test.ts \
  packages/production-pipeline/test/production-planning-closure.test.ts \
  packages/production-pipeline/test/production-pipeline-reference-grammar.test.ts \
  packages/production-pipeline/test/generative-asset-worker.test.ts \
  apps/studio/test/production-joint-rework.test.ts \
  apps/studio/test/production-planning-editing.test.ts \
  apps/studio/test/production-planning-stages.test.ts

(cd apps/studio && npx vitest run \
  test/node-workspace.test.tsx test/client.test.tsx)

npm run typecheck
git diff --check
```

上述不是本次已执行记录，也不是全部验收入口。四角色 recording、真实 role-loop、Python 物化和共享扫描必须加入对应现有标准测试入口；Python consumer 未附，不能在报告里虚构其文件路径。所有结果应绑定同一 dirty-tree 源码快照与完整命令/退出码。

---

# 9. Codex 执行建议

```yaml
