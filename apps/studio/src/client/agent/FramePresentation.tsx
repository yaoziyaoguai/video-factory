import { ChevronRight, FileText, Film, Image, AudioLines, Sparkles } from "lucide-react";
import type { ArtifactHead } from "./api.js";
import type { Work } from "../../shared/agent/generated/contracts.js";

export function ArtifactIcon({ kind }: { kind: ArtifactHead["kind"] }) {
  const Icon = kind === "video" ? Film : kind === "image" ? Image : kind === "audio" ? AudioLines : FileText;
  return <Icon aria-hidden="true" />;
}

export const artifactLabel = (kind: ArtifactHead["kind"]) => ({ prompt: "Prompt", script: "脚本", analysis: "分析", storyboard: "分镜", image: "图片", video: "视频", audio: "音频", project: "工程", file: "文件" }[kind] ?? "内容");

export const REVIEW_ROLE_LABELS = {
  content: "内容", plan: "方案", character: "角色", scene: "场景", storyboard: "分镜",
  voice: "配音", music: "音乐", clip: "片段", video: "成片", subtitle: "字幕", other: "素材",
} as const;

// 归属派生标签：被某个审阅事项引用的产物按角色称呼；其余产物沿用 kind 标签。
// 同一产物先后承担多个角色时取最新归属（后面的覆盖前面的）。
export function stageOwnedLabel(works: readonly Work[], artifact: ArtifactHead): string {
  let owned: string | null = null;
  for (const work of works) for (const group of work.reviewGroups) for (const item of group.items) {
    for (const source of [item.draft, item.approved]) {
      if (source?.kind === "artifact_revision" && source.artifactId === artifact.id) owned = REVIEW_ROLE_LABELS[item.role];
    }
  }
  return owned ?? artifactLabel(artifact.kind);
}

export function FrameWelcome({ simulated = false, onChoose }: { simulated?: boolean; onChoose: (text: string) => void }) {
  // 离线替身装配把演示口令放进首屏示例，开箱即可建立多作品总览；在线装配不受影响。
  const examples = [...(simulated ? ["演示多作品总览与审片工作台"] : []),
    "我想做一条视频，先一起聊聊想法", "帮我写三种不同方向的 Prompt，先不要制作", "聊聊今天感兴趣的事"];
  return <div className="agent-welcome">
    <span className="agent-intro-mark"><Sparkles aria-hidden="true" /></span>
    <span className="agent-eyebrow">FRAME STUDIO · 创作对话</span>
    <h2>今天，想一起做些什么？</h2>
    <p>聊想法、看作品、改一改。<br />事情可以一件件来，也可以交错着做。</p>
    <div className="agent-examples">{examples.map((text, index) => <button type="button" key={text} onClick={() => onChoose(text)}>
      <span className="agent-example-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <span>{text}</span><ChevronRight aria-hidden="true" />
    </button>)}</div>
  </div>;
}

// 空态是编辑部接触印相单：三帧分别隐喻"脚本结构线 → 画面构图景别 → 时间线声画成片"。
// 纯装饰 SVG（≤35 节点、零位图），点阵与图注排版由 CSS 承担。
export function FrameEmptyPreview() {
  return <div className="agent-empty-workspace">
    <div className="agent-empty-visual" aria-hidden="true">
      <svg className="agent-contact-sheet" viewBox="0 0 360 118">
        <rect className="sheet-base" x="2" y="2" width="356" height="114" rx="10" />
        <g className="sheet-frame">
          <rect x="16" y="16" width="100" height="56" rx="3" />
          <path className="sheet-glyph" d="M26 30h80M26 42h62M26 54h70" />
          <text x="16" y="86">FRAME 01A</text>
        </g>
        <g className="sheet-frame">
          <rect x="130" y="16" width="100" height="56" rx="3" />
          <path className="sheet-glyph" d="M130 54h100" />
          <circle className="sheet-glyph" cx="208" cy="30" r="5" />
          <rect className="sheet-subject" x="150" y="34" width="24" height="16" rx="2" />
          <text x="130" y="86">FRAME 02A</text>
        </g>
        <g className="sheet-frame">
          <rect x="244" y="16" width="100" height="56" rx="3" />
          <path className="sheet-glyph" d="M254 56V40h8v16h8V30h8v26h8V44h8v12h8V28h8v28h8V42h8v14h8V34h8v22" />
          <text x="244" y="86">FRAME 03A</text>
        </g>
        <path className="sheet-mark" d="M14 8v12M8 14h12M346 8v12M340 14h12M14 98v12M8 104h12M346 98v12M340 104h12" />
        {/* B13-POLISH-06 胶片齿孔：单条 path 双子路径 + dasharray 零 DOM 成本还原片基穿孔。 */}
        <path className="sheet-sprocket" d="M28 8h304M28 110h304" strokeDasharray="7 9" />
      </svg>
    </div>
    <span className="agent-empty-divider" aria-hidden="true" />
    <h2>聊着聊着，作品就有了形状。</h2>
    <p>脚本、分析和不同的作品，都留在这里。</p>
  </div>;
}
