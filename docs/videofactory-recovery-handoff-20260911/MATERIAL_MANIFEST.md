# 审计材料与源码导航

## 本次事实来源

- 当前仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 当前事实：[CURRENT_STATE.md](CURRENT_STATE.md)
- 旧设计包：`/Users/jinkun.wang/Documents/ChatGPT/做视频/videofactory-workflow-handoff-20260909`
- 当前 Oracle prompts：`oracle/prompts/`
- 当前 Oracle 完整结果：`oracle/results/`

## 四批 Oracle 输入范围

### B4

发送了当前状态、旧 B 技术/计划、旧 B4 finding 作为历史、current pipeline/workflow diff、完整 planning/store/executable/contracts、Studio current diff、planning stage UI 和当前 planning/editing/stage tests。预览约 25.3 万 tokens；没有 `.env`、token、生产 dump 或真实素材。

执行者重新施工时还必须直接读取当前完整：

- `packages/production-pipeline/src/production-pipeline.ts`
- `packages/production-pipeline/src/run-store.ts`
- `packages/workflow-core/src/workflow-runner.ts`
- `packages/production-pipeline/src/creative-planning*.ts`
- `creative-treatment.ts`、`executable-production-plan.ts`、`executable-timeline.ts`
- 角色 adapters、`asset-semantic-ranker.ts`、Broker task definitions/executors
- `python-worker-client.ts`、Python stock/inventory/worker 路径
- Studio app/service/server/shared/client 编辑纵向链

### B5

发送了当前状态、旧 B 计划、旧 B5 finding 作为历史、B5 core/studio current diff、完整 `creative-planning.ts`、`generative-asset-worker.ts`、`codex-visual-review.ts` 和 joint rework test。预览约 21.7 万 tokens。

执行者必须补读三项当前失败用例的完整 fixture、runner `applyNodeRevision`、role-loop checkpoint、Studio 返工 UI/DTO 和真实媒体/审片消费边界。

### C1

发送了当前状态、旧 C 计划、旧 C1 finding 作为历史、C1 pipeline/worker/workflow diff、完整 `production-authorization.ts`、`run-store.ts` 和授权测试。预览约 13.5 万 tokens。

执行者必须补读当前正式 Studio issuer、完整 WorkflowRunner exact matcher、paid ledger item parser、worker create/reconcile 和现有认证/lease/CAS 接口。

### C2

发送了当前状态、旧流程/技术/C 计划、旧 C2 finding 作为历史、Studio server/API/UI current diff、完整授权模块、API test 以及 NewRunDialog/NodeWorkspace/RunWorkbench。预览约 23.7 万 tokens。

执行者必须补读当前 Pipeline/C1 host、run-store、认证和全局 HTTP error mapping，并用真实 route→service→pipeline 测试补足本轮没有执行的边界。

## 旧材料的使用规则

可继续作为权威设计依据：

- `WORKFLOW.md`
- `TECHNICAL_DECISIONS.md`
- `PROMPT_CONTRACTS.md`
- A/B/C plan 中未被本包修正的产品合同
- 旧 `ACCEPTANCE.md` 的跨题材/时间/费用/UX ID

仅用于考古：

- 旧 `BASELINE.md` 的文件数量和 diff 规模
- 旧 `JOURNAL.md` 的阶段状态
- 旧 Oracle verdict
- 旧测试通过总数

本包的四份 Oracle transcript 也只是当前执行建议。它们明确有未附完整源码或未独立重跑测试的证据边界；执行者必须以当前仓库重新定位和验证。
