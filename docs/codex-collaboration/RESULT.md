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
