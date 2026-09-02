# 逐笔素材报价、手动重规划与严格素材路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 取消视频级硬费用上限，以图片/视频逐项报价和人工授权保护现金支出；拒绝报价后等待用户手动重规划；任何未明确授权的说明卡或不完整素材计划都不能成功进入成片。

**Architecture:** Workflow Core 将 `billing` 与 `approvalPolicy` 分离，并继续用不可变 `SpendPlan` 约束单次授权。Production Pipeline 持久化报价反馈但不自动调用导演，导演在用户主动重规划时读取有限反馈历史；素材执行器以导演路由为唯一事实来源，并在 Python、TypeScript 和最终计划门禁三层拒绝静默卡片降级。Studio 只为人工审批的图片/视频显示报价，模板不再注入预算；GitHub Actions 只部署本次已验证的 commit SHA。

**Tech Stack:** TypeScript 5.9、Node.js test runner、React、Python 3.11 `unittest`、SQLite loop ledger、GitHub Actions、Docker、阿里云 ECS。

---

## Scope

- **Outcome:** 图片/视频 `metered + manual`，TTS `metered + automatic`，GLM Flash 视觉审片 `subscription + none`；拒绝图片/视频报价后保存反馈并停住；手动重规划后产生新报价；非显式 editorial 卡片、失败生成、缺失场景和错误复用链均使素材节点失败。
- **Non-goals:** 不增加视频级预算、付费镜头数限制、自动砍镜头、自动换低价 Provider、自动发布内容或公网域名备案方案。
- **Compatibility:** 历史 `maxCostCny`、`maxPaidShots`、模板 `costPolicy` 可以被旧数据解析，但统一归零或忽略，不得进入导演 prompt、UI、执行门禁或 KPI。
- **Proof:** `python -m unittest discover -s tests`、`npm test`、Docker smoke、Oracle Web 复核、GitHub Actions 全绿、阿里云隧道下桌面/移动端点击和最终视频逐片段核验。

## File Map

- `packages/workflow-core/src/types.ts`：定义审批策略与 Provider 元数据。
- `packages/workflow-core/src/workflow-runner.ts`：决定节点是否停在报价授权、是否自动执行，并验证执行回执。
- `packages/production-pipeline/src/contracts.ts`：兼容旧经济字段和解析报价反馈。
- `packages/production-pipeline/src/production-pipeline.ts`：Provider 策略、报价拒绝状态机、手动重规划与反馈历史。
- `packages/production-pipeline/src/visual-director.ts`、`codex-visual-director.ts`：导演输入合同，不再接收视频预算。
- `apps/codex-broker/src/codex-executor.ts`、`task-definitions.ts`：接收并提示导演使用 `costFeedback` 历史。
- `packages/production-pipeline/src/generative-asset-worker.ts`：付费生成、复用依赖、失败传播和最终计划门禁。
- `src/video_factory/stock_assets.py`、`worker.py`：图库/卡片物化的严格路由合同。
- `apps/studio/src/**`：拒绝反馈、手动重规划、Provider 能力目录和费用文案。
- `packages/template-core/src/**`、`apps/studio/src/server/template-*.ts`：历史模板预算兼容但不进入新运行。
- `.github/workflows/ci-cd.yml`：把本轮已验证 `${{ github.sha }}` 传到 ECS 并部署该 SHA。

### Task 1: 分离计费与审批策略

**Files:**
- Modify: `packages/workflow-core/src/types.ts`
- Modify: `packages/workflow-core/src/workflow-runner.ts`
- Modify: `packages/workflow-core/src/index.ts`
- Test: `packages/workflow-core/test/workflow-runner.test.ts`

- [ ] **Step 1: 写出审批策略失败测试**

在 `workflow-runner.test.ts` 增加三个行为用例：

