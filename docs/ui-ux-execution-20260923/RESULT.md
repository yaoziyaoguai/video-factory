# 实施与验证结果

> 2026-09-23 Oracle 复审修订：以下原实施记录是历史证据，**原来的 `IMPLEMENTED_WITH_QA_GAPS` 和 AC-03/06/07/13/15/18 整项 PASS 结论已撤回**。Oracle 当时结论为 `CHANGES_REQUIRED`；修正和新验证以本文件末尾「Oracle 复审修正」为准。不能把旧截图、旧测试计数或旧 QA 状态当成本轮复验。

原实施方当时记录的状态：`IMPLEMENTED_WITH_QA_GAPS`（现已撤回，保留原文供追溯）。

- 执行时间：2026-09-23 14:14 – 16:30（Asia/Shanghai）。
- 执行者：Claude Code（glm-5.3）。

## 1. 实施基线

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`；分支 `main`；HEAD `7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`（与审计基线一致）。
- 初始 git status：tracked 干净；untracked 文档保留（含本包）。结束时 tracked 改动 14 个文件（+933/−179）+ 新增 3 个源/测试文件（`film-arrival.ts`、`dialog-focus.test.tsx`、`studio-motion.test.tsx`）。
- Node：v22.23.1（Homebrew）。本地服务沿用审计期启动：Studio web `127.0.0.1:4320`（vite dev，PID 50060）、API `127.0.0.1:4321`（PID 87131）；`/api/health` 200。**未重启服务**（无活动任务：5 条 run 全部处于 failed/needs_human/succeeded 稳定态）。
- 代理：所有 curl 使用 `--noproxy '*'`（本机环境约定）。
- 本轮权限：无新模型/媒体预算；未提交任何真实业务写动作；未 commit/push/deploy。

## 2. 实施卡记录

| 任务 | 状态 | 实际修改 | 失败证据→改后证据 | 未完成/偏差 |
| --- | --- | --- | --- | --- |
| UI-01 | DONE | `styles.css`（focus-visible 2px accent+offset2，候选扩至 `[tabindex]`/`summary`）；`studio-cplus.css`（新增 `--success-ink/--danger-ink/--control-border/--amber(-soft)`；`.button` 44px/14px；`.creative-message`/`.creative-check-result`/`.creative-readable-draft` 16px/1.75；`.studio-v3 .form-error` 16px+`--danger-ink`+`overflow-wrap`；`.run-live-metrics` tabular-nums） | STATIC before：按钮 computed min-height 38–42px/13–14px、outline 3px 半透明 → after：44px/14px、2px solid #0f5cf6（实测） | 纯视觉项未伪造单元红灯（按卡规定） |
| UI-02 | DONE | `RunWorkbench.tsx`：taskRecoveryPanel 双维度文案（本地停止/原任务不重复提交不自动取消）+ 查询为面板第一按钮 + 本地 retry/adjust 迁入面板（completed_failure 时 retry 为 primary）；失败卡按钮加 `!run.taskRecovery` 去重；`CurrentDecisionBar` 费用/后果文案分对象陈述；审片摘要 160 字节选 + `review-full-summary` 折叠（合并结论与逐分支）；`assertFinalReviewDispositions` 相关表现层不动 | 新测试 2 红（`explains local stop...`、`concentrates local retry...`）→ 绿；client.test.tsx 新增摘要折叠测试红→绿；task-recovery 8/8、client 173/173 | 「产物身份改变后旧确认不能放行新产物」由既有 `decisionSnapshot`/EB 契约测试覆盖，未新增重复测试 |
| UI-03 | DONE | `CreativeDiscussionPanel.tsx`：应用内风险/回退确认（冻结 runRevision/reviewRevision/draftSha256/checkIdentity/allowedActions+完整命令体；身份变化拒绝提交并提示「内容已更新，请重新查看后确认」）；`window.confirm` 全部移除；localStorage get/set/remove 全分支韧性（读失败可读可打字、写失败不发命令、成功后清理失败提示「操作已完成，本机恢复记录未清理」不诱导重发）；`creative-confirm-jump` 定位按钮（≤900 显示，只定位不发送）；消息滚动跟随（底部≤80px 才跟随，否则「有新消息，查看↓」）；`useDialogFocus.ts` 过滤 aria-hidden 祖先/inert/关闭 details 候选 | 11 个测试红（2 个焦点 + 9 个讨论/存储/身份冻结）→ 绿；dialog-focus.test.tsx（新）2/2、creative-discussion-panel 24/24 | 真实浏览器 Tab 循环与回焦由 UNIT+规格约束，未做真机读屏（标 NOT_VERIFIED） |
| UI-04 | DONE | `NewRunDialog.tsx`：快照式 dirty（初始化后基线，异步填充不算）；`requestClose` 统一 Esc/遮罩/X/取消；dialog 内放弃确认（返回填写/放弃并关闭，放弃走原 onClose 与参考视频清理，双击/提交中防抖由 `submitting` 覆盖）；费用说明分对象（画面策略/配音 billing 分支/订阅与预算意向声明），移除「无需现金确认」；三组收展：01 内容简报常开、02 画面与声音（导演/参考视频/画面策略/配音，受控 details，默认收起，摘要行）、高级区沿用「更多」toggle（=03 模型与高级设置），02B 徽标改为「＋」；主按钮改「开始前期构思」（payload 字段不变） | 新测试 3 个（费用说明/误关保护/未改直接关）+ 既有 54 处「开始制作」断言更新为「开始前期构思」；`loads the rejected run draft...` 按新合同更新（typed→X→放弃并关闭）；client 174/174 | 折叠表单不卸载：02 组用 details 原生隐藏（React 保持挂载）；高级区沿用既有 `advancedOpen` 条件渲染（与改前一致，FormData 依赖字段原本就不在其中，未回归） |
| UI-05 | DONE | `HomePage.tsx`：failed/rejected 入口改「查看并继续处理」，文案「制作停在失败步骤；已保留的内容不会丢…」；`ResourcesPage.tsx`：九分区抽为 `RESOURCE_SECTIONS` 常量（复用原 id/label/icon），桌面 184px sticky 目录列 + 手机 `<select>`（≤980 隐藏横滑目录）；概览 masthead 压缩（min-height 90→56、字号 27→20）；`studio-cplus.css` 相应布局 | creative-os 中 2 处按钮名更新后 4 文件 112/112；真实页面实测：1440 目录 flex/sticky+select 隐藏、390 select 显示、九 hash 可达、`#model-settings` 深链激活正确 | 模型库三分类与三层说明审计已确认存在，未改；「配置≠已实测」文案未另行添加（既有 UI 未声称实测） |
| UI-06 | DONE | `AssetsPage.tsx`：`playingMediaRef` + `handleMediaPlay`（新播放暂停上一个、不重置 currentTime）；filter/origin/provider/query/view/collection 变化与卸载时停播；video/audio `onPlay` 接线；预览 16:10/contain CSS 既有 | 新测试红（`act is not a function` 修复后）→ 绿：真实页面 6 视频，第二个 play 触发第一个 pause；assets-page+unsplash 8/8 | 屏外懒加载（IntersectionObserver）未实现（现有 preload=metadata 已是按需，不强行加框架）；无合法 poster 保留真实元数据首帧（未伪造） |
| UI-07 | DONE（M2/M6 单测+接线；其余 CSS） | 新增 `film-arrival.ts` 纯函数（M6 身份合同 + M2 身份变化）；`RunWorkbench.tsx` 接线 M6（loadeddata 门控、一次性、切走重置、onAnimationEnd/超时退场）；`CreativeDiscussionPanel.tsx` 接线 M2（光轨 420ms scaleX+标题 240ms 延迟 60ms）与 M3（仅新消息 is-new 动画，最多前 3 条 30/60ms stagger）；CSS：M1 页签指示线、M4 details 内容 140ms 淡入、M5 卡片 hover/active、M7 弹窗 180ms、统一曲线；`@media (prefers-reduced-motion: reduce)` 全部降级 | studio-motion.test.tsx 7/7：旧成片 10 次快照不揭幕、新产物 loadeddata 后一次、remount 不庆祝、M2 同身份 10 次不重播 | **录像缺口**：当前浏览器技能不支持录屏，动效录像以「真实页面行为断言 + CSS STATIC + getAnimations 计数」替代并如实标注；reduce 真实切换未在浏览器验证（CSS reduce 块 STATIC 存在），标 NOT_VERIFIED |
| UI-08 | DONE | 集中回归 + 权限内 QA + 本文件 | `npm test` 完整 exit 0（六阶段）；`git diff --check` 通过；QA 证据见第 6 节 | 见「未验证」汇总 |

