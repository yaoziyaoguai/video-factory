# 审计材料背景与证据边界

日期：2026-09-23（Asia/Shanghai）。本轮仅 UI/UX 外审与交付实施资料包，不修改产品。

## 当前基线

- repo：`/Users/jinkun.wang/work_space/veidofactory`；branch main；HEAD `7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`。
- 采集开始 tracked 工作树干净；5 组已有 untracked 文档未动。此目录和采集证据是本轮新增。
- 实际页面来自本地 Studio `http://127.0.0.1:4320`（API 4321）；无需输入账号即可读取当前工作区。不是云端验收，不假冒生产构建性能。
- 之前已经有真实可播放首版：run-1278a59f-b336-414e-844e-6a205cd9781d，最新记录 succeeded/revision68/10步完成，33 秒竖屏视频；这不代表内容零缺陷，独立审片意见仍显示“修改后再审”。本轮只读页面，video.readyState=4，不重做这条视频的内容验收。
- 当前生产是单个视觉审片路径，不要求恢复旧双模型生产依赖。UI“独立质量复核”不能改写成两个模型已经审过。

## 采集纪律

使用隔离 Playwright 会话 vfux23。只导航、关闭引导、打开未提交的新建制作、调整 viewport、读取 DOM/CSS 和截图。没有提交新 run、发讨论/重试/确认、调用生成或修改设置。会话采集后已关闭。没有读取 `.env`、凭据、cookie 或生产 dump；截图未见账号/密钥。没有运行产品编译/回归：这是取证阶段，不能报测试通过。

## 产品不变量

1. 每个关键节点停下，用户讨论/编辑/确认后才能往下走。保存不是批准。用户主动权不是“无论缺什么都跳过”。
2. 普通质量意见、低分、未完成审查与真实安全/费用/产物/许可/取证边界区分；可安全推进时让用户接受风险。保留未完成/低分事实，不伪装审查通过。
3. 不改变 source_assets 与 rendered_video 的证据绑定、当前版本、revision/intervention ID 的有效性和幂等约束。
4. 费用估算/授权/消费/未知不同；免费素材优先，不把“仅免费画面”说成整个制作零成本。不改实际收费策略。
5. 模型库接入→角色默认→本片/节点可覆盖，不锁死本次选择。模板仅资料，不重启模板生产。现在首页四入口（热点/系列/想法/案例）都保留。
6. 本轮和此 UI 资料包不授予真实模型/媒体花费、历史 run 修改、commit/push/deploy 权限；需要新的业务验证则报告缺口。

## 截图索引

本轮截图原始目录 `output/playwright/ui-ux-audit-20260923/`，附录脚本将选中的独立文件复制到本包 `evidence/screenshots/`。CURRENT 表示本轮读取当前代码运行页面；不表示每个状态行为已经验证。截图均未经视觉修饰。图片 hash、尺寸、原路径见 evidence/manifest.json。

| 文件 | 页面/状态 | 尺寸/证据级别 | 外审发送 |
|---|---|---|---|
| 00-onboarding-desktop.png | 首页首次引导，未推进生产 | 1440×900 CURRENT | 仅本地补充 |
| 01-home-desktop.png | 四入口、继续工作 | 1440×900 CURRENT | 是 |
| 02-projects-desktop.png | 制作列表，待处理/失败/已完成 | 1440×900 CURRENT | 是 |
| 03-workbench-desktop.png | run-1278 已完成、成片与审片意见 | 1440×900 CURRENT | 是 |
| 04-assets-desktop.png | 8 项素材，索引加载完成后截取 | 1440×900 CURRENT | 是 |
| 05-models-desktop.png | /resources#model-settings | 1440×900 CURRENT | 是 |
| 06-roles-desktop.png | /resources#production-roles | 1440×900 CURRENT | 仅本地补充 |
| 07-home-mobile.png | 首页移动布局 | 390×844 CURRENT | 仅本地补充 |
| 08-workbench-mobile.png | run-1278 成片首屏 | 390×844 CURRENT | 是 |
| 09-models-mobile.png | 模型设置首屏 | 390×844 CURRENT | 是 |
| 10-recovery-desktop.png | run-c769 已失败的当前显示 | 1440×900 CURRENT | 是 |
| 11-new-run-desktop.png | 未填写/未提交新建制作 | 1440×900 CURRENT | 是 |
| 12-new-run-mobile.png | 同一未提交表单手机布局 | 390×844 CURRENT | 是 |
| 13-discussion-desktop.png | run-4399 真实等待前期构思确认 | 1440×900 CURRENT | 是 |
| 14-discussion-mobile.png | 同一停点，当前方案页签 | 390×844 CURRENT | 是 |
| 15-discussion-tablet.png | 同一停点平板双栏 | 768×1024 CURRENT | 仅本地补充 |
| H01-spend-gate.png | 昨日 run-1278 等待费用确认长页 | 原图 full-page HISTORICAL | 是 |
| H02-node-confirm.png | 昨日 run-c769 内容简报确认弹窗 | 原图 full-page HISTORICAL | 是 |

