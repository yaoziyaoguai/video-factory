# VideoFactory 第六轮真实本地 QA 报告（revision 7）

- 报告编号：`VF-REAL-LOCAL-QA-20260913-06`
- 日期：2026-09-13
- 模式：`qa-only` / report-only；真实服务、真实模型，QA 阶段只记录不修改产品
- 分支：`codex/final-dual-review-cloud-acceptance`
- HEAD：`570fe6e59e072c4965c86769bf2096825f003383`
- 开始时间：2026-09-13 10:21:37 +0800
- 目标：`http://127.0.0.1:4317`

## 1. QA 前安全门与正式环境

- 确定性回归、production build、source/dist 正式组合检查均已通过后才启动本轮服务。
- 旧 OpenAI Broker PID 42143、ZAI Broker PID 42144、Studio PID 59645 均来自本仓库，启动时间早于最终构建。两个 Broker `active=0/queued=0`，Studio 无正在执行的 run；三进程均以 TERM 正常退出。
- 本轮最终 dist：Broker `apps/codex-broker/dist/main.js` 构建时间 10:11:46；Studio server 10:11:57，client 10:11:54。
- 新 OpenAI Broker PID 5993、ZAI Broker PID 5994、Studio PID 5996；工作目录均为本仓库。Studio 使用 production dist 和显式的两个真实 socket；没有 fake/mock/fixture 服务。
- OpenAI 与 ZAI 的正式 Studio consumer probe 均 `available=true`，各识别 10 类任务和 10 个 canonical digest。ZAI 同时识别 `asset-rank`、`role-audit` 的有图/无图模型路由。
- `/api/providers` 实际返回本轮十个关键角色均 `available=true,status=ready`。OpenAI 默认 `gpt-5.6-sol`；ZAI 文本 `glm-5.3`，视觉 `glm-5.3-flash`。
- Studio `/api/health` 为 `ok`，Python/FFmpeg/ffprobe/say 全部可用。旧 durable storeId、checkpoint、workspace、历史 run 和登录配置均保留。
- 登录页与首页成功加载，qa-local 正式认证成功，console error=0。证据：`videofactory-real-local-qa-20260913-06-assets/01-initial-1440.png`、`02-home-1440.png`。

## 2. E01–E07 覆盖表

| ID | 范围 | 状态 | 当前证据 |
| --- | --- | --- | --- |
| E01 | 三入口到真实规划/方案/报价 | BLOCKED | 自有想法在前期构思提交前发生合同错配；系列真实构思通过但编剧三轮不通过；热点 0 条具备有效来源，均未到方案/报价 |
| E02 | 报价三动作、暂停与显式恢复 | PARTIAL | 系列 run 的查询原任务与暂停请求已实测；未到报价，显式恢复无可继续节点 |
| E03 | 代表性新片媒体、TTS、渲染 | BLOCKED / NOT_VERIFIED | 三入口均未到报价；媒体 create=0、TTS=0、Provider media taskId=无，新增消费 ¥0.00 |
| E04 | 两个真实模型同 evidence SHA 独立审片 | BLOCKED / NOT_VERIFIED | 两个真实审片角色 ready，但没有新成片/evidence SHA，未提交审片 |
| E05 | 审片建议预填与局部返工复用 | BLOCKED / NOT_VERIFIED | 没有真实审片结果，未制造缺陷或扩大返工范围 |
| E06 | 刷新/重启恢复、1440/390 | PARTIAL | 运行中查询原任务与暂停无重复调用；新 run 刷新、Studio 正常重启后持久化、1440/390 均通过；未到可显式恢复的后续节点，未测试付费 Broker 恢复 |
| E07 | 新片技术与创作质量 | BLOCKED / NOT_VERIFIED | 本轮无新成片，不能评价帧数、时长、声画同步或创作质量 |

## 3. 费用与止损账本

- 本轮新增媒体与 TTS 止损线：`¥50.00`。这是 QA 资源线，不写入产品费用逻辑。
- 当前实际新增支出：`¥0.00`。
- 每笔付费 create 前记录精确报价、Provider、模型、镜头范围、已有消费；付费结果 unknown 时只观察原任务，不确认第二笔。

## 4. 问题与阻断记录

### QA-R7-01：正式角色 ready，但自有想法的真实前期构思在 Broker task 边界被拒绝（P1，阻断）

