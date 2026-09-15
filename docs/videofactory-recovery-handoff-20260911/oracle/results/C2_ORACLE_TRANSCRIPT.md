# Oracle Browser Transcript

Conversation: https://chatgpt.com/c/6aa38d06-9580-83eb-b18f-0b3e7dc4e31c

## Prompt

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

## Answer

## 1. Verdict：`CHANGES_REQUIRED`

**C2 已有实质实现，但尚未形成“看见同一份报价 → 明确确认 → 安全自动继续 → 追加、调整或暂停 → 重开恢复”的完整闭环。** 当前阻断不能全部归为旧测试过时，也不能继续沿用“C2 UI 完全没有实现”的旧描述。

本轮以附件中的当前 diff、完整组件和测试源码为依据。另执行了一组**当前 C2 方法的源码抽取、内存存储隔离探针**，确认了差额计算、报价与授权金额不一致、非整数分输入、历史命令重放等局部行为；这些探针替换了存储和 Pipeline 边界，**不等于真实 HTTP、完整服务链、仓库测试或浏览器验收**。

当前测试总数沿用本次事实快照：服务/API 为 **142/150**，UI 为 **171/175**，正式 Studio typecheck 失败。本轮没有重新运行这些仓库测试。

**前置依赖单列：**

| 依赖 | 对 C2 的影响                                          | 本轮结论                                                      |
| -- | ------------------------------------------------- | --------------------------------------------------------- |
| B4 | 当前 accepted plan、规划产物身份、编辑失效及 revision/version 合同 | 不替 B4 宣布通过；C2 必须消费其权威身份。                                  |
| B5 | “调整方案”的 findings、受影响范围、保留素材和返工闭包                  | 不重审媒体复用内部实现；C2 不得把未知范围扩大为全片重做。                            |
| C1 | 授权接受与消费、精确执行凭证、历史消费、逐 create 暂停检查                 | 当前快照仍报告 covered quote 自动继续失败；不能用 C2 的单个通过 fixture 抹去这一阻塞。 |

本附件**未包含当前完整的 `production-pipeline.ts`、`generative-asset-worker.ts`、`workflow-runner.ts`、run-store、认证实现和全局 HTTP error handler**。涉及这些实现的旧故障是否仍存在，以下明确标为 `UNVERIFIED`，不把历史 transcript 当作当前源码。

---

## 2. C2 合同完成矩阵

`PROVEN` 只表示对应证据层已证明，不自动代表整条产品链通过。

| 合同                                             | Source-level                                                                              | Service-level                           | Browser-level                | 综合判断             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------- | ---------------- |
| 准备报价不调用媒体 Provider                             | `PROVEN`：当前方法读取方案并保存记录，没有媒体执行调用                                                           | `PARTIAL`：现有测试未严格断言 create 计数           | `UNVERIFIED`                 | **PARTIAL**      |
| 不可变 quote 绑定当前方案、质量、模型、规格及修复上限                 | `PARTIAL`：已校验 plan digest，并保存 quality/permissions；但目录有效性、规格与价格新鲜度未闭合                      | `CONTRADICTED`：隔离探针可生成不存在于当前目录的模型报价     | `UNVERIFIED`                 | **CONTRADICTED** |
| 用户先看到 quote，再批准同一个 identity                    | `CONTRADICTED`：一个 handler 内 prepare 后立即 authorize                                         | 未证明知情确认                                 | `UNVERIFIED`                 | **CONTRADICTED** |
| 首次授权及基本幂等                                      | `PARTIAL`：稳定 grant ID、run-scoped receipt、prepared/accepted 已加入                            | `PARTIAL`：基本 fixture 通过；历史命令重放存在残留      | `UNVERIFIED`                 | **PARTIAL**      |
| authenticated actor、run ownership              | `PROVEN`：HTTP 已传 trusted actor，quote/funding 校验所属 run；**actor 对 run 的访问权限仍 `UNVERIFIED`** | 真实认证与无权访问测试 `UNVERIFIED`                | `UNVERIFIED`                 | **PARTIAL**      |
| funding request 权威差额和权限变更                      | `CONTRADICTED`：不再信客户端金额，但服务计算未消费历史账本                                                      | `CONTRADICTED`：应追加 50 分的隔离 fixture 返回 0 | `UNVERIFIED`                 | **CONTRADICTED** |
| 三动作及带上下文的局部改方案                                 | `PARTIAL`：已有退回报价、返工预填；没有完整 funding 三动作                                                    | funding → replan/amend/pause 未证明        | `UNVERIFIED`                 | **PARTIAL**      |
| durable pause、只 reconcile、明确 resume            | `PARTIAL`：等待报价可以请求暂停；UI 不支持全部新增暂停状态                                                       | 每次 create/retry/backup 检查 `UNVERIFIED`  | `UNVERIFIED`                 | **PARTIAL**      |
| 新 plan/model/attempt 重新批准，含 0 元 scope revision | `PARTIAL`：amendment 已可携带新 scope，允许 delta=0                                                | 历史 spend/reservation/attempt 保留未获真实账本证明 | `UNVERIFIED`                 | **PARTIAL**      |
| reload 恢复 active/pending/accepted command      | `CONTRADICTED`：当前详情 DTO 没有完整授权、待确认和命令投影                                                   | 未证明                                     | `UNVERIFIED`                 | **CONTRADICTED** |
| 无新增媒体费用的内容确认；TTS 自动记账                          | C2 quote 入口仍要求 spend-waiting；无费用内容确认路径 `UNVERIFIED`                                       | 零费用与真实 voice 配置链 `UNVERIFIED`           | `UNVERIFIED`                 | **UNVERIFIED**   |
| NewRunDialog duration/budget/template          | `PROVEN`：三个能力均有实现；预算重开初始化存在局部缺陷                                                           | budget 是否持久化并进入规划偏好 `UNVERIFIED`        | `UNVERIFIED`                 | **PARTIAL**      |
| 类型、移动端、键盘、长内容与错误恢复                             | 类型门禁 `CONTRADICTED`；有 dialog/focus/scroll 基础实现                                            | UI 单测仍有失败                               | 1440/390、键盘与滚动均 `UNVERIFIED` | **PARTIAL，不能验收** |

