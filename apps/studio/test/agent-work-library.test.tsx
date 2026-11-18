import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { WorkLibrary } from "../src/client/agent/WorkLibrary.js";
import type { ArtifactRevision, LibraryVideo, ReviewInput } from "../src/shared/agent/generated/contracts.js";

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), head: vi.fn() }));
vi.mock("../src/client/agent/api.js", () => ({
  agentApi: { listLibraryVideos: api.list, readRevision: api.read, readArtifactHead: api.head },
}));

const at = "2026-11-18T00:00:00.000Z";
const digest = "a".repeat(64);
const video = { artifactId: "art-final", revisionId: "rev-final" };
const frozen = [["art-script", "rev-script"], ["art-plan", "rev-plan"]] as const;

function revision(artifactId: string, revisionId: string, revisionNumber: number, content: ArtifactRevision["content"]): ArtifactRevision {
  return { artifactId, revisionId, revisionNumber, content, digest, baseRevisionId: null, requestId: null, runId: null, createdAt: at };
}

const library = (bringTarget: "current" | "new" = "current") => <MemoryRouter><WorkLibrary bringTarget={bringTarget} onBringIn={vi.fn()} /></MemoryRouter>;
const basisReads = () => api.read.mock.calls.filter(([artifactId]) => artifactId !== video.artifactId);

async function openFinalVideo(readBasis: (artifactId: string, revisionId: string) => ArtifactRevision | Promise<ArtifactRevision>) {
  const reviewSources: ReviewInput[] = frozen.map(([artifactId, revisionId], index) => ({
    groupId: "group-1", itemId: `item-${index}`, confirmationId: `confirmation-${index}`,
    source: { kind: "artifact_revision", artifactId, revisionId, digest },
  }));
  const entry: LibraryVideo = {
    title: "测试定稿", finalizedAt: at, conversationId: "synthetic", workId: "work-1", originMessageId: null, video,
    materials: [], projectFiles: [], project: null, narrationText: null, content: null, plan: null,
    provenanceStatus: "recorded",
    // 用等值的新对象模拟数据重建，验证依据读取不依赖对象引用。
    get reviewSources() { return structuredClone(reviewSources); },
  };
  api.list.mockResolvedValue({ nextCursor: null, items: [entry] });
  api.read.mockImplementation(async (artifactId: string, revisionId: string) =>
    artifactId === video.artifactId && revisionId === video.revisionId
      ? revision(artifactId, revisionId, 1, { format: "media", blobId: "synthetic-video", mimeType: "video/mp4", durationMs: 1000 })
      : readBasis(artifactId, revisionId));
  const ui = render(library());
  await userEvent.click(await screen.findByRole("button", { name: /测试定稿/ }));
  await screen.findByLabelText("定稿视频");
  const summary = screen.getByText("本次制作依据");
  return { ...ui, summary, details: summary.closest("details")! };
}

beforeEach(() => vi.resetAllMocks());

test("R5 展开才读取两条冻结修订，等值重渲染保持认可版本且不读新稿", async () => {
  const laterDraft = revision(frozen[0][0], "rev-script-later", 3, { format: "markdown", text: "后继未认可的草稿" });
  api.head.mockResolvedValue({ head: laterDraft });
  let resolvePlan!: (value: ArtifactRevision) => void;
  const pendingPlan = new Promise<ArtifactRevision>(resolve => { resolvePlan = resolve; });
  const { summary, details, rerender } = await openFinalVideo((artifactId, revisionId) => {
    if (artifactId === frozen[0][0] && revisionId === frozen[0][1]) {
      return revision(artifactId, revisionId, 2, { format: "markdown", text: "冻结的认可文稿" });
    }
    if (artifactId === frozen[1][0] && revisionId === frozen[1][1]) return pendingPlan;
    if (artifactId === laterDraft.artifactId && revisionId === laterDraft.revisionId) return laterDraft;
    throw new Error(`意外的修订请求 ${artifactId}/${revisionId}`);
  });
  expect(details.open).toBe(false);
  expect(basisReads()).toEqual([]);

  await userEvent.click(summary);
  const basis = within(details);
  expect(await basis.findByText("冻结的认可文稿")).toBeVisible();
  expect(basis.getByText("正在读取…")).toBeVisible();
  expect(basisReads()).toEqual(frozen);
  await act(async () => resolvePlan(revision(...frozen[1], 4, { format: "markdown", text: "冻结的认可方案" })));
  expect(basis.getByText("依据 1 · 已认可 · v2")).toBeVisible();
  expect(basis.getByText("依据 2 · 已认可 · v4")).toBeVisible();
  expect(basis.getByText("冻结的认可方案")).toBeVisible();

  rerender(library("new"));
  expect(screen.getByRole("button", { name: "带入新对话" })).toBeInTheDocument();
  expect(basis.getByText("冻结的认可文稿")).toBeVisible();
  expect(basis.getByText("冻结的认可方案")).toBeVisible();
  expect(basis.queryByText("后继未认可的草稿")).toBeNull();
  expect(basisReads()).toEqual(frozen);
  expect(api.head).not.toHaveBeenCalled();
});

test("R5 只展示已记录的素材署名，媒体是否为模拟保持未知", async () => {
  const { summary, details } = await openFinalVideo((artifactId, revisionId) => revision(artifactId, revisionId, 2, {
    format: "media", blobId: `blob-${revisionId}`, mimeType: "image/png", durationMs: null,
    ...(revisionId === frozen[1][1] ? { sources: [{
      provider: "pexels", assetId: "42", sourceUrl: "https://example.invalid/asset", creatorName: "测试作者",
      creatorUrl: null, licenseUrl: "https://example.invalid/license", acquiredAt: at,
    }] } : {}),
  }));
  await userEvent.click(summary);
  const [unattributed, attributed] = await within(details).findAllByRole("listitem");
  expect(await within(unattributed!).findByText("真实或模拟来源未知")).toBeVisible();
  expect(within(unattributed!).queryByRole("link", { name: "原素材" })).toBeNull();
  expect(await within(attributed!).findByRole("link", { name: "原素材" })).toHaveAttribute("href", "https://example.invalid/asset");
  expect(within(attributed!).getByText(/测试作者/)).toBeVisible();
  expect(within(attributed!).getByText("真实或模拟来源未知")).toBeVisible();
});