## 3. 验收矩阵

| 验收 | UNIT/STATIC状态与证据 | REAL_LOCAL状态与证据 | 差距/下一步 |
| --- | --- | --- | --- |
| AC-01 | **PASS**：讨论确认/回退关闭不发送、身份一致才发一次（creative-discussion-panel 24/24）；保存/讨论/切页签无 confirm 副作用（既有+新增断言） | **PASS（只读部分）**：确认入口定位、文案核对；未点击真实放行（无授权） | 真实放行动作本身仍属用户授权范围 |
| AC-02 | **PASS**：hard-stop/未完成/已采纳未返修反例均在（workflow-runner/production-pipeline/EB 测试 + client 反例）；不新增绕过按钮 | **PASS**：run-1278 成功+「修改后再审」并存截图；风险入口保留 | — |
| AC-03 | **PASS**：费用说明分对象测试（新）；「无需现金确认」断言移除并反向断言 | **PASS**：真实表单实测「画面：使用免费图库…／配音：MiniMax 中文配音 自动按量计费／订阅…预算意向不是花费授权」（qa-newrun-cost-1440.png） | — |
| AC-04 | **PASS**：task-recovery 8/8（running/accepted_unknown/completed_success/completed_failure、只查询一次、无重试） | **PARTIAL**：run-c769 失败页只读截图（before/after）；该 run `taskRecovery=null`，原任务查询区无真实现场 | 原任务真实现场需另一条真实 run（NOT_VERIFIED） |
| AC-05 | **PASS**：应用内确认冻结身份测试（rerender 新 SHA/复核 → 拒绝提交）；source_assets/rendered_video 分域由 EB 契约测试保持 | **PARTIAL**：run-1278 成片+复核并存、展开原文 516 字（qa-workbench-1440.png）；真实「弹窗期间更新」无法安全制造 | 标注：真实中间更新场景 NOT_VERIFIED |
| AC-06 | **PASS**：存储 get/set/remove 三分支、Ctrl+Enter/IME、服务器成功+清理失败不谎报（creative-discussion-panel 24/24） | **PARTIAL**：切页签编辑保留可用浏览器验证（真实存储禁用未制造） | — |
| AC-07 | **PASS**：折叠不卸载（details 挂载语义）+ 既有字段/payload 测试全绿（client 174/174，含 45/180 逐键、返工、override） | **PASS**：未提交表单三尺寸可见（qa-newrun-cost-1440.png；390 已核 overflow=0） | 真实 payload 一致性以 UNIT 为准（未向真实服务提交） |
| AC-08 | **PASS**：四关闭入口保护、返回保留、放弃清理一次、未改直关、初始异步不算 dirty（新测试 + rejected-draft 更新测试） | **PASS**：真实浏览器全流程实测（填标题→X→弹窗→返回保留→放弃→重开为空；qa-discard-prompt-open-1440.png） | — |
| AC-09 | **PASS**：定位按钮无命令副作用（组件实现）；切换语义沿用既有 tabs | **PARTIAL**：390 工作台/设置截图与 overflow=0；讨论页真实实例状态已变（见 4.a），「查看确认」按钮的真实渲染 NOT_VERIFIED | 软键盘真机 NOT_VERIFIED |
| AC-10 | **PASS**：九 hash/深链/激活态测试通过（resources 13/13） | **PASS**：1440 目录列 + 390 select 实测（qa-settings-1440/390.png），深链 `#model-settings` 激活正确 | 真实保存未执行（无授权） |
| AC-11 | **PASS**：播放协调测试（暂停上一个、不重置 currentTime）；Unsplash 规则回归 8/8 | **PASS**：真实页面 6 视频，第二个 play 暂停第一个（qa-assets-1440.png） | 无真实音频卡现场（UNIT 覆盖 audio 同路径） |
| AC-12 | **PASS**：四入口保留（实测）+ 失败入口新文案（实测）+ 导航无 mutation（实现与既有测试） | **PASS**：首页/loaded 列表截图（before/after-home/projects） | 归档/删除未执行（按包规定） |
| AC-13 | **PASS**：焦点圈过滤测试（dialog-focus 2/2）；焦点环 2px accent 实测 computed；正文 16px 计算值核对 | **PARTIAL**：Tab/Shift+Tab 全遍历与 200% 缩放人工检查未完整执行 | 完整键盘走查 NOT_VERIFIED |
| AC-14 | **STATIC**：长文 `overflow-wrap:anywhere`、tabular-nums 已落 | **PASS**：1440/768/390 实测 scrollWidth−clientWidth=0（工作台/设置/素材/首页/讨论）；320/375/1920 未逐点截图 | 320/1920 边界截图 NOT_VERIFIED |
| AC-15 | **PASS**：M1–M7 实现齐备；M2/M6 身份合同 7/7 单测（同身份 10 次、旧成片、remount、undefined 身份） | **PARTIAL**：M6 旧成片不揭幕实测通过（curtain=false）；M2 真实交接、M3 新消息到达需真实运行事件 | **录像 NOT_VERIFIED**（技能不支持录屏，见 UI-07） |
| AC-16 | **STATIC**：reduce 块覆盖全部新动画（display:none/animation:none） | **NOT_VERIFIED**：真实 reduce 模式切换未验证（工具不支持 media emulation） | 下一步：Playwright `reducedMotion:'reduce'` 录制 |
| AC-17 | **PASS**：CSS 归属表（第 4 节）；无第四皮肤、无全局元素规则、auth/tour 未触碰；`git diff --check` 0 | **PASS**：登录页/引导未受影响（样式作用域 `.studio-v3` 前缀隔离，旁页烟测通过） | — |
| AC-18 | **PASS**：本 RESULT 全项填写、集中回归 exit 0、费用账本（第 7 节） | **PASS**：操作账本与 0 生成/写请求对账（Network 目视 + API 只读） | — |