关键依据：报价生成与落盘见当前 `prepareProductionQuote`；详情只增加了 `productionPlanDigest`、`planningStages` 等字段，未增加完整 C2 approval projection；组件仍直接串联 prepare/authorize。

NewRunDialog 已有可编辑时长、预算意向输入与提交，以及模板推荐/选择逻辑，不能再记为“缺 UI”。

---

## 3. 旧 C2-01..C2-12 复核表

下列 `production-studio.ts` 行号按附件 unified diff 的 **current side** 还原；组件和测试行号使用附件完整文件中的原始行号。

| 旧 finding                           | 复核状态                      | 当前位置与已变化部分                                                                                                                                           | 剩余失败场景／证据缺口                                                                                                                          | 阻断             |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| **C2-01** 重放重复追加、崩溃恢复               | **PARTIAL**               | `production-studio.ts:961–1172`：增加 run/actor/target digest、稳定 authorization ID、先写 prepared receipt；不再是旧的随机 grant＋事后才记幂等                              | 当前仅以 **active head** 判断重放成功；合法 supersede 后，旧 accepted command 重放报冲突。grant/run-save 崩溃窗口因当前宿主未附，仍 `UNVERIFIED`，不能继续宣称复现旧 double-delta | P1             |
| **C2-02** 信客户端金额、忽略 URL predecessor | **RESOLVED**，限该机制         | `app.ts::parseProductionAmendmentInput`、`ProductionStudio.amendProductionScope:1062–1172`：body 不再采纳 `additionalCents`，URL ID 已传递并与 active/funding 核对 | 服务端**生成的差额仍错误**，列为新增 N01；旧签名测试不能证明原漏洞仍在                                                                                              | 原机制关闭；N01 为 P1 |
| **C2-03** quote 跨 run 路径接受          | **RESOLVED**，source-level | HTTP `requireOpaqueCommandId`；服务核对 `quote.quoteId`、`quote.runId`、plan digest                                                                         | 当前测试所谓 “foreign quote” 只使用不存在的 ID，真实 A/B 两个 run 交叉引用、编码路径和直接服务边界测试仍需补                                                                | 原机制关闭          |
| **C2-04** quote 不绑定实际 scope         | **PARTIAL**               | `prepareProductionQuote:844–958` 已核对当前 plan digest、保存完整 permissions；不再固定 `maxCreateAttempts:2`                                                       | `allowedModels` 只对照旧 `plan.items`；规格/价格新鲜度、可行性、许可备选与修复报价未充分证明；accept 仍可能授予不同于 quote 的金额                                              | P1             |
| **C2-05** quality digest 签发消费不一致    | **PARTIAL**               | `productionQualityContractDigest:2351` 已使用共享函数，并纳入 `visualProof/visualPlanDigest/editorial`                                                          | **C2 签发侧旧遗漏已修**；当前消费侧未附，全部可选字段下自动继续仍 `UNVERIFIED`                                                                                    | C1 集成 P1 待关闭   |
| **C2-06** 分取整及精确执行凭证不匹配             | **OPEN**，修复未证明            | 当前附件只有 C2 调用端与纯授权模块，没有旧 finding 涉及的完整 host/runner                                                                                                    | 不重复认定旧 `floor` 仍在；¥4.80/¥2.40、自定义 maximum、attempt narrowing 的真实执行结果 `UNVERIFIED`。另有 C2 自身分精度问题 N02                                   | C1 集成 P1       |
| **C2-07** 无法重新批准新 scope             | **PARTIAL**               | initial issuance 已可 supersede active；amendment 改用 funding 的新 plan/quality/permissions，并允许 `additionalCents=0`                                        | API 表达能力已有；但未与展示、scope diff、真实账本及三动作闭环，首次与后续批准入口语义混杂                                                                                 | P1             |
| **C2-08** 暂停不持久、不阻止新 create         | **PARTIAL**               | `requestPause:1334` 已允许等待报价；`resumePaused:1345` 已处理仅有 pause flag 的情况                                                                                 | UI 只为 `status==="paused"` 提供恢复；逐 create/retry/backup 和原 lost-pause cleanup 的当前实现 `UNVERIFIED`                                        | C2 P1＋C1 集成证据  |
| **C2-09** 未展示 quote 就批准             | **OPEN**                  | `NodeWorkspace.tsx:292–323,439–461` 仍先 prepare 再立即 authorize，丢弃返回 run detail，每次新 quote 生成新 key                                                       | 未知确认结果后无法恢复同一命令；没有完整 funding 展示与三动作                                                                                                  | P1             |
| **C2-10** authenticated actor 丢失    | **RESOLVED**，source-level | 三条 HTTP route 已调用 `trustedStudioActor`；服务保存 `approvedBy: actor`                                                                                      | 不等于已证明 run ownership 或真实认证保护；后者另列 `UNVERIFIED`                                                                                       | 原机制关闭          |
| **C2-11** 真实 CAS/lease 错误变 500      | **OPEN**，修复未证明            | 新 scope 方法仍未见对应异常转换；`StudioService.withLease` 调用的是 series edit lease                                                                                 | 当前全局 handler、lease 实现未完整提供，因此不能断言现在必然 500，也不能认定真实 409 和 accepted-result 恢复已通过                                                        | P2，验收证据必补      |
| **C2-12** fake 测试替代真实业务证据           | **OPEN**                  | `production-authorization-api.test.ts:321–412` 仍有旧调用签名及 fake 参数位置；组件测试仍断言一次点击完成两请求                                                                   | 未覆盖真实 route→service 全链、账本保留、pause、grant/create 次数、崩溃及浏览器                                                                             | P2，证据门禁        |

