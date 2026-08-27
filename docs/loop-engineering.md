# VideoFactory Loop Engineering

VideoFactory 的 loop 不是普通 todo list。它是一个可复盘的工程闭环：每轮都必须说明为什么做、怎么做、如何验证、哪些证据证明完成。

## Loop Definition

一个 loop 包含：

- `objective`：本轮要改变什么能力。
- `success_criteria`：完成标准，必须可观察。
- `phase events`：每个阶段发生了什么。
- `evidence`：命令、文件、测试、导出物或数据。
- `status`：`active`、`completed`、`blocked`、`skipped`。

数据库实体是 `engineering_loops` 和 `loop_events`。CLI 是事实入口，文档是人类可读入口。

## Stages

| Stage | Purpose | Evidence |
|---|---|---|
| `discover` | 明确问题和约束 | 调研摘要、用户决策、风险清单 |
| `plan` | 切出最小可交付范围 | plan 文件、成功标准、非目标 |
| `implement` | 改代码或产出内容资产 | diff、生成文件、样例 |
| `verify` | 证明本轮能力可用 | 测试命令、CLI 输出、导出包 |
| `review` | 找错、降复杂度、确认范围 | review 结论、剩余风险 |
| `ship` | 提交、推送或准备交付 | commit、branch、PR、发布包 |
| `learn` | 把结果变成下一轮输入 | 数据复盘、失败原因、下一轮假设 |

## Skill And Plugin Operating System

当前仓库采用轻量人工掌舵，不直接跑全自动 `lfg`。

| Need | Preferred Skill / Plugin | Use |
|---|---|---|
| 模糊方向收敛 | `decision-mapping`、`ce-brainstorm` | 用于赛道、商业化、产品方向不清时 |
| 工程计划 | `ce-plan` | 生成 implementation-ready 计划 |
| 工程执行 | `ce-work` | 按计划完成代码和本地验证 |
| 代码审查 | `ce-code-review` 或普通 review stance | 行为改动完成后找 bug 和测试缺口 |
| 文档审查 | `ce-doc-review` | plan 或长文档需要清晰度检查时 |
| 浏览器/视觉 QA | `qa`、`ce-test-browser`、`playwright` | 有 Web UI 或视频预览页面时 |
| 提交发布 | `ce-commit`、`ce-commit-push-pr`、GitHub plugin | 提交、推送、PR |
| 长任务保存 | `checkpoint`、`context-save` | loop 中断前保存状态 |
| 外部调研 | `browse`、web search | 平台规则、API、开源项目更新 |

`lfg` 只在明确要自动完成到 PR、且不需要中途确认时使用。VideoFactory 当前阶段更适合 `ce-plan -> ce-work -> review -> commit/push`。

## Loop Rules

1. 非平凡变更从 `codex/<loop-slug>` 分支开始。
2. 每个 loop 先写成功标准，再写代码。
3. 每个行为改动必须有测试或可复现 CLI 验证。
4. 每个 loop 至少记录一个 `verify` 事件。
5. 不把 `data/`、`workspace/` 和生成产物提交进仓库。
6. 内容产品决策先验证小样，不用工程复杂度替代内容判断。
7. 自动发布平台放后期，MVP 阶段保留人工审核。

## CLI Cheatsheet

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

## Current Loop Sequence

1. `loop-1-topic-experiments`：建立大众赛道选题实验基础。
2. `loop-2-script-quality`：按赛道升级脚本和分镜质量。
3. `loop-3-review-package-metrics`：发布包和数据复盘。
4. `loop-4-low-cost-render`：生成可发布的 1080x1920 MP4。
5. `loop-5-asset-automation`：接素材、TTS、字幕和 scene 级重生成。
