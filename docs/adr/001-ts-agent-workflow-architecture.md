# ADR 001: TS-First Agent Workflow Architecture

Date: 2026-08-21

## Status

Accepted for the next implementation loop.

## Context

当前 Python MVP 已经跑通了选题、脚本、素材、渲染和 loop ledger，但它更像固定 CLI 链条。用户明确要求项目不能停留在 demo，而要具备工业级短视频流水线能力：节点可扩展、provider 可替换、流程可自动或人工介入，并且后续能承接 agent graph 工作流。

同时，短视频渲染、模板、运营后台、人工审核台和 provider 配置都天然需要 Web/UI 能力。TS/React 生态在这些方面比 Python 更适合作为产品主干。

## Decision

VideoFactory 采用 TS-first 架构：

- TypeScript 作为产品域、workflow、provider registry、API 和 Studio UI 的主语言。
- Python 保留为 media worker 层，承接 FFmpeg、Pillow、素材准备，以及未来的云端转写与 TTS Provider 适配。
- Remotion 作为后续视频模板和动态渲染的优先方向。
- LangGraph.js / Mastra / OpenAI Agents SDK 可以作为 agent runtime 候选，但核心业务协议不直接绑定某一个框架。

第一步先建立 `@video-factory/workflow-core`，定义稳定的领域协议：

- WorkflowDefinition / WorkflowRun
- NodeDefinition / NodeRun
- Provider / ProviderRegistry
- Artifact
- QualityGate
- HumanIntervention
- TopicCandidate / TopicSignal / TopicScore

## Rationale

不直接把 LangGraph.js 或 Mastra 写进第一层核心，是为了避免早期框架锁定。我们先定义自己的领域协议，再把 runtime 当 provider 接进来。这样既能兼容 agent graph，又不会让视频生产语义散落在外部框架的 callback 里。

TS 主干的收益：

- 与未来 Web Studio、审核台、Remotion 模板天然同栈。
- 方便表达强类型 workflow schema。
- provider 和 node contract 更容易被测试、复用和暴露成 API。
- Python worker 可以被清晰包裹，而不是继续扩成不可控脚本。

## Consequences

正面影响：

- 后续每个节点都可以支持自动 provider 和人工 provider。
- 选题引擎会成为 workflow node，而不是静态内容配置。
- 可以逐步迁移，不需要推翻当前 Python 成果。
- 测试可以先覆盖领域协议，再接具体平台/API。

代价：

- 仓库会进入双语言阶段，需要同时维护 Python 与 TS 测试。
- 初期不能享受完整 LangGraph/Mastra 的 runtime 能力。
- 需要明确 worker 边界，避免 TS 和 Python 两边重复实现业务逻辑。

## Follow-Up Decisions

- ADR 002：选择 LangGraph.js、Mastra 或自研轻 runtime 的接入方式。
- ADR 003：选择 Remotion 模板系统与 Python FFmpeg 后处理的边界。
- ADR 004：选择 Postgres/SQLite、artifact store、queue 的演进路径。
