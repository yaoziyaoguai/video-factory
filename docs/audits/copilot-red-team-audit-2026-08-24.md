# VideoFactory Studio 红队只读审计报告

- 审计日期：2026-08-24
- 审计对象：`codex/loop-engineering-foundation` 工作区（含全部 untracked 成果），本地站点 http://127.0.0.1:4317/（`node` PID 72533，构建产物模式）
- 审计方式：4 个并行只读代码审计（术语文案 / 架构 / 安全与真实性 / 测试与文档）+ 真实浏览器全流程实测（Chrome DevTools MCP）+ 统一验证命令
- 审计约束遵守情况：未修改任何源文件；未触发付费 API（唯一一次生产使用默认"经济日更"全本地免费配方，服务端三层校验证实零计费、无外部请求）；未批准任何审片；未发布外部内容；未读取 `.env` / `.env.local` / 任何密钥
- 审计造成的副作用（全部披露）：① 创建了一条免费本地生产 run `run-99cc8e84-06e6-41bc-86e0-9d38647f6314`（超长标题边界测试）并将其打回（含原因）；② 浏览器 localStorage 的导览完成标记被重置并恢复为 `creator-canvas-v2`（完成态）；③ `npm run build` 重新生成了 `apps/studio/dist/`（gitignored 构建产物）；④ 一张误写入 `output/` 的截图已删除。仓库工作区无其他改动。

---

## 第一部分：问题清单

> 严重级别定义：P0 数据/付费/安全/核心流程灾难；P1 阻断主要任务或严重误导；P2 明显降低效率/质量/可信度；P3 一致性与工程卫生。

### [P1] 用户选择 Kokoro 神经音色，实际静默使用 macOS 系统音色合成

- 类别：功能 / 文案（行为与用户选择不符）
- 证据：
  - `apps/studio/src/client/components/NewRunDialog.tsx:44` — voice 能力 `preferred: "macos-say-v1"`（Provider 绑定默认值）
  - `apps/studio/src/client/components/NewRunDialog.tsx:391-398` — `defaultVoiceDirection` 在 Kokoro 可用时默认 `profileId: "kokoro:zf_001"`（音色默认值）
  - 实测 run `workspace/factory/runs/run-99cc8e84-06e6-41bc-86e0-9d38647f6314/run.json`：`providers.voice: "macos-say-v1"` 与 `voiceDirection.profileId: "kokoro:zf_001"` 同时提交
  - 产物实测：配音 artifact 为 `macos-say-v1` 生成（RunPage 产物列表可见"配音文件 macos-say-v1"），而弹窗 UI 显示勾选"女声 01 · Kokoro 神经音色"
  - `packages/production-pipeline/src/contracts.ts` 对该组合无任何交叉校验
- 当前行为：弹窗中音色选择（Kokoro 女声 01）与 Provider 绑定（macOS say）是两份互不相干的默认值，提交后 Worker 按 Provider 合成。
- 为什么是问题：用户以为选定了高质量神经音色，实际成片使用系统音色，全程无提示。这是内容质量的直接损失，且属于"界面说的和实际发生的不是一件事"。
- 用户影响：所有使用默认配置的"经济日更"生产（即新用户的第一次生产）音色全部不符预期。
- 复现步骤：首页 → 创建创意方案 →（不动任何声音设置，默认显示"女声 01 Kokoro 神经音色"选中）→ 开始生产 → 等待审片 → 查看配音产物 provider 为 `macos-say-v1`；试听成片为系统音色。
- 推荐修复：`defaultVoiceDirection` 与 `providerDefaults` 统一（Kokoro 可用时 voice Provider 默认应为 `kokoro-local-v1`）；并在 `contracts.ts` 增加 profile 前缀与 voice Provider 的一致性校验，不一致直接 400。
- 验收标准：默认配置提交的 brief 中 `providers.voice` 与 `profileId` 前缀一致；故意构造不一致的请求返回 400；新增回归测试。

### [P1] 进程崩溃/重启后，进行中的生产永久卡在"生产中"，无任何恢复或超时

- 类别：架构 / 功能
- 证据：
  - `apps/studio/src/server/main.ts:11-43` — 启动只做组装与 listen，无对持久化 run 的扫描/复活/标记逻辑
  - `apps/studio/src/server/production-studio.ts:76-84` — run 的执行 Promise 只存在于进程内 `completions` Set，无 shutdown drain
  - `packages/production-pipeline/src/run-store.ts` — 无 "mark stale running as failed" API
  - `apps/studio/src/client/api.ts:69-76` — SSE 客户端无 `onerror` 处理、无降级轮询
  - 导览文案 `apps/studio/src/client/onboarding/creator-tour-steps.ts:91` 承诺"你可以离开页面，运行记录和中间产物都会保留"
- 当前行为：dispatch 后服务进程被 kill/崩溃，`run.json` 永远停留在 `status:"running"`，UI 永久显示"生产中"；页面上的 SSE 断开后浏览器静默重连失败，无任何提示。
- 为什么是问题：用户照导览指示"离开页面"，回来后如果发生过应用重启，看到的是永远转圈的僵尸任务，没有任何文案告诉他发生了什么、该怎么办。
- 用户影响：信任损失 + 列表被僵尸任务污染；孤儿 python 子进程（`python-worker-client.ts:56` detached）可能还在写无人认领的产物。
- 复现步骤：启动一条生产 → 中途重启 studio 进程 → 刷新页面：该 run 永远"生产中"。（代码路径确凿；进程级实测未执行，见未验证项）
- 推荐修复：启动时扫描 `runs/*`，将 `running` 且无活跃锁的 run 标记为 `failed`（error="应用重启中断"）；SSE 增加错误处理与可见的连接状态；为 run 增加总超时。
- 验收标准：kill -9 后重启服务，僵尸 run 在 UI 中显示"失败"并给出可理解的中文原因；SSE 断线时页面出现提示。

### [P1] 全部 Web Studio 成果处于 untracked 未提交状态，而交付文档宣称"Complete"

- 类别：测试 / 交付完整性
- 证据：
  - `git log` 止于 `8eaf1d3 feat: add director-grade visual pipeline`；`git status` 显示 `apps/`、`packages/`、`package.json`、`tsconfig.base.json`、`docs/loops/008-018`、`docs/adr/`、`scripts/`、`src/video_factory/worker.py` 等全部 untracked
  - `docs/loops/009-publishable-production-slice-results.md:51`、`docs/loops/015-browser-dogfood-results.md:49` 等引用"`git diff --check` 通过"作为交付证据——diff 检查通过 ≠ 已提交
  - 所有 `*-results.md` 标注 "Status: Complete"（如 `docs/loops/010-web-operator-studio-results.md:4`）
  - `README.md` 的快速开始（`npm install && make setup-local-runtime`）对 HEAD 的 clone 而言会失败——`apps/`、`packages/` 在 git 里不存在
