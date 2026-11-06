import { Fragment, type ReactNode } from "react";
import type { MarkdownContent } from "../../shared/agent/generated/contracts.js";

// 极小 Markdown 渲染：只输出 React 文本节点，不经过 innerHTML，结构上排除脚本注入。
// 支持：标题、无序/有序列表、围栏代码、粗体、行内代码、管道表格、安全链接与图片。

const SAFE_LINK = /^https?:\/\//i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s）)】\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index}`;
    index += 1;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("![")) {
      const imageMatch = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      // 图片只走白名单协议直链，不承载任何脚本能力。
      if (imageMatch && SAFE_LINK.test(imageMatch[2]!)) {
        nodes.push(<img key={key} src={imageMatch[2]} alt={imageMatch[1]!} loading="lazy" />);
      } else if (imageMatch) {
        nodes.push(imageMatch[1]!);
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch?.[2] ?? "";
      if (linkMatch && SAFE_LINK.test(href)) {
        nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
      } else {
        nodes.push(label);
      }
    } else if (SAFE_LINK.test(token)) {
      nodes.push(<a key={key} href={token} target="_blank" rel="noreferrer noopener">{token}</a>);
    } else {
      nodes.push(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

interface Block {
  kind: "p" | "h" | "ul" | "ol" | "pre" | "table";
  level?: number;
  lines: string[];
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line: string) => /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(line);
const splitRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    // 管道表格：表头 + 分隔行 + 若干数据行；分隔行不进渲染数据。
    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1]!)) {
      const rows: string[] = [line];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(lines[index]!);
        index += 1;
      }
      blocks.push({ kind: "table", lines: rows });
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1; // 收尾围栏（ tolerate 缺失）
      blocks.push({ kind: "pre", lines: code });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1]!.length, lines: [heading[2]!] });
      index += 1;
      continue;
    }
    if (/^\s*[-•]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-•]\s+/.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\s*[-•]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }
    if (/^\s*\d+[.、]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.、]\s+/.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\s*\d+[.、]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() !== "" && !/^(#{1,3}\s|```|\s*[-•]\s|\s*\d+[.、]\s)/.test(lines[index]!)
      && !(isTableRow(lines[index]!) && index + 1 < lines.length && isTableDivider(lines[index + 1]!))) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push({ kind: "p", lines: paragraph });
  }
  return blocks;
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text);
  return (
    <>
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        if (block.kind === "pre") {
          return <pre key={key}><code>{block.lines.join("\n")}</code></pre>;
        }
        if (block.kind === "table") {
          const [header, ...body] = block.lines;
          return <div className="agent-md-table" key={key}><table>
            <thead><tr>{splitRow(header!).map((cell, cellIndex) => <th key={`${key}-h${cellIndex}`}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{body.map((row, rowIndex) => <tr key={`${key}-r${rowIndex}`}>{splitRow(row).map((cell, cellIndex) => <td key={`${key}-r${rowIndex}c${cellIndex}`}>{renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table></div>;
        }
        if (block.kind === "h") {
          const Tag = (block.level === 1 ? "h4" : block.level === 2 ? "h5" : "h6") as "h4" | "h5" | "h6";
          return <Tag key={key}>{renderInline(block.lines[0]!, key)}</Tag>;
        }
        if (block.kind === "ul" || block.kind === "ol") {
          const Tag = block.kind === "ul" ? "ul" : "ol";
          return (
            <Tag key={key}>
              {block.lines.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}
            </Tag>
          );
        }
        return <p key={key}>{block.lines.map((line, lineIndex) => <Fragment key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}{lineIndex < block.lines.length - 1 ? <br /> : null}</Fragment>)}</p>;
      })}
    </>
  );
}

// 分段主稿的阅读形态：全局说明在前，各段按播放顺序以自身标题成段；与 markdownFullText
// 同一事实，不重排、不合并段落。无 sections 的旧稿就是 text 本身。
export function MarkdownBody({ content }: { content: MarkdownContent }): ReactNode {
  return <>
    {content.text.trim() ? <MarkdownText text={content.text} /> : null}
    {content.sections?.map(section => <section className="agent-md-section" key={section.id}>
      <h5>{section.title}</h5>
      <MarkdownText text={section.text} />
    </section>)}
    {content.narrationText !== undefined ? <section className="agent-md-section">
      <h5>旁白原文</h5>
      <p style={{ whiteSpace: "pre-wrap" }}>{content.narrationText}</p>
    </section> : null}
  </>;
}
