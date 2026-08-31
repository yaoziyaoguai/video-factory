import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NodeStructuredEditor } from "../src/client/components/NodeStructuredEditor.js";

describe("NodeStructuredEditor", () => {
  it("edits deep creative fields while omitting provenance and system-only fields", () => {
    const onChange = vi.fn();
    render(<NodeStructuredEditor
      nodeId="asset-semantic-rank"
      value={{
        scenes: [{
          scenePosition: 1,
          intent: { subject: "早餐摊", visible_action: "蒸汽上升" },
          candidates: [{ provider: "pexels", assetId: "asset-1", rank: 2, rationale: "动作不够明确" }],
        }],
      }}
      onChange={onChange}
    />);

    const rank = screen.getByDisplayValue("2");
    fireEvent.change(rank, { target: { value: "1" } });
    fireEvent.blur(rank);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      scenes: [expect.objectContaining({
        candidates: [expect.objectContaining({ rank: 1 })],
      })],
    }));
    expect(screen.queryByDisplayValue("pexels")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("早餐摊")).not.toHaveAttribute("readonly");
  });

  it("edits numeric arrays without falling back to a read-only technical field", () => {
    const onChange = vi.fn();
    render(<NodeStructuredEditor nodeId="reference-grammar" value={{ beats: [60, 80], confidence: 0.75 }} onChange={onChange} />);

    const threshold = screen.getByDisplayValue("60");
    fireEvent.change(threshold, { target: { value: "65" } });
    fireEvent.blur(threshold);
    expect(onChange).toHaveBeenCalledWith({ beats: [65, 80], confidence: 0.75 });
    onChange.mockClear();
    const confidence = screen.getByRole("spinbutton", { name: "置信度（%）" });
    expect(confidence).toHaveValue(75);
    fireEvent.change(confidence, { target: { value: "" } });
    expect(confidence).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(confidence, { target: { value: "90" } });
    fireEvent.blur(confidence);
    expect(onChange).toHaveBeenCalledWith({ beats: [60, 80], confidence: 0.9 });
  });

  it("does not expose old task snapshots, paths, ids, or renderer internals", () => {
    render(<NodeStructuredEditor
      nodeId="brief"
      value={{
        title: "一杯水",
        templateSnapshot: { templateId: "knowledge-explainer", sourceLayers: ["system"] },
        protocolVersion: "video-factory/brief-v1",
        renderPath: "/tmp/render.mp4",
        requires_ffmpeg: true,
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByDisplayValue("一杯水")).toBeInTheDocument();
    expect(screen.queryByText("template Snapshot")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("/tmp/render.mp4")).not.toBeInTheDocument();
    expect(screen.queryByText("需要 FFmpeg")).not.toBeInTheDocument();
  });

  it("uses the creator contract for known roles instead of exposing every scalar", () => {
    render(<NodeStructuredEditor
      nodeId="brief"
      value={{
        title: "一杯水",
        angle: "只移动光",
        audience: "生活美学创作者",
        nicheSlug: "ordinary-life",
        durationSeconds: 24,
        platform: "douyin",
        reviewMode: "manual",
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByDisplayValue("一杯水")).toBeInTheDocument();
    expect(screen.getByDisplayValue("只移动光")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("ordinary-life")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("douyin")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("manual")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("24")).not.toBeInTheDocument();
  });

  it("uses semantic choices for constrained creative fields", async () => {
    const onChange = vi.fn();
    render(<NodeStructuredEditor
      nodeId="script"
      value={{ scenes: [{ narration: "开场", visual_strategy: "stock" }] }}
      onChange={onChange}
    />);

    const strategy = screen.getByRole("combobox", { name: "画面来源" });
    expect(strategy).toHaveDisplayValue("实拍视频素材");
    await userEvent.setup().selectOptions(strategy, "generated");
    expect(onChange).toHaveBeenCalledWith({ scenes: [{ narration: "开场", visual_strategy: "generated" }] });
  });

  it("collapses long scene collections and keeps creative language in their summaries", () => {
    const { container } = render(<NodeStructuredEditor
      nodeId="script"
      value={{ scenes: [
        { purpose: "建立冲突", narration: "第一句", visual_strategy: "stock" },
        { purpose: "给出答案", narration: "第二句", visual_strategy: "local" },
      ] }}
      onChange={vi.fn()}
    />);

    const items = container.querySelectorAll(".node-editor-collection-item");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("open");
    expect(items[1]).not.toHaveAttribute("open");
    expect(screen.getByText("分镜 01")).toBeInTheDocument();
    expect(screen.getByText("建立冲突")).toBeInTheDocument();
    expect(screen.queryByText("purpose")).not.toBeInTheDocument();
  });

  it("uses creator-facing labels for nested platform and shot fields", () => {
    render(<NodeStructuredEditor
      nodeId="script"
      value={{
        platform_notes: { platform: "douyin", audience: "普通创作者" },
        scenes: [{ position: 1, narration: "开场" }],
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByRole("combobox", { name: "发布平台" })).toHaveDisplayValue("抖音");
    expect(screen.getByRole("spinbutton", { name: "镜头序号" })).toHaveValue(1);
    expect(screen.queryByText("platform")).not.toBeInTheDocument();
    expect(screen.queryByText("position")).not.toBeInTheDocument();
  });

  it("names upstream creative documents without exposing schema keys", () => {
    render(<NodeStructuredEditor
      nodeId="script-input"
      value={{ brief: { title: "一杯水", angle: "日常观察", audience: "普通观众" } }}
      onChange={vi.fn()}
    />);

    expect(screen.getByText("内容简报")).toBeInTheDocument();
    expect(screen.queryByText("brief")).not.toBeInTheDocument();
  });

  it("uses creator language for director fields and production shorthand", () => {
    const { container } = render(<NodeStructuredEditor
      nodeId="visual-direction"
      assetProviderIds={["pexels-stock-v1", "hailuo-video-v1"]}
      value={{
        requestedProfileId: "auto",
        resolvedProfileId: "geometric-control",
        profileRationale: "geometric-control 匹配本片",
        visualBible: { pacing: "节奏 measured，字幕密度 medium" },
        shots: [{ scenePosition: 1, narrativeRole: "question / shot-question：提出问题", preferredProviderId: "pexels-stock-v1" }],
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByRole("combobox", { name: "指定风格" })).toHaveDisplayValue("自动匹配");
    expect(screen.getByRole("combobox", { name: "导演风格" })).toHaveDisplayValue("几何秩序");
    expect(screen.getByRole("combobox", { name: "首选画面能力" })).toHaveDisplayValue("Pexels 图库");
    expect(screen.getByRole("option", { name: "MiniMax 海螺视频生成" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Seedance 视频生成" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("几何秩序 匹配本片")).toBeInTheDocument();
    expect(screen.getByDisplayValue("节奏 舒缓克制，字幕密度 适中")).toBeInTheDocument();
    expect(screen.getByDisplayValue("提问钩子：提出问题")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "镜头序号" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("requestedProfileId");
    expect(container).not.toHaveTextContent("shot-question");
  });

  it("does not offer renderer metadata as editable asset content", () => {
    render(<NodeStructuredEditor
      nodeId="assets"
      value={{
        scene_assets: [{ scene_position: 1, media_type: "video", width: 720, height: 1280 }],
        director_routing: [{ scene_position: 1, rationale: "采用动态镜头" }],
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByDisplayValue("采用动态镜头")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("video")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("720")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("1280")).not.toBeInTheDocument();
  });

  it("lets creators curate candidate order without exposing machine ranking internals", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NodeStructuredEditor
      nodeId="asset-candidates"
      value={{
        scene_candidates: [{
          query: "创作者操作鼠标",
          candidates: [
            { query: "候选一", score: 2084600, selected: false },
            { query: "候选二", score: 91, selected: true },
          ],
        }],
      }}
      onChange={onChange}
    />);

    expect(screen.queryByText("score")).not.toBeInTheDocument();
    expect(screen.queryByText("selected")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("2084600")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下移候选素材 1" }));
    expect(onChange).toHaveBeenCalledWith({
      scene_candidates: [{
        query: "创作者操作鼠标",
        candidates: [
          { query: "候选二", score: 91, selected: true },
          { query: "候选一", score: 2084600, selected: false },
        ],
      }],
    });
    onChange.mockClear();
    await user.click(screen.getByRole("button", { name: "移出候选素材 1" }));
    expect(onChange).toHaveBeenCalledWith({
      scene_candidates: [{
        query: "创作者操作鼠标",
        candidates: [{ query: "候选二", score: 91, selected: true }],
      }],
    });
  });

  it("does not keep a removed collection row visible through a recycled array index", async () => {
    const user = userEvent.setup();
    const initial = {
      scene_candidates: [{
        query: "创作者操作鼠标",
        candidates: [
          { query: "应当移除的候选" },
          { query: "" },
        ],
      }],
    };
    const onChange = vi.fn();
    const { rerender } = render(<NodeStructuredEditor nodeId="asset-candidates" value={initial} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "移出候选素材 1" }));
    const next = { scene_candidates: [{ query: "创作者操作鼠标", candidates: [{ query: "" }] }] };
    rerender(<NodeStructuredEditor nodeId="asset-candidates" value={next} onChange={onChange} />);

    expect(screen.queryByDisplayValue("应当移除的候选")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /移出候选素材/ })).not.toBeInTheDocument();
  });

  it("uses editorial choices for visual review findings and keeps timestamps read-only", () => {
    render(<NodeStructuredEditor
      nodeId="visual-review"
      value={{
        confidence: 0.96,
        scores: { continuity: 27, codec_name: "h264" },
        findings: [{
          timecodeMs: 6000,
          category: "continuity",
          severity: "warning",
          description: "转场闪白",
          suggestion: "使用 manualReplacement 修复",
          debugPayload: "internal",
        }],
      }}
      onChange={vi.fn()}
    />);

    expect(screen.getByRole("combobox", { name: "问题类型" })).toHaveDisplayValue("连续性");
    expect(screen.getByRole("combobox", { name: "严重程度" })).toHaveDisplayValue("需修改");
    expect(screen.queryByDisplayValue("6000")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("转场闪白")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "置信度（%）" })).toHaveValue(96);
    expect(screen.getByRole("spinbutton", { name: "连续性" })).toHaveValue(27);
    expect(screen.getByDisplayValue("使用 人工补充素材 修复")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("h264")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("internal")).not.toBeInTheDocument();
  });

  it("does not render empty or technical-only collection rows", () => {
    const { container } = render(<NodeStructuredEditor
      nodeId="visual-review"
      value={{ findings: [{ debugPayload: "internal" }, { timecodeMs: 6000, category: "continuity", severity: "warning", description: "需要重剪" }, { description: "" }] }}
      onChange={vi.fn()}
    />);

    expect(screen.getByText("1 项")).toBeInTheDocument();
    expect(screen.getByText("00:06 · 连续性 · 需修改")).toBeInTheDocument();
    expect(screen.getByDisplayValue("需要重剪")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("internal")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".node-editor-finding")).toHaveLength(1);
    expect(container.querySelector(".node-editor-finding")).toHaveAttribute("open");
  });
});