- 当前行为：文档时间线（Loop 008-018，至 2026-08-24）远超提交时间线；没有任何文档说明这一点。
- 为什么是问题：这是最容易被"信任文档的人"踩中的坑：按 README 走的新环境会直接坏掉；任何回滚/换机/协作场景都会丢失全部 Web Studio 工作。
- 用户影响：对新 clone 者 = 产品不存在；对本机 = 一次误操作（如 `git clean`）即可清空全部成果。
- 复现步骤：`git stash --include-untracked` 或在新目录 `git clone` 本仓库 → 按 README 快速开始 → 失败。
- 推荐修复：立即将 Loop 008-018 成果提交（按模块拆分 commit）；在提交前跑全量 `npm test`；results 文档补充"提交哈希"字段作为交付证据。
- 验收标准：`git clone` 后按 README 能跑通；`git status` 干净。

### [P2] ≈1280×720 视口下，悬浮"创作向导"按钮遮挡"创建创意方案"主按钮右半区，点击误开向导面板

- 类别：UX / 交互
- 证据：实测（窗口 1280×720）：CTA rect x:1026-1280 y:680-720；`.guide-dock-trigger` rect x:1132-1258 y:674-720；`elementFromPoint(CTA 中心)` 返回向导按钮。点击 CTA 右半区实际展开的是"创作向导"面板而非生产弹窗（实测复现一次）。1440×900 下两者相距 12px 不重叠；390×844 / 768×1024 无此问题。
- 为什么是问题：主路径 CTA 在常见笔记本有效视口（13" 1280×800 减浏览器 chrome ≈ 720）半失效，且错误反馈是"打开另一个面板"，新用户会困惑。
- 用户影响：首次使用关键动作被劫持；可用 /projects 的"新建生产"绕过，故评 P2。
- 复现步骤：窗口调整为 1280×720 → 首页 → 点击"创建创意方案"按钮中部/右部。
- 推荐修复：为 `.guide-dock-trigger` 的悬浮层增加与主内容的碰撞避让（如 CTA 所在面板加 padding-bottom），或 dock 收起态改为小圆形图标按钮。
- 验收标准：在 1024-1440 全宽度 × 640-900 高度矩阵下，`elementFromPoint` 在 CTA 任意位置都返回 CTA 本身。

### [P2] 导览进行中切换路由：过期遮罩与"创意项目"导览弹层继续覆盖"实验复盘"页面

- 类别：UX / 架构（导览生命周期）
- 证据：实测：/projects 发起"讲解当前页面"（6 步导览）→ 点导航"实验复盘" → 实测 popover 仍 `opacity:1、visibility:visible、rect(470,261,340×176)`，全宽 overlay 仍激活（`display:block, w:1280`），内容讲的是"到了创意项目…"。代码根因：`apps/studio/src/client/onboarding/use-creator-tour.ts:67-81` 仅在 AppShell unmount 时 destroy，而 AppShell 跨路由永不 unmount；无路由变化监听。
- 为什么是问题：用户看到暗色遮罩盖住新页面 + 一段讲旧页面的引导，语义完全错乱；只能靠 × 或"提前结束"逃出。
- 用户影响：导览体验中断且误导；相关联的代码级问题：full tour 进行中点"讲解当前页面"会经 `runTour` 的 destroy→`onDestroyed` 静默把完整导览记为已完成（`use-creator-tour.ts:22,45-48`），之后不再自动出现。
- 复现步骤：如上实测路径。
- 推荐修复：`useEffect` 监听 `location.pathname` 变化时 destroy 活跃导览；`startPageTour` 打断 full tour 时不记完成。
- 验收标准：导览中切路由后无 overlay/popover 残留；full tour 被页面导览打断后仍会在下次首访重放。

### [P2] 术语体系混乱：同一动作/对象/状态在相邻界面换名（体系性问题）

- 类别：文案 / UX
- 证据（全部为 file:line 级实测枚举，择要）：
  1. **"开始生产"这一动作 5 个名字**：首页按钮"创建创意方案"（`DirectorPanel.tsx:69`）→ 弹窗标题"新建视频生产"（`NewRunDialog.tsx:191`）→ 弹窗内章节"制作配方"（`:249`）→ 项目页按钮"新建生产"（`ProductionQueue.tsx:39`）→ 提交按钮"开始生产"（`NewRunDialog.tsx:382`）。
  2. **"机会"8 个叫法**：候选机会 / 录入机会 / 选择选题 / 选题池 / 候选选题 / Agent 今日提案 / 已核验机会 / 真实机会（`OpportunityRail.tsx:17`、`TodayPage.tsx:113,120,174`、`creator-tour-steps.ts:13,14` 等）。
  3. **项目页条目 6 个叫法**：创意项目 / 生产任务 / 制作记录 / 项目 / 任务 / 片场日志（`ProductionQueue.tsx:51,79,111,112`；`RunPage.tsx:57`）。
  4. **运行状态三个名字**："生产中"（`StatusBadge.tsx:6`）/ "正在生产"（`ProductionStrip.tsx:20`）/ "正在制作"（`ProductionQueue.tsx:45`）；且 pending 在条幅显示"正在生产"、徽章却叫"等待中"（`StatusBadge.tsx:5` vs `ProductionStrip.tsx:6-13`）——同一 run 两处矛盾。
  5. **工作流节点两套标签**：长版"脚本生成/素材准备/配音合成/视频渲染"（`ProductionStrip.tsx:31-40`）vs 短版"脚本/素材/配音/渲染"（`ProductionQueue.tsx:141-150`、`production-studio.ts:43-52`）；assets 还有第三名"画面素材"（`NewRunDialog.tsx:43`）。
  6. **"导演"4 个叫法**：导演台（导览 `creator-tour-steps.ts:40`）/ 导演桌（`:15`）/ 导演控制台（`DirectorPanel.tsx:30` aria）/ 导演镜头板（`OpportunityFocus.tsx:31`），可见标题却是"创意决策"。
  7. **Provider 状态两套词**："待接入/待配置"（`NewRunDialog.tsx:335`）vs "规划中/需要配置"（`ResourcesPage.tsx:171`）；同页"制作底座"vs"生产底座"（`ResourcesPage.tsx:143,144`）。
  8. 其他：平台名"抖音"vs"DOUYIN"大写直出（`DirectorPanel.tsx:44`、`RunWorkbench.tsx:31`）；时长"24 秒 / 24s / 0-03s"三种（`NewRunDialog.tsx:239`、`ProductionQueue.tsx:101`、`OpportunityFocus.tsx:6-8`）；"付费镜头"vs"计费镜头"同页两词（`NewRunDialog.tsx:195,369`）；"已完成/成片归档/已结束"三种分组名；评分维度录入侧与展示侧两套标签且"安全"为反转值无解释（`OpportunityDialog.tsx:13-21` vs `OpportunityFocus.tsx:46-51`）。
