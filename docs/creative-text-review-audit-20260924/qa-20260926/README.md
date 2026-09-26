# 2026-09-26 收尾验证证据

本目录是固定证据，不是另一份当前计划。当前状态与任务边界以 [RESULT.md](../RESULT.md) 顶部为准。

## 范围与结论

代码基线 `main / 0e5f615` 加本次收尾修改。真实 Studio、正式 Broker、真实持久化和浏览器；模型 Provider 为受控本地替身。仅本地验证和提交，未 push、部署、调用真实付费模型或媒体 Provider，新增费用 **¥0.00**。

| 检查 | 结论 | 主要证据 |
| --- | --- | --- |
| 任务②：参考报告 AI 修订、主动再审、历史；发布文案再审不换稿 | PASS（确定性） | `tests/vf-20260926-task2-*`；最终全量中的 reference-grammar-agent、node-document-revision、NodeDocumentCommands / NodeWorkspace |
| 任务③：全部候选确定失败时无结论停人；unknown 等不可降级 | PASS（真实 Pipeline＋受控角色输入） | `tests/vf-20260926-task3-{red,targeted}.log`；6 个反例/正例 |
| W3：Studio 停机时原任务完成，重启取回 | PASS（受控浏览器） | `W3-injection.jsonl`、`W3-{before,offline,after-restart}.json`、Provider 计数、`W3-recovered.png` |
| W5：Broker 已受理，但客户端收不到受理/查询回包 | PASS（修后受控浏览器） | `W5-fixed-unknown-detail.json`、透明代理日志、前后快照及截图；回执 completed，重启快照一致 |
| QA③：旧七镜、空返工范围、新五镜候选 | PASS（受控浏览器） | `QA3-source-script.json`、`QA3-run-after.json`、`QA3-review.json`、`QA3-scope-stop.png`；旧稿保留，候选仅提案，未启动媒体 |
| 完整 `npm test` | PASS / exit 0 | `tests/vf-20260926-final-scope-npm-test.log`，包括 typecheck、正式 build、package |
| 真实外部模型、真实视频/TTS/渲染/审片 E2E | NOT_VERIFIED | 本轮未授权调用；不能用替身结果冒充真实成片验收 |
| r13 单列的适配器侧完整回执绑定增强 | 未纳入本轮完成范围（非阻断项） | 当前继续使用装配层宿主注入的绑定；W3/W5 只证明本次创作规划恢复链，不能外推成所有文字适配器的恢复保证 |

## 不调用服务的证据复核

在仓库根目录运行：

```sh
/Users/jinkun.wang/.nvm/versions/node/v22.23.1/bin/node docs/creative-text-review-audit-20260924/qa-20260926/verify-evidence.mjs
```

本轮执行 **exit 0**。脚本只读取归档 JSON，复核 W3/W5 原请求仅一次、旧稿/旧回执/历史前缀不变、审计仅追加一次、W5 unknown 的允许动作、重启快照一致，以及 QA③七镜旧稿/五镜提案/无媒体。它不是重新执行 E2E，也不替代截图和原始故障注入证据。

## 身份与方法

- W3/W5 run：`run-45465ebc-f8be-40ca-ae72-94a75af178c3`。
- W3 command：`fd363fff-a3a7-459d-a1c2-283fa8024865`；request：`agent-d8fa6b6c86946f9b3063238b120984d01f4d2bd5dbb07906b10eb3e8e75c2095`。`stop-on-accept.mjs` 在观察到对应请求已进入运行后核对 PID 并停止 Studio，Provider 随后在 Studio 离线期间返回。重启不重提请求。
- W5 修后 command：`257a059a-1ae7-4ca9-b25c-33c6f2bf85df`；request：`agent-8f341a2a68efaca4273210006089423297f1627074bd8a07e8f8dcaf3ec87b28`。`transport-fault.mjs` 原样转发给正式 Broker，只在真实 202 已发生后丢回包并隐藏该 request 的查询响应；放开后经浏览器“查询原任务→取回结果并继续”。不是 fake broker。
- QA③源：`run-f6b837f1-324f-4d87-aceb-0708ab5c58c4`；返工：`run-e48e740c-6169-4747-bd23-25b622c30e8c`。`prepare-empty-scope.mts` 通过公开 Pipeline/Studio 接口创建去标识化**历史事故样例**，不写 `run.json`。源媒体 worker 在任何物化前拒绝；子样例通过底层入口重现旧版空范围，**不表示当前新建 UI 允许把未物化镜头全部移出范围**。子样例的简报确认、构思确认和失败重试均走浏览器按钮。
- `QA3-run-after.json` 为受控测试 workspace 的原样最终副本，仅用于读证据，不得复制回产品数据。不是用户历史制作，也没有假成片。
- QA 服务使用隔离环境，不读取真实 `.env`；Node HTTP/fetch 有非回环拦截。这不是 OS 级网络隔离，也不声称覆盖 Python；本轮停在文字/范围节点，未走媒体路径。

