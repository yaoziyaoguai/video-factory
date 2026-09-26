# 创作文字交付「初稿审一次」实施结果（执行者填写）

当前状态：`IN_PROGRESS（S4 四类交付全链 + S6 确定性验收 + 受控 QA 部分完成。Oracle r13 裁决：PASS / SCOPED_CONVERGED——R11-V01、R11-V02、R11-E01 CLOSED，R9-01 联动回归收口结束，本轮阻断整改循环关闭。放行仅涵盖创作规划审计链的操作身份绑定、旧绑定不改签、异常归属拒收、uncertain 优先传播及异常引用保持与相关确定性回归；不涵盖 W3/W5、reference-grammar 产品裁决、适配器完整回执绑定增强、Provider 全候选耗尽 P2、部署或项目整体验收。总体仍 IN_PROGRESS）`。工作树 66 modified + 19 untracked（85 项）全部保留。未 commit/push/deploy。

## 2026-09-25 接手基线（Claude Code，先验证后实施）

| 检查（Node 22.23.1 + 仓库 Python 运行时 `.local/python/.venv`） | 退出码 | 结果 |
| --- | --- | --- |
| `git diff --check` | 0 | 无空白错误 |
| `npm run typecheck` | 0 | 通过 |
| 完整 `npm test`（当前工作树，覆盖交接后 RunWorkbench 23:39 修改） | 0 | TS 1044 pass/0 fail/1 skip；Broker 265/265；Studio Vitest 541/541；Studio node 631/631；package 4/4；typecheck+build 同令完成。日志：`/tmp/videofactory-npmtest-takeover-20260924.log` |

此基线取代此前"23:15 日志早于 23:39 修改"的未决状态：交接疑虑已消除，当时工作树完整回归通过。

## 本轮新增（S4 增量，全部先红后绿）

### 1. 发布文案 AI 修订 + 主动再审（publish-package，合同 §0/§1/A02/A05）

- **Pipeline**（`packages/production-pipeline/src/codex-publish-copy.ts`）：`CodexPublishCopyWriter` 新增 `revise()`（单次 `publish-copy` 任务经既有 `revision` 通道携带 `{instruction, currentCopy}`，零 `role-audit`，出稿经 `validatePublishCopy` 硬校验；指令 1–4000 字门禁，越界零调用）与 `auditCurrent()`（单次 `role-audit`，与首审同一套 criteria，输出经 `validateRoleAudit`）。红绿证据：`codex-publish-copy.test.ts` 新增 4 例（10/10 exit 0）。
- **Studio 服务层**（`production-studio.ts`）：新增 `reviseNodeDocument`（修订产稿 → 复用 `prepareDocumentOverride` 写 `model-revisions/` 不可变新产物 + `contentReview=not_audited` + AI 修订出处 provenance → 走 `pipeline.applyNodeOverride` 持锁原子落盘）与 `auditNodeDocumentCurrent`（stale 双校验 run revision + 版本 id → 只审当前精确稿 → `contentReview` 更新并记录 `auditId/auditedAt/score`，稿件文件不变、零新产物）。两者未配置修订模型时如实拒绝（"没有可用的发布文案修订模型"），不退化。
- **伪造面补丁**：普通 output 编辑路径现在拒绝修改 `contentReview`（"审计状态由系统托管"）——此前旧产物 reference 已含该字段时存在手工改 status 的通道；主动再审走专用受控通道写入。
- **API/UI**：`POST /api/runs/:runId/nodes/:nodeId/document-revision` 与 `.../document-audit`；client API + `NodeDocumentCommands` 组件（建议复选、"加入修改意见（N）"只追加不覆盖不发送、发送/审计按钮、4000 字超限阻止发送且保留全文、失败保留草稿），接入 `NodeWorkspace` 发布文案交付区。红绿证据：`node-document-revision.test.ts` 6/6、`node-document-commands.test.tsx` 5/5、受影响 UI 测试 57/57，exit 0。
- **装配**：`main.ts` 将与首审同一 writer 传入 `StudioService.documentCopyTools`（同一模型配置，不另立旁路）。

### 2. 热点候选修订（topic-ideas，合同 §0/§A02"修订候选不自动审"）

- **模型层**（`trend-opportunity-agent.ts`）：`CodexTopicIdeaModel.reviseCandidate`——单次 `topic-ideas` 任务经 `revision` 通道携带当前候选与用户指令，零 `role-audit`；输出必须仍绑定原候选 signal，漂移拒收；`parseTopicIdeasOutput` 硬校验。红绿证据：`trend-opportunity-agent.test.ts` 新增 2 例（46/46 exit 0）。
- **Agent 层**：`TrendOpportunityAgent.reviseCandidate` 把修订稿构造为新收件箱候选（复用既有评分/构造链；修订无新正文来源，facts 保守清空，不冒充已核验）。
- **Studio 层**（`trend-studio.ts`）：`reviseCandidate(candidateId, expectedGenerationId, instruction)`——stale 校验（用户所见候选包版本不符即拒）；修订候选 `auditStatus:"not_audited"` + `revisedFrom` 溯源 + 独立 `generationId`，原子持久化进候选缓存，原候选与其审计状态不变。红绿证据：`trend-studio.test.ts` 新增 2 例（17/17 exit 0）。
- **API/UI**：`POST /api/trend-candidates/revise`、client API、热点看板候选卡"修订"入口（展开输入、发送后提示"修订稿以本版未审进入收件箱"）。红绿证据：`hot-topic-board.test.tsx` 新增 2 例（5/5 exit 0）。

### 本轮未完成（不得标 PASS）

- **候选收件箱主列表**（TopicEntryWorkspace 内）的修订入口与 `not_audited` 标识投影尚未加；热点看板已覆盖。候选审计状态"六态文案"（D02）在收件箱场景的投影未逐项核对。
- **S2 的 C01–C04 端到端验收证据**（费用门禁与旧失败 run 恢复的真实链路证明）仍在 S6 清单。
- **S6**：A01–D05 逐项证据表、受控真实本地浏览器 QA 均未完成（本地 4320/4321 服务未运行，需按 ACCEPTANCE E 节搭建可控本地 Provider 替身环境后执行）。

## S6 逐项验收（2026-09-25，确定性回归证据）

验收批次（全部 exit 0）：
- 批次 P（pipeline 核心）：`creative-review / creative-planning / production-planning-closure / codex-publish-copy / production-pipeline-publish-copy / reference-grammar-agent / role-agent-loop` 合并运行 214/214，exit 0（`/tmp/s6-acceptance-pipeline.log`）
- 批次 R（返工/系列/回执恢复）：`generative-asset-worker / production-joint-rework(pipeline+studio) / production-authorization-api / series-planning-agent / series-studio-audit / series-store / text-task-recovery-receipt.cross` 合并运行 163/163，exit 0（`/tmp/s6-acceptance-rework-series.log`）
- 批次 S（服务端）：`studio-service / server / trend-opportunity-agent / trend-studio / candidate-inbox / node-document-revision` 合并运行 284/284，exit 0（`/tmp/s6-acceptance-server.log`）
- 批次 U（UI）：`creative-discussion-panel / creative-os / node-workspace / client / node-document-commands / node-content-review / node-document-history / creative-review-history-panel / hot-topic-board / planning-delivery-panel` vitest 371/371，exit 0（`/tmp/s6-acceptance-ui.log`）

### A. 合同与模型调用次数

| ID | 结论 | 证据（测试名 → 文件） |
| --- | --- | --- |
| A01 | PASS（七节点初稿均一产一审一停） | topic: "audits the first topic package once without automatically rewriting it"（S 批）；series: "returns the first roadmap with its independent advice without automatic rewriting"（R 批）；treatment/script/director: "waits without side effects, runs exactly one independent audit per draft publication"（P 批）；publish-copy: "returns the first publish draft and independent advice without automatic rewriting"（P 批）；reference-grammar: "audits the first reference report once without silently rewriting it"（P 批） |
| A02 | PASS（publish/topic/series/三阶段）；**reference-grammar 的 AI 修订 NOT_VERIFIED** | publish: "revise produces exactly one publish-copy call … and no audit"（P 批）；topic: "sends exactly one topic-ideas call carrying the instruction and current candidate, and no audit"（S 批）；series: "revises one series episode without auditing or adopting it"（R 批）；三阶段：修订走 `publishCreativeDraft` 清 checkResult 停人（"swaps in a hand-edited draft as a new revision, clearing the old check binding"，P 批）。reference-grammar 修订：IMPLEMENTATION_CONTRACT §0 矩阵未要求该节点具备 AI 修订（仅"初稿审一次并供用户看/采用"），与 ACCEPTANCE A02 字面（含 reference-grammar）不一致，按矩阵从宽未实现；如按验收卡字面要求补齐，需产品确认 |
| A03 | PASS | "手工保存、采用备选与恢复旧稿都生成新版本，旧审计不能跟随"（P 批） |
| A04 | PASS | "未审修订必须显式承认才能采用，且决定记为未审采用（A04）"（P 批）；发布文档：client "binds an unaudited publish-copy adoption to the visible document version"（U 批） |
| A05 | PASS | "同版可多次审计并全部留痕：checkResult 取最新，auditHistory 完整（A05）"（P 批）；series 并发合并审计（R 批）；publish 文档 auditCurrent（P 批） |
| A06 | PASS | "已审初稿确认时绑定当时的版本与审计身份（A06）"（P 批） |
| A07 | PASS | series: "only audits the human episode and cannot auto-rewrite its continuity requirements"（R 批）；publish 旁路：production-pipeline-publish-copy 的 writeDetailed 优先与 write-only 拒绝（P 批） |
| A08 | PASS | "keeps advisory content suggestions even when the topic package passes audit"（S 批）；组件 "shows creator-facing suggestions even when the first audit passed"（U 批） |

### B. 权限、版本、并发与恢复