- 为什么是问题：首次使用者必须在同义词之间自行建立映射，认知负担极高；状态词不一致直接导致"我不知道现在系统在干什么"。
- 用户影响：贯穿全部页面的理解成本；导览教的词（"母带风格"`creator-tour-steps.ts:261`）在界面上根本找不到（实际控件叫"声音质感"`VoiceStudio.tsx:153`）。
- 复现步骤：任意页面交叉阅读。
- 推荐修复：建立术语表（见第二部分统一表），由单一常量模块导出全部用户可见名词；文案评审以术语表为准。
- 验收标准：同一概念全站只有一个名字；新增 lint（对硬编码状态词做 grep 检查或抽成枚举）。

### [P2] 英文工程错误消息直接透出到中文创作者界面

- 类别：文案 / 功能
- 证据：
  - 服务端 `apps/studio/src/server/production-studio.ts:90-165`：`Run 'x' is not waiting for human review.`、`Metered provider 'x' is disabled...`、`estimated cost ¥X exceeds the production budget ¥Y` 等，经 `apps/studio/src/client/api.ts:82`（`Request failed with status 500.`）拼接后渲染到表单错误位
  - `packages/production-pipeline/src/contracts.ts:49-138` 全英文校验消息（如 `durationSeconds must be an integer between 20 and 180.`）直出 NewRunDialog
  - `NewRunDialog.tsx:456` `${key} is required.`；`OpportunityDialog.tsx:162` `"title 不能为空."`（英文字段名混入中文）
  - 节点失败时 Python stderr（含本地绝对路径/venv 路径）经 `python-worker-client.ts:100` → `node.error` → `RunWorkbench.tsx:155-159` 直出
  - `RunWorkbench.tsx:105` 产物副标直出 `python-template-v1` 等 Provider ID
- 为什么是问题：目标用户是中文创作者；错误时刻恰是用户最需要明确指引的时刻。
- 用户影响：出错即懵；本地路径暴露虽仅限本机（绑定 127.0.0.1），仍属不当信息泄露。
- 复现步骤：断开本地热点服务后刷新资源页；或对生产表单注入非法值。
- 推荐修复：服务端为面向用户错误提供中文文案；`node.error` 折叠为"节点名 + 中文摘要 + 展开详情"；Provider ID 换 label，ID 放 title。
- 验收标准：所有到达 UI 的错误字符串均为中文（工程细节仅在折叠区/日志中）。

### [P2] "实时更新"承诺与实现不符：列表页一次性拉取、SSE 无兜底、候选 10 分钟缓存

- 类别：文案 / 功能 / 架构
- 证据：
  - 导览承诺："启动后会自动进入生产现场并实时更新节点"（`creator-tour-steps.ts:91`）、"页面会实时刷新"（`:210`）、RunWorkbench "流程正在自动执行，页面会实时更新"（`RunWorkbench.tsx:161`）
  - 实现：列表页（/projects、/experiments、首页统计）全部 fetch-once-on-mount，无轮询无订阅（全 client 无 setInterval/EventSource 除 RunPage 外）；停在 /projects 时后台 run 状态变化无感知
  - RunPage SSE 客户端无 `onerror`/重连终止处理（`api.ts:69-76`）；服务端无心跳（`app.ts:129-173`）
  - 趋势候选缓存 10 分钟且 UI 未标注（`trend-studio.ts:53`）；资源页自称"实时热点信号"（`ResourcesPage.tsx:119` aria）
- 为什么是问题：用户按"实时"预期等待，实际可能盯着过期数据；SSE 断开时界面永远显示"生产中"。
- 用户影响：等待空转；错判当前状态。
- 复现步骤：在 /projects 页等待后台 run 完成——计数与状态不更新，需手动刷新（实测确认 fetch-once）。
- 推荐修复：要么兑现（列表页轻量轮询或 SSE 广播），要么改文案为"进入任务页查看实时进度"。SSE 客户端补错误处理。
- 验收标准：后台 run 完成时停留列表页的用户能在 30 秒内看到状态变化；或全部"实时"字样被移除/限定。

### [P2] UI 展示的"失败兜底"链条（Pexels → 本地编辑卡片）运行时并不存在

- 类别：功能 / 文案（虚假韧性承诺）
- 证据：
  - UI：`NewRunDialog.tsx:342-347` 渲染 `fallbackProviderIds` 为"失败兜底 A → B"链；`provider-catalog.ts:65,78` 为 Pexels/Pixabay 声明 fallback
  - 运行时：全仓 grep 证实 `fallbackProviderIds` 仅存在于 catalog 声明与 UI 渲染；执行路径唯一 fallback 在 metered 镜头失败→本地 baseline（`generative-asset-worker.ts:94-97`）。Pexels 节点失败 → run 直接 failed（`workflow-runner.ts:279-284,437-439`）；Kokoro 失败同样不会回落 macOS say
- 为什么是问题：用户以为有韧性（一次图库抖动能兜底），实际一次失败废掉整条 run——若配了付费配方，已花费的镜头也随之作废。
- 用户影响：对系统可靠性的错误预期；真实故障时损失更大。
- 复现步骤：选"免费实拍"配方 + 制造 Pexels 不可用（撤 key）→ run failed 而非兜底。
- 推荐修复：短期从 UI 移除"失败兜底"展示或标注"规划中"；长期在 asset/voice 节点实现真实 fallback。
- 验收标准：UI 不再展示未实现的兜底；或实现后补集成测试（Pexels 失败→run 仍成功且产物记录 fallback 来源）。

### [P2] "已核验机会 / N 条真实信号 / Pexels 实拍镜头板"等真实性宣称缺乏事实支撑

- 类别：文案（真实性）
- 证据：
  - `TodayPage.tsx:58` "{n} 个已核验机会"——系统无核验机制：机会可随手录入或从提案一键转入（"加入选题池"），状态机无核验态（`opportunity-store.ts:28-34`）
  - `OpportunityRail.tsx:23` "{n} 条真实信号"——人工录入条目同样计入
  - `OpportunityFocus.tsx:5-9,31` "导演镜头板 · Pexels 实拍 · 本地缓存"——三张图为硬编码篮球素材（alt"篮球旋转的特写镜头"等），对任何含 sport 的 track 显示同一组图，与所选机会内容无关；导览第 4 步还背书"它是开拍前的视觉草图"（`creator-tour-steps.ts:32`）
  - `TodayPage.tsx:67-71`：点击开始生产会静默把所选机会置为 `approved`，UI 无任何提示；机会卡随后显示"已批准"（`OpportunityRail.tsx:47`）——用户从未执行过批准动作
- 为什么是问题：红队视角下这是最危险的一类问题——用"已核验/真实/实拍"字样为未核验、占位的内容背书。
- 用户影响：基于虚假证据信号做选题决策；对"已批准"状态来源产生困惑。
- 复现步骤：手动录入一条编造的机会 → 卡片即计入"N 条真实信号"；选择任意 sports 类机会 → 看到的都是同一组篮球图。
- 推荐修复：改为中性文案（"今日机会 N 条"）；镜头板要么接入真实素材检索、要么明示"示例画面，开拍时按脚本重新检索"；机会状态联动要么显式提示要么改名为"已投产"。
- 验收标准：界面上不再存在与事实不符的真实性宣称；"已批准"只在用户可见的批准动作后出现。

