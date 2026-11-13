import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  createReadTool, createWriteTool, createEditTool, createBashTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { MediaContent } from "../../shared/agent/generated/contracts.js";
import { AgentError } from "./errors.js";

export const CREATIVE_IMAGE = "frame-creative:pi-1.4-v1";
export const CREATIVE_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;
export const CREATIVE_CWD = "/workspace";

// code_project 媒体输入在执行工作区的落位规则：inputs/<slot>.<扩展名>。
// 受理边界用同一映射核对输出路径与输入落位分离，执行处用它真实落文件；作品库选材输入复用同一扩展映射。
export const MEDIA_INPUT_EXTENSION: Record<MediaContent["mimeType"], string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "video/mp4": ".mp4", "video/webm": ".webm", "audio/mpeg": ".mp3", "audio/wav": ".wav",
};
export const CODE_PROJECT_INPUT_EXTENSIONS: readonly string[] = [...new Set(Object.values(MEDIA_INPUT_EXTENSION))];
export function codeProjectInputPath(slot: number, mimeType: MediaContent["mimeType"]): string {
  const extension = MEDIA_INPUT_EXTENSION[mimeType];
  if (!extension) throw new AgentError("INVALID_INPUT", `不支持的媒体输入类型：${mimeType}。`);
  return `inputs/${slot}${extension}`;
}
// Pi 1.4 在 Operations 之前探测本机路径。NUL 让 Node 在参数校验时拒绝该预探测，
// 不触及宿主文件系统；真正路径只在下方 Operations 内还原，再交给容器。
const READ_PREFIX = "/__frame_read__\0";

export interface CreativeWorkspace {
  conversationId: string;
  workId: string;
  /** 可编辑工程用固定身份，后台执行使用冻结 run 身份。 */
  executionId: string;
}
export interface CreativeSkill { id: string; directory: string }
export interface CreativeToolContext extends Omit<CreativeWorkspace, "workId"> {
  workId: string | null;
  deliveryClosed: boolean;
  /** 未明确作品时仍可读 Skill 指令，但不能进入工程或执行代码。 */
  readOnly?: boolean;
  skills: CreativeSkill[];
  onToolCall?: (name: typeof CREATIVE_TOOL_NAMES[number]) => void;
}
export interface CreativeExecutionOptions {
  signal?: AbortSignal;
  /** 秒，与 Pi Bash Operations 一致；缺省不另加执行超时或重试。 */
  timeout?: number;
  onData?: (data: Buffer) => void;
}
export interface CreativeFile { path: string; size: number }
interface SkillFile { path: string; data: string }
interface RunnerReply { data?: string; files?: CreativeFile[]; mimeType?: string | null; exitCode?: number | null; imageId?: string; error?: string }

export function creativeWorkspaceId(workspace: CreativeWorkspace | CreativeToolContext): string {
  for (const value of [workspace.conversationId, workspace.executionId, ...(workspace.workId === null ? [] : [workspace.workId])]) {
    if (typeof value !== "string" || !value || value.length > 200) throw new AgentError("INVALID_INPUT", "创作工作区身份无效。");
  }
  if (workspace.workId === null && !("readOnly" in workspace && workspace.readOnly)) throw new AgentError("INVALID_INPUT", "未明确作品时只能读取 Skill 资源。");
  return createHash("sha256").update(JSON.stringify([workspace.conversationId, workspace.workId, workspace.executionId])).digest("hex");
}
export const creativeSkillDirectory = (id: string): string => `/skills/${id}`;

/** 编辑工作区：同一 conversation+work 的原生创作工具与 publish_project 共用固定身份。 */
export function editingWorkspace(conversationId: string, workId: string): CreativeWorkspace {
  return { conversationId, workId, executionId: "project" };
}

/** App 仅连接窄 socket；Docker 权限和宿主目录映射只存在于宿主入口。 */
export class CreativeRunner {
  constructor(private readonly options: { socketPath: string }) {}

