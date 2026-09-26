# 源码与检查导航

基于 `main / 7eb7a84e56ebadeac4ffd774c427029fb9cc15a6`。路径相对 `/Users/jinkun.wang/work_space/veidofactory`。行号会随实施变化，**以符号和当前完整上下文为准**。本表是导航，不是替代读源码。

## 页面与关键合同

| 文件 | 当前锚点 | 用途/特别注意 |
| --- | --- | --- |
| `DESIGN.md` | Light Curated Studio / Review Workbench | 已确认风格、移动确认随页滚动、历史双审只读 |
| `apps/studio/src/client/main.tsx` | 8–12行CSS导入 | 不再追加新皮肤；真实字体本地打包 |
| `apps/studio/src/client/App.tsx` | App路由 | 保留热点/案例/项目/素材/模板/设置/复盘 |
| `apps/studio/src/client/components/AppShell.tsx` | AppShell、Search | header/mobile nav、搜索焦点与路由滚动；主要做回归，不扩search后端 |
| `apps/studio/src/client/pages/HomePage.tsx` | `continueAction:106`、`continueMessage:116` | 四入口和继续任务措辞 |
| `apps/studio/src/client/pages/ProductionPage.tsx` | ProductionPage | providers/settings/run加载，新建与归档接线；settings失败不应静默默认 |
| `apps/studio/src/client/pages/ProjectsPage.tsx` | re-export | 不要在这个壳里另写制作列表 |
| `apps/studio/src/client/components/ProductionQueue.tsx` | `ProductionQueue:22`、`runAction:256` | 列表filter、loading/empty/error、操作语义 |
| `apps/studio/src/client/pages/RunPage.tsx` | `preferRunSnapshot:13`、`RunPage:53` | 过时响应防护/状态回调，不为动画重写 |
| `apps/studio/src/client/components/RunWorkbench.tsx` | `decisionSnapshot:54`、taskRecovery:130、review:311、retry:608、`CurrentDecisionBar:1563` | 原任务恢复、风险确认/费用/产物身份；文件含NUL，搜索用`rg -a`，别为本轮顺手全文件格式化 |
| `apps/studio/src/client/components/CreativeDiscussionPanel.tsx` | component:15、storage:20、`confirmDraft:86`、footer:242、`readPendingCommand:277`、editor:326 | 多轮讨论、版本、幂等、stale、原生确认；必须全文读 |
| `apps/studio/src/client/hooks/useDialogFocus.ts` | `useDialogFocus:12` | Tab/Esc/body锁/回焦；可见候选需专项测试 |
| `apps/studio/src/client/components/NewRunDialog.tsx` | component:111、计费:208、初始化:326、FormData:567、头部:678、费用:1240、footer:1253 | 全字段映射、误关、引用上传cleanup、返工、时长草稿；必须全文读 |
| `apps/studio/src/client/pages/ResourcesPage.tsx` | component:113、hash/focus:160、`showSection:190`、布局:323 | 九分区、missing深链、各配置表单状态与保存保持 |
| `apps/studio/src/client/components/ModelLibrary.tsx` | `modelLibraryItems:13`、component:45、form:96 | 三能力分组、协议/自定义模型、添加不调用模型 |
| `apps/studio/src/client/pages/AssetsPage.tsx` | component:34、`AssetCard:220`、`AssetPreview:244` | 分组/去重/来源/署名、video/audio/image读取，不新增资产后端 |
| `apps/studio/src/client/studio-cplus.css` | 2886后工作台等再覆盖；motion约1279/1820及多个reduce段 | 要看全部相关selector/断点；本轮合并覆盖，不加第四皮肤 |
| `apps/studio/src/shared/api.ts` | 各StudioRun/CreativeReview输入输出类型 | **只读合同**，本轮不扩协议 |

## 已存在测试

以下均已核实存在，集中UI测试只自动发现 `test/**/*.test.tsx`；Node `.test.ts` 由Studio package script显式列举。不要以文件后缀混用runner。

| 现有路径（均 `apps/studio/test/`） | 主要保护 |
| --- | --- |
| `client.test.tsx` | NewRunDialog大量字段、时长/返工/计费、确认/逐条表态、Resources等 |
| `creative-discussion-panel.test.tsx` | discuss/confirm/edit、稿件身份、幂等与文本保留 |
| `node-workspace.test.tsx` | 节点输入/交付/模型配置与显式保存 |
| `task-recovery-ui.test.tsx` | 原任务running/unknown/success/failure、允许的恢复动作 |
| `run-observability.test.tsx` | 状态/进度/调用呈现 |
| `historical-readonly-ui.test.tsx` | 旧生产记录不重入已退役流程 |
| `creative-os.test.tsx` | 创作入口、组件/设置等既有交互 |
| `creator-language.test.tsx` | 面向创作者的文案 |
| `production-queue.test.tsx` | 制作列表与失败后入口 |
| `model-library.test.tsx` | 多角色同模型去重、三层接入、保存一次、不自动付费测 |
| `resources-manifest-page.test.tsx` | 来源与授权分区 |
| `assets-page.test.tsx` / `unsplash-attribution.test.tsx` | 素材分组、来源、图片URL/署名 |
| `auth-gate.test.tsx` / `creator-tour.test.tsx` / `cases-page.test.tsx` / `templates-page.test.tsx` | 共享样式修改的旁页回归 |

计划允许新增 `dialog-focus.test.tsx`、`studio-motion.test.tsx`；**资料包制作时它们尚不是已存在的产品测试**。不允许只按文件名打勾。

## 命令（当前package script已核实）

```sh
cd /Users/jinkun.wang/work_space/veidofactory
git status --short
git rev-parse HEAD
npm run build:pipeline

cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/creative-discussion-panel.test.tsx

cd /Users/jinkun.wang/work_space/veidofactory
npm test
git diff --check
```

首次pipeline构建是聚焦测试前置；启动着使用dist的真实服务时先核活动任务。`npm test`目前串行调用 `typecheck → test:ts → test:broker → studio:test → build → test:package`。可以分开定位失败，但最终每段真实退出状态要齐全，不以通过某一段冒充全量。

`npm run studio:build` 包含pipeline构建和Studio构建；root `npm run build` 还构建Broker。`npm run test:e2e` 会启用真实生成测试，本轮不要执行。

环境：`apps/studio/vite.config.ts`默认web4317、API4318，支持当前项目定义的端口变量；本轮页面曾在4320/4321。不要把旧PID/端口当成当前事实。`apps/studio/vitest.config.ts`为jsdom，不能用它证明真实布局、视频解码、软键盘或动画流畅。

## 原始取证

- [manifest](../ui-ux-oracle-20260923/evidence/manifest.json)：23个源文件SHA与截图尺寸/hash。
- [证据上下文](../ui-ux-oracle-20260923/EVIDENCE_CONTEXT.md)：原采集范围。
- [源码取证文本](../ui-ux-oracle-20260923/SOURCE_CONTEXT.md)：标注完整/摘录与省略范围，约485KB；**无需为了交接重复吞整份文本**，改哪个组件就读磁盘当前全文和调用合同。
- [原咨询记录](../ui-ux-oracle-20260923/README.md)：只用于证明Oracle未完成，不是当前实施指令。不要运行里面的Oracle重发脚本。

旧Graphify索引只作导航，没有更新它或把其边关系当作当前源码事实。上述路径不存在/符号变动时先检查HEAD/工作树，不自动新建同名替代文件。
