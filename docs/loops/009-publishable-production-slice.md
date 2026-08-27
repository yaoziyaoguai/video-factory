# Loop 9: Publishable Production Slice

Date: 2026-08-21

## Goal

把 Loop 8 的 TS 工作流底座和现有 Python 媒体链连接成一条真实、可恢复的发布前生产闭环。输入一个版本化 brief 后，系统必须生成非静音竖屏 MP4、完整审核包和可审计 `run.json`，并在人工终审处暂停；另一个进程提交决定后可以继续生成发布包，且不重跑已完成节点。

这轮完成的是“发布前技术闭环”，不是播放量或涨粉验证。真实发布和 T+24h 指标必须由账号操作产生，不能用样例值冒充。

## Global Constraints

- TypeScript 是 workflow/run 状态的唯一所有者；Python worker 不写 TS run 状态。
- Python worker 使用版本化 JSON 协议；stdout 只输出一个 JSON 响应，诊断写 stderr。
- 不解析现有 Python CLI 的人类可读输出作为系统接口。
- 每个 worker attempt 使用隔离输出目录，artifact 带 SHA-256、大小、content type、producer、provider 和 license snapshot。
- 素材 provider 通过 brief 选择；`local` 与 `pexels` 不得要求修改 workflow 定义。
- 包含 narration 的成片必须有可检测的非静音音轨。
- 人工终审记录 actor、action、时间和 note；重复或过期决定必须被拒绝。
- 不接平台发布 API，不做 Studio UI，不引入 LangGraph/Mastra/Remotion/Postgres/队列。
- 不读取或提交 `.env.local`；测试和默认样片使用不需要 API key 的本地 provider。
- 不提交或推送，除非用户另行明确要求。

## Definition of Done

- `run <brief>` 生成 `script.json`、`asset_plan.json`、`voiceover_plan.json`、`final.mp4`、`technical_review.json` 和持久化 `run.json`，状态为 `needs_human`。
- `approve <run-id>` 从磁盘加载 run，记录决定并生成 `publish_package.json`，状态为 `succeeded`。
- `reject <run-id>` 记录拒绝并终止，不生成发布包。
- approve/reject 不重跑脚本、素材、配音、渲染或技术质检节点。
- 至少一次真实 FFmpeg 运行证明成片为 1080x1920、H.264/AAC、含非静音音轨、分镜完整，且技术门禁通过。
- Python、TS、package entrypoint 和真实 E2E 验证均有新鲜证据。

## Task 1: Versioned Contracts

### Scope

- 定义 `video-factory/brief-v1` 和 `video-factory/worker-v1`。
- 定义 production artifact、provider binding、human decision 和 run manifest 的最小字段。
- TS 与 Python 都拒绝错误协议版本、未知 capability 和缺失关键字段。

### Evidence

- 先写 TS/Python 失败测试并观察预期失败。
- focused contract tests 通过。

## Task 2: Python Media Worker

### Scope

- 新增 JSON worker 入口，复用 `script_service`、`stock_assets` 和 `renderer`。
- 支持 `script.draft`、`asset.prepare`、`voice.synthesize`、`video.render`、`quality.review`。
- 增加 `local` 素材 provider，可为所有分镜生成自有 editorial card。
- 增加 `macos-say` 配音 provider，并把每段音频时长同步到视频时间线。
- 渲染器接收 voiceover plan，输出真实 AAC 音轨；技术质检检查尺寸、编码、时长、音量、素材覆盖和 mock 禁止策略。

### Evidence

- 先写 worker/local asset/voice timeline/review 失败测试。
- Python focused tests 与既有 19 项测试通过。

## Task 3: Persistent Resume Runtime

### Scope

- 扩展 `WorkflowRunner`，支持对 `needs_human` run 提交 `approve` 或 `reject` 决定。
- approve 从暂停节点后继续，reject 终止；两者都保留审计记录。
- 增加文件型 `RunStore`，使用 revision 防止过期写入，并用临时文件原子替换。

### Evidence

- 先写跨 runner 实例 resume、重复决定和 stale revision 失败测试。
- 证明前序节点执行计数没有增加。

## Task 4: Production CLI

### Scope

- 新增 TS production package 和 `factory run/show/approve/reject` CLI。
- Python worker adapter 校验 JSON 响应、超时并映射结构化错误。
- workflow 节点顺序为 script、assets、voice、render、technical review、human final review、publish package。
- 保存 provider snapshot、artifact lineage 和 run manifest。

### Evidence

- 使用 fake worker 的 CLI/runtime 集成测试先失败后通过。
- provider 选择只改 brief，不改 workflow。

## Task 5: Real E2E And Review

### Scope

- 用 `examples/briefs/life-avoidance-local.json` 生成真实样片。
- 运行 approve，检查发布包与 run/artifact 状态一致。
- 更新 README、Makefile、ADR/loop 记录。
- 运行独立 correctness、architecture 和 product review，修复重要发现。

### Evidence

- `make test`
- `make test-e2e`
- `ffprobe` 和音量检测输出
- `git diff --check`

## External Gate For Loop 10

- 人工把连续 3 条通过审核的视频发布到同一个真实账号。
- 每条记录平台 post id/URL、发布时间和对应 run id。
- T+24h 回填播放、完播、新增关注等真实指标。
- 三条数据都闭环后，才可以声称“每天 1 条”和播放/涨粉验证进入有效阶段。
