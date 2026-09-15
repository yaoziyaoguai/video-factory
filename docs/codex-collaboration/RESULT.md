# 执行结果与恢复点

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `1`
- status: `READY_FOR_REVIEW`
- 唯一写入者：执行窗口 Codex
- 当前执行模型/思考强度：Codex；宿主未向会话暴露可核对的精确 model id / reasoning effort，故不猜测。
- 开始时间：2026-09-12 17:30:28 +0800
- 完成时间：2026-09-12（Asia/Shanghai）

本任务已停止产品修改和真实 E2E，不 commit、不 push。以下是交给审查窗口的实际状态；`READY_FOR_REVIEW` 不代表验收通过。

## 1. 实际基线与范围

- HEAD `570fe6e59e072c4965c86769bf2096825f003383`；branch `codex/final-dual-review-cloud-acceptance`（开始时 ahead 2）。
- Node `v26.8.1`；npm `11.19.0`；`.venv/bin/python` `3.12.10`。
- 开始时 `BASELINE.json` 314 个文件：SHA256 差异 0、缺失 0；大量原有未提交 A/B/C 修改全部保留，没有 reset/stash/clean。
- 开始时 `git diff --check` exit 0；最终报告写入前再次执行 exit 0。
- 未重新实施 A/B/C，未修改 `TASK.md`，未升级依赖，未读取/输出凭据。

## 2. 实施与关键决定

| 修复组 | 主要文件 | 实际结果 |
| --- | --- | --- |
| 受理互斥、不可变绑定、后台生命周期 | `apps/codex-broker/src/broker-server.ts`、`task-binding.ts`、`task-definitions.ts`、`codex-executor.ts`、`zai-code-plan-executor.ts` 及对应正式测试 | durable task 使用完整 binding；相同物理 ID 并发单执行；完成/未知/not_accepted 分离；完成记录与派生 session registry 分离；后台完成失败不再形成 unhandled rejection；durable store 单 owner 与 shutdown 有正式测试。 |
| Client 原任务观察与恢复 | `packages/production-pipeline/src/codex-chat.ts`、`codex-task-binding.ts`、`fallback-task-client.ts`、`role-agent-loop.ts` 及对应测试 | 丢失 POST/202/完成回包后只查询原任务；accepted/unknown 不换 ID/Provider/backup；完成信封校验 requestId、binding、Provider/model/contract；pending immutable operation 先持久化再 POST。 |
| Topic/script 合同与用户偏好 | Broker task definitions、Studio `topic-ideas-payload.ts`、相关生产者与 cross tests | 正式生产者请求进入 Broker parser 验证；topic 合法偏好完整保留，统一 6000/6001 边界，未知字段拒绝；script planning brief 覆盖真实联合规划字段；descriptor digest 与两端 pin 对齐。 |
| Studio 恢复投影和服务端动作 | `production-studio.ts`、`studio-service.ts`、`run-observability.ts`、shared/client API、`RunWorkbench.tsx` 及测试 | 服务端生成 `taskRecovery/allowedActions`；查询与取回动作不重提原任务；未知任务拒绝普通重试；暂停不被查询解除。真实 E2E 仍发现 running/unknown 页面没有显示 API 已允许的查询动作，列为 FAIL。 |
| Asset-rank 严格合同 | `asset-semantic-ranker.ts` 及 pipeline/Broker 测试 | 内部 `planningIntent` 继续参与 checkpoint 身份，但 Broker 请求只投影 `version/scenes/thumbnails`，修复真实 400。 |
| 图库无实质进展停止循环 | `creative-planning.ts`、Studio observability/service 及测试 | 保存 `availabilityBlockerDigests`；第一次同类阻断可换路线，第二次仍同类则 `needs_source`，不进入第三组 director/search/rank；给出人工上传/实拍、概念表达或停止制作，且不让 AI 图冒充真实实验。 |
| 证据 helper 适配新协议 | `docs/codex-collaboration/evidence/transport-audit.test.mjs` | helper 转发 immutable binding headers，并按 v3 完成状态断言；核心行为断言未反转。初始 0/12，最终 12/12。 |

相对 `BASELINE.json` 的本任务主要变化为上述实现、对应正式测试、本轮 QA 证据和本文件；原有 A/B/C 差异不计作本轮贡献。审查窗口应以 `BASELINE.json` 逐文件 SHA 与当前工作树复核最终精确清单。

## 3. 检查记录

| 检查 | 结果 | 退出码/说明 |
| --- | --- | --- |
| `node --test --import tsx docs/codex-collaboration/evidence/transport-audit.test.mjs` | 12 pass / 0 fail | 0；初始基线为 0 pass / 12 fail。 |
| `npm run test:broker` | 188/188 pass | 0；包含 A01–A12、真实生产者合同、并发 owner、故障矩阵和 asset-rank 边界。 |
| `npm run studio:test` | Vitest 377/377；Node tests 482/482 | 0。 |
| `npm run test:ts` | 766 tests：765 pass / 0 fail / 1 skip | 完整终态无失败；该轮没有单独保存 shell exit marker，因此不把退出码写成已核对。 |
| `npm run typecheck` | 成功 | 0。 |
| `npm run build` | 成功 | 0；只有既有 Vite 500k chunk warning。 |
| `npm run build:pipeline` | 成功 | 0。 |
| `npm run test:package` | 3/3 pass | 0。 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131/131 pass | 0。 |
| `.venv/bin/python -m pytest` | 未运行测试 | 1；环境缺少 pytest：`No module named pytest`，未安装/升级依赖。 |
| `git diff --check` | 无输出 | 0（最终报告写入前）。 |

用户要求立即收口后，执行窗口取消了刚启动的重复 `test:broker` / `test:ts`。取消输出中的 fail/cancel 是 SIGINT 人工中断，不能当作产品回归失败，也不能当作新通过证据；上表引用的是此前完整结束的结果。

## 4. A01–A12 验收映射

| ID | 状态 | 证据 |
| --- | --- | --- |
| A01 | PASS | `task-lifecycle-v3.cross.test.ts` A01/A07；poll completion 保留 output/trace/session。 |
| A02 | PASS | A02；barrier 并发同绑定 executor=1、异绑定 conflict；owner 测试覆盖跨进程。 |
| A03 | PASS | A03；完整 query binding 必需，缺/错 binding 不返回结果。 |
| A04 | PASS | A04 + recovery cross tests；orphan/legacy/unknown 不伪装 running、不重派。 |
| A05 | PASS | A05 + query fault matrix；202 后 reset/ENOENT/ECONNREFUSED/timeout/裸404 不退回 not_accepted。 |
| A06 | PASS | A06；持久化完成失败保持 `completed_failure`，不无限查询/乱切模型。 |
| A07 | PASS | A01/A07；缺派生 session registry 可由 completed evidence 重建，executor 不增加。 |
| A08 | PASS | A08 + fallback/trace tests；rejected/conflict/uncertain 禁止 fallback。 |
| A09 | PASS | A09 + topic/script contract tests；最大合法偏好保留，6001 显式拒绝。 |
| A10 | PASS | A10；丢 POST 回包后查询原任务，POST=1、executor=1。 |
| A11 | PASS | A11 + recovery identity matrix；替换 requestId/digest/Provider/contract 的结果拒绝为 conflict。 |
| A12 | PASS | A12 + durable owner lifecycle；完成落盘/registry/shutdown 故障不崩溃、不伪完成。 |

隔离探针 P01–P12 与 A01–A12 一一对应，最终同样 12/12 pass。

## 5. G01–G08 验收映射

| ID | 状态 | 证据与边界 |
| --- | --- | --- |
| G01 | PASS | 正式 topic/script 生产者进入 Broker parser；正式测试覆盖 treatment/director/role-audit/asset-rank、digest、边界和 receipt。 |
| G02 | PASS | barrier 单 executor、异绑定 conflict、跨进程单 owner、重启不重派均有正式测试。 |
| G03 | PASS | immutable operation 先保存、丢回包/进程重建恢复、原 Provider 固定、计数不旋转；role checkpoint 回归通过。 |
| G04 | PASS | query fault matrix、持久化故障、queue/not_accepted、shutdown deadline 均有任务事实与调用计数断言。 |
| G05 | FAIL | 服务端和组件测试通过，但真实 running/accepted_unknown run 的 API 返回 `query_original_task`，刷新后页面未呈现该面板/按钮；轮次还出现 2/3 → 1/3 倒退。截图 07/08。 |
| G06 | PASS | 正式授权、paid recovery、preflight、asset worker、双审、局部返工回归通过；本轮真实 run 未产生媒体调用。 |
| G07 | NOT_VERIFIED | Node 构建/套件和 Python unittest 通过，但指定的 pytest 因环境缺少模块未执行；`test:ts` 完整终态未单独捕获 shell exit marker。 |
| G08 | NOT_VERIFIED | 正式服务 Provider/model/socket/health 已实测；G05/G07 未全绿，因此没有进入付费安全门。 |

## 6. E01–E07 验收映射

| ID | 状态 | 实际证据/未覆盖 |
| --- | --- | --- |
| E01 | NOT_VERIFIED | 系列 run `run-41860eb5-9898-41f7-986e-88c2236a33a9` 到真实三轮编剧审计后失败；自有概念 run `run-97298ba0-f2ff-4c38-a201-67c447235429` 到真实规划后 unknown；热点只有上一轮 QA03 的真实总编候选证据。本轮三入口均到报价未完成。 |
| E02 | NOT_VERIFIED | 已有 390 暂停与未授权 create=0 证据；未走到真实媒体报价，拒绝追加/调整方案/暂不继续的完整链未覆盖。 |
| E03 | NOT_VERIFIED | 没有制作进入媒体、Tingting、FFmpeg 或成片；Provider 媒体 taskId 无，费用 ¥0.00。 |
| E04 | NOT_VERIFIED | 没有成片 evidence SHA，未进入 GLM/OpenAI 同 SHA 独立双审。 |
| E05 | NOT_VERIFIED | 未进入双审后的用户打回和真实局部返工；只有确定性 affected-set/复用回归。 |
| E06 | NOT_VERIFIED | Studio 重启、刷新、1440/390 和无 console error 已覆盖；概念 run 重启后仍 unknown，API/页面恢复投影不一致；未完成真实 Broker 结果取回。 |
| E07 | NOT_VERIFIED | 无成片，不能评价帧数、时长、同步和质量；真实状态文案已发现长等待、轮次倒退和查询动作不可见问题。 |

## 7. 真实 QA、耗时与费用

完整报告：[videofactory-real-local-qa-20260912-04.md](/Users/jinkun.wang/work_space/veidofactory/docs/qa/videofactory-real-local-qa-20260912-04.md)

- OpenAI Broker PID 41763：`openai` / `gpt-5.6-sol` / `.local/runtime/codex/worker.sock`。
- ZAI Broker PID 41764：`zai-bigmodel-api` / `glm-5.3` / `.local/runtime/zai-codex/worker.sock`。
- Studio PID 90503：`http://127.0.0.1:4317`；health ok，Python/FFmpeg/ffprobe/say 均 true。
- 系列 run 总计 16 分 39 秒；编剧三轮 produce 466237 ms、audit 474343 ms、queue 约 56803 ms。最后因开头未明确“正常联网 vs 飞行模式”失败。
- 旧 run `run-1e12feb7-19e2-4d66-b126-8e3b974c9bd0` 总计约 65 分 49 秒，一次恢复约 15 分 57 秒；旧指纹导致同类来源阻断重复串行 director/rank。
- 概念 run 至少等待约 19 分 20 秒；安全查询仍为 `accepted_unknown`。没有重新提交、没有普通重试。
- OpenAI 单 worker 排队增加耗时；更主要的问题是角色内部多轮、跨阶段恢复和外层重试没有统一机会预算与清晰人工终止状态。

用户产品判断（仅记录，未扩大实现）：

- 以“单个视频 × 单个角色”为粒度，每个角色总共最多 3 次机会：1 次自动创建 + 2 次审计/修订。
- 外层打回同一角色不得新建 checkpoint 后重新获得三次机会。
- 达上限应展示最后独立审计的具体阻断、已保留成果和人工动作，而不是继续重复“候选不足”。
- 当前全局机会预算及交互仍未实现/未验证，应由后续产品设计决定。

费用与外部副作用：

- 媒体授权 0 笔；Provider 媒体 taskId 无；实际媒体费用 ¥0.00。
- 未 commit、未 push、未云端部署、未删除 durable/checkpoint、未修改用户历史数据。

## 8. 截图与重点审查

- `05-manual-gate-no-blind-retry-1440.png`
- `06-series-script-audit-exhausted-1440.png`
- `07-concept-stuck-after-query-1440.png`
- `08-concept-stuck-after-refresh-390.png`
- 目录：`docs/qa/videofactory-real-local-qa-20260912-04-assets/`

审查窗口重点：A01–A12 正式测试映射；G05 API/UI 不一致与轮次倒退；图库同类阻断第二次即 `needs_source`；普通重试不能绕过 `retryable:false`；“单视频 × 单角色总共 3 次机会”仍是未实现产品语义；E01–E07 未覆盖项不得换算成真实成片通过。

执行窗口至此停止。审查结论只由审查窗口写入 `TASK.md`。

---

# Revision 3 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `3`
- status: `READY_FOR_REVIEW`
- 开始时间：2026-09-12（Asia/Shanghai）
- 执行模型/思考强度：当前 Codex 会话；宿主未暴露可核验的精确 model id / reasoning effort，故不猜测。

## R3.1 开始基线

- 实际目录：`/Users/jinkun.wang/work_space/veidofactory`。
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`；branch：`codex/final-dual-review-cloud-acceptance`（ahead 2）。
- 运行时：Node `v26.8.1`、npm `11.19.0`、Python `3.12.10`。
- `git diff --check`：exit 0。
- 对原 `BASELINE.json` 逐文件重算：46 个既有文件哈希已变化、0 个缺失；与 `REVIEW.md` 记录一致。
- 原基线外已有 7 个产品/测试文件，全部保留：`apps/codex-broker/src/task-binding.ts`、`apps/codex-broker/test/durable-owner-lifecycle.cross.test.ts`、`apps/codex-broker/test/fixtures/completion-persistence-failure-child.ts`、`apps/codex-broker/test/fixtures/durable-owner-child.ts`、`apps/codex-broker/test/task-lifecycle-v3.cross.test.ts`、`apps/studio/test/task-recovery-ui.test.tsx`、`packages/production-pipeline/src/codex-task-binding.ts`。
- 46 个当前哈希已在开始时从 `BASELINE.json` 重算并逐文件核对；本轮最终只把实际再次变化的文件列为 revision 3 贡献，不把 revision 1 或 A/B/C 算入。
- 未发现仓库内适用的 `AGENTS.md`；遵循会话提供的工程基线。已读取根 `CONTEXT.md`，未发现本范围 ADR。
- 不 reset/stash/clean，不修改 `TASK.md`，不 commit/push/deploy，不删除或迁移历史 run/checkpoint。

## R3.2 失败基线

命令：`node --test --import tsx docs/codex-collaboration/evidence/r3-review-probes.mjs`

- 结果：0 pass / 3 fail / 0 skipped / 0 cancelled，exit 1。
- R3-UI：running + `taskRecovery` 时服务端允许的“查询原任务”没有渲染。
- R3-OBSERVE：健康 running 任务的短观察期限被错误表述为“连接中断”。
- R3-SEMANTIC：三个明确否定身份连续性的句子都被关键词规则误判为身份要求。

R01–R04、PR01–PR10 的实施、集中验证、真实 QA 与未验证项将在本节继续追加；旧 revision 1 记录保持原样。

## R3.3 本轮实际修改

本轮在 revision 2 的实际进展上继续收口，没有重做 A/B/C。产品代码和测试按共同根因集中修改，主要范围如下：

| 修复组 | 主要实现与测试 | revision 3 结果 |
| --- | --- | --- |
| R01 查询、恢复和当前计划绑定 | `packages/production-pipeline/src/codex-chat.ts`、`codex-task-binding.ts`、`role-agent-loop.ts`；Studio `production-studio.ts`、`studio-service.ts`、`run-observability.ts`、shared/client API、`RunWorkbench.tsx`、`NodeWorkspace.tsx` 及 Broker/Studio/recovery tests | running 页面按服务端动作独立显示“查询原任务”；健康 running 单次查询不再误报连接中断；查询失败保留最近可信事实和观察时间。恢复对象必须同时匹配 run、node、workflow operation、checkpoint、role、phase、generation 和 immutable task binding，不再按 mtime 猜。worker 持有执行权时只允许查询，暂停不因查询解除，两个取回并发只有一次推进，编辑后旧结果晚到不能附到新计划。 |
| R02 自然语言连续性判断 | `visual-evidence-boundary.ts`、`visual-director.ts`、`codex-visual-director.ts` 及 director/pipeline/probe tests | 删除自由文本人物关键词硬拒绝，不增加否定词白名单。机器边界继续检查 delivery、Provider、reuse/reference 引用与证据用途；“叙事是否真实依赖同一主体”由既有独立导演审计判断。否定句可进入审计，真正无能力支撑的身份连续性仍不能进入报价和付费执行。 |
| R03 十类角色提示词和正式输入合同 | `apps/codex-broker/src/task-definitions.ts`、`broker-server.ts`、`codex-executor.ts`、`zai-code-plan-executor.ts`；pipeline 各 `codex-*` 角色、`contracts.ts`、`production-capabilities.ts`、`production-pipeline.ts` 及 cross/role tests | 十类正文、criteria、outputRules、示例和公共前言统一；构思/编剧/导演生成与审计共享同一 `productionCapabilities`，编剧/导演审计读取当前 `creativeTreatment` 和 `planningIssues`。`referenceGrammar` 已接入构思正式类型、白名单、归一化和 digest。Codex/GLM 共用同一正式合同，十类任务都校验 `expectedContractDigest`。 |
| R04 收敛、耗时和进度 | `creative-planning.ts`、`creative-planning-store.ts`、`production-pipeline.ts`、Studio observability/service、`NodeWorkspace.tsx` 及 tests | 图库阻断改为结构化 `reasonCode/narrativeTarget/impactScope/evidence`。同一稳定目标只换措辞、query 或 artifact 且证据未改善时，第二次转 `needs_source` 人工素材门禁；目标不同或证据改善时不误停。checkpoint 保存每个目标的最佳候选证据。角色进度显示角色/阶段/轮次；耗时只展示不重叠的步骤总耗时、排队、Provider 执行和本地处理/候选切换。 |

集中回归首次发现并修复了三处合同升级遗漏：`CodexBridgeClient` 基础夹具补正式 digest 握手，pipeline receipt 的 director/visual-review prompt pack 更新到 `director-v28` / `visual-review-v14`，跨边界测试的 TypeScript 联合类型先经 `unknown` 收窄。它们均由完整门禁重新验证，不是通过降低断言掩盖。

## R3.4 R01–R04 结果

| ID | 状态 | 实际证据与边界 |
| --- | --- | --- |
| R01 | PASS（确定性） | `r3-review-probes.mjs` 的 running UI 与健康 observe 复现由 2 个失败转为通过；Broker recovery cross、`studio-service.test.ts`、`task-recovery-ui.test.tsx`、`node-workspace.test.tsx` 覆盖 running/paused/failed × running/unknown/completed/query-failure、暂停前后完成、并发取回、编辑后旧结果、旧 checkpoint 新 mtime 和 Studio 重建。断言 POST、executor 和实际推进次数。真实浏览器启动时已无 running/unknown run，因此真实按钮点击列 `NOT_VERIFIED`。 |
| R02 | PASS（确定性） | 语义 probe 中 3 个否定句由 3 个误拒绝改为全部允许；正式 director/pipeline tests 覆盖独立生成免责声明、同母片复用、参考图、无效引用和独立审计阻断。真实新模型对自然语言的判断质量没有用替身冒充，列 `NOT_VERIFIED`。 |
| R03 | PASS（合同与控制流） | 正式 adapter 请求捕获通过真实 Broker parser；构思 initial、validation-repair、role-audit 使用同一能力快照，带 `referenceGrammar` 的请求成功解析。角色 tests 验证 scoped revision 保留未受影响字段和上游承诺。没有新增模型调用层、自动 Broker `AGENTS.md`、模型降级或阈值降低。真实新提示词创作样本未新增运行，效果列 `NOT_VERIFIED`。 |
| R04 | PASS（确定性） | tests 覆盖同输入恢复不增加轮数、主动新规划使用新身份、查询不消耗修订轮数、同目标无证据改善止损、不同目标/证据改善继续、角色切换和不重叠耗时口径。没有实现尚未确认的全局终身三次限制；真实整体提速未运行新样本，不能承诺。 |

## R3.5 PR01–PR10 验收映射

| ID | 状态 | 证据 |
| --- | --- | --- |
| PR01 | PASS | 十类 task definition 各只有本角色正文，公共前言在 prompt 组装点只注入一次；tests 检查 directive 不重复公共前言、无 `creatorStrategy` 和旧母片起点绝对禁止，JSON Schema 未放宽。 |
| PR02 | PASS | treatment/script/director producer 与对应 role-audit 捕获到同一 `productionCapabilities`；编剧、导演审计携带当前 `creativeTreatment` / `planningIssues`。 |
| PR03 | PASS | `topic-script-contract.cross.test.ts` 覆盖构思 reference grammar、initial、validation repair、audit；Broker 对能力摘要缺失、错类型、未知字段和 digest mismatch 在 executor 前拒绝。 |
| PR04 | PASS | 明确 20–90 秒范围且参考 30 秒时，60 秒脚本通过；91 秒拒绝；没有 `durationRange` 时保留既有 0.6–1.4 倍兼容边界。 |
| PR05 | PASS | director/visual plan tests 覆盖 `sourceInSeconds`、直接和多级复用、母片最远覆盖、静态非零起点拒绝、无效引用和参考能力边界；没有用字幕掩盖缺失动作。 |
| PR06 | PASS（控制流） | parser 不再按自由文本关键词误杀；不支持的真实连续性在已有独立审计边界阻断。真实模型语义判断质量仍为 `NOT_VERIFIED`。 |
| PR07 | PASS | screenwriter/director scoped repair tests 验证候选合并后未受影响 scenes 和顶层承诺保持；上轮已修复条件不会因无依据偏好被改写；能力摘要缺失不会被模型自行补成支持。 |
| PR08 | PASS（控制流） | visual review tests 覆盖稀疏证据 `not_observed → inspect_existing_media`、pilot 范围、报告审计通过但作品仍不批准；未授权媒体 create=0。没有新的真实成片媒体可用于本轮实审，效果为 `NOT_VERIFIED`。 |
| PR09 | PASS | 全量回归保持事实边界、费用精确授权、无失败说明卡、双审独立/同 evidence SHA、时间轴与局部返工；模型/思考强度/评分门槛未降低，未增加调用层。 |
| PR10 | PASS | 十类 digest、pending immutable operation 和 task binding tests 证明 prompt/digest 改变不会把旧 pending 以新身份重提；旧结果必须匹配原 request、plan、stage、provider/model 和 contract 才可消费。未删除 checkpoint 或用户数据。 |

正式 prompt pack 与 digest 最终同步如下；`task-definitions.test.ts` 验证 descriptor、生产端 pin 与 Broker 端一致：

| task | prompt pack | digest |
| --- | --- | --- |
| `topic-ideas` | `video-factory/topic-editor-v8` | `16df6ddc097508f91530d4df20dc2643bd849bde0971524567a345f0138b5b58` |
| `series-roadmap` | `video-factory/series-showrunner-v2` | `19b961d58dcc4e87dbc7c4e710766b417e57f89f565ad07b776fb54017874b3f` |
| `creative-treatment` | `video-factory/treatment-director-v2` | `4906ed1115d05f8669e5505f6bd75636ab2b218e53523f4245ef92bd8d626ed3` |
| `director-plan` | `video-factory/director-v28` | `67d797e0523860c193e880ddc131650f57b84e39173eb9c632d3179c1b750a80` |
| `script-draft` | `video-factory/screenwriter-v15` | `87954a8443ddb085a8c5c2c01877f1d426086fe79ba3ba4d62484a6484baa0ae` |
| `publish-copy` | `video-factory/publish-editor-v3` | `b2ba3e2c155aefda2dd47213eea13f7260b4580bf13e0a66408621ba2fff15cf` |
| `asset-rank` | `video-factory/asset-rank-v4` | `c52416dc97cbd09ff747fa48f69fe65caa9a4c43fe5f1e3d3325dbb8031d5ba1` |
| `reference-grammar` | `video-factory/reference-grammar-v3` | `49a25cf42265929fa0bc244967acc7f36e53c7de2546957798a6f1631e447ca7` |
| `visual-review` | `video-factory/visual-review-v14` | `3461a6524c9113a7793a91b63a696cd77edf6db369c0078cae996023b9f0b7d2` |
| `role-audit` | `video-factory/role-audit-v4` | `61e2317082d4f84a06e70771bed2f8f132e46944e6d661a2d32ebc835c685795` |

## R3.6 集中验证

以下均在 `/Users/jinkun.wang/work_space/veidofactory`、同一 Node/Python 环境执行。最终成功结果均有完整命令结束和明确退出码；没有安装 pytest。

| 命令 | 最终完整结果 | 退出码 |
| --- | --- | --- |
| `node --test --import tsx docs/codex-collaboration/evidence/r3-review-probes.mjs` | 3 pass / 0 fail | 0 |
| `npm run build:pipeline` | template/core/pipeline TypeScript build 全部完成 | 0 |
| `npm run test:ts` | 768 tests：767 pass / 0 fail / 1 skip；73 suites | 0 |
| `npm run test:broker` | 189 pass / 0 fail；19 suites | 0 |
| `npm run studio:test` | Vitest：18 files、378 pass；Node：482 pass / 0 fail、44 suites | 0 |
| `npm run typecheck` | template/core/pipeline/Studio/Broker 全部通过 | 0 |
| `npm run build` | Broker + Studio production build 成功；仅有 Vite 既有大 chunk warning | 0 |
| `npm run test:package` | 3 pass / 0 fail；2 suites | 0 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，`OK` | 0 |
| `git diff --check` | 无输出 | 0（写入本节前；交付前再执行一次） |

聚焦证据也全部通过：role/treatment/director 87/87、`studio-service.test.ts` 113/113、`node-workspace.test.tsx` 44/44、screenwriter pipeline 19/19。隔离替身只用于故障注入和控制流断言，没有接入正式 Studio，也没有用它证明真实创作质量。

集中回归保留红灯记录：第一次 `npm run test:ts` 为 764 pass / 3 fail / 1 skip，exit 1，暴露一个旧 Broker response fixture 和两个旧 prompt pack receipt；同步后第二次为 766 pass / 1 fail / 1 skip，exit 1，暴露请求键集合缺少 `expectedContractDigest`；第三次最终全绿。第一次 `npm run typecheck` 因 3 个 TS2352 失败，exit 2；收窄跨边界测试类型后 exit 0。

## R3.7 真实本地 E2E、安全与费用

真实操作前核对到旧服务 PID 41763/41764/90503 均来自本仓库，但启动早于本轮构建；OpenAI/ZAI Broker 均 `active=0`、`queued=0`，没有在途任务。随后对这三个已核对进程正常发送 TERM，未删除 durable task/store/checkpoint，使用刚通过构建的正式产物启动：

- OpenAI Broker PID 82880：socket `.local/runtime/codex/worker.sock`，profile/provider `openai`，model `gpt-5.6-sol`，capacity 1，当前 active/queued 0/0。
- ZAI Broker PID 82882：socket `.local/runtime/zai-codex/worker.sock`，profile `zai`、provider `zai-bigmodel-api`，text model `glm-5.3`、visual model `glm-5.3-flash`，capacity 1，当前 active/queued 0/0。
- Studio PID 82884：`http://127.0.0.1:4317`，health `ok`，Python/FFmpeg/ffprobe/say 均 true。
- 两套 Broker 保持原 storeId，health 返回 revision 3 的 prompt digest；没有接 fake Broker，没有展示凭据。

Playwright 使用正式 qa-local 会话并只访问现有 run `run-97298ba0-f2ff-4c38-a201-67c447235429`：

- 1440×1000 与 390×844 页面均可阅读和操作，刷新前后显示明确 `failed / creative-planning`，移动端导航存在。
- 控制台结果：0 errors / 0 warnings。
- 截图：`output/playwright/r3-existing-run-1440.png`、`output/playwright/r3-existing-run-390.png`。
- 该 run 在最新服务下已是失败终态，项目列表“制作中”为 0；因此没有安全的 running/accepted_unknown 样本可点击“查询原任务”。没有为了补这个证据再新建一个可能耗时 16–22 分钟的模型 run。真实查询按钮、暂停后完成、真实结果取回列 `NOT_VERIFIED`，确定性正式测试已通过。

费用与外部副作用：本轮真实 QA 的 Broker completed/failed 均为 0，没有提交模型 task，没有媒体授权、媒体 Provider taskId 或新增付费图片/视频调用，实际新增媒体费用 `¥0.00`。未 commit、push、部署云端、发布内容、删除或迁移用户数据。

E01–E07：

| ID | 状态 | revision 3 实际结论 |
| --- | --- | --- |
| E01 | NOT_VERIFIED | 未重新跑热点/系列/自有想法到真实新提示词规划和报价；沿用历史 run 只能作为旧效果背景。 |
| E02 | NOT_VERIFIED | 暂停、恢复、拒绝报价的确定性测试通过；本轮无真实 running 任务和新报价可安全点击。 |
| E03 | NOT_VERIFIED | 未生成新媒体、配音、渲染或成片。 |
| E04 | NOT_VERIFIED | 没有新成片 evidence SHA，未运行真实 GLM/OpenAI 双审。 |
| E05 | NOT_VERIFIED | 局部返工 affected-set/复用回归通过；没有新的真实双审后人工打回。 |
| E06 | PARTIAL | 正式服务安全重启、同 durable store、刷新、1440/390 和 0 console error 已实测；真实 running 查询与结果取回未覆盖。 |
| E07 | NOT_VERIFIED | 失败状态文字和响应式布局已查看；无新成片，不能评价画面、声音、时长同步和创作质量。 |

## R3.8 长耗时、候选不足与待产品决定

历史 16–22 分钟并非“三轮计数器自己跑了 22 分钟”：系列样本三轮编剧中 produce 约 466237 ms、audit 约 474343 ms、queue 约 56803 ms；OpenAI Broker 单 worker 的排队、多轮高强度 Provider 执行、跨角色回退，以及旧合同矛盾/自然语言误杀造成了无效轮次。旧 UI 还把重叠 producer/audit/validation/tool 时间重复展示，进一步放大了“卡住”的感受。本轮已修正显示口径并消除已确认的空转根因，但没有运行新的真实模型样本，因此不能声称整体耗时已经降到某个数值。

“候选不足”现在不是允许无限换措辞继续跑的理由：系统按稳定叙事目标、影响范围和候选证据判断进展；同一目标第二次仍无证据改善即转人工素材门禁，明确保留现有成果，并让用户补充/实拍素材、改成不依赖该证据的表达，或停止制作。不同目标或证据确有改善时仍可继续，避免把新问题误判成重复。

用户提出的产品方向已记录但未实现：以“单条视频 × 单个角色”为粒度，1 次自动创建 + 2 次审计/修订，外层打回不能重新获得三次，耗尽后展示具体阻断并人工介入。`TASK revision 3` 明确禁止在产品决定未确认前自行加入“终身三次”限制；全局机会预算、什么变更形成新创作身份、人工是否可追加机会仍需产品确认。本轮只保证查询/恢复不消耗轮数、同一无进展来源阻断有界停止。

## R3.9 交付状态

- 完成时间：2026-09-12 23:37:15 +0800。
- revision 3 状态：`READY_FOR_REVIEW`；不代表 `ACCEPTED`。
- `TASK.md` 未修改；全部已有工作树修改已保留。
- 产品修改和真实 E2E 到此停止，等待审查窗口统一检查。

---

# Revision 4 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `4`
- status: `READY_FOR_REVIEW`
- 开始基线：HEAD `570fe6e59e072c4965c86769bf2096825f003383`，branch `codex/final-dual-review-cloud-acceptance`；`evidence/r4-start-baseline.json` 为 322 个文件、0 changed、0 missing。保留全部既有 A/B/C 与 revision 1–3 未提交修改，不 reset/stash/clean。
- 交付口径：`READY_FOR_REVIEW` 只表示本轮实现和确定性验证完成，不代表审查窗口已经 `ACCEPTED`，也不把未获授权的真实成片 E2E 写成完成。

## R4.1 两组根因与最终修正

1. **原任务生命周期（F01/F03/F04）**：`role-agent-loop` 原先先判当前合同能否复用，合同/criteria/checkpoint key 变化会绕开尚未结清的物理 `pendingOperation`；Studio 即使查询到可信 `completed_failure`，正式 pipeline 也没有一条既结清原请求又能按失败分类继续的动作；恢复回执还把可信事实时间和本次查询时间混成一个 `observedAt`。修正后，pending 物理任务优先于合同复用判断，pipeline 会在同一恢复 owner 下寻找旧 pending 文件并沿用其 request/envelope/route/binding；人工恢复把“定位旧 pending 的 owner”和“本次 workflow operation owner”分开，多个匹配 pending 时 fail closed。`completed_failure` 先由正式 role loop 结清，只有 `model_provider_transient` / `model_provider_no_output` 在显式人工动作下新建下一代 request；unknown、conflict、`contract_rejected` 不借机自动换 ID/backup。回执升级为 `video-factory/text-task-recovery-v3`，分开保存 `lastVerifiedAt`、`lastAttemptAt`、`observationError`、`terminalError` 和 `failureKind`；迟到 running 不能覆盖已确认 terminal。
2. **规划止损（F02）**：旧 identity 直接包含导演每轮能改写的 `narrativeTarget` 和位置，同目标仅换 successCriteria/visibleAction/query/artifact 就会多消耗一次 director/rank。修正后 identity 取自已接受 script scene 的稳定目标字段（purpose、narration、visual strategy/prompt、visible action、success/failure conditions），排除 position、duration、search terms 及导演本轮改写；候选数量、锁定数和最佳语义分单独作为进展证据。相同目标无改善第二次即转 `needs_source` 人工门禁；不同已接受目标或仍低于阈值但证据确有改善可以继续，SQLite 重启后累计证据不丢。

集中回归还发现 `apps/studio/test/editorial-decision.test.ts` 不在 `studio:test` 的 Node 文件清单内，其中“如何回应孩子突然发脾气”错误落到人物微纪录。没有加入题材句子特判；只把现有日常词集合收敛成“日常场景 + 方法意图”两个条件，并让动作模板判断和静态新闻排除复用同一判断。该孤儿测试由 14 pass / 1 fail 修为 15/15，四个未被 package script 收录的文件最终 24/24。

## R4.2 相对 revision 4 基线的文件变化

产品代码：

- `packages/production-pipeline/src/role-agent-loop.ts`
- `packages/production-pipeline/src/role-agent-checkpoint.ts`
- `packages/production-pipeline/src/production-pipeline.ts`
- `packages/production-pipeline/src/creative-planning.ts`
- `apps/studio/src/server/production-studio.ts`
- `apps/studio/src/server/editorial-decision.ts`
- `apps/studio/src/shared/api.ts`
- `apps/studio/src/client/components/RunWorkbench.tsx`

测试与执行报告：

- `packages/production-pipeline/test/role-agent-loop.test.ts`
- `packages/production-pipeline/test/creative-planning.test.ts`
- `apps/studio/test/studio-service.test.ts`
- `apps/studio/test/task-recovery-ui.test.tsx`
- 新增 `apps/studio/test/text-task-production-recovery.test.ts`
- `docs/codex-collaboration/RESULT.md`

`TASK.md` 未修改。构建生成的 `dist` 已由正式脚本重建，不计作产品源码贡献。

## R4.3 F01–F04 结果

| 发现 | 状态 | 实际证据 |
| --- | --- | --- |
| F01 合同升级保住未结清原任务 | PASS（确定性） | `role-agent-loop.test.ts` 的 `observes an accepted pending operation before applying a changed role contract`：首次物理 submit=1，恢复新 submit=0，observe 原 request=1。正式集成测试还主动改 checkpoint 文件名、key 和旧 contractDigest；Studio/Pipeline 恢复仍观察同一旧 request，accepted treatment 只执行 1 次。原 `R3-F01` 探针和同合同对照均转绿。 |
| F02 稳定无进展目标身份 | PASS（确定性） | `creative-planning.test.ts`：仅换 query/artifact 与同义改 successCriteria/visibleAction 均在 director=2、rank=2 时 `needs_source`；不同已接受稿件目标允许 director=3；同目标分数 20→30 允许继续，30→30 才停，director/rank=3/3；SQLite 关闭重开仍保留累计证据。最初新增“20→40→40”fixture 红灯是测试错误：40 已等于自动采用阈值，应合法完成；改为仍低于阈值的 20→30→30 后行为测试通过，未改产品门槛。 |
| F03 迟到 completed_failure 可行动恢复 | PASS（确定性） | `text-task-production-recovery.test.ts` 穿过真实 `ProductionStudio → ProductionPipeline → joint-v1 → CodexScreenwriterAgent → role-agent-loop/file checkpoint → CodexBridgeClient parser`。旧 terminal transient request 被观察/结清 1 次，新 script submit=1 且 requestId 不同，role-audit=1，treatment 总计仍 1；两个独立 Studio/Pipeline 实例并发只有一个推进成功。`role-agent-loop.test.ts` 另证实未显式恢复时不创建下一代。F03 窄探针的 action 也转绿，但不以按钮/action 字符串代替上述正式链证据。 |
| F04 可信时间与查询失败分离 | PASS（确定性） | `studio-service.test.ts` 覆盖 running→query failure、首次 query failure、completed→query failure、服务重建、两个 Studio 实例 barrier 下迟到 running；可信时间不刷新、首次失败保持 unknown、terminal 不回退。`task-recovery-ui.test.tsx` 显示“上次确认”“最近查询”“原任务失败原因”。F04 原探针转绿。 |

