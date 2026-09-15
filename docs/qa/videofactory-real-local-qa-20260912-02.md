# VideoFactory 真实本地端到端 QA 报告（第二轮）

- 报告编号：VF-REAL-LOCAL-QA-20260912-02
- 日期：2026-09-12
- 测试人：QA（Claude Code + gstack browse 无头浏览器）
- 模式：report-only（只记录、不修改产品代码；环境恢复仅限服务重启）
- 分支：`codex/final-dual-review-cloud-acceptance`（HEAD 570fe6e + 第一轮五问题修复的未提交实现）
- 前置：第一轮报告 `videofactory-qa-acceptance-20260912-01.md` 的 ISSUE-001..005 已集中修复并回归（见 JOURNAL `VF-QA-R2-FIX`）

---

## 1. 真实本地部署方式与运行环境

### 1.1 部署方式（全部为正式产物 + 真实凭据，无 fake/mock/fixture）

| 组件 | 启动方式 | 关键配置 |
| --- | --- | --- |
| Codex Broker（正式） | `node apps/codex-broker/dist/main.js` | socket `.local/runtime/codex/worker.sock`；`CODEX_BIN=~/.nvm/versions/node/v20.20.2/bin/codex`；隔离 `CODEX_HOME`（auth.json 符号链接至 `~/.codex/auth.json`）；effort=xhigh、auditEffort=xhigh、timeout=1200s、concurrency=1 |
| ZAI/GLM Broker（正式） | `node --env-file=.local/secrets/zai-bigmodel.env apps/codex-broker/dist/main.js` | profile=zai、socket `.local/runtime/zai-codex/worker.sock`、effort=max、modelId=glm-5.3 |
| Studio（生产构建） | `node apps/studio/dist/server/server/main.js` | 127.0.0.1:4317；workspace=仓库默认持久化目录 `workspace/factory`（含 48 条历史 run）；自动加载仓库 `.env`（媒体 Provider key、热点源 URL、Python 运行时）；生产模式强制认证（scrypt 哈希，本次 QA 口令仅存于会话，不入任何文件/报告）；`no_proxy=127.0.0.1,localhost`（绕过公司代理访问本机服务） |
| Python worker | 由 pipeline 按需调用 `.local/python/.venv/bin/python`（3.11.6，video_factory 可导入） | ffmpeg/ffprobe（/opt/homebrew/bin）、say（/usr/bin/say）就绪 |
| 热点信号容器 | docker（newsnow/dailyhot/rsshub/trendradar，Up 2 days） | 四个本地源全部 200 |

### 1.2 部署完成标准核对（证据）

| 检查项 | 结果 |
| --- | --- |
| Studio 可访问 | ✅ `http://127.0.0.1:4317`（`/api/health` 200，python/ffmpeg/ffprobe/say 全 true） |
| 页面使用正式构建产物 | ✅ 生产模式静态服务 `apps/studio/dist/client`（非 dev） |
| 正式 Broker 运行 | ✅ PID 46372（codex）/ 46486（zai），`ps` 与 socket health 双证 |
| Broker socket 存在且属于正式 Broker | ✅ 两 socket health 返回 `video-factory/codex-bridge-v2` 完整 taskContracts |
| Studio↔Broker 健康检查 | ✅ `/api/providers` 23 项能力全部 ready（topic/series/script/director/treatment/dual-review/图库/生成图/生成视频/双 TTS/渲染/质检） |
| 双审解析为两个不同模型 | ✅ codex-visual-review-v1（gpt-5.6-sol）+ glm-visual-review-v1（glm-5.3-flash）同时 ready |
| 真实文本模型完成合法任务 | ✅ 多个真实任务在 codex broker 完成并可核验（见 §6）；ZAI broker 就绪但本轮未产生调用（fallback 顺序 codex 优先且未发生 fallback） |
| Python worker | ✅ `/api/health` runtime.python=true |
| SQLite 持久化路径 | ✅ workspace/factory（294MB，含 runs/opportunities/series/settings/checkpoints）；codex-home 下 broker 运行时出现 goals_1.sqlite |
| 页面刷新/重启后状态恢复 | ✅ Studio 重启后 51 条 run 全部保留；48 条历史 run + 本轮 3 条失败 run 可读；固定 session secret 下重启后会话仍有效（对比第一轮 OBS-006：那是每次启动随机 secret 的部署方式产物，非产品缺陷） |
| 日志无 fake/mock/fixture | ✅ 三个服务日志 grep 计数为 0；round-1 fake broker 进程/socket/脚本/请求记录已删除（见 JOURNAL） |
| 无旧进程/旧构建污染 | ✅ round-1 QA Studio 与 fake broker 已终止；构建产物为本轮 `npm run build` 产物 |

