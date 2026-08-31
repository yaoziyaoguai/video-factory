import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_CODEX_SOCKET_PATH,
  DEFAULT_ZAI_CODEX_SOCKET_PATH,
  readCodexProviderSettings,
  readZaiCodexProviderSettings,
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
    let taskKinds = ["topic-ideas", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"];
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion,
        profileId: "openai",
        providerId: "openai",
        modelId,
        taskModels,
        taskKinds,
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
});

describe("readZaiCodexProviderSettings", () => {
  it("requires the exact visual-review broker identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-zai-codex-settings-"));
    const socketPath = path.join(directory, "worker.sock");
    let identity = {
      profileId: "zai",
      providerId: "zai-bigmodel-api",
      modelId: "glm-5.3-flash",
      taskKinds: ["visual-review"],
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
      const ready = await readZaiCodexProviderSettings({ VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH: socketPath });
      assert.equal(ready.available, true);

      identity = { ...identity, modelId: "GLM-4.6V-Flash" };
      const wrongModel = await readZaiCodexProviderSettings({ VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH: socketPath });
      assert.equal(wrongModel.available, false);
      assert.match(wrongModel.reason, /模型身份或任务权限/);

      identity = { ...identity, modelId: "glm-5.3-flash-preview" };
      const configuredModel = await readZaiCodexProviderSettings({
        VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH: socketPath,
        ZAI_VISUAL_REVIEW_MODEL_ID: "glm-5.3-flash-preview",
      });
      assert.equal(configuredModel.available, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a distinct default socket from the OpenAI Codex broker", async () => {
    let probedPath = "";
    await readZaiCodexProviderSettings({}, { socketProbe: async (socketPath) => {
      probedPath = socketPath;
      return "missing";
    } });
    assert.equal(probedPath, DEFAULT_ZAI_CODEX_SOCKET_PATH);
    assert.notEqual(DEFAULT_ZAI_CODEX_SOCKET_PATH, DEFAULT_CODEX_SOCKET_PATH);
  });
});

describe("buildProviderCatalog codex fallback", () => {
  it("keeps existing broker tasks available during a capability-expanding rollout", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", taskKinds: ["topic-ideas", "script-draft"] },
    );

    assert.equal(providers.find((provider) => provider.id === "api-topic-editor-v1")?.available, true);
    assert.equal(providers.find((provider) => provider.id === "codex-screenwriter-v1")?.available, true);
    const director = providers.find((provider) => provider.id === "api-visual-director-v1");
    assert.equal(director?.available, false);
    assert.equal(director?.modelProfiles?.[0]?.available, false);
    assert.equal(providers.find((provider) => provider.id === "codex-screenwriter-v1")?.modelProfiles?.[0]?.available, true);
    assert.match(director?.requirement ?? "", /director-plan/);
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
      { available: true, reason: "", modelId: "gpt-5.6-sol", taskKinds: ["script-draft"] },
    );

    const screenwriter = providers.find((provider) => provider.id === "codex-screenwriter-v1");
    assert.equal(screenwriter?.defaultModelId, "gpt-5.6-sol");
    assert.equal(screenwriter?.modelProfiles?.[0]?.id, "gpt-5.6-sol");
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

  it("keeps configured metered models unavailable when the production runtime is missing", () => {
    const providers = buildProviderCatalog(
      { python: false, ffmpeg: false, ffprobe: false, say: false },
      {
        ARK_API_KEY: "test-ark-key",
        SEEDANCE_ESTIMATED_CNY_PER_CLIP: "2",
        MINIMAX_API_KEY: "test-minimax-key",
        MINIMAX_VIDEO_MODEL_ID: "MiniMax-Hailuo-02",
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

  it("advertises GLM-5.3-Flash as the preferred visual reviewer only after its isolated broker is ready", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "" },
      { available: true, reason: "" },
    );
    const glm = providers.find((provider) => provider.id === "glm-visual-review-v1");

    assert.equal(glm?.available, true);
    assert.equal(glm?.billing, "metered");
    assert.equal(glm?.estimatedCnyPerClip, 0.1);
    assert.equal(glm?.billingUnit, "run");
    assert.equal(glm?.capability, "quality.review.visual");
    assert.match(glm?.description ?? "", /GLM-5\.3-Flash/);
    assert.doesNotMatch(glm?.description ?? "", /Coding Plan/);
  });

  it("does not advertise GLM visual review without an independent Codex role auditor", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      {},
      { available: true, reason: "", taskKinds: ["visual-review"] },
      { available: true, reason: "", taskKinds: ["visual-review"] },
    );
    const glm = providers.find((provider) => provider.id === "glm-visual-review-v1");

    assert.equal(glm?.available, false);
    assert.equal(glm?.modelProfiles?.[0]?.available, false);
    assert.match(glm?.requirement ?? "", /role-audit/);
    assert.match(glm?.requirement ?? "", /独立 Codex Agent/);
  });

  it("shows the configured GLM visual-review model instead of a hard-coded model", () => {
    const providers = buildProviderCatalog(
      { python: true, ffmpeg: true, ffprobe: true, say: false },
      { ZAI_VISUAL_REVIEW_MODEL_ID: "glm-5.3-flash-preview" },
      { available: true, reason: "" },
      { available: true, reason: "", taskKinds: ["visual-review"] },
    );
    const glm = providers.find((provider) => provider.id === "glm-visual-review-v1");

    assert.equal(glm?.defaultModelId, "glm-5.3-flash-preview");
    assert.equal(glm?.modelProfiles?.[0]?.id, "glm-5.3-flash-preview");
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
    assert.match(digitalHuman?.requirement ?? "", /AK\/SK/);
    assert.match(digitalHuman?.requirement ?? "", /ARK_API_KEY 不能替代/);
  });
});
