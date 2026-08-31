import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const brokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(brokerRoot, "../..");
const execFileAsync = promisify(execFile);

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
    assert.match(executor, /model: this\.identity\.modelId/);
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
  it("packages and validates the matching broker unit before switching each release", async () => {
    const [service, deploy, dockerfile, studioMain] = await Promise.all([
      readFile(path.join(brokerRoot, "deploy", "vf-codex-broker.service"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8"),
      readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "apps", "studio", "src", "server", "main.ts"), "utf8"),
    ]);

    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_TIMEOUT_MS=600000$/m);
    assert.match(studioMain, /timeoutMs: 1_260_000/);
    assert.match(dockerfile, /^COPY apps\/codex-broker\/deploy apps\/codex-broker\/deploy$/m);
    assert.match(deploy, /Candidate image does not contain a complete broker release/);
    const validationPosition = deploy.indexOf('! -f "$staging/broker/dist/main.js"');
    const switchPosition = deploy.indexOf('ln -sfn "$candidate_broker_release" "$broker_root/current"');
    assert.ok(validationPosition >= 0 && switchPosition > validationPosition);
    assert.match(deploy, /install_broker_unit_from_release\(\)/);
    assert.match(deploy, /install -m 0644 "\$source" "\$broker_unit" \|\| return 1/);
    assert.match(deploy, /systemctl daemon-reload \|\| return 1/);
    assert.match(deploy, /install_broker_unit_from_release "\$broker_root\/current"/);
    assert.match(deploy, /previous_broker_unit_backup/);
    assert.match(deploy, /chown -R vf-codex:vf-bridge "\$release_dir" \|\| return 1/);
    assert.match(deploy, /chmod -R a\+rX "\$release_dir" \|\| return 1/);
    assert.match(deploy, /image_id="\$\(docker create video-factory:candidate\)" \|\| return 1/);
    assert.match(deploy, /if ! staging="\$\(mktemp -d\)"; then/);
    assert.match(deploy, /if ! docker rm "\$image_id" >\/dev\/null; then/);
  });

  it("propagates a broker unit installation failure from conditional deployment calls", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const installFunction = deploy.match(/install_broker_unit_from_release\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(installFunction);
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-deploy-unit-"));
    const release = path.join(directory, "release");
    await mkdir(path.join(release, "deploy"), { recursive: true });
    await writeFile(path.join(release, "deploy", "vf-codex-broker.service"), "[Unit]\n", "utf8");

    try {
      const script = `
set -Eeuo pipefail
broker_unit=${JSON.stringify(path.join(directory, "installed.service"))}
install() { return 23; }
systemctl() { return 0; }
${installFunction}
if install_broker_unit_from_release ${JSON.stringify(release)}; then
  exit 0
fi
exit 42
`;
      await assert.rejects(
        () => execFileAsync("bash", ["-c", script]),
        (error: NodeJS.ErrnoException) => Number(error.code) === 42,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("checks Codex upstream reachability before mutating the production release", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    const probePosition = script.indexOf("check_codex_upstream || exit 1");
    const networkMutationPosition = script.indexOf('docker network inspect "$trend_network"');
    const buildPosition = script.indexOf('"${compose[@]}" build app');
    assert.ok(probePosition >= 0);
    assert.ok(networkMutationPosition > probePosition);
    assert.ok(buildPosition > probePosition);
    assert.match(script, /runuser -u "\$broker_user" -- curl/);
    assert.match(script, /https:\/\/api\.openai\.com\/v1\/models/);
  });

  it("provides a restart policy for an existing OpenAI egress tunnel", async () => {
    const dropIn = await readFile(
      path.join(repositoryRoot, "deploy", "systemd", "vf-openai-egress-restart.conf"),
      "utf8",
    );

    assert.match(dropIn, /^\[Service\]$/m);
    assert.match(dropIn, /^Restart=always$/m);
    assert.match(dropIn, /^RestartSec=60s$/m);
  });

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

  it("pins a verified production model while preserving operator overrides", async () => {
    const script = await readFile(
      path.join(repositoryRoot, "scripts", "setup-codex-broker-host.sh"),
      "utf8",
    );

    assert.match(script, /default_codex_model=gpt-5\.6-terra/);
    assert.match(script, /default_codex_audit_model=gpt-5\.6-sol/);
    assert.match(script, /VIDEO_FACTORY_CODEX_MODEL:-\$existing_codex_model/);
    assert.match(script, /VIDEO_FACTORY_CODEX_AUDIT_MODEL:-\$existing_codex_audit_model/);
    assert.match(script, /VIDEO_FACTORY_CODEX_EFFORT:-\$existing_codex_effort/);
    assert.match(script, /VIDEO_FACTORY_CODEX_AUDIT_EFFORT:-\$existing_codex_audit_effort/);
    assert.match(script, /printf 'VIDEO_FACTORY_CODEX_MODEL=%s\\n'/);
    assert.match(script, /printf 'VIDEO_FACTORY_CODEX_AUDIT_MODEL=%s\\n'/);
    assert.match(script, /printf 'VIDEO_FACTORY_CODEX_AUDIT_EFFORT=%s\\n'/);
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
    assert.match(script, /install -m 0644 "\$previous_broker_unit_backup" "\$broker_unit" \|\| return 1/);
    assert.match(script, /systemctl daemon-reload \|\| return 1/);
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
