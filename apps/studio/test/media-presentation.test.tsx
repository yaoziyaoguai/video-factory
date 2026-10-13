import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeWorkspace } from "../src/client/components/NodeWorkspace.js";
import { NodeDeliveryPreview } from "../src/client/components/NodeDeliveryPreview.js";
import type { StudioArtifact, StudioNode } from "../src/shared/api.js";

describe("artifact media presentation", () => {
  it("keeps candidate identity and attribution outside a failed thumbnail", () => {
    const candidate = { selected: true, preview_url: "https://images.unsplash.com/first.jpg", provider_id: "unsplash-stock-v1", width: 1080, height: 1920, creator: "原摄影者" };
    const { rerender } = render(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{ scene_position: 1, candidates: [candidate] }] }} />);
    const picture = screen.getByRole("img");
    expect(screen.getByText("当前采用").closest("figcaption")).not.toBeNull();
    fireEvent.error(picture);
    expect(screen.getByText("候选缩略图读取失败")).toBeVisible();
    expect(screen.getByText(/1080 × 1920/)).toBeVisible();
    expect(screen.getByText("当前采用")).toBeVisible();
    rerender(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{ scene_position: 1, candidates: [{ ...candidate, preview_url: "https://images.unsplash.com/second.jpg" }] }] }} />);
    expect(screen.queryByText("候选缩略图读取失败")).not.toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://images.unsplash.com/second.jpg");
  });

  it("keeps a failed picture separate from video and never changes the production state", () => {
    const artifacts: StudioArtifact[] = [
      { id: "image-1", kind: "asset", contentType: "image/jpeg", contentUrl: "/image.jpg", scenePosition: 1, createdAt: "2026-10-13T00:00:00Z", producerNodeId: "assets" },
      { id: "video-2", kind: "asset", contentType: "video/mp4", contentUrl: "/video.mp4", scenePosition: 2, createdAt: "2026-10-13T00:00:00Z", producerNodeId: "assets" },
    ];
    const node: StudioNode = { id: "assets", label: "素材", status: "succeeded", artifactIds: artifacts.map(artifact => artifact.id), qualityGateResults: [], output: {} };
    const onOverride = vi.fn();
    const onAuthorize = vi.fn();
    const { rerender } = render(<NodeWorkspace node={node} artifacts={artifacts} runId="media-display" runRevision={1} runStatus="needs_human" acceptedPlanDigest="" busy={false} currentDelivery onOverride={onOverride} onAuthorize={onAuthorize} />);
    const picture = screen.getByAltText("镜头 1 画面预览");
    fireEvent.error(picture);
    expect(screen.getByText("镜头 1 预览读取失败，原素材记录仍保留。")).toBeVisible();
    const video = screen.getByLabelText("镜头 2 画面预览");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    fireEvent.error(video);
    expect(screen.getByText("镜头 2 预览读取失败，原素材记录仍保留。")).toBeVisible();
    fireEvent.loadedData(video);
    expect(screen.queryByText("镜头 2 预览读取失败，原素材记录仍保留。")).not.toBeInTheDocument();
    expect(screen.getByText("镜头 1 预览读取失败，原素材记录仍保留。")).toBeVisible();
    const changed = artifacts.map(artifact => artifact.id === "image-1" ? { ...artifact, contentUrl: "/other.jpg" } : artifact);
    rerender(<NodeWorkspace node={node} artifacts={changed} runId="media-display" runRevision={2} runStatus="needs_human" acceptedPlanDigest="" busy={false} currentDelivery onOverride={onOverride} onAuthorize={onAuthorize} />);
    expect(screen.queryByText("镜头 1 预览读取失败，原素材记录仍保留。")).not.toBeInTheDocument();
    expect(onOverride).not.toHaveBeenCalled();
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
