import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexBridgeError, classifyReviewDisposition, audioReviewObservationCoverage, validateAudioReviewReport, type AudioReviewReport, type AudioReviewResult, type CodexPreparedOperation, type VisualReviewAgent, type VisualReviewAgentInput, type VisualReviewMediaPreprocessor, type VisualReviewMediaPayload } from "@video-factory/production-pipeline";
import { lock } from "proper-lockfile";
import { dispositionAllowsHumanStop, VisualReviewFallbackError, IndependentVisualReviewError, VisualReviewWithAudioError } from "@video-factory/production-pipeline";
import type { ConnectedModel } from "./model-connections.js";

const execFile = promisify(execFileCallback);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
type LowLevelInterval = { startMs: number; endMs: number };

// T06：与操作 checkpoint 并排耐久保存的完成结果；重启/崩溃后直读，不再依赖 broker 可用。
interface PersistedAudioReviewResult {
  version: "video-factory/audio-review-result-v1";
  kind: "completed" | "settled_unusable" | "request_failed";
  requestId: string;
  modelId: string;
  videoSha256: string;
  audioSha256: string;
  durationMs: number;
  completedAt: string;
  trace?: import("@video-factory/production-pipeline").CodexTaskTrace;
  output?: unknown;
  validationError?: string;
  requestState?: "settled" | "not_accepted";
  failureDetails?: SafeAudioFailureDetails;
}

type SafeAudioFailureDetails = Pick<NonNullable<CodexBridgeError["failureDetails"]>,
  "providerId" | "modelId" | "requestIdHash" | "brokerRequestIdHash" | "accepted" | "modelAttemptCount" | "structuredRepairCount" | "providerWaitMs" | "queueWaitMs">;

interface AudioInputBinding {
  version: "video-factory/audio-review-input-v1";
  inputIdentity: string;
  requestId: string;
  modelId: string;
  videoSha256: string;
  audioSha256: string;
  durationMs: number;
  reviewCycleId?: string;
}

type PersistedAudioOperation = CodexPreparedOperation & { audioInputBinding?: AudioInputBinding };

export type AudioReviewObservation = AudioReviewResult & {
  requestState: "settled" | "not_accepted" | "unknown";
};

function validateInputBinding(value: AudioInputBinding, requestId: string): void {
  if (value.version !== "video-factory/audio-review-input-v1" || value.requestId !== requestId
    || !/^sound-[a-f0-9]{64}$/.test(value.requestId) || !/^[a-f0-9]{64}$/.test(value.inputIdentity)
    || !/^[a-f0-9]{64}$/.test(value.videoSha256) || !/^[a-f0-9]{64}$/.test(value.audioSha256)
    || !Number.isInteger(value.durationMs) || value.durationMs <= 0
    || value.reviewCycleId !== undefined && (typeof value.reviewCycleId !== "string" || !value.reviewCycleId.trim())) bindingConflict();
}

function bindingConflict(): never {
  throw new CodexBridgeError("声音审片原请求与证据身份无法核对，未发送新请求。", false, "conflict");
}

function completedAudioResult(saved: PersistedAudioReviewResult, binding: AudioInputBinding, selected: ConnectedModel): AudioReviewResult {
  if (saved.requestId !== binding.requestId || saved.modelId !== binding.modelId || saved.videoSha256 !== binding.videoSha256
    || saved.audioSha256 !== binding.audioSha256 || saved.durationMs !== binding.durationMs
    || saved.kind !== "request_failed" && (!saved.trace || saved.trace.providerId !== binding.modelId || saved.trace.modelId !== binding.modelId)
    || saved.trace?.brokerRequestIdHash && saved.trace.brokerRequestIdHash !== sha(binding.requestId)) bindingConflict();
  if (saved.kind === "request_failed") {
    if (saved.requestState !== "settled" && saved.requestState !== "not_accepted") bindingConflict();
    return { status: "failed", reason: "原声音审片请求已核清，但未取得有效报告。普通恢复不会重新消费；可在确认当前配置后主动发起新的审听。" };
  }
  if (saved.kind === "settled_unusable") return { status: "failed", reason: "声音审片已返回，但报告未形成有效结论（settled）。原始证据已保留，普通恢复不会自动重审。" };
  if (saved.kind !== "completed") bindingConflict();
  try {
    const report = validateAudioReviewReport(saved.output, binding.audioSha256, binding.durationMs);
    return { status: "completed", modelId: binding.modelId, modelLabel: `${selected.model.label} · ${selected.model.modelId}`,
      videoSha256: binding.videoSha256, audioSha256: binding.audioSha256, durationMs: binding.durationMs,
      report, observationCoverage: audioReviewObservationCoverage(report), ...(saved.trace ? { trace: saved.trace } : {}) };
  } catch {
    return { status: "failed", reason: "已保存的声音报告未形成有效结论（settled）；原始返回保留，普通恢复不会自动重审。" };
  }
}