| ID | 结论 | 证据 |
| --- | --- | --- |
| B01 | PASS | "does not apply a model's unsolicited rewrite to a discussion-only command (B01)"（P 批） |
| B02 | PASS | "keeps proposals separate, adopts without another model call, and can undo the adopted draft"（P 批） |
| B03 | PASS | "审计记录绑定 versionId：V1 的审计不能回挂到同文字的 V3（B03）"（P 批） |
| B04 | PASS | "rejects an audit result for different draft bytes before binding it to the current version"（P 批）；命令并发由回执竞态场景与 gate 幂等覆盖（R/S 批） |
| B05 | PASS | receipt-race-scenario（text-task-recovery-receipt.cross，R 批 exit 0）：同 ID 同 body 重放零新请求、异 body 冲突 |
| B06 | PASS | receipt-race-scenario 覆盖受理由到结果/确认的重启恢复（R 批）；"resumes the saved series generation result before starting its audit"（R 批） |
| B07 | PASS | "target=script 时重跑编剧并重建导演；treatment 不再调用"（P 批）；series canon 硬校验（R 批） |
| B08 | PASS | "lets the creator adopt a valid draft after a settled check failure without inventing a score" 与 "does not offer unaudited adoption while the original audit request is still unknown"（P 批） |
| B09 | PASS | 旧 run 历史投影诚实降级（creativeReviewHistory legacy 路径，S 批 server.test） |

### C. 返工影响范围与费用安全

| ID | 结论 | 证据 |
| --- | --- | --- |
| C01 | PASS | "keeps a model-generated out-of-scope director plan at a recoverable stop without reaching assets"（Studio→Pipeline 集成，R 批）；worker `REWORK_SCOPE_CONFLICT` 最后防线（generative-asset-worker，R 批） |
| C02 | PASS | 逐镜 sound_cue/visibleAction/缺失旧脚本等范围反例（generative-asset-worker，R 批 exit 0） |
| C03 | PASS（确定性层；交互层由 E 节 QA 复核） | 不可变报价 + 幂等授权 + delta 追加授权（"prepares an immutable quote…"、"amends as a delta that supersedes…"，R 批）；needs_scope 扩围必须重新报价（studio-service "marks only a structured rework-scope failure as needing a fresh scope decision"） |
| C04 | PASS | needs_scope 仅由结构化 `REWORK_SCOPE_CONFLICT` 触发（S 批）；"prefills the concrete failed-node reason instead of a generic rework summary"——无关异常不被吞成建议 |

### D. 浏览器交互与历史

| ID | 结论 | 证据 |
| --- | --- | --- |
| D01 | PASS | "keeps an unsent instruction with its original draft…"（U 批）；node-document-commands "appends selected suggestions to the existing instruction without overwriting or sending" |
| D02 | PASS | 六态文案组件与面板断言（creative-discussion-panel / NodeContentReview / "shows an incomplete review without a score"，U 批） |
| D03 | PASS | "retains an overlong pasted instruction and refuses to send it"、"keeps an unsent instruction with its original draft when the version changes"（U 批）；node-document-commands 超长保留全文 |
| D04 | PASS | "连续多次修订后仍能回看每版全文和当时的采用决定"（P 批）；NodeDocumentHistory / creative-review-history-panel（U 批） |
| D05 | PASS | "reconciles a pending command without sending a new one"、"refuses to confirm when the displayed identity changed while the dialog was open"、"keeps the composer usable in memory when reading stored drafts fails"（U 批） |

D 类为组件/服务级确定性证据；真实浏览器端到端复核见下节受控 QA。

## S6 受控真实本地浏览器 QA（2026-09-25，部分完成）

**环境**（全部真实组件 + 可控本地 Provider 替身；无真实付费密钥、未伪造 run.json、未绕过人工按钮）：
- 本地替身 Provider（`/tmp/vf-stub-provider.mjs`，127.0.0.1:4390）：chat-completions 协议 + 热点信号源（DailyHot/NewsNow 同形端点），提供 `/stats` 请求计数与 `/control` 延迟/失败注入
- broker（`apps/codex-broker/dist/main.js`，deepseek profile，socket `/tmp/vf-qa/broker.sock`）：经 `NODE_OPTIONS=--require /tmp/vf-fetch-stub-hook.cjs` 把出网 `api.deepseek.com` 重定向到替身（进程级注入，未改产品代码/系统配置）
- Studio server（4318，workspace `/tmp/vf-qa/studio-workspace`）+ vite web（4319）：真实服务端与持久化
- 浏览器：Chrome 真实操作；截图存 `qa-screenshots/`

**已验证（PASS，含请求计数证据）**：

1. **热点候选流全链**：刷新热点 → 替身 `topic-ideas` 1 次 + `role-audit`(选题总编) 1 次 → 收件箱候选 + 审计建议同屏（"选题总编这轮独立复核未判通过……这是复核建议修复的点"——awaiting_user 态建议展示，A08）→ 候选"修订"入口输入指令发送 → **`topic-ideas` +1、`role-audit` +0（修订零审计 ✓ A02）** → 修订候选以 `not_audited` + `revisedFrom` 追加进收件箱，原候选不变 → 采用原候选 → opportunity 记录 `adoptedCandidateGenerationId` + `adoptedCandidateAuditStatus=awaiting_user`（精确版本采用 ✓）。截图：`01-candidate-inbox-audit-advice.png`、`02-candidate-revision-unaudited.png`
2. **重启回看**：kill 并重启 Studio server 后，2 条候选（awaiting_user / not_audited）与 opportunity 的采用绑定完整保留（实际持久化 ✓）
3. **创作流停点**：手动录入选题 → 新建制作（免费图库路线）→ 内容简报节点审计 1 次（"独立复核 92 分"）→ 放行 → 创作规划 `creative-treatment` 1 次 + 初稿审计（导演前期构思）1 次 → **停人**（run needs_human）。停点页面：稿件全文 + "本版已审计" + 三主操作分离（撤销/审计当前版本/确认当前方案）+ "采用不会重复审计当前稿" + "创作版本记录：前期构思 · 第 1 版 · 已审计"（S3/S5 停点交互 ✓ A01/A06）

**更正（2026-09-25 深入核查后）**：此前怀疑的「audit_current 端到端短路缺陷」**不成立**。run.json 证据：三次点击的 `creativeReviewOperations` commandId 各不相同、全部 completed；`treatment.auditHistory` 从 1 条增至 4 条（1 initial + 3 manual，时间戳递增、auditId 各异、checkResult 指向最新一条）。替身 `role-audit` 计数不变的原因是：**同版本重复审计的请求身份与初稿审计完全一致，role-agent-loop checkpoint 命中后恢复既有结果、零新模型调用**——符合合同"不重复提交同一付费请求"（B06）与"主动审计只审该精确版本"语义，且"完整保存新旧审计记录"满足（A05 ✓）。UI 无可见变化是因为同版同内容的新结论与旧结论完全一致，仅 auditId 更新。
- **遗留小项（UX 改进，非缺陷）**：同版重审后 UI 应提示"已重新核对：结论与之前一致（第 N 次审计）"，否则用户无从确认审计确实发生。归入 S5 小改。
- **QA ② 的正确做法**：先发送修订产生新稿（内容变化 → checkpoint key 变化）→ 设置替身审计延迟 → 点「审计当前版本」→ 立即刷新/重启 Studio → 验证只消费原请求、不重复发起（此时计数应恰好 +1）。

### QA ② 实测结果（2026-09-25，已有部分结论）

- 手工修订流程浏览器级验证通过：修订表单未修改时「保存修订」禁用；保存后 v2 新稿（`versionId …#v2`、checkResult=None、版本历史 2 条）；停点 UI 文案诚实切换为「本版未审计」+「采用本版（未审计）」按钮 +「查看上一版」；未保存修改期间审计/确认按钮冻结（"先保存或放弃修改"）。A03/A04/D05 浏览器级 ✓。
- **主动审计在崩溃/重启下的行为（B06 边界发现）**：对 v2 发起主动审计（替身设 8s 响应延迟），响应未返回时硬重启 Studio server。结果：恢复路径正确恢复同一 audit_current 操作、审计结论正确落盘（checkResult=pass、draftSha256 与 v2 一致、auditHistory 第 5 条 manual、operation completed），不丢稿不误判。**但替身侧 role-audit 计数 +2 而非 +1**：原 in-flight 的 Provider 请求在 Studio 崩溃后被取消（broker 收到客户端断开），恢复路径重新执行并发出新请求——即"崩溃时已发出的模型调用"没有被跨进程观察（观察原 requestId），而是取消+重发。真实按量计费 Provider 下存在双花风险；该行为是否达标取决于「Provider 对 abort 请求是否计费」与产品对 B06"不重复提交模型任务"的边界定义。**建议作为产品决策项**：a) 接受现状（崩溃罕见、多数 Provider 对 abort 不计费）；b) broker 侧对已受理任务做跨连接结果缓存（同 requestId 幂等返回）；c) 恢复前先向 broker 查询原任务状态再决定重发。截图：`03-v2-audited-after-restart.png`

**未执行（NOT_VERIFIED）**：QA ②（被上述按钮问题阻断）、QA ③（返工空范围样例的浏览器级演示；C01–C04 已有确定性测试证据）。QA 环境进程仍在运行（stub 4390 / broker socket `/tmp/vf-qa/broker.sock` / server 4318 / web 4319），可直接续查"审计当前版本"按钮问题；停止方式：`pkill -f vf-stub-provider.mjs; pkill -f codex-broker/dist/main.js; pkill -f 'tsx apps/studio/src/server/main.ts'; pkill -f 'vite --host 127.0.0.1 --port 4319'`。QA 数据在 `/tmp/vf-qa/`，不涉及仓库工作区。

## Oracle 审计轮（2026-09-25，oracle-web max 强度，会话 vf-creative-review-s6-audit-r2）

完整资料包存档：`EXECUTION_PACKAGE-ORACLE-r2.md`（Oracle CHANGES_REQUIRED 裁决 + OA-01..06 实施项 + QA② W1-W5 窗口矩阵 + 最终验证命令）。要点与执行状态：

