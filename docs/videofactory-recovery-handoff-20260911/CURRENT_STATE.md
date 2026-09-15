# VideoFactory 当前事实快照

日期：2026-09-11

本文只记录重新采集到的事实，不把旧 `JOURNAL.md` 的阶段结论直接继承为当前结论，也不把测试失败自动解释成产品缺陷或测试过时。

## 1. 仓库与权限边界

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 相对 `origin/codex/final-dual-review-cloud-acceptance` 领先 2 个提交。
- A 阶段此前已由用户确认完成；本次恢复审计不重新实现 A，但要检查 B/C 修改是否破坏 A 的时间轴、产物绑定、媒体复用和付费安全。
- 本轮现状采集没有修改产品源码，没有 commit、push、部署或调用真实 Provider。
- 为恢复确定性本地测试，只执行了 `npm rebuild better-sqlite3`。它修复了本地 `node_modules` 的 ABI，不修改项目源码或 lockfile。

禁止对现有工作树执行 reset、stash、checkout、clean。所有现有修改都必须保留并重新判断。

## 2. 工作树规模

重新采集时：

- 86 个已跟踪文件有修改。
- 22 个未跟踪文件。
- 已跟踪 diff 约 `+13248/-692`。
- `git diff --check`：exit 0。

这与旧交接包 `BASELINE.md` 中的 25 个修改文件、约 `+491/-54` 已完全不同，因此旧文件只能作为历史和设计来源，不能描述当前完成度。

修改横跨：

- `packages/production-pipeline`
- `packages/workflow-core`
- `apps/studio`
- `apps/codex-broker`
- Python/FFmpeg worker
- 部署脚本和大量测试

## 3. 最近一次中断的执行

Copilot coding agent 会话曾尝试一起修 B4/B5/C1/C2，在额度终止前运行约 30 分钟，自报 `+730/-238`。它修改了规划事务、返工、授权和 Studio API 的部分源码，但没有完成阶段测试，也没有更新旧交接包 `JOURNAL.md`。

近期相关文件包括：

- `packages/production-pipeline/src/creative-planning.ts`
- `packages/production-pipeline/src/production-pipeline.ts`
- `packages/production-pipeline/src/production-authorization.ts`
- `packages/production-pipeline/src/generative-asset-worker.ts`
- `packages/production-pipeline/src/codex-screenwriter.ts`
- `packages/production-pipeline/src/codex-visual-review.ts`
- `packages/production-pipeline/src/visual-director.ts`
- `packages/production-pipeline/src/contracts.ts`
- `packages/production-pipeline/src/index.ts`
- `apps/studio/src/server/production-studio.ts`
- `apps/studio/src/server/studio-service.ts`
- `apps/studio/src/server/app.ts`
- `apps/studio/src/shared/api.ts`
- `apps/studio/src/client/components/NodeWorkspace.tsx`

这些文件中的修改不是已验证成果。后续执行者必须检查完整上下文，保留正确部分，修正半完成部分，不能整体重写。

## 4. 本地运行环境

- Node：`v26.8.1`
- Node module ABI：`147`
- `better-sqlite3`：`12.11.1`，声明支持 Node 20/22/23/24/25/26。
- 原本本地 binding 使用 ABI 127，导致 LangGraph SQLite checkpoint 相关测试普遍失败。
- 执行 `npm rebuild better-sqlite3` 后，内存 SQLite 探针成功返回 `1`，后续规划测试可以正常运行。

旧 ABI 失败不能继续当作当前代码失败，也不能通过回退到 MemorySaver 绕过 durable checkpoint。

## 5. 构建与类型检查

### 通过

`npm run build:pipeline`

- exit 0。
- template-core、workflow-core、production-pipeline 的 build 完成。

`git diff --check`

- exit 0。

### 失败

`npm run typecheck`

- exit 2。
- 前置 template/core/pipeline 检查与 `build:pipeline` 通过。
- 失败发生在 Studio 正式 typecheck。

