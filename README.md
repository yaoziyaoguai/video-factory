# VideoFactory

VideoFactory 是一个本地优先的短视频生产 MVP。第一版目标不是“一键爆款”，而是把每天 1 条视频的生产流程先变成可追踪、可审核、可替换 provider 的工作流。

## 当前目标

- 用 SQLite 管理选题、任务、分镜和导出状态。
- 用 CLI 跑通 `选题 -> 结构化脚本/分镜 -> 人工审核包`。
- 保留人工审核和手动发布，不在 MVP 阶段自动点击平台发布。
- 后续再接入 MoneyPrinterTurbo、CosyVoice、faster-whisper、Remotion、FFmpeg、ComfyUI。

## 快速开始

```bash
cd /Users/jinkun.wang/work_space/veidofactory
make init
make demo
make test
```

手动流程示例：

```bash
PYTHONPATH=src python3 -m video_factory init
PYTHONPATH=src python3 -m video_factory add-topic "30岁以后才懂的生活真相" --angle "反常识、共鸣、可转发"
PYTHONPATH=src python3 -m video_factory list-topics
PYTHONPATH=src python3 -m video_factory draft 1 --duration 45
PYTHONPATH=src python3 -m video_factory export 1
```

如果要指定数据库或工作目录，把全局参数放在子命令前：

```bash
PYTHONPATH=src python3 -m video_factory --db data/video_factory.sqlite --workspace workspace demo
```

导出包会放在 `workspace/exports/<job_id>/`，包括：

- `title.txt`
- `description.txt`
- `hashtags.txt`
- `script.json`
- `compliance.json`
- `asset_manifest.json`

## MVP 边界

当前脚本生成器是确定性模板，方便先验证数据结构和流程。它不是最终内容质量方案。下一步可以把 `script_service.py` 替换成：

- 本地 Ollama 模型
- OpenAI-compatible API
- 人工写稿 + 自动分镜
- 按赛道定制的 prompt pack

## 推荐后续路线

1. 先做 3-5 个大众赛道的小样，每个赛道 3 条。
2. 根据播放、完播、点赞、关注率选择胜出的赛道。
3. 再为胜出赛道做专用 prompt、字幕模板、画面模板。
4. 最后再接入自动素材、TTS、视频合成和平台上传。

## Loop Engineering

VideoFactory 用 loop 管理每次工程迭代。一个 loop 必须有目标、成功标准、阶段事件和验证证据。

```bash
PYTHONPATH=src python3 -m video_factory loop-start "loop-1-topic-experiments" \
  "Loop 1: Topic Experiments" \
  --objective "Build a repeatable way to choose the first week of video topics." \
  --criterion "Export a first-week content plan."

PYTHONPATH=src python3 -m video_factory loop-event loop-1-topic-experiments \
  --phase plan \
  --status completed \
  --summary "Loop plan written." \
  --evidence "docs/loops/001-topic-experiment.md"

PYTHONPATH=src python3 -m video_factory loop-show loop-1-topic-experiments
```

完整工作流见 [docs/loop-engineering.md](docs/loop-engineering.md)。

## Loop 1: 选题实验

```bash
PYTHONPATH=src python3 -m video_factory seed-niches
PYTHONPATH=src python3 -m video_factory generate-topics --loop loop-1-topic-experiments --count 30
PYTHONPATH=src python3 -m video_factory list-candidates --loop loop-1-topic-experiments --limit 10
PYTHONPATH=src python3 -m video_factory export-week-plan --loop loop-1-topic-experiments --count 7
PYTHONPATH=src python3 -m video_factory draft-candidate 13
```

默认导出到 `workspace/week-plans/loop-1-topic-experiments-week-1.json`。

## Later Loops

候选题生成赛道化审核包：

```bash
PYTHONPATH=src python3 -m video_factory draft-candidate 43
```

手动录入发布数据并导出复盘：

```bash
PYTHONPATH=src python3 -m video_factory record-metric \
  --platform douyin \
  --job-id 3 \
  --candidate-id 43 \
  --views 1000 \
  --likes 80 \
  --comments 12 \
  --follows 9 \
  --completion-rate 0.41 \
  --avg-watch-seconds 18.5 \
  --published-at 2026-08-20T20:00:00+08:00

PYTHONPATH=src python3 -m video_factory metrics-report --platform douyin
```

渲染预检。真实 MP4 输出需要本机安装 `ffmpeg` 和 `ffprobe`：

```bash
PYTHONPATH=src python3 -m video_factory render-job 3 --dry-run
```

登记本地素材并匹配到分镜：

```bash
PYTHONPATH=src python3 -m video_factory add-local-asset workspace/assets/decision-checklist.png \
  --media-type image \
  --tag "普通人做决定前最该避开的 3 个坑" \
  --tag checklist \
  --license-note "created by owner"

PYTHONPATH=src python3 -m video_factory match-assets 3
```
