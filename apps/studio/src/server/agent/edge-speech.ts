import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  Bootstrap,
  DubbedSpeechMeta,
  ExecutionInput,
  ExecutionObservation,
  InputRef,
  MarkdownContent,
  ModelBinding,
  RecoveryQuery,
  SpeechBoundary,
} from "../../shared/agent/generated/contracts.js";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import { speechText } from "../../shared/agent/markdown.js";
import { AgentError, AgentToolError } from "./errors.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { getRevisionRow, type QuoteCatalogEntry } from "./artifact-store.js";
import { DEFAULT_EDGE_TTS_VOICE, edgeTtsPythonCommand } from "./free-service-settings.js";
import { PortObservations, withAttemptFiles, withZeroCostBilling } from "./media-port-support.js";
import { InvalidAudioFile, probeAudioFile } from "./media-probe.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { canonicalJson, digestOf, type AgentClock } from "./util.js";

export const EDGE_TTS_VOICE_PATTERN = /^[a-z]{2}-[A-Za-z]{2}-[A-Za-z0-9]{1,64}$/;
export const EDGE_TTS_RATE_PATTERN = /^[+-]\d{1,3}%$/;
const EDGE_MAX_DURATION_MS = 120_000;

export const EDGE_TTS_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 中文女声" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 中文男声" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 新闻播报" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 活泼女声" },
  { id: "en-US-AriaNeural", label: "Aria · 英文女声" },
  { id: "en-US-GuyNeural", label: "Guy · 英文男声" },
];

export function edgeVoiceOptions(
  defaultVoice: string = DEFAULT_EDGE_TTS_VOICE,
): [{ id: string; label: string }, ...{ id: string; label: string }[]] {
  const list = [...EDGE_TTS_VOICES];
  if (defaultVoice && !list.some(item => item.id === defaultVoice)) {
    list.unshift({ id: defaultVoice, label: defaultVoice });
  }
  return list as [{ id: string; label: string }, ...{ id: string; label: string }[]];
}

export function edgeVoiceLabel(voiceId: string): string {
  return EDGE_TTS_VOICES.find(item => item.id === voiceId)?.label ?? voiceId;
}

const EDGE_CONFIGURATION_REVISION_ID = `cfg-${digestOf({
  providerId: "edge-tts",
  modelId: "edge-tts",
  connectionId: "free-service-edge-tts",
  format: "mp3",
}).slice(0, 24)}`;

export const EDGE_SPEECH_BINDING: ModelBinding = {
  providerId: "edge-tts",
  modelId: "edge-tts",
  connectionId: "free-service-edge-tts",
  configurationRevisionId: EDGE_CONFIGURATION_REVISION_ID,
};

export function isEdgeSpeechBinding(binding: ModelBinding | null | undefined): boolean {
  return Boolean(binding && canonicalJson(binding) === canonicalJson(EDGE_SPEECH_BINDING));
}

export function edgeSpeechCatalogEntry(defaultVoice: string, isDefault: boolean): QuoteCatalogEntry {
  return {
    binding: EDGE_SPEECH_BINDING,
    quoteMinor: 0,
    priceKind: "bounded",
    maxCreateAttempts: 1,
    outputDurationBoundMs: EDGE_MAX_DURATION_MS,
    estimateNote: "Edge 免费配音不产生媒体供应商人民币费用（¥0.00），生成 MP3 与词级时间边界。",
    poolMeta: {
      kind: "speech",
      isDefault,
      connectionName: "免费服务",
      modelName: "Edge 免费配音",
      costSummary: "¥0.00 免费配音",
      defaultVoiceId: defaultVoice,
    },
    validate: (op, inputs) => {
      if (op.kind !== "speech") throw new AgentError("CAPABILITY_UNAVAILABLE", "该目录条目只支持 speech 操作。");
      if (op.maxCreateAttempts !== 1) throw new AgentError("INVALID_INPUT", "本通道每个操作只允许一次创建尝试。");
      if (op.parameters.format !== "mp3" || !EDGE_TTS_VOICE_PATTERN.test(op.parameters.voiceId)) {
        throw new AgentError("CAPABILITY_UNAVAILABLE", "Edge 免费配音仅支持合法 Neural 声线标识与 mp3 输出格式。");
      }
      if (op.parameters.rate !== undefined && !EDGE_TTS_RATE_PATTERN.test(op.parameters.rate)) {
        throw new AgentError("INVALID_INPUT", "Edge 免费配音语速格式须如 +0%、+10% 或 -5%。");
      }
      if (!inputs) return;
      const input = inputs[0];
      if (op.inputs.length !== 1 || !input || (input.kind !== "text" && (input.kind !== "artifact_revision" || input.content.format !== "markdown"))) {
        throw new AgentError("INVALID_INPUT", "该配音通道只接受一份旁白文本作为输入。");
      }
    },
  };
}

