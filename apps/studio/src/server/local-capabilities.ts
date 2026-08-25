import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
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
const KOKORO_PROFILES: StudioVoiceProfile[] = ([
  ["zf_001", "女声 01", "female"],
  ["zf_002", "女声 02", "female"],
  ["zf_003", "女声 03", "female"],
  ["zf_004", "女声 04", "female"],
  ["zf_005", "女声 05", "female"],
  ["zm_009", "男声 09", "male"],
  ["zm_010", "男声 10", "male"],
  ["zm_011", "男声 11", "male"],
  ["zm_012", "男声 12", "male"],
  ["zm_013", "男声 13", "male"],
] satisfies Array<[string, string, "female" | "male"]>).map(([id, label, gender]) => ({
  id: `kokoro:${id}`,
  providerId: "kokoro-local-v1",
  label,
  locale: "zh-CN",
  engine: "kokoro",
  gender,
  curated: true,
  description: `中文神经音色 ${id}`,
}));

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

  constructor(private readonly options: LocalCapabilityServiceOptions) {
    this.environment = options.environment ?? process.env;
    this.commandAvailable = options.commandAvailable ?? defaultCommandAvailable;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.pathExists = options.pathExists ?? defaultPathExists;
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
    const voiceRoot = this.voiceRuntimeRoot();
    if (await this.pathExists(path.join(voiceRoot, "kokoro.ready.json"))) {
      profiles.push(...KOKORO_PROFILES);
    }
    return profiles;
  }

  async report(): Promise<StudioLocalCapability[]> {
    const [python, ffmpeg, ffprobe, say, uv, docker, ollama, voices] = await Promise.all([
      this.commandAvailable("python3"),
      this.commandAvailable("ffmpeg"),
      this.commandAvailable("ffprobe"),
      this.commandAvailable("say"),
      this.commandAvailable("uv"),
      this.commandAvailable("docker"),
      this.commandAvailable("ollama"),
      this.listVoices(),
    ]);
    const voiceRoot = this.voiceRuntimeRoot();
    const pythonRoot = this.pythonRuntimeRoot();
    const [kokoroPython, kokoroReady, projectPython, projectPythonReady, qwenReady] = await Promise.all([
      this.pathExists(path.join(voiceRoot, ".venv", "bin", "python")),
      this.pathExists(path.join(voiceRoot, "kokoro.ready.json")),
      this.pathExists(path.join(pythonRoot, ".venv", "bin", "python")),
      this.pathExists(path.join(pythonRoot, "python.ready.json")),
      this.pathExists(path.join(this.agentRuntimeRoot(), "qwen3.ready.json")),
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
        state: say && voices.length > 0 ? "ready" : "missing",
        evidence: say ? `发现 ${voices.length} 个中文音色` : "未发现 macOS say",
      },
      {
        id: "kokoro-local",
        label: "Kokoro 本地神经配音",
        category: "voice",
        state: kokoroPython && kokoroReady ? "ready" : uv && process.arch === "arm64" ? "available" : "missing",
        evidence: kokoroPython && kokoroReady
          ? "本地运行时与模型已通过烟雾测试"
          : uv && process.arch === "arm64"
            ? "Apple Silicon 与 uv 已就绪，可自动搭建"
            : "需要 Apple Silicon 与 uv",
      },
      {
        id: "qwen3-local",
        label: "Qwen3 本地选题 Agent",
        category: "trend",
        state: ollama && qwenReady ? "ready" : ollama ? "available" : "missing",
        evidence: ollama && qwenReady ? "Qwen3 本地模型已通过结构化选题检查" : ollama ? "Ollama 已安装，模型尚未通过结构化选题检查" : "未发现 Ollama",
      },
    ];
  }

  async preview(input: StudioVoicePreviewInput): Promise<StudioArtifactResource | undefined> {
    const profile = (await this.listVoices()).find((candidate) => candidate.id === input.profileId);
    if (!profile) return undefined;
    const previewRoot = path.join(this.options.workspaceRoot, "previews", "voices");
    const identity = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
    const outputPath = path.join(previewRoot, `${identity}.m4a`);
    if (await this.pathExists(outputPath)) return audioResource(outputPath);

    await mkdir(previewRoot, { recursive: true });
    const rawPath = path.join(previewRoot, `${identity}.aiff`);
    try {
      if (profile.engine === "macos") {
        await this.runCommand("say", [
          "-v",
          profile.label,
          "-r",
          String(Math.round(input.rate)),
          "-o",
          rawPath,
          withDirectedPauses(input.text, input.pauseScale),
        ]);
      } else {
        await this.runCommand(
          path.join(this.voiceRuntimeRoot(), ".venv", "bin", "python"),
          [
            path.join(this.options.repositoryRoot, "src", "video_factory", "kokoro_voice.py"),
            "--text",
            input.text,
            "--voice",
            profile.id.slice("kokoro:".length),
            "--speed",
            String(Math.max(0.65, Math.min(1.45, input.rate / 180))),
            "--output",
            rawPath,
            "--runtime-root",
            this.voiceRuntimeRoot(),
          ],
          { timeoutMs: 180_000 },
        );
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

  private voiceRuntimeRoot(): string {
    return this.environment.VIDEO_FACTORY_VOICE_RUNTIME
      ? path.resolve(this.environment.VIDEO_FACTORY_VOICE_RUNTIME)
      : path.join(this.options.repositoryRoot, ".local", "voice");
  }

  private pythonRuntimeRoot(): string {
    return this.environment.VIDEO_FACTORY_PYTHON_RUNTIME
      ? path.resolve(this.environment.VIDEO_FACTORY_PYTHON_RUNTIME)
      : path.join(this.options.repositoryRoot, ".local", "python");
  }

  private agentRuntimeRoot(): string {
    return this.environment.VIDEO_FACTORY_AGENT_RUNTIME
      ? path.resolve(this.environment.VIDEO_FACTORY_AGENT_RUNTIME)
      : path.join(this.options.repositoryRoot, ".local", "agent");
  }
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
