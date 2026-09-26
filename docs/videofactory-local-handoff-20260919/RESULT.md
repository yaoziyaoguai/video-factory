# 执行结果与接续（唯一更新入口）

状态：LOCAL_STOCK_CODE_VERIFIED（P0–P4 历史确定性完成；Unsplash 已接线并离线验证；国内采购未接入、待准入与计价合同）
资料包基线：08b8b000180cdf7b8ec5d509e64ab436f1dcf09d
当前执行端/模型：Codex 本地执行；未调用任何模型
本轮真实新增调用：0
本轮新增费用：0（公开资料调研与本地实现/验证；未采购）
本轮收费授权：无新额度；旧 ¥50 不沿用
用户作品验收：未进行

## 当前接续

P0–P4 的源码、构建和确定性回归已在前一批收口；下面保留其历史记录，不把它们冒充本轮重新执行。最新素材扩展结果见文末「素材来源扩展」。真实模型/媒体制作未进行；Unsplash 留待用户配置，国内付费图库还需确认 API 合作准入、计价与授权范围，不能报告为“全部只剩 key”。

## 基线变化

执行开始时间：2026-09-19 19:45 +08:00
实际 HEAD / 分支：08b8b000180cdf7b8ec5d509e64ab436f1dcf09d / main
原有 tracked / untracked：接管时已有 11 个 tracked P0 修改；保留 3 份既有未跟踪审计资料和本包 8 份文档，未清理、未覆盖。
运行时与 ABI：Node v26.8.1、npm 11.19.0、Node ABI 147、better-sqlite3 12.11.1。未因 ABI 证据修改业务代码。
与 BASELINE 的差异及处理（保留原修改）：HEAD 与基线相同；P0 工作树为已有单审改造。发现单审 UI 漏掉 auditVerdict 的真实回归后，先补失败断言再最小修复；未回退既有改动。

## 实施进度

| 批次 | 状态 | 实际修改/已满足无需改 | 失败证据→修后证据 | 剩余 |
|---|---|---|---|---|
| P0 | DONE | 新 production 固定 DeepSeek 单审+独立角色复核；历史双审仅按严格只读证据验证。修复单审 UI 遗漏独立审计提示，以及残缺双审被误读为单审的 guard。 | 单审 UI auditVerdict 断言 RED→GREEN；Pipeline 旧双审保护测试先因新开工合同 RED，改为历史载荷测试后 GREEN。 | 全量/构建受外部旧 suite 占用，留 P4 串行运行。 |
| P1 | DONE | 完整负面试片转为 `needs_human/source_review_decision`；完整证据绑定、同一操作恢复、审查无结果专用重试、报价不变复用授权/报价变化失效均已接通。修正计费请求前的临时已消费标记不会在已知结果后永久锁住同一操作。 | WorkflowRunner 新增授权复用与报价变化两条 RED→GREEN；正式 Worker/Pipeline、Studio service、HTTP 路由与界面均有聚焦证据。 | 真实模型、媒体、TTS、成片、人工终审未运行（无新付费授权）。 |
| P2 | DONE | 只有显式模型生命周期码才允许切换；账户、费用、鉴权和流式 EOF 均有可追溯的作用范围与安全停点。 | 61 个 Broker 聚焦测试、101 个 broker/fallback 协议测试、46 个角色恢复测试、Studio 正式恢复 5/5 均通过；typecheck exit 0。 | 全量/构建受 P4 串行统一验证；真实模型、媒体、TTS、成片仍未运行（无新付费授权）。 |
| P3 | DONE | 新建 run 冻结模型选择；节点清除临时覆盖时回到该 run 的冻结值；Brief 不能篡改冻结选择；设置页按文本、多模态、图片、视频、声音五类展示，NewRunDialog 保持轻量。 | `role-agent-assembly` 旧错误文案断言 RED→GREEN（44/44）；相关跨层回归纳入根测试 920 pass / 0 fail / 1 已说明 skip。 | 真实模型未运行（无新授权）。 |
| P4 | DONE | 修正 Wan 超时用例的测试竞争：先确认任务受理，再验证轮询超时；未改变生产超时逻辑。完成全量构建、包入口、Python 回归及无付费界面核验。 | `video-generation` 24/24 RED→GREEN；typecheck、根测试、Broker、Studio、build、package、Python 和 diff-check 全部通过。 | 未生成真实成片、未播放/听声、未执行真实审片或用户终审。 |

