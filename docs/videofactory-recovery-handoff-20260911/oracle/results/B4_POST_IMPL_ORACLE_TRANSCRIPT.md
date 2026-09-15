# B4 实施后 Oracle Web 审计 transcript（第 5 档）

- 会话 slug：`vf-b4-post-implementation-audit-20260911-01`（全新会话，非 followup）
- 运行时间：2026-09-11，耗时 24m32s；↑553.51k ↓7.29k tokens；附件 30 文件单一 bundle（2.0MB）
- 档位证据：`Model selection evidence: resolvedLabel=Pro，第 5 项，共 5 项。; status=already-selected; verified=yes; source=thinking-time-control; capturedAt=2026-09-11T08:46:25.901Z`（wrapper 0.17.3 未输出会话 URL；提交证据为已提交 user turn + 流式回答捕获）
- 清理证据：运行结束后无 oracle 进程存活、无 oracle 临时 Profile 残留（playwright profile 属其他工具，与 Oracle 无关）
- Verdict：**CHANGES_REQUIRED**

## Prompt

（完整 prompt 见运行日志 /tmp/vf-b4-oracle-run.log 第 1-60 行区段；核心要求：独立审计 B4 全部合同点、RB4-01..07、旧 F1-F10+N1 重裁定、测试诚信检查、根因图、最小实施顺序与 yaml 建议。）

## Answer（完整）

Answer:
## 1. Verdict

**CHANGES_REQUIRED**

当前 B4 不能阶段放行。阻断不只是缺少运行日志：当前源码仍存在**部分正式登记后无法恢复、图库 seed 崩溃丢失私有库存路径、消费校验未绑定当前 accepted output version**等可由源码构造的反例；A 的声音时长修订也没有维持新的 joint 引用闭包。与此同时，真实 Broker 请求、已完成排序缓存失效、真实离线库存物化等必需门禁尚未得到充分证据。

**证据边界：**本轮审计依据附件当前源码和测试全文，未访问用户本地 Git 工作树，也未执行项目构建、测试或进程恢复用例。附件报告的 build、136/136、108/108、32/32、176/176、typecheck 和 diff-check 成功属于**执行者提供的结果**，不是本轮独立运行结果。该证据文件是 58 行汇总，没有附上完整命令展开、原始测试日志和共享红项堆栈。

以下 `PROVEN` 表示指定机制可以由当前附件直接建立；不等同于完整生产 E2E 已验证。源码行号采用各文件自身编号。

---

## 2. B4 合同逐项裁定

| 合同点                                                                     | 裁定               | 当前源码与结论                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 production、新 derivative 使用 joint；历史 run 保留原拓扑                         | **PARTIAL**      | `production-studio.ts::start`、`reworkDraft` 已明确补入 `joint-v1`，Studio 新建返工的旧缺陷已修。`production-pipeline.ts::dispatch` 自身仍依赖输入解析；完整 `contracts.ts` 及历史恢复入口的行为证据未附，不能扩大为所有入口均已验证。                         |
| joint/legacy 规划互斥；joint 失败不 fallback                                    | **PROVEN**       | `production-pipeline.ts::createWorkflow` 对旧规划节点与 `creativePlanningNode` 使用互斥分支；`creativePlanningNode` 对非 completed outcome 抛错，不启动另一条 legacy 链。                                                      |
| reference grammar、适用承诺进入共同创作                                            | **PARTIAL**      | `treatmentStageInputIdentity` 已包含 grammar 和锁定承诺；`codex-creative-treatment.ts::treatmentPayload/treatmentAuditContext` 明确标记 `style_structure_reference`。真实 Broker 最终接收、schema/prompt 消费及全部角色录制证据仍不足。 |
| treatment/script/director/rank 请求、checkpoint、stage compatibility 来自一致投影 | **CONTRADICTED** | `jointPlanningStageInputs` 的 rank 身份包含 ranker/model；实际 rank 的 `nodeAgentLoopCheckpoint` 却没有传 ranker/model。跨 thread seed 还将缺失 rank identity 当作“未变化”。这不是同一兼容合同。                                       |
| rank 消费当前主体、动作、真实性要求                                                    | **PARTIAL**      | `creativePlanningNode` 已向 ranker port 传入 `rankingSemanticIntent(rankDirectorPlan.output)`，不再只有 artifact IDs。但旧候选 report 仍整体展开，真实 rank adapter/Broker 对新语义字段的消费没有 recording 证据。                      |
| 实际 provider/model provenance                                            | **PARTIAL**      | treatment 正式 artifact 的 provider/model 混写已修；正常、fallback、seed 用例都检查了实际 provider。完整四角色来源投影、真实模型未知时的展示仍未闭合。                                                                                            |
| private inventory 独立保存、恢复、校验及真实消费                                       | **CONTRADICTED** | 正常路径已不拿 public report 顶替 inventory；但 seed checkpoint 不保存 inventory binding，恢复仍依赖尚未写入的 history。真实 Python 离线物化被明确记为未验证。                                                                               |
| 唯一 planning outputs 投影                                                  | **PARTIAL**      | `currentPlanningOutputPaths` 已被 assets/voice/render/technical-review 的输入构造实际消费，指定四处路径选择确实收敛；但它仍只是路径投影，不包含当前 accepted version/引用集合，发布打包等位置也保留独立兼容选择。不能据此认定“正式规划真相”已统一。                               |
| prepared → accepted 发布与进程恢复                                             | **CONTRADICTED** | 整组准备完成后的硬崩溃恢复已有有效测试；逐项 `addArtifact` 与后续文件写入交错，普通 I/O 异常仍可能留下被失败 checkpoint 持久化的部分 registry，恢复分支却要求完整集合。详见 F1 残留。                                                                                   |
| executable 内部引用属于当前 run、当前 output version，且 SHA/父关系闭合                   | **CONTRADICTED** | `verifyExecutablePlanInput/ReferenceClosure` 搜索全局历史 `context.artifacts`，不核对当前 effective output version；缺 digest 会跳过 joint 一致性检查；也未检查 parent edges。                                                  |
| caller revision/version 贯穿客户端、服务和持锁点                                    | **PARTIAL**      | 已提交的 tokens 确实进入 pipeline lease 内复核，客户端打开时基线也已保留。剩余是底层入口允许省略 tokens，以及配置竞争、真实 lease 占用、拒绝后完整零变更证据不足。                                                                                                |
| Studio 当前 running/failed/publication 状态与未知模型                            | **CONTRADICTED** | running 优先级、外层 failed 时归 compile 的修复成立；但正式 commit 校验失败只清空 artifact 映射，不改变 completed 状态。未知模型仍被省略，测试还固定了这一行为。                                                                                         |

