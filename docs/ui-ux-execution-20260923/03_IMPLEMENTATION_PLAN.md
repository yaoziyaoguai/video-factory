# 实施计划：一次实施，集中验收

## 共同执行合同

顺序为 **UI-01 → UI-02 → UI-03 → UI-04 → UI-05 → UI-06 → UI-07 → UI-08**。一个执行agent连续做完，不逐卡等用户、不开逐卡Oracle。每卡先失败测试/前截图，再改实现、跑聚焦检查，在RESULT记证据。已存在的保护测试不能删断言换成快照来“通过”。

修改范围：`apps/studio/src/client/` 的本卡明确模块、对应Studio测试、根 `DESIGN.md` 的实际变更、此包RESULT与QA证据。后端、shared协议、Broker、流水线、付费、Provider、持久化schema不在范围。单纯发现范围外问题先记录；仍可继续独立安全任务，不能暗中扩改。

开始基线：记录 `pwd`、`git branch --show-current`、`git rev-parse HEAD`、`git status --short`、`git diff --stat`；读根DESIGN与当前完整相关源码、现有测试。不reset、不新worktree、不依历史包覆盖代码。若HEAD或文件已变，只重核受影响卡；若另一agent正在改相同文件，先停相关写入并说明冲突。

所有命令在真实仓库运行。聚焦Vitest需已存在pipeline dist，首次执行 `npm run build:pipeline`；若运行中服务使用这些dist，先核实进程，避免在活跃生产任务中重建。命令不得带启用真实E2E的环境变量。

每卡RESULT记录：目标、实际文件/符号、基线失败证据、改后命令/退出码、验收ID、截图/录像、未验证项、范围偏差。测试timeout/输出截断/没有exit code不算通过。共同权限：不commit/push/deploy、不花钱、不提交真实制作动作、不修改历史run或真实配置。服务环境问题不能用fake broker替代。

## UI-01 · 设计基础与样式归属

**用户目标：** 同类标题、说明、控件和焦点一致，正文不靠缩小字号腾空间。

**确认事实：** 已有C+ token/字体；`main.tsx`顺序导入五层CSS；`studio-cplus.css`末段重新覆盖多个本轮页面；现有少数token配对不足小号文字4.5:1。不是从零换皮。

**前置：** 基线完成；保存当前三个尺寸的重点页面前截图，已有截图可复用但标时间。为本轮将改的selector列归属表：原定义、末段覆盖、将保留的位置。

**允许：** `studio-cplus.css`；必要时移除已被本轮替代的 `styles.css/studio-v3.css` 重叠声明；本轮测试；根DESIGN在实现后同步。

**Non-goals：** 不动auth/tour风格，不加CSS框架/新皮肤文件，不机械拆CSS，不全站换字号。

**路径：**

1. 采用设计规格token，新增success/danger文字色与control-border，不改语义色用途。
2. 先落稿件/消息/费用/错误说明字级、44px操作、focus、长文本与min-width保护；避免裸元素全局覆盖。
3. 本轮重复selector合回归属块，记录未动历史覆盖。保留媒体原生controls和无障碍outline。
4. 用当前真实页面对比三尺寸，确认不是靠截断重要文本“变整洁”。

**先建失败证据：** 当前色值计算与对应实际computed style；重点首屏前截图。纯视觉项不伪造单元红灯。焦点隐藏候选风险留UI-03复现。

**聚焦验证：** 仓库根 `npm run typecheck`；`git diff --check`；1440/768/390截图和实际对比测试。不开真实生产命令。

**验收：** AC-13、AC-14、AC-17。**停止条件：** 只有需要改整套CSS加载架构才能实现时先收缩方案，不借此扫全仓库。

## UI-02 · 工作台当前决定、恢复与审片层级

**用户目标：** 一眼知道作品在哪、现在需决定什么、下一步是否重做/可能花费；先看作品再读报告。