| 项 | 内容 | 状态 |
| --- | --- | --- |
| OA-03 (P1) | reviewGateNode pass 确认分支覆盖用户 checkIdentity（图层漏洞，Oracle 隔离探针复现） | **代码已修**（creative-planning.ts 透传 resume）。**测试适配进度**：creative-review.test.ts 33/33 绿（resume() helper 已改为从停点 outcome 读 checkResult.checkIdentity，35 处调用点更新）；production-planning-closure.test.ts 的 confirm() helper 已补 expectedCheckIdentity（从节点 output.creativeReview.stages[stage].checkResult 读），剩 2 例红：'lets only one of two concurrent confirmation command ids'、'pauses paid generation on an unfinished source review'（各有一个独立 confirm 构造点，同模式补身份）；joint-rework 剩 5 例红（host-bound stock consent ×3、recovers expired real ranking ×2，同模式）；creative-planning.test.ts 角色级 2 例同模式。**根因均一致**：pipeline 的 confirm resume 构造（production-pipeline.ts confirm 分支）对缺失 expectedCheckIdentity 会自造 'creative-review-confirm-v1' 摘要——建议同时收掉该 fallback（pass 确认缺身份应在 dispatch 层按 HumanDecisionConflictError 拒绝），可一并消掉剩余用例 |
| OA-01 (P1) | 审计操作身份（auditOperationId/commandId 派生）进 creativeReviewExecution → 角色适配器 → checkpoint key；手动重审=新操作，恢复=原身份 | 未开始（见资料包"身份规则"） |
| OA-02 (P1) | auditPublishedStageDraft 禁止事后补写 versionId：核验结果绑定（目标版本+操作身份）后才登记；异常分支的来历不明 audit 不得登记 | 未开始 |
| OA-04 (P1) | auditId 由持久化操作稳定派生（非随机）；记录级幂等（同身份同结果幂等返回、同身份异目标冲突）；恢复窗口 W1-W5 | 未开始 |
| OA-05 (P2) | 候选入口与反馈 | 热点方向行标识、TopicEntryWorkspace 修订入口已完成；awaiting_user≠not_audited 区分与三类重审提示文案待做 |
| OA-06 | reference-grammar 标 CONTRACT_CONFLICT/NOT_IMPLEMENTED（不由执行者按宽泛条目推定）；撤回"audit_current 无缺陷/A05✓"整体结论（auditHistory 增长≠三次新审计，checkpoint 复用待 OA-01 核实）；applyCreativeReviewEditDraft 过时注释修正 | 本文件已完成部分更正；其余随 OA 收尾一并落实 |
| QA② | W1-W5 恢复窗口矩阵；替身需提供调用序号/暂停/按序不同结论 | W2 部分实测（结论落盘 ✓、计数 +2 待 OA-01 后复测）；其余待做 |

**Oracle 对此前记录的两点关键更正（已接受）**：a) "三次命令完成 + auditHistory 增长"不能证明三次新独立审计——同版重审复用旧结果的解释未经 checkpoint key 核实，不得记 A05/B06 通过；b) 实际采用的是原候选（awaiting_user），修订候选的 A04 未审采用全链未验证。

**下一执行者最短路径**：① 收尾 OA-03 测试适配（三件套聚焦绿）→ ② OA-02 → OA-01 → OA-04（顺序执行，每步先红后绿，身份规则严格按资料包，不得每次生成新 UUID）→ ③ OA-05/06 收尾 → ④ QA② W1-W5 → ⑤ 完整 npm test → ⑥ oracle-web 复审（--browser-thinking-time max，附 RESULT.md + creative-planning.ts + creative-review.ts + 新测试），循环至无 CHANGES_REQUIRED。

## OA-01/02/03/04 实施完成（2026-09-25，Oracle 资料包第一轮执行）

| 项 | 实施内容 | 验证 |
| --- | --- | --- |
| OA-03 | reviewGateNode pass 确认不再覆盖用户 checkIdentity（透传 resume）；creative-review / closure / joint-rework / planning 全部确认构造补齐 `expectedCheckIdentity`（从停点 checkResult 读取） | 图层反例：错误身份被 confirmCreativeDraft 拒绝（既有合同测试）；三件套+宽套件 293/293 exit 0 |
| OA-01 | `creativeReviewExecution` check 模式新增 `auditOperationId`：initial 由 runId+stage+versionId+draftSha256+stageInputDigest 稳定派生；manual 由已持久化 commandId 派生；经 `planningReviewCheckpointIdentity` 进入装配层 checkpoint key；三个角色适配器接口同步类型 | `planningReviewCheckpointIdentity (OA-01)` 4 例（新命令新身份/同操作恢复同身份/A→B→A 新请求/旧无身份兼容旧派生） |
| OA-02 | 结构性解决：initial 身份含 versionId/draftSha256/stageInputDigest → A→B→A 的 V3 初稿审计 key ≠ V1，旧 checkpoint 结果不可能被 V3 命中；recordCreativeReviewCheck 的显式 versionId 防线保留 | 上述第 3 断言 + 既有 B03 用例 |
| OA-04 | auditId 由 `{auditOperationId, checkIdentity, draftSha256}` 稳定派生（不再随机）；recordCreativeReviewCheck 记账幂等：同 auditId 同结论重放 → 幂等返回（不追加/不推进 reviewRevision），同身份异结论 → 冲突拒绝（W4 窗口） | 「审计记账幂等（OA-04/W4）」2 例 |
| QA② W1+W2（真实环境复测，OA-01 后） | 新 commandId 审计 → 替身延迟 10s 中：浏览器刷新（W1）+ 硬重启 Studio（W2）→ **Provider 计数恰好 +1**（恢复路径经 checkpoint 观察原请求，不再取消重发）、auditHistory +1、operation 收口 | 替身 /stats 计数 6→7、run.json auditHistory 7→8、v2 sha 匹配 |

**A05/B06 状态更正**：OA-01 落地后，「同版多次主动审计」真实发起新请求并逐次留痕（A05 ✓）；同 commandId 恢复命中同一请求不重复扣费（B06 ✓，W1/W2 实测）。W3 与 W1/W2 共享同一观察机制（结果就绪时观察返回），W5（broker 受理状态真实 unknown）需故障注入，保留 NOT_VERIFIED。

**遗留（下一轮）**：OA-05 剩余（同版重审的 N 次计数提示、awaiting_user/not_audited 文案细化）；W5 故障注入验证；reference-grammar 范围裁决待产品确认（当前标 CONTRACT_CONFLICT）。

## OA 轮最终回归（OA-01/02/03/04 全部实施后，2026-09-25）

完整 `npm test` **exit 0**（Node 22.23.1 + 仓库 Python 运行时），日志 `/tmp/vf-final2.log`：
- TS：1054 pass / 0 fail / 1 skip（含 OA-01 身份 4 例、OA-04 幂等 2 例）
- Broker：265/265
- Studio Vitest：549/549（含 NodeDocumentCommands/热点看板修订等）
- Studio node:test：641/641（含修正后的 production-planning-stages 恢复/重放用例；此前漏登记的 node-document-revision.test.ts 已在清单内一并执行）
- package：4/4
- `git diff --check` exit 0；pipeline 的 identity 自造摘要 fallback 已删除（pass 确认缺 expectedCheckIdentity 在 dispatch 层按 HumanDecisionConflictError 拒绝），恢复/重放用例改为携带停点真实身份。

## R3 收口轮（Oracle r3 资料包执行完成，2026-09-25）

针对 Oracle r3（CHANGES_REQUIRED）的六项收口：

| 项 | 实施 | 验证 |
| --- | --- | --- |
| R3-02（P1） | auditId 绑定持久化操作 `H(auditOperationId)`（正常/completed_failure/异常携带 audit 三个登记出口全部稳定派生，P10 随机记账消除）；记录幂等改**严格 no-op**——已应用操作重放返回原状态，不回退 checkResult（P12）、不追加、不推进 reviewRevision；完整比较 verdict/score/summary/checkIdentity/draftSha256/versionId/issues/source（P09 同操作异结果、P11 同字节跨版本复用 auditId 均冲突拒绝） | 「审计记账幂等」3 例（no-op 含 A后B重放A、P11 宿主补写场景、异结论冲突） |
| R3-01（P08） | 审计返回缺失 reviewCheck 由静默跳过改为显式合同错误（不再出现"节点正常结束却无首审意见"） | 3 个旧夹具（settled-failure/explanation/proposals 的 screenwriter/director/treatment 裸端口）按合同补齐 check 分支，creative-review 37/37 |
| R3-03 | 快照冲突已消除：当前源码确认 fallback 已删（diff 中仅剩删除记录行）；图层"pass 确认缺身份必拒"反例新增 | creative-review「refuses a pass confirmation that omits the seen check identity」绿 |
| R3-04（部分） | OA-01 落地后的 W1/W2 实测：审计延迟中刷新+重启 → Provider 恰好 +1、history +1、operation 收口（原请求被观察）。W3/W5 与 requestId 关联证据待下轮（替身增强：物理序号/屏障/按序不同结论） | 替身 /stats 计数 6→7、run.json auditHistory 7→8 |
| R3-06（部分） | RESULT.md 已多次更正并记录 OA 执行轮；**单一当前状态的最终整理见下方"当前状态速览"** | — |

**最终完整回归（R3 收口后）**：完整 `npm test` **exit 0**（日志 `/tmp/vf-final4.log`）：TS 1056 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 549/549；Studio node 641/641；package 4/4。`git diff --check` exit 0。

## R4 收口轮（Oracle r4 两个 P1 修复完成，2026-09-25）

| 项 | 实施 | 验证 |
| --- | --- | --- |
| P09 闭合（auditId 只绑操作） | 三处登记出口的稳定 auditId 改为 `H({auditOperationId})`——不再混入 checkIdentity/draftSha256。同一操作永远只有一个 auditId，结果差异由记录器的**完整比较**（verdict/score/summary/checkIdentity/draftSha256/versionId/issues 逐项/source）裁决，无法靠换身份绕过冲突 | 幂等 3 例绿 |
| 来源核验（R3-01 闭合） | 装配层 `planningReviewCheckResult` 宿主注入 `auditOperationId`（来自 planningContext 的持久化操作身份，模型输出不经手）到 reviewCheck；`auditPublishedStageDraft` 登记前核验绑定一致，不一致抛"check result does not belong to the requested audit operation"——旧 checkpoint 结果、任何同字节旧结论都无法登记为当前版本审计 | 图层校验在 creative-review 全套件 37/37 中执行；夹具全部经 context 回传真实绑定 |
| 既有 12 处夹具对齐 | 全部 reviewCheck 夹具经 context 回传操作绑定；passingCheck helper 增加 ctx 参数 | typecheck 0 |
| R3-06（部分） | 快照管理教训已落实：三个 diff 与 RESULT 同一工作树快照导出（上一轮 diff 早于 fallback 删除导致误报"fallback 仍保留"——当前源码核实无该 fallback，1399 行为冲突拒绝） | `git diff --check` exit 0 |

