# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6aa383be-3700-83ed-b2eb-4c7e1666cad6

## Prompt

# VideoFactory 恢复审计：B5（Batch 2/4）

你是独立的架构与实现审计者。你只负责分析、规划、审计和执行建议，不修改文件、不调用付费 Provider、不部署。当前主 Codex 会核对你的结论并整理成供 Claude Code + GLM 5.3 Flash 执行的资料包。你可以在内部做并行的多视角分析，但最终必须输出一份统一结论。

## 项目与基线

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 工作树含累计未提交 A/B/C 修改：86 tracked + 22 untracked，tracked diff 约 `+13248/-692`。
- A 已由用户确认；B4 当前仍在恢复审计，不得假定已经 ACCEPTED。请明确区分 B5 自身问题与 B4 前置缺口。
- 旧资料和旧 `JOURNAL.md` 是历史设计/记录，不是当前完成证明。
- 本轮不改源码、不 commit/push/deploy、不读取密钥、不调用真实 Provider。

## Batch 边界

Batch: 2/4

本批范围仅为 B5：制作失败、审片建议和用户返工如何回到正确环节，并最小化重做范围，包括：

1. findings/用户反馈到 script/director/source/voice/edit/review/user 的结构化所有权和实际 payload 传递。
2. 未物化、已物化待审、真实不合格、证据不足四种状态的行为。
3. 局部返工的依赖闭包、固定点、reference-derived master、多级引用、SHA/来源证明和跨 run 合法继承。
4. script/director/voice/media/review 各类修改应重跑什么、必须保留什么，以及素材 preflight/render/technical review/双审的顺序。
5. 用户 note-only 或无法定位的反馈不得静默扩大成全片，也不得变成空范围后悄悄无事发生。
6. 双审分支的真实 reviewer identity、同 snapshot 独立性、失败分支补审、缓存键和容量边界。
7. 无新增媒体费用的合法返工可自动继续；涉及媒体 create 只标记为需要 C1 决策，本批不能自行授权。

排除范围：

- 不修 B4 的核心接入，只标出它如何阻断 B5。
- 不设计 C1/C2 的金额、授权 UI 或 funding request。
- 不审 C3-C6、部署或真实付费 E2E。
- 不新增第三审片模型、第三份返工判决或按具体题材/镜头特判。

## 当前确定性证据

- B5 聚焦：159 tests，156 pass，3 fail。
- 失败分别为：
  - `carries an unaffected multi-level reference chain across runs with one new paid call`：actual 4，expected 5；
  - `regenerates the full human-approved reference dependency closure`：actual 4，expected 7；
  - `refuses to inherit a reference-derived master whose reference SHA cannot be proven`：actual 6，expected 7。
- 失败集中在跨 run 媒体继承、引用依赖闭包和 reference SHA 证明边界。
- Studio 还有一项语义冲突：note-only 用户拒绝当前得到空返工范围，旧测试期待全片 `[1,2,3,4]`。最新产品原则是不因无法定位自动扩大到全片，但也不能吞掉反馈；请给出通用状态/交互合同，而不是为该 fixture 特判。
- `npm run typecheck` 目前失败，但主要是 B4/C2 跨层 DTO/fixture 不同步；请只把真正属于 B5 的类型缺口计入本批。

附件中的旧 B5 Oracle transcript 是历史 finding。当前源码此后被修改，请对旧 F1-F9 逐项给 `RESOLVED`、`PARTIAL`、`OPEN` 或 `OBSOLETE`，引用当前证据，不直接复制旧 verdict。

## 不可破坏规则

- 局部返工不能扩大成全片；依赖闭包必须完整到足以保证引用合法和成片一致。
- 可继承的是经 SHA、来源、实际输入和当前质量合同证明仍适用的 artifact，不是“文件存在就复用”。
- 改素材后必须经过相应 preflight、render、technical review 和同证据双审；只改声音不能买素材；仅补缺失审片分支不能重渲染。
- 证据不足先补查已有媒体，不能直接列购买清单。
- 两个审片模型必须互不可见、读取同一 snapshot、记录实际 provider/model；单分支失败可有界补审，但不能拿旧报告批准新视频。
- 找不到明确影响范围时，应要求用户选择/澄清或生成可操作的停顿状态，而不是自动全片或空操作。
- 不能用说明卡填补失败素材。

## 要求输出

用中文输出，代码标识符保留原文，并严格按下列结构：

1. `ACCEPTED` 或 `CHANGES_REQUIRED`。
2. B5 合同点完成矩阵：`PROVEN/PARTIAL/CONTRADICTED/UNVERIFIED`。
3. 旧 F1-F9 复核表：`RESOLVED/PARTIAL/OPEN/OBSOLETE`，含当前位置、剩余场景和阻断级别。
4. 当前新增 P0/P1/P2 findings；合并同根因，不为三个失败断言各写一个 case 补丁。
5. 一张通用的返工影响矩阵：用户/审片输入类型 → target owner → invalidated stages → reusable evidence → 是否允许新媒体调用 → 用户可见动作。
6. 对三项失败测试判断：实现 bug、测试过时或二者皆有；给合同层答案，禁止用调整 expected 数字掩盖错误。
7. 适合 Claude Code + GLM 5.3 Flash 的 B5 单阶段执行计划：允许文件、non-goals、失败测试、最小实现顺序、通过标准。
8. 精确验证矩阵：多级 reference、缺 SHA、全依赖闭包、note-only/无法定位、四媒体状态、voice-only、review-only、review identity collision、局部修改后的完整复验顺序。
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