- 时间：2026-09-13 10:24:46 +0800。
- 入口与 run：自有想法“冰水杯壁的水珠从哪里来？”；`run-b50a099c-8d66-4785-8745-231fc5182a37`。
- 操作：选择正式知识解释模板、AI 编剧 `gpt-5.6-sol`、AI 视觉导演、双模型审片，并允许 AI 画面但没有确认任何媒体报价；点击“开始制作”一次。
- 预期：前期构思通过正式 OpenAI Broker 生成，独立审计后继续脚本和导演方案。
- 实际：run 立即失败在“前期构思”。页面原始错误为“模型服务拒绝了本次请求（请求与任务合同不一致），任务没有开始执行；不会产生模型调用或费用。”截图：`videofactory-real-local-qa-20260913-06-assets/08-own-run-started.png`。
- 已证实证据：run 固化的正式 `creative-treatment` task digest 为 `4906ed11…626ed3`，与 Broker health 的 canonical digest 一致；失败 checkpoint 的 role-loop `contractDigest` 为另一份 `705c9c47…846f5`，并记录唯一 requestId，但 `pendingOperation=null`。OpenAI Broker 在这次操作后仍 `completed=0,failed=0,active=0,queued=0`，说明请求在模型执行前被拒绝。
- 已证实范围：能力探针只证明 Broker task digest 就绪；本次正式组合请求仍在 Broker task 边界被拒绝。checkpoint 中的 `705c9c47…846f5` 是 role-loop 语义/criteria digest，与 Broker task digest 本来就可以不同，因此仅凭两者不同不能证明字段接错。
- 原因判断：更可能是该自有想法实际生成的 payload、expected digest 或 binding 之一没有通过正式 Broker parser；当前公开 UI/receipt 没有保留具体字段级诊断，因此根因仍为 **推测**。系列入口随后在同一服务上已产生真实 OpenAI 调用，说明不是全局 socket、health 或模型不可用。
- 已排除：旧 dist（服务使用 10:11 最终 build）；socket 漏传（两个正式 consumer probe 均 available）；Broker 未启动（health 正常）；模型超时或质量拒绝（executor 调用数为 0）；媒体/费用门禁（尚未进入报价）。
- 影响：共享 creative-treatment 后段阻断，因此 E01 自有想法到方案/报价、E02–E05、E07 暂不能完成。未点击“重试失败步骤”，因为前置条件没有变化；避免把同一确定性错误当成随机失败盲目重投。

### QA 工具记录（非产品问题）

浏览器工具首次跨独立命令恢复时遇到一次陈旧 lock，确认浏览器 daemon 存活后清理自身陈旧状态并重新连接；该过程没有触碰产品服务、数据库或 QA run。

### QA-R7-02：系列三轮审计有界停止，但一次角色节点实际产生 7 次调用（P1，性能/交互）

- run：`run-732178ce-3d5a-4f93-8e8f-b3da53bfd600`，系列“手机充电误区纠察队”E01。
- 正式链路：导演前期构思 1 次 produce + 1 次 audit，96 分通过；编剧 3 个语义审计轮次后以 38 分停止，没有进入导演方案、素材、TTS 或媒体。
- 最终可解释结果：页面明确列出“上一轮两个 blocking 均未解决”、空白表格自测教程偏离真实对照实验、关键测试场无法在时长内执行、依赖未启用静态编辑卡等具体问题；显示“三轮复核未通过”，没有继续自动申请新轮次。截图：`13-series-three-round-exhausted.png`。
- 调用与耗时：该 run 从 10:28:56 到 10:42:50，共 `13m53.812s`；OpenAI Broker completed 从 0 增至 9，failed=0、queued 始终为 0。构思阶段 2 次调用，produce 47.231s、audit 24.107s。编剧阶段 7 次调用，`phaseAttempts={produce:4,audit:3}`，produce 合计 512.473s、audit 合计 249.774s，另有 1 个结构修复 request；没有 session rebuild 或 Provider 重试。
- 长耗时原因：不是候选不足、网络排队或盲目重试，而是构思 2 次调用 + 编剧 3 轮语义审计/修订 + 1 次结构纠正串行执行，且 `gpt-5.6-sol/xhigh` 单次调用约几十秒到数分钟。页面只显示“第 3/3 轮”，不直接把 7 次物理调用拆给用户。
- 暂停/恢复：在编剧执行中点击“暂停后检查或修改”，页面变为“当前步骤完成后暂停”，没有取消或重复当时的已受理任务。由于暂停边界是整个 creative-planning workflow node，不是单个角色/单次审计，编剧仍运行到三轮耗尽并终止；最终没有可显式恢复的下一节点。
- 原任务查询：运行中点击“查询原任务”前后 Broker 计数完全一致（active=1、completed=3、queued=0、failed=0），证明查询没有提交新模型调用。截图：`11-series-query-original-running.png`、`12-series-pause-requested.png`。
- 产品决策待确认：当前实现符合既有“最多三轮语义审计”合同，但不等同于用户提出的“每个角色总共 1 次创建 + 2 次审计机会”。若要降低承载与等待，需要单独决定物理调用预算、结构修复是否计次，以及暂停应在角色边界还是整个创作规划节点生效；本轮按 TASK 没有擅自加入终身三次限制。

### 热点入口：候选来源不足，正确阻断并要求人工补来源（有效业务阻断）

