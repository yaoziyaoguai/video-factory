# VideoFactory Light Curated Studio 设计系统

## Product Character

VideoFactory 面向单人创作者。界面以可读稿件、真实素材、声音和成片为主，制作状态与费用记录放在容易查找的位置。用清晰的纸面、栏线和留白组织信息，不让流程图挤占创作内容。

## Experience Principles

1. 先看真实世界，再生成。趋势、分数、成本和表现必须来自证据，或明确显示未配置。
2. 像编辑一样选择。候选不是批量按钮，而是可阅读、可比较、可拒绝的编辑提案。
3. 让声音和素材可感知。选择器优先展示角色、来源、样片和适用场景，而不只是 provider id。
4. 保留人的主编权。Agent 只能提案；入池、Brief、终审和打回原因都是正式决策。
5. 以排版建立秩序。使用刊物式栏线、索引、留白和稳定行列，避免卡片墙和仪表盘堆砌。
6. 诚实呈现每种状态。加载、空、错误、降级、未配置和不可用都是完整的产品界面。

## Selected Direction

采用浅色工作区：稿件易读，素材保留足够的预览尺寸，操作与状态层级明确。页面用细分隔线和留白区分内容，不按制作入口或角色堆叠不同主题。

这个方向称为 Light Curated Studio。它不是营销型画廊，也不是传统后台：真实画面、声音、选题证据和人的判断是视觉主体；导航、状态和 Agent 只提供安静的秩序。设计参考包括 [Runway](https://runwayml.com/product/ai-video-editor) 的媒体工作区、[Frame.io](https://frame.io/creative-management-platform) 的审片清晰度和 [Descript](https://help.descript.com/hc/en-us/articles/37585546799757-The-editor-interface) 的编辑层级。它们只提供产品模式参考，不复制品牌外观。

## Visual Language

```css
:root {
  --canvas: #f3f4f6;
  --paper: #ffffff;
  --paper-soft: #f8f9fb;
  --ink: #252f42;
  --muted: #626c7b;
  --faint: #98a2b3;
  --line: #dcdfe5;
  --line-strong: #cfd7e3;
  --accent: #2c55cc;
  --accent-strong: #2449a6;
  --accent-soft: #eaf0fb;
  --green: #178765;
  --green-soft: #edf8f4;
  --amber: #956515;
  --amber-soft: #fff7e6;
  --red: #c44747;
  --red-soft: #fff1f1;
}
```

- 冷白画布和纯白内容纸面承载工作区；不使用米色、紫色、珊瑚色或深蓝工业主题。
- 深钴蓝是唯一产品强调色，只用于主操作、链接、焦点、当前选择和可编辑状态。普通内容不因为题材、入口或角色不同而获得不同颜色。
- 绿色只表示完成、通过和服务就绪，优先使用小圆点或勾，不制作抢眼的绿色分数胶囊。
- 琥珀色只表示真实的风险、授权待确认、付费前确认和需要人的判断。待处理但无风险的内容保持中性。
- 红色只表示错误、失败、删除和已经进入危险确认的动作。普通“打回修改”默认是中性次级按钮，打开确认后才进入红色语义。
- 分数和内容标签默认使用石墨灰；当前候选可使用细钴蓝边线。素材占位图使用银灰，不用粉红或红色暗示失败。
- 普通面板使用 0-8px 圆角，首页作品与连续入口区可用 10-12px；以细栏线、序号和基线组织信息，不使用渐变、玻璃、光斑、彩色描边或嵌套卡片。

## Typography And Density

- 拉丁与数字正文：bundled `Manrope Variable`。
- 中文正文：bundled `Noto Sans SC Variable`，再回退到 `PingFang SC`。
- 中文标题、作品名和编辑性引语同样使用 `Noto Sans SC Variable`，通过字重、字号和留白建立层级，不用衬线字体制造表面的“艺术感”。
- Identifiers: `SFMono-Regular`, `Menlo`, monospace.
- Page titles stay between 25px and 32px，桌面一级标题默认 600 字重；使用石墨色，标题不靠大面积彩底建立层级。Operational labels start at 12px; ordinary body copy is 14-16px. 稿件和关键后果说明保留16px及舒适行距。
- Letter spacing is never negative. Long Chinese titles wrap; IDs truncate visually inside stable tracks.
- Density comes from hierarchy and alignment, not shrinking text. A desktop registry uses at most three detailed cards per row.
- Font packages are self-hosted by the build; the interface does not depend on a third-party font CDN.

## Information Architecture

| Destination | Job |
| --- | --- |
| Today | Select a verified opportunity, inspect evidence, make the creative decision, start production |
| Projects | Search and filter persisted runs, open production or review |
| Resources | Inspect real provider readiness and strategic gaps in trends/models/generation |
| Experiments | Review persisted production outcomes; disclose that platform performance is unconnected |
| Project detail | Watch video, inspect workflow and grouped artifacts, approve or reject |

## Core Workspaces

### Today Creation Desk

- 首页先展示需要继续的真实作品与下一项决定，制作概况退为辅助摘要；没有媒体不显示假播放预览。
- 初次读取作品时说明等待状态，四种创作入口仍可操作。桌面将作品说明与真实预览并排，手机上下编排；入口区桌面四列、平板两列、手机单列。
- 热点、系列、自主想法、案例/脚本四种入口完整保留，使用简洁入口标题与说明，不以编号、彩色图标底或重复眉题制造视觉噪声。
- 热点入口内仍可查看候选证据、来源、分数口径、受众与成本，不把示意机会当真实推荐。
- 素材库先呈现可播放/可查看的真实素材；来源、署名及授权状态始终可见，规格与标签按需展开。展开详情不触发采购或生成。
- 自主入口使用「写下想法 → 保存创作草稿 → 开始制作」的任务语言；结构化 JSON 导入作为次级入口保留。保存草稿不生成视频、不授权付费。
- 读取已有内容与后台生成分别表述。数量尚未取得时显示占位，成功读取的空结果才显示零；错误仍有明确的重新读取入口。

### Projects

Runs remain rows, not promotional cards. Filters separate all, active, review, and terminal work; title search remains local and deterministic. Each row exposes status, current node, start time, and the next action. Missing thumbnails use silver editorial placeholders; failure is expressed by the status label, not by painting the whole placeholder red.

制作记录使用紧凑统计和纵向作品行；小预览、作品标题、当前状态与下一操作共同出现在首屏，不再用大面积统计卡和占位封面挤走作品。手机转为单列，保留搜索、筛选和归档操作。

### Resources

Strategic resources explicitly report trend ingestion, reasoning/director models, and generative visual models. Service totals are available in a collapsed overview; the default form takes priority. Registries preserve readable names, requirements, provenance, and cost. The provider table is the source of truth for actual node execution and never displays secret values. 能力限制、保存范围及费用后果使用14px正文级别，不能靠小字弱化。

### Series Desk

Series uses a master-detail editorial layout. The current and next episodes take priority; season promise, canon and fixed rules remain available through the season summary. Episode taxonomy and recurring themes are neutral metadata, not orange warnings. A cobalt rule marks the selected episode; fixed rules and actual risks remain semantically distinct.

### Review Workbench

当前阶段的真实产物是主区：前期为可读稿件与讨论，已有成片时才呈现原生视频预览。作品标题、阶段和区域导航在顶部；模型调用和费用明细放在下方可查。讨论版本与稿件身份不混称，不用空播放器或内部进度百分比充当产物。

工作区层级为“当前成果与就近决定、建议与修改、细节与历史”。非阻断建议紧邻讨论输入，缺必需信息和当前风险不因重排而消失。成片优先进入观看区，决定及完成后的交付操作先于长报告；原审计请求及费用待核保留醒目摘要与明细定位，不能把未核费用折叠成已经结清。视频使用深色观看底且不裁剪画面，编辑及确认区域仍为浅色。所有视觉变动保留现有显式签字、版本校验、返工与零重发合同。

桌面稿件区宽于讨论区；1100px及以下通过「当前方案 / 建议与讨论」切换，保留输入与显式确认。建议保留标题和选择状态，依据按条展开；输入与发送先于历史消息，完成请求默认中性折叠，处理或待核原因紧邻发送区，原文与核对入口保留。手动修改保存成功后才标记已保存，服务端换稿后保留旧文字但禁止覆盖新稿。保存、确认采用、费用授权是不同动作；关键后果说明在手机上也不能隐藏。时长摘要仍在脚本采用前可见，逐镜帧数按需展开。

当前稿件支持按真实结构分段阅读，并可随时查看整篇。前期构思使用内容推进、脚本使用段落、导演稿使用镜头；身份不完整或重复时保留整篇，不猜测跨版本对应。阅读切段不改变「指定讨论范围」，换稿或换制作重置阅读位置，普通轮询保留当前选择。没有可信段落归属的审计意见标作「全稿建议」，仍可多选加入意见，并补充自己的要求。

当前稿件的采用、提出修改和后果说明位于正文前；审计与撤销作为次级动作。提出修改只定位讨论框，不发送命令，也不丢弃已勾选建议和输入。段落标记的短过渡可中断，减少动态时立即定位；正文不缩放或飞入。

脚本时长采用紧凑摘要，参考目标、用户明确范围和采用/费用边界常显，帧数与逐镜计算按需展开；旁白正文先于制作参考。加入过的建议在输入旁可见、可移除，不重复插入；用户改写后的文字仍由用户控制。讨论区显示当前稿件及明确选定的范围，阅读切段不暗中改变讨论范围。

改稿差异只比较服务端给出的前后稿：构思使用双侧唯一的 beatId，脚本使用双侧唯一的 id。缺少可靠身份时只提供整篇比较，不按位置猜测；差异不代表所有要求已满足，也不沿用旧审计。处理中、原请求结果未知和确定失败分别表达，结果与费用状态互不推断。

完成页从标题就限定为内部交付，播放器前列发布包与机器复核事实；费用待核仅按已有记录显示，不把外部发布、账单或审片缺口包装成全部完成。返工影响区分当前有效、已失效和新方案后才能确定，不预测镜头复用或价格。确认窗用「先不确认」表达取消，「不同意这条意见」与「接受风险」保持区别，表态在最后确认前只是草稿。

有待讨论稿件时，制作进度默认折叠在区域导航旁，创作目标与受众可展开，优先让正文进入首屏；没有讨论稿件时进度仍展开。稿件与讨论在桌面各自滚动，手动修订入口位于稿件顶部。手机确认区随页面滚动，不用悬浮栏遮挡讨论输入与发送；长讨论记录限高滚动，输入区按内容展开。

新建制作的时长范围、画面要求与证据允许展开填写，折叠不得改变或丢弃字段值；已有值须在摘要中提示。空表单不显示一整块待填写的创作摘要，用户输入后再显示。原模型、声音、预算意向和付费确认边界不变。

新建制作依次展示 01 内容目标、02 画面与声音、03 模型与高级设置。高级设置折叠时保留字段与本片覆盖值；预算输入不合法或必填项遗漏时，展开所在分组并把焦点交给该字段。费用说明分别陈述画面报价、自动按量配音和订阅模型，不把预算意向写成授权，也不承诺所有后续付费都会逐笔弹窗。

动效只提示真实状态变化：讨论稿件只在同一 run 中出现新稿时用当前稿标题和光轨提示，减少动效时仍给出“当前稿件已更新”的文字；成片只在当前产物的媒体数据可播放后揭幕，同一产物不重复。对话框关闭时业务和焦点立即恢复，短暂退出层仅作装饰，不参与交互或读屏。素材卡的键盘聚焦反馈与悬停同样明确。

已有成片时视频优先，复核与局部返工在相邻面板；1100px 以下改为上下布局，避免审片意见横向溢出。复核是建议，用户承担 repair 的入口保留，版本、审计身份及资金权限仍由服务端校验。历史双审只读展示不意味着恢复已退役的生产模型。

「专注观看」将视频与意见改为上下编排，不进入假全屏，不隐藏费用待核、风险或用户决定。同一播放器保留进度、字幕与播放状态；Esc 退出并恢复操作焦点，打开弹窗时由弹窗优先处理 Esc。换制作或媒体身份后退出专注，不把上一版状态继承给新媒体。

声音规划与时间调整沿用现有字体、纸面和钴蓝变量。生成前保存不推进；生成后调整成功回试听。旧来源、待确认请求和未保存草稿分别说明，换源或关闭不能悄悄丢失编辑内容。含运行现场信息的验证证据留在本地，不随公开仓库发布。

## Responsive Rules

- `>=1201px`：216px完整侧栏。稿件与讨论双栏，视频与相关决定并排；内容区域按可用宽度编排，不强制所有页面三栏。
- `701-1200px`：76px图标侧栏，各入口保留名称提示及可访问名称；内容根据实际宽度转为单栏。
- `<=700px`：置顶品牌栏和固定五项底部导航；三步状态并排可见，编辑提案、声音角色和 Provider 台账转为单栏，弹窗成为全宽 sheet。
- Required viewport checks: 390x844, 768x1024, 1440x900, 1920x1080.
- Route changes reset document scroll. No page may create document-level horizontal overflow.
- Visual acceptance requires real screenshots at desktop and mobile widths, plus a console warning/error sweep. Tablet-specific polish is not part of the current release, but layouts must remain usable without overflow.

共享外框由`studio-foundation.css`维护，首页/素材库由`studio-library.css`维护，制作工作区由`studio-workspace.css`维护；在旧基础样式之后导入，新增改动按所属区域集中维护，不在页面中加入独立主题或新字体依赖。全局导航不重复展示日期宣言，工具栏标明当前位置，搜索和帮助保持可达。动效用于进入、操作反馈、换稿与真实媒体到达，不模拟进度，减少动效设置下保留文字反馈。

保存想法或采用候选后的下一步绑定刚完成的真实对象，不因当前选择变化而打开另一条稿件；继续制作准备不等于生成或费用授权。素材来源与提供方筛选可折叠，但生效条件在外部可清除，授权摘要不能随之隐藏。手机创作设置先呈现可编辑默认值，完整服务状态和计费说明仍位于保存操作之前；云端配音配置存在不等于真实调用、余额或额度已验证。

## Interaction And Accessibility

- Lucide icons only; every icon-only command has a tooltip/accessibility name.
- Native form labels, video controls, links, buttons, tables, and dialog roles remain intact.
- Status always uses icon, text, and color.
- Dialogs close with Escape and prevent background scrolling.
- 确认窗口整体受动态视口高度约束；长意见在正文内滚动，标题、关闭和底部动作保留可达。初始焦点须在屏内，关闭后返回触发入口。
- Rejection requires a concrete note; approval is explicit.
- Motion respects `prefers-reduced-motion`.

## Anti-Patterns

- No fake trend, cost, account, collaborator, or performance values.
- No dark industrial side rail or default workflow canvas; the product opens on the editorial decision that needs attention.
- No marketing hero, feature explanation wall, decorative chart, card mosaic, or AI-themed ornament.
- No three-column marketing feature cards, decorative colored left borders, or colored icon bubbles; color must communicate selection, state, or risk.
- No dark section headers or near-black action buttons outside the video monitor; editorial and configuration surfaces stay light.
- No orange/coral category labels, red ordinary metadata, green score pills, pink missing-media placeholders, or purple page outlines.
- No multiple competing primary buttons in one decision area. One decision has one cobalt primary action; alternatives are neutral until their semantic state changes.
- No hidden provider substitution and no automatic external publishing in the current release.
