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
    assert.match(service, /^Environment=CODEX_HOME=\/var\/lib\/video-factory-zai-codex\/codex-home$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_PROFILE=zai$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_EFFORT=max$/m);
    assert.match(
      service,
      /^Environment=VIDEO_FACTORY_CODEX_MODEL_CATALOG_PATH=\/var\/lib\/video-factory-zai-codex\/codex-home\/models\.json$/m,
    );
    assert.match(service, /^EnvironmentFile=\/etc\/video-factory\/zai-codex-broker\.env$/m);
    assert.match(service, /stat -c %a \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(service, /test .* = 600/);
    assert.match(service, /^Group=vf-bridge$/m);
    assert.match(service, /^UMask=0007$/m);
    assert.match(service, /^RuntimeDirectoryMode=0750$/m);
    assert.match(service, /\/run\/video-factory-zai-codex\/worker\.sock/);
    assert.match(service, /\/var\/lib\/video-factory-zai-codex\/workspace/);
    assert.doesNotMatch(service, /ZAI_API_KEY\s*=/);
  });

  it("ships a valid GLM-5.3-Flash model catalog with image input enabled", async () => {
    const catalog = JSON.parse(await readFile(
      path.join(brokerRoot, "deploy", "zai-models.json"),
      "utf8",
    )) as { models?: Array<{ slug?: string; input_modalities?: string[] }> };

    const model = catalog.models?.find((candidate) => candidate.slug === "glm-5.3-flash");
    assert.ok(model);
    assert.deepEqual(model.input_modalities, ["text", "image"]);
  });

  it("installs Codex CLI with the validated Node 22 runtime first on PATH", async () => {
    const script = await readFile(
      path.join(repositoryRoot, "scripts", "setup-zai-codex-broker-host.sh"),
      "utf8",
    );

    assert.match(
      script,
      /env PATH="\$broker_root\/bin:[^"]*"\s+\\?\s*"\$npm_bin" install --prefix "\$broker_root\/codex-cli"/,
    );
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
    const disabledBranch = script.match(
      /if \[\[ "\$zai_broker_enabled" -eq 0 \]\]; then([\s\S]*?)\nfi/,
    )?.[1] ?? "";

    assert.match(disabledBranch, /if \[\[ ! -e "\$zai_broker_runtime_dir" \]\]; then/);
    assert.match(disabledBranch, /install -d -o root -g vf-bridge -m 0750 "\$zai_broker_runtime_dir"/);
    assert.doesNotMatch(disabledBranch, /chown|chmod/);
  });
});