上述修正分别可从当前 route/parser、quote 接受校验、命令 receipt、amendment 和暂停实现直接确认。

quality 签发侧已补齐字段；旧测试/fake 和“一次点击两请求”的断言则仍在当前文件中。

**历史 transcript 中“预算意向输入尚未实现”的描述应标为 `OBSOLETE`；这不代表预算偏好的持久化和重开恢复已经完成。**

---

## 4. 新增 findings

### C2-N01 — P1：funding 已由服务端保存，但没有按可用授权计算缺口

**位置：** `ProductionStudio.prepareProductionQuote:844–958`，特别是 `maximumCents`、`additionalCents` 的计算。

当前使用：

```ts
additionalCents = Math.max(0, maximumCents - active.approvedAmountCents);
```

它没有读取已花、在途及未知结果占用。隔离探针中，已批 **1000**、已花 **250**、在途 **200**、新任务最高 **600**，方法返回 **0**，而正确缺口是 **50**。这不是客户端篡改，而是**服务端权威记录本身计算错误**。

**最小修复：** 消费 C1 的权威、去重账本快照；对尚未提交的新工作计算剩余需求。已 accepted/unknown 的任务不得再次列入新工作报价，也不得释放后重买。差额与权限变更一并保存进 immutable funding request。

---

### C2-N02 — P1：被展示的最高额与实际接受的授权金额不一致，且允许非整数分

**位置：** `prepareProductionQuote` 的金额校验；`authorizeProductionScope` 的 `approvedAmountCents`。

隔离探针确认两个问题：

| 场景                                                   | 当前结果                                                    |
| ---------------------------------------------------- | ------------------------------------------------------- |
| 已有授权 1000 分，新 quote 显示最高 600 分，经 initial endpoint 接受 | `Math.max(active, quote)` 实际签发 **1000 分**               |
| 输入 `requestedMaximumCny=6.006`                       | quote 保留 **¥6.006**，accept 通过 `Math.round` 签发 **601 分** |

第一项**不是证明超出旧授权扣费**，而是证明本次 quote 与签发 scope 不一致；第二项证明 C2 未严格实现整数分输入合同。

**最小修复：** 持久化 quote/funding 时确定准确的 `resultingApprovedAmountCents`，接受时不得临时 `Math.max` 重算；明确区分“已有累计授权”“本次最高追加”“追加后累计授权”。拒绝不能精确表示为分的用户输入，而不是静默向上取整。

---

### C2-N03 — P1：`plan.items` 被当作当前模型目录，`feasible:true` 被当作可行性结论

**位置：** `prepareProductionQuote` 中 `availableModels`、`permittedAssets`、`feasible`。