### 1.3 运行记录

- Studio URL：`http://127.0.0.1:4317`（登录用户 qa-local）
- Studio PID：77872（重启后）；Codex Broker PID：46372；ZAI Broker PID：46486
- 本轮创建的 run：run-b0440c8f（自定义·失败）、run-64be4d66（自定义·失败）、run-091ae38e（自定义·失败）、run-c555c789（系列 E01·失败）
- Socket：`.local/runtime/codex/worker.sock`、`.local/runtime/zai-codex/worker.sock`
- workspace：`/Users/jinkun.wang/work_space/veidofactory/workspace/factory`
- 实际模型身份：Codex=gpt-5.6-sol（effort xhigh，audit 同）；GLM=glm-5.3（effort max，visual-review/asset-rank/reference-grammar 子任务用 glm-5.3-flash）
- 媒体 Provider 就绪状态：Pexels/Pixabay（图库）、Seedream（图片）、Seedance-2.0-mini + MiniMax-Hailuo-2.3（视频）、MiniMax TTS + macOS say（配音）全部 ready

---

## 2. 第一轮五个问题的修复验证（真实浏览器回归）

| 问题 | 结论 | 真实环境证据 |
| --- | --- | --- |
| ISSUE-001 全局搜索无结果 | ✅ 已修复 | ① 搜"知识"命中内置模板"知识解释"，href=`/templates?template=knowledge-explainer`，直达后编辑器正确选中该模板（截图 03/05）；② 搜历史 run 标题"窗边一杯水"命中 4 条 `/projects/<id>`（截图 04）；③ 保存自定义机会后搜"充电习惯"命中机会，href=`/topics?mode=custom&opportunity=<id>`，点击后正确选中该机会（截图 11）；④ 空态文案如实描述范围："没有匹配的制作记录、选题机会、模板或功能…" |
| ISSUE-002 保存机会无反馈/计数不刷新 | ✅ 已修复 | 自定义入口保存后出现明确通知"已保存《…》。它已进入下方待制作区，可以直接开始制作。"；机会立即出现在待制作列表且选中（截图 10）；计数"2 条已进入"实时更新；两次不同机会的保存均复现成功 |
| ISSUE-003 缺失能力链接落点 | ✅ 已修复 | 直达 `/resources?missing=script.draft,voice.synthesize#production-roles`：production-roles 分区激活（data-active=true）、创作默认不再在前、键盘焦点落在 production-roles 分区、缺失的"编剧""配音执行"两张角色卡带"当前缺失"高亮（截图 08）；组件级 href 断言 + DirectorPanel 缺失清单联动有回归测试 |
| ISSUE-004 移动端弹窗 skip-link 可见 | ✅ 已修复 | 390×844 真实浏览器：弹窗开/关两种状态下 skip-link 计算样式均 opacity=0、pointer-events=none，不再遮挡标题（截图 14，对比第一轮 16-topics-390-dialog.png）；焦点仍正确落入弹窗首字段；CSS 合同回归测试防回退 |
| ISSUE-005 补齐来源后 0 分跳变 | ✅ 基本修复（留一个文案缺口 → R2-ISSUE-004） | 服务端新增 `pendingEditorReview` 投影：本轮 12 条热点候选全部为规则保底（providerId=trend-heuristic-v1），列表/详情显示"内容潜力/历史内容潜力 + 分数"和"待补来源 · 补齐后再评估"，不再出现"总编评分 0"（截图 24）；"未入选"候选的采用按钮显示"等待总编评估"；**残留缺口**：恢复面板在"全部候选被来源阻断"的规则轮次仍显示"选题总编本轮评估了 12 条热点候选"（见 R2-ISSUE-004）；组件测试覆盖的"未阻断规则候选显示待总编评估"路径因本轮候选全部被阻断未能在浏览器复现（测试已覆盖，风险低） |

