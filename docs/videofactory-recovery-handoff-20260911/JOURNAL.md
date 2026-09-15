# VideoFactory 恢复实施 Journal

## 2026-09-11：重新采集与四批 Oracle 审计

### 目标

停止混合修改 B4/B5/C1/C2，重新建立当前事实和可由 Claude Code + GLM 5.3 Flash 分阶段执行的资料包。

### 仓库基线

- repo：`/Users/jinkun.wang/work_space/veidofactory`
- branch：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- upstream：领先 2，落后 0
- tracked modified：86
- untracked：22
- tracked diff：约 `+13248/-692`
- `git diff --check`：exit 0

未执行 reset、stash、checkout、clean、commit、push 或部署。

### 环境恢复

本机 Node `v26.8.1`，ABI 147；已有 `better-sqlite3` binding 是 ABI 127。执行 `npm rebuild better-sqlite3` 后 SQLite 内存探针成功。该操作只重建本地依赖，没有修改源码或 lockfile。

### 当前测试证据

- `npm run build:pipeline`：exit 0。
- `npm run typecheck`：exit 2，Studio 正式类型错误；详见 `CURRENT_STATE.md`。
- B4 pipeline：144/144。
- B4 Studio：24/29。
- B5：156/159。
- C1：24/25；组合 180/184，其中另 3 项属于 B5。
- C2 service/API：142/150。
- C2 UI：171/175。

本轮没有真实 Provider、视频 E2E、浏览器产品验收或云端验证。

### Oracle Web

完整重读最新 Skill 和 execution advice，选择第 5 档。四批使用独立 conversation/slug，串行运行；网页均实际显示 `Pro，第 5 项，共 5 项`，prompt 均提交到新 `/c/...` 并捕获完整答案。四个专属 Chrome PID 已退出，四个临时 Profile 已删除。

- B4：`CHANGES_REQUIRED`
- B5：`CHANGES_REQUIRED`
- C1：`CHANGES_REQUIRED`
- C2：`CHANGES_REQUIRED`

完整证据见 `ORACLE_SESSION_VERIFICATION.md` 和 `oracle/results/`。

### 本轮修改

只创建/更新本恢复资料包，没有修改 `/Users/jinkun.wang/work_space/veidofactory` 产品源码。

### 下一步

Claude Code + GLM 5.3 Flash 执行 `B4_EXECUTION_CARD.md`。完成 B4 全阶段并本地验证后停止；由审计者检查实际共享仓库并运行 Oracle Web B4 复审。只有 `ACCEPTED` 后才进入 B5。

### 在途外部状态

- 真实图片/视频/TTS/模型 Provider 调用：无。
- 可能扣费或结果未知的外部任务：无。
- commit/push/deploy：无。

---

## VF-RECOVERY-B4：joint planning 正式接入收口

```text
任务 / 日期：VF-RECOVERY-B4 / 2026-09-11
执行者实际模型与 thinking：Claude Code 会话，实际模型 glm-5.3-flash[1M]（与用户配置一致，
未发现替换/降级）；最高可用 thinking 档位。
进入时 HEAD、branch、status、diff：
  HEAD 570fe6e59e072c4965c86769bf2096825f003383（与包基线一致）
  branch codex/final-dual-review-cloud-acceptance（ahead 2，与包基线一致）
  tracked modified 86（一致）；untracked 46 = 包基线 22 个产品文件 + 24 个本资料包文档，
  无新增产品变更。git diff --check exit 0。
预期用户行为：新制作/返工只走 joint 规划；编辑并发贯穿持锁点；阶段状态真实；
  历史 run 恢复不重复角色/产物；planning 不调用付费媒体 Provider。

环境事实（进入时发现）：
  默认 shell node 为 v22.23.1（ABI 127），better-sqlite3 binding 为 ABI 147，
  导致全部 SQLite 规划测试假失败。分类 ENVIRONMENT：改用 /opt/homebrew/bin/node
  （v26.8.1，与资料包采集环境一致）后恢复，未 rebuild、未改源码、未回退 MemorySaver。

失败证据（进入时，Node 26 下重放）：
  - production-pipeline-reference-grammar 6/9：3 处 assertSingleJointPlanningCommit
    期望 kinds 缺 creative_treatment —— STALE_TEST（treatment 正式注册是已确认的正确合同）。
  - production-planning-editing 1/5：合法调用缺 expectedRunRevision/expectedVersionId
    —— STALE_TEST；同文件缺真实持锁点复核 —— PRODUCT_BUG（F7 残留）。
  - production-planning-stages 8/9：treatment 旧空 artifact 断言 —— STALE_TEST。
  - node-workspace.test.tsx 4 失败：组件保存时用当前 props 拼 token、无打开时基线
    —— PRODUCT_BUG（B4-R1 客户端段）。
  - studio client typecheck exit 2（组件缺 revision、fixture 缺 acceptedPlanDigest、
    重复 JSX 属性）。
  - Oracle N1：正式 treatment provenance.providerId 写入 model 字符串 —— PRODUCT_BUG。
  - Oracle F5 残留：ranker 身份不进入 stageInputs，completed graph 可重放旧排序
    —— PRODUCT_BUG。F4 残留：rank 请求只有 artifact id，无当前画面语义 —— PRODUCT_BUG。
  - Oracle F10：joint 图库路线 candidateInventoryPath 用公开 report 顶替 —— PRODUCT_BUG。
  - Oracle F6/F9 残留：verifyExecutablePlanInput 不解析内部引用闭包；
    stage DTO 以旧 artifact presence 覆盖 running/发布失败 —— PRODUCT_BUG。

根因与关闭方式：
  1. 编辑并发纵向链（R1）：expectedRunRevision 进入 workflow-core 三个 draft 类型；
     pipeline.applyNodeInputOverride / applyNodeExecutionConfiguration 在 lease 内
     复核 caller revision（StaleRunRevisionError）；studio host 原样传递 tokens；
     客户端 NodeWorkspace 以 beginInputEditing 捕获打开时基线（runRevision+versionId），
     保存只用基线，props 刷新不替换；执行配置编辑器以"调整"点击时的 revision 为基线；
     PlanningStagesPanel 改用不含 token 的草稿类型。分离 StudioNodeInputDraft /
     StudioNodeExecutionConfigurationDraft 与 wire DTO。
  2. 请求/身份/provenance（R2/N1/F3/F4/F5）：
     - history 与 checkpoint 增加 provider traces（carriedProviderTraces 通道），
       正式 treatment artifact 的 providerId 取实际执行 provider（fallback 后为
       zai-bigmodel-api），缺失显式 "unknown"，不再写入 model 字符串或首选配置；
       planningReceipt.modelId 无 trace 时为 "unknown"。
     - stageInputs 增加独立 rank 身份（ranker id+model+合同版本+语义投影规则版本）；
       ranker 身份变化：播种只携带候选不携带排序（游标停 director 后真实重排），
       同 digest 恢复经 updateState 失效 rank/integrate/compile 后真实重排（不重搜）。
     - rank 请求携带 rankingSemanticIntent（与图内证据覆盖同一投影：
       planContract + 逐镜 shotEvidenceIdentity），checkpoint 身份随之变化。
     - treatment 输入补 lockedViewerPromise（系列承诺）与 referenceGrammar
       （payload/审计上下文标注 evidenceStatus=style_structure_reference，不冒充事实证据）。
  3. 库存与单一投影（R3/F10）：joint 图库路线节点输出新增 candidateInventoryPath
     （worker 私有路径，经执行记录按 digest 持久化与恢复，播种随候选继承），
     validateJointPlanningOutput 与 planningCandidatePaths 对缺失 fail closed，
     物化消费真实库存；新增 currentPlanningOutputPaths 唯一兼容投影，
     assets/voice/render/technical-review 不再各自判断拓扑。
  4. 发布与引用闭包（R4/R5）：verifyExecutablePlanInput 扩展引用闭包校验：
     joint（有 commit 绑定）要求全部内部引用唯一解析、kind/producer/digest 一致且字节
     完整，quote/worker 前 fail closed；legacy 无 commit 绑定按显式兼容只做唯一解析/
     kind/完整性。真实进程崩溃测试 production-planning-publication.test.ts
     （fixtures/production-planning-publication-child.ts）：SIGKILL 硬杀四个窗口
     （afterGraph/afterArtifacts/afterCommit/afterSeed），第二个全新子进程经真实
     lease 过期（recoverInterruptedRuns + retryFailedNode）恢复；断言角色调用不增、
     正式 artifact 唯一、当前 accepted 结果唯一、fallback provenance 存活。
     为此新增 planningFailpoints.afterCommit/afterSeed 与窄测试缝隙
     executionLeaseStaleMs（生产默认 30s 不变，测试等待真实过期，不手工删锁）。
  5. DTO（R5/F9）：inspectCreativePlanningStages 状态优先级改为
     failed > running(cursor) > completed(旧产物) > pending；图完成而发布失败时
     compile 阶段标 failed 并带可行动 issue；不再把重跑中的阶段覆盖成 completed。
  6. 测试同步（保留安全断言）：editing 4 例改读真实 token 并拆分多重非法条件；
     新增持锁点 stale 拒绝（素材配置变更推进 revision、planning 输入版本未变——
     只有 caller revision 复核能拦下）与双客户端预检查后 barrier 竞争测试（拒绝后零变更）；
     stages 断言唯一正式 treatment artifact + view_artifacts，新增发布失败不显示全绿；
     reference-grammar kinds 补 creative_treatment、私有库存独立路径/内容断言、
     treatment 收到语法断言；closure 新增 ranker 身份变化真实重排（不重搜）、
     provider/model 分离 provenance（正常+fallback）、系列承诺进入 treatment 请求、
     引用闭包 quote 边界 fail closed（不重跑规划、零 worker 调用）；
     node-workspace 175→176 例（补 props 刷新不替换草稿基线测试）。

修改文件（本阶段实际改动；均为最小 symbol 级修改，未覆盖既有未提交内容）：
  产品源码：
    packages/workflow-core/src/types.ts
    packages/production-pipeline/src/production-pipeline.ts
    packages/production-pipeline/src/creative-planning.ts
    packages/production-pipeline/src/codex-creative-treatment.ts
    apps/studio/src/shared/api.ts
    apps/studio/src/server/production-studio.ts
    apps/studio/src/client/components/NodeWorkspace.tsx
    apps/studio/src/client/components/PlanningStagesPanel.tsx
  测试/夹具：
    packages/production-pipeline/test/production-planning-publication.test.ts（新增）
    packages/production-pipeline/test/fixtures/production-planning-publication-child.ts（新增）
    packages/production-pipeline/test/production-planning-closure.test.ts
    packages/production-pipeline/test/production-pipeline-reference-grammar.test.ts
    apps/studio/test/production-planning-editing.test.ts
    apps/studio/test/production-planning-stages.test.ts
    apps/studio/test/node-workspace.test.tsx

聚焦验证（Node 26，最终代码状态，全部 exit 0）：
  - build:pipeline：exit 0。
  - pipeline block1（store/planning/treatment/contracts/executable-plan）123/123。
  - pipeline block2（closure/reference-grammar/preflight/publication/run-store/
    workflow-runner）108/108。
  - studio node（editing/stages/api-contract）32/32。
  - studio vitest（node-workspace/client）176/176。
  - npm run typecheck：exit 0（进入时为 exit 2）。
  - git diff --check：exit 0。

进程/并发/恢复证据：
  - L3 崩溃：production-planning-publication.test.ts 4/4——真实子进程 SIGKILL
    （exit 137/signal SIGKILL）、跨进程 side-effect 计数、真实 lease 过期恢复、
    唯一 commit/正式产物/当前 accepted 结果、seed 窗口 fallback provider/model 存活。
  - L2/L3 并发：editing 持锁点 stale 拒绝（隔离 revision 复核）与双客户端 barrier
    （两请求过预检查→A 落定→B 在持锁点 409，拒绝后 revision/版本/产物零变更）。
  - 库存：reference-grammar 断言私有库存与公开报告不同路径不同内容、assets 输入
    消费库存本身；恢复经执行记录按 digest 找回。

外部调用、费用、taskId 与未知结果：无。无 Provider 调用、无 commit/push/deploy、
无密钥读取。测试全部使用本地替身 transport。

共享回归扫描单列（进入前已存在，本阶段未修改；失败机制均在未触碰代码上核实）：
  - apps/studio/test/server.test.ts 3 例 + studio-service.test.ts 1 例
    （removes a model override / replans direction / resumes from assets /
    exposes cost ledgers）：旧请求缺新并发 token（400!==200 / 409 冲突）
    —— STALE_TEST，C2 同步范围。
  - studio-service.test.ts turns a note-only human rejection…：空返工范围 vs 全片
    —— 资料包已记录的 B5 needs_scope 待裁定项。
  - production-pipeline.test.ts 3 例（reuses one reviewed scene / quotes only changed
    paid scenes / reuses one reviewed scene 的 scene-revision descendant 合同）
    —— B5 返工/复用家族，堆栈在未触碰的 applyNodeRevision 与报价流程上。
  - B5 已知红组重放：generative-asset-worker/codex-visual-review/production-joint-rework
    126/129（3 红）；C1：production-authorization 24/25（1 红）——与资料包记录一致。

未通过或未验证项：
  - 上述共享扫描 8 例与 B5 3 例、C1 1 例维持已知红，按边界不顺手修改。
  - 真实 Python worker 离线物化消费库存未在本阶段新造 pytest（js/worker 消费边界
    已由 L2 断言覆盖）；留待 B5/C6 统一验证。
  - L4 浏览器证据、L5 真实模型/媒体：本阶段授权范围外，not_run。
  - reference-grammar 的 grammar→treatment 断言依赖风格注入路径，未覆盖
    grammar 身份进入 treatmentStageInputIdentity 的独立失效场景（身份字段已在
    同一投影中，随 F5 场景一并验证）。
停止位置：B4 实现完成，等待审计者按 B4 验收 + Oracle Web 复审。不进入 B5。
```