## R4.4 七组贯通行为证据

| 行为组 | 结果与调用/终态证据 |
| --- | --- |
| 正常运行查询 | PASS。Studio 的 pending/running 查询只观察原任务，不产生 POST、新 generation、phaseAttempts 或质量轮次；UI/API 均由服务端 `allowedActions` 投影。`r3-post-review-service-extra.mjs` 为 GET-only，Broker submit 增量 0。 |
| 查询失败与迟到响应 | PASS。`keeps last verified task time separate...`、`keeps an initial failed observation unknown...`、`preserves a verified completed result...`、`does not let a late running response overwrite...` 四项均通过；刷新/服务重建读取 v3 receipt 结果一致。 |
| 未结清任务遇到新合同 | PASS。role-loop 单测证实合同改变不新 submit；正式集成把 pending 移到不同文件并篡成旧 key/contractDigest，仍按原 binding 查询。多个相同 owner 的旧 pending 不自动挑选；旧结果进入当前流程前仍经过当前 parser/role audit，未把旧结果直接冒充新合同通过。 |
| 迟到成功取回 | PASS。正式 late success：旧 script observe=1，新 script submit=0，role-audit=1，treatment=1；两个独立 Studio/Pipeline 并发恢复只有 1 个 fulfilled 并继续完成后续 workflow，依赖正式 lease/CAS，不依赖单 Studio 内存 Map。 |
| 迟到失败恢复 | PASS。正式 late transient failure：先 observe/结清旧 request=1，再由显式人工 retry 创建新 generation；新 script submit=1、旧 ID 不复用、role-audit=1、treatment=1，并发只推进一次。unknown/conflict/contract rejection 没有自动 backup；非临时失败仍有“调整方案后重新制作”入口。 |
| 暂停/编辑 | PASS（确定性）。`queries an original result while paused without unpausing or allowing retrieval` 保持暂停；`does not attach a late original-task observation after the run revision changes` 拒绝污染新版本；并发 completed-success 只取回一次。没有真实 running 模型任务可做页面点击，列 E06 未验证部分。 |
| 目标与证据变化 | PASS。query/artifact/展示位置及导演同义改写不重置稳定目标；不同已接受稿件目标与同目标真实分数改善分别有独立反例；20→30→30 证明“改善可继续、停滞才人工介入”；SQLite 重启对照通过。 |

## R4.5 A01–A12、G01–G08

| 范围 | 状态 | revision 4 证据 |
| --- | --- | --- |
| A01–A12 | PASS（确定性回归） | `npm run test:broker` 完整 exit 0；正式 parser、binding、owner、故障矩阵、丢回包/落盘/恢复及跨进程测试仍全绿。revision 4 未削弱 Broker 合同。 |
| G01 | PASS | `test:broker`、`test:ts` 和当前两套 Broker health 的 10 类 taskKinds/current contract digests 通过；提示词、输入 schema、Broker 白名单与 digest 沿用 revision 3 同步结果，revision 4 未另改提示词。 |
| G02 | PASS | Broker 全量并发/单 owner 回归 exit 0；正式恢复集成额外用两个独立 Studio/Pipeline 实例争用同一恢复，只有一个推进。 |
| G03 | PASS | 新正式 joint-v1 late success/failure 集成 2/2；原 pending 跨合同、跨 checkpoint 文件、跨 Studio/Pipeline 实例恢复，断言物理提交、观察、上游重跑和最终推进。 |
| G04 | PASS | `test:broker` 完整故障矩阵 exit 0；Studio 时间/迟到响应对照与 revision 4 六个探针均通过。 |
| G05 | PASS（确定性） | Studio 全量、恢复 UI 5/5、Studio recovery/service 120/120、正式集成 2/2；paused/edit/concurrent/API action 与 UI 同口径。真实 running 页面点击仍属 E06 未验证。 |
| G06 | PASS（确定性） | production authorization 37/37；复用/双审聚焦 5/5；未授权、unknown 资金占用、精确报价、REUSE_ONLY 不报价、双审分支持久化、补审 assets/voice/render 增量 0 均通过。Python 成片链 131/131。 |
| G07 | PASS | build、全量 TS/Broker/Studio、类型检查、package entrypoint、Python unittest、release smoke、孤儿测试及 `git diff --check` 均取得明确 exit 0；详见下节。 |
| G08 | PASS（启动安全门） | 重启前核对旧 PID/工作目录/构建时间及两 Broker `active=0/queued=0`；正常停止旧服务，不删 durable 数据；用最终 build 启动正式本地服务并复核身份/health。未获新的真实模型/媒体调用授权，因此没有继续付费 E2E。 |

## R4.6 集中测试、退出码与耗时

所有命令从仓库根运行，恢复 UI 命令例外。Node 环境为 v26.8.1；Python 为项目 `.venv` 的 3.12.10。

| 命令 | 完整终态 | exit | 实际耗时/说明 |
| --- | --- | ---: | --- |
| `npm run build:pipeline` | template/core/pipeline dist 重建成功 | 0 | 约 4.7s；受限沙箱第一次删除 dist 得到 EPERM、exit 1，获准在仓库环境按原命令重跑后成功，EPERM 不计产品失败。 |
| `node --test --import tsx packages/production-pipeline/test/creative-planning.test.ts` | 75 pass / 0 fail | 0 | 约 4.1s。 |
| `node --test --import tsx packages/production-pipeline/test/role-agent-loop.test.ts` | 20 pass / 0 fail | 0 | 约 2.7s。 |
| `node --test --import tsx apps/studio/test/studio-service.test.ts apps/studio/test/text-task-production-recovery.test.ts` | 120 pass / 0 fail（含正式恢复 2/2） | 0 | 约 2.3s；未授权沙箱的 Node 26 native socket assertion 不是断言失败，获准后同命令完整通过。 |
| `../../node_modules/.bin/vitest run test/task-recovery-ui.test.tsx` | 5 pass / 0 fail | 0 | 约 12.7s；主要为 jsdom/Vite environment 8.5s。 |
| `node --test --import tsx docs/codex-collaboration/evidence/r3-post-review-extra.mjs docs/codex-collaboration/evidence/r3-post-review-service-extra.mjs` | 6 pass / 0 fail | 0 | 约 1.6s；F01–F04 与两个对照全绿。 |
| `npm run test:ts` | Node dot reporter 全部完成，无 fail | 0 | 约 51s；耗时来自 core 重建及 packages 全量，不含模型调用。 |
| `npm run test:broker` | Node dot reporter 全部完成，无 fail | 0 | 约 27s；含 pipeline 重建和 Broker 全量。 |
| `npm run studio:test` | Vitest 18 files / 380 pass；后续 Node phase 全部完成，无 fail | 0 | 最终受影响重跑约 31s；使用 dot reporter 压缩 Node 输出，不改变测试选择。 |
| `npm run typecheck` | template/core/pipeline/Studio/Broker 均通过 | 0 | 约 22s。最终 Studio 单独复核 `npm run typecheck --workspace @video-factory/studio` 约 8.3s、exit 0。 |
| `npm run build` | Broker + pipeline + Studio production build 成功 | 0 | 最终状态约 9.5s；Vite 仅报告既有大 chunk warning，无构建失败。 |
| `npm run test:package` | 3 pass / 0 fail | 0 | 约 1.4s。 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，`OK` | 0 | 约 16.9s；未安装 pytest。 |
| production authorization 全文件 | 37 pass / 0 fail | 0 | 约 2.7s。 |
| 复用/报价/双审聚焦 | 5 pass / 0 fail | 0 | 约 2.6s；包含 late branch、局部复用、双审补跑增量 0、精确 paid shots、REUSE_ONLY 不报价。 |
| Studio 四个 package-script 孤儿文件 | 24 pass / 0 fail | 0 | 约 1.8s；含正式恢复 2/2。 |
| 临时 Broker release smoke | health 200，protocol v2、binding v1、10 taskKinds、active/queued 0/0 | 0 | 约 0.9s；只复制正式 build 到临时目录并读 health，未调用模型/外网，临时目录已清理。 |
| `git diff --check` | 无输出 | 0 | RESULT 最终写入后再次执行。 |

采用 dot reporter 是为了避免全量输出截断；退出码由完整进程终态取得。上表的具体行为不靠 dot 数量推断，均由前述命名聚焦测试和正式恢复链的调用计数证明。

## R4.7 真实本地环境、费用与 E01–E07

重启前核对旧服务 PID 82880/82882/82884 均属于本仓库，OpenAI/ZAI Broker active/queued 均 0/0。正常 TERM 旧服务组后，以最后通过的 production build 启动：

- OpenAI Broker PID 29980：`video-factory/codex-bridge-v2`、binding v1、provider `openai`、model `gpt-5.6-sol`、10 类任务，active/queued 0/0。
- ZAI Broker PID 29982：provider `zai-bigmodel-api`，text `glm-5.3`、visual `glm-5.3-flash`、10 类任务，active/queued 0/0。
- Studio PID 29983：`127.0.0.1:4317`，health `ok`，Python/FFmpeg/ffprobe/say 均 true。
- 两个 durable storeId 保持不变；未删除、迁移或清理 checkpoint/operation/user run。没有接 Fake Broker，没有打印凭据。

本轮外部模型提交 0、媒体 create 0、付费授权 0、实际新增媒体费用 `¥0.00`。未 commit、push、云端部署或外发源码。

| ID | 状态 | revision 4 实际结论 |
| --- | --- | --- |
| E01 | NOT_VERIFIED | 未获本轮新增外部模型调用授权，没有重新跑热点/系列/自有想法到真实规划与报价。 |
| E02 | NOT_VERIFIED | 暂停、查询、恢复、报价拒绝有确定性证据；没有真实 running task 或新报价可做页面动作。 |
| E03 | NOT_VERIFIED | 未调用新媒体、TTS 或渲染，没有新成片。 |
| E04 | NOT_VERIFIED | 没有新成片 evidence SHA，未触发真实 OpenAI/GLM 独立双审。 |
| E05 | NOT_VERIFIED | 局部返工/复用增量测试通过，但没有真实双审后人工打回与新返工。 |
| E06 | PARTIAL | 最终 build 的三个正式服务已安全重启并 health 通过；没有真实 running 任务可验证页面查询/取回，未重复上一轮 1440/390 截图。 |
| E07 | NOT_VERIFIED | 状态文字有 UI 测试；无新成片，不能评价画面、声音、时长同步和实际创作质量。 |

若要补齐真实 E01–E07，最小新增范围是一条代表性新视频：真实规划与报价、必要媒体、TTS/渲染、同一 evidence SHA 的 OpenAI+GLM 双审，以及必要的一次局部返工。文本/订阅审片本身不增加现金审批，但媒体图片/视频仍需在当时取得精确报价和当前有效授权；本轮没有报价，因此不能给出可靠金额，也未沿用旧聊天授权。

## R4.8 长耗时与产品待决定

本轮确定性最长单项为 `test:ts` 约 51s，Studio 全量约 31s，主要是 TypeScript/dist 重建、Vite/jsdom 和全量用例；没有模型排队或角色审计。历史真实样本 16–22 分钟的主要来源仍是单 worker 排队、xhigh/max 真实模型 produce/audit、跨角色回退和旧合同空转；revision 4 消除了“合同升级另起请求”“同目标同义改写多跑一轮”和失败死路，但没有新的真实模型样本，不能宣称实际制作已降到具体时长。

用户提出的“单条视频 × 单角色 = 1 次创建 + 2 次审计/修订，耗尽后说明具体问题并人工介入”继续记录为产品待决定，revision 4 没有实现“打回后重新申请三轮”或“终身三次”。当前已确定的止损是：同一素材目标第二次没有证据改善就转人工；角色内部与跨角色仍沿用现有各自上限。若后续决定统一次数，还需明确人工编辑是否形成新创作身份、谁可追加机会以及 UI 如何解释剩余机会。

## R4.9 交付状态

- 完成时间：2026-09-13（Asia/Shanghai）。
- revision 4 状态：`READY_FOR_REVIEW`；不代表 `ACCEPTED`。
- 产品修改到此停止，等待审查窗口统一检查。
- `TASK.md` 未修改；全部已有工作树修改已保留；未 commit、push、deploy、删除或迁移用户数据。

---

# Revision 5 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `5`
- status: `READY_FOR_REVIEW`
- 开始基线：HEAD `570fe6e59e072c4965c86769bf2096825f003383`，branch `codex/final-dual-review-cloud-acceptance`；`evidence/r5-start-baseline.json` 为 323 个文件、0 changed、0 missing。保留全部既有未提交修改，不 reset/stash/clean，不重做 A/B/C。
- 本轮边界：只修 REVIEW_REVISION4 的 R4-F01–R4-F03、正式行为回归与默认测试接线；不改 prompt、模型/思考强度、题材规则或产品机会预算。

## R5.1 根因与最小修正方案（实施前）

1. **恢复授权与验收合同边界（F01/F02）**：节点级 `resumeCompletedFailure` 布尔值没有绑定用户核验的原 pending operation，结清原失败后仍会放行同 phase 的新失败，且可能泄漏到后续 phase/角色；合同变化时 checkpoint 又用当前 `contractDigest` 覆盖整体身份，却保留旧 pending audit，导致旧标准的 pass 可直接认证新标准。最小修正是把人工许可绑定原 pending 的 operation/request identity，结清后持久化消费；后续新失败立即保留成果并停止。pending audit 同时保存其适用合同 identity；旧任务仍先按原 binding 结清，但只有同合同才可复用通过，新 contractVersion/criteria 必须对当前候选发起当前标准 audit，中断恢复仍保留差异。
2. **receipt 提交原子性（F03）**：现有 merge 只在调用方已读到最新 receipt 时成立，`read → merge → rename` 没有共同的跨进程临界区，旧进程可用旧快照覆盖新进程已写入的 terminal；仅含 PID 的临时文件名还会让同进程并发写冲突。最小修正是在网络查询完成后，仅对 receipt 的重读、run revision/task identity 复核、merge 与原子提交使用既有跨进程文件锁；网络等待不持锁。临时文件加入唯一后缀，确保同进程并发安全。

## R5.2 七组行为测试映射（实施前）

| 行为组 | 本轮必须证明的结果 |
| --- | --- |
| produce 失败恢复 | 原失败 observe=1；人工许可只创建 1 个新 request；新 `completed_failure` 后停止并保留进度。 |
| audit 失败恢复 | 当前候选保留；原 audit 失败结清后只允许 1 次新 audit；再次失败停止，不回到 produce。 |
| 后续角色/phase 隔离 | 前一 operation 的人工许可消费后，后续 phase 或角色的新失败不继承许可。 |
| pending audit 合同变化 | 同合同复用旧 audit；contractVersion-only 与 criteria-only 变化均不复用旧 pass，当前标准 audit 失败/中断后可再次恢复且不重跑 producer。 |
| 两个 OS 进程 receipt 竞态 | barrier 固定旧 running 先读、新 terminal 先写、旧写后到；最终文件和响应均保持 terminal，POST=0。 |
| 同进程及查询状态邻接 | 同进程并发无临时文件冲突；terminal→query_failure、旧 running 迟到均不回退可信终态或刷新可信时间。 |
| 暂停、编辑与正式接线 | 查询不解除暂停；编辑/换任务后旧回包不覆盖新 revision/identity；正式 Studio/Pipeline/Broker 可控 executor 真正消费结果并推进；相关测试及 `editorial-decision.test.ts` 纳入默认 `studio:test`。 |

实施、红转绿证据、集中回归、E01–E07 未验证项与最终状态将在本节继续追加。本轮不启动真实付费 QA，不盲目重试。

## R5.3 实际修改与边界

相对 `evidence/r5-start-baseline.json` 的 323 个文件，本轮最终为 8 个已有文件变化、0 个缺失、1 个新增测试文件：

产品代码：

- `packages/production-pipeline/src/role-agent-loop.ts`
- `packages/production-pipeline/src/role-agent-checkpoint.ts`
- `packages/production-pipeline/src/production-pipeline.ts`
- `apps/studio/src/server/production-studio.ts`
- `apps/studio/package.json`

测试：

- `packages/production-pipeline/test/role-agent-loop.test.ts`
- `apps/studio/test/studio-service.test.ts`
- `apps/studio/test/text-task-production-recovery.test.ts`
- 新增 `apps/studio/test/text-task-recovery-receipt.cross.test.ts`

确定性证据脚本同步了新的真实竞态落点：

- `docs/codex-collaboration/evidence/r4-receipt-race.mjs`
- `docs/codex-collaboration/evidence/r4-receipt-child.mjs`

`TASK.md` 未修改；没有重做 A/B/C，也没有修改 prompt、模型、思考强度、题材规则、Graphify 或产品机会预算。

正式恢复接口现传递 `resumeCompletedFailureRequestId`，Studio 从已核验的唯一 pending operation 取得精确原 `requestId`，再经 Studio → Pipeline → file checkpoint → role-loop 传递。旧 `resumeCompletedFailure` 仅保留为 deprecated 的测试兼容入口，正式 Studio/Pipeline 产品链没有使用。许可只匹配该原物理请求：结清后新 generation 再次失败会保存进度并停止，后续 phase/角色无法继承。

pending operation 现持久化提交时的 `contractDigest`。旧 audit 仍按原不可变 request/envelope/route/binding 结清；若其合同与当前 `contractVersion`/criteria 不同，旧 verdict 不认证当前标准，保留 producer 候选、清理旧 audit session、迁移当前 checkpoint 后提交当前合同的独立 audit。同合同 pending audit 不额外重审。

receipt 提交使用 `proper-lockfile` 的跨进程短临界区。模型任务网络查询发生在锁外；锁内重新读取最新 run 和 pending identity、重新读取 receipt、merge 并原子提交。临时文件名加入 `randomUUID()`，避免同进程并发冲突。terminal receipt 不会被迟到 running/query failure 覆盖。

## R5.4 R4-F01–R4-F03 红转绿证据

| 发现 | 最终状态 | 确定性证据 |
| --- | --- | --- |
| R4-F01 一次人工恢复持续放行 | PASS | `r4-boundary-probes.mjs`：自动恢复旧失败 observe=1、新 submit=0；一次人工恢复 observe=1、新 submit=1，随后新失败立即停止。`role-agent-loop.test.ts` 分别覆盖 produce 与 audit 的“原失败→人工恢复→新失败”，并覆盖 produce 许可不泄漏 audit、前一角色许可不泄漏后续角色。 |
| R4-F02 旧 audit 认证新合同 | PASS | 同合同对照：旧 audit observe=1、新 audit=0、producer=1；合同变化：旧 audit observe=1、新 audit=1、producer=1。role-loop 另覆盖 contractVersion-only、criteria-only、当前新 audit 再次中断后恢复，producer 始终不重跑。 |
| R4-F03 receipt 跨进程回退 | PASS | 两个 OS 进程的 barrier 探针最终 `terminal=completed_failure`、`stale=completed_failure`、`persistedState=completed_failure`、`posts=0`。barrier 位于旧 running 网络响应返回前，仍确定性保证旧结果晚到，又不把文件互斥本身锁死。 |

正式集成不再覆写 `runTaskDetailed` 手工制造 accepted。`text-task-production-recovery.test.ts` 实际穿过 `ProductionStudio → ProductionPipeline → CodexScreenwriterAgent/role adapter → role-loop/file checkpoint → CodexBridgeClient → CodexBrokerServer parser/durable store → controllable executor`；可控 executor 是唯一模型替身，treatment/director/媒体仍按测试边界替代，不能据此声称真实模型创作质量已验证。该链证明迟到 success 被正式工作流消费并推进；迟到 transient failure 先结清旧请求、只创建一个新 script request；role audit 实际执行；已接受 treatment 不重跑；两个独立 Studio/Pipeline 实例只有一个取得 lease/CAS 并推进；Studio、Pipeline、checkpoint 收到同一个被核验原 requestId。

## R5.5 七组行为结果

| 行为组 | 结果 |
| --- | --- |
| produce 失败恢复 | PASS。原失败只 observe 1 次；一次人工动作只创建 1 个新 request；新 `completed_failure` 后停止，质量轮次和已有进度保留。 |
| audit 失败恢复 | PASS。producer 候选保留；原 audit 结清后只允许 1 个新 audit；再次失败停止，不回到 produce。 |
| 后续角色/phase 隔离 | PASS。精确 requestId 许可不会命中新的 audit request，也不会命中后一角色 request。 |
| pending audit 合同变化 | PASS。同合同直接复用；contractVersion-only、criteria-only 均先结清旧 audit 再按当前标准重审；当前 audit 中断后恢复不丢合同差异且 producer 不重跑。 |
| 两个 OS 进程 receipt 竞态 | PASS。旧 running 回包晚于新 terminal 提交时，两个响应与最终文件都保持 `completed_failure`，POST=0。 |
| 同进程及查询状态邻接 | PASS。同进程并发原子临时文件不冲突；terminal→query failure 和迟到 running 不回退可信终态、不刷新 `lastVerifiedAt`。 |
| 暂停、编辑与正式接线 | PASS（确定性）。查询不解除暂停；run revision/pending identity 变化时旧回包不能提交；正式 Studio/Pipeline/Broker 可控 executor 真正消费结果并推进。`editorial-decision.test.ts`、正式恢复测试与跨进程 receipt 测试均进入默认 `studio:test`。 |

## R5.6 聚焦与集中回归

所有命令从仓库根运行，UI 命令例外。Node v26.8.1；Python 使用项目 `.venv` 3.12.10。本轮没有通过延长超时、降低模型/质量门槛或修改断言凑绿。

| 命令 | 完整终态 | exit / 说明 |
| --- | --- | --- |
| `node --test --import tsx docs/codex-collaboration/evidence/r4-boundary-probes.mjs` | 4 pass / 0 fail | 0 |
| `node --test --import tsx docs/codex-collaboration/evidence/r4-receipt-race.mjs` | 1 pass / 0 fail；两个 OS 进程，约 3.17s | 0 |
| 核心聚焦：两个 revision 3 补充探针、正式恢复、role-loop、creative-planning、Studio service | 227 pass / 0 fail | 0 |
| Studio 聚焦：editorial decision、service、正式恢复、跨进程 receipt | 136 pass / 0 fail | 0 |
| Broker 生命周期/owner/正式 topic-script parser + production authorization | 61 pass / 0 fail | 0 |
| Studio UI：task recovery、node workspace、run observability | 67 pass / 0 fail | 0 |
| `npm run build:pipeline` | template/core/pipeline dist 重建成功 | 0 |
| `npm run test:ts` | 778 pass / 0 fail / 1 skip，约 29s | 0 |
| `npm run test:broker` | 189 pass / 0 fail，约 27s | 0 |
| `npm run studio:test` | Vitest 380/380；Node 505/505 | 0 |
| `npm run typecheck` | template/core/pipeline/Studio/Broker 均通过 | 0 |
| `npm run build` | production build 成功；仅既有 Vite 大 chunk warning | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，`OK` | 0 |
| 临时 Broker release smoke | health 200；protocol v2、provider openai、model release-smoke、active/queued 0/0 | 0；受控 health-only executor，无模型/外网调用，临时目录已清理 |

集中回归保留真实红灯记录：第一次 `npm run typecheck` 因新增正式集成测试直接访问 `unknown payload` 报 TS18046；收窄测试类型后完整复跑 exit 0。交付前合并复核命令中，30 个角色/边界断言已通过，但受限执行环境触发 Node 26 `InternalCallbackScope::Close` native socket assertion，组合命令 exit 1；没有把它记成通过。随后在正常本地权限下单独复跑同一个两进程 receipt 探针为 1/1、exit 0，上述 terminal/POST 证据明确。最终 role-loop 单文件与 `git diff --check` 另行取得独立 exit 0。

## R5.7 G03/G05 收窄与未验证 E01–E07

- G03：PASS（确定性正式组件集成），证明 Studio/Pipeline/真实 role adapter/file checkpoint/Broker parser/durable store 对可控模型 executor 的结果能消费、恢复和推进；不是实际 OpenAI/GLM 调用，也不证明真实创作质量。
- G05：PASS（确定性 UI/API/状态回归），证明 allowed actions、暂停、编辑版本隔离、恢复推进和默认测试接线；本轮没有真实 running 模型任务的页面点击证据。

| ID | 状态 | revision 5 实际结论 |
| --- | --- | --- |
| E01 | NOT_VERIFIED | 本轮按要求未启动真实付费 QA，没有重跑三个入口到真实模型方案/报价。 |
| E02 | NOT_VERIFIED | 暂停、查询、恢复和报价动作仅有确定性回归；没有新的真实 running task/报价交互。 |
| E03 | NOT_VERIFIED | 未调用新媒体、TTS 或渲染，没有新成片。 |
| E04 | NOT_VERIFIED | 没有新 evidence SHA，未触发真实 OpenAI/GLM 独立双审。 |
| E05 | NOT_VERIFIED | 复用/局部返工确定性回归通过；没有真实双审后的人工打回与返工。 |
| E06 | NOT_VERIFIED | 本轮未启动、停止或重启真实服务，也未用真实 running 任务验证页面取回。 |
| E07 | NOT_VERIFIED | 无新成片，不能评价画面、声音、时长同步或实际创作质量。 |

本轮外部模型提交 0、媒体 create 0、新增付费调用 0、实际新增费用 `¥0.00`。没有启动/重启真实服务，没有操作 durable/checkpoint/用户数据，没有 commit、push、deploy 或外发源码。修复经审查窗口确认后，真实本地 E2E 才按 TASK/REVIEW 的三入口、一个代表性完整成片、真实双审、一次局部返工及费用止损范围执行；同根因只有在前置条件或新证据变化时才恢复一次，不盲目新建 run 或重复付费。

## R5.8 耗时与待产品决定

本轮确定性较长项为 `test:ts` 约 29s、`test:broker` 约 27s、Studio 全量测试；来源是 TypeScript/dist 重建、跨进程生命周期、Vite/jsdom 与全量用例，不含模型排队或角色审计。两进程 receipt 探针正常本地约 3.17s。受限环境的 Node native assertion 及复跑原因已在 R5.6 单独记录，不能算产品耗时改善或模型失败。

历史真实模型 16–22 分钟的排队/produce/audit/校验/重试拆分仍沿用 revision 3/4 记录；本轮没有真实模型样本，不能声称总耗时已降低到某个数值。用户提出的“单条视频 × 单角色 = 1 次创建 + 2 次审计/修订，耗尽后说明具体阻断并人工介入”继续作为产品待决定，本轮没有自行实施“终身三次”。本次只修复一次人工恢复不会持续放行基础设施失败。

## R5.9 交付状态

- 完成时间：2026-09-13 01:54:37 +0800。
- revision 5 状态：`READY_FOR_REVIEW`；不代表 `ACCEPTED`。
- 三个已复现边界、相关正式行为测试与默认测试接线已完成；产品修改到此停止，等待审查窗口统一确认。
- `TASK.md` 未修改；全部既有工作树修改已保留；未启动真实付费 QA，未 commit、push、deploy、删除或迁移数据。

---

# Revision 6 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `6`
- status: `READY_FOR_REVIEW`
- 开始基线：HEAD `570fe6e59e072c4965c86769bf2096825f003383`，branch `codex/final-dual-review-cloud-acceptance`；`evidence/r6-start-baseline.json` 为 324 个文件。保留全部既有 dirty changes，不 reset/stash/clean，不重做 A/B/C。

## R6.1 唯一根因与最小修正

原样运行 `node --test --import tsx docs/codex-collaboration/evidence/r5-combined-audit.mjs` 得到 0 pass / 1 fail、exit 1：producer=1、旧 audit observe=1、当前合同 audit=2，断言期望 1。根因是外层在 `executeOperation` 之前捕获旧 pending audit 的 `contractDigest`，而 `executeOperation` 可在同一次调用中结清旧失败、切到下一 generation 并返回当前合同的新结果；外层仍以旧快照判断，误丢弃已经通过的新 audit。

最小修正：让 `executeOperation` 随返回结果携带真正产生该结果的 operation 身份/合同；外层只在返回结果本身属于旧合同时丢弃并重审。保持同合同旧成功直接复用、旧合同旧成功按新标准重审、旧失败人工恢复后新失败立即停止、unknown/conflict 不换 ID、producer 不重跑。正式测试加入 contractVersion-only、criteria-only、当前 pass 一次、当前失败停止、当前中断恢复及既有权限隔离对照。

确定性修复验证通过后才进入真实本地部署与 `qa-only` 报告模式；QA 中发现的问题只记录证据，不边测边改。

## R6.2 实际代码修改与红转绿

本轮产品实现只修改：

- `packages/production-pipeline/src/role-agent-loop.ts`
- `packages/production-pipeline/test/role-agent-loop.test.ts`

`executeOperation` 现在随结果返回实际产生该结果的 operation `contractDigest`；外层按这份结果身份决定是否需要以当前合同重审，不再使用执行前捕获的旧 pending digest。没有改 prompt、模型/思考强度、素材质量门、题材规则、费用上限或产品机会预算。

| 场景 | 原始红灯 | 修复后证据 |
| --- | --- | --- |
| 旧 audit transient failure，同一次恢复返回当前合同 pass | producer=1、旧 observe=1、当前 audits=2，`r5-combined-audit.mjs` exit 1 | producer=1、旧 observe=1、当前 audits=1，exit 0 |
| contractVersion-only | 旧结果身份可使当前 pass 再审一次 | 当前标准 audit 只执行一次；producer 不重跑 |
| criteria-only | 同上 | 当前标准 audit 只执行一次；producer 不重跑 |
| 当前新 audit 再失败 | 可能继续消耗 | 立即停止并保留候选，不回到 producer |
| 当前新 audit 中断后恢复 | 需证明只观察当前请求 | 恢复沿用当前 audit request，不重跑 producer |
| 精确人工许可隔离 | 需防止泄漏到新 request/后续 phase | 许可只结清原失败；新失败与后续角色不继承 |

聚焦组合探针与 role-loop 共 31/31、exit 0；最终恢复边界聚焦 39/39、exit 0。测试加入正式 role-loop 文件，未弱化原断言。

## R6.3 集中确定性回归

Node v26.8.1；Python 文件未改，按 TASK 引用 revision 5 的正式 unittest 131/131、exit 0。没有安装 pytest，没有通过加超时、降模型/强度或修改断言凑绿。

| 命令/检查 | 完整终态 | exit |
| --- | --- | ---: |
| 组合探针 + `role-agent-loop.test.ts` | 31 pass / 0 fail | 0 |
| 最终恢复边界聚焦 | 39 pass / 0 fail | 0 |
| `npm run test:ts` | 782 pass / 0 fail / 1 skip | 0 |
| `npm run test:broker` | 189 pass / 0 fail | 0 |
| `npm run studio:test` | Vitest 380/380；Node 505/505 | 0 |
| `npm run typecheck` | 全 workspace 通过 | 0 |
| `npm run build` | production build 成功；仅既有 Vite chunk warning | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |
| `git diff --check` | 无 whitespace error | 0 |

`npm run build` 已重建 Broker、pipeline 与 Studio 正式产物；没有单独重复运行 `npm run build:pipeline`，不将未单独取得的退出码伪报为独立证据。Python/媒体实现未变，本轮引用 revision 5 的 131/131 成片链回归。

## R6.4 正式本地部署与新发现

初始安全检查确认旧服务来自本仓库且早于最终 build，两个 Broker `active=0/queued=0`，随后正常 TERM；没有删除 durable/checkpoint/历史 run。最终 build 启动的 Broker 为：

- OpenAI Broker PID 42143：provider `openai`，model `gpt-5.6-sol`，effort/auditEffort `xhigh/xhigh`，socket `.local/runtime/codex/worker.sock`，storeId `vfs_store_9b7afe63713f2bebffbd7dc97c677bc9`。
- ZAI Broker PID 42144：provider `zai-bigmodel-api`，text `glm-5.3`（max），visual/asset/reference `glm-5.3-flash`，socket `.local/runtime/zai-codex/worker.sock`，storeId `vfs_store_e4d1561b08220ce917bf084b6de43f43`。
- 初始 Studio PID 42146 运行 production dist、health ok，但手工启动漏传两个 socket。该失败先写入 QA 报告；确认两个 Broker仍 `active=0/queued=0` 后正常 TERM，按正式启动脚本补齐两个 socket，最终 Studio PID 59645，`http://127.0.0.1:4317`，Python/FFmpeg/ffprobe/say 全 true。登录会话、历史 run 与媒体在重启后继续可读。

有目的恢复后发现新的正式运行阻断 `QA-R6-01`：两个 Broker `/health` 的 `taskKinds` 声明 10 类，但 `taskContracts` 只发布 5 类；pipeline/Studio 正式 parser 要求所有声明支持的受保护任务 digest，因此 `/api/providers` 正确 fail-closed 为 `protocol_mismatch`。源码和 dist 中 `apps/codex-broker/src/broker-server.ts` 的 health 白名单均只含 `visual-review`、`role-audit`、`creative-treatment`、`topic-ideas`、`script-draft`，缺 `series-roadmap`、`director-plan`、`publish-copy`、`asset-rank`、`reference-grammar`。

这不是 socket、权限、缓存、凭据或旧 build：两个 socket health 均 200，最终 Studio 已准确连接，三份 dist 时间均为本轮 07:52 构建，页面刷新与 Studio 重启后结果一致。按照“QA 中不边测边改”和同根因不盲重试，本轮没有再修改 Broker 产品代码或创建模型 run，留给审查窗口集中安排。

## R6.5 真实本地 QA（`qa-only` + `browse`）

详细报告：`docs/qa/videofactory-real-local-qa-20260913-05.md`；截图目录：`docs/qa/videofactory-real-local-qa-20260913-05-assets/`。

| ID | 状态 | revision 6 实际证据 |
| --- | --- | --- |
| E01 | BLOCKED | 三入口均真实进入。热点候选明确“待补来源 · 当前不可开工”，未刷新同一失败题目；系列本集可选但“新建制作”禁用并提供“查看缺失能力”；自有想法表单可打开但因已知合同阻断未保存机会。正式规划/方案/报价未到达。 |
| E02 | BLOCKED | 没有合法的新规划 run，不能硬改状态或拿历史只读 run 冒充。方案修改、报价三动作、暂停/显式恢复未做；媒体 create=0。 |
| E03 | BLOCKED | 未到报价/授权，Provider taskId=无，未生成新媒体/TTS/渲染/成片；实际新增费用 ¥0.00。 |
| E04 | BLOCKED | Studio 因正式 Broker health 合同不完整拒绝两个模型；没有本轮 evidence SHA 或两份独立审片。 |
| E05 | BLOCKED | 没有本轮真实审片建议可触发必要局部返工；未人工制造缺陷、未扩大到全片重买。 |
| E06 | BLOCKED（独立部分通过） | 1440/390、导航、制作记录/全局搜索、素材按作品/筛选空状态、设置、浏览器刷新、Studio 重启持久化均实测；本人 QA 模板 POST 201→PUT 200→DELETE 200 并清理，console 0 error。新 run 暂停/恢复被同一阻断覆盖，故整体不记 PASS。 |
| E07 | BLOCKED | 新成片未生成。只读历史成片实际加载为 1080×1920、21s，配音 24.02322s；0.5/6.5/12.5/18.5s 四段画面与“不通过、双审 0/2”记录一致。该历史证据不冒充本轮质量通过，执行窗口无法实际听见扬声器输出，声音/同步仍 NOT_VERIFIED。 |

本轮 QA 新增媒体/TTS 支出 `¥0.00`，¥50 止损线占用 0；OpenAI/ZAI Broker counters 始终 completed=0、failed=0、active=0、queued=0。没有 accepted/unknown 任务，未换 ID、backup 或重复提交。可独立页面请求约 0.3–2.6s，没有新的长模型任务；因此无法提供 produce/audit 分段耗时，也不虚构网络归因。

## R6.6 验收边界、未验证项与产品记录

- R5-F01 唯一重复审计问题：`FIX_VERIFIED`（确定性正式测试）。
- A01–A12、G02–G07 的相关确定性回归继续通过；G08 的“最终 build 启动真实 Broker/Studio”已执行，但正式 Broker health 合同不完整使真实模型能力门禁失败，故真实运行门不记 PASS。
- `QA-R6-01` 是本轮 E2E 才暴露的独立 P1：应让 Broker health 的 `taskContracts` 与它声明的 10 个 taskKinds 和 `REQUIRED_CODEX_TASK_CONTRACT_DIGESTS` 同步；修复后先做 health parser 聚焦测试，再部署并只恢复一次 E01。
- 未验证：三入口真实规划/方案/报价；报价三动作；新 run 暂停/显式恢复；真实媒体/TTS/渲染；双真实模型同 evidence SHA；必要局部返工与复用；实际听声和新成片同步。没有实际走通的部分均未写 PASS。
- 用户提出的“单条视频 × 单角色 1 次创建 + 2 次审计/修订，耗尽后解释具体问题并人工介入”继续作为产品待决定；本轮没有加入终身三次限制。热点来源不足的现有 UI 已正确转人工补来源，不用说明卡或生成画面伪成功。
- 未修改 `TASK.md`，未 commit、push、云端部署、发布视频、删除或迁移用户数据，未读取或输出凭据。

## R6.7 交付状态