export function edgeSpeechModelView(defaultVoice: string, isDefault: boolean): Bootstrap["models"][number] {
  return {
    binding: EDGE_SPEECH_BINDING,
    name: "Edge 免费配音",
    kind: "speech",
    features: [
      "text-to-speech",
      defaultVoice,
      "mp3",
      "词级时间边界",
      "≤1000 码点",
      isDefault ? "当前默认配音" : "可按本次选择",
    ],
    availability: "configured",
    verificationNote: `免费配音（edge-tts）：默认音色 ${edgeVoiceLabel(defaultVoice)}，输出 MP3 与词级时间边界，自动衔接字幕审阅；费用 ¥0.00。`,
    isDefault,
    connectionName: "免费服务",
    costSummary: "¥0.00 免费配音",
    defaultVoiceId: defaultVoice,
    voices: edgeVoiceOptions(defaultVoice),
  };
}

// 经同一包（edge-tts 维护版）已验证的 Python API 取音频与词级边界，stdin JSON → stdout JSON。
export const DUB_DRIVER_PYTHON = `
import asyncio, json, os, sys
from urllib.parse import urlsplit
from urllib.request import proxy_bypass_environment
import edge_tts
from edge_tts.constants import WSS_URL

async def main():
    request = json.loads(sys.stdin.read())
    proxy = next((os.environ[name] for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy") if name in os.environ), None)
    no_proxy = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
    if proxy_bypass_environment(urlsplit(WSS_URL).hostname, {"no": no_proxy}):
        proxy = None
    communicate = edge_tts.Communicate(request["text"], request["voice"], rate=request["rate"], boundary="WordBoundary", proxy=proxy or None)
    boundaries = []
    with open(sys.argv[1], "xb") as audio:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                boundaries.append({
                    "text": chunk["text"],
                    "offsetMs": round(chunk["offset"] / 1e4),
                    "durationMs": round(chunk["duration"] / 1e4),
                })
    sys.stdout.write(json.dumps({"boundaries": boundaries}))

asyncio.run(main())
`;

const runDubPython = promisify(execFile);

export type DubDriverRunner = (
  outputFile: string,
  payload: { text: string; voice: string; rate: string },
  pythonCommand: string,
  signal?: AbortSignal,
) => Promise<{ boundaries: SpeechBoundary[] }>;

export async function defaultDubDriverRunner(
  outputFile: string,
  payload: { text: string; voice: string; rate: string },
  pythonCommand: string,
  signal?: AbortSignal,
): Promise<{ boundaries: SpeechBoundary[] }> {
  let stdout: string;
  try {
    const pending = runDubPython(pythonCommand, ["-I", "-c", DUB_DRIVER_PYTHON, outputFile], {
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });
    pending.child.stdin?.on("error", () => {});
    pending.child.stdin?.end(JSON.stringify(payload));
    ({ stdout } = await pending);
  } catch (error) {
    if ((error as Error).name === "AbortError" || signal?.aborted) throw error;
    const stderr = ((error as { stderr?: string | Buffer }).stderr ?? "").toString().trim();
    const detail = stderr || (error as Error).message;
    throw new AgentToolError("TEMPORARILY_UNAVAILABLE", `免费配音调用失败：${detail.slice(-400)}`);
  }
  const parsed = JSON.parse(stdout) as { boundaries?: unknown };
  const boundaries = (Array.isArray(parsed.boundaries) ? parsed.boundaries : []).map((item): SpeechBoundary => {
    const boundary = item as { text?: unknown; offsetMs?: unknown; durationMs?: unknown };
    if (
      typeof boundary.text !== "string" ||
      !boundary.text ||
      !Number.isInteger(boundary.offsetMs) ||
      !Number.isInteger(boundary.durationMs)
    ) {
      throw new AgentToolError("TEMPORARILY_UNAVAILABLE", "免费配音返回的边界数据形状不正确。");
    }
    return { text: boundary.text, offsetMs: boundary.offsetMs as number, durationMs: boundary.durationMs as number };
  });
  return { boundaries };
}