## 失败试验如实保留

1. `W5-recovered-before-fix.json`：旧实现已取回审计，但命令仍 failed。新增失败测试后按精确 command/action/digest 修复；`receipt-red/green`、`receipt-repeat-red/green`、`receipt-running-red/green` 分别对应终态、二次中断关联、恢复中重启可接管三个窗口。没有回改历史失败回执。
2. `QA3-invalid-fixture.json`：最初替身漏 Broker 必填字段，422 是测试夹具错误，不能算产品范围停点验证。
3. `QA3-product-failure-before.json`：修正夹具后，真实编剧适配层仍把范围冲突当结构错误，自动修复后 failed。`scope-adapter-red/green` 及 `scope-targeted` 证明修复；范围校验移交采用前图层，不删除最终安全校验。
4. 临时升高编剧合同版本曾触发既有线程身份拒收，模型零调用。请求/输出协议没有改变，最终保持原 v20；成功证据对应最终代码。同一 run 仅在有新依据后重试，没有修改历史数据绕过身份守卫。
5. `QA3-provider-after.json` 为**累计**计数：5 次 script-draft 包含 2 次不合法夹具尝试、2 次修复前适配器重试及最终 1 次。不能把累计 5 次声称为最终路径一次调用；最终路径的一产稿、零自动修复/审计同时由真实适配器 Pipeline 测试锁定。
6. 更早的 `W3-inflight.*` 是超时探索，不作为正式 W3 证据，故未归档到此目录。原文件仍在 `output/playwright/creative-review-20260926/`。

## 测试命令与结果

运行环境：Node 22.23.1；仓库 Python `.local/python/.venv/bin` 前置 PATH。最终完整命令为：

```sh
PATH=/Users/jinkun.wang/.nvm/versions/node/v22.23.1/bin:/Users/jinkun.wang/work_space/veidofactory/.local/python/.venv/bin:$PATH npm test
```

完整命令 exit 0：TypeScript **1075 pass / 0 fail / 1 skip**；Broker **265/265**；Studio Vitest **552/552**；Studio node **645/645**；package **4/4**。`npm test` 已包含类型检查和正式构建，但没有执行独立 `pytest`；本轮没有 Python 源码修改。唯一 skip 是既有真实生产成片 E2E，不算通过。构建有大 chunk 提示，不是错误。

聚焦命令（均在仓库根目录、同一 Node 22 环境下；Studio vitest 命令工作目录为 `apps/studio`）：

- `node --test --import tsx apps/studio/test/node-document-revision.test.ts`：10/10，exit 0。
- `npx vitest run test/node-document-commands.test.tsx test/node-content-review.test.tsx test/node-workspace.test.tsx`：59/59，exit 0。
- `node --test --import tsx --test-name-pattern='settled audit candidate exhaustion' packages/production-pipeline/test/production-planning-closure.test.ts`：6/6，exit 0。
- 恢复专项入口 `packages/production-pipeline/test/production-planning-closure.test.ts`、`packages/workflow-core/test/workflow-runner.test.ts`、`apps/studio/test/text-task-production-recovery.test.ts`（`node --test --import tsx`）：当轮138/138，exit 0（完整最终回归又覆盖新增范围两例）。
- 范围聚焦入口 `packages/production-pipeline/test/production-planning-closure.test.ts`、`packages/production-pipeline/test/codex-screenwriter.test.ts`、`apps/studio/test/production-joint-rework.test.ts`（`node --test --import tsx`）：73/73，exit 0。
- `graphify update .`：exit 0（源码最终增量后），7077 节点 / 16775 边；HTML 因大于 5000 节点跳过，代码索引已更新。
- `git diff --check`：exit 0。

红日志是实施前的预期失败证据；它们不代表最终版本仍失败。最终版本以完整 `final-scope-npm-test.log` 及此目录只读复核为准。归档日志和准备脚本仅规范化行尾空白及文件末尾空行，以通过 `git diff --check`；未修改任何消息、计数或结论，原始日志仍保留在 `/tmp/vf-20260926-*.log`。JSON、截图与请求记录保持原字节。

## 明确的局限

- 本轮不宣称全部产品、真实 Provider 或完整视频已通过验收。
- 浏览器在规划尚未建立时有 `creative-review/history` 404，重启中有连接错误；**不声称 console 零错误**。它们未阻断本轮目标，也未为此增加无关整改。
- 手动复制的脚本保留当时的绝对路径，是故障注入方法证据；除 `verify-evidence.mjs` 外，不应不核环境就直接运行。禁止把注入器接到真实付费环境。
