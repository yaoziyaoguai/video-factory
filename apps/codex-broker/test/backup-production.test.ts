import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile, truncate } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const backupScript = path.join(repositoryRoot, "scripts", "backup-production.sh");
const verifierScript = path.join(repositoryRoot, "scripts", "verify-production-backup.mjs");

const STOPPED_STATE = { Running: false, Status: "exited", Pid: 0, Restarting: false, Dead: false };
const INSPECT_STOPPED = JSON.stringify([{
  State: STOPPED_STATE, Image: "sha256:test-image", Config: { User: "1001:1001", Env: [`VIDEO_FACTORY_RELEASE_SHA=${"a".repeat(40)}`] }, Mounts: [],
}]);
const INSPECT_RUNNING = JSON.stringify([{ State: { ...STOPPED_STATE, Running: true }, Image: "sha256:test-image", Mounts: [] }]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const DEFAULT_STORE = `vfs_store_${"1".repeat(32)}`;
const SESSION_HANDLE = `vfs_${"a".repeat(32)}`;
const CHECKPOINT_KEY = hash("series-planning-checkpoint");
const PYTHON = path.join(repositoryRoot, ".local/python/.venv/bin/python");

interface BackupFixture {
  root: string;
  maintenanceDir: string;
  appRoot: string;
  brokerRoot: string;
  brokerEnv: string;
  backupDir: string;
  binDir: string;
  tracePath: string;
  walHolder?: ReturnType<typeof spawn>;
  writeGate(state: "draining" | "frozen" | "open", owner: string): Promise<void>;
  runBackup(overrides?: Record<string, string>, injectedDriver?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  dispose(): Promise<void>;
}

async function writeExecutable(directory: string, name: string, contents: string): Promise<void> {
  const target = path.join(directory, name);
  await writeFile(target, contents, "utf8");
  await chmod(target, 0o755);
}

async function sha256Of(target: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const content = await readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

/** WAL 只在持有连接未关闭时保留已提交内容：后台持有者进程保持 -wal 存活。 */
async function startWalHolder(database: string): Promise<ReturnType<typeof spawn>> {
  const holder = spawn("python3", ["-c", `
import sqlite3, sys, time
conn = sqlite3.connect(sys.argv[1])
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA wal_autocheckpoint=0")
conn.execute("CREATE TABLE IF NOT EXISTS topics (id INTEGER PRIMARY KEY, title TEXT)")
conn.execute("INSERT INTO topics (title) VALUES ('committed-in-wal')")
conn.commit()
sys.stderr.write("holder-ready\\n")
time.sleep(600)
`, database], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("wal holder 未就绪")), 10_000);
    holder.stderr!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("holder-ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    holder.on("exit", () => reject(new Error("wal holder 提前退出")));
  });
  return holder;
}

async function buildFixture(): Promise<BackupFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "video-factory-backup-"));
  const maintenanceDir = path.join(root, "maintenance");
  const appRoot = path.join(root, "app-factory");
  const brokerRoot = path.join(root, "broker-workspace");
  const brokerEnv = path.join(root, "deepseek-codex-broker.env");
  const backupDir = path.join(root, "backups");
  const binDir = path.join(root, "bin");
  const tracePath = path.join(root, "trace.log");

  const directories = [
    maintenanceDir,
    path.join(appRoot, "runs", "run-001", "input"),
    path.join(appRoot, "runs", "run-001", "output"),
    path.join(appRoot, "checkpoints"),
    path.join(appRoot, "settings"),
    path.join(appRoot, "opportunities"),
    path.join(appRoot, "cache"),
    path.join(appRoot, "data"),
    path.join(brokerRoot, ".video-factory", "models", "m-abcdef123456", "tasks"),
    path.join(brokerRoot, ".video-factory", "models", "m-123456abcdef", "tasks"),
    path.join(brokerRoot, ".video-factory", "codex-idempotency", "deepseek"),
    path.join(brokerRoot, ".video-factory", "codex-sessions", "deepseek"),
    backupDir,
    binDir,
  ];
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));

  const fixture: BackupFixture = {
    root,
    maintenanceDir,
    appRoot,
    brokerRoot,
    brokerEnv,
    backupDir,
    binDir,
    tracePath,
    writeGate: async (state, owner) => {
      await writeFile(
        path.join(maintenanceDir, "gate.json"),
        JSON.stringify({ state, owner, updatedAt: "2026-10-14T00:00:00Z", generation: 2 }),
        "utf8",
      );
    },
    runBackup: (overrides = {}, injectedDriver) => new Promise((resolve) => {
      execFile(injectedDriver ? PYTHON : "bash", injectedDriver ? ["-I", "-B", injectedDriver] : [backupScript], {
        cwd: repositoryRoot,
        env: {
          PATH: `${binDir}:${path.dirname(process.execPath)}:${path.join(repositoryRoot, ".local/python/.venv/bin")}:/usr/bin:/bin`,
          REAL_NODE: process.execPath,
          TEST_VERIFIER: verifierScript,
          DEPLOY_TRACE: tracePath,
          TEST_BACKUP_DIR: backupDir,
          TEST_DOCKER_INSPECT: "stopped",
          TEST_INSPECT_STOPPED: INSPECT_STOPPED,
          TEST_INSPECT_RUNNING: INSPECT_RUNNING,
          TEST_BROKER_ACTIVE: "0",
          TEST_APP_ROOT: appRoot,
          TEST_BROKER_ROOT: brokerRoot,
          TEST_BROKER_ENV: brokerEnv,
          VIDEO_FACTORY_BACKUP_SOURCE_DESCRIPTOR: path.join(root, "source.json"),
          VIDEO_FACTORY_MAINTENANCE_DIR: maintenanceDir,
          VIDEO_FACTORY_MAINTENANCE_OWNER: "deploy-1",
          VIDEO_FACTORY_APP_WORKSPACE_ROOT: appRoot,
          VIDEO_FACTORY_BROKER_WORKSPACE_ROOT: brokerRoot,
          VIDEO_FACTORY_BROKER_ENV_FILE: brokerEnv,
          VIDEO_FACTORY_BACKUP_DIR: backupDir,
          VIDEO_FACTORY_BACKUP_ID: "test-backup-0001",
          VIDEO_FACTORY_BACKUP_VERIFY_IMAGE: "sha256:test-image",
          ...overrides,
        },
      }, (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          code: exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      });
    }),
    dispose: async () => {
      fixture.walHolder?.kill("SIGKILL");
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true });
    },
  };

  await writeExecutable(binDir, "docker", `#!${PYTHON} -I
import json, os, pathlib, subprocess, sys
args = sys.argv[1:]
env = os.environ
with open(env['DEPLOY_TRACE'], 'a') as trace:
    trace.write('docker:' + ' '.join(args) + '\\n')
    trace.write('backup-files-at-verify:' + str(len([p for p in pathlib.Path(env['TEST_BACKUP_DIR']).iterdir() if not p.name.startswith('.')])) + '\\n')
if args[0] == 'inspect':
    if env['TEST_DOCKER_INSPECT'] == 'missing': sys.exit(1)
    print(env['TEST_INSPECT_RUNNING'] if env['TEST_DOCKER_INSPECT'] == 'running' else env['TEST_INSPECT_STOPPED'])
    sys.exit(0)
if '--eval' in args:
    print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'groups': os.getgroups()}))
    sys.exit(0)
mounts = {}
for index, arg in enumerate(args):
    if arg == '-v':
        source, destination, access = args[index + 1].split(':')
        assert access == 'ro'
        mounts[destination] = source
root = args[args.index('--root') + 1]
command = [env['REAL_NODE'], env['TEST_VERIFIER'], '--role', args[args.index('--role') + 1], '--root', mounts[root], '--logical-root', root]
if '--codex-home' in args: command += ['--codex-home', mounts[args[args.index('--codex-home') + 1]]]
result = subprocess.run(command, capture_output=True, text=True)
if env.get('TEST_FINAL_GATE_GENERATION') and 'restore-verify' in mounts[root]:
    gate = pathlib.Path(env['VIDEO_FACTORY_MAINTENANCE_DIR']) / 'gate.json'
    value = json.loads(gate.read_text()); value['generation'] = int(env['TEST_FINAL_GATE_GENERATION']); gate.write_text(json.dumps(value))
if env.get('TEST_FINAL_GATE_OWNER') and 'restore-verify' in mounts[root]:
    gate = pathlib.Path(env['VIDEO_FACTORY_MAINTENANCE_DIR']) / 'gate.json'
    value = json.loads(gate.read_text()); value['owner'] = env['TEST_FINAL_GATE_OWNER']; gate.write_text(json.dumps(value))
sys.stdout.write(result.stdout); sys.stderr.write(result.stderr); sys.exit(result.returncode)
`);
  await writeExecutable(binDir, "systemctl", `#!${PYTHON} -I
import json, os, sys
args = sys.argv[1:]
env = os.environ
if env.get('TEST_SYSTEMCTL_FAILURE'): sys.exit(1)
units = json.loads(env.get('TEST_EXTRA_UNITS', '{}'))
if args[0] in ('list-units', 'list-unit-files'):
    if env.get('TEST_NO_INSTALLED_BROKER'):
        if any('*' in arg for arg in args): sys.exit(1 if args[0] == 'list-unit-files' else 0)
        print('unrelated.service enabled')
    else:
        print('vf-deepseek-codex-broker.service disabled')
        for unit in units: print(unit + ' disabled')
elif args[0] == 'show':
    unit = args[1]
    if env.get('TEST_NO_INSTALLED_BROKER') or (unit != 'vf-deepseek-codex-broker.service' and unit not in units):
        print('LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nControlPID=0\\nControlGroup='); sys.exit(0)
    config = units.get(unit, {})
    active = env.get('TEST_BROKER_STATE', 'active' if env['TEST_BROKER_ACTIVE'] == '1' else 'inactive')
    values = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': active, 'SubState': env.get('TEST_BROKER_SUBSTATE', 'dead'),
        'MainPID': env.get('TEST_BROKER_PID', '0'), 'ControlPID': '0', 'ControlGroup': '', 'DynamicUser': 'no',
        'User': str(os.getuid()), 'Group': str(os.getgid()), 'SupplementaryGroups': '',
        'Environment': 'VIDEO_FACTORY_CODEX_PROFILE=deepseek VIDEO_FACTORY_CODEX_WORKSPACE_ROOT=' + env['TEST_BROKER_ROOT'],
        'EnvironmentFiles': env['TEST_BROKER_ENV'] + ' (ignore_errors=no)', **config}
    for key, value in values.items(): print(key + '=' + str(value))
else: sys.exit(1)
`);
  await writeFile(path.join(root, "source.json"), JSON.stringify({ version: 1,
    app: { uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!() },
    brokers: [{ unit: "vf-deepseek-codex-broker.service", workspaceRoot: brokerRoot,
      logicalRoot: "/var/lib/video-factory-deepseek-codex/workspace", envFiles: [{ source: brokerEnv, logical: "/etc/video-factory/deepseek-codex-broker.env" }],
      uid: process.getuid!(), gid: process.getgid!(), groups: process.getgroups!(), profile: "deepseek" }],
  }));

  await fixture.writeGate("frozen", "deploy-1");
  await writeFile(path.join(maintenanceDir, "holders.json"), JSON.stringify({ protocol: "video-factory/maintenance-admission-v2", holders: [] }));
  return fixture;
}

