# VideoFactory 第二轮真实 QA 集中修复资料包

日期：2026-09-12

本资料包用于修复第二轮真实本地 E2E 暴露的全部问题。它建立在 A/B/C 已实现、第一轮 QA 五项问题已修复的当前脏工作树之上，不重做项目，也不建立第二套生产流程。

## 结论

Oracle Web 第 5 档审计结论为 `CHANGES_REQUIRED`。当前需要集中修复两组共同根因：

1. `topic-ideas` 在 Studio 与 Broker 之间缺少同一份可执行合同，导致热点入口静默退化为规则候选。
2. 长模型任务把“任务受理/执行”与“某条 HTTP 观察连接”绑在一起；连接失效后，Studio 没有独立查询原任务结果的闭环，恢复按钮因此成为死胡同。

另有两个用户可见的小问题必须同轮收口：热点恢复面板误称总编已评估，以及 Provider “可用”与最近一次任务健康混淆。

## 执行者阅读顺序

1. `README.md`
2. `CURRENT_STATE.md`
3. `ORACLE_SYNTHESIS.md`
4. `EXECUTION_CARD.md`
5. `ACCEPTANCE.md`
6. `VERIFICATION.md`
7. `MATERIAL_MANIFEST.md`
8. 当前源码与当前 `git status`

`CLAUDE_PROMPT.md` 是可直接发给全新 Claude Code session 的完整指令。执行中把证据写入本目录的 `JOURNAL.md`。

## 权威性顺序

发生冲突时按以下顺序判断：

1. 用户已经确认的产品目标与权限边界。
2. 当前源码和可复现测试证据。
3. 本资料包的合同与验收标准。
4. 两轮 QA 报告。
5. Oracle transcript 中的建议。

Oracle 只提供分析、规划和执行建议，不替代当前执行者对源码的核验。QA 报告中两个推测已被 Oracle 修正：不能在没有等价复现时断言“Studio 第三方摧毁 socket”；`sessionRebuilds=0` 表示已使用次数为零，不是预算耗尽。

## 范围

- 修复 R2-ISSUE-001～004。
- 修复与它们同根因的任务状态、查询恢复、错误分类、前端动作权限与健康投影。
- 新增真实跨进程合同测试和 durable 故障恢复测试。
- 完成确定性回归后，重启正式本地环境并从 Web 进行真实 E2E。
- 第一轮真实 QA 先尽量测全并记录，完成后再集中修复新问题；不得边点边碎修。

## Non-goals

- 不引入 Redis、消息中间件、微服务或通用工作流框架。
- 不建立 fake/real 两套生产路径。
- 不通过增加 timeout、无限重试或换 backup 掩盖结果恢复缺口。
- 不重写规则系列路线图，不处理与本轮无关的大文件拆分。
- 不删除历史 run、checkpoint、Broker durable record 或用户数据。
- 不为四个失败 run、某个题材、模型或固定测试数字写特判。
- 不 commit、push；GitHub 当前不可用。

## 完成定义

只有以下全部成立才算本轮修复完成：

- R2 合同、恢复、UX 和健康状态验收全部通过。
- 所有新测试进入正式脚本，不存在只手动运行的孤儿测试。
- 全量 TypeScript、Studio、Broker、Python、build、typecheck、diff-check 全绿。
- 正式本地环境使用真实 Broker、真实模型、真实持久化数据，无 fake。
- Web 三入口至少各完成一条真实链路；报价、授权、媒体、配音、渲染、双审、打回和局部返工得到真实证据。
- 媒体失败不会被说明卡伪装成功；accepted/unknown 不会触发第二次模型或媒体购买。
- QA 新发现的问题已经先形成完整报告，再集中修复和回归。