### A 冻结边界

| A 边界                                 | 本轮结论                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 统一时间轴、整数帧、复用根与源偏移                    | **可见编译/解析机制保留。**`compileExecutableProductionPlan` 仍按复用根生成 `assetKey`、传递源偏移；parser 校验连续整数帧及总帧数。真实 renderer 的裁切、VFR、媒体时长结果没有本轮独立验证。                            |
| 声音时长修订后的规划引用                         | **CONTRADICTED。**`requestVoiceTimingRevision` 生成新 plan，但 `retainedArtifactIds: []`；新当前版本不再持有原 planning 支撑产物，新的 plan 又没有 commit digest，消费时转而通过较弱的无 digest 分支。 |
| 无关媒体复用、SHA 与产物绑定                     | **PARTIAL。**编译字段没有发现被删除，但当前版本引用闭包仍有缺陷；共享返工红项也缺少足够证据排除 B4 上游影响。不能报告完整 A 回归通过。                                                                                 |
| 逐请求授权、ledger、lease、CAS、exact matcher | **可见边界未被 planning 绕过；完整回归 UNVERIFIED。**`WorkerProvider.quoteSpend/run` 仍先执行 plan 校验，付费执行仍检查授权。真实 ledger/paid worker 完整材料不在本包，C1 红项也不能当作 B4 的安全通过证据。          |

---

## 3. RB4-01..07 逐项证据核验