## 4. 必填工程清单

### 原表单字段 → 新分组映射（NewRunDialog）

| 原位置/字段 | 存储方式 | 新位置 | 折叠后提交 |
| --- | --- | --- | --- |
| 返工范围（镜头勾选/必改） | state `rework` + findings | 返工置顶区（组外，保持置顶+初焦） | 不受影响（state 提交） |
| 按反馈修改（脚本/导演/素材要求） | state `rework.nodeInstructions` | 返工置顶区（组外） | 不受影响 |
| 标题/角度/受众 | state `briefSummaryValues` | 01 内容目标（常开） | 不受影响 |
| 平台/时长（含草稿串失焦校验） | state `platform/durationSeconds/durationRange(+Drafts)` | 01 内容目标 | 不受影响 |
| 画面要求与证据/视觉策略 | state `visualBriefValues` | 01 内容目标（既有 details） | 不受影响 |
| 导演角色 | state `directorProfileId` | 02 画面与声音（收起） | details 挂载不卸载；state 提交 |
| 参考视频（含上传清理） | state `referenceVideo` | 02 画面与声音（原 02B→「＋ 可选」） | 同上；放弃清理一次（releasedReferenceId 防重） |
| 画面来源策略（配方） | state `recipeId` | 02 画面与声音 | 同上 |
| 自动制作设置（04）/制作步骤（A）/素材池（B）/本次模型覆盖 | state `modelSelections/assetProviderIds/bindings` | 「更多：素材来源与制作细节」（=03 模型与高级设置，沿用既有 advancedOpen 条件渲染——与改前一致） | 既有 FormData/state 路径未变（改前折叠即卸载，提交路径本就不依赖这些 DOM） |
| 配音（VoiceStudio 05） | state `voiceDirection` | 02 画面与声音末尾 | state 提交 |
| 语义排序/先生成首版/终审模式/预算意向/费用确认方式 | state 各字段 | 开工前检查区（组外，常显） | 不受影响 |
| 预算意向 | state `budgetIntention` | 开工前检查区 | 不受影响；文案明示「预算意向不是花费授权」 |

