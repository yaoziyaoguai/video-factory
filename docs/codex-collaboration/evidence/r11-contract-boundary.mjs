import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

// 只在隔离 socket、临时目录和注入 transport 上走正式 source/dist 边界；不读取凭据、不调用外部模型。
const layer = process.env.VF_REVIEW_DIST === "1" ? "dist" : "src";
const ext = layer === "dist" ? "js" : "ts";
const root = new URL("../../../", import.meta.url);
const load = (file) => import(new URL(file, root));
const brokerModule = await load(`apps/codex-broker/${layer}/broker-server.${ext}`);
const executorModule = await load(`apps/codex-broker/${layer}/codex-executor.${ext}`);
const definitionsModule = await load(`apps/codex-broker/${layer}/task-definitions.${ext}`);
const zaiModule = await load(`apps/codex-broker/${layer}/zai-code-plan-executor.${ext}`);
const chatModule = await load(`packages/production-pipeline/${layer}/codex-chat.${ext}`);
const topicPayloadModule = await load(`apps/studio/${layer === "dist" ? "dist/server/server" : "src/server"}/topic-ideas-payload.${ext}`);

const { CodexBrokerServer } = brokerModule;
const { CodexExecutor, codexExecutorProfileFor, parseTaskRequest } = executorModule;
const { BROKER_TASK_KINDS, outputValidationErrorFor, taskContractDescriptorFor } = definitionsModule;
const { ZaiCodePlanExecutor } = zaiModule;
const { CodexBridgeClient, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } = chatModule;
const { topicIdeasModelPayload } = topicPayloadModule;

const treatment = {
  version: "video-factory/creative-treatment-v2",
  viewerPromise: "学会识别原文支持的结论边界",
  hook: { narrationIntent: "先提出一个可核对的问题", visualIntent: "展示正文与标题的信息差" },
  progression: [
    { beatId: "question", purpose: "建立问题", viewerGain: "知道要核对什么" },
    { beatId: "evidence", purpose: "核对原文", viewerGain: "区分事实与推测" },
    { beatId: "payoff", purpose: "兑现判断", viewerGain: "得到可复用的方法" },
  ],
  payoff: "给出有条件的结论和下一步",
  visualPrinciples: ["原文证据与示意画面分开"],
  soundPrinciples: ["自然语速并保留停顿"],
  evidenceRequirements: [{
    beatId: "evidence",
    claim: "正文中的公开陈述",
    requirement: "factual_support",
    suppliedSourceIds: ["source-report"],
    critical: true,
    acquisition: "supplied",
    retrievalProviderId: null,
  }],
  feasibilityQuestions: [{ beatId: "evidence", question: "引用段落是否足以支持该表述" }],
};

const articleSource = {
  sourceId: "source-report",
  originalUrl: "https://news.example/report",
  finalUrl: "https://news.example/report",
  pageTitle: "正文没有写在标题里的公开报告",
  fetchedAt: "2026-09-14T08:00:00.000Z",
  publishedAt: "2026-09-14T07:00:00.000Z",
  contentSha256: "a".repeat(64),
  extractorVersion: "readability-v1",
  readStatus: "read",
  paragraphs: [{ id: "p1", text: "这个可引用事实只出现在正文段落。" }],
  truncated: false,
};

const productionCapabilities = {
  assetProviders: [{
    id: "pexels-stock-v1",
    deliveryTypes: ["stock_video", "stock_image"],
    supportsReferenceImage: false,
    strengths: ["通用纪实素材"],
    constraints: ["不能冒充特定事件实证"],
  }],
  editing: { sourceRangeReuse: true, staticEditorialCard: false },
  audio: { narration: true, pauseControl: "punctuation", musicTrack: false, soundEffectsTrack: false },
};

function request(kind, payload, identity) {
  return parseTaskRequest({
    protocolVersion: "video-factory/codex-bridge-v2",
    requestId: `r11-${layer}-${identity.profileId}-${kind}`,
    kind,
    payload,
    expectedContractDigest: taskContractDescriptorFor(kind).digest,
  }, identity);
}