- 完成时间：2026-09-13（Asia/Shanghai）。
- revision 6 状态：`READY_FOR_REVIEW`；只表示本轮指定修复、集中回归和有界真实 QA 已完成并如实记录，不代表 `ACCEPTED` 或真实 E2E 全通过。
- 产品修改和 QA 到此停止；保留当前正式本地服务与全部已有修改，等待审查窗口统一检查。

---

# Revision 7 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `7`
- status: `READY_FOR_REVIEW`
- 开始基线：2026-09-13 09:14:55 +0800，HEAD `570fe6e59e072c4965c86769bf2096825f003383`，branch `codex/final-dual-review-cloud-acceptance`；`evidence/r7-start-baseline.json` 固化与 revision 6 相同的 324 个产品/测试/配置路径，开始时相对 r6 仅 `role-agent-loop.ts` 及其测试已有变化。全部既有 dirty changes 保留，没有 reset/stash/clean，没有重做 A/B/C 或已通过的重复审计修复。

## R7.1 四类根因与正式组合红灯

先按 `REVIEW_REVISION6.md` 原样运行 source/dist 正式组合探针：两次均为 15 tests、5 pass / 10 fail、exit 1。失败不是十个新需求，而是四个真实 producer-consumer 边界没有闭合：

1. `F01`：Broker health 另维护五项合同白名单，虽然 `taskKinds` 声明十类，但正式 Studio consumer 只能看到五个 digest，默认 profile fail-closed。
2. `F02`：publish-copy 把本次 platform 输入混入 canonical descriptor；客户端按静态 digest 受理，executor 按平台重算，合法成功结果被自己的合同核验拒绝。
3. `F03`：ZAI health/binding 按 task kind 静态选模型，实际执行按是否带图片选模型，持久化 binding 与成功 trace 的物理 modelId 可以不一致且此前仍被接受。
4. `F04`：role-loop 已有 checkpoint 恢复协议，但 asset-rank、reference-grammar、visual-review、series generate/reviewEpisode 的正式适配器没有把 `beforeSubmit` 传给实际 client，也没有消费 `preparedOperation`，因此恢复快照缺原请求 envelope/binding/route。

组合矩阵以十类 task 的 producer、canonical descriptor、health、模型路由、produce/audit 恢复接线和正式测试为边界；共享错误只做边界复用，四个漏接适配器分别保留真实接线行为证据。没有把 FakePipeline 收到调用、按钮出现或测试数量当成正式工作流消费结果的证明。

## R7.2 实际修复与文件范围

- `F01`：Broker 从正式 `BROKER_TASK_KINDS` 与 executor `taskKinds` 的交集发布 health contracts。默认 OpenAI/ZAI profile 发布全部十类；合法子集只发布实际支持项；缺失或错误 digest 仍被正式 Studio consumer 拒绝。
- `F02`：`contractDigest` 固定为任务类型静态合同，覆盖 publish-copy 通用规则、完整平台规则表、默认规则、schema 和语义版本；单次 platform 只留在 payload/requestDigest 和实际 prompt。新 canonical pin：`db27873c44bb30623d5fceb6e5d3811912b32aeea3762fc7d18f3cb9cd58e9bd`。五个平台和未知平台仍产生各自提示，平台规则变更会改变 canonical digest，平台输入改变只改变 requestDigest。
- `F03`：为 mixed-model task 增加声明式 input route，在受理前由实际输入确定物理 modelId，并写入现有 immutable binding；Broker、client、executor 和成功 trace 使用同一身份。成功 trace 的 provider/model/kind 与 binding 不一致时 fail-closed，不自动换 requestId 或 backup。
- `F04`：新增统一的 `role-agent-checkpoint.ts` 接线 helper，四个正式模块在 POST 前保存 prepared operation，保存失败时 POST=0；恢复时只观察原 request，迟到 success/failure 由正式 role-loop 消费，producer/audit 分支隔离。视觉单分支补审不新增 media/voice/render。

相对 `r7-start-baseline.json` 实际变化 23 个产品/测试文件：

- Broker：`broker-server.ts`、`codex-executor.ts`、`task-definitions.ts`、`zai-code-plan-executor.ts`；以及 `broker-server.test.ts`、`codex-bridge-recovery.cross.test.ts`、`task-definitions.test.ts`、`zai-code-plan-executor.test.ts`。
- Studio：`codex-provider-settings.ts`、`series-planning-agent.ts`；以及两份对应测试。
- Production Pipeline：`asset-semantic-ranker.ts`、`codex-chat.ts`、`codex-task-binding.ts`、`codex-visual-review.ts`、`index.ts`、`reference-grammar.ts`、`role-agent-checkpoint.ts`；以及 asset-rank、chat、visual-review、reference-grammar 四份正式测试。

没有修改 Python/媒体实现、数据库、旧 durable 数据、模型/思考强度或质量门槛，也没有加入“单视频每角色终身三次”限制。

## R7.3 V7-01–V7-07 结果

| ID | 状态 | revision 7 实际证据 |
| --- | --- | --- |
| V7-01 | PASS | 真实 `CodexBrokerServer` + Unix socket + 正式 Studio consumer 覆盖全十类和合法子集；缺失/错误合同保持拒绝。最终两个真实 socket 均为 10 kinds / 10 contracts，Studio consumer `available=true`。 |
| V7-02 | PASS | publish-copy canonical digest 与 platform payload 分离；五个平台 + 未知平台、初始/修订、正确完成/重放、错 digest 拒绝均覆盖。OpenAI/ZAI 两个实际 executor 的外部传输替身各只执行一次并正常完成。 |
| V7-03 | PASS | role-audit 有/无图、asset-rank 有/无缩略图、视觉/参考任务及自定义模型名覆盖；受理 binding、durable、实际 transport/trace 一致，错 provider/model/kind 拒收且调用数不增加。 |
| V7-04 | PASS | asset-rank、reference-grammar、visual-review、series generate/reviewEpisode 的 produce/audit 均从正式适配器进入 checkpoint/role-loop；覆盖 POST 前快照、保存失败 POST=0、迟到成功/失败、client rebuild 后只查原请求、上游不重跑和视觉单分支补审安全。 |
| V7-05 | PASS | 四模块正式恢复 52/52；原恢复/审计边界 39/39；Broker 192/192；全仓 TypeScript/Studio 回归全绿。重复审计修复没有重做或回退。 |
| V7-06 | PASS | 最终 `npm run build` exit 0；source/final dist 正式消费者组合均 15/15。真实 OpenAI/ZAI socket 各发布十类合同，十个关键 Studio 角色 ready，Python/FFmpeg/ffprobe/say 可用。 |
| V7-07 | PARTIAL / BLOCKED | 已按 `qa-only` + `browse` 完成有界真本地覆盖，详见 `docs/qa/videofactory-real-local-qa-20260913-06.md`。自有想法被新的 task 边界问题阻断；系列构思通过但编剧三轮不通过；热点无有效来源。E03–E05/E07 无新成片，明确 NOT_VERIFIED。 |

## R7.4 集中确定性回归

Node v26.8.1。Python/媒体文件本轮未改，按 TASK 引用 revision 5 已执行的正式 unittest 131/131、exit 0；本轮没有安装 pytest。没有通过加超时、降模型/强度、删失败场景或改断言凑绿。

| 命令/检查 | 完整终态 | exit |
| --- | --- | ---: |
| source 正式组合修复前探针 | 15 tests，5 pass / 10 fail | 1 |
| final dist 正式组合修复前探针 | 15 tests，5 pass / 10 fail | 1 |
| 四模块正式恢复聚焦 | 52 pass / 0 fail | 0 |
| Broker 聚焦/全量 | 192 pass / 0 fail | 0 |
| TASK 规定恢复/审计集中门 | 39 pass / 0 fail | 0 |
| `npm run test:ts` | 788 tests，787 pass / 0 fail / 1 skip | 0 |
| `npm run studio:test` | Vitest 380/380；Node 507/507 | 0 |
| `npm run typecheck` | 全 workspace 通过 | 0 |
| `npm run build` | Broker、pipeline、Studio production build 成功；仅既有 Vite chunk warning | 0 |
| source `r6-contract-boundary-review.mjs` | 15 pass / 0 fail | 0 |
| final dist `VF_REVIEW_DIST=1 r6-contract-boundary-review.mjs` | 15 pass / 0 fail | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |

`npm run build` 已包含 pipeline 构建，没有把重复 build 当成额外证据。确定性测试使用可控 executor/transport，只证明正式边界、恢复和结果消费，不冒充真实模型创作质量。

## R7.5 最终本地部署与 readiness

确定性门全过后才替换真实本地服务。旧服务先确认两个 Broker `active=0/queued=0`、Studio 无 executing run，再以 TERM 正常退出；durable/checkpoint/workspace/登录和历史 run 全部保留。

- OpenAI Broker PID 5993：production `apps/codex-broker/dist/main.js`，socket `.local/runtime/codex/worker.sock`，provider/model `openai/gpt-5.6-sol`，10 kinds / 10 contracts。
- ZAI Broker PID 5994：production dist，socket `.local/runtime/zai-codex/worker.sock`，文本 `glm-5.3`、视觉 `glm-5.3-flash`，10 kinds / 10 contracts；asset-rank、role-audit 发布有图/无图 route。
- Studio 初始 PID 5996：production dist，明确传入两个 socket。E06 最终正常重启后 PID 24064，仍使用同一 production dist、两个 socket和既有本地登录配置。
- 最终现场：OpenAI `active=0,queued=0,completed=9,failed=0`；ZAI `active=0,queued=0,completed=0,failed=0`；Studio health ok，Python/FFmpeg/ffprobe/say 均 true。未打印或复制任何密钥。

## R7.6 有界真实 QA、费用与长耗时

QA 报告：`docs/qa/videofactory-real-local-qa-20260913-06.md`；截图：`docs/qa/videofactory-real-local-qa-20260913-06-assets/01`–`18`。报告状态 `DONE_WITH_CONCERNS`，观察范围健康分 91/100；该分数不是完整 E2E 放行结论。

| 入口/行为 | 真实结果 |
| --- | --- |
| 自有想法 | run `run-b50a099c-8d66-4785-8745-231fc5182a37` 在 creative-treatment 提交前被 Broker 以合同不一致拒绝；`pendingOperation=null`，Broker 调用 0，约 0.17s。run task digest 与 health canonical digest 相同；role criteria digest 不同本身不是错误。具体 payload/expected digest/binding 哪项不匹配因公开 receipt 无字段级诊断仍为推测。没有同条件重试。 |
| 系列本集 | run `run-732178ce-3d5a-4f93-8e8f-b3da53bfd600`。构思 produce/audit 各 1 次，47.231s + 24.107s，96 分通过；编剧 `phaseAttempts={produce:4,audit:3}`，produce 合计 512.473s、audit 合计 249.774s，含 1 次结构修复，最终 38 分并在三轮后有界停止。总耗时 13m53.812s，OpenAI 真实调用 9 次，queue=0、provider retry=0、session rebuild=0。 |
| 查询与暂停 | 运行中“查询原任务”前后 Broker 均 `active=1,completed=3`，没有新调用；暂停显示“当前步骤完成后暂停”。暂停边界是整个 creative-planning node，因此编剧仍完成有界三轮，最后没有可显式恢复的后续节点。 |
| 热点 | 三个候选全部“待补来源、当前不可开工”，可采用数量 0，“新建制作”禁用并提供人工补来源入口。没有放宽来源、反复刷新或用 AI 画面伪成功。 |
| 刷新/重启/390 | 系列新 run 在 390 宽度刷新前后及 Studio 正常重启后均保留失败状态、三轮解释、重试和调整入口；三次 `clientWidth=scrollWidth=390`、console error=0。热点 390 同样无溢出。 |

本轮新增媒体/TTS费用 `¥0.00 / ¥50.00` 止损线；OpenAI 9 次为现有 subscription 文本调用，ZAI 0 次。没有媒体 create、TTS、Provider media taskId、unknown 付费任务或外部发布，因此没有发生可确认的付费媒体授权动作。

长耗时已按真实阶段拆开记录。13m53s 不是“候选不足”、排队或网络重试，而是 2 次构思调用、编剧三轮审计/修订及一次结构修复串行叠加；页面只显示“三轮”，没有把 7 次编剧物理调用解释给用户。用户提出的“每角色总共 1 次创建 + 2 次审计/修订，耗尽后明确说明并人工介入”仍是产品待决定，TASK 禁止本轮自行实施。

## R7.7 E01–E07 准确状态

| ID | 状态 | revision 7 证据/边界 |
| --- | --- | --- |
| E01 | BLOCKED | 三入口真实进入，但自有想法合同拒绝、系列编剧质量三轮不通过、热点来源不足，均未到完整方案/报价。 |
| E02 | PARTIAL | 真实验证查询原任务、暂停和无重复调用；未到报价三动作，失败 run 无可显式恢复节点。 |
| E03 | BLOCKED / NOT_VERIFIED | 未到媒体报价；media create=0、TTS=0、Provider taskId=无、无新成片。 |
| E04 | BLOCKED / NOT_VERIFIED | 两个真实模型配置均 ready，但没有新 evidence SHA，未提交双真实模型审片。 |
| E05 | BLOCKED / NOT_VERIFIED | 没有真实审片意见，未进行建议预填、局部返工或复用验证。 |
| E06 | PARTIAL | 真实 run 的查询/暂停、client 刷新、Studio 正常重启持久化、1440/390 均有页面证据；没有可安全触发的显式 Broker 恢复节点。 |
| E07 | BLOCKED / NOT_VERIFIED | 没有新成片，不能评价帧数、实际长度、声画同步、开头承诺/推进/结尾兑现或视觉一致性。 |

## R7.8 交付状态与未验证项

- 完成时间：2026-09-13 10:54:21 +0800。
- revision 7 状态：`READY_FOR_REVIEW`。只表示四类指定修复、集中确定性回归和一轮有界真实 QA 已完成并如实记录，不代表 `ACCEPTED` 或完整生产验收。
- QA 新发现 `QA-R7-01`：正式 creative-treatment 请求仍在 Broker parser 边界被拒绝。QA/report-only 阶段没有边测边改；字段级根因未证实，交审查窗口统一复核。
- 未验证：报价三动作、显式恢复推进、代表性新片媒体/TTS/渲染、同 evidence SHA 双真实模型审片、审片建议驱动的局部返工/复用，以及新片真实声画和创作质量。
- 没有 commit、push、云端部署、外部发布、删除或迁移用户数据；没有修改 `TASK.md` 或 `REVIEW_REVISION6.md`。产品修改与 QA 到此停止，等待审查窗口统一检查。

---

# Revision 8 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `8`
- status: `READY_FOR_REVIEW`
- 交付口径：指定修复和确定性验证完成；有界真实 QA 已执行完；**产品验收未通过**。`READY_FOR_REVIEW` 不代表 `ACCEPTED`。

## R8.1 开始基线与范围

- 开始基线：`docs/codex-collaboration/evidence/r8-start-baseline.json`，时间 `2026-09-13T03:36:43.988Z`，HEAD `570fe6e59e072c4965c86769bf2096825f003383`，branch `codex/final-dual-review-cloud-acceptance`，范围为 324 个产品/测试/配置路径。
- 现场目录、HEAD 和分支与 TASK revision 8 一致。全部既有 dirty changes 原样保留，没有 reset、stash、clean；没有重做 A/B/C 或回退已通过的重复审计修复。
- 先复现 `r7-capability-contract-review.mjs`：source 与 dist 各 6 tests、3 pass / 3 fail、exit 1。两项为正式目录与 Broker 画幅合同错配，一项为系列空 Canon 冲突。F03 使用持久化 checkpoint 的去身份化等价 fixture 复现“非局部问题仍继续调用同角色”，没有为建立红灯再跑真实长任务。
- 相对 r8 baseline 的 324 路径最终有 29 个产品/测试文件变化；另修正审查证据 `docs/codex-collaboration/evidence/r6-contract-boundary-review.mjs` 以适配当前正式合同。完整 29 路径如下：
  - Broker：`broker-server.ts`、`codex-executor.ts`、`task-definitions.ts`；对应 `broker-server.test.ts`、`codex-executor.test.ts`、`task-definitions.test.ts`、`topic-script-contract.cross.test.ts`、`zai-code-plan-executor.test.ts`。
  - Studio：`NodeWorkspace.tsx`、`production-studio.ts`、`studio-service.ts`、shared `api.ts`；对应 `series-store.test.ts`、`studio-service.test.ts`、`text-task-production-recovery.test.ts`。
  - Production Pipeline：`codex-chat.ts`、`codex-creative-treatment.ts`、`codex-screenwriter.ts`、`codex-visual-director.ts`、`creative-planning.ts`、`production-pipeline.ts`、`role-agent-loop.ts`、`visual-director.ts`；对应 `codex-screenwriter.test.ts`、`creative-planning.test.ts`、`production-planning-publication-child.ts`、`production-pipeline-screenwriter.test.ts`、`production-planning-closure.test.ts`、`role-agent-loop.test.ts`。
- 没有修改 TASK、REVIEW、模型/思考强度、媒体执行器、数据库或历史 durable 记录；没有加入“单视频每角色终身三次”产品限制。

## R8.2 四类共同根因与实际修复

1. `F01`：正式 Provider 目录允许五种画幅，Broker 能力 parser 只允许三种，导致 Seedance 等合法选择在文字规划入口被拒绝。修复为“Provider 支持集合”接受正式目录的五种值，项目实际输出画幅仍由原产品边界限制；同步 task descriptor、health、pipeline pin 与三规划角色的正式合同。未知比例、错 digest 和错 binding 仍 fail-closed。
2. `F02`：编剧生成/Schema 与脚本物化、终审及系列记忆提取对 `canonFacts` 的非空要求互相冲突。统一为必填数组、0–8 条已建立事实；空数组不触发结构修复，不编造事实，也不清除历史 Canon。缺字段、null、非数组、非法项和 9 条仍拒绝。
3. `F03`：审计能识别上游来源/用户决策问题，但 role loop 只按 `pass/repair` 命令同一角色继续重写。为规划角色审计接入正式 `planningDisposition`：`revise_here` 保留现有有界修订，`needs_source`/`needs_user` 在下一次 produce 前保存候选、审计和原任务身份并进入现有 PlanningIssue/PlanningHalt；Studio 展示具体缺口并预填调整建议。同输入重试、刷新和重建只观察原 halt，不增加模型或媒体调用；用户改变输入后仍按依赖闭包恢复。
4. `F04`：Broker 字段错误在 client/role/node/Studio 传播中被压平，且页面只展示最后角色的调用，把前序模型耗时算成本地处理。接入受限脱敏诊断（reasonCode、白名单字段路径、HTTP、kind/requestId、是否受理），不透传 prompt、凭据、任意路径或原始响应；接入 produce/audit/结构修复与阶段耗时统计，并向编剧审计提供宿主计算的总时长、场数、范围和 Canon 规则。

## R8.3 V8-01–V8-04 确定性证据

| ID | 状态 | 最终证据 |
| --- | --- | --- |
| V8-01 | PASS | 测试从正式 Provider 目录遍历空/单/混合选择，三种规划角色都经正式 client、Unix socket、Broker parser 和隔离 executor；原始 QA 输入在保留 Seedance 时恰好执行一次。3:4/4:3 合法，未知比例 executor=0；错误 digest/binding 拒绝。十类任务边界、source/final dist 均通过。 |
| V8-02 | PASS | 系列/非系列覆盖 0/1/8/9 条、缺字段/null/非法项；空 Canon 经脚本文件、物化、最终审查和系列记忆提取，不产生 validation-repair，不清除旧 Canon。 |
| V8-03 | PASS（确定性） | 正式 treatment/script/director adapter → role loop → planning graph → ProductionPipeline → Studio 状态/动作均消费处置。`needs_source/needs_user` 首次审计后同角色 produce 增量 0、backup=0、media/TTS=0，重建后仍为 0；可搜索图库、允许 AIGC 表达、已有相容来源、`revise_here` 和用户实际修改输入的反例保持可推进。 |
| V8-04 | PASS（确定性） | 非法比例经正式 client/role/node/Studio 后保留安全字段诊断且 executor=0，伪密钥和任意路径被脱敏；34 秒 host 事实为 34，生成与审计共用同一 durationRange；调用统计覆盖 1 produce + 1 audit、结构修复、查询与恢复，观察动作不增加执行数。 |

这些测试证明正式合同、控制流、恢复和结果消费；不证明真实模型一定会作出正确语义分类，也不替代真实成片质量验收。

## R8.4 集中回归、构建与 source/dist

运行时 Node v26.8.1。没有安装 pytest，没有提高超时、降低模型/思考强度或改断言规避失败。

| 命令/检查 | 完整终态 | exit |
| --- | --- | ---: |
| 修复前 `VF_REVIEW_CAPTURE_RUN=1 ... r7-capability-contract-review.mjs` source | 6 tests，3 pass / 3 fail | 1 |
| 修复前相同探针 final dist | 6 tests，3 pass / 3 fail | 1 |
| `npm run test:ts` | 792 tests，791 pass / 0 fail / 1 skip | 0 |
| `npm run test:broker` | 193 pass / 0 fail | 0 |
| `npm run studio:test` | Vitest 380/380；Node 509/509 | 0 |
| `npm run typecheck` | 全 workspace 通过 | 0 |
| `npm run build` | Broker、pipeline、Studio production build 成功；仅既有 Vite chunk warning | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，`OK` | 0 |
| 原恢复/审计安全组合 | 43 pass / 0 fail | 0 |
| 四正式适配器恢复组合 | 52 pass / 0 fail | 0 |
| `r7-capability-contract-review.mjs` source | 6 pass / 0 fail | 0 |
| 相同探针 final dist | 6 pass / 0 fail | 0 |
| `r6-contract-boundary-review.mjs` source | 15 pass / 0 fail | 0 |
| 相同探针 final dist | 15 pass / 0 fail | 0 |
| `git diff --check` | 无 whitespace error | 0 |

共享后半程另以正式合同 fixture 和隔离依赖验证报价三动作、授权范围变化、媒体/TTS/渲染边界、双审结果消费与局部返工；该证据不冒充真实 E2E。

## R8.5 真实本地环境与有界 QA

- QA 报告：`docs/qa/videofactory-real-local-qa-20260913-07.md`；截图：`docs/qa/videofactory-real-local-qa-20260913-07-assets/01`–`22`；gstack 镜像报告：`.gstack/qa-reports/qa-report-127-0-0-1-2026-09-13-r8.md`。
- 最终 OpenAI Broker PID `81826`、ZAI Broker PID `81827`、Studio PID `21869`，均为本仓库 production dist。两个 Broker 各发布 10 kinds / 10 contracts；OpenAI `completed=38,failed=2,active=0,queued=0`，ZAI `completed=1,failed=0,active=0,queued=0`。Studio health ok，Python/FFmpeg/ffprobe/say 均 true；最终清空 console 后 reload error=0。
- 第一次 Studio TERM 前只检查了 OpenAI idle，漏查 ZAI；重启后发现 ZAI `active=1`。没有终止或重复提交该任务，等待其完成。该调用与热点/系列只读页时间重合，但公开状态不暴露 task kind，来源未证实。关闭额外页面、确认两个 Broker 都 idle 后完成第二次正常重启。

| 样本 | 实际结果与耗时 |
| --- | --- |
| 抽象圆形正例 `run-2344bb51-be40-4dce-b8e4-d7ed5e42223a` | 约 6m10s，OpenAI 6 次；构思 2 produce + 2 audit、编剧 1 produce + 1 audit；最终 `needs_user`，之后同角色 produce 增量 0。调整方案成功预填原因和建议。证明 F03 外部处置被正式 Studio 消费，但不是生产正例通过。 |
| Stock 城市街景 `run-32ba953d-e44b-4b44-9ae0-882e80951928` | 约 23m58s，17 次文本尝试（16 completed + 1 failed）。导演第一次 produce 约 6m36s 后 Provider 失败；GLM 配置 PUT 409，随后 retry 仍用 OpenAI；最终候选排序 `needs_source`。派生 visualPlan 重新写入固定主体/机位/同条件，可能把非实证表达推回实证要求，但该因果仅为推测。 |
| 调整后的正例 `run-eb552d6d-4c73-4e54-9e60-4841d332dd9e` | 约 15m19s，OpenAI 14 次。构思 2+2；编剧 2 produce + 3 audit，含 1 次结构修复；导演 4 produce + 1 audit，含 2 次结构修复。导演首 audit 的 `revise_here` 路由正确，之后因 `shots[1].temporalBeats must contain at least two timed beats.` 失败。 |
| 缺专属来源负例 `run-266b6ff4-8b0f-4989-be30-f27c2d82139a` | suppliedSources 为空；构思 produce 48.215s、audit 19.116s。候选明确专属证据缺失，但 audit 仍以 96/pass 放行到编剧；编剧 produce 1,200.502s 超时。共 2 completed + 1 failed。Broker 已 idle 后 run 仍长期 running，无重试动作；Studio 重启后才变 failed。没有同条件重试。 |
- 热点只有 1 条缓存信号、0 条可采用、3 条历史候选待补来源；未反复刷新或放宽来源。系列没有当前能力和状态均适合直接开工的正常单集；未修改历史状态或再启动另一个负例。模板目录、全局搜索短冒烟正常，390 宽 `clientWidth=scrollWidth=390`。
- QA 阶段没有修改产品代码；同路径同根因失败只验证一次受控恢复，没有盲目换题/模型/runId。

## R8.6 QA 新问题与 E01–E07

新问题统一交回审查窗口，本轮没有边测边改：

1. `QA-R8-01` High：三个可制作方向均未进入报价，共享生产后半程仍无真实正例。
2. `QA-R8-02` High：缺专属来源负例未在构思早停，反而进入一次 20 分钟编剧调用。
3. `QA-R8-03` High：导演失败后选择 GLM 的配置 PUT 409，retry 实际仍使用 OpenAI。
4. `QA-R8-04` High：Provider 超时后 run 仍 running 且无合法动作，依赖 Studio 重启收口。
5. `QA-R8-05` Medium：页面只显示最后导演的 5 次调用，前两角色 9 次模型耗时被归为“本地处理”；“自动重试”实际混入结构修复。
6. `QA-R8-06` Medium：重启后 checkpoint 已 passed 的构思在 UI planningStages 中变回 pending，原 Provider timeout 也被“应用重启中断”覆盖。
7. `QA-R8-07` Low：原任务刚完成时查询出现 409，而不是幂等刷新；调用计数没有增加。

| ID | 状态 | revision 8 真实证据/边界 |
| --- | --- | --- |
| E01 | FAIL / BLOCKED | 三个自有想法均通过真实前门但未到报价；负例错误放行；热点和系列没有可直接贯通的合法正常样本。 |
| E02 | PARTIAL / NOT_VERIFIED | 查询原任务不新增调用；`needs_user` 调整方案能预填并关联源 run。未到报价，三种报价动作未验证；模型切换恢复失败。 |
| E03 | BLOCKED / NOT_VERIFIED | media create=0、TTS=0、渲染=0、media taskId=无。 |
| E04 | BLOCKED / NOT_VERIFIED | 没有新成片/evidence SHA，未提交双真实模型审片。 |
| E05 | PARTIAL / BLOCKED | 外部处置建议预填通过；无真实审片结果，审片建议驱动的局部返工和媒体复用未验证。 |
| E06 | FAIL / PARTIAL | 390 无溢出；刷新和查询保留原任务且不增加调用。超时后 run 卡 running；重启后完成阶段丢失，不能证明恢复推进并保留完成阶段。 |
| E07 | BLOCKED / NOT_VERIFIED | 无新成片，帧数、长度、声画同步、开头/推进/结尾兑现和双审创作质量均未验证。 |

## R8.7 费用、长耗时、未验证项与停止状态

- 新增媒体 create 0、TTS 0、渲染 0；现金支出 `¥0.00 / ¥50.00` 止损线。文本调用使用现有 subscription。没有报价、授权、media taskId 或 unknown 付费任务。
- 长耗时有真实记录：stock run 约 23m58s；调整正例约 15m19s；负例单次编剧调用 1,200.502s。已证实的是调用数量、阶段和结果；未证实的网络/模型内部耗时原因不作归因。页面对整个 planning 的调用和耗时解释仍不准确，已列 `QA-R8-05`。
- 未验证：正例真实报价与三动作、媒体/TTS/渲染、新 evidence SHA 双真实模型审片、审片建议驱动的必要返工/复用、新片声画及创作质量。没有新成片，不能写完整生产流程通过。
- 没有 commit、push、云端部署、外部发布、删除或迁移用户数据；没有覆盖历史报告或修改 TASK/REVIEW。
- 完成时间：2026-09-13（Asia/Shanghai）。revision 8 状态：`READY_FOR_REVIEW`。指定修复完成，QA 执行完，产品验收未通过。产品修改与真实 QA 到此停止，等待审查窗口统一检查。

---

# Revision 9 执行记录

- taskId: `VF-R3-CLOSURE-20260912-01`
- revision: `9`
- status: `PAUSED_BY_USER`

## R9.1 开始基线与暂停前工作点