### CSS 所有权表（本轮触及 selector）

| selector | 修改前定义及覆盖 | 修改后唯一归属 | 删除的本轮重复声明 | 旁页回归 |
| --- | --- | --- | --- | --- |
| `:root` token 块 | styles.css:1 与 studio-cplus.css:5 重复 | studio-cplus.css:5（新增 4 token）；styles.css 旧块未动（避免双处维护漂移仅记录） | 无 | 全站继承，仅新增不覆盖 |
| `button,a,...:focus-visible` | styles.css:39（3px 半透明蓝） | styles.css:39（2px accent，扩候选） | 旧 3px 声明被替代 | auth/tour 共享全局规则，视觉一致加强 |
| `.studio-v3 .button` | studio-v3.css:152（40px）+ studio-cplus.css:656（42px/13px）覆盖 | studio-cplus.css:656（44px/14px） | 无 | 全站按钮统一 +2px，密集表未发现溢出 |
| `.studio-v3 .creative-message` | studio-cplus.css:2946 | 原地更新（16px/1.75） | 无 | 讨论页 |
| `.studio-v3 .creative-check-result` | studio-cplus.css:2968 | 原地更新（16px/1.75） | 无 | 讨论/工作台 |
| `.studio-v3 .creative-readable-draft` | studio-cplus.css:2938 | 原地更新（16px/1.75） | 无 | 讨论稿 |
| `.studio-v3 .form-error` | styles.css:327（12px #96392f） | 新增 `.studio-v3 .form-error` 覆盖（16px + danger-ink + wrap）；styles.css 原规则保留（auth 页不受益也无害） | 无 | studio 全站；auth 未动 |
| `.studio-v3 .run-live-metrics` | studio-cplus.css:134 | 原地新增 tabular-nums 行 | 无 | 工作台 |
| `.resource-masthead/.configuration-index(-select)` | styles.css:926-937 | studio-cplus.css 末段新块（含 981/980 断点） | 无 | 设置页 |
| M1–M7 动效块 | 部分散落动画（1279/1820 及 reduce 段） | studio-cplus.css 末尾集中「动效语言」段（新声明，未改旧动画，避免波及未审计页） | 无 | `.studio-v3` 作用域 |

