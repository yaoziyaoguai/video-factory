# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6aa37eed-b080-83eb-aceb-47893143513f

## Prompt

# VideoFactory 恢复审计：B4（Batch 1/4）

你是独立的架构与实现审计者。你只负责分析、规划、审计和执行建议，不修改文件、不运行付费 Provider、不部署。当前主 Codex 会核对你的结论并整理成供 Claude Code + GLM 5.3 Flash 执行的资料包。你可以在内部做并行的多视角分析，但最终必须输出一份统一、无冲突的结论。

## 项目与当前基线

- 项目：VideoFactory，一条面向普通创作者的 AI 视频制作流水线。
- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 当前工作树是累计的未提交实现，不是一个干净 patch：86 个 tracked 修改、22 个 untracked 文件，tracked diff 约 `+13248/-692`。
- 必须审计附件中的当前完整源码，不能把旧 `JOURNAL.md` 的 ACCEPTED 或旧 Oracle 结论当作当前事实。
- A 阶段由用户确认完成。本批不重做 A，但要检查 B4 是否破坏 A 的时间轴、产物绑定、媒体复用和付费安全。
- 当前不允许 reset/stash/checkout/clean，不允许 commit/push/deploy，不读取密钥，不调用真实 Provider。

## Batch 边界

Batch: 1/4

本批范围仅为 B4：`joint-v1` 创作规划接入生产主流程，包括：

1. 新 production 使用 joint planning，历史 run 仅保留读取/恢复兼容；新建返工 run 不应继续创建 legacy production。
2. joint 与 legacy 规划互斥，不能执行两套 script/director/candidates/rank/preflight，也不能在 joint 失败时静默 fallback 到 legacy。
3. reference grammar 的顺序、真实输入、复用与 parent/provenance。
4. treatment/script/director/search/rank/integrate/compile 的真实 port、payload、prompt/schema/producer identity 与 checkpoint identity。
5. 唯一 `planningOutputs` 投影、正式 artifact 注册、executable plan 内部引用和当前 run registry 的闭包。
6. LangGraph SQLite checkpoint 与 FileRunStore 跨存储提交的两个 crash window、幂等恢复、provenance 和保留 stage 兼容性。
7. planning stage DTO 的真实状态来源，以及 input/model 编辑的 revision/version/lease/CAS 和精确依赖失效。
8. 真实 worker/ranker inventory 到后续 materialization 的消费边界。

排除范围：

- 不设计或实现 B5 的制作返工策略，只指出由 B4 接入直接造成的回归。
- 不设计 C1/C2 授权产品，只检查既有付费边界未被 B4 绕过。
- 不审 C3-C6、部署、云端和真实付费 E2E。
- 不引入第二个工作流框架、Redis、微服务或新业务数据库。

## 当前确定性证据

- `npm run build:pipeline`：通过。
- `git diff --check`：通过。
- `npm run typecheck`：失败，Studio 中存在 `expectedRunRevision` / `expectedVersionId` 调用缺失、`acceptedPlanDigest` fixture 缺失和重复 JSX 属性。
- B4 pipeline 聚焦：144/144 通过。
- B4 Studio 聚焦：24/29 通过，5 失败：
  - planningStageId 输入覆盖先撞 stale conflict；
  - 校验顺序先报无效 revision 而非 stage 错误；
  - stage model routing 与 joint source adjustment 均撞 stale conflict；
  - treatment 已有正式 artifact，但旧测试仍期待无 artifact。
- 这些失败有的可能是测试过时，有的可能是跨层合同没有同步。请逐项依据当前源码裁定，不能为了绿测删掉正确的并发参数或正式 artifact。

附件中的旧 B4 Oracle transcript 只是一份历史 finding 清单。当前源码此后已被修改，必须对旧 F1-F10 逐项给出 `RESOLVED`、`PARTIAL`、`OPEN` 或 `OBSOLETE`，并引用当前源码证据；不能直接复制旧 verdict。

## 不可破坏的产品与架构规则

- 不按题材、镜头编号、runId 或模型写特判。
- planning graph 不能持有或调用付费媒体 create；素材付费仍在正式执行边界。
- 没有合格素材时停住并反馈，不能生成说明卡伪装成功。
- 当前新制作只有一条生产规划主路径；兼容只服务于历史 run 恢复，不是永久双轨和故障 fallback。
- 用户看到的状态必须来自当前 checkpoint/正式提交，不能拿旧 artifact 存在推断“已完成”。
- 导演前置不是增加一个旁观模型，而是让 treatment、script、director、素材可得性共享一份可执行方案。
- 修复应保留未来数字人、口播、照片转视频、短剧可复用的稳定边界，但本批不实现这些产品。

## 要求输出

请用中文输出，保留代码标识符原文，并严格按以下结构：