```ts
test("metered manual provider pauses for an immutable spend authorization", async () => {
  // 断言 quote 与输入、provider、model、items、maxAttempts 绑定，授权前 run.status === "waiting_for_human"。
});

test("metered automatic provider executes without a spend plan and keeps a metered receipt", async () => {
  // 断言 provider 被调用一次、没有 spendPlan、receipt.billing === "metered"。
});

test("new metered providers default to manual approval", async () => {
  // 不声明 approvalPolicy，断言仍等待人工授权。
});
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `npm run build:core && node --test --import tsx --test-name-pattern='approval|automatic provider|default to manual' packages/workflow-core/test/workflow-runner.test.ts`

Expected: FAIL，因为 `Provider` 尚无 `approvalPolicy`，所有 `metered` Provider 都被一律暂停。

- [ ] **Step 3: 实现最小策略合同**

在 `types.ts` 新增并导出：

```ts
export type ApprovalPolicy = "manual" | "automatic" | "none";

export interface Provider<TInput = unknown, TOutput = unknown> {
  // 省略现有字段
  approvalPolicy?: ApprovalPolicy;
}
```

在 runner 使用单一归一化函数：

```ts
function approvalPolicyFor(provider: Pick<Provider, "billing" | "approvalPolicy">): ApprovalPolicy {
  if (provider.approvalPolicy) return provider.approvalPolicy;
  return provider.billing === "metered" ? "manual" : "none";
}
```

只有 `metered + manual` 创建 `SpendPlan` 和等待人工；`metered + automatic` 仍通过受控运行上下文计数和生成真实 `metered` receipt，但不伪造人工授权；`none` 不允许绕过一个未显式改成 `automatic` 的 `metered` Provider。

- [ ] **Step 4: 跑 Workflow Core 全测**

Run: `npm run build:core && node --test --import tsx packages/workflow-core/test/workflow-runner.test.ts`

Expected: PASS。

### Task 2: 修正生产 Provider 费用语义

**Files:**
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `apps/studio/src/server/provider-catalog.ts`
- Modify: `apps/studio/src/server/production-worker.ts`
- Modify: `apps/studio/src/server/resource-governance-studio.ts`
- Test: `packages/production-pipeline/test/production-pipeline.test.ts`
- Test: `apps/studio/test/studio-service.test.ts`

- [ ] **Step 1: 写 Provider 分类失败测试**

```ts
test("TTS auto-executes and records cost while GLM Code Plan review never quotes cash", async () => {
  // TTS: billing=\"metered\", approvalPolicy=\"automatic\", 有 receipt 但无 SpendPlan。
  // GLM: billing=\"subscription\", approvalPolicy=\"none\", estimatedCostCny=0。
});

test("only selected paid image and video routes produce manual quote items", async () => {
  // 免费图库、本地编辑、TTS、GLM 均不出现在 assets SpendPlan.items 中。
});
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `npm run build:pipeline && node --test --import tsx --test-name-pattern='TTS|GLM|quote items' packages/production-pipeline/test/production-pipeline.test.ts`

Expected: FAIL，现有 GLM 仍被登记为 `metered`，TTS 没有显式自动策略。

- [ ] **Step 3: 修正目录和运行时元数据**

将 GLM 视觉审片统一为：

```ts
{ billing: "subscription", approvalPolicy: "none", estimatedCostCny: 0 }
```

将 MiniMax TTS 统一为：

```ts
{ billing: "metered", approvalPolicy: "automatic" }
```

资源看板继续从 TTS `executionReceipt` 汇总真实成本，但不把 GLM Code Plan 额度列为现金支出。

- [ ] **Step 4: 运行生产与 Studio 服务测试**

Run: `npm run build:pipeline && node --test --import tsx packages/production-pipeline/test/production-pipeline.test.ts && npm test --workspace @video-factory/studio -- --test-name-pattern='provider|cost|review'`

Expected: PASS。

### Task 3: 报价拒绝只保存反馈，手动重规划才调用导演