未动的历史覆盖（记录）：studio-cplus.css 2886 行前的讨论/工作台旧覆盖保持原样，本轮仅原地修改触及的声明块。

### M1–M7 动效清单

| ID | 事件身份 | 元素/参数 | 重入与卸载 | reduce | 证据 |
| --- | --- | --- | --- | --- | --- |
| M1 | 当前页签 aria-pressed | 页签指示线 scaleX 160ms 反馈曲线 | CSS transition，无定时器 | transition:none | STATIC；真实切换截图 |
| M2 | `stage:draftArtifactId:draftSha256` 变化（首帧不触发） | 光轨 scaleX(0→1)+opacity 420ms 进入曲线；稿件体 Y(8→0) 240ms 延迟 60ms | onAnimationEnd + 700ms 超时双清理；useEffect cleanup | 规则 display:none/animation:none | UNIT studio-motion 7/7；真实交接 NOT_VERIFIED（无真实停点事件） |
| M3 | 挂载后新 message id（首帧历史不触发） | is-new 淡入 Y(6→0) 200ms，前 3 条 stagger 30/60ms | onAnimationEnd 逐条清除 | animation:none | UNIT（面板测试含消息流）；真实到达 NOT_VERIFIED |
| M4 | 用户展开 details | 内容 opacity 140ms（布局原生即时） | CSS both，无泄漏 | animation:none | STATIC+浏览器展开正常 |
| M5 | hover(fine pointer)/active | 卡片 Y(−2px)/scale(.99) | CSS transition | transform:none | STATIC+qa-assets 截图 |
| M6 | `run.videoArtifactId` 出现序列（首帧已有→永不；新到达→loadeddata→一次） | 监看区纸幕 translateX(0→101%) 520ms 进入曲线 | onAnimationEnd+900ms 超时；unmount 清理 timer | display:none | UNIT 4 例 + **真实旧成片不揭幕实测**（run-1278 curtain=false）；真实新片到达 NOT_VERIFIED（不花钱造片） |
| M7 | 用户打开弹窗 | dialog Y(8→0)+backdrop 淡入 180ms | CSS both | animation:none | STATIC；qa-discard-prompt-open 实拍 |

## 5. 检查命令账本（关键条目，完整日志 /tmp/*.log 与文中同名）