1. **Verdict**：只能是 `ACCEPTED` 或 `CHANGES_REQUIRED`。
2. **阶段完成度**：B4 每个合同点分别标 `PROVEN` / `PARTIAL` / `CONTRADICTED` / `UNVERIFIED`，给出当前文件、symbol/行号和理由。
3. **旧 findings 复核表**：旧 F1-F10 各自为 `RESOLVED/PARTIAL/OPEN/OBSOLETE`；列当前证据、剩余场景和是否阻断 B4。
4. **新增 findings**：仅列当前源码仍存在且旧清单未覆盖的问题，按 P0/P1/P2；说明失败场景、违反合同和最小修复。不要把测试陈旧误写成产品 bug。
5. **根因图**：区分一个根因造成的多个表象，尤其是 revision/version、artifact identity、checkpoint identity、跨存储 commit，不要给每个测试单独打补丁。
6. **最小实施顺序**：适合 Claude Code + GLM 5.3 Flash 一次完成 B4 的清晰步骤。每步给允许修改模块、non-goals、先写的失败测试、实现合同和通过标准。不能要求重写整个 `production-pipeline.ts`。
7. **验证矩阵**：列精确命令与行为断言；必须包含真实 service/store/runner、进程 crash recovery、双客户端 stale edit、无图库/有图库、历史 resume/新 derivative、rank intent 变化、正式 artifact closure。
8. **资料包建议**：指出执行者还必须读哪些当前文件，哪些旧材料只作历史。
9. 末尾给出：

```yaml
codex_execution_advice:
  implementation_plan:
    - <有序、具体、可由当前执行者落实的步骤>
  non_goals:
    - <明确排除>
  optional_subagents: []
  verification:
    - <检查与预期证据>
```

不要用“基本完成”。证据不足就写 `UNVERIFIED`。Oracle 结果只是执行建议，不授权修改、付费或部署。

## Answer

## 1. Verdict

**CHANGES_REQUIRED**

## 2. 阶段完成度

### 证据边界

附件实际包含的是**部分完整源码、两份 current diff、部分测试全文及历史资料**，不是完整工作树。`production-pipeline.ts`、`production-studio.ts`、`NodeWorkspace.tsx` 等只提供了差异及上下文；`workflow-runner.ts` 只有一个局部差异，`run-store.ts`、真实 ranker、主要角色适配器和 Python inventory 消费实现没有附上。不能据此声称已完成“当前完整源码端到端审计”。附件中的 pipeline 材料明确以 `.diff` 提供。

本次没有独立访问用户本地仓库、确认 Git 元数据或重跑 npm/进程恢复测试。`144/144`、`24/29`、构建成功及 typecheck 失败，均作为本次提供的运行证据使用，而不是本次执行结果。

下表中的源代码行号按 **current diff 新文件坐标**计算；不是 diff 自身的编号，也没有沿用旧 Oracle 的行号。`PROVEN` 表示所列代码合同可由当前附件直接建立，不表示真实付费 E2E 已验证。

| B4 合同点                                             | 状态               | 当前文件、位置与理由                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 新制作/新 derivative 使用 joint；历史 run 不被默认迁移**     | **PARTIAL**      | `production-studio.ts:reworkDraft` 344–350、`start` 694–704 已为新分配制作写入 `joint-v1`，不再排除 rework。`contracts.ts:parseWorkflowFeatures` 1009–1026 不给缺失字段补 joint 标记。**旧 Studio derivative 缺陷已修复**；完整 `ProductionPipeline.dispatch` 创建入口及真实历史恢复链未提供，全入口覆盖仍为 **UNVERIFIED**。              |
| **2. joint/legacy 拓扑互斥，无 joint 失败后回退 legacy**      | **PROVEN**       | `production-pipeline.ts:createWorkflow` 2819–2866 对外层旧规划节点与 `creativePlanningNode` 使用互斥分支；`creativePlanningNode` 5532–5534 对非完成结果抛错。`creative-planning.ts:createCreativePlanningGraph` 435–496 固定区分图库/无图库子图。此结论限于可见拓扑与失败处理。                                                     |
| **3. reference grammar 顺序、输入、复用与来源**               | **PARTIAL**      | `production-pipeline.ts:referenceGrammarNode` 3981 起，joint 依赖 `brief`，使用 uploadId/label/SHA，并验证受控路径、大小和内容；grammar 的 parent 绑定参考视频产物。但 `treatment` 5294–5336 仍未接收 grammar 或系列承诺上下文；跨 run 参考复用的完整服务链和测试未附。                                                                        |
| **4a. 真实角色 payload、prompt/schema 消费**              | **PARTIAL**      | `screenwriter` 5337–5368、`director` 5369–5473 已把 `creativeTreatment`、`planningIssues` 放入真实 `provider.run` 请求，而非仅放入 checkpoint key。这是有效修复。但 treatment 输入仍不完整，integrate 仍只追加 `rationale`；真实 producer/auditor/Broker 是否保留并消费新增字段为 **UNVERIFIED**。                                  |
| **4b. 请求身份、producer/contract identity、rank 当前语义**  | **CONTRADICTED** | `jointPlanningStageInputs` 4403–4413 只有 treatment/script/director，没有 ranker 身份。`rank` 5231–5267 新增了 `planningIntent` 中的 artifact IDs/issues，却没有把当前 script/director 的画面要求重建进候选报告的语义输入。详见 F4/F5。                                                                                  |
| **5a. 唯一 `planningOutputs` 兼容投影**                  | **CONTRADICTED** | `planningOutputs` 4214–4231 只读 joint；assets、voice、render、technical-review 等消费者继续各自选择 joint/legacy 路径。`planningCandidatePaths` 4234–4246 还把公开 report 路径当作 private inventory 路径。这不是要求的唯一兼容边界。                                                                                     |
| **5b. 正式 artifact 与 executable 内部引用闭包**            | **PARTIAL**      | treatment 已正式注册；5819–5825 将 executable 的 treatment/script/director/candidate IDs 重绑为正式 ID；`verifyJointPlanningCommit` 4780–4792 也检查对应关系。**原始 graph-only ID 缺陷已被修复。**但下游 `verifyExecutablePlanInput` 9877–9895 仍只核验 plan 文件描述符、字节及 schema，没有解析内部引用，也没有建立当前有效 output version 的闭包。 |
| **6. SQLite/FileRunStore 两处 crash window、幂等与保留证据** | **PARTIAL**      | SQLite saver、稳定 thread、无 MemorySaver fallback 可见；播种产物与携带的模型来源/兼容身份已同 checkpoint 保存。宿主新增 orphaned commit 恢复，但发布仍是逐项 `addArtifact` 后写 commit；部分注册的恢复及真实 FileRunStore 接受点缺少完整实现和进程死亡证据。详见 F1/F2。                                                                                   |
| **7a. planning stage DTO 真实状态**                    | **CONTRADICTED** | `inspectCreativePlanningStages` 2327–2368 仍由 artifact presence 建立 `completedStages`，且 completed 优先于当前 cursor。正式发布失败而图产物齐全时，仍可能全部显示 completed。                                                                                                                                   |
| **7b. 编辑 revision/version/lease/CAS 与失效**          | **PARTIAL**      | HTTP 已保留并要求 caller revision/version；服务已在 no-op 前检查。但 input 编辑只把 version 传入 pipeline，配置编辑未向 pipeline 传 caller revision，lease 内复核链没有闭合证据；客户端草稿类型与 wire DTO 也未同步。详见 F7。                                                                                                            |
| **8. worker/ranker inventory 到物化的消费边界**            | **CONTRADICTED** | 搜索适配器验证 private inventory 后，只返回公开 report；下游再以 report 冒充 inventory。真实 Python 消费端未附，因此**不能宣称已复现下载失败或付费绕过**，但接口替代本身已经成立。                                                                                                                                                           |