### B4 审计后修复轮（2026-09-11，同日）

第一次实施后审计（Oracle Web 第 5 档，slug `vf-b4-post-implementation-audit-20260911-01`，
全新会话，档位 verified=yes「Pro，第 5 项，共 5 项」，24m32s，↑553.51k ↓7.29k）结论
**CHANGES_REQUIRED**。完整 transcript 见 `oracle/results/B4_POST_IMPL_ORACLE_TRANSCRIPT.md`。
逐项核对当前源码后，成立的 finding 一次修完：

- **F1-r1（P1）**：非正式方案文件先全部落盘（任何写入失败都发生在零登记状态）；leftovers
  恢复分支从"只接受完整集合"改为"逐 kind 字节校验 + 缺失 kind 受控补登记 + 父关系核验，
  整组一次 commit 接受"——部分 registry 不再永久卡死，完整性不放松。
  原 `verifyJointPlanningLeftovers` 被取代并移除。
- **F5-r1（P1/BOTH）**：rank 的 durable checkpoint 携带与外层 stage identity 同源的 ranker
  身份（provider/model/合同版本）；seed 对"缺失 rank 身份"与"身份不一致"同等对待
  （只携带候选、真实重排），两条路径对未知身份不再定义相反。新增 completed-cache 失效
  测试：afterGraph 硬失败后（排序已入终态 checkpoint），同 digest 恢复 + 只换 ranker 必须
  真实重排（rankCalls=2、候选不重搜、未变角色不重跑、checkpoint key 变化、新排序产物为
  新 model）；fake ranker 现在真实读取 checkpoint 身份。
- **F6-r1（P1）**：`verifyExecutablePlanReferenceClosure` 绑定当前接受 output（被消费 plan
  必须正是规划节点当前 output 指向的文件）；严格性按显式拓扑判定（producer=creative-
  planning 为 joint：引用集必须共享同一 commit digest、plan 自带 digest 时必须一致、
  producer 一致、证据链父关系核验——缺 digest 不再隐式跳过；production-preflight 为
  legacy 兼容）。声音时长修订进入同一正式合同：新版本保留规划支撑引用集
  （`retainedArtifactIds` = 当前版本除 plan 外全部），不再留下断链的新 plan。
- **F7-r1（P2）**：joint-v1 run 的两个 pipeline 编辑入口强制 caller tokens（revision 必填、
  输入编辑还须 versionId），省略即拒绝；legacy 拓扑显式兼容（提供 token 时仍复核）。
  直接调用 pipeline 的测试改为读取真实 token（含 barriers 之外的 assets 编辑点）。
- **F9-r1（P2/BOTH）**：节点 succeeded 且图产物齐全但正式 commit/registry 核验失败时，
  compile 阶段标 failed 并显示"正式方案还没有通过核验…"；已完成模型阶段（treatment/
  script/director/rank）缺真实 trace 时显式 `effectiveModelId="unknown"`，不再隐藏；
  确定性阶段保持无模型字段。同步 stages 测试中固化 undefined 的旧断言。
- **F10-r1（P1）**：图状态新增 `candidateInventoryBinding` 通道——worker 私有库存绑定与
  候选证据同一 checkpoint 持久化；search 端口返回绑定、candidates 节点写入状态、
  播种随候选携带、节点输出以 checkpoint 状态为权威恢复源（history 退为辅助记录）。
  afterSeed 硬崩溃后图库 run 不再因库存路径丢失而停住。
