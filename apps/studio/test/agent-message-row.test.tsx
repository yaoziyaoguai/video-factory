import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactHead, ArtifactRevision, Message, Work } from "../src/shared/agent/generated/contracts.js";

// UIUX-05 渲染计数：只替身 Markdown 的展示，按调用次数观察 MessageRow 是否被字典换引用拖着重渲染。
const counts = vi.hoisted(() => ({ markdown: 0 }));
vi.mock("../src/client/agent/markdown.js", async () => {
  const React = await import("react");
  return {
    MarkdownText: ({ text }: { text: string }) => { counts.markdown += 1; return React.createElement("p", { "data-testid": "markdown" }, text); },
    MarkdownBody: ({ content }: { content: unknown }) => React.createElement("p", null, String((content as { text?: string }).text ?? "")),
  };
});

const { MessageRow } = await import("../src/client/agent/AgentWorkbench.js");
const { ExecutionRecord, areExecutionRecordPropsEqual } = await import("../src/client/agent/TaskProgress.js");

function message(options: Partial<Message> & Pick<Message, "id" | "role" | "text">): Message {
  return {
    requestId: null, state: "completed", revision: 1, target: null,
    createdAt: "2026-01-01T00:00:00.000Z", createdSequence: 1,
    references: { artifacts: [], proposalIds: [], runIds: [], materialBatchIds: [] },
    kind: "chat", feedback: null, librarySelections: [], ...options,
  };
}

function artifact(id: string, title: string): ArtifactHead {
  return { id, title, kind: "script", revisionId: `${id}-rev-2`, revisionNumber: 2, workId: null, updatedAt: "2026-01-01T00:00:00.000Z" };
}

