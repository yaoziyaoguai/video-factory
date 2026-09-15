# VideoFactory 恢复实施资料包

日期：2026-09-11

这是一套基于**当前脏工作树、当前测试结果和四轮全新 Oracle Web 第 5 档审计**重新建立的交接包。它取代旧包中的阶段完成标签，但不推翻旧包已经确认的产品目标和技术决策。

当前结论不是“重做项目”，也不是“只剩几个断言”：A 由用户确认完成；B1–B3 已有大量实现，但必须随 B4 集成一起收口；B4、B5、C1、C2 均为 `CHANGES_REQUIRED`；C3–C6 尚未重新核验，不能沿用旧日志宣称完成。

## 先读什么

Claude Code + GLM 5.3 Flash 开始新 session 时，按顺序完整读取：

1. [MASTER_PROMPT.md](MASTER_PROMPT.md)
2. [CURRENT_STATE.md](CURRENT_STATE.md)
3. [AUTHORITATIVE_DECISIONS.md](AUTHORITATIVE_DECISIONS.md)
4. [STAGE_STATUS.md](STAGE_STATUS.md)
5. [ORACLE_SYNTHESIS.md](ORACLE_SYNTHESIS.md)
6. 当前阶段执行卡，例如 [B4_EXECUTION_CARD.md](B4_EXECUTION_CARD.md)
7. [ACCEPTANCE.md](ACCEPTANCE.md)、[VERIFICATION.md](VERIFICATION.md) 和 [JOURNAL.md](JOURNAL.md)

旧资料包只在新执行卡明确要求时作为设计依据读取：

`/Users/jinkun.wang/Documents/ChatGPT/做视频/videofactory-workflow-handoff-20260909`

旧 `JOURNAL.md`、旧 `ACCEPTED`、旧测试数量和旧 Oracle verdict 都是历史记录，不能覆盖本包的当前状态。

## 推进顺序

```text
B4 完成并本地验证
  → Oracle Web 独立复审并 ACCEPTED
  → B5 完成并本地验证
  → Oracle Web 独立复审并 ACCEPTED
  → C1
  → C2
  → C3
  → C4
  → C5
  → C6 集中本地验证、统一审计、经授权部署与云端验收
```

一次只执行一张阶段卡。不得为了省 session 把 B4/B5/C1/C2 混在一次实现中；它们共享文件，但验收边界不同。阶段内应集中完成同根因修复，不得修一个测试就停下来审一次。

## 当前最重要的恢复原则

- 保留仓库全部 86 个 tracked 修改和 22 个 untracked 文件；禁止 reset、stash、checkout、clean。
- 不针对题材、镜头、runId、模型或单个 expected 数字打补丁。
- 不让新 production 继续走 legacy 工作流；历史兼容仅用于原 run 读取/恢复。
- 不用说明卡掩盖素材失败。
- 图片/视频费用由用户看见方案和最高金额后授权；没有全局硬上限。授权内先保质量、再省钱。
- 文本/订阅审片不弹现金审批；TTS 自动执行并按现有机制记账。
- 两个独立审片模型必须使用同一不可变证据，不得单审降级发布。
- 先修当前阶段全部同根因问题，再集中跑聚焦、类型和回归；不要“修一点→审一次→部署一次”。

## 本包内容

- `CURRENT_STATE.md`：当前仓库、环境和重跑证据。
- `AUTHORITATIVE_DECISIONS.md`：不可再自行改写的产品/技术决定。
- `STAGE_STATUS.md`：每阶段的真实状态和进入条件。
- `ORACLE_SYNTHESIS.md`：四批 Oracle 结论的统一根因与依赖顺序。
- `B4_EXECUTION_CARD.md`、`B5_EXECUTION_CARD.md`、`C1_EXECUTION_CARD.md`、`C2_EXECUTION_CARD.md`：可直接交给 Flash 的单阶段任务。
- `C3_C6_REMAINING.md`：后续范围，防止前四阶段顺手扩张。
- `ACCEPTANCE.md`：阶段放行证据。
- `VERIFICATION.md`：命令、测试层级与证据格式。
- `MATERIAL_MANIFEST.md`：材料来源和源码导航。
- `oracle/prompts/`：四份自包含审计 prompt。
- `oracle/results/`：四次完整 Oracle transcript。
- `ORACLE_SESSION_VERIFICATION.md`：实际第 5 档、会话提交和浏览器清理证据。

## 权限边界

本包创建过程没有修改产品源码，没有 commit、push、部署、读取密钥或调用真实 Provider。之后任何阶段也不得从旧聊天继承提交、付费或发布权限；必须以当次用户授权为准。
