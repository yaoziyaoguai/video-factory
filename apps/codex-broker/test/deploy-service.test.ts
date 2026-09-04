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
  | "openai-unit-install"
  | "zai-unit-install"
  | "zai-health"
  | "broker-identity"
  | "app-health"
  | "zai-upstream";

interface DeployFailureResult {
  candidateImage: string;
  currentRelease: string;
  openAiUnit: string;
  stderr: string;
  trace: string;
  zaiUnit: string;
  zaiWorkspaceExists: boolean;
}

async function runDeployFailureScenario(scenario: DeployFailureScenario): Promise<DeployFailureResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "video-factory-deploy-transaction-"));
  const repository = path.join(directory, "repository");
  const scriptsDirectory = path.join(repository, "scripts");
  const brokerInstallRoot = path.join(directory, "host", "codex-broker");
  const releasesDirectory = path.join(brokerInstallRoot, "releases");
  const previousRelease = path.join(releasesDirectory, "previous");
  const systemdDirectory = path.join(directory, "systemd");
  const openAiUnitPath = path.join(systemdDirectory, "vf-codex-broker.service");
  const zaiUnitPath = path.join(systemdDirectory, "vf-zai-codex-broker.service");
  const zaiEnvironmentPath = path.join(directory, "zai-codex-broker.env");
  const zaiRuntimeDirectory = path.join(directory, "run", "zai");
  const zaiStateRoot = path.join(directory, "var", "lib", "video-factory-zai-codex");
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
    mkdir(path.join(candidateBroker, "deploy"), { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(zaiRuntimeDirectory, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(environmentPath, "VIDEO_FACTORY_TEST=1\n", "utf8"),
    writeFile(zaiEnvironmentPath, "ZAI_BIGMODEL_API_KEY=test-only\n", "utf8"),
    writeFile(openAiUnitPath, "[Unit]\nDescription=old-openai\n", "utf8"),
    writeFile(zaiUnitPath, "[Unit]\nDescription=old-zai\n", "utf8"),
    writeFile(path.join(candidateBroker, "dist", "main.js"), "export {};\n", "utf8"),
    writeFile(
      path.join(candidateBroker, "deploy", "vf-codex-broker.service"),
      "[Unit]\nDescription=new-openai\n",
      "utf8",
    ),
    writeFile(
      path.join(candidateBroker, "deploy", "vf-zai-codex-broker.service"),
      "[Unit]\nDescription=new-zai\n",
      "utf8",
    ),
    writeFile(path.join(stateDirectory, "candidate-image"), "sha256:new-image\n", "utf8"),
    writeFile(tracePath, "", "utf8"),
  ]);
  await symlink(previousRelease, path.join(brokerInstallRoot, "current"), "dir");

  const originalDeploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
  const isolatedDeploy = originalDeploy
    .replace("broker_unit=/etc/systemd/system/vf-codex-broker.service", `broker_unit=${JSON.stringify(openAiUnitPath)}`)
    .replace("zai_broker_unit=/etc/systemd/system/vf-zai-codex-broker.service", `zai_broker_unit=${JSON.stringify(zaiUnitPath)}`)
    .replace("broker_root=/opt/video-factory/codex-broker", `broker_root=${JSON.stringify(brokerInstallRoot)}`)
    .replace("zai_broker_state_root=/var/lib/video-factory-zai-codex", `zai_broker_state_root=${JSON.stringify(zaiStateRoot)}`)
    .replaceAll("/etc/video-factory/zai-codex-broker.env", zaiEnvironmentPath)
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
    writeExecutable("systemctl", '#!/bin/sh\necho "systemctl:$*" >> "$DEPLOY_TRACE"\nexit 0\n'),
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
if [ "$DEPLOY_SCENARIO" = "openai-unit-install" ] && [ "$destination" = "$TEST_OPENAI_UNIT" ] && grep -q "new-openai" "$source"; then
  exit 81
fi
if [ "$DEPLOY_SCENARIO" = "zai-unit-install" ] && [ "$destination" = "$TEST_ZAI_UNIT" ] && grep -q "new-zai" "$source"; then
  exit 82
fi
/bin/cp "$source" "$destination"
`,
    ),
    writeExecutable(
      "stat",
      `#!/bin/sh
case "$*" in
  *"%U:%G"*"$TEST_ZAI_STATE"*) echo "vf-zai-codex:vf-bridge" ;;
  *"%a"*"$TEST_ZAI_STATE"*) echo "750" ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`,
    ),
    writeExecutable(
      "node",
      `#!/bin/sh
