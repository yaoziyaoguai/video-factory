import { ChevronRight, FileText, Film, Image, AudioLines, Sparkles } from "lucide-react";
import type { ArtifactHead } from "./api.js";
import type { Work } from "../../shared/agent/generated/contracts.js";

export function ArtifactIcon({ kind }: { kind: ArtifactHead["kind"] }) {
  const Icon = kind === "video" ? Film : kind === "image" ? Image : kind === "audio" ? AudioLines : FileText;
  return <Icon aria-hidden="true" />;
}

export const artifactLabel = (kind: ArtifactHead["kind"]) => ({ prompt: "Prompt", script: "脚本", analysis: "分析", storyboard: "分镜", image: "图片", video: "视频", audio: "音频" }[kind] ?? "内容");

const STAGE_OWNED_LABELS: readonly [keyof Work["stages"], string][] = [
  ["content", "内容稿"], ["plan", "画面与声音方案"], ["video", "视频初稿"],
];

// 归属派生标签：被某个创作阶段引用的产物按阶段称呼；其余产物沿用 kind 标签。
// 同一产物先后承担多个阶段时取最新阶段（后面的覆盖前面的）。
export function stageOwnedLabel(works: readonly Work[], artifact: ArtifactHead): string {
  let owned: string | null = null;
  for (const work of works) for (const [stage, label] of STAGE_OWNED_LABELS) {
    const stageView = work.stages[stage];
    for (const source of [stageView.draft, stageView.approved]) {
      if (source?.kind === "artifact_revision" && source.artifactId === artifact.id) owned = label;
    }
  }
  return owned ?? artifactLabel(artifact.kind);
}

export function FrameWelcome({ onChoose }: { onChoose: (text: string) => void }) {
  const examples = ["我想做一条视频，先一起聊聊想法", "帮我写三种不同方向的 Prompt，先不要制作", "聊聊今天感兴趣的事"];
  return <div className="agent-welcome">
    <span className="agent-intro-mark"><Sparkles aria-hidden="true" /></span>
    <span className="agent-eyebrow">从任意一件事开始</span>
    <h2>今天，想一起做些什么？</h2>
    <p>聊想法、看作品、改一改。<br />事情可以一件件来，也可以交错着做。</p>
    <div className="agent-examples">{examples.map(text => <button type="button" key={text} onClick={() => onChoose(text)}><FileText aria-hidden="true" /><span>{text}</span><ChevronRight aria-hidden="true" /></button>)}</div>
  </div>;
}

// 直接沿用已确认原型的空态构图；这是一幅装饰插画，不是生成结果。
export function FrameEmptyPreview() {
  return <div className="agent-empty-workspace">
    <div className="agent-empty-visual" aria-hidden="true">
      <div className="agent-empty-photo back" /><div className="agent-empty-photo middle" />
      <div className="agent-empty-photo front"><svg viewBox="0 0 360 240">
        <rect width="360" height="240" fill="#dbe3df" />
        <path d="M0 174 76 126l45 22 73-68 166 123v37H0Z" fill="#a4b6af" />
        <path d="m0 208 100-42 87 35 81-69 92 48v60H0Z" fill="#768c83" />
        <path d="M0 0h360v240H0Z M75 196h210V62a105 105 0 0 0-210 0Z" fill="#35433d" fillRule="evenodd" />
        <rect x="75" y="196" width="210" height="44" fill="#64776c" />
        <path d="M180 199v41m-80-29h160m-160 16h160" stroke="#aab8b0" opacity=".35" />
      </svg><span>想到哪儿，聊到哪儿。</span></div>
    </div>
    <h2>聊着聊着，作品就有了形状。</h2>
    <p>脚本、分析和不同的作品，都留在这里。</p>
  </div>;
}
