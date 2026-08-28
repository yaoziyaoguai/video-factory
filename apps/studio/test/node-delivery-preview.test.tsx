import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { NodeDeliveryPreview } from "../src/client/components/NodeDeliveryPreview.js";

describe("NodeDeliveryPreview", () => {
  it("shows reviewable asset candidates without exposing download URLs", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="assets" value={{
      job_id: 7,
      director_routing: [{
        scene_position: 2,
        actual_provider_id: "pexels-stock-v1",
        query: "asian office worker evening",
        rationale: "优先选择与旁白动作一致的竖屏实拍",
        candidate_shortlist: [{
          provider: "pexels",
          provider_id: "pexels-stock-v1",
          asset_id: "asset-2",
          media_type: "video",
          width: 1080,
          height: 1920,
          duration: 6,
          preview_url: "https://images.pexels.com/photos/asset-2.jpg",
          source_url: "https://www.pexels.com/video/asset-2",
          creator: "Creator",
          license_note: "Review the provider license before publishing.",
          score: 93,
          selected: true,
        }],
      }],
    }} />);

    expect(screen.getByText("导演选材与备选素材")).toBeInTheDocument();
    expect(screen.getByText("镜头 2")).toBeInTheDocument();
    expect(screen.getByText("当前采用")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "候选素材 1" })).toHaveAttribute("src", "https://images.pexels.com/photos/asset-2.jpg");
    expect(screen.getByRole("link", { name: "核验原始来源" })).toHaveAttribute("href", "https://www.pexels.com/video/asset-2");
    expect(container).not.toHaveTextContent("download_url");
    expect(container.querySelector('a[href*="temporary"]')).toBeNull();
  });

  it("does not turn unsafe candidate URLs into links", () => {
    render(<NodeDeliveryPreview nodeId="assets" value={{
      director_routing: [{
        scene_position: 1,
        actual_provider: "local",
        candidate_shortlist: [{
          provider: "local",
          preview_url: "https://tracking.example.com/private.jpg",
          source_url: "http://127.0.0.1/private.mp4",
          selected: true,
        }],
      }],
    }} />);

    expect(screen.getByText("暂无缩略图")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("describes legacy asset records without inventing a local or generative source", () => {
    render(<NodeDeliveryPreview nodeId="assets" value={{
      director_routing: [{
        scene_position: 1,
        actual_provider: "pexels",
        query: "person editing video",
      }],
    }} />);

    expect(screen.getByText(/本次任务没有保存可公开预览的候选素材/)).toBeInTheDocument();
    expect(screen.queryByText(/采用本地编辑画面/)).not.toBeInTheDocument();
  });

  it("renders nested node inputs as readable production context instead of only JSON", () => {
    render(<NodeDeliveryPreview nodeId="script-input" value={{
      brief: { title: "人工智能如何改变创作", audience: "短视频创作者", durationSeconds: 24 },
      scriptPath: "/private/runs/run-1/script.json",
    }} />);

    expect(screen.getByRole("heading", { name: "内容简报" })).toBeInTheDocument();
    expect(screen.getByText("人工智能如何改变创作")).toBeInTheDocument();
    expect(screen.getByText("短视频创作者")).toBeInTheDocument();
    expect(screen.getByText("已连接上游产物")).toBeInTheDocument();
    expect(screen.queryByText(/private\/runs/)).not.toBeInTheDocument();
  });
});