- **RB4-02 证据补强（部分）**：rank 请求的 recording 断言保留；既有
  `creative-planning.test.ts`（70 例，含角色请求/Broker payload 覆盖）本轮已定位为
  复审必附材料（上一轮未附导致 UNVERIFIED 判定的一部分）。

审计意见核对结果：7 项 blocking 全部成立并已修；RB4-02 的"真实 Broker recording"部分
由既有 creative-planning.test.ts 覆盖（本轮随材料附上供独立核验）；真实 Python 离线
库存物化与 accepted-后 kill 窗口仍未独立验证，如实单列（UNVERIFIED，不阻断本地
逻辑修复的复审，但阶段放行与否由审计者裁定）。

复审前完整验证（最终代码状态）：build:pipeline exit 0；block1（含 A 回归
executable-timeline）136/136；block2（closure 20 / reference-grammar 9 / preflight 6 /
publication 4 / run-store / workflow-runner）109/109；studio node 32/32；vitest 176/176；
`npm run typecheck` exit 0；`git diff --check` exit 0。共享扫描 229/237——8 例与进入前
完全一致（逐名核对），修复批次零新增回归。

停止位置：等待第二次全新 Oracle 复审（新 slug/新会话），不进入 B5。

---

## VF-RECOVERY-B5：局部返工、媒体复用与双审收口

```text
任务 / 日期：VF-RECOVERY-B5 / 2026-09-11
执行者实际模型与 thinking：glm-5.3-flash[1M]（与配置一致），最高可用 thinking。
进入时基线：同日 B4 修复轮完成后的工作树；B5 聚焦 156/159（3 例跨 run 失败）、
studio-service note-only 1 例、production-pipeline.test.ts 2 例 B5 族。
用户指示：B4 不再单独复审，B 里程碑审计改为 B4+B5 合并 Oracle。

根因与关闭方式：
1. 三项跨 run 失败（4/5、4/7、6/7）同一根因：findReworkCarryForwardItems 只按
   findings 排除，不消费人工批准的重做范围。修复：affectedScenePositions（人工确认
   的重生成集合）从 carry-forward 资格排除；空范围=全保留；缺字段=保守全重做。
   三例分别重演：范围外三代链 1/2/3 携带 + 范围内 4 重做（5 次）；批准闭包 1/2/3
   重做 + 4 携带（7 次）；SHA 篡改使 2/3 证明断裂重做 + 范围内 4 重做 + 1 携带（7 次）。
2. N1：跨 run carried 账本项现一律绑定已核验的实际输入身份
   （paidItemWithReferenceIdentity：reference SHA、executionDigest、input fingerprint），
   当前 run 操作 id 可变、内容身份不得退回未解析。
3. F3：media/director-only 返工的新 run 从返工源 run 的 planning history+checkpoint
   跨 run 播种未受影响阶段（treatment/script）；编剧被点名时（screenwriterReworkContext
   实质相关）不启用源 run 继承，保持全重跑。seedJointPlanningThread 增加 priorRunId。
4. F5：note-only 合同——用户显式"整体/全部"措辞 = 全片范围选择（整体意图解析，
   修复 note-only 测试的 [1,2,3,4] 断言）；真正无法定位的拒绝说明 → 草稿
   scopeState="needs_scope"（含 scopePrompt），startRun 对空范围拒绝开跑
   （StudioReworkDraft DTO 增加 scopeState/scopePrompt；server.test/client.test fixture 同步）。
5. N6：双审聚合 findings 容量 = 单分支 50 × 2 = 100（两个合法分支合并 51+ 不再被
   前置边界拒绝）；单分支 50 不变。
6. N7：joint 影响摘要——script 调用计数优先读 legacy script 节点；joint 时读
   creative-planning receipt，无逐 producer 统计时报 "unknown"（类型放宽为
   number|"unknown"，shared/api.ts 同步），不再把真实执行显示成 0/not_run；nodes 投影
   在 joint 下含 creative-planning。

测试裁决（三项原失败）：
- carries-an-unaffected-multi-level-reference-chain（4≠5）：PRODUCT_BUG（范围未消费），
  修复后按合同通过；新增结构断言随既有用例保留。
- regenerates-the-full-human-approved-closure（4≠7）：PRODUCT_BUG，修复后通过。
- refuses-to-inherit-unprovable-reference-SHA（6≠7）：PRODUCT_BUG，修复后通过
  （证明断裂的 2/3 与范围内 4 重做，1 携带）。
- note-only（[]≠[1,2,3,4]）：BOTH——显式整体措辞属全片选择（已解析支持）；
  真正无法定位进入 needs_scope（新合同），不默认全片也不静默空跑。

修改文件：
  packages/production-pipeline/src/generative-asset-worker.ts（范围排除 + N1 绑定）
  packages/production-pipeline/src/codex-visual-review.ts（聚合容量 100）
  packages/production-pipeline/src/production-pipeline.ts（F3 跨 run 播种 +
    screenwriterReworkContext + N7 摘要）
  apps/studio/src/server/production-studio.ts（整体意图解析 + needs_scope + startRun 守卫）
  apps/studio/src/shared/api.ts（StudioReworkDraft.scopeState/scopePrompt、
    rework calls.scriptModel 类型）
  测试：server.test.ts、client.test.tsx（fixture 加 scopeState）、
    production-planning-closure.test.ts（tokens helper + rankCheckpoints，
    属 B4 修复轮延续）

验证（最终状态，全部 exit 0）：
  build:pipeline 0；B5 聚焦+B1-B3（generative-asset-worker 96、codex-visual-review、
  contracts、creative-planning 70、store、treatment 合计）247/247；B4 关键回归
  （closure 20 / reference-grammar 9 / preflight 6 / publication 4 / run-store /
  workflow-runner / executable-plan / executable-timeline）127/127；studio node
  （joint-rework 3 / editing / stages / api-contract）35/35；vitest 176/176；
  npm run typecheck exit 0；git diff --check exit 0。
  共享扫描 231/237：较进入时净修复 2 例（quotes-only-changed-paid-scenes、
  note-only），其余 6 例与进入前同名同因（stale-token/scene-revision/库存同步，
  属 C2/B4 遗留），零新增回归。

未通过或未验证项（如实单列，未顺手实现）：
  - N4：双审共同不可变 evidence envelope + 分支实际消费 snapshot identity 核验——未实现。
  - N5：identity collision 只失效外层缓存，内层 role checkpoint/请求身份未贯通；
    真实 role-loop 恢复回归缺失。
  - V03 补证停顿状态、V07/V08 部分恢复语义、V11 voice timing 后 membership 完整性、
    V13-V15 双审偏序完整集成、真实 Python 离线库存物化、accepted-后 kill 窗口：UNVERIFIED。
  - 共享扫描剩余 6 例维持既有归属，不计入 B5 完成。
外部调用、费用、commit/push/deploy：无。
停止位置：B5 本地实现完成（P1 三项失败与 F3/F5/N6/N7 关闭，N4/N5 如实未做），
停止等待 B4+B5 合并 Oracle 审计。不进入 C1。
```

---

## 后续阶段记录模板

```text
任务 / 日期：
执行者实际模型与 thinking：
进入时 HEAD、branch、status、diff：
预期用户行为：
失败证据：命令、exit、关键断言、证据路径：
根因：
修改文件及必要性：
聚焦验证：
类型/构建/回归：
进程/并发/恢复证据：
外部调用、费用、taskId 与未知结果：
未通过或未验证项：
停止位置：
```

---

## VF-RECOVERY 修复轮 2（审计响应，进行中）

任务 / 日期：B4+B5 合并审计 CHANGES_REQUIRED 的修复 / 2026-09-11
执行模型：glm-5.3-flash[1M]（一致）。
基线：HEAD 570fe6e（未变），审计 transcript 见 oracle/results/B4B5_MILESTONE_ORACLE_TRANSCRIPT.md。

本轮已关闭（全部有回归）：
- BG-01：引用闭包 membership 绑定当前 effective output version（joint only；
  currentPlanningVersionArtifactIds 读 run.json；legacy 显式兼容不约束）；joint 必须引用
  creative_treatment（缺失 fail closed）。
- BG-02：commit 已写但产物部分持久化时不再永久拒绝——落入 leftovers 续齐分支
  （按重放内容补登记缺失 kind、provenance 按 kind 写真实来源、整组重写同一 commit）；
  tamper 组 "unknown artifact id" 变体改为修复语义断言（角色 0 重跑、commit 只引用
  已登记产物），其余损坏变体仍 fail closed。
- BG-03：排序证据跨 run 携带时 carriedStageInputIdentities.rank 同 checkpoint 保存；
  无 history 恢复分支按 carried identity 核对，不一致强制真实重排。
