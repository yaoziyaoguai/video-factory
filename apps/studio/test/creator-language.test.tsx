import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeriesDialog } from "../src/client/components/SeriesDialog.js";

describe("creator-facing language", () => {
  it("describes unspecified creative directions as suggestions owned by the creator", () => {
    render(<SeriesDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    expect(screen.getByRole("dialog", { name: "创建系列" })).toHaveTextContent("未填写的风格和内容方向交给角色提出建议，再由你决定");
    expect(screen.queryByText(/系统会先补齐.*默认值/)).not.toBeInTheDocument();
    expect(screen.queryByText(/经济实用/)).not.toBeInTheDocument();
  });
});