当前只检查模型是否出现在 `plan.items`，没有调用当前目录校验。隔离探针令当前可用目录为空，仍能得到包含该旧模型、且 `feasible:true` 的报价。`missingGoals` 取全部 item label，`preservedWork` 取全部 artifact kind，也不是“未完成目标”和“已验证保留成果”的可靠投影。

**最小修复：** 从既有目录、accepted plan 和实际媒体状态生成 scope/规格报价；保存目录或价格依据及变更身份。无法达到质量要求时返回调整方案状态，不提供“只追加费用即可继续”的动作。保留成果必须来自已验证可复用证据，而不是所有历史 artifact。

---

### C2-N04 — P1：合法追加后，旧 accepted command 无法幂等恢复

**位置：** `authorizeProductionScope`、`amendProductionScope` 的 receipt replay 分支。

当前只有 `active.id === previous.authorizationId` 才返回成功；一旦授权被后续合法修订替代，旧 receipt 虽然已经 `accepted`，相同 key/body 重放却返回“授权结果与当前制作状态不一致”。该局部行为已由源码隔离探针确认。

**最小修复：** 重放恢复的是**该命令的已接受结果**，不是要求该命令的授权永远保持 active。返回历史 command receipt 和当前 run 状态，明确授权已被后续修订替代；不得恢复旧授权、重新加钱或重新执行旧计划。

同时，`prepared`、receipt 损坏和 grant/run-save 窗口必须在当前 C1 宿主上做故障注入；本轮未证明这些窗口已经安全闭合。

---

### C2-N05 — P1：编辑草稿使用保存时最新 revision/version，可能绕过用户所见版本的冲突保护

**位置：** `NodeWorkspace.tsx:152–168,245–264`。

编辑期间 `inputDraft` 被保留；但保存时填入的是最新 props 的 `runRevision` 和 `effectiveInputVersion.id`。用户基于 v1 编辑，期间服务器更新到 v2，随后保存旧草稿时却提交 v2 的 expected identity，可能使服务端把旧草稿当作基于新版本的编辑接受。**“请求带了 expected 字段”不等于正确绑定了编辑基线。**

**最小修复：** 打开编辑器时捕获 revision/version，并随草稿、终态确认一起保存；后台更新不能替换该基线。冲突后保留草稿，让用户明确核对新版再提交。此项是 C2 客户端接入修复，不要求重做 B4 编辑器。

---

### C2-N06 — P1：新增“仅 pause flag”状态没有对应恢复入口

**位置：** `ProductionStudio.resumePaused:1345`；`RunWorkbench.tsx:157–177,377`。

服务现已支持 `awaiting_spend_approval + pauseRequested=true`，但工作台恢复按钮只在 `run.status === "paused"` 时出现；等待报价面板没有“暂不继续”，也不按该 pause flag 展示恢复。因而新接口状态与 UI 合同不匹配。

**最小修复：** 由服务投影“已暂停新媒体任务”和 `allowedActions`，覆盖等待报价与执行中的暂停；明确 resume。`resumePaused` 清除 flag 后是否需要恢复调度，也必须按实际 continuation 状态返回，不能只消掉 UI 标记。

---

### C2-N07 — P1：正式 UI 类型门禁失败，不能只修测试断言

**位置：** `NodeWorkspace.tsx::saveInputOverride`、配置编辑器输入构造；事实快照记录的 `PlanningStagesPanel.tsx` 调用。

正式组件仍把不含 expected identity 的对象当成完整命令输入；快照同时记录组件调用缺 revision、fixture 缺 `acceptedPlanDigest`、测试重复 JSX 属性。运行时四个旧断言失败与生产源代码 typecheck 失败必须分开处理。

**最小修复：** 区分本地编辑草稿与正式 API command 类型，并绑定 N05 的编辑基线；同步所有真实调用点。不得将服务端必填字段改回 optional，不得用类型断言掩盖缺失。

---

### C2-N08 — P2：预算意向重开初始化不完整，输入 0 又被静默丢弃

**位置：** `NewRunDialog.tsx:136,403–497,790–792,1113–1124`。

`budgetIntention` 只在组件初始挂载时读取 `initialValues`；重新打开时的初始化 effect 会重置其他生产设置，却没有同步它。同一组件重开另一个草稿可能沿用旧值或漏掉新预填值。输入控件允许 0，但提交条件为 `>0`，会把 0 当作未设置。

**最小修复：** 区分同一草稿重开与切换新制作的初始化身份；明确 0 元预算意向的产品语义，允许就原样保存，不允许就明确校验，不能静默消失。

### 测试与 UX 证据的分类

**旧测试/fake 错位属于 P2 测试合同缺陷，不是新的金额漏洞证据。** Amendment 测试应先由服务生成真实 funding request，再按新签名提交；不是补一个参数后继续传旧 `additionalCents`。此外，当前 “foreign quote” 测试只是不存在的 quote ID；初次自动继续测试只断言“不等于 awaiting”，也不足以证明进入了正确执行状态、只签发一次授权或只创建一次媒体。