- 现场仓库 `/Users/jinkun.wang/work_space/veidofactory`，branch `codex/final-dual-review-cloud-acceptance`，HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`；暂存区为空。保留 45 个当前产品/测试修改路径、2 个本轮新增 pipeline 源文件及约 230 个历史未跟踪资料/证据，没有 reset、stash、clean 或回退到历史 `570fe6e`。
- `r9-start-baseline.json` 保存的 322 个产品、测试及配置摘要与提交前内容基线相符；revision 9 在此之上的实际实现和 QA 证据继续保留。未修改 TASK、REVIEW、IMPLEMENTATION 或 VALIDATION。
- 已完成 W1/W2/W3 的实现、聚焦测试和集中确定性回归。最新补充修复把 `templateGuidance` 纳入构思阶段身份，防止模板变化复用旧构思；Studio 持久化摘要优先展示正式 `visualIntent`；visual-review/role-audit 正式合同与 digest 同步 `sourceTimecodeMs`；正式 halt receipt 明确为 produce 1 + audit 1；崩溃恢复 fixture 改用不改变构思输入的系列连续性变化。
- 暂停前工作点：用户明确同意追加 `¥6.25` 后，执行窗口只在原 run 正式页面确认一次。5 个镜头现已全部 materialized，实际媒体费用 `¥8.75 / ¥50`，无 unknown、失败或人工对账；镜头 2 确实复用，其余 4 个新 taskId 唯一。workflow 已把 `assets` 标为 succeeded 并进入 `asset-source-review`。素材阶段 20 分 41 秒中，约 15 分钟来自两次 GLM pilot review；Seedream 实测约 8 秒，三条新 MiniMax 视频约 2 分 04 秒、2 分 04 秒、1 分 33 秒。预检约 6 分钟后曾进入 `accepted_unknown`；只查询一次相同原任务，task identity 不变、Broker active 1/queued 0，没有重提。后续终态和暂停边界见 R9.4–R9.5。

## R9.2 已完成的集中检查

| 命令/检查 | 完整终态 | exit |
| --- | --- | ---: |
| `npm run build:pipeline` | 通过 | 0 |
| `npm run test:ts` 首轮 | 797 pass / 1 fail / 1 skip；旧 afterSeed fixture 因构思 identity 正确纳入模板后语义过期 | 1 |
| 修正等价 fixture 后 `npm run test:ts` | 798 pass / 0 fail / 1 skip | 0 |
| `npm run test:broker` | 197 pass / 0 fail | 0 |
| `npm run studio:test` | Vitest 383/383；Node 515/515 | 0 |
| `npm run typecheck` | 全 workspace 通过 | 0 |
| `npm run build` | Broker、pipeline、Studio production build 成功；仅既有 Vite chunk warning | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，`OK` | 0 |
| `apps/codex-broker/test/deploy-service.test.ts` | 28 pass / 0 fail | 0 |
| `r6-contract-boundary-review.mjs` source / dist | 15/15；15/15 | 0；0 |
| `r7-capability-contract-review.mjs` source / dist | 6/6；6/6 | 0；0 |
| `r9-planning-contract-boundary.mjs` source / dist | 4/4；4/4 | 0；0 |
| `r9-director-contract.test.mjs` | 5/5 | 0 |
| `git diff --check` | 无 whitespace error | 0 |

一次从仓库根直接调用 Studio Vitest 未加载 workspace 的 jsdom 配置而出现 `document is not defined`；随后使用正式 `npm run studio:test` 全量通过。该记录是命令入口误用，不是产品失败，也不从证据中删除。

## R9.3 最终真实环境与 QA 继续点

- 最终 build 产物：Broker `apps/codex-broker/dist/main.js` SHA-256 `665709f2e52374ce37ff2f5660b42ebf997933eadb5a67c420359247dcf6f124`；Studio server `1b2f5b487e785de95cfee6d37411b332799bd65d92389873967e95aaf5a5787a`；client index `da00a462b123c739bd08440c122797cccca22fbe0fe94beb33dd8d73e345b4c1`。
- OpenAI Broker PID `15927`，`gpt-5.6-sol / xhigh`；ZAI Broker PID `15928`，`glm-5.3 / max`、视觉 `glm-5.3-flash`；Studio PID `15929`。三个 cwd 均为本仓库，使用绝对 workspace 与双绝对 socket；两个 Broker 10 kinds / 10 contracts、启动时 active/queued 0/0，Studio health ok，Python/FFmpeg/ffprobe/say 均 true。
- QA 报告继续追加于 `docs/qa/videofactory-real-local-qa-20260913-r9.md`，证据目录为同名 `-assets/`。本轮 `qa-only` 只记录期间未修改产品代码；最终构建后的恢复证据为 `39-new-contract-recovery-ready.png`、`40-incremental-quote-mobile.png`。

## R9.4 用户要求暂停后的统一问题记录

- 用户明确要求“先别修了，把出现的问题都记录下来”。自该指令起停止产品修改、真实模型调用、媒体购买、TTS 和重试；没有把 revision 9 状态标成 `READY_FOR_REVIEW` 或 `ACCEPTED`。
- 主 run `run-e72cd051-e83c-4a9f-8cc8-5a4d2ae70b6f` 的 5 个素材均被正式 workflow 消费，`assets` 成功推进到 `asset-source-review`。预检第 2/3 轮正确以 `replan_upstream` 打回 `visual-direction/script`，没有第 3 轮和再次购买；实际媒体费用 `¥8.75 / ¥50.00`，无待确认费用。配音、渲染和双成片审片未开始。
- 已证实的四项 High 问题：
  1. 模板默认知识/证据职责覆盖用户明确的“只借节奏、纯主观隐喻”要求；
  2. 可由 AIGC 完成的普通抽象示意被错误升级为上传、实拍或图库来源要求；
  3. 一条视频母片加独立静态结尾被误判为两个母片必须同对象连续；
  4. 导演原方案没有在付费前建立跨镜一致性机制，四条独立视频的空间、卡片形态和色板在花费 `¥8.75` 后才由画面预检发现严重发散。
- 已证实的体验/容量问题：页面没有完整汇总前序 producer、audit、结构修复、调用数与总耗时；返工原因含过长内部技术文案；镜头勾选范围与自然语言时长要求的关系仍易误解。两次 GLM pilot review 合计约 15 分钟；全量预检首轮 producer `504,277ms` + audit `361,073ms`，约 14 分 25 秒，二者 `queueWaitMs=0`。这证明长耗时来自大上下文真实视觉调用，不是媒体 Provider、排队、候选不足或三轮反复。
- 用户提出但尚未确认实施的产品方向：以单视频、单角色节点为粒度，总机会考虑限制为 `1 次自动创建 + 2 次审计/修订`；耗尽后明确问题并转人工介入，不允许打回后重新获得三轮。本轮按 TASK 边界只记录，没有实现。证据同时表明还需单独决定单次墙钟止损和进度说明，不能只靠轮次数量解决等待问题。
- 三个受控返工 run：`run-66e84d3e-4ecb-4e36-ac58-cc0590e5de05`（3 分 47 秒、2 次真实执行、`needs_source`）、`run-e1d213cd-1267-4116-b30f-44b27df8445b`（6 分 12 秒、4 次真实执行、`needs_user`）、`run-d514e218-b8fd-4fa3-b00b-045954747991`（2 分 15 秒、2 次真实执行、同类 `needs_source`）。每个 `accepted_unknown` 只查询原任务一次，没有换 ID、重提或增加轮次；同类根因复现后按止损停止。
- `run-1dd80478-bff5-499f-8046-84c38aa221d8` 的 18 秒结果已排除为产品校验错误：QA 只勾选镜头 1–4，系统正确保留未勾选镜头 5 的 3 秒。OpenAI `process_exit` 也已排除为产品代码缺陷：其根因是 QA 部署传入相对 workspace，切换为绝对路径后正式调用恢复。
- 完整问题表、运行证据、费用和截图见 `docs/qa/videofactory-real-local-qa-20260913-r9.md` 第 6–7 节及 `videofactory-real-local-qa-20260913-r9-assets/43-template-priority-needs-source.png`。

## R9.5 暂停时验收边界

- 代码回归：revision 9 现有确定性回归、类型检查、正式构建及 source/dist 合同检查已通过，命令与退出码见 R9.2；本次暂停记录没有修改产品代码。
- QA 执行：只完成到真实素材与画面预检、调整方案及三次有界规划复现；按用户要求停止后不再继续。状态是 `PAUSED_BY_USER`，不是 QA 全部执行完。
- 产品验收：未通过。没有 TTS、渲染、新成片、同一 evidence SHA 的两个真实模型独立审片、审片建议驱动的局部返工或最终人工批准；无法评价新片声音、字幕、声画同步、节奏和内容兑现。
- 后续若恢复，应先由审查窗口统一确认上述根因与产品决定，再集中修复；不得在同类失败上继续换措辞、换 run 或盲目重试。

---

# Revision 10 交接准备

- taskId：`VF-DIRECTOR-CLOSURE-20260914`
- 日期：2026-09-14（Asia/Shanghai）
- 状态：`HANDOFF_READY`；执行入口 TASK.md 为 `READY_FOR_IMPLEMENTATION`。这不是产品 `READY_FOR_REVIEW` 或验收通过。

## 本轮交付

- TASK.md：最新决定、权限和 S0–S5 连续执行顺序。原 TASK 完整保存在 TASK_REVISION9.md。
- IMPLEMENTATION_REVISION10.md：现状证据、允许范围、模板退出、宿主/审计误分类纠正、导演与声音交接、恢复/统计/无损性能排查的固定实施方案。
- PROMPTS_REVISION10.md：公共规则、构思/编剧/导演/角色审计/视觉审片的可实施文本，以及必须保留的原合同。
- VALIDATION_REVISION10.md：21项确定性验收与9项真实QA验收；完整检查命令、有限样本、集中修复和止损规则。
- evidence/r10-handoff-baseline.json：资料准备开始时306个产品/测试/脚本文件hash，包含HEAD与分支，不含秘密；不是产品完成快照。

## 与 Revision 9 的明确差异

- 模板不再参与新生产，而非继续调整模板 required 职责。模板管理/历史、三入口、原声音与其它既有能力保留。
- 生产者误将示意分类成实证时，允许独立审计以绑定宿主issue的明确证据要求当前候选有界修订；不是直接放行或删除真实来源门。
- 导演在已有构思/方案/反馈环节统筹，不加总监督Agent；声音按真实配音与声音处理能力交接，不新建音乐/音效系统。
- 未采用“单视频单角色终身1次创建+2次审计”的待定配额。真实QA费用必须依据执行窗口当前授权，旧¥50不自动沿用。

## 本轮验证与边界

- 重新核对当前源码、R9记录和相关调用边界。Graphify已作导航，图谱较旧，结论以源码为准；没有重建图谱。
- 已比较上述306个文件hash：相对本轮资料准备基线变化0。本轮只编辑交接文档，没有追加产品修改。
- 文档完整性、验收编号和相关路径检查通过；`git diff --check` exit 0。
- 未运行产品构建/回归、真实模型、媒体、配音或部署；没有commit/push。源码仍包含上轮模板停用半成品，已在S0点名，不能直接用于付费QA。
- R9已有素材和¥8.75历史费用事实保留；TTS、新成片、双真实成片审片与局部返工仍未验证，未重新宣称通过。

执行窗口从 TASK.md 开始，完整读取三份附件，追加本节之后的 Revision 10 实施记录；不要覆盖本节和任何历史证据。

---

# Revision 10 执行记录

- taskId：`VF-DIRECTOR-CLOSURE-20260914`
- revision：`10`
- status：`READY_FOR_REVIEW`
- 完成时间：2026-09-14 01:34:45 +0800
- 结论：`CODE_VALIDATED`；真实本地 QA 为 `WAITING_AUTHORIZATION`，不是 `PRODUCT_ACCEPTED`。

## R10.1 基线、环境与权限

- 开始与结束 HEAD 均为 `b36ebac3189cf574b8e437cbe16eb9d0b228a177`，branch 为 `codex/final-dual-review-cloud-acceptance`。保留全部既有未提交修改，未执行 reset、stash、clean、commit、push、部署或用户数据迁移；暂存区为空。
- 以 `evidence/r10-handoff-baseline.json` 的 306 个文件摘要为开始导航，逐项按当前源码复核。最终相对该摘要有 42 个源码/测试路径变化；另更新 README、两份当前指南及本 Revision 记录。删除的旧 `planning-guidance.ts` 没有以兼容分支恢复，新职责由当前正式合同承担。
- 实际验证环境：Node `v26.8.1`，Python `3.12.10`。本地 shell 不暴露当前编辑会话的准确模型/effort，因此没有猜测或伪造；产品运行模型、effort、输出上限和审片阈值均未降低。
- 本轮没有启动真实模型、媒体或 TTS 任务，没有读取/输出凭据，也没有替换当前运行中的本地服务。新增现金费用、在途费用和未知费用均为 `¥0.00`；R9 已发生的 `¥8.75` 仅作为历史事实保留，不构成本轮授权。

## R10.2 S0–S5 实际完成

### S0：半成品与编译边界

- 收口 Studio 悬空引用和已经删除的生产模板选项；所有新制作仍强制使用 `joint-v1` 与可执行计划，历史 run 只读兼容，不恢复第二套旧流程。
- 最终类型检查最初发现两处新增合同后的测试类型未同步：视觉导演捕获类型漏 `voiceTiming`，音频能力夹具的 `pauseControl` 被扩成普通字符串。仅补类型边界后，完整类型检查通过。

### S1：模板退出生产

- 热点、系列和自有想法的新制作不再查询、等待、自动选择或提交模板；候选仍保留视频形态和三拍视觉方向。
- Studio 直接 start、Pipeline 有效 brief、构思/编剧/导演 producer、独立 audit、重新规划与返工均不再接收或回注 `templateGuidance`。已知旧 `template`/`templateSnapshot` 只在输入边界明确剥离，其它未知顶层字段继续 fail closed。
- Broker 的 `creative-treatment`、`script-draft`、`director-plan` 明确拒绝新请求中的旧模板指导。模板 CRUD、发布版本、删除/恢复、资源统计和历史快照读取保持；页面明确提示“暂不用于新制作”。
- 原模型、画面来源、声音、导演配置、系列约束、时长范围、视觉计划、参考语法、技能选择、报价与返工范围继续保留。图库/生成/复用失败仍不得生成说明卡；主动导演选择的正式 `editorial_card` 不受影响。

### S2：共同依据、导演与审计纠错

- 构思、编剧、视觉导演的 producer/audit 使用同版本用户要求、时长范围、能力、上游产物、声音节奏和返工范围；用户明确要求保持最高优先级。
- 新增宿主制作前提 `hostReadiness` 与审计复核 `hostReadinessReview`。独立审计只能精确引用被宿主误分类的问题并要求当前角色 `revise_here`；不能直接放行、不能覆盖真正的来源/用户阻断，未知、重复或越权引用均拒绝。
- 纯示意、普通机制说明与真实专属事实采用结构化证据语义，不以题材关键词特判。跨镜连续身份必须有可执行母片/引用关系；独立同风格镜头和独立静态结尾不被机械判为同对象连续。付费前导演检查仍通过现有构思、方案编译和独立审计完成，没有新增逐步监督 Agent。

### S3：声音与剪辑真实交接

- `ProductionCapabilities.audio` 只声明当前真实能力：旁白、Provider 实际支持的停顿控制；`musicTrack` 与 `soundEffectsTrack` 不伪造为可用。
- `voiceTiming` 进入编剧、导演与独立审计上下文，用户 `voiceDirection` 不再被模板覆盖。现有配音、语速、停顿、声音处理、TTS 自动执行与后台记账均保留，没有增加声音模型节点或人工核账门。
- worker validator 保留 `executablePlanPath`；素材、配音、渲染和质检消费同一已接受时间轴。超长语音继续返回 `VOICE_DOES_NOT_FIT`，保留原音频证据与可行动修订入口，不靠截断或强制加速伪成功。

### S4：模型切换、恢复、统计和耗时

- 保存编剧模型后只复用已完成构思并真实重跑编剧/导演；保存导演模型只重跑导演及下游。界面草稿在保存成功前不会生效，保存失败继续保留草稿并禁用旧模型重试；服务端在持锁点再次校验 run revision 与 input version，冲突零写入。
- `accepted_unknown` 继续只观察原 `requestId`，不换模型、不新 POST；迟到成功/失败、暂停、重启、持久化异常和并发消费均由正式 checkpoint/role loop 测试覆盖。
- 调用数按物理请求身份聚合；结构修复不重复计数，查询不算新执行，历史/本轮/未知状态分开。进行中费用与已物化进度沿用不可变 receipt/ledger。
- 新增不含内容的性能诊断：`requestPayloadBytes`、`promptBytes`、图像数量/字节、图像集合 SHA 与映射 SHA。诊断从不可变请求计算，不保存 `jpegBase64`；视觉证据只通过图像通道传递，独立双审仍各自获得完整证据。Studio 折叠展示“发送数据、模型指令、视觉证据”。
- 没有真实同模型、同证据的前后性能对照，因此本轮只证明冗余与统计口径修正，**没有宣称实际模型提速**。

### S5：文档、探针与交付

- 更新 `README.md`、`docs/guides/production-workflow.md`、`docs/guides/web-studio.md`：模板暂停参与新制作/重新规划/返工，CRUD 和历史资料保留；声音能力按真实 Provider 投影。
- 修订旧 source/dist 探针：role-audit 样本补当前必填的 `hostReadinessReview: null`；R9 规划探针从“模板指导必须穿透”改为“正常请求不传、旧指导在三个 producer 边界均拒绝”。

## R10.3 V10 验收状态

| ID | 状态 | 证据摘要 |
| --- | --- | --- |
| V10-01 | PASS | 类型、正式构建、source/dist 均无悬空引用或 source-only 修改。 |
| V10-02 | PASS | 三入口、模板正常/空/失败和无默认 beats 的 Studio/Pipeline 测试通过；正式请求无模板字段。 |
| V10-03 | PASS | `contracts.test.ts` 与 Broker 三角色边界证明旧字段剥离、旧 guidance 拒绝、其它未知字段拒绝。 |
| V10-04 | PASS | 模板 CRUD/历史、原模型/声音/素材/参考/系列能力回归通过；说明卡禁令未削弱。 |
| V10-05 | PASS | 在途原任务恢复、历史模板剥离、局部返工范围/复用/缺证据边界回归通过。 |
| V10-06 | PASS | 三正式 adapter 与 ProductionStudio→Pipeline 组合验证共同依据及依赖失效身份。 |
| V10-07 | PARTIAL | 多领域结构化示意/事实边界与宿主判断确定性通过；真实模型自然语言效果留给 E10-01。 |
| V10-08 | PASS | 宿主误分类只能有界 `revise_here`，不能绕过宿主；错误字段和越权引用拒绝。 |
| V10-09 | PASS | candidate/audit/修订等待等 checkpoint 与正式 socket 恢复测试证明不重复物理调用。 |
| V10-10 | PARTIAL | 连续母片、独立镜头和静态结尾的确定性执行边界通过；真实导演模型判断留给 E10-01/E10-02。 |
| V10-11 | PASS | 动态时长、时间轴、temporal beats、source range、复用和局部不变范围回归通过。 |
| V10-12 | PASS | no-match/能力不足/导演上推/单镜返工/not_observed 与卡片禁令测试通过。 |
| V10-13 | PASS | 三类声音 Provider 能力投影、voiceTiming 传递和不伪造音乐/音效轨通过。 |
| V10-14 | PASS | 正式 validator→worker 的 executable plan 传递及 Python 真实 worker 时间轴测试通过。 |
| V10-15 | PASS | `VOICE_DOES_NOT_FIT`、原音频证据、修改后恢复与未受影响媒体不重购通过。 |
| V10-16 | PASS | UI保存→revision→失效→真实 port 路由、草稿失败和并发冲突通过。 |
| V10-17 | PASS | 首 produce/audit 失败、迟到结果、暂停/恢复、lease 和重启终态组合通过。 |
| V10-18 | PASS | 多角色/回退/恢复物理调用聚合、未知单列与费用 ledger 回归通过。 |
| V10-19 | PARTIAL | 无损请求诊断、图像去重和耗时口径通过；实际提速没有真实对照，未验证。 |
| V10-20 | PARTIAL | 组件、键盘焦点、文案、模板暂停提示和恢复动作自动化通过；1440/390 真实浏览器未运行。 |
| V10-21 | PASS（确定性层） | 十类 digest、OpenAI/ZAI source/dist、正式 adapter/parser、隔离 socket 与正式 pipeline 组合全部通过；不冒充真实外部模型 E2E。 |

## R10.4 集中验证

| 命令/检查 | 最终结果 | exit |
| --- | --- | ---: |
| `npm run build:pipeline` | 成功 | 0 |
| `npm run test:ts` | 804 tests；803 pass / 0 fail / 1 既有 real production E2E skip | 0 |
| `npm run test:broker` | 198 pass / 0 fail | 0 |
| `npm run studio:test` | Vitest 384/384；Studio Node 515/515 | 0 |
| `npm run typecheck` | 全 workspace 通过 | 0 |
| `npm run build` | Broker/Pipeline/Studio production build 成功；仅 Vite 大 chunk 警告 | 0 |
| `npm run test:package` | 3 pass / 0 fail | 0 |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 131 tests，OK | 0 |
| R6 contract probe source / dist | 15/15；15/15 | 0；0 |
| R7 capability probe source / dist | 6/6；6/6 | 0；0 |
| R9 planning probe source / dist（已更新模板边界） | 5/5；5/5 | 0；0 |
| `r9-director-contract.test.mjs` | 5/5 | 0 |
| `git diff --check`（记录前） | 无 whitespace error | 0 |

自动化只证明确定性控制流、协议、恢复和边界，不证明真实模型一定产出高质量创作，也不证明真实媒体、听感或实际性能改善。

## R10.5 E10、费用与未验证项

- E10-01～E10-09：`WAITING_AUTHORIZATION / NOT_RUN`。本轮没有新的真实模型、媒体或 TTS 授权，因此没有启动 production 服务或 QA 浏览器，也没有创建替身 broker 来冒充真实验收。
- 尚未验证：两个真实文本模型的正/负语义效果、三入口真实到报价、报价三动作、媒体→配音→渲染、同一 evidence SHA 的两个真实成片审片模型、审片建议预填与局部返工、1440/390 真浏览器、完整新片画面/声音/同步/文字污染/视觉一致性，以及同模型同证据的实际性能对照。
- 新增实际费用 `¥0.00`，新增在途/未知最大暴露 `¥0.00`。没有把 R9 的历史止损金额当成本轮授权，没有发生外部发布。
- 最终状态是 `READY_FOR_REVIEW + CODE_VALIDATED + WAITING_AUTHORIZATION`。在上述真实证据完成前不得写 `QA_DONE` 或 `PRODUCT_ACCEPTED`。

## R10.6 Graphify 与最终差异

- 按任务约束只执行一次 `graphify update .`，exit 0。增量更新完成后为 6,779 nodes、14,744 edges、280 communities；`graphify-out/graph.json` 与 `graphify-out/GRAPH_REPORT.md` 已更新。
- 图谱超过 5,000 节点，Graphify 按可视化阈值跳过 `graph.html`；这是工具的明确保护提示，不是代码验证失败。本轮没有提高阈值、缩小项目或再次运行图谱命令。

## Revision 11 — 实现包与真实本地 QA 包交接（2026-09-14）

- taskId：`VF-CREATOR-COLLABORATION-R11-20260914`。
- 当前状态：`PACKET_READY / READY_FOR_IMPLEMENTATION`，不是 `CODE_VALIDATED` 或产品验收通过。
- 唯一执行入口：`docs/codex-collaboration/revision11/MASTER_PROMPT.md`；总目录见同目录 `README.md`。
- 实现包：`revision11/implementation/` 五份文档，覆盖产品交互、技术设计、S0–S6执行步骤、角色提示词与 D11-01～D11-46 确定性验收。
- 测试包：`revision11/qa/` 两份文档，覆盖正式本地环境、QA技能、Q11-01～Q11-12真实用例、费用与报告格式。先完成实现及集中验证，再运行真实QA；测试阶段集中记录现象、原因和未验证项，结束后交回，不无限修复重试。

### 已固定的本轮范围与权限

三入口保留；模板继续退出新生产而管理与历史保留；用户明确要求与自动建议分离；导演初案、脚本、分镜与画面方案分别支持自然语言多轮讨论，由用户确认当前版本后才继续。保留声音、技能、真实模型、时间轴、素材复用、局部返工、付费安全与双真实审片。

同时修复 `REVIEW_REVISION10.md` 的 F01–F08，落实导演素材路线权限、唯一有效审计反馈、声音配置同步、系列约束前置、恢复与界面纠正；热点入围后读取原文，再形成可追溯的事实和选题建议。技术方案复用现有工作流、SQLite checkpoint和Broker，不重建项目。

用户本次明确授权：实现及确定性验证收口后，可启动正式本地环境，通过QA技能代用户确认创作及必要付款，**本轮全部测试新增现金最大暴露总额不超过人民币50元**，跨run/session/重启共用，包含TTS及在途/未知费用。此授权取代本记录R10中针对当轮的“真实QA未授权”，不扩大为产品全局限额、每条视频50元或云端权限。不commit、push、云部署、外部发布、删除/迁移历史数据；不启动Oracle或外发资料。

### 本窗口实际修改与验证

- 基线：HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`，分支 `codex/final-dual-review-cloud-acceptance`，暂存区为空。`revision11/BASELINE.json`保留316个现有文件摘要及开始git状态。
- 新增10份资料包文件；原TASK原样存档为`TASK_REVISION10.md`，`TASK.md`更新为R11入口，并追加本记录。没有覆盖已有产品修改。
- 文档检查：10个文件齐全，Markdown代码块、相对链接、尾随空白检查通过；46个D11验收与12个Q11用例编号齐全；TASK存档SHA与编写前原文件完全相同。
- 追加本记录前，316个基线文件仅`TASK.md`发生变化，`RESULT.md`与产品源码均未被其它窗口修改。本窗口没有修改产品代码。
- 本次只准备交接资料，未运行编译、产品测试、真实模型/媒体任务或服务部署；新增现金费用`¥0.00`。所有D11/Q11仍待执行端用实际证据验证，不能把资料校验当成功能通过。

执行端下一步：完整读取MASTER_PROMPT与其指定资料，从S0核对当前现场开始，连续完成本轮实现和有界真实QA；仅在本文件追加R11执行记录，详细QA报告按测试包写入`docs/qa/`。

## Revision 11 — 实现与确定性验收（2026-09-14）

- status：`CODE_VALIDATED / LOCAL_QA_PENDING`。这里只表示代码与确定性合同通过；真实主片、真实音轨、双真实模型审片和局部返工仍须由 Q11 证明。
- 开始与结束 HEAD 均为 `b36ebac`；保留既有 dirty 成果，没有 reset/stash/clean、commit、push、云部署、外部发布、Oracle 或付费调用。
- 最后一次 `git diff --check`：exit 0。

### D11-01～D11-46 证据

下列行为均由正式领域图、Studio、SQLite/checkpoint、Broker 合同或 UI 组件接缝验证；外部模型语义、真实媒体质量和实际视觉仍按 Q11 单列，未用 D 证据替代。

| ID | 状态 | 确定性证据（测试文件与准确行为） |
| --- | --- | --- |
| D11-01 | PASS | `production-pipeline-reference-grammar.test.ts`：`runs a single joint creative-planning stage instead of the four legacy planning nodes`；`creative-review.test.ts`：`waits without side effects and resumes exactly one confirmed stage at a time`。 |
| D11-02 | PASS | `creative-review.test.ts`：同上，逐次确认只推进一个角色；`creative-planning.test.ts`：`图运行期间付费媒体调用为 0，且只访问创作规划 port`。 |
| D11-03 | PASS | `creative-review.test.ts` 的等待/确认/返回上游组合；`production-pipeline.test.ts`：`pauses before a metered worker and only calls it after the exact spend plan is approved`。 |
| D11-04 | PASS | `creative-os.test.tsx`：`shows an unsaved visual suggestion without submitting it as a user requirement`；Broker `rejects retired template guidance on every new planning-role request`。 |
| D11-05 | PASS | `role-agent-loop.test.ts`：`stops on host readiness after preserving a passing independent audit and replays without new calls` 及损坏 checkpoint 恢复组合。 |
| D11-06 | PASS | `role-agent-loop.test.ts`：`lets an independent audit send a misclassified source issue back to the same role without bypassing revalidation`、`does not let a partial or unknown host correction hide a real source blocker`。 |
| D11-07 | PASS | `production-pipeline.test.ts`：`allows the director to reroute an illustrative stock suggestion to an executable generated source`；不支持路线负例仍 fail closed。 |
| D11-08 | PASS | `trend-opportunity-agent.test.ts` 的问号、数字、空泛语义和来源组合回归，含 `keeps evergreen method-structure quantities...` 与 `blocks an unsupported factual premise...`。 |
| D11-09 | PASS | `codex-screenwriter.test.ts` 的 canon 输入边界；`production-planning-editing.test.ts` 的模型/输入 digest 失效与保留组合。 |
| D11-10 | PASS | `creative-review.test.ts` 等待无副作用；`production-planning-stages.test.ts` 的重启、同 digest 恢复和损坏 checkpoint 拒绝。 |
| D11-11 | PASS | `creative-review.test.ts`：`records an explanation...without changing the draft`、`keeps proposals separate...`；`creative-discussion-panel.test.tsx` 覆盖讨论动作。 |
| D11-12 | PASS | `creative-review.test.ts`：提案采用、撤销和旧稿保护；采用/撤销均不触发新模型调用。 |
| D11-13 | PASS | `creative-review.test.ts`：`keeps the same draft waiting when its confirmation check requests repair`；确认绑定候选 SHA，修订后重新等待。 |
| D11-14 | PASS | `production-planning-editing.test.ts`：`revalidates caller tokens at the locked point after both requests passed the service precheck`；Studio command replay/409 组合。 |
| D11-15 | PASS | `production-planning-editing.test.ts`：`rejects a stale caller revision at the locked mutation point with zero state change`；stage/run/baseSHA 边界测试。 |
| D11-16 | PASS | `text-task-production-recovery.test.ts` 的真实 socket 迟到成功/失败；Broker durable replay 与 `creative-review.test.ts` 的持久化命令恢复。 |
| D11-17 | PASS | `codex-bridge-recovery.cross.test.ts`：只轮询原任务、不重复 POST、身份错配拒绝；`role-agent-loop.test.ts`：accepted pending 观察恢复。 |
| D11-18 | PASS | 讨论历史无产品轮数上限；结构修复/角色循环仍由 `role-agent-loop.test.ts` 的有界重试、exhaustion 用例限制。 |
| D11-19 | PASS | `creative-discussion-panel.test.tsx`：可读阶段、正确主动作；`production-planning-stages.test.ts`：实际节点/产物投影。 |
| D11-20 | PASS | `creative-discussion-panel.test.tsx`：选中镜头讨论、返回影响；`creative-review.test.ts`：备选、采用、撤销、返回上游。 |
| D11-21 | PASS | `creative-discussion-panel.test.tsx`：不确定提交复用 commandId、轮询不覆盖未发送草稿、冲突保留输入。 |
| D11-22 | PASS | `creative-discussion-panel.test.tsx` 的冲突状态；`production-planning-editing.test.ts` 的持锁 revision 重验与模型设置生效边界。 |
| D11-23 | PASS | `creative-discussion-panel.test.tsx`：Ctrl+Enter、中文 IME、焦点/草稿；390px 真实布局和遮挡仍由 Q11-02/Q11-11补充视觉证据。 |
| D11-24 | PASS | Studio server/auth/component 回归覆盖登录、run 访问、字段 parser 与恶意文本按普通文本展示。 |
| D11-25 | PASS | 声音配置到规划/配音的共同输入与依赖闭包测试；`production-pipeline.test.ts`：声音节点编辑重合成且不重买无关媒体。 |
| D11-26 | PASS | 声音影响矩阵与 Provider 参数适配测试；不支持 pause 不投影为已生效。 |
| D11-27 | PASS | `VoiceStudio` 组件/参数测试覆盖 MiniMax 相对速度、Kokoro pause 禁用说明及 macOS 能力保留。 |
| D11-28 | PASS | `creative-review.test.ts`：从 director 返回已持久化 script，重确认后只重生下游；系列/核心要求失效组合。 |
| D11-29 | PASS | `production-joint-rework.test.ts`：读取上一版正式产物、按 finding 预填、只向受影响脚本/导演阶段反馈。 |
| D11-30 | PASS | `production-planning-editing.test.ts`：导演或脚本模型修改只失效对应及下游；在途安全合同拒绝切换。 |
| D11-31 | PASS | `production-planning-stages.test.ts` legacy run 可读；新流程确认门不可关闭；Broker/client recovery 只回收原任务。 |
| D11-32 | PASS | `production-pipeline-reference-grammar.test.ts`：joint-v1 commit 完整性、篡改/输入 digest 变化拒绝；未确认 draft 不发布。 |
| D11-33 | PASS | `production-authorization.test.ts`：无 scope 不执行、unknown 占用预算、digest/范围变化重新等待；Pipeline 精确批准组合。 |
| D11-34 | PASS | Studio 模板 CRUD、三入口、配置、动态时长、复用、局部返工、TTS记账和双审既有回归均通过；新生产请求拒绝模板指导。 |
| D11-35 | PASS | `trend-article-reader.test.ts`：编号段落与不可变快照；`trend-opportunity-agent.test.ts`：只存在于文章段落的合法事实可引用，缺段落拒绝。 |
| D11-36 | PASS | `trend-article-reader.test.ts`：登录墙/无正文诚实标注、批量截止；UI/agent 保留 title-only/partial 状态。 |
| D11-37 | PASS | `trend-article-reader.test.ts`：逐跳重验、内网/映射回环/非标准端口/解压上限/提示注入约束。 |
| D11-38 | PASS | `trend-article-reader.test.ts`：同 URL 合并、缓存、并发3、16 URL/128000字符和批次截止；调用方 sourceId 正确重绑。 |
| D11-39 | PASS | Broker task-definition、executor、cross-contract 与 R11 source/dist `4/4 + 4/4`，验证 kind/descriptor/normalizer/digest 和 discussion intent 一致。 |
| D11-40 | PASS | 三阶段 producer/discussion/audit 的共同 identity、旧审计隔离和自动建议边界由 creative-review、Broker executor 与角色输入捕获测试覆盖。 |
| D11-41 | PASS | 热点采用→ProductionBrief→treatment/script/director 的来源快照组合测试；verified 状态由服务端生成，客户端不能伪造。 |
| D11-42 | PASS | 热点正文失败与其它入口隔离、title-only 事实门、多转载合并不冒充独立核验的 agent/Studio 组合回归。 |
| D11-43 | PASS | `role-agent-loop.test.ts`：真实 producer/audit/validation/retry timings；Broker durable replay 与 UI 投影按物理 request 去重。 |
| D11-44 | PASS | `role-agent-loop.test.ts`：`reports real producer, audit, validation, and retry timings`；等待/排队/执行/修复分项且不从缺失时间戳编造。 |
| D11-45 | PASS | Pipeline timeline、VOICE_DOES_NOT_FIT、render、visual-review、局部返工与完整双审既有回归全部通过；复用镜头和最终发布证明未退化。 |
| D11-46 | PASS | `npm run test:ts` 813 pass/0 fail/1既有skip；`npm run studio:test` 390/390 + 529/529；`npm run test:broker` 199/199；`npm run typecheck`、`npm run build`、`npm run test:package` 3/3、Python 131/131、R6 source/dist 15/15、R9 5/5、R11 4/4均 exit 0。 |

### 集中验证边界

- `npm run build` 只有既有 Vite chunk size warning，不是失败。
- D11-23 的真实 390px 视觉、D11-35～42 的真实网页来源质量、D11-43～45 的真实模型/媒体/声音与成片质量仍进入 Q11，不把确定性测试写成真实验收。
- 下一状态：`LOCAL_QA_RUNNING`。按 revision11 QA 包使用正式 dist、真实 OpenAI/ZAI Broker 和隔离 workspace，集中测试、集中记录，本轮总现金与未知暴露不得超过 ¥50.00。

## R11 QA 集中修复资料包交接（2026-09-14 08:57，Asia/Shanghai）

- 用户本次要求读取最新报告/记录，生成交给普通 coding agent 的修复资料，并明确授予其本地测试所需权限。本窗口状态为 `PACKET_READY`；没有实施修复，没有替旧 QA 窗口写终态或宣称产品通过。
- 执行入口：`docs/codex-collaboration/r11-qa-repair-20260914/MASTER_PROMPT.md`；目录 README、FINDINGS_AND_FIXES、VALIDATION_AND_QA、BASELINE、两个脱敏证据快照已保存。任务标识 `VF-R11-QA-REPAIR-20260914`，属于 R11 定向修复，不替换 TASK/REVIEW、不重做 R11/A/B/C。
- 当前六项问题：F01 预算意向导致正式创建400；F02 采用备选已完成但页面仍等待；F03 OpenAI构思确认独审失败且安全诊断丢失；F04 阶段/终态/调用耗时投影矛盾；F05 脚本模型切换导致已采用构思和当前讨论回退；F06 GLM脚本本地执行退出后durable仍accepted/无outcome、观察无从收口。F06是资料编写期间最新QA-R11-006追加，已纳入V10验证。
- 关键核对：Broker的422是受理后错误的统一包装，不是已证实的上游原始HTTP码；失败confirm不等于有效StageConfirmation；Broker idle不证明远端任务失败。新包分别要求保护用户当前稿、保持确认门，以及保存未知证据/停止假运行，禁止超时后伪造远端失败以解锁重复提交。
- 修复与验证矩阵：V01～V10补完整HTTP/Pipeline/SQLite/Broker/RunPage组合失败序列；Q11-01～12保留三入口、正负语义、报价/媒体/TTS/渲染、双真实审片、返工、声音/恢复/移动端和统计。原报告中部分D11编号误映射已在新包注明，不改写历史报告。
- 授权：执行者可自行修改范围代码/测试、构建、启动/安全重启真实本地服务、读取必要配置/凭据、使用QA/浏览器、代用户讨论采用确认及额度内媒体付款/TTS/渲染/双审/有限返工；已授权动作不用逐项再问。沿用R11这一轮累计¥50止损，不因资料包/agent/run/session重新增加50元。凭据不回显，不commit/push/云部署/外部发布，不删除迁移历史或清checkpoint。
- 核对基线：HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`，原分支，暂存区为空；新BASELINE保存321个现有产品/测试/配置摘要、92项tracked dirty状态及322个未跟踪文件数量。资料编写期间这些321项没有变化；最新QA报告由原执行活动追加F06，其变化保留。
- 实际检查：报告/当前源码/正式durable与health只读核对；Graphify查询只用于源码导航。Markdown链接、代码块、尾随空白校验通过；`git diff --check` exit 0。没有为文档编写重跑产品测试、构建或真实请求，新增媒体/TTS费用为0。
- 现场截至08:57：主run revision9仍running；GLM构思producer/audit已完成，脚本原request `agent-e9fc146b34379bc729eb6f0cfcce4ff30586ce59be714157986fc13d6287ed60` 的结果未知。较后health为active/queued 0/0、completed/failed 2/1。没有干预、重投或重启它，接手先查原任务与最新QA报告。
- 产品验收仍未通过：最新主片未完成脚本确认/分镜/报价/媒体/TTS/渲染、新成片/双真实审片/成片返工；原Q11矩阵多项未验证。资料包已准备好，后续执行结果由coding agent追加于本文件。

## Revision 11 — 真实本地 QA 收口（2026-09-14 09:28，Asia/Shanghai）

- status：`QA_DONE_WITH_CONCERNS / PRODUCT_NOT_ACCEPTED`。这表示本轮可安全执行的真实点击、恢复观察和报告已经完成，不表示产品通过验收。
- 正式环境：HEAD `b36ebac`，Studio `http://127.0.0.1:4317`，workspace `workspace/qa-r11-20260914-001`；OpenAI Broker 为 `gpt-5.6-sol` xhigh，ZAI Broker 为 `glm-5.3` max，11类任务及合同摘要一致。没有fake Broker。
- 确定性基线沿用R11实现记录：TypeScript 813 pass/0 fail/1既有skip、Studio 390/390 + 529/529、Broker 199/199、Python 131/131、typecheck/build/package/source-dist均通过。本QA收口没有重新修改或重跑产品代码，只完成浏览器验证、现场读取和报告；最终 `git diff --check` exit 0。
- 真实主片没有完成。导演初案、解释、独立备选与采用已真实执行；OpenAI构思独审以422包装失败。切GLM后构思生成与独审真实成功，但脚本执行计入Broker failed后，durable原任务仍保持accepted且无outcome；Studio等待42分59秒后才本地收敛为失败。没有到报价、媒体、TTS、渲染、双真实视觉审片或局部返工。
- 真实文本任务共9个物理request：OpenAI completed=3/failed=3；ZAI completed=2/failed=1，另有同一失败执行对应的durable accepted原任务。轮询与刷新没有重复计数。媒体/TTS现金实际费用 `¥0.00`，在途/未知现金暴露 `¥0.00`，本轮50元止损未使用。
- QA共记录11项问题：P0 2项、P1 6项、P2 3项。共同根因集中在：OpenAI结构化任务执行/诊断边界、无远端身份的accepted收敛、stage-scoped模型失效和UI状态投影、预算输入双合同、热点正文DNS/IP安全校验。独立UX问题为声音预设静默换演员、模板暂停与复盘文案矛盾、全局搜索“声音”指向错误入口。
- 独立用例：热点真实刷新完成，但9/9正文读取失败且总编422，只得到规则回退候选；QA系列及6集路线图持久化，首集采用被OpenAI独审422阻断；声音设置、素材库空态、模板CRUD与刷新持久化、390px/1440px主要页面、搜索焦点/Escape、主run刷新恢复均已检查。因为底层原任务仍accepted，没有重启Broker或进行两窗口并发修改。
- 完整报告：`docs/qa/videofactory-real-local-qa-20260914-r11.md`；截图目录：`docs/qa/videofactory-real-local-qa-20260914-r11-assets/`。覆盖矩阵逐项标记Q11-01～Q11-12的PASS、PARTIAL、BLOCKED和NOT_VERIFIED，没有把确定性测试冒充真实E2E。
- 最终现场保持运行：Studio PID 84675；OpenAI Broker PID 84673，active/queued=0/0；ZAI Broker PID 84674，active/queued=0/0。未知原任务 `agent-e9fc146b34379bc729eb6f0cfcce4ff30586ce59be714157986fc13d6287ed60` 只允许继续查询原身份，不能重放或通过重启抹除。
- 未执行commit、push、云部署、外部发布、Oracle、工具升级或产品源码修改。下一轮应先按报告中的共同根因集中修复，再做确定性回归和一次有界真实主片复验；不能继续换题、换run或为单一case打补丁。

## Revision 11 — QA集中修复资料包完整更新（2026-09-14）

- 本次任务：依据执行者记录整理可由普通coding agent执行的资料；不实施产品修复，不运行真实QA。复用`docs/codex-collaboration/r11-qa-repair-20260914/`，唯一入口仍为`MASTER_PROMPT.md`，没有新增平行版本。
- 依据：09:28收口的最终QA报告、当前RESULT、R11产品/技术/验收/QA合同、相关源码和既有测试。Graphify仅用于定位Broker接缝，实际结论以当前源码为准，没有重建/修复图谱。
- 原包只覆盖6项，现更新为F01～F11、V01～V15及完整Q11矩阵；补齐共享热点/系列模型失败、正文读取、声音预设、模板复盘、设置搜索。分别给出已证实事实/未知原因、固定修正、允许模块、失败序列和验证范围。
- 新的定位证据：本机Node v26.8.1的连接lookup传入all=true；现有requestPinned返回标量而非数组。无外网/无模型的最小Node诊断复现`ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`，原测试整体替换request未覆盖此层。exit0表示捕获错误，不是产品测试通过。资料要求修callback合同并保留DNS固定/SSRF保护。
- 纠正三类误导：Broker包装422不等于上游HTTP422；采用后confirm审计失败不等于有有效StageConfirmation；旧Studio已在约43分钟后本地失败，但Broker仍accepted/无outcome，不能伪造远端失败来解锁重投。OpenAI具体拒绝原因仍待安全诊断取证，未宣称已定位或已修。
- 执行指令已明确：集中修复及代码验证后直接部署真实本地环境，使用QA技能继续浏览器QA/E2E，不能停在编译通过；集中记录后仅对同范围遗漏作有界修正/复验。原R11累计¥50授权不重开预算；unknown只查原身份；不commit/push/云部署/外部发布或降模型质量。
- 修改文件：本包四份Markdown和新增`EVIDENCE_FINAL_UPDATE.json`，以及本条RESULT记录。旧BASELINE与两个运行快照、原QA报告、TASK/REVIEW均保留。
- 资料验证：17个Markdown本地链接存在，11个问题与15条验收均完整、JSON可解析、代码围栏/尾随空白检查通过，`git diff --check` exit0。原BASELINE的321个产品/测试/配置摘要核对无变化，暂存区仍为空。未运行编译/产品测试/模型或媒体任务，本次现金新增¥0。
- 交付状态：`PACKET_READY`；产品仍未验收通过。执行端从入口开始，修复与真实测试的结果继续追加本文件，不据本条资料交付记录声明产品已修复。

## R11 QA集中修复 / VF-R11-QA-REPAIR-20260914

- 状态：`IMPLEMENTING`。接管现有未提交修改；HEAD `b36ebac3189cf574b8e437cbe16eb9d0b228a177`，分支 `codex/final-dual-review-cloud-acceptance`，暂存区为空。资料基线321项源码摘要已核对一致。
- 执行范围：F01–F11共同根因修复、V01–V15确定性验证、正式本地部署与Q11有界真实验证；不以编译通过替代成片验收。
- 先修Broker结构化请求/安全诊断/未知结果，再修预算、命令终态、采用稿保留和正文/声音/复盘/搜索。沿用R11累计50元，不重开预算；当前尚未新增模型或现金调用，付款前重新核实账本。
- 原GLM未知请求保留，只查询原身份；不以重启/清checkpoint/换模型重提解锁。不commit、push、云部署、升级工具或覆盖历史证据。