| 门禁                        | 已建立的真实证据                                                                                                                                                                                                                | 未闭合部分                                                                                                                                      | 裁定                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **RB4-01** 编辑并发           | `production-planning-editing.test.ts` 的 barrier 子类只延迟进入 `super.applyNodeInputOverride`，仍使用真实 ProductionStudio、pipeline、store、lease；B 通过预检查后等待，A 保存，B 再进入持锁点遭拒。组件测试明确从 revision 2 刷新到 7，仍提交 revision 2 和旧 input version。 | barrier 主要覆盖输入编辑；未等效覆盖执行配置竞争、两类编辑的真实 lease 占用。零变更断言主要是 revision/version，未完整比较 graph、artifacts、授权状态。底层缺 token 仍可调用。                         | **PARTIAL**。                                   |
| **RB4-02** 最终请求录制         | treatment adapter 的生产请求与审计上下文都构造了承诺、grammar；pipeline 已传共同创作字段。                                                                                                                                                          | 新测试用注入的 `treatDetailed`、`draftDetailed`、`rankDetailed` 捕获参数，不是四角色真实 adapter → Broker 的最终 recording。`creative-planning.test.ts` 未附只是其中一项缺口。 | **PARTIAL；最终 transport 覆盖 UNVERIFIED**。        |
| **RB4-03** ranker-only 变化 | stageInputs 有 rank 身份；同 digest 检测变化后会清空 rank/integrate/compile 并调整图游标。                                                                                                                                                  | 新测试第一轮 rank 就失败，没有已完成排序缓存；fake ranker 不消费 checkpoint 参数。因此它不能证明 completed graph/role cache 不重放旧结果；provider-only、contract-only 也未覆盖。        | **PARTIAL**。                                   |
| **RB4-04** 私有库存真实物化       | reference-grammar 测试确实断言不同路径、不同 JSON 内容，以及 assets 输入使用 inventory 路径。                                                                                                                                                    | 检查的是输入传递，不是实际 materialization 读取、选择和产出媒体；Journal 明确未跑真实 Python 离线消费。另有 seed 崩溃丢路径的当前代码反例。                                                  | **PARTIAL；恢复合同 CONTRADICTED，真实物化 UNVERIFIED**。 |
| **RB4-05** 发布/seed 硬崩溃    | 使用真实子进程和 `SIGKILL`，跨进程调用记录、真实租约过期恢复、current output ownership 检查均存在；不是 throw 模拟。                                                                                                                                         | `afterArtifacts` 是全部内存登记之后；`afterCommit` 明确是 commit 文件写入后、run CAS 前，**不是 run accepted 后**。缺普通部分写入失败、accepted 后恢复，以及图库候选被 seed 的库存恢复场景。     | **PARTIAL**。                                   |
| **RB4-06** 当前正式引用闭包       | 新测试改变 `scriptArtifactId` 为不存在的 ID，同时更新外层 SHA，确实越过文件哈希层测试了内部引用拒绝；拒绝后没有新增 assets worker 调用。                                                                                                                               | 没有完整覆盖合法旧版本整组引用、缺 joint digest、缺 treatment/library 引用、父关系错误、声音修订后的 current set。源码也没有 current output version 检查。                            | **PARTIAL；完整合同 CONTRADICTED**。                 |
| **RB4-07** DTO/UI 真实性     | 状态优先级已调整；正式 treatment 的唯一 artifact 与 `view_artifacts` 得到同步断言。                                                                                                                                                           | accepted node 的 commit 校验失败仍可能显示全 completed；未知模型被断言为 `undefined`，UI 直接不显示，与“显式 unknown”不同。保留旧 artifact 的真实重跑失败组合未完整覆盖。                     | **PARTIAL；未知模型合同 CONTRADICTED**。               |

**关于 crash 窗口的准确表述：**当前实现把图完成放在 run 接受之前，原来“run 已接受而图未结束”的具体顺序可能已不再可达。可以用当前协议的 **accepted 后退出与恢复**证明等效安全性，但不能把现有 pre-CAS `afterCommit` 改名后算作该证据。

---

## 4. 旧 F1-F10 + N1 重裁定

`RESOLVED` 只表示对应旧失败机制已关闭，不自动覆盖该主题的全部门禁。

| 旧 ID                                        | 当前裁定         | 当前源码依据与剩余问题                                                                                                                                                                                    |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** 发布/registry 持久化                      | **PARTIAL**  | `creativePlanningNode` 已有 orphan commit 重建及完整 leftovers 复用；但新发布仍在每次文件写入之间调用 `context.addArtifact`，部分登记异常没有完整恢复协议。                                                                              |
| **F2** seed 与模型来源/兼容身份分开保存                  | **RESOLVED** | `seedJointPlanningThread` 将 `carriedModelTraces`、`carriedProviderTraces`、`carriedStageInputIdentities` 与种子产物一起 `updateState`；原 fallback treatment 来源丢失窗口已有对应硬崩溃测试。新增 inventory 元数据丢失归入 F10 残留。 |
| **F3** 共同创作上下文未进入真实请求                       | **PARTIAL**  | treatment 的承诺/grammar 以及 script/director 的共享输入已有宿主传递；真实四角色最终 Broker 请求和实际消费仍未证明，不能沿用“这些字段完全没传”的旧描述。                                                                                            |
| **F4** rerank 沿用旧语义                         | **PARTIAL**  | rank port 现在包含当前 director 的 `rankingSemanticIntent`，旧“仅有 IDs”的描述已不成立；真实 rank adapter 对扩展字段的消费和语义变化对照测试仍未闭合。                                                                                    |
| **F5** producer/model/contract identity 不完整 | **PARTIAL**  | rank stage identity 已加入，但 lower role checkpoint 未包含 ranker/model；缺失旧 rank identity 在 seed 路径被视为兼容。                                                                                             |
| **F6** graph-only IDs、正式引用闭包                | **PARTIAL**  | 正常发布会重绑正式 IDs，消费端新增了引用存在性/kind/SHA 检查；但未建立 current version、父关系和显式 joint/legacy 边界，声音修订仍丢 current supporting set。                                                                               |
| **F7** stale-client 编辑                      | **PARTIAL**  | Studio → pipeline 的 caller token 丢失与客户端保存时换基线已修。低层 optional token 分支仍在；完整配置竞争、真实锁及拒绝后零变更覆盖不足。**不是已证明的“HTTP 仍丢 tokens”。**                                                                       |
| **F8** 新 derivative 创建 legacy               | **RESOLVED** | Studio `reworkDraft/start` 的具体缺陷已修，新分配制作补 `joint-v1`。历史 parser、所有低层创建入口的完整覆盖仍为 UNVERIFIED，不因此修改历史 run。                                                                                         |
| **F9** 旧 artifact 覆盖当前阶段状态                  | **PARTIAL**  | running 优先、外层发布失败归 compile 已修；commit 校验失败没有反馈进状态决策，未知模型仍被隐藏。                                                                                                                                   |
| **F10** report/inventory 替代与弱物化测试           | **PARTIAL**  | 正常路径的 report 冒充 inventory 已修；inventory 没进入 seed checkpoint，真实离线消费仍未验证。                                                                                                                         |
| **N1** treatment provider 字段写入 model ID     | **RESOLVED** | `registeredTreatment` 使用 `providerTraces.treatment ?? "unknown"`；首次/fallback/seed 测试分别检查 provider 与 model，不再把模型字符串写到 provider 字段。                                                              |