  private async request(workspace: CreativeWorkspace | CreativeToolContext, action: string, input: Record<string, unknown>, options: CreativeExecutionOptions = {}): Promise<RunnerReply> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.options.socketPath, path: "/", method: "POST", headers: { "content-type": "application/json" } }, response => {
        let pending = "";
        let result: RunnerReply | undefined;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line) continue;
            try {
              const frame = JSON.parse(line) as RunnerReply & { output?: string };
              if (frame.output !== undefined) options.onData?.(Buffer.from(frame.output, "base64"));
              else result = frame;
            } catch (error) { request.destroy(error as Error); }
          }
        });
        response.on("error", reject);
        response.on("end", () => {
          options.signal?.removeEventListener("abort", abort);
          if (!result || pending.trim()) { reject(new Error("创作宿主返回了不完整的结果。")); return; }
          if (result.error) { reject(new Error(result.error)); return; }
          resolve(result);
        });
      });
      const abort = () => request.destroy(new Error("aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      request.on("error", error => {
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      request.end(JSON.stringify({ workspaceId: creativeWorkspaceId(workspace), action, ...input }));
    });
  }

  async imageId(workspace: CreativeWorkspace): Promise<string> {
    return (await this.request(workspace, "image", {})).imageId!;
  }
  async readFile(workspace: CreativeWorkspace, relativePath: string): Promise<Buffer> {
    const result = await this.request(workspace, "read", { path: this.projectPath(relativePath) });
    return Buffer.from(result.data!, "base64");
  }
  async writeFile(workspace: CreativeWorkspace, relativePath: string, content: Buffer | string): Promise<void> {
    await this.request(workspace, "write", { path: this.projectPath(relativePath), data: Buffer.from(content).toString("base64") });
  }
  async listFiles(workspace: CreativeWorkspace): Promise<CreativeFile[]> {
    return (await this.request(workspace, "list", {})).files!;
  }
  async execute(workspace: CreativeWorkspace, command: string, options: CreativeExecutionOptions = {}): Promise<{ exitCode: number | null }> {
    const result = await this.request(workspace, "execute", { command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options);
    return { exitCode: result.exitCode! };
  }
  // 冻结工程的正式执行入口：argv 逐项直传进程，不经 shell 重新解释（含空格参数保持原样）。
  async executeArgv(workspace: CreativeWorkspace, argv: readonly string[], options: CreativeExecutionOptions = {}): Promise<{ exitCode: number | null }> {
    const result = await this.request(workspace, "execute", { argv: [...argv], ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options);
    return { exitCode: result.exitCode! };
  }

  private projectPath(file: string): string {
    if (!file || path.posix.isAbsolute(file) || file.split(/[\\/]/).some(part => part === "..")) {
      throw new AgentError("INVALID_INPUT", "工程文件必须使用工作区内的相对路径。");
    }
    return path.posix.join(CREATIVE_CWD, file);
  }

  private async skillSnapshot(skills: CreativeSkill[]): Promise<{ revision: string; files: SkillFile[] }> {
    const files: SkillFile[] = [];
    for (const skill of skills) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(skill.id)) throw new AgentError("INVALID_INPUT", "Skill 身份无效。");
      const root = await realpath(skill.directory);
      const visit = async (directory: string, prefix: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          // 只复制创作资源；宿主隐藏配置、凭据和数据库不进入代码容器。
          if (entry.name.startsWith(".") || entry.name === "node_modules"
            || /^(auth|credentials)\.json$|\.(?:pem|key|db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(entry.name)) continue;
          const file = path.join(directory, entry.name);
          const actual = await realpath(file);
          if (actual !== root && !actual.startsWith(root + path.sep)) throw new AgentError("FORBIDDEN", "Skill 资源的真实路径超出所属目录。");
          if (entry.isSymbolicLink()) throw new AgentError("FORBIDDEN", "Skill 只读副本不接受符号链接，请保留实际资源文件。");
          const relative = path.posix.join(prefix, entry.name);
          if (entry.isDirectory()) await visit(file, relative);
          else if (entry.isFile()) files.push({ path: path.posix.join(skill.id, relative), data: (await readFile(file)).toString("base64") });
        }
      };
      await visit(root, "");
    }
    return { revision: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
  }

  tools(current: () => CreativeToolContext | null): ToolDefinition[] {
    // 包装器缓存于 Pi 会话；实际 Operations 每次调用按当前请求创建，不捕获首个 work。
    const make = (context: CreativeToolContext, revision: string) => {
      const guard = () => {
        const latest = current();
        if (!latest || creativeWorkspaceId(latest) !== creativeWorkspaceId(context)) throw new AgentError("REQUEST_NOT_RUNNING", "当前创作请求已结束或工作区已切换。");
        if (latest.deliveryClosed) throw new AgentError("DELIVERY_CLOSED", "本请求已交付；修改请发送新的明确请求。");
        if (latest.readOnly) throw new AgentError("FORBIDDEN", "尚未明确作品；当前只允许读取 Skill 资源。");
      };
      const readPath = (file: string) => file.startsWith(READ_PREFIX) ? file.slice(READ_PREFIX.length) : file;
      const read = async (file: string) => Buffer.from((await this.request(context, "read", { path: readPath(file), skillsRevision: revision })).data!, "base64");
      const access = async (file: string, mode: "read" | "write") => { await this.request(context, "access", { path: readPath(file), mode, skillsRevision: revision }); };
      const write = async (file: string, content: string) => {
        guard(); await this.request(context, "write", { path: file, data: Buffer.from(content).toString("base64"), skillsRevision: revision });
      };
      return [
        createReadTool(CREATIVE_CWD, { operations: {
          readFile: read,
          access: file => access(file, "read"),
          detectImageMimeType: async file => (await this.request(context, "image_type", { path: readPath(file), skillsRevision: revision })).mimeType,
        } }),
        createWriteTool(CREATIVE_CWD, { operations: {
          writeFile: write,
          mkdir: async directory => { guard(); await this.request(context, "mkdir", { path: directory, skillsRevision: revision }); },
        } }),
        createEditTool(CREATIVE_CWD, { operations: {
          readFile: read, writeFile: write,
          access: async file => { guard(); await access(file, "write"); },
        } }),
        createBashTool(CREATIVE_CWD, { exposeSessionEnvironment: false, operations: {
          exec: async (command, _cwd, options) => {
            guard();
            const result = await this.request(context, "execute", { command, skillsRevision: revision,
              ...(options.timeout === undefined ? {} : { timeout: options.timeout }) }, options);
            return { exitCode: result.exitCode! };
          },
        } }),
      ];
    };
    const definitions = make({ conversationId: "descriptor", workId: "descriptor", executionId: "descriptor", deliveryClosed: true, skills: [] }, "");
    return definitions.map((definition, index) => ({
      ...definition,
      execute: async (id, input, signal, onUpdate) => {
        const context = current();
        if (!context) throw new AgentError("REQUEST_NOT_RUNNING", "当前没有明确的创作工作区。");
        context.onToolCall?.(CREATIVE_TOOL_NAMES[index]!);
        if (definition.name !== "read" && context.deliveryClosed) throw new AgentError("DELIVERY_CLOSED", "本请求已交付；修改请发送新的明确请求。");
        if (definition.name !== "read" && context.readOnly) throw new AgentError("FORBIDDEN", "尚未明确作品；当前只允许读取 Skill 资源。");
        const snapshot = await this.skillSnapshot(context.skills);
        await this.request(context, "skills", snapshot, signal ? { signal } : {});
        const args = { ...(input as Record<string, unknown>) };
        if (typeof args.path === "string") {
          let file = args.path;
          if (file.includes("\0")) throw new AgentError("INVALID_INPUT", "文件路径不能包含 NUL。");
          for (const skill of context.skills) {
            if (file === skill.directory || file.startsWith(skill.directory + path.sep)) {
              file = path.posix.join(creativeSkillDirectory(skill.id), path.relative(skill.directory, file)); break;
            }
          }
          const absolute = path.posix.resolve(CREATIVE_CWD, file);
          if (absolute !== CREATIVE_CWD && !absolute.startsWith(CREATIVE_CWD + "/") && !absolute.startsWith("/skills/")) {
            throw new AgentError("FORBIDDEN", "只能访问当前工程和已安装 Skill 的只读资源。");
          }
          if (context.readOnly && !absolute.startsWith("/skills/")) throw new AgentError("FORBIDDEN", "尚未明确作品；当前只允许读取 Skill 资源。");
          if (definition.name !== "read" && !absolute.startsWith(CREATIVE_CWD + "/")) throw new AgentError("FORBIDDEN", "Skill 资源只读；请在工程区修改文件。");
          args.path = definition.name === "read" ? READ_PREFIX + absolute : absolute;
        }
        const tool = make(context, snapshot.revision)[index]!;
        return tool.execute(id, args as never, signal, onUpdate);
      },
    } as ToolDefinition));
  }
}
