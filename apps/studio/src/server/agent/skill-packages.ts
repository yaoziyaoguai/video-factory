import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DefaultPackageManager, SettingsManager, loadSkills, type LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import type { SkillPackage, SkillPackagesView, SkillPackageMutation } from "../../shared/agent/generated/contracts.js";
import { AgentError } from "./errors.js";
import { digestOf } from "./util.js";

const within = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);

// 应用专属 Pi 包配置和发现；运行会话仍使用原有内存 settings，不继承安装器配置。
export class SkillPackages {
  readonly directory: string;
  readonly settings: SettingsManager;
  readonly manager: DefaultPackageManager;
  mutation: SkillPackageMutation | null = null;
  refreshing = false;
  get available(): boolean { return this.catalog !== null; }
  private catalog: LoadSkillsResult | null = null;
  private packages: SkillPackage[] = [];

  constructor(dataDir: string, private readonly skillsRoot: string) {
    const directory = path.join(dataDir, "skill-packages");
    mkdirSync(directory, { recursive: true });
    this.directory = realpathSync(directory);
    this.settings = SettingsManager.create(this.directory, this.directory);
    this.settings.setNpmCommand(["npm", "--ignore-scripts"]);
    this.settings.setExtensionPaths([]);
    this.settings.setPromptTemplatePaths([]);
    this.settings.setThemePaths([]);
    this.manager = new DefaultPackageManager({ cwd: this.directory, agentDir: this.directory, settingsManager: this.settings });
  }

  async initialize(): Promise<void> {
    await this.persist();
    await this.refresh();
  }

  resources(): LoadSkillsResult {
    if (!this.catalog) throw new AgentError("TEMPORARILY_UNAVAILABLE", "Skill 目录读取未完成，请先读取 Skill 设置核对。", { retryAction: "wait" });
    return this.catalog;
  }

  summaries() {
    return this.resources().skills.map(skill => ({ id: skill.name,
      name: skill.name.slice(0, 80), description: (skill.description || skill.name).slice(0, 300) }));
  }

  read(): SkillPackagesView {
    return { packages: this.packages, skills: this.summaries(), mutation: this.mutation };
  }

  async reloadConfiguration(): Promise<void> {
    await this.settings.reload();
    if (this.settings.drainErrors().length) {
      this.catalog = null;
      throw new AgentError("TEMPORARILY_UNAVAILABLE", "Pi 包配置回读失败，请修复配置后重新读取。", { retryAction: "reload" });
    }
    // 只覆盖当前安装器运行参数；回读不能放开包脚本或外部可执行资源。
    this.settings.applyOverrides({ npmCommand: ["npm", "--ignore-scripts"], extensions: [], prompts: [], themes: [] });
  }

  invalidate(): void { this.catalog = null; }