回归测试：五修复共新增/修改 12 个测试块（editorial-decision、candidate-inbox、creative-os、templates-page、client），第一轮问题对应聚焦测试全部通过；全量回归见 §7。

---

## 3. 本轮问题清单（按严重程度）

### R2-ISSUE-001｜P1｜选题总编任务合同错配：Studio 发送的 `creatorStrategy` 被 Broker 拒绝，总编轮 100% 静默失败

- 入口/流程/页面/节点：热点入口 → 候选生成（topic-ideas 任务）→ trend-studio/TrendOpportunityAgent ↔ codex-broker
- 复现步骤：
  1. 部署正式 broker + Studio（本报告 §1），登录后进入 `/topics`（热点）。
  2. 触发"重新刷新热点"（或等待首屏加载触发生成）。
  3. 刷新完成后查看任意候选的 proposalSource。
- 预期结果：选题总编模型（gpt-5.6-sol / glm-5.3）真实生成 0-8 个创作角度；候选 providerId 为模型身份。
- 实际结果：全部 12 条候选 providerId=`trend-heuristic-v1`（规则保底），`editorialDecision.verdict=skip` + `pendingEditorReview=true`，用户不能采用任何候选（"这条候选当前不值得进入生产"）→ **热点入口到制作链路完全断裂**。直接用同一协议向 broker 发送含 `creatorStrategy` 的 topic-ideas 请求得到确定性的 400：`payload.creatorStrategy is not allowed; the broker owns all prompt text and execution settings.`；broker 侧 `validateTaskPayload` 只接受 `["signals","strategy","revision"]`（creatorStrategy 应命名为 strategy），而 Studio `CodexTopicIdeaModel.generate` 发送 `creatorStrategy`。异常在 `TrendOpportunityAgent.listCandidates` 被无差别 catch 后静默回退规则候选，任何日志/界面均无失败痕迹。
- 证据：直连探针 400 报文（会话记录）；`GET /api/candidate-inbox` 12/12 为 trend-heuristic-v1；`apps/codex-broker/src/codex-executor.ts` validateTaskPayload 与 `apps/studio/src/server/trend-opportunity-agent.ts` generate() 的字段名对比。
- 阻断：是（热点入口的模型选题与采用全部不可用；这也是第一轮报告 §7 薄弱点 1 在真实模型环境下的延续——模型接通后仍未生效）。
- 涉及费用：无（任务在 broker 校验即拒绝，未产生模型调用）。
- 初步涉及模块：Studio `trend-opportunity-agent.ts`（发送字段名）与 Broker `codex-executor.ts`（task payload 校验）的 topic-ideas 合同不同步；失败被静默吞掉掩盖了合同破坏。
- 备注：修复方向应二选一并补一个跨进程合同测试（真实 broker 校验函数对真实 payload）：改发送字段为 `strategy`，或在 broker 白名单加入 creatorStrategy；同时 listCandidates 的静默 catch 至少要留下可诊断痕迹。

### R2-ISSUE-002｜P1｜Studio→Broker 长等待连接中断（4/4 复现），broker 侧任务实际全部成功，结果丢失

- 入口/流程/页面/节点：制作 run 的 `creative-planning` 节点（creative-treatment + role-audit 循环）↔ codex broker
- 复现步骤：
  1. 从任一机会/单集进入"新建制作"完成向导，点击"开始制作"。
  2. 观察 run 页面 1-20 分钟。
