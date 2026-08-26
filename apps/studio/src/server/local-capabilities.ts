import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  StudioArtifactResource,
  StudioLocalCapability,
  StudioMasteringPreset,
  StudioVoicePreviewInput,
  StudioVoiceProfile,
} from "../shared/api.js";

const execFileAsync = promisify(execFile);
const CURATED_MACOS_VOICES = new Set(["Tingting", "Meijia", "Sinji", "Sandy", "Shelley", "Reed"]);
const MINIMAX_VOICES: StudioVoiceProfile[] = [
  { id: "minimax:Chinese (Mandarin)_News_Anchor", providerId: "minimax-tts-v1", label: "新闻女声", locale: "zh-CN", engine: "minimax", gender: "female", curated: true, description: "专业、清晰，适合新闻解释与知识内容" },
  { id: "minimax:Chinese (Mandarin)_Reliable_Executive", providerId: "minimax-tts-v1", label: "沉稳高管", locale: "zh-CN", engine: "minimax", gender: "male", curated: true, description: "稳重可信，适合理性叙事与商业内容" },
  { id: "minimax:male-qn-qingse", providerId: "minimax-tts-v1", label: "青涩青年", locale: "zh-CN", engine: "minimax", gender: "male", curated: true, description: "年轻自然，适合生活方式与轻知识" },
  { id: "minimax:male-qn-jingying", providerId: "minimax-tts-v1", label: "精英青年", locale: "zh-CN", engine: "minimax", gender: "male", curated: true, description: "清楚利落，适合科技与职场" },
  { id: "minimax:male-qn-daxuesheng", providerId: "minimax-tts-v1", label: "大学生男声", locale: "zh-CN", engine: "minimax", gender: "male", description: "轻松亲近，适合校园与年轻议题" },
  { id: "minimax:female-shaonv", providerId: "minimax-tts-v1", label: "少女音色", locale: "zh-CN", engine: "minimax", gender: "female", description: "明亮活泼，适合轻快内容" },
  { id: "minimax:female-yujie", providerId: "minimax-tts-v1", label: "御姐音色", locale: "zh-CN", engine: "minimax", gender: "female", curated: true, description: "有力量感，适合观点与故事" },
  { id: "minimax:female-chengshu", providerId: "minimax-tts-v1", label: "成熟女声", locale: "zh-CN", engine: "minimax", gender: "female", curated: true, description: "温和稳定，适合纪录与人文" },
  { id: "minimax:female-tianmei", providerId: "minimax-tts-v1", label: "甜美女声", locale: "zh-CN", engine: "minimax", gender: "female", description: "轻盈友好，适合美食与生活" },
];

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutionOptions {
  timeoutMs?: number;
}

export interface LocalCapabilityServiceOptions {
  repositoryRoot: string;
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  commandAvailable?: (command: string) => Promise<boolean>;
  runCommand?: (command: string, args: string[], execution?: CommandExecutionOptions) => Promise<CommandResult>;
  pathExists?: (target: string) => Promise<boolean>;
  fetcher?: typeof fetch;
}