**最终完整回归（R4 收口后）**：完整 `npm test` **exit 0**（日志 `/tmp/vf-final5.log`）：TS 1056 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 549/549；Studio node 641/641；package 4/4。

**遗留（下一轮候选，非阻断项按 r4 资料包定级）**：QA② W3/W5 独立窗口与 requestId 关联证据（替身增强）；适配器侧完整回执绑定（当前为装配层宿主注入，Oracle 认可方向）；同版重审"N 次"提示文案。

## R5 收口（Oracle r5 指出的实现偏差修正，2026-09-25）

Oracle r5 复核确认比较侧已闭合，但**派生侧未统一**：三处登记出口的 auditId 实际哈希输入仍混入 checkIdentity/draftSha256/settled 特征。已修正——**三处出口统一为 `H({auditOperationId})`**：
- 正常返回：`audit-${H({auditOperationId})}`
- completed_failure：同上（同操作重放同 id，失败态重放经完整比较幂等）
- 异常携带 audit：同上（外来 audit 与已记账结论不一致时被完整比较冲突拒绝）

验证：聚焦六文件 207/207 exit 0；修正后完整回归两轮 exit 0（`/tmp/vf-final6.log`、`/tmp/vf-final7.log`）：TS 1056 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 549/549；Studio node 641/641；package 4/4；`git diff --check` exit 0。三个 diff 附件（oa-diff-planning / oa-diff-pipeline-full / oa-diff-tests）与最终回归同快照导出。

**R6 唯一阻断项闭合（2026-09-25）**：异常携带 audit 分支新增来源核验——`iteration.candidateHash` 必须等于当前稿件 SHA（本次 loop 实际审的候选指纹），不一致（外来/旧候选意见）保留原异常上抛、不组织成当前版本审计。P11 专项夹具已修正为真实 A→B→A（补"再次发布 A"步骤并断言同字节异版本）。修正后完整回归 exit 0（`/tmp/vf-final7.log`，数字同上）。

## R7 收口（Oracle r7 唯一 P1 修复：异常分支操作归属核验，2026-09-26）

r7 确认 P09 闭合、P11 夹具 PASS，但指出：异常携带 audit 分支的 candidateHash 核验只证明"审的字节一致"——同字节 A→B→A 时旧操作异常的 candidateHash 仍匹配当前 V3，会被包装成当前操作的首次登记。

**修复（调用级绑定机制，Oracle 认可的两个方向之一）**：
- 装配层新增 `withAuditOperationBinding`：check 模式的三个角色调用（treatment/script/director）抛出 RoleAgentLoopError 时，宿主把本次持久化的 auditOperationId 附加到异常对象（宿主注入，模型不经手）。
- 图层 `auditPublishedStageDraft` 异常分支核验 `error.auditOperationId === options.auditOperationId`：不一致（旧操作异常，含同字节 A→B→A 的 O1 异常撞 O3）保留原异常上抛、零登记；一致才进入 candidateHash 与登记路径。
- 既有边界不变：uncertain 优先上抛；completed_failure 登记无分数 incomplete（auditId 绑定操作）。

**验证**：最终完整 `npm test` exit 0（`/tmp/vf-final9.log`）——TS 1056 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 549/549；Studio node 641/641；package 4/4。`git diff --check` exit 0；diff 附件（oa-diff-planning / oa-diff-pipeline-full / oa-diff-tests）与最终源码同快照。

**补充（r7 二次结论的操作归属核验实现）**：r7 二次指出 candidateHash 核验不含操作归属后，本轮在图层异常分支补齐了完整核验链——(1) 装配层 `withAuditOperationBinding` 注入操作标记；(2) 图层先核验 `error.auditOperationId === options.auditOperationId`（不一致零登记上抛）；(3) 再核验 `candidateHash === 当前稿 SHA`。三个旧夹具（含 repair 停点与 proposals 用例的 screenwriter/director/treatment）已按合同对齐并模拟装配层标记。creative-review 37/37。

## R8 收口（Oracle r8 唯一阻断项 R8-01 修复，2026-09-26）

> **历史口径标注（r12b 收口）**：本节及相邻各轮多次写"R9-01 已闭合（guard 2 例）""O1 登记无分数 incomplete"——这些是当时的中间状态记录，**不代表 r12b 后的当前验证状态**：guard 专项现为**三例**（含"同操作重放绑定不变"），R9-01 联动回归已在 R12 收口轮按真实合同重写、O1 走**异常携带意见的 pass/95 分登记路径**。当前状态以下方 R12/r12b 节与顶部状态行为准。

r8 确认三处装配包裹已落实、三个登记出口 auditId 统一、uncertain/completed_failure 语义未回退；唯一 P1 = `withAuditOperationBinding` 无条件覆盖异常已绑定的旧操作身份（O1 异常经 O3 helper 被改签为 O3，绕过图层归属核验）。

**修复（按 r8 资料包的精确规则）**：已有相同绑定 → 原样保留；已有不同绑定 → 保留旧标记原异常上抛（图层归属核验将拒绝登记）；尚无绑定 → 本次可信调用边界建立首次绑定。附带 guard 行为锁定断言（「withAuditOperationBinding guard (R8-01)」）。

**最终完整回归（R11-01 修复后重跑）**：完整 `npm test` **exit 0**（`/tmp/vf-final14.log`）——TS 1061 pass / 0 fail / 1 skip（含 R11-01 uncertain 回归）；Broker 265/265；Studio Vitest 549/549；Studio node 641/641；package 4/4。diff 附件与最终源码同快照。**R9-01 已闭合**（guard 测试直接调用生产 helper 2 例 + 联动回归「旧操作的异常经新操作重抛」1 例）；**R11-01 已修复**：uncertain 原异常传播移到异操作拒收之前（旧操作绑定 + uncertain → 原异常上抛、绑定保留、零登记、不转停点，专项回归绿）。**R9-01 已闭合**：guard 测试直接调用生产 `withAuditOperationBinding`（已导出，2 例：已绑定 O1 经 O3 边界原样上抛且标记不变、未绑定异常当前边界首绑）；联动回归「旧操作的异常经新操作重抛」经真实 ProductionPipeline 验证 O1 真实登记一次（calls 1→2、auditHistory+1、incomplete 无分数）、O3 重放被归属核验拒绝零登记（calls=3、auditHistory 不变）、原稿 SHA 与停点保留、run 保持 needs_human。**R9-01（真实 helper/图层拒收链回归）已闭合**：guard 测试改为直接调用生产 `withAuditOperationBinding`（已导出），覆盖"已绑定 O1 经 O3 边界原样上抛且标记不变"与"未绑定异常在当前边界建立首绑"两条路径。

## R9-01 联动回归当前状态（R12 收口轮更正 + r12b 裁决确认，已闭合）

> **本节 2026-09-25 版本曾诊断"workflow-runner 将 planningStop 转为节点 failed 的 runner 层状态转换缺陷"——该诊断已被证伪并替代，Oracle r12b 复核确认撤回是正确方向。** 最终诊断（按 r12b 建议措辞）：**此次失败不是 planningStop 被 runner 错误转换造成，而是此前测试未按预期进入目标归属拒收路径；修正夹具后，既有生产链能够正确保留人工停点。** 两个构造缺陷（执行者追踪证据，Oracle 未独立复现全部 fallback 实现）：

1. **rethrowException 在 `pipeline.start()` 前置位**（属更早试验版本的错误，r12 收口前的 20260925-191126 导出包已改为 start 后置位）：初稿审计（第一次 check 调用）就抛出异常，run 在第一阶段即 failed——并非发生在 O3 重放阶段，此前把失败位置误读为"O3 拒收后 runner 转 failed"。
2. **fixture 异常的 sourceError 是可切换 Provider 故障**（`CodexBridgeError` stage=completed_failure、failureKind=model_provider_no_output）：`isModelProviderFailure` 判真 → `runCandidates` 按既有候选切换合同把它包装成 `ModelCandidatesExhaustedError`（cause=原异常）→ 图层 `auditPublishedStageDraft` 只对 `RoleAgentLoopError` 做归属/字节核验，收到包装层后走通用 `throw error` → 节点 failed。归属核验从未被触发，与 runner 无关。
3. 次要构造错误：`candidateHash: "pending"` 永远过不了字节核验；`assert.rejects(error === staleException)` 与图层"返回 planningStop 拒收"的已审语义（R7/R8 轮确立）矛盾。

**R12 收口轮（2026-09-26，生产代码零行为改动）**：

- **R11-V01 闭合**：角色替身入口记录每次 check 调用的操作身份（`treatmentCheckOperations`）与实际抛出的异常对象（`treatmentRethrown`）；删除构造期"rethrowException 单候选"分支（延迟置位时该分支永不生效，Oracle r11b 指出不能作为调用次数证据）——调用次数由断言直接钉住（初稿/O1/O3 各恰好一次，非 Provider 故障按既有合同不切换候选）。
- **R9-01 测试重写并通过**：fixture 异常改为非 Provider 故障源（纯 `Error` sourceError，`runCandidates` 按既有合同原样上抛 `RoleAgentLoopError`），`candidateHash` 取真实停点稿件 SHA；O1 首绑+登记一次（图层异常携带意见分支，**当前验证的是 pass/95 分登记路径**——r12b 确认这是正确的隔离而非绕过生产合同，"无分数 incomplete"属另一分支的既有专项，两者各证不同性质）、O3 重放同一对象零登记、停点保持 needs_human、操作收口 completed、拒绝原因（"另一次已过期的操作"）到达停点。仪器化断言：同一异常对象本体两次进入真实调用链、三个互不相同且均非占位的有效操作身份、O3 后绑定仍属 O1 未改签。
- **R11-V02 闭合（真实 pipeline 用例）**："旧操作绑定的 uncertain 异常经新操作重抛"——经生产 helper 建立旧绑定后，通过真实 `dispatchCreativeReviewCommand` 重放：uncertain 原异常传播（节点 failed、错误正文为原异常消息、无 planningStop）、零登记、初稿结论保持、同一异常对象与旧绑定保持、sourceError.stage 仍为 uncertain。
- **debug 遗留清理**：移除排查遗留 debug 输出——生产代码两处（`withAuditOperationBinding` 的 `[dbg-helper-catch]`、图层来源核验前的 `[dbg-layer]`）+ fixture 一处（`[dbg-fixture]`）；旧导出包中测试用例自身的 `[dbg-init]`/`[dbg-after-o3]` 也随重写一并消失。r12b 逐行比对确认：两个生产文件相对前包各只有这一行 debug 删除，不承担绑定、登记、恢复或状态迁移职责。