Oracle 只提供建议，不授权实现、付费或部署；证据不足写 `UNVERIFIED`。

## Answer

CHANGES_REQUIRED

**B5 自身仍存在阻断，不能把当前失败全部归因于 B4。** 主要问题是：引用母片的继承证明在转存时丢失、复用资格与实际执行采用不同判据、无法定位的反馈没有形成可操作的停顿状态，以及新 run 的局部返工仍重新执行未受影响的规划角色。

本轮依据为当前十份附件；完整 `generative-asset-worker.ts`、`codex-visual-review.ts` 与对应 diff 的重叠部分一致。我进行了源码提取后的**内存隔离探针**，没有重跑完整仓库测试。`159 tests / 156 pass / 3 fail` 是附件提供的基线，不是本轮重新取得的结果。三项失败用例的完整正文未包含在附件中，因此其具体断言归因必须保留 `UNVERIFIED`。

## 2. B5 合同点完成矩阵

`PROVEN` 仅表示表中明确指出的源码或隔离验证边界成立，不表示完整产品链路已经验收。

| 合同点                                      | 状态               | 当前证据与边界                                                                                                                |
| ---------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 新产生的规划问题进入 script/director 实际调用 payload  | **PROVEN**       | `planningContext.issues` 已进入 `requestBrief`、`producerBrief`，并传给 `provider.run`；不再只是 checkpoint 输入。更下游模型适配器的最终请求仍需回归测试。 |
| source、voice、edit、review、user 的统一责任与动作合同 | **PARTIAL**      | 规划图已有 `needs_source`、`needs_user`；但返工 findings 的目标白名单仍只有 script、visual-direction、assets，不能据此证明其他责任的完整闭环。               |
| 无法定位的用户反馈既不扩大、也不丢失                       | **CONTRADICTED** | Studio 不再默认全片，但会跳过未定位问题；core 对缺失 scope 或未定位视觉 finding 仍采用全片语义。                                                         |
| 未物化媒体的恢复                                 | **PARTIAL**      | 存在原任务恢复及未知结果阻断；未证明所有 joint 返工入口都先区分“未调用、已受理、结果未知”，再决定后续动作。                                                             |
| 已物化、待审媒体不重新购买                            | **PARTIAL**      | 已选中的 materialized item 会绕过 create，校验并进入 pilot review；但其进入复用集合的资格判断仍有缺陷。                                                |
| 真实不合格媒体进入正确返工责任                          | **PARTIAL**      | 明确的 assets finding 会排除对应旧媒体；用户重生成意图、依赖后代失效与“只需重新验证”尚未形成统一执行语义。                                                         |
| 证据不足先补查已有媒体                              | **PARTIAL**      | `inspect_existing_media` 被排除出视觉替换范围；但引用证明缺失的继承路径仍直接按“新生成报价”处理，未证明存在先补证的统一停顿状态。                                         |
| old/new reference、显式 REUSE 联合固定点         | **PROVEN**       | 当前算法已循环处理所有 shot sets，并读取显式 `reuseFromScenePosition`；隔离探针得到跨集合闭包 `[1,2,3]`。这不等于闭包已正确支配实际媒体失效。                          |
| 多级 reference 跨 run 合法继承                  | **CONTRADICTED** | 资格检查支持多级链，但继承落入新 ledger 时丢失已绑定的 reference SHA 和请求身份，见 N1。                                                              |
| 局部返工保留无关规划角色                             | **CONTRADICTED** | 新 joint run 只从自己的 history 播种；现有测试还明确期待重新调用 treatment、script。                                                           |
| 素材修改后的完整复验顺序                             | **PARTIAL**      | `dispatchSceneRevision` 已加入 `asset-source-review` 失效；还缺当前 joint 路径的完整事件顺序和有效版本证据。                                      |
| 两个实际 reviewer identity 不同                | **PROVEN**       | 汇总前检查实际 provider/model 去重，碰撞会拒绝；不代表碰撞后的恢复已经正确。                                                                         |
| 同一不可变 snapshot、失败分支补审、缓存边界               | **PARTIAL**      | 普通分支缓存存在；共享可变媒体对象、分支实际 snapshot 未核对，以及内外两层缓存失效不一致仍未闭合，见 N4、N5。                                                         |
| findings 容量跨层一致                          | **CONTRADICTED** | 当前聚合 validator 限制 50，两个合法分支可合并出 51 条以上；返工 parser 改为 100 并未解决此问题。                                                       |
| 无新媒体费用可继续；create 交 C1 决策                 | **PARTIAL**      | worker 仍有正额度检查，未发现本轮探针绕过它；但错误复用资格可能使“无需新媒体”的前置判断不可靠。                                                                   |
| 失败不降级为说明卡                                | **PARTIAL**      | 当前检查到的复用路径明确禁止把 editorial card 当 footage；完整失败路径的负向覆盖仍需保留。                                                              |

### B4 前置缺口：单列，不计为 B5 自身修复成果