**1440/390、键盘、长内容滚动和实际错误恢复仍为 `UNVERIFIED`。** 当前有 focus hook、dialog 命名和滚动处理，但没有浏览器结果；不据此虚构横向溢出或焦点通过结论。

---

## 5. 推荐唯一 API／状态流

### 5.1 统一权威来源

继续使用现有 run、授权记录和 paid ledger。扩展既有 `StudioRunDetail` 的一份 C2 投影，至少包含：

```ts
productionApproval: {
  state,
  allowedActions,
  activeAuthorization,
  pendingQuote,
  pendingFundingRequest,
  latestCommand,
  mediaPause
}
```

这些是**服务端事实的展示投影**，不是第二套前端授权状态机。金额统一使用整数分；客户端只格式化人民币。

服务端决定 plan/quality/asset identity、模型能力与规格、可行性、报价、历史消费、许可次数、predecessor、命令结果和允许动作。客户端只提交用户选择、用户所见 identity、编辑基线及稳定命令 key；不能决定差额、历史消费、权限集合或认证 actor。

### 5.2 首次确认

```text
当前方案完成
  → POST production-quotes
  → 保存并返回 immutable quote 与稳定确认命令身份
  → UI 展示该 quote
  → 用户点击“确认并开始”
  → POST production-authorizations，接受同一 quoteId
  → 持久化 accepted command
  → 原 Pipeline 自动继续
```

具体要求：

* **prepare：** 核验当前方案、目录与规格，生成完整 scope、预计金额、最高金额、有限修复及备选说明；不调用媒体执行。重复打开同一个 pending approval 不重造 quote/key。
* **display：** 页面实际渲染服务端返回的 quote。用户改变最高額、模型或修复许可后，旧确认按钮失效；重新报价并展示后才能接受。
* **accept：** 在原 run 写入边界核验 quote、revision、权限及新鲜度，接受 quote 中已确定的 scope；不能在此临时扩大金额或替换 permissions。
* **recover：** 超时或断网先恢复同一 command。accepted 与后续执行失败分开返回，避免“已经授权，但页面报失败”诱导再次批准。
* **已有 active authorization：** 后续变更统一通过 funding/amendment，不让普通客户端继续把 initial endpoint 当作另一条追加路径。
* **无新增媒体费用：** quote 明确标记内容确认类型；接受后记录内容确认并继续，不创建虚假的正金额 `ProductionAuthorizationScope`。当前 C1 parser 要求正金额及非空素材许可，不应为了 UI 通行而伪造数据。

### 5.3 Funding 与三动作

对于真正新增的工作，设：

```text
A = 当前累计授权
C = 已结算 + 在途预留 + 未知结果保守占用（去重、互斥分类）
R = 尚未提交的新工作最高需求，包含本次明确许可的有限修复

最高追加 = max(0, C + R - A)
```

`R` 不得再次包含已受理、已预留的相同物理请求。预计追加与最高追加分别保存；金额够但模型、效果或次数范围变化时，可以产生 **0 元 scope revision**。

```text
服务端生成 pending funding request
  ├─ 同意追加并继续 → 核验当前 predecessor → 接受保存的 delta + scope diff
  ├─ 调整方案       → 预填 findings、缺失目标、保留成果、影响范围 → 局部规划
  └─ 暂不继续       → 持久化 media pause → 保留成果，仅核对已受理请求
```

Amendment 必须同时核对：

```text
URL authorizationId
  == funding.authorizationId
  == 当前 active head
```

还要核对 run、revision、请求身份、适用状态和可行性。合法重放恢复原命令；不同 key 重复消费同一个 funding request 不得再次增加额度。

“调整方案”返回新的 accepted plan 后重新展示报价或 0 元 scope diff；**历史花费、预留和已用次数始终保留**。无可行质量路线时不提供单纯追加动作。

### 5.4 Pause、reload 与 resume

暂停应是独立、持久的“禁止新媒体任务”决定，不依赖某个节点恰好返回 `paused`。

暂停确认后的每个新 create、retry、backup 都必须经过同一停止检查；已经 accepted/unknown 的原请求继续查询和记录。查询完成不能顺便进入下一个 create。只有明确 resume 才解除暂停，并重新核对当前方案、授权和待处理命令。

reload 只读取已保存的 active/pending/command/pause 投影；**不能用刷新重新报价、重新生成 key 或自动接受新 scope**。恢复制作与接受新授权必须保持不同含义。

---

## 6. 普通创作者信息架构与文案表

主区域保留一个“当前需要你决定”的面板；脚本、分镜、模型和技术证据继续使用现有展开详情。