  // 缺包只跳过并显示诊断：启动、GET、Bootstrap 都不会触发下载或升级。
  async refresh(): Promise<SkillPackagesView> {
    this.catalog = null;
    const builtinRoot = realpathSync(this.skillsRoot);
    const builtin: SkillPackage = { id: "builtin-skills", source: "builtin", name: "内置 Skill", origin: "builtin", skillIds: [], status: "ready", diagnostics: [] };
    const configured = this.manager.listConfiguredPackages();
    const packages = [builtin, ...configured.map(entry => ({ id: `pkg-${digestOf(entry.source).slice(0, 24)}`,
      source: entry.source, name: entry.source.slice(0, 200), origin: "installed" as const, skillIds: [] as string[], status: "no_skills" as const,
      diagnostics: [] as string[] }))];
    const roots = new Map<string, string>([[builtin.id, builtinRoot]]);
    for (const [index, entry] of configured.entries()) {
      const pkg = packages[index + 1]!;
      if (!entry.installedPath) { pkg.diagnostics.push("已配置来源不存在；请卸载后重新安装。"); continue; }
      const root = realpathSync(entry.installedPath);
      // 原生将本地来源持久化为相对 agentDir 的路径；托管 npm/git 的真实根必须留在应用目录。
      const localPath = path.resolve(this.directory, entry.source);
      const local = !entry.source.startsWith("npm:") && existsSync(localPath) && realpathSync(localPath) === root;
      if (!local && !within(path.join(this.directory, "npm"), root) && !within(path.join(this.directory, "git"), root)) {
        pkg.diagnostics.push("来源不在本应用受管安装目录，未加载。"); continue;
      }
      if (entry.source.startsWith("npm:") && !within(path.join(this.directory, "npm", "node_modules"), root)) {
        pkg.diagnostics.push("npm 来源不在本应用受管目录，未加载宿主全局安装。"); continue;
      }
      if (!statSync(root).isDirectory()) { pkg.diagnostics.push("来源必须是 Pi 包目录。"); continue; }
      const manifestFile = path.join(root, "package.json");
      if (existsSync(manifestFile)) {
        let manifest: unknown;
        try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
        catch { pkg.diagnostics.push("package.json 读取或解析失败，未加载该来源。"); continue; }
        if (manifest && typeof manifest === "object" && "name" in manifest && typeof manifest.name === "string" && manifest.name.trim()) {
          pkg.name = manifest.name.slice(0, 200);
        } else pkg.name = path.basename(root).slice(0, 200);
      } else pkg.name = path.basename(root).slice(0, 200);
      roots.set(pkg.id, root);
    }
    const resolved = await this.manager.resolve(async source => {
      packages.find(pkg => pkg.source === source)?.diagnostics.push("原生来源缺失或版本不符；请卸载后重新安装。");
      return "skip";
    });
    const paths: { path: string; packageId: string }[] = [{ path: builtinRoot, packageId: builtin.id }];
    for (const resource of resolved.skills) {
      if (!resource.enabled || resource.metadata.origin !== "package") continue;
      const pkg = packages.find(item => item.origin === "installed" && item.source === resource.metadata.source);
      const root = pkg && roots.get(pkg.id);
      if (!pkg || !root) continue;
      const actual = realpathSync(resource.path);
      if (!within(root, actual) || !resource.metadata.packageRoot || realpathSync(resource.metadata.packageRoot) !== root) {
        pkg.diagnostics.push("Skill 路径超出所属包目录，未加载。"); continue;
      }
      paths.push({ path: resource.path, packageId: pkg.id });
    }
    const loaded = loadSkills({ cwd: this.directory, agentDir: this.directory, includeDefaults: false, skillPaths: paths.map(item => item.path) });
    for (const diagnostic of loaded.diagnostics) {
      const owner = diagnostic.path ? paths.find(item => within(item.path, diagnostic.path!)) : undefined;
      const pkg = packages.find(item => item.id === owner?.packageId) ?? builtin;
      pkg.diagnostics.push(diagnostic.message.slice(0, 1200));
    }
    const skills = loaded.skills.filter(skill => {
      const owner = paths.find(item => within(item.path, skill.filePath));
      const pkg = packages.find(item => item.id === owner?.packageId);
      const root = pkg && roots.get(pkg.id);
      if (!pkg || !root || !within(root, realpathSync(skill.filePath)) || !within(root, realpathSync(skill.baseDir))) {
        pkg?.diagnostics.push("Skill 的真实路径超出所属包，未发布。"); return false;
      }
      // SDK 警告仍可能产出 Skill；不能发布无法作为原生命令或合同 Id 使用的名称。
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(skill.name)) {
        pkg.diagnostics.push("Skill 名称无法用于指定调用，未发布；请修正包中的原生 Skill 名称。"); return false;
      }
      pkg.skillIds.push(skill.name);
      return true;
    });
    if (skills.length > 200 || packages.length > 200) throw new AgentError("INVALID_INPUT", "Skill 或包数量超过当前目录上限 200。");
    this.packages = packages.map(pkg => ({ ...pkg, diagnostics: pkg.diagnostics.slice(0, 200),
      status: pkg.skillIds.length ? "ready" : pkg.diagnostics.length ? "invalid" : "no_skills" }));
    this.catalog = { skills, diagnostics: loaded.diagnostics };
    return this.read();
  }

  async install(source: string): Promise<void> {
    source = source.trim();
    if (!source || /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i.test(source)) throw new AgentError("INVALID_INPUT", "安装来源不能为空或包含 URL 内嵌凭据。");
    // 让原生配置语义判断包身份和版本，避免复制 npm/git 名称解析。
    const shadow = SettingsManager.inMemory({ packages: this.settings.getPackages() });
    const native = new DefaultPackageManager({ cwd: this.directory, agentDir: this.directory, settingsManager: shadow });
    const changed = native.addSourceToSettings(source);
    if (!changed) return;
    const configured = this.manager.listConfiguredPackages();
    const installedPath = this.manager.getInstalledPath(source, "user");
    const sameRoot = installedPath && configured.find(pkg => pkg.installedPath && realpathSync(pkg.installedPath) === realpathSync(installedPath));
    if (sameRoot) {
      // 原生身份不包含版本；只归一 SDK 的 git: 前缀别名，不猜包名或 ref。
      const withoutPrefix = (value: string) => value.startsWith("git:") ? value.slice(4) : value;
      if (source.startsWith("npm:") || /^(git:|https?:|ssh:)/.test(source)) {
        if (withoutPrefix(source) !== withoutPrefix(sameRoot.source)) throw new AgentError("INVALID_INPUT", "该包已有其他版本，请先卸载再安装。");
      }
      return;
    }
    if (shadow.getPackages().length === this.settings.getPackages().length) throw new AgentError("INVALID_INPUT", "该包已有其他版本，请先卸载再安装。");
    if (configured.length >= 199) throw new AgentError("INVALID_INPUT", "Skill 包数量已达当前目录上限，请先卸载一个包。");
    await this.manager.installAndPersist(source);
    this.settings.setPackages(this.settings.getPackages().map(entry => ({ source: typeof entry === "string" ? entry : entry.source,
      extensions: [], prompts: [], themes: [] })));
    await this.persist();
  }

  configuredPackage(packageId: string) {
    if (packageId === "builtin-skills") return { source: "builtin", origin: "builtin" as const };
    const configured = this.manager.listConfiguredPackages().find(pkg => `pkg-${digestOf(pkg.source).slice(0, 24)}` === packageId);
    return configured ? { source: configured.source, origin: "installed" as const } : undefined;
  }

  async remove(packageId: string): Promise<void> {
    const pkg = this.configuredPackage(packageId);
    if (!pkg) throw new AgentError("NOT_FOUND", "未找到这个 Skill 包，请先刷新列表。");
    if (pkg.origin === "builtin") throw new AgentError("FORBIDDEN", "内置 Skill 不可卸载。");
    await this.manager.removeAndPersist(pkg.source);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.settings.flush();
    if (this.settings.drainErrors().length) throw new AgentError("TEMPORARILY_UNAVAILABLE", "Pi 包配置未能保存，请读取当前目录核对。", { retryAction: "reload" });
  }
}