---

## 5. 新增 findings 与当前阻断残留

**未确认旧清单之外的独立新增 P0/P1/P2 finding。**下面是旧 finding 在当前源码中的具体残留，不能因为它们表现为新测试缺口就另行重复编号。

### F1-r1 · P1 · PRODUCT_BUG：部分 registry 可随失败状态持久化，随后无法恢复

**位置：**`production-pipeline.ts::creativePlanningNode`，5915–5948、5848–5869；`workflow-runner.ts::run`、`runNode`。

**失败场景：**treatment 已经 `context.addArtifact`，下一次 `script.json` 写入发生局部权限或 rename 错误，而 `run.json` 仍可写。`run.artifacts` 与 context 的 artifact 数组共享，`runNode` catch 不撤回新登记项，失败 checkpoint 因而可能保存部分正式 registry。重试进入 leftovers 分支后，缺失的 script/director 等项会被直接拒绝，完整 SQLite 图也不能恢复这次发布。

**最小修复：**文件准备与正式 registry 接受分开。沿现有 runner/store 的窄接缝，在完整准备、重绑、验证后接受整组 artifact 与 output version；失败 checkpoint 不得把半组准备结果登记为正式集合。已有部分状态要有受控恢复路径，不是放松完整性检查。

现有 `afterArtifacts` 在全部登记后触发，不能覆盖这一反例。

### F5-r1 · P1 · PRODUCT_BUG / BOTH：外层失效与内层缓存仍使用不同身份

**位置：**`jointPlanningStageInputs` 4450–4468；rank port 5347–5389；`nodeAgentLoopCheckpoint` 9667–9680；`seedJointPlanningThread` 4656–4659。

**确定的问题有两处：**

第一，只换 ranker provider/model 时，外层 rank identity 改变，但传入 lower checkpoint key 的内容没有相应 provider/model。是否最终重放旧完成结果，还取决于未附的真实 ranker/role-loop 实现，**该最终行为为 UNVERIFIED**；不能用现在的 fake ranker 测试宣布它已修。

第二，跨 thread seed 明确把 `prior.stageInputs.rank === undefined` 当作兼容，可以携带旧 ranking 并把游标推进到 rank 后；同 digest 恢复却把缺失 rank identity 当作必须重排。两个路径对“身份未知”的定义相反。

**最小修复：**让 rank 的真实请求、producer/model、相关合同 pin 形成一个规范化执行输入，由它派生两层身份；未知旧 rank identity 不得被默认视为兼容。先建立“旧排序和 role checkpoint 已成功完成”的真实 adapter 回归，再分别改 provider、model、contract。

现有测试第一轮 rank 本就失败，且 fake `rankDetailed` 不消费 checkpoint，属于**实现缺口与测试建模不足并存的 BOTH**，不是有效的 completed-cache 回归。

### F6-r1 · P1 · PRODUCT_BUG：引用自洽不等于当前 accepted 版本，joint 还会被隐式降级

**位置：**`verifyExecutablePlanInput` 10060–10079、`verifyExecutablePlanReferenceClosure` 10086–10137、`requestVoiceTimingRevision` 1055–1070。