- BG-04：startRun 对显式空数组路径同样执行 needs_scope 守卫；holisticReworkIntent
  排除否定式（"不要全部"）。
- BG-06：media-only 返工不再生成默认 script 指令（空串=编剧未点名）；
  contracts.parseReworkContext 允许空串（boundedOptionalReworkText）；
  production-joint-rework 测试更新为新合同（编剧 0 调用、treatment 跨 run 继承 0、
  导演携带返工上下文重跑）。
- BG-07：dispatchSceneRevision 失效集合补 voice（assets 后代）；TTS 自动执行语义下
  重合成新版本+新 receipt；production-pipeline.test 同步。
- BG-08（部分）：双审分支各收 structuredClone 独立证据副本；共同快照执行前后完整性
  核对（被改写即抛错）；evidenceSnapshotId 进分支输入并回写 execution 供汇总核对；
  codex-visual-review.test 快照断言改为"同内容不同引用"。
- BG-09：candidateInventorySha256 进图状态/执行记录/seed 携带；恢复时校验库存文件
  指纹（缺失/被替换 fail closed，不消费）。
- BG-10：joint 下 planning 节点已执行但缺 receipt 时 scriptModel="unknown"。

验证（本轮完成后）：build:pipeline exit 0；B4+B5 pipeline 全量 374/374；
production-pipeline 91/91；joint-rework 3/3；closure/grammar/preflight/publication/
generative/contracts 合并 156/156；typecheck exit 0；git diff --check exit 0。

仍未完成（下一轮，方案已固化 /tmp/vf-fixround-notes.md）：
- BG-05：regenerateScenePositions 与重判边界分离；carry 证明失败项进 needs_evidence
  停顿（worker diagnostics + pipeline 暂停），不自动转购买；三测试按新合同改写。
- BG-08 剩余：collision 冲突分支内层 checkpoint 带 nonce 重派 + 有界重试；真实
  role-loop 集成回归。
- BG-01 尾巴：声音修订后 inspectCreativePlanningStages 的 artifact 映射按当前 version。
- EVIDENCE：accepted-后 kill 窗口；四角色最终 Broker recording 材料；共享六红项归因。

外部调用、费用、commit/push/deploy：无。停止位置：修复轮 2 结束，剩余项见上；
未重新发起 Oracle（等 BG-05/BG-08/证据补齐后以新 slug 复审）。

---

## VF-RECOVERY 修复轮 3（EVIDENCE 部分）

- EVIDENCE 部分关闭：production-planning-publication.test.ts 新增 afterAccepted 窗口——
  start 返回（run CAS 已保存、正式身份被 run 接受）后对子进程 SIGKILL；全新恢复进程
  断言零角色重跑、正式 artifact 每类 1、commit 1、唯一 accepted output version。
  fixture 恢复循环按 run 状态收敛（needs_human 直接复用，不再轮询）。
- 验证：publication 5/5；closure/generative/visual-review/contracts 176/176；
  build:pipeline / typecheck / git diff --check 全部 exit 0。

剩余不变（见 /tmp/vf-fixround-notes.md）：BG-05、BG-08 剩余、BG-01 尾巴、复审材料附全。
停止位置：修复轮 3 结束；未重新发起 Oracle。

---

## VF-RECOVERY 修复轮 4（BG-05 / BG-08 / EVIDENCE 收口）

- BG-05（A 方案，用户决策）：needs_evidence 停顿落地——
  safelyCarriableReworkItems 对证明失败且不在人工批准重做范围内的母片抛出
  ReworkEvidenceRequiredError（列出镜头 2、3 与"未产生任何新购买"），在报价/准备
  边界 fail closed；新媒体 create=0；源 ledger/反馈保留。测试 3 改写为新合同
  （rejects + getPaidCalls=4）；测试 1/2 不受影响（范围内显式重生成仍被批准执行）。
- BG-08（有界碰撞重试）：碰撞墓碑记录 attempts；priorAttempts>=1 时停止并要求人工
  核对模型配置（IndependentVisualReviewError），不无限重置、不引入第三模型。
  内层 checkpoint nonce 重派仍未做（无 history/role-loop 改动），如实单列。
- 验证：B4+B5 全量 19 个测试文件 501/501 fail 0；typecheck exit 0；git diff --check exit 0。
- 剩余（未做，如实单列）：BG-01 尾巴（声音修订后 stage 投影按当前 version）；
  BG-08 内层 checkpoint nonce；真实 Python 物化；四角色 Broker recording 材料附全。
- 外部副作用：无。停止位置：修复轮 4 结束；等 BG-01 尾巴与材料补齐后以新 slug 复审。

---

## VF-RECOVERY 修复轮 5（BG-01 尾巴收口）

- BG-01 尾巴关闭：inspectCreativePlanningStages 的 compile 阶段投影优先使用 planning
  节点当前 effective output version 的 executable_plan 产物（声音时长修订后指向新
  plan，不再永远指向原始 graph commit）；treatment/script/director/candidates/rank
  仍按 commit 映射（未被修订替换）。
- 验证：stages/preflight/closure 36/36；B4+B5 全量 501/501；typecheck、
  git diff --check exit 0。

## 修复轮总览（对照 BG-01..10 + EVIDENCE）

全部关闭：BG-01（membership + joint treatment 必需 + 投影按当前 version）、BG-02、
BG-03、BG-04、BG-05（A 方案 needs_evidence）、BG-06、BG-07、BG-08（隔离副本 +
snapshotId 核验 + 有界碰撞重试）、BG-09（路径+内容指纹绑定）、BG-10。

如实未做（非代码项/外部项）：真实 Python 离线物化运行；四角色最终 Broker recording
的独立复核材料（creative-planning.test.ts 70 例已存在，复审时附全文）；内层 role
checkpoint nonce 重派（现有有界停止保证不会无限重试）。

外部副作用：无 Provider 调用、无付费、无 commit/push/deploy。
停止位置：BG-01..BG-10 全部代码项收口完成，等 B4+B5 合并 Oracle 复审（新 slug
vf-b4b5-milestone-audit-20260911-03），不进入 C1。

---

## VF-RECOVERY-C1：制作范围授权与精确消费闭环

