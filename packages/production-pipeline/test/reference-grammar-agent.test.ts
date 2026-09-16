import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexReferenceGrammarAgent,
  type CodexPreparedOperation,
  type CodexTaskExecution,
  type CodexTaskKind,
  type CodexTaskRequestOptions,
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
        const auditScore = analysisAttempt === 1 ? 61 : 93;
        return { output: {
          version: "video-factory/role-audit-v2",
          rubricVersion: "video-factory/role-quality-rubric-v1",
          assessments: [{
            targetPath: "",
            dimensions: [
              {
                dimension: "evidence",
                score: auditScore,
                evidence: analysisAttempt === 1
                  ? "camera 字段要求复刻原片标志性运镜，没有抽象证据支撑。"
                  : "语法结论都能对应到抽帧里的可见运动。",
              },
              { dimension: "coverage", score: auditScore, evidence: "覆盖了本轮要求提炼的语法范围。" },
              { dimension: "consistency", score: auditScore, evidence: "评分与 issues 的严重度一致。" },
              { dimension: "actionability", score: auditScore, evidence: "输出可直接交给导演作为机位依据。" },
            ],
          }],
          verdict: analysisAttempt === 1 ? "repair" : "pass",
          score: auditScore,
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

  it("observes a saved audit and does not resample the reference video", async () => {
    let stored: unknown;
    let interruptAudit = true;
    let mediaCalls = 0;
    let producerCalls = 0;
    let auditCalls = 0;
    const observed: string[] = [];
    const checkpoint = {
      key: "reference-audit-recovery",
      load: async () => stored,
      save: async (value: unknown) => { stored = structuredClone(value); },
    };
    const client = {
      runTask: async () => grammar("稳定推进"),
      runTaskDetailed: async (
        kind: CodexTaskKind,
        payload: unknown,
        requestId?: string,
        _session?: unknown,
        requestOptions?: CodexTaskRequestOptions,
      ): Promise<CodexTaskExecution> => {
        if (kind === "reference-grammar") {
          producerCalls += 1;
          return { output: grammar("稳定推进") };
        }
        auditCalls += 1;
        if (interruptAudit) {
          await requestOptions?.beforeSubmit?.(preparedOperation(kind, payload, requestId!));
          throw new Error("reference audit response interrupted");
        }
        return { output: passingAudit() };
      },
      observePrepared: async (operation: CodexPreparedOperation): Promise<CodexTaskExecution> => {
        observed.push(operation.requestId);
        return { output: passingAudit() };
      },
    };
    const agent = new CodexReferenceGrammarAgent({
      client,
      media: {
        prepare: async () => {
          mediaCalls += 1;
          return {
            durationMs: 10_000,
            frames: [{ timecodeMs: 5_000, sha256: "a".repeat(64), jpegBase64: "/9j/2Q==" }],
          };
        },
      },
    });
    const input = { videoPath: "/tmp/reference.mp4", runRoot: "/tmp", sourceLabel: "用户参考片", agentLoopCheckpoint: checkpoint };

    await assert.rejects(() => agent.analyzeDetailed(input), /reference audit response interrupted/);
    interruptAudit = false;
    const execution = await agent.analyzeDetailed(input);

    assert.equal(execution.agentLoop?.status, "passed");
    assert.equal(producerCalls, 1);
    assert.equal(auditCalls, 1);
    assert.equal(observed.length, 1);
    assert.equal(mediaCalls, 1);
  });
});

function passingAudit() {
  return {
    version: "video-factory/role-audit-v2",
    rubricVersion: "video-factory/role-quality-rubric-v1",
    assessments: [{
      targetPath: "",
      dimensions: [
        { dimension: "evidence", score: 93, evidence: "语法结论对应抽帧中可见的运动。" },
        { dimension: "coverage", score: 93, evidence: "覆盖了参考片要求的语法范围。" },
        { dimension: "consistency", score: 93, evidence: "评分与 issues 的严重度一致。" },
        { dimension: "actionability", score: 93, evidence: "结论可直接用于后续机位设计。" },
      ],
    }],
    verdict: "pass",
    score: 93,
    summary: "参考片语法与证据边界一致。",
    issues: [],
    repairInstructions: [],
  };
}

function preparedOperation(kind: CodexTaskKind, payload: unknown, requestId: string): CodexPreparedOperation {
  const envelope = { protocolVersion: "video-factory/codex-bridge-v2", requestId, kind, payload };
  const brokerBinding = {
    version: "video-factory/task-binding-v1" as const,
    storeId: `vfs_store_${"e".repeat(32)}`,
    providerId: "openai",
    modelId: "codex-default",
  };
  return {
    version: "video-factory/codex-prepared-operation-v1",
    requestId,
    kind,
    envelope,
    serializedEnvelope: JSON.stringify(envelope),
    binding: {
      ...brokerBinding,
      requestDigest: "f".repeat(64),
      kind,
      contractDigest: "a".repeat(64),
      sessionDigest: "b".repeat(64),
    },
    brokerBinding,
    route: { socketPath: "/tmp/reference.sock" },
    taskFact: "not_submitted",
  };
}