## P0 实际证据

- `apps/studio`：`npx vitest run test/client.test.tsx`，161/161 pass，exit 0。
- 仓库根：`node --test --test-timeout=300000 --import tsx apps/studio/test/role-agent-assembly.test.ts apps/studio/test/studio-service.test.ts`，141/141 pass，exit 0。
- 仓库根：`node --test --test-timeout=300000 --import tsx packages/production-pipeline/test/codex-visual-review.test.ts packages/production-pipeline/test/production-pipeline.test.ts`，ProductionPipeline 150/150 pass，CodexVisualReviewAgent 及合同套件全绿，exit 0。
- 仓库根：`git diff --check`，exit 0。
- RED 证据：单审报告带 `auditVerdict: repair` 时，`shows one complete DeepSeek review as a finished independent quality review` 找不到 `role=note`；原因是汇总 Map 的 identity key 丢失 `\u0000` 分隔符。修复后该用例与既有双审 audit scope 用例均通过。
- 未将旧双审测试删除或改成新 production：改为明确的历史双审载荷（`runPurpose: test`），仍覆盖残缺、同身份、证据/合同篡改和分支不匹配；新 production 另有完整 DeepSeek 单审发布测试。

## P1 实际证据

- 根因：计费调用在发出前会把授权暂记为不可复用，以防进程中断重复购买；已知的完整试片结果没有清除该临时锁，导致用户接受质量意见后即使报价、范围、输入和操作都未改变，仍被错误送回报价确认。
- `packages/workflow-core/test/workflow-runner.test.ts`：`WorkflowRunner` 69/69 通过，exit 0。新增两条合同：同一操作且计划未变时复用原授权；报价从 ¥4 变为 ¥6 时保留试片、进入 `approval_invalidated` 且第二次 provider 调用为 0。
- `packages/production-pipeline/test/generative-asset-worker.test.ts` 与 `packages/production-pipeline/test/production-pipeline.test.ts`：3 个套件 212/212 通过，exit 0。覆盖 direct/director 两条试片路线、无结果专用重试、已物化媒体保留、证据篡改 fail-closed 和同操作恢复。
- `apps/studio/test/studio-service.test.ts`：130/130 通过，exit 0。覆盖专用重试、恢复投影、并发和付费恢复边界。
- `apps/studio/test/server.test.ts`：42/42 通过，exit 0。新增浏览器 API 到服务端的证据 ID 透传/畸形 SHA 拒绝检查。
- `apps/studio`：`npx vitest run test/client.test.tsx`，162/162 通过，exit 0。界面明确展示“调整方案 / 承担后继续 / 终止”，并只传回服务端签发的证据 ID。
- `npm run typecheck` 与 `git diff --check` 均 exit 0。期间修复三处先前未被完整类型检查覆盖的严格类型问题：试片请求参数读取、单审 DTO 的推荐枚举、可选配音时长的测试断言。
- 不读取、不输出、不轮换 DeepSeek key；没有启动真实模型或媒体任务；新增请求 0、费用 ¥0；没有 commit、push、云部署或修改历史 run。

## 验收登记

A01–A30 是前一批完整项目验收要求，不是本轮新增素材接口的验收编号。历史执行记录没有逐项证据索引，不能从总通过数推断每项都已满足。诚实登记如下：

