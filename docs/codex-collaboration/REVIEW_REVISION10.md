# Revision 10 源码与业务流程审查

- 审查日期：2026-09-14。
- 结论：`CHANGES_REQUIRED`。有实质改进，但当前代码仍存在可复现的业务交接缺陷，不能放行产品验收。
- 基线：`b36ebac3189cf574b8e437cbe16eb9d0b228a177`，分支 `codex/final-dual-review-cloud-acceptance`，暂存区为空。
- 核对 `r10-handoff-baseline.json` 的 306 项摘要，42 个路径变化，与执行记录一致；HEAD 差异同时包含此前未提交工作，不能全部归因于 R10。
- 范围：R10 交付与当前正式入口、规划、恢复、声音、可扩展边界。保留已有修改；只新增本报告和隔离诊断材料，没有修改产品代码、TASK 或 RESULT，没有真实模型/媒体调用、费用、服务重启、提交或推送。

## 已落实的改进

1. 模板目录和模板字段已从主要新生产路径退出，模板管理/历史保留；这部分不是只改界面文字。
2. 角色输入新增音频能力与声音节奏，构思审计可以结构化指出候选分类误判；方向合理。
3. 正式计划、报价授权、媒体复用、双视觉审片和原任务观察仍沿用既有结构，未发现需要为本次修复换工作流框架的依据。
4. 执行记录明确区分自动化通过和真实产品未验收，没有虚报新成片、实际提速或真实 QA 完成。

下列发现说明若干边界尚未闭合；并不否认已有自动化测试运行结果。

## 必须修复的交接问题

### F01 / P1：自动视觉建议被升级成用户硬要求

位置：`apps/studio/src/client/pages/TodayPage.tsx:561`；`apps/studio/src/shared/visual-plan.ts:26`；`apps/studio/src/client/components/NewRunDialog.tsx:390,592,613`；`apps/codex-broker/src/task-definitions.ts:153`。

链路：TodayPage 对没有 visualPlan 的机会仍调用 `resolveOpportunityVisualPlan` 生成固定三段建议。NewRunDialog 把该 strategy 预填到输入框，未经用户编辑也提交为 `visualIntent`；角色合同又把 visualIntent 明确当成用户创作边界，而 visualPlan 本应只是可调整参考。

复现：输入“只是构图示意，不做实验或实测”，fallback 仍返回“受控实证、连续过程与同条件前后结果”和优先图库。另一个明确只用生成的表达输入也得到优先实拍/环境声建议。这些建议随后会进入用户硬要求字段，给导演制造人为冲突。此处确认的是实际输入污染，不是宣称已观察到本轮真实模型输出错误。

现有 `client.test.tsx` 的 `keeps an untouched upstream visual plan as planning guidance` 反而断言未编辑时 `visualIntent === visualPlan.strategy`；独立运行该测试通过，证明当前测试保护了错误语义。

最小修正：保留明确的 visualIntent；未编辑的自动建议只作为 visualPlan 参考，不升级其优先级。无上游计划时，不把展示 fallback 默认为已确认生产要求；清理该路径的否定句/题材词推导，不新增题材例外名单。

验收：从实际机会入口捕获正式角色输入，覆盖无计划、自动计划、明确用户意图、用户编辑、与建议冲突的意图及返工继承。自动建议不改变允许的来源/连续性要求。涉及 V10-02、V10-06、V10-07。

### F02 / P1：新增构思审计可以保存，却无法从 checkpoint 恢复

位置：`packages/production-pipeline/src/role-agent-loop.ts:715,1302`。

`restoreCheckpoint()` 调用 `validateRoleAudit()` 时只传 planningRole，没有传同条已保存的 hostReadiness。新 validator 对任何非 null 的 hostReadinessReview 都要求宿主依据，因此合法的空数组 `{ misclassifiedIssueIds: [] }` 也会失败。

