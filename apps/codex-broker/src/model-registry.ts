import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { parseModelConnectionInput, type ModelConnection, type ModelConnectionInput } from "@video-factory/production-pipeline/model-connection";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "./chat-completions-executor.js";
import { CodexBrokerServer } from "./broker-server.js";
import type { BrokerTaskExecutor } from "./codex-executor.js";

interface StoredConnection { id: string; enabled: boolean; connection: ModelConnectionInput }

export class ModelRegistry {
  private entries: StoredConnection[] = [];
  private servers = new Map<string, CodexBrokerServer>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    directory: string;
    socketDirectory: string;
    timeoutMs: number;
    createExecutor?: (entry: StoredConnection) => BrokerTaskExecutor;
  }) {}

  async start(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.options.directory, "models.json"), "utf8")) as { version: number; entries: StoredConnection[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("Unsupported model registry format.");
      this.entries = parsed.entries.map((entry) => {
        if (!/^m-[a-f0-9]{12}$/.test(entry.id) || typeof entry.enabled !== "boolean") throw new Error("Invalid model registry entry.");
        return { id: entry.id, enabled: entry.enabled, connection: parseModelConnectionInput(entry.connection) };
      });
      if (new Set(this.entries.map((entry) => entry.id)).size !== this.entries.length) throw new Error("Duplicate model registry identity.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 已停用的入口仍可查询原 durable 结果；执行器拒绝新任务，不能把恢复变成重生成。
    try { for (const entry of this.entries) await this.startEntry(entry); }
    catch (error) { await this.close(); throw error; }
  }

  list(): ModelConnection[] {
    return this.entries.map(({ id, enabled, connection }) => {
      const { apiKey: _key, ...publicConnection } = connection;
      return { ...structuredClone(publicConnection), id, enabled, socketName: `${id}.sock`, credentialConfigured: true };
    });
  }

  async handle(method: string, url: string, body?: unknown): Promise<unknown> {
    if (method === "GET" && url === "/v1/models") return { models: this.list() };
    const operation = this.writes.then(async () => {
      if (method !== "POST") throw new Error("Unsupported model registry operation.");
      if (url === "/v1/models") {
        if (this.entries.length >= 40) throw new Error("Too many model connections.");
        const entry: StoredConnection = { id: `m-${randomBytes(6).toString("hex")}`, enabled: true, connection: parseModelConnectionInput(body) };
        await this.startEntry(entry);
        try { await this.persist([...this.entries, entry]); }
        catch (error) { await this.servers.get(entry.id)?.close(); this.servers.delete(entry.id); throw error; }
        this.entries.push(entry);
      } else {
        const match = /^\/v1\/models\/(m-[a-f0-9]{12})\/(disable|enable)$/.exec(url);
        const id = match?.[1];
        const entry = this.entries.find((item) => item.id === id);
        if (!entry) throw new Error("Unknown model connection.");
        const enabled = match?.[2] === "enable";
        await this.persist(this.entries.map((item) => ({ ...item, enabled: item.id === id ? enabled : item.enabled })));
        entry.enabled = enabled;
      }
      return { models: this.list() };
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await this.writes;
    await Promise.all([...this.servers.values()].map((server) => server.close()));
  }

  private async startEntry(entry: StoredConnection): Promise<void> {
    const executor = this.options.createExecutor?.(entry) ?? new ChatCompletionsExecutor({
      provider: { ...DEEPSEEK_CHAT_COMPLETIONS_PROVIDER, label: entry.connection.label },
      configuredModel: { id: entry.id, connection: entry.connection },
      timeoutMs: this.options.timeoutMs,
    });
    const server = new CodexBrokerServer({
      socketPath: path.join(this.options.socketDirectory, `${entry.id}.sock`),
      executor: {
        identity: executor.identity,
        ...(executor.modelCandidates ? { modelCandidates: executor.modelCandidates } : {}),
        runTask: (task, options) => {
          if (!entry.enabled) throw new Error("This model connection is disabled; existing results remain queryable.");
          return executor.runTask(task, options);
        },
      },
      idempotencyDirectory: path.join(this.options.directory, entry.id, "tasks"),
      sessionDirectory: path.join(this.options.directory, entry.id, "sessions"),
    });
    await server.start();
    this.servers.set(entry.id, server);
  }

  private async persist(entries: StoredConnection[]): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.options.directory, "models.json");
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
}