| ID | 当前可据以判断的证据 | 尚未覆盖/本轮处理 |
|---|---|---|
| A01–A02 | P0 的单审 assembly/UI、历史双审只读保护记录 | 确定性已记录；真实模型未验，本轮未重跑单审专项 |
| A03–A10 | P1 的 WorkflowRunner、正式 worker/Pipeline、Studio/HTTP 聚焦记录 | 有确定性证据，尚无逐项 direct/路由、全部重启时点的独立映射；不写整组完全通过 |
| A11–A12 | P2 明确模型生命周期、鉴权、余额及限流合同记录 | 确定性已记录，真实账号故障未验 |
| A13–A17 | P2 role loop、恢复、SSE、参数选择测试记录 | 部分覆盖；不能仅凭套件总数宣称全部 deadline/统计组合已验 |
| A18–A21 | 既有 creative-review、讨论 UI、编辑/版本合同 | 本轮未逐项复验，不由素材扩展套件代替 |
| A22–A24 | P3 冻结默认、五类设置、轻新建的测试和只读浏览器记录 | 部分覆盖；全入口、全保存/重启组合未逐项登记 |
| A25–A26 | 既有正式生产图与参数合同测试 | 本轮未做专项证明，不宣称全覆盖 |
| A27 | 确定性生产链与资源 manifest 测试 | 真实完整制作、播放听声和返工未验证 |
| A28 | 前轮只读 UI；本轮 390/1440 素材设置页与入口核验 | 本轮只证明布局/入口，不证明真实费用、恢复和并发编辑 |
| A29 | P4 历史全量；本轮文末列出实际命令和日志 | 本轮重跑相关套件、typecheck/build/package/Python，未重跑全部 Broker/全仓 TS |
| A30 | 历史记录与本文末最新交付范围 | 用户作品验收仍未进行，无远程操作 |

## 决策和偏离

已发现根因：
与计划不同的最小必要实现：
旧测试合同需要修改的理由：
需要用户决定的最小问题：
禁止操作/保护边界核对：

### P0

已发现根因：新单审 UI 分支只构造模型身份，读取独立审计判定时没有使用与 Map 写入相同的 identity 分隔符；发布守卫按 actualModels 数量推断模式，会把残缺的历史双审伪装成单审。

与计划不同的最小必要实现：保留 `codex-*` 类型/目录作为共享历史协议，不重命名；将历史双审测试切到不允许新 production 的测试载荷，而非放宽新 production gate。

旧测试合同需要修改的理由：原测试以新建 formal production 驱动 dual review，已与用户确定的“新 production 只有 DeepSeek 单审”相冲突。其断言对象改为历史双审证据的读取与防篡改，不删减任一安全检查。

需要用户决定的最小问题：无。

禁止操作/保护边界核对：未读取/输出凭据；未启动或控制真实模型任务；未接触历史 run；未 commit、push、云部署或外部发布。

### P1

已发现根因：计费请求出站前的安全锁在已知结果返回后没有解除；它本应只保护 outcome unknown，却把已物化试片的同一授权误当成不可继续使用。

与计划不同的最小必要实现：没有新建状态服务或授权平台。在现有 `consumedSpendAuthorizationIds` 账本中，仅当节点存在原授权且 `outcomeUncertain` 已清除时移除临时锁；若输入、provider、模型、尝试上限、报价项目、免费排除项或金额不匹配，现有 `approval_invalidated` 路径保留并要求新确认。

旧测试合同需要修改的理由：`StudioDecisionInput` 的 `request_changes` 已允许非配音节点的调整，旧客户端测试仍把配音时长错误写成强制字段；改为验证其可选性，同时继续禁止在 approve/reject 中携带它。

需要用户决定的最小问题：无。真实媒体/模型验证仍需要本轮之外的新付费授权。

禁止操作/保护边界核对：未读取/输出凭据；未启动或控制真实模型任务；未接触历史 run；未 commit、push、云部署或外部发布。

### P2

已发现根因：裸 HTTP 404 与明确模型退役此前被混为同一类，模型账户余额/账号限流又缺少“影响整账户还是单模型”的结构化范围；SSE 在收到内容但没收到终止帧时可被误当成完整返回。

实际修改：模型切换只接受 `model_not_found`、`model_not_exist`、`model_retired`、`model_deprecated` 等明确生命周期码。401/403、402/明确余额码和账号级 429 统一透传 `scope=provider_account`；鉴权不切换，账号级故障跳过同一 provider 的其它模型，只有已配置的不同 provider 才可作为独立候选。SSE 必须收到 `finish_reason` 或 `[DONE]`，并覆盖 UTF-8 跨分块；EOF 截断记录 `stream_incomplete`，不产生成功回执。

