import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexReferenceGrammarAgent,
  type CodexTaskExecution,
  type CodexTaskKind,
} from "../src/index.js";

function grammar(camera: string): Record<string, unknown> {
  return {
    version: "video-factory/shot-grammar-v1",
    summary: "先留白，再由细节推进到全景。",
    durationMs: 10_000,
    pacing: "前慢后快",
    composition: "主体沿画面中轴展开",
    camera,
    color: "低饱和墨色",
    transitions: "按主体运动方向切换",
    sound: "声音信息不确定，保持低置信描述",
    beats: [{
      startMs: 0,
      endMs: 10_000,
      narrativeFunction: "由悬念推进到揭示",
      shotSize: "特写到全景",
      composition: "中心构图逐步打开",
      cameraMovement: camera,
      subjectMovement: "墨迹扩散",
      lighting: "柔和侧光",
      color: "黑白灰",
      transitionIn: "直接切入",
      soundRole: "无法由静帧确认",
    }],
    reusableRules: ["用主体尺度变化完成揭示"],
    avoidCopying: ["不复制人物、对白、品牌与独特情节"],
    confidence: 0.7,
  };
}

describe("CodexReferenceGrammarAgent", () => {
  it("repairs abstract shot grammar before returning it to the director", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    let analysisAttempt = 0;
    const client = {
      runTask: async () => grammar("稳定推进"),
      runTaskDetailed: async (kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> => {
        calls.push({ kind, payload });
        if (kind === "reference-grammar") {
          analysisAttempt += 1;
          return { output: grammar(analysisAttempt === 1 ? "复制原片标志性的环绕运镜" : "缓慢推进后稳定") };
        }
        return { output: {
          version: "video-factory/role-audit-v1",
          verdict: analysisAttempt === 1 ? "repair" : "pass",
          score: analysisAttempt === 1 ? 61 : 93,
          summary: analysisAttempt === 1 ? "包含应排除的标志性镜头复刻。" : "只保留了可复用的抽象制作语法。",
          issues: analysisAttempt === 1 ? [{
            severity: "blocking",
            criterion: "只提炼抽象语法",
            evidence: "camera 明确要求复制原片标志性环绕运镜。",
            repairInstruction: "改写为不依赖原片身份的通用机位变化。",
          }] : [],
          repairInstructions: analysisAttempt === 1 ? ["删除标志性复刻要求。"] : [],
        } };
      },
    };
    const agent = new CodexReferenceGrammarAgent({
      client,
      maxReviewIterations: 2,
      media: {
        prepare: async () => ({
          durationMs: 10_000,
          frames: [{ timecodeMs: 5_000, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==" }],
        }),
      },
    });

    const execution = await agent.analyzeDetailed({ videoPath: "/tmp/reference.mp4", runRoot: "/tmp", sourceLabel: "用户参考片" });

    assert.equal(execution.output.camera, "缓慢推进后稳定");
    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.deepEqual(calls.map((call) => call.kind), ["reference-grammar", "role-audit", "reference-grammar", "role-audit"]);
    assert.equal("revision" in (calls[2]!.payload as Record<string, unknown>), true);
    const auditPayload = calls[1]!.payload as { images: Array<Record<string, unknown>>; context: { upstreamFacts: { frames: Array<Record<string, unknown>> } } };
    assert.equal(auditPayload.images.length, 1);
    assert.equal(auditPayload.images[0]?.imageIndex, 1);
    assert.equal(typeof auditPayload.images[0]?.jpegBase64, "string");
    assert.equal(auditPayload.context.upstreamFacts.frames[0]?.imageIndex, 1);
  });
});
