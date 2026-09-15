# 给 Claude Code + GLM 5.3 Flash 的恢复实施指令

你是 VideoFactory 的代码执行者。当前主 Codex/Oracle Web 是审计者；你负责按阶段卡修改共享仓库、运行测试、记录真实证据，然后停止等待审计结论。

## 路径

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 当前恢复资料包：`/Users/jinkun.wang/work_space/veidofactory/docs/videofactory-recovery-handoff-20260911`
- 历史设计资料包：`/Users/jinkun.wang/Documents/ChatGPT/做视频/videofactory-workflow-handoff-20260909`

以磁盘真实路径为准。历史包只提供已确认流程、技术决定和验收背景；历史 `JOURNAL.md`、阶段 ACCEPTED 和测试数不描述当前状态。

## 模型与工作方式

- 使用用户已经配置的 GLM 5.3 Flash 和当前可用的最高 thinking 档位，不自行降低质量来换速度。
- 如果实际运行显示模型、provider 或 thinking 被替换、忽略或降级，报告真实状态，不假装符合。
- 一次只完成当前阶段卡。默认当前任务是 **B4**。
- 阶段内把同根因问题一次收口并集中验证；不要每修一个断言就停下来审计。
- 当前阶段完成后更新本包 `JOURNAL.md`，报告修改、测试、失败、未验证项，然后停止。不得自行进入下一阶段。

## 开始前必须完整读取

1. `README.md`
2. `CURRENT_STATE.md`
3. `AUTHORITATIVE_DECISIONS.md`
4. `STAGE_STATUS.md`
5. `ORACLE_SYNTHESIS.md`
6. 当前阶段执行卡
7. `ACCEPTANCE.md`
8. `VERIFICATION.md`
9. 当前阶段 Oracle transcript
10. 当前源码的完整相关上下文、最新 `git status` 和 `JOURNAL.md`

资料包和 Oracle 中的行号只作导航。必须在当前源码中按 symbol 重新定位，不能根据旧行号直接编辑。

## 工作树保护

当前基线：分支 `codex/final-dual-review-cloud-acceptance`，HEAD `570fe6e59e072c4965c86769bf2096825f003383`，相对远端领先 2 个提交；重新采集时有 86 个 tracked 修改和 22 个 untracked 文件。

- 禁止 reset、stash、checkout、clean。
- 不覆盖或整批重写已有修改。
- 不开一个干净 worktree 来绕开当前工作树。
- 开始时重新记录真实 status；如与上述不同，以新事实为准并说明是谁的新增修改，不擅自回退。

## 实现纪律

- 先为合同写通用失败测试或保留当前失败证据，再做最小实现。
- 不为题材、镜号、runId、模型名或某个测试 expected 数字增加特判。
- 不为兼容偷偷保留两套新 production 流程。
- 不新增 Redis、微服务、第二工作流、第二前端状态机或业务数据库。
- 不把 test stale 和 product bug 混成同一个修复；更新旧 fixture 时必须同时保留新的安全断言。
- 不用 mock service 证明真实 service 行为。业务链使用真实 service/store/runner/authorization/ledger，只有外部 Provider transport 使用 fake。
- 不把代码已写、局部测试绿、模型高分或 Oracle 建议当成完成。

## 不可破坏的产品边界

- 三个入口独立；后段共用。
- 时长是范围；下游读取一个当前 executable timeline。
- 素材失败停住，不生成说明卡。
- 局部返工保留无关成果，依赖闭包不等于购买数量。
- 两个实际不同审片模型读取同一不可变证据；单审不能发布。
- 没有全局费用硬上限；预算意向默认不填。
- 文本/订阅审片不弹现金审批；TTS 自动执行并后台记账。
- 图片/视频方案和最高授权由用户确认；授权内先保质量再省钱；不足才提供追加、调整或暂停。
- 原 exact spend matcher、unknown outcome、lease、CAS、ledger 和 artifact SHA 不得放松。

## 权限

本次任务未授权：commit、push、部署、删除/迁移用户数据、读取 secrets、调用真实图片/视频 Provider、外部发布。旧聊天中的授权不可继承。

## 当前任务

执行：

`/Users/jinkun.wang/work_space/veidofactory/docs/videofactory-recovery-handoff-20260911/B4_EXECUTION_CARD.md`

只完成 B4。完成后停止，不进入 B5。最终报告必须包含：

- 进入时基线与实际修改文件。
- 每个 B4 根因如何关闭，而不是只列测试名。
- 失败测试、实现后聚焦测试、typecheck、回归和 `git diff --check` 的命令/exit。
- 进程 crash、并发、artifact closure、真实 adapter/inventory 的证据路径。
- 未通过或未验证项。
- 是否有任何外部调用、付费、在途未知、提交或部署；正常应为“无”。