失败→通过证据：

- `apps/codex-broker/test/chat-completions-executor.test.ts`：61/61，exit 0；覆盖显式退役/裸 404、401/403、402、429、UTF-8 分块、缺少终止帧。
- `packages/production-pipeline/test/codex-chat.test.ts`、`fallback-task-client.test.ts`、`fallback-role-agents.test.ts`：101/101，exit 0；覆盖原 requestId 观察、已受理不双跑、同账户候选跳过和鉴权停止。
- `packages/production-pipeline/test/role-agent-loop.test.ts`：46/46，exit 0；覆盖有界 session 重建、迟到成功/失败、物理调用计数和恢复。
- `apps/studio/test/text-task-production-recovery.test.ts`：5/5，exit 0；正式 Studio → Pipeline → Broker 恢复链。
- `npm run typecheck`：exit 0。

延期：不在没有新付费授权的条件下调用真实文本模型、媒体、TTS 或成片审查。P2 未改变模型质量、输出上限、32MiB 流上限、原请求观察语义或用户的推进权。

### P3

已发现根因：模型默认值、单次制作冻结值和节点临时覆盖在旧测试与页面文案中没有完全区分，容易让用户误以为修改全局设置会改变正在制作的项目。

实际修改/确认：新建制作保存其模型冻结值；清除节点级覆盖回到该制作创建时的冻结值；内容 Brief 只是创作输入，不能越权改写冻结模型选择。设置页把可选能力明确分为文本、多模态、图片、视频、声音五类；新建入口只保留必要字段，参考来源保持折叠的可选项。

失败→通过证据：

- `apps/studio/test/role-agent-assembly.test.ts`：44/44 通过，exit 0。旧测试只匹配过时、可变的错误文字；改为验证稳定的“候选模型调用未能完成”合同，不改变生产错误处理。
- 根仓库 `npm run test:ts`：920 pass / 0 fail / 1 已说明 skip，exit 0。
- 本地界面只读核验：创作设置明确呈现五类模型及“只影响后续新建制作”；从“自己的想法”进入的手动录入弹窗只包含标题、平台、受众、痛点、钩子，参考来源为可选折叠项。未保存机会、未创建 run。

禁止操作/保护边界核对：未读取或输出凭据；未向真实模型、媒体或 TTS 发请求；未改动既有 run；未 commit、push、云部署或外部发布。

### P4

已发现根因：Wan 超时测试把 POST 提交和受理后的轮询时间预算压到同一个 1ms 窗口，慢机器会在拿到 `taskId` 前先超时，形成测试竞争而不是生产行为缺陷。

实际修改：测试先确定任务已受理，再对轮询阶段施加超时；生产请求、超时策略和模型选择均未修改。

失败→通过证据：

- `packages/production-pipeline/test/video-generation.test.ts`：24/24 通过，exit 0。
- `npm run typecheck`：exit 0。
- `npm run test:ts`：920 pass / 0 fail / 1 已说明 skip，exit 0。
- `npm run test:broker`：252/252，exit 0。
- `npm run studio:test`：Vitest 443/443；Studio Node 593/593，exit 0。此前遗留的长运行旧进程没有被终止或作为本轮结果；本轮独立运行结果为准。
- `npm run build`、`npm run test:package`（3/3）及 `PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests`（132/132）均 exit 0。
- `git diff --check`：exit 0。构建唯一警告为 Vite 压缩后单个 JS chunk 超过 500KB；不影响正确性，本轮不扩大到拆包优化。
- 本地只读界面核验（`http://127.0.0.1:4317`）：1440px 下创作设置与“前期构思讨论→用户确认后继续”清晰可达；390px 下手动录入弹窗、关闭操作和移动端主导航均可达。未点击“确认当前方案，继续”、未开始制作、未保存设置或机会。

禁止操作/保护边界核对：无新收费授权，真实文本、图片、视频、TTS、成片和真实审片均未执行，新增费用 ¥0；未 commit、push、云部署或外部发布。

## 测试与 QA 问题