```text
任务 / 日期：VF-RECOVERY-C1 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（与配置一致），最高可用 thinking。
进入时基线：B 里程碑放行（B4+B5 全量 501/501）；C1 24/25（1 红卡 awaiting_spend_
approval，旧 intentDigest fixture）；C2 service/API 158/165（7 红为 C2 范围）。
用户指示：从 C1 开始连续完成整个 C 阶段，阶段边界不停顿。

失败证据（进入时重放）：
  - production-authorization.test.ts 24/25；"auto-continues a covered quote with a
    derived sub-authorization" 断言 awaiting_spend_approval —— PRODUCT_BUG+STALE_TEST：
    测试签发端使用旧 SHA256(item.id) intent，宿主消费端已是 canonicalProductionAsset-
    IntentDigest(planDigest, assetKey)；同时宿主派生子凭证时收窄 maxCostCny/maxAttempts
    却引用原 plan id，必然被原 exact matcher 拒绝（C1-R3 双缺口）。

根因与关闭方式：
  1. C1-R1 严格链校验器：新增 inspectProductionAuthorizationChain（absent/committed/
     integrity_error），接受（acceptProductionAuthorization）与读取（readProduction-
     Authorization）共用；损坏/外 run/分叉/零幸存者一律 integrity_error，不再把损坏
     解释成 undefined 空链接受新首份授权。
  2. C1-R2 physical fold 重做：同一 itemRequestId 冲突记录拒绝（不再后行覆盖）；组内
     结算/占用事实按内容选择而非数组顺序（alias 旧估价不能覆盖真实结算，两种输入顺序
     结果一致）；受理未定价（taskId 无 actualCost）按组内最高估价保守占用；明确未受理
     （无 task 无费用）不占用不计次；checked integer 累加防溢出。
  3. C1-R3 身份与子凭证：测试签发入口改用与正式 issuer 相同 helper（canonicalProduction-
     AssetIntentDigest + canonicalQualityContractDigest）；旧 hash 只保留为拒绝用例；
     子凭证与当前报价计划逐字段一致（maxCostCny/maxAttempts 不再收窄——收窄的 draft 必然
     被 matcher 拒绝）；范围收窄移到预留层：SpendAuthorizationDraft 新增 derivedFrom-
     ScopeId 与 itemCreateBudgets（workflow-core 最小内部字段，不参与 matcher），
     scope 每素材次数预算经 provider run() 透传 worker parameters，worker 在每个
     create 边界按"历史叶子 create 事实 + 1 ≤ 预算"强制执行（preparePaidAssetOperation
     返回 priorCreateAttemptsByQuoteItem）。
  4. C1-R4 金额口径：request_approval(amount) 的 additionalCents 改为总增量口径
     （quote - available，可用为负时含超占用回补；1000/1100/100 → 200）。
  5. supersession 防护：dispatchSpendAuthorization 增加可选 guard，在持锁 CAS 边界内、
     runner 接受子凭证前重读授权链，head ≠ 覆盖判定所用 scope 即拒绝（已被替代的
     scope 不得为尚未开始的新请求签发子权限）。
  6. C1-R5 结构化评估：新增 assessProductionSpendPlan（逐项 decision + 可区分原因
     amount/scope/attempts/quality + 精确金额/缺失目标/追加后上限）；scopeCoversSpendPlan
     变为其派生；assessProductionScopePendingQuote 返回结构化结果（missing_plan/
     unreadable_plan/plan_digest/quality_contract/empty_quote/ledger_evidence/quote_items）；
     未覆盖时经 recordNodeSpendAssessment 持久化到等待节点（NodeRun.spendAssessment
     新字段，CAS 预检查+持锁复核，并发变化放弃写入），计划最高占用（含重试余量）不足时
     给出精确缺口。派生成功后链返回更新后的 run。

修改文件：
  packages/production-pipeline/src/production-authorization.ts（fold 重做/overcommit/
    assessProductionSpendPlan/结构化类型）
  packages/production-pipeline/src/production-pipeline.ts（严格链校验器/评估驱动的
    continueCoveredSpendApproval/guard/itemCreateBudgets 透传/recordNodeSpendAssessment）
  packages/production-pipeline/src/generative-asset-worker.ts（priorCreateAttemptsByQuoteItem/
    create 边界预算强制/optionalNumberRecord）
  packages/workflow-core/src/types.ts（derivedFromScopeId/itemCreateBudgets/spendAssessment）
  测试：production-authorization.test.ts（canonical 签发入口、旧 intent 拒绝、终点断言、
    子凭证 matcher 一致性、fold 5 例、overcommit、损坏链 fail-closed）

聚焦验证（全部 exit 0）：
  - build:pipeline exit 0。
  - production-authorization.test.ts 33/33（原 25 + 8 新）。
  - 组合（authorization + generative-asset-worker + workflow-runner）192/192。
  - B 回归（closure/reference-grammar/preflight/publication/contracts/production-pipeline）
    158/158。
  - npm run typecheck exit 0；git diff --check exit 0。

外部调用、费用、taskId 与未知结果：无。测试全部本地替身 transport。
未通过或未验证项：
  - C2 7 红维持既有归属（studio-service 4 个缺并发 token、server 1 个 stale、
    authorization-api 2 个签名/断言），归 C2 修复。
  - L3 进程级 crash 注入（grant 写入后/run CAS 前 kill 等）本阶段以既有 L2 幂等重放
    （prepared/accepted receipt）+ guard/预检查覆盖，未新增 kill 子进程测试；
    生产者/消费者跨进程 create 计数证据由既有 publication 测试家族覆盖，未单列新造。
  - L4/L5：not_run（授权范围外）。
停止位置：C1 本地实现完成，按用户指示直接进入 C2，不等待阶段审计。
```

---

## VF-RECOVERY-C2：报价、追加、调整、暂停与恢复体验

```text
任务 / 日期：VF-RECOVERY-C2 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（与配置一致），最高可用 thinking。
进入时基线：C1 完成后工作树；C2 service/API 158/165（7 红），UI 256/256。
用户指示：连续推进，不在阶段边界停顿。

失败证据与裁决（7 红逐项）：
  - studio-service 4 例（removes a model override / resumes from assets / replans
    direction / keeps private candidate inventory）STALE_TEST：旧请求缺 B4 并发
    token（expectedRunRevision / expectedVersionId）→ 409 StudioConflictError。
    修复：测试按新合同补 caller tokens（run revision 0 + assets-input-v1 基线）。
  - server 1 例（exposes cost ledgers…）STALE_TEST：execution-configuration 与
    input-override payload 缺 expectedRunRevision/expectedVersionId → 400。
    修复：payload 补 token（input-override 为 1/script-input-v1）。
  - production-authorization-api 2 例：amend 测试按旧 2 参签名调用且客户端自报
    additionalCents（PRODUCT_BUG 测试侧，违反"服务端权威差额"合同）；HTTP 层 fake
    的 amendProductionScope 也按旧签名捕获 → 记录 'amend:undefined'。
    修复：测试改用新合同 (runId, authorizationId, input, actor) + 服务端 funding
    request；并按真实资金缺口流程重建场景。

根因与关闭方式：
  1. 先展示再接受（C2-R4/RC2-02）：NodeWorkspace 的 authorizeProductionScope 一次
     点击完成 prepare+authorize——违反"不能在一次点击里 prepare 后自动 authorize"。
     拆为两阶段：第一次点击"获取费用报价"只 prepare（media create=0），面板展示
     服务端报价（预计/最高/逐镜模型与费用/不确定项）；第二次点击"确认并授权（最高
     ¥X）"才以同一 quote identity + 稳定幂等 key 接受。pendingQuote 记录 prepare 时
     revision；用户修改额度输入即作废已展示报价。
  2. funding 三动作（RC2-05）：C1 结构化评估经 toRunDetail 投影到节点
     （StudioNode.spendAssessment 新字段）；评估驱动三动作面板——
     "同意追加 ¥X 并继续"（prepare 生成服务端 funding request → amend 以
     fundingAuthorizationId 为 URL 合同 id，客户端不自报差额）、"调整方案"（复用
     既有返工意见面板）、"暂不继续"（持久暂停 onRequestPause）。
     quote DTO 新增 fundingAuthorizationId（funding.authorizationId == active head）。
  3. 非整数分拒绝（RC2-03）：prepare 对 requestedMaximumCny 做整数分核验（容差只
     吸收二进制浮点表示误差，8.006 元拒绝、8.01 元通过），不再静默四舍五入成 601 分。
  4. 追加场景重建（真实缺口）：harness 改直连 seedance provider（router 合成
     metadata 硬编码 maxAttempts=1 导致永远无金额缺口），maxAttempts=2 下
     maxCostCny=2×estimated：首授权只批 estimated → 覆盖判定失败保持等待（C1 评估
     落盘）→ prepare#2 生成 funding request（差额=服务端计算）→ amend → 新 scope
     完整覆盖 → 自动继续。逐断言验证：等待时不继续、追加后继续、delta 叠加不清零、
     supersede 链、幂等重放无双 delta。

修改文件：
  apps/studio/src/server/production-studio.ts（spendAssessment 投影/fundingAuth-
    orizationId/非整数分拒绝）
  apps/studio/src/shared/api.ts（StudioSpendAssessment/quote.fundingAuthorizationId）
  apps/studio/src/client/components/NodeWorkspace.tsx（两阶段报价 UI/funding 三动作
    面板/spendAssessmentHeadline 文案）
  测试：production-authorization-api.test.ts（amend 新合同+真实缺口流程+非整数分
    +5 例）、node-workspace.test.tsx（两阶段断言+funding 三动作测试）、
    client.test.tsx（两处两阶段合同同步）、studio-service.test.ts（4 例补 token）、
    server.test.ts（2 处 payload 补 token）

聚焦验证（全部 exit 0）：
  - C2 service/API 组合 166/166（原 7 红全关+新增用例）。
  - studio vitest 257/257（client+node-workspace+creative-os）。
  - B 回归（planning-editing/stages/joint-rework/C1 authorization）53/53。
  - npm run typecheck exit 0；git diff --check exit 0。

外部调用、费用、taskId 与未知结果：无。
未通过或未验证项：
  - C2-R6 浏览器 1440/390 截图证据：not_run（无浏览器授权），组件级交互测试已覆盖
    两阶段与三动作行为；真实浏览器留待 C6 集中验证或用户授权后补证。
  - reload 恢复 pending quote 的跨会话持久化：pendingQuote 是会话内状态，刷新后用户
    重新点"获取费用报价"即可（服务端 quote 落盘幂等，不产生新授权）；完整 reload
    投影验收留待 C6。
停止位置：C2 本地实现完成，按用户指示直接进入 C3。
```

---

## VF-RECOVERY-C3 / C4 / C5：选题模板偏好、低门槛主线与模型可靠性

