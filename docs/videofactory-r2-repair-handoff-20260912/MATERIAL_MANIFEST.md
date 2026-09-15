# 材料清单

## 必读报告

- 第一轮 QA：`/Users/jinkun.wang/work_space/veidofactory/docs/qa/videofactory-qa-acceptance-20260912-01.md`
- 第二轮真实 QA：`/Users/jinkun.wang/work_space/veidofactory/docs/qa/videofactory-real-local-qa-20260912-02.md`
- QA 证据说明：`/Users/jinkun.wang/work_space/veidofactory/docs/qa/README.md`
- 第二轮截图：`/Users/jinkun.wang/work_space/veidofactory/docs/qa/real-local-20260912-02/screenshots/`
- A/B/C 恢复包：`/Users/jinkun.wang/work_space/veidofactory/docs/videofactory-recovery-handoff-20260911/`
- 早期权威设计包：`/Users/jinkun.wang/Documents/ChatGPT/做视频/videofactory-workflow-handoff-20260909/`

早期资料只用于理解产品目标和不变量；当前源码、R2 报告和本包优先。

## Oracle

- session meta：`/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-r2-transport-contract-repair-audit-20260912-01/meta.json`
- transcript：`/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-r2-transport-contract-repair-audit-20260912-01/artifacts/transcript.md`
- SHA-256：`9cc84c227ac0df1a88dd13f971e9e0f908936e3ce8274f3bd6a75e0e08e5b257`

## 核心源码导航

### Topic 合同

- `apps/studio/src/server/trend-opportunity-agent.ts`
- `apps/studio/src/server/trend-studio.ts`
- `apps/studio/test/trend-opportunity-agent.test.ts`
- `apps/codex-broker/src/codex-executor.ts`
- `apps/codex-broker/src/task-definitions.ts`
- `apps/codex-broker/test/task-definitions.test.ts`
- `packages/production-pipeline/src/codex-chat.ts`
- `apps/studio/src/server/codex-provider-settings.ts`

### Broker durable/transport

- `apps/codex-broker/src/broker-server.ts`
- `apps/codex-broker/test/broker-server.test.ts`
- `packages/production-pipeline/src/codex-chat.ts`
- `packages/production-pipeline/test/codex-chat.test.ts`
- `packages/production-pipeline/src/fallback-task-client.ts`
- `packages/production-pipeline/test/fallback-task-client.test.ts`

### Role loop 与恢复

- `packages/production-pipeline/src/role-agent-loop.ts`
- `packages/production-pipeline/test/role-agent-loop.test.ts`
- `packages/production-pipeline/src/production-pipeline.ts`
- `packages/production-pipeline/test/production-planning-closure.test.ts`
- `apps/studio/src/server/production-studio.ts`
- `apps/studio/src/server/studio-service.ts`
- `apps/studio/src/shared/api.ts`
- `apps/studio/src/client/api.ts`
- `apps/studio/src/client/components/RunWorkbench.tsx`
- `apps/studio/src/client/pages/RunPage.tsx`
- `apps/studio/test/production-planning-stages.test.ts`
- `apps/studio/test/studio-service.test.ts`
- `apps/studio/test/client.test.tsx`

### 选题 UX 与健康

- `apps/studio/src/client/components/TopicEntryWorkspace.tsx`
- `apps/studio/src/server/editorial-decision.ts`
- `apps/studio/src/server/provider-catalog.ts`
- `apps/studio/src/server/run-observability.ts`
- `apps/studio/test/candidate-inbox.test.ts`
- `apps/studio/test/creative-os.test.tsx`
- `apps/studio/test/run-observability.test.tsx`

## 真实证据

- workspace：`/Users/jinkun.wang/work_space/veidofactory/workspace/factory`
- Codex socket：`/Users/jinkun.wang/work_space/veidofactory/.local/runtime/codex/worker.sock`
- ZAI socket：`/Users/jinkun.wang/work_space/veidofactory/.local/runtime/zai-codex/worker.sock`

不要把整个 workspace、secrets 或用户数据作为外部 Oracle/聊天附件。执行者可在本机只读核对与四条失败 run 直接相关的 record，并在日志中只写 hash/ID/状态，不写 prompt、凭据或私人内容。

