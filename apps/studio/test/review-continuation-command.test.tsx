import { afterEach, expect, it, vi } from "vitest";
import { submitLocalReviewCommand, pendingLocalReviewCommand, observePendingLocalReviewCommand } from "../src/client/review-continuation-command.js";

const input = { commandId: "original-command", expectedRunRevision: 4, nodeId: "visual-review" as const,
  targetArtifactId: "render-A", targetVersionId: "version-A", targetSha256: "a".repeat(64) };
const receipt = (state: string) => new Response(JSON.stringify({ commandId: input.commandId, action: "prepare", state, isCurrent: true }), { status: 200 });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("persists the original body before sending and observes an unknown response without resubmitting", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Lost response")).mockResolvedValueOnce(receipt("accepted"));
  vi.stubGlobal("fetch", fetch);
  await expect(submitLocalReviewCommand("run-A", { kind: "prepare", input })).rejects.toThrow();
  expect(pendingLocalReviewCommand("run-A")).toEqual({ kind: "prepare", input });
  expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/runs/run-A/review-continuations", "/api/runs/run-A/review-continuations/original-command"]);
  fetch.mockReset().mockResolvedValueOnce(receipt("applied")).mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-A", status: "needs_human" })));
  const result = await observePendingLocalReviewCommand("run-A", true);
  expect(result?.id).toBe("run-A");
  expect(fetch.mock.calls.every(call => !call[1]?.method || call[1].method === "GET")).toBe(true);
  expect(pendingLocalReviewCommand("run-A")).toBeUndefined();
});

it("only an explicit accepted-command recovery uses the same id and exact body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Lost response")).mockResolvedValueOnce(receipt("accepted")));
  await expect(submitLocalReviewCommand("run-A", { kind: "prepare", input })).rejects.toThrow();
  const fetch = vi.fn().mockResolvedValueOnce(receipt("accepted")).mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-A", status: "needs_human" })));
  vi.stubGlobal("fetch", fetch);
  await observePendingLocalReviewCommand("run-A", true);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual(input);
});

it("does not send if the original command cannot be saved locally", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(submitLocalReviewCommand("run-A", { kind: "prepare", input })).rejects.toThrow(/保存|storage/);
  expect(fetch).not.toHaveBeenCalled();
});