当前 joint 拓扑已经移除外层 `script`、`visual-direction`、`production-preflight`，但 source review 与 final review 的 `reviewScope.sourceNodeIds` 仍可写入这些旧节点名。**这是 B4 接入遗留对 B5 证据新鲜度、补审与来源说明的直接影响**，应交回 B4 核对，不能在 B5 中用额外映射或旧节点回退掩盖。

同样，阶段编辑的 revision/version DTO、调用链与 fixture 同步属于 B4/C2 已报告问题；本轮没有足够证据新增一个“B5 编译错误”结论。不能把全仓 typecheck 失败全部算入 B5，也不能声称全仓已通过。

## 3. 旧 F1–F9 复核表

下表按**当前函数位置与当前证据**复核，不沿用旧 transcript 的完成或阻断结论。

| 旧 finding                                    | 复核           | 当前位置与已经改变的行为                                                                                                                              | 剩余场景与阻断级别                                                                                                   |
| -------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **F1：voice timing 指向不存在的旧节点**                | **RESOLVED** | `ProductionPipeline.requestVoiceTimingRevision` 已按拓扑选择 `creative-planning` / `production-preflight`，并检查对应有效 plan artifact。                | 原“找错节点”问题关闭；新版本是否保留 joint 节点其他有效 artifacts，见 **N3，UNVERIFIED 待核 P1**。不能据原问题关闭推导整个 voice 恢复链通过。              |
| **F2：reuse 跳过 preflight、覆盖目标 cut 字段**        | **RESOLVED** | `dispatchSceneRevision` 已失效 `asset-source-review`；`reviseAssetPlanByReuse` 已保留目标 `duration_frames`、`source_in_frame`、`asset_key`、`crop`。  | 原两个缺陷关闭；必须补“媒体覆盖校验→render→technical→双审”的 joint 集成回归。该完整链目前 **UNVERIFIED**。                                  |
| **F3：新 joint 返工重跑无关规划角色**                    | **OPEN**     | `creativePlanningNode` 仍使用当前 run 的 history；`seedJointPlanningThread` 的前驱来自该 history，而不是经验证的 `rework.sourceRunId`。                         | 仅媒体/证据返工仍可能重新调用 treatment、script；已有测试明确接受这种行为。**P1**。                                                       |
| **F4：媒体复用依赖整计划身份和宽泛范围**                      | **PARTIAL**  | `createPaidAssetOperationItem` 的 fingerprint 已改为 scene + resolved request；但 `isMatchingReferencedPaidItem` 仍要求整文件 `sourceFingerprint` 相同。 | 同 run 的 reference 媒体仍会因无关文件变化拒绝复用；另一方向又出现过宽继承资格，见 N2。**P1**。                                                |
| **F5：用户反馈扩大全片或丢失**                           | **PARTIAL**  | Studio 已删除默认全片，并独立合并可识别的用户镜号；未定位内容仍被跳过，core 仍保留全片默认语义。                                                                                    | note-only、越界镜号、voice-only 无法通过一个明确的责任/范围状态继续。**P1**。                                                        |
| **F6：缺显式 REUSE 边、跨 old/new 不到固定点**           | **RESOLVED** | `reworkSceneDependencyClosure`、`shotDependencyPosition` 已同时修复这两个算法缺陷；隔离探针通过。                                                              | 实际哪些母片失效、哪些后代只重验，仍由 N1/N2 覆盖；不能把三项失败测试简单归结为“闭包函数还少遍历一次”。                                                    |
| **F7：新 planning issues 未进 producer payload** | **RESOLVED** | script/director 的实际 brief 已含 `planningIssues`，随后传给 `provider.run`。                                                                        | 当前附件未覆盖所有下游模型适配器最终 payload/schema；补 adapter 捕获测试。原“仅写 checkpoint”缺陷已关闭。                                     |
| **F8：实际 reviewer 碰撞永久重放缓存**                  | **PARTIAL**  | 第二分支的独立结果缓存已改写为 collision tombstone。                                                                                                      | 内层 role checkpoint、request identity 没有同步失效证据；兼容持久化替身仍复现重复碰撞。真实 `runRoleAgentLoop` 恢复路径须补测，见 N5。**P1 剩余风险**。 |
| **F9：合法双审报告超过返工容量**                          | **PARTIAL**  | 返工 findings 上限已从 50 改为 100；但当前聚合 validator 又限制为 50，阻断前移。                                                                                  | 两个合法分支合计 51 条就失败；多来源 findings 的总容量也未统一。**P2**，见 N6。                                                         |

## 4. 当前新增或新暴露的 findings

F3、F5 的未闭合问题已在上表保留，不重复编号。以下按根因归并，不为三个调用次数断言分别设计补丁。

### N1 — P1：跨 run 继承成功后，丢失 reference-derived 母片的已执行输入证明

**位置：** `generative-asset-worker.ts::preparePaidAssetOperation`，尤其 `carriedBase`；后续 `runDirectorRoutes` 的 reference binding 分支。

选中跨 run 候选后，代码使用新准备的 `item` 作为基础，而不是保留或重新绑定候选已经证明的 reference identity。新 `item` 的 reference SHA 尚未解析；它却被写为 `materialized`。后续执行又因为已经物化而跳过 reference binding。

**隔离探针结果：** 对 `1 → 2 → 3` 多级引用链，2、3 成功继承且状态为 `materialized`，但新条目的 `referenceImageSha256` 均消失，resolved input fingerprint 也不再保持原身份；再将该 run 作为来源，安全继承检查只认可根素材 1。

