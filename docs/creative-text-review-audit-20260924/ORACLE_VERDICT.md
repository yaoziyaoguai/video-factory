# Oracle 审计结论与证据边界

审计会话：`vf-text-creation-review-20260924-06`。本地记录：`/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-text-creation-review-20260924-06/artifacts/transcript.md`。会话状态 `completed`，发送动作已提交，工具在发送前两次核实能力滑块为 `第 5 项，共 5 项`（右端）。临时 Chrome 与临时 Profile 已清理。

## 裁决

Oracle 明确回答：**同意，没有实质产品异议。**用户已定的交互规则可以作为实施基线：面向创作者的文字交付，初稿生成后独立审计一次，同屏给人；用户可直接采用，也可多选建议并追加自己的文字后明确修订；修订返回不自动审计或推进；用户可主动再审。质量建议由人取舍，事实、来源、结构、费用和已批准返工范围不能被“接受建议”绕过。

它提出两项边界澄清，均非反对上述规则：

1. `role-audit`、`asset-rank`、`visual-review`、`audio-review` 是评价/分析任务，不对其报告再递归加“初稿＋独立审计”。报告仍应绑定所审版本并给用户看；其修改建议不能自动执行。
2. `creative-discussion` 是原内容节点的讨论/改稿子任务，不每条聊天单独审计。若它产出修订，版本归属原内容节点，并标为未审。

`reference-grammar` 按实际输出去向分类。当前仓库 `apps/studio/src/server/production-studio.ts` 同时把它列入 `WORKFLOW_NODES` 和 `EDITABLE_DOCUMENTS`，因此**现有作为可供创作者查看/采用的参考分析报告的路径必须纳入**；纯后台特征提取调用不另设确认。编码前仍要核对真实消费者，不能凭名称排除。

## Oracle 证实的缺口与本地复核

| ID | 现状 | 证据边界 |
| --- | --- | --- |
| TX-01 | `publishCreativeDraft` 产生未审新稿，而 `confirmCreativeDraft` 必须有当前稿审计；`parseCreativeReviewResume` 无主动审计动作。 | Oracle 对 `creative-review.ts` 状态函数做了只读复现；我们复核了对应源码。外层编排仍需实施端逐条确认。 |
| TX-02 | 系列规划、发布文案有产审自动循环或分叉调用，不能因“三阶段改完”宣称全节点覆盖。 | `series-planning-agent.ts`、`codex-publish-copy.ts` 已读；实际消费者需沿调用链核实。 |
| TX-03 | 仅用稿件 hash 不足以区分 A→B→A 的三个版本；审计可能在纯状态函数层回挂。 | Oracle 局部复现，不等于已证明线上越权；必须检查服务端和 checkpoint 的额外防线。 |
| TX-04 | `discuss` 没有确定性请求模式，模型返回 `intent: revise` 可改当前稿。 | `creative-review.ts` 的状态合同成立；上线实际频率未验证。 |
| TX-05 | 状态主要保留当前/上一稿，不能由此保证每个已确认版本、审计、决定都可回看。 | 其他工件存储可能仍有历史；要盘点后再设计最小持久引用。 |
| TX-06 | 审计意见按钮覆盖输入；`pass` 下的有效建议未在当前建议区展示；“讨论范围多选”不是“意见多选”。 | `CreativeDiscussionPanel.tsx` 直接证实。 |
| 返工范围 | 零媒体不等于零影响；批准空范围且全 `retain` 与变化的五镜候选冲突。 | 去标识化故障记录与关键源码片段支持修复方向；完整恢复链未附给 Oracle，须实施端核实。 |

Oracle 未运行全仓测试，也未验真实本地流程。它的咨询结果不是代码通过或部署放行。`IMPLEMENTATION_CONTRACT.md` 将这些建议与实际源码核对后定成执行合同；如未附源码中出现相反事实，执行端先记录证据并在 RESULT 中说明，不得悄悄改变用户规则。
