import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, InputRef, MarkdownContent, ModelBinding, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { InvalidImageFile, probeImageFile } from "./media-probe.js";
import { digestOf, type AgentClock } from "./util.js";
import { getRevisionRow } from "./artifact-store.js";
import type { ImageProfile } from "./media-config.js";
import { markdownFullText } from "../../shared/agent/markdown.js";

// OpenAI 和火山方舟共用同步单图执行与恢复（B1/B2）：一次 POST 完整接收响应→解析恰一张 b64 图→解码并验实际
// 格式与冻结尺寸→按 attempt 确定位置原子落盘→登记 blob/效果收据→返回观测；billing 恒 null，估价不写成账单。
// 该接口没有经证实的任务查询/取消：query/cancel 只读本地文件与收据，缺证据稳定 unknown，绝不伪造 providerTaskId 外查。
// signal：未发出即停止 → cancelled；请求已发出后中断无法证明未受理 → unknown（Images 无远端取消语义）。

/** 按冻结绑定解析该次调用的执行配置与原 Key；返回 null 表示绑定不在本部署历史（漂移）。 */
export type ImageBindingResolver = (binding: ModelBinding) => { profile: ImageProfile; apiKey: string | null } | null;

export interface ImageGenerationPortOptions {
  resolve: ImageBindingResolver;
  /** 尝试工作目录（确定性完成位置：<workRoot>/<attemptId>/image.png 或 image.jpeg）。 */
  workRoot: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 30 * 1024 * 1024;
// 输出上限不含传输编码；另留 64 KiB 给 JSON 元数据。
const DEFAULT_MAX_RESPONSE_BYTES = Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 + 64 * 1024;

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

export class ImageGenerationPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: ImageGenerationPortOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "image") throw new Error("图片通道只接受 image 操作。");
    if (signal?.aborted) return this.deterministic(input.attemptId, "cancelled", "停止请求发生在请求发出之前；未提交任何请求。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "图片凭据未启用；未提交任何请求，不会自动重试。");
    // 输入已经过能力校验（恰好一份文字输入）；这里直接读取正文，不重复整份执行对象校验。
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const prompt = ref.kind === "text" ? ref.text : markdownFullText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    let bytes: Buffer;
    try {
      bytes = this.parseSingleImage(await this.requestImage(resolved.apiKey, prompt, resolved.profile, signal));
    } catch (error) {
      if (error instanceof ImageRejection) {
        return this.preRefusal(input.attemptId, `供应商明确拒绝创建图片：${error.message}`);
      }
      if (error instanceof BadImageOutput) {
        // 完整响应已取得但产出不可用：如实终态失败，费用仍未核实，不改写成“没花钱”。
        return this.nonCompliant(input.attemptId, error.message);
      }
      // 连接阶段失败（DNS/拒连/连接超时）＝请求从未写出，供应商不可能受理：确定失败，不落 unknown。
      const connectPhase = connectPhaseCode(error);
      if (connectPhase) {
        return this.preRefusal(input.attemptId, `图片创建请求未发出（${connectPhase}）；供应商未收到任何生成指令。`);
      }
      // 超时、断连、5xx、发出后本地停止、响应不完整：无法证明未受理 → unknown，不自动重试 POST。
      return this.unstableUnknown(input.attemptId,
        `图片创建请求结果未核实（${error instanceof IncompleteResponse ? error.message : signal?.aborted ? "请求已发出后本地停止" : "网络请求未完成"}）；保留原身份核对，不会重新提交。`);
    }
    return this.settleBytes(input.attemptId, resolved.profile.image, bytes);
  }

  // 同步接口没有可外查的任务身份：恢复只读本地证据，不要求当前 Key 可用。
  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          return this.deterministicSucceeded(query.attemptId, blob.id, blob.digest, blob.mime_type);
        } catch { /* 成品文件缺失：继续按其余本地证据分支核对 */ }
      }
    }
    if (receipt?.exit_kind === "failed") {
      return this.deterministic(query.attemptId, "failed", receipt.detail ?? "已取得的输出不满足冻结参数。");
    }
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    const format = query.accountBinding.providerId === "ark" ? "jpeg" : "png";
    if (existsSync(path.join(attemptDir, `image.${format}`))) return this.settleImage(query, format);
    if (existsSync(path.join(attemptDir, "image.part"))) {
      return this.stableUnknown(query.attemptId, "只取得部分响应文件，结果无法核实；不会重新提交。");
    }
    return this.stableUnknown(query.attemptId, "同步图片接口没有可查询的任务身份，无法向供应商查询；结果与实际费用未取得；不会重新提交。");
  }

  // 同步请求不能声称供应商已取消：与 query 相同，只核对已有响应/收据；停止后续步骤由 worker 处理。
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  // —— 内部 ——

  /** 临时写入→探测→按冻结规格核对→原子移入完成位置；不可用如实 failed，工具暂不可用保留文件 unknown。 */
  private async settleBytes(attemptId: string, image: ImageProfile["image"], bytes: Buffer): Promise<ExecutionObservation> {
    const attemptDir = path.join(this.options.workRoot, attemptId);
    const temporary = path.join(attemptDir, "image.part");
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, bytes, { mode: 0o600 });
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    try {
      this.verifyImage(await probeImageFile(temporary), image.resolution, image.format);
      renameSync(temporary, path.join(attemptDir, `image.${image.format}`));
    } catch (error) {
      if (error instanceof InvalidImageFile || error instanceof BadImageOutput) {
        rmSync(temporary, { force: true });
        return this.nonCompliant(attemptId, error.message);
      }
      return this.unstableUnknown(attemptId,
        `图片文件已取得，本地校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留文件继续核对，不重新提交。`);
    }
    return this.publish(attemptId, image.format);
  }

  /** 完成文件已就位但收据缺失（落盘与登记之间中断）：按冻结参数重验后补收据，只发布一次。 */
  private async settleImage(query: ProviderRecoveryQuery, format: ImageProfile["image"]["format"]): Promise<ExecutionObservation> {
    const finalFile = path.join(this.options.workRoot, query.attemptId, `image.${format}`);
    const row = this.db.prepare("SELECT spec_json FROM production_operations WHERE run_id=? AND id=?")
      .get(query.runId, query.operationId) as { spec_json: string };
    const op = JSON.parse(row.spec_json) as { parameters: { resolution: string } };
    try {
      this.verifyImage(await probeImageFile(finalFile), op.parameters.resolution, format);
      return this.publish(query.attemptId, format);
    } catch (error) {
      if (error instanceof InvalidImageFile || error instanceof BadImageOutput) {
        // 恢复同样不放过规格不符文件：登记失败收据，不发布。
        rmSync(finalFile, { force: true });
        return this.nonCompliant(query.attemptId, error.message);
      }
      return this.stableUnknown(query.attemptId,
        `图片文件已取得，本地校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留文件继续核对，不重新提交。`);
    }
  }

  private publish(attemptId: string, format: ImageProfile["image"]["format"]): ExecutionObservation {
    const finalFile = path.join(this.options.workRoot, attemptId, `image.${format}`);
    const row = this.db.prepare("SELECT run_id FROM production_attempts WHERE id=?").get(attemptId) as { run_id: string };
    const run = runRow(this.db, row.run_id);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(finalFile), `image/${format}`, null);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { blobId: blob.id, digest: blob.digest }))();
    return this.deterministicSucceeded(attemptId, blob.id, blob.digest, blob.mime_type);
  }

  private verifyImage(facts: { width: number; height: number; mimeType: string }, resolution: string, format: ImageProfile["image"]["format"]): void {
    if (facts.mimeType !== `image/${format}`) throw new BadImageOutput(`输出不是 ${format.toUpperCase()} 单图。`);
    const [width, height] = resolution.split("x").map(Number);
    if (facts.width !== width || facts.height !== height) {
      throw new BadImageOutput(`输出画幅 ${facts.width}x${facts.height} 与冻结参数 ${width}x${height} 不符。`);
    }
  }

  private async requestImage(apiKey: string, prompt: string, profile: ImageProfile, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const onStop = () => controller.abort();
    signal?.addEventListener("abort", onStop, { once: true });
    try {
      // 两家都返回一张 base64 图片，方舟和 OpenAI 各自使用其原生参数。
      const response = await this.fetchImpl(new URL(`${profile.baseUrl}/images/generations`), {
        method: "POST", signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: profile.modelId,
          prompt,
          size: profile.image.resolution,
          ...(profile.providerId === "ark"
            ? { response_format: "b64_json", watermark: true, ...(profile.modelId === "doubao-seedream-4-0-20260415"
                ? { sequential_image_generation: "disabled" } : { output_format: "jpeg" }) }
            : { n: 1, quality: profile.image.quality, output_format: profile.image.format }),
        }),
      });
      const body = await this.readCapped(response);
      let parsed: unknown;
      try { parsed = body ? JSON.parse(body) : {}; } catch { throw new IncompleteResponse("响应不是有效 JSON。"); }
      if (!response.ok) {
        // 供应商原始错误可能回显凭据；在写入观测/收据前只保留受控状态。
        const message = profile.providerId === "ark" && response.status === 404
          ? (parsed as { error?: { code?: string } } | null)?.error?.code === "ModelNotOpen"
            ? "当前账号尚未开通此图片型号，请在火山方舟的开通管理中核对。"
            : "火山方舟未找到该型号或此连接无权调用（HTTP 404），请核对型号与开通状态。"
          : `HTTP ${response.status}。`;
        // 4xx/429 是明确未受理的拒绝；5xx、超时与断连按未知处理，由调用方归类。
        if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new ImageRejection(message);
        throw new IncompleteResponse(`供应商暂时不可用：${message}`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new IncompleteResponse("供应商响应不是对象。");
      const record = parsed as { error?: unknown };
      if (record.error !== undefined && record.error !== null) {
        throw new ImageRejection("供应商返回明确错误。");
      }
      return parsed;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onStop);
      controller.abort(); // 完整读取后无影响；超限或解析失败时释放仍在传输的响应。
    }
  }

  private async readCapped(response: Response): Promise<string> {
    const limit = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isSafeInteger(declared) && declared > limit) throw new IncompleteResponse(`响应超过大小上限（${declared} 字节）。`);
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) throw new IncompleteResponse("响应超过大小上限。");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** 响应里必须恰一张 b64 图：多张不悄悄选第一张冒充单图合同，缺张不当作可重试的未知。 */
  private parseSingleImage(response: unknown): Buffer {
    const data = (response as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new IncompleteResponse("响应缺少 data 数组。");
    if (data.length !== 1) throw new BadImageOutput(`供应商返回 ${data.length} 张图片，与单图合同不符。`);
    const b64 = (data[0] as { b64_json?: unknown } | null)?.b64_json;
    if (typeof b64 !== "string" || b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new BadImageOutput("响应中的图片数据不是有效的 base64。");
    }
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > MAX_OUTPUT_BYTES) throw new BadImageOutput("图片输出超过 30 MiB 上限。");
    return bytes;
  }

  // 完整响应已取得但确定不可用：failed 终态、登记效果收据、费用仍未核实，不再获取同一响应。
  private nonCompliant(attemptId: string, reason: string): ExecutionObservation {
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId,
      { exitKind: "failed", detail: `已完整取得的输出不满足冻结参数：${reason}` }))();
    return this.deterministic(attemptId, "failed", `已完整取得的输出不满足冻结参数：${reason}`);
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    // B2：提交前本地拒绝/明确供应商拒绝同样登记效果收据，费用未发生的事实留在 detail。
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { exitKind: "failed", detail: message }))();
    return this.deterministic(attemptId, "failed", message);
  }

  private deterministic(attemptId: string, state: "failed" | "cancelled", message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-image", state, message }).slice(0, 24)}`,
      attemptId, state, providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  private deterministicSucceeded(attemptId: string, blobId: string, digest: string, mimeType: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-image", state: "succeeded", blobId }).slice(0, 24)}`,
      attemptId, state: "succeeded", providerTaskId: null, blob: { id: blobId, digest, mimeType },
      observedAt: this.stableTime(attemptId), message: "供应商图片已解码并核对通过。", billing: null,
    };
  }

  // 稳定未知：同一 attempt 每次查询得到同一条观测，不生成新事实。
  private stableUnknown(attemptId: string, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-image-unknown", message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  private unstableUnknown(attemptId: string, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-image-transient", at: this.clock(), message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: this.clock(), message, billing: null,
    };
  }

  private stableTime(attemptId: string): string {
    const row = this.db.prepare("SELECT r.created_at AS at FROM production_runs r JOIN production_attempts a ON a.run_id=r.id WHERE a.id=?").get(attemptId) as { at: string } | undefined;
    return row?.at ?? this.clock();
  }
}

class ImageRejection extends Error {}
class BadImageOutput extends Error {}
class IncompleteResponse extends Error {}

// fetch 网络失败时错误码挂在 cause 上；这组码只出现在请求写出前的连接阶段，可证明“未发送”。
function connectPhaseCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown })?.cause;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ? code : null;
}