- 预期结果：创作规划完成（broker 完成任务并返回），进入素材报价/授权阶段。
- 实际结果：4 次独立 run（run-b044…、run-64be…、run-091a…、run-c555…）均在 creative-planning 阶段失败，错误为"与模型服务的连接中断，结果未知：这次请求可能已经被模型受理…"。而 broker 侧幂等记录显示这些 run 的 creative-treatment 与 role-audit 任务**全部真实执行成功**（第 1 轮甚至完成到 audit=pass 的修订闭环；4 轮累计 completed=15、failed=0）：客户端在长等待中丢失连接，结果滞留 broker。同机直连探针（无 Studio 进程上下文，同一 socket、同一协议、含会话语义外的等价长任务 103s）全部成功，说明 broker/CLI 路径本身健康，问题指向 Studio 进程内的连接被第三方摧毁（客户端报错非超时类，是 socket 级重置）。根因未定位（broker 进程未重启、无服务端超时配置证据、客户端非 AbortError）。
- 证据：三次 run 的节点错误文案与时间戳；broker `/health` counters completed=15/failed=0；幂等记录文件（agent-c619…=creative-treatment ok、agent-d223…=role-audit ok 等 8 条 run 相关记录全部 ok）；对照探针 `qa-direct-probe-2`（11s ok）、`qa-long-probe-3`（103s ok, ideas=5）。
- 阻断：是——付费漏斗（报价→授权→素材→渲染→双审→返工）在本轮全部无法经真实 UI 到达，见 §5 未验证清单。
- 涉及费用：无（文本阶段免费；媒体任务从未到达）。
- 初步涉及模块：Studio 侧进程内 CodexBridgeClient 连接管理 / 与 Studio 同进程其他组件对连接生命周期的干扰；broker `response.once("close", cancelIfDisconnected)` 的取消语义值得一并排查（断连后任务继续执行完成，说明取消未生效或未触发）。
- 备注：错误文案本身是诚实的 uncertain 分类（符合 B08 合同，没有盲目重发），这一点是正确的。

### R2-ISSUE-003｜P1｜uncertain 之后的"重试失败步骤"是死胡同：重试瞬间再失败、错误文案不更新、已完成成果无法取回

- 入口/流程/页面/节点：失败 run 详情页 → "重试失败步骤"
- 复现步骤：
  1. 处于 R2-ISSUE-002 状态的 run，点击"重试失败步骤"。
  2. 观察 run 状态与节点时间戳。
- 预期结果：按"先核对原有任务的结果"的指引恢复：reconcile 原 requestId 的已完成结果，或明确提示需要人工核对/新的处理方式。
- 实际结果：每次点击 POST `/nodes/creative-planning/retry` 返回 200，但节点在 15-60ms 内再次失败（checkpoint 显示 produce phase 在 15ms 内被拒、sessionRebuilds 预算为 0）；节点错误文案**仍显示第一次的"连接中断"文案**，不反映新的失败原因；broker 侧已完成的 treatment/audit 成果没有任何 UI 路径可以取回。用户面对一个永远失败的按钮。
- 证据：run-b044… attempt-1..4 记录与 agent-loop-checkpoints（budget {produce:0,audit:0}、failedReqs、15ms produce）；三次重试 POST 全 200 但 run 始终 failed；截图 16。
- 阻断：是（叠加 R2-ISSUE-002 使失败 run 不可恢复）。
- 涉及费用：无。
- 初步涉及模块：production-pipeline 的 run retry/CG-06 有界 session 重建预算与 uncertain 恢复（CG-01 的 resumeCoveredSpendApproval 思路）未覆盖"规划阶段 uncertain"场景；错误文案未随失败原因更新。

### R2-ISSUE-004｜P3｜恢复面板在"全部被阻断的规则轮次"仍声称"选题总编已评估"

