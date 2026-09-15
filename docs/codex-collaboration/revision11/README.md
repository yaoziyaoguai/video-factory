# Revision 11：创作讨论确认、交接修复与真实本地 QA

任务编号：`VF-CREATOR-COLLABORATION-R11-20260914`。状态：`PACKET_READY`，尚未实现。

仓库实际路径：`/Users/jinkun.wang/work_space/veidofactory`。

本包根据 2026-09-14 用户确认的产品方向编写。目标是让通用视频流水线更容易产出高质量、有吸引力且兑现承诺的视频，同时让普通用户能理解、讨论和决定。不是保证流量爆款，也不是为某个测试题制作专用流程。

## 两个包，按顺序执行

1. **实现包**：从[产品与交互](implementation/01_PRODUCT_AND_UX.md)和[执行顺序](implementation/03_EXECUTION_PLAN.md)开始。先修 R10 的真实缺陷，再完成三阶段讨论确认、热点原文阅读及必要交接。局部红绿测试随开发进行，完成后集中回归、自查。
2. **测试包**：[真实本地执行规则](qa/01_RUNBOOK.md)和[测试用例与报告](qa/02_CASES_AND_REPORT.md)。实现验收通过后，用正式本地构建、真实 Broker/模型/媒体和 QA 技能测试。用户在本次明确授权：可代替用户确认方案和费用，本轮新增现金总暴露不超过 **¥50.00**。测试先集中记录问题与原因，最后交回报告，不启动无限修复/重测循环。

给执行窗口的单一入口：[MASTER_PROMPT.md](MASTER_PROMPT.md)。

这次只是生成资料包；编写者没有修改产品代码、运行新 QA、创建真实任务或消费这 50 元。

## 完整阅读顺序

- `../TASK.md`：当前任务、权限和启动顺序。
- 本 README 与 `BASELINE.json`。
- `implementation/01_PRODUCT_AND_UX.md`：已经定下的行为和交互。
- `implementation/02_TECHNICAL_DESIGN.md`：固定技术边界、数据/恢复/API 方案。
- `implementation/03_EXECUTION_PLAN.md`：源码导航、分步执行卡、失败证据和命令。
- `implementation/04_ROLE_PROMPTS.md`：产品内部角色提示词和实际输入合同。
- `implementation/05_ACCEPTANCE.md`：确定性验收矩阵和进入 QA 的门槛。
- `qa/01_RUNBOOK.md`：真实本地部署、授权、停止条件。
- `qa/02_CASES_AND_REPORT.md`：完整测试顺序、用例、报告格式。
- `../REVIEW_REVISION10.md`、`../RESULT.md` 的 R10 及最新段落：已有证据，不把执行者自报 PASS 当作本轮结论。

路径以当前源码为准。本文中的**新增类型/API/测试文件都是设计目标，不宣称当前已存在**。已有文件/函数导航经过本次源码核对；行号只用于定位。

## 两窗口通信，不增加第三套台账

- 规划端维护 `../TASK.md` 与本包。
- 执行端只在 `../RESULT.md` 追加 R11 进度、决定偏差、验证证据、费用与最终状态；不改验收条件求通过。
- QA 的详细结果写入 `docs/qa/videofactory-real-local-qa-<实际日期>-r11.md`，RESULT 链接它。
- 原 JOURNAL 是历史导航，本轮不再让执行端在多个 JOURNAL 反复抄写。
- 断点恢复先读 RESULT 的 R11 最新记录，从实际未完成步骤继续；不重新研究 A/B/C，不重做已完成 R10。

## 权威与冲突

本包取代 R10 中“全部创作自动推进”“本轮不增加创作等待”“真实 QA 尚未授权”的部分。R10 已存档到 `../TASK_REVISION10.md`；其安全边界及未冲突能力继续保留。

本包不授权 commit、push、云部署、外部发布、删除/迁移用户历史数据、升级工具或把私有资料发往 Oracle。旧聊天中的其它授权不继承。用户当前配置的 coding 模型不在这里重新指定；如实际模型/effort不可见，诚实报告，不猜测。

## 交付状态

`IMPLEMENTING → CODE_VALIDATED → LOCAL_QA_RUNNING → READY_FOR_REVIEW`。

最终另列：`QA_PASSED` 或 `QA_DONE_WITH_CONCERNS`。未完成完整真实主链不能写产品验收通过。任何报告都不代表“没有所有可能的 bug”。
