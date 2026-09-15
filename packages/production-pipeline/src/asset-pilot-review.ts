import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
  validateVisualReviewReport,
  type VisualReviewAgent,
  type VisualReviewExecution,
} from "./codex-visual-review.js";
import type { RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export interface AssetPilotReviewInput {
  runRoot: string;
  outputDir: string;
  assetPlanPath: string;
  scriptPath: string;
  directorPlanPath?: string;
  scenePosition: number;
  inputFingerprint: string;
  mediaSha256: string;
  reviewProviderId?: string;
  reviewModelId?: string;
}

export interface AssetPilotReviewResult {
  execution: VisualReviewExecution;
  reportPath: string;
}

export interface AssetPilotReviewer {
  assertAvailable(providerId?: string, modelId?: string): void;
  review(input: AssetPilotReviewInput): Promise<AssetPilotReviewResult>;
}

// 同一实际素材和方案只审一次；模型、提示、参数或文件内容变化都会换检查点。
export class SourceAssetPilotReviewer implements AssetPilotReviewer {
  constructor(private readonly agents: VisualReviewAgent[]) {}

  assertAvailable(providerId?: string): void {
    const agent = this.agent(providerId);
    // 试片是付费闸门，所以"服务已连接"必须按它实际需要的审查强度判定：声明双审的
    // 审查器若只有同一个实际模型的两个名义分支，就不算独立复审，宁可现在拒绝动手，
    // 也不要等素材生成完才在复审里发现。
    const reviewers = agent.finalReviewConfiguration?.mode === "dual"
      ? agent.finalReviewConfiguration.reviewers
      : [];
    if (reviewers.length > 0
      && (new Set(reviewers.map((reviewer) => reviewer.providerId)).size !== reviewers.length
        || new Set(reviewers.map((reviewer) => reviewer.modelId)).size !== reviewers.length)) {
      throw new Error("试片复审需要两个不同的视觉审片模型，当前两个分支是同一个 Provider 或模型。");
    }
  }

  private agent(providerId?: string): VisualReviewAgent {
    const agent = providerId ? this.agents.find((candidate) => candidate.id === providerId) : this.agents[0];
    if (!agent) throw new Error("试片审查服务尚未连接，请连接视觉审片模型后再生成付费画面。");
    return agent;
  }

  async review(input: AssetPilotReviewInput): Promise<AssetPilotReviewResult> {
    const agent = this.agent(input.reviewProviderId);
    const key = createHash("sha256").update(JSON.stringify({
      // v3：试片改为两个独立模型复审。旧的单模型试片结论不能当双审结论复用。
      version: `asset-pilot-v3|${VISUAL_REVIEW_AGENT_CONTRACT_VERSION}`,
      scenePosition: input.scenePosition,
      inputFingerprint: input.inputFingerprint,
      mediaSha256: input.mediaSha256,
      providerId: agent.id,
      modelId: input.reviewModelId ?? agent.modelId,
    })).digest("hex");
    const directory = path.join(input.runRoot, "asset-pilot-reviews", key);
    await mkdir(directory, { recursive: true });
    const cachePath = path.join(directory, "review.json");
    const checkpoint = (modelId: string): RoleAgentLoopCheckpoint => {
      const modelKey = createHash("sha256").update(modelId).digest("hex");
      const target = path.join(directory, `checkpoint-${modelKey}.json`);
      return { key: `${key}:${modelKey}`, load: () => readOptionalJson(target), save: (value) => writeJson(target, value) };
    };
    let execution = await readOptionalJson(cachePath) as VisualReviewExecution | undefined;
    const cached = Boolean(execution);
    if (!execution) {
      const request = {
        assetPlanPath: input.assetPlanPath,
        scriptPath: input.scriptPath,
        ...(input.directorPlanPath ? { directorPlanPath: input.directorPlanPath } : {}),
        reviewStage: "source_assets" as const,
        scenePositions: [input.scenePosition],
        runRoot: input.runRoot,
        ...(input.reviewModelId ? { selectedModelId: input.reviewModelId } : {}),
        agentLoopCheckpoint: checkpoint(input.reviewModelId ?? agent.modelId),
        agentLoopCheckpointForModel: checkpoint,
      };
      execution = agent.reviewDetailed ? await agent.reviewDetailed(request) : { output: await agent.review(request) };
    }
    const report = validateVisualReviewReport(execution.output,
      execution.inspectedDurationMs ?? Number.MAX_SAFE_INTEGER, [input.scenePosition]);
    execution.output = {
      ...report,
      reviewScope: {
        reviewStage: "source_assets",
        evidenceId: input.mediaSha256,
        sourceNodeIds: ["assets"],
        sourceArtifactIds: [],
        scenePositions: [input.scenePosition],
        timelineDurationMs: execution.inspectedDurationMs
          ?? Math.max(1, ...report.findings.map((finding) => finding.endTimecodeMs)),
        // 复审的每个分支都要留名：只记一个模型等于把"谁参与了这次放行"藏起来。
        actualModels: execution.independentReviews?.length
          ? execution.independentReviews.map(({ providerId, modelId }) => ({ providerId, modelId }))
          : [{
              providerId: execution.executedProviderId ?? execution.trace?.providerId ?? agent.id,
              modelId: execution.executedModelId ?? execution.trace?.modelId ?? input.reviewModelId ?? agent.modelId,
            }],
        reviewContractVersion: VISUAL_REVIEW_AGENT_CONTRACT_VERSION,
      },
    };
    if (!cached) await writeJson(cachePath, execution);
    const reportPath = path.join(input.outputDir, `pilot-review-scene-${input.scenePosition}.json`);
    await writeJson(reportPath, { ...execution.output, scenePosition: input.scenePosition });
    return { execution, reportPath };
  }
}

async function readOptionalJson(target: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