**r12b 裁决（CHANGES_REQUIRED，但"本轮没有做偏、没有发现需要重新修改生产逻辑的理由"）与余项收口**：

- Oracle r12b 逐项核验五条已审边界全部保持：uncertain 优先、guard 不改签、归属核验、auditId 稳定派生（`audit-${contentSha256({auditOperationId})}` 三个出口一致，未混入其他输入；一处旧注释仍写"操作身份+结果身份"，r12b 指出应改注释不改代码）、已应用操作重放 no-op（承接已审实现与本轮回归通过记录；本轮未附 creative-review.ts 全文，不宣称对其重新完整源码审计）。R9-01 的 O3 是"新操作携带旧异常"，与"同一已应用操作重放"两种语义不合并。
- **R11-V01 余项（本轮已补）**：O1 后深拷贝完整 `creativeReview`，O3 拒收后经 `pipeline.show()` 深比较——覆盖审计历史全内容、checkResult 全字段、currentDraft/versionId/SHA、phase、activeStage、reviewRevision；不比较整个 run（命令记录、run revision、planningStop 合法变化）。`treatmentCheckOperations` 补"非空且非 `(initial)` 占位"断言。
- **R11-V02 余项（本轮已补）**：新增图执行边界伴随用例（creative-review.test.ts，公开 `runCreativePlanning` 入口 + 生产 `withAuditOperationBinding`，旧绑定 uncertain 进入新操作）——rejection 边界直接断言 `error === staleUncertain`（引用同一性），并断言旧绑定与 sourceError uncertain 状态保持。不导出私有函数、不加生产钩子、不改 dispatch completion 返回 failed run 的既有合同。
- **红性质两项均实测**（执行者mutation记录，非 Oracle 亲测）：①顺序回退（uncertain 移到异操作拒收后）→ pipeline 用例失败（run 变 needs_human）；②图层改抛同类型、同消息、同 sourceError 的**新对象** → 图用例失败（"图执行边界必须原样交还旧操作绑定的 uncertain 异常对象"）。两项 mutation 后均恢复生产代码原样。
- **Provider 全候选耗尽观察（r12b 裁量：单列为非阻断 P2 后续项）**：多候选场景下 check 调用的全部候选都以可切换 Provider 故障失败时，`ModelCandidatesExhaustedError` 包装使图层 `settledCheckFailure` 分支（登记无结论 incomplete 并保留停点）不可达，run 直接 failed。与 R9-01 归属防线正交（本轮无证据表明该路径造成错误登记、放行或费用绕过），但与 S3 描述"审计腿已核清失败时形成无结论状态并保留用户决定机会"的期望存在缺口，登记为后续独立核验项：应先验证所有候选尝试的真实状态（区分"全部确定结束/未受理"与 uncertain/身份冲突/状态缺失），优先评估规划审计消费边界能否正确分类包装错误，而不是先改通用候选切换合同。不得据此把 B08 写成已完全验证，也不并入本轮生产整改。

**r12b 余项收口验证（2026-09-26，最终改动后）**：typecheck exit 0；三件套（creative-review / creative-planning / production-planning-closure）161/161 exit 0（含新增图用例）；最终完整 `npm test` **exit 0**（`/tmp/vf-final17.log`：TS 1063 tests / 1062 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 549/549（32 文件）；Studio node 641/641；package 4/4；typecheck+build 同令完成；R9-01 与两个 R11-V02 用例的通过记录均在日志内）。`git diff --check` exit 0；两个生产文件与 r12b 送审快照逐字节一致（执行者 diff 校验记录，非 Oracle 独立字节比较——r13 已明确此证据等级）；HEAD 仍 7b30875，未 commit/push/deploy。

**r13 确认复审裁决（2026-09-26，PASS / SCOPED_CONVERGED，会话 vf-creative-review-s6-audit-r13）**：

- R11-V01 **CLOSED**：O1 后 structuredClone 完整 creativeReview、O3 后经 pipeline.show() deepEqual 的比较被认定为"完整状态不变性"证据——历史内容改写、结论字段替换、稿件版本或复核轮次推进都不能再靠局部摘要/分数/SHA 断言蒙混；比较范围锁定 creativeReview 而非整个 run 的取舍正确（命令记录、run revision、拒收提示合法变化）。调用链证据（1/2/3 计数、三个互异非占位操作身份、同一异常对象本体两次入口、O3 后绑定仍属 O1）保留完整。
- R11-V02 **CLOSED**：真实 pipeline 用例与图边界用例"各自证明不同性质，组合方式正确"——pipeline 层锁定 uncertain 不得被降级为异操作人工停点；图层边界 `error === staleUncertain` 直接检查引用同一性，图层改抛同属性新对象时该断言仍会失败。两项 mutation 记录与断言对应关系成立（按 RESULT 标注为执行者 mutation 证据，非 Oracle 亲测）。
- R11-E01 **CLOSED（限本轮记录整理范围）**：历史口径标注、诊断撤回措辞、debug 清理分类、Provider 耗尽独立 P2 各有明确对应；顶部保留总体 IN_PROGRESS 与未决项，"没有把局部收口包装成整体完成"。
- **是否做偏**：当前生产边界（绑定不改签、uncertain 优先、auditId 只绑操作、重放 no-op 承接已审实现）与"生产不动、保留已审边界"无冲突变化；跨轮字节一致性采用执行者 diff 校验记录（证据等级已注明）。
- **两处非阻断记录（不升级为整改）**：① 测试累计 diff 中仍有早期轮次的 `console.log("T16 step ...")` 噪声（无法归因于本轮，属测试日志噪声，不阻断）；② 生产补丁中"操作身份 + 结果身份"旧注释与实际只哈希 auditOperationId 的代码不完全一致（既有注释维护项，非派生逻辑回退）。
- 唯一 skip 为真实生产成片 E2E，不影响本轮确定性收口，也不得当作成片验收证据。
- **执行建议（已按此收尾）**：登记本裁决、保留当前实现不再修改本轮审计链、证据归档（RESULT + 四份源码/测试补丁 + npm-test-final17.log + 两项 mutation 记录 + 快照 diff 校验记录）、结束阻断循环；W3/W5、reference-grammar、适配器回执增强、Provider 耗尽 P2 保持独立未决项。


### 本轮收尾回归（S4 增量后的完整 `npm test`，2026-09-25）

| 阶段 | 结果 |
| --- | --- |
| 完整 `npm test`（含 typecheck + build） | **exit 0**，日志：`/tmp/videofactory-npmtest-s4-revision-20260925.log` |
| TS（node --test） | 1048 pass / 0 fail / 1 skip（含 publish-copy 修订/再审 4 新例） |
| Broker | 265 / 265 |
| Studio Vitest | 548 / 548（含 NodeDocumentCommands 5 例、热点看板修订 2 例） |
| Studio node:test | 635 / 635（含热点候选修订 4 新例；首轮 635 时 `node-document-revision.test.ts` 漏登记于 `apps/studio/package.json` 测试清单，补登记后单独复跑 6/6 exit 0——**该文件已进清单，下一轮全量应为 641**） |
| `git diff --check` | 0 |

- 总状态保持 `IN_PROGRESS`。
基线：`main / 7b30875e9e36f90e4191ee12385e0774c117eb4c`，tracked 干净，untracked 文档保留。本地 Studio web 4320 / API 4321 存活（`/api/health` 200），无活动任务。未 commit/push/deploy。

## S0 真实调用矩阵

核对方式：逐文件读源码并沿调用链核实；行号为基线 `7b30875` 时点，实施后会漂移，以符号为准。