function discussionPayload(stage = "treatment") {
  return {
    stage,
    currentDocument: treatment,
    context: {
      effectiveUserInstructions: [{ commandId: "user-1", message: "保留事实边界", active: true }],
      upstreamConfirmed: {},
      productionCapabilities,
      voiceTiming: { rate: 120, pauseScale: 2 },
      seriesContext: { canon: [{ id: "canon-1", statement: "不虚构结果" }] },
      articleSources: [articleSource],
    },
    message: "请解释当前开场，必要时给我另一种方向。",
    recentMessages: [{ role: "user", text: "先保留原文依据。" }],
  };
}

function discussionOutput(intent) {
  const document = intent === "propose" || intent === "revise" ? treatment : null;
  return {
    stage: "treatment",
    intent,
    reply: intent === "clarify" ? "你希望先强调结论，还是先展示证据？" : "当前安排先建立问题，再核对正文。",
    changeSummary: document ? ["保留原文依据并调整开场表达"] : [],
    treatment: document,
    script: null,
    director: null,
    upstreamRequest: intent === "request_upstream_change"
      ? { stage: "treatment", reason: "需要先重新确认观众承诺" }
      : null,
  };
}

class FakeCodexChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  kill() {}
}

function fakeCodexSpawn(outputs) {
  return (_command, args) => {
    const child = new FakeCodexChild();
    const outputPath = args[args.indexOf("--output-last-message") + 1];
    const output = outputs.shift();
    setImmediate(async () => {
      await writeFile(outputPath, JSON.stringify(output), "utf8");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
}

async function withBroker(executor, check) {
  const directory = await mkdtemp(path.join(tmpdir(), "vf-r11-contract-"));
  const socketPath = path.join(directory, "worker.sock");
  const server = new CodexBrokerServer({
    socketPath,
    executor,
    idempotencyDirectory: path.join(directory, "durable"),
    sessionDirectory: path.join(directory, "sessions"),
  });
  try {
    await server.start();
    await check(server, socketPath);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test(`${layer}: registry, executor identities, descriptors, health, and pipeline pins expose one canonical task set`, async () => {
  const openai = new CodexExecutor({
    workspaceRoot: path.join(tmpdir(), "vf-r11-openai-unused"),
    profile: codexExecutorProfileFor("openai", "gpt-5.6-sol"),
    spawnFn: fakeCodexSpawn([]),
  });
  const zai = new ZaiCodePlanExecutor({ env: { ZAI_BIGMODEL_API_KEY: "isolated-test-only-not-a-credential" }, fetchFn: async () => new Response() });
  const canonical = [...BROKER_TASK_KINDS].sort();
  assert.deepEqual(Object.keys(REQUIRED_CODEX_TASK_CONTRACT_DIGESTS).sort(), canonical);
  assert.deepEqual([...openai.identity.taskKinds].sort(), canonical);
  assert.deepEqual([...zai.identity.taskKinds].sort(), canonical);
  for (const kind of BROKER_TASK_KINDS) {
    assert.equal(taskContractDescriptorFor(kind).digest, REQUIRED_CODEX_TASK_CONTRACT_DIGESTS[kind]);
  }
  await withBroker(openai, async (server) => {
    const health = server.healthReport();
    assert.deepEqual([...health.taskKinds].sort(), canonical);
    assert.deepEqual(Object.keys(health.taskContracts).sort(), canonical);
  });
});

test(`${layer}: topic article body and series/audio context survive both profile parsers while illegal fields fail closed`, () => {
  const signal = {
    id: "signal-1", sourceId: "source-report", platform: "douyin", rank: 1,
    title: "只含笼统标题", collectedAt: "2026-09-14T08:00:00.000Z", relatedSignals: [],
    articleSources: [articleSource],
  };
  const topic = topicIdeasModelPayload([signal], { customInstruction: "优先可追溯事实" }).payload;
  const script = {
    brief: {
      title: "从正文核对一个结论", angle: "区分标题与正文", audience: "普通观众", nicheSlug: "source-reading",
      platform: "douyin", durationSeconds: 30, durationRange: { minSeconds: 24, maxSeconds: 40 },
      articleSources: [articleSource], seriesContext: { bible: { premise: "不虚构结果" }, canon: [], continuity: { fromPrevious: [], toNext: [] } },
      creativeTreatment: treatment, productionCapabilities, voiceTiming: { rate: 120, pauseScale: 2 },
    },
  };
  const { nicheSlug: _nicheSlug, ...directorBrief } = script.brief;
  const director = {
    directorProfiles: [{ id: "documentary-observer" }],
    brief: { ...directorBrief, requestedProfileId: "auto" },
    scenes: [{ position: 1, narration: "核对正文。", duration: 30, visualPrompt: "查看正文段落", visualStrategy: "stock" }],
    assetProviders: [{ id: "pexels-stock-v1", label: "Pexels", deliveryTypes: ["stock_video"], estimatedCnyPerClip: 0 }],
    economics: { allowMeteredProviders: false },
  };
  for (const profile of [codexExecutorProfileFor("openai", "gpt-5.6-sol").identity, codexExecutorProfileFor("zai").identity]) {
    const parsedTopic = request("topic-ideas", topic, profile);
    assert.equal(parsedTopic.payload.signals[0].articleSources[0].paragraphs[0].id, "p1");
    for (const [kind, payload] of [["script-draft", script], ["director-plan", director]]) {
      const parsed = request(kind, payload, profile);
      assert.deepEqual(parsed.payload.brief.articleSources, [articleSource]);
      assert.deepEqual(parsed.payload.brief.voiceTiming, { rate: 120, pauseScale: 2 });
      assert.deepEqual(parsed.payload.brief.seriesContext, script.brief.seriesContext);
      assert.throws(() => request(kind, { ...payload, unexpected: true }, profile), /unexpected is not allowed/i);
    }
  }
});

for (const profile of ["openai", "zai"]) {
  test(`${layer}: ${profile} executor and Broker/client validate every creative discussion intent`, async () => {
    const intents = ["explain", "propose", "revise", "clarify", "request_upstream_change"];
    const outputs = intents.map(discussionOutput);
    const executor = profile === "openai"
      ? new CodexExecutor({
          workspaceRoot: await mkdtemp(path.join(tmpdir(), "vf-r11-openai-executor-")),
          profile: codexExecutorProfileFor("openai", "gpt-5.6-sol"),
          model: "gpt-5.6-sol",
          effort: "xhigh",
          spawnFn: fakeCodexSpawn([...outputs]),
        })
      : new ZaiCodePlanExecutor({
          env: { ZAI_BIGMODEL_API_KEY: "isolated-test-only-not-a-credential", ZAI_TEXT_MODEL_ID: "glm-5.3" },
          effort: "max",
          fetchFn: async () => new Response(JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(outputs.shift()) } }],
          }), { status: 200, headers: { "content-type": "application/json" } }),
        });
    await withBroker(executor, async (_server, socketPath) => {
      const client = new CodexBridgeClient({ socketPath, timeoutMs: 4_000, maxAttempts: 1, pollIntervalMs: 5 });
      for (const intent of intents) {
        const result = await client.runTaskDetailed("creative-discussion", discussionPayload(), `r11-${layer}-${profile}-${intent}`);
        assert.equal(result.output.intent, intent);
        assert.equal(outputValidationErrorFor("creative-discussion", result.output), undefined);
      }
    });
    const invalid = { ...discussionOutput("propose"), treatment: null };
    assert.match(outputValidationErrorFor("creative-discussion", invalid), /document matching stage/i);
  });
}