**失败场景：**一组旧 plan 和支撑 artifact 在全局 registry 中仍然存在且 SHA 自洽时，校验器没有检查其是否属于当前有效 output version；对于缺失 `producerRequestDigest` 的 joint plan，它还会跳过同 producer/commit 检查。treatment 可省略、图库引用可为空、父关系未核验，也没有按当前 joint 路线收紧。

**实际相邻入口：**声音时长修订只创建一个新 plan，`retainedArtifactIds` 为空，而且没有为新 plan 建立正式 joint 修订身份。这不是纯篡改假设，而是现有合法产品入口与新增校验器之间的合同缺口。

**最小修复：**消费校验从当前 accepted planning projection 取得 owner/version、plan 与引用集合，核对引用基数、kind、受控路径、SHA 和父关系。legacy 兼容由明确历史拓扑/版本决定，不能以“缺 digest”推断。声音修订进入同一正式发布合同，保留或重绑支撑引用并接受新版本；不能复制旧 commit key 冒充新接受，也不能靠放松校验维持运行。

### F7-r1 · P2 · PRODUCT_BUG（底层合同残留）：省略 tokens 可以跳过并发约束

**位置：**`workflow-core/types.ts::NodeInputOverrideDraft`；pipeline 两个编辑方法；runner 581–583。

**失败场景：**调用低层编辑入口时省略 `expectedRunRevision`，pipeline 不做 caller revision 比较；省略 `expectedVersionId`，runner 同样不比较输入版本。完整 wire DTO 已强制，但底层公开变更合同仍提供无 token 路径。

**最小修复：**在 B4 对外编辑变更入口强制合法 caller tokens，并更新直接调用该入口的测试。需要宿主内部变更时，应沿已有受控 transition 表达其身份，不能通过省略参数获得豁免。

**边界说明：**当前 Studio 已正确传递 tokens，本轮没有证明正常 HTTP 请求还能利用该省略路径；因此不把它描述为仍存在的 HTTP 丢字段漏洞。

### F9-r1 · P2 · PRODUCT_BUG / BOTH：正式接受校验失败仍可全绿，未知模型断言与合同不符

**位置：**`inspectCreativePlanningStages`、`planningCommitArtifactIds`、`PlanningStagesPanel`。

**失败场景：**planning node 已为 succeeded，但 commit/正式 artifact 校验失败，`planningCommitArtifactIds` 返回空映射；状态仍依据 checkpoint artifact presence 显示 completed，没有可行动的 publication issue。另外，已执行但无模型 trace 的角色返回 `undefined`，UI 隐藏该信息，而非显示未知。

**最小修复：**将正式接受验证结果纳入同一次 stage 状态投影；失败时 compile 明确未通过并保留已完成上游。模型角色的未知实际来源显式表示为 unknown，界面显示“实际模型未知”；确定性阶段则继续没有模型字段。

当前测试把 director/rank 无 trace 固定为 `undefined`，同时混同于确定性阶段“没有模型”，该断言属于 **BOTH**，不能作为新合同通过证据。

### F10-r1 · P1 · PRODUCT_BUG：图库 seed 窗口丢失库存路径

**位置：**`seedJointPlanningThread` 4663–4693；`creativePlanningNode` 5617–5693、5745–5750。

**失败场景：**图库 run 仅调整导演模型，脚本仍可保留，检索条件不变。seed 将 candidates/ranking 写入新 thread，但 inventory 路径只通过函数返回值传给局部变量。此时 `afterSeed` 硬崩溃，当前 digest 的 history 尚未写入。新进程发现已有 checkpoint，不再 seed，也没有从 checkpoint 恢复 inventory；候选获取身份不变又不会重新搜索，最终因 inventory 路径缺失停住。

**最小修复：**将私有库存 binding 与对应候选身份一起持久化到可恢复的 checkpoint 数据中；恢复和消费前验证其受控路径、内容身份及候选关联。该私有信息不应泄露到 Studio 公共 DTO。

现有 afterSeed 测试使用无图库路线，且编辑导致 script/director 重新执行，只证明 treatment provenance 存活，不能覆盖本场景。

---

## 6. 根因图

