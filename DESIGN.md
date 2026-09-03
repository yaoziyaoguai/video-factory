# VideoFactory Light Curated Studio 设计系统

## Product Character

VideoFactory 是为单人创作者设计的 Light Curated Studio。产品气质来自电影刊物、当代剪辑台和中文内容编辑室：清晰的纸面、明确的编排、可触摸的真实素材与声音选择，同时保留工业系统所需的证据、状态和审计能力。

它不是营销页、通用节点编辑器，也不是 AI 玩具。热点证据、选题判断、声音角色、画面来源、成片和人的最终决定才是视觉中心。工作流存在于产品结构中，不把用户包围在“流水线仪表盘”的视觉语言里。

## Experience Principles

1. 先看真实世界，再生成。趋势、分数、成本和表现必须来自证据，或明确显示未配置。
2. 像编辑一样选择。候选不是批量按钮，而是可阅读、可比较、可拒绝的编辑提案。
3. 让声音和素材可感知。选择器优先展示角色、来源、样片和适用场景，而不只是 provider id。
4. 保留人的主编权。Agent 只能提案；入池、Brief、终审和打回原因都是正式决策。
5. 以排版建立秩序。使用刊物式栏线、索引、留白和稳定行列，避免卡片墙和仪表盘堆砌。
6. 诚实呈现每种状态。加载、空、错误、降级、未配置和不可用都是完整的产品界面。

## Selected Direction

本轮先比较了 Soft Editorial Atelier、Luminous Media Studio 和 Curated Gallery Grid。最终由用户确认采用 C+：保留 Luminous Media Studio 清晰、可操作的生产结构，吸收 Curated Gallery Grid 的开放排版、素材尺度、细分隔线和画廊式留白。

这个方向称为 Light Curated Studio。它不是营销型画廊，也不是传统后台：真实画面、声音、选题证据和人的判断是视觉主体；导航、状态和 Agent 只提供安静的秩序。设计参考包括 [Runway](https://runwayml.com/product/ai-video-editor) 的媒体工作区、[Frame.io](https://frame.io/creative-management-platform) 的审片清晰度和 [Descript](https://help.descript.com/hc/en-us/articles/37585546799757-The-editor-interface) 的编辑层级。它们只提供产品模式参考，不复制品牌外观。

## Visual Language

```css
:root {
  --canvas: #f5f7fa;
  --paper: #ffffff;
  --paper-soft: #f8fafc;
  --ink: #273247;
  --muted: #667085;
  --faint: #98a2b3;
  --line: #e1e6ed;
  --line-strong: #cfd7e3;
  --accent: #0f5cf6;
  --accent-strong: #0948c8;
  --accent-soft: #edf4ff;
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
- 面板使用 0-8px 圆角，以细栏线、序号和基线组织信息；不使用渐变、玻璃、光斑、彩色描边或嵌套卡片。

## Typography And Density

- 拉丁与数字正文：bundled `Manrope Variable`。
- 中文正文：bundled `Noto Sans SC Variable`，再回退到 `PingFang SC`。
- 中文标题、作品名和编辑性引语同样使用 `Noto Sans SC Variable`，通过字重、字号和留白建立层级，不用衬线字体制造表面的“艺术感”。
- Identifiers: `SFMono-Regular`, `Menlo`, monospace.
- Page titles stay between 23px and 29px，桌面一级标题默认 520 字重；使用柔和石墨蓝，不用大号粗黑字模拟文档标题。Operational labels start at 12px; ordinary body copy is 13-15px.
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

- Left: ordered opportunity radar with status, freshness, score provenance, and evidence count. Scores remain neutral numerals; selection is shown by a cobalt rule instead of traffic-light pills.
- Center: selected opportunity, dimension scores, scoring source/time, hook stage, real visual candidates, and traceable evidence links.
- Right: audience/platform/series, required provider readiness, honest AI director state, and production action.
- Active production appears as a compact strip above the workspace.
- No opportunity produces a designed `趋势源尚未配置` state, not synthetic recommendations.

### Projects

Runs remain rows, not promotional cards. Filters separate all, active, review, and terminal work; title search remains local and deterministic. Each row exposes status, current node, start time, and the next action. Missing thumbnails use silver editorial placeholders; failure is expressed by the status label, not by painting the whole placeholder red.

### Resources

Strategic resources explicitly report trend ingestion, reasoning/director models, and generative visual models. A compact pulse row summarizes readiness, while three-column registries preserve readable names, requirements, provenance, and cost. The provider table is the source of truth for actual node execution and never displays secret values.

### Series Desk

Series uses a master-detail editorial layout. Season promise, canon, completed episodes and next episode remain visible together. Episode taxonomy and recurring themes are neutral metadata, not orange warnings. A cobalt rule marks the selected episode; fixed rules and actual risks remain semantically distinct.

### Review Workbench

The 9:16 native video monitor is the primary surface. Workflow status remains above it; the sticky review panel keeps approval/rejection and artifacts together. Artifacts are grouped by producer node so the reviewer can reconstruct the production evidence. Review metrics are neutral data; approval is the single cobalt primary action; rejection stays neutral until the user enters a destructive confirmation.

## Responsive Rules

- `>=1361px`：完整 Light Curated Studio 侧栏，主要工作区使用稳定三栏编排。
- `901-1360px`：图标侧栏，选题/焦点二栏，导演控制下移。
- `701-900px`：图标侧栏，主要工作区单栏，机会列表横向浏览。
- `<=700px`：置顶品牌栏和固定五项底部导航；三步状态并排可见，编辑提案、声音角色和 Provider 台账转为单栏，弹窗成为全宽 sheet。
- Required viewport checks: 390x844, 768x1024, 1440x900, 1920x1080.
- Route changes reset document scroll. No page may create document-level horizontal overflow.
- Visual acceptance requires real screenshots at desktop and mobile widths, plus a console warning/error sweep. Tablet-specific polish is not part of the current release, but layouts must remain usable without overflow.

## Interaction And Accessibility

- Lucide icons only; every icon-only command has a tooltip/accessibility name.
- Native form labels, video controls, links, buttons, tables, and dialog roles remain intact.
- Status always uses icon, text, and color.
- Dialogs close with Escape and prevent background scrolling.
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