**Files:**
- Modify: `packages/production-pipeline/src/contracts.ts`
- Modify: `packages/production-pipeline/src/production-pipeline.ts`
- Modify: `packages/production-pipeline/src/visual-director.ts`
- Modify: `packages/production-pipeline/src/codex-visual-director.ts`
- Modify: `apps/codex-broker/src/codex-executor.ts`
- Modify: `apps/codex-broker/src/task-definitions.ts`
- Modify: `apps/studio/src/server/app.ts`
- Modify: `apps/studio/src/client/components/NodeWorkspace.tsx`
- Test: `packages/production-pipeline/test/contracts.test.ts`
- Test: `packages/production-pipeline/test/production-pipeline.test.ts`
- Test: `apps/codex-broker/test/codex-executor.test.ts`
- Test: `apps/studio/test/node-workspace.test.tsx`

- [ ] **Step 1: 写完整状态机失败测试**

```ts
test("rejecting an asset quote stores zero-target feedback without calling the director", async () => {
  // 拒绝前记录 directorCalls；提交 targetEstimatedCostCny: 0 后 directorCalls 不变。
  // 旧 spendPlan 被作废，visual-direction/assets 处于 stale，UI 显示待手动重规划。
});

test("manual replan sends bounded feedback history newest first and creates a fresh quote", async () => {
  // 调用 resumeStale 后 directorCalls + 1；收到最近历史；新 spendPlan.id 不等于旧 id。
});

test("broker accepts costFeedback and includes it in the isolated director payload", async () => {
  // 不触发 assertExactKeys；结构化历史出现在 prompt data 中。
});
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `npm run build:pipeline && node --test --import tsx --test-name-pattern='zero-target|manual replan|feedback history' packages/production-pipeline/test/{contracts,production-pipeline}.test.ts && npm run test --workspace @video-factory/codex-broker -- --test-name-pattern=costFeedback`

Expected: FAIL，目标价 `0` 被拒绝，`dispatchSpendRejection()` 自动 `resumeStale()`，Broker exact-key 校验拒绝 `costFeedback`。

- [ ] **Step 3: 实现拒绝与重规划边界**

将目标价解析范围改为 `[0, 100000]`。`dispatchSpendRejection()` 只完成以下动作：校验当前 assets 报价、append 最多 20 条反馈、作废报价和导演/素材下游、checkpoint 并返回 stale run；不得调用 `resumeStale()`。

导演输入使用有限历史而非 `.at(-1)`：

```ts
costFeedback: [...(brief.spendFeedback ?? [])].slice(-10).reverse()
```

Broker payload 类型、`assertExactKeys()` 和 prompt data 同时允许该字段；反馈不含任何 secret。Studio 的按钮分别调用“保存反馈”和“重新规划”，不能用一个请求完成两步。

- [ ] **Step 4: 跑状态机、Broker、Studio 测试**

Run: `npm run build:pipeline && node --test --import tsx packages/production-pipeline/test/{contracts,production-pipeline}.test.ts && npm run test --workspace @video-factory/codex-broker && npm test --workspace @video-factory/studio -- --test-name-pattern='报价|反馈|重新规划'`

Expected: PASS。

### Task 4: 移除说明卡基线并严格执行素材失败

**Files:**
- Modify: `src/video_factory/stock_assets.py`
- Modify: `src/video_factory/worker.py`
- Modify: `packages/production-pipeline/src/generative-asset-worker.ts`
- Test: `tests/test_worker.py`
- Test: `tests/test_visual_rendering.py`
- Test: `packages/production-pipeline/test/generative-asset-worker.test.ts`

- [ ] **Step 1: 反转旧降级测试并增加失败矩阵**

Python 用例覆盖：stock 无 key、搜索空、语义筛选全拒绝、候选全下载失败；TypeScript 用例覆盖生成提交前失败、提交后失败、媒体下载失败、文件描述失败。每个用例都断言：节点失败、无 `local://video-factory/card`、无未授权 local asset、第一条必需素材失败后不再提交后续付费调用。

显式保留唯一成功卡片用例：

