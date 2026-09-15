# 当前任务：Revision 11 — 用户主导创作讨论与交接修复

- taskId：`VF-CREATOR-COLLABORATION-R11-20260914`
- revision：11
- status：`READY_FOR_IMPLEMENTATION`（资料包完成，不代表产品已实现）
- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 完整资料包：`/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/revision11`

## 1. 先读这些，不从旧聊天猜任务

完整读取 revision11/README.md 并按顺序读取：

1. implementation/01_PRODUCT_AND_UX.md
2. implementation/02_TECHNICAL_DESIGN.md
3. implementation/03_EXECUTION_PLAN.md
4. implementation/04_ROLE_PROMPTS.md
5. implementation/05_ACCEPTANCE.md
6. qa/01_RUNBOOK.md
7. qa/02_CASES_AND_REPORT.md
8. revision11/BASELINE.json、REVIEW_REVISION10.md、RESULT.md 的R10和最新R11段落。

上面 implementation 和 qa 路径均相对 revision11。旧TASK已原样保存到TASK_REVISION10.md；旧资料只作历史导航，不重新实施A/B/C或R10。

## 2. 当前真实状态

R10已经有实质代码改动及自动化验证记录，但本窗口实际源码/组合审查是CHANGES_REQUIRED。确认的F01–F08见REVIEW_REVISION10。新要求的三阶段讨论确认和热点原文阅读尚未实现。

开始资料包时HEAD为b36ebac3189cf574b8e437cbe16eb9d0b228a177，branch为codex/final-dual-review-cloud-acceptance，暂存区为空；BASELINE记录316个现有文件摘要。已有dirty成果属于用户，不能回滚。另一个窗口可能继续修改，开工先核对实际状态与RESULT。

## 3. 本轮必须一起做

- 保留三入口、模板退出新生产而管理/历史保留；不后台补固定套路。
- 用户要求与自动建议分开；明确采用才升级为约束。
- 导演初案、脚本、分镜/画面方案各自草稿后等待，多轮自然讨论；用户确认当前版本后才进入下一阶段，绝不把聊天当付款。
- 采用、撤销、局部讨论、上游返回、模型选择、移动端/刷新/重启可用；不只加前端暂停按钮。
- 修恢复读写合同、误分类有效反馈、导演素材路线权限、声音共同配置与依赖、系列前期约束、机械词规则裁决与声音界面。
- 热点入围后读原文、保留证据和不确定项，再由现有总编发散；真正把来源传入制作链。
- 保留现有时间轴、媒体复用、精确授权、TTS自动后台记账、局部返工与双真实模型审片。恢复unknown只观察原任务。

不换框架/数据库，不建通用聊天/版本/核账平台，不增加监工Agent、不做数字人/短剧。不为题材、镜号、runId、模型名增加语义特判；不降模型强度或质量标准。

## 4. 执行方式

执行端实现全部S0→S6，阶段内正常聚焦红绿，全部范围收口后一次集中回归与自查，再进入真实本地QA。不要完成一点就外部审计，不每改一点就部署。技术细则/接口/状态/依赖以02为准，验收以05为准。

一个窗口维护本任务与方案；执行窗口只追加RESULT的R11实际进度/证据/未验证项，不改验收条件迎合实现。QA详细报告写docs/qa/videofactory-real-local-qa-<实际日期>-r11.md，RESULT链接它。

## 5. 权限

允许范围内代码/测试/文档修改与确定性验证；实现验收通过后，允许正式本地构建/启动/正常重启及真实QA，按现有本地配置加载本项目所需凭据但不显示或外发秘密。

用户本次明确授权测试端代用户确认创作及图片/视频费用，本轮所有QA新增现金最大暴露合计上限 **¥50.00**，包括媒体/TTS/在途/未知，跨run和session共用。不是产品全局限额，不是每条片50元，不新增订阅/充值。详细费用纪律见qa/01_RUNBOOK。无需重复询问该已授权额度。

不commit/push、不云部署/外部发布，不删除/迁移历史数据、不reset/stash/clean、不升级工具、不启动Oracle或把私有资料发外部。需要突破50元、无法替代的新登录/权限、破坏性操作或改变本包产品决定时停止相关路径并询问用户。

## 6. 完成与停止

执行状态：IMPLEMENTING→CODE_VALIDATED→LOCAL_QA_RUNNING→READY_FOR_REVIEW。另列QA_PASSED或QA_DONE_WITH_CONCERNS。

真实QA先记录问题与根因、尽量完成独立用例；同根因不盲重试、不边测边改产品，测完交回报告后停止。没有完整新主片/真实音轨/双模型审片/局部返工证据必须列缺口，不能只用自动化测试通过宣称产品验收通过。

本次资料编写没有修改产品代码、运行真实模型/媒体或使用测试额度。执行端开始后用自己的实际证据更新状态。
