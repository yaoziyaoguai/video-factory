# VideoFactory Loop Engineering

Loop 是一轮可复盘的工程闭环，不是长期堆积的 todo 或实现计划。当前工作树只保留仍能指导实现的规则和最新验收记录；已完成的旧计划与逐轮截图由 Git 历史保存。

## Loop 合同

每轮必须记录：

- `objective`：本轮要改变的可观察能力。
- `success_criteria`：可以被测试或人工验收证明的完成标准。
- `phase events`：发现、设计、实现、验证、审查和发布过程中发生了什么。
- `evidence`：测试命令、失败复现、artifact、PR、部署和真实界面验证。
- `status`：`active`、`completed`、`blocked` 或 `skipped`。

数据库中的 `engineering_loops` 与 `loop_events` 是机器可读记录；仓库文档只保留需要长期阅读的决策和最新验收。

## 阶段

| Stage | 目的 | 最低证据 |
|---|---|---|
| `discover` | 确认问题、根因和约束 | 复现、代码路径、风险 |
| `plan` | 限定最小结果与非目标 | 成功标准、影响文件 |
| `implement` | 完成最小行为改动 | diff、RED/GREEN |
| `verify` | 证明目标行为与回归风险 | 完整命令与 exit code |
| `review` | 检查正确性、范围和复杂度 | review 结论与修正 |
| `ship` | 经 PR 和 CI/CD 发布 | PR、Action、release SHA |
| `learn` | 把真实结果反馈到下一轮 | 失败原因、保留边界 |

## 规则

1. 非平凡变更从 `codex/<slug>` 分支开始。
2. 行为改动先写可失败的回归测试，再做最小实现。
3. 自动化测试、真实浏览器验收和生产健康检查分别记录，不能互相代替。
4. 图片/视频费用审批、最终审片和外部发布始终由人决定。
5. `data/`、`workspace/`、`output/`、密钥和浏览器产物不提交。
6. 完成的计划不继续作为当前事实；长期有效的决定进入 ADR、指南或 README。
7. 发布只走 PR、GitHub Actions 和固定 SHA 部署，不通过 SSH 覆盖代码。

## CLI

```bash
PYTHONPATH=src python3 -m video_factory loop-start <slug> "<title>" \
  --objective "<objective>" \
  --criterion "<success criterion>"

PYTHONPATH=src python3 -m video_factory loop-event <slug-or-id> \
  --phase verify \
  --status completed \
  --summary "<what happened>" \
  --evidence "<command or artifact>"

PYTHONPATH=src python3 -m video_factory loop-show <slug-or-id>

PYTHONPATH=src python3 -m video_factory loop-complete <slug-or-id> \
  --verification "make test"
```

## 现行记录

- 当前完整验收：[Loop 022：费用审批与严格素材](loops/022-spend-approval-and-strict-assets-results.md)
- 历史阶段摘要：[项目演进](HISTORY.md)
- 清理前完整文档树：Git commit `2d4f842b160801925115acbae9d1e536079334c6`