**修复方向：** 跨 run 转存必须保留已经核验的实际输入身份，包括 reference SHA、resolved execution digest、来源条目与来源 run/version；当前 run 的操作身份可以变化，但不能把“已执行请求的内容身份”退回未解析状态。不能只在本次返回结果中补字段而遗漏持久化 ledger。

---

### N2 — P1：复用资格、请求匹配与失效范围没有使用同一份判定

**位置：** `findReworkCarryForwardItems`、`safelyCarriableReworkItems`、`isMatchingReworkCarryForwardItem`、`isMatchingReferencedPaidItem`、`paidExecutionParametersMatch`；以及 `WorkerProvider.quoteSpend` 的继承检查调用。

当前存在三种相反方向的问题：

* `safelyCarriableReworkItems` 对独立母片主要检查镜号与模型，对当前实际生成请求的完整匹配留到后面；报价路径已经读取其返回的 carried scene 集合。
* 缺少旧 `executionDigest` / `compiledPromptSha256` 时，兼容比较仍可能接受不同 prompt；代码注释依赖的旧脚本/来源语义约束，并未在当前跨 run matcher 中完整体现。
* 同 run reference matcher 仍以整文件 `sourceFingerprint` 相等为条件，实际媒体输入没变也可能拒绝复用。

**隔离探针结果：** 改变独立镜头的实际 prompt 后，前置继承检查仍将其列为候选，最终 worker 匹配才拒绝；删除旧 digest/prompt 摘要后，不同 prompt 被 matcher 接受；另一个 reference 场景则出现“normalized parameters 相同，但整文件变动导致不复用”。

此外，当前候选排除主要依据明确的 assets finding，**不能单凭 `affectedScenePositions` 区分“用户明确要求重生成”与“只需重验/改剪辑”**。恢复旧的“scope 内全部禁止复用”同样是错误修复。

**修复方向：** 让前置检查和执行消费同一套逐母片判定，明确区分：

`可复用且证明完整`、`可保留字节但需要补审`、`缺少来源/输入证明`、`明确失效或要求重生成`。

实际 create 集合必须从这些结果推导，而不是从镜号数组直接推导。当前探针证明了判据失配，**没有证明最终报价金额错误或发生越权扣费**。

---

### N3 — 待核 P1，`UNVERIFIED`：voice timing 修订是否丢失 joint 节点的其他有效 artifacts

**位置：** `ProductionPipeline.requestVoiceTimingRevision`。

该方法现在正确定位 joint plan，但提交新版本时只提供新的 executable-plan artifact，并设置 `retainedArtifactIds: []`，同时保留其他 planning output 路径。Studio 返工读取则依赖有效节点 artifact。

**风险场景：** 一次局部时长调整后，节点 output 仍含 script/director 路径，但新有效版本不再包含它们的 artifact membership，导致后续返工读取、来源验证或打包失败。

当前附件没有完整的 `WorkflowRunner.applyNodeRevision` 实现，**不能断言上述最终效果已经发生**。此项不计为已复现缺陷，但必须用当前 runner 的真实版本行为核实。

**修复方向：** 增加有效版本成员断言；若确实丢失，只保留经验证仍有效的 sibling artifacts，替换 plan 并失效真正依赖它的证据，不能通过全局旧 artifact 查找绕过有效版本合同。

---

### N4 — P1：双审没有强制两分支消费同一个不可变的最终证据 envelope

**位置：** `IndependentDualVisualReviewAgent.reviewDetailed`、`CodexVisualReviewAgent.preparePayload`。

双审向两分支传入同一个可变 `preparedMedia` 对象；分支内又分别读取和组装当前上下文。汇总只验证报告内容，没有比较每个 execution 返回的 `evidenceSnapshotId` 与共同 snapshot。

**隔离探针结果：** 第一分支改写共享上下文，第二分支看到改写后的内容；两分支分别返回不同 snapshot identity，汇总仍返回 `approve`。这是 adapter 边界反例，不是对真实 Provider 已发生污染的断言。

**修复方向：** 先组装完整、带当前质量合同与来源身份的 snapshot，再给两分支独立副本或不可变投影；汇总前核验分支实际消费的 snapshot 身份。每个模型仍只能看到共同证据和自己的角色审计材料，不能看到另一份结论。

---

### N5 — P1 剩余风险：identity collision 只失效外层结果，没有证明内层完成态也能恢复

**位置：** `IndependentDualVisualReviewAgent.reviewDetailed` 的 collision tombstone，以及传入的 `agentLoopCheckpointForModel`。

第二分支的结果缓存已清除，但其 role checkpoint 仍使用相同模型键，request identity 也没有针对 identity collision 的恢复变化。

**隔离探针结果：** 使用当前外层实现和“完成态会被复用”的内层 checkpoint 替身，第二次调用时分支调用次数为 `[1,2]`，实际 producer 次数仍为 `[1,1]`，继续重复 identity collision。**真实 role-loop 的同场景恢复仍为 `UNVERIFIED`，必须补集成回归。**

**修复方向：** 只对冲突分支贯通失效结果缓存、角色完成态和执行身份，并沿用持久化的有限重试计数；保留第一份合法同证据报告。既有两个分支配置无法恢复独立性时停顿，不能引入第三审片模型，也不能不断重置次数重试。

---

