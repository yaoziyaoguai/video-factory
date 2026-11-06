import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const RESULT_PREFIX = "FRAME_S3_NATIVE_RESULT ";
const NPM_PACKAGE = "frame-s3-native-skill";
const DEPENDENCY = "frame-s3-native-dependency";
const GIT_SOURCE = "https://native-skill.invalid/fixture/pi-package.git";
const lifecycleEvents = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preuninstall", "uninstall", "postuninstall"];

interface CommandRecord { command: string; args: string[]; cwd: string }
interface WorkerConfig { directory: string; agentDir: string; gitPackageDir: string; gitCommit: string }

// 生命周期哨兵只写临时文件；父测试先直接执行一次，证明缺文件不是哨兵失效。
const sentinelScript = `const fs = require("node:fs");
fs.appendFileSync(process.env.FRAME_S3_SENTINEL, JSON.stringify({event: process.env.npm_lifecycle_event}) + "\\n");
`;

async function writePackage(directory: string, name: string, dependency: boolean) {
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, "skills", "native-fixture"), { recursive: true });
  const manifest = {
    name, version: "1.0.0",
    scripts: Object.fromEntries(lifecycleEvents.map(event => [event, "node scripts/sentinel.cjs"])),
    ...(dependency ? { dependencies: { [DEPENDENCY]: "1.0.0" } } : {}),
    pi: { skills: ["skills"], extensions: [], prompts: [], themes: [] },
  };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "scripts", "sentinel.cjs"), sentinelScript);
  await writeFile(path.join(directory, ".npmrc"), "ignore-scripts=false\n");
  await writeFile(path.join(directory, "skills", "native-fixture", "SKILL.md"),
    "---\nname: native-fixture\ndescription: Native package lifecycle fixture.\n---\nFixture only.\n");
  return manifest;
}