- 入口/流程/页面/节点：热点收件箱恢复面板（短名单为空时）
- 复现步骤：1. 热点候选全部为规则保底且全部被来源门槛阻断（本轮真实环境即如此）；2. 打开 `/topics`。
- 预期结果：如实说明"本轮候选由规则保底生成，未经过选题总编评估"。
- 实际结果：显示"选题总编本轮评估了 12 条热点候选，其中 0 条未推荐。"（.pendingEditorReview 标记存在，但面板统计只统计了未阻断候选，全部阻断时退回旧文案）。
- 证据：截图 24 上方面板文案；`candidate-inbox-studio` 列表 12/12 blocked+pending。
- 阻断：否。涉及费用：无。初步涉及模块：`TopicEntryWorkspace.tsx` TrendRecoveryPanel 文案分支与 pendingEditorCount 统计口径。
- 备注：这是第一轮 ISSUE-005 修复（本轮 VF-QA-R2-FIX）的残留边缘场景；未阻断场景的修复本身已在组件测试中覆盖并通过。

### 观察项（不计入问题计数，附证据）

- OBS-R2-01｜P3｜导演台"选题智能"显示"AI 选题总编可用"，但其就绪探针只证明 broker 可达；在 R2-ISSUE-001 现状下实际每轮总编都失败并回退规则。建议就绪标签与最近一次真实任务结果解耦或提示最近一次回退原因。
- OBS-R2-02｜P3｜系列路线图由规则保底生成后，集名/支柱仍呈"实测/决策"交替的公式化模式（本轮 E01 经真实模型开拍复核后标题已被重写为可测试命题"赶出门前开飞行模式，15 分钟真的能多充电吗？"，说明模型链路能改善多样性；规则保底本身仍单调，与第一轮 OBS-007 同源）。
- OBS-R2-03｜info｜登录会话在服务重启后保持有效（本轮使用固定 session secret）；第一轮 OBS-006"重启需重新登录"是随机 secret 的部署方式产物，非产品缺陷。

---

## 4. 已通过项（真实环境）

- 登录/登出、错误口令提示、三入口独立可达且共用后段
- 热点收件箱：分页签/门槛计数、候选详情的"暂不可开工"诚实门禁（至少 2 个不同域名有效来源）、补充原始来源入口、内容潜力与开工状态分离显示（截图 24）
- 系列全链（创建 → 规则路线图 → 依赖语义 E01 待采用/E02+ 等待前集 → 真实模型开拍前复核通过 → 采用成功、复核重写标题/hook/promise 进入路线图）——本轮唯一走通的"真实模型 → 业务成果"链路（截图 23/27/28/29）
- 模板工坊 CRUD：新建（名称+适用说明必填校验）→ 草稿编辑保存（"模板草稿已保存。"）→ 发布确认弹窗 → "新版本已发布；已有项目继续使用自己的运行快照。" → 删除确认（后果说明"已经开始的项目仍保留当时的模板快照"）→ 列表同步移除（截图 19-22）
- 创作设置：真实已保存的定位/受众/总编规则正确加载回显（只读验证；未改动用户数据）
- 素材库：43 项历史创作素材按作品/资产组织、可复用 42/授权待确认 0、来源与提供方筛选（截图 25）
- 制作复盘：真实统计（终审通过率 56%、已打回返工 7、制作中断 22——含本轮 3 次）与"下一轮行动"可读（截图 26）
- 全局搜索三项数据源 + 深链导航（§2）
- 响应式：1440 无溢出；390 无横向溢出、专用底部导航、弹窗可用（截图 13/14/30）
- 服务重启持久化：51 条 run 全保留（§1.2）
- 费用账本一致性：3 条 run 的成本账本均 0 条记录、¥0.00，与"媒体任务从未提交、文本任务订阅制"的 Provider 实际情况一致（本轮无任何扣费；run-c555c789（系列单集）账本同为 0）

## 5. 失败/未验证项及原因

**失败**：4 条本轮创建的 run 全部在 creative-planning 失败（R2-ISSUE-002），证据完整保留在 run store 与 broker 幂等记录中。

**因 R2-ISSUE-001/002 阻断而未能验证**（按第一轮未验证清单延续；本轮已把"环境是否允许"从不可知变为确定可运行，阻断原因从"无模型"变为上述两个缺陷）：

