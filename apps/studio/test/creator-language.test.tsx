import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeriesDialog } from "../src/client/components/SeriesDialog.js";

describe("creator-facing language", () => {
  it("describes series defaults by fit instead of price", () => {
    render(<SeriesDialog open onClose={() => undefined} onSubmit={async () => undefined} />);

    expect(screen.getByRole("dialog", { name: "创建系列" })).toHaveTextContent("系统会先补齐一套适合这个系列的制作默认值");
    expect(screen.queryByText(/经济实用/)).not.toBeInTheDocument();
  });
});
