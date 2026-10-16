import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MaintenanceCoordinator, transitionMaintenanceGate } from "../../../packages/production-pipeline/src/maintenance.js";

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
  stdout: string;
  trace: string;
  deepseekUnit: string;
  deepseekWorkspaceExists: boolean;
  gateState: string;
  gateOwner: string;
  gateBefore: string;
  gateAfter: string;
  appRunning: boolean;
  appRelease: string;
  exitCode: number;
  unitBackupsRemaining: boolean;
}

interface DeployScenarioOptions {
  expectSuccess?: boolean;
  firstMigration?: boolean;
  appAdmission?: "protocol" | "legacy";
  cold?: boolean;
  expectedExitCode?: number;
  leftoverGate?: "draining" | "frozen";
  env?: Record<string, string>;
}

async function runDeployFailureScenario(
  scenario: DeployFailureScenario | "success",
  options: DeployScenarioOptions = {},
): Promise<DeployFailureResult> {
  const firstMigration = options.firstMigration ?? false;
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "video-factory-deploy-transaction-")));
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
  const previousSha = "b".repeat(40);
  const maintenancePackage = path.join(candidateBroker, "node_modules", "@video-factory", "production-pipeline");
  const maintenanceModule = path.join(maintenancePackage, "dist", "maintenance.js");
  const healthFixture = path.join(scriptsDirectory, "fixture-health.mjs");

  const writeExecutable = async (name: string, contents: string): Promise<void> => {
    const target = path.join(binDirectory, name);
    await writeFile(target, contents, "utf8");
    await chmod(target, 0o755);
  };

  await Promise.all([
    mkdir(scriptsDirectory, { recursive: true }),
    mkdir(previousRelease, { recursive: true }),
    mkdir(path.join(brokerInstallRoot, "deployment"), { recursive: true }),
    mkdir(systemdDirectory, { recursive: true }),
    mkdir(path.join(candidateBroker, "dist"), { recursive: true }),
    mkdir(path.join(candidateBroker, "node_modules", "undici"), { recursive: true }),
    mkdir(path.join(maintenancePackage, "dist"), { recursive: true }),
    mkdir(path.join(candidateBroker, "deploy"), { recursive: true }),
    mkdir(binDirectory, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
    mkdir(deepseekRuntimeDirectory, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(environmentPath, "VIDEO_FACTORY_TEST=1\n", "utf8"),
    writeFile(path.join(brokerInstallRoot, "deployment", "current.compose.json"), '{"services":{"app":{"environment":{"OLD_CONFIG":"preserved"}}}}'),
    writeFile(deepseekEnvironmentPath, scenario === "deepseek-not-configured" ? "" : "DEEPSEEK_API_KEY=test-only\n", "utf8"),
    writeFile(openAiUnitPath, "[Unit]\nDescription=old-openai\n", "utf8"),
    writeFile(deepseekUnitPath, "[Unit]\nDescription=old-deepseek\n", "utf8"),
    writeFile(path.join(candidateBroker, "dist", "main.js"), "export {};\n", "utf8"),
    writeFile(path.join(candidateBroker, "package.json"), '{"type":"module"}\n', "utf8"),
    writeFile(path.join(previousRelease, "release-sha"), `${previousSha}\n`, "utf8"),
    writeFile(path.join(maintenancePackage, "package.json"), '{"type":"module"}\n', "utf8"),
    writeFile(maintenanceModule, await readFile(path.join(repositoryRoot, "packages", "production-pipeline", "dist", "maintenance.js"), "utf8")),
    writeFile(path.join(stateDirectory, "app-running"), options.env?.TEST_APP_RUNNING ?? "1"),
    writeFile(path.join(stateDirectory, "app-release"), previousSha),
    writeFile(path.join(stateDirectory, "app-epoch"), "app-original"),
    writeFile(
      path.join(candidateBroker, "dist", "task-definitions.js"),
      `export const BROKER_TASK_KINDS = [
  "topic-ideas",
  "series-roadmap",
  "creative-treatment",
  "director-plan",
  "script-draft",
  "publish-copy",
  "asset-rank",
  "reference-grammar",
  "visual-review",
  "role-audit",
  "creative-discussion",
];
`,
      "utf8",
    ),
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

  // 真实共享模块负责门禁、锁、holders 和服务报告；替身只控制进程状态与 health 接点。
  const maintenanceDirectory = path.join(brokerInstallRoot, "deployment", "maintenance");
  if (options.cold && !options.leftoverGate) await mkdir(maintenanceDirectory, { recursive: true });
  else await transitionMaintenanceGate(maintenanceDirectory, "open", "original-installation");
  if (options.leftoverGate) {
    await transitionMaintenanceGate(maintenanceDirectory, "draining", "deploy-crashed");
    if (options.leftoverGate === "frozen") await transitionMaintenanceGate(maintenanceDirectory, "frozen", "deploy-crashed");
  }
  if (options.env?.TEST_BROKER_BUSY === "1") {
    const busy = new MaintenanceCoordinator({ directory: maintenanceDirectory, serviceId: "deepseek-original" });
    await busy.admit("long-running-task");
  }
  const gateBefore = await readFile(path.join(maintenanceDirectory, "gate.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && options.cold) return "";
    throw error;
  });
  const controller = await readFile(path.join(repositoryRoot, "scripts", "production-maintenance.mjs"), "utf8");
  assert.ok(controller.includes("readHealth = localHealth"), "controller must expose the health observation seam");
  await writeFile(path.join(scriptsDirectory, "production-maintenance.mjs"),
    controller.replace("import { request }", 'import { fixtureHealth } from "./fixture-health.mjs";\nimport { request }')
      .replace("readHealth = localHealth", "readHealth = fixtureHealth"));
  await writeFile(healthFixture, `
import { readFile, appendFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MaintenanceCoordinator } from ${JSON.stringify(pathToFileURL(maintenanceModule).href)};
const state = process.env.DEPLOY_STATE;
const exists = (name) => access(path.join(state, name)).then(() => true, () => false);
const text = async (name) => (await readFile(path.join(state, name), "utf8")).trim();
const originalKinds = ["director-plan", "script-draft", "visual-review"];
const legacyKinds = ["topic-ideas", "series-roadmap", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit"];
const candidateKinds = ["topic-ideas", "series-roadmap", "creative-treatment", "director-plan", "script-draft", "publish-copy", "asset-rank", "reference-grammar", "visual-review", "role-audit", "creative-discussion"];
export async function fixtureHealth(endpoint) {
  await appendFile(process.env.DEPLOY_TRACE, "health:" + endpoint + "\\n");
  const app = endpoint.includes("/api/health");
  const legacy = !app && !endpoint.includes(process.env.TEST_DEEPSEEK_SOCKET);
  let release, serviceId;
  if (app) {
    if (await text("app-running") !== "1") throw new Error("App is stopped.");
    release = await text("app-release");
    serviceId = await text("app-epoch");
  } else {
    const service = legacy ? "vf-codex-broker" : "vf-deepseek-codex-broker";
    if (await exists("systemd/" + service + ".stopped")) throw new Error("Broker is stopped.");
    if (!legacy && process.env.TEST_FIRST_MIGRATION === "1" && !(await exists("systemd/" + service + ".started"))) throw new Error("DeepSeek is not installed yet.");
    release = (await readFile(path.join(process.env.TEST_BROKER_CURRENT, "release-sha"), "utf8")).trim();
    serviceId = (legacy ? "legacy" : "deepseek") + (await exists("systemd/" + service + ".epoch")
      ? await text("systemd/" + service + ".epoch") : "-original");
    if (!legacy && process.env.DEPLOY_SCENARIO === "deepseek-health" && release === process.env.RELEASE_SHA) throw new Error("Candidate broker is unavailable.");
  }
  if (process.env.TEST_COLD === "1" && release !== process.env.RELEASE_SHA) {
    return app ? { status: "ok" } : { protocolVersion: "video-factory/codex-bridge-v2",
      profileId: legacy ? "openai" : "deepseek", providerId: legacy ? "openai" : "deepseek",
      modelId: "test-model", active: 0, queued: 0, taskKinds: legacy ? legacyKinds : originalKinds,
      taskModels: Object.fromEntries((legacy ? legacyKinds : originalKinds).map(kind => [kind, "test-model"])) };
  }
  const incomplete = app && await exists("committed-integrity-failed");
  const report = await new MaintenanceCoordinator({ directory: process.env.TEST_MAINTENANCE_DIRECTORY, serviceId })
    .report({ complete: !incomplete, issues: incomplete ? ["unreadable_run"] : [] });
  const maintenance = { protocol: report.protocol, serviceId: report.serviceId, updatedAt: report.updatedAt,
    gate: report.gateView, gateView: report.gateView, inflightCount: report.ownCount, holderCount: report.globalCount,
    integrity: report.integrity, quiescent: report.quiescent };
  if ((app && process.env.TEST_APP_ADMISSION === "legacy") || (legacy && process.env.TEST_LEGACY_BROKER_LEGACY === "1")) {
    maintenance.protocol = "video-factory/maintenance-admission-v1";
  }
  if (app) {
    const candidate = release === process.env.RELEASE_SHA;
    return { status: process.env.DEPLOY_SCENARIO === "app-health" && candidate ? "degraded" : "ok",
      runtime: { python: true, ffmpeg: true, ffprobe: true },
      release: candidate && process.env.TEST_APP_RELEASE_MISMATCH === "1" ? "stale-release" : release, maintenance };
  }
  const wrongIdentity = !legacy && process.env.DEPLOY_SCENARIO === "broker-identity" && release === process.env.RELEASE_SHA;
  const openai = legacy || wrongIdentity;
  const taskKinds = legacy ? legacyKinds : release === process.env.RELEASE_SHA ? candidateKinds : originalKinds;
  const modelId = openai ? "gpt-test" : "deepseek-flash";
  return { protocolVersion: "video-factory/codex-bridge-v2", profileId: openai ? "openai" : "deepseek",
    providerId: openai ? "openai" : "deepseek", modelId, release, taskKinds,
    taskModels: Object.fromEntries(taskKinds.map((kind) => [kind, modelId])), maintenance };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await fixtureHealth(process.argv[2]))); }
  catch (error) { process.stderr.write(error.message + "\\n"); process.exitCode = 22; }
}
`);

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
    '#!/bin/sh\necho "backup:$*" >> "$DEPLOY_TRACE"\nif [ -n "$TEST_SIGNAL_AT_BACKUP" ]; then kill -"$TEST_SIGNAL_AT_BACKUP" "$PPID"; fi\n[ "$TEST_BACKUP_FAILS" = "1" ] && exit 1\nexit 0\n',
    "utf8",
  );
  await chmod(path.join(scriptsDirectory, "backup-production.sh"), 0o755);
  if (options.cold) {
    // 宿主动作在独立用例验证；此处保留真实 controller，验证 shell 跨阶段编排与回滚。
    const hostHelper = path.join(scriptsDirectory, "fixture-cold-host.mjs");
    await writeFile(hostHelper, `
import { appendFile, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
const [command, statePath, ...args] = process.argv.slice(2);
const stateRoot = process.env.DEPLOY_STATE;
await appendFile(process.env.DEPLOY_TRACE, "cold:" + command + "\\n");
if (process.env.TEST_COLD_FAIL === command) process.exit(1);
const input = name => args[args.indexOf(name) + 1];
const source = { previousRelease: process.env.TEST_PREVIOUS_SHA, candidateRelease: process.env.RELEASE_SHA,
  container: {id: "1".repeat(64), image: "sha256:" + "2".repeat(64)}, brokerRelease: process.env.TEST_PREVIOUS_RELEASE,
  candidateEndpoints: ["http://127.0.0.1:4317/api/health", "unix:" + process.env.TEST_DEEPSEEK_SOCKET] };
if (command === "prepare") {
  await writeFile(statePath, JSON.stringify({...source, ingressPath:input("--ingress")}));
} else if (command === "stop-app") {
  await writeFile(path.join(stateRoot,"app-running"), "0");
} else if (command === "stop-brokers") {
  for (const service of ["vf-codex-broker", "vf-deepseek-codex-broker"]) {
    await writeFile(path.join(stateRoot,"systemd",service+".stopped"), "");
    await appendFile(process.env.DEPLOY_TRACE, "cold:normal-stop:"+service+"\\n");
  }
} else if (command === "stopped" || command === "restored") {
  const state = JSON.parse(await readFile(statePath,"utf8"));
  const restored = command === "restored";
  await writeFile(input("--output"), JSON.stringify({...source, kind: restored ? "cold-abort" : "cold-upgrade", bootstrap:false,
    ingress:{closed:true,drained:true,statePath:state.ingressPath}, integrity:{complete:true,quiescent:true},
    observedAt:new Date().toISOString(), ...(restored ? {writersRestored:true,candidateWritersStopped:true} : {writersStopped:true}) }));
}
`);
    await writeFile(path.join(scriptsDirectory, "production-cold-ingress.mjs"), `
import { appendFile,writeFile } from "node:fs/promises";
const [command,state] = process.argv.slice(2);
await appendFile(process.env.DEPLOY_TRACE,"ingress:"+command+"\\n");
if (command === "enter") await writeFile(state,JSON.stringify({phase:"closed",closed:true,drained:true}));
if (process.env.TEST_COLD_FAIL === "ingress-"+command) process.exit(1);
`);
    await writeFile(deployPath, isolatedDeploy.replace(
      'python3 -I -B "$repository_root/scripts/production-cold-upgrade.py"',
      `node ${JSON.stringify(hostHelper)}`));
  }

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
    writeExecutable("sleep", `#!/bin/sh
if [ -n "$TEST_SIGNAL_DURING_DRAIN" ] && [ "$1" = "5" ] && [ ! -f "$DEPLOY_STATE/signal-sent" ]; then
  touch "$DEPLOY_STATE/signal-sent"
  kill -"$TEST_SIGNAL_DURING_DRAIN" "$PPID"
fi
if [ "$TEST_REAL_DRAIN_SLEEP" = "1" ] && [ "$1" = "5" ]; then
  # 排空超时测试需要真实的时钟推进：每次轮询压缩为 1 秒真实时间。
  exec /bin/sleep 1
fi
exit 0
`),
    writeExecutable("chown", "#!/bin/sh\nexit 0\n"),
    writeExecutable(
      "systemctl",
      `#!/bin/sh
echo "systemctl:$*" >> "$DEPLOY_TRACE"
systemd_state="$DEPLOY_STATE/systemd"
mkdir -p "$systemd_state"
case "$1" in
  is-active)
    service="$3"
    if [ "$service" = "vf-zai-codex-broker" ] || [ -f "$systemd_state/$service.stopped" ]; then exit 3; fi
    if [ "$TEST_FIRST_MIGRATION" = "1" ] && [ "$service" = "vf-deepseek-codex-broker" ] && [ ! -f "$systemd_state/$service.started" ]; then exit 3; fi
    exit 0
    ;;
  show)
    service="$2"
    load=loaded
    active=active
    sub=running
    main=123
    control=0
    if [ "$service" = "vf-zai-codex-broker" ]; then load=not-found; active=inactive; sub=dead; main=0; fi
    if [ -f "$systemd_state/$service.stopped" ] || { [ "$TEST_FIRST_MIGRATION" = "1" ] && [ "$service" = "vf-deepseek-codex-broker" ] && [ ! -f "$systemd_state/$service.started" ]; }; then
      active=inactive; sub=dead; main=0
    fi
    if [ "$TEST_UNKNOWN_SERVICE_STATE" = "1" ] && [ "$service" = "vf-codex-broker" ] && [ -f "$systemd_state/$service.stopped" ]; then
      active=deactivating; sub=stop-sigterm; control=234
    fi
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nMainPID=%s\\nControlPID=%s\\n' "$load" "$active" "$sub" "$main" "$control"
    ;;
  stop)
    service="$2"
    if [ "$TEST_STOP_FAILS" = "1" ]; then exit 1; fi
    touch "$systemd_state/$service.stopped"
    if [ "$TEST_FIRST_MIGRATION" = "1" ] && [ "$service" = "vf-deepseek-codex-broker" ]; then
      /bin/rmdir "$VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR" 2>/dev/null || true
    fi
    ;;
  restart)
    if [ "$TEST_ROLLBACK_BROKER_FAILS" = "1" ] && [ -f "$DEPLOY_STATE/candidate-started" ] && [ "$(readlink "$TEST_BROKER_CURRENT")" = "$TEST_PREVIOUS_RELEASE" ]; then exit 1; fi
    rm -f "$systemd_state/$2.stopped"
    touch "$systemd_state/$2.started"
    echo "-restart-$$" > "$systemd_state/$2.epoch"
    ;;
  cat)
    [ "$2" != "vf-zai-codex-broker" ]
    exit $?
    ;;
  disable)
    touch "$systemd_state/$3.stopped"
    if [ -n "$TEST_SIGNAL_AFTER_COMMIT" ] && [ ! -f "$DEPLOY_STATE/signal-sent" ]; then
      touch "$DEPLOY_STATE/signal-sent"
      if [ "$TEST_COMMITTED_INTEGRITY_FAILS" = "1" ]; then touch "$DEPLOY_STATE/committed-integrity-failed"; fi
      kill -"$TEST_SIGNAL_AFTER_COMMIT" "$PPID"
    fi
    ;;
esac
exit 0
`,
    ),
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
  container)
    if [ "$TEST_CONTAINER_LIST_FAILS" = "1" ]; then exit 1; fi
    echo "video_factory_prod"
    ;;
  inspect)
    if [ "$TEST_CONTAINER_INSPECT_FAILS" = "1" ]; then exit 1; fi
    case "$*" in
      *'{{.State.Running}}'*)
        if grep -q '^1$' "$DEPLOY_STATE/app-running"; then echo "true"; else echo "false"; fi
        ;;
      *'{{json .State}}'*)
        if grep -q '^1$' "$DEPLOY_STATE/app-running"; then
          echo '{"Running":true,"Pid":1234,"Restarting":false,"Dead":false,"Status":"running"}'
        elif [ "$TEST_UNKNOWN_APP_STATE" = "1" ]; then
          echo '{"Running":false,"Pid":0,"Restarting":true,"Dead":false,"Status":"restarting"}'
        else
          echo '{"Running":false,"Pid":0,"Restarting":false,"Dead":false,"Status":"exited"}'
        fi
        ;;
      *) echo "sha256:old-image" ;;
    esac
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
        case "$*" in
          *current.compose.json*)
            if [ "$TEST_ROLLBACK_APP_FAILS" = "1" ]; then exit 85; fi
            echo "$TEST_PREVIOUS_SHA" > "$DEPLOY_STATE/app-release"
            ;;
          *)
            echo "$RELEASE_SHA" > "$DEPLOY_STATE/app-release"
            touch "$DEPLOY_STATE/candidate-started"
            ;;
        esac
        echo "1" > "$DEPLOY_STATE/app-running"
        echo "app-restart-$$" > "$DEPLOY_STATE/app-epoch"
        if [ -n "$TEST_SIGNAL_AFTER_APP_UP" ] && [ ! -f "$DEPLOY_STATE/signal-sent" ]; then
          touch "$DEPLOY_STATE/signal-sent"
          kill -"$TEST_SIGNAL_AFTER_APP_UP" "$PPID"
        fi
        ;;
      *" stop "*)
        if [ "$TEST_APP_STOP_FAILS" = "1" ]; then exit 86; fi
        echo "0" > "$DEPLOY_STATE/app-running"
        ;;
      *" build app "*) echo "sha256:new-image" > "$DEPLOY_STATE/candidate-image" ;;
      *" config --format json "*) echo '{"services":{"app":{"image":"video-factory:candidate"}}}' ;;
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
endpoint=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --unix-socket) shift; endpoint="unix:$1" ;;
    http:*) if [ -z "$endpoint" ]; then endpoint="$1"; fi ;;
  esac
  shift
