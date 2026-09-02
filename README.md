# VideoFactory

VideoFactory 是一个本地优先的短视频 Creative OS。当前 Web Studio 已经把“中文热点聚合 / 持久系列 / 自定义观察 -> 统一候选收件箱 -> 人工采用 -> 可编辑创意 Brief -> 可替换 Provider 流水线 -> 视频审片 -> 发布包”连成闭环；运行节点、artifact、授权快照、技术质检和人工决定写入 `run.json`，机会与系列分别原子持久化到 `opportunities.json` 和 `series.json`。

## 当前目标

- 用 TS workflow-core 表达节点、provider、artifact、人工介入和质量门禁。
- 用 TS production pipeline 持久化 run，并通过版本化 JSON 协议调度 Python media worker。
- 用 Python/Pillow/FFmpeg/macOS `say` 跑通 `brief -> 脚本 -> 画面 -> 配音 -> 渲染 -> 机器质检 -> 人工终审 -> 发布包`。
- 用 React/Fastify Creative OS 提供今日机会、制作记录、总配置、实验复盘和视频优先的审片现场。
- 用 TrendRadar、NewsNow、DailyHotApi、RSSHub 组成可自托管热点底座，由统一网关去重并保留来源证据。
- 语义层统一使用宿主机 Codex（ChatGPT 订阅）承担选题总编、编剧、视觉导演与发行编辑四个角色；bridge 不可用时新建制作在能力选择处回落到确定性筛选与本地模板并如实标注来源，已绑定 Codex 的制作则明确失败，绝不静默降级。
- 自动发现 macOS 中文声音；语速、停顿和 FFmpeg 后期处理进入正式 production brief。
- 机会必须包含至少一条来源声明；人工录入内容由用户自行核验，平台指标仅在数据连接器接入后展示。
- 保留原有 SQLite CLI，用于选题实验、历史 job、指标记录和兼容路径。
- 保留人工审核和手动发布，不在 MVP 阶段自动点击平台发布。
- Seedance、MiniMax 海螺与 Wan 已接入统一异步生成协议；默认关闭，配置完整后按导演实际选中的镜头逐项报价，只有人工确认本次报价后才调用。
- 可灵与 Vidu 保留为明确的规划项，不会伪装成可用 Provider。

## 快速开始

```bash
cd /Users/jinkun.wang/work_space/veidofactory
npm install
make setup-local-runtime
make init
make setup-local-trends
npm run studio:dev
```

浏览器打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。开发机推荐运行 `make studio-local`，它会校验当前 ChatGPT/Codex 登录、启动本地 Codex bridge，再启动 Studio；只调试确定性流程时仍可运行 `npm run studio:dev`。热点服务由 Docker 运行，生产环境 Codex bridge 作为宿主机 systemd 服务运行（见生产部署指南）。socket 健康检查通过后选题、编剧、导演与发行编辑才会在总配置显示为“可用”。Today 把热点机会、系列选题和自定义创作作为三个并列入口；只有人工点击“采用到制作区”后才会进入正式机会与制作。

本地服务管理：

```bash
make local-trends-status
make local-trends-stop
make setup-local-trends
make codex-broker-status
```

默认端口为 TrendRadar `8080`、TrendRadar MCP `3333`、NewsNow `4444`、DailyHotApi `6688` 和 RSSHub `1200`。所有服务只绑定 `127.0.0.1`；API key 不写入仓库，也不会由配置页面回传。

默认“经济日更”配方不选择计费图片或视频能力。免费图库或付费图片、视频模型按需配置：

```bash
cp .env.example .env
# 只填写准备启用的 Provider；.env 已被 Git 忽略
npm run studio:dev
```

Studio 会自动读取仓库根目录的 `.env`，shell 中已经存在的环境变量优先。配置 `PEXELS_API_KEY` 后才会启用 Pexels；密钥只在忽略文件中保存，API 和资源页不会返回密钥值。

Seedream 需要 `ARK_API_KEY`、`SEEDREAM_MODEL_ID` 和 `SEEDREAM_ESTIMATED_CNY_PER_IMAGE`；Seedance 需要 `ARK_API_KEY`、`SEEDANCE_MODEL_ID` 和 `SEEDANCE_ESTIMATED_CNY_PER_CLIP`；MiniMax 海螺需要 `MINIMAX_API_KEY`、`MINIMAX_VIDEO_MODEL_ID` 和 `MINIMAX_ESTIMATED_CNY_PER_CLIP`；Wan 需要 `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID`、`WAN_MODEL_ID` 和 `WAN_ESTIMATED_CNY_PER_CLIP`。MiniMax 云配音只需 `MINIMAX_API_KEY`，默认使用 `speech-2.8-turbo`。图片和视频估价用于生成逐镜报价，应按账号实际计费配置一个保守值，不代表厂商实时价格；系统不设置全片费用上限。

完整验证：

```bash
make test
make test-e2e
```

macOS 系统 Python 可能会把入口脚本放到 `~/Library/Python/3.9/bin/video-factory`。如果这个目录不在 `PATH`，继续用下文的 `PYTHONPATH=src python3 -m video_factory ...` 也可以。

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

## 语义层与技术质检边界

一条热点视频最多调用四次 Codex 语义角色：选题总编（热点转选题）、编剧（分镜脚本）、视觉导演（视觉圣经与逐镜路由）、发行编辑（人工终审通过后的平台标题/描述/话题标签）。系列与自定义创作入口会跳过选题总编；bridge 不可用时，新建制作在能力选择处回落（选题→确定性评分、脚本→本地模板），发行文案回退简报标题并标注来源；已绑定 Codex 的制作在 bridge 失效时明确失败，不静默降级。每个任务受理后至多执行一次（不自动重放），调用次数受订阅配额约束。技术质检（分辨率、时长、轨道、产物哈希）始终由 ffprobe 与确定性规则执行，不使用模型。