```text
任务 / 日期：VF-RECOVERY-C3、C4、C5 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（一致），最高可用 thinking。
进入时基线：C2 完成后工作树；全部聚焦测试绿。

C3（热点发散、模板和偏好质量）：
  - E01 PRODUCT_BUG 修复：TrendOpportunityAgent.listCandidates 的 modelCandidates 以
    signalId 为键——同一 canonical 事件的多个模型角度只保留第一个，直接违反"同一事件
    允许多个 angleId"。改为角度身份集合（editorialAngleKey = 归一化标题+受众+题材）：
    受众/收益不同的方向全部保留，只有同角度重复才去重。新增测试：同信号 3 个不同
    受众方向全部保留（id 与受众互不相同）+ 重复角度去重。
  - E02 修复：换一批原先请求体与 checkpoint key 完全相同——强制刷新会重放上一次的
    checkpoint 结果而非新一批。topic-ideas 请求新增 generationNonce（C3 合同：
    focus/creator intent 已有，nonce 本阶段补齐）；TrendStudio 强制刷新生成全新 nonce
    （createGenerationNonce，默认 randomUUID），普通读取/自动刷新不带 nonce 不重复
    生成。新增测试：普通读取无 nonce、换一批 nonce-1、再换一批 nonce-2。
  - E03/E04/Q04 现状核验（有既有测试覆盖，未改动）：偏好经 formatTopicStrategy 进入
    真实 prompt 且 excluded/preferred 方向过滤有测试；无来源数字/引语/专名/clickbait
    的 grounding 拒绝与高风险保守回退有 5+ 例测试；模板 CRUD/版本/恢复/发布走
    revision 保护路由有测试；推荐只引用 published 模板且手选不被覆盖
    （recommendUntouchedTemplate 仅在未手动选择时生效）。

C4（低门槛主线与高级能力）：
  - needs_human 差异化现状核验：spend 节点显示"确认{角色}"+两阶段报价面板（待确认
    方案/费用）、funding 面板（待追加费用，C2 新增）、intervention 面板按服务端原因
    文案展示（待补来源/待看成片/审片建议），不统一为"等你审片"。
  - stale 素材文案修复（C4 合同"重新检查适用性，不写成全部重新生成"）：
    NodeWorkspace stale 警告补"仍然适用的部分会自动保留，不会全部重做"；素材预览
    副标改为"将重新检查适用性，只重做不再适用的部分"；RunWorkbench stale 状态文案
    改为"重新检查每一步是否仍然适用，只重做失效的部分，保留仍然有效的成果"。
  - 高级能力未被主线简化删除：脚本/分镜/声音/模型编辑、双审证据、逐 finding 定位、
    首选/备选模型、能力分组选择器均在现有组件中核验存在。

C5（文本模型速度、可靠 fallback 与质量）：
  - 分段计时现状核验（已有实现，本阶段未改动）：broker 队列 queueWaitMs（排队）、
    providerWaitMs（请求到响应）、validationMs（解析/合同校验）、role-agent-loop 的
    produce/audit phaseDurationsMs + phaseAttempts + retriedRequestIds（审计/重试）、
    Codex 流式 firstOutputEventMs；ZAI（非流式 GLM）只记 providerWaitMs，不编造
    首 token 指标。
  - 故障分类现状核验：fallback-role-agents 测试矩阵已覆盖——not_accepted 各类别
    （连接拒绝/429 等瞬态）按原策略切 backup；uncertain 超时与 completed
    invalid-output 不切 backup（已受理未知不重发）；业务校验失败立即停止；
    每 backup 模型独立 checkpoint 恢复不重复调用；用户首选模型优先且成功后不再
    调用更低候选。requestId/attempt/model/provider/failureDetails 全程可追溯。
  - 重复规划/审计消除：B4/B5 的调用计数测试（角色 0 重跑、审计只补失败分支等）
    全部保持绿色。

聚焦验证（全部 exit 0）：
  - trend-opportunity-agent 34/34（+E01 新测试）、trend-studio 12/12（+E02 新测试）、
    trend-topic-pipeline/gateway/taxonomy/template-* 合计 83/83。
  - C5 相关（fallback-role-agents/fallback-task-client/codex-chat/codex-executor/
    broker-server）142/142。
  - UI 测试 177/177（文案变更后无断言回归）。
  - npm run typecheck exit 0；git diff --check exit 0。

外部调用、费用、commit/push/deploy：无。
未通过或未验证项：
  - M01/M02 真实双模型 planning 运行、M04 前后延时对比：L5 范围，无授权 not_run
    （故障注入矩阵已由替身测试覆盖）。
  - C4 的 1440/390 真实浏览器截图（U06）：无浏览器授权，not_run；组件级交互测试
    覆盖行为，布局截图留待 C6/用户授权。
停止位置：C3/C4/C5 本地实现完成，进入 C6 集中验证。
```

---

## VF-RECOVERY-C6：集中本地验证

```text
任务 / 日期：VF-RECOVERY-C6 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（一致），最高可用 thinking。
环境：/opt/homebrew/bin/node v26.8.1（ABI 147，与 better-sqlite3 binding 匹配）；
SQLite 规划测试经该 Node 运行，未用 MemorySaver 绕过，未改源码/lockfile。

集中验证结果（全部真实 exit 0 / 0 fail）：
  - npm run build:pipeline：exit 0。
  - npm run test:ts（全部 package 测试，759 项）：pass 758 / fail 0 / skipped 1。
    唯一 skip：e2e.real.test.ts（由 VIDEO_FACTORY_E2E=1 门控的真实媒体/付费 E2E，
    属 L5 授权范围，是已解释的文档化 skip，非未解释 skip）。
  - npm run studio:test（build + studio 全量 node --test，472 项）：472/472。
  - npm run test:broker（156 项）：156/156。
  - npm run test:package（3 项）：3/3。
  - npm run build（broker + studio 前端，vite build）：exit 0（chunk 体积警告非错误）。
  - npm run typecheck：exit 0。
  - git diff --check：exit 0。
  - 关键 L3 复核（closure + publication 四窗口 crash + workflow-runner）88/88。
  - 扩展跨阶段回归（visual-review/screenwriter/asset-rank-fallback/executable-*/
    creative-planning*/treatment/reference-grammar/run-store/joint-rework/
    asset-semantic-ranker/contracts/publish-copy/fallback-task-client/preflight/
    reference-grammar/image-generation/python-worker-client/planning-editing/
    planning-stages/studio joint-rework）：172/172 + 102/102，0 fail。
  - Python worker 套件（uv run pytest tests/）：131 passed + 31 subtests，0 fail。
    进入时收集错误（ModuleNotFoundError: video_factory）为环境缺 editable install，
    经 uv run pip install -e . 修复后全部通过；无源码修改。

验收覆盖映射（本地可验证部分）：
  - 三个入口/规划/报价/授权/追加/暂停恢复：C1/C2 service+UI 测试（166+257）。
  - 素材复用/生成素材/配音/双审/打回/局部返工：B5 + production-pipeline + joint-rework
    测试族（759 项 package 测试内）。
  - 素材失败停在可操作状态：worker 失败语义测试（manualReconciliationRequired、
    terminal_failed 需新授权、needs_evidence 停顿）保持绿色；无说明卡伪装成功路径。
  - 双审同证据/单审不发布：codex-visual-review + BG-08 断言保持绿色。

外部调用、费用、taskId 与未知结果：无。全部测试使用本地替身 transport。
未通过或未验证项（如实单列）：
  - 真实付费媒体/真实双模型的 L5 验证（三条真实成片、云端 E2E）：无授权，not_run。
  - 1440/390 真实浏览器截图：无浏览器授权，not_run（组件级交互测试已覆盖行为）。
  - 部署（GitHub Actions/阿里云）：无授权，not_run。
停止位置：C6 本地集中验证完成，发起 Oracle Web 第 5 档统一审计。
```

---

## VF-RECOVERY-C6：Oracle Web 统一审计与集中修复轮

