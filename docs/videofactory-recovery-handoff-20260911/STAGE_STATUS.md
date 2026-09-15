# 阶段真实状态

状态日期：2026-09-11。状态来源优先级：当前源码与测试 > 本轮 Oracle 复核 > 用户已确认决定 > 旧资料历史标签。

| 阶段 | 当前状态 | 已确认成果 | 当前阻断 / 进入条件 |
| --- | --- | --- | --- |
| A | `FROZEN_BY_USER` | 用户确认 A 完成；当前 pipeline build 通过。统一时间轴、裁切、声音、复用和付费安全必须作为回归边界保留。 | 本轮没有重新审计 A 全量验收。任何 B/C 修改若破坏 A，当前阶段不得放行。 |
| B1 | `IMPLEMENTED_PROVISIONAL` | LangGraph/SQLite 依赖和 checkpoint 实现已存在；本地 `better-sqlite3` ABI 已恢复，B4 聚焦中的 store/graph 测试通过。 | 必须在 B4 进程 crash/恢复里证明，不得单独宣称完成。 |
| B2 | `IMPLEMENTED_PROVISIONAL` | creative treatment、Broker task 和双 executor 合同已有大量实现。 | treatment 仍缺 reference grammar/系列承诺等真实输入；正式 provenance 有 provider/model 混写风险。随 B4 收口。 |
| B3 | `IMPLEMENTED_PROVISIONAL` | 固定 planning graph、issues、调用预算与恢复已有实现，144 项 B4 pipeline 聚焦通过。 | ranker identity、当前排序语义、真实 port consumption 尚未闭合。随 B4 收口。 |
| B4 | `CHANGES_REQUIRED` | joint/legacy 可见拓扑已互斥；script/director 已收到 treatment/issues；seed provenance 与新 derivative legacy 两个旧缺陷已修；treatment 正式 artifact 和 executable 重绑已部分完成。 | 编辑并发未贯穿持锁点；rank identity/语义、唯一 outputs、private inventory、正式引用闭包、真实 crash 恢复、DTO 状态不真实；Studio 24/29，typecheck 失败。下一施工阶段。 |
| B5 | `CHANGES_REQUIRED` | voice timing 旧节点、reuse 跳 preflight/覆盖 cut、固定点闭包和 issues 不进 producer 的旧机制已修。 | 跨 run reference 证明转存丢失、复用判据不一致、note-only 反馈被吞、局部返工重跑无关角色、双审 snapshot/碰撞恢复/容量未闭合；156/159。必须在 B4 ACCEPTED 后开始。 |
| C1 | `CHANGES_REQUIRED` | grant 文件幽灵授权、整元截断、retry/stale-resume 漏接已修；纯决策能算出 50 分缺口。 | superseded scope 仍可能派发、ledger alias/unknown 占用错误、子凭证与 exact plan 不一致、损坏链当空、拒绝原因丢失；24/25。必须在 B5 ACCEPTED 后开始。 |
| C2 | `CHANGES_REQUIRED` | quote、authorization、amendment、actor、duration range、预算意向和部分 pause/UI 已有实质实现；旧客户端金额/URL predecessor 和基础 quote ownership 机制已改。 | funding 差额错误、显示/授权金额不一致、目录/可行性弱、先展示后接受未实现、accepted command 重放、编辑草稿基线、pause 恢复入口、类型门禁和浏览器证据缺失。必须在 C1 ACCEPTED 后开始。 |
| C3 | `UNVERIFIED_CURRENT` | 旧计划和当前工作树已有选题/模板/偏好改动。 | 本轮没有重新审计或运行对应测试。C2 后按 `C3_C6_REMAINING.md` 重新采集，不继承旧完成标签。 |
| C4 | `UNVERIFIED_CURRENT` | 当前 Studio 已有 creator-first UI、模型编辑、素材/模板页面和错误展示改动。 | 需要基于真实服务 DTO 收口主线、文案、1440/390、键盘和错误恢复。 |
| C5 | `UNVERIFIED_CURRENT` | 当前 Codex/GLM executor 已有 20 分钟超时、较大输出上限和失败分类修改。 | 必须用真实 trace 证明慢在哪里、fallback 何时安全；不得降模型质量或用加 timeout 冒充优化。 |
| C6 | `NOT_STARTED_FOR_CURRENT_TREE` | 尚无。 | 只有 B4–C5 全部阶段放行后，才做集中本地 E2E、统一 Oracle、经授权 GitHub 部署和云端桌面/移动验收。 |

## 当前唯一下一步

执行 [B4_EXECUTION_CARD.md](B4_EXECUTION_CARD.md)，完成整个 B4 后停止，由审计者按 B4 验收和 Oracle Web 复审给出 `ACCEPTED` 或 `CHANGES_REQUIRED`。没有 B4 `ACCEPTED` 不进入 B5。