**A 的保护边界：**可见 graph port 不含媒体 create，搜索请求也是 `asset.search`；不能据此认定 B4 在图内发起了付费媒体调用。但完整 worker 消费、媒体复用、历史未知付费结果恢复及时间轴修改后的正式引用闭包，仍需真实离线集成验证，状态为 **UNVERIFIED**。

## 3. 旧 findings 复核表

`RESOLVED` 针对旧 finding 的**具体失败机制**，不自动代表相关整项合同已经通过全部验收。

| 旧 finding                                  | 当前裁定         | 当前证据与剩余场景                                                                                                                                                                                                                                                                                          | 是否阻断 B4              |
| ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **F1 · P1：commit 先于 registry 持久化**         | **PARTIAL**  | `creativePlanningNode` 5615–5666 新增 `registeredCount === 0` 的 orphan 分支，验证 prepared 文件后重新注册；因此不能再照抄“commit 存在、registry 为空必然永久失败”。但 5670 起的 leftovers 分支仍要求完整集合，`verifyJointPlanningLeftovers` 4810 起拒绝部分注册；全新发布仍交错执行文件写入和 `addArtifact`。**部分集合能否由真实 runner 异常路径持久化，以及两处硬崩溃如何恢复，尚未得到完整源码/进程测试证明。**  | **是**：发布协议验收未闭合。     |
| **F2 · P1：seed 与 provenance/兼容身份分开保存**     | **RESOLVED** | `seedJointPlanningThread` 4591–4593 将 `carriedModelTraces`、`carriedStageInputIdentities` 随产物一起 `updateState`；graph annotation 明确声明这两个 channel；恢复分支读取并核验。旧“seed 成功、history 未写导致已知 fallback 模型来源丢失”的具体窗口已有修复。字段覆盖不全归 F5，正常注册写错 provider 归新增 N1。                                                      | **否，针对原缺陷**；仍须补进程回归。 |
| **F3 · P1：共同创作输入未进入真实角色请求**                | **PARTIAL**  | script/director 的 `creativeTreatment`、`planningIssues` 传递已经修复。剩余是 treatment 未收到已有 reference grammar/系列承诺上下文；`suppliedSources` 固定为空；integrate 仅拼接采用说明，尚未建立“创作约束—候选采用—实际消费”一致性的证据。无真实来源时空数组合法，**不能为修复而伪造来源**。                                                                                        | **是**。               |
| **F4 · P1：请求 rerank 却沿用旧语义请求/checkpoint**  | **PARTIAL**  | 5236–5255 已将当前 artifact IDs/issues 加入请求和 checkpoint，所以不能再断言两次 key 必定相同。但 `...candidates.output` 的旧 scene intent 未用当前 script/director 内容更新。只给内容摘要式 ID，不能让排序模型知道新的主体、动作或真实性要求。真实 ranker 对额外字段的消费未附。                                                                                                  | **是**。               |
| **F5 · P1：producer/contract identity 不完整** | **PARTIAL**  | `jointPlanningInputDigest` 不再剔除 `taskContractDigests`；script identity 已含 provider；三角色已有 contract version。剩余确定场景：**只更换 `options.assetSemanticRanker` 的 provider/model，brief digest 与三个 stage identity 均可不变，completed graph 可直接重放而不执行新 ranker。**播种还可直接推进到 rank 之后。实际 prompt/schema/规则 pin 的完整消费链未提供。 | **是**。               |
| **F6 · P1：executable 保留 graph-only IDs**   | **PARTIAL**  | 新产物已正式注册 treatment，并重绑 executable IDs；commit verifier 已检查内部 ID 与 committed artifacts 对应。剩余在**消费侧**：`verifyExecutablePlanInput` 不解析内部引用、不检查当前有效版本闭包。不能把“初次生成正确”扩大为“恢复、人工修订和下游消费始终正确”。                                                                                                               | **是**。               |
| **F7 · P1：无法拒绝 stale-client 编辑**           | **PARTIAL**  | 原来丢弃 caller tokens 的 parser 已修复，服务也会拒绝明显过期的顺序提交。剩余：服务读取 R 并通过预检查后，配置修改还会 `await assertProvidersAvailable`，随后以不含 expected revision 的调用进入 pipeline；两个已通过预检查的请求仍缺少 caller revision 的持锁复核合同。input 路径同样未传 run revision。完整 host 方法未附，不能以现有测试宣称 race 已闭合。                                                 | **是**。               |
| **F8 · P1：新 derivative 仍创建 legacy**        | **RESOLVED** | `reworkDraft` 明确生成 `joint-v1`；`start` 的补标条件已不再排除 `brief.rework`。旧 Studio 新版本分配场景已修复。完整低层创建入口及历史 resume 行为仍需独立验证，不能因此修改原历史 run 的拓扑。                                                                                                                                                                 | **否，针对原缺陷**。         |
| **F9 · P2：artifact 存在被当作当前完成**             | **OPEN**     | 仍是 `failed → completedStages.has → runningStage → pending`。重跑角色保留旧 artifact 时，旧完成覆盖当前运行；图已完成而正式发布失败时，没有“缺产物阶段”可被判 failed。                                                                                                                                                                          | **是**：用户状态不真实。       |
| **F10 · P2：report/inventory 替代及弱集成测试**     | **OPEN**     | 搜索只保留 report、`candidateInventoryPath` 仍指向 report。公开候选描述不能被默认视为包含私有物化数据的 inventory。当前 attachment 未提供旧测试对应的完整新版本与真实消费端，因此“集成测试已修复”亦不能成立。                                                                                                                                                             | **是**：真实执行边界未闭合。     |