| 开始/结束 | cwd | 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 14:2x | repo | `npm run typecheck` | 0 | — | /tmp/ui-tc3.log |
| 15:5x | repo | `npm test`（typecheck→test:ts→test:broker→studio:test→build→test:package） | **0** | TS 1018/0/1skip、broker 0fail、studio vitest+node 全过、build 成功、package 4/4 | /tmp/ui-npm-test.log |
| 16:0x | repo | `git diff --check` | 0 | 通过 | — |
| 过程 | apps/studio | `vitest run test/task-recovery-ui.test.tsx` | 0 | 8/8 | — |
| 过程 | apps/studio | `vitest run test/client.test.tsx` | 0 | 174/174 | — |
| 过程 | apps/studio | `vitest run test/creative-discussion-panel.test.tsx test/dialog-focus.test.tsx test/node-workspace.test.tsx` | 0 | 24/24（dialog-focus 2/2） | — |
| 过程 | apps/studio | `vitest run test/studio-motion.test.tsx` | 0 | 7/7 | — |
| 过程 | apps/studio | `vitest run test/assets-page.test.tsx test/unsplash-attribution.test.tsx` | 0 | 8/8 | — |
| 过程 | apps/studio | `vitest run test/creative-os/production-queue/model-library/resources-manifest` | 0 | 112/112 | — |

早期失败（保留记录）：better-sqlite3 ABI 已于本轮前修复；UI 过程中的 RED 均按「先红后绿」流转；测试中无任何真实模型/媒体调用（fixtures/mock）。

## 6. 截图、录像与浏览器证据

| 文件 | 类型 | URL/状态/runId | viewport | 对应验收 | 观察与限制 |
| --- | --- | --- | --- | --- | --- |
| qa/20260923-ui/before-*.png（workbench/discussion/recovery/newrun/assets/settings/home/projects-1440） | REAL_LOCAL | 各页 | 1440×900 | 基线 | 改造前（HEAD 未变时拍摄） |
| qa-workbench-1440/768/390.png | REAL_LOCAL | run-1278 succeeded | 三尺寸 | AC-14/05 | overflow=0；视频 contain 适配；折叠摘要+展开原文 516 字 |
| qa-discard-prompt-open-1440.png | REAL_LOCAL | 未提交新建表单 | 1440 | AC-08 | 放弃确认弹窗实拍（文案/双按钮） |
| qa-newrun-cost-1440.png | REAL_LOCAL | 未提交新建表单 | 1440 | AC-03 | 分对象费用说明 |
| qa-settings-1440/390.png | REAL_LOCAL | /resources#model-settings | 1440/390 | AC-10 | 目录列/ select 切换 |
| qa-assets-1440.png | REAL_LOCAL | /assets | 1440 | AC-11 | 播放协调实测通过 |
| 动效录像 | — | — | — | AC-15/16 | **缺口**：技能不支持录屏；以 UNIT+STATIC+运行时断言替代，reduce 真实切换 NOT_VERIFIED |

Console：仅 vite 连接 debug、React DevTools info、3 条既有 a11y issue（form field id/name，改造前已存在）。无新增 warning/error。Network：只读 GET（页面/API/媒体），本轮 0 写请求（见第 7 节）。

## 7. 操作与费用账本

| 时间 | 动作 | 真实写/生成 | 费用事实 | 证据 |
| --- | --- | --- | --- | --- |
| 全程 | 页面只读导航/滚动/截图 | 否 | 无 | Network 目视仅 GET |
| 15:5x | 新建表单填写临时标题→误关保护→放弃 | 否（未提交 start） | 无 | 页面实测+截图 |
| 15:5x | run-4399 页面点击「确认当前方案」按钮一次 | **否**（按钮当时 disabled，未发送命令；API 核对 decisions 仍为 09-19 的 1 条） | 无 | decisions 只读核对 |
| 全程 | 素材/成片播放 | 否（播放既有媒体） | 无 | — |

模型/媒体任务新增：0。供应商账单：未独立核验（不写「账单确认 0 元」）。

## 8. 最终结论

