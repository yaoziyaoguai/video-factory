import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { REQUIRED_CODEX_TASK_CONTRACT_DIGESTS } from "@video-factory/production-pipeline";
import {
  DEFAULT_CODEX_SOCKET_PATH,
  DEFAULT_DEEPSEEK_CODEX_SOCKET_PATH,
  auditedRoleCandidateAvailability,
  readCodexProviderSettings,
  readDeepseekCodexProviderSettings,
  resolveCodexSocketPath,
  type CodexSocketStatus,
} from "../src/server/codex-provider-settings.js";
import { buildProviderCatalog } from "../src/server/provider-catalog.js";

describe("resolveCodexSocketPath", () => {
  it("falls back to the default socket path when the env is unset", () => {
    const resolution = resolveCodexSocketPath({});

    assert.equal(resolution.socketPath, DEFAULT_CODEX_SOCKET_PATH);
    assert.equal(resolution.configured, false);
    assert.match(resolution.requirement, /VIDEO_FACTORY_CODEX_SOCKET_PATH/);
  });

  it("uses a trimmed custom socket path", () => {
    const resolution = resolveCodexSocketPath({ VIDEO_FACTORY_CODEX_SOCKET_PATH: "  /tmp/vf/custom.sock  " });

    assert.equal(resolution.socketPath, "/tmp/vf/custom.sock");
    assert.equal(resolution.configured, true);
  });
});

