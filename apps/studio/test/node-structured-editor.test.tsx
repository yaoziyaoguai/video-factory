import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeStructuredEditor } from "../src/client/components/NodeStructuredEditor.js";

describe("NodeStructuredEditor", () => {
  it("edits deep scene and candidate fields while keeping provenance fields read-only", () => {
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
    expect(screen.getByDisplayValue("pexels")).toHaveAttribute("readonly");
    expect(screen.getByDisplayValue("早餐摊")).not.toHaveAttribute("readonly");
  });

  it("keeps numeric arrays typed and allows a temporary empty numeric draft", () => {
    const onChange = vi.fn();
    render(<NodeStructuredEditor nodeId="review" value={{ thresholds: [60, 80], confidence: 0.8 }} onChange={onChange} />);

    expect(screen.getByText(/含数字或布尔值/).closest("label")?.querySelector("textarea")).toHaveAttribute("readonly");
    const confidence = screen.getByDisplayValue("0.8");
    fireEvent.change(confidence, { target: { value: "" } });
    expect(confidence).toHaveValue(null);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(confidence, { target: { value: "0.9" } });
    fireEvent.blur(confidence);
    expect(onChange).toHaveBeenCalledWith({ thresholds: [60, 80], confidence: 0.9 });
  });
});