### 五个 Studio 失败的逐项裁定

| 失败                                               | 裁定与正确处理                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepts planningStageId...` 先撞 stale            | **测试请求过时。**合法调用没有 `expectedRunRevision` / `expectedVersionId`，当前服务又正确地在 no-op 前校验它们。测试应读取真实 detail 的 tokens 后提交，不能恢复“缺 token 也成功”。                                                                                  |
| `maps planningStageId...` 报 revision 而非 stage    | **该失败是测试同时提交多项非法条件，不是已证明的 parser 产品缺陷。**首个请求是“合法枚举 treatment + 不允许的 nodeId + 缺 revision/version”。枚举校验在 parser；nodeId/stage 配对在服务，前者通过后可先报缺 revision。测试 node/stage 配对时应携带合法 tokens；测试非法枚举时单独断言 400，不把多重错误文案优先级当业务合同。 |
| `routes stage-scoped model changes...` stale     | **测试未同步新 revision 合同。**每次成功修改后应重新取得 revision，再执行下一次独立修改。之后还要验证真正执行的 provider/model，而不只看 DTO。                                                                                                                        |
| `routes joint asset-source adjustments...` stale | **测试请求缺 revision。**服务已有 `replanNodeId = joint ? "creative-planning" : "visual-direction"`。修正请求后还应断言失效对象、保留的上游产物和实际调用次数；“节点仍存在”不足以证明路由正确。                                                                            |
| 完成后 treatment 仍期待无 artifact                      | **断言过时。**应期待唯一正式 `creative_treatment`，并同步更新 `view_artifacts` action；不能删除正式产物来恢复旧断言。                                                                                                                                 |

前四项的旧调用形态和 fake conflict 可直接从测试看到；第五项同时存在旧 `artifactIds=[]` 与旧 actions 断言。

另需准确区分：`PlanningStagesPanel` 自己构造的对象缺 revision，**但 `NodeWorkspace` 的父回调已经补入 `expectedRunRevision`**。因此这里能确定的是“表单草稿类型与完整请求 DTO 混用”，不能直接写成“所有阶段换模型 HTTP 请求都漏 revision”。应拆开草稿类型与 wire DTO，并检验编辑草稿是否绑定了打开时观察到的版本，而不是保存时随 props 刷新换成新版本。

`acceptedPlanDigest` fixture 缺失、重复 JSX 属性属于当前报告中的类型门禁问题；相关完整测试文件未附，本次不虚构其精确修复行号，也不把它们升级成新的 B4 运行时 finding。

## 4. 新增 findings

### N1 · P2：正式 treatment 的 `provenance.providerId` 被写成 model ID

**位置：**`packages/production-pipeline/src/production-pipeline.ts`，`creativePlanningNode` 5738–5750，尤其 5746；`fileArtifact` 9081–9110。

**失败场景：**treatment 正常返回 `trace.modelId = "model-b"` 后，注册代码把 `modelTraces.treatment ?? treatmentAgent.id` 传给 `fileArtifact` 的 `providerId` 参数，最终正式 artifact 的 `provenance.providerId` 成为 `"model-b"`。不需要崩溃就能发生，因而不是旧 F2 的“跨存储窗口丢 provenance”。

**违反合同：**provider identity 与 model identity 被混用，正式产物不能诚实表达实际执行来源。当前 commit verifier 的 key/SHA 正确也不能纠正这个字段。

**最小修复：**为阶段保留明确区分 `providerId`、`modelId`、请求/合同身份的执行证据，注册 treatment 时按现有 provenance 的 provider 命名空间填写正确来源；model 放模型字段。来源缺失应明确未知，不能用配置首选值冒充真实执行。该证据随播种一并保存，避免重新引入 F2。

**先写测试：**使用 provider ID 与 model ID 明确不同的 recording agent，分别覆盖首次完成、fallback 完成、seed 后恢复；正式 artifact 的 provider 字段始终不是 model 字符串。

本次没有建立独立于旧清单的新增 P0/P1 证据。

## 5. 根因图

```text
R1：调用方观察到的并发版本没有贯穿到持锁变更点
    browser draft 的 revision / inputVersion
        → HTTP parser（已修复）
        → Studio 预检查（已加入）
        → pipeline 持锁变更（caller revision 未传递）
        → F7
    同一次合同升级未同步表单类型与测试请求
        → 4 个 Studio 失败、部分 typecheck 失败
    注意：测试过时与持锁合同缺口，是两个不同结论。

