import http from "node:http";
import path from "node:path";
import { CodexBridgeClient, parseModelConnectionInput, type ModelConnection } from "@video-factory/production-pipeline";

export interface ConnectedModel { model: ModelConnection; client: CodexBridgeClient }

export class ModelConnections {
  connections: ConnectedModel[] = [];
  onChange: (() => void) | undefined;

  constructor(private readonly brokerSocketPath: string) {}

  async refresh(): Promise<ModelConnection[]> {
    return this.install(await this.request("GET", "/v1/models"));
  }

  async add(input: unknown): Promise<ModelConnection[]> {
    return this.install(await this.request("POST", "/v1/models", parseModelConnectionInput(input)));
  }

  async disable(id: string): Promise<ModelConnection[]> {
    if (!/^m-[a-f0-9]{12}$/.test(id)) throw new Error("模型接入编号无效。");
    return this.install(await this.request("POST", `/v1/models/${id}/disable`, {}));
  }

  async enable(id: string): Promise<ModelConnection[]> {
    if (!/^m-[a-f0-9]{12}$/.test(id)) throw new Error("模型接入编号无效。");
    return this.install(await this.request("POST", `/v1/models/${id}/enable`, {}));
  }

  private install(value: unknown): ModelConnection[] {
    const models = (value as { models?: ModelConnection[] })?.models;
    if (!Array.isArray(models) || models.some((model) => !/^m-[a-f0-9]{12}$/.test(model.id)
      || model.socketName !== `${model.id}.sock` || "apiKey" in model || !Array.isArray(model.capabilities))) {
      throw new Error("模型服务返回的配置目录无效。");
    }
    this.connections = models.map((model) => ({
      model,
      client: this.connections.find((item) => item.model.id === model.id)?.client
        ?? new CodexBridgeClient({ socketPath: path.join(path.dirname(this.brokerSocketPath), model.socketName), timeoutMs: 2_460_000 }),
    }));
    this.onChange?.();
    return structuredClone(models);
  }

  private request(method: string, route: string, value?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = value === undefined ? undefined : JSON.stringify(value);
      const request = http.request({
        socketPath: this.brokerSocketPath, path: route, method, signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/json", ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 128 * 1024) { response.destroy(); reject(new Error("模型目录响应过大。")); return; }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("读取模型目录失败。")));
        response.on("end", () => {
          if (response.statusCode !== 200) { reject(new Error("模型接入管理暂不可用，请检查模型服务版本与连接。")); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new Error("模型目录格式无效。")); }
        });
      });
      request.on("error", () => reject(new Error("无法连接模型管理服务。")));
      request.end(body);
    });
  }
}