## 推荐后续路线

1. 先固定一个 seed track，用当前流水线连续生成并人工发布 3 条。
2. 每条关联 run id、平台 post id/URL；Web 平台结果连接器完成前，先通过现有 CLI 或外部表格记录 T+24h 播放、完播和新增关注。
3. 三条数据闭环后，再决定是否扩赛道或升级 prompt、字幕、素材和配音。
4. 自动发布与完整 agent runtime 只在真实瓶颈出现后进入下一轮。

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

## TS Workflow Core

Loop 8 开始，VideoFactory 引入 TS-first 的工业级工作流核心。它不替代当前 Python MVP，而是定义上层协议：选题、脚本、素材、配音、渲染、审片、发布包和指标回流都应该是可替换的 workflow node。

核心材料：

- [docs/strategy/china-short-video-industrial-workflow.md](docs/strategy/china-short-video-industrial-workflow.md)
- [docs/adr/001-ts-agent-workflow-architecture.md](docs/adr/001-ts-agent-workflow-architecture.md)
- [docs/loops/008-industrial-workflow-foundation.md](docs/loops/008-industrial-workflow-foundation.md)

TS 验证：

```bash
npm test
npm run typecheck
```

`make test` 会同时运行 Python 测试和 TS 测试。

## Production Workflow

完整流程图、能力矩阵、Provider 扩展说明和逐步使用方法见 [docs/guides/production-workflow.md](docs/guides/production-workflow.md)。

Creative OS 的完整流程图、路由、机会 JSON、能力矩阵、架构与使用方式见 [docs/guides/web-studio.md](docs/guides/web-studio.md)。视觉与交互约束见 [DESIGN.md](DESIGN.md)。

阿里云 ECS 的容器化、单用户登录、Nginx/TLS、GitHub Actions 自动发布与回滚说明见 [docs/guides/production-deployment.md](docs/guides/production-deployment.md)。复用 `video.wangjinkun333.me` 不需要购买新域名；只需添加免费的 DNS 记录和 Let's Encrypt 证书。

不需要 API key 的本地样片：

```bash
npm run factory -- run examples/briefs/life-avoidance-local.json \
  --workspace workspace/factory
```

已配置 Pexels 后，可把 brief 中的素材 Provider 换成 `pexels-stock-v1` 运行免费实拍样片；配音默认使用 macOS 系统中文音色。

`durationSeconds` 当前接受 20-180 秒。生产 pipeline 会在每个节点后 checkpoint，校验 provider/capability 绑定，并在 worker 返回及生成发布包前复核 artifact 路径、SHA-256 和大小。

命令返回 `run id` 和 `needs_human`。完整观看 `final.mp4` 后，在另一个进程批准或拒绝：

```bash
npm run factory -- approve <run-id> \
  --actor <reviewer-name> \
  --note "画面、字幕、旁白和授权检查通过" \
  --workspace workspace/factory

npm run factory -- reject <run-id> \
  --actor <reviewer-name> \
  --note "需要换素材" \
  --workspace workspace/factory
```

同一条 workflow 可在 brief 中把 `providers.assets` 从 `local-editorial-v1` 换成 `pexels-stock-v1`、`pixabay-stock-v1`、`seedance-video-v1` 或 `wan-video-v1`。外部 Provider 需要先在进程环境或仓库根目录 `.env` 中提供完整配置；程序不会通过 API 输出配置值。图库或生成失败会让对应素材节点明确失败，不会改用本地说明卡；只有导演显式选择 `local-editorial-v1 + editorial_card` 时才制作正式卡片。付费生成会把任务 ID、估算费用、临时结果 URL 和本地文件写入审计 artifact。

每次 run 位于 `workspace/factory/runs/<run-id>/`，核心产物包括：

- `run.json`：节点状态、provider、artifact、质量门禁、人工决定和 revision。
- `nodes/.../script.json`、`asset_plan.json`、`voiceover_plan.json`。
- `nodes/render/.../final.mp4`：H.264/AAC 竖屏成片。
- `nodes/technical-review/.../technical_review.json`。
- `publish/publish_package.json`：批准后生成，不执行平台上传。

真实媒体门禁：

```bash
make test-e2e
```

这条命令会实际调用 `say`、FFmpeg 和 ffprobe，不是 mock 测试。

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

渲染预检与基础 MP4 输出。`--dry-run` 只写 manifest；不加 `--dry-run` 会生成分镜 PNG 并调用 `ffmpeg` 合成 `workspace/renders/<job_id>/final.mp4`：

```bash
PYTHONPATH=src python3 -m video_factory render-job 3 --dry-run
PYTHONPATH=src python3 -m video_factory render-job 3
```

免费素材驱动的更高质量路径：

```bash
cp .env.example .env
# 填入 PEXELS_API_KEY 或 PIXABAY_API_KEY；不要提交 .env
set -a; source .env; set +a

PYTHONPATH=src python3 -m video_factory asset-search 3 --provider pexels --media-type video
PYTHONPATH=src python3 -m video_factory prepare-assets 3 --provider pexels --media-type video
PYTHONPATH=src python3 -m video_factory render-job 3 --require-assets
```

没有 key 时可以用 mock provider 验证工程链路，但 mock 不是可发布素材：

```bash
PYTHONPATH=src python3 -m video_factory prepare-assets 3 --provider mock --media-type image
PYTHONPATH=src python3 -m video_factory render-job 3 --require-assets
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
