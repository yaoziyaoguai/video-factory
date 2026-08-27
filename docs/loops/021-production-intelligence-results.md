# Loop 021: Production Intelligence Results

Date: 2026-08-28

## Goal

在不重复付费生成、不照搬第三方流水线的前提下，修复真实成片暴露出的审片与素材选择问题，并把开源项目中的可靠模式固化为 VideoFactory 自己的能力。

## Implemented

- 视觉审查按渲染时间线取首屏和逐镜中点，并记录真实视频时长。
- 素材路由保存最多 6 个安全候选，展示当前采用项、缩略图、来源、作者和授权提示。
- 浏览器拒绝 `javascript:`、`file:` 等候选链接；节点交付不暴露素材下载 URL。
- 导演 Prompt Pack 升级为 v5，区分“图库检索”和“模型生成”，压缩图库查询语义。
- broker 增加场景连续性、路由唯一性和审片批准阈值的确定性质量门。
- ADR 004 定义 Skill Pack、语义排名、参考视频和后处理的稳定扩展边界。

## Real-video Evidence

- 视频：H.264 1080x1920 + AAC，27.976 秒，6,040,195 bytes。
- 新抽帧：12/12 为有效画面，没有白色转场样本。
- Codex 视觉审片：`reject`，confidence 0.84；composition 64、continuity 28、pacing 44、legibility 49、safety 90。
- 该拒绝是正确结果：当前免费图库成片存在动作不匹配、重复题材镜头和编辑卡可读性问题。
- 本轮没有重新调用 MiniMax 或其他付费生成节点，也没有批准发布。

## Verification

- Python full regression: 61 passed; review-media: 11 passed.
- Core TypeScript: 155 passed, 1 explicit real-E2E skip.
- Codex broker: 57 passed.
- Studio: 83 component tests and 152 service/API tests passed.
- Package entrypoints: 3 passed; production build completed.
- Production Compose config, deployment shell syntax, diff whitespace and changed-file secret scan passed.

## Cross-review Resolution

- Claude correctly identified stale-run candidate copy, untyped render durations and insufficiently explicit integration tests; all were fixed.
- Claude's P0 claim that `renderManifestPath` was not wired was disproved against production code and is now protected by pipeline, agent and Python preprocessor tests.
- Pixabay video `picture_id` remains deliberately unrendered rather than guessed into an undocumented URL; image candidates and Pexels video candidates still show official previews.

## Deployment And Cloud Acceptance

- Commit `0015fe37b7c54fde1016417aae660be59f811c8c` passed GitHub Actions test/build, dependency security and Alibaba ECS deployment jobs.
- Production login and authenticated read-only canary passed for session, provider catalog, the retained real-video run and cost dashboard.
- Host `vf-codex-broker` and `vf-zai-codex-broker` services are active; after refreshing Studio's startup probe, both Codex and GLM-5.3-Flash visual-review providers report `ready`.
- The cloud login page completed loading without horizontal overflow. The paid video remains at final human review and was neither regenerated nor published.