export class LocalCapabilityService {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly commandAvailable: (command: string) => Promise<boolean>;
  private readonly runCommand: (
    command: string,
    args: string[],
    execution?: CommandExecutionOptions,
  ) => Promise<CommandResult>;
  private readonly pathExists: (target: string) => Promise<boolean>;
  private readonly fetcher: typeof fetch;
  private readonly previewInFlight = new Map<string, Promise<StudioArtifactResource | undefined>>();
  private previewBudgetQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalCapabilityServiceOptions) {
    this.environment = options.environment ?? process.env;
    this.commandAvailable = options.commandAvailable ?? defaultCommandAvailable;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async listVoices(): Promise<StudioVoiceProfile[]> {
    let profiles: StudioVoiceProfile[] = [];
    if (await this.commandAvailable("say")) {
      try {
        profiles = parseMacOSVoiceList((await this.runCommand("say", ["-v", "?"])).stdout);
      } catch {
        profiles = [];
      }
    }
    return this.environment.MINIMAX_API_KEY ? [...MINIMAX_VOICES, ...profiles] : profiles;
  }

  async report(): Promise<StudioLocalCapability[]> {
    const [python, ffmpeg, ffprobe, say, docker, voices] = await Promise.all([
      this.commandAvailable("python3"),
      this.commandAvailable("ffmpeg"),
      this.commandAvailable("ffprobe"),
      this.commandAvailable("say"),
      this.commandAvailable("docker"),
      this.listVoices(),
    ]);
    const pythonRoot = this.pythonRuntimeRoot();
    const macosVoiceCount = voices.filter((voice) => voice.engine === "macos").length;
    const [projectPython, projectPythonReady] = await Promise.all([
      this.pathExists(path.join(pythonRoot, ".venv", "bin", "python")),
      this.pathExists(path.join(pythonRoot, "python.ready.json")),
    ]);
    return [
      runtimeCapability(
        "python",
        "Python worker",
        projectPython && projectPythonReady || python,
        projectPython && projectPythonReady ? "项目 Python 3.11 与 Pillow 已通过烟雾测试" : "python3 可执行文件",
      ),
      runtimeCapability("ffmpeg", "FFmpeg 音视频引擎", ffmpeg && ffprobe, ffmpeg && ffprobe ? "ffmpeg 与 ffprobe 均可用" : "需要 ffmpeg 与 ffprobe"),
      runtimeCapability("docker", "Docker 本地服务", docker, docker ? "Docker CLI 已安装" : "未发现 Docker CLI"),
      {
        id: "macos-voices",
        label: "macOS 中文音色",
        category: "voice",
        state: say && macosVoiceCount > 0 ? "ready" : "missing",
        evidence: say ? `发现 ${macosVoiceCount} 个中文音色` : "未发现 macOS say",
      },
      {
        id: "minimax-tts",
        label: "MiniMax 云端声音演员",
        category: "voice",
        state: this.environment.MINIMAX_API_KEY ? "ready" : "missing",
        evidence: this.environment.MINIMAX_API_KEY ? `已配置 ${MINIMAX_VOICES.length} 个精选中文音色` : "需要 MINIMAX_API_KEY",
      },
    ];
  }

  async preview(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined> {
    const profile = (await this.listVoices()).find((candidate) => candidate.id === input.profileId);
    if (!profile) return undefined;
    const identity = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
    const inFlight = this.previewInFlight.get(identity);
    if (inFlight) return inFlight;
    const rendering = this.renderPreview(input, profile, identity);
    this.previewInFlight.set(identity, rendering);
    try {
      return await rendering;
    } finally {
      if (this.previewInFlight.get(identity) === rendering) this.previewInFlight.delete(identity);
    }
  }

  private async renderPreview(
    input: StudioVoicePreviewInput,
    profile: StudioVoiceProfile,
    identity: string,
  ): Promise<StudioArtifactResource> {
    const previewRoot = path.join(this.options.workspaceRoot, "previews", "voices");
    const outputPath = path.join(previewRoot, `${identity}.m4a`);
    if (await this.pathExists(outputPath)) return audioResource(outputPath);

    await mkdir(previewRoot, { recursive: true });
    const isMiniMax = profile.providerId === "minimax-tts-v1";
    const rawPath = path.join(previewRoot, `${identity}.${isMiniMax ? "mp3" : "aiff"}`);
    try {
      if (isMiniMax) {
        await this.reserveCloudVoicePreview(identity);
        await writeFile(rawPath, await requestMiniMaxPreview(this.fetcher, this.environment, {
          text: input.text,
          voiceId: profile.id.slice("minimax:".length),
          rate: input.rate,
          pauseScale: input.pauseScale,
        }));
      } else {
        await this.runCommand("say", [
          "-v",
          profile.label,
          "-r",
          String(Math.round(input.rate)),
          "-o",
          rawPath,
          withDirectedPauses(input.text, input.pauseScale),
        ]);
      }
      await this.runCommand("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        rawPath,
        "-af",
        masteringFilter(input.masteringPreset),
        "-ar",
        "44100",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        outputPath,
      ]);
      return audioResource(outputPath);
    } finally {
      await rm(rawPath, { force: true });
    }
  }

  private pythonRuntimeRoot(): string {
    return this.environment.VIDEO_FACTORY_PYTHON_RUNTIME
      ? path.resolve(this.environment.VIDEO_FACTORY_PYTHON_RUNTIME)
      : path.join(this.options.repositoryRoot, ".local", "python");
  }

  private async reserveCloudVoicePreview(identity: string): Promise<void> {
    const previous = this.previewBudgetQueue;
    let release!: () => void;
    this.previewBudgetQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const limit = positiveInteger(this.environment.VIDEO_FACTORY_MAX_CLOUD_VOICE_PREVIEWS_PER_HOUR, 12);
      const ledgerPath = path.join(this.options.workspaceRoot, "budgets", "cloud-voice-previews.json");
      const cutoff = Date.now() - 60 * 60 * 1000;
      let entries: Array<{ identity: string; at: number }> = [];
      try {
        const parsed = JSON.parse(await readFile(ledgerPath, "utf8")) as { entries?: Array<{ identity?: unknown; at?: unknown }> };
        entries = (parsed.entries ?? []).flatMap((entry) => {
          return typeof entry.identity === "string" && typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at >= cutoff
            ? [{ identity: entry.identity, at: entry.at }]
            : [];
        });
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw new Error("云端声音试听预算记录无法读取，请检查工作区权限。");
      }
      if (entries.length >= limit) {
        throw new Error(`云端声音试听已达到每小时 ${limit} 次的安全上限，请稍后再试。`);
      }
      entries.push({ identity, at: Date.now() });
      await mkdir(path.dirname(ledgerPath), { recursive: true });
      const temporaryPath = `${ledgerPath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, entries })}\n`, "utf8");
      await rename(temporaryPath, ledgerPath);
    } finally {
      release();
    }
  }

}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function requestMiniMaxPreview(
  fetcher: typeof fetch,
  environment: NodeJS.ProcessEnv,
  input: { text: string; voiceId: string; rate: number; pauseScale: number },
): Promise<Buffer> {
  const apiKey = environment.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("MINIMAX_API_KEY is required for MiniMax voice preview.");
  const baseUrl = (environment.MINIMAX_TTS_BASE_URL ?? "https://api.minimaxi.com/v1").replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/t2a_v2`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: environment.MINIMAX_TTS_MODEL_ID ?? "speech-2.8-turbo",
      text: minimaxDirectedText(input.text, input.pauseScale),
      stream: false,
      voice_setting: { voice_id: input.voiceId, speed: Math.min(2, Math.max(0.5, input.rate / 190)), vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      language_boost: "Chinese",
      output_format: "hex",
      subtitle_enable: false,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`MiniMax voice preview failed with HTTP ${response.status}.`);
  const result = await response.json() as { data?: { audio?: unknown }; base_resp?: { status_code?: unknown; status_msg?: unknown } };
  if (result.base_resp?.status_code !== 0 || typeof result.data?.audio !== "string" || !result.data.audio) {
    throw new Error(`MiniMax voice preview failed: ${String(result.base_resp?.status_msg ?? "no audio returned")}`);
  }
  return Buffer.from(result.data.audio, "hex");
}

function minimaxDirectedText(text: string, pauseScale: number): string {
  const scale = Math.min(2, Math.max(0.5, pauseScale));
  const commaBreaks = Math.max(0, Math.round(scale - 0.5));
  const sentenceBreaks = Math.max(1, Math.round(scale * 1.5));
  return [...text.trim()].map((character) => {
    if ("，、；：".includes(character)) return `${character}${"\n".repeat(commaBreaks)}`;
    if ("。！？!?".includes(character)) return `${character}${"\n".repeat(sentenceBreaks)}`;
    return character;
  }).join("");
}

export function parseMacOSVoiceList(output: string): StudioVoiceProfile[] {
  const profiles: StudioVoiceProfile[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+(zh_(?:CN|TW|HK))\s+#/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!.trim();
    const locale = match[2]!.replace("_", "-") as StudioVoiceProfile["locale"];
    profiles.push({
      id: `macos:${name}`,
      providerId: "macos-say-v1",
      label: name,
      locale,
      engine: "macos",
      curated: CURATED_MACOS_VOICES.has(name),
      description: locale === "zh-CN" ? "普通话系统音色" : locale === "zh-TW" ? "台湾中文系统音色" : "粤语系统音色",
    });
  }
  return profiles.sort((left, right) => Number(Boolean(right.curated)) - Number(Boolean(left.curated)) || left.label.localeCompare(right.label));
}

function runtimeCapability(
  id: string,
  label: string,
  ready: boolean,
  evidence: string,
): StudioLocalCapability {
  return { id, label, category: "runtime", state: ready ? "ready" : "missing", evidence };
}

async function defaultCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function defaultRunCommand(
  command: string,
  args: string[],
  execution: CommandExecutionOptions = {},
): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    timeout: execution.timeoutMs ?? 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function withDirectedPauses(text: string, pauseScale: number): string {
  const commaPause = Math.round(90 * pauseScale);
  const sentencePause = Math.round(220 * pauseScale);
  return text
    .replace(/([，、；：])/g, `$1 [[slnc ${commaPause}]] `)
    .replace(/([。！？!?])/g, `$1 [[slnc ${sentencePause}]] `);
}

function masteringFilter(preset: StudioMasteringPreset): string {
  if (preset === "intimate") {
    return "highpass=f=65,lowpass=f=14500,equalizer=f=180:t=q:w=1:g=1.2,acompressor=threshold=-22dB:ratio=2.5:attack=18:release=220,loudnorm=I=-17:TP=-1.5:LRA=9";
  }
  if (preset === "social") {
    return "highpass=f=90,equalizer=f=2800:t=q:w=1.2:g=1.5,acompressor=threshold=-20dB:ratio=3:attack=12:release=160,loudnorm=I=-14:TP=-1:LRA=7";
  }
  return "highpass=f=75,acompressor=threshold=-18dB:ratio=2:attack=20:release=200,loudnorm=I=-16:TP=-1.5:LRA=11";
}

async function audioResource(target: string): Promise<StudioArtifactResource> {
  return { path: target, contentType: "audio/mp4", sizeBytes: (await stat(target)).size };
}