```text
R1：调用方观察版本与变更入口合同不完全一致
    浏览器打开时基线 ──已修──> Studio 原样传递 ──已修──> lease 内比较
                                                     └─ 缺 token 可跳过 → F7

R2：真实执行输入没有统一派生各层兼容身份
    当前语义 + producer/model + prompt/schema/rule
        ├─ stageInputs.rank 已包含部分身份
        ├─ lower role checkpoint 未包含对应 ranker/model
        ├─ 跨 thread 对“未知 rank identity”默认兼容
        └─ 最终 Broker recording 不足
            → F3 / F4 / F5
    实际来源随 seed 保存、provider/model 分离
            → F2、N1 的旧具体机制已关闭

R3：prepared 文件与正式 registry 接受仍交错
    写一个文件 → addArtifact → 再写下一个文件
                     └─ 普通异常 → 失败 checkpoint 保存半组 registry
                                      └─ leftovers 要求整组 → F1

R4：全局历史 artifact 集合被用于判断当前正式规划
    历史字节存在 + SHA 自洽
        ≠ 当前 accepted output version
        ≠ 正确父关系
        ≠ 正式发布验证成功
            → F6 / F9
            → A 声音时长修订的引用闭包缺口

R5：候选 checkpoint 与私有执行元数据不同步
    candidates/ranking 已 seed
        inventory 仅在返回值/history
            → seed-history crash 丢库存 → F10
```

这些身份不应被合并成一个万能 digest：`expectedRunRevision` 解决过期写入，stage identity 解决可保留范围，request identity 解决实际执行内容，commit/output version 解决正式接受。问题在于它们之间缺少一致、可验证的派生关系，而不是“存在多个 ID”本身。

---

## 7. 测试诚信检查

### 当前测试的具体判断

| 检查项                 | 结论                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 正式 treatment 旧空数组断言 | **同步正确。**当前要求唯一 `creative_treatment`，并同步了 `view_artifacts`，没有通过删除正式产物恢复旧绿测。                                                                                                                                        |
| 编辑基线断言              | **有效加强。**组件确实在 props 变更后保留旧 tokens；但回调固定成功，尚不能证明 409 后草稿保留和用户显式重绑。                                                                                                                                                 |
| ranker 变化测试         | **目标建模不足。**旧 rank 未完成，fake 不读 checkpoint；无法区分“正确失效 completed 缓存”与“本来就会重试 failed rank”。                                                                                                                             |
| inventory 测试        | **断言比旧版本更强，但越不过物化边界。**路径与 JSON 内容不同得到证明，真实选中素材、下载/读取和产出未被证明。                                                                                                                                                       |
| SIGKILL 测试          | **进程层级真实，窗口覆盖不完整。**源码确实自发 `SIGKILL`、等待租约过期，没有手工删锁；不能将其全部否定，也不能把四个名字等同于四个合同窗口。                                                                                                                                      |
| 未知模型测试              | **存在迎合当前实现的错误期望。**director/rank 无 trace 被期待为 `undefined`，与显式 unknown 合同不符。                                                                                                                                         |
| recording 证据        | **不能把 fake role 参数当最终请求。**承诺测试直接替换 `treatDetailed`；其中 `treatmentCheckpointPresent.push(true)` 是常量记录，不能证明实际 checkpoint 被消费。                                                                                         |
| 测试/生产特判             | 对已附当前测试及 B4 相关新增代码扫描，**未发现为指定题材、镜号、runId 或 fixture 模型名称新增的生产分支，也未发现所附测试中的 `.skip/.only` 或 `@ts-nocheck`**。但现有 `runPurpose === "test"` 会绕过部分生产前置检查，publication fixture 又使用该模式及 free editorial 路线，不能据此证明生产双审或媒体安全全链。 |

**断言变化历史的限制：**累计 patch 没有提供这些测试文件的逐行变更，因此“所有旧安全断言均未被删除”整体仍为 **UNVERIFIED**。当前全文能够证明上表中的具体新断言存在，不能证明缺失的历史断言全部得到等效替换。

### 共享红项归因

| 报告中的失败组                                                                  | 本轮裁定                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `server.test.ts` 3 例 + `studio-service.test.ts` 1 例，旧请求缺 tokens          | 根据报告描述，**STALE_TEST 的方向成立**；但完整测试和堆栈未附，逐例归因仍需核验。它们涉及 B4 编辑合同，不能仅因放在共享组就自动归 C2。同步这些 fixture 不等于修改 C2 金额/UI。 |
| note-only rejection：空范围 vs 全片                                            | 属 B5 的反馈范围合同；本轮不要求恢复旧“默认全片”断言。具体实现/测试应在 B5 重裁。                                                             |
| `production-pipeline.test.ts` 3 例，scene revision / reuse / changed quote | **UNVERIFIED。**“堆栈落在本轮未修改的函数”不能排除 B4 上游输入、artifact 集合或投影变化造成回归，尤其当前已发现声音修订引用缺口。                            |
| B5 3 红、C1 1 红                                                            | 提供的名称/数量与进入前记录相符，可继续单列跨批；本轮没有重新审其实现，也没有把它们计为 B4 已通过证据。                                                     |

以上失败描述来自执行者汇总，而非本轮复现。

---