问题 ID / confirmed或hypothesis / 证据链接 / 用户影响 / 是否主线阻断 / 修复范围 / 验收。

## 真实本地执行与费用

授权原文与时间（若后来取得）：
预算范围、总额、已用、余额：
run/节点/真实模型/effort/操作身份：
逻辑复核数、物理调用数：
资产来源/许可/媒体费用/TTS/文本费用：
unknown费用及是否保留暂停：
真实成片、播放/听声、用户终审：
未执行事项及原因：

## P0–P4 历史交付（不是当前素材扩展的工作树快照）

开始/结束 HEAD与工作树：`08b8b00` / `main` 未变；结束时保留既有 35 个 tracked 修改与 `docs/` 未跟踪资料，不 reset、clean、stash 或覆盖。
修改文件及必要性：本批实际测试层改动仅为 `apps/studio/test/role-agent-assembly.test.ts` 的稳定错误合同断言，以及 `packages/production-pipeline/test/video-generation.test.ts` 的确定性轮询超时边界；`RESULT.md` 为本轮唯一状态记录。
聚焦/全量/typecheck/build/package/Python命令、退出码与证据：P3/P4 节分别列出；所有列明命令 exit 0。
L1/L2/L3分别达成范围：L1（静态/类型/构建）通过；L2（确定性单元、跨层合同、包入口、Python）通过；L3 仅完成无付费的本地浏览器可用性核验。
已通过 / 失败 / 未验证 / 明确延期：通过 P0–P4 的确定性范围；失败 0。未验证且明确延期：真实文本模型、付费图库/视频、图片/视频生成、TTS、完整成片、真实审片、局部返工、播放/听声和用户终审，原因是没有本轮新收费授权。
源码与运行build是否一致：`npm run build` 成功后进行本地界面只读核验；未对运行服务作任何写入型操作。
服务状态、在途任务：本地 Studio `http://127.0.0.1:4317` 在核验时返回 200；未新建、推进或修改任何 run。
是否commit/push/云部署：否。
用户作品验收状态：待用户在真实成片完成后验收。
当时的下一接续：真实端到端制作待新授权，素材扩展待后续。此范围已被用户后来要求扩充素材来源所更新；以以下最新结果为准。

## 素材来源扩展（2026-09-19–20）

### 用户要求与范围

- 用户要求完成本地剩余项、扩充国内外图片/视频素材来源，真实 API/账号配置留给用户；最新明确作品用于个人娱乐、非商业用途。
- 不因“禁止商用”排除允许个人用途的资源。剪辑、公开传播、署名、自动下载分别核实；没有新增必须商业授权的制作门槛。
- 保留 DeepSeek 单审、用户确认推进、现有图片/视频生成来源、报价授权、媒体复用、恢复和版本检查。不新增采购平台，不复活 GPT/双审，不改用户历史制作。

### 已完成

1. Unsplash 免费图片正式接入：配置检测 → 导演图片能力 → Python 搜索 → 私有候选库存 → 采用时下载上报 → 本地物化 → 权威产物 → 素材库/授权清单/发布包。只提供图片，不让静态图片冒充视频。
2. 搜索/预览不报下载，采用时上报；上报失败不下载、不自动反复上报。鉴权 API 不跟随重定向；CDN 下载不带 key；公开候选和产物不暴露下载跟踪地址或 key。
3. UI 使用官方 CDN 并保留必要参数、摄影师和 Unsplash 链接。新增“配置外部素材来源”入口；国内目录明确标注“尚未接入”，不作为可选生产来源。
4. 作者链接与预览从权威产物保存；候选编辑不能篡改作者链接，人工替换媒体不继承原素材的作者/预览。新接口暴露了通用静态图片物化时长为 0 的问题，现改为按镜头时长，视频时长处理不变。
5. 官方调研摄图、海洛、包图、新 CG 儿等国内来源，以及 Unsplash/Adobe；成功核实与未取得资料的来源逐一分开。详情在 `06_STOCK_SOURCE_RESEARCH.md`。
6. README 更新本地 DeepSeek 单 Broker/单审说明；新增 `docs/guides/stock-sources.md`，不引导当前任务走远程部署，不写虚构国内环境变量。