| 状态           | 主区域显示                               | 主按钮            | 次按钮／其他动作          | 技术详情                              |
| ------------ | ----------------------------------- | -------------- | ----------------- | --------------------------------- |
| 方案形成中        | 内容目标、时长范围、当前进度；尚未授权图片/视频花费          | 无资金确认按钮        | 查看／调整内容           | 规划阶段、实际模型                         |
| 首次 quote 待确认 | 给谁看、主要内容与画面、时长、预计媒体费用、最高授权、备选与有限修复  | **确认并开始**      | **调整方案**          | quote/plan 身份、逐项规格与报价依据           |
| 图片/视频无新增费用   | 内容摘要；“本次图片/视频无需新增费用”                | **确认内容并继续**    | 调整方案              | 复用证据、其他后台记账                       |
| 授权内自动制作      | 已保留成果、当前制作内容、已记录费用及待确认占用            | 无重复授权按钮        | **暂停制作**          | 逐请求回执、实际费用来源                      |
| 需要追加         | 已完成什么、缺什么、为什么值得继续、预计追加、最高追加、追加后许可变化 | **同意追加并继续**    | **调整方案**；**暂不继续** | funding identity、predecessor、逐项差额 |
| 只改变范围，不追加费用  | 变更前后效果／模型／次数差异；“本次不追加费用”            | **确认变更并继续**    | 调整方案；暂不继续         | 新旧 scope 对照                       |
| 无可行达标方案      | 能力或证据限制、保留成果、可调整方向                  | **调整方案**       | 暂不继续              | 失败与可行性证据                          |
| 已暂停新媒体任务     | “已保留当前成果，不再发起新的图片或视频任务；已受理任务仍会核对结果” | **恢复制作**，仅在允许时 | 查看成果；调整方案         | 在途请求状态                            |
| 确认结果待恢复      | “正在确认上次操作是否已经接受，不会重复追加”             | **重新读取结果**     | 查看当前制作            | command 状态与错误详情                   |
| 已接受但执行需处理    | “你的确认已保存；制作在这里遇到问题，成果仍保留”           | 服务端允许的恢复动作     | 调整方案／暂停           | 已接受 command、失败阶段                  |

**当前应修改的具体文案：**

| 当前位置／现有文案                               | 问题                         | 建议                                              |
| --------------------------------------- | -------------------------- | ----------------------------------------------- |
| NewRunDialog：“逐项人工确认”“每次调用前都会给出报价并等你确认” | 与制作范围授权内自动继续矛盾             | “确认方案和图片/视频最高费用后，授权范围内自动制作”                     |
| 预算提示：“实际花费仍会……逐次报价并等你确认”                | 把预算意向与反复审批混在一起             | “仅供方案取舍参考；实际制作前另行确认图片/视频费用上限”                   |
| RunWorkbench：“现在需要你：确认{节点名}”            | 不区分首次确认、追加和范围变更            | 按服务端 approval kind 显示“确认制作方案”“需要追加制作费用”“确认方案变更” |
| NodeWorkspace：“执行前费用确认”“最多 N 次”         | 不清楚 N 是每个素材、整节点还是修复次数      | “图片/视频制作费用”；明确“每个母片首次制作及最多几次付费修复”               |
| “把这份报价退回导演”                             | 对普通用户偏内部流程，且没有 funding 上下文 | “调整制作方案”；预填当前缺口、问题和保留范围                         |
| “上游变化后需重新生成”“后续旧结果不会继续使用”               | 容易把失效复核理解成全部重买             | “需要重新检查适用性；已合格素材会尽量保留，只重做列出的部分”                 |
| “当前步骤完成后暂停”                             | 不能表达逐媒体请求的停止边界             | 区分“正在暂停新任务”与“已暂停新任务”；说明已受理任务仍查询                 |

这些旧审批描述和节点式标题确实仍在当前组件中。

另外，`RunWorkbench::hasDirectorCostFeedback` 仍只查 `visual-direction`；joint-v1 的相关反馈不能继续依赖这个旧节点名称来决定“按降本意见重新规划”的文案。此处只修 C2 展示接入，不重做 B4/B5 路由。

---

## 7. Claude Code + GLM 5.3 Flash：C2 单阶段执行计划

### 允许文件与修改边界

**主要允许：**

* `apps/studio/src/server/production-studio.ts`、`studio-service.ts`、`app.ts`、必要的既有 typed error 文件。
* `apps/studio/src/shared/api.ts`、`client/api.ts`。
* `NodeWorkspace.tsx`、`RunWorkbench.tsx`、`NewRunDialog.tsx`。
* `PlanningStagesPanel.tsx` 仅修此次 expected revision/type 接入；`pages/ProductionPage.tsx` 仅接入现有 mutation、reload 和返回状态。
* 上述对应的现有 API、service、client、node-workspace 测试；已有样式文件仅修确认面板的布局和可访问性。