- 页面真实显示 3 条候选，但全部为“待补来源、当前不可开工”，可采用数量为 0；“新建制作”保持禁用。
- 候选分别为“学校治理 AI 作弊”“北京 JDG 战胜广州 TTG”“金铲铲 S18 阵容”，页面提供“补充原始来源”“查看 newsnow 来源”等人工介入入口。
- 按执行卡没有放宽来源规则、没有反复刷新同题碰运气，也没有用 AI 画面伪装来源充分。该入口因此无法进入真实规划/方案/报价，但阻断文案能说明具体缺口。
- 1440 证据：`14-hotspot-entry.png`；390 证据：`15-hotspot-mobile-390.png`。390 下复载后 `clientWidth=390`、`scrollWidth=390`，无横向溢出，console error=0。

### E06：新 run 刷新与 Studio 正常重启持久化

- 系列失败 run 在 390 宽度下先后执行页面刷新和 Studio 正常重启。刷新前、刷新后、重启后均显示相同的“三轮复核未通过”、失败状态、“重试失败步骤”和“调整方案后重新制作”，没有创建新 run 或新模型请求。
- 重启前两个 Broker 均为 `active=0,queued=0`；OpenAI `completed=9,failed=0`，ZAI `completed=0,failed=0`。旧 Studio PID 5996 以 TERM 正常停止，最终 dist 使用相同两个 socket 和登录配置启动为 PID 24064；`/api/health` 继续为 ok，Python/FFmpeg/ffprobe/say 均可用。
- 截图：`16-series-failed-mobile-before-refresh.png`、`17-series-failed-mobile-after-refresh.png`、`18-series-failed-mobile-after-studio-restart.png`。三次均 `clientWidth=390,scrollWidth=390`，console error=0。
- 本次只证明 client/Studio 重启后的 run 读取和失败状态持久化。因为 run 已在编剧三轮不通过后终止，没有可显式恢复的后续节点；没有为了凑覆盖杀掉或重投真实付费 Broker 请求。

## 5. 耗时与调用次数

- 自有想法 run 从提交到失败约 0.17 秒；OpenAI/ZAI 实际模型调用均为 0。耗时来自本地合同拒绝，不是排队、网络或推理。
- 系列 run 总耗时 `13m53.812s`，真实 OpenAI 调用 9 次；构思 71.338s，编剧 762.247s。调用全部串行，队列为 0；详见上方阶段拆分。
- 后续逐项记录 queue、produce、audit、Provider、观察/传输、校验、重试与总耗时；没有数据时明确写未知。

## 6. 最终 QA 结论

- 状态：`DONE_WITH_CONCERNS`。本轮有界可测范围已完成，未在 QA 阶段修改产品，也没有在相同前置条件下重试失败链路。
- 观察范围健康分：`91/100`。这是已访问页面的报告分，不是生产放行分。console 100、links 100、visual 100、functional 75、UX 85、performance 85、content 100、accessibility 100；核心 E01–E05/E07 被真实前门阻断，所以不能据此宣称完整 E2E 可用。
- 最高优先问题：QA-R7-01 的正式 creative-treatment 请求被 Broker parser 拒绝，真实共享后段无法开始。
- 第二优先问题：系列编剧虽有界停止，但一次角色节点实际消耗 7 次串行物理调用和 12m42s 角色时间，用户只能看到“三轮”，看不到物理调用拆分；这正是本次 13m53s 等待的来源。
- 待产品决定：是否把每角色总预算定义为“1 次创建 + 2 次审计/修订”，结构修复是否计次，以及人工介入发生在角色边界还是整个 planning node 边界。本轮没有擅自实施。
- 有效非缺陷阻断：热点 0 条候选满足来源要求，产品正确要求人工补来源；不应靠刷新、放宽事实门槛或自动生成画面绕过。

## 7. 真实调用、费用与未验证项

- OpenAI subscription：9 次真实调用；ZAI：0 次。媒体、TTS、外部发布：0 次。
- 新增现金媒体/TTS费用：`¥0.00 / ¥50.00` 止损线；没有报价确认、Provider media taskId 或 unknown 付费任务。
- `BLOCKED/NOT_VERIFIED`：代表性新片媒体/TTS/渲染、同 evidence SHA 的双真实模型审片、审片建议驱动的局部返工/复用、新片帧数/时长/声画同步/创作质量。
- `PARTIAL`：E02 只验证了运行中查询原任务和暂停；未到报价三动作或显式恢复。E06 只验证刷新/Studio 重启持久化及响应式布局；没有可安全触发的真实 Broker 恢复节点。

## 8. 截图索引

- `01`–`08`：登录、首页、自有想法创建及合同拒绝。
- `09`–`13`：系列入口、运行中查询、暂停和三轮有界失败。
- `14`–`15`：热点来源阻断的 1440/390 视图。
- `16`–`18`：系列新 run 在 390 宽度下刷新前、刷新后、Studio 重启后的一致状态。

## 9. QA 后服务状态

- OpenAI Broker PID 5993、ZAI Broker PID 5994 保持运行；Studio 最终 PID 24064，浏览器 daemon PID 8314。
- 没有删除或迁移 durable/checkpoint/workspace/历史 run；没有 commit、push、云端部署或外部发布。