独立复现：第一次角色执行通过并保存，第二次同输入恢复报 `Role audit hostReadinessReview is only valid for a planning role with host readiness evidence.`，exit 1，producer 累计仍为 1。不是模型、网络或付费失败。

最小修正：先验证同条 hostReadiness，再把它交给审计校验；不得清空复核对象、关闭引用验证或删除 checkpoint。

验收：已通过空纠错数组重放；非空纠错后第二轮开始前重启；缺失/损坏宿主依据仍拒绝；不重复物理调用，不刷新轮次预算。V10-09、V10-17 当前不能保持完整 PASS。

### F03 / P1：独审纠正误分类后，下一轮仍收到被否定的补料指令

位置：`packages/production-pipeline/src/role-agent-loop.ts:1344`；`packages/production-pipeline/src/treatment-readiness.ts:52`。

真实宿主检查与 role loop 的组合探针确认：独审已准确标注 misclassifiedIssueIds，要求保留用户承诺并改回示意；`revisionAuditForHost()` 仍无条件追加全部原宿主 requiredChange。下一轮同时收到“不要求补材料或改变承诺”和“请补充所需的专属材料，或明确调整本片承诺”。

这不是提示词措辞偏好，而是有效修订输入内部矛盾。原 audit 确实单独保存；问题发生在下一次 producer 的反馈合成。现有纠错测试手写的 host requiredChange 已经是正确的“改用生成”，未使用真实宿主函数，掩盖了问题。

最小修正：原 audit/host 保留为证据；对准确标为候选误分类的项，使用独审的具体纠错动作生成有效反馈，不重复原补料动作。未被纠正的真实缺料项仍阻断，修订后的新候选仍重新过宿主和独审。

验收：真实 `assessTreatmentReadiness + runRoleAgentLoop` 捕获 revision；全部误分/部分误分/真实缺料/重启后反馈一致。涉及 V10-08、V10-09。

### F04 / P1：图库失败后的改案建议超出导演当前修改权限

位置：`packages/production-pipeline/src/creative-planning.ts:448`；`packages/production-pipeline/src/visual-director.ts:434`；`packages/production-pipeline/src/production-pipeline.ts:7735`。

用户允许图库和生成，编剧最初给普通示意选 stock。图库没有合格候选时，可得性检查把问题派给导演，要求考虑生成/复用；但导演 validator 仅因脚本 visual_strategy=stock 就禁止生成，即使 authenticityPolicy=illustrative、生成 Provider 在允许池内。导演不能修改脚本，因此给出的恢复动作并不能完整执行。

独立探针确认：相同方案/Provider/价格，只将脚本策略改为 generated 就通过。不是当前现金授权或 Provider 能力不足。

最小修正：统一“素材路线建议”和“必须真实取证”的边界。若保持脚本策略不可被导演修改，则涉及策略改变的问题必须回派编剧；若允许导演在用户许可下调整示意获取路线，则同步校验与下游编译。不能仅删除 stock 校验而放开真实事实或用户禁止生成的限制。

验收：正式规划组合完成 no-match → 有权限的角色改案 → 导演校验 → 重新编译/报价，含真实举证、禁止生成的负例；不能仅手工修改 fixture 里的 script 来让导演测试通过。涉及 V10-12。

### F05 / P1：用户修改声音节奏后，执行与规划使用两套配置

位置：`packages/production-pipeline/src/production-pipeline.ts:1175,1200,7850`；`packages/workflow-core/src/workflow-runner.ts:610`。

正式 joint-v1 隔离链已复现：先接受规划，再通过现有声音节点输入编辑把 rate 从185改为120、pause_scale从1改为2并恢复。新声音 receipt 使用120/2，持久化 brief.voiceDirection 仍185/1，构思/编剧/导演次数均1→1、creative-planning仍succeeded。后续返工也从旧 brief 继承声音配置。

这会令新增 voiceTiming 在节点编辑后失真；不能用当前 mock 生成的短音频证明真实语音一定装得下。证据摘要见 `evidence/review-r10-audio-evidence.json`。