- **总体：IMPLEMENTED_WITH_QA_GAPS**。UI-01–UI-08 全部实施；集中回归完整 exit 0；权限内真实本地 QA 完成并留证。
- 修改文件：tracked 14 个（见 `git diff --stat`）+ 新增 `apps/studio/src/client/film-arrival.ts`、`apps/studio/test/dialog-focus.test.tsx`、`apps/studio/test/studio-motion.test.tsx`。
- 环境注记：a) run-4399 在本轮 QA 期间状态已从审计时的 needs_human 变为 failed（非本轮操作，decisions 无新增；疑为服务端原任务观察所致），导致「查看确认定位按钮」与讨论面板的真实渲染无法在该 run 验证；b) 更早的 9/23 凌晨会话遗留的受控 Chrome 已退出，本轮使用新的受控实例。
- 未验证（NOT_VERIFIED）：动效录像与真实 reduce 切换；真实新成片到达（M6 完整链）；真实讨论停点的定位按钮渲染；320/1920 边界截图；完整键盘/读屏走查；真实手机软键盘。
- 明确不做：未新建 run、未发送讨论/确认/重试、未改真实配置、未 commit/push/deploy、未改历史 run 数据。
- 本轮未重新验证生产全链路：**是**。

## 9. Oracle 复审修正（2026-09-23，覆盖以上历史结论）

复审材料为用户授权的 12 个文件；Oracle 使用第 5 档，结论 `CHANGES_REQUIRED`。完整意见保存在本机 `/Users/jinkun.wang/.local/state/oracle-web/sessions/vf-ui-audit-remediation-20260923-02/artifacts/transcript.md`。本轮没有二次送审，也没有真实模型、素材购买、业务提交、commit、push 或部署。

### 修正范围与确定性证据

| 复审项 | 本轮实现 | 当前证据边界 |
| --- | --- | --- |
| UIR-01 手工修订存储失败 | 命令存储写失败不再报告“已保存”；服务器成功但本机清理失败提示独立的完成状态；草稿缓存失败给复制提醒 | `creative-discussion-panel.test.tsx` 聚焦通过；真实禁用存储环境未测 |
| UIR-02 费用语义 | 画面报价、自动按量配音、订阅模型分述；移除“所有后续付费都会再次报价”承诺；费用首部在手机保留，并缩小桌面配音文字避免挤压标题 | 本地 Studio 表单 320/390/1920 CSS 视口实测费用块可见，三宽文档 overflow=0；没有发生付款 |
| UIR-03 单一活动确认与焦点 | 放弃确认保持一个活动 `aria-modal`；背景 `inert`；初焦与 Tab 过滤隐藏祖先、关闭的 `details`，保留 `tabindex=-1` 的显式首焦点 | 新建表单/焦点组件测试通过；完整读屏与真机键盘未测 |
| UIR-04 合法回退 | 回退确认冻结 run/stage/稿件/复核身份；已有复核结果时不误判当前回退过期 | 讨论面板回归通过；真实并发更新未制造 |
| UIR-05 恢复文案 | 本地 running/failed/paused/needs_human 与远端原任务分开陈述，不把本地停止说成原任务取消 | `task-recovery-ui.test.tsx` 覆盖 paused、unknown、成功/失败分支；真实原任务现场未测 |
| UIR-06 三组和非法字段 | 01/02/03 三组；03 含预算，折叠保留 DOM；预算超限展开聚焦；原生必填项在提交前展开所在组并聚焦 | `client.test.tsx` 包含字段/payload、预算、必填、返工/模型覆盖回归；真实提交未做 |
| UIR-07 M6 | ready 绑定 run＋artifact＋媒体源；初始旧片是基线，新片加载后可揭幕；A→B→A 不重播，切 run 重建基线；播放器不换 key | 纯函数及真实 `RunWorkbench` 组件时序测试通过；真实新成片到达未测 |
| UIR-08 M2/M5/M7 | M2 使用实际组件稿件身份与 `stageHandoffIdentityChanged`，快速变化取消旧帧/定时器，动画只作用标题，reduce 保留文字反馈；素材卡有键盘 focus 状态；新建与讨论内确认的关闭有不参与交互/读屏的 120ms 装饰退出层 | M2 组件测试、确认关闭测试、CSS 检查通过；完整对话框种类的退出录像与性能未测 |

本轮仅修改 Studio UI、相关测试及 `DESIGN.md`/本记录；生产管线合同未改。原表中的旧计数、旧 M1–M7 `DONE` 和整项 `PASS` 不适用于本轮。

### 新验证与未通过项

