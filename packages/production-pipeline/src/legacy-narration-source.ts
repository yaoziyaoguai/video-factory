import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { buildNarrationPlan, validateNarrationPlan, type NarrationPlan } from "./narration-plan.js";

export interface LegacyVoiceSourceFiles {
  voicePlanPath: string;
  voicePlanSha256: string;
  trackSha256: string;
  ledgerPath: string;
  ledgerSha256: string;
  origin: { voiceVersionId: string; voiceInputVersionId: string; sourceVoiceOperationId: string };
  currentPlan?: NarrationPlan;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** 原计划、账本和 raw 全部只读。Python 消费边界再核原请求指纹（保留历史浮点序列化）。 */
export async function inspectLegacyVoiceSource(options: {
  nodeRoot: string;
  source: Omit<LegacyVoiceSourceFiles, "ledgerPath" | "ledgerSha256" | "currentPlan">;
  scenes: Array<{ position: number; narration: string; duration: number }>;
  scriptSha256: string; visualSha256: string;
  currentPlan?: unknown;
}): Promise<{ files: LegacyVoiceSourceFiles; plan: NarrationPlan }> {
  const root = await realpath(options.nodeRoot);
  const verify = async (uri: string, digest?: string, size?: number) => {
    const resolved = await realpath(uri);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("旧配音来源越出了声音目录。");
    const bytes = await readFile(resolved);
    if (digest !== undefined && sha256(bytes) !== digest || size !== undefined && bytes.length !== size) {
      throw new Error("旧配音来源字节已变化；原声音保留，请核查原记录。");
    }
    return bytes;
  };
  const source = options.source;
  const original = JSON.parse((await verify(source.voicePlanPath, source.voicePlanSha256)).toString());
  if (original.version !== "video-factory/voiceover-plan-v2" || original.provider !== "minimax") {
    throw new Error("此来源不是具有原始账本的旧逐镜配音。");
  }
  await verify(original.track_path, source.trackSha256);
  const ledgerPath = path.join(root, ".voice-operations", createHash("sha256")
    .update(source.origin.sourceVoiceOperationId).digest("hex") + ".json");
  const ledgerBytes = await verify(ledgerPath);
  const ledger = JSON.parse(ledgerBytes.toString());
  if (ledger.version !== "video-factory/paid-operation-v2" || ledger.operationId !== source.origin.sourceVoiceOperationId
    || ledger.completed !== true || !Array.isArray(ledger.items) || ledger.items.length !== options.scenes.length
    || !Array.isArray(original.scenes) || original.scenes.length !== options.scenes.length) {
    throw new Error("旧配音原请求尚未核实完成；只核对原请求，不重新购买。");
  }
  const plan = buildNarrationPlan(options.scenes, options.scriptSha256, options.visualSha256);
  plan.groups = [];
  let cursor = 0;
  for (const [i, scene] of options.scenes.entries()) {
    const old = original.scenes[i];
    const item = ledger.items[i];
    if (old.position !== scene.position || old.narration !== scene.narration || typeof old.duration !== "number"
      || old.duration !== Math.round(scene.duration * 1000) / 1000 || item.scenePosition !== scene.position
      || item.state !== "materialized" || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1
      || item.parameters?.voice !== original.voice || item.parameters?.rate !== original.rate
      || item.parameters?.pauseScale !== original.direction?.pause_scale) {
      throw new Error("旧配音文字、时长、音色或原请求不匹配，不能据此调整。");
    }
    await verify(item.localPath, item.sha256, item.sizeBytes);
    const endFrame = cursor + Math.round(scene.duration * 30);
    if (/[\p{L}\p{N}]/u.test(scene.narration)) plan.groups.push({ id: `legacy-scene-${scene.position}`,
      text: scene.narration.trim(), sourceScenePositions: [scene.position],
      window: { startFrame: cursor, endFrame }, placement: { anchor: "start", offsetFrames: 0 } });
    cursor = endFrame;
  }
  const currentPlan = options.currentPlan === undefined ? plan : validateNarrationPlan(options.currentPlan, plan);
  return { plan: currentPlan, files: { ...source, ledgerPath, ledgerSha256: sha256(ledgerBytes), currentPlan } };
}