async function nativeWorker(config: WorkerConfig) {
  const { directory, agentDir } = config;
  const sentinel = path.join(directory, "lifecycle.jsonl");
  const commandLog = path.join(directory, "commands.jsonl");
  const settings = SettingsManager.create(agentDir, agentDir);
  settings.setNpmCommand(["npm", "--ignore-scripts"]);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings });

  // 安装根和 Git 包内的 .npmrc 均尝试打开脚本；命令行固定参数必须优先。
  await mkdir(path.join(agentDir, "npm"), { recursive: true });
  await writeFile(path.join(agentDir, ".npmrc"), "ignore-scripts=false\n");
  await writeFile(path.join(agentDir, "npm", ".npmrc"), "ignore-scripts=false\n");
  const npmSource = `npm:${NPM_PACKAGE}@1.0.0`;
  await manager.installAndPersist(npmSource);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  const installedNpm = manager.getInstalledPath(npmSource, "user");
  assert.equal(installedNpm, path.join(agentDir, "npm", "node_modules", NPM_PACKAGE));
  assert.equal(JSON.parse(await readFile(path.join(installedNpm, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(path.join(agentDir, "npm", "node_modules", DEPENDENCY, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(await readFile(path.join(installedNpm, ".npmrc"), "utf8"), "ignore-scripts=false\n");
  assert.equal(existsSync(sentinel), false, "真实 npm 安装根包和依赖均不能执行 lifecycle");
  const persisted = SettingsManager.create(agentDir, agentDir);
  assert.deepEqual(persisted.getNpmCommand(), ["npm", "--ignore-scripts"]);
  assert.deepEqual(persisted.getGlobalSettings().packages, [npmSource]);

  assert.equal(await manager.removeAndPersist(npmSource), true);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  assert.equal(existsSync(installedNpm), false);
  assert.equal(existsSync(sentinel), false, "真实 npm 卸载不能执行 lifecycle");
  assert.deepEqual(manager.listConfiguredPackages(), []);

  await manager.installAndPersist(GIT_SOURCE);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  const installedGit = manager.getInstalledPath(GIT_SOURCE, "user");
  assert.equal(installedGit, path.join(agentDir, "git", "native-skill.invalid", "fixture", "pi-package"));
  assert.equal(execFileSync("git", ["-C", installedGit, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), config.gitCommit);
  assert.equal(await readFile(path.join(installedGit, ".npmrc"), "utf8"), "ignore-scripts=false\n");
  assert.equal(JSON.parse(await readFile(path.join(installedGit, "node_modules", DEPENDENCY, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(sentinel), false, "真实 Git clone 后的 npm 依赖安装不能执行根包或依赖 lifecycle");
  assert.equal(await manager.removeAndPersist(GIT_SOURCE), true);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  assert.equal(existsSync(installedGit), false);
  assert.equal(existsSync(sentinel), false, "Git 来源移除后无 lifecycle 哨兵");
  assert.equal(existsSync(path.join(config.gitPackageDir, "package.json")), true, "原生卸载保留 fixture 源仓库");
  assert.deepEqual(manager.listConfiguredPackages(), []);
  assert.deepEqual(SettingsManager.create(agentDir, agentDir).getGlobalSettings().packages, []);

  const commands = (await readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as CommandRecord);
  const npmCommands = commands.filter(call => call.command === "npm");
  assert.equal(npmCommands.length, 3, "npm 包安装/卸载、Git 依赖安装各调用一次真实 npm");
  assert.ok(npmCommands.every(call => call.args[0] === "--ignore-scripts"), JSON.stringify(npmCommands));
  assert.equal(npmCommands.some(call => call.args.includes("--ignore-scripts=false")), false);
  assert.deepEqual(npmCommands.map(call => call.args[1]), ["install", "uninstall", "install"]);
  assert.ok(npmCommands[0]!.args.includes(`${NPM_PACKAGE}@1.0.0`));
  assert.ok(npmCommands[1]!.args.includes(NPM_PACKAGE));
  assert.equal(npmCommands[2]!.cwd, installedGit);
  assert.ok(npmCommands[2]!.args.includes("--omit=dev"));
  assert.ok(commands.some(call => call.command === "git" && call.args[0] === "clone" && call.args[1] === GIT_SOURCE));
  process.stdout.write(RESULT_PREFIX + JSON.stringify({ npmCommands, gitClone: true, sentinelAbsent: true }) + "\n");
}

if (process.argv[2] === "--native-worker") {
  await nativeWorker(JSON.parse(process.argv[3]!) as WorkerConfig);
} else {
  test("S3 原生 npm 安装/卸载和真实 Git clone 依赖安装都固定忽略生命周期脚本", { timeout: 60_000 }, async t => {
    const directory = realpathSync(await mkdtemp(path.join(tmpdir(), "frame-s3-native-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const agentDir = path.join(directory, "agent");
    const gitPackageDir = path.join(directory, "git-source");
    const npmPackageDir = path.join(directory, "npm-source", "package");
    const dependencyDir = path.join(directory, "dependency-source", "package");
    const binDir = path.join(directory, "bin");
    const tempDir = path.join(directory, "tmp");
    for (const target of [agentDir, gitPackageDir, binDir, tempDir]) await mkdir(target, { recursive: true });
    await writeFile(path.join(directory, "npm-user.npmrc"), "");
    await writeFile(path.join(directory, "npm-global.npmrc"), "");
    await writeFile(path.join(directory, "gitconfig"), "");
    const realNpm = realpathSync(path.join(path.dirname(process.execPath), "npm"));
    const realGit = (process.env.PATH ?? "").split(path.delimiter)
      .map(entry => path.join(entry, "git")).find(candidate => existsSync(candidate));
    assert.ok(realGit, "需要本机 Git，fixture 不安装工具");
    const environment: NodeJS.ProcessEnv = {
      PATH: [binDir, path.dirname(process.execPath), path.dirname(realGit), "/usr/bin", "/bin"].join(path.delimiter),
      TMPDIR: tempDir, NO_PROXY: "*", no_proxy: "*",
      npm_config_cache: path.join(directory, "npm-cache"),
      npm_config_userconfig: path.join(directory, "npm-user.npmrc"),
      npm_config_globalconfig: path.join(directory, "npm-global.npmrc"),
      npm_config_prefix: path.join(directory, "npm-global-prefix"),
      npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
      npm_config_fetch_retries: "0", npm_config_progress: "false",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"), GIT_TERMINAL_PROMPT: "0",
      FRAME_S3_SENTINEL: path.join(directory, "lifecycle.jsonl"),
      FRAME_S3_COMMANDS: path.join(directory, "commands.jsonl"),
    };
    const npmManifest = await writePackage(npmPackageDir, NPM_PACKAGE, true);
    const dependencyManifest = await writePackage(dependencyDir, DEPENDENCY, false);
    await writePackage(gitPackageDir, "frame-s3-git-skill", true);

    // 透明命令哨兵只记录参数，然后执行真实 npm/Git；不替代安装结果。
    for (const [command, executable, initialArgs] of [
      ["npm", process.execPath, [realNpm]], ["git", realGit, []],
    ] as const) {
      await writeFile(path.join(binDir, command), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FRAME_S3_COMMANDS, JSON.stringify({command:${JSON.stringify(command)}, args, cwd:process.cwd()}) + "\\n");
const child = spawnSync(${JSON.stringify(executable)}, [...${JSON.stringify(initialArgs)}, ...args], {stdio:"inherit", env:process.env});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`, { mode: 0o755 });
    }
    await run(process.execPath, [path.join(npmPackageDir, "scripts", "sentinel.cjs")], {
      env: { ...environment, npm_lifecycle_event: "fixture-self-check" },
    });
    assert.deepEqual(JSON.parse((await readFile(environment.FRAME_S3_SENTINEL!, "utf8")).trim()), { event: "fixture-self-check" });
    await rm(environment.FRAME_S3_SENTINEL!);

    // 用 plumbing 建立临时 fixture 的 HEAD，不提交工作树产品代码，也不读取用户 Git 配置。
    const gitEnv = { ...environment, GIT_AUTHOR_NAME: "S3 Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "S3 Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = (...args: string[]) => execFileSync(realGit, ["-C", gitPackageDir, ...args], { env: gitEnv, encoding: "utf8" }).trim();
    git("init", "--initial-branch=main");
    git("add", "--", ".");
    const tree = git("write-tree");
    const gitCommit = git("commit-tree", tree, "-m", "S3 native package fixture");
    git("update-ref", "refs/heads/main", gitCommit);

    const tarballs = new Map<string, { bytes: Buffer; manifest: typeof npmManifest }>();
    for (const [name, sourceDir, manifest] of [[NPM_PACKAGE, npmPackageDir, npmManifest], [DEPENDENCY, dependencyDir, dependencyManifest]] as const) {
      const tarball = path.join(directory, `${name}.tgz`);
      await run("tar", ["-czf", tarball, "-C", path.dirname(sourceDir), "package"], { env: environment });
      tarballs.set(name, { bytes: await readFile(tarball), manifest });
    }
    const requests: string[] = [];
    let registryUrl = "";
    const registry = http.createServer((request, response) => {
      const requestPath = new URL(request.url!, registryUrl).pathname;
      requests.push(requestPath);
      const name = requestPath.split("/")[1]!;
      const pkg = tarballs.get(name);
      if (!pkg) { response.writeHead(404); response.end("unexpected fixture request"); return; }
      if (requestPath === `/${name}/-/${name}-1.0.0.tgz`) {
        response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(pkg.bytes); return;
      }
      if (requestPath === `/${name}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { ...pkg.manifest,
          dist: { tarball: `${registryUrl}/${name}/-/${name}-1.0.0.tgz`,
            integrity: `sha512-${createHash("sha512").update(pkg.bytes).digest("base64")}` } } } })); return;
      }
      response.writeHead(404); response.end("unexpected fixture path");
    });
    await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())));
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;

    const { stdout } = await run(process.execPath, ["--import", import.meta.resolve("tsx"), import.meta.filename,
      "--native-worker", JSON.stringify({ directory, agentDir, gitPackageDir, gitCommit } satisfies WorkerConfig)], {
      cwd: agentDir,
      env: { ...environment, npm_config_registry: registryUrl,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(gitPackageDir).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: GIT_SOURCE, GIT_ALLOW_PROTOCOL: "file" },
      timeout: 35_000, maxBuffer: 2 * 1024 * 1024,
    });
    const resultLine = stdout.split("\n").find(line => line.startsWith(RESULT_PREFIX));
    assert.ok(resultLine, stdout);
    const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
    assert.equal(result.sentinelAbsent, true);
    assert.equal(result.gitClone, true);
    assert.equal(requests.includes(`/${NPM_PACKAGE}/-/${NPM_PACKAGE}-1.0.0.tgz`), true, "真实 npm 从回环 registry 下载主包");
    assert.equal(requests.includes(`/${DEPENDENCY}/-/${DEPENDENCY}-1.0.0.tgz`), true, "真实 npm 下载并安装依赖");
    assert.ok(requests.every(url => tarballs.has(url.split("/")[1]!)), JSON.stringify(requests));
    assert.equal(existsSync(path.join(directory, "lifecycle.jsonl")), false);
    t.diagnostic("真实 Pi 1.4.0/npm/Git：npm 包安装、npm 卸载、Git clone 后依赖安装均携带 --ignore-scripts；恶意 .npmrc 未启用生命周期；registry 仅回环，Git 仅 file rewrite。");
  });
}
