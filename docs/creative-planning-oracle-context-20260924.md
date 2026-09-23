# VideoFactory 创作规划与制作进度：Oracle 评审输入

本文件是脱敏的技术与产品证据，不包含生产 run 的原始创作内容、凭据或账单。请结合随附源码分析，不要把本文件的诊断当作不可质疑的结论。

## 已确定的产品合同

- 目标是用户主导的高质量短视频制作，不追求无人值守自动通关。关键交付节点应停下，让用户阅读、讨论、修改，用户决定何时进入下一步。
- 构思/脚本/导演方案的质量审查给意见和风险提示；用户可在知情后接受质量风险继续。真实来源、授权、产物身份、费用与安全事实不能伪装或通过质量按钮绕过。
- 用户此前明确要求：导演生成初稿后，先停下与导演讨论多轮；停止讨论的时机由用户决定。图库/生成的获取方式可以由导演建议，但新购买重新报价；必须真实取证的镜头不能改为生成。
- 现阶段优先做通一条真实成片主线，同时保留可追溯的阶段、费用、来源和人工决定。不要删除现有功能或把六类真实规划产物降格成展示用摘要。

## 本次云端 run 的只读事实（匿名化）

- 外层节点 `creative-planning` 状态是 `succeeded`，当前有效版本登记了六类正式产物：`creative_treatment`、`script`、`storyboard`、`asset_candidates`、`asset_ranking`、`executable_plan`。六份文件存在，登记信息与磁盘 SHA-256 对齐。
- 同一 run 实际停在后续 `assets` 节点，Worker 在 `asset.prepare` 的约 11 ms 内抛出 `WorkerProtocolError`；不是质量审查拦下创作规划，也没有进入正常素材处理。
- 但页面的创作规划阶段把「正式方案」显示为「未通过，请重试生成或重新规划」，交付区域同时写「本步骤没有需要人工阅读的内容」。
- 当前创作规划节点 `output` 仅有 `scriptPath`、`directorPlanPath`、`executablePlanPath`、`candidateSearchPath`、`candidateRankingPath`、`candidateInventoryPath`、空 `canonFacts` 等；可读正文在正式产物文件中，不在节点 `output` 本体。
- 这条 run 的 checkpoint 显示内部图节点按下列顺序串行推进：构思 → 构思人工复核 → 脚本 → 脚本人工复核 → 导演初稿 → 候选检索 → 排序 → 可得性检查 → 画面整合 → 再检查 → 导演人工复核 → 正式方案。构思第一次确认后独立审查给 `repair`（82 分），仍停在构思；用户第二次确认才前进。脚本和导演最终各获 `pass`（85 分）。
- 导演初稿完成时，导演人工确认阶段仍是 `drafting`，图已进入 `candidates`；候选、排序和整合完成约五分钟后，导演讨论才变为 `waiting_user`。这与上方用户合同不一致。
- 运行期间阶段面板可把「导演方案」标「已完成」，因为只检查是否有 `directorPlan` 产物，不检查该版本是否经过用户确认；面板还省略了 `evaluate`、人工审查、回退与修订语义。

## 可复现的最小信号

1. 本地 `hasCreatorDocumentContent("creative-planning", {scriptPath, directorPlanPath, executablePlanPath, candidateSearchPath, candidateRankingPath, canonFacts: []})` 返回 `false`，即使六类正式产物存在。页面因此走空交付文案。
2. 本次 run 在导演初稿 checkpoint 同时满足 `directorPlan != null`、`creativeReview.stages.director.phase !== "confirmed"`、下一图节点为 `candidates`。所以「已完成」与「用户已确认」不是同一状态。
3. 图库风险接受记录确实存在于这条 run 的候选排序文件；正式脚本的 SHA-256 与记录一致，经时长投影得到的 `executable_script.json` 的 SHA-256 与记录不同。其余导演方案、候选库存 SHA-256 均匹配。

## 精确代码线索

