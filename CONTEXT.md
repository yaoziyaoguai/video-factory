# Context

## Workflow

一次端到端的视频生产流程。Workflow 不是固定脚本串联，而是一组可配置、可重跑、可审查的生产节点。

## Workflow Run

某一次 Workflow 的具体执行记录。它保存输入、每个节点的状态、产物、失败原因、人工决策和最终输出。

## Production Session

一条视频从立项到交付的持续制作上下文，由对应的 Workflow Run 承载。Production Session 只沉淀已确认事实、人工修改、节点状态、成本与压缩审计结论；它不会把整份原始上下文无差别发送给每个 Agent。

每个角色在同一 Production Session 内拥有独立的制作会话；独立审计员使用另一条隔离会话。Context Router 首轮只提供该角色拥有的上游事实、合同和下游边界，后续轮次只提供候选差异与上一轮审计。这样既保留连续记忆，也避免角色串线和审计偏见。

## Node

Workflow 中的一个生产节点。节点可以自动执行，也可以要求人工处理。节点的实现可以替换，但节点对外暴露稳定的输入、输出和状态。

## Provider

节点背后的能力来源。Provider 可以是 Pexels、本地素材库、AI 生图、AI 生视频、TTS 服务、人工上传、浏览器操作或未来的第三方平台。

## Human Intervention

人工介入某个节点的执行或决策。人工介入不是异常路径，而是 Workflow 的一等能力，例如人工挑素材、改脚本、拒绝成片、确认发布。

当前 production runtime 支持 `approve`、`request_changes` 和 `reject`。`request_changes` 必须携带受版本保护的节点修订；Studio 已支持从当前视觉审片 finding 定位镜头、复用更早母片，并在同一 run 中重新渲染和复审。改脚本或换 Provider 仍通过节点版本与重新规划入口完成。

## Rework Draft

被人工打回的 run 生成一份可编辑返工草稿。它继承原模板版本、Provider/model 选择、声音、导演角色和上一版创作文件，并把人工打回原因与视觉审片 finding 分流为脚本、导演方案、画面素材三组修改要求。草稿不是一段展示用摘要；三组要求分别进入新一轮编剧、视觉导演和素材执行输入。

返工会创建新的 Production Session，不续用上一轮角色会话。上一版脚本和导演方案只作为明确标记的修改基线，防止旧上下文暗中覆盖新意见。

## Artifact

Workflow 或 Node 产生的可追踪文件或数据，例如脚本、分镜、素材候选、素材计划、配音文件、预览帧、最终视频、审片报告和发布包。

## Quality Gate

决定一个节点产物是否可以进入下一步的检查。Quality Gate 可以自动判断，也可以交给人工。未通过时应进入 rejected、needs_human 或 retry 状态，而不是把低质量结果继续往后传。

## Topic Intelligence Engine

短视频工业流水线的选题能力。它不是固定赛道列表，而是把平台信号、受众痛点、制作成本、视觉可行性、合规风险、商业化潜力和历史数据放进同一个评分与实验循环。

每个进入候选箱的选题还必须形成 `editorialDecision`：说明为什么适合视频、建议采用视频或证据图解、绑定推荐模板，并给出不能被热度覆盖的来源与合规边界。推荐数量有上限，类别需要保持多样；不适合用画面兑现的题材应直接跳过。

## Seed Track

冷启动时用于验证流水线的实验赛道。Seed Track 不是产品边界，也不能写死进核心代码；它只是一组可替换的初始配置。

## Series

长期内容栏目。Series 保存不随单集热点轻易改变的栏目承诺、受众、内容支柱、表达语气、视觉方向和当前季，不等同于一个 `track` 标签或一组普通候选。

## Series Bible

系列的长期创作宪法，包括必须遵守的规则、反复出现的元素和禁止擅自改变的约束。策划、编剧、导演与审片 Agent 都必须读取它，但只有明确的人工修订流程才能改变它。

## Episode Roadmap

按季组织、带稳定集数和前后关系的未来单集计划。Roadmap 是可编辑的创作意图，不是已经发生的事实，也不能自动写入 Canon Ledger。

## Canon Ledger

系列正史账本。只有通过内部终审、形成不可变成片版本的单集才会追加一条事实记录并提升 revision。外部平台发布是后续分发状态，不负责创造正史。

## Internal Master

通过内部终审的定版成片。Internal Master 是后续单集可以安全依赖的检查点；其版本、系列上下文和审计记录保持可追溯。

## Provider Registry

管理同一节点背后可替换能力的注册表。例如素材节点可以同时支持 Pexels、本地素材、AI 生图、AI 生视频、截图、人工上传；工作流只依赖 capability，不直接依赖具体供应商。

## Production Brief

`video-factory/brief-v1` 输入合同，固定目标平台、受众、时长和 provider binding。

## Worker Protocol

`video-factory/worker-v1` 机器接口。TypeScript 负责调度和 run 状态，Python 负责隔离地产出媒体 artifact。

## Run Revision

人工决定和持久化更新使用的 compare-and-swap 版本号。FileRunStore 在同一个 run lock 内完成 load、resume、副作用和 revision 更新，用来拒绝并发、重复或过期决定。
