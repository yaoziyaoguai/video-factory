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
    expect(screen.queryByText("已连接上游产物")).not.toBeInTheDocument();
    expect(screen.queryByText(/private\/runs/)).not.toBeInTheDocument();
  });

  it("does not show system configuration as a creator-facing brief", () => {
    render(<NodeDeliveryPreview nodeId="brief" value={{
      title: "一杯水",
      angle: "只移动光",
      audience: "生活美学创作者",
      nicheSlug: "ordinary-life",
      durationSeconds: 24,
      platform: "douyin",
      reviewMode: "manual",
    }} />);

    expect(screen.getByText("一杯水")).toBeInTheDocument();
    expect(screen.queryByText("ordinary-life")).not.toBeInTheDocument();
    expect(screen.queryByText("douyin")).not.toBeInTheDocument();
    expect(screen.queryByText("manual")).not.toBeInTheDocument();
  });

  it("translates production enums into creator language", () => {
    render(<NodeDeliveryPreview nodeId="script" value={{
      scenes: [{ narration: "开场", visual_strategy: "stock" }],
    }} />);

    expect(screen.getByText("实拍视频素材")).toBeInTheDocument();
    expect(screen.getByText("分镜 1")).toBeInTheDocument();
    expect(screen.queryByText("stock")).not.toBeInTheDocument();
  });

  it("hides rendered asset metadata and translates internal creative terms", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="assets" value={{
      scene_assets: [{ scene_position: 1, media_type: "video", width: 720, height: 1280 }],
      director_routing: [{
        scene_position: 1,
        actual_provider: "local",
        rationale: "shot-question 使用 asset.generate.video，其他镜头交给本地 Provider。",
      }],
    }} />);

    expect(screen.getByText(/提问镜头\s*使用 AI 视频生成/)).toBeInTheDocument();
    expect(screen.getByText(/本地编辑能力/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent("media type");
    expect(container).not.toHaveTextContent("720");
    expect(container).not.toHaveTextContent("1280");
  });

  it("presents visual review findings as editorial notes instead of raw diagnostics", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="visual-review" value={{
      scores: { legibility: 84, safety: 100 },
      findings: [{ timecodeMs: 6000, category: "continuity", severity: "warning", description: "转场闪白" }],
    }} />);

    expect(screen.getByText("文字可读性")).toBeInTheDocument();
    expect(screen.getByText("内容安全")).toBeInTheDocument();
    expect(screen.getByText("00:06")).toBeInTheDocument();
    expect(screen.getByText("连续性")).toBeInTheDocument();
    expect(screen.getByText("需修改")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("timecodeMs");
    expect(container).not.toHaveTextContent("legibility");
  });

  it("hides empty and technical-only collection items while keeping all review findings", () => {
    const findings = Array.from({ length: 10 }, (_, index) => ({
      description: `审片意见 ${index + 1}`,
      severity: index === 8 ? "high" : "low",
    }));
    const { container } = render(<NodeDeliveryPreview nodeId="visual-review" value={{
      findings: [{ codec_name: "h264" }, ...findings, { description: "" }],
    }} />);

    expect(screen.getByText("审片意见 10")).toBeInTheDocument();
    expect(screen.getByText("高风险")).toBeInTheDocument();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent("h264");
    expect(container).not.toHaveTextContent("codec name");
  });
});