1. 服务端媒体报价 → 两阶段确认 → 授权范围/预算意向/追加/调整/暂不继续 全流程（UI 到达不了报价节点）
2. 真实图片/视频/图库素材生成、母片复用、连续动作、素材失败停住、needs_evidence
3. 真实 TTS 配音、渲染、时长/帧数/音画同步、成片 SHA、逐片段检查
4. 双模型审片（GLM+Codex 同证据）、用户终审、打回、审片建议预填、局部返工
5. 首选/备选模型切换的真实 fallback、429/accepted-unknown 的真实故障注入
6. 报价账单与 Provider 账单核对（无媒体消费发生）

**部分验证**：ISSUE-005 修复的"未阻断规则候选 → 待总编评估"浏览器显示（本轮候选全部被来源阻断，未能自然复现；组件测试已覆盖）。

**费用授权纪律执行情况**：本轮授权仅产生文本模型订阅用量（gpt-5.6-sol ×10 任务、无 ZAI 调用），无任何图片/视频/TTS 现金消费；无需 Provider 账单核对。

## 6. 真实模型任务核验（M01 部分）

| 任务 | kind | 模型 | 结果核验 |
| --- | --- | --- | --- |
| 直连探针 1（ creatorStrategy 字段） | topic-ideas | gpt-5.6-sol | 400 拒绝（R2-ISSUE-001 证据） |
| 直连探针 2 | topic-ideas | gpt-5.6-sol | 11s 完成，`{"ideas":[]}`（合法空短名单） |
| 直连长探针（6 信号+策略） | topic-ideas | gpt-5.6-sol | 103s 完成，5 个角度，均含 signalId/visualPlan/整数评分 |
| 系列 E01 开拍前复核（produce+audit） | series-roadmap / role-audit | gpt-5.6-sol | 双任务 10:39 完成，E01 `planning.source=agent, auditStatus=passed, provider=openai`，标题/hook 被模型重写 |
| 3 条生产 run 的 treatment+audit | creative-treatment / role-audit | gpt-5.6-sol | broker 侧全部完成（含一次 repair→修订→pass 闭环），但结果因 R2-ISSUE-002 未送达 Studio |

耗时观察（M04 部分）：topic-ideas（6 信号）≈103s；开拍复核（produce+audit 两跳）≈3 分钟；creative-treatment 单跳 30s~17min 不等（含 audit=repair 的修订轮）。排队耗时可从 broker /health counters 观察（并发 1）。

## 7. 修复后集中回归（进入 QA 前）

- `npm run test:ts`：764 项，763 pass / 0 fail / 1 skip（e2e.real L5 门控，已解释）
- `npm run studio:test`：476/476（vitest 全绿 + node --test）
- `npm run test:broker`：156/156
- Python worker：131 passed
- `npm run build:pipeline` / `npm run build`：exit 0
- `npm run typecheck`：exit 0；`git diff --check`：exit 0
- 范围外已知失败（如实记录）：`apps/studio/test/editorial-decision.test.ts` 的"keeps everyday guidance with ambiguous words"一条失败——该文件不在任何正式测试脚本内（孤儿测试），失败路径与五修复无关（非 heuristic 行为逐字节不变），分类 STALE_TEST，留待下一轮处置。

## 8. 用户体验总体评价

- 修复后的搜索、保存反馈、分区定位、skip-link 四项体验明显改善，空态/门禁/不可用文案继续保持"发生什么、保留什么、下一步"的高水准。
- 最差的体验集中在"模型任务失败之后"：四条 run 的失败 + 重试死胡同 + 旧文案不更新（R2-ISSUE-002/003），是当前产品可信度的最大伤口——用户按指引"先核对原有任务"，但产品没有给任何核对入口。
- 热点入口在真实模型环境下整体退化为"只能看不能做"（R2-ISSUE-001），与第一轮"无模型时断链"形成对照：现在模型有了，链路仍然断。

## 9. 爆款视频工作流薄弱点（更新）

