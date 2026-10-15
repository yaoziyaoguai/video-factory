import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import type { R4Snapshot, R4Stage, R4VoiceLedger } from "./fixtures/voice-r4-child.js";
import { ProductionPipeline, PythonWorkerClient, type WorkerResponse } from "../src/index.js";
import { explicitEditorialDirector, localEditorialAssetProvider } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const e2eEnabled = process.env.VIDEO_FACTORY_E2E === "1";

type VoiceLedger = {
  operationId: string;
  items: Array<{
    itemRequestId: string; scenePosition: number; state: string; stateHistory: string[];
    reusedFromOperationId?: string; notChargedSettlement?: { reconciliationId: string };
  }>;
  terminalEvidence?: {
    source: string; itemRequestIds: string[];
    reconciliation?: { reconciliationId: string; settledItemRequestIds: string[] };
  };
};

/**
 * R4-C 真实链路（真实宿主 reconcilePaidNode → 真实 Python worker → 本地 MiniMax
 * HTTP stub；离线可达的真实产品路径为逐镜 v2 付费账本）：
 *
 * Phase 1（明确拒收 → 合法新操作接续）：镜 2 被 stub 以 HTTP 400 明确拒收，真实
 * worker 把 terminal_failed 持久化后失败。宿主“重试失败步骤”建立新 operation：
 * 镜 1 按原字节复用（不重发），只补发被拒与未发的镜 2–5，重新成片到终审。
 *
 * Phase 2（unknown → 人工未收费结清 → 持久化/重启重读 → 不解禁）：改词触发重配，
 * stub 以 HTTP 500 制造 unknown；宿主 confirmed_not_charged 结清绑定原 operation 与
 * 实际结清范围且不重置状态；重启新实例只凭磁盘重读 run/账本后，重试不得诱发新的
 * 付费请求（unknown 的保守占用不清零）。
 */
