import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexBridgeError, validateAudioReviewReport, type AudioReviewResult, type CodexPreparedOperation, type VisualReviewAgent, type VisualReviewAgentInput, type VisualReviewMediaPreprocessor, type VisualReviewMediaPayload } from "@video-factory/production-pipeline";
import type { ConnectedModel } from "./model-connections.js";

const execFile = promisify(execFileCallback);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export class AudioReviewService {
  constructor(private readonly options: {
    connections: () => ConnectedModel[];
    media: VisualReviewMediaPreprocessor;
    extract?: (video: string, output: string) => Promise<void>;
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
    const execution = agent.reviewDetailed ? await agent.reviewDetailed(input) : { output: await agent.review(input) };
    if (input.reviewStage === "source_assets" || !input.videoPath) return execution;
    const audioReview = await this.review(input);
    return { ...execution, audioReview };
  }

  async review(input: VisualReviewAgentInput): Promise<AudioReviewResult> {
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
      await (this.options.extract ?? extractAudio)(video, output);
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
      const payload = {
        durationMs: media.durationMs, audioSha256, audioBase64: audio.toString("base64"), frames: media.frames,
        reviewContext: { videoSha256, ...(script ? { script } : {}), evidenceBoundary: "实际成片混合音轨；画面仅为带时间码的抽帧，不支持确认逐帧口型同步。" },
      };
      const requestId = `sound-${sha(JSON.stringify({ model: selected.model.id, payload }))}`;
      const directory = path.join(root, ".audio-review-requests");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const checkpointPath = path.join(directory, `${requestId}.json`);
      phase = "读取声音审片原请求记录";
      let operation: CodexPreparedOperation | undefined;
      try { operation = JSON.parse(await readFile(checkpointPath, "utf8")) as CodexPreparedOperation; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!operation && !selected.model.enabled) return { status: "not_reviewed", reason: "声音审片接入已停用，没有提交新请求；重新启用后可审听。" };
      const submit = () => selected.client.runTaskDetailed("audio-review", payload, requestId, undefined, {
        model: selected.model.id,
        beforeSubmit: async (prepared) => {
          const staging = `${checkpointPath}.${randomBytes(6).toString("hex")}.tmp`;
          try {
            await writeFile(staging, JSON.stringify(prepared), { mode: 0o600, flag: "wx" });
            await rename(staging, checkpointPath);
          } finally { await rm(staging, { force: true }); }
        },
      });
      // 恢复先查询原身份；只有服务端证明未受理，才可提交相同请求，不开新请求重试。
      phase = "请求或恢复声音审片";
      const execution = operation ? await selected.client.observePrepared(operation).catch((error: unknown) => {
        if (error instanceof CodexBridgeError && error.stage === "not_accepted" && selected.model.enabled) return submit();
        throw error;
      }) : await submit();
      if (!execution.trace || execution.trace.modelId !== selected.model.id || execution.trace.providerId !== selected.model.id) throw new Error("Audio review execution identity mismatch.");
      phase = "校验声音报告的音轨绑定与时间范围";
      return {
        status: "completed", modelId: selected.model.id, modelLabel: `${selected.model.label} · ${selected.model.modelId}`,
        videoSha256, audioSha256, durationMs: media.durationMs,
        report: validateAudioReviewReport(execution.output, audioSha256, media.durationMs), trace: execution.trace,
      };
    } catch (error) {
      if (error instanceof CodexBridgeError) return {
        status: error.stage === "uncertain" ? "uncertain" : "failed",
        reason: error.stage === "uncertain" ? "声音审片请求结果待核实，已保存原请求；不会自动更换模型或重新消费。" : `声音审片未完成（${error.stage}）。原请求和证据已保留，不影响查看视觉意见。`,
      };
      return { status: "failed", reason: `${phase}失败；未判定审听通过。视觉意见仍可查看，不会自动重新生成素材。` };
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
}

async function extractAudio(video: string, output: string): Promise<void> {
  await execFile("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", video, "-map", "0:a:0", "-vn", "-c:a", "libmp3lame", "-b:a", "128k", output], {
    timeout: 120_000, maxBuffer: 64 * 1024,
  });
}