interface StoredEdgeAttemptDetail {
  summary: string;
  dub: DubbedSpeechMeta;
}

export function parseEdgeAttemptDub(detail: string | null | undefined): DubbedSpeechMeta | null {
  if (!detail || !detail.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(detail) as Partial<StoredEdgeAttemptDetail>;
    if (parsed.dub && typeof parsed.dub.text === "string" && Array.isArray(parsed.dub.boundaries)) {
      return parsed.dub;
    }
  } catch {
    // 非 JSON 详情按普通文本忽略。
  }
  return null;
}

function parseEdgeAttemptSummary(detail: string | null | undefined): string | null {
  if (!detail) return null;
  if (!detail.startsWith("{")) return detail;
  try {
    const parsed = JSON.parse(detail) as Partial<StoredEdgeAttemptDetail>;
    return typeof parsed.summary === "string" ? parsed.summary : detail;
  } catch {
    return detail;
  }
}

export interface EdgeSpeechPortOptions {
  workRoot: string;
  runner?: DubDriverRunner;
  pythonCommand?: () => string;
}

export class EdgeSpeechPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;
  private readonly runner: DubDriverRunner;

  constructor(
    private readonly db: AgentDatabase,
    private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock,
    private readonly options: EdgeSpeechPortOptions,
  ) {
    this.observations = new PortObservations(db, clock, "edge-tts");
    this.runner = options.runner ?? defaultDubDriverRunner;
  }

  async submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "speech") throw new Error("Edge 免费配音通道只接受 speech 操作。");
    if (signal?.aborted) {
      return withZeroCostBilling(
        this.observations.deterministic(input.attemptId, "cancelled", null, "停止请求发生在请求发出之前；未提交任何请求。"),
      );
    }
    if (!isEdgeSpeechBinding(input.operation.model)) {
      return withZeroCostBilling(
        this.observations.deterministic(input.attemptId, "failed", null, "免费配音绑定身份不一致，未提交请求。"),
      );
    }
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const text =
      ref.kind === "text"
        ? ref.text
        : speechText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const voice = input.operation.parameters.voiceId;
    const rate = input.operation.parameters.rate ?? "+0%";
    let pythonCommand: string;
    try {
      pythonCommand = this.options.pythonCommand ? this.options.pythonCommand() : edgeTtsPythonCommand();
    } catch (error) {
      return withZeroCostBilling(
        this.observations.deterministic(
          input.attemptId,
          "failed",
          null,
          error instanceof Error ? error.message : "配音解释器配置不可用。",
        ),
      );
    }
    return withAttemptFiles(this.db, this.options.workRoot, input.attemptId, async () => {
      const attemptDir = path.join(this.options.workRoot, input.attemptId);
      const temporary = path.join(attemptDir, "speech.mp3.part");
      const finalFile = path.join(attemptDir, "speech.mp3");
      await mkdir(attemptDir, { recursive: true, mode: 0o700 });
      await rm(temporary, { force: true });
      let boundaries: SpeechBoundary[];
      try {
        ({ boundaries } = await this.runner(temporary, { text, voice, rate }, pythonCommand, signal));
      } catch (error) {
        await rm(temporary, { force: true });
        if ((error as Error).name === "AbortError" || signal?.aborted) {
          return withZeroCostBilling(
            this.observations.deterministic(input.attemptId, "cancelled", null, "本地已停止等待免费配音生成。"),
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return withZeroCostBilling(this.observations.deterministic(input.attemptId, "failed", null, message));
      }
      if (!existsSync(temporary) || !(await stat(temporary)).size) {
        await rm(temporary, { force: true });
        return withZeroCostBilling(
          this.observations.deterministic(input.attemptId, "failed", null, "免费配音没有返回音频数据。"),
        );
      }
      await rename(temporary, finalFile);
      return this.settleSpeech(input.attemptId, { text, voice, rate, boundaries });
    });
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          return withZeroCostBilling(
            this.observations.deterministicSucceeded(
              query.attemptId,
              null,
              blob.id,
              blob.digest,
              "audio/mpeg",
              parseEdgeAttemptSummary(receipt.detail) ?? "免费配音成品收据核对通过。",
            ),
          );
        } catch {
          // 成品缺失继续按本地证据分支核对。
        }
      }
    }
    if (receipt?.exit_kind === "failed") {
      return withZeroCostBilling(
        this.observations.deterministic(
          query.attemptId,
          "failed",
          null,
          parseEdgeAttemptSummary(receipt.detail) ?? "免费配音未通过本地音频校验。",
        ),
      );
    }
    return this.observations.stableUnknown(query.attemptId, "单次免费配音没有可外查的任务身份；不会重复提交。");
  }

  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  private async settleSpeech(
    attemptId: string,
    dubInput: { text: string; voice: string; rate: string; boundaries: SpeechBoundary[] },
  ): Promise<ExecutionObservation> {
    const finalFile = path.join(this.options.workRoot, attemptId, "speech.mp3");
    try {
      const facts = await probeAudioFile(finalFile);
      if (facts.mimeType !== "audio/mpeg") {
        throw new InvalidAudioFile(`免费配音输出不是 MP3（${facts.mimeType}）。`);
      }
      if (facts.durationMs <= 0 || facts.durationMs > EDGE_MAX_DURATION_MS) {
        throw new InvalidAudioFile(`免费配音时长 ${(facts.durationMs / 1000).toFixed(1)}s 超出 120s 上限。`);
      }
      const row = this.db.prepare("SELECT run_id FROM production_attempts WHERE id=?").get(attemptId) as { run_id: string };
      const run = runRow(this.db, row.run_id);
      const blob = await this.blobs.persistFromFileAsync(run.owner_id, run.conversation_id, finalFile, "audio/mpeg", facts.durationMs);
      const granularity: DubbedSpeechMeta["granularity"] = dubInput.boundaries.length ? "word" : "none";
      const summary = `免费配音 ${(facts.durationMs / 1000).toFixed(1)} 秒（${edgeVoiceLabel(dubInput.voice)}）`;
      const detail = canonicalJson({
        summary,
        dub: {
          text: dubInput.text,
          voice: dubInput.voice,
          rate: dubInput.rate,
          granularity,
          boundaries: dubInput.boundaries,
        },
      } satisfies StoredEdgeAttemptDetail);
      this.db.transaction(() =>
        recordAttemptOutput(this.db, this.clock(), attemptId, {
          blobId: blob.id,
          digest: blob.digest,
          exitKind: "completed",
          detail,
          usage: { mediaDurationMs: facts.durationMs, characters: [...dubInput.text].length },
        }),
      )();
      return withZeroCostBilling(
        this.observations.deterministicSucceeded(attemptId, null, blob.id, blob.digest, "audio/mpeg", summary),
      );
    } catch (error) {
      if (error instanceof InvalidAudioFile) {
        await rm(finalFile, { force: true });
        return withZeroCostBilling(this.observations.nonCompliant(attemptId, null, error.message));
      }
      return this.observations.stableUnknown(
        attemptId,
        `免费配音文件已取得，本地校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留文件继续核对。`,
      );
    }
  }
}