describe("real voice R4 settle chain", () => {
  it("settles and legally continues paid voice operations through the real python worker", { skip: !e2eEnabled }, async () => {
    await Promise.all([
      execFileAsync("ffmpeg", ["-version"]),
      execFileAsync("ffprobe", ["-version"]),
    ]);
    const repositoryRoot = process.cwd();

    // 真实 mp3 字节：纯静音会让响度链路失败，必须用可测音调。
    const probeRoot = await mkdtemp(path.join(tmpdir(), "video-factory-r4c-audio-"));
    const mp3Path = path.join(probeRoot, "scene.mp3");
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=32000:duration=0.6",
      "-b:a", "128k", mp3Path]);
    const audioHex = (await readFile(mp3Path)).toString("hex");

    type Behavior = "ok" | "reject" | "unknown";
    const behaviors: Behavior[] = [];
    const providerCalls: Array<{ text: string; behavior: Behavior }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string }).text).trim();
        const behavior = behaviors.shift() ?? "ok";
        providerCalls.push({ text, behavior });
        if (behavior === "reject") {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: "content rejected by policy" } }));
          return;
        }
        if (behavior === "unknown") {
          response.writeHead(500, { "Content-Type": "text/plain" });
          response.end("upstream exploded");
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          base_resp: { status_code: 0, status_msg: "" },
          trace_id: "r4c-stub-trace",
          data: { audio: audioHex, subtitle_file: "" },
          extra_info: { usage_characters: [...text].length * 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const stubPort = (server.address() as { port: number }).port;
    const client = new PythonWorkerClient({
      command: [process.env.VIDEO_FACTORY_PYTHON ?? "python3", "-m", "video_factory.worker"],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPATH: path.join(repositoryRoot, "src"),
        MINIMAX_API_KEY: "r4c-stub-key",
        MINIMAX_TTS_BASE_URL: `http://127.0.0.1:${stubPort}`,
        // 本机 stub 不经过（不存在的）代理；同时清空大小写两套代理变量。
        http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "",
        no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost",
      },
      timeoutMs: 20 * 60 * 1000,
    });
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "video-factory-r4c-real-"));
    const pipelineOptions = {
      workspaceRoot,
      worker: { run: (request: Record<string, unknown>) => client.run(request) as Promise<WorkerResponse> },
      directorAgent: explicitEditorialDirector,
      assetProviders: [localEditorialAssetProvider],
      providerRuntimeMetadata: [{
        id: "minimax-tts-v1",
        label: "MiniMax 中文声音演员",
        modelId: "speech-2.8-turbo",
        transport: "http_api",
        billing: "metered",
        approvalPolicy: "automatic",
        estimatedCostCny: 0.5,
        maxAttempts: 1,
      } as const],
    };
    const brief = JSON.parse(
      await readFile(path.join(repositoryRoot, "examples", "briefs", "life-avoidance-local.json"), "utf8"),
    ) as Record<string, unknown>;
    const minimaxBrief = {
      ...brief,
      providers: { ...(brief.providers as Record<string, string>), voice: "minimax-tts-v1" },
      voiceDirection: { profileId: "minimax:female-chengshu", rate: 190, pauseScale: 1, masteringPreset: "natural" },
    };
    const readLedgers = async (runId: string): Promise<VoiceLedger[]> => {
      const directory = path.join(workspaceRoot, "runs", runId, "nodes", "voice", ".voice-operations");
      const files = await readdir(directory);
      return Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) =>
        JSON.parse(await readFile(path.join(directory, file), "utf8")) as VoiceLedger));
    };
    try {
      const subject = new ProductionPipeline(pipelineOptions);

      // ── Phase 1：镜 2 明确拒收；镜 3–5 未发。 ──
      behaviors.push("ok", "reject");
      const rejected = await subject.start(minimaxBrief);
      const rejectedVoice = rejected.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(rejected.status, "failed");
      assert.equal(rejectedVoice.status, "failed");
      assert.notEqual(rejectedVoice.outcomeUncertain, true, "明确拒收是已知终态，不停人工核账");
      assert.deepEqual(providerCalls.map((call) => call.behavior), ["ok", "reject"]);
      const rejectedOperationId = rejectedVoice.operationRequestId!;
      assert.ok(rejectedOperationId);
      const rejectedLedger = (await readLedgers(rejected.id)).find((ledger) => ledger.operationId === rejectedOperationId)!;
      assert.deepEqual(rejectedLedger.items.map((item) => item.state),
        ["materialized", "terminal_failed", "prepared", "prepared", "prepared"]);
      const sceneOneText = providerCalls[0]!.text;
      const sceneTwoText = providerCalls[1]!.text;

      // ── Phase 1 合法接续：重试失败步骤 → 新 operation 复用镜 1，只补发镜 2–5。 ──
      const retried = await subject.retryFailedNode(rejected.id, "voice");
      const retriedVoice = retried.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(retried.status, "needs_human", JSON.stringify({
        runStatus: retried.status,
        providerCalls,
        nodes: retried.nodeRuns.map((node) => ({
          nodeId: node.nodeId, status: node.status, error: node.error,
          intervention: node.intervention?.kind, outcomeUncertain: node.outcomeUncertain,
        })),
      }, null, 2));
      const retryOperationId = retriedVoice.operationRequestId!;
      assert.notEqual(retryOperationId, rejectedOperationId, "合法重试建立新 operation，旧 ID 不重发");
      assert.deepEqual(providerCalls.slice(2).map((call) => call.behavior), ["ok", "ok", "ok", "ok"], "只补发镜 2–5");
      assert.ok(!providerCalls.slice(2).some((call) => call.text === sceneOneText), "已成功的镜 1 不得重发");
      assert.equal(providerCalls.slice(2)[0]!.text, sceneTwoText, "被拒的镜 2 重新补发");
      const retryLedger = (await readLedgers(retried.id)).find((ledger) => ledger.operationId === retryOperationId)!;
      const reusedItem = retryLedger.items.find((item) => item.scenePosition === 1)!;
      assert.equal(reusedItem.state, "materialized");
      assert.deepEqual(reusedItem.stateHistory, ["prepared", "reused_materialized"], "镜 1 按原字节/来源复用");
      assert.equal(reusedItem.reusedFromOperationId, rejectedOperationId);
      assert.equal(retryLedger.items.filter((item) => item.state === "materialized").length, 5);

      // ── Phase 2：改词触发重配（v2 指纹整体失效，全部重发）；镜 3 unknown。 ──
      behaviors.push("ok", "ok", "unknown");
      const edited = await subject.requestNarrationRevision(retried.id, {
        expectedRunRevision: retried.revision,
        scenePosition: 5,
        narration: "收藏这张清单。你最想避开哪一个坑？评论区告诉我。",
        actor: "r4c-owner",
        note: "R4-C 真实链路改词",
      });
      const unknownVoice = edited.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(edited.status, "failed");
      assert.equal(unknownVoice.status, "failed");
      assert.equal(unknownVoice.outcomeUncertain, true, "HTTP 500 的结果未知必须停在人工核对");
      assert.deepEqual(providerCalls.slice(6).map((call) => call.behavior), ["ok", "ok", "unknown"]);
      const unknownOperationId = unknownVoice.operationRequestId!;
      const unknownLedger = (await readLedgers(edited.id)).find((ledger) => ledger.operationId === unknownOperationId)!;
      assert.deepEqual(unknownLedger.items.map((item) => item.state),
        ["materialized", "materialized", "unknown", "prepared", "prepared"]);

      // ── 真实宿主人工未收费结清：绑定原 operation 与实际结清范围，不重置状态。 ──
      const settled = await subject.reconcilePaidNode(edited.id, {
        nodeId: "voice",
        expectedRunRevision: edited.revision,
        reconciliationId: "r4c-confirmed-not-charged",
        outcome: "confirmed_not_charged",
        actor: "r4c-owner",
        note: "MiniMax 控制台核对：该请求没有受理记录，未扣费。",
      });
      const settledVoice = settled.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(settledVoice.status, "failed");
      assert.equal(settledVoice.outcomeUncertain, undefined);
      assert.equal(settledVoice.operationRequestId, undefined);
      assert.match(settledVoice.error ?? "", /配音原请求结果仍未核清，本次仅记录费用结清/);
      const settledLedger = (await readLedgers(edited.id)).find((ledger) => ledger.operationId === unknownOperationId)!;
      assert.deepEqual(settledLedger.items.map((item) => item.state),
        ["materialized", "materialized", "unknown", "prepared", "prepared"], "结清只补依据，不得清零占用");
      const settledIds = settledLedger.items.filter((item) => item.state !== "materialized").map((item) => item.itemRequestId);
      assert.equal(settledIds.length, 3);
      for (const item of settledLedger.items) {
        assert.equal(item.notChargedSettlement?.reconciliationId,
          item.state === "materialized" ? undefined : "r4c-confirmed-not-charged",
          "结清范围只覆盖非物化项，materialized 不受损");
      }
      assert.equal(settledLedger.terminalEvidence?.reconciliation?.reconciliationId, "r4c-confirmed-not-charged");
      assert.deepEqual(settledLedger.terminalEvidence?.reconciliation?.settledItemRequestIds, settledIds);

      // ── 持久化/重启重读：新实例只从磁盘恢复 run 与账本事实。 ──
      const restarted = new ProductionPipeline(pipelineOptions);
      const reloaded = await restarted.loadPersisted(edited.id);
      const reloadedVoice = reloaded.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(reloadedVoice.status, "failed");
      assert.match(reloadedVoice.error ?? "", /配音原请求结果仍未核清/);
      const reloadedLedger = (await readLedgers(edited.id)).find((ledger) => ledger.operationId === unknownOperationId)!;
      assert.deepEqual(reloadedLedger.items.map((item) => item.state),
        ["materialized", "materialized", "unknown", "prepared", "prepared"]);

      // ── 重启后的重试不得诱发新付费请求（结清不解禁 unknown 的保守占用）。 ──
      const blocked = await restarted.retryFailedNode(edited.id, "voice");
      const blockedVoice = blocked.nodeRuns.find((node) => node.nodeId === "voice")!;
      assert.equal(blocked.status, "failed");
      assert.equal(blockedVoice.status, "failed");
      assert.equal(providerCalls.length, 9, "结清、重启重读与重试期间不得出现任何新的 provider 调用");
      const blockedLedger = (await readLedgers(edited.id)).find((ledger) => ledger.operationId === unknownOperationId)!;
      assert.deepEqual(blockedLedger.items.map((item) => item.state),
        ["materialized", "materialized", "unknown", "prepared", "prepared"], "占用状态不能被读取或重试清零");
    } finally {
      server.close();
    }
  });
});

