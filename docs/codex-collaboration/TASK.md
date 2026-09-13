# 当前执行任务：Revision 9

- taskId：VF-R3-CLOSURE-20260912-01
- revision：9
- status：READY_FOR_IMPLEMENTATION
- 仓库：/Users/jinkun.wang/work_space/veidofactory
- 审查窗口维护TASK/REVIEW/方案，执行窗口修改产品并追加RESULT。此包没有自动启动执行窗口。
- 原TASK完整归档为TASK_REVISION8.md，不重做其中已通过的修复。

## 目标与三组强制范围

让现有通用视频流水线在不降低创作质量的情况下真正可制作、用户能理解和恢复；用真实完整新片验证，不能只让一个题目或测试通过。

本轮三组必须一起做，不是后续建议：

1. W1：用户明确要求不被自动建议覆盖；模板默认方法可适配，保留叙事职责、真实性、质量与用户/系列明确约束。
2. W2：区分构思质量与制作前提；缺专属核心证据及时反馈，高分不放行；修正一槽一镜、视频必须两个节拍等机械限制，保留时间完整性与执行校验。
3. W3：模型切换真实生效、失败消费到可恢复状态、重启进度保真、全节点调用/耗时可信、查询完成竞态。五项均不可当“附带问题”漏掉。

用户已确认：导演可在承诺、真实能力、时长范围和授权内主动优化质量与成本；更改核心承诺、专属实测改生成、实质改变确认方案须用户决定。模型规划不是购买授权。

## 必读：四份当前文件

完整按序读取：

1. /Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/TASK.md
2. /Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/REVIEW_REVISION8.md
3. /Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/IMPLEMENTATION_REVISION9.md
4. /Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/VALIDATION_REVISION9.md

然后读取RESULT的Revision 8及后续新内容、最新真实QA：

- /Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/RESULT.md
- /Users/jinkun.wang/work_space/veidofactory/docs/qa/videofactory-real-local-qa-20260913-07.md

相关安全回归保留ACCEPTANCE.md。PROMPT_REVISION.md和旧A/B/C资料仅作历史导航；语义冲突以当前四份文件为准，不能重引旧机械限制。此优先级不削弱CAS/lease、原任务结清、费用授权、双审/返工边界。

## 开始基线与源码检查

- 准备时HEAD：570fe6e59e072c4965c86769bf2096825f003383；分支codex/final-dual-review-cloud-acceptance。
- 用户确认后，现有150个产品/测试/配置文件已本地保存为`10592eb6538b8c2e755c1d3744764fd97be2246b`，内容未变。当前资料随第二笔文档提交保存；执行端从包含本TASK的最新HEAD开工，两笔都不推送。详情见LOCAL_COMMIT_PLAN.md，不再把准备时旧HEAD当成必须回退的目标。
- 产品/测试/配置基线：/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/evidence/r9-start-baseline.json，322个路径SHA256；不含docs。
- 现场核对HEAD、git status、staged和基线hash；保留A/B/C、revision1–8所有修改。本地commit可变HEAD而不改内容，不能只因HEAD改变认定污染；记录差异。内容已变先核对RESULT和并行窗口，不能覆盖成果。
- 文件/行号只是导航，改前完整读相关函数与调用链。只让一个执行窗口写产品。
- 先运行evidence/r9-director-contract.test.mjs记录原红灯，再为共同根因补正式行为用例。

## 执行方式

W1→W2→W3连续完成，不做一小项就停下等审计。按IMPLEMENTATION路径，不另选框架或产品语义。允许聚焦红绿迭代；所有修改后集中回归、最终build、source/dist验证、本地部署、真实QA。

QA按VALIDATION有界安排：一轮测完可测范围再集中修，不每修一点重启一次。正例出片、负例早停、三入口、两真实模型、返工如实覆盖；同因不无限重试。上下文切换在RESULT记录续接点，不重新调研工具/重做任务。

F05仍有未定位部分，先找正式失败链第一处丢失边界；不能把相邻诊断修复当全部根因消除。同范围真实缺陷集中修；需要新架构/产品能力带最小决定交回。

## Non-goals与固定约束

- 不重做A/B/C，不加框架/数据库/缓存/队列服务/监督Agent/顶层run状态/新视频方式，不把大文件拆分或全库清理变支线。
- 不按题材、镜号、runId、模型名称特判；不删质量门/降分数、模型、effort、输出上限，不增循环掩盖失败。
- 不接生产fake broker，不伪造来源/审片/费用/完成状态，不删历史数据解锁；替身只用于隔离测试。
- 不重启pi/Claude/Copilot协作或升级Oracle工具；执行端沿用用户当前配置，实际模型/强度被替换须报告。
- 不为清理dirty而回滚/reset/delete；本地commit独立授权，见LOCAL_COMMIT_PLAN.md。本任务不让执行端顺手commit/push。

## 权限与停止条件

代码/测试修改与隔离验证在本任务范围内。本地正式部署、真实QA依用户启动消息现行授权执行；此包不是密钥值或付费凭证，不向外发送私有材料。

授权真实QA与小额花费时可自行确认精确媒体报价；沿用上轮¥50新增媒体+TTS的QA止损，不是产品上限。记录授权、范围、金额及未结清暴露；超额须追加。文本/订阅审片不引入现金审批，TTS自动后台记账。

未经新明确授权，不commit/push、云部署、外部发布、删迁移数据；不修改TASK/REVIEW/方案/历史RESULT。unknown只查原请求，不靠删除/重启/换路由重买。

全部实现及有界验证后，追加RESULT Revision9，映射V9-01–12/E01–07、退出码、费用与未验证，设READY_FOR_REVIEW并停止产品修改，交审查窗口一次统一复核。真权限/产品阻断可提前报告。不得将“可交审查”写成“产品通过”。