**确认事实：** `RunWorkbench`已有`CurrentDecisionBar`、原任务恢复、`decisionSnapshot`、风险/终审/报价不同handler；恢复与失败信息分散；合并及各份审片报告直接展开；费用说明过于笼统。`RunPage`已有序号和runId防过时响应。

**前置：** UI-01；完整读 `RunWorkbench.tsx`（文件含NUL，可用`rg -a`）和`RunPage`相关回调、恢复/风险测试；不得只按本包行号复制。

**允许：** `RunWorkbench.tsx`、必要的局部展示组件、`RunPage.tsx`仅展示接线、对应CSS；`task-recovery-ui.test.tsx`、`client.test.tsx`、`run-observability.test.tsx`、`historical-readonly-ui.test.tsx`。

**Non-goals：** 不重写RunPage轮询/SSE，不新增统一“继续”API，不改变allowedActions、计费或是否需人工确认。

**路径：**

1. 按设计规格状态映射整理当前决定摘要；可以局部纯函数推导文字，但不持久化第二套状态机。
2. 把原任务恢复的状态/时间/查询错误与允许的动作集中。只迁移现有按钮条件和handler，杜绝同一命令两处同时可点。
3. 没有完整费用数据时用限定范围的准确说明并链接现有费用区；别补“所有费用再次授权”的绝对承诺。
4. 真视频为主，右侧先结论/条数/当前产物；长报告分层展开。没有结构化摘要就显示明确标注的原文节选，不新调模型。
5. 制作完成与复核repair分开显示；完整风险逐条表态不减少；source_assets/rendered_video各自身份留在对应面板。
6. 保持播放器节点稳定，不按run.revision换key；给下载等图标明确aria-label。

**必须先红的行为：**

- 同一failed+running原任务场景，首个动作只查询且文字分别说明本地停止/远端未结束；不得显示“远端已取消”。
- accepted_unknown不出现重试/新制作；completed_success只调用一次取回handler，不调用批准handler。
- 成片succeeded但复核repair同时可见，展开能读到全部原意见；当前产物身份改变后旧确认不能放行新产物。
- 画面免费但配音按量时，当前决定不得承诺整条零费用或每笔必定再次确认。

**聚焦命令：**

```sh
cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/task-recovery-ui.test.tsx test/run-observability.test.tsx test/historical-readonly-ui.test.tsx test/client.test.tsx
```

**验收：** AC-01～AC-05、AC-14。**停止条件：** 缺服务端字段无法安全判权限时仅展示“查看处理办法”，记录缺口；不改服务端扩大权限。

## UI-03 · 讨论、确认与输入韧性

**用户目标：** 多轮讨论顺畅、手机能找到确认，误操作和版本更新不丢输入、不确认错版本。

**确认事实：** 已有desktop双栏/mobile切换、draft SHA和review版本、commandId重放、编辑器stale保护；风险与回退用window.confirm；主讨论localStorage部分未捕获异常；focus helper只过滤元素自身aria-hidden。

**前置：** UI-02；全文读 `CreativeDiscussionPanel.tsx`、`useDialogFocus.ts`、相关测试和既有workbench modal用法。

**允许：** 以上两文件，必要的小型局部确认组件、对应CSS；`creative-discussion-panel.test.tsx`、`node-workspace.test.tsx`、`client.test.tsx`。可新增明确标记的新测试 `dialog-focus.test.tsx`。

**Non-goals：** 不重写创意命令协议、不新增聊天后端、不新增统一modal/store框架，不给讨论限定轮数。

**路径：**