- `npm run typecheck`：exit 0；`npm run build`：exit 0；`npm run test:broker`：265/265，exit 0；Studio `vitest run --reporter=dot`：514/514，exit 0；`npm run test:package` 在构建完成后串行重跑：4/4，exit 0；`git diff --check`：exit 0。
- `npm test` 首次 exit 1：默认 Homebrew Python 3.14 缺少 `Pillow`，真实 Python worker 测试失败。改用仓库 `.venv/bin/python3` 后该 worker 测试 8/8 通过，但 `test:ts` 中未修改的 `production-planning-publication.test.ts` 五个 SIGKILL 窗口案例仍为 0/5；子进程先返回 `run.status=failed`，故未进入预期的 kill 窗口。不能把这个失败归因于 UI，也不能宣称全量通过。
- `npm run studio:test`：Vitest 阶段通过；随后 Node 阶段停在 `text-task-production-recovery.test.ts` 子进程超过 10 分钟、CPU 0，人工中断，exit 130。该阶段无成功退出证据；需单独诊断 Node 26 环境或测试挂起原因。
- 本地只读浏览器：打开既有本地 Studio 表单，核对 320/390/1920 视口下文档横向 overflow 均为 0、费用区 computed `display=grid`；模拟 `prefers-reduced-motion: reduce` 时弹窗 backdrop 的 `animationName=none`。未按“开始前期构思”，未发送业务写请求。表单内出现一段已有未提交文字，未擅自丢弃；检查标签页已保留。
- `NOT_VERIFIED`：真实新稿/新成片到达、完整对话框退出录像、真实恢复现场、完整键盘/读屏、真机软键盘、200% 缩放、生产全链路及供应商账单。窄视口的上述结论只覆盖新建表单，不代表全站所有页面。

### 匹配项目运行时后的集中复验

前述五个规划夹具失败与 Studio Node 挂起的共同环境原因已定位：本机默认 Node 26.8.1 需要原生模块 ABI 147，而现有 `better-sqlite3` 是 ABI 127（Node 22）编译；默认 Python 3.14 又缺 `Pillow`。未重编仓库依赖，也未改产品源码；使用隔离的 `node@22`（22.23.2）和仓库现有 `.venv/bin/python3`（3.12.10）后，SQLite 加载和真实 Python worker 均通过。

最终命令：`npm exec --yes --package=node@22 -- sh -c 'PATH="/Users/jinkun.wang/work_space/veidofactory/.venv/bin:$PATH" npm test'`，**exit 0**，完整经过 typecheck、test:ts、Broker、Studio Vitest/Node、build、package 六阶段。单独可复查的结果：Broker 265/265、Studio Vitest 514/514、package 4/4；此前独立的 `npm run build` 和 `git diff --check` 也均 exit 0。初次 Node 26 下的 exit 1/130 保留为环境诊断历史，**不是最终测试状态**。

**当前状态：`READY_FOR_LOCAL_QA`，尚非最终体验验收。** Oracle 的 UI 修正项已有实现和确定性回归；本地只读检查验证了新建表单费用、320/390/1920 无横向溢出及 reduce 关闭弹窗动画。但真实新稿/新成片到达、完整键盘与读屏、真机软键盘、200% 缩放、所有旧对话框的退出表现仍是 `NOT_VERIFIED`。本轮的 120ms 退出层覆盖新建制作外壳、放弃确认和创作讨论风险确认，不能据此声称全站所有弹窗已逐一验收。未做真实模型、付费、业务写入、commit、push 或部署；Oracle 也未对修复后的版本再次审查。

## 10. Oracle 修正后的真实本地 UI QA（2026-09-23）

已完成安全范围内的浏览器复验，详细步骤、截图、录像、测试退出码、费用动作边界与未验证项见 [LOCAL_QA_RESULT.md](qa/20260923-post-oracle/LOCAL_QA_RESULT.md)。真实 768px 页面发现图标侧栏 6 个链接在文字被隐藏后失去无障碍名称；新增先红后绿的回归断言，并在 `AppShell` 为这些链接补齐 `aria-label` 和悬停 `title`。修正后真实页面 6/6 可读；Studio Vitest 514/514、`typecheck`、`build`、`git diff --check` 在串行条件下均通过。320px 进度标签拥挤列为 P3 观察项。当前状态为 **`LOCAL_QA_PARTIAL_PASS`**，并非真实新稿/新成片或生产全链路验收。