R2：真实请求、阶段兼容身份与执行来源没有共用一份定义
    treatment 缺共享上下文                       → F3
    rank key 新了，但语义报告未刷新                → F4
    ranker producer/model/contract 不参与图兼容    → F5
    model 字符串被写入 provider 字段              → N1
    seed 原子携带证据                             → F2 原窗口已修复

R3：图内结果与正式接受结果之间缺少完整的发布状态合同
    graph artifact IDs
        → 正式 registry IDs（重绑已修复）
        → 文件准备 / registry / output version / commit 标记
        → F1 的剩余恢复验收
    正式 plan 文件正确 ≠ 当前消费引用闭包正确
        → F6

R4：阶段有历史产物，被等同于阶段当前已完成
    artifact presence 优先于当前执行和正式发布结果
        → F9 的“重跑显示完成”和“发布失败全绿”

R5：公开描述与私有执行数据被当成同一种输出
    public candidate report ≠ private inventory
        → F10
    joint/legacy 选择散落消费者
        → planningOutputs 唯一投影合同未满足
```

实施时必须保持以下身份彼此独立：

| 身份                                          | 解决的问题                                 |
| ------------------------------------------- | ------------------------------------- |
| `expectedRunRevision` / `expectedVersionId` | 这次写操作是否仍基于用户看到的版本。                    |
| 请求语义 digest                                 | 模型/worker 实际收到的内容是否相同。                |
| stage compatibility identity                | 执行者、模型、参数、prompt/schema/规则及相关上游是否仍兼容。 |
| `inputDigest` / thread identity             | 当前图是否可以恢复，还是必须形成新的规划输入。               |
| `planningCommitKey` + 正式 output version     | 哪一组正式产物被当前 run 接受。                    |

不能用“digest 一样”代替 stale-write 检查，也不能用“新建了 thread”证明保留的旧 ranking 已适用。

## 6. 最小实施顺序

### 步骤 0：补齐当前证据，固定施工基线

**允许修改模块：**测试及交接记录；此步不改产品行为。

**先写/确认：**现有 B4 测试的实际源码、退出码，以及旧 F1–F10 对应当前函数。把尚未提供的完整文件列入执行者必读清单。

**实施合同：**保留全部 dirty/untracked 工作；不按旧 ACCEPTED 回滚，不把历史 transcript 当当前实现。下面步骤发现与本报告不同的完整源码保护时，以当前完整源码和行为测试修正 disposition。

**通过标准：**每项 `UNVERIFIED` 都有明确的待验证入口，而不是被标成完成。

**Non-goals：**依赖升级、工作树清理、部署、C 剩余功能施工。

### 步骤 1：闭合编辑并发的纵向调用链

**允许修改模块：**`shared/api.ts`、`app.ts`、`studio-service.ts`、`production-studio.ts`、pipeline 的两个编辑方法，以及必要的现有 runner/store 接口；对应 Studio/组件测试。

**先写失败测试：**双客户端顺序 stale；两个请求同时通过服务预检查后顺序进入 host；真实 execution lease 占用；旧草稿在 props 刷新后保存。

**实施合同：**caller tokens 原样到达持锁变更点，在变更和可影响结果的 no-op 返回前复核。配置更新不得用新加载的服务端 revision 代替 caller revision。表单草稿与完整请求 DTO 分离，保存时不能无声升级旧草稿的基准版本。

**通过标准：**合法修改成功；旧 revision/version 返回 409；拒绝后 run、图输入、产物、授权状态均不变；阶段枚举和节点配对非法仍为 400。

**Non-goals：**把并发字段改成可选、改变历史付费恢复策略、重写 store。

### 步骤 2：统一角色真实请求、兼容身份及执行来源

**允许修改模块：**`creativePlanningNode` 的局部 helpers、`creative-planning.ts` 必要状态字段、相关角色输入类型/适配器、现有 Broker task 定义及其测试。

**先写失败测试：**recording transport 看见 treatment、已有承诺、参考语法和当前 issues；只更换 ranker model/contract 不能重放旧排序；provider/model 同名空间混淆测试；F2 seed 窗口回归。

**实施合同：**每个角色先构造一份规范化的真实请求，再由同一内容生成请求身份和相关兼容身份。rank 纳入兼容检查。treatment 接收适用的参考风格与用户/系列承诺；参考风格不被当成事实证据。保留实际 provider/model 来源，不用首选配置补造执行记录。

**通过标准：**修改相关 producer/contract 后仅失效依赖闭包；未受影响角色不重跑；请求和 checkpoint 不出现“一个有字段、另一个没字段”。

**Non-goals：**第三审计模型、重做角色内部循环、凭空补来源。

### 步骤 3：修复候选、排序、私有库存和唯一输出投影

**允许修改模块：**planning 的 search/rank/integrate 适配器、`planningOutputs` 及消费者、`python-worker-client.ts`、真实 ranker、现有 Python inventory 搜索/消费模块。

**先写失败测试：**query/provider/candidate pool 不变、画面 action 改变；公开 report 与私有 inventory 使用不同内容、不同文件；真实离线物化消费检查。

**实施合同：**保留候选池时，按当前 script/director 重建排序意图，保留原候选及预览证据；rank checkpoint 取自该真实请求。private inventory 独立保留并校验，不能用 report 顶替。`planningOutputs` 内部统一适配 joint/legacy，消费者不再各自判断。

integrate 可保留确定性实现，但必须核验实际候选采用与后续消费一致，不能仅追加 `rationale`。需要改变画面要求时回到既有 director 责任路径并重新验证证据。

**通过标准：**同检索条件不重搜、语义改变必重排；恢复不丢库存；实际物化消费与被选候选一致；无图库不制造候选文件。

**Non-goals：**第二套搜索器、为了填满阶段而增加模型调用、在 planning 内创建付费媒体。

### 步骤 4：收口正式发布与引用闭包

**允许修改模块：**pipeline 规划发布局部 helpers、现有 `WorkflowRunner` 的窄批量登记/结果接受位置、`FileRunStore` 现有持锁保存边界、正式 plan 消费校验。

**先写失败测试：**真实进程在图完成未登记、prepared 文件完成未接受、run 已接受未写结束标记时退出；文件写入失败产生的部分准备状态；缺失/旧版/跨 run 内部引用。

**实施合同：**以同一次受 lease/CAS 保护的 run 保存接受正式 registry、当前 output version 和 commit identity。外部 commit 文件不能单独证明“已接受”。异步文件准备阶段不得留下被误认为正式接受的部分 registry；已接受结果恢复时直接复用，prepared 结果只能经验证后接受。

plan 重绑后再定稿和计算 SHA；报价与执行入口检查内部引用及当前有效版本闭包。对合法历史版本采用明确兼容规则，不放松当前 joint 规则。

**通过标准：**各 crash window 后完成角色调用数不增加，正式产物不重复，唯一当前结果引用可解析；篡改与身份冲突 fail closed。A 的声音时长修订等入口，也必须保留它需要的规划引用，而不是仅保留一个新 plan 文件。

**Non-goals：**跨 SQLite/JSON 分布式事务、新业务数据库、整文件重写 `production-pipeline.ts`。

### 步骤 5：修复 DTO 与同步 Studio 类型/测试

**允许修改模块：**`inspectCreativePlanningStages`、Studio DTO 映射、`PlanningStagesPanel.tsx`、`NodeWorkspace.tsx` 及相关 fixtures/tests。

**先写失败测试：**重跑阶段仍有旧 artifact；graph 完成但发布失败；commit 验证失败；treatment 正式产物存在；未知实际模型来源。

**实施合同：**状态区分当前活动、当前适用的已完成证据和正式接受结果。运行/失败不能被旧 artifact 覆盖。发布失败必须暴露可行动状态；没有正式接受不能展示正式产物已就绪。修正草稿类型、fixture 字段和重复 JSX，不放松线上并发合同。

**通过标准：**B4 Studio 聚焦和相关 UI 测试全部通过，`npm run typecheck` 通过；修正 treatment artifact 断言的同时修正 actions 断言。

**Non-goals：**重做 C2 报价/追加/暂停产品，修改 B5 返工策略。

### 步骤 6：串行验收并重新生成资料包

**允许修改模块：**测试及审计记录；产品修改只能回到上述对应步骤。

**实施合同：**记录实际 source snapshot、命令、退出码、调用计数、crash barrier、正式 artifact closure。跨批组合测试中的已知 B5/C1/C2 失败单列，不能要求本批顺手修完，也不能用其存在掩盖新增 B4 回归。

**通过标准：**B4 门禁全部满足；未跑过的行为继续标 `UNVERIFIED`。

**Non-goals：**提交、推送、部署、真实付费验证。

## 7. 验证矩阵

### 行为断言

| 编号                              | 必须使用的层级                                                                  | 必须建立的证据                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **V1 无图库/有图库拓扑**                | 真实 `ProductionPipeline + WorkflowRunner + FileRunStore`，外部 transports 替身 | 无图库 treatment/script/director/compile 各一次，search/rank 零次；图库 search/rank 正常消费真实报告。没有外层旧规划节点执行，没有失败后 legacy fallback；planning 期间媒体 create 为零。 |
| **V2 真实角色 payload**             | 真实角色适配器及原有 producer/auditor，recording Broker transport                   | 实际请求包含适用的 treatment、承诺、grammar、issues；不只检查注入 port 的参数或源码字符串。                                                                                |
| **V3 rank intent 改变**           | 真实 rank adapter + durable role checkpoint                                | query/provider/candidate IDs 不变，action/真实性要求改变：不重搜；rank 看见新意图且请求身份变化。完全未变的对照组不重排。                                                           |
| **V4 执行合同身份**                   | 真实 graph/store/runner                                                    | 分别改变 provider、model、相关 prompt/schema/rule 和 ranker identity；仅保留兼容阶段。ranker-only 变化不能沿用 completed graph 的旧 rank。                             |
| **V5 正式 artifact closure**      | 真实发布与 quote/worker 前置检查                                                  | treatment/script/director/candidates/rank 引用唯一解析到当前适用正式产物，SHA、受控路径、父关系正确；缺引用、旧版本、跨 run 或重复 ID 在报价/执行前拒绝。                                    |
| **V6 两处进程 crash recovery**      | 子进程 + 真实 SQLite/FileRunStore                                             | 父进程等待确定性 barrier 后终止子进程，不能用 throw 代替。覆盖图完成未接受、run 接受后未结束标记，并覆盖 prepared/部分写入。新进程恢复无重复角色和正式 artifact。                                        |
| **V7 seed/provenance crash**    | 真实 SQLite seed + 新进程恢复                                                   | fallback B 产物播种成功、history 未写时终止；恢复仍保留 B 的执行来源及兼容身份，不重跑 retained treatment。                                                                  |
| **V8 双客户端编辑**                   | 真实 HTTP/service/pipeline/store                                           | A、B 都读 R；A 成功后 B 用 R 提交返回 409。另加两请求都通过服务预检查的 barrier。持有真实 lease 时两类编辑均不产生覆盖，不以改 `run.status` 代替锁测试。                                         |
| **V9 历史 resume / 新 derivative** | 真实创建/恢复入口                                                                | 支持继续的历史 executable-plan run 保持旧拓扑；pre-A 不支持继续者仍只读/核账；新 derivative 为 joint，来源 run 不变且不继承付费许可。                                                |
| **V10 DTO 与 A 回归**              | 真实详情读取及实际离线 worker 消费                                                    | 旧 artifact 不覆盖活动 cursor；发布失败不全绿。公开 report 与 private inventory 不同且后者被真实消费；复用根、`assetKey`、`sourceInFrame`、帧连续性保持。声音时长修订后仍满足正式引用闭包。            |

V6/V7 的恢复应使用真实 lease 过期/所有权恢复机制；不能手工删锁、关闭 CAS 或切换 MemorySaver 来让测试通过。

### 精确命令

以下命令供仓库执行者运行，本次没有执行。`production-planning-publication.test.ts` 是步骤 4 **建议新增**的进程恢复测试文件，不是声称附件里已有该文件。

```bash
cd /Users/jinkun.wang/work_space/veidofactory

