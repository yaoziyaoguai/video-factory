# AI Director And Adaptive Shot Routing Design

Date: 2026-08-24

## Goal

把 VideoFactory 从“整条视频选择一种素材能力”升级为由 AI 导演逐镜决策的生产系统。成本策略只定义预算、时延和人工门禁，不定义素材组合；导演是正式工作流角色，而不是渲染末端的风格滤镜。

## Product Decisions

- 每条制作必须选择一个导演角色。`auto` 允许 AI 根据题材选择导演语法，其余角色固定创作立场，但仍由 AI 生成逐镜方案。
- 导演角色档案描述擅长题材、节奏、构图、声音和视觉连续性。知名导演只作为电影传统的灵感说明，底层保存结构化摄影语法，不把姓名当作唯一 Prompt。
- “全免费、效果均衡、精品”是经济策略，只限制 `maxPaidShots`、`maxCostCny` 和可用 Provider 池。它们不得规定第几个镜头必须使用图库或生成视频。
- AI 导演只能从本次已启用且服务端验证过的 Provider 池中逐镜选择。每个选择必须记录理由、检索词、真实性策略、连续性提示、置信度和预计成本。
- 逐镜路由没有静态配方回退。导演模型不可用或返回非法计划时，导演节点失败并向用户暴露原因。
- 素材下载或生成失败时允许在同一镜头内回退到导演给出的候选 Provider；最终回退必须写入产物，不能伪装成原决策。

## Director Role

`Director Agent` 位于脚本之后、素材准备之前，职责包括：

1. 复核叙事目标和脚本场景。
2. 选择或落实导演角色档案。
3. 生成全片视觉圣经，包括节奏、构图、色彩、镜头运动、连续性和声音提示。
4. 为每个脚本场景生成 `ShotDecision`，并在预算内选择首选和候选 Provider。
5. 为后续素材节点提供检索词或生成 Prompt。

第一版导演角色：自动导演、纪实观察、静观生活、都市诗意、色彩叙事、几何秩序、悬念调度。UI 同时展示擅长题材和电影传统灵感。

## Workflow Roles

| Node | Role | Responsibility |
| --- | --- | --- |
| brief | 制片人 | 明确目标、平台、预算和生产边界 |
| script | 编剧 | 形成旁白、节奏和场景文本 |
| visual-direction | 导演 | 视觉圣经、逐镜意图和动态路由 |
| assets | 素材导演 | 搜索、生成、授权和逐镜落地 |
| voice | 声音导演 | 音色、语速、停顿和声音质感 |
| render | 剪辑师 | 画面、字幕、声音和节奏合成 |
| technical-review | 技术质检 | 文件、轨道、分辨率和产物完整性 |
| final-review | 总导演 | 人工审片与打回 |
| publish-package | 制片人 | 固化发布包、授权和 AIGC 声明 |

## Data Contracts

`ProductionBrief.director` 保存导演角色、导演 Provider 和本次素材 Provider 池。`VisualDirectorPlan` 保存解析后的角色、视觉圣经和逐镜决策。每个 `ShotDecision` 至少包含：

- `scenePosition`
- `narrativeRole`
- `authenticityPolicy`
- `preferredProviderId`
- `alternativeProviderIds`
- `query`
- `generationPrompt`
- `rationale`
- `continuityNote`
- `confidence`
- `estimatedCostCny`

素材节点消费 `VisualDirectorPlan`，而不是从经济策略推导镜头类型。

## Failure And Cost Boundaries

- 付费 Provider 的实际单镜估价由服务端配置决定，不信任模型输出。
- 付费镜头数量和总估价超过 Brief 上限时，导演计划被拒绝。
- 事实性镜头不得把 AI 生成画面标记为事件证据。
- Provider 下载或生成失败时保留逐镜失败记录和最终来源。
- 旧版 Brief 没有 `director` 时继续走旧工作流，保证历史运行可读取；Web 新建制作默认使用新版导演路径。

## Acceptance Criteria

1. 同一条制作的不同镜头可以由 AI 选择不同 Provider，组合不来自静态配方表。
2. 导演模型返回未知 Provider、重复场景、漏场景或超预算计划时，节点失败。
3. 运行详情的每个节点显示生产角色，导演计划可作为产物下载查看。
4. 新建制作可选择导演角色，并清楚区分经济策略和素材来源池。
5. 本地真实运行生成 `director_plan.json`，素材计划保存逐镜导演决策和实际 Provider。
6. TypeScript、Python、前端组件、生产构建和浏览器主流程验证通过。
