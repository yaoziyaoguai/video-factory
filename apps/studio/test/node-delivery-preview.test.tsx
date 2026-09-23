import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { NodeDeliveryPreview } from "../src/client/components/NodeDeliveryPreview.js";

describe("NodeDeliveryPreview", () => {
  it("shows new stock sources, original credits and unknown dimensions honestly", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{
      scene_position: 1, candidates: [
        { provider: "met", width: 0, height: 0, preview_url: "https://images.metmuseum.org/art.jpg", source_url: "https://www.metmuseum.org/art/collection/search/1", creator: "画家", license_note: "CC0" },
        { provider: "nasa", preview_url: "https://images-assets.nasa.gov/earth.jpg", source_url: "https://images.nasa.gov/details/earth", creator: "NASA/GSFC", license_note: "保留原始创作者" },
        { provider: "openverse", preview_url: "https://api.openverse.org/v1/images/id/thumb/", source_url: "https://www.flickr.com/photos/author/1", creator: "摄影师", license_note: "仅限非商业" },
        { provider: "cleveland", preview_url: "https://openaccess-cdn.clevelandart.org/1/web.jpg", source_url: "https://clevelandart.org/art/1", creator: "馆藏作者", license_note: "CC0" },
        { provider: "archive", preview_url: "https://archive.org/download/clouds/thumb.jpg", source_url: "https://archive.org/details/clouds", creator: "视频作者", license_note: "CC BY · 需署名" },
      ],
    }] }} />);
    expect(screen.getByRole("link", { name: "The Met" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "NASA" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Openverse" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cleveland Museum of Art" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Internet Archive" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "镜头 1 的候选素材 5" })).toHaveAttribute("src", "https://archive.org/download/clouds/thumb.jpg");
    expect(screen.getByRole("img", { name: "镜头 1 的候选素材 4" })).toHaveAttribute("src", "https://openaccess-cdn.clevelandart.org/1/web.jpg");
    expect(screen.getAllByRole("link", { name: /核验原始来源：镜头 1，候选/ })).toHaveLength(5);
    expect(screen.getByRole("img", { name: "镜头 1 的候选素材 1" })).toHaveAttribute("src", "https://images.metmuseum.org/art.jpg");
    expect(screen.getByText(/仅限非商业/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("0 × 0");
  });
  it("shows Coverr logo credit and Commons source/license with safe previews", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{
      scene_position: 1, candidates: [
        { provider: "coverr", preview_url: "https://cdn.coverr.co/a.jpg", source_url: "https://coverr.co/videos/a", creator: "A" },
        { provider: "wikimedia", preview_url: "https://thumb.wikimedia.org/a.jpg", source_url: "https://commons.wikimedia.org/wiki/File:A.webm", creator: "B", license_note: "CC BY-SA 4.0 · 改编须按相同许可分享" },
        { provider: "coverr", preview_url: "https://cdn.coverr.co/private.jpg?token=secret", source_url: "https://user:password@coverr.co/videos/a" },
      ],
    }] }} />);
    expect(screen.getAllByRole("link", { name: "Coverr" })[0]).toHaveAttribute("href", "https://coverr.co");
    expect(screen.getAllByRole("img", { name: "Coverr" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "镜头 1 的候选素材 1" })).toHaveAttribute("src", "https://cdn.coverr.co/a.jpg");
    expect(screen.getByRole("img", { name: "镜头 1 的候选素材 2" })).toHaveAttribute("src", "https://thumb.wikimedia.org/a.jpg");
    expect(screen.getByText(/改编须按相同许可分享/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /核验原始来源：镜头 1，候选/ })).toHaveLength(2);
    expect(container.innerHTML).not.toContain("token=secret");
    expect(container.innerHTML).not.toContain("user:password");
  });
  it("makes every storyboard scene reachable instead of silently truncating the delivery", async () => {
    const scenes = Array.from({ length: 11 }, (_, index) => ({
      position: index + 1,
      narration: `第 ${index + 1} 镜旁白`,
    }));

    render(<NodeDeliveryPreview nodeId="script" value={{ scenes }} />);

    expect(screen.getByText("第 8 镜旁白")).toBeInTheDocument();
    expect(screen.queryByText("第 9 镜旁白")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开其余 3 个分镜" }));
    expect(screen.getByText("第 11 镜旁白")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起分镜" })).toBeInTheDocument();
  });

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
    expect(screen.getByRole("img", { name: "镜头 2 的候选素材 1" })).toHaveAttribute("src", "https://images.pexels.com/photos/asset-2.jpg");
    expect(screen.getByRole("link", { name: /核验原始来源：镜头 2，候选 1，.*（新窗口）/ })).toHaveAttribute("href", "https://www.pexels.com/video/asset-2");
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
      scenes: [{ position: 1, narration: "开场", visual_strategy: "stock" }],
    }} />);

    expect(screen.getByText("实拍视频素材")).toBeInTheDocument();
    expect(screen.getByText("分镜 1")).toBeInTheDocument();
    expect(screen.queryByText("stock")).not.toBeInTheDocument();
  });

  it("calls a director's provider choice a visual source instead of an internal capability", () => {
    render(<NodeDeliveryPreview nodeId="visual-direction" value={{
      shots: [{ purpose: "建立现场", preferredProviderId: "pexels-stock-v1" }],
    }} />);

    expect(screen.getByText("首选画面来源")).toBeInTheDocument();
    expect(screen.queryByText("首选画面能力")).not.toBeInTheDocument();
    expect(screen.getByText("Pexels 图库")).toBeInTheDocument();
  });

  it("hides rendered asset metadata and preserves the model's creative wording", () => {
    const { container } = render(<NodeDeliveryPreview nodeId="assets" value={{
      scene_assets: [{ scene_position: 1, media_type: "video", width: 720, height: 1280 }],
      director_routing: [{
        scene_position: 1,
        actual_provider: "local",
        rationale: "shot-question 使用 asset.generate.video，其他镜头交给本地 Provider。",
      }],
    }} />);

    expect(screen.getByText("shot-question 使用 asset.generate.video，其他镜头交给本地 Provider。")).toBeInTheDocument();
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
    expect(screen.getByText("需你判断的质量问题")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("timecodeMs");
    expect(container).not.toHaveTextContent("legibility");
  });

  it("shows the canon facts a creator is approving at final review", () => {
    render(<NodeDeliveryPreview nodeId="final-review" value={{
      review: { recommendation: "approve", summary: "画面与叙事可以定版。" },
      canonFacts: ["本集已经完成一次可复现的真实验证。"],
    }} />);

    expect(screen.getByRole("heading", { name: "本轮审片结论" })).toBeInTheDocument();
    expect(screen.getByText("画面与叙事可以定版。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /拟加入系列设定的内容/ })).toBeInTheDocument();
    expect(screen.getByText("本集已经完成一次可复现的真实验证。")).toBeInTheDocument();
  });

  it("hides empty and technical-only collection items while keeping all review findings reachable", async () => {
    const findings = Array.from({ length: 10 }, (_, index) => ({
      description: `审片意见 ${index + 1}`,
      severity: index === 8 ? "high" : "low",
    }));
    const { container } = render(<NodeDeliveryPreview nodeId="visual-review" value={{
      findings: [{ codec_name: "h264" }, ...findings, { description: "" }],
    }} />);

    expect(screen.queryByText("审片意见 10")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开其余 5 个审片发现" }));
    expect(screen.getByText("审片意见 10")).toBeInTheDocument();
    expect(screen.getByText("高风险")).toBeInTheDocument();
    expect(screen.getAllByText("10").length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent("h264");
    expect(container).not.toHaveTextContent("codec name");
  });

  it("preserves original creative and license text instead of rewriting words", () => {
    render(<NodeDeliveryPreview nodeId="script" value={{ scenes: [{ position: 1, narration: "Learn fast；合同约束不是创作约束。" }] }} />);
    expect(screen.getByText("Learn fast；合同约束不是创作约束。")).toBeInTheDocument();
  });

  it("makes inner candidate and fact truncation visible and reversible", async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => ({ provider: "pexels", creator: `作者 ${index + 1}` }));
    render(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{ scene_position: 3, candidates }] }} />);
    expect(screen.getByText("7 个候选")).toBeInTheDocument();
    expect(screen.queryByText("作者：作者 7")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开其余 1 个候选" }));
    expect(screen.getByText("作者：作者 7")).toBeInTheDocument();
  });

  it("does not invent a scene identity when its number is absent", () => {
    render(<NodeDeliveryPreview nodeId="asset-candidates" value={{ scene_candidates: [{ candidates: [] }] }} />);
    expect(screen.getByText(/镜头编号未记录 · 第 1 条记录/)).toBeInTheDocument();
    expect(screen.queryByText("镜头 1")).not.toBeInTheDocument();
  });
});