// v3 独立覆盖：三个确认后的连续旁白组，真实宿主/worker 与整个 Node 进程退出重启。
describe("real voice R4 v3 process restart", () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const childPath = fileURLToPath(new URL("./fixtures/voice-r4-child.ts", import.meta.url));
  const childEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "VIDEO_FACTORY_PYTHON", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
  };
  type Scenario = "explicit-rejection" | "local-interruption";
  type CrashPoint = "record-before-ledger" | "ledger-before-run" | "run-before-completed";
  async function child(t: TestContext, root: string, scenario: Scenario, phase: string, point?: CrashPoint): Promise<R4Stage> {
    const args = ["--import", "tsx", childPath, phase, root, scenario, ...(point ? [point] : [])];
    let stage: R4Stage;
    try {
      const { stdout } = await execFileAsync(process.execPath, args, { cwd: repositoryRoot, env: childEnv(), timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024 });
      assert.notEqual(phase, "crash", "故障子进程必须被硬退出，不能只重建宿主实例");
      stage = JSON.parse(stdout.trim());
    } catch (error) {
      if (phase !== "crash") throw error;
      assert.equal((error as { signal?: string }).signal, "SIGKILL", String(error));
      stage = JSON.parse(await readFile(path.join(root, "r4-crash-stage.json"), "utf8"));
    }
    t.diagnostic(JSON.stringify({ phase, point, pid: stage.pid, node: stage.node, sources: stage.sources }));
    assert.deepEqual(stage.sourcesAfter, stage.sources, "产品代码在阶段执行期间改变，不能把混合版本当作通过证据");
    assert.equal(stage.snapshot.workerEvents.filter(event => event.kind === "network-denied").length, 0);
    return stage;
  }
  async function fixture(t: TestContext) {
    await Promise.all([execFileAsync("ffmpeg", ["-version"]), execFileAsync("ffprobe", ["-version"])]);
    const root = await mkdtemp(path.join(tmpdir(), "video-factory-r4-v3-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  }
  const voice = (value: R4Snapshot) => {
    const node = value.run.nodeRuns.find(node => node.nodeId === "voice");
    assert.ok(node);
    return node;
  };
  const original = (value: R4Snapshot, operationId: string): R4VoiceLedger => {
    const ledger = value.ledgers.find(ledger => ledger.operationId === operationId);
    assert.ok(ledger);
    assert.equal(ledger.version, "video-factory/voice-operation-v3");
    assert.equal(ledger.items.length, 3);
    return ledger;
  };
  function unchangedFirstGroup(before: R4Snapshot, after: R4Snapshot, operationId: string) {
    const first = original(before, operationId).items[0]!;
    assert.equal(first.state, "materialized");
    assert.ok(first.actualCostCny! > 0);
    assert.ok(first.localPath && first.metadataPath && first.sha256);
    assert.deepEqual(original(after, operationId).items[0], first, "原组 1 的费用、状态、字节指纹与来源不可被结清或重试修改");
    assert.deepEqual(after.media[first.localPath], before.media[first.localPath]);
    assert.deepEqual(after.media[first.metadataPath], before.media[first.metadataPath]);
    assert.equal(after.media[first.localPath]!.sha256, first.sha256);
  }
  function unchangedPaidState(before: R4Snapshot, after: R4Snapshot) {
    assert.deepEqual(after.calls, before.calls, "结清未完成或重入期间不新增 provider 调用");
    assert.deepEqual(after.ledgerSha256, before.ledgerSha256, "不得改写账本或提前创建新 operation");
    assert.equal(after.runSha256, before.runSha256, "未完成结清不得清除原 run 的恢复身份");
    assert.equal(after.reconciliationSha256, before.reconciliationSha256);
  }
  function assertLegalRetry(before: R4Snapshot, after: R4Snapshot, operationId: string) {
    assert.equal(after.run.status, "needs_human", JSON.stringify(after.run.nodeRuns));
    assert.equal(voice(after).status, "needs_human");
    const retryId = voice(after).operationRequestId;
    assert.ok(retryId);
    assert.notEqual(retryId, operationId);
    const prior = original(before, operationId);
    const retried = original(after, retryId);
    assert.equal(retried.completed, true);
    assert.deepEqual(retried.items.map(item => item.state), ["materialized", "materialized", "materialized"]);
    const first = retried.items[0]!;
    assert.deepEqual(first.stateHistory, ["prepared", "reused_materialized"]);
    assert.equal(first.reusedFromOperationId, operationId);
    assert.equal(first.reusedFromItemRequestId, prior.items[0]!.itemRequestId);
    assert.equal(first.responseItemRequestId, prior.items[0]!.responseItemRequestId);
    assert.equal(first.localPath, prior.items[0]!.localPath);
    assert.equal(first.sha256, prior.items[0]!.sha256);
    assert.equal(first.actualCostCny, 0, "复用组 1 不重复记费");
    assert.deepEqual(after.calls.slice(before.calls.length).map(call => call.itemRequestId), retried.items.slice(1).map(item => item.itemRequestId),
      "合法新 operation 只发送原来拒收或尚未发送的组 2、3");
    assert.equal(after.calls.filter(call => call.text === before.calls[0]!.text).length, 1);
    assert.equal(after.ledgerSha256[operationId], before.ledgerSha256[operationId]);
    unchangedFirstGroup(before, after, operationId);
    const receipts = after.run.executionReceipts!.filter(receipt => receipt.nodeId === "voice");
    const oldReceipt = receipts.find(receipt => receipt.requestId === operationId);
    assert.ok(oldReceipt, "原 operation 的费用收据必须保留");
    assert.equal(oldReceipt.actualCostCny, prior.items[0]!.actualCostCny);
    assert.equal(oldReceipt.actualCostSource, prior.items[0]!.actualCostSource);
    assert.equal(receipts.filter(receipt => receipt.requestId === operationId).length, 1, "结清重入不能重复旧 operation 的收据");
    assert.equal(retried.actualCostCny, Math.round(retried.items.slice(1).reduce((sum, item) => sum + item.actualCostCny!, 0) * 100) / 100);
    assert.equal(receipts.find(receipt => receipt.requestId === retryId)?.actualCostCny, retried.actualCostCny);
  }
  function sameSources(stages: R4Stage[]) {
    assert.equal(new Set(stages.map(stage => stage.pid)).size, stages.length, "每个阶段必须使用不同 Node 进程");
    for (const stage of stages) assert.deepEqual(stage.sources, stages[0]!.sources, "跨重启验证必须使用同一份产品源码");
  }

  it("v3 explicit rejection restarts and retries only groups 2 and 3", { skip: !e2eEnabled, timeout: 180_000 }, async t => {
    const root = await fixture(t);
    const setup = await child(t, root, "explicit-rejection", "setup");
    const failed = setup.snapshot;
    const operationId = voice(failed).operationRequestId!;
    assert.equal(failed.run.status, "failed");
    assert.notEqual(voice(failed).outcomeUncertain, true);
    assert.deepEqual(original(failed, operationId).items.map(item => item.state), ["materialized", "terminal_failed", "prepared"]);
    assert.equal(original(failed, operationId).terminalEvidence?.source, "explicit_rejection");
    assert.deepEqual(failed.calls.map(call => call.rejected), [false, true]);
    assert.ok(failed.hostEvents.some(event => event.kind === "confirmed-narration-plan"));
    assert.ok(failed.workerEvents.some(event => event.capability === "voice.quote"));
    assert.ok(failed.workerEvents.some(event => event.capability === "voice.synthesize"));
    const retry = await child(t, root, "explicit-rejection", "retry");
    assert.equal(retry.error, undefined);
    assertLegalRetry(failed, retry.snapshot, operationId);
    sameSources([setup, retry]);
  });

  for (const point of ["record-before-ledger", "ledger-before-run", "run-before-completed"] as const) {
    it(`v3 crash at ${point} blocks dispatch until the original reconciliation completes`, { skip: !e2eEnabled, timeout: 240_000 }, async t => {
      const root = await fixture(t);
      const setup = await child(t, root, "local-interruption", "setup");
      const initial = setup.snapshot;
      const operationId = voice(initial).operationRequestId!;
      assert.equal(initial.run.status, "failed");
      assert.equal(voice(initial).outcomeUncertain, true);
      assert.deepEqual(original(initial, operationId).items.map(item => item.state), ["materialized", "prepared", "prepared"]);
      assert.equal(initial.calls.length, 1);
      assert.equal(original(initial, operationId).terminalEvidence, undefined);
      assert.ok(initial.workerEvents.some(event => event.kind === "prepare" && event.index === 2 && event.interrupted));
      assert.ok(initial.hostEvents.some(event => event.kind === "lost-worker-response"));
      const crash = await child(t, root, "local-interruption", "crash", point);
      const boundary = crash.snapshot;
      assert.equal(boundary.reconciliation?.status, "in_progress");
      assert.equal(boundary.reconciliation?.reconciliationId, "r4-e2e-not-charged");
      assert.deepEqual(boundary.calls, initial.calls);
      unchangedFirstGroup(initial, boundary, operationId);
      if (point === "record-before-ledger") {
        assert.deepEqual(boundary.ledgerSha256, initial.ledgerSha256);
      } else {
        assert.equal(original(boundary, operationId).terminalEvidence?.reconciliation?.reconciliationId, "r4-e2e-not-charged");
      }
      if (point === "run-before-completed") {
        assert.equal(boundary.run.revision, initial.run.revision + 1);
        assert.equal(voice(boundary).outcomeUncertain, undefined);
        assert.equal(voice(boundary).operationRequestId, undefined);
      } else {
        assert.equal(boundary.runSha256, initial.runSha256);
        assert.equal(voice(boundary).outcomeUncertain, true);
      }
      // proper-lockfile 最短 stale 为 5s；等待真实过期，不手工修改或删除锁文件。
      await delay(6_100);
      const blocked = await child(t, root, "local-interruption", "retry");
      assert.match(blocked.error ?? "", /reconcil|结清|核账|核对/i, "应由未完成结清屏障拒绝，不能误把残留租约当覆盖证据");
      unchangedPaidState(boundary, blocked.snapshot);
      assert.deepEqual(blocked.snapshot.workerEvents, boundary.workerEvents, "宿主屏障必须在 worker dispatch 前拒绝");
      const resumed = await child(t, root, "local-interruption", "resume");
      const settled = resumed.snapshot;
      assert.deepEqual(settled.calls, initial.calls);
      assert.deepEqual(settled.workerEvents, initial.workerEvents, "同 reconciliation 重入仅完成本地结清");
      assert.equal(settled.run.revision, initial.run.revision + 1, "run 保存后的重入不得再次追加 revision");
      assert.equal(settled.reconciliation?.status, "completed");
      assert.equal(settled.reconciliation?.runId, initial.run.id);
      assert.equal(settled.reconciliation?.operationId, operationId);
      assert.equal(settled.reconciliation?.nodeId, "voice");
      assert.equal(settled.reconciliation?.outcome, "confirmed_not_charged");
      assert.equal(settled.reconciliation?.resultingRunRevision, settled.run.revision);
      const ledger = original(settled, operationId);
      const settledIds = ledger.items.slice(1).map(item => item.itemRequestId);
      assert.deepEqual(settled.reconciliation?.settledItemRequestIds, settledIds);
      assert.deepEqual(ledger.terminalEvidence?.reconciliation?.settledItemRequestIds, settledIds);
      assert.deepEqual(ledger.items.map(item => item.state), ["materialized", "prepared", "prepared"]);
      for (const item of ledger.items.slice(1)) assert.equal(item.notChargedSettlement?.reconciliationId, "r4-e2e-not-charged");
      const receipt = settled.run.executionReceipts?.find(receipt => receipt.nodeId === "voice" && receipt.requestId === operationId);
      assert.equal(receipt?.actualCostCny, original(initial, operationId).items[0]!.actualCostCny);
      unchangedFirstGroup(initial, settled, operationId);
      const replayed = await child(t, root, "local-interruption", "resume");
      unchangedPaidState(settled, replayed.snapshot);
      assert.deepEqual(replayed.snapshot.workerEvents, settled.workerEvents);
      const retried = await child(t, root, "local-interruption", "retry");
      assert.equal(retried.error, undefined);
      assertLegalRetry(settled, retried.snapshot, operationId);
      sameSources([setup, crash, blocked, resumed, replayed, retried]);
    });
  }
});