**有条件允许：** 当前宿主源码核验后，确需修改的 `production-pipeline.ts` 命令恢复／暂停接缝，以及 `generative-asset-worker.ts` 的逐 create 检查。只做 C2 必需集成；C1 决策策略与 workflow-core 精确匹配器不是本轮重构对象。

### 最小实现顺序

| 步骤                      | 先写的失败测试                                                                  | 最小实现                                                          |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **S1：固定证据与接口合同**        | 给现有失败分类；新增真实 route→StudioService 集成 fixture，证明旧 fake 与真实命令不同             | 核对当前 host/lease/auth/error handler；同步新签名和 fixture，不恢复旧客户端金额合同 |
| **S2：权威 quote/funding** | 1000/250/200/600→50；目录失效；规格变化；非整数分；quote 与 grant 金额一致                    | 复用 C1 账本折叠与身份函数；保存准确 scope、金额、可行性和 pending identity           |
| **S3：接受与恢复**            | 相同 key、不同 body、已 superseded 历史命令、receipt/run-save 故障、不同 key 消费同一 funding | 稳定命令结果；接受与执行结果分离；补真实冲突映射和 read projection                     |
| **S4：变更与暂停**            | delta=0 scope revision；历史账本不变；等待报价暂停；多 item 间暂停；未知请求核对后不新建               | 统一 amendment/replan/pause/resume 合同，保留原执行器                    |
| **S5：先展示再接受**           | prepare 完成前后 authorize 都为 0；第二次明确点击才批准已显示 quote；断网/reload 恢复原 key        | 现有面板消费服务端投影；三动作接回现有 page mutation；不再丢弃返回 detail               |
| **S6：编辑和表单收口**          | 编辑中收到新版本仍提交旧基线并得到冲突；预算同草稿重开／切换草稿／0 值                                     | 修生产类型错误、基线捕获、预算初始化和文案                                         |
| **S7：统一验收**             | 下节完整矩阵                                                                   | 串行构建、聚焦与标准测试、1440/390 实际浏览器留证，再重新审计                           |

**Non-goals：** 不重做 Studio，不新建强制页面或第二套状态机；不加钱包、充值、Redis、业务数据库或全站预算引擎；不升级依赖、工具或模型；不改双审独立性、不放宽 unknown/quality/attempt/精确授权；不清理现有 dirty work、历史素材或账本；不实施 C3–C6，不调用真实付费 Provider，不部署。

**通过标准：** C2 自身阻断全部关闭，正式 typecheck 和相关标准测试通过，真实链路证据与浏览器证据齐全；B4/B5/C1 被 C2 消费的前置合同另有明确通过结论。不能以“新增单测绿”替代整体准入。

---

## 8. 验证矩阵

| 验证面                  | 必测场景                                                                                              | 必须保存的结果                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **真实服务链**            | `buildStudioApp → StudioService → ProductionStudio → ProductionPipeline`；只 fake 外部 transport/模型返回 | 不替换业务服务来伪造 200/409；记录实际方法、授权记录和 create/reconcile 次数         |
| **报价不执行**            | 首次、重复打开、目录更新、重新报价                                                                                 | prepare 的媒体 create/retry/backup 均为 **0**                    |
| **quote identity**   | 不存在、其他 run、路径/编码输入、plan/quality/规格/价格变化                                                           | 400/409 或项目明确合同；不签发、不调用；两个真实 run 的交叉引用测试                    |
| **认证与 ownership**    | 未登录、请求保护失败、无权 run、body 伪造 actor                                                                   | 既有认证响应正确；`approvedBy` 来自可信上下文；拒绝时副作用为 0                     |
| **funding identity** | URL 与 request predecessor 不同、非 active head、foreign/nonexistent request、重复消费                       | 仅接受当前适用请求；客户端金额不参与计算                                        |
| **精确金额**             | 恰好够、差 1 分、1000/250/200/600→50、非整数分、非有限值、加法溢出                                                      | 报价、授权和执行核算一致；不因显示四舍五入扩大许可                                   |
| **quote/授予一致**       | 已有 1000 分授权，新方案报价较低；自定义最高额低于默认修复上界                                                                | 明确显示累计与新增含义；接受对象与显示 scope 完全一致                              |
| **崩溃与幂等**            | prepared 前后、grant 写入后、run-save 后、receipt 写入失败、响应丢失、后续合法 supersede                                 | 一次命令只产生一次 grant/delta；历史命令可恢复，不复活旧授权                        |
| **并发与 lease/CAS**    | 同 key 并发、不同 key 同 revision、quote 与编辑竞争、pause 与 accept/resume 竞争                                   | 唯一接受结果；实际 writer/lease 证据；失败映射不能靠 fake                      |
| **scope revision**   | 新 plan/model/attempt、0 元变更、已有尝试用尽                                                                 | 明确 scope diff 与重新确认；seeded 历史 spend/reservation/attempt 不归零 |
| **无费用内容确认**          | 免费图库、已验证素材复用、没有新增付费 item                                                                          | 可确认内容并继续；不存在伪造正金额 grant；TTS 不弹媒体审批但仍记账                      |
| **暂停与核对**            | 等待报价暂停；第一 item 已受理时暂停；retry/backup 前暂停；unknown 恢复                                                 | 暂停确认后新增 create 为 **0**；原请求可核对；核对完成不启动下一项                    |
| **reload/resume**    | prepare 后、accept 响应丢失后、追加后、flag-only pause、进程重启后打开                                                | 恢复原 pending/accepted identity；不生成新 quote/key；明确 resume      |
| **编辑冲突**             | v1 草稿编辑期间收到 v2，再保存；终态确认期间版本变化                                                                     | 旧基线 409；草稿保留；用户明确核对后才重绑版本                                   |
| **桌面／移动**            | 1440 与 390 宽度，长脚本、很多 quote items、长错误内容                                                            | 无关键按钮遮挡或横向溢出；弹窗可滚动；触屏三动作可用，附实际截图                            |
| **键盘与错误恢复**          | Tab/Shift+Tab、Enter/Space、Esc、关闭重开、断网、409、已接受但执行失败                                                | 焦点合理进入与返回；busy/error 可感知；不丢草稿，不重复授权                         |
| **构建与 CI**           | root typecheck、API/service、客户端、受影响 Pipeline/worker 测试、标准 Studio 测试入口                              | exit code、测试总数、失败清单；证明 C2 suite 真正纳入标准测试/CI                 |