async function persistAtomically(target: string, content: string): Promise<void> {
  const staging = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(staging, content, { mode: 0o600, flag: "wx" });
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
}

async function readPersistedResult(resultPath: string): Promise<PersistedAudioReviewResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resultPath, "utf8")) as PersistedAudioReviewResult;
    if (parsed?.version !== "video-factory/audio-review-result-v1") bindingConflict();
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export class AudioReviewService {
  constructor(private readonly options: {
    connections: () => ConnectedModel[];
    media: VisualReviewMediaPreprocessor;
    extract?: (video: string, output: string) => Promise<void | LowLevelInterval[]>;
  }) {}

  wrap(agent: VisualReviewAgent): VisualReviewAgent {
    return {
      id: agent.id, modelId: agent.modelId,
      ...(agent.independentRoleAudit !== undefined ? { independentRoleAudit: agent.independentRoleAudit } : {}),
      ...(agent.finalReviewConfiguration ? { finalReviewConfiguration: agent.finalReviewConfiguration } : {}),
      review: async (input) => (await this.run(agent, input)).output,
      reviewDetailed: (input) => this.run(agent, input),
    };
  }

  private async run(agent: VisualReviewAgent, input: VisualReviewAgentInput) {
    let execution;
    try { execution = agent.reviewDetailed ? await agent.reviewDetailed(input) : { output: await agent.review(input) }; }
    catch (error) {
      const failures = error instanceof VisualReviewFallbackError || error instanceof IndependentVisualReviewError
        ? error.failures.map((item) => item.error) : [error];
      if (input.reviewStage === "source_assets" || !input.videoPath || !failures.length
        || !failures.every((failure) => dispositionAllowsHumanStop(classifyReviewDisposition(failure)))) throw error;
      throw new VisualReviewWithAudioError(error, await this.review(input));
    }
    if (input.reviewStage === "source_assets" || !input.videoPath) return execution;
    const audioReview = await this.review(input);
    return { ...execution, audioReview };
  }

  async review(input: VisualReviewAgentInput): Promise<AudioReviewResult> {
    let release: (() => Promise<void>) | undefined;
    let inspectingRequests = false;
    let compromised = false;
    const assertOwned = () => { if (compromised) bindingConflict(); };
    try {
      const root = await realpath(input.runRoot);
      const directory = path.join(root, ".audio-review-requests");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await lock(directory, { realpath: false, stale: 30_000, update: 10_000, retries: 0,
        onCompromised: () => { compromised = true; } });
      const inputIdentity = await audioInputIdentity(input, root);
      inspectingRequests = true;
      const names = await readdir(directory);
      const bindings: AudioInputBinding[] = [];
      for (const name of names.filter((name) => name.endsWith(".input.json"))) {
        const value = JSON.parse(await readFile(path.join(directory, name), "utf8")) as AudioInputBinding;
        validateInputBinding(value, name.slice(0, -".input.json".length));
        bindings.push(value);
      }
      // 信封与绑定在同一次原子写入中提交；索引是可重建投影，崩溃不能丢失恢复依据。
      for (const name of names.filter((name) => /^sound-[a-f0-9]{64}\.json$/.test(name))) {
        const operation = JSON.parse(await readFile(path.join(directory, name), "utf8")) as PersistedAudioOperation;
        const embedded = operation.audioInputBinding;
        if (!embedded) continue;
        validateInputBinding(embedded, name.slice(0, -".json".length));
        const indexed = bindings.find((item) => item.requestId === embedded.requestId);
        if (indexed && JSON.stringify(indexed) !== JSON.stringify(embedded)) bindingConflict();
        if (!indexed) bindings.push(embedded);
      }
      const pending = bindings.filter((binding) => names.includes(`${binding.requestId}.json`) && !names.includes(`${binding.requestId}.result.json`));
      if (pending.length > 1) bindingConflict();
      // 先查原请求，再看当前选择；模型停用或改选不能遮蔽旧在途请求。
      const binding = pending[0] ?? bindings.find((item) => item.inputIdentity === inputIdentity && item.modelId === input.selectedAudioModelId
        && (item.reviewCycleId ?? "initial") === (input.reviewCycleId ?? "initial"));
      if (binding) {
        const selected = this.options.connections().find(({ model }) => model.id === binding.modelId);
        if (!selected) return { status: "uncertain", reason: "原声音审片接入暂不可用，请恢复原接入以核实原请求；没有向新模型提交。" };
        assertOwned();
        const restored = await this.restore(directory, binding, selected, assertOwned);
        if ((binding.inputIdentity !== inputIdentity || await audioInputIdentity(input, root) !== inputIdentity) && restored.status !== "uncertain") return {
          status: "not_reviewed", reason: "原声音请求已核清，但画面、音轨或脚本已经变更，旧意见不能沿用；本次没有购买新审查。",
        };
        return restored;
      }
      // 兼容旧prepared记录：无输入索引时只能用原模型重新构造同一证据身份，不能越过未核清记录换模型。
      for (const name of names.filter((name) => /^sound-[a-f0-9]{64}\.json$/.test(name))) {
        if (names.includes(name.replace(/\.json$/, ".result.json"))) continue;
        const operation = JSON.parse(await readFile(path.join(directory, name), "utf8")) as CodexPreparedOperation;
        if (operation.brokerBinding?.modelId !== input.selectedAudioModelId) return { status: "uncertain", reason: "旧声音请求尚未核清；请恢复原模型接入查询，不会自动切换模型。" };
      }
      assertOwned();
      return await this.executeReview(input, inputIdentity, assertOwned);
    } catch (error) {
      const disposition = classifyReviewDisposition(error);
      if (!inspectingRequests && disposition.evidence === "none" && (error as NodeJS.ErrnoException).code !== "ELOCKED") return {
        status: "failed", reason: "声音审片输入文件暂不可用；没有提交模型请求，已有成片和视觉意见保留。",
      };
      if (disposition.requestState === "not_accepted" || disposition.requestState === "settled") return {
        status: "failed", reason: "原声音审片请求已核清，但未取得可用结论；记录已保留，不会自动反复提交。",
      };
      return { status: "uncertain", reason: "声音审片原请求或证据尚未核实，记录已保留；不会自动切换模型或再次消费。" };
    } finally { await release?.(); }
  }

  /** 用户查询只观察已登记的原信封，不抽轨、不重建输入，也不补提交未受理请求。 */
  async observe(input: { runRoot: string; requestId: string }): Promise<AudioReviewObservation> {
    if (!/^sound-[a-f0-9]{64}$/.test(input.requestId)) throw new Error("Invalid original sound request identity.");
    let release: (() => Promise<void>) | undefined;
    let compromised = false;
    try {
      const root = await realpath(input.runRoot);
      const directory = await realpath(path.join(root, ".audio-review-requests"));
      if (!directory.startsWith(`${root}${path.sep}`)) bindingConflict();
      release = await lock(directory, { realpath: false, stale: 30_000, update: 10_000, retries: 0,
        onCompromised: () => { compromised = true; } });
      const operationPath = await realpath(path.join(directory, `${input.requestId}.json`));
      if (!operationPath.startsWith(`${directory}${path.sep}`)) bindingConflict();
      const operation = JSON.parse(await readFile(operationPath, "utf8")) as PersistedAudioOperation;
      const binding = operation.audioInputBinding;
      if (!binding) bindingConflict();
      validateInputBinding(binding, input.requestId);
      const selected = this.options.connections().find(({ model }) => model.id === binding.modelId);
      if (!selected) return { status: "uncertain", requestState: "unknown", reason: "原声音审片接入暂不可用；没有向其它模型提交。" };
      const result = await this.restore(directory, binding, selected, () => { if (compromised) bindingConflict(); }, false);
      const saved = await readPersistedResult(path.join(directory, `${binding.requestId}.result.json`));
      return { ...result, requestState: saved?.kind === "request_failed" ? saved.requestState! : "settled" };
    } catch (error) {
      const disposition = classifyReviewDisposition(error);
      return disposition.requestState === "not_accepted" || disposition.requestState === "settled"
        ? { status: "failed", requestState: disposition.requestState, reason: "原声音请求已核清但没有有效结论；本次仅查询，没有补提交。" }
        : { status: "uncertain", requestState: "unknown", reason: "原声音请求或绑定仍待核；本次仅查询，没有补提交。" };
    } finally { await release?.(); }
  }

  private async restore(directory: string, binding: AudioInputBinding, selected: ConnectedModel, assertOwned: () => void,
    allowResubmission = true): Promise<AudioReviewResult> {
    const resultPath = path.join(directory, `${binding.requestId}.result.json`);
    const saved = await readPersistedResult(resultPath);
    if (saved) return completedAudioResult(saved, binding, selected);
    const operation = JSON.parse(await readFile(path.join(directory, `${binding.requestId}.json`), "utf8")) as CodexPreparedOperation;
    if (operation.requestId !== binding.requestId || operation.kind !== "audio-review"
      || operation.brokerBinding.providerId !== binding.modelId || operation.brokerBinding.modelId !== binding.modelId) bindingConflict();
    let execution;
    try { execution = await selected.client.observePrepared(operation); }
    catch (error) {
      const disposition = classifyReviewDisposition(error);
      if (!allowResubmission || disposition.reasonCode !== "bridge_not_accepted" || !selected.model.enabled) {
        await persistRequestFailure(directory, binding, error, false);
        throw error;
      }
      const recoveryPath = path.join(directory, `${binding.requestId}.recovery.json`);
      let prior = 0;
      try {
        const recovery = JSON.parse(await readFile(recoveryPath, "utf8")) as { requestId?: string; resubmissions?: number };
        if (recovery.requestId !== binding.requestId || recovery.resubmissions !== 1) bindingConflict();
        prior = recovery.resubmissions;
      } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
      if (prior >= 1) {
        await persistRequestFailure(directory, binding, error, true);
        throw error;
      }
      // 联网前耐久限次；使用原序列化信封，不按当前参数重建一个请求。
      await persistAtomically(recoveryPath, JSON.stringify({ requestId: binding.requestId, resubmissions: 1 }));
      assertOwned();
      try { execution = await selected.client.submitPreparedIfUnaccepted(operation); }
      catch (error) { await persistRequestFailure(directory, binding, error, true); throw error; }
    }
    const persisted: PersistedAudioReviewResult = { version: "video-factory/audio-review-result-v1", kind: "completed",
      requestId: binding.requestId, modelId: binding.modelId, videoSha256: binding.videoSha256, audioSha256: binding.audioSha256,
      durationMs: binding.durationMs, completedAt: new Date().toISOString(), output: execution.output,
      ...(execution.trace ? { trace: execution.trace } : {}),
    };
    await persistAtomically(resultPath, JSON.stringify(persisted));
    const result = completedAudioResult(persisted, binding, selected);
    if (result.status === "failed") await persistAtomically(resultPath, JSON.stringify({ ...persisted, kind: "settled_unusable" }));
    return result;
  }

  private async executeReview(input: VisualReviewAgentInput, inputIdentity: string, assertOwned: () => void): Promise<AudioReviewResult> {
    const connections = this.options.connections();
    const selected = connections.find(({ model }) => model.id === input.selectedAudioModelId);
    if (!selected) return { status: "not_configured", reason: "尚未配置能直接听音轨并理解画面的模型。本次只有视觉意见，未完成声音审片。" };
    if (!selected.model.capabilities.includes("audio") || !selected.model.capabilities.includes("image")) {
      return { status: "not_reviewed", reason: "选定的声音审片接入已停用，或不具备音频与图像联合输入能力。未偷偷改用其他模型。" };
    }
    let temporary: string | undefined;
    let phase = "检查成片与脚本的文件边界";
    try {
      const root = await realpath(input.runRoot);
      if (!input.videoPath) throw new Error("No rendered video.");
      const video = await realpath(input.videoPath);
      if (!video.startsWith(`${root}${path.sep}`)) throw new Error("Unconfined audio input.");
      const videoHash = createHash("sha256");
      for await (const chunk of createReadStream(video)) videoHash.update(chunk);
      const videoSha256 = videoHash.digest("hex");
      temporary = await mkdtemp(path.join(root, ".audio-review-"));
      const output = path.join(temporary, "soundtrack.mp3");
      phase = "提取成片音轨（检查 ffmpeg 和成片是否包含音轨）";
      const lowLevelIntervals = await (this.options.extract ?? extractAudio)(video, output);
      const size = (await stat(output)).size;
      if (size < 4 || size > 5 * 1024 * 1024) return { status: "not_reviewed", reason: "音轨为空或超过单次审听大小上限；没有截断音轨冒充全片已审听。" };
      const audio = await readFile(output);
      const audioSha256 = sha(audio);
      phase = "准备声音审片的画面与脚本上下文";
      const media: VisualReviewMediaPayload = input.preparedMedia ?? await this.options.media.prepare(input);
      const scriptPath = input.scriptPath ? await realpath(input.scriptPath) : undefined;
      if (scriptPath && !scriptPath.startsWith(`${root}${path.sep}`)) throw new Error("Unconfined script input.");
      if (scriptPath && (await stat(scriptPath)).size > 192 * 1024) throw new Error("Audio review context is too large.");
      const script = scriptPath ? JSON.parse(await readFile(scriptPath, "utf8")) as unknown : undefined;
      const identityPayload = {
        durationMs: media.durationMs, audioSha256, audioBase64: audio.toString("base64"), frames: media.frames,
        reviewContext: { videoSha256, ...(script ? { script } : {}), evidenceBoundary: "实际成片混合音轨；画面仅为带时间码的抽帧，不支持确认逐帧口型同步。" },
      };
      // 新增的本地测量不能让部署后的恢复另开付费请求，旧证据身份仍优先查询原记录。
      const cycle = input.reviewCycleId && input.reviewCycleId !== "initial" ? input.reviewCycleId : undefined;
      const requestId = `sound-${sha(JSON.stringify({ model: selected.model.id, payload: identityPayload,
        ...(cycle ? { reviewCycleId: cycle } : {}) }))}`;
      const payload = {
        ...identityPayload,
        reviewContext: {
          ...identityPayload.reviewContext,
          audioEvidence: {
            attachmentType: "input_audio", format: "mp3",
            ...(lowLevelIntervals ? {
              measurement: "ffmpeg silencedetect; noise=-40dB; minimum=0.5s; mixed soundtrack, not speech recognition",
              lowLevelIntervals: lowLevelIntervals.map(({ startMs, endMs }) => ({ startMs, endMs: Math.min(endMs, media.durationMs) }))
                .filter(({ startMs, endMs }) => endMs > startMs),
            } : {}),
          },
        },
      };
      const directory = path.join(root, ".audio-review-requests");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const checkpointPath = path.join(directory, `${requestId}.json`);
      const resultPath = path.join(directory, `${requestId}.result.json`);
      phase = "读取声音审片原请求记录";
      let operation: CodexPreparedOperation | undefined;
      try { operation = JSON.parse(await readFile(checkpointPath, "utf8")) as CodexPreparedOperation; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // T06：已有耐久完成结果且绑定正确 → 直接读取，不查询、不调用模型。
      const persisted = await readPersistedResult(resultPath);
      const binding: AudioInputBinding = { version: "video-factory/audio-review-input-v1", inputIdentity, requestId,
        modelId: selected.model.id, videoSha256, audioSha256, durationMs: media.durationMs,
        ...(cycle ? { reviewCycleId: cycle } : {}) };
      if (persisted) return completedAudioResult(persisted, binding, selected);
      if (!operation && !selected.model.enabled) return { status: "not_reviewed", reason: "声音审片接入已停用，没有提交新请求；重新启用后可审听。" };
      const submit = () => selected.client.runTaskDetailed("audio-review", payload, requestId, undefined, {
        model: selected.model.id,
        beforeSubmit: async (prepared) => {
          assertOwned();
          if (await audioInputIdentity(input, root) !== inputIdentity) bindingConflict();
          await persistAtomically(checkpointPath, JSON.stringify({ ...prepared, audioInputBinding: binding } satisfies PersistedAudioOperation));
          await persistAtomically(path.join(directory, `${requestId}.input.json`), JSON.stringify(binding));
        },
      });
      // 恢复先查询原身份；只有服务端证明未受理，才可提交相同请求，不开新请求重试。
      phase = "请求或恢复声音审片";
      if (operation) {
        await persistAtomically(path.join(directory, `${requestId}.input.json`), JSON.stringify(binding));
        return await this.restore(directory, binding, selected, assertOwned);
      }
      let execution;
      try { execution = await submit(); }
      catch (error) { await persistRequestFailure(directory, binding, error, false); throw error; }
      // T06：模型返回后先耐久保存完成事实与原始结果，再做宿主校验；
      // 校验失败转为 settled/unusable 并耐久保留，普通恢复不自动重审。
      const completedAt = new Date().toISOString();
      await persistAtomically(resultPath, JSON.stringify({
        version: "video-factory/audio-review-result-v1",
        kind: "completed", requestId, modelId: selected.model.id,
        videoSha256, audioSha256, durationMs: media.durationMs, completedAt,
        ...(execution.trace ? { trace: execution.trace } : {}), output: execution.output,
      } satisfies PersistedAudioReviewResult));
      if (!execution.trace || execution.trace.modelId !== selected.model.id || execution.trace.providerId !== selected.model.id) bindingConflict();
      if (await audioInputIdentity(input, root) !== inputIdentity) return { status: "not_reviewed",
        reason: "本次声音报告已保存，但送审期间成片或脚本发生变化，旧意见不能沿用。没有自动购买新审查。" };
      phase = "校验声音报告的音轨绑定与时间范围";
      let report;
      try {
        report = validateAudioReviewReport(execution.output, audioSha256, media.durationMs);
      } catch (error) {
        const validationError = error instanceof Error ? error.message : String(error);
        await persistAtomically(resultPath, JSON.stringify({
          version: "video-factory/audio-review-result-v1",
          kind: "settled_unusable", requestId, modelId: selected.model.id,
          videoSha256, audioSha256, durationMs: media.durationMs, completedAt,
          trace: execution.trace, output: execution.output, validationError,
        } satisfies PersistedAudioReviewResult));
        return { status: "failed", reason: `声音审片请求已完整返回，但报告未通过宿主校验（settled，无有效结论）。原始返回已保留；恢复不会自动重审。诊断：${validationError}` };
      }
      return {
        status: "completed", modelId: selected.model.id, modelLabel: `${selected.model.label} · ${selected.model.modelId}`,
        videoSha256, audioSha256, durationMs: media.durationMs,
        report, observationCoverage: audioReviewObservationCoverage(report), trace: execution.trace,
      };
    } catch (error) {
      const disposition = classifyReviewDisposition(error);
      if (disposition.evidence !== "none" || phase === "请求或恢复声音审片") return {
        status: disposition.requestState === "unknown" ? "uncertain" : "failed",
        reason: disposition.requestState === "unknown" ? "声音审片请求结果待核实，已保存原请求；不会自动更换模型或重新消费。" : "声音审片未完成，模型服务未返回可验证的报告。原请求和证据已保留，不影响查看视觉意见。",
      };
      return { status: "failed", reason: `${phase}失败；未判定审听通过。视觉意见仍可查看，不会自动重新生成素材。` };
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
}

async function persistRequestFailure(directory: string, binding: AudioInputBinding, error: unknown, resubmissionUsed: boolean): Promise<void> {
  const disposition = classifyReviewDisposition(error);
  const failureDetails = boundFailureDetails(error, binding);
  // 诊断只记录安全事实；不把原始异常/服务端响应里的账户信息写进用户报告。
  await persistAtomically(path.join(directory, `${binding.requestId}.failure.json`), JSON.stringify({
    version: "video-factory/audio-review-failure-v1", requestId: binding.requestId, modelId: binding.modelId,
    requestState: disposition.requestState, bindingState: disposition.bindingState, reasonCode: disposition.reasonCode,
    ...(failureDetails ? { failureDetails } : {}),
  }));
  if (disposition.requestState === "settled" || disposition.requestState === "not_accepted" && resubmissionUsed) {
    await persistAtomically(path.join(directory, `${binding.requestId}.result.json`), JSON.stringify({
      version: "video-factory/audio-review-result-v1", kind: "request_failed", requestState: disposition.requestState,
      requestId: binding.requestId, modelId: binding.modelId, videoSha256: binding.videoSha256, audioSha256: binding.audioSha256,
      durationMs: binding.durationMs, completedAt: new Date().toISOString(),
      ...(failureDetails ? { failureDetails } : {}),
    } satisfies PersistedAudioReviewResult));
  }
}

function boundFailureDetails(error: unknown, binding: AudioInputBinding): SafeAudioFailureDetails | undefined {
  const seen = new Set<unknown>();
  for (let current = error, depth = 0; current instanceof Error && depth < 6 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current);
    const details = current instanceof CodexBridgeError ? current.failureDetails : undefined;
    if (!details || details.providerId !== binding.modelId || details.modelId !== binding.modelId
      || (details.brokerRequestIdHash ?? details.requestIdHash) !== sha(binding.requestId)) continue;
    const safe: SafeAudioFailureDetails = { providerId: details.providerId, modelId: details.modelId,
      ...(details.requestIdHash ? { requestIdHash: details.requestIdHash } : {}) };
    // 旧拒收回执只有requestIdHash；仅在恰好匹配原请求时沿用，不把供应方编号猜成宿主编号。
    safe.brokerRequestIdHash = sha(binding.requestId);
    if (typeof details.accepted === "boolean") safe.accepted = details.accepted;
    for (const key of ["modelAttemptCount", "structuredRepairCount", "providerWaitMs", "queueWaitMs"] as const) {
      const value = details[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
    }
    return safe;
  }
  return undefined;
}

async function audioInputIdentity(input: VisualReviewAgentInput, root: string): Promise<string> {
  const files: Record<string, string> = {};
  for (const key of ["videoPath", "scriptPath", "renderManifestPath", "executablePlanPath"] as const) {
    const candidate = input[key];
    if (!candidate) continue;
    const file = await realpath(candidate);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Unconfined audio context.");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    files[key] = digest.digest("hex");
  }
  return sha(JSON.stringify({ files, scenePositions: input.scenePositions ?? null,
    preparedMedia: input.preparedMedia ? sha(JSON.stringify(input.preparedMedia)) : null }));
}

async function extractAudio(video: string, output: string): Promise<LowLevelInterval[]> {
  // 检测滤镜不改变音轨或时间线；测量只辅助定位，不能代替听感或判定有意留白。
  const { stderr } = await execFile("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "info", "-i", video, "-map", "0:a:0", "-vn", "-af", "silencedetect=noise=-40dB:d=0.5", "-c:a", "libmp3lame", "-b:a", "128k", output], {
    timeout: 120_000, maxBuffer: 64 * 1024,
  });
  const intervals: LowLevelInterval[] = [];
  let startMs: number | undefined;
  for (const match of stderr.matchAll(/silence_(start|end):\s*(\d+(?:\.\d+)?)/g)) {
    const timeMs = Math.round(Number(match[2]) * 1000);
    if (match[1] === "start") startMs = timeMs;
    else if (startMs !== undefined && timeMs > startMs) {
      intervals.push({ startMs, endMs: timeMs });
      startMs = undefined;
    }
  }
  return intervals;
}