done
exec "$REAL_NODE" "$TEST_HEALTH_FIXTURE" "$endpoint"
`,
    ),
  ]);

  const deploymentStateDirectory = path.join(brokerInstallRoot, "deployment");
  const deployEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DEPLOY_SCENARIO: scenario,
    TEST_FIRST_MIGRATION: firstMigration ? "1" : "0",
    ...(options.cold ? { TEST_COLD: "1", VIDEO_FACTORY_UPGRADE_MODE: "cold",
      VIDEO_FACTORY_EXPECTED_PREVIOUS_RELEASE: previousSha, VIDEO_FACTORY_LAST_RELEASE_FILE: path.join(directory, "last-release"),
      PUBLIC_HEALTH_URL: "http://127.0.0.1:4317/api/health" } : {}),
    DEPLOY_STATE: stateDirectory,
    DEPLOY_TRACE: tracePath,
    PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
    RELEASE_SHA: releaseSha,
    REAL_NODE: process.execPath,
    TEST_HEALTH_FIXTURE: healthFixture,
    TEST_MAINTENANCE_DIRECTORY: maintenanceDirectory,
    TEST_PREVIOUS_SHA: previousSha,
    TEST_APP_ADMISSION: options.appAdmission ?? "protocol",
    TEST_BROKER_CURRENT: path.join(brokerInstallRoot, "current"),
    TEST_CANDIDATE_BROKER: candidateBroker,
    TEST_OPENAI_UNIT: openAiUnitPath,
    TEST_PREVIOUS_RELEASE: previousRelease,
    TEST_DEEPSEEK_SOCKET: path.join(deepseekRuntimeDirectory, "worker.sock"),
    TEST_DEEPSEEK_STATE: deepseekStateRoot,
    TEST_DEEPSEEK_UNIT: deepseekUnitPath,
    VIDEO_FACTORY_ENV_FILE: environmentPath,
    VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR: deepseekRuntimeDirectory,
    ...(options.env ?? {}),
  };

  let stderr = "";
  let stdout = "";
  let exitCode = 0;
  try {
    const outcome = await execFileAsync("bash", [deployPath], {
      cwd: repository,
      env: deployEnvironment,
      timeout: 60_000,
    });
    stdout = outcome.stdout;
    stderr = outcome.stderr;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    exitCode = Number(failure.code);
    stderr = failure.stderr ?? "";
    stdout = failure.stdout ?? "";
  }

  const gatePath = path.join(maintenanceDirectory, "gate.json");
  let gateState = "";
  let gateOwner = "";
  try {
    const gate = JSON.parse(await readFile(gatePath, "utf8")) as { state?: string; owner?: string };
    gateState = gate.state ?? "";
    gateOwner = gate.owner ?? "";
  } catch {
    gateState = "";
  }
  let unitBackupsRemaining = false;
  for (const entry of await readdir(deploymentStateDirectory).catch(() => [] as string[])) {
    if (entry.startsWith("legacy-unit.") || entry.startsWith("deepseek-unit.")) {
      unitBackupsRemaining = true;
    }
  }

  try {
    assert.equal(exitCode, options.expectSuccess ? 0 : options.expectedExitCode ?? 1,
      `unexpected deployment result for ${scenario}: ${stderr}`);
    return {
      candidateImage: (await readFile(path.join(stateDirectory, "candidate-image"), "utf8")).trim(),
      currentRelease: await readlink(path.join(brokerInstallRoot, "current")),
      openAiUnit: await readFile(openAiUnitPath, "utf8"),
      stderr,
      stdout,
      trace: await readFile(tracePath, "utf8"),
      deepseekUnit: await readFile(deepseekUnitPath, "utf8"),
      deepseekWorkspaceExists: await statExists(path.join(deepseekStateRoot, "workspace")),
      gateState,
      gateOwner,
      gateBefore,
      gateAfter: await readFile(gatePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && options.cold) return "";
        throw error;
      }),
      appRunning: (await readFile(path.join(stateDirectory, "app-running"), "utf8")).trim() === "1",
      appRelease: (await readFile(path.join(stateDirectory, "app-release"), "utf8")).trim(),
      exitCode,
      unitBackupsRemaining,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** R3-C：按固定顺序断言 trace 中各动作的先后（构建→停写者→备份→切换→启动）。 */
function assertTraceOrder(trace: string, markers: string[]): void {
  let cursor = 0;
  for (const marker of markers) {
    const at = trace.indexOf(marker, cursor);
    assert.ok(at >= 0, `trace must contain "${marker}" after byte ${cursor}`);
    cursor = at + marker.length;
  }
}

function assertFullDeployRollback(result: DeployFailureResult, expectAppRollback: boolean): void {
  assert.equal(path.basename(result.currentRelease), "previous");
  assert.equal(result.appRunning, true);
  assert.equal(result.appRelease, "b".repeat(40));
  assert.equal(result.candidateImage, expectAppRollback ? "sha256:old-image" : "sha256:new-image");
  assert.match(result.openAiUnit, /Description=old-openai/);
  assert.doesNotMatch(result.openAiUnit, /Description=new-openai/);
  assert.match(result.deepseekUnit, /Description=old-deepseek/);
  assert.doesNotMatch(result.deepseekUnit, /Description=new-deepseek/);
  assert.match(result.stderr, /Deployment failed; restoring the application and all configured brokers/);
  assert.doesNotMatch(result.stderr, /Recovery did not fully restore every writer|Maintenance recovery verification failed/);
  assert.match(result.trace, /systemctl:restart vf-codex-broker/);
  assert.match(result.trace, /systemctl:restart vf-deepseek-codex-broker/);
  if (expectAppRollback) {
    assert.match(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.match(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
    assert.match(result.trace, /docker:compose .*current\.compose\.json up --detach --no-deps --force-recreate app/);
  } else {
    assert.doesNotMatch(result.trace, /docker:tag video-factory:rollback video-factory:candidate/);
    assert.doesNotMatch(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
    assert.match(result.trace, /docker:compose .*current\.compose\.json up --detach --no-deps app/);
  }
  assert.equal(result.gateState, "open");
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
restart_brokers topic-ideas,series-roadmap,creative-treatment,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit,creative-discussion
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
    assert.match(service, /^ReadWritePaths=\/var\/lib\/video-factory-deepseek-codex \/run\/video-factory-deepseek-codex \/opt\/video-factory\/codex-broker\/deployment\/maintenance$/m);
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
  it("restores the DeepSeek unit even when no legacy unit exists", async () => {
    const source = await readFile(path.join(repositoryRoot, "scripts", "deploy-production.sh"), "utf8");
    const rollback = source.match(/rollback_broker\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(rollback);
    const directory = await mkdtemp(path.join(tmpdir(), "vf-deepseek-only-rollback-"));
    try {
      await mkdir(path.join(directory, "releases", "old"), { recursive: true });
      await writeFile(path.join(directory, "old-deepseek"), "old-deepseek");
      const { stdout } = await execFileAsync("bash", ["-c", `