**现有测试需要特别增强的断言：** grant 数、累计授权分值、原 ledger entries、已用次数和真实 create/reconcile 计数，而不是只断言 HTTP 状态、run revision，或“不再 awaiting”。当前测试确实缺少这些关键保证。

---

## 9. Codex execution advice

```yaml
codex_execution_advice:
  implementation_plan:
    - "核对当前 C1 host、run lease、认证和 error handler；将旧测试签名错误、C2 产品缺陷及前置阻塞分别登记，不沿用历史完成结论。"
    - "先写真实 route 到 Pipeline 的失败测试，覆盖 funding 50 分缺口、quote 与 grant 一致、目录失效、非整数分、历史命令重放和暂停恢复。"
    - "复用现有权威账本与身份函数，生成 immutable quote/funding scope；保存预计追加、最高追加、累计授权和准确权限差异。"
    - "闭合稳定 command receipt、接受结果恢复和 pending approval 读取；首次接受、后续 amendment、0 元 scope revision 与无费用内容确认各有明确语义。"
    - "闭合等待报价和执行中的 durable pause；所有新 create、retry、backup 受控，已 accepted/unknown 请求仅 reconcile，恢复必须明确。"
    - "在现有 NodeWorkspace/RunWorkbench 中先展示 quote 再接受，接入三动作和 reload；复用现有页面 mutation，不再丢弃返回状态。"
    - "修复编辑基线捕获、正式 UI 类型错误、预算意向初始化与中文文案；完成标准测试和 1440/390 浏览器验收后再审计。"
  non_goals:
    - "不修改或清理无关累计工作，不 reset、stash、clean、commit、push 或 deploy。"
    - "不调用真实付费 Provider，不升级工具、依赖或模型，不读取密钥。"
    - "不实现 C3-C6，不重做 Studio、模板内容或 B4/B5 创作与返工架构。"
    - "不新增钱包、充值、全站预算引擎、业务数据库、第二套前端状态机或强制页面。"
    - "不放宽 C1 精确授权、quality、unknown outcome、有限 attempts 或独立双审合同。"
  optional_subagents: []
  verification:
    - "运行 npm run typecheck 和 npm run build:pipeline，串行执行，保留完整 exit code。"
    - "运行 production-authorization-api、api-contract、studio-service、server 及受影响的规划编辑测试；真实业务链不得由 fake service 代替。"
    - "使用已安装 Vitest 运行 client、node-workspace 及相关组件测试；同步旧 fixture 不得删除冲突与安全断言。"
    - "核验 1000 已批、250 已花、200 在途、600 新需求产生 50 分缺口，批准前 create 为 0，批准后历史消费保持不变。"
    - "故障注入覆盖 prepared、grant、run-save、receipt 和响应丢失；相同命令只接受一次，supersede 后历史重放不恢复旧授权。"
    - "验证 quote/funding/run/actor/predecessor 身份、真实 lease/CAS、精确分、零费用内容确认及 0 元 scope revision。"
    - "验证暂停后的新 create/retry/backup 为 0，原请求继续核对，reload 不重造 quote/key，明确 resume 后才继续。"
    - "提供 1440/390、键盘焦点、长内容滚动、关闭重开、断网与 409 恢复的实际浏览器证据。"
    - "证明 C2 测试纳入仓库标准测试入口与 CI；B4/B5/C1 依赖单独验收，UNVERIFIED 项不得记为通过。"
```
