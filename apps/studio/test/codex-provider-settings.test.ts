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
    assert.equal(settings.reason, "");
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
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion,
        profileId: "openai",
        providerId: "openai",
        modelId: "codex-default",
        taskKinds: ["topic-ideas", "director-plan", "script-draft", "publish-copy", "visual-review"],
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
      providerId: "zai-coding-plan",
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
    assert.equal(glm?.billing, "subscription");
    assert.equal(glm?.capability, "quality.review.visual");
    assert.match(glm?.description ?? "", /GLM-5\.3-Flash/);
  });
});