async function populateBusinessData(fixture: BackupFixture): Promise<{ finalVideoSha: string }> {
  const input = path.join(fixture.appRoot, "runs", "run-001", "input");
  const output = path.join(fixture.appRoot, "runs", "run-001", "output");
  await writeFile(path.join(input, "original.mov"), "原始参考 mov 字节", "utf8");
  await writeFile(path.join(input, "paid-image.png"), "付费图片字节", "utf8");
  await writeFile(path.join(input, "paid-audio.mp3"), "付费音频字节", "utf8");
  await writeFile(path.join(input, "narration.m4a"), "旁白音频字节", "utf8");
  await writeFile(path.join(output, "final.mp4"), "成片字节", "utf8");
  const finalVideoSha = await sha256Of(path.join(output, "final.mp4"));

  const run = {
    id: "run-001",
    revision: 3,
    workflowId: "video-production",
    workflowVersion: "v3",
    status: "awaiting_spend_approval",
    initialInput: {},
    startedAt: "2026-10-13T08:00:00.000Z",
    nodeRuns: [],
    artifacts: [
      {
        id: "artifact-final",
        kind: "final_video",
        uri: "runs/run-001/output/final.mp4",
        sha256: finalVideoSha,
        sizeBytes: Buffer.byteLength("成片字节"),
        createdAt: "2026-10-13T09:00:00.000Z",
        provenance: { source: "test" },
      },
    ],
    interventions: [],
    decisions: [{ id: "decision-1", decision: "approve" }],
    spendAuthorizations: [{ id: "spend-1", scope: "production", amountCny: 1 }],
  };
  await writeFile(path.join(fixture.appRoot, "runs", "run-001", "run.json"), JSON.stringify(run, null, 2), "utf8");
  await mkdir(path.join(fixture.appRoot, "checkpoints/series-showrunner"), { recursive: true });
  await writeFile(path.join(fixture.appRoot, "checkpoints/series-showrunner", `${CHECKPOINT_KEY}.json`), JSON.stringify({
    version: "video-factory/agent-loop-checkpoint-v9", key: CHECKPOINT_KEY, storageKey: CHECKPOINT_KEY,
    status: "awaiting_user", completed: [], attemptedRequestIds: [],
    planningOwner: { kind: "series", id: "series-001", title: "新建系列", action: "generate" },
  }));
  const { JsonCreatorSettingsStore } = await import("../../studio/src/server/creator-settings-store.js");
  await new JsonCreatorSettingsStore(path.join(fixture.appRoot, "settings/creator-settings.json")).update({});
  await writeFile(path.join(fixture.appRoot, "opportunities/opportunities.json"), JSON.stringify({ version: 1, opportunities: [] }));
  await writeFile(path.join(fixture.appRoot, "cache", "stock.json"), "可再生缓存", "utf8");

  const connection = { label: "Fixture", protocol: "openai-chat-completions", baseUrl: "https://api.example.com",
    modelId: "fixture-model", apiKey: "FAKE-KEY-never-provider", capabilities: ["text"], maxOutputTokens: 1000 };
  await writeFile(path.join(fixture.brokerRoot, ".video-factory/models/models.json"), JSON.stringify({ version: 1,
    entries: [{ id: "m-abcdef123456", enabled: true, connection }, { id: "m-123456abcdef", enabled: false, connection }],
  }));
  const session = { version: 1, handle: SESSION_HANDLE, key: "series-001", taskKind: "series-roadmap",
    threadId: "12345678-1234-4123-8123-123456789abc" };
  for (const [directory, provider, requestId, state, storeId] of [
    ["models/m-abcdef123456/tasks", "m-abcdef123456", "r1", "completed", `vfs_store_${"2".repeat(32)}`],
    ["models/m-123456abcdef/tasks", "m-123456abcdef", "r-disabled", "accepted", `vfs_store_${"3".repeat(32)}`],
    ["codex-idempotency/deepseek", "deepseek", "r2", "accepted", DEFAULT_STORE],
    ["codex-idempotency/deepseek", "deepseek", "r-session", "completed", DEFAULT_STORE],
  ] as const) {
    const binding = { version: "video-factory/task-binding-v1", storeId, providerId: provider, modelId: "fixture-model",
      requestDigest: hash(requestId), kind: "series-roadmap", contractDigest: null,
      sessionDigest: requestId === "r-session" ? hash('{"handle":null,"key":"series-001"}') : hash("null") };
    const value = { version: 3, requestId, digest: hash(`execution-${requestId}`), binding, state,
      ...(state === "accepted" ? { uncertainty: { localExecutionEndedAt: "2026-10-13T10:00:00.000Z" } }
        : { outcome: { ok: true, output: "{}", trace: { providerId: provider, modelId: binding.modelId, taskKind: binding.kind },
          ...(requestId === "r-session" ? { sessionHandle: SESSION_HANDLE } : {}) } }),
      ...(requestId === "r-session" ? { sessionRecord: session } : {}) };
    const target = path.join(fixture.brokerRoot, ".video-factory", directory);
    await writeFile(path.join(target, `${hash(requestId)}.json`), JSON.stringify(value));
    await writeFile(path.join(target, ".store-id"), storeId);
  }
  await writeFile(path.join(fixture.brokerRoot, ".video-factory/codex-sessions/deepseek", `${hash(SESSION_HANDLE)}.json`), JSON.stringify(session));
  const nodeRoot = path.join(fixture.appRoot, "runs/run-001/nodes/voiceover");
  await mkdir(path.join(nodeRoot, ".voice-operations"), { recursive: true });
  const audio = "ledger-only-paid-audio";
  await writeFile(path.join(nodeRoot, "paid.mp3"), audio);
  const itemRequestId = "voice-group-fixture", synthesisKey = hash("speech-content");
  const response = JSON.stringify({ request: { itemRequestId, synthesisKey }, audio_sha256: hash(audio), audio_size_bytes: Buffer.byteLength(audio) });
  await writeFile(path.join(nodeRoot, "paid.response.json"), response);
  const operationId = "voice-fixture";
  await writeFile(path.join(nodeRoot, ".voice-operations", `${hash(operationId)}.json`), JSON.stringify({
    version: "video-factory/voice-operation-v3", operationId, completed: true, items: [{ itemRequestId, synthesisKey,
      providerId: "minimax-tts-v1", modelId: "speech-02-hd", state: "materialized",
      localPath: "/data/factory/runs/run-001/nodes/voiceover/paid.mp3", sha256: hash(audio), sizeBytes: Buffer.byteLength(audio),
      metadataPath: "/data/factory/runs/run-001/nodes/voiceover/paid.response.json", metadataSha256: hash(response),
      responseItemRequestId: itemRequestId }],
  }));

  const { durableTaskBinding } = await import("../src/task-binding.js");
  const brokerBinding = { version: "video-factory/task-binding-v1", storeId: DEFAULT_STORE, providerId: "deepseek", modelId: "fixture-model" };
  const envelope = { requestId: "r2", kind: "series-roadmap", payload: { series: { title: "fixture" } }, brokerBinding };
  const binding = durableTaskBinding({ request: envelope, storeId: DEFAULT_STORE, providerId: "deepseek", modelId: "fixture-model", kind: "series-roadmap" });
  const durableFile = path.join(fixture.brokerRoot, ".video-factory/codex-idempotency/deepseek", `${hash("r2")}.json`);
  const durable = JSON.parse(await readFile(durableFile, "utf8")); durable.binding = binding;
  await writeFile(durableFile, JSON.stringify(durable));
  await writeFile(path.join(fixture.appRoot, "runs/run-001/nodes/voiceover/model-operation.json"), JSON.stringify({
    version: "video-factory/codex-prepared-operation-v1", requestId: "r2", kind: "series-roadmap", envelope,
    serializedEnvelope: JSON.stringify(envelope), binding, brokerBinding,
    route: { socketPath: "/run/video-factory-deepseek/worker.sock" }, taskFact: "accepted_unknown",
  }));
  await writeFile(fixture.brokerEnv, "DEEPSEEK_API_KEY=FAKE-KEY-do-not-log\n", "utf8");
  await chmod(fixture.brokerEnv, 0o600);

  return { finalVideoSha };
}