```py
def test_explicit_editorial_route_materializes_a_card(self):
    route = {"preferredProviderId": "local-editorial-v1", "deliveryType": "editorial_card"}
    # 断言卡片成功；仅出现在 alternativeProviderIds 或 visual_strategy=local 时均不得成功。
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `PYTHONPATH=src python3 -m unittest tests.test_worker tests.test_visual_rendering && npm run build:pipeline && node --test --import tsx packages/production-pipeline/test/generative-asset-worker.test.ts`

Expected: 至少 direct baseline、生成失败和 stock fallback 用例失败。

- [ ] **Step 3: 收紧两层 Worker**

Python 只在严格条件下调用 `materialize_local_scene()`：

```py
card_allowed = (
    route.get("preferredProviderId") == "local-editorial-v1"
    and route.get("deliveryType") == "editorial_card"
)
```

stock 全失败抛出素材准备异常；generative route 只产生待执行路由，不预制卡片；local alternative 不能成为 fallback。

TypeScript direct mode 不再改写为 `local-editorial-v1` baseline，不再按 `maxPaidShots` 截断，不把 failed job 正常化为 `fallbackScenes`；失败 job 先持久化 task ID、成本和错误，再使节点失败，且停止剩余付费请求。

- [ ] **Step 4: 跑 Worker 全测**

Run: `PYTHONPATH=src python3 -m unittest tests.test_worker tests.test_visual_rendering && npm run build:pipeline && node --test --import tsx packages/production-pipeline/test/generative-asset-worker.test.ts`

Expected: PASS。

### Task 5: 完成 REUSE_ONLY 与最终素材计划门禁

**Files:**
- Modify: `packages/production-pipeline/src/generative-asset-worker.ts`
- Modify: `src/video_factory/stock_assets.py`
- Modify: `src/video_factory/worker.py`
- Test: `packages/production-pipeline/test/generative-asset-worker.test.ts`
- Test: `tests/test_worker.py`

- [ ] **Step 1: 写复用图和完整性失败测试**

```ts
test("direct and transitive reuse share the replaced master without extra calls", async () => {
  // scene 1 生成一次；scene 4 -> 1；scene 5 -> 4；三个 final asset 共享物理文件，只有一次 job/cost。
});

test("invalid or failed reuse graphs fail without cards", async () => {
  // 缺 source、前向、循环、重复 scenePosition、母片失败均拒绝。
});

test("completed asset plans exactly cover script scenes", async () => {
  // 缺失、重复、额外 scene、generation_pending、failed job、旧 card artifact 均被 assertCompletedAssetPlan 拒绝。
});
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `npm run build:pipeline && node --test --import tsx --test-name-pattern='reuse|completed asset plans|cover script' packages/production-pipeline/test/generative-asset-worker.test.ts && PYTHONPATH=src python3 -m unittest tests.test_worker`

Expected: FAIL，当前成功门禁只检查已有 route/asset，未精确对齐脚本场景，间接复用或母片失败传播不完整。

- [ ] **Step 3: 实现复用拓扑和最终门禁**

先解析完整 reuse 图，再计算生成任务和报价。复用镜头永不进入生成 job，不计费；母片成功替换时，直接和间接依赖同步 `asset_id/local_path/provider/source_url`，同时保留各镜头自己的 `duration/query/crop`。任何 source 不合法或母片失败都使整个素材节点失败。

最终门禁接收脚本场景列表并验证一一覆盖：

```ts
assertCompletedAssetPlan(plan, expectedScenePositions, jobs);
```

成功计划必须无 pending、failed job、非显式 editorial local card、未引用 media artifact；返回 artifacts 必须恰好对应最终计划引用文件。

- [ ] **Step 4: 跑复用与完整性全测**

Run: `npm run build:pipeline && node --test --import tsx packages/production-pipeline/test/generative-asset-worker.test.ts && PYTHONPATH=src python3 -m unittest tests.test_worker`

Expected: PASS。

### Task 6: 清除旧预算产品语义并由 Provider 目录驱动 UI

