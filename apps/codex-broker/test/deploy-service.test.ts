import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const brokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(brokerRoot, "../..");
const execFileAsync = promisify(execFile);

async function statExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

type DirtyReleaseScenario = "tracked" | "untracked";

async function runDirtyReleaseScenario(scenario: DirtyReleaseScenario): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-dirty-release-"));
  const repository = path.join(directory, "repository");
  const scriptsDirectory = path.join(repository, "scripts");
  const environmentPath = path.join(repository, ".env.docker.prod");
  const trackedPath = path.join(repository, "tracked.txt");

  try {
    await mkdir(scriptsDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(scriptsDirectory, "deploy-production.sh"),
        await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8"),
        "utf8",
      ),
      writeFile(environmentPath, "VIDEO_FACTORY_TEST=1\n", "utf8"),
      writeFile(trackedPath, "committed\n", "utf8"),
    ]);
    await execFileAsync("git", ["init", "--quiet", repository]);
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repository,
      "-c",
      "user.name=VideoFactory Test",
      "-c",
      "user.email=video-factory-test@example.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "baseline",
    ]);
    const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"]);

    if (scenario === "tracked") {
      await writeFile(trackedPath, "modified\n", "utf8");
    } else {
      await writeFile(path.join(repository, "local-only.txt"), "untracked\n", "utf8");
    }

    try {
      await execFileAsync("bash", [path.join(scriptsDirectory, "deploy-production.sh")], {
        cwd: repository,
        env: {
          ...process.env,
          RELEASE_SHA: stdout.trim(),
          VIDEO_FACTORY_ENV_FILE: environmentPath,
        },
      });
      assert.fail(`deployment unexpectedly accepted a ${scenario} release checkout`);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      assert.equal(Number(failure.code), 1);
      return failure.stderr ?? "";
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type DeployFailureScenario =
  | "deepseek-not-configured"
  | "deepseek-unit-install"
  | "deepseek-health"
  | "broker-identity"
  | "app-health"
  | "deepseek-upstream";

interface DeployFailureResult {
  candidateImage: string;
  currentRelease: string;
  openAiUnit: string;
  stderr: string;
  trace: string;
  deepseekUnit: string;
  deepseekWorkspaceExists: boolean;
}

async function runDeployFailureScenario(scenario: DeployFailureScenario, firstMigration = false): Promise<DeployFailureResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-deploy-transaction-"));
  const repository = path.join(directory, "repository");
  const scriptsDirectory = path.join(repository, "scripts");
  const brokerInstallRoot = path.join(directory, "host", "codex-broker");
  const releasesDirectory = path.join(brokerInstallRoot, "releases");
  const previousRelease = path.join(releasesDirectory, "previous");
  const systemdDirectory = path.join(directory, "systemd");
  const openAiUnitPath = path.join(systemdDirectory, "vf-codex-broker.service");
  const deepseekUnitPath = path.join(systemdDirectory, "vf-deepseek-codex-broker.service");
  const deepseekEnvironmentPath = path.join(directory, "deepseek-codex-broker.env");
  const deepseekRuntimeDirectory = path.join(directory, "run", "deepseek");
  const deepseekStateRoot = path.join(directory, "var", "lib", "video-factory-deepseek-codex");
  const candidateBroker = path.join(directory, "candidate-broker");
  const binDirectory = path.join(directory, "bin");
  const stateDirectory = path.join(directory, "state");
  const tracePath = path.join(stateDirectory, "trace.log");
  const environmentPath = path.join(repository, ".env.docker.prod");
  const releaseSha = "a".repeat(40);

  const writeExecutable = async (name: string, contents: string): Promise<void> => {
    const target = path.join(binDirectory, name);
    await writeFile(target, contents, "utf8");
    await chmod(target, 0o755);
  };

  await Promise.all([
    mkdir(scriptsDirectory, { recursive: true }),
    mkdir(previousRelease, { recursive: true }),
    mkdir(systemdDirectory, { recursive: true }),
    mkdir(path.join(candidateBroker, "dist"), { recursive: true }),
    mkdir(path.join(candidateBroker, "node_modules", "undici"), { recursive: true }),
    mkdir(path.join(candidateBroker, "deploy"), { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(deepseekRuntimeDirectory, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(environmentPath, "VIDEO_FACTORY_TEST=1\n", "utf8"),
    writeFile(deepseekEnvironmentPath, scenario === "deepseek-not-configured" ? "" : "DEEPSEEK_API_KEY=test-only\n", "utf8"),
    writeFile(openAiUnitPath, "[Unit]\nDescription=old-openai\n", "utf8"),
    writeFile(deepseekUnitPath, "[Unit]\nDescription=old-deepseek\n", "utf8"),
    writeFile(path.join(candidateBroker, "dist", "main.js"), "export {};\n", "utf8"),
    writeFile(
      path.join(candidateBroker, "node_modules", "undici", "package.json"),
      '{"name":"undici","type":"commonjs"}\n',
      "utf8",
    ),
    writeFile(
      path.join(candidateBroker, "deploy", "vf-codex-broker.service"),
      "[Unit]\nDescription=new-openai\n",
      "utf8",
    ),
    writeFile(
      path.join(candidateBroker, "deploy", "vf-deepseek-codex-broker.service"),
      "[Unit]\nDescription=new-deepseek\n",
      "utf8",
    ),
    writeFile(path.join(stateDirectory, "candidate-image"), "sha256:new-image\n", "utf8"),
    writeFile(tracePath, "", "utf8"),
  ]);
  await symlink(previousRelease, path.join(brokerInstallRoot, "current"), "dir");

  const originalDeploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
  const isolatedDeploy = originalDeploy
    .replace("broker_unit=/etc/systemd/system/vf-codex-broker.service", `broker_unit=${JSON.stringify(openAiUnitPath)}`)
    .replace("deepseek_broker_unit=/etc/systemd/system/vf-deepseek-codex-broker.service", `deepseek_broker_unit=${JSON.stringify(deepseekUnitPath)}`)
    .replace("broker_root=/opt/video-factory/codex-broker", `broker_root=${JSON.stringify(brokerInstallRoot)}`)
    .replace("deepseek_broker_state_root=/var/lib/video-factory-deepseek-codex", `deepseek_broker_state_root=${JSON.stringify(deepseekStateRoot)}`)
    .replaceAll("/etc/video-factory/deepseek-codex-broker.env", deepseekEnvironmentPath)
    .replaceAll('"$broker_root/bin/node"', "node");
  const deployPath = path.join(scriptsDirectory, "deploy-production.sh");
  await writeFile(deployPath, isolatedDeploy, "utf8");
  await writeFile(
    path.join(scriptsDirectory, "backup-production.sh"),
    '#!/bin/sh\necho "backup" >> "$DEPLOY_TRACE"\n',
    "utf8",
  );
  await chmod(path.join(scriptsDirectory, "backup-production.sh"), 0o755);

  await Promise.all([
    writeExecutable(
      "git",
      `#!/bin/sh
case " $* " in
  *" rev-parse HEAD "*) echo "$RELEASE_SHA" ;;
  *" status --porcelain=v1 --untracked-files=all "*) exit 0 ;;
  *) exit 64 ;;
esac
`,
    ),
    writeExecutable("getent", '#!/bin/sh\necho "vf-bridge:x:1234:"\n'),
    writeExecutable("runuser", "#!/bin/sh\nexit 0\n"),
    writeExecutable("sleep", "#!/bin/sh\nexit 0\n"),
    writeExecutable("chown", "#!/bin/sh\nexit 0\n"),
    writeExecutable("systemctl", `#!/bin/sh
echo "systemctl:$*" >> "$DEPLOY_TRACE"
if [ "$TEST_FIRST_MIGRATION" = "1" ]; then
  if [ "$*" = "is-active --quiet vf-deepseek-codex-broker" ]; then exit 3; fi
  if [ "$*" = "stop vf-deepseek-codex-broker" ]; then /bin/rmdir "$VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR"; fi
fi
exit 0
`),
    writeExecutable(
      "install",
      `#!/bin/sh
if [ "$1" = "-d" ]; then
  for argument in "$@"; do
    case "$argument" in
      /*) /bin/mkdir -p "$argument" ;;
    esac
  done
  exit 0
fi
previous=""
destination=""
for argument in "$@"; do
  previous="$destination"
  destination="$argument"
done
source="$previous"
echo "install:$source->$destination" >> "$DEPLOY_TRACE"
if [ "$DEPLOY_SCENARIO" = "deepseek-unit-install" ] && [ "$destination" = "$TEST_DEEPSEEK_UNIT" ] && grep -q "new-deepseek" "$source"; then
  exit 82
fi
/bin/cp "$source" "$destination"
`,
    ),
    writeExecutable(
      "stat",
      `#!/bin/sh
case "$*" in
  *"%U:%G"*"$TEST_DEEPSEEK_STATE"*) echo "vf-deepseek-codex:vf-bridge" ;;
  *"%a"*"$TEST_DEEPSEEK_STATE"*) echo "750" ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`,
    ),
    writeExecutable(
      "node",
      `#!/bin/sh
case " $* " in
  *" --env-file="*)
    if [ "$DEPLOY_SCENARIO" = "deepseek-upstream" ]; then exit 71; fi
    exit 0
    ;;
esac
exec "$REAL_NODE" "$@"
`,
    ),
    writeExecutable(
      "docker",
      `#!/bin/sh
echo "docker:$*" >> "$DEPLOY_TRACE"
case "$1" in
  inspect)
    echo "sha256:old-image"
    ;;
  network)
    exit 0
    ;;
  tag)
    if [ "$2" = "sha256:old-image" ] && [ "$3" = "video-factory:rollback" ]; then
      echo "sha256:old-image" > "$DEPLOY_STATE/rollback-image"
    elif [ "$2" = "video-factory:rollback" ] && [ "$3" = "video-factory:candidate" ]; then
      /bin/cp "$DEPLOY_STATE/rollback-image" "$DEPLOY_STATE/candidate-image"
    fi
    ;;
  compose)
    case " $* " in
      *" up "*)
        if [ ! -d "$VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR" ]; then exit 84; fi
        ;;
    esac
    case " $* " in
      *" build app "*) echo "sha256:new-image" > "$DEPLOY_STATE/candidate-image" ;;
    esac
    ;;
  create)
    echo "candidate-container"
    ;;
  cp)
    /bin/cp -R "$TEST_CANDIDATE_BROKER" "$3"
    ;;
  rm)
    exit 0
    ;;
  image)
    if [ "$2" = "inspect" ]; then
      test -s "$DEPLOY_STATE/rollback-image"
    fi
    ;;
esac
`,
    ),
    writeExecutable(
      "curl",
      `#!/bin/sh
echo "curl:$*" >> "$DEPLOY_TRACE"
if [ "$DEPLOY_SCENARIO" = "deepseek-health" ]; then
  case " $* " in
    *"$TEST_DEEPSEEK_SOCKET"*)
      current_release="$(readlink "$TEST_BROKER_CURRENT")"
      if [ "$current_release" != "$TEST_PREVIOUS_RELEASE" ]; then
        exit 22
      fi
      ;;
  esac
fi
case " $* " in
  *" --unix-socket "*)
    case " $* " in
      *"$TEST_DEEPSEEK_SOCKET"*)
        current_release="$(readlink "$TEST_BROKER_CURRENT")"
        if [ "$DEPLOY_SCENARIO" = "broker-identity" ] && [ "$current_release" != "$TEST_PREVIOUS_RELEASE" ]; then
          echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"openai","providerId":"openai","modelId":"gpt-test","taskKinds":["director-plan","script-draft","visual-review"],"taskModels":{"director-plan":"gpt-test","script-draft":"gpt-test","visual-review":"gpt-test"}}'
        elif [ "$current_release" = "$TEST_PREVIOUS_RELEASE" ]; then
          echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"deepseek","providerId":"deepseek","modelId":"deepseek-flash","taskKinds":["director-plan","script-draft","visual-review"],"taskModels":{"director-plan":"deepseek-flash","script-draft":"deepseek-flash","visual-review":"deepseek-flash"}}'
        else
          echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"deepseek","providerId":"deepseek","modelId":"deepseek-flash","taskKinds":["topic-ideas","series-roadmap","creative-treatment","director-plan","script-draft","publish-copy","asset-rank","reference-grammar","visual-review","role-audit"],"taskModels":{"topic-ideas":"deepseek-flash","series-roadmap":"deepseek-flash","creative-treatment":"deepseek-flash","director-plan":"deepseek-flash","script-draft":"deepseek-flash","publish-copy":"deepseek-flash","asset-rank":"deepseek-flash","reference-grammar":"deepseek-flash","visual-review":"deepseek-flash","role-audit":"deepseek-flash"}}'
        fi
        ;;
      *)
        echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"openai","providerId":"openai","modelId":"gpt-test","taskKinds":["topic-ideas","series-roadmap","creative-treatment","director-plan","script-draft","publish-copy","asset-rank","reference-grammar","visual-review","role-audit"],"taskModels":{"topic-ideas":"gpt-test","series-roadmap":"gpt-test","creative-treatment":"gpt-test","director-plan":"gpt-test","script-draft":"gpt-test","publish-copy":"gpt-test","asset-rank":"gpt-test","reference-grammar":"gpt-test","visual-review":"gpt-test","role-audit":"gpt-test"}}'
        ;;
    esac
    ;;
  *"/api/health"*)
    if [ "$DEPLOY_SCENARIO" = "app-health" ] && grep -q "new-image" "$DEPLOY_STATE/candidate-image"; then
      echo '{"status":"degraded","runtime":{"python":true,"ffmpeg":false,"ffprobe":true}}'
    else
      echo '{"status":"ok","runtime":{"python":true,"ffmpeg":true,"ffprobe":true}}'
    fi
    ;;
esac
exit 0
`,
    ),
  ]);

  let stderr = "";
  try {
    await execFileAsync("bash", [deployPath], {
      cwd: repository,
      env: {
        ...process.env,
        DEPLOY_SCENARIO: scenario,
        TEST_FIRST_MIGRATION: firstMigration ? "1" : "0",
        DEPLOY_STATE: stateDirectory,
        DEPLOY_TRACE: tracePath,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        RELEASE_SHA: releaseSha,
        REAL_NODE: process.execPath,
        TEST_BROKER_CURRENT: path.join(brokerInstallRoot, "current"),
        TEST_CANDIDATE_BROKER: candidateBroker,
        TEST_OPENAI_UNIT: openAiUnitPath,
        TEST_PREVIOUS_RELEASE: previousRelease,
        TEST_DEEPSEEK_SOCKET: path.join(deepseekRuntimeDirectory, "worker.sock"),
        TEST_DEEPSEEK_STATE: deepseekStateRoot,
        TEST_DEEPSEEK_UNIT: deepseekUnitPath,
        VIDEO_FACTORY_ENV_FILE: environmentPath,
        VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR: deepseekRuntimeDirectory,
      },
    });
    assert.fail(`deployment unexpectedly succeeded for ${scenario}`);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    assert.equal(Number(failure.code), 1);
    stderr = failure.stderr ?? "";
  }

  try {
    return {
      candidateImage: (await readFile(path.join(stateDirectory, "candidate-image"), "utf8")).trim(),
      currentRelease: await readlink(path.join(brokerInstallRoot, "current")),
      openAiUnit: await readFile(openAiUnitPath, "utf8"),
      stderr,
      trace: await readFile(tracePath, "utf8"),
      deepseekUnit: await readFile(deepseekUnitPath, "utf8"),
      deepseekWorkspaceExists: await statExists(path.join(deepseekStateRoot, "workspace")),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertFullDeployRollback(result: DeployFailureResult, expectAppRollback: boolean): void {
  assert.equal(path.basename(result.currentRelease), "previous");
  assert.equal(result.candidateImage, expectAppRollback ? "sha256:old-image" : "sha256:new-image");
  assert.match(result.openAiUnit, /Description=old-openai/);
  assert.doesNotMatch(result.openAiUnit, /Description=new-openai/);
  assert.match(result.deepseekUnit, /Description=old-deepseek/);
  assert.doesNotMatch(result.deepseekUnit, /Description=new-deepseek/);
  assert.match(result.stderr, /Deployment failed; restoring the application and all configured brokers/);
  assert.doesNotMatch(result.stderr, /Rollback did not fully recover every component/);
  assert.match(result.trace, /systemctl:restart vf-codex-broker/);
  assert.match(result.trace, /systemctl:restart vf-deepseek-codex-broker/);
  if (expectAppRollback) {
    assert.match(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.match(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
  } else {
    assert.doesNotMatch(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.doesNotMatch(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
  }
  assert.equal(result.deepseekWorkspaceExists, true);
}

describe("DeepSeek systemd service sample", () => {
  it("starts only DeepSeek for a new release even if the legacy service cannot start", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const restart = deploy.match(/restart_brokers\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(restart);
    const { stdout } = await execFileAsync("bash", ["-c", `
set -Eeuo pipefail
broker_service=retired-openai
broker_socket=/unused/old.sock
deepseek_broker_service=deepseek
deepseek_broker_socket=/new/deepseek.sock
deepseek_broker_enabled=1
deepseek_broker_was_active=1
legacy_broker_was_active=1
systemctl() { echo "$*"; [[ "$*" != *retired-openai* ]]; }
wait_for_broker_health() { return 0; }
${restart}
restart_brokers
`]);
    assert.match(stdout, /restart deepseek/);
    assert.doesNotMatch(stdout, /retired-openai/);
  });

  it("isolates runtime state and enforces a 0600 sensitive environment file", async () => {
    const service = await readFile(
      path.join(brokerRoot, "deploy", "vf-deepseek-codex-broker.service"),
      "utf8",
    );

    assert.match(service, /^User=vf-deepseek-codex$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_PROFILE=deepseek$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_EFFORT=xhigh$/m);
    // unit 显式配置 1200s（20 分钟），与 broker 默认及本地开发脚本一致，避免强推理在旧 deadline 被截断。
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_TIMEOUT_MS=1200000$/m);
    assert.match(service, /^EnvironmentFile=\/etc\/video-factory\/deepseek-codex-broker\.env$/m);
    assert.match(service, /stat -c %%U:%%G \/etc\/video-factory\/deepseek-codex-broker\.env/);
    assert.match(service, /stat -c %%a \/etc\/video-factory\/deepseek-codex-broker\.env/);
    assert.doesNotMatch(service, /stat -c %U:%G \/etc\/video-factory\/deepseek-codex-broker\.env/);
    assert.match(service, /test .* = 600/);
    assert.match(service, /^Group=vf-bridge$/m);
    assert.match(service, /^UMask=0007$/m);
    assert.match(service, /^RuntimeDirectoryMode=0750$/m);
    assert.match(service, /^RuntimeDirectoryPreserve=restart$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_WORKSPACE_ROOT=\/var\/lib\/video-factory-deepseek-codex\/workspace$/m);
    assert.match(service, /^ReadWritePaths=\/var\/lib\/video-factory-deepseek-codex \/run\/video-factory-deepseek-codex$/m);
    assert.match(service, /\/run\/video-factory-deepseek-codex\/worker\.sock/);
    assert.doesNotMatch(service, /CODEX_HOME|CODEX_BIN|MODEL_CATALOG/);
    assert.match(service, /DEEPSEEK_API_KEY/);
    // 密钥只能来自那个 0600 文件：unit 自身不得内联任何密钥赋值。
    assert.doesNotMatch(service, /DEEPSEEK_API_KEY\s*=/);
  });

  it("uses the validated shared Node runtime without installing a second Codex CLI", async () => {
    const script = await readFile(
      path.join(repositoryRoot, "scripts", "setup-deepseek-codex-broker-host.sh"),
      "utf8",
    );

    assert.match(script, /node_bin="\$broker_root\/bin\/node"/);
    assert.match(script, /runuser -u "\$broker_user"[\s\S]*"\$node_bin" --version/);
    assert.match(script, /broker_state_root=\/var\/lib\/video-factory-deepseek-codex/);
    assert.match(script, /broker_workspace="\$broker_state_root\/workspace"/);
    assert.match(script, /install -d -o "\$broker_user" -g "\$broker_group" -m 0750 "\$broker_state_root" "\$broker_workspace"/);
    assert.doesNotMatch(script, /npm_bin|codex_bin|@openai\/codex|deepseek-models\.json/);
  });

  it("keeps the local DeepSeek key in a broker-only ignored environment file", async () => {
    // ChatGPT/Codex 套餐退役（N1/N2）后，launcher 只拉起 DeepSeek broker；
    // 不再需要 Codex CLI 登录、隔离 HOME 与 auth.json 符号链接。
    const script = await readFile(path.join(repositoryRoot, "scripts", "studio-dev-with-codex.sh"), "utf8");

    assert.match(script, /\.local\/secrets\/deepseek\.env/);
    assert.match(script, /deepseek_workspace_root=\$\{VIDEO_FACTORY_DEEPSEEK_CODEX_WORKSPACE_ROOT:-"\$deepseek_runtime_root\/tasks"\}/);
    assert.match(script, /mkdir -p "\$deepseek_runtime_root" "\$deepseek_workspace_root"/);
    assert.match(script, /VIDEO_FACTORY_CODEX_WORKSPACE_ROOT="\$deepseek_workspace_root"/);
    assert.match(script, /node --env-file="\$deepseek_env_file" apps\/codex-broker\/dist\/main\.js/);
    assert.doesNotMatch(script, /node --env-file="\$repository_root\/\.env"/);
    assert.doesNotMatch(script, /codex_bin|codex_process_home|CODEX_HOME/);
  });

  it("pins every DeepSeek request to the public chat-completions endpoint", async () => {
    const executor = await readFile(
      path.join(brokerRoot, "src", "chat-completions-executor.ts"),
      "utf8",
    );

    assert.match(executor, /https:\/\/api\.deepseek\.com\/chat\/completions/);
    assert.doesNotMatch(executor, /open\.bigmodel\.cn/);
    assert.match(executor, /model: modelId/);
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
  it("transfers the tested commit as a bundle when ECS cannot reach GitHub", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "ci-cd.yml"), "utf8");
    const deployJob = workflow.slice(workflow.indexOf("  deploy:"));

    assert.match(deployJob, /git bundle create video-factory-release\.bundle HEAD/);
    assert.match(deployJob, /appleboy\/scp-action@ff85246acaad7bdce478db94a363cd2bf7c90345/);
    assert.match(deployJob, /git -C "\$PROJECT_PATH" fetch "\$bundle_path" HEAD/);
    assert.match(deployJob, /test "\$\(git -C "\$PROJECT_PATH" rev-parse FETCH_HEAD\)" = "\$RELEASE_SHA"/);
    assert.match(deployJob, /trap 'rm -f "\$bundle_path"' EXIT/);
    assert.doesNotMatch(deployJob, /git fetch origin/);
  });

  for (const scenario of ["tracked", "untracked"] as const) {
    it(`refuses to build a release checkout with ${scenario} changes`, async () => {
      const stderr = await runDirtyReleaseScenario(scenario);

      assert.match(stderr, /Release checkout is not clean; refusing to build/);
      assert.match(stderr, scenario === "tracked" ? /tracked\.txt/ : /local-only\.txt/);
    });
  }

  it("checks a reused GitHub release worktree before checkout can hide local files", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "ci-cd.yml"), "utf8");
    const reusedWorktreePosition = workflow.indexOf('if [[ -e "$release_path/.git" ]]');
    const cleanCheckPosition = workflow.indexOf(
      'git -C "$release_path" status --porcelain=v1 --untracked-files=all',
      reusedWorktreePosition,
    );
    const checkoutPosition = workflow.indexOf(
      'git -C "$release_path" checkout --detach "$RELEASE_SHA"',
      reusedWorktreePosition,
    );

    assert.ok(reusedWorktreePosition >= 0);
    assert.ok(cleanCheckPosition > reusedWorktreePosition);
    assert.ok(checkoutPosition > cleanCheckPosition);
    assert.match(workflow, /Release worktree is not clean; refusing to reuse it/);
  });

  it("requires an exact GitHub release SHA except during explicit first-time bootstrap", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    assert.match(deploy, /deployment_mode="\$\{VIDEO_FACTORY_DEPLOYMENT_MODE:-release\}"/);
    assert.match(deploy, /release_sha="\$\{RELEASE_SHA:-\}"/);
    assert.match(deploy, /\^\[0-9a-f\]\{40\}\$/);
    assert.match(deploy, /git -C "\$repository_root" rev-parse HEAD/);
    assert.match(deploy, /\[\[ "\$repository_sha" != "\$release_sha" \]\]/);
    assert.match(deploy, /"\$deployment_mode" != "bootstrap"/);
    const cleanlinessPosition = deploy.indexOf(
      'git -C "$repository_root" status --porcelain=v1 --untracked-files=all',
    );
    const candidateBuildPosition = deploy.indexOf('"${compose[@]}" build app');
    assert.ok(
      cleanlinessPosition >= 0 && candidateBuildPosition > cleanlinessPosition,
      "release cleanliness must be verified before the candidate build starts",
    );
  });

  it("packages and validates the matching broker unit before switching each release", async () => {
    const [service, deploy, dockerfile, studioMain] = await Promise.all([
      readFile(path.join(brokerRoot, "deploy", "vf-codex-broker.service"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8"),
      readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "apps", "studio", "src", "server", "main.ts"), "utf8"),
    ]);

    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_TIMEOUT_MS=1200000$/m);
    assert.match(studioMain, /timeoutMs: 2_460_000/);
    assert.match(
      dockerfile,
      /^COPY --from=production-dependencies \/app\/node_modules\/undici apps\/codex-broker\/node_modules\/undici$/m,
    );
    assert.match(dockerfile, /^COPY apps\/codex-broker\/deploy apps\/codex-broker\/deploy$/m);
    assert.match(deploy, /Candidate image does not contain a complete broker release/);
    assert.match(deploy, /! -f "\$staging\/broker\/node_modules\/undici\/package\.json"/);
    assert.match(deploy, /vf-deepseek-codex-broker\.service/);
    const validationPosition = deploy.indexOf('! -f "$staging/broker/dist/main.js"');
    const switchPosition = deploy.indexOf('ln -sfn "$candidate_broker_release" "$broker_root/current"');
    assert.ok(validationPosition >= 0 && switchPosition > validationPosition);
    assert.match(deploy, /install_broker_units_from_release\(\)/);
    assert.doesNotMatch(deploy, /install -m 0644 "\$source" "\$broker_unit"/);
    assert.match(deploy, /install -m 0644 "\$deepseek_source" "\$deepseek_broker_unit" \|\| return 1/);
    assert.match(deploy, /systemctl daemon-reload \|\| return 1/);
    assert.match(deploy, /install_broker_units_from_release "\$broker_root\/current"/);
    assert.match(deploy, /previous_broker_unit_backup/);
    assert.match(deploy, /previous_deepseek_broker_unit_backup/);
    assert.match(deploy, /chown -R root:vf-bridge "\$release_dir" \|\| return 1/);
    assert.match(deploy, /chmod -R a\+rX "\$release_dir" \|\| return 1/);
    assert.match(deploy, /image_id="\$\(docker create video-factory:candidate\)" \|\| return 1/);
    assert.match(deploy, /if ! staging="\$\(mktemp -d\)"; then/);
    assert.match(deploy, /if ! docker rm "\$image_id" >\/dev\/null; then/);
  });

  it("propagates a broker unit installation failure from conditional deployment calls", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const installFunction = deploy.match(/install_broker_units_from_release\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(installFunction);
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-deploy-unit-"));
    const release = path.join(directory, "release");
    await mkdir(path.join(release, "deploy"), { recursive: true });
    await writeFile(path.join(release, "deploy", "vf-deepseek-codex-broker.service"), "[Unit]\n", "utf8");

    try {
      const script = `
set -Eeuo pipefail
broker_unit=${JSON.stringify(path.join(directory, "installed.service"))}
deepseek_broker_unit=${JSON.stringify(path.join(directory, "installed-deepseek.service"))}
deepseek_broker_configured=1
install() { return 23; }
systemctl() { return 0; }
${installFunction}
if install_broker_units_from_release ${JSON.stringify(release)}; then
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

  it("requires DeepSeek readiness instead of retired OpenAI connectivity before mutating the release", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    const probePosition = script.indexOf("check_deepseek_upstream || {");
    const networkMutationPosition = script.indexOf('docker network inspect "$trend_network"');
    const buildPosition = script.indexOf('"${compose[@]}" build app');
    assert.ok(probePosition >= 0);
    assert.ok(networkMutationPosition > probePosition);
    assert.ok(buildPosition > probePosition);
    assert.doesNotMatch(script, /check_codex_upstream|api\.openai\.com/);
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

  it("uses regional package mirrors only for ECS deployment builds", async () => {
    const [dockerfile, compose, deploy] = await Promise.all([
      readFile(path.join(repositoryRoot, "docker", "Dockerfile"), "utf8"),
      readFile(path.join(repositoryRoot, "docker", "docker-compose.prod.yml"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8"),
    ]);

    assert.match(dockerfile, /^ARG ALPINE_MIRROR$/m);
    assert.match(dockerfile, /^ARG NPM_REGISTRY$/m);
    assert.match(dockerfile, /npm config set registry "\$NPM_REGISTRY"/);
    assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS dependencies[\s\S]*apk add --no-cache python3 make g\+\+[\s\S]*npm ci/);
    assert.ok(
      dockerfile.indexOf("apk add --no-cache python3 make g++") < dockerfile.indexOf("npm ci"),
      "native dependency toolchain must exist before npm falls back to source compilation",
    );
    assert.match(dockerfile, /^ARG NODE_IMAGE=node:22-alpine$/m);
    assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\} AS dependencies$/m);
    assert.doesNotMatch(dockerfile, /^RUN sed .*mirrors\.aliyun\.com/m);
    assert.match(compose, /NODE_IMAGE: \$\{NODE_IMAGE:-node:22-alpine\}/);
    assert.match(compose, /ALPINE_MIRROR: \$\{ALPINE_MIRROR:-\}/);
    assert.match(compose, /NPM_REGISTRY: \$\{NPM_REGISTRY:-\}/);
    assert.match(deploy, /ALPINE_MIRROR="\$\{ALPINE_MIRROR:-http:\/\/mirrors\.cloud\.aliyuncs\.com\/alpine\}"/);
    assert.match(deploy, /NPM_REGISTRY="\$\{NPM_REGISTRY:-https:\/\/registry\.npmmirror\.com\}"/);
  });

  it("passes curated multi-model video settings into the production container", async () => {
    const compose = await readFile(
      path.join(repositoryRoot, "docker", "docker-compose.prod.yml"),
      "utf8",
    );

    assert.match(compose, /SEEDANCE_MODEL_ESTIMATES_JSON: \$\{SEEDANCE_MODEL_ESTIMATES_JSON:-\}/);
    assert.match(compose, /SEEDANCE_MODEL_PROFILES_JSON: \$\{SEEDANCE_MODEL_PROFILES_JSON:-\}/);
    assert.doesNotMatch(compose, /MINIMAX_ESTIMATED_CNY_PER_CLIP|WAN_ESTIMATED_CNY_PER_CLIP|WAN_MODEL_ESTIMATES_JSON/);
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

    assert.match(script, /default_codex_model=gpt-5\.6-sol/);
    assert.match(script, /default_codex_effort=xhigh/);
    assert.match(script, /default_codex_audit_effort=xhigh/);
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
    assert.match(script, /^app_mutated=0$/m);
    assert.match(script, /^app_mutated=1$/m);
    assert.match(script, /rollback_broker \|\| failed=1[\s\S]*video-factory:rollback/);
    assert.match(script, /restart_brokers\(\) \{[\s\S]*?local [^\n]*failed=0/);
    assert.match(script, /systemctl restart "\$broker_service"/);
    assert.match(script, /systemctl restart "\$deepseek_broker_service"/);
    assert.match(script, /Configured DeepSeek broker is unavailable; refusing a partial deployment/);
    assert.doesNotMatch(script, /Optional DeepSeek broker is unavailable; continuing/);
    assert.match(script, /return "\$failed"\n\}/);
    assert.match(script, /install -m 0644 "\$previous_broker_unit_backup" "\$broker_unit" \|\| return 1/);
    assert.match(script, /install -m 0644 "\$previous_deepseek_broker_unit_backup" "\$deepseek_broker_unit" \|\| return 1/);
    assert.match(script, /systemctl daemon-reload \|\| return 1/);
    assert.ok(
      script.indexOf('[[ -s "$previous_broker_unit_backup" ]]')
        < script.indexOf('[[ -f "$previous_broker_release/deploy/vf-codex-broker.service" ]]'),
      "rollback must prefer the exact pre-deploy unit backups over an older release bundle",
    );
  });

  for (const scenario of ["deepseek-unit-install"] as const) {
    it(`executes a complete rollback when ${scenario} fails`, async () => {
      const result = await runDeployFailureScenario(scenario);

      assertFullDeployRollback(result, false);
    });
  }

  it("executes a complete rollback when the configured DeepSeek broker stays unhealthy", async () => {
    const result = await runDeployFailureScenario("deepseek-health");

    assert.match(result.stderr, /Configured DeepSeek broker is unavailable/);
    assertFullDeployRollback(result, false);
  });

  it("rejects a healthy HTTP response from the wrong broker identity without restarting the unchanged app", async () => {
    const result = await runDeployFailureScenario("broker-identity");

    assertFullDeployRollback(result, false);
  });

  it("rolls back the app only after the candidate app has actually been started", async () => {
    const result = await runDeployFailureScenario("app-health");

    assertFullDeployRollback(result, true);
  });

  it("restores the old app after a failed first DeepSeek migration without requiring a prior DeepSeek service", async () => {
    const result = await runDeployFailureScenario("app-health", true);
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.equal(result.candidateImage, "sha256:old-image");
    assert.match(result.trace, /systemctl:stop vf-deepseek-codex-broker/);
    assert.match(result.trace, /systemctl:restart vf-codex-broker/);
    assert.equal(result.trace.match(/systemctl:restart vf-deepseek-codex-broker/g)?.length, 1);
    assert.match(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
    assert.doesNotMatch(result.stderr, /Rollback did not fully recover every component/);
  });

  it("preserves both retired socket mounts for rollback to the previous production image", async () => {
    const compose = await readFile(path.join(repositoryRoot, "docker", "docker-compose.prod.yml"), "utf8");
    assert.match(compose, /target: \/run\/video-factory-codex\n/);
    assert.match(compose, /target: \/run\/video-factory-zai-codex\n/);
    assert.match(compose, /VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH:/);
  });

  it("checks DeepSeek reachability without submitting content before mutating the release", async () => {
    const result = await runDeployFailureScenario("deepseek-upstream");

    assert.equal(path.basename(result.currentRelease), "previous");
    assert.match(result.openAiUnit, /Description=old-openai/);
    assert.match(result.deepseekUnit, /Description=old-deepseek/);
    assert.equal(result.deepseekWorkspaceExists, true);
    assert.match(result.stderr, /DeepSeek upstream readiness check failed/);
    assert.doesNotMatch(result.trace, /docker:compose .* build app/);
    assert.doesNotMatch(result.trace, /systemctl:restart/);
  });

  it("validates durable DeepSeek workspace permissions and parses app and broker readiness bodies", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    assert.match(deploy, /ensure_deepseek_workspace\(\)/);
    assert.match(deploy, /\[\[ -L "\$target" \|\| -e "\$target" && ! -d "\$target" \]\]/);
    assert.match(deploy, /install -d -o "\$deepseek_broker_user" -g vf-bridge -m 0750/);
    assert.match(deploy, /stat -c %U:%G "\$target"/);
    assert.match(deploy, /stat -c %a "\$target"/);
    assert.match(deploy, /runuser -u "\$deepseek_broker_user" -- test -w "\$deepseek_broker_workspace"/);
    assert.match(deploy, /health\?\.status === "ok"/);
    assert.match(deploy, /health\.protocolVersion === "video-factory\/codex-bridge-v2"/);
    assert.match(deploy, /health\.profileId === process\.env\.EXPECTED_BROKER_PROFILE/);
    assert.match(deploy, /health\.providerId === process\.env\.EXPECTED_BROKER_PROVIDER/);
    assert.match(deploy, /expectedKinds\.every\(\(kind\) => typeof taskModels\[kind\] === "string"/);
    assert.match(deploy, /EXPECTED_BROKER_ALLOW_EXTRA_KINDS/);
    assert.match(deploy, /allowExtraKinds \|\| expectedKinds\.length === actualKinds\.length/);
    assert.match(deploy, /restart_brokers director-plan,script-draft,visual-review 1 1/);
    assert.match(
      deploy,
      /broker_health "\$deepseek_broker_socket" deepseek deepseek \\\n\s+topic-ideas,series-roadmap,creative-treatment,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit/,
    );
  });

  it("uses authenticated GET readiness probes that cannot submit billable content", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const probe = deploy.match(/check_deepseek_upstream\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

    assert.match(probe, /--env-file=\/etc\/video-factory\/deepseek-codex-broker\.env/);
    assert.match(probe, /method: "GET"/);
    assert.match(probe, /api\.deepseek\.com\/models/);
    // 探针只读模型目录；生成内容的那条端点连出现都不该出现。
    assert.doesNotMatch(probe, /chat\/completions/);
    assert.doesNotMatch(probe, /method: "POST"|messages:|body:\s*(?:JSON|stringify|["'`])/);
    assert.match(probe, /response\.status !== 200/);
  });

  it("leaves the existing release untouched when DeepSeek credentials are missing", async () => {
    const result = await runDeployFailureScenario("deepseek-not-configured");
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.match(result.stderr, /DeepSeek broker credentials are not configured/);
    assert.equal(result.deepseekWorkspaceExists, false);
    assert.doesNotMatch(result.trace, /docker:|systemctl:restart|install:/);
  });

  it("fails the deployment when a configured DeepSeek broker is unhealthy", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const restartBrokers = script.match(
      /restart_brokers\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
    const optionalFailure = restartBrokers.match(
      /if ! systemctl restart "\$deepseek_broker_service"[\s\S]*?then([\s\S]*?)\n    fi/,
    )?.[1] ?? "";

    assert.match(optionalFailure, /failed=1/);
    assert.doesNotMatch(optionalFailure, /deepseek_broker_enabled=0|systemctl stop|ensure_deepseek_runtime_mount/);
  });
});