# 基线：只读，不执行任何工作树清理
git rev-parse HEAD
git status --short
git diff --stat
git ls-files --others --exclude-standard

npm run build:pipeline

# 图、合同与 A 编译回归
node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/creative-planning-store.test.ts \
  packages/production-pipeline/test/creative-planning.test.ts \
  packages/production-pipeline/test/creative-treatment.test.ts \
  packages/production-pipeline/test/contracts.test.ts \
  packages/production-pipeline/test/executable-production-plan.test.ts

# B4 集成、真实发布恢复与既有运行器/存储
node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/production-planning-closure.test.ts \
  packages/production-pipeline/test/production-planning-publication.test.ts \
  packages/production-pipeline/test/production-pipeline-reference-grammar.test.ts \
  packages/production-pipeline/test/production-pipeline-preflight.test.ts \
  packages/production-pipeline/test/run-store.test.ts \
  packages/workflow-core/test/workflow-runner.test.ts

# B4 Studio 合同
node --test --test-concurrency=1 --import tsx \
  apps/studio/test/production-planning-editing.test.ts \
  apps/studio/test/production-planning-stages.test.ts \
  apps/studio/test/api-contract.test.ts

# 客户端请求构造、草稿版本与正式产物展示
node --test --test-concurrency=1 --import tsx \
  apps/studio/test/node-workspace.test.tsx \
  apps/studio/test/client.test.tsx