### 集中修复进度（实施中，尚未代码/产品验收）

- 已修改：预算意向正式合同与角色输入；OpenAI provider schema 投影和安全诊断；GLM 本地结束而远端未知的 durable 诊断及有界观察；采用备选的命令终态刷新；同 run 采用稿在脚本模型调整后的保留；阶段失败投影；正文固定 IP lookup 合同；声音预设保留演员；复盘历史模板降级展示；声音设置搜索深链。
- 当前证据：`npm run test:broker` 202/202 exit 0（`/tmp/vf-r11-broker-all.log`）；`npm run typecheck` exit 0（`/tmp/vf-r11-typecheck.log`）；正式 Pipeline/SQLite/Studio 采用稿恢复聚焦 1/1 exit 0（`/tmp/vf-r11-carry-focus.log`）。
- 尚未通过项：UI 聚焦 231 pass/2 fail，新增 RunPage 用例因测试环境缺 localStorage.getItem 抛错，正在补齐夹具后复跑；规划组合此前51/52，单项修正后尚待整组复跑。统计累计、未知状态换模型保护、声音不可用选择等边界继续核对，不能声称11项全部完成。
- 本轮尚未启动真实模型/媒体任务，新增现金¥0；真实 QA、成片、双审、局部返工均未验证。最终集中回归和正式本地部署仍在本任务内继续执行。

### 集中回归与进入真实QA前检查

- 进一步修复：无模型操作保留历史累计而本次调用为0；重复checkpoint不重复累计；未知文本任务在持锁的配置/输入修改边界拒绝重新提交。真实socket恢复测试发现 beforeSubmit 快照仍可能写 not_submitted，故以最新 uncertain failure 为准，不能据旧快照解锁。没有放宽付费或阶段确认。
- 声音不可用时保留配置并要求显式选演员，不把预设修改写成macOS默认；三个初始演员×全部节奏预设通过。声音搜索五个同义词到真实ResourcesPage同页分区通过。正文失败与无正文事实分开说明。
- 聚焦：规划/合同/正文78/78；UI三文件233/233，扩充后client+creative-os 231/231；正式socket/Studio恢复5/5，均exit0。初期两次vitest失败分别是测试工作目录错误、spy历史未清，均已纠正并保存日志，不计为产品通过证据。
- 集中：`npm run test:ts` 814 pass/0 fail/1既有skip，`npm run studio:test` 395/395组件 + 531/531 Node，Python unittest 131/131，`npm run typecheck` exit0。Broker202/202已完成且其后未修改Broker源码。完整构建/package/source-dist继续执行；不能据此声明V01–V15所有组合与真实产品已通过。
- 只读核对旧R11账本未发现媒体/现金记录；原GLM请求仍accepted且无outcome，保持现场。新QA使用`.local/runtime/qa-r11-repair-20260914`与`workspace/qa-r11-repair-20260914`、端口4319，沿用既有真实配置/登录，不清旧任务。现金已花0、未知现金0，R11共用剩余额度50元。

### 正式本地QA推进（持续执行，尚未收口）

- 正式build、package 3/3、R6 source/dist各15/15、R9各5/5、R11各4/4均exit0；完整日志保存于本轮QA的checks目录。新dist的Studio 4319与两个独立真实Broker已启动。
- 主片`run-25b4c195-a50c-4344-98fd-197d1bf58438`：预算35元成功往返；导演初案、解释、备选、采用与确认已真实完成。OpenAI确认独审95分pass并进入脚本等待，确认本轮不再遇到原schema拒绝。脚本正在做一次仅结尾旁白的表达修改，随后验证撤销和确认。
- 系列开拍复核已通过，准备以GLM执行本轮系列制作验证，不购买第二主片。复盘390布局、声音搜索同页落点和保留演员的节奏预设已真实点击。
- 新发现正常运行时提前显示未知恢复警告、自动视觉建议显示为“必须看到”，已记QA-R11R-01/02；后者尚未证明造成实际阻断。按约定先集中测试，不边点击边改产品。
- 当前现金及未知现金暴露仍0，未到媒体/TTS/渲染/成片双审，不能写产品通过。现场和详细步骤持续写入`docs/qa/videofactory-real-local-qa-20260914-r11-repair.md`。

### 第一轮真实QA集中收集后补修（进行中）

- 主片脚本修改/撤销和确认已执行，最终脚本独审96分通过；分镜返回`invalid_output/task_semantics`，原durable未保留具体规则。未重建样片或盲点重试。系列GLM脚本修改后独审通过，正在执行分镜/图库候选适配，尚未购买。
- 已确证QA-R11R-03：撤销只还原文档、未还原有效指令。新增稿件/指令成对快照，撤销与恢复一起切换；保留讨论历史；旧记录无法证明上一稿指令时明确拒绝安全撤销，不清空要求。
- 已确证QA-R11R-04：真实队列503拒绝在查询层被伪装404、重投又变409会话重建。正式socket→client→role loop回归已复现并修复，保留原拒绝原因、原ID继续封存；新代码及旧pending checkpoint恢复都通过，有界下一代只在确证未受理后执行。未知/冲突仍不切换重发。
- QA-R11R-01/02：正常running checkpoint不再自动投影成故障恢复；策划进度纳入creative-planning；等待用户明确停止自动执行；系统推导画面摘要改为参考而非“必须看到”。没有据界面文案误判去改写用户简报或放宽来源规则。
- QA-R11R-05：OpenAI/ZAI共享分镜语义诊断白名单，给出重复编号、引用/复用冲突、前向引用、非图片参考路线的安全code/字段；客户端保留并翻译，不暴露生成内容。原分镜失败的具体规则历史不可恢复，需新build下原run一次受控复验。
- 热点真实产出6ideas，但groundModelIdea全部过滤；已用原模型返回及原已读段落离线重放确认0。引用ID均有效，存在创作标签引号触发词面过滤的迹象；没有放宽事实核验换通过，热点正链仍未验收。
- 本段只新增确定性测试/源码修正，未追加人工真实生成操作。正在运行集中回归/typecheck；现金及未知现金暴露仍¥0/¥0，累计止损¥50不变。未commit/push，未操作旧GLM未知任务。

### 补修验证完成，原样片受控复验（2026-09-14 12:27）

- 补修回归：TS串行815 pass/0 fail/1既有skip；Broker205/205；Studio组件395/395及Node531/531；typecheck、正式build、package3/3均exit0。随后新增审计队列拒绝回归与显式phase修正，role-loop37/37、最终正式组合295/295及正式build均exit0；R11 source/dist各4/4。没有把最后新增单测冒充已重跑的全量TS数字。完整输出保存在本轮QA `checks/qa-followup-*`。
- 保留失败证据：首次并行npm脚本重写共享dist造成TS三项文件读取错误，串行重跑消除；Broker旧断言将已撤回任务预期为409，按原503重放合同及零新增执行改正后全过。此后共享build脚本只串行。
- 系列真实链约21m14s后因图库候选不足停止；GLM三次分镜均成功返回，但导演调整后仍保留不可得stock镜头，未抵达报价。其AI示意目标与补料文案之间的问题仍待解释，不能标为正链通过。
- 确认本轮两个Broker均无在途后，正常重启本轮三服务：Studio86968、OpenAI86965、ZAI86967，同workspace、同socket、端口4319。`/api/health`正常、11类合同一致，模型仍sol/xhigh与GLM/max。旧4317环境与未知请求不动。
- 原主片刷新保留treatment/script完成状态；12:27仅点击一次“重试失败步骤”，新请求`agent-c1381e9b8b425cd092ea96333ba30c4be665b388a5519c930bc7aac3d2373915`为director-plan。没有重开run/预算、没有重跑上游。正常运行误报未知警告已消失，截图`11-recovered-running.png`已检查。
- 当前仍`LOCAL_QA_RUNNING`：等待这次分镜受控复验后继续可达链；现金及未知现金暴露0，成片/双审/返工尚未验证。

### R11集中修复最终交回（2026-09-14，补修后有界QA结束）

**提交审查状态：READY_FOR_REVIEW；代码检查：CODE_VALIDATED；QA：QA_DONE_WITH_CONCERNS；产品：PRODUCT_NOT_ACCEPTED；建议：CHANGES_REQUIRED。** 这些不是同义词。已运行的代码检查通过，但不能宣称11项全部验收或新视频已完成。按MASTER规定，集中补修后单次受控复验仍阻断，停止新生产与产品修改，没有继续无条件重试。

#### 已完成与剩余问题

| 项目 | 当前结论 |
|---|---|
| F01预算 | 正式合同与规划输入已修，真实35元创建/持久化通过，授权仍0 |
| F02采用终态 | 真实采用无需刷新即可继续；generic retry后阶段详情仍有需刷新补齐的相邻遗漏 |
| F03共享独审/诊断 | 原OpenAI schema拒绝已不复现，真实构思/脚本独审推进；新分镜输出重复编号仍阻断，安全诊断已可取 |
| F04状态/统计 | 正常未知警告、部分阶段投影已修；恢复把checkpoint内部旧调用/时间移入本次仍错误，未完成 |
| F05上游稿保留 | 正式carry回归通过；真实检查失败后只改script模型，上游SHA和repair76保留、零新增模型；全部并发分支没有冒称真实测过 |
| F06未知结果 | ZAI本地结束/远端未知诊断和有界观察、持锁禁止重投已修并通过回归；旧accepted无outcome仍未知，不伪造恢复 |
| F07热点/系列调用 | 两类真实调用成功；热点后过滤成0、系列图库no-match仍使业务正链未通过 |
| F08正文 | 正式固定IP lookup合同已修，6 read/2 title_only、澎湃原文核对，无InvalidIP；B站描述不当视频证据 |
| F09声音 | 节奏预设不暗换演员、不可用演员不静默替换、参数说明已修；真实音轨/TTS未执行 |
| F10复盘 | 作品优先、模板仅历史，组件和真实空态通过，CRUD保留 |
| F11搜索 | 声音同义索引与同页分区激活已修，真实声音/停顿搜索可达 |

真实主片最终：`run-25b4c195-a50c-4344-98fd-197d1bf58438` revision11/failed。导演讨论和采用、构思独审95、脚本修改与复验96完成；唯一分镜复验request `agent-c1381e9b8b425cd092ea96333ba30c4be665b388a5519c930bc7aac3d2373915`，实际模型运行183185ms、排队0，失败规则`duplicate_scene_position`，字段`output.shots[2].scenePosition`。不是网络超时，不是上游HTTP422。旧task_semantics究竟哪条规则仍不可逆推，不能补写猜测。刷新后页面能显示诊断；当前稿与上游保留，没有手工删镜头/改号/关校验。

系列：`run-62324471-a9bd-4e6d-9b90-5cfe049dc700` revision5/failed。GLM构思、脚本及3次分镜成功，但调整后图库1/2仍没有可采用候选，约21m14s停止；AI示意作品却被泛化成“上传实拍/改变实验主张”提示，用户不能顺畅回到分镜调整。热点真实总编与独审产出6ideas，正式宿主过滤为0；原引用有效，`unsupportedClaim`对创作标签/引号等仍有词面误判。两者均保留证据，不换题刷成功。

负例：`run-6083f24f-bc98-4fb5-81f2-2aeb3954e285`修后原run恢复，GLM-5.3/max构思69283ms成功；OpenAI真实独审27940ms、76分repair，明确本人录像/数据缺失，停treatment、script未开始、媒体0。随后仅改脚本模型并按人工版本恢复，run revision3→5，草稿SHA`ca743be661b34c403cb40b01227335821d6d4adafeb96b84532ead8bcae82fe1`和check修订要求保持，零新增模型。390手机未发送输入跨刷新保留；但发送中心被sticky撤销按钮覆盖，截图和DOM命中均已确认（QA-R11R-09）。

新增/残留的优先事项：分镜输出唯一性及其有界修正（不能靠重试碰运气）；示意路线no-match反馈与返回讨论；热点事实与创作表达混判；恢复按原request归属统计；手机底栏遮挡。当前证据不要求重写框架或数据库。具体共同根因、确定/待查边界和最小建议在QA报告，不新增题材特判。

#### 验证和证据

- 代码日志与退出码沿上节；最终TS全量实跑815 pass/0 fail/1既有skip，Broker205/205、Studio395+531、Python131/131；最后phase修正后role-loop37/37和正式组合295/295、build、R11 source/dist通过。没有在最后增补后虚报更高全量TS数量。首次dist并发竞争失败与Broker旧断言失败均保留，有对应串行/修正后成功证据。
- V01–V15：V01 PASS、V02 PARTIAL、V03 PASS、V04 PARTIAL、V05 FAIL、V06 PASS、V07 PARTIAL、V08 PARTIAL、V09 PASS、V10 PARTIAL、V11 PARTIAL、V12 PASS、V13 PARTIAL、V14 PASS、V15 PASS；逐项范围/缺口在报告，不用测试总数覆盖未证明的组合。
- Q11-01 PASS；Q11-02 PARTIAL/FAIL；Q11-03/04/05 NOT_VERIFIED；Q11-06/07 PARTIAL/FAIL；Q11-08 PASS；Q11-09/10 PARTIAL；Q11-11 PARTIAL/FAIL；Q11-12 FAIL。无成片/正式音轨/双真实视觉审片/局部成片返工/交付，听感未验证。没有用旧片或替身冒充。
- 详细报告：`docs/qa/videofactory-real-local-qa-20260914-r11-repair.md`；新截图11～15与此前截图均保留；脱敏任务清单、原durable路径、实际模型/effort/时间/输出SHA、运行文件SHA、build摘要及43个本次基线变化文件：`docs/qa/videofactory-real-local-qa-20260914-r11-repair-assets/final-evidence.json`。
- 最终HEAD仍`b36ebac3189cf574b8e437cbe16eb9d0b228a177`，暂存区空，`git diff --check` exit0。资料BASELINE中的TASK与REVIEW_REVISION10摘要核对未变；保留全部dirty，无commit/push/云部署/升级/Oracle或外部发布。

#### 费用与最终现场

- 本QA新目录共41个物理Broker任务：38 completed（36成功、2失败）、3 not_accepted（实际0执行），无accepted在途；原R11此前9个请求另计，非重开测试轮。请求清单不含凭据/完整prompt。
- 四条R11相关run均无spendAuthorization，receipt仅订阅或本地；未到媒体/TTS。累计已确定现金¥0.00、在途/未知现金暴露¥0.00、剩余¥50.00。旧GLM未知请求依然accepted无outcome、订阅路由，不重投，不将未知执行判失败。
- 正式本地服务保持运行：http://127.0.0.1:4319；Studio PID86968、OpenAI86965、ZAI86967；同`workspace/qa-r11-repair-20260914`与对应runtime。最后`/api/health`正常，两个Broker active=0/queued=0。OpenAI本次进程completed1/failed1，ZAI completed1/failed0，仅为重启后计数，不能代替41条持久化任务总数。
- 旧4317服务/历史数据/未明GLM请求没有干预。正常CRUD仅删除本轮自建临时模板，6个内置保留。测试草稿留在本机负例的讨论输入中、未发送，便于审查。

### R11 剩余根因审计与新执行包（2026-09-14）

状态：`AUDIT_PACKAGE_READY`；产品仍为`CHANGES_REQUIRED / PRODUCT_NOT_ACCEPTED`。本轮按用户最新要求只审计并写修复/真实测试包，没有继续改产品或真实生成。

资料入口：`docs/codex-collaboration/r11-final-closure-20260914/MASTER_PROMPT.md`。同目录AUDIT记录根因与证据等级，IMPLEMENTATION规定K1–K6最小修正路线，VALIDATION列C01–C15跨边界失败/回归，REAL_QA规定修完编译回归后直接真实本地部署与主片/双审/局部返工测试；BASELINE记录325项当前源码/测试/脚本摘要。沿用R11累计50元，不新开预算；执行前核对实时现金暴露。

本次新增确认：

- K1：Broker在role-loop宿主校验前拒绝director语义错误；合法输出对照1次成功，只改变一处scenePosition后1次拒绝、宿主validate调用0，当前有界结构修正未消费此路径。原坏输出无法恢复，未臆测模型为何重复编号。
- K2：原系列三轮顺序更正为初次stock1/2→修1/2时又把4改stock→修4时又把1/2改stock。真实反馈有传递，但下一producer输入没有上一完整分镜基线。图库路径halt在director_review之前，普通失败与统一补实拍文案进一步堵住讨论入口。新包一并要求修改分镜后的候选/可得性复核与确认身份，不能仅连接UI后绕过编译前检查。
- K3：正式原数据回放6ideas→0候选；6项引用都有效、6项均受引号词面过滤，第4项另有AI、第6项另有28。不是正文未读或模型未返回，不等于6项语义全都合格。明确机器引用校验与现有独审事实判断分工。
- K4：原主片正式summary复现本次2次/439225ms，实际本次只1个director请求/183185ms。checkpoint可变owner与整个执行墙钟是两个独立归属/时间问题，不能靠改显示数字修复。
- K5：同revision简略事件用当前preferRunSnapshot函数复现清掉planningStages；GET有增强但publish/toDetail没有，终态停止订阅又阻断补全。未冒称重演了全部原浏览器事件顺序。
- K6：沿用真实390手机DOM命中和截图15，sticky动作覆盖发送；新QA包含较矮窗口、长输入、IME与hit-test，不把无横滚当通过。

验证：`node --import tsx docs/codex-collaboration/r11-final-closure-20260914/evidence/probe.mjs`退出0；证据`evidence/probe-before.json`。探针只用本地记录/受控transport和当前模块，不发真实网络/模型。`node --test --test-concurrency=1 --test-name-pattern='preserves safe director semantic diagnostics' --import tsx apps/codex-broker/test/codex-executor.test.ts`为1/1、退出0；只证明原诊断能力，没有声称新方案已实现。最初CJS探针因ESM-only exports失败，改内存ESM加载后成功，未动依赖。一次证据patch因同文件双操作被拒绝，改为单文件更新完成，未影响产品。

325项产品/测试/脚本SHA复核全未变；本轮仅新资料包与本RESULT记录，不重跑全量构建、不操作服务、不新增费用、不commit/push/部署/升级或Oracle外传。新执行端下一步按MASTER接管集中修复，不再从历史A/B/C重做。

### R11 主线续测（2026-09-14，进行中）

状态：`IN_PROGRESS / PRODUCT_NOT_ACCEPTED`。以上 AUDIT_PACKAGE_READY 是历史状态，未及时记录后续实施，不能代表当前源码或实时费用。用户最新要求先完成当前主片的素材、声音、渲染、同片双审和局部返工，再集中修非阻断问题；不换题刷成功、不 commit/push。

- 当前续接制作：`run-a7c42cc4-98de-4354-9dc9-c268b68b1446`，revision20，`awaiting_spend_approval`。此前已有导演/脚本/分镜产物，镜头5已物化，实际 Provider task `441663804842287`，不可重复购买。
- 最近已经实施但旧记录未覆盖：审片 criteria 合同上限同步到16（正式调用为13）；失败/拒绝操作中未提交 prepared 的费用预留释放，submitted/unknown 仍保守占用；素材提前终止关闭未提交条目。此前报告的403重新核对为测试请求漏 `x-video-factory-request: studio`，不是产品登录故障，没有修改鉴权。
- 本次独立运行 `node --test --test-concurrency=1 --import tsx packages/production-pipeline/test/production-authorization.test.ts packages/production-pipeline/test/generative-asset-worker.test.ts apps/studio/test/production-authorization-api.test.ts`：141/141，退出0。完整日志 `/tmp/vf-main-resume-regression.log`。不以此宣称完整成片验收通过。
- 付款前只读所有本轮6条run的账本，经正式物理请求去重：父制作镜头5 ¥4、当前制作镜头5 ¥4，累计确定媒体 ¥8；在途/未知现金0。当前尚缺镜头1报价 ¥5.50，原scope ¥9.50中的余额足够；仍共用本轮¥50（不是新预算），给声音及局部返工留余量。旧两个prepared各¥5.50已由真实failed/rejected receipt证明操作终止，不是应追加购买的¥11。
- 正式本地服务4319及两Broker仍运行；使用19:31构建产物，19:33启动。续测结果与旁支清单持续追加到 `docs/qa/videofactory-real-local-qa-20260914-r11-closure.md`。

续测更新（20:03）：原授权幂等续接成功，revision20→21，assets已succeeded，进入asset-source-review。镜头1新task `441687379644690`真实生成/落盘，SHA `7d414749a6207fd3bb1e2fb50b75cf9e4a7f36f1817f05e1a9fb7c222e491543`，11.542秒/277帧/24fps/768×1344；镜头5复用SHA未变，2–4为镜头1的复用段。累计本轮媒体¥13.50（父片4+本片9.50），未追加scope、未重复购买。GLM镜头5的报告复核pass/92，249703ms/1attempt；整组素材审查是新职责的真实visual-review，仍在原请求等待，未盲重试。配音/渲染/最终双审尚未发生。

仅新增既有 `production-authorization.test.ts` 内3个真实宿主/持久化回归，覆盖终止未提交释放、活跃预留保留、终止但已提交保留，以及续接不重复派生。合跑144/144，退出0（`/tmp/vf-main-resume-regression-final.log`）；pipeline不产出构建的类型检查退出0。另下游试片/审片/生产预检42/42，退出0（`/tmp/vf-main-downstream-regression.log`）。运行中没有修改产品源码或重启服务。

用户新增明确要求：本次整组素材审查已超过10分钟，**即使成功也必须在主线之后追查慢的根因**。已登记QA报告 `PERF-R11-01 / OPEN`，记录原request、受理/观察时间、15帧及输入体量、当前produce/audit阶段和待查时间拆分；功能成功不自动关闭该项。当前仍观察原请求，不重投、不降模型/质量。

续测更新（20:14终态）：整组素材审查失败，989138ms/1attempt/0结构修正/0排队，HTTP422 task_semantics。输入24036tokens、输出38311tokens（思考36514）；不是网络超时。具体语义规则被错误诊断映射遗漏，公开脱敏后未保留，旧候选无法恢复；不臆测是某个镜头或某条规则。正在检查完整validator/prompt/executor/Broker错误链并建立不调用模型的失败回归。两素材保留，累计¥13.50，声音/成片/双真实审片未达。

补记回归：全量TS828 pass/0 fail/1既有skip，exit0；Broker全量211 pass/2 fail，exit1，两个固定毫秒等待的恢复断言actual0/expected1，原样单跑2/2 exit0。不是全量通过；需核对时序并重新验证。证据见QA closure报告及`/tmp/vf-main-broker-regression.log`。

20:24用户要求停止并移交Claude Code。状态`PAUSED_BY_USER / PRODUCT_NOT_ACCEPTED`。最后新增visual七类语义安全诊断、v16输出规则、同步digest及集成回归，**未完成验证**：聚焦66 pass/1 fail，exit1，新增全链测试error.statusCode undefined（预期422），尚未查清。没有build/重启/真实复验。完整现场及下一步见`docs/codex-collaboration/HANDOFF_R11_20260914.md`；源码保留未撤回，不得把新patch说成已修好。无新增购买，累计媒体仍¥13.50。

### R11 接管续测（Claude Code，2026-09-14 20:30 起）

状态：`IN_PROGRESS / PRODUCT_NOT_ACCEPTED`。接手后先复现红灯、沿调用链定位，再集中修复并重新验证。

**失败测试的真根因（不是测试问题，是产品缺陷）**：新增全链用例的1项失败在 `replay=1`，不在首次执行。逐案探针（7类×2次重放，共14个断言）显示：**首次执行7类语义拒绝全部正确保留** `statusCode=422/reasonCode/fieldPath/taskKind`；**失败的是同一 requestId 的幂等重放**——`CodexBridgeClient.submit()` 对 `status=200` 一律按成功信封调用 `parseEnvelope`，而 Broker 重放已终结失败时返回的是 `200 + state=completed_failure + ok:false + outcome`，于是抛出 `Codex bridge response envelope is missing ok/output.`（`stage=uncertain`，无 statusCode），把已落盘的权威诊断整个丢掉。这是独立于“visual 诊断映射遗漏”的第二个诊断丢失缺陷，且恰好命中产品主线的失败观察路径。

**修复（最小、不放宽任何校验）**：`packages/production-pipeline/src/codex-chat.ts` 的 `submit()` 200 分支在解析成功信封前先判 `ok`；`ok!==true` 时先做身份校验，`state==="completed_failure"` 走既有 `completedFailureError(outcome)`，否则保持原 `missing ok/output` 行为。没有改 validator、评分、超时或重试语义。

**确定性测试**：
- `packages/production-pipeline/test/codex-chat.test.ts` 新增2个客户端边界用例（同requestId重放失败信封保留诊断且只POST一次；无法解释的200仍按 uncertain + missing ok/output 失败）。已做 RED 验证：撤回修复后新用例1/1失败，恢复后25/25通过。
- 既有 `apps/codex-broker/test/zai-fallback-integration.test.ts` 七类规则链路用例由 1 fail 转 0 fail。

**恢复测试的调度敏感性**：`codex-bridge-recovery.cross.test.ts` 此前用固定 20/30ms sleep 后再断言 `executor.calls.length===1`，在全量运行时读到0（历史日志`/tmp/vf-main-broker-regression.log` 记 actual0/expected1×2）。已改为真实事件/状态同步：`ScriptedExecutor.waitForCallCount()`（真实开始事件，带5s有界失败）与 `waitForDurableState()`（读已落盘的 durable record 终态，按 requestId 匹配）。未增加 sleep、未删断言；同时消除了“release 早于 executor 启动导致 gate 永不释放”的真实竞态。全量复跑214/214。

**Node 运行时纠正**：首次全量 TS 出现122 fail，全部来自 `better_sqlite3.node` 的 `NODE_MODULE_VERSION 147 vs 127` ABI 不匹配——原因是本 shell 的 `node` 解析到 nvm v22.23.1，而项目按交接要求使用 `/opt/homebrew/bin/node` v26.8.1。改用正确 Node 后无失败。**未重建 ABI、未换 Node**。

**集中验证（全部使用 `/opt/homebrew/bin/node` v26.8.1）**：聚焦67/67 exit0；Broker全量214/214 exit0；全量TS 831项 830 pass/0 fail/1既有E2E skip exit0；Studio vitest 399/399 + node --test 532/532 exit0；source/dist 合同探针 `r11-contract-boundary.mjs` src 4/4、dist 4/4 exit0；`tsc --noEmit` pipeline/broker/template-core/workflow-core 与 studio server+client 全部 exit0；`npm run build` exit0。日志 `/tmp/vf-node26-*.log`、`/tmp/vf-contract-*.log`、`/tmp/vf-studio-test.log`、`/tmp/vf-build-1.log`。

**真实本地部署**：核对两 Broker `active=0/queued=0`、无在途 durable 任务后，仅重启本轮三个服务（保留 workspace/媒体/checkpoint，未动 08:15 起的旧环境）。现 PID：openai 6746、zai 6751、studio 6804，均从 20:56 新 dist 启动。`/api/health` 为 `{"status":"ok","runtime":{"python":true,"ffmpeg":true,"ffprobe":true,"say":true}}`；两 Broker `/health` 正常且 active/queued=0。dist 已确认包含本次修复。注意本机 shell 有代理，本地请求需 `--noproxy '*'`。

费用未变：累计媒体仍 ¥13.50，本轮无新增购买、无在途/未知现金。下一步按用户要求用正式 UI 恢复原主片一次，只重做受影响的素材审查。

### R11 接管续测（22:3x 更新）：恢复链逐次归因、三处同源缺陷修复、构建与契约复验、一次受控返工

主片 `run-a7c42cc4-98de-4354-9dc9-c268b68b1446` 的 `asset-source-review` 共 7 次真实运行。按调用链逐次归因，四类问题分开陈述，不写"语义不符合"了事：

| # | 本地时间 | 耗时 | 结果 | 模型调用 | 归类 |
| --- | --- | --- | --- | --- | --- |
| 1 | 19:57:52→20:14:24 | 989s | 失败 HTTP422 `task_semantics` | 1 | 模型输出错误 |
| 2 | 21:07:18→21:27:26 | 1208s | 审片完成 `revise`，节点 `rejected` | 3 | **合同闸门**（`production-pipeline.ts:8930` 要求 `recommendation === "approve"`），不是缺陷 |
| 3 | 21:39:52→21:39:57 | 5.0s | 失败，无 attempt 产物 | 0 | 恢复错误（缺陷 A） |
| 4 | 21:52:51→21:52:55 | 4.0s | 409 `binding_conflict` | 0 | 恢复错误（B/C） |
| 5 | 21:57:47→21:57:50 | 3.0s | 409 `binding_conflict` | 0 | 恢复错误（C） |
| 6 | 21:58:13→21:58:15 | 2.9s | 409 `binding_conflict` | 0 | 恢复错误（C） |
| 7 | 22:03:43→22:22:24 | 1120.3s | 审片完成 `reject`，节点 `rejected` | produce 1 + audit 1，修复 0 | 受控复验 |

第 1 次是模型输出错误；第 2 次产出的报告在合同内完全有效，节点 `rejected` 是规定闸门，据此排除"提示词与校验合同矛盾"；第 3–6 次都是**传输/恢复错误**，`modelCallCount=0`，物理请求在代理处即被拒，模型一次都没被调用。

**缺陷 A（恢复期校验失败被伪装成服务故障）**：`restoreCheckpoint` 用宿主 `options.validate` 重新校验检查点内的候选，而审片报告是证据绑定的；帧重新生成后旧结论不再成立，校验抛的是普通 `Error`，不经 `failedLoopError` 包装，于是既不是 `RoleAgentLoopError` 也不是 `VisualReviewFallbackError`，落到 `production-pipeline.ts:8861-8865` 兜底分支，被报成"源素材视觉预检服务暂时不可用…请重试…或更换视觉审片模型"——**把确定性校验失败说成服务故障，并给出无效建议**。已改为标记该次拒绝，非"已受理未结清"的物理任务以 `fresh(cycle + 1)` 开新 cycle 重跑。

**缺陷 B（冲突只清 pending、不换身份，运行永久卡死）**：409 `binding_conflict` 表示该身份已被内容不同的历史任务占用；旧代码只 `clearPendingOperation`，generation 不变，每次重试都撞同一条 durable 记录。已改为 `stage === "conflict"` 时 `retireAcceptedOperation`（generation+1）后抛出，**不自动重发**，由操作者显式重试。

**缺陷 C（审片身份不绑定证据快照）**：物理请求身份由 `{scope, contractDigest, cycle, iteration, phase, generation}` 派生，而审片节点声明的输入只有素材方案与脚本**路径**；帧重新生成时路径不变、载荷已变，于是既回放绑定旧证据的旧结论，又与历史任务撞身份。这也是 B 修完后第 5、6 次仍冲突的原因。已改为在传给 agent loop 的 `contractVersion` 上追加 `|evidence:${evidenceSnapshotId}`（与既有 `|cycle:` 同一约定）。未改 `VISUAL_REVIEW_AGENT_CONTRACT_VERSION` 常量、未改评分门槛、未加题材特判、未删任何断言。

**证据集为什么会变（关键旁证）**：工作区 `src/video_factory/review_media.py` 有一处未提交改动（mtime 21:33，`git diff` 只有这一段）：全片预检原先固定每场只加两轮采样（每场 3 帧、共 15 帧），改为与试片共用同一笔 24 帧预算逐场轮转（场 1–4 各 5 帧、场 5 为 4 帧）。第 2 次审片证据在 21:07 生成（15 帧，`imageSetSha256 85968597…`）；第 3 次起为 24 帧（`26cb90ee…`）。这既解释了两次结论差异（稀疏采样只落在人物仍在画的时段，故判 satisfied），也正是缺陷 A 的触发条件、并证实缺陷 C 的必要性。详见 QA 资产 `checks/evidence-budget-change.md`。该改动只把没被用满的既有预算用满，未改上限、未改模型、未改思考强度、未改门槛。

**RED→GREEN（均不调用真实模型）**：`role-agent-loop.test.ts` 增 3 例（证据重生后重跑且 produce 请求 id 与旧的不同；已受理 pending 保留现场不被跳过；代理报身份冲突后换发新身份），第 3 例在移除 `retireAcceptedOperation` 后失败，恢复后通过，套件 42/42。`codex-visual-review.test.ts` 增 1 例（证据重生时以新身份重审；证据未变时回放已通过结论、不重复付费），移除 `|evidence:` 后失败，恢复后通过，套件 35/35。

**受控复验（同 run、不重买素材、不新建 run）**：22:02 构建（含 A+B+C）→ 22:02:56 重启 studio → 22:03:44 点击一次。得到全新 `requestId`（`agent-b7bea825…`）与新检查点摘要 `f564cec3…`，代理新建 `accepted` durable 记录，真实模型执行、`active=1`；**不再 409，也不再沿用历史身份**。反向对照：同样的点击在部署 C 之前连续三次（21:52 / 21:57 / 21:58）都是 409 `binding_conflict`、零模型调用。每次点击都有明确修正依据，未自动重发任何物理任务。

**复验的实际产出（真实结论，不是系统缺陷）**：produce 于 22:16 完成（`queueWaitMs=1`、`providerWaitMs=755687`、`modelAttemptCount=1`、`structuredRepairCount=0`、`finishReason=stop`、24 帧证据），产出 `recommendation=reject`、confidence 0.78、评分 composition 82 / continuity 52 / pacing 68 / legibility 88 / safety 93；5 条 findings 中 2 条 `critical` + `rework_asset`、1 条 `inspect_existing_media`、2 条 satisfied，全部指向场 1 母片（asset `441687379644690`）。已人工查帧独立复核：`scene-01-03.jpg`（源 3150 毫秒）画面只剩墙面、接缝与树影，**人物确已离画**；`scene-04-00.jpg`（源 5100 毫秒）与 `scene-04-04.jpg`（源 9900 毫秒）树影在墙面同一位置，4.8 秒内无跨缝移动。两条 critical 成立，本次审片是对**真实素材缺陷**的如实报告。证据 `docs/qa/.../checks/attempt-7-review-outcome.json`。

**构建与契约复验**：`npm run build` 退出 0，`npm run test:package` 3/3 退出 0（日志 `/tmp/vf-build-r11-takeover.log`、`/tmp/vf-test-package-r11-takeover.log`）。A/B/C 三处修复均已确认存在于 `packages/production-pipeline/dist`；最后一次源码改动 mtime 22:01:18，studio PID 33563 启动于 22:02:54，即**运行中的进程已经加载含三处修复的同一源码版本，无需再重启**。`tsc -p` 六个工程全部退出 0、无 `error TS`（`/tmp/vf-typecheck-r11-takeover.log`）；未在模型调用进行中重写 `dist`。

**费用与暴露复核（修正接管前的记录）**：接管前记的"在途 1 笔"不准确。逐 run 扫描后确认是 **2 笔**未结清：`assets:2026-09-14T10:16:51.214Z:16`（本片）与 `assets:2026-09-14T07:17:02.437Z:23`（同题更早的 run-25b4c195，早于接管轮），两笔都是 `seedance-video-v1` / `status: failed` / est ¥5 / `actualPending: true`，都在 1 秒内在供应商边界失败。全工作区 `actualCostCny 13.5`、`actualPendingCount 2`、`authorizedCostCny 36.5`。**已确认现金仍 ¥13.50；最坏情形暴露 ¥23.50**，仍在累计 ¥50 授权内。按约束不动这两笔历史记录，仅计入暴露。详见 `checks/pre-rework-exposure.md`。购买前只读确认两 Broker `active 0 / queued 0`、studio `/api/health` 正常。

**一次受控返工（产品自带路径，不是另建 run、不换题）**：主片被真实素材缺陷挡住，产品自身的处置建议是"调整导演方案或画面 Provider，重新报价并确认后再生成"。走正式 UI 入口"调整方案后重新制作"提交一次返工，新制作 `run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a`：`initialInput.rework.sourceRunId = run-a7c42cc4…`、`sourceRunRevision 27`（**与父片同一制作谱系，不是新建 run**），继承 `brief / script / visual-direction / visual-review`，`affectedScenePositions [1,2,3,4,5]`。第 5 镜为必改是因其 finding 的 `targetNodeIds` 含 `assets`（只调看、不新购），与对话框"审片明确要求的镜头不能移除"的规则一致；API 字段 `requiredAffectedScenePositions` 只列 `[1,2,3,4]`，比 UI 语义窄，属命名与语义不齐的低优先级观察，行为本身正确。提交本身不产生现金支出：新一轮先重新规划并逐项报价，购买前仍需人工确认。证据 `checks/step-13-*.log`、`checks/step-13-submitted-payload.json`、`screenshots/12a-rework-dialog.png`、`13a-rework-run-created.png`。

**尚未验证**：返工后的素材预检、配音（本片声音实际为 macOS `say` Tingting/rate185/pauseScale1/natural，**不冒称 MiniMax TTS**）、渲染、技术质检、同片由两个不同真实视觉模型复审、无关素材复用。PERF-R11-01 仍 `OPEN`。

### R11 接管续测（23:0x 更新）：配音默认值纠偏、返工 scope 合同矛盾的根因修复与重新部署

**先更正上一条记录中的一处错误结论（不是补充，是推翻）**：上一条写"第 5 镜为必改…行为本身正确，仅 `requiredAffectedScenePositions` 命名与语义不齐"。按调用链复核后该结论**不成立**，正确结论恰好相反：服务端给的 `[1,2,3,4]` 是对的，客户端把它扩成 `[1,2,3,4,5]` 才是缺陷，而这正是返工轮卡在导演闸门、模型编造 `EXISTING_ASSET_ONLY` 伪语法的触发原因。上一段保留在文档中作为过程记录，但以本节为准。