## 8. 最小实施顺序与验证矩阵

### 实施顺序

| 步骤                        | 允许修改模块                                                                           | 先建立的失败测试                                                                                           | 通过标准                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **S1：编辑入口收口**             | workflow-core drafts、pipeline 两个编辑方法、Studio 纵向链及直接相关 tests                       | 缺失/非法 tokens；配置编辑的预检查后竞争；真实 lease 占用；组件 409 保留草稿                                                   | caller tokens 必须到持锁点；旧请求拒绝；完整比较 run、输入/输出版本、artifacts、授权和规划状态均无意外变化           |
| **S2：统一执行身份**             | planning identity helpers、真实四角色 adapters/ranker、既有 checkpoint 接口                 | 先成功完成 rank 与 role checkpoint，再分别只换 provider/model/contract；缺 rank identity 的旧记录；同候选池改变动作/真实性；未变对照组 | 最终 recording 请求与两层身份一致；变更真实 rerank、不重搜、不重跑无关角色；未知身份不默认兼容                      |
| **S3：库存恢复与真实消费**          | `creative-planning.ts`、seed/history 局部 helper、现有 worker inventory 边界             | 图库导演-only 变更后 afterSeed 硬 kill；库存缺失/篡改/候选错配；真实离线 materialization                                   | 新进程恢复同一 inventory binding；被选择候选与实际物化一致；public report 不能替代私有库存                 |
| **S4：发布、当前闭包与 A 声音修订一起修** | planning 发布 helpers、runner/store 窄接受点、plan verifier、`requestVoiceTimingRevision` | 第 1/2 个产物准备后普通 I/O 失败；部分 prepared 硬 kill；accepted 后退出；旧整组 plan、缺 digest、错误父关系；合法声音延长               | 正式 registry/output/接受身份同一次受控保存；恢复无重复角色/正式集合；消费只接受当前闭包；声音修订保留合法媒体且不靠 legacy 降级 |
| **S5：DTO 与未知来源**          | `inspectCreativePlanningStages`、正式接受映射、Studio DTO、`PlanningStagesPanel`          | succeeded node 的 commit 损坏；保留旧产物的重跑失败；模型无 trace                                                    | publication 验证失败明确未通过；运行/失败不被旧完成覆盖；模型未知显式显示，确定性阶段不伪造模型                        |
| **S6：门禁与证据回收**            | 直接相关测试、标准 test/CI 接入、JOURNAL/验证记录                                                | 四角色 recording、图库离线消费、历史恢复/新 derivative、共享红项逐例最小复现                                                  | RB4-01..07 都有行为证据；新增 B4/A 回归为零；共享旧红项有基线与合同归属，不用测试总数替代                         |

S4 不应只给 verifier 加一个更严格的 `if`：必须同时修合法声音修订入口，否则会把现有引用缺口转化为正常操作必失败。也不应为恢复部分 registry 引入第二工作流或新业务数据库。

### 验证矩阵

| 验证入口                                                         | 必须观察到的结果                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `production-planning-editing.test.ts` + HTTP contract tests  | 输入和配置两条路径都覆盖预检查竞争、真实锁、stale 409、拒绝后零变更                                                                     |
| `node-workspace.test.tsx` / client tests                     | props 刷新不换基线；409 后保留草稿；用户确认后才采用新基线                                                                         |
| 真实 treatment/script/director/rank adapter + recording Broker | 最终 producer/auditor 请求保留适用承诺、grammar、treatment、issues、当前排序语义；记录实际 provider/model                           |
| `production-planning-closure.test.ts`                        | 成功缓存后的 provider/model/contract-only 变化；未变对照不 rerank；缺身份不保留旧排序                                              |
| `production-planning-publication.test.ts`                    | 无图库与图库；普通部分 I/O 失败、各 prepared 窗口、accepted 后恢复、seed-history 窗口；真实进程、SQLite、lease，不删锁                        |
| 现有 Python inventory 物化测试入口                                   | 使用内容不同的 public/private 文件；实际读取 private binding 并产出对应媒体；缺失/篡改拒绝                                             |
| plan/preflight/A 回归                                          | 旧版、跨 run、重复、缺失、错误父关系均在 quote/worker 前拒绝；自然声音修订后 current reference set 完整，`assetKey/sourceInFrame/SHA` 保持正确 |
| stage DTO tests                                              | 当前运行/失败、正式发布失败、损坏 commit、未知实际模型都与界面一致                                                                      |
| 共享回归                                                         | 对报告中的 8+3+1 红项保存完整失败输出和阶段基线；按失败合同归因，而不是按堆栈文件是否改过归因                                                         |