function readManifest(fixture: BackupFixture): Promise<{ files: Array<{ path: string; sha256: string; mode: string }>; sqlite: Array<{ logical: string; integrity: string }>; formatVersion: string }> {
  return readFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.json"), "utf8").then(JSON.parse);
}

describe("production offline backup (R2)", () => {
  const reviewedCorruptions: Array<[string, (fixture: BackupFixture) => Promise<unknown>]> = [
    ["creator settings JSON violates the actual reader contract", (fixture) => writeFile(path.join(fixture.appRoot,
      "settings/creator-settings.json"), JSON.stringify({ language: "zh" }))],
    ["opportunities JSON violates the actual reader contract", (fixture) => writeFile(path.join(fixture.appRoot,
      "opportunities/opportunities.json"), "[]")],
    ["missing global holders", (fixture) => rm(path.join(fixture.maintenanceDir, "holders.json"))],
    ["nonempty global holders", (fixture) => writeFile(path.join(fixture.maintenanceDir, "holders.json"), JSON.stringify({
      protocol: "video-factory/maintenance-admission-v2", holders: [{ id: "still-owned" }],
    }))],
    ["gate without generation", (fixture) => writeFile(path.join(fixture.maintenanceDir, "gate.json"), JSON.stringify({
      state: "frozen", owner: "deploy-1", updatedAt: "2026-10-15T00:00:00Z",
    }))],
    ["broken required planning SQLite", async (fixture) => {
      await mkdir(path.join(fixture.appRoot, "planning"));
      await writeFile(path.join(fixture.appRoot, "planning/checkpoints.sqlite"), "broken sqlite header");
    }],
    ["broken nested planning checkpoint", async (fixture) => {
      await mkdir(path.join(fixture.appRoot, "checkpoints/topic-editor"), { recursive: true });
      await writeFile(path.join(fixture.appRoot, "checkpoints/topic-editor", `${"b".repeat(64)}.json`), "{broken");
    }],
    ["registered task invalid JSON", (fixture) => writeFile(path.join(fixture.brokerRoot,
      ".video-factory/models/m-abcdef123456/tasks", `${"a".repeat(64)}.json`), "{broken")],
    ["disabled model session invalid JSON", async (fixture) => {
      const directory = path.join(fixture.brokerRoot, ".video-factory/models/m-123456abcdef/sessions");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${"b".repeat(64)}.json`), "{broken");
    }],
    ["application original request is missing from its broker store", (fixture) => rm(path.join(fixture.brokerRoot,
      ".video-factory/codex-idempotency/deepseek", `${hash("r2")}.json`))],
    ["application and broker request digest disagree", async (fixture) => {
      const file = path.join(fixture.brokerRoot, ".video-factory/codex-idempotency/deepseek", `${hash("r2")}.json`);
      const value = JSON.parse(await readFile(file, "utf8")); value.binding.requestDigest = hash("different-envelope");
      await writeFile(file, JSON.stringify(value));
    }],
    ["registered request binding belongs to another store", async (fixture) => {
      const file = path.join(fixture.brokerRoot, ".video-factory/models/m-abcdef123456/tasks", `${hash("r1")}.json`);
      const value = JSON.parse(await readFile(file, "utf8")); value.binding.storeId = DEFAULT_STORE;
      await writeFile(file, JSON.stringify(value));
    }],
    ["request filename does not match original request", async (fixture) => {
      const file = path.join(fixture.brokerRoot, ".video-factory/codex-idempotency/deepseek", `${hash("r2")}.json`);
      const value = JSON.parse(await readFile(file, "utf8")); value.requestId = "different-request";
      await writeFile(file, JSON.stringify(value));
    }],
    ["session index refers to a different thread", async (fixture) => {
      const file = path.join(fixture.brokerRoot, ".video-factory/codex-sessions/deepseek", `${hash(SESSION_HANDLE)}.json`);
      const value = JSON.parse(await readFile(file, "utf8")); value.threadId = "00000000-1234-4123-8123-123456789abc";
      await writeFile(file, JSON.stringify(value));
    }],
    ["session digest belongs to another key", async (fixture) => {
      const file = path.join(fixture.brokerRoot, ".video-factory/codex-idempotency/deepseek", `${hash("r-session")}.json`);
      const value = JSON.parse(await readFile(file, "utf8")); value.binding.sessionDigest = hash('{"handle":null,"key":"other"}');
      await writeFile(file, JSON.stringify(value));
    }],
    ["voice response binds another original request despite matching media hashes", async (fixture) => {
      const directory = path.join(fixture.appRoot, "runs/run-001/nodes/voiceover");
      const response = JSON.parse(await readFile(path.join(directory, "paid.response.json"), "utf8"));
      response.request.itemRequestId = "some-other-paid-request";
      await writeFile(path.join(directory, "paid.response.json"), JSON.stringify(response));
      const file = path.join(directory, ".voice-operations", `${hash("voice-fixture")}.json`);
      const ledger = JSON.parse(await readFile(file, "utf8")); ledger.items[0].metadataSha256 = hash(JSON.stringify(response));
      await writeFile(file, JSON.stringify(ledger));
    }],
    ["voice ledger media hash drift", (fixture) => writeFile(path.join(fixture.appRoot, "runs/run-001/nodes/voiceover/paid.mp3"), "changed-audio")],
    ["ledger-only paid media missing", async (fixture) => {
      const directory = path.join(fixture.appRoot, "runs/run-001/nodes/voiceover/.voice-operations");
      await mkdir(directory, { recursive: true });
      const operationId = "voice-ledger-only";
      await writeFile(path.join(directory, `${createHash("sha256").update(operationId).digest("hex")}.json`), JSON.stringify({
        version: "video-factory/paid-operation-v2", operationId, completed: true,
        items: [{ itemRequestId: "paid-item-1", providerId: "minimax-tts-v1", modelId: "speech-02-hd",
          state: "materialized", localPath: "/data/factory/runs/run-001/nodes/voiceover/missing.mp3",
          sha256: "a".repeat(64), sizeBytes: 12 }],
      }));
    }],
  ];
  for (const [name, corrupt] of reviewedCorruptions) {
    it(`fails closed for reviewed corruption: ${name}`, async () => {
      const fixture = await buildFixture();
      try {
        await populateBusinessData(fixture);
        await corrupt(fixture);
        const result = await fixture.runBackup();
        assert.equal(result.code, 1, `unsafe full backup for ${name}: ${result.stdout}`);
        assert.deepEqual(await readdir(fixture.backupDir), [], "failed validation must not publish or leave staging");
      } finally { await fixture.dispose(); }
    });
  }

  it("records source release identity independently of the candidate release", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const result = await fixture.runBackup({ RELEASE_SHA: "b".repeat(40), TEST_INSPECT_STOPPED: JSON.stringify([{
        State: { Running: false, Status: "exited", Pid: 0, Restarting: false, Dead: false },
        Image: "sha256:source-image", Config: { User: "1001:1001", Env: [`VIDEO_FACTORY_RELEASE_SHA=${"a".repeat(40)}`] }, Mounts: [],
      }]) });
      assert.equal(result.code, 0, result.stderr);
      const manifest = JSON.parse(await readFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.json"), "utf8"));
      assert.equal(manifest.source.releaseSha, "a".repeat(40));
    } finally { await fixture.dispose(); }
  });

  it("archives directory identity and excludes only transient execution ownership", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const tasks = path.join(fixture.brokerRoot, ".video-factory/codex-idempotency/deepseek");
      await chmod(tasks, 0o750);
      await writeFile(path.join(tasks, ".owner.lock"), JSON.stringify({ pid: 1, token: "old-runtime-owner" }));
      await writeFile(path.join(fixture.appRoot, "runs/run-001/.execution-lease.json"), JSON.stringify({ pid: 1 }));
      const result = await fixture.runBackup();
      assert.equal(result.code, 0, result.stderr);
      const manifest = JSON.parse(await readFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.json"), "utf8"));
      const archived = manifest.files.find((entry: { path: string }) => entry.path === "broker-workspace/.video-factory/codex-idempotency/deepseek");
      const source = await stat(tasks);
      assert.deepEqual(archived && { type: archived.type, uid: archived.uid, gid: archived.gid, mode: archived.mode },
        { type: "directory", uid: source.uid, gid: source.gid, mode: "0750" });
      assert.equal(manifest.files.some((entry: { path: string }) => entry.path.endsWith("/.owner.lock") || entry.path.endsWith("/.execution-lease.json")), false);
    } finally { await fixture.dispose(); }
  });

  it("archives all works media, broker state and WAL-committed SQLite into a verified full backup", async () => {
    const fixture = await buildFixture();
    try {
      const { finalVideoSha } = await populateBusinessData(fixture);
      const database = path.join(fixture.appRoot, "data", "planning.sqlite");
      await writeFile(database, "", "utf8");
      fixture.walHolder = await startWalHolder(database);
      await fixture.writeGate("frozen", "deploy-1");

      const result = await fixture.runBackup();
      assert.equal(result.stderr, "");
      assert.equal(result.code, 0, result.stderr);

      const manifest = await readManifest(fixture);
      assert.equal(manifest.formatVersion, "video-factory/full-backup-v1");
      const paths = manifest.files.map((entry) => entry.path);
      for (const required of [
        "app-workspace/runs/run-001/input/original.mov",
        "app-workspace/runs/run-001/input/paid-image.png",
        "app-workspace/runs/run-001/input/paid-audio.mp3",
        "app-workspace/runs/run-001/input/narration.m4a",
        "app-workspace/runs/run-001/output/final.mp4",
        "app-workspace/runs/run-001/run.json",
        `app-workspace/checkpoints/series-showrunner/${CHECKPOINT_KEY}.json`,
        "app-workspace/settings/creator-settings.json",
        `broker-workspace/.video-factory/models/m-abcdef123456/tasks/${hash("r1")}.json`,
        `broker-workspace/.video-factory/models/m-123456abcdef/tasks/${hash("r-disabled")}.json`,
        `broker-workspace/.video-factory/codex-idempotency/deepseek/${hash("r2")}.json`,
        `broker-workspace/.video-factory/codex-sessions/deepseek/${hash(SESSION_HANDLE)}.json`,
        "broker-config/deepseek-codex-broker.env",
      ]) {
        assert.ok(paths.includes(required), `manifest 缺少 ${required}`);
      }
      assert.equal(paths.some((entry) => entry.includes("cache/")), false, "可再生缓存不得进入归档");
      assert.equal(paths.some((entry) => entry.endsWith("-wal") || entry.endsWith("-shm")), false, "归档不得混入旧 WAL/SHM");
      const finalVideo = manifest.files.find((entry) => entry.path === "app-workspace/runs/run-001/output/final.mp4");
      assert.equal(finalVideo?.sha256, finalVideoSha);
      const envEntry = manifest.files.find((entry) => entry.path === "broker-config/deepseek-codex-broker.env");
      assert.equal(envEntry?.mode, "0600", "受限配置必须按 0600 权限保全");

      assert.equal(manifest.sqlite.length, 1);
      assert.equal(manifest.sqlite[0]?.logical, "app-workspace/data/planning.sqlite");
      assert.equal(manifest.sqlite[0]?.integrity, "ok");

      const archive = path.join(fixture.backupDir, "video-factory-full-test-backup-0001.tar.gz");
      const extractDir = path.join(fixture.root, "restore-check");
      await mkdir(extractDir, { recursive: true });
      await execFileAsync("tar", ["-xzf", archive, "-C", extractDir]);
      const { stdout } = await execFileAsync("python3", ["-c", `
import sqlite3, sys
p = sys.argv[1]
print("PATH-REPR:", repr(p))
uri = "file:" + p + "?mode=ro"
print("URI-REPR:", repr(uri))
conn = sqlite3.connect(uri, uri=True)
rows = conn.execute("SELECT title FROM topics").fetchall()
print(rows)
`, path.join(extractDir, "app-workspace", "data", "planning.sqlite")]);
      // 独立快照合并了 WAL 内最新已提交内容：恢复副本没有 -wal 也必须读到该行。
      assert.ok(stdout.includes("committed-in-wal"), `快照未包含 WAL 已提交内容: ${stdout}`);
      const restoredStoreId = await readFile(
        path.join(extractDir, "broker-workspace", ".video-factory", "codex-idempotency", "deepseek", ".store-id"),
        "utf8",
      );
      assert.equal(restoredStoreId, DEFAULT_STORE, "store-id 不得在恢复中重建");

      const trace = await readFile(fixture.tracePath, "utf8");
      const verifyRuns = trace.match(/docker:run [^\n]*/g) ?? [];
      assert.equal(verifyRuns.length, 4, "源与恢复副本各以 app/broker 身份验证一次");
      assert.equal(verifyRuns.every((line) => line.includes(`--user ${process.getuid!()}:${process.getgid!()}`)), true);
      assert.equal(verifyRuns.some((line) => line.includes(".env:ro")), false, "业务身份不读取 root 受限配置");
      for (const line of verifyRuns) {
        assert.match(line, /--network none/);
        assert.match(line, /--read-only/);
        assert.match(line, /:ro\b/);
      }
      assert.match(trace, /backup-files-at-verify:0/, "full 成功标识必须在隔离恢复验证之后才发布");
      // 输出与 manifest 都不得携带密钥内容。
      assert.doesNotMatch(result.stdout + result.stderr, /FAKE-KEY/);
      assert.doesNotMatch(JSON.stringify(manifest), /FAKE-KEY/);
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves the app root from the running container mount when no override is given", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const stoppedWithMount = JSON.stringify([{
        State: STOPPED_STATE,
        Image: "sha256:test-image",
        Mounts: [{ Destination: "/data/factory", Source: fixture.appRoot }],
      }]);
      const result = await fixture.runBackup({
        VIDEO_FACTORY_APP_WORKSPACE_ROOT: "",
        TEST_INSPECT_STOPPED: stoppedWithMount,
        VIDEO_FACTORY_BACKUP_ID: "test-backup-0002",
      });
      assert.equal(result.code, 0, result.stderr);
      await stat(path.join(fixture.backupDir, "video-factory-full-test-backup-0002.tar.gz"));
    } finally {
      await fixture.dispose();
    }
  });

  it("cleans expired backups only after the new full backup is verified", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const aged = new Date(Date.now() - 30 * 86400 * 1000);
      await writeFile(path.join(fixture.backupDir, "video-factory-metadata-20260101T000000Z.tar.gz"), "old metadata", "utf8");
      await utimes(path.join(fixture.backupDir, "video-factory-metadata-20260101T000000Z.tar.gz"), aged, aged);
      await writeFile(path.join(fixture.backupDir, "video-factory-full-old.tar.gz"), "old full", "utf8");
      await writeFile(path.join(fixture.backupDir, "video-factory-full-old.json"), "{}", "utf8");
      await utimes(path.join(fixture.backupDir, "video-factory-full-old.tar.gz"), aged, aged);
      await utimes(path.join(fixture.backupDir, "video-factory-full-old.json"), aged, aged);

      const result = await fixture.runBackup();
      assert.equal(result.code, 0, result.stderr);
      const remaining = (await readdir(fixture.backupDir)).sort();
      assert.deepEqual(remaining, ["video-factory-full-test-backup-0001.json", "video-factory-full-test-backup-0001.tar.gz"]);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps optional settings absent and leaves valid settings bytes unchanged during verification", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const settings = path.join(fixture.appRoot, "settings/creator-settings.json");
      const opportunities = path.join(fixture.appRoot, "opportunities/opportunities.json");
      const settingsBytes = await readFile(settings), opportunitiesBytes = await readFile(opportunities);
      assert.equal((await fixture.runBackup()).code, 0);
      assert.deepEqual(await readFile(settings), settingsBytes);
      assert.deepEqual(await readFile(opportunities), opportunitiesBytes);
      await rm(settings); await rm(opportunities);
      const result = await fixture.runBackup({ VIDEO_FACTORY_BACKUP_ID: "optional-absent" });
      assert.equal(result.code, 0, result.stderr);
      await assert.rejects(readFile(settings), { code: "ENOENT" });
      await assert.rejects(readFile(opportunities), { code: "ENOENT" });
    } finally { await fixture.dispose(); }
  });

  it("supports an explicit cold source when systemd has no installed broker units", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const result = await fixture.runBackup({ TEST_NO_INSTALLED_BROKER: "1" });
      assert.equal(result.code, 0, result.stderr);
      assert.ok((await readManifest(fixture)).files.length > 0);
    } finally { await fixture.dispose(); }
  });

  for (const state of ["deactivating", "activating", "unknown", ""]) {
    it(`rejects unproved broker exit state ${JSON.stringify(state)}`, async () => {
      const fixture = await buildFixture();
      try {
        await populateBusinessData(fixture);
        const result = await fixture.runBackup({ TEST_BROKER_STATE: state });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /写者未退出|状态未知/);
        assert.deepEqual(await readdir(fixture.backupDir), []);
      } finally { await fixture.dispose(); }
    });
  }

  for (const overrides of [{ TEST_BROKER_PID: "42" }, { TEST_SYSTEMCTL_FAILURE: "1" },
    { TEST_FINAL_GATE_GENERATION: "3" }, { TEST_FINAL_GATE_OWNER: "other-owner" }]) {
    it(`keeps old full backup and source intact on ${Object.keys(overrides)[0]}`, async () => {
      const fixture = await buildFixture();
      try {
        await populateBusinessData(fixture);
        const runFile = path.join(fixture.appRoot, "runs/run-001/run.json");
        const before = await sha256Of(runFile);
        await writeFile(path.join(fixture.backupDir, "video-factory-full-prior.tar.gz"), "known-good-archive");
        await writeFile(path.join(fixture.backupDir, "video-factory-full-prior.json"), "known-good-manifest");
        const result = await fixture.runBackup(overrides);
        assert.equal(result.code, 1, result.stdout);
        assert.equal(await sha256Of(runFile), before);
        assert.deepEqual((await readdir(fixture.backupDir)).sort(), ["video-factory-full-prior.json", "video-factory-full-prior.tar.gz"]);
        assert.equal(await readFile(path.join(fixture.backupDir, "video-factory-full-prior.tar.gz"), "utf8"), "known-good-archive");
      } finally { await fixture.dispose(); }
    });
  }

  it("resolves configured root B instead of an existing default A, including retired and extra brokers", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const rootB = path.join(fixture.root, "actual-broker-B");
      await cp(fixture.brokerRoot, rootB, { recursive: true });
      await writeFile(path.join(rootB, "actual-root-marker"), "B-only-business");
      const extras: Record<string, Record<string, string>> = {};
      for (const unit of ["vf-codex-broker.service", "vf-zai-codex-broker.service", "custom-broker.service"]) {
        const broker = path.join(fixture.root, unit);
        await cp(fixture.brokerRoot, broker, { recursive: true });
        for (const subdirectory of ["models/m-abcdef123456/tasks", "models/m-123456abcdef/tasks", "codex-idempotency/deepseek"]) {
          const tasks = path.join(broker, ".video-factory", subdirectory);
          const storeId = `vfs_store_${hash(`${unit}/${subdirectory}`).slice(0, 32)}`;
          await writeFile(path.join(tasks, ".store-id"), storeId);
          for (const filename of (await readdir(tasks)).filter((name) => name.endsWith(".json"))) {
            const file = path.join(tasks, filename), value = JSON.parse(await readFile(file, "utf8"));
            value.binding.storeId = storeId; await writeFile(file, JSON.stringify(value));
          }
        }
        const config = path.join(fixture.root, `${unit}.env`);
        await writeFile(config, "API_KEY=FAKE-KEY-extra\n");
        extras[unit] = { Environment: `VIDEO_FACTORY_CODEX_PROFILE=deepseek VIDEO_FACTORY_CODEX_WORKSPACE_ROOT=${broker}`,
          EnvironmentFiles: `${config} (ignore_errors=no)` };
      }
      const result = await fixture.runBackup({ VIDEO_FACTORY_BACKUP_SOURCE_DESCRIPTOR: "", VIDEO_FACTORY_BROKER_WORKSPACE_ROOT: "",
        TEST_BROKER_ROOT: rootB, TEST_EXTRA_UNITS: JSON.stringify(extras) });
      assert.equal(result.code, 0, result.stderr);
      const manifest = JSON.parse(await readFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.json"), "utf8"));
      const brokers = manifest.roles.filter((role: { role: string }) => role.role === "broker-workspace");
      assert.equal(brokers.length, 4);
      assert.equal(brokers.some((role: { source: string }) => role.source === fixture.brokerRoot), false);
      assert.equal(brokers.some((role: { source: string }) => role.source === rootB), true);
      assert.equal(manifest.files.some((entry: { path: string }) => entry.path === "broker-workspace/actual-root-marker"), true);
    } finally { await fixture.dispose(); }
  });

  it("preserves SQLite source identity and reads real planning checkpoints committed in WAL", async () => {
    const fixture = await buildFixture();
    let holder: ReturnType<typeof spawn> | undefined;
    try {
      await populateBusinessData(fixture);
      const database = path.join(fixture.appRoot, "planning/checkpoints.sqlite");
      await mkdir(path.dirname(database));
      holder = spawn(process.execPath, ["--input-type=module", "--eval", `
        import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
        const saver = SqliteSaver.fromConnString(process.argv[1]);
        saver.setup(); saver.db.pragma('wal_autocheckpoint=0'); saver.db.pragma('wal_checkpoint(TRUNCATE)');
        const checkpoint = { v: 4, id: '12345678-1234-4123-8123-123456789abc', ts: '2026-10-15T00:00:00Z',
          channel_values: { runId: 'run-001', approved: true, pending: 'audit' }, channel_versions: {}, versions_seen: {} };
        await saver.put({ configurable: { thread_id: 'creative-planning:run-001:fixture' } }, checkpoint,
          { source: 'loop', step: 2, parents: {} });
        process.stdout.write('ready\\n'); setInterval(() => {}, 1000);
      `, database], { cwd: repositoryRoot, env: { PATH: path.dirname(process.execPath) }, stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("planning WAL holder timeout")), 10_000);
        holder!.stdout!.on("data", (chunk) => { if (chunk.toString().includes("ready")) { clearTimeout(timer); resolve(); } });
        holder!.on("exit", () => reject(new Error("planning WAL holder exited")));
      });
      await chmod(database, 0o640);
      const original = await sha256Of(database), walOriginal = await sha256Of(database + "-wal");
      const result = await fixture.runBackup();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await sha256Of(database), original);
      assert.equal(await sha256Of(database + "-wal"), walOriginal);
      const manifest = JSON.parse(await readFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.json"), "utf8"));
      const dbEntry = manifest.files.find((entry: { path: string }) => entry.path === "app-workspace/planning/checkpoints.sqlite");
      const info = await stat(database);
      assert.deepEqual({ mode: dbEntry.mode, uid: dbEntry.uid, gid: dbEntry.gid }, { mode: "0640", uid: info.uid, gid: info.gid });
      assert.ok(manifest.sqlite[0].walBytes > 0);
      assert.ok(manifest.sqlite[0].shmBytes > 0);
      const restore = path.join(fixture.root, "planning-restore");
      await mkdir(restore);
      await execFileAsync("tar", ["-xzf", path.join(fixture.backupDir, "video-factory-full-test-backup-0001.tar.gz"), "-C", restore]);
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
        import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
        const saver = SqliteSaver.fromConnString(process.argv[1]);
        const value = await saver.getTuple({ configurable: { thread_id: 'creative-planning:run-001:fixture' } });
        console.log(JSON.stringify(value.checkpoint.channel_values)); saver.db.close();
      `, path.join(restore, "app-workspace/planning/checkpoints.sqlite")], { cwd: repositoryRoot });
      assert.deepEqual(JSON.parse(stdout), { runId: "run-001", approved: true, pending: "audit" });
    } finally { holder?.kill("SIGKILL"); await fixture.dispose(); }
  });

  const failureScenarios: Array<{ name: string; overrides: Record<string, string>; expected: RegExp; gate?: "draining" }> = [
    { name: "gate missing", overrides: { VIDEO_FACTORY_MAINTENANCE_DIR: "__MISSING__" }, expected: /门禁不存在|不可读/ },
    { name: "gate not frozen", overrides: {}, expected: /不是 frozen/, gate: "draining" },
    { name: "owner mismatch", overrides: { VIDEO_FACTORY_MAINTENANCE_OWNER: "someone-else" }, expected: /owner 不一致/ },
    { name: "container running", overrides: { TEST_DOCKER_INSPECT: "running" }, expected: /写者未退出/ },
    { name: "broker active", overrides: { TEST_BROKER_ACTIVE: "1" }, expected: /写者未退出/ },
    { name: "no container", overrides: { TEST_DOCKER_INSPECT: "missing" }, expected: /没有可备份的现有部署/ },
    { name: "app root missing", overrides: { VIDEO_FACTORY_APP_WORKSPACE_ROOT: "/nonexistent/vf-backup-root" }, expected: /app 工作根不存在/ },
    { name: "broker root missing", overrides: { VIDEO_FACTORY_BROKER_WORKSPACE_ROOT: "/nonexistent/vf-broker-root" }, expected: /broker 工作根不存在/ },
    { name: "broker env missing", overrides: { VIDEO_FACTORY_BROKER_ENV_FILE: "/nonexistent/vf.env" }, expected: /受限模型配置缺失/ },
  ];
  for (const scenario of failureScenarios) {
    it(`refuses to report a consistent backup when ${scenario.name}`, async () => {
      const fixture = await buildFixture();
      try {
        await populateBusinessData(fixture);
        if (scenario.gate === "draining") {
          await fixture.writeGate("draining", "deploy-1");
        }
        const overrides = { ...scenario.overrides };
        if (overrides.VIDEO_FACTORY_MAINTENANCE_DIR === "__MISSING__") {
          overrides.VIDEO_FACTORY_MAINTENANCE_DIR = path.join(fixture.root, "no-such-maintenance");
        }
        const result = await fixture.runBackup(overrides);
        assert.equal(result.code, 1);
        assert.match(result.stderr, scenario.expected);
        const remaining = await readdir(fixture.backupDir);
        assert.deepEqual(remaining, [], "失败不得留下 partial 或工作目录");
      } finally {
        await fixture.dispose();
      }
    });
  }

  it("fails the space precheck before writing anything when capacity cannot cover archive plus restore", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      const sparse = path.join(fixture.appRoot, "runs", "run-001", "output", "huge-frames.mp4");
      const handle = await import("node:fs/promises").then((fs) => fs.open(sparse, "w"));
      await handle.close();
      await truncate(sparse, 128 * 1024 * 1024 * 1024);
      const result = await fixture.runBackup();
      assert.equal(result.code, 1);
      assert.match(result.stderr, /空间预检不足/);
      assert.deepEqual(await readdir(fixture.backupDir), []);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses to overwrite an existing archive or a polluted sidecar name", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      await writeFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0001.tar.gz"), "existing", "utf8");
      const first = await fixture.runBackup();
      assert.equal(first.code, 1);
      assert.match(first.stderr, /拒绝覆盖/);

      await writeFile(path.join(fixture.backupDir, "video-factory-full-test-backup-0002.json"), "{}", "utf8");
      const second = await fixture.runBackup({ VIDEO_FACTORY_BACKUP_ID: "test-backup-0002" });
      assert.equal(second.code, 1);
      assert.match(second.stderr, /旧 sidecar 已存在/);
      assert.deepEqual((await readdir(fixture.backupDir)).sort(), ["video-factory-full-test-backup-0001.tar.gz", "video-factory-full-test-backup-0002.json"]);
    } finally {
      await fixture.dispose();
    }
  });

  it("keeps a previously verified backup intact when a later run fails", async () => {
    const fixture = await buildFixture();
    try {
      await populateBusinessData(fixture);
      assert.equal((await fixture.runBackup()).code, 0);
      await fixture.writeGate("draining", "deploy-1");
      const failed = await fixture.runBackup({ VIDEO_FACTORY_BACKUP_ID: "test-backup-0002" });
      assert.equal(failed.code, 1);
      const remaining = (await readdir(fixture.backupDir)).sort();
      assert.deepEqual(remaining, ["video-factory-full-test-backup-0001.json", "video-factory-full-test-backup-0001.tar.gz"]);
    } finally {
      await fixture.dispose();
    }
  });

  for (const failure of ["archive", "manifest-link"]) {
    it(`cleans an injected ENOSPC during ${failure} without publishing or deleting an old full`, async () => {
      const fixture = await buildFixture();
      try {
        await populateBusinessData(fixture);
        await writeFile(path.join(fixture.backupDir, "video-factory-full-prior.tar.gz"), "prior-full-bytes");
        await writeFile(path.join(fixture.backupDir, "video-factory-full-prior.json"), "prior-full-manifest");
        const driver = path.join(fixture.root, "inject-enospc.py");
        await writeFile(driver, `import errno, importlib.util, sys
spec = importlib.util.spec_from_file_location('backup', ${JSON.stringify(path.join(repositoryRoot, "scripts/production-backup.py"))})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
if ${JSON.stringify(failure)} == 'archive':
    original = module.add_file
    count = 0
    def fail_after_write(*args, **kwargs):
        global count
        original(*args, **kwargs); count += 1
        if count == 5: raise OSError(errno.ENOSPC, 'synthetic full disk')
    module.add_file = fail_after_write
else:
    original = module.os.link
    def fail_manifest(source, target):
        if str(target).endswith('.json'): raise OSError(errno.ENOSPC, 'synthetic full disk')
        original(source, target)
    module.os.link = fail_manifest
sys.exit(module.main())
`);
        const result = await fixture.runBackup({}, driver);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /OSError \(28\)/);
        assert.deepEqual((await readdir(fixture.backupDir)).sort(), ["video-factory-full-prior.json", "video-factory-full-prior.tar.gz"]);
        assert.equal(await readFile(path.join(fixture.backupDir, "video-factory-full-prior.tar.gz"), "utf8"), "prior-full-bytes");
      } finally { await fixture.dispose(); }
    });
  }

  it("compares broker record/session counts and rejects unreadable roots", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vf-backup-invariants-"));
    try {
      const { stdout } = await execFileAsync(PYTHON, ["-I", "-B", "-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('backup', ${JSON.stringify(path.join(repositoryRoot, "scripts/production-backup.py"))})
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for field in ('brokerRecords', 'brokerSessions'):
    try: module.reports_match({field: 1}, {field: 0}); raise AssertionError(field)
    except module.BackupError: pass
root = pathlib.Path(sys.argv[1]) / 'unreadable'; root.mkdir(); root.chmod(0)
try:
    try: module.discover_files(root); raise AssertionError('unreadable root accepted')
    except PermissionError: pass
finally: root.chmod(0o700)
print('OK')
`, directory]);
      assert.equal(stdout.trim(), "OK");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("detects archive truncation, hash drift and non-empty restore targets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "video-factory-backup-units-"));
    try {
      const { stdout } = await execFileAsync("python3", ["-c", `
import importlib.util, io, json, pathlib, sys, tarfile
spec = importlib.util.spec_from_file_location("production_backup", ${JSON.stringify(path.join(repositoryRoot, "scripts", "production-backup.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

work = pathlib.Path(sys.argv[1])
target = work / "sample.bin"
target.write_bytes(b"payload-bytes")
files = []
with tarfile.open(work / "sample.tar.gz", "w:gz") as tar:
    module.add_file(tar, target, "payload/sample.bin", files)
    payload = json.dumps({"files": files}).encode("utf-8")
    info = tarfile.TarInfo("manifest.json")
    info.size = len(payload)
    tar.addfile(info, io.BytesIO(payload))

module.verify_archive(work / "sample.tar.gz", files)

corrupt = work / "corrupt.tar.gz"
corrupt.write_bytes((work / "sample.tar.gz").read_bytes()[:-64])
try:
    module.verify_archive(corrupt, files)
    print("FAIL:no-truncation-detection")
except module.BackupError:
    pass

drift = [{**files[0], "sha256": "0" * 64}]
try:
    module.verify_archive(work / "sample.tar.gz", drift)
    print("FAIL:no-hash-detection")
except module.BackupError:
    pass

occupied = work / "occupied"
occupied.mkdir()
(occupied / "stale.txt").write_text("x")
try:
    module.unpack_isolated(work / "sample.tar.gz", occupied)
    print("FAIL:no-target-check")
except module.BackupError:
    pass
empty = work / "empty-existing"
empty.mkdir()
try:
    module.unpack_isolated(work / "sample.tar.gz", empty)
    print("FAIL:existing-empty-target-accepted")
except module.BackupError:
    pass
print("OK")
`, directory]);
      assert.equal(stdout.trim(), "OK", stdout);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