```text
任务 / 日期：C 阶段统一 Oracle 审计 + findings 集中修复 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（一致），最高可用 thinking。

审计会话证据：
  - skill：oracle-web 0.17.3（调用前完整重读 SKILL.md；未使用旧 oracle；未检查/升级 CLI）。
  - slug：vf-c-stage-unified-audit-20260912-01（全新唯一 slug，新 conversation）。
  - 会话 URL：https://chatgpt.com/c/6aa439e3-61d0-83ed-94b4-674ca211aedf
    （meta.json tabUrl/conversationUrl 均为该新会话；promptSubmitted=true）。
  - 强度：thinking-time 控件实际显示 "Pro，第 5 项，共 5 项"（verified=yes，
    source=thinking-time-control），CLI --browser-thinking-time max。
  - 用量：↑101.19k ↓3.73k，25m07s；13 个附件文件（约 377KB）。
  - 运行后清理：记录的 chromePid 98113 已退出，临时 userDataDir 已删除。
  - 完整 transcript：oracle/results/C_STAGE_UNIFIED_ORACLE_TRANSCRIPT.md。

Verdict：CHANGES_REQUIRED（6 P1：CG-01..06；2 P2：CG-07/08；无可确证 P0）。

逐项核对结论与修复（全部采纳并有回归；无被拒绝的 finding）：
  - CG-01（P1 授权命令恢复）：amend/authorize 重放原先重新构造 amendment（新
    approvedAt）导致"同 id 不同内容"永久卡死；且"授权已提交"分支不补完续链。修复：
    重放复用 prepared receipt 保存的原始 scope 字节（字节一致才能通过宿主幂等接受，
    revision 过期仍被拒）；已提交分支调用新增的 pipeline.resumeCoveredSpendApproval
    幂等恢复 governed continuation 并补齐 accepted receipt；历史 accepted 且已被
    supersede 的旧命令重放返回当前 run（不再抛冲突）。测试：prepared receipt 崩溃
    残留恢复（fixed approvedAt 证明字节复用）+ 幂等重放无二次 delta。
  - CG-02（P1 链校验不完整）：inspectProductionAuthorizationChain 原先只统计幸存者；
    现消费 committed artifact 记录（id/uri/sha256）：内容摘要核验、文件身份==scope.id、
    唯一 head 后沿 supersedes 回溯——无环、无缺失前驱、全部 committed 记录可达；
    接受与读取两侧同一实现同一内容完整性。测试：schema 合法但前驱缺失的篡改
    （同步伪造 artifact 摘要）fail closed。
  - CG-03（P1 评估非整份计划口径）：assessProductionSpendPlan 重写——非金额阻断
    （scope/quality/attempts）逐项收集且优先报告（加钱不遮盖）；金额需求 = 非金额
    可行条目合计与 planMaximumCents（计划最高占用）取大，顺序无关；宿主原独立
    plan-max 分支并入评估统一产生。被 scope/quality 阻断的素材不计入"加钱即可解决"
    的追加额（避免误导用户为仍无法运行的内容付钱）。测试：双金额项两顺序同结果
    （1300/800）、金额+quality 混合阻断 reason=quality、计划重试余量缺口 720。
  - CG-04（P1 角度身份不统一）：candidateId 改为 hash(signalId+title+audience+track)
    ——与 editorialAngleKey 同一投影；同事件同标题不同受众拥有不同可寻址 id，
    跨事件相同标题/受众不误合并。E01 测试断言 id 互不相同保持绿色。
  - CG-05（P1 grounding 双向缺口）：unsupportedHighRiskAssertion 改为子句级检查——
    问句子句（核验问题）允许，陈述子句的新增事实断言不再借问号整体豁免
    （"救援已经结束，为何还要关注？"被拦）；unsupportedClaim 增加结构数量豁免
    （小整数 + 封闭结构量词集合：步/招/种方法/个方法/个技巧/条建议/个习惯），仅在
    非高风险题材启用（高风险新闻数字一律按事实）。测试：常青"用3步"通过；
    高风险断言+问号回退保守问句；既有"计划内无来源 20 分钟拒绝"保持绿色。
  - CG-06（P1 无界会话重建）：executeOperation 的 409 分支新增持久化、有界的
    sessionRebuilds 预算（每 phase 上限 2 次受控重建），超限停止并保留原因；
    checkpoint 恢复不重置预算（旧 checkpoint 容错按 0 恢复）。测试：连续 409
    三次调用后停止、requestId 各不相同、跨"进程"恢复预算不重置。
  - CG-07（P2 解析器弱于声明合同）：parseModelIdea 强制 visualPlan 存在且合法、
    novelty/seriesPotential/monetization 必须为 0–100 整数；缺字段 idea 整体拒绝
    进入修复循环；TOPIC_EDITOR_AGENT_CONTRACT_VERSION 升级（validator-v5 +
    angle-identity-v1）使旧 checkpoint 不再复用。4 个 payload 捕获类 fixture 按
    新合同补最小视觉方案（STALE_TEST 同步）。
  - CG-08（P2 uncertain 文案误导）：creatorMessageFor 消费受理阶段——uncertain
    输出"结果未知…核对原有任务结果，不要重新发起同样的请求"；仅确证未受理才建议
    重试/换模型。2 处旧文案断言同步（STALE_TEST：role-agent-loop、codex-visual-review）。

Oracle 未验证清单的处理：其"节选材料造成的 UNVERIFIED"条目（完整 authorize、guard
  执行位置、itemCreateBudgets 全链、model-fallback 矩阵、B5 消费链、模板/接线）
  均为当前仓库已存在实现，本轮未发现反证；相应文件在仓库中可复核，不重复展开。

集中修复后最终回归（全部真实 exit 0 / 0 fail）：
  - npm run build:pipeline：exit 0。
  - npm run test:ts：764 项，pass 763 / fail 0 / skipped 1（e2e.real L5 门控，已解释）。
  - npm run studio:test：475/475。
  - npm run test:broker：156/156。
  - npm run build：exit 0；npm run typecheck：exit 0；git diff --check：exit 0。

外部调用、费用、commit/push/deploy：无。
未通过或未验证项：与上一条 C6 记录相同（真实付费 L5、真实浏览器截图、部署——无授权）。
停止位置：Oracle findings 集中修复完成并通过全量回归；未再次发起 Oracle
  （按用户指示：集中修复一次回归，不逐 finding 重复审计）。剩余事项仅为
  真实付费 E2E、commit、push、GitHub Actions 部署与阿里云云端验收，
  等待用户一次性授权。
```

---

## VF-QA-R2-FIX：第一轮 QA 五问题集中修复 + 回归

