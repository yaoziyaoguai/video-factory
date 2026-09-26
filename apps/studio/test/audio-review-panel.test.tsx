import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AudioReviewPanel } from "../src/client/components/AudioReviewPanel.js";
import { AUDIO_REVIEW_CHECKS } from "@video-factory/production-pipeline/audio-review";

test("missing real audio evidence is never displayed as a passed sound review", () => {
  render(<AudioReviewPanel value={undefined} />);
  expect(screen.getByText("声音审片 · 未审听")).toBeInTheDocument();
  expect(screen.queryByText("声音审片 · 已审听")).toBeNull();
});
test("invalid audio evidence cannot be displayed as heard", () => {
  render(<AudioReviewPanel value={{ status: "completed", audioSha256: "wrong", report: {} }} />);
  expect(screen.getByText("声音报告不可验证")).toBeInTheDocument();
});

test("a valid report with no audible observations is explicitly marked unverified", () => {
  const hash = "a".repeat(64);
  render(<AudioReviewPanel value={{ status: "completed", audioSha256: hash, durationMs: 10000, report: {
    audioSha256: hash, summary: "没有听觉证据", checks: Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"])), findings: [],
  } }} />);
  expect(screen.getByText("声音审片 · 未完成有效审听")).toBeInTheDocument();
  expect(screen.queryByText(/检查依据是本版成片混合音轨/)).toBeNull();
});

test("completed report distinguishes observations, uncertainty and timed actionable findings", () => {
  const hash = "a".repeat(64);
  render(<AudioReviewPanel value={{ status: "completed", audioSha256: hash, durationMs: 10000, modelLabel: "审听模型", report: {
    audioSha256: hash, summary: "存在一次停顿建议", checks: { ...Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"])), pauses: "issue" },
    findings: [{ startMs: 1000, endMs: 2000, category: "pauses", observation: "句中停顿打断含义", suggestion: "将停顿放到句末" }],
  } }} />);
  expect(screen.getByText("声音审片 · 报告已返回")).toBeInTheDocument();
  expect(screen.getAllByText("证据不足")).toHaveLength(5);
  expect(screen.getByText("1.0–2.0 秒 · 语速与停顿")).toBeInTheDocument();
  expect(screen.getByText("建议：将停顿放到句末")).toBeInTheDocument();
});