主要错误类别：

1. `NodeWorkspace.tsx` 内部仍构造缺少 `expectedRunRevision` / `expectedVersionId` 的输入草稿。
2. `PlanningStagesPanel.tsx` 调用执行配置时缺少 `expectedRunRevision`。
3. `node-workspace.test.tsx` 大量 fixture 缺少新必填 `acceptedPlanDigest`。
4. `node-workspace.test.tsx` 有两处 JSX 属性重复（TS17001）。
5. 多个测试和组件调用仍未同步新的并发/授权合同。

因此不能声称当前项目类型检查通过。

## 6. B4 当前测试证据

Pipeline 聚焦测试：

```text
files:
- creative-planning-store.test.ts
- creative-planning.test.ts
- production-planning-closure.test.ts
- production-pipeline-preflight.test.ts
- creative-treatment.test.ts
- executable-production-plan.test.ts
- contracts.test.ts

tests 144
pass 144
fail 0
exit 0
```

Studio 规划/API 聚焦测试：

```text
files:
- production-planning-editing.test.ts
- production-planning-stages.test.ts
- api-contract.test.ts

tests 29
pass 24
fail 5
exit 1
```

失败：

1. `accepts planningStageId only on creative-planning and only for whitelisted stages`
   - `applyNodeInputOverride` 返回 stale conflict。
   - 当前测试调用未同步新的 expected revision/version，需判断测试过时还是调用链缺口。
2. `maps planningStageId validation failures and conflicts to 400/409 at the HTTP layer`
   - 预期阶段校验错误，实际先返回“制作版本号必须是有效的非负整数”。
   - 需明确 parser 校验顺序是否属于公共合同。
3. `routes stage-scoped model changes to the matching provider binding`
   - execution configuration 返回 stale conflict。
4. `routes joint asset-source adjustments back to the creative-planning node`
   - execution configuration 返回 stale conflict。
5. `reports every real library-route stage with committed artifacts after completion`
   - treatment 当前已有正式 artifact，但旧断言仍期待空数组。
   - 需要按 B4 正式产物合同更新测试，而不是删除 artifact。

初步事实：B4 pipeline 核心实现较完整，但 Studio API、客户端调用和测试合同未同步，B4 不能判定完成。

## 7. B5 当前测试证据

聚焦文件：

- `generative-asset-worker.test.ts`
- `codex-visual-review.test.ts`
- `contracts.test.ts`
- `production-joint-rework.test.ts`

结果：

```text
tests 159
pass 156
fail 3
exit 1
```

失败：

1. `carries an unaffected multi-level reference chain across runs with one new paid call`
   - actual 4，expected 5。
2. `regenerates the full human-approved reference dependency closure`
   - actual 4，expected 7。
3. `refuses to inherit a reference-derived master whose reference SHA cannot be proven`
   - actual 6，expected 7。

三个失败都集中在跨 run 媒体继承、引用依赖闭包或引用 SHA 证明边界。B5 不能判定完成。

另有 StudioService 用例：

- note-only 用户拒绝当前得到空返工范围，旧测试期待全片 `[1,2,3,4]`。
- 这里涉及产品决定：不能把无法定位的问题自动扩大成全片；测试旧期望很可能与最新产品规则冲突，但需要 Oracle 根据完整合同裁定应要求用户选范围、从自然语言提取范围，还是明确停止。

## 8. C1 当前测试证据

`production-authorization.test.ts`：

```text
tests 25
pass 24
fail 1
exit 1
```

唯一失败：

`auto-continues a covered quote with a derived sub-authorization`

- run 仍停在 `awaiting_spend_approval`。
- 断言要求已被当前 scope 覆盖的报价自动继续。

把 authorization、workflow-runner 和 asset worker 放在同一组时：

```text
tests 184
pass 180
fail 4
```

其中 3 个是 B5 媒体复用失败，另 1 个是上述 C1 自动继续失败。

