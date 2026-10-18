import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexBridgeClient, FallbackCodexTaskClient } from "@video-factory/production-pipeline";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "../../../codex-broker/src/chat-completions-executor.js";
import { CodexBrokerServer } from "../../../codex-broker/src/broker-server.js";
import { buildStudioApp } from "../../src/server/app.js";
import { StudioService, type StudioPipelinePort } from "../../src/server/studio-service.js";
import { MaintenanceGate } from "../../src/server/maintenance-gate.js";
import { transitionMaintenanceGate } from "@video-factory/production-pipeline/maintenance";
import { CodexSeriesPlanningAgent } from "../../src/server/series-planning-agent.js";
import type { StudioSeriesInput } from "../../src/shared/api.js";

export const seriesInput: StudioSeriesInput = {
  name: "本地验收｜窗边十二秒", premise: "观察日常里缓慢发生的变化", audience: "想歇一会儿的人",
  platform: "douyin", category: "lifestyle", track: "causal-local", pillars: ["光影", "雨窗"],
  tone: "克制", visualStyle: "无屏幕演示的生活观察", targetEpisodeCount: 2,
};
export const roadmap = { episodes: [
  { episodeNumber: 1, pillar: "光影", title: "光从窗沿移过去", concept: "看见十二秒里光影的变化",   fromPrevious: [], toNext: ["下一集观察雨窗"] },
  { episodeNumber: 2, pillar: "雨窗", title: "两滴雨水相遇", concept: "看见水滴汇合的过程",   fromPrevious: [], toNext: [] },
] };
export function roadmapAudit() {
  return { version: "video-factory/role-audit-v2", rubricVersion: "video-factory/role-quality-rubric-v3",
    verdict: "pass", score: 90, summary: "每集兑现独立观察。", issues: [], repairInstructions: [], planningDisposition: null, hostReadinessReview: null,
    assessments: roadmap.episodes.map((_, index) => ({ targetPath: `/episodes/${index}`, dimensions: ["expression", "consistency"].map((dimension) => ({ dimension, score: 90, evidence: "有明确可见的变化。" })) })),
  };
}

/** 真路由、服务、文件存储、bridge、durable broker 与执行器；仅供应商 HTTP 响应受控。 */
export async function seriesCausalHarness(options: { workspaceRoot?: string; audit?: "pass" | "fail"; gateAudit?: Promise<void>; gateProduce?: Promise<void>; timeoutMs?: number; selectedModel?: () => Promise<string | undefined>; maintenance?: boolean } = {}) {
  const workspaceRoot = options.workspaceRoot ?? await mkdtemp(path.join(tmpdir(), "vf-causal-"));
  await mkdir(workspaceRoot, { recursive: true });
  // Unix socket 路径有长度上限，业务证据仍放在显式工作区。
  const socketRoot = await mkdtemp(path.join(tmpdir(), "vf-cs-"));
  const socketPath = path.join(socketRoot, "b.sock");
  const calls: Array<{ kind: string; attempt: number }> = [];
  const maintenanceDirectory = options.maintenance ? path.join(workspaceRoot, "maintenance") : undefined;
  if (maintenanceDirectory) await transitionMaintenanceGate(maintenanceDirectory, "open", "setup");
  const maintenanceGate = new MaintenanceGate(maintenanceDirectory ? { directory: maintenanceDirectory } : {});
  await maintenanceGate.announceStartup();
  let produceStarted!: () => void;
  const produceStart = new Promise<void>((resolve) => { produceStarted = resolve; });
  let auditStarted!: () => void;
  const auditStart = new Promise<void>((resolve) => { auditStarted = resolve; });
  const executor = new ChatCompletionsExecutor({ provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER, env: { DEEPSEEK_API_KEY: "local-test-only" },
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { response_format?: { json_schema?: { name?: string } }; messages: Array<{ content: string }> };
      const isAudit = JSON.stringify(body).includes("video-factory/role-audit-v2");
      const kind = isAudit ? "role-audit" : "series-roadmap";
      const attempt = calls.filter((call) => call.kind === kind).length + 1;
      calls.push({ kind, attempt });
      if (isAudit) { auditStarted(); await options.gateAudit; } else { produceStarted(); await options.gateProduce; }
      const audit = roadmapAudit();
      const output = !isAudit ? roadmap : options.audit === "pass" ? audit
        : attempt % 2 === 1 ? { ...audit, extra: true } : { ...audit, summary: "结构修复时改写判断" };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100 * attempt, completion_tokens: 10 * attempt, total_tokens: 110 * attempt } }), { status: 200 });
    },
  });
  const broker = new CodexBrokerServer({ socketPath, executor, idempotencyDirectory: path.join(workspaceRoot, "broker"), sessionDirectory: path.join(workspaceRoot, "sessions"),
    ...(maintenanceDirectory ? { maintenanceDirectory } : {}),
  });
  await broker.start();
  const transport = new CodexBridgeClient({ socketPath, timeoutMs: options.timeoutMs ?? 5000, pollIntervalMs: 10 });
  const client = new FallbackCodexTaskClient({ candidates: [{ client: transport, providerId: "deepseek", modelId: "deepseek-flash",
    taskKinds: ["series-roadmap", "role-audit"], sessionMode: "stateless" }] });
  const checkpointDirectory = path.join(workspaceRoot, "checkpoints", "series-showrunner");
  // 任何制作执行都是验收越界；只提供空制作列表，绝无真实模型或媒体服务退路。
  const pipeline = new Proxy({ list: async () => [] }, { get(target, key) {
    if (key === "list") return target.list;
    // 本桩仅提供空列表；可选读取能力缺省，不发生制作扫描或执行。
    if (typeof key === "string" && (key.startsWith("read") || key === "scanRuns")) return undefined;
    return () => { throw new Error(`Local causal harness forbids production method ${String(key)}`); };
  } }) as unknown as StudioPipelinePort;
  function service() {
    return new StudioService({ workspaceRoot, pipeline, environment: {}, commandAvailable: async () => false,
      seriesPlanningAgent: new CodexSeriesPlanningAgent(client, checkpointDirectory, options.selectedModel),
      trendGateway: { listServices: async () => [], listSignals: async () => [] }, trendAgent: { listCandidates: async () => [] },
    });
  }
  const newApp = () => buildStudioApp({ service: service(), ...(maintenanceDirectory ? {
    maintenanceGate, maintenanceIntegrity: async () => ({ complete: true, issues: [] }),
  } : {}) });
  const app = newApp();
  return { app, client, transport, broker, calls, auditStart, produceStart, workspaceRoot, checkpointDirectory, service,
    maintenanceDirectory, maintenanceGate, newApp,
    async close() { await app.close(); await broker.close(); await rm(socketRoot, { recursive: true, force: true }); if (!options.workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true }); },
  };
}