**Files:**
- Modify: `packages/template-core/src/types.ts`
- Modify: `packages/template-core/src/template-parser.ts`
- Modify: `packages/template-core/src/resolve-template.ts`
- Modify: `packages/template-core/src/snapshot-parser.ts`
- Modify: `apps/studio/src/server/template-studio.ts`
- Modify: `apps/studio/src/server/template-catalog.ts`
- Modify: `apps/studio/src/server/resource-governance-studio.ts`
- Modify: `apps/studio/src/client/components/NewRunDialog.tsx`
- Modify: `apps/studio/src/client/templates/TemplateGallery.tsx`
- Modify: `apps/studio/src/client/pages/ResourcesPage.tsx`
- Modify: `apps/studio/src/client/components/NodeWorkspace.tsx`
- Modify: `.env.example`
- Test: `packages/template-core/test/template-core.test.ts`
- Test: `apps/studio/test/client.test.tsx`
- Test: `apps/studio/test/studio-service.test.ts`

- [ ] **Step 1: 写 UI/模板兼容失败测试**

```ts
test("legacy template costPolicy parses but does not affect a new production run", () => {
  // 历史值可读；resolved production input 不含有效 cap。
});

test("new run, template gallery and resources do not present a video budget ceiling", () => {
  // 页面中无“预算上限”“付费镜头上限”“上限 ¥”。
});

test("asset provider choices come from declared delivery types", () => {
  // stock_video/generated_video/generated_image/editorial_card 均由目录筛选，无前端模型硬编码分支。
});
```

- [ ] **Step 2: 运行用例并确认 RED**

Run: `npm run build:template && node --test --import tsx packages/template-core/test/*.test.ts && npm test --workspace @video-factory/studio -- --test-name-pattern='budget|上限|delivery types'`

Expected: FAIL，模板和部分页面仍显示或传播旧 `costPolicy`。

- [ ] **Step 3: 最小清理旧语义**

保留历史 parser 字段但统一归零/忽略；新模板和新运行不生成该配置；删除导演输入、模板卡片和资源 KPI 中的上限文案。`NodeWorkspace` 只按 Provider 目录声明的 `deliveryTypes` 过滤，所有新增素材 Provider 默认继承其计费与审批元数据。

- [ ] **Step 4: 跑模板和 Studio 全测**

Run: `npm run build:template && node --test --import tsx packages/template-core/test/*.test.ts && npm run studio:test`

Expected: PASS。

### Task 7: 固定 CI 已验证版本并做本地自动化总验

**Files:**
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `scripts/deploy-production.sh` only if the current script cannot accept a detached SHA worktree
- Create: `docs/loops/021-spend-approval-and-strict-assets-results.md`

- [ ] **Step 1: 给部署脚本增加静态验证**

Action 将不可变 SHA 传入远端：

```yaml
env:
  RELEASE_SHA: ${{ github.sha }}
with:
  envs: PROJECT_PATH,PUBLIC_HEALTH_URL,RELEASE_SHA
```

远端先 fetch 该 SHA，再 checkout 并校验：

```bash
git fetch origin "$RELEASE_SHA"
git -C "$release_path" checkout --detach "$RELEASE_SHA"
test "$(git -C "$release_path" rev-parse HEAD)" = "$RELEASE_SHA"
```

- [ ] **Step 2: 运行最小静态检查**

Run: `bash -n scripts/deploy-production.sh scripts/backup-production.sh scripts/setup-codex-broker-host.sh scripts/setup-zai-codex-broker-host.sh`

Run: `docker compose --env-file .env.docker.prod.example -f docker/docker-compose.prod.yml config --quiet`

Expected: 两条命令 exit 0；workflow 不再 checkout 漂移的 `origin/main`。

- [ ] **Step 3: 运行全量自动化与容器 smoke**

Run: `PYTHONPATH=src python3 -m unittest discover -s tests`

Run: `npm test`

Run: `docker build --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine --file docker/Dockerfile --tag video-factory:preflight .`