### [P2] 实验复盘页没有任何数据录入能力，导览却指导用户"记录真实播放、完播、互动和涨粉"

- 类别：UX / 文案（死路）
- 证据：`ExperimentsPage.tsx`（全文 43 行）只有 3 个统计卡 + "平台数据尚未接入"空态；导览 `creator-tour-steps.ts:245` "发布后别忘了复盘…记录真实播放…"、`:276` "再接平台结果…发布后补充播放…"；`GuideDock.tsx:96` "发布后记录平台表现"。
- 为什么是问题：闭环叙事（第六步"看复盘"）在 UI 上是断的；用户按指引寻找录入入口找不到。
- 用户影响：流程终点是死路，"从真实结果学习"的核心承诺落空。
- 复现步骤：完成一次生产 → 按导览到实验复盘 → 找录入入口（不存在）。
- 推荐修复：短期把导览/GuideDock 文案改为"平台数据接入开发中，当前仅展示生产侧事实"；中期加最小手动录入（发布链接 + 播放/完播数字）。
- 验收标准：导览不再指引到不存在的操作；或录入入口可用。

### [P2] 成本上限是"客户端自声明 + 人工估值"，无真实计费约束（接入付费 API 前必须解决）

- 类别：功能 / 成本透明度
- 证据：
  - 服务端约束真实存在且为三层（`production-studio.ts:156-166` 预检、`generative-asset-worker.ts:81-86` 外呼前复验、`contracts.ts:125-126` 边界钳制）——这是亮点
  - 但上限数值由请求方声明：`maxPaidShots ∈ [0,20]`、`maxCostCny ≤ 100000`，直接调 API 可在边界内任设（`contracts.ts:125-126`）；无跨 run 累计消费账本、无全局预算
  - 单价来自环境变量人工估值（`video-provider-settings.ts:23-24` `SEEDANCE_ESTIMATED_CNY_PER_CLIP`），配置低于真实账单则实际花费超限
  - `video-generation.ts:103` 轮询超时直接 throw，不取消云端任务——已提交的付费任务可能继续计费
- 为什么是问题："成本上限"当前语义是"按估值的预算声明"，不是"花费保证"。UI 承诺"预算封顶 ¥N"（`NewRunDialog.tsx:378`）强于实现。
- 用户影响：付费接入后可能出现真实账单超预期。
- 复现步骤：代码证实；真实计费行为未验证（无 key，禁止）。
- 推荐修复：接入付费前建立任务级真实计费回填 + 全局消费账本 + 超限熔断；超时路径增加远端任务取消或至少告警。
- 验收标准：存在按任务实际计费对账的机制与测试；文档明确"上限=预估值封顶"的边界。

### [P2] 审片决定 API 语义缺陷：并发/重复决定返回 500 而非 409；decide 在持锁期间同步跑完剩余节点

- 类别：架构 / API
- 证据：
  - 数据安全有保障（文件锁 wx+pid 回收 `run-store.ts:128-202`、revision CAS、`workflow-runner.ts:296-309` 二次校验；并发测试证实 1 成功 1 拒绝且不重跑 `production-pipeline.test.ts:333-365`）
  - 但落败方收到 workflow-runner 抛的普通 Error → `app.ts:201-216` 未映射 → 500 "Internal server error."；`StaleRunRevisionError` 同样落 500
  - `production-pipeline.ts:111-118`：`POST /decisions` 在 `store.update` 文件锁内同步执行 resume（当前 manual 模式含 publish-package 的全量 sha256 复核）；无中间 checkpoint，HTTP 请求阻塞至完成（实测打回请求约 1s 内返回，但批准路径含打包更久）
- 为什么是问题：500 把正常并发冲突伪装成服务器故障；未来任何更早节点出现 needs_human 时该模式退化为分钟级持锁+长阻塞请求。
- 用户影响：双开窗口审片时看到"内部错误"；监控噪音。
- 复现步骤：对同一 needs_human run 并发 POST 两个 decide（未实测 HTTP 层，代码+pipeline 测试证实路径）。
- 推荐修复：pipeline 层错误类型化并在 app.ts 映射 409；decide 改为仅落决定、剩余节点异步续跑并继续走 SSE。
- 验收标准：重复决定返回 409 且 message 中文；decide 响应时间与剩余节点耗时解耦。

### [P2] Provider 身份四处重复定义 + 测试 Provider 仅靠 UI 过滤，直接调 API 可用测试音轨投产

- 类别：架构 / 安全
- 证据：
  - 四处定义：`provider-catalog.ts:20-171`（UI 目录）、`production-pipeline.ts:354-376`（known 硬编码表）、`generative-asset-worker.ts:46`（`KNOWN_METERED_ASSET_PROVIDERS`）、`NewRunDialog.tsx:41-47,410-423`（客户端 preferred id）。catalog 新增而 known 未同步时：预检放行 → dispatch 抛普通 Error → 500。`workflow-core` 的 `ProviderRegistry.replace()`（`provider-registry.ts:18-34`）在生产路径从未被调用——"可替换"只在编译期成立
  - `ffmpeg-tone-test-v1`（kind:"test"）仅被 UI 过滤（`NewRunDialog.tsx:101` 等）；服务端 `assertProvidersAvailable` 不检查 kind（`production-studio.ts:150-167`）；`contracts.ts` 允许 `tone:` 前缀 profile。直接 `POST /api/runs` 带 `providers.voice="ffmpeg-tone-test-v1"` 会真实投产测试音轨成片
- 为什么是问题：注册表"单一事实源"缺位使扩展即埋雷；test Provider 泄入生产路径违背"测试 Provider 不参与正式生产"的自述（`provider-catalog.ts:144`）。
- 用户影响：正常 UI 无影响；但与"studio 是唯一入口"的假设冲突（本机单用户场景风险有限，故 P2 偏低）。
- 复现步骤：curl 直接 POST /api/runs（未实测，代码路径确凿）。
- 推荐修复：known 表由 catalog 单一来源生成（或构建期一致性测试）；服务端拒绝 kind:"test"。
- 验收标准：新增 Provider 只需改一处；test Provider 经 API 提交返回 400。

### [P2] 文档能力矩阵与实现不符（Playwright 宣称、四源趋势采集、douyin-hotsearch "ready"、响应式断点）

- 类别：测试 / 文档真实性
- 证据：
  - `docs/loops/010-web-operator-studio.md:43`（`[x] Playwright completes the real user flow`）、loop-013:22-29——仓库 grep 零 Playwright 测试；浏览器验证是一次性会话，证据不可再生
  - `docs/guides/web-studio.md:180` 能力矩阵"自动趋势采集 已实现：TrendRadar/NewsNow/DailyHotApi/RSSHub"——`trend-gateway.ts:67-71` 信号仅实现 DailyHot+NewsNow；TrendRadar/RSSHub 只有健康探测（与其自身正文 :73 矛盾）
  - `provider-catalog.ts:178`：配两个 env 即把 douyin-hotsearch 置 ready，但全仓无任何 hotsearch 抓取适配器——"ready" 误导
  - `DESIGN.md:97-100` 断点 `>=1241/901-1240/701-900/<=700` 与 `styles.css` 实际 `1180/920/760/410/980/700` 不符
  - `README.md:55` "当前本机已启用 Pexels"、loop-016:9 "10 个 Kokoro 音色已预热"——机器状态写进仓库文档，对 clone 者为假
