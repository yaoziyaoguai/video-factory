import { afterEach, expect, it, vi } from "vitest";
import { submitLocalReviewCommand, pendingLocalReviewCommand, observePendingLocalReviewCommand } from "../src/client/review-continuation-command.js";

const input = { commandId: "original-command", expectedRunRevision: 4, nodeId: "visual-review" as const,
  targetArtifactId: "render-A", targetVersionId: "version-A", targetSha256: "a".repeat(64) };
const receipt = (state: string) => new Response(JSON.stringify({ commandId: input.commandId, action: "prepare", state, isCurrent: true }), { status: 200 });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("clears an applied decision when only its downstream work is still running", async () => {
  const command = { kind: "decision" as const, input: { commandId: "original-command", action: "approve" as const,
    expectedRunRevision: 15, interventionId: "visual-stop", reviewEvidenceId: "evidence-A", acceptIncomplete: true as const } };
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-A", status: "running", revision: 16 })))
    .mockResolvedValueOnce(receipt("applied"));
  vi.stubGlobal("fetch", fetch);
  const result = await submitLocalReviewCommand("run-A", command);
  expect(result.revision).toBe(16);
  expect(pendingLocalReviewCommand("run-A")).toBeUndefined();
  expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/runs/run-A/decisions", "/api/runs/run-A/review-continuations/original-command"]);
  expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
});

it.each(["accepted", "query-failed", "wrong-command"])("keeps the original identity when the successful response still has an unconfirmed receipt: %s", async (state) => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-A", status: "running" })));
  if (state === "query-failed") fetch.mockRejectedValueOnce(new TypeError("receipt unavailable"));
  else fetch.mockResolvedValueOnce(state === "wrong-command"
    ? new Response(JSON.stringify({ commandId: "another-command", state: "applied" })) : receipt(state));
  vi.stubGlobal("fetch", fetch);
  const command = { kind: "prepare" as const, input };
  await expect(submitLocalReviewCommand("run-A", command)).resolves.toMatchObject({ status: "running" });
  expect(pendingLocalReviewCommand("run-A")).toEqual(command);
  await expect(submitLocalReviewCommand("run-A", { kind: "prepare", input: { ...input, commandId: "new-command" } })).rejects.toThrow("上一条决定还未核实");
  expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
});

it("does not clear a newer command saved by another tab while the old receipt was in flight", async () => {
  const next = { kind: "prepare" as const, input: { ...input, commandId: "next-command" } };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "run-A", status: "running" })))
    .mockImplementationOnce(async () => {
      localStorage.setItem("video-factory:local-review-command:run-A", JSON.stringify(next));
      return receipt("applied");
    });
  vi.stubGlobal("fetch", fetch);
  await submitLocalReviewCommand("run-A", { kind: "prepare", input });
  expect(pendingLocalReviewCommand("run-A")).toEqual(next);
  expect(fetch.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
});

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