Run: `docker run --rm video-factory:preflight node packages/production-pipeline/dist/cli.js run examples/briefs/linux-container-smoke.json --workspace /tmp/video-factory-smoke`

Expected: 全部 exit 0，smoke 产出完整视频；不得把 timeout、截断输出或部分日志当 PASS。

- [ ] **Step 4: 记录 Loop/Journal 证据**

在结果文档记录设计偏差、失败尝试、测试命令、Oracle 结论、commit、Actions run、云端桌面/移动端核验与成片元数据；同时用 `loop-event` 添加 `implement`、`verify`、`review`、`ship` 事件。只有所有验证完成后才运行 `loop-complete`。

### Task 8: Oracle Web 评估、最小补强与云端终验

**Files:**
- Modify: 仅 Oracle 指出的、与“最急缺能力”直接相关且经源码证据确认的最小文件集
- Test: 对应能力的回归测试
- Modify: `docs/loops/021-spend-approval-and-strict-assets-results.md`

- [ ] **Step 1: 对最小非敏感文件集运行 Oracle Web dry-run**

附加设计、计划、核心费用合同、状态机、素材门禁和相关测试；明确排除 `.env`、token、API key、生产数据。先执行 skill 指定的 dry-run，确认文件体积和 prompt，再运行真实评估，并验证结果包含 `Thinking time: Ultra`。

- [ ] **Step 2: 只实现 Oracle 证据支持的最高优先级缺口**

先增加可复现失败测试，再写最小实现；若 Oracle 建议与产品决策冲突，以本设计为准并在 journal 说明不采纳原因。

- [ ] **Step 3: 重跑 Task 7 的全部自动化检查和独立 diff review**

Expected: 全绿且 review 无未解决 P0/P1。

- [ ] **Step 4: 提交、推送并等待 GitHub Actions 部署固定 SHA**

Run: `git diff --check`

Run: `git status --short`

提交后推送到 GitHub；通过仓库既有 main 发布流程触发 Actions。不得在 ECS 手工覆盖仓库或绕过 CI。确认 Actions 的 verify、security、deploy 三个 job 全绿，并核对 ECS `.release` HEAD 等于本次 SHA。

- [ ] **Step 5: 通过临时 loopback 隧道执行一次云端广覆盖桌面 QA**

Run: `ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:14317:127.0.0.1:4317 aliyun`

浏览器访问 `http://localhost:14317`，覆盖：新建制作、方案编辑、图片/视频报价、拒绝并填 `¥0`、确认不会自动重规划、手动重规划、新报价确认、Provider 切换同步、TTS 不弹报价、GLM Code Plan 不弹现金报价、素材失败无说明卡、复用母片、最终审片与打回。

- [ ] **Step 6: 修复集中发现后统一再发布，并做移动端与成片终验**

若桌面 QA 发现问题，在本地集中修复并重跑全量自动化，只做一次新的正式部署。移动视口重复关键路径，验证触控、布局、弹窗和报价明细。对最终视频用 `ffprobe` 验证时长/帧数，并逐片段播放检查 0–总时长均有画面、视觉一致、无内部术语和未授权说明卡；不用可能误判尾部黑屏的稀疏拼图采样作为唯一证据。

## Self-Review

- **Spec coverage:** 费用/审批分离、TTS/GLM 分类、拒绝后手动重规划、`¥0`、反馈历史、Broker、说明卡、失败传播、REUSE_ONLY、旧预算清理、目录驱动 UI、固定 SHA 部署、Oracle、桌面/移动端/成片验证均有对应 Task。
- **Placeholder scan:** 无 `TBD`、`TODO`、`implement later` 或“同 Task N”占位语句；每个行为任务都有明确失败测试、实现边界和命令。
- **Type consistency:** 使用统一 `ApprovalPolicy`、`costFeedback` 历史、`targetEstimatedCostCny`、`SpendPlan.maxCostCny` 单次授权语义；没有重新引入视频级 cap。