1. ≤900采用现有两面板切换；不卸载输入和编辑文档。顶部定位确认入口不发命令；真正批准仍在原footer。
2. 用应用内确认替换风险和回退window.confirm。打开时冻结展示与命令身份，snapshot变化/allowedActions撤销即禁用并提示重新查看；保留所有原acknowledge字段。
3. focus helper排除hidden/inert/aria-hidden祖先、关闭details内容、CSS不可见候选；不要用offsetParent单一判断（fixed元素可能仍可见）。焦点为空时落dialog本身；先focus安全项；关窗回原触发器。
4. 同一时刻只启用一套确认焦点圈。局部组件打开/卸载清理listener/body滚动锁，不使后台可Tab。
5. 按规格处理localStorage不可用：文字内存保留；待发命令读失败或身份写失败都不发出；服务器成功但cleanup失败不报提交失败、不自动重发。沿用原commandId和完成回执逻辑。
6. 新消息只在用户靠近底部时跟随；其余提供查看入口。不要在用户读旧消息时跳屏。

**必须先红的行为：** 旧稿弹窗→rerender新SHA/checkIdentity→点击仍不能提交；关闭/返回/保存/切tab的onCommand不含confirm；输入法Ctrl+Enter不发送；存储get/set/remove分别抛错时语义正确；隐藏首末候选不吞Tab或逃出dialog。jsdom可验证事件/属性，真实可见Tab必须浏览器验证。

**聚焦命令：**

```sh
cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/creative-discussion-panel.test.tsx test/node-workspace.test.tsx test/client.test.tsx
# 新建 dialog-focus.test.tsx 后把它加入同一条聚焦命令；不存在时不假称已运行。
```

**验收：** AC-01、AC-02、AC-05、AC-06、AC-09、AC-13。**停止条件：** 遇命令身份持久化/服务端协议必须改变，保留原安全行为并记录，不以UI便利绕过。

## UI-04 · 新建制作重排、费用说明、误关保护

**用户目标：** 快速表达需求，按需看高级配置；知道开始后先出构思，知道哪些费用可能发生；误关不丢填写。

**确认事实：** 表单混合controlled与FormData字段；现有初始化防异步重置；配音自动计费与图片视频报价分别计算；时长有草稿字符串/失焦校验；参考视频关闭有清理路径；返工已有继承/范围守卫。

**前置：** UI-03的焦点规则；全文读 `NewRunDialog.tsx`，列出**所有原字段→三区/返工前置区**的映射，写入RESULT。

**允许：** `NewRunDialog.tsx`、必要局部presentational提取、CSS、`client.test.tsx`及现有creator-language等相关测试；不得将两千行文件机械拆分为本轮目标。

**Non-goals：** 不删字段、不做跨页wizard/自动云草稿、不改recipe语义、审批策略、上传API或角色路由。

**路径：**

1. 三组disclosure，首组开、高级收起；已有缺能力/校验错误自动展开所属区。保留已选摘要、风险和费用可见。
2. 折叠不卸载表单DOM，不丢FormData字段；校验先展开再focus。所有input的submit行为与原来一致。
3. 头部/提交旁移除“无需现金确认”大承诺，分别显示画面策略、实际voice规则、订阅/未知说明。预算意向明确不授权。
4. 主按钮改“开始前期构思”，payload里的 `creativePlanning/creativeReview/boundaryGates/reviewMode`原值不变；`modelSelections`只传真实override。
5. 集中requestClose。dirty基于用户修改/基线比较，不能把初始化算进去；原dialog内放弃确认，不嵌两套trap。确认放弃才调用清理；提交中/成功/失败分别处理。
6. 返工范围保持置顶与初焦；无效继承仍阻止提交。时长逐键输入45/180不夹取，失焦才校验。

**必须先红的行为：**

- 标题/角度/受众填后折叠、展开、提交仍完整；全字段映射抽测每种controlled/uncontrolled类型。
- Esc、遮罩、X、取消均保护dirty；返回仍有文字/参考视频；放弃只清理一次；未改动可直接关。
- 后台provider/settings更新不重置输入、不误触discard；成功关闭不弹discard，失败不清值。
- 免费画面+计费配音、订阅、缺计费信息三种说明不假报0；缺失字段展开聚焦；默认模型不变显式override。

**聚焦命令：**

```sh
cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/client.test.tsx test/creator-language.test.tsx
```