| Broker task kind | 产稿调用点 | 审计方式（现状） | 产物去向 | 用户入口/停点 | 审计/修订/历史 | 默认循环 | checkpoint/恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `creative-treatment` | `codex-creative-treatment.ts:211`（`creativeReviewExecution.mode==="draft"` → `deferAudit:true`，`maxIterations=1`） | 无初稿审计；`confirm` 时以 `mode:"check"` 补审（`creative-planning.ts:1735`） | `publishCreativeDraft` → `CreativeReviewState.stages.treatment` | 创作规划 treatment 停点（讨论/备选/编辑/确认） | 审计在确认后才产出；修订（编辑/备选/讨论改稿）后 checkResult 清空、确认重新触发审计；仅保留 current/previous 两版 | draft=1；check=1 | 角色 checkpoint v7（`nodeAgentLoopCheckpoint`，按 stage+brief 身份）；prepared operation 恢复 |
| `script-draft` | `codex-screenwriter.ts:170`（同上 draft 模式） | 同上（`creative-planning.ts` script 确认时补审） | `stages.script` | script 停点 | 同上 | 同上 | 同上 |
| `director-plan` | `codex-visual-director.ts:121`（同上） | 同上 | `stages.director`（`direction`/`material_plan` 两次停点复用同一 stage 状态，`directorReviewPurpose` 区分） | director 停点 ×2（direction 与 material_plan） | 同上；两种 purpose 共享同一 currentDraft 槽位，依次覆盖 | 同上 | 同上 |
| `topic-ideas` | `trend-opportunity-agent.ts:417` | `runRoleAgentLoop` 产审自动循环（audit `repair` 自动触发 revision，最多 `maxReviewIterations`） | 选题候选包 → opportunity store（trend inbox） | 热点收件箱：人工浏览/保存选题；无「稿件+审计」停点 | 审计循环结果仅保留最终轮 trace；无版本历史给用户 | 3 | trend 侧无 per-run checkpoint（`this.checkpointDirectory` 未用于 topic） |
| `series-roadmap` | `series-planning-agent.ts:80,158`（showrunner/greenlight 两路） | 同上自动循环 | 系列路线图 → series store | 系列规划窗口；选集/开拍检查另有门（未逐条核实质量建议不重写已确认集） | 同上 | 3 | `fileRoleAgentLoopCheckpoint`（checkpointKey） |
| `publish-copy` | `codex-publish-copy.ts:82`（`write()` 单次无审计）；`:81` `writeDetailed()` 走自动循环 | `write()` 零审计；`writeDetailed()` 产审自动循环 | 生产消费者 `production-pipeline.ts:9381`：有 `writeDetailed` 则优先（当前发布包节点路径），否则退化 `write()` | 无独立文案停点（随发布包节点产出） | 无版本历史；审计 trace 随 outcome | 3 | `input.checkpoint`（agentLoopCheckpoint） |
| `reference-grammar` | `reference-grammar.ts:75,80`（`analyze` 单次 / `analyzeDetailed` 自动循环） | `analyzeDetailed` 产审循环 | 导演 brief 输入（`production-pipeline.ts` referenceGrammar 注入 visual-director）+ `EDITABLE_DOCUMENTS`（`production-studio.ts:237`，`shot_grammar`，NodeWorkspace 可见可编辑） | 目前仅作为 director 的上游证据 + 历史只读展示；无独立确认停点 | 无 | 3 | agentLoopCheckpoint |
| `asset-rank` | `asset-semantic-ranker.ts`（选材排序分析） | 循环内 audit（有界） | 排序证据 → 选材方案 | 不独立停点（属导演/选材证据） | 绑定候选证据 | 有界 | checkpoint |
| `visual-review` | `codex-visual-review.ts` | 产审循环（成片审查） | review_report artifact + 审片停点 | 视觉审片停点（已有完整人工门禁） | 已绑定媒体版本 | 有界 | checkpoint |
| `audio-review` | audio-review-service | 单审（无递归） | 报告随 visual-review 交付 | 未配置即如实显示未审听 | — | 1 | — |
| `role-audit` | 各循环的 audit 腿 | 本身是审计 | 审计记录 | 随目标稿展示 | 不递归审 | — | — |
| `creative-discussion` | `codex-discussion*`（讨论子任务） | 不审计（交互子任务） | 消息/备选/修订 → 原节点 review state | 随宿主停点 | 修订产出未审新稿（现状语义与合同一致） | 1 | — |

### 与合同「事实背景」的差异更正

1. 「三阶段确认才补审」**证实**：draft 腿 `deferAudit:true`（三文件同模式），确认腿 `mode:"check"` 才审（`creative-planning.ts:1735`）。
2. 「topic/series/publish 已有 role-audit 但行为是自动修稿循环，不是初稿审一次停人」**证实**：三处均为 `runRoleAgentLoop` produce+audit 自动迭代（audit 驱动 revision），无人工停点；`publish-copy.write()` 更是零审计。
3. 「reference-grammar 可见可编辑」**证实**：`production-studio.ts:221/237` 将其列入 `WORKFLOW_NODES` 与 `EDITABLE_DOCUMENTS`；同时它是导演 brief 的上游证据。两条消费路径并存。
4. 「返工空范围放行链」**证实**：`production-studio.ts` `unmaterializedAssetScenePositions`（无 asset_plan 且无 jobs 时返回 `[]`）→ 批准范围 `[]` → 规划不受限 → 导演阶段 `reworkAffectedScenePositions`（`production-pipeline.ts:7364`）按内容差异抛「返工影响范围新增了镜头…」→ run `failed`。worker 最后防线存在（`generative-asset-worker.ts:1514`）。
5. `role-agent-loop.maxIterations` 合法域为 1–3（`role-agent-loop.ts:263`）；三阶段 draft 腿已是 `maxIterations=1 + deferAudit`。

### 十二 task 最终归类（按合同）

- **内容交付（纳入新合同）**：creative-treatment、script-draft、director-plan、publish-copy、topic-ideas、series-roadmap、reference-grammar（可见报告路径）。
- **分析/审计（不递归审，绑定版本展示）**：role-audit、asset-rank、visual-review、audio-review。
- **交互子任务（不独立停点）**：creative-discussion。

## S1+S3 已完成实施（本轮交付）

### S1 版本/动作/决定最小合同（creative-review.ts，已实现，测试先红后绿）

先红证据（`初稿审一次的版本与动作合同` 6 用例在实现前全部失败：无 versionId、无 auditHistory、无未审采用、audit_current 解析不存在）：

1. **versionId**：`CreativeDraftRef.versionId = ${artifactId}#v${revision}`（`creativeVersionId()`）。同内容重发不换版；内容变化必换版；A→B→A 三版各自独立（B03 基础）。
2. **审计记录**：`CreativeAuditRecord {auditId, versionId, draftSha256, checkIdentity, recordedAt, source: initial|manual, result}`；`CreativeStageReviewState.auditHistory`（上限 10 条）；`recordCreativeReviewCheck` 新签名 `(review, stage, result, options?)`——`result.versionId` 携带时必须等于当前版本身份，**V1 的迟到审计不能回挂同文字的 V3**（TX-03/B03）；`checkResult` 指向最新一条并带 `versionId+auditId`。
3. **用户决定**：`CreativeStageConfirmation` 新增 `versionId`、`auditId: string|null`、`unauditedAdoption?: true`；`checkIdentity` 改为可选（未审采用不存在，绝不虚构）。
4. **未审采用（A04）**：`confirmCreativeDraft` 在本版无有效审计时要求 `acknowledgeUnaudited: true`，决定记 `unauditedAdoption` 且不写 checkIdentity；与 acknowledgeRepair/Incomplete 互斥（parser 强制）。
5. **主动审计（A05）**：新一等动作 `audit_current`（`CreativeReviewAuditCurrentResume` + parser），只审当前精确版本、留痕、不推进。
6. 旧数据兼容：`result.versionId` 缺省按当前版本解释（旧 run 零模型调用可读）；既有 stale/幂等/checkIdentity 保护全部保留。

### S3 三个规划阶段接线（creative-planning.ts，已实现）

1. **初稿审一次**：新增三个图节点 `treatment_audit / script_audit / director_audit`（`stageAuditNode` + `auditPublishedStageDraft`），插在产稿节点与复审停点之间（两种拓扑：无图库与图库路线的边均已改写）。停点第一次出现时稿件与本版审计意见**同屏**。幂等：本版已有审计直接放行；审计腿失败按 B08 分类——已核清失败记 `incomplete`（「未取得结论」），未知/在途不记结论并按既有 prepared-operation 恢复，均不判稿失败。
2. **确认不再补审（A06）**：gate 的 confirm 分支删除「确认时临时跑审计」逻辑；只验证 `recordedForCurrentDraft`（sha+versionId 绑定）与用户看到的 checkIdentity。pass 直接确认；repair 必须 `acknowledgeRepair`；incomplete 必须 `acknowledgeIncomplete`。
3. **修订只产稿（A02）**：讨论/编辑/备选产生的 `publishCreativeDraft` 清空 checkResult → 新版未审、停人；确认被拒并提示「审计当前版本或显式未审采用」。
4. **audit_current 在 gate**：stale 校验（revision+draftSha）→ 审当前版 → 记录（source: manual）→ 停在原地。
5. **gate 幂等重入**：phase !== waiting_user 时直接放行给条件边（修复确认后图回放对已确认阶段的再进入）。
6. **返回上游审计恢复**：`returnCreativeReviewToStage` 对被退回且内容未变的阶段，从 auditHistory 恢复该 versionId 的最新审计（同版审计仍适用，不重复烧审计）。

### 测试状态（真实退出码）

| 命令（cwd=repo，node --test --test-concurrency=1 --import tsx） | 退出码 | 结果 |
| --- | --- | --- |
| packages/production-pipeline/test/creative-review.test.ts | 0 | **25 pass / 1 fail**（见下） |
| packages/production-pipeline/test/creative-planning.test.ts | 0 | 78/78 |
| packages/production-pipeline/test/role-agent-loop.test.ts | 0 | 46/46 |
| packages/workflow-core/test/workflow-runner.test.ts | 0 | 83/83 |
| packages/production-pipeline/test/production-planning-closure.test.ts | 1 | 35/1（见下） |
| `npm run typecheck` | 0 | — |
| `git diff --check` | 0 | — |

新增测试（先红后绿）：`初稿审一次的版本与动作合同` 6 例（versionId 不变性、B03 迟到审计拒绝、A05 auditHistory、A04 未审采用、A06 确认绑定、audit_current 解析）；重写为 S3 新交互脚本的既有用例：settled-failure 采用、repair 建议承担（audit 计数语义改为「每次初稿发布恰一次」）、override/stale-rebind、门内解释计数、repair 停等、director→script 返回计数、图库证据重建（含 audit_current 步骤）。

### 已知失败（2 项，均定位清楚，属交接工作非未知缺陷）

1. **creative-review.test.ts test 17**（availability 失败 → material 草稿 confirm）：`本版还没有审计结论`。原因：经 evaluate 的 `publishDirectorMaterialDraft`（role-halt/manual-review 路径，1606/1634/1407 行）发布的 material 草稿**未经过 director_audit 节点**（该路径由 evaluate 返回后直接路由 review/wait，部分场景绕过审计节点）。修法（二选一，建议 A）：A) evaluate/halt 发布后路由统一改经 `director_audit`（把 routeFromEvaluate 的 `review` 与相关 wait 目标改为 `director_audit`，并对 halt 转停点路径补审计调用）；B) 在这些发布点内联 `auditPublishedStageDraft`。随后按 S3 脚本补该测试的 confirm（audit_current 或 acknowledgeUnaudited）。
2. **production-planning-closure.test.ts `只认当前那一份复核`**：服务层 `confirmCreativeReview` 的交互脚本仍按旧合同（确认触发审计）。新合同下第一次 confirm 需携带 `acknowledgeRepair + expectedCheckIdentity`（初稿停点已带 repair 审计）；确认前置条件抛错目前会使 run 落 `failed`——需确认 studio/pipeline 服务层把 HumanDecision 前置错误转为可恢复停点或 409，而不是节点失败（与上一轮 EB-05 的 `HumanDecisionConflictError` 模式一致）。