集中验证沿用附件已确认的构建、Node test 与 Studio Vitest 入口；新增 recording 和 Python 消费用例应接入仓库实际存在的标准脚本，不能停留在临时手跑。`npm run typecheck`、`git diff --check` 必须在最终同一工作树再次通过。真实模型、付费媒体、部署和 C6 浏览器验收不作为本批擅自执行的补证手段。

---

## 9. Codex 执行建议

```yaml
codex_execution_advice:
  verdict: CHANGES_REQUIRED

  blocking_findings:
    - "F1-r1 | P1 | PRODUCT_BUG: 逐项 addArtifact 与文件写入交错，部分 registry 可随失败 checkpoint 持久化，恢复却只接受完整集合。"
    - "F5-r1 | P1 | PRODUCT_BUG/BOTH: rank 的 stage identity 与 lower checkpoint identity 不一致；跨 thread 将缺失 rank identity 视为兼容；现有测试未建立成功缓存。"
    - "F6-r1 | P1 | PRODUCT_BUG: 消费引用未绑定当前 accepted output version；缺 digest 隐式跳过 joint 校验；A 声音修订未保留当前引用闭包。"
    - "F7-r1 | P2 | PRODUCT_BUG: 底层编辑入口仍允许省略 caller revision/version；正常 Studio 传递链已修，但完整权威入口合同未收口。"
    - "F9-r1 | P2 | PRODUCT_BUG/BOTH: 正式 commit 校验失败未反馈至 completed 状态；未知模型仍被隐藏，测试固化了不符合同的期望。"
    - "F10-r1 | P1 | PRODUCT_BUG: candidate inventory binding 未随图库 seed checkpoint 保存，seed-history 窗口崩溃后可丢失。"
    - "RB4-02 | UNVERIFIED: 缺少四角色真实 adapter 到 Broker 最终请求的 recording 证据。"
    - "RB4-04/RB4-05 | UNVERIFIED: 缺真实离线库存物化、accepted 后恢复及图库 seed 崩溃证据。"

  non_blocking_risks:
    - "F2、F8、N1 的旧具体失败机制已关闭，不得为修其他问题回退。"
    - "提供的 exit 0 和测试数量未由本轮独立重跑，最终需绑定同一 dirty-tree 快照和完整命令输出。"
    - "历史 parser、真实 ranker/角色 adapters、Broker 和 Python consumer 的未附部分不能按实现正确补全。"
    - "B5 三个红项和 C1 一个红项继续单列；共享 scene-revision/quote 红项的跨批归因仍需核验。"
    - "test-purpose 和 free editorial fixtures 不能替代生产媒体、双审或 paid ledger 的完整证明。"
    - "L4/L5、真实模型媒体和云端验收未执行，不影响本批继续做获准的本地 B4 修复与验证。"

  implementation_plan:
    - "S1: 强制 B4 编辑入口 tokens，补输入/配置竞争、真实 lease 和 409 草稿保留测试。"
    - "S2: 从规范化真实执行输入派生 stage 与 role checkpoint 身份，未知 rank 身份强制失效，补成功缓存后的换模测试。"
    - "S3: 将私有库存 binding 与候选身份一起持久化和恢复，完成真实离线消费验证。"
    - "S4: 收口 prepared 与 accepted 发布，绑定当前正式引用闭包，并同时修复合法声音时长修订。"
    - "S5: 将正式接受验证纳入 DTO 状态，显式显示未知实际模型，修正对应错误断言。"
    - "S6: 串行重跑 B4、A 相关回归及共享扫描，更新证据后停止，重新进行阶段审计。"

  verification:
    - "RB4-01: 两种编辑都验证 caller tokens 到持锁点；冲突后 run、graph、artifacts、授权零意外变更。"
    - "RB4-02: recording 捕获真实四角色最终请求及实际 provider/model，不只捕获 fake port 参数。"
    - "RB4-03: 旧 rank 和 role checkpoint 已成功完成；provider/model/contract-only 变化真实 rerank，未变对照不重排。"
    - "RB4-04: public/private 内容不同，真实 worker 消费 private binding，产出与选中候选一致。"
    - "RB4-05: 普通部分写入失败及硬崩溃恢复均成立；真实 SQLite、FileRunStore、lease；唯一 current accepted 结果。"
    - "RB4-06: 当前版本、引用基数、kind、父关系、SHA、显式 legacy 边界和 A 声音修订全部闭合。"
    - "RB4-07: running/failed/publication failure/unknown model 与服务端权威状态一致。"
    - "最终同一工作树 build、相关 Node tests、Studio Vitest、typecheck、diff-check 通过；共享红项逐例归因。"
    - "本建议不授权修改、付费调用、commit、push 或 deploy；不进入 B5/C1/C2 施工。"
```