**验收：** AC-03、AC-07、AC-08、AC-13、AC-14。**停止条件：** 不能证明折叠不丢字段就不交付；不得删掉难归类字段凑简化。

## UI-05 · 首页、制作记录与设置导航

**用户目标：** 能找到开始/继续入口，模型接入与角色默认一眼分清，手机不用越过大统计才能配置。

**确认事实：** 首页四入口；ProjectsPage转发ProductionPage；设置有九hash、missing角色高亮/焦点；模型库已有三组与添加接口，未实测不能称“可用”；首页failed用重来措辞。

**前置：** UI-01/UI-04；读HomePage、ProductionQueue、ResourcesPage、ModelLibrary全文；确认设置表单状态放在哪，不因布局换mount丢输入。

**允许：** 上述四文件、必要的ProductionPage展示、相应CSS；`creative-os.test.tsx`、`production-queue.test.tsx`、`model-library.test.tsx`、`resources-manifest-page.test.tsx`、`client.test.tsx`。

**Non-goals：** 不新增/删除产品入口，不改变search数据源，不清理历史双审记录，不接入新模型协议、不修改真实密钥或配置。

**路径：**

1. failed入口改“查看并继续处理”，详情数据缺失时不推测可恢复；导航不能调用retry/create。
2. 制作列表保留行布局、筛选/搜索；明确加载/空/失败，补拍真正已加载列表。危险操作不增主色权重。
3. 设置概览收成一行，桌面184px目录+正文；手机select替代横滑九项，不做两套同时可操作导航。
4. 九个hash直接打开/刷新/浏览器返回均验证；missing参数与focus不丢；切分区保持未保存配置。
5. 模型首屏呈现三类/添加按钮，三层关系说明沿用既有功能。卡片把协议/能力/配置与实测区别讲清，不发自动能力探测。

**必须先红的行为：** 首页/队列入口点击只有导航；settings每个hash能定位，`?missing=...#production-roles`仍高亮；改未保存值→切区→回来值仍在；“已配置”不渲染成“已实测通过”；模型添加仍单次现有调用（mock），真实QA不保存。

**聚焦命令：**

```sh
cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/creative-os.test.tsx test/production-queue.test.tsx test/model-library.test.tsx test/resources-manifest-page.test.tsx test/client.test.tsx
```

**验收：** AC-10、AC-12、AC-14、AC-17。**停止条件：** 需要动路由/服务层才能改善时先采用不变路由的最小布局，不自行扩展架构。

## UI-06 · 素材预览与可追溯信息

**用户目标：** 一眼看懂素材，主动预览不卡成一堆播放器，来源/许可仍查得到。

**确认事实：** AssetsPage已有按作品/资产、去重、filter、来源/许可；video每卡metadata；Unsplash图片有专用公开URL规则；音频preload none。

**前置：** UI-01；全文读AssetsPage与assets/unsplash测试，确认previewUrl类型，不能将任意URL当poster。

**允许：** `AssetsPage.tsx`、其CSS/必要小预览组件、`assets-page.test.tsx`、`unsplash-attribution.test.tsx`。

**Non-goals：** 不新抓素材、转码、下载封面、不改库索引/许可判定，不造新资产store。

**路径：** 工具栏渐进收起、稳定媒体比例；保持真实预览URL，屏外不强制读取整段媒体；根组件用一个当前播放ref协调video/audio，新播放暂停前一个，不重置时间；错误给占位和原来源，不自动连点重试；许可/作者/限制/复用各保留。

**必须先红的行为：** 播放B暂停A且不重置A.currentTime；切筛选卸载停止旧播放；任何mouseenter不play；Unsplash地址及署名回归不变；缺许可不能显示成已授权，缺时长不显示0秒。

**聚焦命令：**

```sh
cd /Users/jinkun.wang/work_space/veidofactory/apps/studio
npx --no-install vitest run test/assets-page.test.tsx test/unsplash-attribution.test.tsx
```