#### 1. 配音为什么走了 macOS `say` 而不是已配置的 TTS（用户提问的逐链归因）

结论：**MiniMax TTS 一直是可用状态，是本轮 run 的配音绑定被出厂默认值锁死，不是"没配 TTS"、不是供应商不可用、也不是运行环境缺依赖。**

只读证据（`harness/step-17-tts-availability-and-rework.mjs`、`step-17b-voices.mjs`）：

- studio 进程环境里 `MINIMAX_API_KEY` 存在且非空（`apps/studio` 侧读取，未回显任何凭据内容）；运行时依赖 `python/ffmpeg` 均为 true，`miniMaxTtsAvailable` 的前三个条件全部满足。
- `GET /api/providers`：`minimax-tts-v1` 为 `capability=voice.synthesize`、`available:true`、`status:"ready"`，模型 `speech-2.8-turbo` 可用。
- `GET /api/voices`：共 28 个音色，其中 minimax 引擎 9 个、macos 引擎 19 个。

根因链（三处叠加，全部在源码中读到，未靠猜测）：

1. `DEFAULT_CREATOR_SETTINGS.voiceDirection` 把出厂音色硬编码为 `macos:Tingting`（`apps/studio/src/server/creator-settings-store.ts`）。
2. 本运行环境没有 `settings/creator-settings.json`，服务端于是把出厂默认值当作"创作者的设置"交给对话框。
3. `NewRunDialog` 让 `creatorSettings.voiceDirection` 优先于唯一按可用性决策的 `defaultVoiceDirection(providers)`，而后者才会选 `minimax:Chinese (Mandarin)_News_Anchor`。因此在正常操作路径上，**偏好云端配音的默认分支永远不可达**；返工 run 又按创建时绑定继承 `macos-say-v1`。
4. 配音绑定只在创建时决定（`packages/production-pipeline/src/production-pipeline.ts:3435-3451` 读 `brief.providers.voice` + `brief.voiceDirection`），没有任何变更路由（`return_to_stage` 只接受 treatment/script），所以创建后不可改。

修复（按用户在两个选择项上的决定实施）：默认策略改为**已配置云端 TTS 时优先**；本轮主片**沿用 macOS `say`**（不改本轮绑定，不重跑已完成的阶段）。改动为把出厂音色提取为具名常量 `DEFAULT_STUDIO_VOICE_DIRECTION`（`apps/studio/src/shared/api.ts`），`creator-settings-store.ts` 复用它，`NewRunDialog.tsx` 新增 `creatorVoiceIsShippedDefault()`：只有当设置值**逐字段等于出厂值且未被标记为自定义**时才让位给 `defaultVoiceDirection(providers)`；任何真实选择（如已改成 `macos:Meijia`）或自定义标记仍然优先。没有删除任何断言、没有降低质量门槛、没有加题材特判。

RED→GREEN：新增用例 `prefers a configured cloud voice over the shipped macOS default`，撤回修复时 1 failed | 18 skipped，恢复后 19 passed。全量：studio vitest 19 文件 / **401 用例全通过**（原 400 + 新增 1）；`node --import tsx --test test/studio-service.test.ts test/api-contract.test.ts` 137/137；`tsc -p tsconfig.server.json` 与 `tsc -p tsconfig.client.json` 均 exit 0。

#### 2. 返工轮卡在导演闸门的根因：提示词与校验合同矛盾，触发器是客户端的 scope 推导缺陷

现象：返工 run `run-e204cd6c-2365-4cda-bb1d-c50e6e69bb8a` 连续两次 `confirm`（reviewRevision 45→46→47）都被独立 `check` 判 `verdict:"repair"` 并重新开闸，证据是"场5使用了合同未声明的既有素材绑定语法"。

**归类：提示词与校验合同矛盾（不是模型输出错误，不是传输/恢复错误，不是测试问题）。** 依据是下面四条互相独立的证据：

1. **模型在三次连续尝试里给出同一结果**（`nodes/creative-planning/attempt-2|3|4/director-draft-r2.json`）：场 5 全部是 `preferredProviderId:"pexels-stock-v1"` + `deliveryType:"stock_video"` + `query:"EXISTING_ASSET_ONLY scene 5；先检查源4.5秒至结尾完整连续片段"`。三次取样一致说明这是对合同的确定性反应，不是采样噪声。
2. **它被要求做的事情没有可表达的方式**。assets 指令对场 5 写的是"先补查已有素材，不进入新购买"，同时 `affectedScenePositions` 把场 5 标成本轮必须重做。而合同里唯一的"用已有素材"语法是 `REUSE_ONLY scene N` / `reuseFromScenePosition`，它只能指向**同一方案中更早的镜头**（`packages/production-pipeline/src/generative-asset-worker.ts:1908` 明确对 `reuseFrom <= 自身` 抛错），无法绑定上一版 run 已生成的母片。于是模型只能编一个 token。
3. **触发原因是客户端把"只要求补查"的 finding 扩成了强制重做范围**。服务端 `recommendedReworkScenePositions` 在 `apps/studio/src/server/production-studio.ts:3833` 显式 `if (finding.action === "inspect_existing_media") continue;`；执行层两处投影（`generative-asset-worker.ts:1305`、`production-pipeline.ts:3413`）同样排除它。但客户端 `NewRunDialog.tsx` 的 `defaultReworkScenePositions`（预选）与 `requiredScenePositionsForRework`（必改）都没有这个过滤。部署前实测：第 5 镜复选框 `checked=true, disabled=true`（必改不可移除），摘要"本轮选择 5 个镜头：1、2、3、4、5"。**操作者在 UI 上无法取消它**，所以这不是操作者误选。
4. **范围一旦包含场 5，宿主就不再逐字继承它**。`codex-visual-director.ts:369 mergeReworkCandidateShots` 的语义是"未受影响镜头由宿主程序逐字继承"；场 5 在 affected 集合内，于是走模型输出，上一版场 5 的真实母片（`hailuo-video-v1` / `generated_video`）被丢弃并改道到 `pexels-stock-v1`。

修复：新增 `isInspectionOnlyReworkFinding()`（`apps/studio/src/client/components/NewRunDialog.tsx`），在上述两个函数里与服务端范围推荐、执行层投影使用同一口径跳过 `action === "inspect_existing_media"` 的 finding。未改任何校验、评分、超时或重试语义；场 5 的 finding 与"先调看源 4.5 秒至结尾"的建议原样保留。

RED→GREEN：新增用例 `keeps an inspection-only finding out of the mandatory rework scope`，修复前失败输出与线上症状逐字一致（`checked="" disabled=""`），修复后通过。全量 studio vitest 401/401。

**重新部署与线上复验**：`npm run build --workspace @video-factory/studio` exit 0（22:50），随后仅重启本轮 studio 服务（PID 33563 → 54660，22:50:59，`Server listening at http://127.0.0.1:4319`），两 Broker 未动。用修复后的客户端对同一源 run 做只读复验（`harness/step-19-rework-scope-recheck.mjs`，证据 `checks/step-19-rework-scope.json`）：第 5 镜 `checked:false, disabled:false`，摘要"本轮选择 4 个镜头：1、2、3、4"，"其余 1 个镜头计划沿用：5"，控制台 0 错误。

**一次受控复验（同源 run、同 findings、不换题、不另立成功线）**：以修复后的默认范围提交，新制作 `run-b0468e64-2815-46e6-b837-7cf1bfafa389`，`initialInput.rework.sourceRunId = run-a7c42cc4-98de-4354-9dc9-c268b68b1446`、`sourceRunRevision 27`，`affectedScenePositions [1,2,3,4]`，findings 三条与父片完全一致（场 1/4 `replace_asset`、场 5 `inspect_existing_media`），配音按本轮决定仍为 `macos-say-v1` / `macos:Tingting`。提交本身不产生现金支出。被卡住的 `run-e204cd6c` 原样保留在磁盘作为证据，未删除、未批准、未重试。

**新记录的开放观察（不是本轮阻断项）**：场 5 的 `inspect_existing_media` finding 来自 `source_assets` 阶段，而产品目前只有 `POST /api/runs/:runId/reinspect-visual-review`（对应 `visual-review` 的成片审片），**没有**针对 `asset-source-review` 既有素材的补查入口（`packages/production-pipeline.ts:3002 dispatchVisualReinspection` 只接受 visual-review 的 delivery 与 evidenceId）。因此"先完整调看源 4.5 秒至结尾"这一要求在产物上没有对应的可执行路径，只能靠素材节点重跑时的既有采样策略。本轮按"记录具体原因和证据、继续其他独立可测项"处理，不以此放宽任何审片门槛。

**尚未验证**：复验轮导演闸门的独立 check 结论、素材预检、配音、渲染、技术质检、同片由两个不同真实视觉模型复审、无关素材复用。PERF-R11-01 仍 `OPEN`。

### R11 接管轮补充记录：缺陷 F、G、H 的定性与取证

（本节补齐此前只存于过程记录、未落盘的三个编号；同时修正一处先前结论。）

#### 缺陷 F：返工审计没有可比对的基线，凭空指控"擅自换成付费生成路线"

**归类：合同/协同缺陷（不是模型输出错误）。** 现象是返工轮的独立审计声称场 5 被改成新的付费生成路线，而场 5 实际按宿主规则逐字继承了上一版母片。

根因：`visualDirectorAuditContext` 只拿到经 `directorInputForModel` **收窄后**的 `brief.rework`。收窄对生产模型是必要的（只该看受影响镜头），但审计被同样收窄后就没有 `previousDirectorPlan` 这个基线可用，"其余镜头逐字继承"这条要求便无从核对；审计只能拿上游 `scenes[].visualStrategy` 反推既有路线——那是素材获取建议，可能已被上一版导演方案取代——于是把逐字继承的镜头误判成擅自改路线。

修复：审计上下文改传**未经收窄**的原始 rework（`packages/production-pipeline/src/codex-visual-director.ts:137`），函数内提取 `reworkBaseline = sourceRework.previousDirectorPlan` 并注入 `previousDirectorPlan`（同文件 `:434-455`）。未改评分门槛、未删断言、未加题材特判。

验证：RED→GREEN（撤回修复即复现）。生产复验：同一审计、同一 candidate，修复后不再指控换路线，并明确写出场 5 保留原 Provider / deliveryType / 既有素材。

#### 缺陷 G：check 模式仍可改写方案（复核与生产共用同一多轮迭代预算）

**归类：合同缺陷。** 创作闸门的独立复核以 `mode=check` 与生产草稿 `mode=draft` 共用 agent loop 的 `maxIterations`，复核因此保有迭代空间去**重写候选**——把"检查当前方案"变成"再产一版方案"，于是同一个闸门可以被反复重新开闸。

修复：`packages/production-pipeline/src/codex-visual-director.ts:120-123` —— `maxIterations: input.creativeReviewExecution ? 1 : this.maxReviewIterations`；`mode=draft` 时 `deferAudit: true`；`mode=check` 时以既有 candidate 作为 `initialCandidate`，复核只判不改。该修复随导演角色合同 `director-v31 → v35` 一起部署。

验证：源码形态已核实（见上引行号）。生产复验的完整结论取决于新起端到端制作的闸门表现，见后续记录；在此之前按"已修、生产未复验"计，**不记为已通过**。

#### 缺陷 H：同 digest 复用的规划线程在真实输入漂移时 fail-closed —— **判定为不是缺陷**

现象：主片第 3 次 `confirm` 报
`Creative planning cannot resume this thread: the real inputs of a planning stage (asset catalog, runtime models, or role bindings) changed while the planning input stayed the same.`

**归类：不是缺陷；是设计上的 fail-closed。** 逐条排除：不是模型输出错误（模型未被调用）；不是提示词与校验合同矛盾；不是传输/恢复错误（无 409、无重放）。真实原因是**接管者在 run 进行中重新部署**：导演角色合同 `director-v31 → v35`（`packages/production-pipeline/src/codex-visual-director.ts:37`）在 15:23:54Z 被换掉，而 run 记录的 executionSeq 8 由旧进程于 15:18:54Z 写入，新 studio 起来 18 秒后第 3 次 confirm 即失败。

判据：该 guard 被仓库自带回归钉住 —— `production-planning-closure.test.ts` 的 "same-digest replay fails closed when stage inputs drift (B-FIX)" 断言 `assert.equal(spies.directorCalls, 1, "the drifted thread must not silently replay or re-run planning")`。我一度实现"漂移即作废并重跑导演阶段"，会使该断言变成 2，即把 fail-closed **降级为 fail-open**，被要求 3 明确禁止；已逐处回退，回退后残留引用为空、`tsc --noEmit` 退出 0、`production-planning-closure.test.ts` 26/26 通过。

结论：**保持 fail-closed，不放宽**。合同 `v31 → v35` 携带本轮真实合同变更（`assertPlanningRevisionScope`、`maxIterations`/`deferAudit`/`initialCandidate`、审计基线、voiceTiming/articleSources），不能为恢复可续跑而回滚。

**保留的操作面观察（开放项，不是本轮阻断）**：该 guard 给出的补救是"编辑规划输入以开启新的规划线程"。对已进入终态的 run，通用节点编辑路由（`PUT …/nodes/creative-planning/input-override` 与 `…/execution-configuration`）都要求 `confirmTerminalEdit: true`，而**界面上没有对应入口**。即：中途重新部署会让在跑的 run 失败，而失败信息指向的补救动作在 UI 上不可达。按"记录具体原因和证据、继续其他独立可测项"处理。

#### 缺陷 I：复核判定 repair 后主按钮仍可点击，唯一结果是同一份草稿的同一结论

**归类：界面与流程状态不一致（真实缺陷）。** 在 `checkResult.verdict === "repair"` 状态下，面板已显示"有 N 处需要调整，尚未进入下一步"，但主按钮仍是"确认当前方案，继续"且可点击。此时点击的唯一后果是按**同一份草稿**重跑一次独立复核，回到同一个 repair —— 推不动流程，却要消耗一次付费复核。这解释了主片上观察到的连续三次确认、`reviewRevision` 44→45→46 而草稿 sha 未变。

判据：`packages/production-pipeline/src/creative-review.ts:318` 的不变量 `checkResult: sameDraft ? current.checkResult : null` —— 草稿一变必然清空 `checkResult`，所以在场的 repair 一定针对当前草稿；而 `confirmCreativeDraft` 硬性要求 `verdict === "pass"`。两点合起来使该点击必然无进展。

修复：`apps/studio/src/client/components/CreativeDiscussionPanel.tsx` 新增 `awaitingRepair = review.checkResult?.verdict === "repair"`，主按钮在此时禁用并把文案改为"先按上面的意见调整"。

RED→GREEN：`apps/studio/test/creative-discussion-panel.test.tsx` 新增 2 例（repair 在场时确认按钮不存在且替代按钮禁用；repair 不在场时确认按钮可用），`npx vitest run test/creative-discussion-panel.test.tsx` **8 passed**（原 6 + 新 2）。未改任何校验、评分、超时或重试语义。

#### 本轮基线与构建复核

- 生产链路回归（不调用真实模型）：`node --test --import tsx packages/production-pipeline/test/*.test.ts` → **765 用例 / 764 通过 / 0 失败 / 1 跳过**，exit 0。
- `tsc -p apps/studio/tsconfig.server.json --noEmit` 与 `tsc -p apps/studio/tsconfig.client.json --noEmit` 均 exit 0。
- `npm run studio:build` exit 0；仅重启本轮 studio 服务（PID 68107 → 75915，2026-09-14 23:42:23），两 Broker 未动。

#### 模板（template）在当前代码中的实际状态 —— 与"早已去掉"的印象不符

新制作**确实不再走模板**：创建路径 `apps/studio/src/server/production-studio.ts` 对 `template` 无任何引用（除可选 `templateSnapshot`）；`packages/production-pipeline/src/contracts.ts:351` 的 `templateSnapshot?` 为可选，仅历史 run 携带；`packages/template-core/src/types.ts` 的 `TemplateCostPolicy` 注释写明"仅用于读取历史模板。费用控制已经移到每次真实报价后的人工授权"。

但代码面并未拆除：`/templates` 页面（`apps/studio/src/client/App.tsx:33`）、`/api/templates` 及 8 条 CRUD 路由（`apps/studio/src/server/app.ts:232-288`）、`template-store.ts` / `template-catalog.ts` / `template-studio.ts`、整个 `packages/template-core/` 仍在。它们现在是**不参与生产链路的残留面**，不阻断端到端，但需要决定是拆除还是明确标注为历史兼容。原概念为分层制作模板（`TemplateLayer = system | platform | template | series | run | node`），含叙事节拍、镜头槽位、视觉/声音系统、质量规则与费用策略；其费用角色由**配方 recipe**（`economics.recipeId`）+ 逐次报价授权接管。

### 端到端续跑：操作员角色与 treatment 闸门处置（run-f8e2635f）

**角色约定（操作员口径）**：这条 run 由我以**操作员身份**在闸门上做决定——不是"新增人工环节"，闸门本来就是设计给人在此决策的入口（三阶段各一个：treatment / script / director，动作 `discuss | adopt_proposal | undo_draft | return_to_stage | confirm`）。我不新增流程、不改代码实现，只按已有 UI 动作做决策并留证。

**链路事实（新建制作的真实起点）**：`run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08`，`runPurpose: production`，无 `rework`。第一道闸门为 `stage=treatment`（不是 `director`），确认新的制作确实从构思起点开始。node 链为 `brief → creative-planning → assets → voice → render → technical-review → visual-review → final-review → publish-package`；三个阶段都在 `creative-planning` **一个节点内部**。

**treatment 闸门第 1 次阻断的完整归因（不是猜）**：

- 现象：gate1 `stage=treatment rev=1` 无 `checkResult`；点"确认当前方案，继续"后，gate2 出现 `rev=2`、`checkResult.verdict=repair`、`score=74`、1 条 blocking，而两版 **`draftSha256` 完全相同**（`2996c19c…`）。
- 第一层解释（设计行为，非缺陷）：`codex-creative-treatment.ts:206` 的 `deferAudit`（缺陷 G 的修复）使 draft 模式先出稿、审计延后；用户点确认才触发那次独立复核。因此"确认"不是无效果，而是**确认触发的那次复核判了 repair**，流程按设计停在原地。主按钮 `disabled=true` 是缺陷 I 的修复在生产生效。
- 第二层解释（阻断内容）：候选 treatment 的 `evidenceRequirements` 有 7 条，其中 `beatId=half_pause`、`claim="若画面中的脚步、车流或街区声被呈现为同期声，其来源必须能确认属于对应原片。"` 被标为 `factual_support` + `critical: true` + `acquisition: "external_required"`。宿主 `treatment-readiness.ts:34,36` 对该组合**无条件**判阻断（生成 `treatment-readiness-5`），独立审计读取 `hostReadiness` 后如实引用。
- 第三层解释（根因，逐层核对后确认）：该条内容是**创作边界声明**（"不以别处音效冒充现场记录"），而角色指令 `task-definitions.ts:173` 明确写着「边界声明本身不是 factual_support」「不自动升级为外部来源要求」，第 174 行又明确 `external_required` 只用于**流水线不能取得的用户专属实验或拍摄**。**模型同时违反了这两条明确指令。**
- 对照证据：同一简报下，原始主片 treatment 仅 5 条 `evidenceRequirements`（5 个 beat 各 1 条），全为 `illustration_only` + `pipeline_retrievable`/`not_needed`，且把同一约束正确处理为 `soundPrinciples` 的**退路句**（"若无法混合素材同期声…不虚构可听见的环境声"），因此 0 条 `external_required`。本次模型把同一约束错误归档进 evidenceRequirements 并标成核心外部依赖。简报逐字段比对除 `creationContext`（我剥离的来源标记）与 `taskContractDigests`（服务端重新计算）外**完全一致**。
- **定性：模型输出错误（指令遵循失败），被宿主确定性合同正确拦下、被独立审计如实引用。不是产品缺陷，不是提示词与校验的矛盾，也不是传输/恢复错误。** 结论是**此处不改任何代码**——去松动 `treatment-readiness` 才是"降低质量门槛过关"。
- 自我更正：本段一度判断"提示词未说明 `external_required` 语义"，属**错误结论**。错因是只查了 `treatmentPayload`（仅装 brief/suppliedSources/referenceGrammar），漏看指令经 broker 的 `task-definitions.ts` 下发这条路径。已核对第 173/174 行后更正。

**操作员决定与结果**：在 treatment 闸门以 `discuss` 动作提交决策（命令 `d2e8aa02-4b44-4788-bca9-c65ee6b6cd61`，75 秒完成）：本片不承诺可听环境同期声，要求把该条从 `evidenceRequirements` 移除、把边界并入 `soundPrinciples`。模型返回修订稿 `f2e884c6…`，改动为：`evidenceRequirements` 7→6 条且**该条已删除**（其余全为 `illustration_only` + `pipeline_retrievable`/`not_needed`）；`soundPrinciples[1]` 改为"本片不使用可听的环境同期声，也不以另配的脚步、车流或街区音效冒充现场记录"；**并额外修正了真正的过度承诺** `soundPrinciples[2]`（原"前段保留通勤声压…突出更近、更轻的环境细节"→"前段旁白略紧，注意力转向后拉开句间停顿"）。其余 beat、观众承诺、事实边界未动。新稿 `checkResult` 按 `creative-review.ts:318` 自动清空，随后点确认触发新稿上的独立复核。

**本轮新记的流程问题（真实存在、未修，与本条 run 的阻断无关）**：

1. **闸门未告知"确认"的真实语义。** 首屏文案是「导演方案已生成，等你确认」「确认只检查当前版本，不会购买素材」，但没有说明**确认会触发一次独立复核、该复核可能驳回、驳回后仍停在同一份稿上**。现场表现即为：点了确认没有任何进展，只是多出一条此前未展示的意见。对必须在此做决策的操作员，这是信息缺失。
2. **驳回后没有结构化补救动作。** 本次阻断的本质是"某字段被错误分类"，但闸门只提供自由文本讨论框，只能以自然语言描述，无法表达"把这条从 A 类移到 B 类"。人来操作勉强可行，代价是每轮多消耗一次模型调用。
3. **模型违反明确指令后没有有界自动重做。** `codex-creative-treatment.ts:206` 在创作复核路径将 `maxIterations` 钉死为 1（缺陷 G 的修复：独立复核不得改写候选），因此不存在"把 hostReadiness 回喂生成方自动重做一次"的路径。这是**有意的取舍**（复核不得悄悄改稿，改不改由人定），代价是每次指令遵循失败都必须停下等人。是否有界放开属产品决策，未自行更改。
4. **已核实不成立、予以撤回**：曾判断 `inspect_existing_media`（"补查已有素材"）没有执行入口。实为有：`RunWorkbench.tsx:305` 在 `pendingInspectionCount > 0` 时提供按钮，走 `POST /api/runs/:id/reinspect-visual-review`。

**操作员决定的事实依据（独立复核，非从权）**：该决定"本片不承诺可听环境同期声"由两条独立证据支持——①本条 run 的 `providers.voice = macos-say-v1`，只有旁白 TTS；②`src/video_factory/renderer.py:775-782` 的 `render_audio_input` 只返回旁白音轨或 `anullsrc` 静音，**素材片源自带音频从不进入渲染**。即流水线在能力上确实无法产出可听的环境同期声，因此该边界声明必须落在 `soundPrinciples` 而不是 `evidenceRequirements`。这不是为通过闸门而降低要求。

**下一个花钱关口（预判）**：`economics.recipeId = "keyshot-ai"`、`allowMeteredProviders: true`、`providers.assets = "ai-shot-router-v1"`，因此 `assets` 节点会按镜头给出真实报价。`budgetIntentionCny = 35` 是费用意向而非付款授权。本条 run 为全新制作、无 `rework`，**不复用已归档母片**，需自行采购。读到报价后先核对是否落在剩余额度内再决定。

**费用与现场**：本条 run 至今 `spendAuthorizations` 为空、无 `production-quotes`，未产生任何现金。已付费母片所在的 `run-a7c42cc4` / `run-25b4c195` 按操作员决定**移出工作区归档**至 `.local/archive/qa-r11-superseded-20260914/`（14M，可 `mv` 回），未做不可逆删除——因母片仅存于此、工作区无共享媒体库。当前累计已确定现金仍 ¥13.50，最坏 ¥23.50。

### treatment 第 2 次阻断：我上次的指令错了，以及由此暴露的设计缺陷 J–N

**自我更正（重要）**：第 2 次独立复核判 `repair`（score 76），宿主确定性阻断项 **0**。复核意见是"上游 visualPlan 采用同期环境声，候选却规定不使用可听的环境同期声，形成直接冲突"。我核对上游后确认：**复核是对的，我错了。** `brief.visualPlan.strategy` 原文即写着「人物、街区细节与**同期环境声**」（`run.json` → `initialInput.visualPlan.strategy`），而我在 R3 那次 discuss 里让模型写"本片不使用可听的环境同期声"，等于让产物与上游对着干，且当时**没有核对上游就动手改**。R2 阶段模型把该约束标成 `external_required` 被宿主拦下，与这一条是同一根因的两面。

**操作员处置（`run-f8e2635f`，R4）**：命令 `4c807cd1-0673-42e5-9805-29f558fd4627`，16:14:27 completed。新稿 `attempt-5/treatment-draft-r3.json`，`soundPrinciples[1]` 改为：

> 本片不产出可听的环境同期声，也不以另配的脚步、车流或街区音效冒充现场记录；声音只由旁白及其停顿节奏构成。**这是对上游 brief.visualPlan.strategy 中"同期环境声"一项的已知偏离，原因是当前流水线只支持旁白音轨。**

即**在稿面上记录偏离**，而不是靠删除上游要求来消除冲突。依据仍是 `providers.voice = macos-say-v1` 与 `renderer.py:775-782`（`render_audio_input` 只接旁白音轨或 `anullsrc`，源片音轨从不进渲染）——复核给的 A 分支"保留并核验素材原始同期声"在当前流水线不可实现。

#### 本轮新确认的设计缺陷（J–N，均有代码或现场证据）

| 编号 | 缺陷 | 证据 | 状态 |
| --- | --- | --- | --- |
| **J**（根因） | 上游输入可声明流水线不具备的能力，创建/简报阶段**无任何对账** | `brief.visualPlan.strategy` 写"同期环境声"；`renderer.py:775-782` 证明渲染器不接源片音轨；`providers.voice = macos-say-v1`、`musicTrack=false`、`soundEffectsTrack=false`。模型于是被逼进死角：照做→被宿主拦，违背→被审计拦 | **未修**（需产品决策：在创建阶段做能力对账，或在闸门记录偏离） |
| **K** | 审计裁决是"否决"而非"提议" | `creative-review.ts` `confirmCreativeDraft` 原先硬要求 `checkResult.verdict === "pass"`，否则抛错；命令契约仅 `confirm/discuss/adopt_proposal/undo_draft/return_to_stage`，**无 override** | **已修（RED→GREEN）** |
| **L** | 闸门未告知"确认"的真实语义 | `CreativeDiscussionPanel.tsx` 原文案「确认只检查当前版本，不会购买素材」，未说明确认会触发独立复核、复核可能驳回、驳回后仍停在同一稿 | **已修** |
| **M** | 驳回后没有结构化补救动作 | 只有自由文本框；`api.ts` 的 `discuss` 已带 `selection` 可表达"针对哪一条"，但缺"做什么操作" | **部分修复**：每条意见旁给"按这条意见改 / 这条我不同意"，**预填不发送**；完整的"结构化字段操作"仍需复核输出携带机器可读目标 |
| **N** | 无法记录"操作员批准了对上游输入的偏离" | treatment 文档字段仅 `version/viewerPromise/hook/progression/payoff/visualPrinciples/soundPrinciples/evidenceRequirements/feasibilityQuestions`，无承载偏离之处；本次只能写进 `soundPrinciples` 散文 | **未修**（K 的 `acknowledgedRepair` 只覆盖复核裁决，不覆盖上游偏离） |

**另一条机制性问题（非缺陷，待缓解）**：`discuss` 返回**整份新稿**而非定点补丁，且稿子一变 `checkResult` 即清空（`creative-review.ts:318`，本身正确）。因此每轮都可能冒出新问题且无法累积进度——这是"反复打回"的机制来源，不是同一个问题回归。缓解方向：把复核意见的字段路径变成范围约束，由宿主校验 diff 越界即 fail-closed。

#### K/L/M 的实现与验证

- **K（领域层）**：`CreativeReviewConfirmResume` 增 `acknowledgeRepair?: true`；`confirmCreativeDraft` 改为"检查存在且与当前草稿匹配"即放行，`verdict !== "pass"` 时要求显式 `acknowledgeRepair`；`CreativeStageConfirmation` 增 `acknowledgedRepair: { verdict, score, issueCount }` 留痕。沿用既有 `return_to_stage`/`acknowledgeImpact` 的显式承担模式，未发明新机制。
- **K（客户端）**：`parseStudioCreativeReviewCommandInput` 增该字段；面板 `awaitingRepair` 不再禁用主按钮，改文案为"看过意见，仍然确认"，点击先经 `window.confirm` 说明后果，并带上 `acknowledgeRepair`。
- **L**：首屏文案改为明说"确认会按当前这一版做一次独立复核；复核通过才进入下一步；复核提出意见时会停在同一份方案上"。
- **M**：`creative-check-result` 每条意见旁新增两个按钮，把复核自己的 `criterion`/`repairInstruction`/`evidence` 组好预填进输入框（含"不要扩大改动范围""如有多分支取最保守一支"），**只预填不发送**。
- **验证**：`packages/production-pipeline/test/creative-review.test.ts` **10/10 通过**（新增用例 `treats the independent check as advice: repair blocks by default but can be explicitly acknowledged`，先 RED：`Creative review resume field 'acknowledgeRepair' is not allowed.`）；`apps/studio/test/creative-discussion-panel.test.tsx` **9/9 通过**（原缺陷 I 的用例断言的是旧行为，已改写为新契约，非删除断言）；`tsc` server/client/pipeline 三个 tsconfig 均 exit 0。
- **未部署**：以上改动**尚未 build、未重启服务**。理由是缺陷 H——中途更换 studio dist 会把在跑的 run 判 fail-closed。构建与重启安排在 `run-f8e2635f` 到达终态之后。

### 端到端续跑：规划三阶段通过 → 方案报价 → 第一笔真实媒体授权（run-f8e2635f）

#### 规划闸门完整历史（由 `run.json` 的 `creativeReviewOperations` 与 `outputState.versions` 还原，非推测）

| 接受时间 (UTC) | 动作 | stage | 结果 |
| --- | --- | --- | --- |
| 15:51:10 | confirm | treatment | → `repair(74)`，第 1 次阻断 |
| 16:02:20 | discuss | treatment | R3 我的**错误指令**（见上节自我更正） |
| 16:03:59 | confirm | treatment | → `repair(76)`，第 2 次阻断；宿主确定性阻断项 **0** |
| 16:13:41 | discuss | treatment | R4 **更正指令**：把偏离写进稿面而非删上游要求 |
| 16:15:31 | confirm | treatment | completed 16:19:40 → **`pass(95)`** |
| 16:19:44 | confirm | script | completed 16:32:25 → **`pass(96)`，`issues=0`** |
| 16:32:43 | confirm | director | → `creative-planning` **succeeded** |

最终确认态（从 `outputState.versions` 读出）：`treatment=confirmed/pass(95)`、`script=confirmed/pass(96)`、`director` 阶段随节点成功结束。节点终态：`brief=succeeded`、`creative-planning=succeeded`、`assets=awaiting_spend_approval`，`run.status=awaiting_spend_approval revision=7`。

#### 导演方案实际内容（7 个镜头，`blockingIssues=0`）

| 镜头 | 路线 | provider | 计入报价 | 估价 |
| --- | --- | --- | --- | --- |
| 1 | generated_video | seedance-video-v1 | 是 | ¥5 |
| 2 | generated_video | seedance-video-v1 | 是 | ¥5 |
| 3 | generated_video | hailuo-video-v1 | 是 | ¥2 |
| 6 | generated_video | seedance-video-v1 | 是 | ¥5 |
| 4 / 5 | stock_video | pexels-stock-v1 | 否 | ¥0 |
| 7 | generated_video | seedance-video-v1 | 否（复用 #1 同一母片的不同区间） | ¥0 |

`libraryRoute = brief.workflowFeatures?.assetSemanticRank === true`（`production-pipeline.ts:4779`）为 **true**，即本 run 走的正是本轮要求的"候选素材库 + 语义排序 → 复用"路线，`planning-history.json` 的 `stageInputs.rank`、`candidateSearchPath` / `candidateRankingPath` / `candidateInventoryPath` 均由此产生。

#### 购买前预算重核（按**工作区**分账，不是全盘求和）

全盘求和会得到毫无意义的 ¥68.50——那会把**本轮授权之前的既有历史工作区**算进来。`¥50` 授权是"本轮累计"，必须按工作区分开：

| 工作区 | runs | 已发生 | 在途 | 是否本轮口径 |
| --- | --- | --- | --- | --- |
| `live:factory`（历史） | 74 | ¥55.00 | ¥2.10 | **否**，本轮授权之前 |
| `live:qa-r11-20260914-001` | 1 | ¥0 | ¥0 | 是（无花费） |
| `live:qa-r11-repair-20260914`（本 run 所在） | 2 | ¥0 | ¥0 | 是 |
| `archive:…/run-a7c42cc4` | 1 | ¥9.50 | ¥5.00 | 是 |
| `archive:…/run-25b4c195` | 1 | ¥4.00 | ¥5.00 | 是 |

**本轮口径**：已发生现金 **¥13.50**（与交接时的 ¥13.50 逐分吻合）＋ 在途最坏 **¥10.00** ＝ **¥23.50**，¥50 授权**余 ¥26.50**。

两笔未结清经逐条核验：均为 `billing=metered`、`status=failed`、**从未写入 `actualCostCny`** 的历史回执（`estimatedCostCny=5` 各一），归属 `run-a7c42cc4`（finishedAt 14:22:24Z）与 `run-25b4c195`（finishedAt 08:17:55Z）。按最坏全额预留。

**在途/未知任务**：`openai/tasks/.video-factory` 与 `zai/tasks/.video-factory` 下**无**媒体任务；运行中进程仅本轮的 1 个 studio + 2 个 broker。无未知暴露。

核对口径仍是 **`maximumCostCny`（授权上限）**，不是 `estimatedCostCny`——界面文案本身写着"授权额是上限，不是目标"。

#### 一处**我自己的测试脚本错误**（澄清，非产品缺陷）

我先前用 `GET /api/runs/:id/production-quotes` 拉报价，得到 `404 {"error":"API route was not found."}`，一度记为"报价接口 404"。核对 `apps/studio/src/server/app.ts:579`：该路由是 **`POST`**，GET 命中 Fastify 默认 404。**这是我的方法错误，不是产品缺陷**；报价由客户端在节点进入 `awaiting_spend_approval` 时 POST 生成。此前"`production-quotes` 目录不存在 = 报价未落盘"的推断一并作废——报价不落盘在该目录，它经由 `POST` 实时签发。

同理，先前记的"`creative-review` 接口 404"也已核清：`app.ts:467` 在 `node?.status !== "needs_human"` 时返回 404 文案「这条制作当前没有等待讨论的创作方案。」（`production-studio.ts:1431` 的 `intervention.kind === "creative_review"` 守卫）。复核进行中的节点是 `running`，故 404 是**设计内行为**。

#### 闸门实际形态（两阶段流）与操作员复核

界面不是"一个按钮直接付钱"，而是**两阶段**（`NodeWorkspace.tsx:318-358`，注释即写明「prepare 不授权，accept 不重算价」）：

1. 首屏：`本次最高授权额（元，可不填）` 输入框（placeholder 默认 ¥17.00）+ 「获取费用报价」。`disabled` 条件含 `!acceptedPlanDigest`。
2. 点击后 → `POST /production-quotes` 取回**服务端不可变报价**并展示。
3. 操作员看到金额后才可点「确认并授权（最高 ¥X）」→ `POST /production-authorizations`（带 `quoteId` + `acceptedPlanDigest` + `idempotencyKey`）。

**现场捕获的服务端报价**（截自 `checks/step-r7-spend-gate.txt`）：

```
预计费用 :: ¥17.00
最高授权 :: ¥17.00
制作内容 :: 城市微光：匆忙之中重新看见日常｜做一支20–35秒的竖屏短片…｜面向忙碌的城市上班族
镜头 1 :: ¥5.00 · 最多 1 次 · Seedance 2.0 Mini
镜头 2 :: ¥5.00 · 最多 1 次 · Seedance 2.0 Mini
镜头 3 :: ¥2.00 · 最多 1 次 · MiniMax H3
镜头 6 :: ¥5.00 · 最多 1 次 · Seedance 2.0 Mini
不确定项 :: 实际结果仍需素材预检、技术质检和双模型审片。
```

**操作员逐条复核**：金额 ¥17.00 ≤ 余 ¥26.50 ✓；四个付费镜头与导演方案逐条一致 ✓；镜头 4/5/7 为 ¥0 故不入报价 ✓；不确定项如实披露后续质检环节 ✓。**决定：批准。**

**授权落地证据**（`run.json` → `spendAuthorizations[0]`）：

| 字段 | 值 |
| --- | --- |
| `id` | `spend-authorization-bd6bef3f-25e3-4a56-af12-a363c7483d11` |
| `maxCostCny` / `maxAttempts` | ¥17 / 1 |
| `derivedFromScopeId` | `auth-d6ef90f499e8cddf209060df562265ad` |
| `itemCreateBudgets` | `{scene-1:1, scene-2:1, scene-3:1, scene-6:1}` |
| `approvedBy` | `qa-local（制作范围授权 auth-d6ef90f499e8cddf209060df562265ad）` |
| `approvedAt` | 2026-09-14T16:36:55.993Z |

