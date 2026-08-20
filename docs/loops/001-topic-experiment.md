# Loop 1: Topic Experiments

## Objective

建立一个可重复的选题实验基础，让 VideoFactory 能从多个大众赛道中生成、评分并导出第一周测试计划。

## Why This First

当前最大风险不是渲染，而是做出一批没人看的视频。先验证选题，再把胜出的方向自动化。

## Scope

本轮应该完成：

- 定义 5 个大众赛道。
- 为每个赛道记录目标用户、内容结构、hook 类型、风险和自动化适配度。
- 支持 CLI 生成候选选题。
- 支持导出第一周 7 条测试计划。
- 把生成结果纳入 SQLite 或可追踪文件。

## Out Of Scope

- 不生成最终 MP4。
- 不接抖音或其他平台发布 API。
- 不引入本地视频大模型。
- 不做账号矩阵或自动发布。

## Success Criteria

- 一条命令可以生成至少 30 个候选选题。
- 每个候选选题包含赛道、受众、角度、风险和自动化难度。
- 一条命令可以导出第一周 7 条视频测试计划。
- `make test` 通过。
- loop 记录中有 `plan`、`implement`、`verify` 事件。

## Proposed Niches

| Niche | Why Test |
|---|---|
| 情绪/关系故事 | 大众受众，容易产生评论和转发 |
| 历史人物/奇闻 | 可脚本化，适合旁白和素材剪辑 |
| 生活避坑/清单 | 低成本，强收藏倾向 |
| 冷知识/轻科普 | 稳定供给，适合短结构 |
| 治愈/睡前故事 | 适合 AI 图片和配音，节奏可控 |

## Verification Plan

```bash
make test
PYTHONPATH=src python3 -m video_factory generate-topics --loop loop-1-topic-experiments --count 30
PYTHONPATH=src python3 -m video_factory export-week-plan --loop loop-1-topic-experiments --count 7
PYTHONPATH=src python3 -m video_factory loop-show loop-1-topic-experiments
```

## Commands

Seed the default niches:

```bash
PYTHONPATH=src python3 -m video_factory seed-niches
```

Generate candidates:

```bash
PYTHONPATH=src python3 -m video_factory generate-topics --loop loop-1-topic-experiments --count 30
```

Inspect top candidates:

```bash
PYTHONPATH=src python3 -m video_factory list-candidates --loop loop-1-topic-experiments --limit 10
```

Export the first-week plan:

```bash
PYTHONPATH=src python3 -m video_factory export-week-plan --loop loop-1-topic-experiments --count 7
```