- 为什么是问题：文档是这批成果的"验收证据"，虚高宣称会传导到后续决策（如"已验证 Playwright 回归"）。
- 用户影响：误导协作者与未来的自己。
- 复现步骤：任一条按引用检索代码。
- 推荐修复：能力矩阵逐行改为"已实现/仅健康检查/规划中"三态如实标注；删除机器状态断言；Playwright 要么落地要么从 Exit Conditions 撤除。
- 验收标准：文档每条"已实现"都能指向代码或测试。

### [P2] StrictMode 下首访自动导览与向导自动弹出被永久抑制（dev 环境）

- 类别：架构 / 测试（测试掩盖的 dev 回归）
- 证据：`use-creator-tour.ts:70-71` `autoStartCheckedRef` 在 StrictMode 双执行 effect 时第二次 setup 已为 true，timer 被清后不再排期；`GuideDock.tsx:17-22` `promptedRoutes` 同理。`main.tsx:19` 启用 StrictMode；`creator-tour.test.tsx:84-106` 未包 StrictMode 故测试通过。
- 为什么是问题：`npm run dev`（4318）下首访用户永远等不到自动导览——开发自测与生产行为分叉，且现有测试发现不了。
- 复现步骤：`npm run studio:dev` → 清 localStorage → 打开 127.0.0.1:4318 → 导览不自动启动（推断自代码语义；未实测 dev server，见未验证项）。
- 推荐修复：ref 重置逻辑修正（cleanup 中重置或在 timeout 回调内判定）；测试加 StrictMode 包装用例。
- 验收标准：dev 与 prod 首访均自动启动导览，测试覆盖。

### [P2] 客户端 SSE（subscribeToRun/RunPage）零测试；SAFE_RUN_ID 与 HTTP 层穿越零测试；video-generation 失败/超时零测试

- 类别：测试
- 证据：见"缺失测试"部分逐条（`api.ts:69-76` 无任何测试；`run-store.ts:6,167-171` 正则无测试；`server.test.ts` 无穿越请求用例；`video-generation.test.ts` 仅覆盖成功路径，而 loop-012 宣称"failure, timeout 已实现"）。
- 为什么是问题：RunPage 的实时性是导览核心承诺，却是全站测试最薄处。
- 推荐修复：为 EventSource 封装补 jsdom 可行的单测（mock EventSource）+ 一条真实 SSE 集成测试已存在（server 侧），补客户端；穿越类补 HTTP 级用例。
- 验收标准：上述三项各有至少一条失败可检出的测试。

### [P3] 其余问题（按根因合并列出）

- **文案与状态**
  - "DAY 01 · 今日片场"硬编码（`AppShell.tsx:29`），永远显示第一天——假数据感
  - "0 种本地中文音色"加载闪烁（先渲染错误计数再等数据，实测 29 种最终正确）；"29 种"与 tab 计数 7/5/5/19 关系不明
  - NewRunDialog 章节编号 01/02/04（"03 生产节点"藏在折叠的"高级"区，实测确认）；收起态编号跳号
  - `NewRunDialog.tsx:216,221` 内容角度/目标受众为 defaultValue（示例文案会被原样提交）而非 placeholder
  - "自动通过"未说明后果是跳过人工审片（`NewRunDialog.tsx:364`），与"低质量不会静默流出"的全站承诺相抵触
  - 打回后文案"请根据审片意见重新生产"，但无任何"重新生产"入口（`RunWorkbench.tsx:153`；"Revision required" 眼眉 `:121` 暗示存在 revision 循环，实际 reject=终态无重跑 API）
  - "生产已完成，发布包可供运营使用"——"运营"角色在产品中不存在（`RunWorkbench.tsx:148`）
  - artifactLabel 缺 `media_asset`/`generation_jobs` 映射，付费配方产物列表将直出英文 snake_case（`RunWorkbench.tsx:164-178`）；`technical_review` 为死映射
  - 防御式否定句 6 处（"不会生成虚假的热点数据"等，`TodayPage.tsx:187`、`NewRunDialog.tsx:250`、`creator-tour-steps.ts:97,276`、`ExperimentsPage.tsx:27`）——AI 味、消耗信任
  - `ResourcesPage.tsx:90` `{services.length || 4}` 失败态伪造分母；`:93` "默认日更预算 ¥0"硬编码与实际配置脱节；`:97` "此刻的中文世界"夸大
  - "只填四项即可开始"实际必填 5 项（`OpportunityDialog.tsx:92` vs `:93-97`）；eyebrow "Verified signal" 在录入前即宣称（`:60`）
  - 移动端 /projects 统计卡无"已打回"计数（实测 6 条 rejected 在统计中不可见）；数字格式"00/05"前导零
  - `RunPage.tsx:58` "它可能已被移动或删除"——产品无移动/删除能力
  - 工程词暴露：`topic-intelligence-v1`/`qwen3:4b` 直出（`OpportunityRail.tsx:36`、`TodayPage.tsx:160,172`）、"REV 0"（`RunWorkbench.tsx:31`）、"Provider"（多处）、"烟雾测试"（`provider-catalog.ts:135`）、env 变量名与 make 命令（requirement 字段）、"神经女声"直译（`VoiceStudio.tsx:104`）、JSON 导入提示语（`OpportunityDialog.tsx:74`）
  - `index.html:7` title "VideoFactory Studio" 与站内品牌 "Creator Studio" 不一致；eyebrow 大小写混用（Title Case vs sentence case）
  - 导览欢迎语"六件事"与首页"01/02/03 三步"两套步骤模型并存
  - aria 与可见文字不一致："查看生产：{title}" vs "查看现场"（`ProductionStrip.tsx:24-25`）；机会总分 aria "机会总分" vs 可见"机会分"（`OpportunityFocus.tsx:19,21`）
- **交互与无障碍**
  - 弹窗 Escape 关闭后焦点未归还触发按钮（实测落到侧栏区域）
  - 首页 2 个 h1（页面标题 + 所选机会标题，实测）；无 skip-link；1 个按钮仅有 title 无 aria-label/文本（实测 `title="录入机会"` 图标按钮）
  - 移动端长标题无截断策略，122 字标题把列表卡片撑至极高（实测 390×844，可读但冗长）
  - GuideDock 每个路由会话内自动弹出一次（实测 /projects、run 页均自动展开），对专注浏览有打扰；其面板 role="dialog" 与业务弹窗语义混淆
  - 导览 waitForElement 窗口内快速点击"下一步"可跳步（driver.js 行为，实测复现；低优先）
