# VideoFactory Creator Canvas 设计系统

## Product Character

VideoFactory 是为单人创作者设计的 Creator Canvas。产品气质来自电影刊物、当代剪辑台和中文内容编辑室：清晰的纸面、明确的编排、可触摸的真实素材与声音选择，同时保留工业系统所需的证据、状态和审计能力。

它不是营销页、通用节点编辑器，也不是 AI 玩具。热点证据、选题判断、声音角色、画面来源、成片和人的最终决定才是视觉中心。工作流存在于产品结构中，不把用户包围在“流水线仪表盘”的视觉语言里。

## Experience Principles

1. 先看真实世界，再生成。趋势、分数、成本和表现必须来自证据，或明确显示未配置。
2. 像编辑一样选择。候选不是批量按钮，而是可阅读、可比较、可拒绝的编辑提案。
3. 让声音和素材可感知。选择器优先展示角色、来源、样片和适用场景，而不只是 provider id。
4. 保留人的主编权。Agent 只能提案；入池、Brief、终审和打回原因都是正式决策。
5. 以排版建立秩序。使用刊物式栏线、索引、留白和稳定行列，避免卡片墙和仪表盘堆砌。
6. 诚实呈现每种状态。加载、空、错误、降级、未配置和不可用都是完整的产品界面。

## Selected Direction

本轮比较了三个可实施方向：

| 方向 | 日常决策效率 | 素材表现力 | 移动体验 | 扩展性 | 总分 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Creator Canvas | 24/25 | 24/25 | 23/25 | 21/25 | 92/100 |
| Editorial Desk | 23/25 | 18/25 | 21/25 | 22/25 | 84/100 |
| Cinematic Control Room | 19/25 | 24/25 | 16/25 | 21/25 | 80/100 |

Creator Canvas 被选中：采用 [Runway](https://runwayml.com/product/ai-video-editor) 的媒体与模型工作区思路、[Frame.io](https://frame.io/creative-management-platform) 的审片状态清晰度、[Descript](https://help.descript.com/hc/en-us/articles/37585546799757-The-editor-interface) 的编辑层级，以及 [CapCut](https://www.capcut.com/resource/pc-professional-video-editor) 的可见素材和移动创作密度。它们是设计参考，不复制品牌外观。

## Visual Language

```css
:root {
  --canvas: #f6f6f3;
  --paper: #ffffff;
  --paper-soft: #f0f1ed;
  --ink: #181816;
  --muted: #656760;
  --line: #e3e3de;
  --accent: #ef5b3f;
  --yellow: #e7bd3f;
  --blue: #2e5ee8;
  --green: #217a55;
}
```

- 中性浅灰承载工作区，白色是内容纸面，避免整页米色或单一冷色主题。
- 珊瑚红标记品牌和创意重点；钴蓝用于主动作和当前选择；绿色用于已验证能力。
- 黄色只用于成本或需要注意的配置，不承担大面积装饰。
- 面板使用 0-6px 圆角，以细栏线、序号和基线组织信息；不使用渐变、玻璃、光斑或嵌套卡片。

## Typography And Density

- 拉丁与数字正文：bundled `Manrope Variable`。
- 中文正文：bundled `Noto Sans SC Variable`，再回退到 `PingFang SC`。
- 中文标题与编辑性引语：bundled `Noto Serif SC Variable`。
- Identifiers: `SFMono-Regular`, `Menlo`, monospace.
- Page titles stay between 23px and 38px. Operational labels start at 12px; ordinary body copy is 13-15px.
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

### Today Creator Canvas

- Left: ordered opportunity radar with status, freshness, score provenance, and evidence count.
- Center: selected opportunity, dimension scores, scoring source/time, hook stage, real visual candidates, and traceable evidence links.
- Right: audience/platform/series, required provider readiness, honest AI director state, and production action.
- Active production appears as a compact strip above the workspace.
- No opportunity produces a designed `趋势源尚未配置` state, not synthetic recommendations.

### Projects

Runs remain rows, not promotional cards. Filters separate all, active, review, and terminal work; title search remains local and deterministic. Each row exposes status, current node, start time, and the next action.

### Resources

Strategic resources explicitly report trend ingestion, reasoning/director models, and generative visual models. A compact pulse row summarizes readiness, while three-column registries preserve readable names, requirements, provenance, and cost. The provider table is the source of truth for actual node execution and never displays secret values.

### Review Workbench

The 9:16 native video monitor is the primary surface. Workflow status remains above it; the sticky review panel keeps approval/rejection and artifacts together. Artifacts are grouped by producer node so the reviewer can reconstruct the production evidence.

## Responsive Rules

- `>=1361px`：完整 Creator Studio 侧栏，主要工作区使用稳定三栏编排。
- `901-1360px`：图标侧栏，选题/焦点二栏，导演控制下移。
- `701-900px`：图标侧栏，主要工作区单栏，机会列表横向浏览。
- `<=700px`：置顶品牌栏和固定四项底部导航；三步状态并排可见，编辑提案、声音角色和 Provider 台账转为单栏，弹窗成为全宽 sheet。
- 旧版基础组件还在 `1180/980/920/760/410px` 处理队列、表单和超窄屏细节；它们是组件级约束，不改变上述 Creator Canvas 主断点。
- Required viewport checks: 390x844, 768x1024, 1440x900, 1920x1080.
- Route changes reset document scroll. No page may create document-level horizontal overflow.
- Visual acceptance requires real screenshots at desktop and mobile widths, plus a console warning/error sweep.

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
- No hidden provider substitution and no automatic external publishing in the current release.
