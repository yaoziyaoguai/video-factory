import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SkillPackages } from "../src/server/agent/skill-packages.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = path.join(root, ".local/skill-creation");

test("G2-2 根 SKILL.md 走原生 loadSkills，来源去重、禁用可执行资源和卸载保持", async t => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "sk-"));
  const builtin = path.join(directory, "builtin");
  const source = path.join(directory, "source");
  await mkdir(builtin); await mkdir(path.join(source, "references"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: root-native\ndescription: Root Skill native fixture\n---\nRead references/notes.txt.\n");
  await writeFile(path.join(source, "references/notes.txt"), "retained source\n");
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "root-native-package", pi: { skills: [], extensions: ["extension.mjs"], prompts: ["prompts"], themes: ["themes"] } }));
  await writeFile(path.join(source, "extension.mjs"), "throw new Error('extension must never run')");
  const packages = new SkillPackages(path.join(directory, "settings"), builtin);
  await packages.initialize();
  await packages.install(source);
  const installed = await packages.refresh();
  assert.equal(installed.skills.some(skill => skill.id === "root-native"), true);
  assert.equal(packages.resources().skills.find(skill => skill.name === "root-native")!.filePath, path.join(source, "SKILL.md"));
  const pkg = installed.packages.find(pkg => pkg.origin === "installed")!;
  assert.equal(pkg.status, "ready"); assert.deepEqual(pkg.skillIds, ["root-native"]);
  const alias = path.join(directory, "alias"); await symlink(source, alias);
  await packages.install(alias); await packages.refresh();
  assert.equal(packages.read().packages.length, 2);
  assert.deepEqual(packages.settings.getNpmCommand(), ["npm", "--ignore-scripts"]);
  assert.ok(packages.settings.getPackages().every(entry => typeof entry === "object"
    && entry.extensions?.length === 0 && entry.prompts?.length === 0 && entry.themes?.length === 0));
  await packages.remove(pkg.id); await packages.refresh();
  assert.equal(packages.resources().skills.some(skill => skill.name === "root-native"), false);
  assert.equal(await readFile(path.join(source, "references/notes.txt"), "utf8"), "retained source\n");
  t.diagnostic(`根 Skill 证据 ${directory}`);
});

test("G2-2 公开 Huashu 固定 ref 实际原生安装、根 Skill 与参考资源、卸载", { skip: process.env.FRAME_CREATIVE_UPSTREAM !== "1", timeout: 120_000 }, async t => {
  await mkdir(evidence, { recursive: true });
  // 每次使用新的空目录，安装器与下载内容分开；不执行上游脚本。
  const directory = await mkdtemp(path.join(evidence, "up-"));
  const builtin = path.join(directory, "builtin"); await mkdir(builtin);
  const packages = new SkillPackages(path.join(directory, "settings"), builtin);
  await packages.initialize();
  const source = "https://github.com/alchaincyf/huashu-art-motion@8a0d7d72ca65fcce6f8ba82c4a6c8dfe35b8422c";
  const resourceCopy = process.env.FRAME_CREATIVE_UPSTREAM_PATH;
  await packages.install(resourceCopy ?? source);
  const view = await packages.refresh();
  const pkg = view.packages.find(pkg => pkg.origin === "installed")!;
  assert.equal(pkg.status, "ready", JSON.stringify(view));
  const installedPath = packages.manager.getInstalledPath(resourceCopy ?? source, "user")!;
  const ref = "8a0d7d72ca65fcce6f8ba82c4a6c8dfe35b8422c";
  if (resourceCopy) {
    // 网络受限时只验证已下载的固定 blob，不把资源子集说成完整 Git 安装。
    for (const [file, expected] of [["SKILL.md", "73f2248675f92a2b1928fa0d35e8369a3ea2292a"], ["references/04-纯代码绘制.md", "832d59eddb107a1197c6ac27a62f962a11ddc8c0"]]) {
      const bytes = await readFile(path.join(installedPath, file!));
      assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), expected);
    }
  } else assert.equal(execFileSync("git", ["-C", installedPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ref);
  const skill = packages.resources().skills.find(skill => pkg.skillIds.includes(skill.name))!;
  assert.equal(skill.filePath, path.join(installedPath, "SKILL.md"));
  const body = await readFile(skill.filePath, "utf8");
  assert.ok(body.length > 100);
  await writeFile(path.join(directory, "installed-evidence.json"), JSON.stringify({ source, ref, resourceCopy: resourceCopy ?? null,
    coverage: resourceCopy ? "固定 ref 的 SKILL.md 与 04-纯代码绘制.md；其余资源未下载" : "完整原生 Git 安装", view, skill }, null, 2));
  await packages.remove(pkg.id); await packages.refresh();
  assert.equal(packages.resources().skills.some(item => item.name === skill.name), false);
  await writeFile(path.join(directory, "removed-evidence.json"), JSON.stringify(packages.read(), null, 2));
  t.diagnostic(`固定 ref 原生安装证据 ${directory}`);
});