### N6 — P2：容量修复使合法双审报告在更前面的边界失败

**位置：** `codex-visual-review.ts::validateAggregatedVisualReviewReport`，当前第 885 行传入上限 `50`。

两个分支各允许 50 条，`mergeIndependentVisualReviews` 保留去重后的并集；聚合 validator 却仍只接收 50。

**隔离探针结果：** 26 条与 25 条互不重复的报告分别通过单分支验证，合并后被拒绝。

**修复方向：** 统一单分支、双审汇总、rework parser 和多来源合并的容量合同。超出单次执行容量时，保留原报告及未处理问题引用，返回明确的分批处理状态；不能截断问题，也不能仅把某一处上限继续加大。

---

### N7 — P2：joint 返工影响摘要把实际 script 执行显示为零

**位置：** `production-pipeline.ts::summarizeReworkImpact`。

脚本调用计数只读取 `nodeId === "script"` 的 receipt，节点列表也只有旧 `script`、`visual-direction`，没有 joint 阶段投影。

**隔离探针结果：** 输入包含一次 `creative-planning` 的 script producer receipt，输出仍为 `scriptModel: 0`、script `not_run`。

**修复方向：** 从实际阶段执行记录和可核对的 request identity 投影调用次数、继承状态；没有足够记录时显示未知，而不是零。不能使用这份摘要验收“未重跑编剧”，也不能用 provenance 文案前缀代替继承证明。

## 5. 通用返工影响矩阵与停顿合同

以下是**建议收敛的合同**，不是当前已实现能力。应扩展现有 rework 记录及其投影，不新增第三份返工判决。

首先分开三个概念：

**用户选择的范围**是意图边界；**依赖闭包**是必须重新判断适用性的范围；**新媒体 create 集合**是证明失效或明确重生成意图导出的母片集合。三者不能共用一个 `affectedScenePositions` 数组替代。

在现有返工上下文中，应保留反馈原文、来源 finding/用户反馈身份、target owner、action、范围是否已解析、源 run revision，以及所依据的 evidence/质量合同身份。建议将范围未解决表示为明确的 `needs_scope`，而不是 `[]`；已解析的 voice-only 或 review-only 则可以有空媒体范围，但必须有非空的 voice/review 动作。

下表中，**完整成片复验**指 `render → technical-review → 同 snapshot 双审 → 人工终审`；需要素材复验时，`asset-source-review` 必须在 render 之前完成。

| 用户/审片输入类型                    | Target owner                  | Invalidated stages / 必须执行                                         | Reusable evidence            | 是否允许新媒体调用                           | 用户可见动作                      |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------- | ---------------------------- | ----------------------------------- | --------------------------- |
| 脚本事实、叙事或画面语义修改               | `script`                      | 受影响 script；按真实输入变化失效 director、候选/排序、compile、voice；随后相关素材复验及完整成片复验 | 未受影响稿件片段、素材、来源证据；媒体是否适用逐项判断  | B5 不授权；确需 create 标记交 C1             | 展示修改内容及依赖影响，确认超出原范围的变化      |
| 仅旁白文字/标点修改，画面意图不变            | `script` / `voice`            | 必要的文字修订、voice、字幕/时间线及完整成片复验                                       | 原媒体和未变导演证据                   | **禁止因文字文件变化购买素材**                   | 显示“画面保留，配音/字幕更新”            |
| 镜头设计、构图、动作要求或素材路由修改          | `director`                    | 局部 director；必要的候选/排序与 compile；相关素材复验及完整成片复验                       | script、未变候选/媒体及其来源证明         | 仅将实际新增母片交 C1                        | 展示需修改与可保留的镜头及原因             |
| 真实媒体不合格，方案本身可执行              | `media/assets`                | 被拒 artifact 失效；reference/REUSE 消费者闭包重判；素材复验及完整成片复验                | 未受影响母片、script、voice 等        | 需要 create 时交 C1；同 prompt 不等于可复用被拒结果 | 明确“替换哪项媒体、影响哪些消费者”          |
| 来源、许可或画面证据不足                 | `source` / `review`           | 先补来源记录、已有媒体检查或抽帧；依据结果决定后续失效                                       | 已有媒体字节、任务结果及可核验来源            | **补证阶段不得直接生成购买清单**                  | “补查已有素材 / 补充来源 / 选择替代方案”    |
| 已物化但待审                       | `review`                      | pilot/source review；通过后继续后续流程                                     | 已验证 SHA 的媒体                  | 不允许重新 create 同一媒体                   | “继续检查已有画面”                  |
| 未物化，已有已受理或未知结果的任务            | `media/assets`                | 恢复/查询原 task、下载、物化、补审                                              | 原 task identity、ledger、已成功条目 | 未核清前禁止新 create；确认需要新任务后交 C1         | “继续获取原任务 / 核对结果”            |
| 只改音色、语速、混音                   | `voice`                       | voice、必要时间线重算及完整成片复验                                              | script 语义、导演方案和全部有效媒体        | **此动作不允许买素材**                       | 显示声音修改；画面时长不足时明确停顿          |
| 延长 cut、改 source range、复用已有母片 | `edit` / `director`           | compile/绑定与覆盖校验；必要素材复验；完整成片复验                                     | 已有母片、可继续使用的自然语音和未变质量证据       | 现有范围不够时停顿；不能偷偷转为 create             | 展示可覆盖区间及冲突，要求选择可执行调整        |
| 编码、容器、拼接等技术失败                | `render` / `technical review` | render 与技术复核；产生新成片后重新双审                                           | 媒体、voice、已接受计划               | 不允许因编码失败购买素材                        | “重新输出并复验”，不显示为全片创作返工        |
| 一个审片分支失败，snapshot 未变         | `review`                      | 仅失败分支及汇总/终审门禁                                                     | 同 snapshot 的另一份有效报告及成片       | 不允许；也不得重渲染                          | “补完缺失审片分支”                  |
| 补抽帧或修改审片上下文，snapshot 已变      | `review`                      | 两个分支均对新 snapshot 审片；不因抽样变化重渲染                                     | 原视频、媒体和渲染结果；旧报告仅作历史          | 不允许                                 | “补充证据后重新双审”                 |
| note-only、越界镜号、无法定位或多责任冲突    | `user`，解析后再确定具体 owner         | **暂不执行内容重做**；保留反馈并停在 `needs_scope`                                | 现有全部证据，不自动批准其继续使用            | 不允许                                 | 选择修改类型、镜头/区间，补充说明，或明确选择全片意图 |