授权后 `run.status` `awaiting_spend_approval` → **`running`**（revision 7 → 9），`assets` 节点由 `awaiting_spend_approval` → `running`，`spendAuthorizationId` 已挂上节点。报价→授权的溯源链（`derivedFromScopeId`）完整。

#### 新记的可用性缺口（候选，未定性、未修）

**报价只列付费镜头，不列免费镜头。** 本片 7 个镜头中，镜头 4/5（`pexels-stock-v1`）与镜头 7（复用 #1 母片区间）费用为 ¥0，因此在 `.spend-quote-summary` 中**完全不出现**。操作员看到"制作内容"写的是整片，但清单只有 4 条，无从在闸门上确认另外 3 个镜头"有人管、且确实免费"。这不阻断授权（我另有 `director_plan.json` 可核对），但对只看闸门的操作员是信息缺口：**"不花钱的镜头"与"被遗漏的镜头"在界面上不可区分**。是否值得修属产品决策，未自行更改。

#### 另一处如实记录：4 个曾存在的 run 已不在盘上（未解释，未掩饰）

14:26:06Z 的 `/api/costs` 扫描列出 **6 个 run**，现工作区只剩 2 个。`run-51821120`、`run-cff8e1e0`、`run-6083f24f`、`run-62324471`（**四者全部零花费、零未结清**）既不在 `workspace/` 也不在 `.local/archive/`。

证据链：`studio.log` 中唯一一次 `DELETE` 是 `/api/templates/custom-260bab38-d43`（03:32:31Z 删模板），**无任何 run 删除或归档调用**；四者末次访问全部是 14:26:06Z；`ProductionStudio.list()` 无缓存（`production-studio.ts:237-244`），故当时确实在盘上；我的归档记录只写了 2 个 run。**金额不受影响**（四者均零花费）。**已请用户确认是否为其更早轮次主动清理；若非，需查明。** 未做任何推测性结论。

#### 顺带核实：PERF-R11-01 无需重做

`reasoningTokens` vs `providerWaitMs` Pearson **r=0.913**（glm 子集 0.954），`promptTokens` r=**−0.186**（无关）；154 个样本中 `modelAttemptCount > 1` **0** 个、`structuredRepairCount > 0` **0** 个、`queueWaitMs = 1`。实质是"异常大的推理输出在正常速率下生成"（glm 中位 45.9 tok/s）。真实风险是余量薄：实测最长 989138ms 占 Broker `timeoutMs=1200000` 的 **82.4%**。可观测性缺口：glm 全部 44/153 条 `firstOutputEventMs === providerWaitMs`（等待期无增量事件）。**未动**模型、思考强度、证据帧数、criteria 或超时阈值。**保持 OPEN。**

#### 当前状态

`assets` 节点已 `running`，本轮第一笔真实媒体支出开始流动（上限 ¥17）。观察器覆盖成功与失败两类终态。后续链路：`assets → asset-source-review → voice → render → technical-review → visual-review（两个不同真实视觉模型同片双审）→ final-review → publish-package`，其中一次局部返工与无关素材复用按本轮要求执行。K/L/M 的 build 与重启仍排在 run 终态之后（缺陷 H）。

#### 等待期间预检：双真实模型复审的接线是否真的生效（避免跑到终审才发现配置不对）

本 run 的 `providers.visualReview = "glm-visual-review-v1"` 只有**一个** id，乍看不像"两个模型"。逐层核对如下：

- `role-agent-assembly.ts:151-179` 的 `orderedVisualReviewAgents`：**当且仅当 codex 与 glm 两个视觉 agent 都存在**时，才返回两个 `IndependentDualVisualReviewAgent`——一个 `primary=glm / secondary=codex`，一个 `primary=codex / secondary=glm`；否则只返回单个，且该单个**没有** `finalReviewConfiguration`。
- 每个 `IndependentDualVisualReviewAgent` 构造时即校验 `primary.id !== secondary.id && primary.modelId !== secondary.modelId`（`codex-visual-review.ts:307`），并生成 `finalReviewConfiguration.mode = "dual"`、`reviewers = [primary, secondary]`。其 `id` 取 `primary.id`，故 `glm` 主序那个的 id 恰为 `"glm-visual-review-v1"`，正是 `brief.providers.visualReview` 指向的对象。
- `production-pipeline.ts:9753-9790` 的 `assertProductionVisualReviewReady` 要求 `mode === "dual"`、`reviewers.length === 2`、providerId 与 modelId **各自**去重后仍为 2、且两者 `independentRoleAudit === true`。
- 该断言在 **`dispatch()` 内、建 run 之前**执行（`production-pipeline.ts:659`）。`main.ts:128` 确实把 `visualReviewAgents` 传入了流水线选项。

**结论（逻辑蕴含，非推测）：本 run 已建成并在运行 ⇒ 该断言已通过 ⇒ codex 与 glm 两个真实视觉 agent 当时都已注册、modelId 互异、都带独立角色审计。** 反证也成立：若 codex 缺失，`orderedVisualReviewAgents` 只返回 `[glm]`，其 `finalReviewConfiguration` 为 `undefined`，`dispatch` 会直接抛 "Formal production requires two distinct GLM and Codex visual-review providers…"，本 run 根本不会存在。

**尚未成为证据的部分**：实际跑了哪两个 provider/model，须以 `visual_review.json` 的 `reviewScope.actualModels`（`production-pipeline.ts:9158` 由 `independentReviews` 派生）与 `independentReviews[]` 长度 2（`production-pipeline.ts:10605` 校验）为准，届时核验，**现在不预称已达成**。

---

### 缺陷 O（新）：试片闸门把"证据合同规定的咨询项"当作阻断条件 —— 源素材阶段的结构性死锁

#### 现象与证据（全部来自本 run 的磁盘产物，非推测）

`run-f8e2635f` 于 `2026-09-14T16:49:39.280Z` 在 `assets` 节点 `rejected`，已花费 ¥2.00。`nodes/assets/attempt-1/pilot-review-scene-3.json` 的原文：

| 字段 | 实际值 |
| --- | --- |
| `recommendation` | `revise` |
| `scores` | composition 85 / continuity 82 / pacing 80 / legibility 88 / safety 95（**五项均 ≥ 75**） |
| `confidence` | 0.82（**≥ 0.7**） |
| finding 1 | `satisfied` / `info` / `nextAction: none`——"场景3源素材达到单镜要求，可按当前区间进入后续合成，**无需替换**" |
| finding 2 | `not_observed` / `info` / `nextAction: inspect_existing_media`——"待场景1–2素材可用后再下结论；**不据此要求重新生成场景3，也不进入重买清单**" |
| `reviewScope.actualModels` | `[{providerId: zai-bigmodel-api, modelId: glm-5.3-flash}]`（试片执行者） |

宿主的报错文案是"镜头 3 试片未通过…**请调整对应方案后重新报价**"，而它引用的报告自己写着"无需替换"——**文案与它引用的证据自相矛盾**。

#### 根因：三条各自正确的规则叠成必然死锁

1. 提示词判据第 6/7 条**要求**模型把无法核验的内容如实记为 `not_observed`，不得据此判缺陷。
2. `assertFindingEvidenceContract`（`codex-visual-review.ts`）规定 `not_observed` 必须是 `severity: info` + `nextAction: inspect_existing_media`，语义是"先查看已有素材"，**明确不是返工指令**。
3. `normalizeRecommendation`（同一文件）却把 `not_observed` 与 `failed` 并列，**强制**把 `recommendation` 降为 `revise`。
4. 试片闸门（`generative-asset-worker.ts`）要求 `recommendation === "approve"` 才放行付费生成。

叠加结果：**只要试片诚实记录了任何未覆盖项，`recommendation` 必然是 `revise`，闸门必然打回。** 而试片**按定义就是局部视图**——本片试片只覆盖镜头 3 的 24 帧（52–2448ms），镜头 1–2 尚未生成，"跨镜剪辑速度"在物理上无法核验。也就是说：**该闸门对任何如实标注证据边界的试片都会必然打回，等于在筛掉诚实的报告、只放行声称"全片已验证"的报告。**

该降级条件由 commit `0bfa7f8` 引入（`severity === "warning"` → `evidenceStatus === "failed" || "not_observed"`），而**同一次提交**新增的 `assertFindingEvidenceContract` 恰好把 `not_observed` 定义为非缺陷语义——矛盾在同一提交内产生。

#### 为什么缺陷在闸门而不在归一化

- 归一化层的 fail-closed 是**有意且有测试锁定**的：`codex-visual-review.test.ts` 显式断言 `notObserved.recommendation === "revise"`。
- 成片终审消费 `revise` 的方式是**交给操作员决定**（`production-pipeline.ts:3523` → `needs_human`，"视觉审片建议修改，请人工确认是否继续"，选项 approve/request_changes/reject），并非否决。
- 而试片闸门是**硬抛错、无人工放行路径**。同一系统内同类审计，一个可被接受/不接受，一个直接否决——正是你指出的"审计强制能力太强"。
- 旁证：`pilot-review-scene-*.json` 的返工范围逻辑**本来就排除 inspect-only 发现**（现有测试 `does not turn inspect-only findings into a paid rework scope`）。只有试片闸门例外，属判据不一致。

#### 修复（最小且不降门槛）

新增并按"是否继续"语义命名的共享判据 `visualReviewBlocksContinuation(report)`（`codex-visual-review.ts`，经 `index.ts` 导出）：

```
recommendation === "reject"
|| findings.some(severity !== "info")          // 需要返工的缺陷
|| min(五项评分) < VISUAL_REVIEW_PASS_MIN_SCORE       // 75
|| confidence < VISUAL_REVIEW_PASS_MIN_CONFIDENCE     // 0.7
```

- 门槛常量 `VISUAL_REVIEW_PASS_MIN_SCORE = 75` / `VISUAL_REVIEW_PASS_MIN_CONFIDENCE = 0.7` 从 `normalizeRecommendation` 中提取导出，**两处共用同一组常量**，防止将来各自漂移；这两个数字与提示词判据第 9 条向模型声明的门槛**完全一致**——修复后宿主判据与提示词判据首次对齐。
- 两处"是否继续"闸门改用该判据：试片闸门（`generative-asset-worker.ts`）与源素材预检闸门（`production-pipeline.ts:8930`，原先同样要求 `recommendation === "approve"`，属同一缺陷类）。
- **未改动** `normalizeRecommendation` 与 `assertFindingEvidenceContract`：成片终审保持 fail-closed，其 `revise` 仍走 `needs_human` 交操作员决定。
- `not_observed` 发现**原样保留**在试片报告与产物中供操作员复核，未被丢弃或降噪。

#### 验证（确定性，不调用任何真实模型）

| 检查 | 结果 |
| --- | --- |
| RED：临时还原旧判据后跑新增用例 | **失败** `AssertionError: actual 'rejected' / expected 'succeeded'`（direct 与 director 两种模式均失败）——与本 run 实际被拒的同一判据 |
| GREEN：修复后 `generative-asset-worker.test.ts` | **101/101 pass, 0 fail** |
| `codex-visual-review.test.ts`（含新增判据矩阵用例） | **37/37 pass, 0 fail** |
| `packages/production-pipeline` 全部 72 个套件 | **771 pass / 0 fail / 1 skipped**（共 772） |
| `npm run typecheck`（六个 tsconfig，含 `tsc --noEmit`） | **EXIT=0** |
| `npm run build`（broker + studio） | **EXIT=0** |
| 修复已进入正式产物 | `dist/codex-visual-review.js` / `.d.ts` / `dist/generative-asset-worker.js:779` / `dist/production-pipeline.js:7245` 均已核对 |

新增用例覆盖"必须继续阻断"的全部实质条件——明确否决、warning 级 failed 缺陷、单项评分 74、confidence 0.6——以证明本次修复**没有降低任何质量门槛**。

#### 未降低门槛的边界（如实声明残留缺口）

模型**显式**说 `revise` 但只记录了 info 级发现、且评分与置信度全部达标时，新判据不再阻断。理论上这属提示词判据第 9 条禁止的自相矛盾输出（评分达标却要求修改），且实践中模型的关切仍留在 `description` / `suggestion` 字段供操作员阅读。若要连这一情形也拦住，需在报告中区分"模型显式要求"与"宿主归一化降级"两个来源（新增字段，波及 `visual_review.json` 与 studio 类型契约），或把这两处闸门改为 `revise → needs_human` 交操作员决定。**两者都是产品决策，未自行实施，留待你定。**

#### 附：一处 QA 环境陷阱（非产品缺陷，但会制造假失败）

`which node` → **`~/.nvm/versions/node/v22.23.1/bin/node` 排在 `/opt/homebrew/bin/node` 之前**。`npm run studio:test` 的子进程因此用 v22（ABI 127）执行，而 `better-sqlite3.node` 是按 ABI 147 编译的：

```
The module 'better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 127.
```

首次运行产生 33 个 `not ok`，**全部**源于该 ABI 不匹配（交接文档已警告"nvm v22 会产生 122 个幻影失败"）。已终止该次运行，改用 `PATH=/opt/homebrew/bin:$PATH` 重跑。**未重建任何原生模块**（交接约束：不得重建 Node ABI）。

#### 修复后以操作员身份续跑（复用已物化试片，不重买）

部署：`npm run build` 后仅重启本轮 studio（旧 pid 75915 → 新 pid 57877，`127.0.0.1:4319`）；**未触碰 broker 与任何旧服务，未重建原生模块**。run 已处终态，缺陷 H 的前置条件满足。

操作员动作：`RunWorkbench.tsx:402` 在 `run.status === "rejected"` 且存在源素材失败时提供按钮 **「重新检查已有试片」**（`checks/step-r10-retry-assets.txt`、截图 `r10a`/`r10b`）。这是设计者为此情形预留的恢复路径——但旧判据下缓存报告每次都会重新归一化，该按钮**必然再次打回**，是个死按钮；修复后才真正可用。

| 时点 | `run.status` | revision |
| --- | --- | --- |
| 点击前 | `rejected` | 9 |
| 点击后 | **`running`** | 11 |

**续跑未新增授权敞口（预算纪律的正向证据）**：

| 授权 | `maxCostCny` | `itemCreateBudgets` | `approvedAt` |
| --- | --- | --- | --- |
| `spend-authorization-bd6bef3f…` | ¥17 | `{scene-1:1, scene-2:1, scene-3:1, scene-6:1}` | 16:36:55.993Z |
| `spend-authorization-b8d76e9d…`（重试派生） | ¥15 | `{scene-1:1, scene-2:1, scene-6:1}` | 17:12:13.826Z |

- 镜头 3 **已从新授权的 `itemCreateBudgets` 中消失**——复用已物化素材，未重新购买（¥2 已经结算并保留）。
- 两笔授权的 `derivedFromScopeId` 同为 `auth-d6ef90f499e8cddf209060df562265ad`，即操作员此前接受的 plan digest。累计敞口 = 已花 ¥2 + 新授权 ¥15 = **¥17，恰好等于批准上限**，未越权，也未重新向操作员索要超过原批准范围的费用。
- 预算：本轮最坏 ¥23.50，¥50 授权下余 ¥26.50；本次续跑不改变该数字（仍在原 ¥17 之内）。

---

## R11 续轮：主线推至成片双模型复审 + 成片终审（真实付费路径）

run：`run-f8e2635f-4baa-4a4d-9a2b-a6e169ee5c08`。完整证据：`docs/qa/videofactory-real-local-qa-20260914-r11-takeover-assets/checks/r11-dual-review-and-final-review.md`。

### 节点链结果

| 节点 | 结果 |
| --- | --- |
| brief / creative-planning | succeeded |
| assets | **succeeded**（4 个付费镜头全部 materialized，attempt-2 实付 ¥15） |
| asset-source-review | succeeded |
| voice | succeeded（7 镜 + narration，free / macos-say） |
| render | succeeded |
| technical-review | succeeded |
| visual-review | **succeeded（双模型同片复审）** |
| final-review | needs_human → 操作员补查后进入新一轮复审 |

成片（`nodes/render/attempt-1/renders/1/final.mp4`）：`h264 / 1080x1920 / 30fps / 24.000000s / 7,231,304 B / 含 aac`。

### 用户第 5 条要求「同片由两个不同真实视觉模型复审」：已完成

权威证据 `nodes/visual-review/attempt-1/visual_review.json` → `reviewScope.actualModels`：

| providerId | modelId | evidenceId | producer | audit |
| --- | --- | --- | --- | --- |
| `zai-bigmodel-api` | `glm-5.3-flash` | `b9193232…1928f` | true | true |
| `openai` | `gpt-5.6-sol` | `b9193232…1928f` | true | true |

- `providerId`/`modelId` **两两不同**（确为两个不同真实模型）；`evidenceId` **完全相同**（确为同一份成片证据，而非各审各的）。
- `independentReviews.length === 2`；`producerContractDigest`/`auditContractDigest` 相同且两项 completed 均为 true。
- 旁证：两个并行的 `视觉审片员` agent loop 检查点（分别只含 glm / gpt）、两条独立轨迹 `agent_loop_trace-{1,2}.json`（269,831 B / 193,018 B）、UI「成片双审：2/2 已完成」。
- 装配条件见 `apps/studio/src/server/role-agent-assembly.ts:151-183`（仅当 codex 与 glm 均在位才构造两个互审 Agent）；`assertProductionVisualReviewReady` 在 `dispatch()` 内、建 run 之前 **fail-closed** 断言 `mode==="dual"` 且去重后 provider/model 各为 2——不会静默降级为单模型。

### 复审结论与操作员独立核对

原始报告 `recommendation: revise`，`scores {composition:82, continuity:74, pacing:72, legibility:86, safety:92}`（min 72），`confidence 0.73`，findings 18 条 = info 17 / warning 1，evidenceStatus satisfied 12 / not_observed 5 / failed 1。

操作员**抽帧亲看**（t=1.5/5.0/8.5/9.9/10.6/11.6/13.0/16.0/21.0s）确认：唯一实质缺陷（scene4 蒸汽轮廓极弱）**属实**——10.6s/11.6s 蒸汽几乎不可见，暖色亮边落在**杯口**而非蒸汽，而字幕写"蒸汽有了亮边"。其余各镜与 renderManifest 文案一致，scene7 与 scene1 母片同源呼应成立。

### 新缺陷 P（已定性、已记录，未擅自实施修法）

`apps/studio/src/client/components/RunWorkbench.tsx:925-928` 的替换候选集恒为 `1 … scenePosition-1`，即**只允许复制一条更早的镜头**。三个确定性后果：

1. 对 scene4 任何可选替换都只换画面、不改字幕 → 让"蒸汽有了亮边"与画面直接矛盾，**一个缺陷换成两个缺陷**；选镜头 3 还会与 scene3 连续同景。
2. 素材来自免费图库的镜头（scene4 = `pexels 7577435`）无法"另选一条同源素材"——该能力未被返修面暴露，而这恰是零成本正解。
3. **scene1 永远无法返修**：`scenePosition-1 = 0` → `sourceOptions` 恒空 → 控件整块不渲染（`:938` 守卫）。

同文件 `:937` 对 `replan_upstream` 已写明"不能用任意旧素材替代"，而 `rework_asset` 的唯一通道恰恰就是它——设计自相矛盾。定性为**宿主向操作员暴露的返修能力**与其自身产出的返修建议之间的矛盾，非模型输出错误（`rework_asset` 是证据合同强制取值），亦非提示词问题。三种候选修法（a 图库重选 / b 开放 `replan_upstream` 建议位 / c 显式提示候选不满足）列于 `checks/defect-P-rework-surface.md`，**待用户裁决**。

### 本段花费

| 尝试 | 授权 | 上限 | 实付 | 实际模型 | 结局 |
| --- | --- | --- | --- | --- | --- |
| attempt-1 | `spend-authorization-bd6bef3f…` | ¥17 | **¥2** | MiniMax-H3 | rejected（缺陷 O） |
| attempt-2 | `spend-authorization-b8d76e9d…` | ¥15 | **¥15** | MiniMax-H3 + doubao-seedance-2-0-mini-260615 | succeeded |

- attempt-2 实付恰等于上限且**不含 scene-3 的 ¥2** → 复用未重买；独立佐证：两 attempt 的 `scene_03_hailuo-video-v1.mp4` sha256 均为 `59c7735c…fec986d5`。
- 本 run metered 累计 **¥17**，未越各自授权上限；补查、双模型复审、配音、渲染、技术质检均 ¥0。
- **计费证据更正（自行发现）**：`GET /api/runs/:id`（制作详情）**不返回** `executionReceipts` / `spendAuthorizations`；harness 有四个步骤从该响应取数，全部静默得到空值并打印成"0 笔 / ¥0.00"或"[]"，被误读为"没有花钱/没有授权"。产品另有权威成本入口 `GET /api/runs/:id/costs`。已修四处取数（改磁盘 `run.json` 或 `costs` 端点），在四份证据文件内**保留原读数并就地追加更正标注**，未删任何历史记录。交叉核对：官方 `totals.actualCostCny` = ¥17、磁盘核算 = ¥17.00、`actualPendingCount: 0`（无在途），两侧一致。记入 OBS-4。

### 缺陷 Q：素材试片审查是单模型，双审的检测优势无法在最便宜的阶段生效

**同一镜头，两个阶段判定相反**（`run-f8e2635f-…` scene4 蒸汽）：

| 阶段 | 模型 | 判定 |
| --- | --- | --- |
| `asset-source-review`（素材试片） | **glm-5.3-flash（单模型）** | `info/satisfied`「蒸汽持续上升且形态逐帧变化…**蒸汽亮边兑现成立**」→ `approve` |
| `visual-review` 分支 1 | glm-5.3-flash | `info/satisfied`（failed 0 条） |
| `visual-review` 分支 2 | **gpt-5.6-sol** | `warning/failed/rework_asset`「**蒸汽轮廓极弱**，未形成要求的清晰暖色亮边」 |

**代码级根因**（`packages/production-pipeline/src/codex-visual-review.ts:332-335`）：`input.reviewStage === "source_assets"` 时**显式退化为单模型** `sourceAgent ?? primary`，只有 `rendered_video` 才走双模型分支。`sourceAgent` 由装配顺序决定（`role-agent-assembly.ts:151-183`）：`agents[0]` = glm 侧（`sourceAgent` = glm），`agents[1]` = codex 侧。本 run `providers.visualReview = "glm-visual-review-v1"` 命中第 0 项 → 素材审查走 **glm**，即两个模型里判 `satisfied` 的那一个。`asset-pilot-review.ts:88-91` 的 `actualModels` 硬编码为单元素，与之吻合。**这是设计，不是 bug**；但"用哪个模型"由装配顺序而非质量考虑决定。

**操作员抽帧核实**（`checks/frames/`）：源素材四帧中蒸汽**间歇可见**（0.0s/2.4s 有清晰白色蒸汽丝，1.1s/2.1s 几乎不可见）；源素材与成片同刻画面**除字幕外完全一致**（渲染未劣化）；画面中暖色亮边落在**杯口边缘与杯身高光**、不在蒸汽上。结论：glm"有蒸汽、形态变化"对一半、"持续上升"不成立；gpt"极弱、未形成亮边"更贴合整体观感；**字幕「蒸汽有了亮边」在四帧中均不成立 → 文案过度承诺，画面本身基本合格**。

**三条结构性后果**：① 检测能力与修复成本倒挂（双审只在成片阶段生效，而那时唯一返修工具是"复用更早镜头"，修不了；素材阶段修则 ¥0）；② 两模型分歧时产品取并集（保守正确）但**不向操作员暴露"这是分歧项"**；③ 是否引入第二个模型，直接决定该缺陷能否被发现。

**建议方向（未实施，待裁决）**：I 素材阶段也走双模型（复用现成 `IndependentDualVisualReviewAgent`，多一次 subscription 调用、现金 ¥0）；II 保留单模型但在成片 `failed` 且素材阶段 `satisfied` 时显式标注跨阶段分歧；III 不动装配，改给"文案与画面不符"提供零成本修法（缺陷 P 的 a2）。三者不互斥。完整记录：`docs/qa/videofactory-real-local-qa-20260914-r11-takeover-assets/checks/defect-Q-source-review-single-model.md`。

**与缺陷 O/P 的关系**：Q 是上游（廉价发现机会被单模型漏掉），P 是下游（缺陷流到成片后返修面无解），O 是同区段另一个已修缺陷（试片闸门死锁），三者无因果链但同在 `assets`/`asset-source-review` 区间。

### 补查结果（revision 12）：双模型仍然成立，但否决项由 1 条增至 2 条

补查 `2026-09-14T18:01:39Z → 18:11:54Z`（10m15s），产物 `nodes/visual-review/attempt-2/visual_review.json`。四项核对：

| 核对项 | 结果 |
| --- | --- |
| 两个不同真实模型 | **成立**——`actualModels` 两项 providerId/modelId 两两不同（`zai-bigmodel-api`/`glm-5.3-flash`、`openai`/`gpt-5.6-sol`） |
| 同一份成片证据 | **成立**——两项 `evidenceId` 仍为 `b9193232…1928f`（未变，成片未被改动，符合"补查不重渲染"的预期） |
| `independentReviews.length` | **2** |
| 花费增量 | **¥0**——metered 仍 2 笔 ¥17.00，授权仍 2 笔，末次付费仍 `17:24:34.504Z` |

**但结论变了**：`recommendation` 仍 `revise`，findings 18→15，`warning/failed` 1/1 → **2/2**，`not_observed` 5→3，scores 中 continuity 74→72、legibility 86→92、pacing 72→74、confidence 0.73→0.78。镜头 4 蒸汽否决**仍在**；**新增**镜头 5 树影否决（仅 gpt）。5 条咨询项减为 3 条，减掉的两条都属镜头 5——glm 判它"兑现"，gpt 判它"不成立"，分歧镜头由 1 个增至 2 个。

### 缺陷 R：补查在逐字节相同的输入上重跑审片，判定不可复现且新增了一条依据不成立的否决项

**输入逐字节相同（可核验）**：主审提示词 sha256 前 16 位两轮均为 `66587f99663397c1`（25,708 字符，`agent_loop_trace-2.json` gpt 分支 iteration 0）；21 帧逐帧 `sha256` 与 02:01 重新抽出的帧文件全部一致（attempt-1 findings 引用 13 帧、attempt-2 引用 15 帧，**0 处不符**）；`sampling.mode=scene_triplets`、7 场景 × 3 帧、时间码两轮相同。

**同一输入下两个模型各自推翻自己的事实陈述**：

| 模型 | 补查前（镜头 5） | 补查后（镜头 5） | 变化 |
| --- | --- | --- | --- |
| glm-5.3-flash | 「**帧间位置与形态无可辨推进**……现有证据不足以判定」 | 「**帧间影子位置存在可见变化**，与摇曳要求一致」 | `not_observed` → `satisfied`（放宽） |
| gpt-5.6-sol | 「影子位置和明暗状态**近似**，无法据此确认」 | 「枝叶、树影位置和取景范围**近乎一致**，未形成可见的连续摇曳」 | `not_observed` → `failed`（收紧） |

**操作员独立测量否证了 gpt 的依据**：审片员看到的同三帧 `SSIM_Y = 0.6965 / 0.6958 / 0.5993`（相隔 0.875s / 0.875s / 1.750s），远非"近乎一致"；场景 5 内相邻 0.25s 帧 SSIM 0.93（比场景 1 快速运动的 0.86 更稳）→ **缓慢但持续的变化**。源素材 `scene_05_pexels_6666665.mp4`（8.43s）抽 6 帧：**粗枝位置基本不动（相机静止），叶片簇明显转动**，墙面影子随之变形 → 素材本身确有叶动。**结论：镜头 5 字幕「树影，也在晃。」有画面支撑，新增否决不成立。**（与镜头 4 相反：镜头 4 是画面合格、文案过度承诺。）

**四条结构性后果**：① 补查不是收敛操作而是同输入重掷——无记忆地重跑整轮，不仅重判 `not_observed` 项，也重判上一轮已 `satisfied` 的镜头（本 run 未发生翻转，但机制上可能，且无提示）；② 面板文案「**待补查项**只会重新审查当前成片」把动作描述为定向复查，实际是全集重跑（`RunWorkbench.tsx:318`）；③ 越过证据类别边界——镜头 5 要否定的是**运动属性**，证据是**静帧**，gpt 第一轮自己判的就是 `not_observed`，补查没增加任何证据却改判 `failed`；④ 补查之后没有退路——新报告覆盖旧报告，唯一能"不接受"的按钮是「仍要批准（说明理由）」，而面板把它定义为"覆盖视觉审片建议"，于是"驳回一条依据不成立的否决"在产品语义里等于"降格放行"，没有"逐条接受/驳回"的通道。

**建议方向（未实施，待裁决）**：IV 补查语义对齐（真做定向复查，或文案如实写"重跑整轮、结论可能变化"）；V 明确禁止用静帧证据对**运动类**主张下 `failed`（只记 `not_observed`，或补连续帧/视频证据）——这不是放宽标准，而是不允许用不足的证据下重判；VI 把"与上一轮判定不同"的条目显式标为判定变动项并给出两轮原文对照；VII 终审需要逐条接受/驳回，而不是只有一个全局"批准"按钮。完整记录：`checks/defect-R-reinspection-nondeterminism.md`。

### 主线状态：五要素全部完成；成片终审**阻塞**，需用户裁决

用户第 5 条要求的五个环节均已在本 run 真实完成并可核验：素材审查（`asset-source-review` succeeded）→ 配音（`voice` succeeded，7 镜 + narration）→ 渲染（`render` succeeded，1080×1920/30fps/24.000s）→ **同片由两个不同真实视觉模型复审**（`visual-review` succeeded，双模型证据见上）→ **一次本地返工与无关素材复用**（attempt-1 rejected → attempt-2 重跑资产，`scene-03` 未重买、两 attempt sha256 相同，实付 ¥15 恰等于上限且不含该镜的 ¥2）。

成片终审 `final-review` 停在 `needs_human`（revision 12）。三个出口逐条核对后**都不构成正解**：

| 出口 | 后果 |
| --- | --- |
| 替换后重新审片（镜头 4 → 候选 1/2/3；镜头 5 → 候选 1/2/3/4） | 候选全是"更早的镜头"，替换会让字幕「蒸汽有了亮边」/「树影，也在晃。」与画面直接矛盾，且 s4 选镜头 3 会与 scene3 同景 |
| 补查现有成片 | 已执行一次，结果是把否决从 1 条变成 2 条；再执行属"盲目重试"，且不改画面、不可能消除任何一条否决 |
| 仍要批准（说明理由） | 镜头 4 的文案与画面不符是真实且观众可见的缺陷 → 等于覆盖审片建议、降格放行 |
| 修改后再审 | 同样落在 `requestSceneRevision`，只改 asset plan、不改脚本/字幕，受同一候选集约束 |

即**主线在成片终审处被真实阻塞**，阻塞原因是产品缝隙而非本次操作失误：上游单模型漏检（缺陷 Q）→ 补查同输入重掷并新增一条依据不成立的否决（缺陷 R）→ 返修面无法修复任何一条、也无逐条驳回通道（缺陷 P）。因此**本轮不批准、不另建 run、不换题**，把缺陷 P / Q / R 一并上报裁决。run 保持 `needs_human`，无新增花费。

---

## 收尾轮（revision 15 → 16）：joint 引用闭包缺陷修复与主线打通

### 1. 本段结论

**端到端主线已在 revision 16 打通。** run 从 `failed` 走回 `needs_human`，且**没有多花一分钱、没有重买任何素材**：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| run 状态 | `failed`(rev 15) → **`needs_human`**(rev 16) | `checks/step-r16-retry-failed-voice.txt` |
| 节点 | `voice` / `render` / `technical-review` / `visual-review` 全部 succeeded；`final-review` 停在人工裁决点 | 同上 |
| 付费增量 | **¥0.00**（metered 恒为 ¥17.00，收据 2 笔、授权 2 笔未变） | 同上 |
| 已付费素材 | 7 件 **SHA256 全部未变** | 同上 |
| 双视觉模型复审 | `glm-5.3-flash`(zai-bigmodel-api) 与 `gpt-5.6-sol`(openai) 对**同一成片**各自出报告 | `nodes/visual-review/attempt-4/` 的 `model_trace-1/2.json` |

### 2. 缺陷：joint 拓扑下人工改旁白会破坏可执行方案的引用闭包

**根因链（逐层，不是"语义不符"）**

1. `dispatchNarrationRevision` 在 joint 下**沿用 legacy 语义**：把被改的那一版原稿从规划节点当前接受版本里踢出去。
2. 但 joint 的可执行方案**按 artifact id 引用脚本**（`plan.scriptArtifactId`）。方案的引用集受 `verifyExecutablePlanReferenceClosure`（`production-pipeline.ts:12248-12359`）约束：plan 与全部被引用产物必须同属规划节点**当前 effective version** 的 `artifactIds`（该集合读自 run.json，`:12222-12246`）。
3. 于是 `voice` 消费方案时 fail closed，整条主片卡在配音。

**逐字报错**（RED 复现，与生产**逐字相同**；由"把 `joint ||` 去掉"的受控变异得到）：

```
Executable plan reference 'artifact-9c552b1e-ebfa-4bea-8758-f3be77c5ea16' (script) is not a member of the current accepted planning output version.
```

**修法**（`packages/production-pipeline/src/production-pipeline.ts:1869`，含说明注释）：

```ts
retainedArtifactIds: planningVersion.artifactIds.filter((artifactId) => (
  joint || artifactId !== scriptArtifact.id
)),
```

joint 下保留全部原成员；人工改出的新稿**另立一件**，父级为被改的那一版原稿（如实记录"这行字从哪一版改来"，不冒充 Provider 产物）。legacy 语义不变。

**为什么不重绑方案**（这是本段放弃的第一种修法）：方案是那次规划 commit 的**证据快照**。`verifyJointPlanningCommit`（`:5786-5914`）要求 commit 文件条目 ↔ run 的 artifact 记录 ↔ 磁盘 sha256 三方向一致，且 `executablePlan.scriptArtifactId` 必须等于 `committedId("script")` —— **方案的引用 id 被 commit 文件钉死**。同时 `ExecutableProductionPlan` 全文只有 `durationRange/fps/totalFrames/cuts[...]`，**不含旁白文字**（旁白由 `output.scriptPath` 提供）。所以"改字不动方案"在语义上成立：不重编译、零 Provider 调用、零费用。

**GREEN**：`packages/production-pipeline/test/production-planning-closure.test.ts` 用例
`revises narration without evicting the script its commit-registered executable plan references`，断言：版本成员只增不减（每个旧 id 仍在）、当前版本内 `executable_plan` 恰 1 份且 id 与 uri 不变、`cuts`/`totalFrames` 与改前深等、原稿仍在版本内且磁盘字节深等、下游 `workerCalls` 增量深等 `["voice.synthesize","video.render","quality.review"]`、`asset.prepare` 计数不变、`media_asset` id 列表不变。

**幂等性**：连续多次改字下方案引用集始终是成员（成员数 6→8→10→12，引用恒全在）。

### 3. 落盘状态已被旧代码写坏，且**产品路径无法恢复**（新缺陷，独立于上条）

旧代码在修复前已把一个**活的 run** 写成损坏态：effective version 缺 `artifact-35bacec2-7abf-43e6-a92c-4cb08d2d2daf`（方案引用的原稿）。修复代码不会**再**写出这种版本，但**已写坏的那一版救不回**：

- `applyNodeRevision` 硬约束 `retainedArtifactIds ⊆ 当前版本成员`（`packages/workflow-core/src/workflow-runner.ts:767-771`，否则抛 `Node revision cannot retain non-current artifact`），且用 `exactArtifactIds = [...retained, ...new]` 覆盖版本与 nodeRun 的 artifactIds（`:785-787`）—— 所以任何返修/override **都无法把被踢出的产物加回版本**；
- `retryFailedNode` 只是用同一份 run.json 重跑，必然同一条报错；
- 没有任何"回退到上一版本 / 撤销 revision"的产品操作；
- 重跑 `creative-planning` 会失效 assets 下游，等于重买已付费素材。

**本段做的手工落盘修复（必须如实标注：这是数据修复，不是产品路径）**

脚本 `docs/qa/.../harness/repair-r15-planning-membership.mjs`（dry-run 默认，`--apply` 才写；fail-closed 前置条件见脚本头注释）只做一件事：把原稿 id 插回 effective version 与 `planning.artifactIds` 的**同一索引**（index 1，与父版本同位），使落盘状态**等于修好后的代码本来会写出的那一版**。不碰方案文件、原稿文件、规划 commit 文件、素材、任何金额或授权记录、revision 计数。有备份、有逐 id 前后对照：`checks/step-r15-membership-repair-{dryrun,apply}.txt`，备份 `.local/runtime/qa-r11-repair-20260914/backups/run-f8e2635f-…-rev15-before-membership-repair-2026-09-15T02-13-10-513Z.json`。

**这不是造假**：被加回的产物真实存在于磁盘，sha256 / provenance / commit 三方一致且未改动，恢复的是"它本来就该在版本里"这一条成员关系；配音、渲染、双模型复审全部真实执行。**但它确实不是产品路径 —— 产品对该损坏没有任何恢复手段。**

### 4. 受控复验（步骤 16，一次，非盲目重试）

复验依据是上条的 RED→GREEN 证据 + 修复前后成员表逐 id 对照。操作员先用只读脚本枚举失败态下产品提供的**全部**恢复动作（唯一可用动作是「重试失败步骤」），再执行一次。结果见 §1 表；完整节点迁移：

