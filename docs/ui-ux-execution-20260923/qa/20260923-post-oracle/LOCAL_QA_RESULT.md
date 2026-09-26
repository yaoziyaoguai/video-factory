# Oracle 修正后的真实本地 UI QA（2026-09-23）

状态：**LOCAL_QA_PARTIAL_PASS**。安全、可复现的本地 UI 路径通过；发现并修复 1 个 768px 导航无障碍缺陷。真实新稿/新成片到达、真机和完整读屏没有验证，不能据此宣布最终体验或生产全链路验收。

## 环境与动作边界

- 仓库：`/Users/jinkun.wang/work_space/veidofactory`；HEAD `7eb7a84`，本轮保留全部既有未提交修改。
- 使用已有 Vite Studio `127.0.0.1:4320`（PID 50060）及 API `127.0.0.1:4321`（PID 73359）；两端 HTTP 200。浏览器为隔离的本地 Playwright Chromium 会话，页面加载的是当前源码，不是云端发布版。
- 仅导航、筛选、打开/取消未提交表单、读取既有 run 和媒体。未点“开始前期构思”、重试、确认、保存、下载、购买或模型探测。浏览器请求清单中没有 POST/PUT/PATCH/DELETE；本轮未主动发起模型或媒体任务。未独立核对服务商账单，不能将供应商实际费用断言为 ¥0。
- 未 commit、push、部署；没有修改现有 run/设置。新建表单中的临时标题在应用内确认后放弃；没有留下未提交表单。

## 发现与修复

| ID | 结果 | 证据 |
| --- | --- | --- |
| QA-UI-01 · 768px 图标侧栏链接无名称 | **FIXED**。原先 6 个链接的文字在 768px 被 CSS 隐藏，浏览器无障碍树显示为空名称；给主导航每个链接补 `aria-label` 和鼠标悬停 `title`。没有改变目标路由。 | `creative-os.test.tsx` 新断言先失败（首个链接 `aria-label=null`），修正后聚焦测试通过；真实 768px 页面复验 6/6 链接有名称，且隐藏文字仍为 `display:none`。 |
| QA-UI-02 · 320px 五阶段进度标签拥挤 | **OBSERVED / P3**，非本轮阻断。五列标签在 320px 宽度出现逐字换行，但没有横向溢出，阶段和当前状态仍可读。本轮不为一个窄屏边界改动整个进度组件。 | [320px 失败工作台首屏](failed-workbench-320-top.png)；中途滚动截图 `failed-workbench-320.png` 不能充当首屏证据。 |

## 浏览器验证

- 首页、制作记录、素材库、模型设置、既有成片 `run-1278a59f-b336-414e-844e-6a205cd9781d`、失败工作台 `run-c769f8b4-b4e4-4726-a438-07fa3e280cd5`：在 320×700、390×844、768×1024、1920×1080 四组 CSS 视口下，加载后 `documentElement.scrollWidth - clientWidth = 0`。这只证明文档级无横向溢出，不等于所有内部文字都已达到理想排版。
- 新建制作：1440、768、390、320 首屏可见，390/320 费用说明保留；初焦在标题。填临时标题后点关闭，弹出单一活动 `aria-modal`，背景 `inert`；“返回填写”保留输入，“放弃并关闭”清理表单并将焦点还给“新建制作”。无脏数据时 Esc 直接关闭并回焦。连续 Tab 检查未离开弹窗。
- 模型设置：390px 的分区选择进入 `#model-settings`，目录选择可见；桌面选择 `#production-roles` 后焦点留在对应链接。
- 既有成片：视频真实加载、旧片没有触发新片纸幕；审片摘要保留“查看完整结论原文”。这不是新片到达验证。
- `prefers-reduced-motion: reduce`：真实浏览器媒体查询为 true，打开的新建弹窗计算 `animationName=none`、活动动画数为 0。普通与减少动效的导航/筛选路径分别录制 [9.56 秒录像](motion-navigation-normal.webm) 和 [13.16 秒录像](motion-navigation-reduced.webm)；录像不是 M2/M6 新产物事件的证据。
- 干净浏览器会话重开后，Console error/warning 均为 0。并行构建时旧会话曾短暂记录 Vite 对被清理 `dist` 的 404/HMR 错误；串行构建后新会话不再出现，不能将旧历史日志算作产品运行错误。

截图索引：[首页 1440](home-1440.png)、[制作记录 1440](projects-1440.png)、[制作记录 390](projects-390.png)、[新建 1440](newrun-1440.png)、[新建 768](newrun-768.png)、[新建 390](newrun-390.png)、[新建 320](newrun-320.png)、[放弃确认](discard-confirm-1440.png)、[模型设置 390](settings-model-390.png)、[制作分工 1440](settings-roles-1440.png)、[素材库 390](assets-390.png)、[既有成片 390](film-workbench-390.png)、[既有成片 1920](film-workbench-1920.png)、[失败工作台 1440](failed-workbench-1440.png)。

## 确定性回归

- 新导航断言先红：聚焦 Vitest exit 1，证明原缺陷；修正后同命令 exit 0（1 passed）。
- 使用 Node 22.23.1，串行 `npm run typecheck` exit 0；串行 `npm run build` exit 0；Studio `npx --no-install vitest run --reporter=dot` **514/514，exit 0**；`git diff --check` exit 0。
- 失败尝试也保留事实：第一次把上述命令并行执行，共享的 `build:pipeline` 会删除并重建 `dist`，导致 Studio 4 个测试套件暂时无法解析 `production-pipeline` 导入、构建一度报类型错误；串行完整重跑均通过。本轮没有为该工具链竞争修改产品代码。上轮修正后的完整 `npm test` 已是 exit 0；本轮新增导航标签后未再次运行完整 `npm test`，不能把它误写成新的全量证明。

## 尚未验证

- M2 真实新稿交接、M6 真实新成片到达和揭幕；没有为了动画制造付费生产任务。
- 真实 200% 浏览器缩放、iOS/Android 软键盘、安全区、系统字体放大、完整屏幕阅读器操作。CSS 视口模拟不能代替这些实机检查。
- 真实讨论停点的定位/确认、原任务恢复现场、并发更新期间的确认、浏览器存储失败、供应商账单及视频生产全链路。

本轮建议：QA-UI-01 可随当前 UI 修正进入本地审查；QA-UI-02 列为窄屏视觉后续项。其余未验证项待具备自然运行事件或专门设备时再补，不能用组件模拟冒充真实生产证据。