**两个必要限制：** 依赖闭包确实覆盖全片时，可以展示完整依赖原因后重新确认；这不同于“找不到范围就默认全片”。局部修改后重新生成最终成片文件，也不等于重新创作或购买全片素材。

## 6. 三项失败测试的合同层判断

三条测试名在当前附件中只出现在 `CURRENT_STATE.md`，没有完整 fixture、前后请求、findings、ledger 或断言上下文。因此，**三条现有失败的最终归因均为 `UNVERIFIED`；不能直接签字认定“测试过时”，也不能认定只需修实现就应维持原数字。** 下表给出拿到完整用例后必须采用的裁决标准。

| 失败测试                                                                                         | 分类裁决条件                                                                                                                                                       | 必须落实的合同答案                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `carries an unaffected multi-level reference chain across runs with one new paid call`，4 / 5 | 若 fixture 确有一个新的或明确要求重生成的独立母片，未执行该项属于**实现 bug**；若只是把镜头放进 scope，而请求、质量与拒绝状态均未变化，则“必须多一次调用”的测试假设可能过时。现有 DTO 无法表达重生成意图时属于**二者皆有**。                              | 未受影响 reference 链应连同完整实际输入证明继承；新工作必须单独体现。不能为了凑 5 次破坏合法继承，也不能用旧媒体吞掉明确的重生成请求。                            |
| `regenerates the full human-approved reference dependency closure`，4 / 7                     | 若批准的是明确重生成根母片及由它失效的 reference-derived 后代，却继续复用旧结果，属于**实现 bug**；若 expected 将“闭包中的所有镜头”都计作新 create，包含 REUSE-only 消费者或仅重验项，则**测试过时**。两种语义混在一个 scope 中则**二者皆有**。 | 断言完整失效/重验闭包，以及唯一生成母片集合；REUSE 消费者必须更新绑定和复验，但不按消费者数量购买。                                                 |
| `refuses to inherit a reference-derived master whose reference SHA cannot be proven`，6 / 7   | 若缺证明条目仍被当作可继承，属于**实现 bug**；若 expected 要求连同证明完整、未受影响的上游根一起重买，则**测试过时**。具体 6/7 正误仍需 fixture。                                                                   | 先检查历史已执行请求、来源 ledger 和 artifact；不能拿当前源文件 SHA 猜填历史 reference SHA。无法证明时停在补证/决策边界，必要重生成只包含真正失效母片及其受影响后代。 |

因此，三项修复都应改为同时断言：

**操作意图、失效集合、继承集合、reference SHA、实际请求 digest、来源 run/version、逐项 create/task 次数、以及下一状态。** 总调用数只能作为其中一个结果，不能作为唯一正确性依据。

另一个可以明确分类的是 **note-only 用例：二者皆有**。旧的默认全片 expected 与最新规则冲突；当前实现仅返回空范围又没有完成待定位合同，也不能算正确。

## 7. B5 单阶段执行计划

### 允许文件与修改边界