```
[15s]  voice=running
[75s]  voice=succeeded render=succeeded technical-review=succeeded visual-review=running
[560s] run=needs_human  visual-review=succeeded final-review=needs_human
```

付费增量 ¥0.00、7 件素材 SHA256 全部未变，**"无关素材复用"成立**（其中两件 sha 同为 `59c7735c6f804a4e…`，是未重买的直接佐证；方案里 `场景7` 复用 `asset-scene-1` 亦为同片内复用）。

### 5. 部署事实（可核验）

| 产物 | sha256 | mtime |
| --- | --- | --- |
| `packages/production-pipeline/dist/production-pipeline.js` | `601c86d2db893d6afb9673560f8d45b78e2a0ceaaa9f6b44c057e5e840d473fb` | 2026-09-15T10:09:57 |
| `apps/studio/dist/server/server/main.js` | `a78e01b71ac73c4d8ad826fce56ad3cf33781ec2f992d4c24632e8ca525e7d89` | 2026-09-15T10:10:34 |
| `apps/codex-broker/dist/main.js` | `665709f2e52374ce37ff2f5660b42ebf997933eadb5a67c420359247dcf6f124` | 2026-09-15T10:09:38 |

- 管道 dist **是当前的**：`packages/production-pipeline/src` 中比它新的文件数为 **0**，第 1274 行含修复后的 `retainedArtifactIds: ...(joint || artifactId !== scriptArtifact.id)`。studio bundle **不内联**管道代码（`main.js:5` 从 `@video-factory/production-pipeline` 导入，经 node_modules 符号链接解析到 `packages/production-pipeline`），故运行中的 studio 消费的就是修好的 dist。
- **studio bundle 比源码旧 1 个文件**：`apps/studio/src/server/production-studio.ts`（本段删除的不可达块，见 §7）。该改动已用探针证明行为等价，所以运行中的 studio 与源码**功能等价但不字节一致** —— 如继续 QA 需重建 bundle。**如实标注，不声称已重建。**

### 6. 门禁

| 检查 | 结果 |
| --- | --- |
| `production-planning-closure` 回归 | **122/122 通过** |
| `npx tsc -p packages/production-pipeline/tsconfig.json` | exit 0 |
| `npx tsc -p apps/studio/tsconfig.json --noEmit` | exit 0 |
| `npx tsc -p apps/studio/tsconfig.server.json --noEmit` | exit 0 |
| `unittest tests.test_review_media` | 25/25 通过 |
| studio 生产相关 10 个测试文件 | 233 个测试通过（探针实验，见 §7） |

**已知假红（既有问题，非本段引入）**：`apps/studio/test/text-task-production-recovery.test.ts` 在**多文件并行**运行时偶发失败（4 次运行 2 次），错误为临时目录清理竞态 `ENOTEMPTY: directory not empty, rmdir '…/runs/run-…'`（另一次表现为 `waitForStopped` 超时）；**单文件运行 5/5 通过**。失败的具体用例在运行间变化（completed_success ↔ completed_failure），属测试基础设施竞态。同类问题：`npm run test:ts` 无默认超时，门禁可永久挂起。

### 7. legacy 死路径审计与本次删除

对 `joint`/`legacy` 双拓扑做了一次只读审计（判别值唯一：`ProductionBrief.workflowFeatures.creativePlanning === "joint-v1"`，helper `production-pipeline.ts:602-606`；`packages/workflow-core` 完全不感知拓扑；无任何环境变量或开关可切换）。

**本次删除（唯一一条，可证明不可达）**：`apps/studio/src/server/production-studio.ts` 中"把缺标记的 brief 自动升级为 joint"的兜底块。

- 不可达证明：`start()` 第一行 `assertStudioExecutableProductionInput(input)`（`:733`）已在 `apps/studio/src/shared/api.ts:1717-1720` 强制 `creativePlanning === "joint-v1"` 且 `creativeReview === "user-confirmed-v1"`，否则抛 `StudioInputError`；而 `parseWorkflowFeatures`（`packages/production-pipeline/src/contracts.ts:1163-1176`）**原样保留**这两个标记（`:479-481` 会带上 `workflowFeatures`）。故块内条件恒为 false。
- **实测证明**（不只靠推理）：把该块首行改为 `throw new Error("UNREACHABLE-BLOCK-EXECUTED")`，跑 10 个生产相关 studio 测试文件 —— **233 个测试通过、探针命中 0 次**。
- 顺手把 `let brief` 收紧为 `const`（该函数内已无整体赋值）。

**未删除（审计判定仍活或需人裁决，逐条给出依据）**：

| 路径 | 判定 | 依据 |
| --- | --- | --- |
| `script` / `visual-direction` 等节点构造与依赖链 | **活** | `make sample-production`（`Makefile:31` + `examples/briefs/*.json` 均无 `workflowFeatures`）+ 磁盘 48 个 legacy run 复跑时重建 |
| `currentPlanningOutputPaths` 的 legacy 分支（`:4969-4990`） | **活** | B4 卡明确要求的"唯一兼容投影"（`docs/videofactory-recovery-handoff-20260911/B4_EXECUTION_CARD.md:117`），下游 assets/voice/render 只消费它 |
| 历史 run 编辑合同放宽（`:1470`/`:1869`/`:1894`） | **活** | 磁盘 48 个 legacy run 仍可被编辑/修订 |
| `production-preflight`（legacy 可执行方案）拓扑整体 | **需裁决，本次不动** | 产品入口不可达（Studio 被 `api.ts:1717` 拦死；79 个持久化 run 中满足该拓扑的 = 0；3 个 example brief 均无 `durationRange`），**但 5 个测试文件正在真实构造它**（`production-pipeline-preflight.test.ts:280/:434`、`production-planning-stages.test.ts:803`(`joint:false`)、`codex-visual-review.test.ts:861`、`production-pipeline-asset-rank-fallback.test.ts:105`），且 `factory run <手写 brief>` 可构造。删它等于连测试一起删（违反"不得删断言"），故上报裁决 |
| `@deprecated` 字段（`contracts.ts:24,26` 等 5 处） | **活** | 实测 18 个 persist run 携带；`docs/loops/022-…md:16` 规定"只保留解析兼容" |
| `production-pipeline.ts:9111-9116` 硬编码 `sourceNodeIds` 含 `"script"` | **疑似漏改** | joint run 也会声明一个不存在的来源节点，目前只写进报告、无校验故不炸。属"legacy 假设泄漏进 joint 路径"的反向问题，需人确认是否有意 |

### 8. 新发现：成片终审的帧预算与主张类型结构性不匹配（未修，需裁决）

`visual-review` 17 条发现里 **8 条 `not_observed`**（`nextAction: inspect_existing_media`）、1 条 `critical/failed`、8 条 `satisfied`，`recommendation: reject`。

- 成因（设计使然，非 bug）：成片路径走 `_select_render_timeline_samples`（`src/video_factory/review_media.py:564`），注释写明**"每镜头三帧是可审计的状态证据：起始、中段、结束"**。21 帧 / 7 场景 = 每镜恰好 3 帧。
- 但审片契约含**时间性主张**（"第六秒前暖光"、"连续单镜四阶段动作"、"树影持续摇曳"、"末秒保持约一秒"），3 张稀疏静帧**既不能证实也不能证伪** → 模型只能如实报 `not_observed`，终审无法自行结论，退回人工。
- **同源问题刚在素材侧被修好**：本段提交的 `review_media.py` 改动把全片预检从"固定两轮（每场 3 帧）"改为"逐场轮转补齐"，理由正是"场内的动作窗口一个采样点都落不到，审片只能报 not_observed，预检就会在配音与渲染前停住整条主片"。**成片侧尚未做同样处理。**
- **本次不改**：动它会改变审片行为与分数，而用户明确要求"不得改审片分数"。上报裁决。

**另一条值得记录的观察**：两个模型对**同一批帧**给出相反判断 —— `glm-5.3-flash` 称"场景4亮沿与可见蒸汽…兑现静态要求"，`gpt-5.6-sol` 称"三相抽帧均未呈现蒸汽或暖色亮边"。**我（操作员）逐帧复核了场景4的三张采样帧**（`review_media/frames/frame-09/10/11`，9875/10750/11625ms，均在方案 `cuts` 的场景4 区间 9500–12000ms 内）：三帧**都有**杯沿暖色亮边，杯口左上方**都有**细薄蒸汽丝（偏淡但可见）。即 `critical/failed` 至少对"暖色亮边"这一半与像素不符。**因此本次不据此触发付费返工** —— 在证据与模型结论冲突时先复核，不先花钱。

### 9. 本地提交（仅本地，未 push）

本段把 revision 9–15 期间累积的未提交工作整理为本地提交，按工作区切分、依赖序排列：

| # | 提交 | 范围 |
| --- | --- | --- |
| 1 | `chore: ignore QA screenshot artifacts` | `.gitignore`（`docs/qa/**/*.png|jpg|jpeg` 不入库，报告与文本证据照常提交） |
| 2 | `feat: extend the production pipeline with creative review and planning closure` | `packages/production-pipeline`(46 文件) + `packages/workflow-core` |
| 3 | `fix: harden broker task lifecycle, recovery and zai fallback` | `apps/codex-broker`(15 文件) |
| 4 | `feat: add creative discussion, trend reading and rework surfaces to studio` | `apps/studio`(57 文件) + `package-lock.json` |
| 5 | `fix: give full preflight the same frame budget as pilot review` | `src/video_factory/review_media.py` + `tests/test_review_media.py` |
| 6 | `docs: record QA reports and evidence through revision 15` | `docs/` + `README.md` |

未跟踪体积因此从 **532MB 降到 11.6MB**（`docs/qa` 截图被忽略，报告与文本证据保留）。提交前已扫描：无密钥特征、无大媒体文件、无临时/备份文件残留。**未 push、未云部署、未删除历史。**

**如实标注**：这是一次累积工作的检查点式切分，**各提交未必能独立通过完整门禁**（它们不是独立开发的增量，而是同一批互相依赖的改动的按区拆分）；已通过的验证见 §6，均针对**当前最终工作区**。


---

## 10. 花费闸门假阳性：报价与执行对"复用"用了两套判据（本段定位并修复）

### 现象（用户视角）

单镜换素材（把某一镜的素材换成另一条）之后，重跑素材节点会收到一笔**根本不需要花的钱**的授权请求，且**界面上没有授权按钮** —— 用户被卡死，既不能授权、也不能推进。

### 根因：同一件事，两处用了不同的判据

| 位置 | 判据 | 粒度 |
| --- | --- | --- |
| 报价（宿主）`incrementalAssetQuoteItems`（`production-pipeline.ts:4449+`） | `sourceFingerprint = paidAssetSourceFingerprint([scriptPath, directorPlanPath])` | **整份脚本与导演方案的字节哈希** |
| 执行（worker）`preparePaidAssetOperation` → `createPaidAssetOperationItem`（`generative-asset-worker.ts:2723-2726`） | `inputFingerprint = sha256(JSON.stringify({scenePosition, request}))` | **逐条素材请求的身份** |

后果是一条完整的死路：脚本里任何一个字节变化（哪怕只改了某个免费镜的检索词）→ 整份字节指纹变化 → 报价侧把**四个一分钱都不会再花的付费镜**重新计入 → 报价 ¥17 → 该节点的次数预算已耗尽 → `assessProductionSpendPlan` 返回 `reason: "attempts"` → 按设计**非金额类原因不渲染授权按钮**（加钱解决不了的问题不给加钱按钮）→ 用户卡死。

而执行侧其实**本来就会**把这四个镜原样携带复用（逐条请求身份未变 ⇒ 命中历史台账叶子 ⇒ 不花钱）。即：**报价与执行对同一事实给出相反结论，报价是错的**。

### 修复：把执行期的判据前移到报价，二者共用同一实现

不新增第二套启发式，而是让报价去问执行器本人：

- `GenerativeAssetWorkerClient.forecastPaidAssetSpend()`（`generative-asset-worker.ts:753-801`）—— **只读取证，不产生任何调用或费用**。复用 `planDirectorRoutes` 与 `preparePaidAssetOperation`（同一份代码，从 `runDirectorRoutes` 抽出），返回 `reusableQuoteItemIds` 与 `createCostCny`。
- 宿主 `WorkerProvider.forecastReusableAssetQuoteItemIds()`（`production-pipeline.ts`）把结果作为 `provenReusableItemIds` 传给 `incrementalAssetQuoteItems`；预测拿不到时（`undefined`）退回原保守报价。
- 结构上不可能再分叉：报价与执行现在是**同一个函数**的两次调用，判据只有一份。

**安全上界（fail closed 未被削弱）**：预测偏乐观也不会造成未授权付费 create —— 执行期仍有 `estimatedCost > 0 && maxCostCny <= 0` 与 `itemCreateBudgets` 两道闸门直接抛错。

### 验证

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| worker 确定性用例 ×2 | 通过 | ①只改免费镜字节 → `reusableQuoteItemIds = ["scene-2"]`、`createCostCny = 0`，且换 `commandId` 重跑后 `creates === 1`、`actualCostCny === 0`；②导演方案真变 → 该镜**留在**报价里（`createCostCny = 3.5`） |
| 宿主确定性用例 ×2 | 通过 | ①forecast 证明 `scene-1` 可复用 → 报价只含 `scene-2`，`estimatedCostCny = 2.4`；②两镜都可证明 → 直接执行、`spendPlan === undefined`、`maxCostCny === 0`（不再走 `awaiting_spend_approval`） |
| mutation 校验第 1 轮 | 有效 | 把 `sourceFingerprint` 混进 `inputFingerprint` → worker 正例失败（`actual: []` vs `expected: ['scene-2']`），反例仍通过 |
| mutation 校验第 2 轮 | 有效 | 删掉宿主 `forecastReusableAssetQuoteItemIds(...)` 调用 → 宿主两个用例同时失败 |
| 源码复原 | 已确认 | 两轮 mutation 后均已还原并核对（`production-pipeline.ts` 调用点仍在、`inputFingerprint` 未含 `sourceFingerprint`） |
| 受影响回归（`production-pipeline` + `workflow-core`） | **857 tests / 856 pass / 1 skipped / 0 fail（EXIT=0）** | 用 `/opt/homebrew/bin/node` v26.8.1 运行 |

**如实标注**：本轮我在实现过程中自引入过一个回归 —— `generationLedgerPathIn` 不再做 `path.dirname` 后，我一度把 `nodeDirectory` 直接传给 `previousPaidAssetItems` / `countPriorCreateAttempts`（它们需要的是 `<nodeDir>/.generation-operations`），这会让历史台账永远为空、**跨操作携带复用静默失效**。已用 `git show HEAD:` 对照原实现（`path.dirname(ledgerPath)`）修正为 `operationsDirectory`，并由上表的两个 worker 用例锁住。

### 残留死角（本轮**不在**已授权范围内，如实上报，未修）

真正"付费镜的请求身份**确实变了** + 该节点次数预算已耗尽"仍会落到 `reason: "attempts"` 且**没有授权按钮** —— 这是产品语义问题（"加钱能否解决"的判定），不是本次的假阳性，需单独裁决。

---

## 11. GLM 非流式的实测证据与流式修复

### 实测（真实调用，非推定）

从 broker 的幂等记录里逐条读出 r20 素材阶段 5 笔**已完成的真实 GLM 调用**（任务类型与模型、耗时均取自落盘 trace）：

| 完成时刻 | 任务 | 模型 | `providerWaitMs` | `firstOutputEventMs` | reasoning tokens | finish_reason |
| --- | --- | --- | --- | --- | --- | --- |
| 11:48 | visual-review | `glm-5.3-flash` | 288 663 ms | **288 663 ms** | 11 818 | stop |
| 11:50 | role-audit | `glm-5.3-flash` | 157 739 ms | **157 739 ms** | 6 790 | stop |
| 11:55 | visual-review | `glm-5.3-flash` | 281 443 ms | **281 443 ms** | 10 976 | stop |
| 11:59 | role-audit | `glm-5.3-flash` | 262 801 ms | **262 801 ms** | 10 914 | stop |
| 12:07 | visual-review | `glm-5.3-flash` | 471 781 ms | **471 781 ms** | 20 127 | stop |

**`firstOutputEventMs` 恒等于 `providerWaitMs`** —— 这正是非流式的结构性后果：整包响应下等待期没有任何可观测事件，两个数字只能是同一个。于是 trace 里"模型在长时间思考（最长 472 s）"与"连接已经死在等"在证据上**完全无法区分**，只能等满整体超时。

### 修复（不降模型、不降 thinking、不减证据量）

`apps/codex-broker/src/zai-code-plan-executor.ts`：

1. 请求体 `stream: false` → **`stream: true`**，并新增 SSE 读取器 `readStreamedCompletion`：按行缓冲、跨分片拼装、跳过空行与 `:` 心跳、`[DONE]` 结束、累加 `delta.content`、采集 `finish_reason` 与 `usage`，`MAX_RESPONSE_BYTES` 上限不变。
2. `firstOutputEventMs` 从"等于 `providerWaitMs`"变成**真实首事件耗时**（整包响应仍退回 `providerWaitMs`，不回退成缺失）。
3. 新增**首个输出事件期限** `firstOutputEventDeadline`：默认 `min(600_000, timeoutMs)` = 10 min（整体超时 20 min），它是"连接还在不在"的判据、不是生成预算 —— 期限只针对**第一个输出事件**（思考多久是模型的事），且**心跳不重置它**（只发 keep-alive 却始终不出字的连接同样算卡死）。
4. 路由按 **content-type** 决定，不按 `stream` 参数：Provider 忽略 `stream` 整包返回时仍走原路径，两种合法行为都不被当成错误。

### 验证：新测试当场抓出我实现里的 3 个缺陷

新增/更新 6 个确定性用例（`apps/codex-broker/test/zai-code-plan-executor.test.ts`）：SSE 跨分片拼装 + 首事件时间 + usage/finish_reason；只发心跳从不出字 → 快速失败；流结束无内容 → `no_output`；非 `data:` 帧 → `output_contract`；整包 JSON 即便内容像 SSE 也走整包路径；请求体 `stream: true`。

**这 6 个用例不是补记，而是在写完实现后当场否掉了我 3 个错误实现**：

| # | 我写错的地方 | 测试抓出的现象 | 修正 |
| --- | --- | --- | --- |
| 1 | `firstOutputEventMs` 直接存了 `now()` 的**绝对时刻** | trace 里出现 `1789445024098` | 改为 `elapsed: () => elapsedMs(requestStartedAt, now())`，存**耗时** |
| 2 | 超时路径在 `finally` 里先 `releaseLock()` | 在途读未清空 → `releaseLock` 抛 TypeError **顶掉真实诊断**，最终报成 `request_timeout` | 先 `await reader.cancel()` 再 `releaseLock()` |
| 3 | 期限只盖住**第一个分片**，与"首个输出**事件**"的合同不符（注释也写着事件） | 只发心跳的连接照样一直骗过判据，直到 20 min 整体超时 | 期限覆盖到**第一个输出事件**为止；心跳不重置 |

另有一处顺序缺陷（`abort` 早于 `reject`，导致 `Promise.race` 用中断原因而非真实判据结算）也已修正，并在代码注释里写明顺序为何要紧。

| 检查 | 结果 |
| --- | --- |
| `apps/codex-broker` 单文件 47 用例 | **47/47 通过** |
| `apps/codex-broker` 全量 | **219 tests / 219 pass / 0 fail（EXIT=0）** |
| `npm run typecheck:broker` | **EXIT=0** |
| `npm run typecheck --workspace @video-factory/studio` | **EXIT=0** |
| studio 全量（vitest + node --test） | **vitest 405/405（19 文件）+ node --test 540/540，EXIT=0** |

### 部署状态：**已构建 dist，但尚未重启 broker**（如实标注）

`apps/codex-broker/dist` 已用本轮代码重建（已确认新代码在 dist 内）。**但没有重启 zai broker** —— r20 的素材节点此刻正在使用它跑真实 GLM 审查（最近一笔 12:07 仍在途）。在途期间重启会打断一笔已付费、结果未知的真实调用。重启与真实首字节实测排在 r20 该节点结束之后。

**尚未验证（明确列出，不当作已完成）**：①真实 GLM 在 `stream: true` 下的首事件实测值；②Provider 是否接受该参数、SSE 形状是否与假设一致；③首事件期限 10 min 相对实测最长 472 s 的余量是否足够 —— 这三项都要等重启后的真实调用，**当前只有确定性证据**。

---

## 12. 待裁决 B：成片终审的帧预算 vs 时间性主张 —— 操作员推荐：**本次不改**

### 事实（读代码与合同得到，非推定）

- 成片终审走 `_select_render_timeline_samples`（`src/video_factory/review_media.py:564`）。当 `max_frames >= 场景数 × 3` 时，**每镜恰好 3 帧**（opening/middle/closing）—— 注释写明这是**刻意的可审计设计**（"起始、中段、结束"）；本片 7 场景 × 3 = 21 ≤ 24，走的就是这一支。
- 审片合同（`packages/production-pipeline/src/codex-visual-review.ts:1271`）规定：判 `motion` 主张 `failed` 需要 `sceneFrameShas.length > 3`（同镜**超过三帧**），或采样窗口内逐字节完全相同。3 帧 ⇒ **motion 主张在结构上不可判**，模型只能记 `not_observed` + `nextAction: inspect_existing_media`。
- 预算里还剩 3 帧（21/24），但把 3 帧给到其中 3 个镜，只让**部分**镜头获得 motion 判定能力。

### 推荐：不改，并给出可复现的判据

1. **当前行为是诚实且 fail-closed 的**：稀疏静帧既不能证实也不能证伪运动；合同要求模型如实报 `not_observed` 而不是把"我的采样不够"写成"作品不成立"，并把出口指向 `inspect_existing_media`（人工复核），不是静默放行。
2. **改动会改变审片结果与分数**，而它买到的是**部分、且带位置偏置**的能力（只有轮转到的前几个镜能判 motion，其余仍不能）—— 用"某些镜头更有证据"换取整片结论，代价是镜头间**证据地位不等**。成片终审的目的是**全片一致性**，每镜等量抽样是它的合理基线。
3. **同源问题在素材侧已有正确解法，且判据更硬**：`prepare_asset_review_media` 的"只要还有帧额度就逐场轮转补齐"（提交 `84df844`）+ `sequence_sampling = any(count > 3)`。素材侧之所以能这么定，是因为它按**单个素材**分配预算（一个素材可以被采成一段序列）；成片侧是**一整片共用 24 帧**，两者预算结构不同，不能直接照搬。
4. **成本**：验证这项改动需要至少一次真实终审（本轮实测单笔 GLM 审查 2.5–8 min、5–6 万 tokens），属预算内但非必需支出；而它并不阻断当前主线的收口（r15 的终审在 8/17 条 `not_observed` 的情况下仍给出了确定结论）。

### 触发重新评估的条件（写明，避免这条成为永久搁置）

同一片终审中，**在原则上可判定（static）的主张**也被迫记 `not_observed` 的比例高到让终审无法收口时，或出现"因缺帧而无法判定"直接导致返工时 —— 此时按素材侧同一合同改造 `_select_render_timeline_samples`（逐场轮转补齐至每镜 3 帧上限、并在有镜头达到 >3 帧时给出与素材侧同名的密集序列标志），并以一次真实终审对照改造前后结论。

**另记一条相关但不同的观察（同样未修）**：当场景数 ≥ 9 时（`max_frames < 场景数 × 3`），会整体退回"首屏 + 镜头中点"，每镜只剩 1 帧。这是**刻意的覆盖率优先**（注释：避免为了凑三帧而丢掉后续镜头），不是疏漏；但它与 3 帧分支之间存在能力落差。本片 7 场景不受影响，故同样只在报告中登记，不夹带改动。

---

## 13. 本段未验证 / 未完成清单（如实列出）

| 项目 | 状态 | 原因 / 下一步 |
| --- | --- | --- |
| `npm run test:broker`（完整门禁，含 `build:pipeline`） | **已补跑：219/219 通过** | r20 结束后重建 `dist` 不再是风险；`build:pipeline` 与 broker 全量已一并跑过（见 §14） |
| 修复 ② 的真实 GLM 验证（首事件实测、Provider 是否接受 `stream: true`） | **仍未验证** | 需重启 zai broker；r21 复验在途且正在使用该 broker，不能打断 |
| r20（`run-f8e2635f` rev 20）终态核验 | **已完成** | 04:13:24Z 以 `failed` 结束；`actualCostCny: 0` / `meteredAttemptCount: 0` ⇒ **实际付费增量 ¥0.00**，镜头 3、6 均 `carriedForward: true`。见 `checks/step-r20-authorize-reuse.txt`；失败真因见 §14 |
| 待裁决 B（终审帧预算） | **已给推荐，未修** | 见 §12 |
| 残留死角：付费镜请求身份真变 + 次数耗尽 → 仍 `reason: "attempts"` 无按钮 | **未修，上报** | 产品语义问题（"加钱能否解决"），不在本轮已授权范围 |

---

## 14. 试片双模型复审的并发媒体预处理冲突：一个本地竞态被报成"模型调用失败"

### 现象与问题定位的困难

r20 的 `assets` 节点失败原文：

> 镜头 6 已生成，但试片审查暂未完成，后续付费生成已停止。重试时会复用该镜头并恢复审查。试片双模型复审尚未完成：**gpt-5.6-sol 调用失败**。重试只会继续未完成的模型分支。

界面上操作员只看到 **"调用失败"**。这句话是 `publicModelFailure()` 的兜底分支，含义是"错误链里没有任何可识别特征"——也就是说，**系统自己也不知道发生了什么**。这一段的全部工作就是把这个兜底句还原成一条可复现的本地缺陷。

### 先排除，再下结论

| 候选解释 | 排除依据 |
| --- | --- |
| 模型输出错误 | gpt 分支的请求**根本没发出去**：openai 幂等库 11:44 之后无任何记录 |
| 提示词 / 验证合同矛盾 | 该分支尚未进入提示词组装，合同校验无从触发 |
| 传输恢复错误 | 无请求即无传输；broker 侧无对应任务 |

排除之后，剩下的路径是唯一的：`independentSourceReview()`（`codex-visual-review.ts:494`）把两个分支交给 `Promise.allSettled` **并发**跑，而 `CodexVisualReviewAgent.reviewDetailed` 在进入 `runRoleAgentLoop` 之前只有一件事会失败 —— `preparePayload()` → `PythonReviewMediaPreprocessor.prepare()`。

### 证据链（六条，全部实测，未调用任何真实模型）

1. `asset-pilot-reviews/91cd47f2…/`（场景 6 的证据目录）里**只有 GLM 的 `checkpoint-0d872417…json`**，没有 gpt 的 `checkpoint-419255f2…json`，也没有 `review.json` ⇒ gpt 分支死在循环之前。
2. 循环之前唯一能失败的路径是 `preparePayload()` → `PythonReviewMediaPreprocessor.prepare()`。
3. **Python 层并发复现**（临时根 `/tmp/vf-media-race-probe/`，**未触碰真实 run 目录**）：6 组并发对里 2 组有一个进程死于
   `OSError: [Errno 66] Directory not empty: '.asset-review-media-8aigc3lv' -> 'asset_review_media'`（`src/video_factory/review_media.py:832 _publish_directory`），且**无残留 backup 目录** ⇒ 命中的是 `had_output == False` 那条交错分支。
4. **Node 层闭环**：同一份输入、6 轮并发里 1 轮得到
   `Visual-review media preprocessing failed. The source video and local paths were not sent to the client.`，操作员侧即 **"调用失败"**，与 r20 报告**逐字一致**。
5. 失败率与时序相关（Python 2/6、Node 1/6），解释了"同一次运行里场景 3 过、场景 6 挂"。
6. r20 素材阶段 03:42–04:13Z 确实有 gpt 分支进来过，否则失败记录里不会留下 `gpt-5.6-sol` 这个名字。

⇒ **不是模型输出错误，不是提示词/合同矛盾，不是传输恢复错误，而是本地媒体预处理的并发写冲突 + 错误被裸 `catch` 吞掉。**

### 修复

在 `apps/studio/src/server/review-media-preprocessor.ts` 做两件事：

1. **主修：按预处理身份做 in-flight 去重。** `prepare()` 拆成入口 + `prepareFresh()`，入口维护 `inFlight: Map<key, Promise<payload>>`，`settle` 即删。键由命令里出现的全部字段组成（`runRoot` / `assetPlanPath` / `videoPath` / `renderManifestPath` / `scenePositions` / `scriptPath` / `executablePlanPath`）——**只合并同时进行的相同请求，不做跨次缓存**：素材变了必须重新采帧。每个调用方拿 `structuredClone` 副本，保住 `codex-visual-review.ts:376` 那条既有 BG-08 不变式（分支内的原地改写不得泄漏给另一分支或共同快照）。
2. **可诊断性：不再裸 `catch`。** 错误消息改为带上**机器产生的失败分类**（`exit code N` / `terminated by SIGx` / `timed out after 600s` / `could not start the preprocessor (ENOENT)`）；子进程 stderr 可能含本地绝对路径，**只进服务端日志**（默认 `console.error`，本地部署落在 `.local/runtime/qa-r11-repair-20260914/studio.log`），**错误消息里一个子进程字节都不带**——"本地路径没有发给客户端"这条既有性质与它的断言原样保留，一个字都没放松。

### 为什么这是通用修复，不是题材特判

去重键是**内容无关的预处理身份**，与题材、镜头数、模型组合无关。被合并的是"同一份证据被并发请求"这一通用情形；顺序到达的同身份请求仍各跑一次。任何视频、任何审片模型走的是同一条代码路径。

### 一个**明确不做**的决定（连同上报）

不给 `review_media.py::_publish_directory` 加"容忍并发发布方"的补丁。它是多进程竞态的现场，但唯一可行的语义（发现目标目录已存在就接受对方的产物）在**两个不同审查**撞车时会**静默发布错误证据**——用"可能审错"换"不报错"，是必须避免的隐性错误。正确做法是让知道身份的调用方串行化（即上面第 1 条），多进程限制登记为已知约束。

### 验证

| 检查 | 结果 |
| --- | --- |
| 新增确定性用例 3 个 | 见下表 |
| **mutation 校验** | 源码临时还原到修复前（`git checkout --`）→ **2 个用例转 RED**，报错逐字命中目标缺陷（`actual: 2, expected: 1`；消息里无 `exit code 23`）；复原后 **15/15 GREEN** |
| `tsc -p tsconfig.server.json` / `tsconfig.client.json` | 均 0 错误 |
| studio 全量（`vitest run` + `node --test`） | vitest **405/405**；node --test **543 pass / 0 fail** |
| `npm run test:ts` | **867 tests / 866 pass / 1 skipped / 0 fail** |
| `npm run test:broker`（含 `build:pipeline`） | **219/219** |
| `npm run studio:build` | 成功；`dist` 内可 grep 到修复，随后重启本地 studio（新 PID） |

| 用例 | 断言 | 修复前 |
| --- | --- | --- |
| 并发相同请求只跑一次子进程、两个调用方各拿一份独立副本 | 子进程计数 = 1；两份 payload 内容相等但对象不同；改写其一不影响其二 | **RED**：`actual: 2, expected: 1` |
| 不同身份各跑一次、settle 之后不复用 | 并发不同身份 = 2 个子进程；顺序重发同身份 = 第 3 个子进程 | GREEN（反向护栏：防"合并过头 / 变成缓存"） |
| 失败分类对操作员可见、真实原因只留在服务端 | 错误消息含 `exit code 23`、不含临时根路径与 stderr 内容；注入的服务端 sink 恰收到 1 条且含真实 stderr 与失败命令 basename | **RED**：消息里只有泛化句 |

### 本节的诚实边界

- 复现是在**临时根**上做的（`/tmp/vf-media-race-probe/` 与一个只读探针脚本），**没有为了造证据去改动真实 run 目录**；真实 r20 目录只读。
- Python 层 2/6、Node 层 1/6 是**时序相关**的观测值，不是固定失败率；它们证明的是竞态存在且能落到这条错误上，不是"必然失败"。
- 修复后是否真的让 r20 那条分支跑通，由 §15 的受控复验回答，不由本节推断。

---

## §15 修复后的受控复验（r21）：并发修复生效，但主线被一次**合法**的双模型否决拦在场景 6

§14 末尾写明"修复后是否真的让 r20 那条分支跑通，由 §15 的受控复验回答"。本节就是那个回答，同时给出一个与预期不同的结果：**修复成功了，但主线没有因此恢复**——它撞上了一次货真价实的素材否决。

- 复验脚本：`docs/qa/videofactory-real-local-qa-20260914-r11-takeover-assets/harness/step-r21-retry-pilot-review.mjs`
- 逐字输出：同目录 `checks/step-r21-retry-pilot-review.txt`
- 动作：对 r20 的 `assets` 失败节点发一次产品自己的 `POST /api/runs/:runId/nodes/assets/retry`

### 15.1 三条判据（复验前先定，避免"跑通了就算"）

1. 实际付费增量必须为 **¥0.00**；
2. 场景素材文件哈希**逐字节不变**（复用的是同一个文件，不是重买了一个同名文件）；
3. gpt 分支要么补跑成功、要么给出**可定位的新原因**——不允许再退回"调用失败"。

### 15.2 结果：三条全中，原失败消失

| 项 | 复验前 | 复验后 |
| --- | --- | --- |
| run 状态 | `failed` revision 20 | `rejected` revision 21 |
| metered 花费 | ¥17.00（3 笔） | **¥17.00（3 笔）** |
| 素材 attempt | `attempt-3` | `attempt-4` |
| 场景 1–7 素材哈希 | — | **0 个变动** |
| 试片证据 `91cd47f2` | glm `true`｜gpt **`false`**｜结论 **`false`** | glm `true`｜gpt **`true`**｜结论 **`true`** |

- ★ **付费增量 ¥0.00**、★ **素材变动场景数 0**、★ **gpt 分支补跑完成**——r20 那句 `gpt-5.6-sol 调用失败` **已消失**。
- 补跑后的报告自身记录两个分支都已到齐（这同时修正了我先前"gpt 从不写 checkpoint"的误判——那个文件**时有时无**，判据应改用 `review.json` + `reviewScope.actualModels`）：

```json
"actualModels": [
  { "providerId": "zai-bigmodel-api", "modelId": "glm-5.3-flash" },
  { "providerId": "openai",          "modelId": "gpt-5.6-sol"  }
]
```

### 15.3 但节点结果是 `rejected`：与 r20 完全不同性质的一次否决

必须把两者分开看：**r20 是"两个分支有一个根本没跑起来"（传输/本地故障）；r21 是两个分支都跑完了、并且结论相反（模型判断分歧）。**

- 采样 `mode: "scene_sequence"`，24 帧覆盖场景 6 整条 4.5 秒素材（94ms → 4406ms，≈188ms 间隔）。**两个模型看的是同一批帧。**
- `glm-5.3-flash`（`satisfied`）：停步后"肩线与头部朝向墙面光影轻微调整"。
- `gpt-5.6-sol`（`failed` / `severity: critical` / `nextAction: rework_asset`）："主体已经停住，但头部与肩线直至结尾基本保持同一朝向，未形成可辨认的轻转向墙面光影"。
- 合并取保守侧：`recommendation = "reject"`，`confidence 0.78`。

### 15.4 操作员零成本复核：否决成立，这是真缺陷

按场景 4 的先例（**证据与模型结论冲突时先看画面，不先花钱**），逐帧读了 24 帧中的 6 帧（`scene-06-12/14/17/19/21/23`，跨越两个主张窗口）：**每一帧都是同一个静态背影，肩线正对镜头保持不动，头部朝向只有生成噪声级的微抖，读不出一次有方向的"转向"**；`19/21/23` 三帧姿势几乎重合，期间只有背景行人继续穿过。

而这个转向**是方案自己写明的成功判据**，不是我替它加的：

```
"visual_prompt": "…人物在一面带树影的明亮墙边明确减速，停住约一秒，肩线或头部轻轻转向墙上的光影…"
"success_criteria": ["同一连续镜头完整覆盖快走、减速、停住和轻转四个阶段", …]
```

⇒ **判定：gpt-5.6-sol 的否决有画面依据，素材没兑现它自己方案里的成功判据。这与场景 4 那次（模型结论与画面证据相左 ⇒ 登记冲突、不据此返工）**不同型**，因此**不能**照搬"不返工"的结论。**

### 15.5 状态（严格区分）

| 项 | 判定 |
| --- | --- |
| §14 的并发媒体预处理修复让 r20 的失败分支跑通 | **通过** |
| 付费增量 ¥0.00、未重买已生成素材 | **通过** |
| 原"gpt-5.6-sol 调用失败"消失 | **通过** |
| 主线恢复到成片 | **阻塞**——场景 6 素材未过试片双模型复审，需重做该镜并重新报价 |
| 本轮 metered 合计 | **¥17.00 / ¥50**（两条 run 中仅 `run-f8e2635f` 有消费） |

### 15.6 本节的诚实边界

- 我的逐帧复核**读了 24 帧中的 6 帧**，不是全量 24 帧；结论强度与"6 帧覆盖两个主张窗口且未见转向"相称，不宣称已证明每一帧都无转向。
- 这**不构成**对双模型复审机制的否定：它这次是**按设计工作**的（分歧取保守侧），只是保守侧恰好与画面证据一致。
- `rejected` 是终态；主线要恢复必须走"调整方案 → 重新报价 → 重生成场景 6"。该路径存在（`GET /api/runs/:runId/rework-draft` 接受 `rejected`/已打回 的 run），且**不必新建 run**（同一条 run 出新版本）。