最小修正：在现有声音配置业务入口维护同一有效配置；rate/pause变化同步 brief，并按既有阶段依赖让编剧/导演重新判断。构思无需因纯节奏变化重做；音色/mastering单改仍限声音下游。保留素材复用，变更确需新媒体时重新报价。

验收：正式节点编辑→恢复→角色实际输入→声音receipt→返工继承一致；旧授权/未影响媒体不被误复用或无故重买。涉及 V10-06、V10-13、V10-15。

## 其它当前业务与可用性问题

### F06 / P2：选题可制作性仍被关键词和标点机械裁决

位置：`apps/studio/src/server/editorial-decision.ts:45,72,182`；使用方 `candidate-inbox-studio.ts:189`、`series-planner.ts:158`。

已确认：相同高分、来源就绪的候选，“把回家的路，拍成一封寄给未来的信”被置为 skip/0分；只添加问号或把“一封”改成“1封”就变为 produce_video/90分。规则会阻断采用，并非仅给建议。它是既有逻辑，不应全算作 R10 新引入，但与通用表达类视频和高质量选题目标不一致。

建议：保留结构、来源和真实风险硬门；吸引力是否成立由已有总编的语义判断负责，词规则不作独立否决。用等义改写、中文/阿拉伯数字、问号/陈述句与确实空泛的负例验证，不继续加题材白名单。不要为此新增一个模型节点。

### F07 / P2：前期构思缺少完整系列约束

位置：`packages/production-pipeline/src/production-pipeline.ts:4480,4510,5706`。

当前 treatmentBrief 只拿到系列单集 viewerPromise，没有完整 bible/canon/continuity；编剧/导演却会收到。treatment阶段身份同样漏掉这些消费者应看到的限制。可以确认共同依据不完整，但本次没有用真实模型证明已生成冲突情节，不能把它描述成已重现最终成片错误。

建议：在现有构思 brief/审计上下文中传入必要且有界的已确认系列事实，身份与实际输入共用同一投影。验证系列限制变更后构思正确失效、无关历史不影响输入。不增加另一个系列协调 Agent。

### F08 / P2：声音界面未显示各服务实际支持的控制方式

位置：`apps/studio/src/client/components/VoiceStudio.tsx:195,199,207`；`src/video_factory/voiceover.py:553,616`。

各服务统一显示“字/分”“停顿×”；Kokoro实际不消费pause_scale，MiniMax把rate/190转换为相对speed。新audio能力没有贯通该界面，用户可能以为调节已产生承诺的效果。

建议：沿现有Provider信息显示相对语速/停顿提示或不支持说明，保留用户配置。不同服务的组件行为测试足够，不扩大为音乐/音效系统。

## 对架构与可扩展性的判断

当前不是需要换框架的证据。LangGraph的有界创作规划、WorkflowRunner的执行和持久化、Broker原任务查询、Provider执行与授权可以继续复用。三入口汇入共同制作链也合理；前期构思和导演承担全片统筹、声音节点承担实际配音的分工可保留。

主要架构欠账是同一业务意义在入口字段、角色输入、validator、checkpoint、配置编辑和阶段身份里分别维护，改一处没有自动保证其它消费者一致。F01是建议与要求混淆，F03/F04是反馈与权限不一致，F02是保存与读取合同不同，F05是配置与失效关系不一致。增加缓存或新总控Agent不会修复这些问题。

本次应围绕已有边界做小范围归一：同一角色的实际输入/审计/身份共用投影；用户配置统一写入；反馈只能分配给有权完成修改的角色；持久化产物使用同一合同往返校验。不要机械拆大文件或引入万能上下文对象。

新增同交付类型的媒体模型已有Provider/能力目录可复用；新增数字人、口播或多轨音频并非登记模型就能完成，仍需扩展实际能力、交付物、执行与验收合同。当前音频能力还有按Provider id推导、图谱固定规划节点等具体边界；它们不是此时必须开发的功能。未来按真实新形态扩展这些边界，保留现有报价、引用、恢复、渲染和审片能力即可。