1. **文本任务传输可靠性**是当前最大单点：broker 侧能力已验证充分（10/10 任务成功），成败完全取决于 Studio 进程内的连接保活。
2. **跨进程任务合同无守护**：topic-ideas 字段错配能在 763 项测试全绿的情况下存在于两个进程之间——因为合同测试两侧各用各的夹具。需要"真实 broker 校验 × 真实 Studio payload"的契约测试。
3. **失败恢复的最后一公里**：uncertain 分类是诚实的，但恢复路径没有兑现它给出的指引（"核对原有任务"无入口）。
4. 规则保底路线图的公式化（OBS-R2-02）依旧。

## 10. 下一轮集中修复清单（按严重程度与共同根因）

1. **P0（阻断付费漏斗验证）**：R2-ISSUE-002 + R2-ISSUE-003（同根因树：Studio↔Broker 长等待连接生命周期 + uncertain 恢复路径）。修复要求：a) 定位并消除连接销毁源；b) uncertain 后的恢复必须先 reconcile 原 requestId（broker 幂等存储已有完整结果），禁止进入无意义的秒败循环；c) 节点错误文案必须反映最新失败原因。
2. **P1**：R2-ISSUE-001（topic-ideas 字段名对齐 + listCandidates 静默失败必须留痕 + 新增跨进程合同测试）。
3. **P3**：R2-ISSUE-004（恢复面板统计口径把被阻断的 pendingEditorReview 候选计入）。
4. **P3**：OBS-R2-01（就绪标签与真实任务结果解耦）。

## 11. 截图索引（docs/qa/real-local-20260912-02/screenshots/）

| 文件 | 内容 |
| --- | --- |
| 01-login-1440.png | 登录页（生产模式认证） |
| 02-home-after-login.png | 登录后首页三入口 |
| 03-search-template-hit.png | ISSUE-001：搜"知识"命中内置模板 |
| 04-search-run-hit.png | ISSUE-001：搜历史 run 命中制作记录 |
| 05-template-deeplink.png | 模板深链直达编辑器（知识解释） |
| 06/07-topics-*.png | 热点页与刷新启动 |
| 08-missing-roles-highlight.png | ISSUE-003：分区定位+焦点+缺失角色高亮 |
| 09/10-opportunity-*.png | ISSUE-002：表单与保存成功通知 |
| 11-search-deeplink-landing.png | 机会深链落点选中 |
| 12-wizard-open.png | 新建制作向导模板步 |
| 13/14-390-*.png | ISSUE-004：390 弹窗 skip-link 隐藏证据 |
| 15-trend-candidate-pending.png | 热点候选详情（规则保底诚实状态） |
| 16-run-failed-unknown-state.png | uncertain 失败页与重试按钮（R2-ISSUE-002/003） |
| 17-run-retry-clicked.png | 重试后仍失败 |
| 18/19/20/21/22-template-*.png | 模板创建/草稿/发布确认/已发布/删除确认 |
| 23-series-created.png | 系列创建 |
| 24-trend-candidates-pending.png | 热点未入选列表 + 恢复面板文案（R2-ISSUE-004） |
| 25-assets-page.png / 26-experiments-page.png | 素材库/制作复盘（真实历史数据） |
| 27-series-roadmap.png / 28-series-episode-detail.png | 系列路线图与单集详情 |
| 29-series-e01-adopted.png | E01 开拍复核通过并采用 |
| 30-home-390.png | 390 首页无溢出 |

---

**健康评分**：Functional 45 / Console 100 / Links 100 / Visual 97 / UX 72 / Performance 100 / Content 96 / Accessibility 97（按 qa-only 权重加权 ≈ 84/100；Functional 因付费漏斗阻断重罚）。

**结论**：真实本地部署本身完全成功（正式产物、真实凭据、真实模型、真实数据、持久化、无 fake 残留）；第一轮五问题修复在真实环境中验证通过；但两条 P1 传输/合同缺陷使付费制作漏斗在本轮无法经真实 UI 到达，媒体授权/素材/双审/返工的 L5 验证继续顺延，且现在有了明确的、可复现的缺陷对象。

测试结束时间：2026-09-12 11:00 前后；环境保持运行（Studio 77872 / Broker 46372 / 46486），等待下一轮集中修复。
