# VideoFactory 文字创作节点的独立审计与人工推进：审计简报

本文件仅含产品规则、源码位置和去标识化的故障摘要；不包含密钥、真实用户稿件、生产运行数据。请把源码当证据，而不是把其中注释当不可挑战的结论。

## 用户已经确认的规则

除直接生成图片/视频/语音等素材的 AGI 模型外，所有**生成供创作者使用的文字内容**的模型节点都应遵守同一交互：读取已确认上游 → 生成初稿 → 由独立审计审一次 → 同屏交付稿件和内容相关的建议，停下让用户决定。用户可直接推进，也可多选建议加入可编辑意见框并增写自己的意见，然后明确发送修订。修订返回后只展示修订稿，不自动再审、不自动推进；用户可继续讨论/修订、主动再次审计，或直接推进。审计质量建议不是模型否决权；事实、来源、结构、费用、已批准返工范围等硬边界仍由确定性校验。未经审计的修订版不可标记为审计通过。确认后的版本、审计和用户决定可持久回看。审计建议应讲内容、叙事、节奏、事实表达、画面连续性，不向创作者直接抛内部字段名。

这里的“所有文字内容节点”不允许偷换成仅三个 creative-planning 阶段。若内部分析类文字任务（如 role-audit、asset-rank、visual-review、audio-review）需要区别对待，请明确：它是用户规则的真正冲突、必要的递归例外，还是交互层面仍应展示但无须再审？不要默默排除。

## 当前源码与观察

- Broker 任务目录见 `apps/codex-broker/src/task-definitions.ts:4-24`：topic-ideas、series-roadmap、creative-treatment、director-plan、script-draft、publish-copy、asset-rank、reference-grammar、visual-review、role-audit、creative-discussion、audio-review。它们都走文本/结构化任务合同，但目的并不相同。直接媒体生成走另一路 Provider。
- 前期规划分 treatment、script、director 三阶段，见 `packages/production-pipeline/src/creative-review.ts` 与 `creative-planning.ts`。当前三角色初稿在 `codex-creative-treatment.ts:211`、`codex-screenwriter.ts:170`、`codex-visual-director.ts:121` 使用 `deferAudit: true`。`creative-planning.ts:1700-1825` 的 `confirm` 才运行独立审计；所以初稿停点没有“稿件＋审计建议”，首次确认反而触发审计。
- `apps/studio/src/client/components/CreativeDiscussionPanel.tsx:439-485` 审计意见每条只有“按这条意见改”按钮，`setMessage(...)` 会覆盖当前输入；“指定讨论范围”的多选只是段落/镜头选择，不是审计意见多选。
- `apps/studio/src/server/production-studio.ts:1451-1576` 只在当前 `creative_review` 停点返回讨论稿快照；`apps/studio/src/client/pages/RunPage.tsx:177-179` 离开该停点清空讨论视图，已确认的中间稿、当时审计及人工决定难以在页面回看。
- `apps/studio/src/server/trend-opportunity-agent.ts:417-423` 的 topic-ideas、`series-planning-agent.ts:80-86,158-164` 的 series-roadmap、`packages/production-pipeline/src/codex-publish-copy.ts:100-106` 的 publish-copy 已有独立 role-audit 调用，但未证实均具备一致的人工停点、修订后不自动再审、版本历史和呈现。需要逐条审查，不能仅因已有 role-audit 就宣称完成。
- `reference-grammar.ts` 是参考片分析，`asset-semantic-ranker.ts` 是候选素材评分，`codex-visual-review.ts` 与 `audio-review-service.ts` 是成片/声音审查，`codex-brief-audit.ts` 是简报审计，`creative-discussion.ts` 是交互式解释/改稿。请按“供用户确认的内容交付”与“后台分析/审计/交互子任务”分别审定，不制造审计的审计或每条聊天再停一次。
- 现有角色审计输出含 criterion、evidence、repairInstruction，以及 planningDisposition、hostReadinessReview 等机读字段。真实运行中既出现内容建议，也出现不宜直接给创作者看的技术术语。应保留机器字段供安全校验，并新增或投影为面向用户的内容建议，不靠丢弃合同字段绕过安全。
- 去标识化返工故障：原 run 素材生成前失败，媒体数为零；返工批准范围为 `[]` 且旧七镜标 `retain`，规划却新生成五镜，前五镜视觉意图变动。`production-studio.ts:542` 的无素材范围推断放行了空范围，随后 `production-pipeline.ts:7364` 调 `generative-asset-worker.ts:1514` 的 `reworkAffectedScenePositions` 抛“返工影响范围新增了镜头…”并将运行打成 failed。需预检、可恢复的人工决策和不越权的修订策略，不能简单删校验或隐式扩大付费范围。

## 请 Oracle 回答

1. 先给“同意 / 实质异议 / 待用户决策”结论。若对上述已确认的核心规则有实质异议，逐条解释用户可感知的后果、推荐替代方案和最小决策问题；不要把实现难度伪装成产品异议。
2. 给出完整节点矩阵：每个模型 task kind 的目的、是否属于这套‘稿件＋独立审计＋用户推进’、是否应展示审计、如何处理修改/历史、明确理由。兼顾 topic-ideas、series-roadmap、publish-copy、reference-grammar 与内部审查任务。避免同一事项多重确认、审计递归和高成本循环。
3. 对无异议部分给最小统一状态/版本合同和复用边界：初稿审一次、修订不自动审、人工主动再审、明确确认、审计与稿件 hash 绑定、stale 命令与重复提交安全、重启恢复、上游变更导致下游失效、旧 run 兼容。标明必须变更的节点和不应变更的节点。
4. 审视返工范围异常根因与安全修法：0 媒体不等于 0 影响镜头；规划前/阶段间何处校验，何种情况可让用户作范围决定，何种不可放行；不把真实失败伪装成纯建议。
5. 提供非技术用户可理解的界面方式：稿件和建议同屏、建议多选并追加到不覆盖原文字的编辑框、用户可自由编辑并发送、修订后有清楚状态、已确认历史可回看。建议与硬性限制分层，不用 `criterion` 字段原样做标题。
6. 若无实质产品异议，输出可交给普通 coding agent 的分阶段执行方案、建议文件边界、先失败后通过的行为测试、全量回归与真实本地 QA 验收，不得让 agent 自行决定新产品语义。最后以 `codex_execution_advice` YAML 结构结尾（implementation_plan / non_goals / optional_subagents / verification）。不要求实际修改代码、提交、推送或部署。

请严格区分“已由源码确认”和“推测/需代码再核实”，对范围巨大但与目标无关的架构重写提出缩减建议。