set -Eeuo pipefail
broker_root=${JSON.stringify(directory)}
previous_broker_release="$broker_root/releases/old"
previous_broker_unit_backup="$broker_root/missing-legacy"
previous_deepseek_broker_unit_backup="$broker_root/old-deepseek"
deepseek_broker_unit="$broker_root/current-deepseek"
legacy_broker_was_active=0
deepseek_broker_was_active=1
deepseek_broker_rollback_kinds=director-plan
systemctl() { return 0; }
restart_brokers() { echo "old-contract:$*"; }
${rollback}
rollback_broker
`]);
      assert.equal(await readFile(path.join(directory, "current-deepseek"), "utf8"), "old-deepseek");
      assert.match(stdout, /old-contract:director-plan 0 1/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("transfers the tested commit as a bundle when ECS cannot reach GitHub", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "ci-cd.yml"), "utf8");
    const deployJob = workflow.slice(workflow.indexOf("  deploy:"));

    assert.match(deployJob, /git bundle create "video-factory-release-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}\.bundle" HEAD/);
    assert.match(deployJob, /flock -w 2400 9/);
    assert.match(deployJob, /git merge-base --is-ancestor/);
    assert.match(deployJob, /appleboy\/scp-action@ff85246acaad7bdce478db94a363cd2bf7c90345/);
    assert.match(deployJob, /git -C "\$PROJECT_PATH" fetch "\$bundle_path" HEAD/);
    assert.match(deployJob, /test "\$\(git -C "\$PROJECT_PATH" rev-parse FETCH_HEAD\)" = "\$RELEASE_SHA"/);
    assert.match(deployJob, /trap 'rm -f "\$bundle_path"' EXIT/);
    assert.doesNotMatch(deployJob, /git fetch origin/);
  });

  it("preserves an explicit boolean cold backup opt-out across Actions and SSH while defaulting to backup", async () => {
    const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "ci-cd.yml"), "utf8");
    assert.match(workflow, /backup_existing_data:\n\s+description:.*\n\s+type: boolean\n\s+default: true/);
    assert.ok(workflow.includes("BACKUP_EXISTING_DATA: ${{ github.event_name == 'workflow_dispatch' && toJSON(inputs.backup_existing_data) == 'false' && 'false' || 'true' }}"));
    assert.match(workflow, /envs: [^\n]*EXPECTED_PREVIOUS_RELEASE,BACKUP_EXISTING_DATA/);
    assert.ok(workflow.includes('[[ "$BACKUP_EXISTING_DATA" == true || "$BACKUP_EXISTING_DATA" == false ]]'));
    assert.ok(workflow.includes('[[ "$BACKUP_EXISTING_DATA" == true || "$UPGRADE_MODE" == cold ]]'));
    assert.ok(workflow.includes('VIDEO_FACTORY_BACKUP_EXISTING_DATA="$BACKUP_EXISTING_DATA"'));
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
    assert.match(dockerfile, /^ARG NODE_DIST_URL$/m);
    assert.match(dockerfile, /npm config set registry "\$NPM_REGISTRY"/);
    assert.match(dockerfile, /npm_config_disturl="\$NODE_DIST_URL" npm ci/);
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
    assert.match(compose, /NODE_DIST_URL: \$\{NODE_DIST_URL:-\}/);
    assert.match(deploy, /ALPINE_MIRROR="\$\{ALPINE_MIRROR:-http:\/\/mirrors\.cloud\.aliyuncs\.com\/alpine\}"/);
    assert.match(deploy, /NPM_REGISTRY="\$\{NPM_REGISTRY:-https:\/\/registry\.npmmirror\.com\}"/);
    assert.match(deploy, /NODE_DIST_URL="\$\{NODE_DIST_URL:-https:\/\/npmmirror\.com\/mirrors\/node\}"/);
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
    assert.match(script, /if \[\[ ! -s "\$previous_broker_unit_backup" && -f "\$previous_broker_release\/deploy\/vf-codex-broker.service" \]\]/);
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

  it("rejects the wrong broker identity and restores the already stopped original app", async () => {
    const result = await runDeployFailureScenario("broker-identity");

    assertFullDeployRollback(result, false);
  });

  it("rolls back the app only after the candidate app has actually been started", async () => {
    const result = await runDeployFailureScenario("app-health");

    assertFullDeployRollback(result, true);
  });

  it("restores the old app after a failed first DeepSeek migration without requiring a prior DeepSeek service", async () => {
    const result = await runDeployFailureScenario("app-health", { firstMigration: true });
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.equal(result.candidateImage, "sha256:old-image");
    assert.match(result.trace, /systemctl:stop vf-deepseek-codex-broker/);
    assert.match(result.trace, /systemctl:restart vf-codex-broker/);
    assert.equal(result.trace.match(/systemctl:restart vf-deepseek-codex-broker/g)?.length, 1);
    assert.match(result.trace, /docker:compose .* up --detach --no-deps --force-recreate app/);
    assert.doesNotMatch(result.stderr, /Recovery did not fully restore every writer|Maintenance recovery verification failed/);
  });

  it("preserves both retired socket mounts for rollback to the previous production image", async () => {
    const compose = await readFile(path.join(repositoryRoot, "docker", "docker-compose.prod.yml"), "utf8");
    assert.match(compose, /target: \/run\/video-factory-codex\n/);
    assert.match(compose, /target: \/run\/video-factory-zai-codex\n/);
    assert.match(compose, /VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH:/);
  });

  it("drains, freezes, backs up and only then switches artifacts in the fixed maintenance order (R3-C)", async () => {
    const result = await runDeployFailureScenario("success", { expectSuccess: true });

    assert.equal(result.candidateImage, "sha256:new-image");
    assert.notEqual(path.basename(result.currentRelease), "previous");
    assert.match(result.deepseekUnit, /Description=new-deepseek/);
    assertTraceOrder(result.trace, [
      " build app",
      "systemctl:stop vf-codex-broker",
      "systemctl:stop vf-deepseek-codex-broker",
      "backup:",
      "->",
      "systemctl:restart vf-deepseek-codex-broker",
      " up --detach --remove-orphans --force-recreate app",
    ]);
    // 成功路径：同一 owner 重开门禁并清理 unit 备份（已提交）。
    assert.equal(result.gateState, "open");
    assert.match(result.gateOwner, /^deploy-/);
    assert.equal(result.unitBackupsRemaining, false);
  });

  it("keeps the maintenance transaction order when the candidate app fails health (R3-C failure finale)", async () => {
    const result = await runDeployFailureScenario("app-health");

    assertFullDeployRollback(result, true);
    assertTraceOrder(result.trace, [
      " build app",
      "systemctl:stop vf-codex-broker",
      "systemctl:stop vf-deepseek-codex-broker",
      "backup:",
      "->",
      " up --detach --remove-orphans --force-recreate app",
    ]);
    // 回滚在闭门状态完成后重开门禁。
    assert.equal(result.gateState, "open");
    assert.match(result.gateOwner, /^deploy-/);
  });

  it("rejects a healthy app that does not report the candidate release (R3b version binding)", async () => {
    const result = await runDeployFailureScenario("success", {
      env: { TEST_APP_RELEASE_MISMATCH: "1" },
    });

    assert.match(result.stderr, /does not report the candidate release/);
    assertFullDeployRollback(result, true);
    assert.equal(result.gateState, "open");
  });

  it("reopens the gate without touching services when the drain times out (R3-D)", async () => {
    const result = await runDeployFailureScenario("success", {
      env: {
        TEST_BROKER_BUSY: "1",
        TEST_REAL_DRAIN_SLEEP: "1",
        VIDEO_FACTORY_DRAIN_TIMEOUT_SECONDS: "6",
      },
    });

    assert.match(result.stderr, /Drain timed out after 6s; verifying the original services before reopening/);
    assert.match(result.stderr, /Maintenance gate reopened/);
    assert.doesNotMatch(result.trace, /systemctl:stop/);
    assert.doesNotMatch(result.trace, /backup:/);
    assert.doesNotMatch(result.trace, /->/);
    assert.doesNotMatch(result.trace, / up --detach/);
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.match(result.deepseekUnit, /Description=old-deepseek/);
    assert.equal(result.gateState, "open");
  });

  for (const failure of ["TEST_STOP_FAILS", "TEST_APP_STOP_FAILS", "TEST_UNKNOWN_SERVICE_STATE", "TEST_UNKNOWN_APP_STATE"] as const) {
    it(`preserves FROZEN without restart or backup when clean writer exit is unproved: ${failure}`, async () => {
      const result = await runDeployFailureScenario("success", { env: { [failure]: "1" } });
      assert.match(result.stderr, /Failed to stop writers cleanly/);
      assert.match(result.stderr, /gate stays FROZEN/);
      assert.doesNotMatch(result.stderr, /Maintenance gate reopened/);
      assert.match(result.trace, /systemctl:stop vf-codex-broker/);
      assert.doesNotMatch(result.trace, /systemctl:restart|backup:|->| up --detach/);
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.match(result.deepseekUnit, /Description=old-deepseek/);
      assert.equal(result.gateState, "frozen");
      assert.equal(result.unitBackupsRemaining, true);
    });
  }

  it("keeps the previous artifacts and reopens when the full backup fails (R3-D)", async () => {
    const result = await runDeployFailureScenario("success", {
      env: { TEST_BACKUP_FAILS: "1" },
    });

    assert.match(result.stderr, /Full backup or its restore verification failed; not switching artifacts/);
    assert.match(result.trace, /backup:/);
    assert.doesNotMatch(result.trace, /->/);
    assert.match(result.trace, /current\.compose\.json up --detach --no-deps app/);
    assert.equal(result.appRunning, true);
    assert.equal(result.appRelease, "b".repeat(40));
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.match(result.deepseekUnit, /Description=old-deepseek/);
    assert.match(result.trace, /systemctl:restart vf-codex-broker/);
    assert.equal(result.gateState, "open");
  });

  it("upgrades legacy writers only through explicit cold ingress, idle, stop and backup proofs", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, expectSuccess: true });
    assert.equal(result.gateBefore, "");
    assert.equal(result.gateState, "open");
    assert.equal(result.appRelease, "a".repeat(40));
    assertTraceOrder(result.trace, ["cold:prepare", "ingress:enter", "cold:idle", "cold:stop-app", " stop --timeout -1 app",
      "cold:stop-brokers", "cold:stopped", "backup:", "->", "systemctl:restart vf-deepseek-codex-broker",
      " up --detach --remove-orphans --force-recreate app", "ingress:restore"]);
    assert.doesNotMatch(result.trace, /cold:restored/);
  });

  it("skips historical backup only after cold stop proofs and still verifies and opens the candidate", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, expectSuccess: true,
      env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: "false", TEST_BACKUP_FAILS: "1" } });
    assert.match(result.stdout, /Historical data backup explicitly disabled for this cold release; no full backup was created/);
    assert.doesNotMatch(result.trace, /backup:|cold:restored/);
    assertTraceOrder(result.trace, ["cold:prepare", "ingress:enter", "cold:idle", "cold:stop-app", " stop --timeout -1 app",
      "cold:stop-brokers", "cold:stopped", "->", "systemctl:restart vf-deepseek-codex-broker",
      " up --detach --remove-orphans --force-recreate app", "ingress:restore"]);
    assert.equal(result.appRelease, "a".repeat(40));
    assert.equal(result.appRunning, true);
    assert.equal(result.gateState, "open");
    assert.match(result.gateOwner, /^deploy-/);
    assert.equal(result.unitBackupsRemaining, false);
  });

  it("cannot bypass unproved cold writer exit by disabling historical backup", async () => {
    const result = await runDeployFailureScenario("success", { cold: true,
      env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: "false", TEST_COLD_FAIL: "stop-brokers" } });
    assert.equal(result.appRunning, false);
    assert.equal(result.gateAfter, "");
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.doesNotMatch(result.trace, /backup:|->|systemctl:restart| up --detach|ingress:restore/);
    assert.match(result.stderr, /Cold stop was not fully verified/);
  });

  it("rolls back a cold candidate that fails exact release verification even when backup is disabled", async () => {
    const result = await runDeployFailureScenario("success", { cold: true,
      env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: "false", TEST_APP_RELEASE_MISMATCH: "1" } });
    assert.match(result.stderr, /does not report the candidate release/);
    assert.doesNotMatch(result.trace, /backup:/);
    assertTraceOrder(result.trace, ["cold:stopped", "->", " up --detach --remove-orphans --force-recreate app",
      "cold:rollback-stopped", "cold:restored", "ingress:restore"]);
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.equal(result.appRelease, "b".repeat(40));
    assert.equal(result.appRunning, true);
    assert.equal(result.gateState, "open");
  });

  for (const cold of [false, true]) {
    it(`rejects historical backup opt-out before side effects for ${cold ? "bootstrap" : "online"} deployment`, async () => {
      const result = await runDeployFailureScenario("success", { cold,
        env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: "false", VIDEO_FACTORY_DEPLOYMENT_MODE: cold ? "bootstrap" : "release" } });
      assert.match(result.stderr, /Skipping historical backup requires an explicit cold release/);
      assert.equal(result.trace, "");
      assert.equal(result.gateAfter, result.gateBefore);
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.equal(result.appRelease, "b".repeat(40));
      assert.equal(result.appRunning, true);
    });

    it(`still requires a successful backup when explicitly enabled for ${cold ? "cold" : "online"} deployment`, async () => {
      const result = await runDeployFailureScenario("success", { cold,
        env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: "true", TEST_BACKUP_FAILS: "1" } });
      assert.match(result.trace, /backup:/);
      assert.match(result.stderr, /Full backup or its restore verification failed; not switching artifacts/);
      assert.doesNotMatch(result.trace, /->/);
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.equal(result.appRelease, "b".repeat(40));
      assert.equal(result.appRunning, true);
      assert.equal(result.gateState, "open");
    });
  }

  for (const value of ["0", "1", "yes", "False"]) {
    it(`rejects an invalid historical backup value before touching services: ${value}`, async () => {
      const result = await runDeployFailureScenario("success", { cold: true,
        env: { VIDEO_FACTORY_BACKUP_EXISTING_DATA: value } });
      assert.match(result.stderr, /VIDEO_FACTORY_BACKUP_EXISTING_DATA must be true or false/);
      assert.equal(result.trace, "");
      assert.equal(result.gateAfter, result.gateBefore);
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.equal(result.appRunning, true);
    });
  }

  it("restores the untouched legacy service after cold idle refuses, without stopping any writer", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, env: { TEST_COLD_FAIL: "idle" } });
    assert.equal(result.gateAfter, "");
    assert.equal(result.appRunning, true);
    assertTraceOrder(result.trace, ["ingress:enter", "cold:idle", "ingress:restore"]);
    assert.doesNotMatch(result.trace, / stop --timeout|systemctl:stop|backup:|->/);
  });

  it("does not advance cold deployment when cooperative app shutdown is unproved", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, env: { TEST_COLD_FAIL: "stop-app" } });
    assert.equal(result.appRunning, true);
    assert.equal(result.gateAfter, "");
    assertTraceOrder(result.trace, ["ingress:enter", "cold:idle", "cold:stop-app"]);
    assert.doesNotMatch(result.trace, / stop --timeout|cold:stop-brokers|ingress:restore|systemctl:restart|backup:|->/);
    assert.match(result.stderr, /Cold stop was not fully verified/);
  });

  it("leaves cold ingress closed without restart when normal broker stop is unproved", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, env: { TEST_COLD_FAIL: "stop-brokers" } });
    assert.equal(result.appRunning, false);
    assert.equal(result.gateAfter, "");
    assert.doesNotMatch(result.trace, /ingress:restore|systemctl:restart|backup:|->/);
    assert.match(result.stderr, /Cold stop was not fully verified/);
  });

  it("explicitly aborts a cold transaction and restores the original writers when backup fails", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, env: { TEST_BACKUP_FAILS: "1" } });
    assert.equal(result.gateState, "open");
    assert.equal(result.appRelease, "b".repeat(40));
    assert.equal(path.basename(result.currentRelease), "previous");
    assertTraceOrder(result.trace, ["backup:", "cold:rollback-stopped", "systemctl:restart vf-deepseek-codex-broker",
      "cold:restored", "cold:cleanup", "ingress:restore"]);
  });

  it("normally stops the cold candidate before restoring the exact legacy artifacts", async () => {
    const result = await runDeployFailureScenario("app-health", { cold: true });
    assert.equal(result.gateState, "open");
    assert.equal(result.appRelease, "b".repeat(40));
    assert.equal(path.basename(result.currentRelease), "previous");
    assertTraceOrder(result.trace, ["backup:", " up --detach --remove-orphans --force-recreate app",
      " stop --timeout -1 app", "systemctl:stop vf-deepseek-codex-broker", "cold:rollback-stopped",
      "systemctl:restart vf-deepseek-codex-broker", "cold:restored", "ingress:restore"]);
  });

  it("rejects a previous maintenance owner before closing cold ingress", async () => {
    const result = await runDeployFailureScenario("success", { cold: true, leftoverGate: "frozen" });
    assert.equal(result.gateOwner, "deploy-crashed");
    assert.equal(result.gateBefore, result.gateAfter);
    assert.doesNotMatch(result.trace, /ingress:enter| stop --timeout|systemctl:stop|backup:|->/);
  });

  it("keeps cold ingress closed if restored legacy identity cannot be verified", async () => {
    const result = await runDeployFailureScenario("success", { cold: true,
      env: { TEST_BACKUP_FAILS: "1", TEST_COLD_FAIL: "restored" } });
    assert.equal(result.gateState, "frozen");
    assert.doesNotMatch(result.trace, /ingress:restore/);
    assert.match(result.stderr, /Cold upgrade recovery is incomplete/);
  });

  it("never rolls back a committed cold candidate when ingress restoration fails", async () => {
    const result = await runDeployFailureScenario("success", { cold: true,
      env: { TEST_COLD_FAIL: "ingress-restore" } });
    assert.equal(result.appRelease, "a".repeat(40));
    assert.equal(result.gateState, "open");
    assert.notEqual(path.basename(result.currentRelease), "previous");
    assert.doesNotMatch(result.trace, /cold:restored|cold:rollback-stopped/);
  });

  it("refuses an online switch when the running app predates the maintenance protocol (R3-E)", async () => {
    const result = await runDeployFailureScenario("success", {
      appAdmission: "legacy",
      env: { TEST_APP_RUNNING: "1" },
    });

    assert.match(result.stderr, /拒绝在线切换.*当前运行中的 app/);
    assert.doesNotMatch(result.trace, /systemctl:stop/);
    assert.doesNotMatch(result.trace, /backup:/);
    assert.doesNotMatch(result.trace, /->/);
    assert.doesNotMatch(result.trace, / up --detach/);
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.equal(result.gateState, "open");
    assert.equal(result.gateAfter, result.gateBefore);
  });

  it("refuses an online switch when an active broker predates the maintenance protocol (R3-E)", async () => {
    const result = await runDeployFailureScenario("success", {
      env: { TEST_LEGACY_BROKER_LEGACY: "1" },
    });

    assert.match(result.stderr, /拒绝在线切换.*旧版 vf-codex-broker/);
    assert.doesNotMatch(result.trace, /systemctl:stop/);
    assert.doesNotMatch(result.trace, /backup:/);
    assert.doesNotMatch(result.trace, /->/);
    assert.equal(path.basename(result.currentRelease), "previous");
    assert.equal(result.gateState, "open");
    assert.equal(result.gateAfter, result.gateBefore);
  });

  for (const leftoverGate of ["draining", "frozen"] as const) {
    it(`leaves a crashed owner's ${leftoverGate} gate unchanged instead of taking it over (R3-G)`, async () => {
      const result = await runDeployFailureScenario("success", { leftoverGate });
      assert.equal(result.gateOwner, "deploy-crashed");
      assert.equal(result.gateState, leftoverGate);
      assert.equal(result.gateAfter, result.gateBefore);
      assert.match(result.stderr, /previous maintenance owner must be recovered explicitly/);
      assert.doesNotMatch(result.trace, /systemctl:stop|systemctl:restart|backup:|->| up --detach/);
      assert.equal(result.appRunning, true);
      assert.equal(result.appRelease, "b".repeat(40));
    });
  }

  for (const signal of ["TERM", "INT"] as const) {
    it(`recovers the original admission without stopping writers after ${signal} during drain`, async () => {
      const result = await runDeployFailureScenario("success", {
        env: { TEST_SIGNAL_DURING_DRAIN: signal, TEST_BROKER_BUSY: "1" },
        expectedExitCode: signal === "TERM" ? 143 : 130,
      });
      assert.doesNotMatch(result.trace, /systemctl:stop|systemctl:restart|backup:|->| up --detach/);
      assert.equal(result.appRunning, true);
      assert.equal(result.appRelease, "b".repeat(40));
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.equal(result.gateState, "open");
    });

    it(`recovers stopped original writers under the closed gate after ${signal} during backup`, async () => {
      const result = await runDeployFailureScenario("success", {
        env: { TEST_SIGNAL_AT_BACKUP: signal }, expectedExitCode: signal === "TERM" ? 143 : 130,
      });
      assert.match(result.trace, /backup:/);
      assert.doesNotMatch(result.trace, /->/);
      assert.equal(path.basename(result.currentRelease), "previous");
      assert.equal(result.appRunning, true);
      assert.equal(result.appRelease, "b".repeat(40));
      assert.equal(result.gateState, "open");
      assert.match(result.stderr, /Restoring the previous writers under the closed maintenance gate/);
    });
  }

  for (const signal of ["TERM", "INT"] as const) {
    it(`rolls back a partially switched release after ${signal} without swallowing its failure exit`, async () => {
      const result = await runDeployFailureScenario("success", {
        env: { TEST_SIGNAL_AFTER_APP_UP: signal }, expectedExitCode: signal === "TERM" ? 143 : 130,
      });
      assertFullDeployRollback(result, true);
    });
  }

  for (const signal of ["TERM", "INT"] as const) for (const incomplete of [false, true]) {
    it(`does not resurrect old writers after committed ${signal}; candidate integrity ${incomplete ? "incomplete" : "complete"}`, async () => {
      const result = await runDeployFailureScenario("success", {
        env: { TEST_SIGNAL_AFTER_COMMIT: signal, TEST_COMMITTED_INTEGRITY_FAILS: incomplete ? "1" : "0" },
        expectedExitCode: signal === "TERM" ? 143 : 130,
      });
      assert.notEqual(path.basename(result.currentRelease), "previous");
      assert.equal(result.candidateImage, "sha256:new-image");
      assert.equal(result.appRunning, true);
      assert.equal(result.appRelease, "a".repeat(40));
      assert.doesNotMatch(result.trace, /systemctl:restart vf-codex-broker/);
      assert.equal(result.trace.match(/systemctl:restart vf-deepseek-codex-broker/g)?.length, 1);
      assert.doesNotMatch(result.trace, /current\.compose\.json up |docker:tag video-factory:rollback/);
      assert.doesNotMatch(result.stderr, /Restoring the previous writers/);
      assert.equal(result.gateState, incomplete ? "frozen" : "open");
      assert.equal(result.unitBackupsRemaining, incomplete);
      if (incomplete) {
        assert.match(result.stderr, /Maintenance recovery verification failed/);
        assert.doesNotMatch(result.stderr, /Maintenance gate reopened/);
      } else assert.match(result.stderr, /Maintenance gate reopened/);
    });
  }

  for (const failure of ["TEST_ROLLBACK_APP_FAILS", "TEST_ROLLBACK_BROKER_FAILS"] as const) {
    it(`retains FROZEN and recovery evidence when rollback is incomplete: ${failure}`, async () => {
      const result = await runDeployFailureScenario("app-health", { env: { [failure]: "1" } });
      assert.equal(result.gateState, "frozen");
      assert.equal(result.unitBackupsRemaining, true);
      assert.match(result.stderr, /Recovery did not fully restore every writer/);
      assert.doesNotMatch(result.stderr, /Maintenance gate reopened/);
      assert.equal(path.basename(result.currentRelease), "previous");
    });
  }

  for (const failure of ["TEST_CONTAINER_LIST_FAILS", "TEST_CONTAINER_INSPECT_FAILS"] as const) {
    it(`does not misclassify failed container discovery as a first installation: ${failure}`, async () => {
      const result = await runDeployFailureScenario("success", { env: { [failure]: "1" } });
      assert.equal(result.gateAfter, result.gateBefore);
      assert.doesNotMatch(result.trace, /systemctl:stop|systemctl:restart|backup:|->| up --detach/);
      assert.equal(path.basename(result.currentRelease), "previous");
    });
  }

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
    assert.match(deploy, /broker_contract_kinds\(\)/);
    assert.match(deploy, /task_kinds_from_release\(\)/);
    assert.match(deploy, /BROKER_TASK_DEFINITIONS="\$definitions"/);
    assert.match(deploy, /candidate_broker_task_kinds="\$\(task_kinds_from_release "\$candidate_broker_release"\)"/);
    assert.match(deploy, /restart_brokers "\$deepseek_broker_rollback_kinds" 0 1/);
    assert.match(deploy, /restart_brokers "\$candidate_broker_task_kinds"/);
    assert.match(deploy, /broker_health "\$deepseek_broker_socket" deepseek deepseek \\\n\s+"\$candidate_broker_task_kinds"/);
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
    assert.match(restartBrokers, /! systemctl restart "\$deepseek_broker_service"/);
    assert.match(restartBrokers, /Configured DeepSeek broker is unavailable; refusing a partial deployment/);
    assert.match(restartBrokers, /failed=1/);
    assert.doesNotMatch(restartBrokers, /deepseek_broker_enabled=0|ensure_deepseek_runtime_mount/);
  });
});