- **工程卫生**
  - `NewRunDialog.tsx` 466 行巨型组件；预算推导逻辑与 `production-studio.ts:163-166` 双实现
  - `pages/ProjectsPage.tsx` 仅重导出 `ProductionPage`——文件名与导出名错位
  - `model.reason` 死代码：`DirectorPanel.tsx:27` 恒 false，"AI 导演"区块永远显示"未接入"（误导性 UI）
  - 命令探测双实现（`local-capabilities.ts:259` which vs `capability-studio.ts:76-87` 手动遍历 PATH）
  - VoiceStudio blob URL 仅在下一次 preview 时 revoke，unmount 泄漏（`api.ts:93`）
  - NewRunDialog 在 providers 未加载完成时打开会得到空 bindings（`NewRunDialog.tsx:118-131` deps 仅 [open]）
  - qualityGates 引擎完整但生产节点全部未挂载（`workflow-runner.ts:362-394` vs `production-pipeline.ts:157-287`）
  - jsdom 双声明 minor 不一致（root ^29.1.1 vs studio ^29.0.0）；registry 全走 npmmirror 镜像（integrity 锚定，低风险注明）
  - 无 Host 头校验（DNS-rebinding 窗口）、无 nosniff/CSP 加固头（本地单机工具可接受，注明）
  - `creative-os.test.tsx:132` 断言 data-tour 属性（导览锚点与测试耦合）

---

## 第二部分：术语与文案统一表

| 当前用词 | 出现位置 | 实际对象/行为 | 问题 | 推荐统一用词 | 推荐文案 |
|---|---|---|---|---|---|
| 创建创意方案 / 新建视频生产 / 新建生产 / 开始生产 | DirectorPanel.tsx:69 / NewRunDialog.tsx:191 / ProductionQueue.tsx:39 / NewRunDialog.tsx:382 | 同一动作链：打开弹窗→提交生产 | 5 个名字描述 1 条动作 | 新建制作（入口与弹窗标题）/ 开始制作（提交按钮） | 入口"新建制作"；弹窗标题"新建制作"；提交"开始制作" |
| 机会 / 候选机会 / 选题 / 选题池 / 候选选题 / 提案 | OpportunityRail.tsx:17 / TodayPage.tsx:120,174 / creator-tour-steps.ts:14 等 | opportunity 对象（含 Agent 候选转入） | 8 个叫法 | 机会（对象）/ 今日提案（Agent 候选专称） | "今日机会 N 条"（去掉"已核验"） |
| 创意项目 / 生产任务 / 制作记录 / 项目 / 任务 / 片场日志 | ProductionQueue.tsx:51,79,111 / RunPage.tsx:57 | run（生产实例）及其列表页 | 6 个叫法 | 制作（实例）/ 制作记录（列表） | 空态"还没有制作记录" |
| 生产中 / 正在生产 / 正在制作 / 等待中 | StatusBadge.tsx:5-6 / ProductionStrip.tsx:20 / ProductionQueue.tsx:45 | running / pending 状态 | 同态多名+两处矛盾 | 排队中（pending）/ 制作中（running） | 徽章与条幅统一 |
| 等待审片 / 需要你的判断 / 做审片 / 进入审片 | StatusBadge.tsx:9 / RunWorkbench.tsx:71 / GuideDock.tsx:12 / ProductionQueue.tsx:112 | needs_human（人工终审等待） | 4 词且不分技术/人工 | 等你审片 | 状态徽章"等你审片"；详情页标题"需要你的判断"可保留其一 |
| 技术审片 / 人工终审 / 终审 | NewRunDialog.tsx:46,362-363 | quality.review 节点 / final-review 节点 | 边界未向用户说明 | 机器质检 / 人工终审 | "机器质检（自动）"“人工终审（你来定）" |
| 成片归档 / 已完成 / 已结束 | TodayPage.tsx:58 / StatusBadge.tsx:7 / ProductionQueue.tsx:60 | succeeded / 终态分组 | 3 种分组名 | 已完成（状态）/ 已归档（筛选，含打回） | 筛选改"已完成 / 已打回"分开 |
| 素材 / 画面素材 / 画面来源 / 素材与模型 / 制作底座 | NewRunDialog.tsx:43 / ResourcesPage.tsx:91,143 / AppShell.tsx:34 | asset.prepare 能力与资源页 | 5+ 叫法 | 画面来源（能力）/ 素材与模型（页面） | 页面内区块统一"画面来源""声音""本地引擎" |
| 导演台 / 导演桌 / 导演控制台 / 导演镜头板 / 创意决策 | creator-tour-steps.ts:40,15 / DirectorPanel.tsx:30,34 / OpportunityFocus.tsx:31 | 右侧决策面板 / 镜头示意区 | 4 个导演词 | 决策面板（可见标题）/ 镜头方向（示意） | 面板标题"开拍决策"；镜头区"镜头方向（示意）" |
| 母带风格（导览） / 声音质感（控件） | creator-tour-steps.ts:261 / VoiceStudio.tsx:153 | 同一控件 | 导览词在界面不存在 | 声音质感 | 导览同步改"声音质感" |
| 待接入/待配置 vs 规划中/需要配置 | NewRunDialog.tsx:335 / ResourcesPage.tsx:171 | 同一 status 值 | 两套映射 | 即将支持 / 需要配置 | 全站统一 |
| 付费镜头 / 计费镜头 | NewRunDialog.tsx:195,369 | maxPaidShots | 同页两词 | 付费镜头 | "最多 N 个付费镜头" |
| DOUYIN / 抖音 / B 站 / 哔哩哔哩 | DirectorPanel.tsx:44 / OpportunityRail.tsx:57-58 / ResourcesPage.tsx:191 | 平台名 | 中英混用两套 | 抖音 / 小红书 / 哔哩哔哩 | platformLabel 映射统一 |
| 24 秒 / 24s / 0-03s | NewRunDialog.tsx:239 / ProductionQueue.tsx:101 / OpportunityFocus.tsx:6-8 | durationSeconds | 三种格式 | N 秒（镜头板可保留分镜记法但注明单位） | "{n} 秒" |
| 已核验机会 / 真实信号 | TodayPage.tsx:58 / OpportunityRail.tsx:23 | 未核验的机会集合 | 虚假承诺 | 删除真实性修饰 | "今日机会 {n} 条" |
| 已批准（机会状态） | OpportunityRail.tsx:47 | 开始生产时系统静默置位 | 非用户所为 | 已投产 | 状态标签"已投产" |
| 自动通过 | NewRunDialog.tsx:364 | reviewMode=automatic | 未说明跳过人工审 | 跳过人工终审 | "跳过人工终审（直接进发布包）" |
| 重新生产（文案） | RunWorkbench.tsx:153,156,159 | 无对应入口 | 指引不存在的能力 | — | "已打回。回到今日机会，用同一配方重新发起。" |
| REV {n} | RunWorkbench.tsx:31 | run.revision | 工程版本语 | 第 N 版 | "第 {n} 次决定后"或不展示 |
| Provider | NewRunDialog.tsx:271 / creator-tour-steps.ts:265 / ResourcesPage.tsx:138 | 能力提供方 | 工程词 | 能力 / 画面来源 | "逐节点选择能力与兜底" |
| topic-intelligence-v1 / qwen3:4b（直出） | OpportunityRail.tsx:36 / TodayPage.tsx:160,172 | 评分来源/模型 ID | 工程 ID 当署名 | 本地评分 / Qwen3 本地提案 | ID 移入 title 提示 |
| 生产实验 | ExperimentsPage.tsx:31 | 全部 run 计数（含失败） | 词义错位 | 已发起制作 | "已发起 {n} 次" |
| 录入真实机会 / Verified signal | OpportunityDialog.tsx:60-61 | 手动录入表单 | 录入前即宣称已核验 | 手动录入 | eyebrow"手动录入" |
| 只填四项即可开始 | OpportunityDialog.tsx:92 | 实际必填 5 项 | 数字错误 | — | "标题、受众、痛点、钩子为必填" |

