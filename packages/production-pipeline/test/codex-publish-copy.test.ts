import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodexBridgeClient,
  CodexPublishCopyWriter,
  type CodexTaskExecution,
  type CodexTaskKind,
  type PublishCopyInput,
} from "../src/index.js";

class CapturingCodexClient extends CodexBridgeClient {
  readonly calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];

  constructor(private readonly respond: () => unknown) {
    super({ socketPath: "/nonexistent/vf-codex.sock", sleep: async () => {} });
  }

  async runTask(kind: CodexTaskKind, payload: unknown): Promise<unknown> {
    this.calls.push({ kind, payload });
    return this.respond();
  }
}

function publishInput(platform = "douyin"): PublishCopyInput {
  return {
    platform,
    brief: {
      title: "下班后别急着做这 3 件事",
      angle: "用三条具体动作减少下班后的决策消耗",
      audience: "普通上班族",
      nicheSlug: "life-avoidance",
    },
    narrations: ["第一场旁白", "第二场旁白", "第三场旁白"],
  };
}

function rawCopy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: " 下班后别急着做这三件事 ",
    description: " 三个动作，把下班后的决定变少。 ",
    hashtags: [" 下班 ", "决策消耗"],
    ...overrides,
  };
}

describe("CodexPublishCopyWriter", () => {
  it("repairs publish copy after an independent audit before returning detailed output", async () => {
    const calls: Array<{ kind: CodexTaskKind; payload: unknown }> = [];
    let publishAttempt = 0;
    const client = new class extends CodexBridgeClient {
      constructor() { super({ socketPath: "/nonexistent/vf-codex.sock" }); }
      async runTaskDetailed(kind: CodexTaskKind, payload: unknown): Promise<CodexTaskExecution> {
        calls.push({ kind, payload });
        if (kind === "publish-copy") {
          publishAttempt += 1;
          return { output: rawCopy({ title: publishAttempt === 1 ? "震惊所有人" : "下班后先少做一个决定" }) };
        }
        return { output: {
          version: "video-factory/role-audit-v1",
          verdict: publishAttempt === 1 ? "repair" : "pass",
          score: publishAttempt === 1 ? 58 : 91,
          summary: publishAttempt === 1 ? "标题夸张且没有传达内容价值。" : "文案与脚本和平台约束一致。",
          issues: publishAttempt === 1 ? [{
            severity: "blocking",
            criterion: "不制造额外承诺",
            evidence: "标题使用了‘震惊所有人’。",
            repairInstruction: "改为脚本中关于减少决策消耗的具体收益。",
          }] : [],
          repairInstructions: publishAttempt === 1 ? ["改写标题，明确减少决策消耗。"] : [],
        } };
      }
    }();
    const writer = new CodexPublishCopyWriter({ client, maxReviewIterations: 2 });

    const execution = await writer.writeDetailed(publishInput());

    assert.equal(execution.output.title, "下班后先少做一个决定");
    assert.equal(execution.agentLoop?.iterations.length, 2);
    assert.deepEqual(calls.map((call) => call.kind), ["publish-copy", "role-audit", "publish-copy", "role-audit"]);
    assert.equal("revision" in (calls[2]!.payload as Record<string, unknown>), true);
  });

  it("sends only publish-copy task data and normalizes output", async () => {
    const codexClient = new CapturingCodexClient(() => rawCopy());
    const writer = new CodexPublishCopyWriter({ client: codexClient });
    const input = publishInput();

    const result = await writer.write(input);

    assert.deepEqual(result, {
      title: "下班后别急着做这三件事",
      description: "三个动作，把下班后的决定变少。",
      hashtags: ["下班", "决策消耗"],
    });
    assert.equal(writer.id, "codex-publish-copy-v1");
    assert.equal(codexClient.calls.length, 1);
    assert.equal(codexClient.calls[0]?.kind, "publish-copy");
    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.deepEqual(payload, { platform: "douyin", brief: input.brief, narrations: input.narrations });
    assert.equal("directive" in payload, false);
  });

  it("forwards an unknown platform only as task data", async () => {
    const codexClient = new CapturingCodexClient(() => rawCopy());
    const writer = new CodexPublishCopyWriter({ client: codexClient });

    await writer.write(publishInput("somewhere-else"));

    const payload = codexClient.calls[0]!.payload as Record<string, unknown>;
    assert.equal(payload.platform, "somewhere-else");
    assert.equal("directive" in payload, false);
  });

  it("rejects invalid inputs before sending anything to codex", async () => {
    const codexClient = new CapturingCodexClient(() => rawCopy());
    const writer = new CodexPublishCopyWriter({ client: codexClient });

    await assert.rejects(() => writer.write({ ...publishInput(), platform: " " }), /platform must be a non-empty string/);
    await assert.rejects(
      () => writer.write({ ...publishInput(), brief: { ...publishInput().brief, nicheSlug: " " } }),
      /brief\.nicheSlug must be a non-empty string/,
    );
    await assert.rejects(
      () => writer.write({ ...publishInput(), narrations: ["第一场旁白", "第二场旁白"] }),
      /narrations must contain 3 to 24 non-empty entries/,
    );
    await assert.rejects(
      () => writer.write({ ...publishInput(), narrations: ["第一场旁白", " ", "第三场旁白"] }),
      /narrations must contain 3 to 24 non-empty entries/,
    );
    assert.equal(codexClient.calls.length, 0);
  });

  it("accepts exact code-point boundaries", async () => {
    const codexClient = new CapturingCodexClient(() => rawCopy({
      title: "标".repeat(30),
      description: "述".repeat(100),
      hashtags: ["话题".repeat(8)],
    }));
    const writer = new CodexPublishCopyWriter({ client: codexClient });

    const result = await writer.write(publishInput());

    assert.equal(result.title.length, 30);
    assert.equal([...result.description].length, 100);
    assert.deepEqual(result.hashtags, ["话题话题话题话题话题话题话题话题"]);
  });

  it("rejects non-contract output without any fallback", async () => {
    const cases: Array<{ name: string; output: Record<string, unknown>; pattern: RegExp }> = [
      { name: "missing hashtags", output: { title: "标题", description: "描述" }, pattern: /hashtags must be an array/ },
      { name: "empty hashtags", output: rawCopy({ hashtags: [] }), pattern: /hashtags must be an array of 1 to 5 strings/ },
      { name: "too many hashtags", output: rawCopy({ hashtags: ["一", "二", "三", "四", "五", "六"] }), pattern: /hashtags must be an array of 1 to 5 strings/ },
      { name: "hashtag with hash prefix", output: rawCopy({ hashtags: ["#下班", "决策消耗"] }), pattern: /hashtags\[0\] must not start with '#'/ },
      { name: "hashtag with whitespace", output: rawCopy({ hashtags: ["下班 时间", "决策消耗"] }), pattern: /hashtags\[0\] must not contain whitespace/ },
      { name: "duplicate hashtags", output: rawCopy({ hashtags: ["下班", "下班"] }), pattern: /duplicates \(case-insensitive\) after trimming/ },
      { name: "ascii case-insensitive duplicates", output: rawCopy({ hashtags: ["Life", "life"] }), pattern: /duplicates \(case-insensitive\) after trimming/ },
      { name: "overlong hashtag", output: rawCopy({ hashtags: ["x".repeat(17)] }), pattern: /hashtags\[0\] must be 1 to 16 characters/ },
      { name: "overlong title", output: rawCopy({ title: "标".repeat(31) }), pattern: /title must be 1 to 30 characters/ },
      { name: "overlong description", output: rawCopy({ description: "述".repeat(101) }), pattern: /description must be 1 to 100 characters/ },
      { name: "blank title", output: rawCopy({ title: " " }), pattern: /title must be a non-empty string/ },
    ];
    for (const testCase of cases) {
      const codexClient = new CapturingCodexClient(() => testCase.output);
      const writer = new CodexPublishCopyWriter({ client: codexClient });
      await assert.rejects(() => writer.write(publishInput()), testCase.pattern);
      assert.equal(codexClient.calls.length, 1, testCase.name);
    }
  });
});
