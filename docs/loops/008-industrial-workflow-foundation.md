# Loop 8: Industrial Workflow Foundation

Date: 2026-08-21

## Objective

把 VideoFactory 从固定脚本链条推进到工业级短视频工作流底座。核心目标是让选题、素材、人工介入、质量门禁和 provider 替换成为一等能力。

## Scope

- 写入中国短视频市场与产品战略材料。
- 写入 TS-first agent workflow 架构 ADR。
- 建立 TS package `@video-factory/workflow-core`。
- 定义 workflow、node、provider、artifact、quality gate、human intervention 和 topic intelligence 的核心类型。
- 用测试证明 workflow 可以执行、停止、拒绝低质量产物、请求人工介入、替换 provider。
- 保留 Python MVP，不在本轮重写渲染链。

## Non-Goals

- 不接真实抖音/快手/视频号/小红书发布 API。
- 不实现 LangGraph.js 或 Mastra 运行时绑定。
- 不做 Studio UI。
- 不生成新公开视频样片。
- 不处理真实账号数据。

## Success Criteria

- `npm test` 通过 TS typecheck 和 workflow-core 测试。
- `make test` 通过 Python + TS 验证。
- 文档明确 seed track 不是产品边界，选题引擎是核心能力。
- README 可以告诉后来的人这轮为什么引入 TS。
- 不提交 `.env.local`、`data/`、`workspace/` 或生成的视频素材。

## Plan

1. 记录战略、ADR 和 loop 材料。
2. 初始化 TS workspace。
3. 实现 workflow-core 领域协议和内存 runner。
4. 增加核心行为测试。
5. 更新 README/Makefile，把验证命令纳入常规流程。
6. 运行 Python 与 TS 测试，检查 git diff。

## Deferred Inputs

- 抖音开放平台应用和发布权限。
- 视频号/小红书/快手发布能力与权限。
- 商业 TTS、AI 生图/生视频 API key。
- 真实运营数据导出方式。
- 最终选择 LangGraph.js、Mastra、OpenAI Agents SDK 或组合方案。