---

## 第三部分：完整用户路径断点图

图例：✅ 顺畅 / ⚠️ 有摩擦 / ❌ 断点。基于真实浏览器逐步操作。

1. **打开首页** ✅ — 加载快、console 零错误、首访自动弹导览（生产构建）
2. **理解今天应该做什么** ⚠️ — 首页"01/02/03 三步"与导览"六件事"两套步骤模型并存；"DAY 01"硬编码；"已核验机会"虚假修饰
3. **选择一个机会** ✅ — 雷达列表可切换、同步更新决策面板；⚠️ 卡片副标工程 ID 直出；机会卡"已批准"来源不明
4. **判断证据和画面方向** ❌ — 证据区真实（来源/时间/外链，实测抖音热榜链接存在）；但"导演镜头板"是硬编码篮球占位图并谎称"Pexels 实拍"——用户在这一步基于假画面做判断
5. **创建制作配方** ⚠️ — 入口按钮在 1280×720 被向导按钮遮挡（实测）；弹窗本身结构清晰、免费/付费边界诚实、disabled 原因可理解；但章节编号跳 03、示例 defaultValue 会被提交
6. **理解免费与付费能力** ✅ — 全流程最扎实的部分：经济日更显式"零计费 API"、付费配方未配置即禁用并说明原因、成本上限联动；❌（隐）默认音色与实际合成不一致（P1#1）
7. **启动或安全地停止在启动前** ✅ — 取消/Escape 均有效（实测）；导览明确"不会替你花钱"；开始生产后自动跳转 run 页
8. **进入创意项目** ✅ — 面包屑"创意项目"可返回；列表信息完整（状态/时长/平台/节点条）
9. **理解任务状态与节点进度** ⚠️ — 8 节点进度真实（实测 24s 成片全自动产出）；但节点名两套、pending/running 徽章矛盾、列表不实时刷新
10. **进入生产现场** ✅ — run 页节点+产物+成片预览+审片区同屏；SSE 实测正常推送至 needs_human
11. **理解什么时候等待、什么时候审片** ⚠️ — "需要你的判断"标题+中文干预理由清晰；但"自动通过"模式的后果未说明；列表页同状态叫"等待审片"
12. **找到成片、审片报告和发布包** ✅ — 实测：成片可播可下（24s mp4）；技术审片报告、脚本、素材计划、配音产物全部可下载；归档 run 的发布包真实（JSON 含 approval + AIGC 披露）；打回链路实测完整（空原因禁用→原因必填→持久化→原因展示）
13. **理解发布后如何进入实验复盘** ❌ — 页面只有统计卡+"平台数据尚未接入"，无任何录入入口；导览/GuideDock 却指导用户"记录真实播放/完播/互动/涨粉"——死路
14. **中途忘记操作时重新唤起引导** ✅ — 右下角"创作向导"常驻，支持"完整带我做一条"与"讲解当前页面"（实测各页可用）；⚠️ 自动弹出的时机有打扰感
15. **提前结束引导后重新开始** ✅ — 实测："提前结束"记完成；向导面板可随时重放完整导览；版本号机制（creator-canvas-v2）支持版本升级重放

路径外实测补充：导览中切路由 → 过期遮罩盖新页面（P2#6）；打回后刷新状态持久（revision 1）；长标题全链路不截断不溢出（桌面/平板/手机）。

---

## 第四部分：架构风险

1. **生命周期完整性是最大缺口**：崩溃恢复缺失（P1#2）、SSE 客户端无错误处理、无 run 级总超时（节点级 20 分钟 × 8 串行）、video adapter 超时不取消远端任务。分层与并发正确性反而是强项。
2. **Provider 注册表无单一事实源**（四处定义 + replace 从未调用 + test Provider 泄入 API 路径）。
3. **decide 与文件锁/长任务纠缠**：HTTP 请求内同步跑完剩余节点、无 checkpoint，未来扩展会恶化。
4. **导览系统与路由生命周期脱节**（无路由变化销毁、StrictMode dev 抑制、打断即误记完成）。
5. **实时性架构与文案承诺不匹配**：SSE 只覆盖单 run 详情，列表/统计无任何更新机制。
6. 正向确认：client→shared←server→pipeline→core 单向依赖零循环；数据校验三层（shared 解析器/服务端预检/Worker 复验）；产物 sha256 链 + 原子写 + 文件锁 + revision CAS；列表为详情的严格投影（单一映射函数）。

---

## 第五部分：缺失测试

1. 客户端 `subscribeToRun`/RunPage SSE 行为（建立/终态退订/断线）——零测试
2. `SAFE_RUN_ID`/`validateRunId` 与 HTTP 层路径穿越请求——零测试（防线存在但主入口无证据）
3. `video-generation.ts` 的 FAILED 终态、轮询超时、HTTP 非 200——零测试（loop-012 宣称已验证）
4. 导览：AppShell 卸载 destroy、导览中路由切换、driver.js 真实渲染行为（现全 mock）
5. 并发 decide 的 HTTP 层表现（pipeline 层已测，409 语义未测）
6. main.ts 静态服务/SPA fallback/`/api/` 404 handler——零测试
7. trend 缓存 TTL 过期分支；listSignals 一源失败对整体的影响
8. `POST /api/runs` 垃圾 body 的 HTTP 层断言（StudioInputError 映射仅在决策/试听测过）
9. ExperimentsPage 统计聚合逻辑——零测试
10. e2e.real.test.ts 默认跳过（仅 `make test-e2e`），CI/默认测试不含真实媒体链路
11. 移动端/响应式组件级测试为零（纯手工截图，且 Playwright 宣称无落地）

---

## 第六部分：未验证项目