## 验证证据与范围

主审独立执行：

- 恢复探针：第一次通过、同checkpoint重放失败，exit 1。归档 `evidence/review-r10-host-recovery.mts`。
- 两个规划探针：确认矛盾修订输入、no-match建议与导演校验冲突，exit 0（表示缺陷复现，不表示正确行为通过）。归档 `evidence/review-r10-planning-probes.mjs`。
- 入口等义输入/自动建议探针：确认F01/F06的数据流前段；UI现有测试确认建议被复制入visualIntent。归档 `evidence/review-r10-entry-probes.mjs`。
- `node --test --test-concurrency=1 --import tsx apps/studio/test/editorial-decision.test.ts`：15/15，exit 0；现有测试未覆盖等义输入问题。
- 在apps/studio执行 `npx --no-install vitest run test/client.test.tsx -t 'keeps an untouched upstream visual plan as planning guidance' --reporter=dot`：1通过，其余137项因定向选择未运行，exit 0。
- 主审读取声音隔离run及前后receipt确认F05；隔离正式Pipeline操作由分项审查执行，无真实模型/媒体。
- `git diff --check`：通过。没有重复已经执行完的全部构建与全量回归。

归档探针从仓库根执行：

```sh
node --import tsx docs/codex-collaboration/evidence/review-r10-host-recovery.mts
node --import tsx docs/codex-collaboration/evidence/review-r10-planning-probes.mjs
node --import tsx docs/codex-collaboration/evidence/review-r10-entry-probes.mjs
```

本报告不代替真实QA。E10-01～09仍无本轮真实成片/双审/音频/返工证据；新增性能指标有助于解释耗时，但没有同模型同证据对照证明提速。当前也不能把所有慢归因于网络或模型本身：已经存在会造成无效修订和恢复失败的确定性产品原因，实际占用时长需修复后记录。

## 推荐下一步

先集中修正上述交接缺陷并补“前一节点的真实输出进入后一节点”的组合回归，尤其恢复、建议优先级、修订反馈、素材改案权限、声音编辑。保留所有真实性/授权/局部范围/双审安全边界。代码收口后再跑一轮有界真实本地QA，主片贯通报价→素材→声音→渲染→双审→局部返工；同条件同根因失败停止该链并继续独立项，统一记录，不以换题和反复重试制造通过。

这份文件是审查结果和最小修正建议，不是产品已修复的报告，也不额外授予付费、部署或提交权限。

## 2026-09-14 讨论补充：热点内容阅读

用户已明确赞成并要求记住：热点不能只根据热榜标题形成最终推荐。标题与热度用于初筛，对入围事件读取原文，提取关键事实、出处及不确定信息，再发散成不同视频选题供用户选择；读不到正文时明确标记“仅有标题”，不声称已阅读或核实全文。

当前源码依据：`trend-gateway.ts` 只提取标题/链接/排名等榜单元数据；`topic-ideas-payload.ts:modelSignal` 没有正文或摘要字段；`trend-opportunity-agent.ts:groundModelIdea` 的依据是标题拼接。现有来源数量门仅检查链接/域名，不能视为内容核验。这是已确认的改进方向，具体抓取实现、长度与缓存策略尚未选定，不能据此扩展为全网爬虫项目。

用户同时询问要求/建议分离、导演改路线、有效审计反馈、配置依赖同步、恢复与声音界面这五项的架构影响。当前建议：整体中等范围，沿用既有角色、规划图、存储、Broker与执行器；配置变更的失效/复用/重新报价联动风险最高，应以正式组合测试保护。用户明确采纳的建议也属于已确认要求，不能仅因其非手工输入而丢弃；默认预填不等于明确采纳。讨论不表示本次已开始修改产品代码。