describe("readCodexProviderSettings", () => {
  it("reports available and passes the resolved path to the probe", async () => {
    const probedPaths: string[] = [];

    const settings = await readCodexProviderSettings(
      { VIDEO_FACTORY_CODEX_SOCKET_PATH: "/tmp/vf/ready.sock" },
      {
        socketProbe: async (socketPath) => {
          probedPaths.push(socketPath);
          return "ready";
        },
      },
    );

    assert.deepEqual(probedPaths, ["/tmp/vf/ready.sock"]);
    assert.equal(settings.socketPath, "/tmp/vf/ready.sock");
    assert.equal(settings.configured, true);
    assert.equal(settings.available, true);
    assert.equal(settings.modelId, "");
    assert.equal(settings.reason, "");
    assert.ok(settings.taskKinds.includes("reference-grammar"));
    // 前期构思角色与 role-audit 一起构成健康候选：没有独立审计能力的 broker 不能承担构思生产。
    assert.ok(settings.taskKinds.includes("creative-treatment"));
    assert.ok(settings.taskKinds.includes("role-audit"));
    assert.deepEqual(
      auditedRoleCandidateAvailability(settings, { available: false, taskKinds: [] }, "creative-treatment"),
      { codex: true, deepseek: false },
    );
  });

  it("reports an exact reason for each failure status on the default path", async () => {
    const cases: Array<{ status: CodexSocketStatus; reason: string }> = [
      {
        status: "missing",
        reason: `未找到 Codex bridge socket '${DEFAULT_CODEX_SOCKET_PATH}'；请确认宿主机 broker 已启动。`,
      },
      {
        status: "not_a_socket",
        reason: `'${DEFAULT_CODEX_SOCKET_PATH}' 存在但不是 Unix socket。`,
      },
      {
        status: "inaccessible",
        reason: `当前进程对 '${DEFAULT_CODEX_SOCKET_PATH}' 没有写权限；请检查宿主机侧 socket 的组权限。`,
      },
      {
        status: "unreachable",
        reason: `Codex bridge socket '${DEFAULT_CODEX_SOCKET_PATH}' 存在，但健康检查无法连接。`,
      },
      {
        status: "protocol_mismatch",
        reason: `Codex bridge socket '${DEFAULT_CODEX_SOCKET_PATH}' 使用了不兼容的协议版本。`,
      },
    ];
    for (const testCase of cases) {
      let probedPath = "";
      const settings = await readCodexProviderSettings({}, {
        socketProbe: async (socketPath) => {
          probedPath = socketPath;
          return testCase.status;
        },
      });
      assert.equal(probedPath, DEFAULT_CODEX_SOCKET_PATH);
      assert.equal(settings.available, false);
      assert.equal(settings.reason, testCase.reason);
    }
  });

  it("requires a reachable health endpoint with the current bridge protocol", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-codex-settings-"));
    const socketPath = path.join(directory, "worker.sock");
    let protocolVersion = "video-factory/codex-bridge-v2";
    let modelId = "gpt-5.6-terra";
    let taskModels: Record<string, string> = {
      "director-plan": "gpt-5.6-terra",
      "role-audit": "gpt-5.6-sol",
      "visual-review": "gpt-5.6-sol",
    };
    let taskKinds = ["topic-ideas", "series-roadmap", "creative-treatment", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"];
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion,
        profileId: "openai",
        providerId: "openai",
        modelId,
        taskModels,
        taskKinds,
        taskContracts: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const ready = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(ready.available, true);
      assert.equal(ready.modelId, "gpt-5.6-terra");
      assert.deepEqual(ready.taskModels, taskModels);
      assert.ok(ready.taskKinds.includes("visual-review"));

      const explicitlyMismatched = await readCodexProviderSettings({
        VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath,
        VIDEO_FACTORY_CODEX_MODEL: "gpt-5.6-luna",
      });
      assert.equal(explicitlyMismatched.available, false);
      assert.equal(explicitlyMismatched.modelId, "gpt-5.6-terra");

      taskKinds = ["topic-ideas", "script-draft"];
      taskModels = {};
      const partial = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(partial.available, true);
      assert.deepEqual(partial.taskKinds, taskKinds);

      protocolVersion = "video-factory/codex-bridge-v1";
      const mismatched = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(mismatched.available, false);
      assert.match(mismatched.reason, /不兼容的协议版本/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when creative-treatment is advertised without the pinned contract digest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-codex-settings-treatment-digest-"));
    const socketPath = path.join(directory, "worker.sock");
    const pinnedDigests = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS as Record<string, string>;
    let taskContracts: Record<string, string> = { ...pinnedDigests, "creative-treatment": "0".repeat(64) };
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "video-factory/codex-bridge-v2",
        profileId: "openai",
        providerId: "openai",
        modelId: "gpt-5.6-terra",
        taskKinds: ["creative-treatment", "role-audit"],
        taskModels: { "creative-treatment": "gpt-5.6-terra", "role-audit": "gpt-5.6-terra" },
        taskContracts,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const wrongDigest = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(wrongDigest.available, false);
      assert.match(wrongDigest.reason, /不兼容的协议版本/);

      taskContracts = { ...pinnedDigests };
      delete taskContracts["creative-treatment"];
      const missingDigest = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(missingDigest.available, false);
      assert.match(missingDigest.reason, /不兼容的协议版本/);

      taskContracts = { ...pinnedDigests };
      const ready = await readCodexProviderSettings({ VIDEO_FACTORY_CODEX_SOCKET_PATH: socketPath });
      assert.equal(ready.available, true);
      assert.ok(ready.taskKinds.includes("creative-treatment"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("readDeepseekCodexProviderSettings", () => {
  it("requires the exact DeepSeek broker identity and preserves task models", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-deepseek-codex-settings-"));
    const socketPath = path.join(directory, "worker.sock");
    let identity: Record<string, unknown> = {
      profileId: "deepseek",
      providerId: "deepseek",
      modelId: "deepseek-flash",
      taskKinds: ["topic-ideas", "series-roadmap", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"],
      taskModels: {
        "topic-ideas": "deepseek-flash",
        "series-roadmap": "deepseek-flash",
        "director-plan": "deepseek-flash",
        "script-draft": "deepseek-flash",
        "publish-copy": "deepseek-flash",
        "asset-rank": "deepseek-v4-pro",
        "reference-grammar": "deepseek-flash",
        "visual-review": "deepseek-flash",
        "role-audit": "deepseek-v4-pro",
      },
      // 带图的任务只能落到 flash：pro 接受 image_url 却收不到图像，会把"没看过图"当成审片结论。
      // 纯文本的 asset-rank / role-audit 走 pro 是合法的，夹具故意这样配，才验得出 studio 是
      // 原样保留 broker 公告的路由、而不是自己按 kind 猜一个。
      taskModelRoutes: {
        "asset-rank": { withoutImages: "deepseek-v4-pro", withImages: "deepseek-flash" },
        "role-audit": { withoutImages: "deepseek-v4-pro", withImages: "deepseek-flash" },
      },
      taskContracts: REQUIRED_CODEX_TASK_CONTRACT_DIGESTS,
    };
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ protocolVersion: "video-factory/codex-bridge-v2", ...identity }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const ready = await readDeepseekCodexProviderSettings({ VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath });
      assert.equal(ready.available, true);
      assert.equal(ready.taskModels?.["visual-review"], "deepseek-flash");
      assert.deepEqual(ready.taskModelRoutes, identity.taskModelRoutes);

      identity = { ...identity, taskModelRoutes: { "role-audit": { withImages: "deepseek-flash" } } };
      const malformedRoute = await readDeepseekCodexProviderSettings({ VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath });
      assert.equal(malformedRoute.available, false);
      assert.match(malformedRoute.reason, /不兼容的协议版本/);

      identity = {
        ...identity,
        modelId: "deepseek-flash-preview",
        taskModelRoutes: {
          "asset-rank": { withoutImages: "deepseek-v4-pro", withImages: "deepseek-flash" },
          "role-audit": { withoutImages: "deepseek-v4-pro", withImages: "deepseek-flash" },
        },
      };
      const brokerSelectedModel = await readDeepseekCodexProviderSettings({
        VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath,
        DEEPSEEK_TEXT_MODEL_ID: "studio-does-not-own-this-setting",
      });
      assert.equal(brokerSelectedModel.available, true);
      assert.equal(brokerSelectedModel.modelId, "deepseek-flash-preview");
      assert.deepEqual(brokerSelectedModel.taskModels, identity.taskModels);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a distinct default socket from the OpenAI Codex broker", async () => {
    let probedPath = "";
    await readDeepseekCodexProviderSettings({}, { socketProbe: async (socketPath) => {
      probedPath = socketPath;
      return "missing";
    } });
    assert.equal(probedPath, DEFAULT_DEEPSEEK_CODEX_SOCKET_PATH);
    assert.notEqual(DEFAULT_DEEPSEEK_CODEX_SOCKET_PATH, DEFAULT_CODEX_SOCKET_PATH);
  });

  it("fails closed when DeepSeek advertises creative-treatment without the pinned contract digest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-ds-treatment-digest-"));
    const socketPath = path.join(directory, "worker.sock");
    const pinnedDigests = REQUIRED_CODEX_TASK_CONTRACT_DIGESTS as Record<string, string>;
    let taskContracts: Record<string, string> = { ...pinnedDigests, "creative-treatment": "0".repeat(64) };
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: "video-factory/codex-bridge-v2",
        profileId: "deepseek",
        providerId: "deepseek",
        modelId: "deepseek-flash",
        taskKinds: ["creative-treatment", "role-audit"],
        taskModels: { "creative-treatment": "deepseek-flash", "role-audit": "deepseek-v4-pro" },
        taskContracts,
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const wrongDigest = await readDeepseekCodexProviderSettings({ VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath });
      assert.equal(wrongDigest.available, false);
      assert.match(wrongDigest.reason, /不兼容的协议版本/);

      taskContracts = { ...pinnedDigests };
      delete taskContracts["creative-treatment"];
      const missingDigest = await readDeepseekCodexProviderSettings({ VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath });
      assert.equal(missingDigest.available, false);
      assert.match(missingDigest.reason, /不兼容的协议版本/);

      taskContracts = { ...pinnedDigests };
      const ready = await readDeepseekCodexProviderSettings({ VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH: socketPath });
      assert.equal(ready.available, true);
      assert.ok(ready.taskKinds.includes("creative-treatment"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("auditedRoleCandidateAvailability", () => {
  const unavailable = { available: false, taskKinds: [] };

  it("selects only OpenAI when it owns both production and independent audit tasks", () => {
    assert.deepEqual(auditedRoleCandidateAvailability(
      { available: true, taskKinds: ["script-draft", "role-audit"] },
      unavailable,
      "script-draft",
    ), { codex: true, deepseek: false });
  });

  it("selects only DeepSeek when DeepSeek owns both production and independent audit", () => {
    assert.deepEqual(auditedRoleCandidateAvailability(
      { available: true, taskKinds: ["role-audit"] },
      { available: true, taskKinds: ["script-draft", "role-audit"] },
      "script-draft",
    ), { codex: false, deepseek: true });
  });

  it("selects only providers that own both the producer and audit tasks", () => {
    assert.deepEqual(auditedRoleCandidateAvailability(
      { available: true, taskKinds: ["director-plan", "role-audit"] },
      { available: true, taskKinds: ["director-plan"] },
      "director-plan",
    ), { codex: true, deepseek: false });
    assert.deepEqual(auditedRoleCandidateAvailability(
      { available: true, taskKinds: ["director-plan"] },
      { available: true, taskKinds: ["director-plan"] },
      "director-plan",
    ), { codex: false, deepseek: false });
  });
});

describe("buildProviderCatalog codex fallback", () => {
  it("does not repeat the same unavailable reason for production and audit tasks", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: false, reason: "OpenAI broker unavailable" },
      { available: false, reason: "DeepSeek broker unavailable" },
    );

    const requirement = providers.find((provider) => provider.id === "api-visual-director-v1")?.requirement ?? "";
    assert.equal(requirement.match(/OpenAI broker unavailable/g)?.length, 1);
    assert.equal(requirement.match(/DeepSeek broker unavailable/g)?.length, 1);
  });

  it("shows reviewed video model catalogs before provider credentials are configured", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: false, reason: "not running" },
    );

    const wan = providers.find((provider) => provider.id === "wan-video-v1");
    assert.equal(wan?.available, false);
    assert.equal(wan?.defaultModelId, "wan3.0-video");
    assert.deepEqual(wan?.modelProfiles?.map((model) => model.id), [
      "wan3.0-video",
      "wan3.0-video-prime",
    ]);
    assert.equal(wan?.modelProfiles?.every((model) => model.available === false), true);
    assert.deepEqual(wan?.modelProfiles?.[0]?.resolutions, ["720P"]);
    assert.match(wan?.modelProfiles?.[0]?.description ?? "", /当前接入文生视频、720P、2–15 秒/);

    const miniMax = providers.find((provider) => provider.id === "hailuo-video-v1");
    assert.deepEqual(miniMax?.modelProfiles?.map((model) => model.id), [
      "MiniMax-Hailuo-2.3",
      "MiniMax-H3",
      "MiniMax-H3-Max",
    ]);
    assert.match(miniMax?.modelProfiles?.[0]?.description ?? "", /只能可靠交付横屏.*不能用于.*9:16/);
  });

  it("keeps every role unavailable until one provider owns production and audit", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", taskKinds: ["topic-ideas", "script-draft"] },
    );

    assert.equal(providers.find((provider) => provider.id === "api-topic-editor-v1")?.available, false);
    assert.equal(providers.find((provider) => provider.id === "codex-screenwriter-v1")?.available, false);
    const director = providers.find((provider) => provider.id === "api-visual-director-v1");
    assert.equal(director?.available, false);
    assert.equal(director?.modelProfiles?.[0]?.available, false);
    assert.equal(providers.find((provider) => provider.id === "codex-screenwriter-v1")?.modelProfiles?.[0]?.available, false);
    assert.match(director?.requirement ?? "", /role-audit/);
    const showrunner = providers.find((provider) => provider.id === "codex-series-showrunner-v1");
    const auditor = providers.find((provider) => provider.id === "codex-role-auditor-v1");
    assert.equal(showrunner?.available, false);
    assert.equal(auditor?.available, false);
    assert.match(showrunner?.requirement ?? "", /series-roadmap/);
    assert.match(auditor?.requirement ?? "", /role-audit/);
  });

  it("advertises series planning and independent audit only when the broker declares both tasks", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", taskKinds: ["series-roadmap", "role-audit"] },
    );

    assert.equal(providers.find((provider) => provider.id === "codex-series-showrunner-v1")?.available, true);
    assert.equal(providers.find((provider) => provider.id === "codex-role-auditor-v1")?.available, true);
  });

  it("shows the model actually reported by the OpenAI broker", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", modelId: "gpt-5.6-sol", taskKinds: ["script-draft", "role-audit"] },
    );

    const screenwriter = providers.find((provider) => provider.id === "codex-screenwriter-v1");
    assert.equal(screenwriter?.defaultModelId, "gpt-5.6-sol");
    assert.deepEqual(screenwriter?.modelProfiles?.map((model) => model.id), ["deepseek-flash", "gpt-5.6-sol"]);
  });

  it("offers every reviewed broker model to roles that can switch per request, and only the default elsewhere", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      {
        available: true,
        reason: "",
        modelId: "gpt-5.6-sol",
        taskKinds: ["script-draft", "director-plan", "role-audit"],
        modelCandidates: ["gpt-5.6-sol", "gpt-6-astra"],
      },
    );

    // script-draft 已接入"按请求换模型"：候选表里的每个模型都能真的送上线路，所以全部列出；
    // 最前面的 deepseek-flash 是每个角色都有的跨 broker 首选候选，此处没有 DeepSeek broker，所以它不可用。
    const screenwriter = providers.find((provider) => provider.id === "codex-screenwriter-v1");
    assert.deepEqual(
      screenwriter?.modelProfiles?.map((model) => [model.id, model.recommended]),
      [["deepseek-flash", false], ["gpt-5.6-sol", true], ["gpt-6-astra", false]],
    );
    assert.equal(screenwriter?.defaultModelId, "gpt-5.6-sol");

    // 构思、导演、独立复核也已经按请求换模型了：这几条腿的候选 agent 同样按公告表逐个建出来，
    // 选中哪一个都能真的送上线路，所以候选表也要列进界面。
    for (const providerId of ["codex-creative-treatment-v1", "api-visual-director-v1", "codex-role-auditor-v1"]) {
      assert.deepEqual(
        providers.find((provider) => provider.id === providerId)?.modelProfiles?.map((model) => model.id),
        ["deepseek-flash", "gpt-5.6-sol", "gpt-6-astra"],
        `${providerId} 应当列出 broker 公告的全部候选模型`,
      );
    }

    // 其余角色还没有按请求换模型的能力，展开候选表只会列出选中必然报错的选项。
    const publishCopy = providers.find((provider) => provider.id === "codex-publish-copy-v1");
    assert.deepEqual(publishCopy?.modelProfiles?.map((model) => model.id), ["deepseek-flash", "gpt-5.6-sol"]);
  });

  it("shows the role-specific production and audit models reported by the broker", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      {
        available: true,
        reason: "",
        modelId: "gpt-5.6-terra",
        taskKinds: ["director-plan", "role-audit"],
        taskModels: {
          "director-plan": "gpt-5.6-terra",
          "role-audit": "gpt-5.6-sol",
        },
      },
    );

    assert.equal(providers.find((provider) => provider.id === "api-visual-director-v1")?.defaultModelId, "gpt-5.6-terra");
    assert.equal(providers.find((provider) => provider.id === "codex-role-auditor-v1")?.defaultModelId, "gpt-5.6-sol");
  });

  it("offers DeepSeek and OpenAI as one ordered model pool for script and director nodes", () => {
    const taskKinds = ["script-draft", "director-plan", "role-audit"];
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      {
        available: true,
        reason: "",
        taskKinds,
        modelId: "gpt-5.6-sol",
        taskModels: { "script-draft": "gpt-5.6-sol", "director-plan": "gpt-5.6-sol", "role-audit": "gpt-5.6-sol" },
      },
      {
        available: true,
        reason: "",
        taskKinds: ["script-draft", "director-plan"],
        modelId: "deepseek-flash",
        taskModels: { "script-draft": "deepseek-flash", "director-plan": "deepseek-flash" },
      },
    );

    for (const providerId of ["codex-screenwriter-v1", "api-visual-director-v1"]) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      assert.equal(provider?.available, true);
      assert.equal(provider?.defaultModelId, "gpt-5.6-sol");
      assert.deepEqual(provider?.modelProfiles?.map((model) => model.id), ["deepseek-flash", "gpt-5.6-sol"]);
      assert.deepEqual(provider?.modelProfiles?.map((model) => model.recommended), [false, true]);
      assert.deepEqual(provider?.modelProfiles?.map((model) => model.providerFamily), ["deepseek", "openai"]);
    }
  });

  it("keeps the shot router unavailable when production and audit are split across providers", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      {
        available: true,
        reason: "",
        taskKinds: ["role-audit"],
        modelId: "gpt-5.6-sol",
      },
      {
        available: true,
        reason: "",
        taskKinds: ["script-draft", "director-plan"],
        modelId: "deepseek-flash",
      },
    );

    assert.equal(providers.find((provider) => provider.id === "api-visual-director-v1")?.available, false);
    assert.equal(providers.find((provider) => provider.id === "ai-shot-router-v1")?.available, false);
  });

  it("keeps configured metered models unavailable when the production runtime is missing", () => {
    const providers = buildProviderCatalog(
      { python: false, ffmpeg: false, ffprobe: false, say: false },
      {
        ARK_API_KEY: "test-ark-key",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "2",
        MINIMAX_API_KEY: "test-minimax-key",
        MINIMAX_VIDEO_MODEL_ID: "MiniMax-Hailuo-2.3",
        MINIMAX_ESTIMATED_CNY_PER_CLIP: "1",
      },
      { available: false, reason: "not running" },
    );

    for (const providerId of ["seedream-image-v1", "seedance-video-v1", "hailuo-video-v1", "minimax-tts-v1"]) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      assert.equal(provider?.available, false);
      assert.equal(provider?.modelProfiles?.every((model) => model.available === false), true);
    }
  });

  it("does not advertise an unprobed socket as compatible", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      { VIDEO_FACTORY_CODEX_SOCKET_PATH: "/tmp/vf/unprobed.sock" },
    );
    const codex = providers.find((provider) => provider.id === "api-topic-editor-v1");

    assert.equal(codex?.available, false);
    assert.match(codex?.requirement ?? "", /尚未.*协议健康检查/);
  });

  it("advertises visual review only after the OpenAI Codex broker probe succeeds", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "" },
    );
    const visualReview = providers.find((provider) => provider.id === "codex-visual-review-v1");

    assert.equal(visualReview?.available, true);
    assert.equal(visualReview?.billing, "subscription");
    assert.equal(visualReview?.capability, "quality.review.visual");
  });

  it("advertises DeepSeek as the preferred visual reviewer only after its isolated broker is ready", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "" },
      { available: true, reason: "" },
    );
    const deepseek = providers.find((provider) => provider.id === "deepseek-visual-review-v1");

    assert.equal(deepseek?.label, "DeepSeek 视觉审片");
    assert.equal(deepseek?.available, true);
    assert.equal(deepseek?.billing, "subscription");
    assert.equal(deepseek?.approvalPolicy, "none");
    assert.equal(deepseek?.estimatedCnyPerClip, undefined);
    assert.equal(deepseek?.capability, "quality.review.visual");
    assert.match(deepseek?.description ?? "", /deepseek-flash/);
    assert.match(deepseek?.description ?? "", /关键帧/);
  });

  it("does not advertise DeepSeek visual review without its own independent audit task", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", taskKinds: ["visual-review"] },
      { available: true, reason: "", taskKinds: ["visual-review"] },
    );
    const deepseek = providers.find((provider) => provider.id === "deepseek-visual-review-v1");

    assert.equal(deepseek?.available, false);
    assert.equal(deepseek?.modelProfiles?.[0]?.available, false);
    assert.match(deepseek?.requirement ?? "", /role-audit/);
    assert.match(deepseek?.requirement ?? "", /独立质量复核/);
  });

  it("shows the configured DeepSeek visual-review model instead of a hard-coded model", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      { DEEPSEEK_MODEL_ID: "deepseek-flash-preview" },
      { available: true, reason: "" },
      { available: true, reason: "", taskKinds: ["visual-review"] },
    );
    const deepseek = providers.find((provider) => provider.id === "deepseek-visual-review-v1");

    assert.equal(deepseek?.defaultModelId, "deepseek-flash-preview");
    assert.equal(deepseek?.modelProfiles?.[0]?.id, "deepseek-flash-preview");
  });

  it("keeps digital-human generation separate from ordinary Ark video models", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      { ARK_API_KEY: "configured-ark-key" },
      { available: true, reason: "" },
    );
    const digitalHuman = providers.find((provider) => provider.id === "volcengine-omnihuman-v1");

    assert.equal(digitalHuman?.available, false);
    assert.equal(digitalHuman?.status, "planned");
    assert.equal(digitalHuman?.capability, "avatar.generate");
    assert.deepEqual(digitalHuman?.modelProfiles?.[0]?.taskTypes, ["digital-human"]);
    assert.match(digitalHuman?.requirement ?? "", /火山引擎视觉内容生成服务与 OmniHuman 权限/);
    assert.match(digitalHuman?.requirement ?? "", /普通方舟模型权限不能替代/);
  });

  it("describes creator-facing media setup without deployment variable names", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: true },
      {},
      { available: true, reason: "" },
      { available: true, reason: "" },
    );
    const mediaProviderIds = [
      "pexels-stock-v1",
      "pixabay-stock-v1",
      "seedream-image-v1",
      "seedance-video-v1",
      "hailuo-video-v1",
      "wan-video-v1",
      "minimax-tts-v1",
      "volcengine-omnihuman-v1",
    ];
    const requirements = mediaProviderIds.map((providerId) => {
      const provider = providers.find((candidate) => candidate.id === providerId);
      assert.ok(provider, `missing provider ${providerId}`);
      return provider.requirement ?? "";
    });

    assert.equal(requirements.every((requirement) => requirement.length > 0), true);
    assert.doesNotMatch(requirements.join("\n"), /\b[A-Z][A-Z0-9_]*(?:API_KEY|MODEL_ID|WORKSPACE_ID|CNY_PER_CLIP)\b|AK\/SK/);
    assert.match(requirements.join("\n"), /账号|图库服务/);
  });
});
