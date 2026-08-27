import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const brokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(brokerRoot, "../..");

describe("ZAI systemd service sample", () => {
  it("isolates runtime state and enforces a 0600 sensitive environment file", async () => {
    const service = await readFile(
      path.join(brokerRoot, "deploy", "vf-zai-codex-broker.service"),
      "utf8",
    );

    assert.match(service, /^User=vf-zai-codex$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_PROFILE=zai$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_EFFORT=max$/m);
    assert.match(service, /^EnvironmentFile=\/etc\/video-factory\/zai-codex-broker\.env$/m);
    assert.match(service, /stat -c %%U:%%G \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(service, /stat -c %%a \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.doesNotMatch(service, /stat -c %U:%G \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(service, /test .* = 600/);
    assert.match(service, /^Group=vf-bridge$/m);
    assert.match(service, /^UMask=0007$/m);
    assert.match(service, /^RuntimeDirectoryMode=0750$/m);
    assert.match(service, /^RuntimeDirectoryPreserve=restart$/m);
    assert.match(service, /\/run\/video-factory-zai-codex\/worker\.sock/);
    assert.doesNotMatch(service, /CODEX_HOME|CODEX_BIN|MODEL_CATALOG/);
    assert.match(service, /ZAI_BIGMODEL_API_KEY/);
    assert.match(service, /^UnsetEnvironment=ZAI_API_KEY$/m);
    assert.match(service, /grep -q "\^ZAI_API_KEY"/);
    assert.doesNotMatch(service, /ZAI_(?:BIGMODEL_)?API_KEY\s*=/);
  });

  it("uses the validated shared Node runtime without installing a second Codex CLI", async () => {
    const script = await readFile(
      path.join(repositoryRoot, "scripts", "setup-zai-codex-broker-host.sh"),
      "utf8",
    );

    assert.match(script, /node_bin="\$broker_root\/bin\/node"/);
    assert.match(script, /runuser -u "\$broker_user"[\s\S]*"\$node_bin" --version/);
    assert.doesNotMatch(script, /npm_bin|codex_bin|@openai\/codex|zai-models\.json/);
  });

  it("keeps the local BigModel key in a broker-only ignored environment file", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "studio-dev-with-codex.sh"), "utf8");

    assert.match(script, /\.local\/secrets\/zai-bigmodel\.env/);
    assert.match(script, /node --env-file="\$zai_env_file" apps\/codex-broker\/dist\/main\.js/);
    assert.doesNotMatch(script, /node --env-file="\$repository_root\/\.env"/);
  });

  it("pins the official BigModel Chat Completion endpoint", async () => {
    const executor = await readFile(
      path.join(brokerRoot, "src", "zai-visual-review-executor.ts"),
      "utf8",
    );

    assert.match(executor, /https:\/\/open\.bigmodel\.cn\/api\/paas\/v4\/chat\/completions/);
    assert.doesNotMatch(executor, /\/api\/coding\/paas\/v4/);
    assert.match(executor, /model: ZAI_MODEL_ID/);
    assert.match(executor, /type: "image_url"/);
    assert.match(executor, /response_format: \{ type: "json_object" \}/);
  });

  it("keeps the Unix socket connectable by vf-bridge and explicitly fixes its mode after listen", async () => {
    const server = await readFile(path.join(brokerRoot, "src", "broker-server.ts"), "utf8");

    assert.match(server, /const DEFAULT_SOCKET_MODE = 0o660;/);
    assert.match(
      server,
      /this\.server\.listen\([\s\S]*?await chmod\(this\.options\.socketPath, DEFAULT_SOCKET_MODE\);/,
    );
  });
});

describe("production deployment transaction", () => {
  it("uses a regional Alpine mirror only for ECS deployment builds", async () => {
    const [dockerfile, compose, deploy] = await Promise.all([
      readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "docker", "docker-compose.prod.yml"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8"),
    ]);

    assert.match(dockerfile, /^ARG ALPINE_MIRROR$/m);
    assert.match(dockerfile, /^ARG NODE_IMAGE=node:22-alpine$/m);
    assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\} AS dependencies$/m);
    assert.doesNotMatch(dockerfile, /^RUN sed .*mirrors\.aliyun\.com/m);
    assert.match(compose, /NODE_IMAGE: \$\{NODE_IMAGE:-node:22-alpine\}/);
    assert.match(compose, /ALPINE_MIRROR: \$\{ALPINE_MIRROR:-\}/);
    assert.match(deploy, /ALPINE_MIRROR="\$\{ALPINE_MIRROR:-http:\/\/mirrors\.cloud\.aliyuncs\.com\/alpine\}"/);
  });

  it("installs a physical shared Node runtime instead of linking into a private home", async () => {
    const script = await readFile(
      path.join(repositoryRoot, "scripts", "setup-codex-broker-host.sh"),
      "utf8",
    );

    assert.match(script, /install -o root -g root -m 0755 "\$node_bin" "\$shared_node_tmp"/);
    assert.match(script, /mv -f "\$shared_node_tmp" "\$broker_root\/bin\/node"/);
    assert.doesNotMatch(script, /ln -sfn "\$node_bin" "\$broker_root\/bin\/node"/);
  });

  it("rolls back the app and every configured broker after any mutating-step failure", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    assert.match(script, /^trap rollback_on_exit EXIT$/m);
    assert.match(script, /^deployment_mutated=1$/m);
    assert.match(script, /^deployment_committed=1$/m);
    assert.match(script, /rollback_broker \|\| failed=1[\s\S]*video-factory:rollback/);
    assert.match(script, /restart_brokers\(\) \{\n  local failed=0/);
    assert.match(script, /systemctl restart "\$broker_service"/);
    assert.match(script, /systemctl restart "\$zai_broker_service"/);
    assert.match(script, /return "\$failed"\n\}/);
  });

  it("never changes ownership or mode of an existing disabled-ZAI runtime directory", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const ensureRuntimeMount = script.match(
      /ensure_zai_runtime_mount\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";

    assert.match(ensureRuntimeMount, /if \[\[ ! -e "\$zai_broker_runtime_dir" \]\]; then/);
    assert.match(ensureRuntimeMount, /install -d -o root -g vf-bridge -m 0750 "\$zai_broker_runtime_dir"/);
    assert.doesNotMatch(ensureRuntimeMount, /chown|chmod/);
  });

  it("recreates the Docker bind-mount directory when the optional ZAI broker removes it on failure", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const restartBrokers = script.match(
      /restart_brokers\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
    const optionalFailure = restartBrokers.match(
      /if ! systemctl restart "\$zai_broker_service"[\s\S]*?then([\s\S]*?)\n    fi/,
    )?.[1] ?? "";

    assert.match(optionalFailure, /zai_broker_enabled=0/);
    assert.match(optionalFailure, /systemctl stop "\$zai_broker_service" \|\| true/);
    assert.match(optionalFailure, /ensure_zai_runtime_mount \|\| failed=1/);
  });
});
