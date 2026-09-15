# 给执行窗口的完整启动任务

请接管 `/Users/jinkun.wang/work_space/veidofactory`，完成 Revision 11 的实现和真实本地 QA。

先核对磁盘目录、当前源码和git状态，保留全部已有未提交成果。完整读取：

1. `/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/TASK.md`
2. `/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/revision11/README.md`
3. 按README顺序读完 implementation 五份、qa 两份与 BASELINE。
4. `/Users/jinkun.wang/work_space/veidofactory/docs/codex-collaboration/REVIEW_REVISION10.md` 和 `RESULT.md` 最新R10/R11记录。

这是同一项目的增量实现，不重建项目，不重做A/B/C或R10，不自行换框架，也不按某个测试题打补丁。按资料包固定方案把本轮所有要求做完：三阶段用户讨论确认、模板继续退出、要求与建议分离、导演素材路线权限、有效审计反馈、声音/系列配置交接、恢复与可用性、热点原文阅读。

按S0→S6持续推进。普通聚焦红绿测试随开发进行，不每步停下等审计；全部代码收口后集中回归和自查，再开始真实本地QA。不要在前半段只做UI、把后端确认与恢复留成TODO。

当前用户授权：实现验收通过后可部署正式本地build，使用真实Broker/模型/媒体和QA技能，代用户确认创作及预算内付费；全部本轮新增现金最大暴露合计不超过人民币50元，包含媒体、TTS和在途/未知费用。不是每条视频50元。详细规则以qa/01_RUNBOOK为准，不需要再次询问这笔已授权额度。

不commit、不push、不云部署、不外部发布，不删除/迁移用户历史数据，不升级工具，不启动Oracle或外发资料。真实环境只通过既有配置加载本项目必需凭据，任何报告/截图/日志不得含秘密。

实现阶段自行修好范围内问题。真实QA阶段先集中测试、记录现象与已核实根因，已受理未知只观察原任务，不盲重试、不边测边改产品。完成可达用例后写完整报告，标清未验证项和费用，然后停止，等待统一审查。

你在 `docs/codex-collaboration/RESULT.md` 追加R11状态与证据，规划文档/TASK不由你改写验收。报告放 `docs/qa/videofactory-real-local-qa-<实际日期>-r11.md`。断点后从RESULT最新步骤继续，不重读全部旧聊天重新规划。

完成标准是资料包要求的行为与证据，不是代码行数、测试总数或“模型说通过”。没有真实主片、音频、双真实审片与局部返工证据就明确说未完成哪些验收，不能宣称产品全部通过。