function revision(artifactId: string, revisionId: string, revisionNumber: number): ArtifactRevision {
  return {
    artifactId, revisionId, revisionNumber, baseRevisionId: null, requestId: null, runId: null,
    digest: `sha256-${revisionId}`, content: { format: "markdown", text: "正文" }, createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function work(id: string, title: string, ownedArtifactId: string | null = null): Work {
  return {
    id, title, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    reviewGroups: ownedArtifactId ? [{
      id: `${id}-group`, title: "文稿", revision: 1, nextIntent: null,
      items: [{
        id: `${id}-item`, label: "视频初稿", role: "video", required: true,
        draft: { kind: "artifact_revision", artifactId: ownedArtifactId, revisionId: `${ownedArtifactId}-rev-2`, digest: `sha256-${ownedArtifactId}-rev-2` },
        approved: null, finalizedSource: null, confirmationId: null, approvedAt: null,
      }],
    }] : [],
  };
}

const noop = () => {};
const stableHandlers = { onOpenArtifact: noop, onOpenRun: noop, onOpenBatch: noop, onReply: noop, onRetry: noop };

type RowDictionary = Pick<Parameters<typeof MessageRow>[0], "works" | "artifacts" | "proposals" | "runs" | "materialBatches" | "accepting" | "revisions" | "errors">;
const dictionary = (): RowDictionary => ({
  works: [work("work-a", "山路夜行")], artifacts: [artifact("art-a", "夜行脚本")],
  proposals: [], runs: [], materialBatches: [], accepting: [], revisions: {}, errors: {},
});

describe("UIUX-05 MessageRow 行级渲染收窄", () => {
  it("纯文本行：works/artifacts/runs 等字典换引用但内容相同时不再重渲染", () => {
    const chat = message({ id: "m1", role: "assistant", text: "这轮先聊清楚方向。" });
    const view = render(<MessageRow {...stableHandlers} {...dictionary()} message={chat} />);
    expect(counts.markdown).toBe(1);
    const fresh = dictionary();
    fresh.works = [{ ...fresh.works[0]!, reviewGroups: fresh.works[0]!.reviewGroups.map(group => ({ ...group })) }];
    view.rerender(<MessageRow {...stableHandlers} {...fresh} message={chat} />);
    expect(counts.markdown).toBe(1);
    view.unmount();
  });

  it("revisionCache 连续写入 10 个与本行无关的修订键不触发重渲染", () => {
    const chat = message({ id: "m2", role: "assistant", text: "继续打磨。" });
    const view = render(<MessageRow {...stableHandlers} {...dictionary()} message={chat} />);
    const afterMount = counts.markdown;
    const noisy = dictionary();
    for (let index = 0; index < 10; index += 1) {
      noisy.revisions[`unrelated-${index}:rev-1`] = revision(`unrelated-${index}`, "rev-1", 1);
    }
    noisy.revisions = { ...noisy.revisions };
    view.rerender(<MessageRow {...stableHandlers} {...noisy} message={chat} />);
    expect(counts.markdown).toBe(afterMount);
    view.unmount();
  });

  it("被引用产物的改名、修订到达与归属变化都必须重渲染并反映到行内", () => {
    const withReference = message({ id: "m3", role: "assistant", text: "这版脚本在这里。", references: { artifacts: [{ artifactId: "art-a", revisionId: "art-a-rev-2" }], proposalIds: [], runIds: [], materialBatchIds: [] } });
    const initial = dictionary();
    const view = render(<MessageRow {...stableHandlers} {...initial} message={withReference} />);
    // 修订未载入：显示绑定版本占位。
    expect(view.container.textContent).toContain("绑定版本");

    const renamed = dictionary();
    renamed.artifacts = [artifact("art-a", "山路脚本·改名")];
    renamed.revisions = { "art-a:art-a-rev-2": revision("art-a", "art-a-rev-2", 2) };
    view.rerender(<MessageRow {...stableHandlers} {...renamed} message={withReference} />);
    expect(counts.markdown).toBe(4);
    expect(view.container.textContent).toContain("现名：山路脚本·改名");
    expect(view.container.textContent).toContain("v2");

    // 内容相同的克隆不再触发；把产物归入作品审阅事项后，归属标签从 kind 名换成角色名。
    const owned = dictionary();
    owned.artifacts = [artifact("art-a", "山路脚本·改名")];
    owned.revisions = { "art-a:art-a-rev-2": revision("art-a", "art-a-rev-2", 2) };
    owned.works = [work("work-a", "山路夜行", "art-a")];
    view.rerender(<MessageRow {...stableHandlers} {...owned} message={withReference} />);
    expect(counts.markdown).toBe(5);
    expect(view.container.textContent).toContain("成片");
    view.unmount();
  });

  it("anchored 变化立即重渲染并落到 data-anchor", () => {
    const chat = message({ id: "m4", role: "assistant", text: "被引用的那条。" });
    const view = render(<MessageRow {...stableHandlers} {...dictionary()} message={chat} />);
    const row = view.container.querySelector(".agent-message")!;
    expect(row.getAttribute("data-anchor")).toBeNull();
    const afterMount = counts.markdown;
    view.rerender(<MessageRow {...stableHandlers} {...dictionary()} message={chat} anchored />);
    expect(counts.markdown).toBe(afterMount + 1);
    expect(row.getAttribute("data-anchor")).toBe("true");
    view.unmount();
  });
});

describe("UIUX-05 ExecutionRecord 渲染收窄", () => {
  const executed = message({
    id: "u1", role: "user", text: "写一版。",
    execution: {
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:20.000Z",
      progress: {
        requestId: "r1", sequence: 1, phase: "tool_completed", label: "执行中", updatedAt: "2026-01-01T00:00:10.000Z",
        steps: [{ id: "s1", label: "编写创作文件", state: "completed", workId: "work-a", updatedAt: "2026-01-01T00:00:10.000Z" }],
      },
    },
  });

  it("works 换引用但步骤归属标题不变时判定相等；标题变化才判定不等并更新 DOM", () => {
    const works1 = [work("work-a", "山路夜行")];
    const cloned = works1.map(item => ({ ...item, reviewGroups: item.reviewGroups.map(group => ({ ...group })) }));
    expect(areExecutionRecordPropsEqual({ message: executed, works: works1 }, { message: executed, works: cloned })).toBe(true);
    expect(areExecutionRecordPropsEqual({ message: executed, works: works1 }, { message: executed, works: [{ ...works1[0]!, title: "山路夜行·改名" }] })).toBe(false);

    const view = render(<ExecutionRecord message={executed} works={works1} />);
    expect(view.container.textContent).toContain("山路夜行");
    view.rerender(<ExecutionRecord message={executed} works={cloned} />);
    expect(view.container.textContent).toContain("山路夜行");
    view.rerender(<ExecutionRecord message={executed} works={[{ ...works1[0]!, title: "山路夜行·改名" }]} />);
    expect(view.container.textContent).toContain("山路夜行·改名");
    view.unmount();
  });
});
