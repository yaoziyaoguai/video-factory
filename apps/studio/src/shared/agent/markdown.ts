import type { MarkdownContent, MarkdownSection } from "./generated/contracts.js";

// 分段 Markdown 的唯一文本序列化：渲染、复制、比较、模型读取与生产文本提取共用，
// 不在各消费者再解析 sections。无 sections 的旧稿就是其 text 本身。
export function markdownFullText(content: Pick<MarkdownContent, "text" | "sections" | "narrationText">): string {
  const body = content.sections?.length
    ? [content.text.trim(), ...content.sections.map(section => `## ${section.title}\n\n${section.text.trim()}`)].filter(Boolean).join("\n\n")
    : content.text;
  return content.narrationText === undefined ? body : `${body}\n\n## 旁白原文\n\n${content.narrationText}`;
}

// 方案有逐字旁白时只读该值；独立稿仍按原有完整正文朗读，不把镜头说明送进配音。
export function speechText(content: MarkdownContent): string {
  return content.narrationText ?? markdownFullText(content);
}

// 完整正文＝全局说明＋有序段落；总量边界沿用单一 64000，不变成每段各 64000。
export function markdownTotalLength(content: Pick<MarkdownContent, "text" | "sections" | "narrationText">): number {
  return content.text.length + (content.narrationText?.length ?? 0) + (content.sections ?? []).reduce(
    (sum, section) => sum + section.title.length + section.text.length, 0);
}

export function markdownSectionMap(content: Pick<MarkdownContent, "sections">): Map<string, MarkdownSection> {
  return new Map((content.sections ?? []).map(section => [section.id, section]));
}