## S2 / S4 / S5 / S6 未实施（交接清单）

- **S2 返工范围**（未动）：`production-studio.ts unmaterializedAssetScenePositions`（无 asset_plan 且无 jobs 时返回 `[]` 的推断点）需改为「零媒体 → 内容宇宙（脚本镜头 ∪ 导演 shots）」；四处检查点（规划前/候选成稿前/人工采用时/报价与媒体提交前）加 ReworkImpact 内容差异校验；结构化范围冲突码 + 「保留原方案/调整范围」可恢复停点；worker 最后防线保留。
- **S4 其余内容交付**（未动，S0 已给出接线图）：topic-ideas / series-roadmap / publish-copy 现为产审自动循环（audit 驱动自动修订）或零审计 `write()`；需按「初稿产一次审一次停人」改造消费流（trend inbox / series 窗口 / 发布包节点），选中/采用绑定候选包版本与审计状态；reference-grammar 可见报告路径纳入；内部评价任务不递归审。
- **S5 页面**（未动）：本版建议多选 + 「加入修改意见（N）」追加不覆盖；六种审计状态文案；`pass` 下建议可见；主动审计/发送修订/采用三分；历史版本回看（auditHistory 已为数据层备好，需要 UI 投影与 API 暴露）。
- **S6 验证**（未动）：ACCEPTANCE A01–D05 逐项、`npm test` 全量、真实本地受控 QA（含重启恢复与请求计数）。注意测试环境需 `.venv` 前置（见 docs/creative-planning-oracle-repair-result-20260924.md）。

## 本轮修改文件清单

| 文件 | 必要性 |
| --- | --- |
| `packages/production-pipeline/src/creative-review.ts` | S1 合同：versionId/审计记录/未审采用/audit_current/返回恢复 |
| `packages/production-pipeline/src/creative-planning.ts` | S3 接线：审计图节点×3、gate 确认重写、幂等重入、拓扑边 |
| `packages/production-pipeline/test/creative-review.test.ts` | 新合同 6 例先红后绿 + 既有用例迁移到新交互脚本 |
| `docs/creative-text-review-audit-20260924/RESULT.md` | 本文件（S0 矩阵 + 交接） |

未 commit/push/deploy；未调用真实付费模型/媒体；未改 run.json 或历史数据；未触碰后端工作流引擎语义（仅 planning 图内节点与边）。

## 给下一执行 session 的最小路径

1. 修上面两个已知失败（建议先 B 后 1：closure 服务层错误分类 → test 17 的 director_audit 接线）。
2. S2 返工范围（合同 §4 + C01–C04）。
3. S4 四类交付接线（合同节点矩阵；topic/series/publish 的自动循环改「产审一次停人」是其中最大子项，涉及 trend/series/publish 三条消费流的人工停点 UI）。
4. S5 页面（数据层 auditHistory/versionId 已备好）。
5. S6：ACCEPTANCE 逐项 + `npm test` + 真实本地 QA（ACCEPTANCE.md E 节的受控 Provider 替身方案）。

## Codex 接手进展（2026-09-24，后续记录以本节为准）

- 基线仍为 `7b30875`，保留全部用户已有修改，未 commit/push/deploy，未调用真实模型或媒体。
- 交接所列两个 S1/S3 聚焦失败在接手时已由工作树中的后续修改修复：Node 22 下 `creative-review`、`creative-planning`、`production-planning-closure` 合并运行 exit 0；`npm run typecheck` exit 0。Node 26 与 `better-sqlite3` ABI 不匹配，测试使用本地 Node 22.23.3。
- S1 新增反例：手工保存、采用备选、恢复旧稿后 `versionId` 原本仍指旧版，先红后修；现在三个动作均给新版本身份，`creative-review.test.ts` exit 0。旧版审计仍不会自动绑定新稿。
- S5 底层新增 `versionHistory` 全文快照与 `confirmationHistory` 决定记录；连续三次修订/采用先红后绿。取消 `auditHistory` 静默截为十条，十二次审计反例先红后绿。旧 run 缺历史字段须在投影中诚实显示信息不足。
- S5 页面新增当前稿 `draftVersionId` 投影；未发送的输入按版本隔离，不会在换稿后悄悄应用到新稿。移除输入框原生 `maxLength` 截断，超过 4,000 字时保留全文并阻止发送。Studio 面板 32/32（exit 0）。
- S2 工作树已有零媒体保守范围与 `ReworkScopeConflictError`，但完整“候选先校验、结构化人工恢复、费用授权隔离”尚未证明。
- S4 `topic-ideas`、`series-roadmap`、`publish-copy`、可见 `reference-grammar` 仍未达到全部交付合同；不能把三阶段或本轮局部修复写成整体完成。
- S6 全量回归、真实本地受控浏览器 QA、A01–D05 逐项证据尚未完成，当前不得标 `READY_FOR_REVIEW`。

### 后续接手增量（同日，仍为 `IN_PROGRESS`）

- D03 新增同内容不同 `draftVersionId` 的反例：切换版本后旧审计建议不能保持勾选。先红（33 例中 1 失败），修复 `CreativeDiscussionPanel` 的建议选择身份后，聚焦 Studio 33/33，exit 0。
- S4 发布消费者补一条诚实失败防线：配置了发行编辑却抛错或给出无效文案时，不能静默退回 `brief-title` 并包装为成功。现保留节点失败、无 `publish_package`；行为测试先红（6 例中 1 失败），修后 6/6，exit 0。未配置 writer 的旧保守标题行为尚未改变；这不代表发布文案完整交互合同已完成。
- 当前尚未完成 S2 全链、S4 四类交付的人工作用/版本/主动再审、S5 面向创作者的建议字段、S6 全量与本地 QA。没有新增外部模型/媒体调用或费用，也没有 commit/push/deploy。

### 接手续做：返工范围前置校验（仍为 `IN_PROGRESS`）

- 用真实 Studio／Pipeline 测试夹具复现了 C02 的一个缺口：零媒体、已批准空范围时，在导演人工停点修改全片 `visualBible.pacing` 原本会被接受。新增的集成反例先以 `Missing expected rejection` 失败；现在命令登记前按旧方案与候选方案预检，越界编辑被拒且旧稿 SHA 保持不变，聚焦测试 1/1 exit 0。图内编辑及确认继续做同一范围校验，worker 最终防线未移除。
- 另一个 C02 反例：旧脚本缺失但旧导演方案仍有三镜，新方案只剩两镜，原先错误地将删除镜头当作零影响；先红后绿，聚焦测试 1/1 exit 0。旧导演镜头仅用于核对镜头宇宙，不冒充不存在的旧脚本内容。
- `npm run typecheck` exit 0（本地 Node 22）。这只是当前增量类型检查，不等于 S2 全链或 S4–S6 已通过。现仍缺候选产稿前的可恢复范围决定、旧失败 run 的显式恢复、费用边界集成证据及四类交付完整交互。

### 接手续做：S4 两个可证实的交付缺口（仍为 `IN_PROGRESS`）

- `topic-ideas` 首审 `pass` 且带 advisory issue 时，原先只转发 `repairInstructions`（按合同在 pass 下为空），内容建议被丢掉。新反例先红后绿；现在将 issue 的可执行建议带入 generation receipt 并在热点收件箱显示。聚焦 2/2 exit 0。
- `series-roadmap` 初稿的审计分数/摘要有持久字段，但逐条意见未交到系列页面。新反例先红后绿；现在路线图规划记录携带 `auditSuggestions`，页面在当前单集显示。聚焦 1/1 exit 0。**这不修复**正式系列创建目前先落规则路线图、`generate()` 未进入生产消费者的问题。
- `publish-copy` 正式消费者曾允许配置了 writer 却只有 `write()` 的适配器跳过独立审计后生成发布包。新反例先红后绿；现在这类配置在模型调用前明确失败，不生成发布包。聚焦发布消费者 7/7 exit 0；既有具备 `writeDetailed()` 的正式适配器仍正常。人工修订、主动再审与历史尚未完成。

### Codex 继续接手：全量回归与创作者建议字段（仍为 `IN_PROGRESS`）

- 修复两个旧测试夹具与新合同的冲突：发布文案测试 writer 补 `writeDetailed()`；导演返工测试用完整旧镜头宇宙与明确 `[1,2]` 批准范围，不放松范围校验。两个目标用例 2/2。随后 `npm test` exit 0：TS 1036 pass/1 skip、Broker 265/265、Studio 615/615、package 4/4，含类型检查与构建（此结果在下述创作者字段改动之前）。
- S5 创作者内容建议：新增 `creatorTitle`、`creatorObservation`、`creatorAction`，Broker role-audit 严格输出 Schema、提示词及合同 digest 同步；Pipeline 校验并保留原机器字段；Studio 当前稿/历史投影及页面优先展示可读字段，勾选后把 `creatorAction` 加入编辑框，旧记录保守回退到 `repairInstruction`。选题与系列建议也优先使用可读改法。红绿证据：Pipeline 新用例先因字段被丢弃失败，页面用例先因标题不可见失败；修后 Pipeline 1/1、Broker task-definitions 22/22、Studio 页面目标 1/1、选题/系列 51/51。改动后 `npm run typecheck` exit 0，Broker 全量 265/265；**完整 `npm test` 尚须在最终改动后重跑**。
- 修正手工保存文案：不再错误宣称“确认时自动复核”；保存是未审新稿，用户可主动审计或直接采用。
- 架构核查：`SeriesStudio.create()` 仍先持久化规则路线图，`CodexSeriesPlanningAgent.generate()` 未接入正式创建；`publish-package` 有首审但尚无文案专属的人工修订/再审/历史；热点候选采用未绑定候选包版本。S2 旧范围冲突 failed run 的结构化恢复仍未完成。这些不是上面绿色测试所能证明的行为，S4/S2/S6 不得标 PASS。

### Codex 继续接手：热点候选精确版本采用（仍为 `IN_PROGRESS`）