**验收：** AC-11、AC-14。**停止条件：** 缺poster就保留诚实占位，不为截图好看增加服务端功能或付费请求。

## UI-07 · 真实进展驱动的动效

**用户目标：** 能感知阶段交接、新提案和成片到达；界面有品质和表现力，不烦、不骗、不挡操作。

**确认事实：** 当前已有page/surface/resource进入动画与reduce，需替换/对齐而非叠加；RunPage频繁更新不能作为动画key。

**前置：** UI-02～UI-06布局/行为稳定；完整读涉及现有animation及事件身份。

**允许：** 本轮组件上的事件/类名/refs、小型本地hook（仅有确实复用时）、对应CSS；可新增 `studio-motion.test.tsx`，不是假称已有测试。

**Non-goals：** 不加动效框架、全屏Canvas、网络动画资源、伪进度，不修改产物生成，不自动播放。

**路径：**

1. 逐一实现M1～M7，重点M2/M6。真实身份去重；初始历史加载不当新产物到达。
2. 原动画被替换的声明删除，避免一个节点父子双重进入；不要替换root key或复制DOM来跑动画。
3. rapid update/unmount/reduced-motion清理Animation/timer/observer；装饰不截pointer、不参与读屏。
4. 确定性测试验证触发身份与一次性；组件演示可录模拟到达但必须标COMPONENT，不冒充真实新片。

**必须先红的行为：** 同artifact/draft的10次snapshot更新不重播；初次旧成片不揭幕；新有效artifact仅loadeddata后一次；切run/unmount后无回调；reduce无位移仍有状态；动画中输入与按钮不被禁用/重挂载。

**聚焦命令：** 新建测试后运行 `cd apps/studio && npx --no-install vitest run test/studio-motion.test.tsx test/creative-discussion-panel.test.tsx test/task-recovery-ui.test.tsx`，再按QA手册录真实导航/展开/素材操作与reduce对照。

**验收：** AC-15、AC-16、AC-17。**停止条件：** M2/M6若必须新产物才能真实验证，交组件行为与录像并标真实到达NOT_VERIFIED；不为演示花钱造片。

## UI-08 · 集中回归、真实本地UI QA与交付

**用户目标：** 拿到有证据的实现，而不是“代码改了、编译过了”。

**前置：** 前七卡聚焦通过；所有实际变更审查完；测试中无真模型/媒体命令。确认本机Node/原生依赖匹配，不把SQLite ABI失败归成产品逻辑回归。

**允许：** 范围内缺陷集中修正、确定性测试、根DESIGN同步、RESULT/QA证据。不写范围外补丁。

**路径与命令：**

1. 在仓库根执行 `npm test` 一次集中回归；该脚本当前依次含 typecheck、test:ts、test:broker、studio:test、build、test:package。完整保存日志、各阶段及总exit code，不只tail。若选分命令运行，六项都逐项记录，不能漏项。
2. `git diff --check`；检查实际文件范围、API payload与费用/证据守卫未放宽。说明历史失败/skip是否与本次有关，不能擅自删测试。
3. 按05手册确认本地服务实际加载新构建；复用无活跃任务的真实服务，必要时最小重启仅本地Studio。没有环境启动权限/配置就记录，不读密钥、不用fake broker。
4. 三主尺寸、320/375/1920及200%边界，键盘/存储错误/console、motion录屏和reduce；真实与组件证据分开。
5. UI问题集中修复后重跑影响测试/截图，再跑最终集中回归。相同错误没有新依据不重试。
6. RESULT填满18项验收，每项PASS/FAIL/BLOCKED/NOT_VERIFIED；UI已实施与生产主线未重新E2E分开。完成后停止。

**验收：** AC-01～AC-18。**Non-goals：** 不做新视频制作验收、不部署云端、不代用户授权。**停止条件：** 付费/新run/真实配置或后端修复才能继续的项记清原因；完成其他安全项后交付，不空等或循环点击。