npm run typecheck
git diff --check
```

共享路径兼容扫描另行记录：

```bash
node --test --test-concurrency=1 --import tsx \
  packages/production-pipeline/test/production-pipeline.test.ts \
  apps/studio/test/server.test.ts \
  apps/studio/test/studio-service.test.ts
```

**验收不能只记录 pass 数。**必须同时记录 V1–V10 对应的实际请求、角色调用计数、被消费的 inventory 身份、终止/恢复位置、409 后零变更证据，以及当前 output version 的引用集合。共享扫描中已知跨批失败应保留 disposition；新增 B4 回归必须阻断，不能通过删断言或扩大本批范围处理。

## 8. 资料包建议

执行者必须读取以下**当前完整文件**，再落实上述方案：

| 文件组                    | 必读内容                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **宿主与持久化**             | 完整 `production-pipeline.ts`、`run-store.ts`、`workflow-runner.ts`，及 `WorkflowContext`、`ArtifactDraft`、`NodeExecutionResult`、input/output version 的定义。重点读 `dispatch`、两个编辑方法、持锁 transition、异常 checkpoint、批量 artifact 接受和 `applyNodeRevision`。 |
| **规划与身份**              | `creative-planning.ts`、`creative-planning-store.ts`、`executable-production-plan.ts`、`executable-timeline.ts`、`role-agent-checkpoint.ts`、`role-agent-loop.ts`、`fallback-role-agents.ts`。                                                   |
| **真实 producer/ranker** | `codex-creative-treatment.ts`、`codex-screenwriter.ts`、`visual-director.ts`、`codex-visual-director.ts`、`asset-semantic-ranker.ts`、`codex-chat.ts`、当前 Broker `task-definitions.ts` 及两种 executor。必须核对最终发送的 prompt/schema/input，不只读 port 类型。  |
| **素材消费**               | `python-worker-client.ts`、Python worker 路由、`stock_assets.py` 中候选搜索与 inventory 物化函数、相关媒体 worker。`generative-asset-worker.ts` 只核对 B4 输入/复用/付费边界，不扩展 B5/C1。                                                                                  |
| **Studio 纵向链**         | 完整 `app.ts`、`studio-service.ts`、`production-studio.ts`、`shared/api.ts`、客户端 API、`NodeWorkspace.tsx`、`PlanningStagesPanel.tsx` 和执行配置编辑器。                                                                                                    |
| **验收源码**               | 当前 closure、reference grammar、store、runner、editing、stages、client/node-workspace 测试，以及新增 publication 子进程测试。当前包只提供了其中一部分。                                                                                                                    |

`TECHNICAL_DECISIONS.md` 和 B 计划用于确定设计约束；旧 Oracle F1–F10 用于历史追踪；旧 `JOURNAL.md`、旧 ACCEPTED、旧测试数量不能用于证明本次完成度。`CURRENT_STATE.md` 是提供的本次测试快照，也不能代替缺失的完整源码。

资料包首页应把**源码已证、提供的测试结果、仍待执行的验证**分列，尤其不能把 F2/F8 的具体修复扩大成 B4 已验收。以上是审计与执行建议，不构成修改、付费调用或部署授权。

## 9. 执行建议

```yaml
codex_execution_advice:
  implementation_plan:
    - "读取当前完整 pipeline、runner、store、Studio、角色适配器和 worker 消费代码，记录 dirty-tree 基线；保留全部现有修改，核对本报告中标为 UNVERIFIED 的调用链。"
    - "先补真实双客户端和持锁竞争测试，再将 caller expectedRunRevision/expectedVersionId 贯穿 HTTP、service 与 pipeline 持锁变更点；分离表单草稿和 wire DTO，禁止旧草稿自动升级基准版本。"
    - "统一 treatment/script/director/rank 的真实请求投影与兼容身份；传递已有共享创作上下文，将 ranker producer/model/contract 纳入恢复判断，并修复 treatment 把 modelId 写入 providerId 的问题。"
    - "更新当前排序语义而非只追加 artifact IDs；独立保留 private inventory，验证真实离线物化消费；将 joint/legacy 输出选择收敛到唯一 planningOutputs 投影。"
    - "以既有 lease/CAS 和 run 保存边界原子接受 registry、当前规划 output version 与 commit identity；区分 prepared 与 accepted，覆盖部分准备状态，并在报价和执行前验证正式引用闭包。"
    - "修复 planning-stage DTO 的活动、失败和发布状态优先级；同步 treatment 正式 artifact/actions、客户端类型和相关 fixtures，不删除正确并发字段或正式产物。"
    - "串行执行 B4 聚焦、进程恢复、客户端及类型门禁；逐项记录 V1-V10 行为证据，单列已有跨批失败后再形成新的 B4 验收结论。"
  non_goals:
    - "不 reset、stash、checkout、clean，不覆盖或丢弃累计未提交实现。"
    - "不重写整个 production-pipeline.ts，不引入第二工作流、Redis、微服务或新业务数据库。"
    - "不设计 B5 制作返工策略，不重做 C1/C2 授权产品，不推进 C3-C6。"
    - "不为历史恢复放松媒体复用、未知付费结果、lease、CAS 或授权安全。"
    - "不在 planning graph 内新增媒体 create，不生成说明卡伪装素材成功，不按题材、镜头、runId 或模型写生产特判。"
    - "不读取密钥，不调用真实付费 Provider，不 commit、push 或 deploy。"
  optional_subagents: []
  verification:
    - "npm run build:pipeline、B4 图/合同/closure/Studio/UI 聚焦、npm run typecheck 和 git diff --check 通过。"
    - "真实 service/store/runner 下，顺序 stale、预检查后竞争和实际 lease 占用均拒绝过期修改，且拒绝后无状态变更。"
    - "真实子进程覆盖图完成未接受、run 接受未结束标记及 seed-history 窗口；恢复不重复已完成角色和正式 artifact。"
    - "无图库不调用 search/rank；图库真实请求消费当前意图，ranker identity 改变不复用旧排序。"
    - "公开 report 与 private inventory 分离，真实离线 worker 消费 inventory，选用候选与实际物化一致。"
    - "正式 executable 内部引用唯一解析到当前适用 registry/output version；篡改、跨 run、旧版或缺失引用在报价/执行前失败。"
    - "历史受支持 run 按原拓扑恢复，新 derivative 使用 joint-v1，来源 run 及其付费许可不被迁移或继承。"
    - "重跑保留旧 artifact 时显示当前活动，正式发布失败不显示全部完成；未知实际模型来源不以配置值伪造。"
    - "共享扫描中的已有 B5/C1/C2 失败单列；新增 B4 回归阻断，不以删断言或扩大施工范围换取绿测。"
```