- 发现同一候选 ID 在刷新前后可代表两份不同内容，原采用请求只传 ID。新增反例：用户看到 `topic-batch-v1`，后台刷新同 ID 为 `v2` 后，服务端原先直接采用新版；测试先红（`Missing expected rejection`）。现在刷新缓存为每条候选写入 `generationId` 和当时 `auditStatus`，采用请求携带所见版本；短期旧快照按 `id+generationId` 保留并按当前来源政策重新核验，精确采用旧版或明确拒绝，不偷换到新版。机会记录持久化 `adoptedCandidateGenerationId` 与 `adoptedCandidateAuditStatus`；历史无版本候选仍可采用但不补造身份。目标测试 1/1、CandidateInbox 全部 33/33、TrendStudio 14/14，`npm run typecheck` exit 0。
- 一次在上述实现尚未完成时启动的 `npm test` 在 Studio 新反例失败（TS 1037/0/1 skip、Broker 265/265、Studio 615/1）；该失败随后已由目标测试证明修复，但**当前最终全量回归仍须重跑**。
- S4 剩余：系列路线图正式生成/版本/决定链、发布文案与可见参考报告的人工修订/主动再审/历史。S2 和真实本地 QA 仍未完成；总状态保持 `IN_PROGRESS`。

### Codex 本轮续做：系列精确版本与回归（仍为 `IN_PROGRESS`）

- 保留接手时全部未提交修改；修复 `StudioServicePort` 漏报系列主动审计方法，调整测试夹具。`npm run typecheck` exit 0。
- 系列 `audit_current` 增补 HTTP 合同测试与并发反例：同一系列 revision 的并发请求共用一次审计；写入后新 revision 再主动审计会发起新操作；重启/同版恢复沿用原 checkpoint。新增测试先红后绿，`series-planning-agent` 7/7、`series-studio-audit` 1/1、服务端路由目标 1/1。
- 系列单集现在持久化不可变 `contentVersionId`、完整 `versionHistory`、仅归属目标版本的 `auditHistory`，采用记录精确版本和审计 ID（没有可核实审计记 `not_audited`）；旧存档仅在下一次正常写入时给当前稿分配身份，不补造过去的审计。A→B→A、再次主动再审和未选择的模型稿不能被审计偷改，反例先红后绿；系列页面可回看旧稿及其当时意见，无历史数据如实提示不足。系列存储 22/22、页面 91/91、类型检查 exit 0。
- 修复旧发布包手工保存的兼容缺口：老产物缺少 `contentReview` 时，服务端生成“本版未审”元数据会被通用 shape 校验误拒。现仅受控文档保存路径允许这项服务端新字段，普通输出编辑不能伪造审计。目标测试 exit 0。
- 修复两个 NodeWorkspace 旧夹具：测试把脚本节点改名为配音/视觉审片但仍保留脚本有效输出版本，与产品“读有效版本”语义冲突。目标组件测试 48/48。
- 上一完整 `npm test` 曾 exit 0：TS 1038/0/1 skip、Broker 265/265、Studio vitest 537/537 + node 623/623、package 4/4；这是系列历史增量**之前**的证据。最新全量回归正在执行，完成后在下方追加结果。
- S2 仍未闭环：模型返工候选越界时尚缺“保留为未采用提案 + 原停点调整范围”的完整路径；`needs_scope` 的旧失败 run 与费用隔离仍需端到端验证。
- S4 仍未闭环：热点候选、系列、发布文案、可见参考报告尚未全部具备合同要求的 AI 修订、主动再审、不可变历史和人工停点。系列仅完成其中版本/再审/采用的一部分。
- S6 真实本地受控 QA 尚未执行；没有调用真实模型/媒体、没有新增费用、没有修改历史 run，也未 commit/push/deploy。**总状态继续 `IN_PROGRESS`，不得视为准备验收。**

### 接续实施：S2 候选保全与系列单集修订（仍为 `IN_PROGRESS`）

- S2 增量：返工模型若生成超出已批准范围的脚本/导演候选，现于替换有效稿前拦截；旧稿保持当前，越界内容留作未采用提案，Studio 给出来源 run 与重选范围入口。图级反例、Studio→Pipeline 集成和讨论面板聚焦测试已通过；C01–C04 全链及旧失败 run 恢复尚未验收。
- S4 系列单集：新增 `reviseEpisode` 的 checkpoint 单次 `series-roadmap` 产稿，不自动调 `role-audit`；repository 用预期 revision/Canon 原子保存不可变未审版本，旧版全文与审计历史保留。采用与读取制作上下文不再隐式执行 greenlight；Canon 和集序硬校验继续由 store 保护。增加服务端 API 与系列页意见输入，采用按钮明确标识未审/有建议状态。
- 新测试先红：`series-studio-audit.test.ts` 曾失败于 `reviseEpisodeCurrent is not a function`，后针对审计历史空数组补齐；现在系列 agent/store/studio 聚焦 32/32，模型修订 checkpoint 恢复反例 10/10，`npm run typecheck` exit 0。API 路由目标测试通过。相邻 `candidate-inbox.test.ts` 两个旧断言仍假定采用时自动复核，已改为显式审计后采用和准确的规则保底文案；该文件须复跑。最终 `npm test` 尚未在本次增量后执行。
- 仍未完成 S4 的热点候选修订、发布文案和可见参考报告完整交互，S5 的全部节点同屏体验，S6 全量与受控本地浏览器 QA。不得把上述局部通过解释为整体完成。
- 系列采用并发补强：候选携带所见 `generationId`，最终 `JsonSeriesStore.adoptEpisode` 在写锁内比对当前 revision，防止“列表读取后并发改稿、最后采用了另一版”的 TOCTOU。先后版本反例及候选收件箱聚焦 61/61，exit 0；同进程同一单集修订合并、异内容并发冲突测试 3/3。系列页面建议复选后只追加到未发送输入，需人工点“发送修订意见”；`creative-os.test.tsx` 92/92。
- 全量测试第一次用系统 Python 运行，TS 1038/2 fail/1 skip：一条旧安全测试未列出只读 `reworkBaseline`，另一条 Python Worker 缺 `.venv` 依赖。补回只读访问断言后以仓库 `.venv` 重跑，TS 阶段全过、Broker 通过；Studio Vitest 539/1 fail（旧按钮文案误失“来源待补仍然进入制作”）。该文案已恢复，目标文件 92/92。**本轮最新代码的整套 `npm test` 尚须重跑，先前结果不可算最终 PASS。**

### Codex 本次接手：回归基线（仍为 `IN_PROGRESS`）

- 修正 `studio-service.test.ts` 两个与新系列合同冲突的旧断言：开工使用已采用的「系列总编」稿，不隐式调用「系列开拍总编」；相同 key 重放也不暗中审计。聚焦重放测试 exit 0。
- 以仓库 `.venv` 与 Node 22.23.1 运行当前工作树的完整 `npm test`，**exit 0**：TypeScript 1040 pass / 0 fail / 1 skip；Broker 265/265；Studio Vitest 540/540、服务端 631/631；package 4/4；类型检查及构建也在同一命令内完成。日志：`/tmp/videofactory-creative-review-npm-test.log`。这只证明当前确定性回归；S2 全链、S4 其余交付、S5 全节点交互与 S6 真实本地 QA 仍未完成，不得标整体就绪。
- S2 新增三条先红后绿的范围反例：逐镜 `sound_cue`/字幕变化、导演 `visibleAction` 变化、只有旧镜头编号而缺旧脚本全文。原实现把它们当作零影响；现在按内容变化或无法证明不变要求重新确认范围。`generative-asset-worker` + `production-joint-rework` 合并回归 121/121，类型检查 exit 0。尚未进行费用门禁与旧失败 run 的真实本地浏览器验收。
- S4 参考报告新增反例：仅有单次 `runTask` 的适配器调用 `analyzeDetailed()` 原先会返回无审计报告，外观像完整交付；现于模型调用前明确拒绝这条跳审路径。参考报告与发布包相关聚焦测试 10/10，exit 0；这不代表参考报告 AI 修订/主动再审/历史合同完成。
- S5 人工采用的交互对齐合同：`repair` 建议或审计完成但无结论时，按钮自身是明确质量决定，直接提交精确版本、审计身份与承担标记，不叠第二层泛化弹窗；`pass` 仍有建议时按钮明确写「保留这些建议，仍采用」。素材风险专用弹窗继续保留并冻结版本身份。页面反例先红（3 fail）后绿，`creative-discussion-panel` 35/35，exit 0。
- `graphify update .` exit 0；完整 `npm test` 已在上述最新代码上重新执行中。总状态仍为 `IN_PROGRESS`，真实本地 QA 尚未开始。

### 交接收尾（2026-09-24，停止产品修改）

- 最近一次完整 `npm test` 日志为 `/tmp/videofactory-creative-review-npm-test.log`，记录 TS 1040 pass / 1 skip、Broker 265/265、Studio 服务端 631/631、package 4/4，末尾正常结束。但该日志完成于 23:15，`RunWorkbench.tsx` 最后修改时间为 23:39，**不能作为当前工作树的完整回归证据**。最后改动后的 `client.test.tsx` 178/178 是执行时记录的聚焦结果；接手者须自行核对并重跑类型检查、完整回归。
- 最后增量：发布包和可见参考报告的“采用当前版本”按钮直接提交绑定版本的质量决定，不再叠加普通确认弹窗；素材风险专用确认继续保留。此改动在 `RunWorkbench.tsx`，与 `CreativeDiscussionPanel.tsx` 的同类交互对齐。`reference-grammar.ts` 已防止仅有单次模型调用的适配器跳过独立审计，但 AI 修订、主动再审与历史仍未闭环。
- 交接时核对：`main` HEAD `7b30875e9e36f90e4191ee12385e0774c117eb4c`；工作树 76 条 modified/untracked 状态项，均须保留；`git diff --check` exit 0。没有正在运行的 `npm test` 进程；本次收尾未调用模型、媒体、未改历史 run、未 commit/push/deploy。
- 剩余以 `IMPLEMENTATION_CONTRACT.md` 和 `ACCEPTANCE.md` 为准：S2 的 C01–C04 全链（尤其旧失败 run 的结构化恢复、扩围后新报价与费用隔离）；S4 的热点候选、系列、发布文案、可见参考报告完整修订/主动再审/版本采用与历史；S5 的各交付页面；S6 的逐项证据、完整确定性回归和受控真实本地 QA。状态保持 `IN_PROGRESS`，不得称已验收或部署就绪。