```text
任务 / 日期：修复第一轮 QA 报告（VF-QA-20260912-01）确认的 ISSUE-001..005 / 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（一致），最高可用 thinking。

进入时基线：
  - HEAD 570fe6e，branch codex/final-dual-review-cloud-acceptance，
    脏工作树（A/B/C 全部累计未提交实现，有意保留；未执行 reset/stash/checkout/clean）。
  - 上一轮验证基线：test:ts 763/0/1 skip、Studio 475、Broker 156、build/typecheck/diff-check exit 0。
  - 进程：Studio PID 98045（127.0.0.1:4317，旧 QA 实例，workspace
    /tmp/vf-qa-workspace-20260912-0549）；Fake Broker PID 8446/8447
    （/tmp/vf-qa-fakebroker-5c0J/，codex.sock + zai.sock）。

五问题的共同根因与修复：
  - ISSUE-005（P3，服务端投影根因）：规则保底候选（providerId=trend-heuristic-v1）的
    editorialDecision 全部由 decideEditorialFormat 规则重算得出，从未经过选题总编模型，
    但来源补齐前客户端显示"内容潜力 80"（score.final），补齐后切到 editorialDecision.score=0
    并标为"总编评分 0 · 暂不生产"——把"尚未评估"投影成了"质量为 0"。
    修复：StudioEditorialDecision 新增 pendingEditorReview 可选标记；
    decideEditorialFormat 对 heuristic 候选统一打标（含 blocked 分支）；客户端
    （TopicEntryWorkspace 列表芯片/CandidateDetail 评分头/总编建议/核验块/采用按钮/
    candidateStatusLabel）按标记显示"待总编评估/来源已达标 · 等待总编评估"，继续展示
    内容潜力参考分；TrendRecoveryPanel 在全规则轮次改说"由规则保底生成，还没有经过
    选题总编评估"，不再谎称总编评估过。真实模型评估的 0 分仍如实显示（带总编口径）。
  - ISSUE-001（P1，搜索数据源根因）：全局搜索只覆盖静态功能入口与制作记录。
    修复：AppShell 首次打开搜索时并行装配 runs + templates + opportunities；
    新增"选题机会"（仅待制作状态、无 run 的机会，按来源跳 /topics 系 deep link）与
    "模板"（跳 /templates?template=<id>）两组结果；空结果文案改为
    "没有匹配的制作记录、选题机会、模板或功能…"；搜索框文案同步为
    "搜索项目、选题、模板或功能"。
  - ISSUE-002（P2，反馈与深链根因）：录入机会保存后静默成功，且 trend 入口看不到
    manual 机会。修复：TodayPage 新增 announceNotice 统一入口（清除过期跳转动作）；
    保存成功给出"已保存《标题》+ 去向说明"，非 custom 入口附带"去查看并制作"链接
    （/topics?mode=custom&opportunity=<id>）；TodayPage 支持 ?opportunity= 深链选中
    机会，displayedOpportunities 重置 effect 在加载完成前不再清空选中项。
    机会状态本身仍以服务端投影为唯一事实（两页共用 opportunity.status）。
  - ISSUE-003（P2，锚点根因）：DirectorPanel"查看缺失能力"只跳 /resources 顶部。
    修复：链接改为 /resources?missing=<缺失 capability 列表>#production-roles；
    ResourcesPage 初始分区改从 router location.hash 解析（刷新/直达可恢复），
    携带 hash 直达时把键盘焦点落到目标分区；production-roles 分区按 missing 参数
    给对应角色卡加 is-missing 高亮和"当前缺失"标记。系列锁与 NewRunDialog 既有的
    #production-roles 链接同享新分区定位。
  - ISSUE-004（P3，CSS 根因）：skip-link 原用 transform:translateY(-160%) 隐藏，
    几何位移在移动端弹窗等场景失效导致持续可见。修复：改为 opacity:0 +
    pointer-events:none 隐藏、:focus 显示——与元素被绘制的位置无关，对包含块/
    transform 失效类问题全部免疫，键盘可达性不变（390 弹窗开/关态留待真实浏览器复核）。

修改文件：
  - apps/studio/src/shared/api.ts（pendingEditorReview 类型）
  - apps/studio/src/server/editorial-decision.ts（heuristic 打标）
  - apps/studio/src/client/components/TopicEntryWorkspace.tsx（待总编评估展示 + 恢复面板文案）
  - apps/studio/src/client/components/AppShell.tsx（搜索数据源/结果/文案/深链 helper）
  - apps/studio/src/client/pages/TodayPage.tsx（保存反馈/深链/选中保护）
  - apps/studio/src/client/pages/TemplatesPage.tsx（?template= 深链）
  - apps/studio/src/client/components/DirectorPanel.tsx（缺失能力链接）
  - apps/studio/src/client/pages/ResourcesPage.tsx（hash 分区/焦点/缺失高亮）
  - apps/studio/src/client/styles.css（skip-link opacity）
  - apps/studio/src/client/studio-cplus.css（is-missing 高亮样式）

新增/修改测试：
  - editorial-decision.test.ts：新增 heuristic 全分支 pendingEditorReview 标记 + 模型候选无标记。
  - candidate-inbox.test.ts：新增"补齐来源后的规则保底候选保持 pendingEditorReview、
    模型评估的 0 分不带标记"。
  - creative-os.test.tsx：新增待总编评估展示（含与真实 0 分对照）、规则轮恢复面板文案、
    保存机会成功反馈+深链点击到达、深链重开选中、全局搜索命中机会/模板与空态文案、
    DirectorPanel 缺失链接 href、ResourcesPage 分区落点/缺失高亮/焦点；
    同步搜索框文案 9 处、"blocks production" href 断言。
  - templates-page.test.tsx：新增 ?template= 深链测试；10 处 render 包 MemoryRouter。
  - client.test.tsx：新增 skip-link CSS 合同测试（默认 opacity:0 + pointer-events:none，
    :focus 显示，且不再使用 translateY 隐藏）。

集中回归（全部真实 exit 0 / 0 fail；/opt/homebrew/bin/node v26.8.1，ABI 与
better-sqlite3 binding 匹配，未用 MemorySaver）：
  - npm run test:ts：764 项，pass 763 / fail 0 / skipped 1（e2e.real L5 门控，已解释）。
  - npm run studio:test：vitest 全绿 + node --test 476/476。
  - npm run test:broker：156/156。
  - Python worker（uv run pytest tests/）：131 passed。
  - npm run build:pipeline：exit 0；npm run build：exit 0（chunk 体积警告非错误）。
  - npm run typecheck：exit 0；git diff --check：exit 0。

范围外发现（如实记录，未修复）：
  - test/editorial-decision.test.ts 中"keeps everyday guidance with ambiguous words"
    一项失败（期望 product-demo、实际 human-mini-doc）。该文件不在任何正式测试脚本
    （test:ts / studio:test / test:broker 均不含）内，属孤儿测试；失败路径与本次修改无关
    （非 heuristic 输入行为逐字节不变），分类 STALE_TEST。留待下一轮决定：要么按当前
    形态规则更新断言并纳入正式套件，要么删除；不得为迁就它改规则模式。

未验证项：
  - ISSUE-004 在真实浏览器 390 宽、弹窗开/关态的视觉复核（第二轮 QA 承担）。
  - 五修复在真实环境下的手工回归（第二轮 QA 承担）。
外部调用、费用、commit/push/deploy：无。
停止位置：五问题修复 + 全量回归完成；进入 Fake 环境清理与真实本地部署。
```

---

## VF-REAL-LOCAL-QA-R2：Fake 清理 + 真实本地部署 + 第二轮真实 E2E QA

```text
任务 / 日期：第四~八阶段（Fake 清理 → 真实部署 → 真实付费授权 E2E → 报告）/ 2026-09-12
执行者实际模型与 thinking：glm-5.3-flash[1M]（一致），最高可用 thinking。

Fake 清理（核对后执行，无宽泛删除）：
  - 终止 round-1 QA Studio（PID 98045，env 确认连接 fake sockets）与 fake broker
    PID 8446/8447（cwd=本仓库、脚本头注释"一次性测试工具"）。
  - 删除 /tmp/vf-qa-fakebroker-5c0J（socket+logs+脚本）、两个 QA workspace、
    pid/auth-hash/build-log/server-log 等 6 个临时文件；删除仓库内
    fake-broker-20260912.js 与两份请求 jsonl。
  - 保留：QA 报告、全部截图；docs/qa/README.md 新增证据边界说明
    （25-*~33-* 标注为 Fake Broker 证据，不冒充真实模型证据）。
  - 验证：无 fake 进程/socket、产品代码零引用、正式测试 fixtures 完好。

真实本地部署（正式产物 + 真实凭据；凭据值未入终端输出/日志/报告/文件）：
  - Codex Broker：dist/main.js，隔离 CODEX_HOME（auth.json→~/.codex/auth.json 符号链接，
    codex CLI v20.20.2 已登录 ChatGPT），xhigh/xhigh，socket .local/runtime/codex/worker.sock。
  - ZAI Broker：--env-file=.local/secrets/zai-bigmodel.env，profile=zai（glm-5.3，effort=max），
    socket .local/runtime/zai-codex/worker.sock。
  - Studio：生产构建 node dist/server/server/main.js，:4317，workspace=workspace/factory
    （294MB 真实持久化数据，48 条历史 run），.env 自动加载（ARK/MINIMAX/PEXELS/PIXABAY 等），
    生产认证（scrypt），no_proxy=127.0.0.1,localhost 绕过公司代理。
  - 依赖：Python .venv 3.11.6（video_factory 可导入）、ffmpeg/ffprobe/say、
    4 个热点容器全部 200（Up 2 days）。
  - 核对：/api/providers 23 项能力全部 ready；双审=gpt-5.6-sol + glm-5.3-flash 两个不同身份；
    服务重启后 51 条 run 保留、会话保持；日志 0 fake/mock/fixture。

第一轮五问题修复的真实浏览器回归：001/002/003/004 全部通过（截图+href/computed-style/
焦点证据）；005 基本通过（不再出现"总编评分 0"），发现一个全部被阻断场景的恢复面板
文案残留（R2-ISSUE-004，P3）。

第二轮真实 E2E 结果（报告：docs/qa/videofactory-real-local-qa-20260912-02.md，截图 30 张）：
  - 走通：登录/三入口/模板 CRUD 全链/创作设置回显/素材库 43 项真实资产/复盘真实统计/
    系列创建→规则路线图→真实模型开拍复核通过（gpt-5.6-sol，标题被重写）→E01 采用/
    全局搜索三项数据源+深链/390+1440 响应式/重启持久化。
  - 新问题：R2-ISSUE-001（P1）topic-ideas 合同错配（Studio 发 creatorStrategy、
    broker 只收 strategy→400 静默回退规则候选，热点→制作链路断裂）；
    R2-ISSUE-002（P1）Studio↔Broker 长等待连接中断（4/4 复现；broker 侧 4 轮
    treatment+audit 全部成功完成 completed=15/failed=0，结果滞留幂等存储未送达）；
    R2-ISSUE-003（P1）uncertain 后"重试失败步骤"15-60ms 秒败死胡同、文案不更新、
    无 reconcile 入口；R2-ISSUE-004（P3）恢复面板文案缺口；OBS-R2-01/02/03。
  - 未验证（被 001/003 阻断）：媒体报价/两阶段授权/素材/渲染/双审/返工/真实费用核对。
  - 费用：无任何现金消费（媒体任务从未到达；文本任务订阅制）；
    4 条 run 账本均 0 记录，与 Provider 实际一致。
  - 未 commit/push；真实环境保持运行（Studio 77872 / Broker 46372/46486）。

下一阶段位置：等待下一轮集中修复（P0=R2-002+003 连接生命周期与 uncertain 恢复；
P1=R2-001 合同对齐+跨进程契约测试；P3=004/001-obs），随后重跑付费漏斗 E2E。
```