1. 进程崩溃→重启后僵尸 run 的最终 UI 表现（代码路径确凿，未 kill 用户进程实测）
2. `npm run dev`（StrictMode）下自动导览被抑制（代码语义推断，未启动 dev server）
3. 并发双 decide 的真实 HTTP 结果（只读约束未发并发 POST）
4. Seedance/Wan 真实计费与配置单价一致性（无 key，禁止触发）
5. douyin 证据链接（douyin.com/hot/2620543）的外部可达性（未外访）
6. `e2e.real.test.ts` 与 `make test-e2e` 的当次通过性（未运行）
7. Python 侧 `src/video_factory/` 全量逐行审计（worker.py 入口与调用点已核，后 60% 未逐行）
8. 视频画面的真实观感质量（占位卡片成片的内容质量判断超出审计范围）
9. 真实 390px 物理设备表现（Chrome 窗口最小 500px，390 经 emulate 模拟，DPR/触控差异未覆盖）
10. 页面已加载后单 API 失败的实时 UI（整页 Offline 只能得到 Chrome 错误页；该场景仅有单测证据）
11. npmmirror 与 npmjs 的 tarball 一致性（以 integrity 哈希存在为等价锚定）
12. 非法 JSON body 的响应形态（推测 500 非 400，未发 POST 验证）

---

## 第七部分：验证命令记录

| 命令 | 结果 |
|---|---|
| `npm test --workspace @video-factory/studio` | ✅ exit 0（vitest 35 pass + node --test 49 pass，0 fail） |
| `npm run typecheck --workspace @video-factory/studio` | ✅ exit 0 |
| `npm run build --workspace @video-factory/studio` | ✅ exit 0（vite 51.2s，JS 359.7KB / CSS 308.7KB） |
| `git diff --check` | ✅ exit 0 |
| `curl -fsS http://127.0.0.1:4317/api/health` | ✅ `{"status":"ok","runtime":{python:true,ffmpeg:true,ffprobe:true,say:true}}`（注：环境 Squid 代理拦截 127.0.0.1 需 `--noproxy '*'`；503 来自代理非应用） |

浏览器检查：全部会话 Console 零 error / 零 warning（含 preserved history）；网络请求全部 200（含 SSE）；无 React 警告；规定视口下无横向溢出（桌面 1280 宽存在 28px 溢出，元凶为右栏 `panel-heading`/`director-brief` 长文本——注：该宽度非规定视口，1440/768/390 均无溢出）。

---

## 第八部分：最值得优先修复的 10 项

1. **提交全部 untracked 成果**（P1#3）——其他一切的前提
2. **音色路由不一致**（P1#1）——默认路径内容质量 + 信任
3. **崩溃恢复 + SSE 错误处理**（P1#2 + P2#8 部分）——消除僵尸"生产中"
4. **术语统一表落地**（P2#7）——一个常量模块 + 文案走查
5. **移除真实性虚假宣称**（P2#11：已核验/真实信号/镜头板假图/静默 approved）——红线问题
6. **英文错误中文化 + node.error 折叠**（P2#9）
7. **导览路由销毁 + StrictMode 修复**（P2#6 + P2#14）
8. **decide 异步化 + 409 语义**（P2#12）
9. **兑现或撤回"实时"承诺；fallbackProviderIds 展示降级为"规划中"**（P2#8 + P2#10）
10. **补 SSE 客户端/穿越/导览生命周期三类测试 + 文档能力矩阵纠偏**（P2#15 + P2#13）

---

## 第九部分：总评分（0-10）

| 维度 | 分 | 依据 |
|---|---|---|
| 首次使用可理解性 | 6 | 导览完整可走通、恢复入口常驻；但两套步骤模型 + 术语混乱拉低 |
| 任务闭环完整性 | 6.5 | 生产→审片→发布包真实闭环（实测）；实验复盘死路 + 崩溃无恢复 |
| 中文文案质量 | 5 | 大量用心之作（干预理由、provider 描述）；但也有 AI 味防御句、示例值提交、虚假宣称 |
| 术语一致性 | 3 | A1-A23 组冲突，核心概念 5-8 个名字，状态词跨页矛盾——全站最大短板 |
| 交互反馈 | 7 | loading/error/重试全覆盖、禁用有因、打回校验完整；扣分：CTA 遮挡、列表不刷新 |
| 视觉层级 | 7 | eyebrow+标题+分区结构清晰、三视口无溢出；编号跳号、DAY 01 假计数 |
| 移动端体验 | 7.5 | 底部导航/无溢出/无遮挡（实测 390×844）；长标题不截断、向导自动弹出打扰 |
| 无障碍 | 6 | landmark/aria-live/slider aria 用心；双 h1、无 skip-link、title-only 按钮、焦点不归还 |
| 功能真实性 | 6 | 亮点与硬伤并存：成本边界/Provider 状态/热点数据全真实；镜头板假图、"已核验"/兜底/实时是虚假宣称 |
| 成本透明度 | 8 | 三层服务端约束 + 免费默认 + 付费显式禁用说明，同类产品少见；扣分：估值非实付、无累计账本 |
| 架构质量 | 7 | 分层纪律、校验、幂等、产物链皆为上乘；生命周期完整性与注册表单一源是结构性欠账 |
| 测试可信度 | 7 | 行为测试质量高（并发/篡改/回归皆有）；SSE 客户端/导览/穿越零覆盖 + 文档宣称超出证据 |

---

## 第十部分：结论

**当前是否适合交给真实创作者使用？——否。**
阻断项：术语体系混乱（创作者无法建立稳定心智模型）、镜头板假图与"已核验"等真实性宣称（误导决策）、默认音色不符（第一次生产品质即受损）、实验复盘死路、崩溃后僵尸任务无解释。以上任意一条都会在真实日更的第 1-3 天摧毁信任。

**当前是否适合接入付费 API？——否。**
阻断项：成本上限为"自声明估值"而非真实计费约束、无跨 run 消费账本与熔断、远端任务超时不取消、单 run 可声明至 ¥100,000、付费镜头失败会连带已花费镜头整 run 报废（无兜底）。经济防护的三层架构是好的地基，但缺"真实账单"这一层前不应放开付费。

**当前是否适合公开部署？——否（当前也未按公开形态部署：仅绑定 127.0.0.1，这是正确的）。**
阻断项：代码未提交（无可部署的可靠基线）、无鉴权模型（单机单操作员假设未文档化为硬边界）、错误消息含本地路径、无 Host 校验/安全头。作为本机单操作员工具的定位是自洽的；任何多用户/公网形态都需要重新审视写 API 的并发与鉴权。

**达到上述三个条件前必须完成（按序）：**
1. 提交全部成果，建立可回滚基线（P1#3）
2. 修复音色路由、崩溃恢复、SSE 错误处理三个正确性缺陷（P1#1、P1#2）
3. 落地术语统一表并全站文案走查，删除全部真实性虚假宣称（P2#7、P2#11）
4. 错误消息中文化 + 决定 API 语义修正（P2#9、P2#12）
5. 补齐 SSE 客户端/路径穿越/导览生命周期测试；文档能力矩阵改为如实三态（P2#15、P2#13）
6. 付费接入前置条件：真实计费回填 + 全局账本 + 超限熔断 + 远端任务取消（P2 成本项）
7. 公开部署前置条件：鉴权、Host 校验、安全头、多操作员并发边界文档化

---

*本报告为只读审计。审计过程中产生的唯一持久变更已在文首"副作用"一节完整披露。*