H01 原路径 `.local/dogfood-20260921/qa/20260922/run-1278-awaiting-spend.png`；H02 原路径 `.local/dogfood-20260921/qa/20260922/run-c769-content-brief-confirm-modal.png`。长截图中 fixed header/overlay 的位置可能是 full-page 拼接效果，不能据此断言当前弹窗定位损坏。原文件名带 quote-modal 的另一张实际上是失败恢复页，没有作为费用确认弹窗证据。

## 现场观察（供核查，不预设你的结论）

- 当前已有统一蓝白系、中文本地字体、焦点环、移动底栏。不是“没设计/没有动画”。首页带多个小号注释；新建制作很长，有导演角色、参考视频、声音、画面策略等段落，序号有 02B、03、05，适合检查信息层级而不是删能力。
- 当前桌面讨论界面已经是稿件/讨论双栏，底部有“确认当前方案，继续”；手机已有“当前方案/讨论”切换。不要重复建议“从零增加聊天”。手机首屏确认入口在下方，须判断是否需要更容易找到的动作区，不能凭截屏就说不可操作。
- 成片页正文与长篇审片摘要并置，意见存在 rendered_video、executablePlan 等术语。只可调整摘要与详情层级，不可删除真实风险。
- 失败 run-c769 的当前页面同时有“失败/创作规划没有完成”“模型调用已停止”和“原模型任务仍在处理中”；这是确实观察到的文案张力，但未追踪后台真实任务状态，不能只凭 UI 把后端根因定死。本包可做展示一致性诊断/人话表述；如果需要后端行为改变，要另报范围。
- 模型设置和角色默认说明在当前代码中已存在；深链有 focus outline。不能把无障碍焦点环当作默认视觉 bug 删除。
- 首次快速截图捕捉到有限时长进入动画，后来主截图已在有限动画结束后重拍；没有把半透明过渡帧当最终视觉。
- 1440 的被测页面 document.scrollWidth=1440；390 的成片/模型/讨论页为390；768讨论为768。只证明这些初始画面没有文档水平溢出，不证明所有交互/弹窗/放大。
- 普通设置页观测到 300ms 页面进入、360ms 卡片（0/40/80ms stagger）、220ms 区域显现；reduce 模式下 settings 页面 document.getAnimations()=[]。尚未记录连续动效录像，没有验证所有动效场景的性能。
- 采集窗口 console 只有 React DevTools INFO，未见 warning/error；不是全项目无控制台错误的证明。

## 工程导航与覆盖限制

React19 / Router7 / Vite8 / TS；main.tsx 样式导入依次 styles.css → studio-v3.css → creator-tour.css → auth.css → studio-cplus.css。后者末尾 2886 行之后仍覆盖工作台/讨论/列表/新建表单，必须考虑最后覆盖，不能只看基础 CSS。

完整关键组件与明确范围的摘要见 SOURCE_CONTEXT。RunWorkbench 原文件含一个 NUL 字节，取证文本中用 `[U+0000]` 标识，不修改源码。Graphify 2026-09-22 旧索引仅作导航，未当成当前源码证据。

本轮没有打开热点冷收件箱（读取可能触发后台生成），未提交配置/讨论/人工确认，没有做整个工作流新 E2E，也没有验证登录/未授权、多语言、屏幕阅读器、真实手机虚拟键盘或网络失败分支。相关任务需基于源码和已有确定性测试设计回归，不能标已通过。图中费用仅用于 UI 呈现，不构成本次账单证明。