- `packages/production-pipeline/src/production-pipeline.ts`：`planningCommitArtifactIds` 约 3412–3489 行重算 commit key 时遗漏可选 `stockAcceptance`；正式发布约 7927–7939 行把它算入。只读投影于是错误认为 commit 不存在，在约 3320–3361 行显示「正式方案未通过」。严格产物完整性校验本身要保留。
- `src/video_factory/worker.py`：约 109 行 `prepare_assets` 先调用 `materialize_executable_script`；约 153–156 行把 `deliveryAcceptance.scriptSha256` 与返回的投影后 `script_path` 比较；约 541–583 行会因 `executablePlanPath` 存在而写出新 `executable_script.json`。风险接受记录的 `scriptSha256` 却在 TS 发布侧按原始正式脚本计算。应查清校验对象，不能简单去掉哈希检查。
- `apps/studio/src/client/components/NodeWorkspace.tsx`：约 154–155 行只拿 `node.output` 算 `hasDelivery`，约 187–205 行只按 `selectEditableArtifact` 读取单个产物；约 729–741 行 `EDITABLE_ARTIFACT_KIND` 没有 `creative-planning`。约 610–624 行空交付文案随之出现。
- `apps/studio/src/client/creator-document-policy.ts`：未登记 `creative-planning` 专属输出视图，`*Path` 被锁定且 `canonFacts` 此 run 为空；代码约 145–169 行。
- `apps/studio/src/client/components/NodeDeliveryPreview.tsx`：`PRIMARY_FIELDS`、`COLLECTION_FIELDS`、`NESTED_FIELDS` 没有 `creative-planning`；空列表时约 230 行显示「没有需要人工查看或修改的创作内容」。
- `apps/studio/src/client/pages/RunPage.tsx`：约 176–188 行，`activeIntervention.kind !== "creative_review"` 时清除讨论快照；已完成阶段的可读正文不在持久展示区重建。
- `packages/production-pipeline/src/creative-planning.ts`：约 797–882 行两条条件图；图库路线为 `director → candidates → rank → evaluate → integrate → evaluate → director_review → compile`，可回退 `script/director`。评审必须区分“图按顺序运行”与“产品定义的停点是否放对位置”。
- `packages/production-pipeline/src/production-pipeline.ts`：约 3297–3353、6584–6601 行，阶段 `completed` 由产物是否存在决定，不等于独立审查通过或用户确认。
- `apps/studio/src/client/components/RunWorkbench.tsx`：约 283–295、1619–1633 行展示外层五阶段进度；内部七阶段另由 `PlanningStagesPanel` 展示。双层计数和长清单让创作者难以辨认「现在需要我做什么」。

## 现有页面与用户反馈

- 当前外层是「制作进度 N / 10 步」和五个阶段卡；展开创作规划后又是七条平铺的阶段卡、每阶段模型选择和细节，交付区域却为空。长审计摘要、配置和失败/恢复操作与进度同时出现。
- 用户的直接反馈：步骤展示“土气、机械、繁杂、不舒服，好像没理清楚”；希望更清爽、有品位，但不能用炫技动效掩盖状态或让用户失去推进主动权。
- 特别要让用户一眼读懂：当前交付是什么、下一步是谁、为什么等待、可以讨论/修改/继续什么、费用会不会发生，以及已经完成的内容如何回看。

## Oracle 需要回答

1. 独立审查上述两个工程根因和四个交互问题是否充分；指出遗漏的交叉风险，不发散到无关模块。
2. 给一份当前 Codex 能按序实施的修复包：改动边界、精确文件/函数、数据合同和兼容策略、先失败后修复的回归测试、真实旧 run 的恢复验证、安全与成本边界。不要建议绕过产物/版权/费用硬约束；不要删除用户历史 run。
3. 对步骤展示给一个明确推荐方案，并简短比较 1–2 个备选。请提供信息架构、桌面/手机布局线框（文字即可）、状态文案、折叠层次、已完成产物回看、讨论多轮、重新规划/失败恢复、费用确认、动效和 reduced-motion、键盘/读屏行为。目标是创作者感觉从容、优雅、可控，不是花哨面板叠面板。
4. 给明确验收 ID、最小测试切面和人工 QA 检查点。区分可以自动验证与必须真实运行验证。
5. 分析与实施建议分开，末尾必须给 `codex_execution_advice` YAML，含 `implementation_plan`、`non_goals`、`optional_subagents`、`verification`。Oracle 只提建议，不修改文件、不执行外部操作。