C1 的纯 scope/decision/安全整数/并发 fold/原型键/authorization host acceptance 测试均已通过，但实际自动继续链尚未闭合。

## 9. C2 与 Studio 当前测试证据

服务/API 组合：

- `production-authorization-api.test.ts`
- `server.test.ts`
- `studio-service.test.ts`

结果：

```text
tests 150
pass 142
fail 8
exit 1
```

与 C2 直接相关：

1. 首次 immutable quote + authorization + idempotent replay 已通过。
2. stale revision 与 foreign quote 拒绝已通过。
3. amendment delta 用例失败：服务签名已变为 `(runId, authorizationId, input, actor)`，测试仍按旧签名直接调用，导致 input 为 undefined。
4. HTTP amendment fake 仍按旧参数位置读取 input，得到 `amend:undefined`。
5. 通用 server 测试中的节点编辑请求未提交新的 expected revision/version，200 预期变成 400。

其他失败涉及 B4/B5 的并发编辑和返工范围，不应重复归因给 C2。

UI 聚焦：

```text
files:
- client.test.tsx
- node-workspace.test.tsx

tests 175
pass 171
fail 4
exit 1
```

四个运行时失败都是旧断言未包含新增的：

- `expectedRunRevision`
- `expectedVersionId`

但正式 Studio typecheck 还有大量 fixture 和组件构造错误，说明不能只更新四个断言。

`NewRunDialog.tsx` 当前已经存在：

- 可编辑 duration range。
- 可选 `budgetIntentionCny`。
- 模板推荐与视觉来源兼容检查。

因此“C2 UI 完全没做”不是准确结论。仍需检查：

- 是否真的先展示 immutable quote，再允许确认。
- 是否有追加、调整方案、暂不继续三个动作。
- 是否把内部授权术语暴露给普通用户。
- UI 与服务端 funding request、pause 和重新授权是否真实闭环。

## 10. 旧资料与当前事实冲突

旧 `JOURNAL.md` 同时出现过：

- B 里程碑 ACCEPTED。
- 后续完整审计又将 B 退回未完成。
- C1 ACCEPTED。
- 后续新的 C1 当前态审计为 CHANGES_REQUIRED。
- C2 API 4/4、Studio 全量绿。
- 当前重新运行却出现合同错位和类型检查失败。

后续资料包必须把这些内容标为历史记录，而不是最终状态。阶段状态只由当前源码、当前测试和新的独立 Oracle 审计共同决定。

## 11. 当前阶段结论（Oracle 前）

- A：用户已确认完成；需防止回归，不重新施工。
- B4：部分完成，pipeline 核心测试绿，Studio 合同与测试未闭合。
- B5：部分完成，媒体依赖/复用仍有 3 个真实失败。
- C1：大部分决策合同通过，自动继续仍失败。
- C2：服务/API 与 UI 已有不少实现，但跨层签名、类型、测试和完整用户闭环未完成。
- C3–C6：本轮尚未重新核验完成度，不能沿用旧日志结论。

## 12. 四批独立 Oracle Web 后的状态

四个全新、相互隔离的第 5 档会话已经完成，并由主 Codex综合：

- B4：`CHANGES_REQUIRED`
- B5：`CHANGES_REQUIRED`
- C1：`CHANGES_REQUIRED`
- C2：`CHANGES_REQUIRED`

这不表示当前实现从零开始。每批分别列出了已修复、部分修复、仍开放和未验证的合同。统一根因与施工顺序见 `ORACLE_SYNTHESIS.md`，完整结果见 `oracle/results/`，会话提交/强度/清理证据见 `ORACLE_SESSION_VERIFICATION.md`。

新的执行顺序固定为 B4 → 阶段审计 → B5 → 阶段审计 → C1 → 阶段审计 → C2 → 阶段审计；C3–C6 在此前不顺手展开。当前唯一施工入口是 `B4_EXECUTION_CARD.md`。