### 当前仍未完成

- **国内付费素材自动搜索/采购尚未实现。** 摄图、海洛不是普通会员填 key 即可使用；缺 API 合作账户、实际许可范围、套餐/计价及重复下载规则。已向用户询问正式 API 接入与人工采购路线，尚未得到明确选择；个人非商业用途已确认，但不等于供应商已授予自动下载权限。
- 没有为新 CG 儿、包图等未核实正式 API 的来源抓取下载；它们可适合个人用途，不等于已实现自动接入。
- Unsplash 真实鉴权、搜索质量、国内连通性、下载上报与正式额度尚未用用户账号验证；配置说明已给出。
- 本轮不以确定性通过代替真实成片、TTS、单审或完整 E2E 验收。

### 实际验证

全部命令在仓库根运行，Vitest 标注项在 `apps/studio`。日志统一在 `output/playwright/stock-sources-20260919/`。以下套件有重叠，**不要把测试数量相加**。

| 检查 | 实际结果 | 原始日志 |
|---|---|---|
| Node 合同组：python-worker-client、asset-semantic-ranker、generative-asset-worker、production-pipeline、production-worker、resource-governance-studio | 266/266，exit 0 | `contracts.log` |
| 新增协议解析后单跑 python-worker-client | 5/5，exit 0 | `worker-protocol.log` |
| 最后来源不可变/人工替换防误署名补充：studio-service | 131/131，exit 0 | `studio-service-final.log` |
| Studio Vitest 全量 | 451/451、22 文件，exit 0；随后新增署名单测另列 | `studio-ui.log` |
| 署名、素材库、授权清单 Vitest 聚焦 | 18/18，exit 0 | `ui-focused.log` |
| `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests` | 139/139，exit 0 | `python-final.log` |
| 最后修改后的 `npm run typecheck` | exit 0 | `typecheck-final.log` |
| 最后修改后的 `npm run build` | exit 0；既有 Vite 单 chunk >500KB 警告，不扩展拆包 | `build-final.log` |
| 最后修改后的 `npm run test:package` | 3/3，exit 0 | `package-final.log` |
| `git diff --check` | exit 0 | 最终命令退出状态 |
| `graphify update .` | exit 0，AST 增量更新；图超过 5000 节点，HTML 按工具上限跳过，不继续折腾 | `graphify-update.log` |

关键新增断言包括：`test_selected_download_is_tracked_before_media_without_sending_key_to_cdn`、`test_failed_download_tracking_does_not_download_or_retry`、`test_video_is_rejected_without_network_or_silent_image_substitution`、`test_worker_preserves_attribution_and_preview_in_the_authoritative_artifact`，以及 Studio 的 `derives unchanged asset provenance from the immutable media artifact`。

本地真实浏览器只读检查：`http://127.0.0.1:4320/resources#visual-providers`，Unsplash 显示“需要配置”、国内目录明确未接入；390px/1440px 的 document scrollWidth 分别等于 390/1440，无页面横向溢出。截图：`sources-mobile.png`、`sources-desktop.png`、`domestic-directory.png`。素材库页面的“配置外部素材来源”入口指向该分区。未伪造 API 就绪，未保存设置、未新建/推进制作；外部 API 的成功搜索和素材预览不在本轮真实浏览器证据中。

### 基线、权限和费用

- HEAD 保持 `08b8b00`；本地分支 `codex/stock-source-expansion-local`。开始已有约 48 个 tracked 修改及未跟踪文档，原始差异保存在 `output/playwright/stock-sources-20260919/baseline.patch`；保留而不覆盖，不把整个脏工作树混合提交。
- 没有读取用户密钥、启动真实模型、采购媒体、修改历史 run、commit、push、云部署或外部发布，新增费用 ¥0。
- 有公开官方文档网络请求；早期测试 mock 位置错误曾触发匿名不存在的 CDN 图片请求（404），随后改为隔离真实网络边界。最终列明的素材测试不使用真实账号，不把早期失误掩盖为“整个过程无网络”。
- 最终只做一次 `graphify update .`，不另建语义抽取/图优化任务。
