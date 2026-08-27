# Context

## Workflow

一次端到端的视频生产流程。Workflow 不是固定脚本串联，而是一组可配置、可重跑、可审查的生产节点。

## Workflow Run

某一次 Workflow 的具体执行记录。它保存输入、每个节点的状态、产物、失败原因、人工决策和最终输出。

## Node

Workflow 中的一个生产节点。节点可以自动执行，也可以要求人工处理。节点的实现可以替换，但节点对外暴露稳定的输入、输出和状态。

## Provider

节点背后的能力来源。Provider 可以是 Pexels、本地素材库、AI 生图、AI 生视频、TTS 服务、人工上传、浏览器操作或未来的第三方平台。

## Human Intervention

人工介入某个节点的执行或决策。人工介入不是异常路径，而是 Workflow 的一等能力，例如人工挑素材、改脚本、拒绝成片、确认发布。

当前 production runtime 已实现的机器决策只有 `approve` 和 `reject`。改脚本、换 provider、替换素材属于后续可扩展 intervention，不在现有合同中提前宣称。

## Artifact

Workflow 或 Node 产生的可追踪文件或数据，例如脚本、分镜、素材候选、素材计划、配音文件、预览帧、最终视频、审片报告和发布包。

## Quality Gate

决定一个节点产物是否可以进入下一步的检查。Quality Gate 可以自动判断，也可以交给人工。未通过时应进入 rejected、needs_human 或 retry 状态，而不是把低质量结果继续往后传。

## Topic Intelligence Engine

短视频工业流水线的选题能力。它不是固定赛道列表，而是把平台信号、受众痛点、制作成本、视觉可行性、合规风险、商业化潜力和历史数据放进同一个评分与实验循环。

## Seed Track

冷启动时用于验证流水线的实验赛道。Seed Track 不是产品边界，也不能写死进核心代码；它只是一组可替换的初始配置。

## Provider Registry

管理同一节点背后可替换能力的注册表。例如素材节点可以同时支持 Pexels、本地素材、AI 生图、AI 生视频、截图、人工上传；工作流只依赖 capability，不直接依赖具体供应商。

## Production Brief

`video-factory/brief-v1` 输入合同，固定目标平台、受众、时长和 provider binding。

## Worker Protocol

`video-factory/worker-v1` 机器接口。TypeScript 负责调度和 run 状态，Python 负责隔离地产出媒体 artifact。

## Run Revision

人工决定和持久化更新使用的 compare-and-swap 版本号。FileRunStore 在同一个 run lock 内完成 load、resume、副作用和 revision 更新，用来拒绝并发、重复或过期决定。