case " $* " in
  *" --env-file="*)
    if [ "$DEPLOY_SCENARIO" = "zai-upstream" ]; then exit 71; fi
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
if [ "$DEPLOY_SCENARIO" = "zai-health" ]; then
  case " $* " in
    *"$TEST_ZAI_SOCKET"*)
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
      *"$TEST_ZAI_SOCKET"*)
        current_release="$(readlink "$TEST_BROKER_CURRENT")"
        if [ "$DEPLOY_SCENARIO" = "broker-identity" ] && [ "$current_release" != "$TEST_PREVIOUS_RELEASE" ]; then
          echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"openai","providerId":"openai","modelId":"gpt-test","taskKinds":["director-plan","script-draft","visual-review"],"taskModels":{"director-plan":"gpt-test","script-draft":"gpt-test","visual-review":"gpt-test"}}'
        else
          echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"zai","providerId":"zai-bigmodel-api","modelId":"glm-5.3","taskKinds":["director-plan","script-draft","visual-review"],"taskModels":{"director-plan":"glm-5.3","script-draft":"glm-5.3","visual-review":"glm-5.3-flash"}}'
        fi
        ;;
      *)
        echo '{"protocolVersion":"video-factory/codex-bridge-v2","profileId":"openai","providerId":"openai","modelId":"gpt-test","taskKinds":["topic-ideas","series-roadmap","director-plan","script-draft","publish-copy","asset-rank","reference-grammar","visual-review","role-audit"],"taskModels":{"topic-ideas":"gpt-test","series-roadmap":"gpt-test","director-plan":"gpt-test","script-draft":"gpt-test","publish-copy":"gpt-test","asset-rank":"gpt-test","reference-grammar":"gpt-test","visual-review":"gpt-test","role-audit":"gpt-test"}}'
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
        DEPLOY_STATE: stateDirectory,
        DEPLOY_TRACE: tracePath,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        RELEASE_SHA: releaseSha,
        REAL_NODE: process.execPath,
        TEST_BROKER_CURRENT: path.join(brokerInstallRoot, "current"),
        TEST_CANDIDATE_BROKER: candidateBroker,
        TEST_OPENAI_UNIT: openAiUnitPath,
        TEST_PREVIOUS_RELEASE: previousRelease,
        TEST_ZAI_SOCKET: path.join(zaiRuntimeDirectory, "worker.sock"),
        TEST_ZAI_STATE: zaiStateRoot,
        TEST_ZAI_UNIT: zaiUnitPath,
        VIDEO_FACTORY_ENV_FILE: environmentPath,
        VIDEO_FACTORY_ZAI_CODEX_RUNTIME_DIR: zaiRuntimeDirectory,
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
      zaiUnit: await readFile(zaiUnitPath, "utf8"),
      zaiWorkspaceExists: await statExists(path.join(zaiStateRoot, "workspace")),
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
  assert.match(result.zaiUnit, /Description=old-zai/);
  assert.doesNotMatch(result.zaiUnit, /Description=new-zai/);
  assert.match(result.stderr, /Deployment failed; restoring the application and all configured brokers/);
  assert.match(result.trace, /systemctl:restart vf-codex-broker/);
  assert.match(result.trace, /systemctl:restart vf-zai-codex-broker/);
  if (expectAppRollback) {
    assert.match(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.match(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
  } else {
    assert.doesNotMatch(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.doesNotMatch(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
  }
  assert.equal(result.zaiWorkspaceExists, true);
}

describe("ZAI systemd service sample", () => {
  it("isolates runtime state and enforces a 0600 sensitive environment file", async () => {
    const service = await readFile(
      path.join(brokerRoot, "deploy", "vf-zai-codex-broker.service"),
      "utf8",
    );

    assert.match(service, /^User=vf-zai-codex$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_PROFILE=zai$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_EFFORT=xhigh$/m);
    assert.match(service, /^EnvironmentFile=\/etc\/video-factory\/zai-codex-broker\.env$/m);
    assert.match(service, /stat -c %%U:%%G \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(service, /stat -c %%a \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.doesNotMatch(service, /stat -c %U:%G \/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(service, /test .* = 600/);
    assert.match(service, /^Group=vf-bridge$/m);
    assert.match(service, /^UMask=0007$/m);
    assert.match(service, /^RuntimeDirectoryMode=0750$/m);
    assert.match(service, /^RuntimeDirectoryPreserve=restart$/m);
    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_WORKSPACE_ROOT=\/var\/lib\/video-factory-zai-codex\/workspace$/m);
    assert.match(service, /^ReadWritePaths=\/var\/lib\/video-factory-zai-codex \/run\/video-factory-zai-codex$/m);
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
    assert.match(script, /broker_state_root=\/var\/lib\/video-factory-zai-codex/);
    assert.match(script, /broker_workspace="\$broker_state_root\/workspace"/);
    assert.match(script, /install -d -o "\$broker_user" -g "\$broker_group" -m 0750 "\$broker_state_root" "\$broker_workspace"/);
    assert.doesNotMatch(script, /npm_bin|codex_bin|@openai\/codex|zai-models\.json/);
  });

  it("keeps the local BigModel key in a broker-only ignored environment file", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "studio-dev-with-codex.sh"), "utf8");

    assert.match(script, /\.local\/secrets\/zai-bigmodel\.env/);
    assert.match(script, /zai_workspace_root=\$\{VIDEO_FACTORY_ZAI_CODEX_WORKSPACE_ROOT:-"\$zai_runtime_root\/tasks"\}/);
    assert.match(script, /mkdir -p "\$zai_runtime_root" "\$zai_workspace_root"/);
    assert.match(script, /VIDEO_FACTORY_CODEX_WORKSPACE_ROOT="\$zai_workspace_root"/);
    assert.match(script, /node --env-file="\$zai_env_file" apps\/codex-broker\/dist\/main\.js/);
    assert.doesNotMatch(script, /node --env-file="\$repository_root\/\.env"/);
  });

  it("pins the official BigModel visual and Coding Plan endpoints", async () => {
    const executor = await readFile(
      path.join(brokerRoot, "src", "zai-code-plan-executor.ts"),
      "utf8",
    );

    assert.match(executor, /https:\/\/open\.bigmodel\.cn\/api\/paas\/v4\/chat\/completions/);
    assert.match(executor, /https:\/\/open\.bigmodel\.cn\/api\/coding\/paas\/v4\/chat\/completions/);
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

    assert.match(service, /^Environment=VIDEO_FACTORY_CODEX_TIMEOUT_MS=600000$/m);
    assert.match(studioMain, /timeoutMs: 1_260_000/);
    assert.match(dockerfile, /^COPY apps\/codex-broker\/deploy apps\/codex-broker\/deploy$/m);
    assert.match(deploy, /Candidate image does not contain a complete broker release/);
    assert.match(deploy, /vf-zai-codex-broker\.service/);
    const validationPosition = deploy.indexOf('! -f "$staging/broker/dist/main.js"');
    const switchPosition = deploy.indexOf('ln -sfn "$candidate_broker_release" "$broker_root/current"');
    assert.ok(validationPosition >= 0 && switchPosition > validationPosition);
    assert.match(deploy, /install_broker_units_from_release\(\)/);
    assert.match(deploy, /install -m 0644 "\$source" "\$broker_unit" \|\| return 1/);
    assert.match(deploy, /install -m 0644 "\$zai_source" "\$zai_broker_unit" \|\| return 1/);
    assert.match(deploy, /systemctl daemon-reload \|\| return 1/);
    assert.match(deploy, /install_broker_units_from_release "\$broker_root\/current"/);
    assert.match(deploy, /previous_broker_unit_backup/);
    assert.match(deploy, /previous_zai_broker_unit_backup/);
    assert.match(deploy, /chown -R vf-codex:vf-bridge "\$release_dir" \|\| return 1/);
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
    await writeFile(path.join(release, "deploy", "vf-codex-broker.service"), "[Unit]\n", "utf8");

    try {
      const script = `
set -Eeuo pipefail
broker_unit=${JSON.stringify(path.join(directory, "installed.service"))}
zai_broker_unit=${JSON.stringify(path.join(directory, "installed-zai.service"))}
zai_broker_configured=0
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

  it("passes curated multi-model video settings into the production container", async () => {
    const compose = await readFile(
      path.join(repositoryRoot, "docker", "docker-compose.prod.yml"),
      "utf8",
    );

    assert.match(compose, /SEEDANCE_MODEL_ESTIMATES_JSON: \$\{SEEDANCE_MODEL_ESTIMATES_JSON:-\}/);
    assert.match(compose, /SEEDANCE_MODEL_PROFILES_JSON: \$\{SEEDANCE_MODEL_PROFILES_JSON:-\}/);
    assert.match(compose, /WAN_MODEL_ESTIMATES_JSON: \$\{WAN_MODEL_ESTIMATES_JSON:-\}/);
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
    assert.match(script, /restart_brokers\(\) \{\n  local failed=0/);
    assert.match(script, /systemctl restart "\$broker_service"/);
    assert.match(script, /systemctl restart "\$zai_broker_service"/);
    assert.match(script, /Configured ZAI Code Plan broker is unavailable; refusing a partial deployment/);
    assert.doesNotMatch(script, /Optional ZAI Code Plan broker is unavailable; continuing/);
    assert.match(script, /return "\$failed"\n\}/);
    assert.match(script, /install -m 0644 "\$previous_broker_unit_backup" "\$broker_unit" \|\| return 1/);
    assert.match(script, /install -m 0644 "\$previous_zai_broker_unit_backup" "\$zai_broker_unit" \|\| return 1/);
    assert.match(script, /systemctl daemon-reload \|\| return 1/);
    assert.ok(
      script.indexOf('[[ -s "$previous_broker_unit_backup" ]]')
        < script.indexOf('[[ -f "$previous_broker_release/deploy/vf-codex-broker.service" ]]'),
      "rollback must prefer the exact pre-deploy unit backups over an older release bundle",
    );
  });

  for (const scenario of ["openai-unit-install", "zai-unit-install"] as const) {
    it(`executes a complete rollback when ${scenario} fails`, async () => {
      const result = await runDeployFailureScenario(scenario);

      assertFullDeployRollback(result, false);
    });
  }

  it("executes a complete rollback when the configured ZAI broker stays unhealthy", async () => {
    const result = await runDeployFailureScenario("zai-health");

    assert.match(result.stderr, /Configured ZAI Code Plan broker is unavailable/);
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

  it("checks ZAI reachability without submitting content before mutating the release", async () => {
    const result = await runDeployFailureScenario("zai-upstream");

    assert.equal(path.basename(result.currentRelease), "previous");
    assert.match(result.openAiUnit, /Description=old-openai/);
    assert.match(result.zaiUnit, /Description=old-zai/);
    assert.equal(result.zaiWorkspaceExists, true);
    assert.match(result.stderr, /ZAI upstream readiness check failed/);
    assert.doesNotMatch(result.trace, /docker:compose .* build app/);
    assert.doesNotMatch(result.trace, /systemctl:restart/);
  });

  it("validates durable ZAI workspace permissions and parses app and broker readiness bodies", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");

    assert.match(deploy, /ensure_zai_workspace\(\)/);
    assert.match(deploy, /\[\[ -L "\$target" \|\| -e "\$target" && ! -d "\$target" \]\]/);
    assert.match(deploy, /install -d -o "\$zai_broker_user" -g vf-bridge -m 0750/);
    assert.match(deploy, /stat -c %U:%G "\$target"/);
    assert.match(deploy, /stat -c %a "\$target"/);
    assert.match(deploy, /runuser -u "\$zai_broker_user" -- test -w "\$zai_broker_workspace"/);
    assert.match(deploy, /health\?\.status === "ok"/);
    assert.match(deploy, /health\.protocolVersion === "video-factory\/codex-bridge-v2"/);
    assert.match(deploy, /health\.profileId === process\.env\.EXPECTED_BROKER_PROFILE/);
    assert.match(deploy, /health\.providerId === process\.env\.EXPECTED_BROKER_PROVIDER/);
    assert.match(deploy, /expectedKinds\.every\(\(kind\) => typeof taskModels\[kind\] === "string"/);
  });

  it("uses authenticated GET readiness probes that cannot submit billable content", async () => {
    const deploy = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const probe = deploy.match(/check_zai_upstream\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

    assert.match(probe, /--env-file=\/etc\/video-factory\/zai-codex-broker\.env/);
    assert.match(probe, /method: "GET"/);
    assert.match(probe, /api\/paas\/v4\/models/);
    assert.match(probe, /api\/coding\/paas\/v4\/models/);
    assert.doesNotMatch(probe, /method: "POST"|messages:|body:\s*(?:JSON|stringify|["'`])/);
    assert.match(probe, /response\.status !== 200/);
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

  it("fails the deployment when a configured ZAI broker is unhealthy", async () => {
    const script = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const restartBrokers = script.match(
      /restart_brokers\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
    const optionalFailure = restartBrokers.match(
      /if ! systemctl restart "\$zai_broker_service"[\s\S]*?then([\s\S]*?)\n    fi/,
    )?.[1] ?? "";

    assert.match(optionalFailure, /failed=1/);
    assert.doesNotMatch(optionalFailure, /zai_broker_enabled=0|systemctl stop|ensure_zai_runtime_mount/);
  });
});