| 范围                                                                | 允许内容                                                                                                                                                            |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/production-pipeline/src/generative-asset-worker.ts`     | 继承资格、逐母片实际输入证明、reference 转存、重生成/重验区别；不改金额授权算法                                                                                                                   |
| `packages/production-pipeline/src/contracts.ts`                   | 现有 rework 的责任、动作、范围解析状态、证据引用与容量合同                                                                                                                               |
| `packages/production-pipeline/src/production-pipeline.ts`         | B5 的来源继承、局部失效、voice timing 修订、补审与影响摘要；不重构 B4 核心拓扑                                                                                                               |
| `packages/production-pipeline/src/codex-visual-review.ts`         | 不可变证据 envelope、分支身份核验、碰撞恢复、容量一致性                                                                                                                                |
| `apps/studio/src/server/production-studio.ts`、`studio-service.ts` | 返工草稿、范围待定位状态、来源校验、动作映射                                                                                                                                          |
| 当前相关测试                                                            | `generative-asset-worker.test.ts`、`codex-visual-review.test.ts`、`contracts.test.ts`、`production-joint-rework.test.ts`、`apps/studio/test/studio-service.test.ts` |

返工状态涉及的共享 DTO 和现有返工界面组件，**由主 Codex 先定位真实文件并补入白名单**；不能让执行模型猜路径或顺带修改 planning 编辑、报价、funding 页面。

### 最小实现顺序

1. **补齐基线证据与红测。**
   读取三项失败用例完整正文，记录逐 run、逐母片的 create/task 行为；把当前 N1/N2、51 条聚合、joint 摘要错误和 unresolved scope 反例加入现有测试。保留 B4/C2 已知失败清单。

2. **先收敛动作和范围合同。**
   在现有 rework 中区分“未定位”“没有媒体工作”“重验”“明确重生成”；用户反馈与模型 finding 分别保留，再确定 owner。前后端都禁止以 `undefined` 或 `[]` 代替待定位状态。

3. **统一媒体继承判定并保全引用证明。**
   前置检查、准备与执行采用一致的实际请求判据；保留跨 run reference identity；缺证明进入补证状态；显式拒绝或重生成意图不能被相同 prompt 抵消。保留已修复的 old/new 固定点算法，不回退到 scope 内全部重买。

4. **连接最小阶段失效与来源继承。**
   在 producer 调用之前验证并继承未受影响的 treatment/script/director 证据；核实 N3 的真实 runner 行为；验证 voice-only 和已有母片复用不触发媒体 create。B4 的 effective planning projection 未成立时，记录前置阻断，不在本阶段另造读取路径。

5. **闭合双审 snapshot、恢复和容量。**
   统一最终证据 envelope；只修复失败/冲突分支；贯通内外 checkpoint 且不清零重试计数；统一合法容量并对多来源溢出给出可操作状态。

6. **最后修正 UI 投影和验收。**
   用户能看到“待定位、待补证、保留哪些、重做哪些、是否交 C1”；影响摘要读取实际阶段执行证据，不把缺失统计显示成零。

### Non-goals 与通过标准

本阶段不修 B4 核心接入、不设计 C1/C2 金额与授权 UI、不做 C3–C6、不增加第三审片模型/第三份返工判决、不建立新工作流或新基础设施，也不按测试中的题材、镜号、模型名称特判。

**B5 通过标准：** 当前聚焦测试与第 8 节新增回归全部通过；三项原失败有完整合同裁决记录；已证明 P1 关闭；N3 和真实 role-loop 碰撞恢复不再留 `UNVERIFIED`；B5 相关类型与调用方无新增错误。全仓 `npm run typecheck` 仍须执行，但 B4/C2 基线错误必须单列，不能通过放松类型、删除 fixture 或跳过测试制造绿色结果。

即使上述完成，B4 的前置合同未闭合时，也不能把它写成“B5 已具备完整生产接入证明”。

## 8. 精确验证矩阵

| ID      | 场景与构造                                                 | 必须取得的证据                                                                                                |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **V01** | old 中 `3→2`，new 中 `2→1`；另含显式 REUSE 边                  | 联合固定点包含全部消费者；改变子节点不无故失效无关上游和兄弟节点；重复计算幂等                                                                |
| **V02** | 三个连续 run；`1→2→3` 多级 reference，独立母片 4 在第二 run 明确替换     | 2、3 在每一代 ledger 中保留正确 reference SHA、resolved digest 和来源链；第二 run 只创建明确需要的母片；第三 run 无变更时不因上一次转存丢证明而重买    |
| **V03** | reference SHA 缺失、错误、对应源字节改变、源 revision 改变             | 不作为已证明继承；先补查已有记录；不能用当前 SHA 猜填历史输入；不能直接把证据不足变成自动 create                                                 |
| **V04** | 明确拒绝根母片 1；reference-derived 2、3；另有 REUSE 消费者和独立母片     | 被拒结果不能因 prompt 相同复活；闭包完整；REUSE 消费者不额外 create；未授权时 fake create 计数为 0，授权边界替身接受后只执行确切母片集合                 |
| **V05** | 媒体请求未变，但 narration 标点、另一镜头或说明文案改变                     | 独立和 reference 母片都能保持合法复用；改变实际 prompt/model/reference 后必须失效；旧账本缺请求摘要不能宽松匹配                              |
| **V06** | note-only、中文镜号未解析、越界镜号、用户反馈与模型 finding 并存             | 原文和两类来源均保留；明确 `needs_scope` 或已解析 owner；不默认全片、不空操作、不先运行模型再等待失败                                          |
| **V07** | 未物化：未提交、已受理、unknown、下载失败                              | 已受理/unknown 优先恢复同 task；不得重复 create；只有确认需要新任务且经过 C1 边界后才允许创建                                            |
| **V08** | 已物化待审、真实不合格、证据不足三类使用同一素材                              | 待审保留 SHA 并补审；真实不合格排除该结果并按责任修复；证据不足只补查，不自动进入替换清单                                                        |
| **V09** | 新 joint run 只修 media/director，script/treatment 实际输入未变 | 捕获真实端口调用：script/treatment producer 为 0；继承 artifacts、阶段输入身份、原模型 provenance 可核验                          |
| **V10** | voice-only 修改；再构造 voice 时长不足                          | media create 为 0；必要 voice/render/review 正常执行；已有媒体覆盖不足时明确停顿，不自动购买；自然语音不被截断                              |
| **V11** | joint voice timing 修订后再次读取返工草稿、有效 planning 输出与打包入口    | 新 plan 生效；仍有效的 script/director 等 artifact membership 完整；旧 plan 和旧成片审片证据不能继续批准新成片                       |
| **V12** | 局部素材替换/REUSE，目标 cut 长度、offset、asset key 与 donor 不同    | 目标执行字段保持或经明确计划修订；覆盖校验通过；事件偏序满足 **素材 preflight 完成 → render → technical-review 完成 → 两分支双审 → 终审**；无关素材不重买 |
| **V13** | 同 snapshot 的单分支调用失败                                   | 保留成功分支报告；仅失败分支补审；render、voice、media create 不增加；失败次数持久化且有限                                              |
| **V14** | 名义身份不同、实际 identity 相同；包含真实 role-loop 完成态缓存            | 首轮拒绝；修复后冲突分支必须实际执行而非仅增加 wrapper 调用；合法分支不重做；无法恢复独立性时停顿，不新增第三模型                                          |
| **V15** | 分支修改输入；分支 snapshot 不同；脚本/质量合同或抽样变化                    | 分支不可相互污染；不一致 envelope 拒绝；证据变化使旧报告失效；两分支读取同一最终 snapshot，而不是分别重读可变文件                                     |
| **V16** | 26+25、50+50 条独立 findings；再加入 source/asset findings    | 合法双审聚合可表示；超单次返工容量时保留完整原证据和未处理问题身份，返回明确状态；无静默截断                                                         |
| **V17** | joint 阶段实际执行、继承、失败、重试，以及统计记录缺失                        | 影响摘要与实际 request/receipt 对齐；没有统计证据显示未知而非 0；不能把 joint script 显示成 `not_run`                               |
| **V18** | 上述场景经 Studio parser/service/UI 往返，并带陈旧 revision       | owner、动作、scope 状态、证据身份不丢失；陈旧请求拒绝；B5 类型检查无新增错误；B4/C2 既有失败独立报告                                           |

验证应使用仓库现有测试入口，并记录实际命令、退出码、失败用例和逐项证据。构建检查包括 `npm run build:pipeline`、`npm run typecheck`、`git diff --check`；不能用本轮隔离探针替代这些仓库级结果。

## 9. Codex 执行建议

```yaml
codex_execution_advice:
  implementation_plan:
    - "先读取三项失败测试的完整 fixture、当前 runner 和测试入口；固定 B5 基线，并单列 B4/C2 前置失败。"
    - "在现有 rework 合同中区分 needs_scope、无媒体工作、重验、明确重生成；保留用户原文与 finding 来源，不新增第三份返工判决。"
    - "统一逐母片复用资格与实际请求判定，贯通前置检查、准备和执行；保留跨 run reference SHA、resolved digest 和来源链。"
    - "把依赖闭包作为重判范围，而非购买数量；明确拒绝结果不可复活，缺输入证明先补证，任何新媒体 create 只交 C1 决策。"
    - "在 producer 调用前继承已证明未受影响的 joint 规划阶段；验证 voice timing 有效 artifact membership 和局部素材修改后的完整复验顺序。"
    - "组装共同不可变审片 snapshot，核验分支实际身份；贯通冲突分支的内外缓存失效与有限重试，保留另一分支的合法同证据结果。"
    - "统一 findings 容量及溢出状态，并使返工影响摘要、共享 DTO 与现有返工界面消费真实阶段证据。"
    - "按验证矩阵关闭 B5 缺陷和待核项；B4 前置未闭合时继续标明集成证据不足，不宣告整体生产接入完成。"
  non_goals:
    - "不重构或替代 B4 核心拓扑、planningOutputs、阶段编辑及历史恢复合同。"
    - "不设计或修改 C1/C2 金额算法、授权 UI、funding request 或付款语义。"
    - "不审改 C3-C6，不调用真实 Provider，不读取密钥，不部署或发布。"
    - "不新增第三审片模型、第三份返工判决、第二套工作流或新基础设施。"
    - "不按题材、镜号、run、模型或单个测试 fixture 特判。"
    - "不通过调整 expected 调用次数、删除测试、放松类型、静默截断 findings 或说明卡兜底消除失败。"
  optional_subagents: []
  verification:
    - "V01-V05：固定点、三代 reference 继承、缺 SHA、真实失效与请求身份；同时检查继承集合、create 集合及逐条 ledger。"
    - "V06-V08：未定位反馈与四媒体状态；检查可操作下一状态、原反馈保留及未授权 create 为零。"
    - "V09-V12：无关规划角色零 producer 调用、voice-only 零媒体 create、有效 artifact membership 及完整复验偏序。"
    - "V13-V15：单分支补审、真实 role-loop identity collision 恢复、不可变 snapshot 和旧报告失效。"
    - "V16-V18：合法 findings 容量、真实影响摘要、Studio 往返与陈旧 revision 拒绝。"
    - "重跑当前四个 B5 聚焦测试文件和相关 Studio 返工测试，保留完整命令、退出码及三项原失败的合同裁决。"
    - "执行 npm run build:pipeline、npm run typecheck、git diff --check；B5 新增错误必须清零，B4/C2 基线错误不得混报为 B5 通过或失败。"
    - "N3 与真实 role-loop 碰撞恢复必须取得当前仓库证据；不能仅凭历史 JOURNAL、旧 transcript 或隔离替身签署验收。"
```
