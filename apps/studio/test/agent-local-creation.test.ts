import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { CreativeRunner, creativeWorkspaceId, editingWorkspace } from "../src/server/agent/creative-runner.js";
import { parseCreationState, writeWorkState, type WorkRow } from "../src/server/agent/creative-work.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { mixedRenderCatalogEntry } from "../src/server/agent/media-config.js";
import type { QuoteCatalog } from "../src/server/agent/artifact-store.js";
import { probeImageFile } from "../src/server/agent/media-probe.js";
import { retainedVideoMaterials } from "../src/server/agent/library-materials.js";
import type { ProductionService } from "../src/server/agent/production-service.js";
import { newAgentId, systemClock } from "../src/server/agent/util.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL } from "../src/server/agent/offline.js";
import type { CreativeProjectContent, ModelEntry, Work } from "../src/shared/agent/generated/contracts.js";

// G2-3 行为验收：publish_project 封存、render_project 免费受理（§4.2.1）、code_project 隔离执行、
// 草稿落位与在途 no-clobber、取消语义。走真实 SQLite + Pi 会话 + 现有 worker 与 LocalRenderPort；
// 唯一替身是与 creative-runner.ts 同协议的进程内 UDS 宿主（替代"隔离容器宿主"这一外部边界），
// execute 仍用真实 node 子进程，媒体验收用真实 ffprobe/ffmpeg。

const run = promisify(execFile);
let sequence = 0;
const cmd = () => `g23-${++sequence}`;
const chatInput = (text: string, extra: Record<string, unknown> = {}) => ({
  commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null, ...extra,
});

// 工程脚本：zlib 生成 160x90 PNG（无第三方依赖）；inputs/0.png 存在时要求非空，缺省跳过（编辑工作区试跑没有媒体输入）。
// 颜色参数化：精准修改样例靠换色区分 v1/v2 产物；output/guard 供 S3 判别（自定义输出名与入口参数守卫）。
const chartScript = (red: number, green: number, blue: number, output = "out.png", guard = "") => `const fs = require("fs"), z = require("zlib");
const crc = b => { let c = -1; for (const v of b) { c ^= v; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const h = Buffer.alloc(4), s = Buffer.alloc(4), b = Buffer.concat([Buffer.from(t), d]); h.writeUInt32BE(d.length); s.writeUInt32BE(crc(b)); return Buffer.concat([h, b, s]); };
const h = Buffer.alloc(13); h.writeUInt32BE(160, 0); h.writeUInt32BE(90, 4); h[8] = 8; h[9] = 2;
const rows = Buffer.alloc(90 * (1 + 160 * 3));
for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) { const p = y * 481 + 1 + x * 3; rows[p] = ${red}; rows[p + 1] = ${green}; rows[p + 2] = ${blue}; }
${guard}
if (fs.existsSync("inputs/0.png") && fs.statSync("inputs/0.png").size === 0) process.exit(3);
fs.writeFileSync("${output}", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", h), chunk("IDAT", z.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
`;
const pngScript = chartScript(46, 128, 110);

// 测试侧生成同规格 PNG（媒体输入与后继稿用），与工程脚本同一编码逻辑。
function makePng(red: number, green: number, blue: number): Buffer {
  const crc = (b: Buffer) => { let c = -1; for (const v of b) { c ^= v; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const h = Buffer.alloc(4), s = Buffer.alloc(4), b = Buffer.concat([Buffer.from(type), data]);
    h.writeUInt32BE(data.length); s.writeUInt32BE(crc(b)); return Buffer.concat([h, b, s]);
  };
  const h = Buffer.alloc(13); h.writeUInt32BE(160, 0); h.writeUInt32BE(90, 4); h[8] = 8; h[9] = 2;
  const rows = Buffer.alloc(90 * (1 + 160 * 3));
  for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
    const p = y * 481 + 1 + x * 3; rows[p] = red; rows[p + 1] = green; rows[p + 2] = blue;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", h), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

interface HostExecution { workspaceId: string; command: string; argv: string[] | null; inputBytes: number | null }

// 与 creative-runner.ts 同协议的进程内宿主替身：UDS + 换行分帧 JSON；/workspace 与 /skills
// 映射到每个 workspaceId 的真实目录；execute 用真实 /bin/sh 子进程在对应目录执行。
class LocalCreativeHost {
  private readonly server: http.Server;
  readonly executions: HostExecution[] = [];
  fileFailure: { action: "write" | "read"; path: string; message: string } | null = null;
  private constructor(readonly socketPath: string, private readonly root: string) {
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
  }
  static async start(root: string): Promise<LocalCreativeHost> {
    await mkdir(root, { recursive: true });
    const host = new LocalCreativeHost(path.join(root, "r.sock"), root);
    await new Promise<void>(resolve => host.server.listen(host.socketPath, resolve));
    return host;
  }
  close(): Promise<void> { return new Promise(resolve => this.server.close(() => resolve())); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const reply = (payload: Record<string, unknown>) => { response.end(`${JSON.stringify(payload)}\n`); };
    try {
      reply(await this.dispatch(JSON.parse(Buffer.concat(chunks).toString("utf8")), output => {
        response.write(`${JSON.stringify({ output: Buffer.from(output).toString("base64") })}\n`);
      }));
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async dispatch(frame: Record<string, unknown>, onOutput: (output: string) => void): Promise<Record<string, unknown>> {
    const workspaceId = frame.workspaceId as string;
    const workspaceDir = path.join(this.root, workspaceId, "workspace");
    const map = (file: string): string => {
      if (file === "/workspace" || file.startsWith("/workspace/")) return path.join(workspaceDir, file.slice("/workspace".length));
      if (file.startsWith("/skills/")) return path.join(this.root, workspaceId, "skills", file.slice("/skills/".length));
      throw new Error(`宿主替身只接受容器内路径：${file}`);
    };
    const failure = this.fileFailure;
    if (failure && failure.action === frame.action && failure.path === frame.path) {
      this.fileFailure = null;
      throw new Error(failure.message);
    }
    switch (frame.action) {
      case "image": return { imageId: "local-test-host:node" };
      case "skills": {
        for (const file of (frame.files as { path: string; data: string }[]) ?? []) {
          const target = map(`/skills/${file.path}`);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(file.data, "base64"));
        }
        return {};
      }
      case "write": {
        const target = map(frame.path as string);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(frame.data as string, "base64"));
        return {};
      }
      case "read": return { data: (await readFile(map(frame.path as string))).toString("base64") };
      case "mkdir": await mkdir(map(frame.path as string), { recursive: true }); return {};
      case "access": {
        if (frame.mode !== "read") return {};
        await access(map(frame.path as string));
        return {};
      }
      case "image_type": {
        const file = map(frame.path as string);
        return { mimeType: file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : null };
      }
      case "list": {
        const files: { path: string; size: number }[] = [];
        const walk = async (directory: string, prefix: string): Promise<void> => {
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(file, `${prefix}${entry.name}/`);
            else files.push({ path: `/workspace/${prefix}${entry.name}`, size: (await stat(file)).size });
          }
        };
        await mkdir(workspaceDir, { recursive: true });
        await walk(workspaceDir, "");
        return { files };
      }
      case "execute": {
        // 与真实宿主一致：command 走 shell，argv 逐项直传进程（冻结工程的正式执行入口）。
        const argv = (frame.argv as string[] | undefined) ?? null;
        const command = frame.command as string | undefined;
        await mkdir(workspaceDir, { recursive: true });
        const input = path.join(workspaceDir, "inputs", "0.png");
        this.executions.push({ workspaceId, command: command ?? JSON.stringify(argv), argv, inputBytes: await stat(input).then(s => s.size, () => null) });
        try {
          const executed = argv
            ? await run(argv[0]!, argv.slice(1), { cwd: workspaceDir, timeout: (typeof frame.timeout === "number" ? frame.timeout : 60) * 1000 })
            : await run("/bin/sh", ["-c", command!], { cwd: workspaceDir, timeout: (typeof frame.timeout === "number" ? frame.timeout : 60) * 1000 });
          onOutput(executed.stdout); onOutput(executed.stderr);
          return { exitCode: 0 };
        } catch (error) {
          const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stdout?: string; stderr?: string };
          onOutput(failure.stdout ?? ""); onOutput(failure.stderr ?? "");
          if (typeof failure.code === "number") return { exitCode: failure.code };
          if (failure.killed || typeof failure.signal === "string") return { exitCode: null };
          throw error;
        }
      }
      default: throw new Error(`宿主替身不支持 action=${String(frame.action)}`);
    }
  }
}

const FAUX_TEXT_ENTRY: ModelEntry = {
  binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "local-fixture", configurationRevisionId: "g23-local" },
  name: "Faux 文本模型（本地创作）", kind: "text", features: ["chat", "tools", "offline-fixture"], availability: "configured",
  verificationNote: "测试 Faux 模型，仅驱动流程。", isDefault: true,
};

interface World {
  runtime: AgentRuntime;
  conversationId: string;
  host: LocalCreativeHost;
  blobs: ProductionService["blobs"];
  directory: string;
  close(): Promise<void>;
}

async function setup(catalog: QuoteCatalog = {}): Promise<World> {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-g23-"));
  const host = await LocalCreativeHost.start(path.join(directory, "creative-host"));
  const runner = new CreativeRunner({ socketPath: host.socketPath });
  await mkdir(path.join(directory, "skills"), { recursive: true });
  const runtime = await createAgentRuntime({
    dataDir: path.join(directory, "app"), skillsRoot: path.join(directory, "skills"),
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, catalog: () => catalog,
    creative: { runner },
    media: { autoStart: false, factory: (db, blobs) => ({
      port: new LocalRenderPort(db, blobs, systemClock, { workRoot: path.join(directory, "media-work") }, runner),
      catalog: () => catalog, models: () => [],
    }) },
  });
  const conversationId = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "本地创作" }).conversation.id;
  return {
    runtime, conversationId, host, blobs: runtime.production!.blobs, directory,
    close: async () => { await runtime.close(); await host.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

async function send(world: World, steps: (ReturnType<typeof fauxAssistantMessage> | ((context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>))[], text = "请处理") {
  world.runtime.host.faux!.setResponses(steps);
  const sent = await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput(text));
  for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId, null, "回合应已结束");
  return sent.receipt;
}

async function drive(world: World, runId: string) {
  for (let i = 0; i < 50; i++) {
    await world.runtime.worker!.pollOnce();
    const state = world.runtime.service.getRun("local-owner", runId).state;
    if (state === "succeeded" || state === "failed" || state === "cancelled") break;
    // 本地运行执行真实 node 子进程，观察间隔给子进程留出真实时间。
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return world.runtime.service.getRun("local-owner", runId);
}

const count = (world: World, sql: string, ...args: unknown[]) =>
  (world.runtime.database.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args) as { n: number }).n;

const jsonField = (world: World, sql: string, field: string, ...args: unknown[]) =>
  JSON.parse(String((world.runtime.database.prepare(sql).get(...args) as Record<string, unknown>)[field]));

// 最近一次封存的 project 修订（同会话多工程并存时按修订创建顺序取最新，不依赖产物头部列表形态）。
const latestProjectRevision = (world: World): { artifactId: string; revisionId: string } =>
  world.runtime.database.prepare("SELECT r.id AS revisionId, r.artifact_id AS artifactId FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.kind='project' ORDER BY r.rowid DESC LIMIT 1")
    .get() as { artifactId: string; revisionId: string };

// 读取运行产物修订背后的真实字节（判别"执行真产生了输出"用）。
const outputBytes = (world: World, revisionId: string): Buffer => {
  const media = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", revisionId) as { blobId: string };
  const blob = world.blobs.get("local-owner", media.blobId);
  return readFileSync(world.blobs.filePath(blob.digest));
};

const works = (world: World): Work[] => world.runtime.service.snapshot("local-owner", world.conversationId).works;

function currentState(context: TranscriptContext): { target: unknown; libraryInputs: { path: string }[]; referencedWorkIds: string[] } {
  const texts = context.messages.flatMap(message => typeof message.content === "string" ? [message.content]
    : message.content.flatMap(block => block.type === "text" ? [block.text] : []));
  const state = texts.filter(text => text.startsWith("[frame-current-state]")).at(-1);
  assert.ok(state, "应取得模型实际收到的当前业务状态");
  return JSON.parse(state.slice("[frame-current-state]".length).split("\n")[0]!);
}

function itemOf(world: World, groupId: string, itemId: string) {
  const group = works(world).flatMap(work => work.reviewGroups).find(group => group.id === groupId);
  assert.ok(group, `应能读到组 ${groupId}`);
  const item = group.items.find(item => item.id === itemId);
  assert.ok(item, `应能读到事项 ${itemId}`);
  return item;
}

// 起始作品 + 冻结工程：返回 workId 与工程修订引用。
async function authorProject(world: World): Promise<{ workId: string; artifactId: string; revisionId: string }> {
  await send(world, [
    fauxAssistantMessage([fauxToolCall("start_work", { title: "城市动画" })]),
    fauxAssistantMessage("已开始。"),
  ]);
  const workId = works(world)[0]!.id;
  await send(world, [
    fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: pngScript })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
    fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "动画工程", files: ["main.cjs"],
      entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
    fauxAssistantMessage("工程已冻结。"),
  ], "写一个首帧脚本并封存工程。");
  const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project");
  assert.ok(project, "应产出 project 产物");
  const revision = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?", "content_json", project.id, project.revisionId) as CreativeProjectContent;
  assert.equal((revision as { runtimeImage: string }).runtimeImage, "local-test-host:node", "工程应冻结宿主镜像标识");
  assert.deepEqual((revision as { files: { relativePath: string }[] }).files.map(file => file.relativePath), ["main.cjs"], "S3：封存清单只收源码，输出是执行产生的未来文件");
  return { workId, artifactId: project.id, revisionId: project.revisionId };
}

// 返回推断的字面量类型（不用 interface 注解）：fauxToolCall 的实参是 JsonObject 索引签名，
// interface 没有隐式索引签名会编译失败；运行时校验由真实契约路径把关。
const draftImageOperation = (project: { artifactId: string; revisionId: string }) => ({
  operationId: "frame-1", outputSlot: "image-1",
  inputs: [] as { kind: "blob"; blobId: string; digest: string }[],
  parameters: { assembly: "code_project" as const, projectRevision: { artifactId: project.artifactId, revisionId: project.revisionId },
    entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.png",
    expectedMediaKind: "image" as const, format: "png" as const, width: 160, height: 90 },
  target: { group: { mode: "create" as const, key: "visual", title: "画面", nextIntent: null },
    item: { mode: "create" as const, key: "first-frame", label: "首帧图", role: "storyboard" as const, required: true } },
});

it("DGR-02 失败运行保留有界真实执行输出，新工程修订成功且不改旧稿", async () => {
  const world = await setup(); try {
    const project = await authorProject(world);
    const failureSource = 'process.stderr.write("start-of-output\\n" + "x".repeat(12000)); throw new Error("Background bytes differ from the bound original revision.");';
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: failureSource })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId: project.workId, title: "动画工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("失败样例已封存。"),
    ]);
    const failedProject = latestProjectRevision(world);
    const before = world.runtime.service.readRevision("local-owner", failedProject.artifactId, failedProject.revisionId);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId: project.workId, title: "错误样例", scope: "错误输出验证", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [draftImageOperation(failedProject)] })]),
      fauxAssistantMessage("已受理。"),
    ]);
    const failedRunId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const failed = await drive(world, failedRunId);
    assert.equal(failed.state, "failed");
    assert.match(failed.issue?.message ?? "", /exit=1/);
    assert.match(failed.issue?.message ?? "", /Background bytes differ from the bound original revision/);
    assert.doesNotMatch(failed.issue?.message ?? "", /^start-of-output$/m);
    assert.ok(Buffer.byteLength(failed.issue?.message ?? "") < 9000, "只保留约8KiB执行输出尾部");
    assert.equal(failed.outputRevisions.length, 0);

    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: pngScript })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId: project.workId, title: "动画工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("正确新稿已封存。"),
    ]);
    const corrected = latestProjectRevision(world);
    assert.notEqual(corrected.revisionId, failedProject.revisionId);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId: project.workId, title: "正确新稿", scope: "新稿验证", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [draftImageOperation(corrected)] })]),
      fauxAssistantMessage("已受理。"),
    ]);
    const correctedRunId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const correctedRun = await drive(world, correctedRunId);
    assert.equal(correctedRun.state, "succeeded");
    const correctedMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", correctedRun.outputRevisions[0]!.revisionId) as { blobId: string };
    const facts = await probeImageFile(world.blobs.filePath(world.blobs.get("local-owner", correctedMedia.blobId).digest));
    assert.equal(facts.width, 160); assert.equal(facts.height, 90);
    assert.deepEqual(world.runtime.service.readRevision("local-owner", failedProject.artifactId, failedProject.revisionId), before);
    assert.equal(world.runtime.service.getRun("local-owner", failedRunId).state, "failed");
  } finally { await world.close(); }
});

it("DGR-R1.1 执行诊断：恢复文件和读取输出失败保留阶段与原因，不猜测未生成", async () => {
  const world = await setup(); try {
    const project = await authorProject(world);
    for (const [index, failure] of [
      { action: "write" as const, path: "/workspace/main.cjs", message: "restore channel interrupted", phase: /恢复文件 main\.cjs/ },
      { action: "read" as const, path: "/workspace/out.png", message: "output channel interrupted", phase: /读取声明输出 out\.png/ },
    ].entries()) {
      await send(world, [
        fauxAssistantMessage([fauxToolCall("render_project", { workId: project.workId, title: "阶段诊断", scope: "读写边界", purpose: "draft",
          inputSources: [], reviewInputs: [], operations: [{ ...draftImageOperation(project), operationId: `diagnostic-${index}` }] })]),
        fauxAssistantMessage("已受理。"),
      ]);
      const runId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
      const executionsBefore = world.host.executions.length;
      world.host.fileFailure = failure;
      const failed = await drive(world, runId);
      assert.equal(failed.state, "failed");
      assert.equal(failed.outputRevisions.length, 0);
      assert.match(failed.issue?.message ?? "", failure.phase);
      assert.match(failed.issue?.message ?? "", new RegExp(failure.message));
      assert.doesNotMatch(failed.issue?.message ?? "", /没有产生声明的输出|没有生成输出/);
      assert.equal(world.host.executions.length - executionsBefore, failure.action === "write" ? 0 : 1);
      if (failure.action === "read") {
        const runner = new CreativeRunner({ socketPath: world.host.socketPath });
        const bytes = await runner.readFile({ conversationId: world.conversationId, workId: project.workId,
          executionId: `${runId}:diagnostic-${index}` }, "out.png");
        assert.ok(bytes.equals(makePng(46, 128, 110)), "读取通道失败时输出其实已存在，不能反推工程没有生成它");
      }
    }
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId: project.workId, title: "正常执行", scope: "不影响成功路径", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [draftImageOperation(project)] })]),
      fauxAssistantMessage("已受理。"),
    ]);
    const runId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const succeeded = await drive(world, runId);
    assert.equal(succeeded.state, "succeeded");
    assert.ok(outputBytes(world, succeeded.outputRevisions[0]!.revisionId).equals(makePng(46, 128, 110)));
  } finally { await world.close(); }
});

it("DGR-R1.1 零增益工程音轨：合法混合不留未采用音轨的工程和独有依据", async () => {
  const world = await setup({ "render:mixed_concat": mixedRenderCatalogEntry() }); try {
    const { workId } = await authorProject(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "create", title: "仅供音乐工程的依据", kind: "script",
        content: { format: "markdown", text: "这份说明只属于音轨工程，不是画面或最终混合的依据。" } }] })]),
      fauxAssistantMessage("已交付独立依据。"),
    ]);
    const uniqueSource = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "script")!;
    const musicScript = `require("node:child_process").execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "48000", "-ac", "1", "out.wav"]);`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "music.cjs", content: musicScript })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "未采用的音轨工程", files: ["music.cjs"],
        entrypoint: { argv: ["node", "music.cjs"] }, dependencyLocks: [], timelineFiles: [],
        sourceRevisions: [{ artifactId: uniqueSource.id, revisionId: uniqueSource.revisionId }] })]),
      fauxAssistantMessage("音轨工程已封存。"),
    ]);
    const musicProject = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "备选音乐", scope: "程序音轨", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [{ operationId: "unused-music", outputSlot: "music", inputs: [],
          parameters: { assembly: "code_project", projectRevision: musicProject, entrypoint: { argv: ["node", "music.cjs"] },
            outputPath: "out.wav", expectedMediaKind: "audio", format: "wav", sampleRate: 48000, channels: 1 },
          target: { group: { mode: "create", key: "music", title: "音乐", nextIntent: null },
            item: { mode: "create", key: "audio", label: "备选音乐", role: "music", required: false } } }] })]),
      fauxAssistantMessage("音轨已受理。"),
    ]);
    const musicRunId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
    const musicRun = await drive(world, musicRunId);
    assert.equal(musicRun.state, "succeeded", musicRun.issue?.message);
    const musicRef = musicRun.outputRevisions[0]!;
    const musicRevision = world.runtime.service.readRevision("local-owner", musicRef.artifactId, musicRef.revisionId);
    const videoPath = path.join(world.directory, "red.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1280x720:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
    const rawVideo = world.blobs.persist("local-owner", world.conversationId, readFileSync(videoPath), "video/mp4", 1000);
    let toolError: string | undefined;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "静音音乐混合", scope: "零增益音轨合法但不采用", purpose: "draft",
        inputSources: [{ kind: "artifact_revision", ...musicRef, digest: musicRevision.digest }], reviewInputs: [], operations: [
          { operationId: "mixed", outputSlot: "final", inputs: [
              { kind: "blob", blobId: rawVideo.id, digest: rawVideo.digest },
              { kind: "artifact_revision", ...musicRef, digest: musicRevision.digest } ],
            parameters: { assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24, segmentIds: ["red"],
              segments: [{ inputSlot: 0, kind: "video", startMs: 0, durationMs: 1000, originalGain: 0 }],
              music: { inputSlot: 1, sourceStartMs: 0, sourceDurationMs: 1000, repeat: false,
                timelineStartMs: 0, playDurationMs: 1000, gain: 0, fadeInMs: 0, fadeOutMs: 0, duckUnderNarration: false } },
            target: { group: { mode: "create", key: "mixed", title: "混合", nextIntent: null },
              item: { mode: "create", key: "clip", label: "混合草稿", role: "clip", required: false } } },
        ] })]),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        if (result.isError) toolError = JSON.stringify(result.content);
        return fauxAssistantMessage("已核对受理结果。");
      },
    ]);
    assert.equal(toolError, undefined, toolError);
    const acceptedRun = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
    assert.ok(acceptedRun, JSON.stringify(world.runtime.service.snapshot("local-owner", world.conversationId).messages.items));
    const result = await drive(world, acceptedRun.id);
    assert.equal(result.state, "succeeded", result.issue?.message);
    const video = result.outputRevisions.find(ref => {
      const content = world.runtime.service.readRevision("local-owner", ref.artifactId, ref.revisionId).content;
      return content.format === "media" && content.mimeType === "video/mp4";
    });
    assert.ok(video);
    const retained = retainedVideoMaterials(world.runtime.database, "local-owner", video);
    assert.equal(retained.producer?.operationId, "mixed");
    assert.equal(retained.projects.some(project => project.revisionId === musicProject.revisionId), false,
      `gain=0 的工程不应随扁平绑定混入：${JSON.stringify(retained.projects)}`);
    assert.equal(retained.materials.some(material => "revisionId" in material.source && material.source.revisionId === uniqueSource.revisionId), false);
    assert.equal(retained.materials.length, 1, "只留真实采用的 raw 画面");
    assert.ok("kind" in retained.materials[0]!.source && retained.materials[0]!.source.kind === "run_input");
  } finally { await world.close(); }
});

it("G2-3 受理事实：免费本地渲染不建提案/授权/账单，正式视频需组认可", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    const seed = world.blobs.persist("local-owner", world.conversationId, makePng(200, 60, 60), "image/png", null);

    // 草稿图片受理：媒体输入按 blob 引用，新组/项由受理一次分配。
    const receipt = await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }), inputs: [{ kind: "blob", blobId: seed.id, digest: seed.digest }] }] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "生成首帧草稿。");
    assert.equal(count(world, "FROM production_runs"), 1);
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string; proposal_id: string | null; source_request_id: string };
    const run = world.runtime.service.getRun("local-owner", runRow.id);
    assert.equal(run.origin.kind, "local_request");
    assert.equal(run.origin.kind === "local_request" ? run.origin.requestId : null, receipt.requestId, "来源请求是受理时的当前请求");
    assert.equal(runRow.proposal_id, null);
    assert.equal(run.finance, null, "免费运行没有账务事实");
    assert.equal(count(world, "FROM proposals"), 0);
    assert.equal(count(world, "FROM user_actions"), 0, "免费受理不建 user_action");
    assert.equal(count(world, "FROM authorizations"), 0, "免费受理不建授权");
    assert.equal(count(world, "FROM production_attempts"), 0, "受理只排队，不抢先执行");
    assert.equal(world.host.executions.length, 1, "受理本身不执行任何容器命令（只有编辑工作区试跑一次）");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", run.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    assert.match(target.groupId, /^grp-/); assert.match(target.itemId, /^item-/);
    const created = itemOf(world, target.groupId, target.itemId);
    assert.equal(created.draft, null, "新事项先无主稿，只展示制作中");
    assert.equal(created.label, "首帧图");
    const firstDone = await drive(world, runRow.id);
    assert.equal(firstDone.state, "succeeded", "首个草稿运行完整执行，释放作品在途位");

    // 正式视频无认可依据：受理拒绝，且不再建第二个 run。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "城市成片", scope: "正式整片", purpose: "production",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "final-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId, revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.png",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "create", key: "final", title: "成片", nextIntent: null },
            item: { mode: "create", key: "final-video", label: "成片", role: "video", required: true } } }] })]),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        assert.equal(result.isError, true, text);
        assert.match(text, /正式视频制作需要先获得组审阅认可/);
        return fauxAssistantMessage("需要先认可内容。");
      },
    ], "直接出正式成片。");
    assert.equal(count(world, "FROM production_runs"), 1, "被拒受理不建 run");

    // 有真实认可后：正式视频受理成立，认可依据随快照冻结。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "城市文案", kind: "script", content: { format: "markdown", text: "# 城市\n雨停之前走一遍天桥。" } }],
        reviewGroups: [{ workId, group: { mode: "create", key: "content-group", title: "脚本与内容", nextIntent: null },
          items: [{ item: { mode: "create", key: "script", label: "脚本", role: "content", required: true },
            itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("文案已交付。"),
    ], "先给文案。");
    const contentGroup = works(world).flatMap(work => work.reviewGroups).find(group => group.items.some(item => item.role === "content"))!;
    const contentItem = contentGroup.items.find(item => item.role === "content")!;
    assert.ok(contentItem.draft?.kind === "artifact_revision");
    const contentV1 = contentItem.draft;
    const firstFrame = itemOf(world, target.groupId, target.itemId).draft;
    assert.ok(firstFrame?.kind === "artifact_revision");
    // 同一事项改稿的两条历史路径：直接来源与冻结工程来源都保留 v1；另一项首帧仍是独立依据。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "改稿参考工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [],
        sourceRevisions: [{ artifactId: contentV1.artifactId, revisionId: contentV1.revisionId }] })]),
      fauxAssistantMessage("已保留改稿参考。"),
    ]);
    const historyProject = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [{ mode: "revise", artifactId: contentV1.artifactId,
        baseRevisionId: contentV1.revisionId, title: "城市文案", kind: "script", content: { format: "markdown", text: "# 城市\n雨停后的天桥。（第二版）" } }],
        reviewGroups: [{ workId, group: { mode: "existing", groupId: contentGroup.id },
          items: [{ item: { mode: "existing", itemId: contentItem.id }, itemIndex: 0, purpose: "draft",
            inputSources: [contentV1, firstFrame], reviewInputs: [],
            projectRevision: { artifactId: historyProject.artifactId, revisionId: historyProject.revisionId } }] }] })]),
      fauxAssistantMessage("v2 已交付，旧稿保留。"),
    ], "按首帧参考改文案。");
    const revised = itemOf(world, contentGroup.id, contentItem.id).draft;
    assert.ok(revised?.kind === "artifact_revision");
    const contentDraft = revised;
    assert.notEqual(contentDraft.revisionId, contentV1.revisionId);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("认可这版文案", {
      reviewConfirmation: { workId, groupId: contentGroup.id, items: [{ itemId: contentItem.id, source: contentDraft }], action: "approve" },
    }));
    const confirmed = itemOf(world, contentGroup.id, contentItem.id);
    assert.ok(confirmed.confirmationId, "认可产生真实确认 ID");
    await send(world, [
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "正式成片工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [],
        sourceRevisions: [{ artifactId: contentDraft.artifactId, revisionId: contentDraft.revisionId }] })]),
      fauxAssistantMessage("正式工程只采用 v2。"),
    ]);
    const finalProject = latestProjectRevision(world);
    const finalStep = (inputSources: typeof contentV1[] = []) => fauxAssistantMessage([fauxToolCall("render_project", {
      workId, title: "城市成片", scope: "正式整片", purpose: "production", inputSources,
      reviewInputs: [{ groupId: contentGroup.id, itemId: contentItem.id, source: contentDraft, confirmationId: confirmed.confirmationId }],
      operations: [{ operationId: "final-1", outputSlot: "video-1", inputs: [],
        parameters: { assembly: "code_project", projectRevision: { artifactId: finalProject.artifactId, revisionId: finalProject.revisionId },
          entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.png",
          expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
        target: { group: { mode: "existing", groupId: target.groupId }, item: { mode: "existing", itemId: target.itemId } } }],
    })]);
    let rejection = "";
    const recordRejection = (context: TranscriptContext) => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
      rejection = result.content.filter(part => part.type === "text").map(part => part.text).join("");
      return fauxAssistantMessage("先解决准确依据的认可缺口。");
    };
    await send(world, [finalStep(), recordRejection]);
    assert.match(rejection, /首帧图/, "已认 v2 仍须核对另一项上游依据");
    assert.doesNotMatch(rejection, /脚本/, "v2 的改稿来源不能追讨同事项 v1 的认可");
    assert.equal(count(world, "FROM production_runs"), 1);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("认可首帧参考", {
      reviewConfirmation: { workId, groupId: target.groupId, items: [{ itemId: target.itemId, source: firstFrame }], action: "approve" },
    }));
    await send(world, [finalStep([contentV1]), recordRejection]);
    assert.match(rejection, /脚本/, "另行直接采用未认 v1 仍被拒绝");
    assert.equal(count(world, "FROM production_runs"), 1);
    await send(world, [finalStep(), fauxAssistantMessage("成片已受理。")], "现在出正式成片。");
    assert.equal(count(world, "FROM production_runs"), 2, "带认可的正式受理建 run");
    const second = world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    const secondRun = world.runtime.service.getRun("local-owner", second.id);
    assert.equal(secondRun.origin.kind, "local_request");
    assert.equal(secondRun.finance, null);
    const secondSpec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", secondRun.snapshotId);
    assert.equal((secondSpec as { type: string }).type, "local_creation");
    assert.equal((secondSpec as { reviewInputs: { confirmationId: string }[] }).reviewInputs[0]!.confirmationId, confirmed.confirmationId, "认可依据随快照冻结");
  } finally { await world.close(); }
});

it("G2-3 执行发布：隔离身份执行、媒体输入物化、真实探测落位、完成不自动点评", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    const seedBytes = makePng(200, 60, 60);
    const seed = world.blobs.persist("local-owner", world.conversationId, seedBytes, "image/png", null);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }), inputs: [{ kind: "blob", blobId: seed.id, digest: seed.digest }] }] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "生成首帧草稿。");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string };
    const editingId = creativeWorkspaceId(editingWorkspace(world.conversationId, workId));

    // 在途可聊：run 仍在排队，普通对话照常进行（worker autoStart=false，未轮询即未执行）。
    await send(world, [fauxAssistantMessage("在途也可以聊其他话题。")], "聊聊别的。");
    assert.equal(world.runtime.service.getRun("local-owner", runRow.id).state, "queued", "渲染未完成前不阻塞对话");

    const assistantsBefore = world.runtime.service.snapshot("local-owner", world.conversationId).messages.items.filter(m => m.role === "assistant").length;
    const requestsBefore = count(world, "FROM requests");
    const result = await drive(world, runRow.id);
    assert.equal(result.state, "succeeded");
    assert.equal(count(world, "FROM production_attempts WHERE run_id=?", runRow.id), 1, "恰好一次尝试，不重试");
    assert.equal((world.runtime.database.prepare("SELECT reserve_minor FROM production_attempts WHERE run_id=?").get(runRow.id) as { reserve_minor: number }).reserve_minor, 0, "免费运行不预留额度");
    assert.equal(count(world, "FROM requests"), requestsBefore, "完成不排新请求");
    const messagesAfter = world.runtime.service.snapshot("local-owner", world.conversationId).messages.items;
    assert.equal(messagesAfter.filter(m => m.role === "assistant").length, assistantsBefore, "完成后不自动点评");
    assert.ok(messagesAfter.some(m => m.role === "system_notice" && m.text.includes("“首帧草稿”已完成")), "完成事实以系统通知告知，不冒充模型发言");
    assert.equal(count(world, "FROM events WHERE kind='artifact.delivered'"), 1);

    // 隔离执行身份：run 用冻结的 run+operation 工作区，不复用编辑工作区；媒体输入按槽位物化。
    const runExecution = world.host.executions.at(-1)!;
    assert.equal(runExecution.workspaceId, creativeWorkspaceId({ conversationId: world.conversationId, workId, executionId: `${runRow.id}:frame-1` }), "执行身份是冻结 run+operation");
    assert.deepEqual(runExecution.argv, ["node", "main.cjs"], "S3：正式执行按冻结 argv 逐项直传，不是拼成的 shell 命令");
    assert.equal(runExecution.command, JSON.stringify(["node", "main.cjs"]), "替身只把 argv 记录为结构化事实");
    assert.equal(runExecution.inputBytes, seedBytes.length, "媒体输入按槽位物化成非空文件");
    assert.notEqual(runExecution.workspaceId, editingId);

    // 成品真实探测验收：草稿落位到冻结目标，媒体事实与修订一致。
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision", "产出落为事项主稿");
    assert.equal(item.draft.revisionId, result.outputRevisions[0]!.revisionId);
    const revision = jsonField(world, "SELECT content_json, creation_binding_json FROM artifact_revisions WHERE id=?", "content_json", item.draft.revisionId) as { format: string; blobId: string; mimeType: string; durationMs: number | null };
    const media = revision;
    assert.equal(media.mimeType, "image/png");
    const blob = world.blobs.get("local-owner", media.blobId);
    const facts = await probeImageFile(world.blobs.filePath(blob.digest));
    assert.equal(facts.width, 160); assert.equal(facts.height, 90);
    const binding = jsonField(world, "SELECT creation_binding_json FROM artifact_revisions WHERE id=?", "creation_binding_json", item.draft.revisionId);
    assert.equal(binding.itemId, target.itemId, "新组模型 binding 记录准确落位");
    assert.equal(binding.runId, runRow.id);
  } finally { await world.close(); }
});

it("G2-3 在途 no-clobber：后继草稿不被旧运行结果覆盖，产出事实保留", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    const admit = async (existing?: { groupId: string; itemId: string; baseRevisionId: string }) => {
      await send(world, [
        fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
          inputSources: [], reviewInputs: [],
          operations: [existing
            ? { ...draftImageOperation({ artifactId, revisionId }), baseRevisionId: existing.baseRevisionId,
                target: { group: { mode: "existing" as const, groupId: existing.groupId }, item: { mode: "existing" as const, itemId: existing.itemId } } }
            : draftImageOperation({ artifactId, revisionId })] })]),
        fauxAssistantMessage("渲染已受理。"),
      ], "生成首帧。");
      return world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    };
    const first = await admit();
    const done = await drive(world, first.id);
    assert.equal(done.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", done.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision");
    const firstDraft = item.draft;

    // 第二次受理冻结当前基线；在途期间交付后继稿（引用首个运行已落盘的输出，经可信 local_output 通道）。
    const second = await admit({ groupId: target.groupId, itemId: target.itemId, baseRevisionId: firstDraft.revisionId });
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "revise", artifactId: firstDraft.artifactId, baseRevisionId: firstDraft.revisionId,
          title: "首帧图", kind: "image", content: { format: "local_output",
            source: { kind: "run_output", runId: first.id, operationId: "frame-1", outputSlot: "image-1" } } }],
        reviewGroups: [{ workId, group: { mode: "existing", groupId: target.groupId },
          items: [{ item: { mode: "existing", itemId: target.itemId }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("新版已交付。"),
    ], "换个颜色。");
    const superseded = itemOf(world, target.groupId, target.itemId);
    assert.ok(superseded.draft?.kind === "artifact_revision" && superseded.draft.revisionId !== firstDraft.revisionId, "在途交付推进了草稿");

    const secondResult = await drive(world, second.id);
    assert.equal(secondResult.state, "succeeded", "运行本身成功");
    const after = itemOf(world, target.groupId, target.itemId);
    assert.equal(after.draft?.kind === "artifact_revision" ? after.draft.revisionId : null, superseded.draft?.kind === "artifact_revision" ? superseded.draft.revisionId : null,
      "后继稿不被旧运行结果覆盖（§4.2.1）");
    assert.equal(secondResult.outputRevisions.length, 1, "旧运行的产出修订仍保留");
    const binding = jsonField(world, "SELECT creation_binding_json FROM artifact_revisions WHERE id=?", "creation_binding_json", secondResult.outputRevisions[0]!.revisionId);
    assert.equal(binding.itemId, target.itemId, "被跳过落位的产出仍记录准确归属");
  } finally { await world.close(); }
});

// S4（§11.6）：本地渲染的输出基准从受理时真实 item.draft 冻结——null 明确表示受理时确实无稿，
// 完成时只有仍为空才落位；省略 baseRevisionId 不当作“此前无稿”；显式给出的基准与事实不符时受理即拒。
it("S4 输出基准从受理时真实草稿冻结：null 只在仍为空时落位，省略不当作无稿，错基准受理被拒", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);

    // 空主稿目标事项：受理目标分配后的真实初始形状（公开工具尚无更轻的空项入口，用内核写状态建立事实）。
    const workRow = world.runtime.database.prepare("SELECT * FROM works WHERE id=?").get(workId) as WorkRow;
    const state = parseCreationState(workRow);
    const groupId = newAgentId("grp"), emptyItemId = newAgentId("item");
    state.groups.push({ id: groupId, title: "画面", revision: 1, nextIntent: null,
      items: [{ id: emptyItemId, label: "首帧图", role: "storyboard", required: true, draft: null, approved: null, confirmationId: null, approvedAt: null }] });
    writeWorkState(world.runtime.database, new Date().toISOString(), workRow, state);

    const admitExisting = async (baseRevisionId?: string) => {
      await send(world, [
        fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
          inputSources: [], reviewInputs: [],
          operations: [{ ...draftImageOperation({ artifactId, revisionId }),
            target: { group: { mode: "existing" as const, groupId }, item: { mode: "existing" as const, itemId: emptyItemId } },
            ...(baseRevisionId === undefined ? {} : { baseRevisionId }) }] })]),
        fauxAssistantMessage("渲染已受理。"),
      ], "再生成一版。");
      const row = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
      const target = (jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json",
        world.runtime.service.getRun("local-owner", row.id).snapshotId) as { operations: { target: { baseRevisionId: string | null } }[] }).operations[0]!.target;
      return { runId: row.id, frozenBase: target.baseRevisionId };
    };

    // A：受理时空项基准为 null；在途期间交付的首版草稿不被完成结果覆盖。
    const first = await admitExisting();
    assert.equal(first.frozenBase, null, "受理时无稿，冻结基准如实为 null");
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "手绘首帧说明", kind: "script", content: { format: "markdown", text: "# 手绘首帧\n构图与镜头说明。" } }],
        reviewGroups: [{ workId, group: { mode: "existing", groupId },
          items: [{ item: { mode: "existing", itemId: emptyItemId }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const }] }] })]),
      fauxAssistantMessage("首版说明已交付。"),
    ], "先给这版首帧补一份说明稿。");
    const delivered = itemOf(world, groupId, emptyItemId).draft;
    assert.ok(delivered?.kind === "artifact_revision", "在途交付把空项推进为首版草稿");
    const doneFirst = await drive(world, first.runId);
    assert.equal(doneFirst.state, "succeeded", "运行本身成功");
    const kept = itemOf(world, groupId, emptyItemId).draft;
    assert.ok(kept?.kind === "artifact_revision" && kept.revisionId === delivered.revisionId,
      "S4：null 基准只在完成时仍为空才落位，在途首版草稿不被覆盖");
    assert.equal(doneFirst.outputRevisions.length, 1, "未落位的运行产出仍保留可查看");

    // B：已有稿时省略基准，受理仍从真实草稿冻结；完成仍等于该基准才落位。
    const second = await admitExisting();
    assert.equal(second.frozenBase, delivered.revisionId, "省略 baseRevisionId 不当作此前无稿，冻结受理时真实草稿");
    const doneSecond = await drive(world, second.runId);
    assert.equal(doneSecond.state, "succeeded");
    const landed = itemOf(world, groupId, emptyItemId).draft;
    assert.ok(landed?.kind === "artifact_revision" && landed.revisionId === doneSecond.outputRevisions[0]!.revisionId,
      "基准未前进时结果正常落位为当前草稿");

    // C：显式给出的已读基准与当前事实不符，受理如实拒绝，不悄悄接受后覆盖。
    const runsBefore = count(world, "FROM production_runs");
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }), baseRevisionId: delivered.revisionId,
          target: { group: { mode: "existing" as const, groupId }, item: { mode: "existing" as const, itemId: emptyItemId } } }] })]),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        assert.equal(result.isError, true, text);
        assert.match(text, /草稿已不是给出的基准版本/);
        return fauxAssistantMessage("需要基于当前版本重新发起。");
      },
    ], "基于旧版说明再渲一版。");
    assert.equal(count(world, "FROM production_runs"), runsBefore, "显式错基准不建运行");
  } finally { await world.close(); }
});

it("G2-3 取消：排队中的本地运行可取消，取消后不产出", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧图片", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [draftImageOperation({ artifactId, revisionId })] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "生成首帧。");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string; revision: number };
    const artifactsBefore = count(world, "FROM artifacts WHERE kind='image'");

    const cancel = world.runtime.production!.cancel("local-owner", runRow.id, { commandId: cmd(), expectedRevision: runRow.revision });
    assert.equal(cancel.cancellation, "requested");
    const result = await drive(world, runRow.id);
    assert.equal(result.state, "cancelled");
    assert.equal(count(world, "FROM artifacts WHERE kind='image'"), artifactsBefore, "取消后不产出媒体产物");
    assert.equal(result.outputRevisions.length, 0);
  } finally { await world.close(); }
});

// G3-2 程序音乐：原创音效由 Skill/原生工具写代码生成，经冻结工程渲染登记为 audio 草稿。
// 16-bit PCM WAV（8000Hz 单声道 2 秒正弦）纯 node 生成，不用外部合成服务。
const chimeScript = `const fs = require("fs");
const rate = 8000, seconds = 2, samples = rate * seconds;
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 9000), i * 2);
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(data.length, 40);
fs.writeFileSync("output.wav", Buffer.concat([header, data]));
`;

it("G3-2 程序音效：代码生成 WAV 经冻结工程渲染登记为 audio 草稿", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "城市配乐" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "chime.cjs", content: chimeScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node chime.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "配乐工程", files: ["chime.cjs"],
        entrypoint: { argv: ["node", "chime.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "写一段程序音效并封存。");
    const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project");
    assert.ok(project, "应产出 project 产物");
    const projectRef = { artifactId: project.id, revisionId: project.revisionId };

    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "配乐草稿", scope: "程序音效", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "sfx-1", outputSlot: "audio-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: projectRef,
            entrypoint: { argv: ["node", "chime.cjs"] }, outputPath: "output.wav",
            expectedMediaKind: "audio", format: "wav", sampleRate: 8000, channels: 1 },
          target: { group: { mode: "create", key: "sound", title: "声音", nextIntent: null },
            item: { mode: "create", key: "chime", label: "程序音效", role: "music", required: true } } }] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "渲染程序音效。");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    const result = await drive(world, runRow.id);
    assert.equal(result.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.equal(item.role, "music");
    assert.ok(item.draft?.kind === "artifact_revision", "音效落为事项主稿");
    assert.equal(item.draft.revisionId, result.outputRevisions[0]!.revisionId);
    const media = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", item.draft.revisionId) as { mimeType: string; durationMs: number | null; blobId: string };
    assert.equal(media.mimeType, "audio/wav");
    assert.ok(media.durationMs! > 1500 && media.durationMs! < 2500, `时长应约 2 秒：${media.durationMs}`);
    const blob = world.blobs.get("local-owner", media.blobId);
    world.blobs.verify(blob);
    const artifactKind = (world.runtime.database.prepare("SELECT a.kind AS kind FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.id WHERE r.id=?")
      .get(item.draft.revisionId) as { kind: string }).kind;
    assert.equal(artifactKind, "audio", "产出登记为 audio 初稿");
  } finally { await world.close(); }
});

it("G3-3 精准修改：数据图表局部改代码重渲染为新修订，旧稿保留", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "数据图表", scope: "首版图表", purpose: "draft",
        inputSources: [], reviewInputs: [], operations: [draftImageOperation({ artifactId, revisionId })] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "生成首版图表。");
    const firstRun = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string };
    const first = await drive(world, firstRun.id);
    assert.equal(first.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", first.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision");
    const firstDraft = item.draft;
    const firstMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", firstDraft.revisionId) as { blobId: string };
    const firstDigest = world.blobs.get("local-owner", firstMedia.blobId).digest;

    // 精准修改：只改配色的局部代码，试跑后基于 v1 封存 v2 工程修订（baseRevisionId 防并发覆盖）。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: chartScript(200, 60, 60) })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, artifactId, baseRevisionId: revisionId, title: "动画工程",
        files: ["main.cjs"], entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("v2 工程已冻结。"),
    ], "配色改成暖红再封存一版。");
    const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(entry => entry.kind === "project")!;
    assert.notEqual(project.revisionId, revisionId, "封存推进了工程修订");
    const secondRevision = project.revisionId;

    // 重渲染绑定新工程修订；target 落在同一事项，旧稿不被删除。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "数据图表", scope: "暖红配色", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId: secondRevision }),
          target: { group: { mode: "existing", groupId: target.groupId }, item: { mode: "existing", itemId: target.itemId } } }] })]),
      fauxAssistantMessage("v2 渲染已受理。"),
    ], "重渲染暖红版。");
    const secondRun = world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    const second = await drive(world, secondRun.id);
    assert.equal(second.state, "succeeded");
    const after = itemOf(world, target.groupId, target.itemId);
    const afterDraft = after.draft;
    assert.ok(afterDraft?.kind === "artifact_revision");
    assert.notEqual(afterDraft.revisionId, firstDraft.revisionId, "主稿推进到 v2 渲染");
    const secondMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", afterDraft.revisionId) as { blobId: string };
    assert.notEqual(world.blobs.get("local-owner", secondMedia.blobId).digest, firstDigest, "新产物字节确有变化");
    // 旧稿修订仍完整可读（对比与回退的基础），v2 运行的输出修订包含新主稿。
    assert.ok(world.runtime.service.readRevision("local-owner", firstDraft.artifactId, firstDraft.revisionId), "旧稿修订保留可读");
    assert.ok(second.outputRevisions.some(ref => ref.revisionId === afterDraft.revisionId), "v2 运行输出包含新主稿修订");
    const binding = jsonField(world, "SELECT creation_binding_json FROM artifact_revisions WHERE id=?", "creation_binding_json", afterDraft.revisionId);
    assert.equal(binding.itemId, target.itemId, "v2 仍落位同一事项");
  } finally { await world.close(); }
});

it("G3-3 部分认可：一组两事项只认可一项，另一项不代填", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "角色短片" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    // 同一组交付两个事项：角色设定与场景设定；用户只认可角色。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "角色设定", kind: "script", content: { format: "markdown", text: "# 角色\n主角：红色雨衣，走路轻快。" } },
        { mode: "create", title: "场景设定", kind: "script", content: { format: "markdown", text: "# 场景\n清晨天桥，地面湿滑。" } }],
        reviewGroups: [{ workId, group: { mode: "create", key: "design-group", title: "设定组", nextIntent: null },
          items: [
            { item: { mode: "create", key: "character", label: "角色", role: "character", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" },
            { item: { mode: "create", key: "scene", label: "场景", role: "scene", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("设定已交付。"),
    ], "给角色和场景设定。");
    const group = works(world).flatMap(work => work.reviewGroups).find(entry => entry.items.some(item => item.role === "character"))!;
    const character = group.items.find(item => item.role === "character")!;
    const scene = group.items.find(item => item.role === "scene")!;
    assert.ok(character.draft?.kind === "artifact_revision" && scene.draft?.kind === "artifact_revision");

    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("认可角色，场景再改改", {
      reviewConfirmation: { workId, groupId: group.id, items: [{ itemId: character.id, source: character.draft }], action: "approve" },
    }));
    const approved = itemOf(world, group.id, character.id);
    const pending = itemOf(world, group.id, scene.id);
    assert.ok(approved.confirmationId, "被认可项有真实确认 ID");
    assert.ok(approved.approved, "被认可项记录了认可来源");
    assert.equal(pending.confirmationId, null, "未认可项不被一键代填");
    assert.equal(pending.approved, null, "未认可项没有认可来源");
    const firstConfirmation = approved.confirmationId;

    // 后续单独认可场景：角色项的既有确认保持不变，不重复、不重置。
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("场景这版也行", {
      reviewConfirmation: { workId, groupId: group.id, items: [{ itemId: scene.id, source: scene.draft }], action: "approve" },
    }));
    const laterCharacter = itemOf(world, group.id, character.id);
    const laterScene = itemOf(world, group.id, scene.id);
    assert.equal(laterCharacter.confirmationId, firstConfirmation, "逐项推进不改动既有确认");
    assert.ok(laterScene.confirmationId && laterScene.confirmationId !== firstConfirmation, "场景获得自己的确认");
  } finally { await world.close(); }
});

// S7（AUDIT-07）：多作品会话的原生工作区接线。全程走产品消息路径（sendMessage/faux 工具调用），
// 不在测试里改 CreativeToolContext；文件事实直接读宿主替身的真实工作区目录。
it("S7 工作区接线：start_work 激活本回合、read_work activate 显式切换并立即生效、默认只读不切、steering 不回退原 target", async () => {
  const world = await setup(); try {
    const workspaceFile = (workId: string, file: string) => path.join(
      world.directory, "creative-host", creativeWorkspaceId(editingWorkspace(world.conversationId, workId)), "workspace", file);
    const absent = async (file: string) => { await assert.rejects(access(file)); };

    // 回合 1：普通消息 start A 并写入——新 work 建立即为本回合工作区。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "作品A" })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "A-one" })]),
      fauxAssistantMessage("A 已建立。"),
    ], "正式开始作品A。");
    const workA = works(world).find(work => work.title === "作品A")!;
    assert.ok(workA);
    assert.equal(await readFile(workspaceFile(workA.id, "a.txt"), "utf8"), "A-one");

    // A 有一份内容稿，供后续消息 target 引用。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "A 的设定", kind: "script", content: { format: "markdown", text: "# A\n第一版设定。" } }],
        reviewGroups: [{ workId: workA.id, group: { mode: "create", key: "content", title: "内容", nextIntent: null },
          items: [{ item: { mode: "create", key: "setting", label: "设定", role: "content", required: true },
            itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("设定已交付。"),
    ], "给 A 一份设定。");
    const setting = works(world).find(work => work.id === workA.id)!.reviewGroups[0]!.items[0]!;
    const settingSource = setting.draft;
    assert.ok(settingSource?.kind === "artifact_revision", "A 的设定稿已落组");

    // 诊断输入只用于判别两种投影；真实库选材/准备入口在下方来源6/7旅程覆盖。
    world.runtime.database.prepare("INSERT INTO library_input_preparations(work_id,source_key,path,prepared_at) VALUES(?,?,?,?)")
      .run(workA.id, "fixture-A", "inputs/library/A/scene.png", systemClock());
    const uniqueContexts: TranscriptContext[] = [];
    await send(world, [context => { uniqueContexts.push(context); return fauxAssistantMessage("继续看 A。"); }]);
    assert.deepEqual(currentState(uniqueContexts[0]!).libraryInputs.map(input => input.path), ["inputs/library/A/scene.png"], "无 target 的唯一作品回合仍披露其已准备输入");

    // 回合 2：普通消息 start B 并写入——两条创作并存时，start 建立的 B 是本回合工作区，A/B 文件隔离。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "作品B" })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "b.txt", content: "B-one" })]),
      fauxAssistantMessage("B 已建立。"),
    ], "正式开始作品B。");
    const workB = works(world).find(work => work.title === "作品B")!;
    assert.ok(workB);
    assert.equal(works(world).length, 2);
    assert.equal(await readFile(workspaceFile(workB.id, "b.txt"), "utf8"), "B-one");
    await absent(workspaceFile(workA.id, "b.txt"));
    await absent(workspaceFile(workB.id, "a.txt"));
    world.runtime.database.prepare("INSERT INTO library_input_preparations(work_id,source_key,path,prepared_at) VALUES(?,?,?,?)")
      .run(workB.id, "fixture-B", "inputs/library/B/scene.png", systemClock());

    // 回合 3：默认 read_work 不切目标（写入被拦）；read_work(A, activate: true) 显式切回 A 后可修改 A。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("read_work", { workId: workB.id })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "b2.txt", content: "must-fail" })]),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        assert.equal(result.isError, true, "默认 read_work 只读，不改变写入目标");
        assert.match(text, /尚未明确作品/);
        return fauxAssistantMessage("需要先明确作品。");
      },
    ], "看看 B 的资料并随手改一笔。");
    await absent(workspaceFile(workB.id, "b2.txt"));

    await send(world, [
      fauxAssistantMessage([fauxToolCall("read_work", { workId: workA.id, activate: true })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "A-two" })]),
      fauxAssistantMessage("已切回 A 修改。"),
    ], "回去改作品A。");
    assert.equal(await readFile(workspaceFile(workA.id, "a.txt"), "utf8"), "A-two");
    assert.equal(await readFile(workspaceFile(workB.id, "b.txt"), "utf8"), "B-one", "改 A 不动 B");

    // 回合 4：消息 target 指向 A 的设定稿，回合内 read_work(B, activate: true) 成功后
    // 立即原生写入——必须落在 B。原消息 target 只负责初始化，不能在每次原生调用时
    // 覆盖成功显式激活（§11.6 S7 主审复现场景：不靠 steering 消除 target 后才验证）。
    const activatedContexts: TranscriptContext[] = [];
    world.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("read_work", { workId: workB.id, activate: true })]),
      context => { activatedContexts.push(context); return fauxAssistantMessage([fauxToolCall("write", { path: "active.txt", content: "B-explicit" })]); },
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "B 的新草稿", kind: "script", content: { format: "markdown", text: "# B\n本回合的新草稿。" } }],
        reviewGroups: [{ workId: workB.id, group: { mode: "create", key: "content", title: "内容", nextIntent: null },
          items: [{ item: { mode: "create", key: "setting", label: "设定", role: "content", required: true },
            itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("已显式切到 B 并交付。"),
    ]);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("改为处理作品 B", {
      target: { artifactId: settingSource.artifactId, revisionId: settingSource.revisionId, workId: workA.id },
    }));
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId, null, "回合应已结束");
    assert.equal(await readFile(workspaceFile(workB.id, "active.txt"), "utf8"), "B-explicit", "成功显式激活 B 后立即写入必须落在 B");
    await absent(workspaceFile(workA.id, "active.txt"));
    const activatedState = currentState(activatedContexts[0]!);
    assert.deepEqual(activatedState.libraryInputs.map(input => input.path), ["inputs/library/B/scene.png"], "编辑已切 B，模型素材路径同步切 B");
    assert.deepEqual(activatedState.target, { artifactId: settingSource.artifactId, revisionId: settingSource.revisionId, workId: workA.id }, "参考 A 与编辑 B 可以同时成立");
    assert.deepEqual(activatedState.referencedWorkIds, [workA.id]);
    const settingB = works(world).find(work => work.id === workB.id)!.reviewGroups[0]!.items[0]!;
    assert.ok(settingB.draft?.kind === "artifact_revision", "B 的新草稿经过正式交付落组");
    assert.deepEqual(works(world).find(work => work.id === workA.id)!.reviewGroups[0]!.items[0]!.draft, settingSource, "交付 B 不改 A 的原稿");

    // 后续用户明确回到 A：写入与 revise 的准确对象仍由这条消息授权。
    const backContexts: TranscriptContext[] = [];
    world.runtime.host.faux!.setResponses([
      context => { backContexts.push(context); return fauxAssistantMessage([fauxToolCall("write", { path: "back.txt", content: "A-again" })]); },
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "revise", artifactId: settingSource.artifactId, baseRevisionId: settingSource.revisionId,
          title: "A 的设定", kind: "script", content: { format: "markdown", text: "# A\n用户明确回到 A 后修改。" } }] })]),
      fauxAssistantMessage("已回到 A。"),
    ]);
    const back = await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("修改 A 的这份设定", {
      target: { artifactId: settingSource.artifactId, revisionId: settingSource.revisionId, workId: workA.id },
    }));
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((world.runtime.database.prepare("SELECT state FROM requests WHERE id=?").get(back.receipt.requestId) as { state: string }).state, "completed");
    assert.deepEqual(currentState(backContexts[0]!).libraryInputs.map(input => input.path), ["inputs/library/A/scene.png"]);
    assert.equal(await readFile(workspaceFile(workA.id, "back.txt"), "utf8"), "A-again");
    await absent(workspaceFile(workB.id, "back.txt"));
    assert.notEqual(world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.id === settingSource.artifactId)!.revisionId, settingSource.revisionId, "用户指向的 A 稿正式修订成功");

    // 回合 5：steering 改目标。消息 target 指向 A 的设定稿；回合中 read_work(B, activate) 显式激活 B；
    // steering 被原生接收后动作来源换成 steering 消息（无 target），不得回退 request.target 把写入拉回 A。
    let releaseSteer!: () => void;
    const steerGate = new Promise<void>(resolve => { releaseSteer = resolve; });
    let steerWindow = false;
    const steeringContexts: TranscriptContext[] = [];
    world.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("read_work", { workId: workB.id, activate: true })]),
      async () => { steerWindow = true; await steerGate; return fauxAssistantMessage([fauxToolCall("read_work", { workId: workB.id })]); },
      context => {
        steeringContexts.push(context);
        return fauxAssistantMessage([fauxToolCall("write", { path: "steer.txt", content: "into-B" })]);
      },
      fauxAssistantMessage("已按补充写入 B。"),
    ]);
    const turn = await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("继续处理作品", {
      target: { artifactId: settingSource.artifactId, revisionId: settingSource.revisionId, workId: workA.id },
    }));
    const requestId = turn.receipt.requestId;
    for (let i = 0; i < 300 && !steerWindow; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(steerWindow, "第二轮模型调用已开始（激活 B 已执行）");
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("补充：接下来写到作品B", {
      mode: "steer", steerRequestId: requestId,
    }));
    releaseSteer();
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId, null, "回合应已结束");
    assert.equal(await readFile(workspaceFile(workB.id, "steer.txt"), "utf8"), "into-B", "steering 后写入落在显式激活的 B");
    await absent(workspaceFile(workA.id, "steer.txt"));
    assert.ok(JSON.stringify(steeringContexts[0]!.messages).includes("补充：接下来写到作品B"), "steering 真实进入当前回合上下文");
    const steeringState = currentState(steeringContexts[0]!);
    assert.equal(steeringState.target, null, "已消费的无 target steering 不再冒用初始 target A");
    assert.deepEqual(steeringState.referencedWorkIds, [], "feedback 投影不经旧 target 重新引用 A");
    assert.deepEqual(steeringState.libraryInputs.map(input => input.path), ["inputs/library/B/scene.png"]);
    const originalTarget = world.runtime.database.prepare("SELECT target_json FROM messages WHERE id=?").get(turn.receipt.messageId) as { target_json: string };
    assert.deepEqual(JSON.parse(originalTarget.target_json), { artifactId: settingSource.artifactId, revisionId: settingSource.revisionId, workId: workA.id }, "投影更新不改写原消息引用");
  } finally { await world.close(); }
});

// 3 秒走路预览工程：ffmpeg testsrc2 生成 160x90@4fps 的 3 秒 MP4（宿主替身经 /bin/sh 执行，ffmpeg 在 PATH）。
const walkPreviewScript = `const { execFileSync } = require("child_process");
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=duration=3:size=160x90:rate=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "out.mp4"], { stdio: "ignore" });
`;

it("G3-3 阶段退出：角色认可、场景未认可时 3 秒预览可受理执行且认可不推进", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "走路预览" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "预览工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "封存走路预览工程。");
    const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project")!;
    assert.ok(project);

    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "角色设定", kind: "script", content: { format: "markdown", text: "# 角色\n红色雨衣主角。" } },
        { mode: "create", title: "场景设定", kind: "script", content: { format: "markdown", text: "# 场景\n清晨天桥。" } }],
        reviewGroups: [{ workId, group: { mode: "create", key: "design", title: "设定", nextIntent: null },
          items: [
            { item: { mode: "create", key: "character", label: "角色", role: "character", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" },
            { item: { mode: "create", key: "scene", label: "场景", role: "scene", required: true }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("设定已交付。"),
    ], "给角色和场景设定。");
    const group = works(world).flatMap(work => work.reviewGroups).find(entry => entry.items.some(item => item.role === "character"))!;
    const character = group.items.find(item => item.role === "character")!;
    const scene = group.items.find(item => item.role === "scene")!;
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("角色认可，场景还没定", {
      reviewConfirmation: { workId, groupId: group.id, items: [{ itemId: character.id, source: character.draft }], action: "approve" },
    }));
    const characterConfirmation = itemOf(world, group.id, character.id).confirmationId;
    assert.ok(characterConfirmation);

    // 场景未认可不阻塞预览：3 秒走路预览按 draft 受理并执行完成。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "3 秒走路预览", scope: "角色走路预览", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "walk-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId: project.id, revisionId: project.revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.mp4",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
            item: { mode: "create", key: "walk-preview", label: "走路预览", role: "video", required: true } } }] })]),
      fauxAssistantMessage("预览已受理。"),
    ], "先出 3 秒走路预览。");
    assert.equal(count(world, "FROM production_runs"), 1, "预览按 draft 受理建 run");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string };
    const result = await drive(world, runRow.id);
    assert.equal(result.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision", "预览落为事项主稿");
    const media = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", item.draft.revisionId) as { mimeType: string; durationMs: number | null };
    assert.equal(media.mimeType, "video/mp4");
    assert.ok(media.durationMs! >= 2500 && media.durationMs! <= 3500, `预览时长应约 3 秒：${media.durationMs}`);

    // 完成不推进认可：角色保持原确认，场景仍无确认（§4.2.1 在途只约束新制作受理）。
    assert.equal(itemOf(world, group.id, character.id).confirmationId, characterConfirmation, "角色认可不被重置或重复");
    assert.equal(itemOf(world, group.id, scene.id).confirmationId, null, "场景仍未被认可");
    assert.equal(itemOf(world, group.id, scene.id).approved, null);
  } finally { await world.close(); }
});

it("G4-2 跨会话选材工程文件：文本共享 blob 文件卡、媒体共享 blob，清单外拒绝", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "走路预览" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScript })]),
      // S3 后输出 out.mp4 不进封存清单；工程里的媒体资源以独立文件 sample.mp4 留存（输入素材，不是输出）。
      // model.bin 是真二进制输入资源：来源5 后不再默认 utf8 转文稿，保留原字节。
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs && cp out.mp4 sample.mp4 && node -e \"require('fs').writeFileSync('model.bin', Buffer.from([0,159,3,255,10,13]))\"", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "预览工程", files: ["main.cjs", "sample.mp4", "model.bin"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "封存走路预览工程。");
    const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project")!;
    assert.ok(project);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "3 秒走路预览", scope: "角色走路预览", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "walk-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId: project.id, revisionId: project.revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.mp4",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
            item: { mode: "create", key: "walk-preview", label: "走路预览", role: "video", required: true } } }] })]),
      fauxAssistantMessage("预览已受理。"),
    ], "先出 3 秒走路预览。");
    const runId = (world.runtime.database.prepare("SELECT id FROM production_runs").get() as { id: string }).id;
    const result = await drive(world, runId);
    assert.equal(result.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision");
    const draft = item.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const draftRevision = world.runtime.service.readRevision("local-owner", draft.artifactId, draft.revisionId);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("这版定稿", {
      reviewConfirmation: { workId, groupId: target.groupId,
        items: [{ itemId: target.itemId, source: { kind: "artifact_revision", artifactId: draft.artifactId, revisionId: draft.revisionId, digest: draftRevision.digest } }],
        action: "finalize_video" },
    }));

    // 作品库投影：定稿当时的封存工程与文件清单（准确 MIME）随之可见。
    const [entry] = world.runtime.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.ok(entry);
    assert.deepEqual(entry.project, { artifactId: project.id, revisionId: project.revisionId });
    assert.deepEqual(entry.projectFiles, [
      { project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "main.cjs", mimeType: "text/javascript" },
      { project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "sample.mp4", mimeType: "video/mp4" },
      { project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "model.bin", mimeType: "application/octet-stream" },
    ]);
    const projectContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?", "content_json", project.id, project.revisionId) as { files: { relativePath: string; blobId: string }[] };
    const mp4BlobId = projectContent.files.find(file => file.relativePath === "sample.mp4")!.blobId;
    const cjsBlobId = projectContent.files.find(file => file.relativePath === "main.cjs")!.blobId;
    const binBlobId = projectContent.files.find(file => file.relativePath === "model.bin")!.blobId;

    // 跨会话带入：文本/二进制/媒体工程文件都只共享 blob、不复制字节；非媒体保留原 MIME 与相对路径的文件卡（§11.7 来源5）。
    const other = world.runtime.service.createConversation("local-owner", { commandId: cmd(), title: "选材会话" }).conversation;
    const captured: unknown[] = [];
    world.runtime.host.faux!.setResponses([context => { captured.push(context.messages); return fauxAssistantMessage("收到工程文件。"); }]);
    const selections = [
      { sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "project_file" as const, project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "main.cjs" } },
      { sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "project_file" as const, project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "sample.mp4" } },
      { sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "project_file" as const, project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "model.bin" } },
    ];
    await world.runtime.service.sendMessage("local-owner", other.id, chatInput("按这份工程继续", { librarySelections: selections }));
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", other.id).activeRequestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const page = world.runtime.service.snapshot("local-owner", other.id);
    const userMessage = page.messages.items.find(message => message.role === "user" && message.text.includes("按这份工程"))!;
    assert.ok(userMessage);
    assert.deepEqual(userMessage.librarySelections, selections);
    assert.equal(userMessage.references.artifacts.length, 3);
    const [scriptRef, mediaRef, binRef] = userMessage.references.artifacts;
    assert.ok(scriptRef && mediaRef && binRef, "应恰有三个产物引用");
    const scriptHead = page.artifacts.items.find(head => head.id === scriptRef.artifactId)!;
    assert.equal(scriptHead.kind, "file");
    assert.ok(scriptHead.title.includes("main.cjs"));
    const scriptContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", scriptRef.revisionId) as { format: string; blobId: string; mimeType: string; path: string };
    assert.equal(scriptContent.format, "file");
    assert.equal(scriptContent.mimeType, "text/javascript");
    assert.equal(scriptContent.path, "main.cjs");
    assert.equal(scriptContent.blobId, cjsBlobId, "文本工程文件共享同一 blob，不复制字节");
    assert.equal(outputBytes(world, scriptRef.revisionId).toString(), walkPreviewScript, "按 blob 读回仍是原字节");
    assert.ok(Boolean(world.runtime.database.prepare("SELECT 1 FROM revision_blob_links WHERE revision_id=? AND blob_id=?").get(scriptRef.revisionId, cjsBlobId)), "共享 blob 应登记修订链接");
    const mediaHead = page.artifacts.items.find(head => head.id === mediaRef.artifactId)!;
    assert.equal(mediaHead.kind, "video");
    const mediaContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", mediaRef.revisionId) as { format: string; blobId: string; mimeType: string };
    assert.equal(mediaContent.format, "media");
    assert.equal(mediaContent.mimeType, "video/mp4");
    assert.equal(mediaContent.blobId, mp4BlobId, "媒体工程文件共享同一 blob，不复制字节");
    assert.ok(Boolean(world.runtime.database.prepare("SELECT 1 FROM revision_blob_links WHERE revision_id=? AND blob_id=?").get(mediaRef.revisionId, mp4BlobId)), "共享 blob 应登记修订链接");
    const binHead = page.artifacts.items.find(head => head.id === binRef.artifactId)!;
    assert.equal(binHead.kind, "file");
    const binContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", binRef.revisionId) as { format: string; blobId: string; mimeType: string; path: string };
    assert.equal(binContent.format, "file");
    assert.equal(binContent.mimeType, "application/octet-stream");
    assert.equal(binContent.path, "model.bin");
    assert.equal(binContent.blobId, binBlobId, "二进制工程文件共享同一 blob，不复制字节");
    assert.deepEqual([...outputBytes(world, binRef.revisionId)], [0, 159, 3, 255, 10, 13], "按 blob 读回仍是原始二进制字节");
    assert.ok(Boolean(world.runtime.database.prepare("SELECT 1 FROM revision_blob_links WHERE revision_id=? AND blob_id=?").get(binRef.revisionId, binBlobId)), "共享 blob 应登记修订链接");
    assert.ok(JSON.stringify(captured[0]).includes("librarySelections"), "currentContext 应披露库选材");

    // 清单外路径拒绝：封存工程里没有 notes.md。
    const rejection = (send: () => unknown): Promise<Error> => {
      try {
        return Promise.resolve(send()).then(() => { throw new Error("应当被拒绝"); }, error => error as Error);
      } catch (error) {
        return Promise.resolve(error as Error);
      }
    };
    const outside = await rejection(() => world.runtime.service.sendMessage("local-owner", other.id, chatInput("再带 notes", {
      librarySelections: [{ sourceVideo: { artifactId: draft.artifactId, revisionId: draft.revisionId },
        source: { kind: "project_file", project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "notes.md" } }],
    })));
    assert.match(outside.message, /不在定稿封存工程清单里/);
  } finally { await world.close(); }
});

// §11.7 来源6/7 输入准备的五情形共用一段前置：会话 A 定稿一个带 main.cjs/sample.mp4 的工程；
// 之后在会话 B 按不同节奏明确作品，断言 inputs/library/ 只在作品明确后按原字节落位一次。
it("§11.7 来源6/7 库选材输入准备：start/activate 后原字节落位、幂等不覆盖用户编辑、默认只读不写、无作品不写、上下文披露", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "走路预览" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs && cp out.mp4 sample.mp4", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "预览工程", files: ["main.cjs", "sample.mp4"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "封存走路预览工程。");
    const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project")!;
    assert.ok(project);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "3 秒走路预览", scope: "角色走路预览", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "walk-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId: project.id, revisionId: project.revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.mp4",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
            item: { mode: "create", key: "walk-preview", label: "走路预览", role: "video", required: true } } }] })]),
      fauxAssistantMessage("预览已受理。"),
    ], "先出 3 秒走路预览。");
    const runId = (world.runtime.database.prepare("SELECT id FROM production_runs").get() as { id: string }).id;
    const result = await drive(world, runId);
    assert.equal(result.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision");
    const draft = item.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const draftRevision = world.runtime.service.readRevision("local-owner", draft.artifactId, draft.revisionId);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("这版定稿", {
      reviewConfirmation: { workId, groupId: target.groupId,
        items: [{ itemId: target.itemId, source: { kind: "artifact_revision", artifactId: draft.artifactId, revisionId: draft.revisionId, digest: draftRevision.digest } }],
        action: "finalize_video" },
    }));
    const projectContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?", "content_json", project.id, project.revisionId) as { files: { relativePath: string; blobId: string }[] };
    const mp4BlobId = projectContent.files.find(file => file.relativePath === "sample.mp4")!.blobId;
    const mp4Bytes = readFileSync(world.blobs.filePath(world.blobs.get("local-owner", mp4BlobId).digest));
    const cjsSourceKey = `project:${project.id}:${project.revisionId}:main.cjs`;

    // 会话 B：先发选材但模型不明确任何作品——无作品可写，不落任何输入。
    const other = world.runtime.service.createConversation("local-owner", { commandId: cmd(), title: "输入准备会话" }).conversation;
    const sourceVideo = { artifactId: draft.artifactId, revisionId: draft.revisionId };
    const sendIn = async (steps: Parameters<typeof send>[1], input?: ReturnType<typeof chatInput>) => {
      world.runtime.host.faux!.setResponses(steps);
      const sent = await world.runtime.service.sendMessage("local-owner", other.id, input ?? chatInput("请处理"));
      for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", other.id).activeRequestId; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return sent.receipt;
    };
    await sendIn([fauxAssistantMessage("收到，先不动。")], chatInput("先带素材", {
      librarySelections: [{ sourceVideo, source: { kind: "project_file" as const, project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "main.cjs" } }],
    }));
    assert.equal(count(world, "FROM library_input_preparations"), 0, "无明确作品不写任何输入");

    // 同回合明确作品：选材消息触发的回合里 start_work 立即按原字节落位。
    await sendIn([
      fauxAssistantMessage([fauxToolCall("start_work", { title: "改编这条" })]),
      fauxAssistantMessage("已开始，素材就位。"),
    ]);
    const adaptedWork = world.runtime.service.snapshot("local-owner", other.id).works[0]!;
    assert.ok(adaptedWork);
    const prepared = world.runtime.database.prepare("SELECT source_key, path FROM library_input_preparations WHERE work_id=?")
      .all(adaptedWork.id) as { source_key: string; path: string }[];
    assert.deepEqual(prepared.map(row => row.source_key), [cjsSourceKey], "start_work 后已发送选材立即准备");
    assert.deepEqual(prepared.map(row => row.path), [`inputs/library/${project.revisionId}/main.cjs`]);
    const workspaceDir = path.join(world.directory, "creative-host", creativeWorkspaceId(editingWorkspace(other.id, adaptedWork.id)), "workspace");
    assert.equal(readFileSync(path.join(workspaceDir, "inputs/library", project.revisionId, "main.cjs")).toString(), walkPreviewScript, "原字节落位，不是 utf8 改写");
    const uniqueContexts: TranscriptContext[] = [];
    await sendIn([context => { uniqueContexts.push(context); return fauxAssistantMessage("查看已准备的素材。"); }]);
    assert.deepEqual(currentState(uniqueContexts[0]!).libraryInputs.map(input => input.path), [`inputs/library/${project.revisionId}/main.cjs`], "真实库入口准备的输入在唯一作品无 target 回合可见");

    // 后继选材消息不指向作品：默认只读 read_work 不写入；activate 后才准备。
    await sendIn([fauxAssistantMessage("收到，先不动。")], chatInput("再带一段", {
      librarySelections: [{ sourceVideo, source: { kind: "project_file" as const, project: { artifactId: project.id, revisionId: project.revisionId }, relativePath: "sample.mp4" } }],
    }));
    assert.equal(count(world, "FROM library_input_preparations WHERE work_id=?", adaptedWork.id), 1, "消息不指向作品时不准备");
    await sendIn([
      fauxAssistantMessage([fauxToolCall("read_work", { workId: adaptedWork.id, activate: false })]),
      fauxAssistantMessage("只读确认。"),
    ]);
    assert.equal(count(world, "FROM library_input_preparations WHERE work_id=?", adaptedWork.id), 1, "默认只读 read_work 不写入");
    const captured: unknown[] = [];
    await sendIn([
      fauxAssistantMessage([fauxToolCall("read_work", { workId: adaptedWork.id, activate: true })]),
      context => { captured.push(context.messages); return fauxAssistantMessage("已切到这条，输入已就位。"); },
    ]);
    const preparedAfter = world.runtime.database.prepare("SELECT source_key, path FROM library_input_preparations WHERE work_id=?")
      .all(adaptedWork.id) as { source_key: string; path: string }[];
    assert.deepEqual(preparedAfter.map(row => row.path).sort(),
      [`inputs/library/${project.revisionId}/main.cjs`, `inputs/library/${project.revisionId}/sample.mp4`].sort(), "activate 后按已发送选材补齐");
    assert.deepEqual(readFileSync(path.join(workspaceDir, "inputs/library", project.revisionId, "sample.mp4")), mp4Bytes, "媒体素材按原字节落位");
    const transcript = JSON.stringify(captured[0]);
    assert.ok(transcript.includes("libraryInputs"), "currentContext 应披露输入位置");
    assert.ok(transcript.includes(`inputs/library/${project.revisionId}/main.cjs`), "披露的路径与实际落位一致");

    // 幂等：用户编辑已落位文件后再次 activate，不覆盖用户改动，也不重复记行。
    await sendIn([
      fauxAssistantMessage([fauxToolCall("bash", { command: `echo "// 用户已修改" > inputs/library/${project.revisionId}/main.cjs`, timeout: 10 })]),
      fauxAssistantMessage([fauxToolCall("read_work", { workId: adaptedWork.id, activate: true })]),
      fauxAssistantMessage("继续。"),
    ]);
    assert.equal(readFileSync(path.join(workspaceDir, "inputs/library", project.revisionId, "main.cjs")).toString(), "// 用户已修改\n", "重准备不覆盖用户编辑");
    assert.equal(count(world, "FROM library_input_preparations WHERE work_id=?", adaptedWork.id), 2, "同一（作品, 来源）只准备一次");
  } finally { await world.close(); }
});
const walkPreviewScriptV2 = `const { execFileSync } = require("child_process");
execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=duration=2:size=160x90:rate=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "out.mp4"], { stdio: "ignore" });
`;

it("G4-1 定稿事实冻结：finalize 只认最终视频，后继新稿/新工程不回写入库条目", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "走路预览" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "预览工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "封存走路预览工程。");
    const projectV1 = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(item => item.kind === "project")!;
    assert.ok(projectV1);

    // 局部预览从未独立认可：定稿仍允许，但只产生这一条认可事实，来源清单如实为空。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "3 秒走路预览", scope: "走路预览", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "walk-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId: projectV1.id, revisionId: projectV1.revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.mp4",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "create", key: "preview", title: "预览", nextIntent: null },
            item: { mode: "create", key: "walk-preview", label: "走路预览", role: "video", required: true } } }] })]),
      fauxAssistantMessage("预览已受理。"),
    ], "先出 3 秒走路预览。");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs").get() as { id: string };
    const first = await drive(world, runRow.id);
    assert.equal(first.state, "succeeded");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", first.snapshotId);
    const target = (spec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision");
    const draftV1 = item.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const draftRevisionV1 = world.runtime.service.readRevision("local-owner", draftV1.artifactId, draftV1.revisionId);
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("这版定稿", {
      reviewConfirmation: { workId, groupId: target.groupId,
        items: [{ itemId: target.itemId, source: { kind: "artifact_revision", artifactId: draftV1.artifactId, revisionId: draftV1.revisionId, digest: draftRevisionV1.digest } }],
        action: "finalize_video" },
    }));
    const confirmations = world.runtime.database.prepare(
      "SELECT action, COUNT(*) AS n FROM work_review_confirmations WHERE work_id=? GROUP BY action").all(workId) as { action: string; n: number }[];
    assert.deepEqual(confirmations, [{ action: "finalize_video", n: 1 }], "定稿只认可最终视频，不给素材凭空补认可");
    const [entryV1] = world.runtime.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.ok(entryV1);
    assert.equal(entryV1.video.revisionId, draftV1.revisionId);
    assert.deepEqual(entryV1.reviewSources, [], "来源清单标实际用途：draft 预览没有认可依据");
    assert.deepEqual(entryV1.project, { artifactId: projectV1.id, revisionId: projectV1.revisionId });

    // 后继修改：改短时长重新封存 v2 工程并重渲染同一事项。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScriptV2 })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, artifactId: projectV1.id, baseRevisionId: projectV1.revisionId,
        title: "预览工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("v2 工程已冻结。"),
    ], "改成 2 秒再封存一版。");
    const projectV2 = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items.find(entry => entry.kind === "project")!;
    assert.notEqual(projectV2.revisionId, projectV1.revisionId, "封存推进了工程修订");
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "走路预览", scope: "2 秒版", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "walk-2", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId: projectV2.id, revisionId: projectV2.revisionId },
            entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.mp4",
            expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
          target: { group: { mode: "existing", groupId: target.groupId }, item: { mode: "existing", itemId: target.itemId } } }] })]),
      fauxAssistantMessage("v2 渲染已受理。"),
    ], "重渲染 2 秒版。");
    const secondRun = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    const second = await drive(world, secondRun.id);
    assert.equal(second.state, "succeeded");
    const after = itemOf(world, target.groupId, target.itemId);
    assert.ok(after.draft?.kind === "artifact_revision" && after.draft.revisionId !== draftV1.revisionId, "事项主稿推进到 v2");

    // 新稿不回写已入库条目：库仍只有 v1，工程引用仍是定稿当时的 v1 修订，不重新封存最新目录。
    const entries = world.runtime.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.equal(entries.length, 1, "v2 草稿不入库");
    assert.equal(entries[0]!.video.revisionId, draftV1.revisionId);
    assert.deepEqual(entries[0]!.project, { artifactId: projectV1.id, revisionId: projectV1.revisionId });
    assert.deepEqual(entries[0]!.projectFiles, [
      { project: { artifactId: projectV1.id, revisionId: projectV1.revisionId }, relativePath: "main.cjs", mimeType: "text/javascript" },
    ], "S3：定稿工程只冻结源码清单，输出产物不混入封存文件");
  } finally { await world.close(); }
});

// S3（§11.6/V3）：输出位语义与执行权威判别。受理边界一次核对入口一致性、输出与封存文件/输入落位分离、
// operation_output 依赖关系（自指/成环/错槽在入口拒绝，不留永久排队 run）；执行边界核对镜像身份、
// argv 逐项直传、正常退出但无声明输出时如实失败不交付旧文件、同源码确定性重渲同字节合法。
it("S3 受理边界：入口与输出位一次核对，依赖图自指/成环/错槽被拒不建 run，两操作依赖链各自产出", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "受理边界" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: pngScript })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "notes.txt", content: "静态素材，随工程封存。" })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "边界工程", files: ["main.cjs", "notes.txt"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "封存带静态资产的工程。");
    const mainRef = latestProjectRevision(world);
    const seed = world.blobs.persist("local-owner", world.conversationId, makePng(210, 120, 90), "image/png", null);

    type OpInput = { kind: "blob"; blobId: string; digest: string } | { kind: "operation_output"; producerOperationId: string; outputSlot: string };
    const op = (overrides: { entrypoint?: { argv: string[] }; outputPath?: string } = {}, inputs: OpInput[] = []) => ({
      operationId: "frame-1", outputSlot: "image-1", inputs,
      parameters: { assembly: "code_project", projectRevision: mainRef,
        entrypoint: overrides.entrypoint ?? { argv: ["node", "main.cjs"] },
        outputPath: overrides.outputPath ?? "out.png",
        expectedMediaKind: "image", format: "png", width: 160, height: 90 },
      target: { group: { mode: "create", key: "visual", title: "画面", nextIntent: null },
        item: { mode: "create", key: "first-frame", label: "首帧图", role: "storyboard", required: true } },
    });
    const secondOp = (inputs: OpInput[] = [], outputPath = "out2.png") => ({
      operationId: "frame-2", outputSlot: "image-2", inputs,
      parameters: { assembly: "code_project", projectRevision: mainRef, entrypoint: { argv: ["node", "main.cjs"] },
        outputPath, expectedMediaKind: "image", format: "png", width: 160, height: 90 },
      target: { group: { mode: "create", key: "derived", title: "派生画面", nextIntent: null },
        item: { mode: "create", key: "second-frame", label: "第二帧", role: "storyboard", required: true } },
    });
    const reject = async (operations: ReturnType<typeof op>[], pattern: RegExp) => {
      await send(world, [
        fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "边界草稿", scope: "判别", purpose: "draft",
          inputSources: [], reviewInputs: [], operations })]),
        context => {
          const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
          const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
          assert.equal(result.isError, true, `受理应被拒绝：${text}`);
          assert.match(text, pattern);
          return fauxAssistantMessage("已被拒绝。");
        },
      ], "尝试受理。");
      assert.equal(count(world, "FROM production_runs"), 0, "被拒受理不留 run，也不留永久排队操作");
    };

    await reject([op({ entrypoint: { argv: ["node", "main.cjs", "--flag"] } })], /渲染入口与冻结工程不一致/);
    await reject([op({ outputPath: "notes.txt" })], /输出路径与封存文件同名/);
    await reject([op({ outputPath: "inputs/0.png" }, [{ kind: "blob", blobId: seed.id, digest: seed.digest }])], /输入文件落位同名/);
    await reject([op({}, [{ kind: "operation_output", producerOperationId: "frame-1", outputSlot: "image-1" }])], /操作依赖不能循环/);
    await reject([op(), secondOp([{ kind: "operation_output", producerOperationId: "frame-1", outputSlot: "missing-slot" }])], /真实输出槽/);
    await reject([op({}, [{ kind: "operation_output", producerOperationId: "frame-2", outputSlot: "image-2" }]),
      secondOp([{ kind: "operation_output", producerOperationId: "frame-1", outputSlot: "image-1" }])], /操作依赖不能循环/);

    // 合法依赖链：第二操作以 operation_output 消费第一操作产物（物化到自己的输入槽 inputs/0.png，不经共享目录）。
    const passthroughScript = `const fs = require("fs");
if (fs.existsSync("inputs/0.png")) {
  if (fs.statSync("inputs/0.png").size === 0) process.exit(3);
  fs.copyFileSync("inputs/0.png", "out2.png");
} else {
  fs.writeFileSync("out2.png", Buffer.alloc(0));
}
`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "passthrough.cjs", content: passthroughScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node passthrough.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "复用工程", files: ["passthrough.cjs"],
        entrypoint: { argv: ["node", "passthrough.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("复用工程已冻结。"),
    ], "封存复用工程。");
    const passthroughRef = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "链式草稿", scope: "两步", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [op(),
          { operationId: "copy-1", outputSlot: "image-2",
            inputs: [{ kind: "operation_output", producerOperationId: "frame-1", outputSlot: "image-1" }],
            parameters: { assembly: "code_project", projectRevision: passthroughRef, entrypoint: { argv: ["node", "passthrough.cjs"] },
              outputPath: "out2.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
            target: { group: { mode: "create", key: "derived", title: "派生画面", nextIntent: null },
              item: { mode: "create", key: "copied-frame", label: "复用帧", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("链式渲染已受理。"),
    ], "两步链式渲染。");
    assert.equal(count(world, "FROM production_runs"), 1);
    const runRow = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    const chained = await drive(world, runRow.id);
    assert.equal(chained.state, "succeeded");
    assert.equal(chained.outputRevisions.length, 2, "两操作各自产出");
    const firstBytes = outputBytes(world, chained.outputRevisions[0]!.revisionId);
    assert.ok(firstBytes.length > 0);
    assert.ok(outputBytes(world, chained.outputRevisions[1]!.revisionId).equals(firstBytes), "第二操作真实消费了第一操作的物化输入（字节一致）");
    // 同 run 两操作各用 run+operation 独立工作区执行（§11.6 S3），不共享目录。
    const frameWorkspace = creativeWorkspaceId({ conversationId: world.conversationId, workId, executionId: `${runRow.id}:frame-1` });
    const copyWorkspace = creativeWorkspaceId({ conversationId: world.conversationId, workId, executionId: `${runRow.id}:copy-1` });
    assert.deepEqual(world.host.executions.filter(e => e.workspaceId === frameWorkspace).map(e => e.argv),
      [["node", "main.cjs"]], "frame-1 在自己的冻结工作区执行");
    assert.deepEqual(world.host.executions.filter(e => e.workspaceId === copyWorkspace).map(e => e.argv),
      [["node", "passthrough.cjs"]], "copy-1 在独立工作区执行，不经共享目录读前序产物");
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", chained.snapshotId) as { operations: { target: { groupId: string; itemId: string } }[] };
    for (const operation of spec.operations) {
      assert.ok(itemOf(world, operation.target.groupId, operation.target.itemId).draft?.kind === "artifact_revision", "两操作产物各自落位");
    }

    // 零输出如实失败（§11.6 S3 / 主审复现场景）：合法冻结的静默工程正常退出但不产生声明输出。
    // 第二操作与第一操作同名 out.png——同名路径合法受理（不限制独立工程各用 out.mp4），
    // 但两个操作各在自己的工作区，第二个操作读不到第一个操作的产物，不能冒充本次输出。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "silent.cjs", content: "console.log(\"done without output\");\n" })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "零输出工程", files: ["silent.cjs"],
        entrypoint: { argv: ["node", "silent.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("零输出工程已冻结。"),
    ], "封存零输出工程。");
    const silentRef = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "同名输出", scope: "两操作同名 out.png", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "frame-3", outputSlot: "image-3", inputs: [],
            parameters: { assembly: "code_project", projectRevision: mainRef,
              entrypoint: { argv: ["node", "main.cjs"] }, outputPath: "out.png",
              expectedMediaKind: "image", format: "png", width: 160, height: 90 },
            target: { group: { mode: "create", key: "visual3", title: "画面三", nextIntent: null },
              item: { mode: "create", key: "third-frame", label: "第三帧", role: "storyboard", required: true } } },
          { operationId: "silent-1", outputSlot: "image-4", inputs: [],
            parameters: { assembly: "code_project", projectRevision: silentRef, entrypoint: { argv: ["node", "silent.cjs"] },
              outputPath: "out.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
            target: { group: { mode: "create", key: "silent", title: "静默组", nextIntent: null },
              item: { mode: "create", key: "silent-frame", label: "静默帧", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("同名输出已受理。"),
    ], "两操作同名输出受理。");
    assert.equal(count(world, "FROM production_runs"), 2, "同名输出路径合法受理，不因跨操作重名被拒");
    const silentRunRow = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    const silentRun = await drive(world, silentRunRow.id);
    assert.equal(silentRun.state, "failed", "正常退出但零输出必须如实失败，不登记假产物");
    const silentSpec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", silentRun.snapshotId) as { operations: { operationId: string; target: { groupId: string; itemId: string } }[] };
    const silentTarget = silentSpec.operations.find(operation => operation.operationId === "silent-1")!.target;
    assert.ok(itemOf(world, silentTarget.groupId, silentTarget.itemId).draft === null, "静默操作的目标事项不得挂上别的操作的产物");
    const frame3Target = silentSpec.operations.find(operation => operation.operationId === "frame-3")!.target;
    assert.ok(itemOf(world, frame3Target.groupId, frame3Target.itemId).draft?.kind === "artifact_revision", "正常产出的第一操作结果保留可查看");
  } finally { await world.close(); }
});

// S5（§11.7 来源1-3）：逐操作来源绑定与多工程定稿留存。每个输出只携带本操作实际提供/声明采用的
// 输入——artifact_revision 数据输入、operation_output 继承 producer 产物既有 binding、工程
// sourceRevisions 声明提供给工程的资源；整条 run 的 inputSources 不复制到任何产物。工程链随
// projectRevisions 留存：多工程合成时库投影按行 project 展开文件（同名 relativePath 各归所属工程），
// 最终主工程仍是产出最终视频那步自己的工程；选材按所属工程放行。
it("S5 逐操作来源：run 级 inputSources 不复制，operation_output 继承来源，多工程清单按行归属", async () => {
  const world = await setup(); try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "多工程成片" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;
    // 两份文稿修订：一份声明提供给工程 A（sourceRevisions），另一份只出现在 run 级 inputSources、
    // 没有提供给任何操作——后者不得被复制成任何产物的来源。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "画面依据", kind: "script", content: { format: "markdown", text: "# 依据\n主角红衣。" } },
        { mode: "create", title: "候选稿", kind: "script", content: { format: "markdown", text: "# 候选\n蓝衣备选。" } }],
        reviewGroups: [{ workId, group: { mode: "create", key: "basis", title: "依据", nextIntent: null },
          items: [
            { item: { mode: "create", key: "basis", label: "画面依据", role: "storyboard", required: true }, itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" },
            { item: { mode: "create", key: "candidate", label: "候选稿", role: "storyboard", required: false }, itemIndex: 1, inputSources: [], reviewInputs: [], purpose: "draft" }] }] })]),
      fauxAssistantMessage("依据与候选已交付。"),
    ], "交付依据与候选。");
    const basisGroup = works(world).flatMap(work => work.reviewGroups).find(group => group.items.some(item => item.label === "画面依据"))!;
    const basisDraft = itemOf(world, basisGroup.id, basisGroup.items[0]!.id).draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const candidateDraft = itemOf(world, basisGroup.id, basisGroup.items[1]!.id).draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const digestOf = (revisionId: string) => String((world.runtime.database.prepare("SELECT digest FROM artifact_revisions WHERE id=?").get(revisionId) as { digest: string }).digest);
    const basis = { kind: "artifact_revision" as const, artifactId: basisDraft.artifactId, revisionId: basisDraft.revisionId, digest: digestOf(basisDraft.revisionId) };

    // 工程 A：ffmpeg 写 3 秒片段，封存时声明采用「画面依据」。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: walkPreviewScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "片段工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [],
        sourceRevisions: [{ artifactId: basisDraft.artifactId, revisionId: basisDraft.revisionId }] })]),
      fauxAssistantMessage("片段工程已冻结。"),
    ], "封存片段工程。");
    const projectA = latestProjectRevision(world);
    // 工程 B：同名 main.cjs（内容不同），有输入时原样搬运上游产物、无输入时写 1 秒占位（封存前试跑用）。
    const composeScript = `const fs = require("fs");
if (fs.existsSync("inputs/0.mp4")) {
  fs.copyFileSync("inputs/0.mp4", "out2.mp4");
} else {
  const { execFileSync } = require("child_process");
  execFileSync("ffmpeg", ["-f", "lavfi", "-i", "testsrc2=duration=1:size=160x90:rate=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "out2.mp4"], { stdio: "ignore" });
}
`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: composeScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "合成工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("合成工程已冻结。"),
    ], "封存合成工程。");
    const projectB = latestProjectRevision(world);
    assert.notEqual(projectA.revisionId, projectB.revisionId);

    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "多工程成片", scope: "两工程合成", purpose: "draft",
        inputSources: [{ kind: "artifact_revision", artifactId: candidateDraft.artifactId, revisionId: candidateDraft.revisionId, digest: digestOf(candidateDraft.revisionId) }],
        reviewInputs: [],
        operations: [
          { operationId: "seg-1", outputSlot: "video-1", inputs: [],
            parameters: { assembly: "code_project", projectRevision: projectA, entrypoint: { argv: ["node", "main.cjs"] },
              outputPath: "out.mp4", expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
            target: { group: { mode: "create", key: "segments", title: "片段", nextIntent: null },
              item: { mode: "create", key: "seg-a", label: "片段甲", role: "clip", required: true } } },
          { operationId: "final-1", outputSlot: "video-2",
            inputs: [{ kind: "operation_output", producerOperationId: "seg-1", outputSlot: "video-1" }],
            parameters: { assembly: "code_project", projectRevision: projectB, entrypoint: { argv: ["node", "main.cjs"] },
              outputPath: "out2.mp4", expectedMediaKind: "video", format: "mp4", width: 160, height: 90, fps: 4 },
            target: { group: { mode: "create", key: "final", title: "成片", nextIntent: null },
              item: { mode: "create", key: "final-video", label: "成片", role: "video", required: true } } }] })]),
      fauxAssistantMessage("多工程渲染已受理。"),
    ], "两工程链式渲染。");
    const runId = (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string }).id;
    const result = await drive(world, runId);
    assert.equal(result.state, "succeeded");
    assert.equal(result.outputRevisions.length, 2);
    const bindingOf = (revisionId: string) => jsonField(world, "SELECT creation_binding_json FROM artifact_revisions WHERE id=?", "creation_binding_json", revisionId) as
      { inputSources: { kind: string; revisionId: string }[]; projectRevision?: { artifactId: string; revisionId: string }; projectRevisions?: { artifactId: string; revisionId: string }[] };
    const segBinding = bindingOf(result.outputRevisions[0]!.revisionId);
    assert.deepEqual(segBinding.inputSources, [basis], "本操作来源 = 工程声明提供给它的资源（digest 读冻结行）");
    assert.deepEqual(segBinding.projectRevision, projectA, "本操作自己的工程");
    assert.deepEqual(segBinding.projectRevisions, [projectA], "单操作工程链只有自己的工程");
    const finalBinding = bindingOf(result.outputRevisions[1]!.revisionId);
    assert.deepEqual(finalBinding.inputSources, [basis], "operation_output 继承上游产物的来源");
    assert.ok(!JSON.stringify(finalBinding).includes(candidateDraft.revisionId), "run 级声明、未提供给任何操作的候选不复制到产物（§11.7 来源1）");
    assert.deepEqual(finalBinding.projectRevision, projectB, "最终主工程 = 产出最终视频那步自己的工程");
    assert.deepEqual(finalBinding.projectRevisions, [projectB, projectA], "工程链去重留存：本操作在前、继承工程在后");
    assert.ok(outputBytes(world, result.outputRevisions[1]!.revisionId).equals(outputBytes(world, result.outputRevisions[0]!.revisionId)),
      "第二操作真实消费了上游产物（字节一致）");

    // 定稿后库投影：多工程清单按行归属，同名 main.cjs 各归所属工程；采用素材只含来源链上的修订。
    const spec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", result.snapshotId) as { operations: { target: { groupId: string; itemId: string } }[] };
    const finalTarget = spec.operations[1]!.target;
    const finalItem = itemOf(world, finalTarget.groupId, finalTarget.itemId);
    assert.ok(finalItem.draft?.kind === "artifact_revision");
    const finalDraft = finalItem.draft as { kind: "artifact_revision"; artifactId: string; revisionId: string };
    const finalRevision = world.runtime.service.readRevision("local-owner", finalDraft.artifactId, finalDraft.revisionId);
    // 草稿渲染不代认其必选画面依据；定稿仍需用户明确认可实际采用的准确版本。
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("认可实际采用的画面依据", {
      reviewConfirmation: { workId, groupId: basisGroup.id,
        items: [{ itemId: basisGroup.items[0]!.id, source: basis }], action: "approve" },
    }));
    await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput("这版定稿", {
      reviewConfirmation: { workId, groupId: finalTarget.groupId,
        items: [{ itemId: finalTarget.itemId, source: { kind: "artifact_revision", artifactId: finalDraft.artifactId, revisionId: finalDraft.revisionId, digest: finalRevision.digest } }],
        action: "finalize_video" },
    }));
    const [entry] = world.runtime.service.listLibraryVideos("local-owner", undefined, undefined).items;
    assert.ok(entry);
    assert.deepEqual(entry.project, projectB, "最终主工程；没有则为 null，不猜上游工程");
    assert.deepEqual(entry.projectFiles, [
      { project: projectB, relativePath: "main.cjs", mimeType: "text/javascript" },
      { project: projectA, relativePath: "main.cjs", mimeType: "text/javascript" },
    ], "多工程清单按行 project 归属，主工程分组在前；同名 main.cjs 各自指向所属工程");
    assert.deepEqual(entry.materials, [
      { source: result.outputRevisions[0]!, label: "多工程成片 · 合成视频 1", kind: "video", provenance: [] },
      { source: { artifactId: basisDraft.artifactId, revisionId: basisDraft.revisionId },
        label: "画面依据（提供给工程）", kind: "script", provenance: [] },
    ], "采用的生成片段本身与其工程依据均留存；未采用候选不混入，也不追加认可");

    // 跨会话选材：两个同名 main.cjs 按所属工程各自物化不同字节；链外工程引用被拒。
    const other = world.runtime.service.createConversation("local-owner", { commandId: cmd(), title: "选材会话" }).conversation;
    world.runtime.host.faux!.setResponses([() => fauxAssistantMessage("收到两个工程文件。")]);
    const selections = [
      { sourceVideo: { artifactId: finalDraft.artifactId, revisionId: finalDraft.revisionId },
        source: { kind: "project_file" as const, project: projectA, relativePath: "main.cjs" } },
      { sourceVideo: { artifactId: finalDraft.artifactId, revisionId: finalDraft.revisionId },
        source: { kind: "project_file" as const, project: projectB, relativePath: "main.cjs" } },
    ];
    await world.runtime.service.sendMessage("local-owner", other.id, chatInput("按这两份工程继续", { librarySelections: selections }));
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", other.id).activeRequestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const page = world.runtime.service.snapshot("local-owner", other.id);
    const userMessage = page.messages.items.find(message => message.role === "user" && message.text.includes("按这两份工程"))!;
    assert.deepEqual(userMessage.librarySelections, selections);
    assert.equal(userMessage.references.artifacts.length, 2, "同名文件按所属工程各物化一份");
    // §11.7 来源5：文本工程文件是共享原 blob 的文件卡，按 blob 读回字节判别不串工程。
    const scripts = userMessage.references.artifacts
      .map(ref => outputBytes(world, ref.revisionId).toString())
      .sort();
    assert.deepEqual(scripts, [composeScript, walkPreviewScript].sort(), "两份 main.cjs 字节不同：A 是片段脚本、B 是合成脚本，不串工程");
    let rejected: Error | undefined;
    try {
      await world.runtime.service.sendMessage("local-owner", other.id, chatInput("带链外工程", { librarySelections: [
        { sourceVideo: { artifactId: finalDraft.artifactId, revisionId: finalDraft.revisionId },
          source: { kind: "project_file", project: { artifactId: projectA.artifactId, revisionId: "rev_not_in_chain" }, relativePath: "main.cjs" } }] }));
    } catch (error) { rejected = error as Error; }
    assert.match(rejected?.message ?? "", /不在定稿封存工程里/, "来源链之外的工程引用被拒，不能借同名路径串工程");
  } finally { await world.close(); }
});

it("S3 执行边界：正常退出无输出不交付旧文件、镜像不匹配拒绝执行、含空格 argv 逐项直传、同源码重渲同字节", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    const runOf = () => (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string }).id;

    // 合法封存 + 确实执行 + 正常退出但不写声明输出：如实失败，不读回任何旧文件（V3）。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "silent.cjs", content: "process.exit(0);\n" })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node silent.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "静默工程", files: ["silent.cjs"],
        entrypoint: { argv: ["node", "silent.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("静默工程已冻结。"),
    ], "再封存一个不产出的工程。");
    const silentRef = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "静默渲染", scope: "不产出", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "silent-1", outputSlot: "image-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: silentRef, entrypoint: { argv: ["node", "silent.cjs"] },
            outputPath: "out.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
          target: { group: { mode: "create", key: "silent", title: "静默", nextIntent: null },
            item: { mode: "create", key: "silent-frame", label: "静默帧", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("静默渲染已受理。"),
    ], "渲染静默工程。");
    const silentRun = await drive(world, runOf());
    assert.equal(silentRun.state, "failed", "正常退出但没有声明输出必须失败");
    assert.match(silentRun.issue?.message ?? "", /读取声明输出 out\.png失败：.*ENOENT/);
    assert.doesNotMatch(silentRun.issue?.message ?? "", /没有产生声明的输出/);
    assert.equal(silentRun.outputRevisions.length, 0);
    assert.ok(world.host.executions.some(e => e.argv?.[1] === "silent.cjs"), "入口确实被执行过，不是被入口校验挡下");
    assert.equal(count(world, "FROM artifacts WHERE kind='image'"), 0, "不产出媒体产物，也不得交付旧文件");
    const silentSpec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", silentRun.snapshotId) as { operations: { target: { groupId: string; itemId: string } }[] };
    assert.equal(itemOf(world, silentSpec.operations[0]!.target.groupId, silentSpec.operations[0]!.target.itemId).draft, null, "目标事项保持无主稿");

    // 执行边界核对镜像身份：封存镜像与宿主不一致时清楚失败，不默默换镜像执行。
    const sealedContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?", "content_json", artifactId, revisionId) as CreativeProjectContent;
    const restore = world.runtime.database.prepare("UPDATE artifact_revisions SET content_json=? WHERE id=?");
    restore.run(JSON.stringify({ ...sealedContent, runtimeImage: "other-host:1" }), revisionId);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "镜像边界", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "mismatch-1", outputSlot: "image-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: { artifactId, revisionId }, entrypoint: { argv: ["node", "main.cjs"] },
            outputPath: "out.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
          target: { group: { mode: "create", key: "mismatch", title: "镜像", nextIntent: null },
            item: { mode: "create", key: "mismatch-frame", label: "镜像帧", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "渲染镜像不一致的工程。");
    const executionsBefore = world.host.executions.length;
    const mismatchRun = await drive(world, runOf());
    assert.equal(mismatchRun.state, "failed");
    assert.match(mismatchRun.issue?.message ?? "", /环境不匹配/);
    assert.equal(world.host.executions.length, executionsBefore, "镜像不匹配时不执行任何入口命令");
    restore.run(JSON.stringify(sealedContent), revisionId);

    // 含空格参数按原 argv 逐项直传：脚本只在收到原样的单一参数时才产出（守卫判别）。
    const spacedArg = "参数 含 空格";
    const spacedGuard = `if (process.argv.length !== 3 || process.argv[2] !== "${spacedArg}") process.exit(4);`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "spaced.cjs", content: chartScript(46, 128, 110, "spaced.png", spacedGuard) })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: `node spaced.cjs "${spacedArg}"`, timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "参数工程", files: ["spaced.cjs"],
        entrypoint: { argv: ["node", "spaced.cjs", spacedArg] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("参数工程已冻结。"),
    ], "封存带空格参数的工程。");
    const spacedRef = latestProjectRevision(world);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "参数渲染", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "spaced-1", outputSlot: "image-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: spacedRef, entrypoint: { argv: ["node", "spaced.cjs", spacedArg] },
            outputPath: "spaced.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
          target: { group: { mode: "create", key: "spaced", title: "参数", nextIntent: null },
            item: { mode: "create", key: "spaced-frame", label: "参数帧", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("参数渲染已受理。"),
    ], "渲染带空格参数的工程。");
    const spacedRun = await drive(world, runOf());
    assert.equal(spacedRun.state, "succeeded", "守卫脚本只有在参数原样直达时才产出");
    assert.deepEqual(world.host.executions.at(-1)!.argv, ["node", "spaced.cjs", spacedArg], "宿主收到的 argv 逐项一致");
    assert.ok(outputBytes(world, spacedRun.outputRevisions[0]!.revisionId).equals(makePng(46, 128, 110)), "产出与测试侧同规格 PNG 字节一致");

    // 同源码确定性重渲：两次运行产出相同字节合法（不因摘要相同而拒绝）。
    const renderMain = async (operationId: string, groupKey: string, itemKey: string) => {
      await send(world, [
        fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "重渲", scope: "确定性", purpose: "draft",
          inputSources: [], reviewInputs: [],
          operations: [{ operationId, outputSlot: "image-1", inputs: [],
            parameters: { assembly: "code_project", projectRevision: { artifactId, revisionId }, entrypoint: { argv: ["node", "main.cjs"] },
              outputPath: "out.png", expectedMediaKind: "image", format: "png", width: 160, height: 90 },
            target: { group: { mode: "create", key: groupKey, title: "重渲", nextIntent: null },
              item: { mode: "create", key: itemKey, label: "重渲帧", role: "storyboard", required: true } } }] })]),
        fauxAssistantMessage("已受理。"),
      ], "重渲首帧。");
      return drive(world, runOf());
    };
    const againFirst = await renderMain("again-1", "rerender-a", "frame-a");
    const againSecond = await renderMain("again-2", "rerender-b", "frame-b");
    assert.equal(againFirst.state, "succeeded");
    assert.equal(againSecond.state, "succeeded");
    assert.ok(outputBytes(world, againFirst.outputRevisions[0]!.revisionId)
      .equals(outputBytes(world, againSecond.outputRevisions[0]!.revisionId)), "同源码重渲产出同样字节是合法结果");
  } finally { await world.close(); }
});

// —— r4.5 C1（F04 工程续版归属）：B 工作区的工程不能以 baseRevisionId 续到 A 名下 ——

it("C1 工程续版只认归属创作：跨作品续版拒绝且无残留；本作品续版与另封新工程照常", async () => {
  const world = await setup(); try {
    const authorTitled = async (workTitle: string, projectTitle: string) => {
      // start_work 激活只在本回合内有效；跨回合封存前用 read_work activate 重新锚定工作区。
      await send(world, [
        fauxAssistantMessage([fauxToolCall("start_work", { title: workTitle })]),
        fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: pngScript })]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
        fauxAssistantMessage("脚本就绪。"),
      ], `开始${workTitle}并写脚本。`);
      const workId = works(world).find(work => work.title === workTitle)!.id;
      await send(world, [
        fauxAssistantMessage([fauxToolCall("read_work", { workId, activate: true })]),
        fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: projectTitle, files: ["main.cjs"],
          entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
        fauxAssistantMessage("工程已冻结。"),
      ], `封存${workTitle}工程。`);
      const project = world.runtime.service.snapshot("local-owner", world.conversationId).artifacts.items
        .find(item => item.kind === "project" && item.workId === workId)!;
      return { workId, artifactId: project.id, revisionId: project.revisionId };
    };
    const projectA = await authorTitled("动画A", "A的工程");
    const projectB = await authorTitled("动画B", "B的工程");
    const revisionCount = (artifactId: string) =>
      count(world, "FROM artifact_revisions WHERE artifact_id=?", artifactId);

    // 跨作品续版：B 的工程以 baseRevisionId 声明到 A 名下——拒绝，双方向都无残留。
    const beforeCounts = [revisionCount(projectA.artifactId), revisionCount(projectB.artifactId)];
    await send(world, [
      fauxAssistantMessage([fauxToolCall("publish_project", { workId: projectA.workId, artifactId: projectB.artifactId,
        baseRevisionId: projectB.revisionId, title: "A名下的B工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      context => {
        const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
        const text = result.content.filter(part => part.type === "text").map(part => part.text).join("");
        assert.equal(result.isError, true, `跨作品续版应被拒绝：${text}`);
        assert.match(text, /这份工程属于其他视频创作，不能在该创作下续版/);
        return fauxAssistantMessage("需要各自封存。");
      },
    ], "把B的工程续到A名下。");
    assert.equal(revisionCount(projectA.artifactId), beforeCounts[0], "A 的工程无新修订");
    assert.equal(revisionCount(projectB.artifactId), beforeCounts[1], "B 的工程无新修订");

    // 本作品续版照常：切回 A，改一版并续封 A 自己的工程。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("read_work", { workId: projectA.workId, activate: true })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: chartScript(200, 60, 60) })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId: projectA.workId, artifactId: projectA.artifactId,
        baseRevisionId: projectA.revisionId, title: "A的工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("A 已续版。"),
    ], "回A改配色再封一版。");
    assert.equal(revisionCount(projectA.artifactId), beforeCounts[0]! + 1, "A 的工程推进一版");

    // B 需要同源工程：在自己的工作区另封新工程（不带 artifactId），是允许路径。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("read_work", { workId: projectB.workId, activate: true })]),
      fauxAssistantMessage([fauxToolCall("write", { path: "main.cjs", content: chartScript(60, 60, 200) })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node main.cjs", timeout: 30 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId: projectB.workId, title: "B的新工程", files: ["main.cjs"],
        entrypoint: { argv: ["node", "main.cjs"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("B 另封了新工程。"),
    ], "给B另封一份工程。");
    assert.equal(count(world, "FROM artifacts WHERE kind='project'"), 3, "B 得到独立的新工程产物");
  } finally { await world.close(); }
});

// —— r4.5 C2（F05 继续按钮）：消息 reviewContext 决定原生工具服务的作品工作区 ——

it("C2 继续消息指哪写哪：reviewContext 指A时原生 write 落 A 的工作区，B 不动", async () => {
  const world = await setup(); try {
    const workspaceFile = (workId: string, file: string) => path.join(
      world.directory, "creative-host", creativeWorkspaceId(editingWorkspace(world.conversationId, workId)), "workspace", file);
    // A、B 各有一组已交付设定；最后活动的是 B（多作品会话无指向时不可写，唯一能改变归属的就是消息指向）。
    for (const title of ["作品A", "作品B"]) {
      await send(world, [fauxAssistantMessage([fauxToolCall("start_work", { title })]), fauxAssistantMessage("已开始。")]);
      const workId = works(world).find(work => work.title === title)!.id;
      await send(world, [
        fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
          { mode: "create", title: `${title}设定`, kind: "script", content: { format: "markdown", text: `# ${title}\n设定。` } }],
          reviewGroups: [{ workId,
            group: { mode: "create", key: "content", title: "内容", nextIntent: null },
            items: [{ item: { mode: "create", key: "setting", label: "设定", role: "content", required: true },
              itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const }] }] })]),
        fauxAssistantMessage("设定已交付。"),
      ], `交付${title}设定。`);
    }
    const a = works(world).find(work => work.title === "作品A")!;
    const b = works(world).find(work => work.title === "作品B")!;
    const aGroup = a.reviewGroups[0]!;

    // 继续按钮的消息形态：reviewContext 指向 A 的组；回合内原生写入必须落 A。
    world.runtime.host.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "continued.txt", content: "via-continue-A" })]),
      fauxAssistantMessage("已继续 A。"),
    ]);
    await world.runtime.service.sendMessage("local-owner", world.conversationId,
      chatInput("继续A的设定往下做", { reviewContext: { workId: a.id, groupId: aGroup.id } }));
    for (let i = 0; i < 300 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(workspaceFile(a.id, "continued.txt"), "utf8"), "via-continue-A", "写入落在 reviewContext 指向的 A 工作区");
    await assert.rejects(access(workspaceFile(b.id, "continued.txt")), Error, "B 的工作区不动");
  } finally { await world.close(); }
});

// —— r4.5 A3（F07 组版本）：目标元数据实际变化才升组版本，且事件真实 ——

it("A3 组元数据变更升版本：改 label/组标题升一版并留事件；无变化不升；无关组不动", async () => {
  const world = await setup(); try {
    const { workId, artifactId, revisionId } = await authorProject(world);
    // 首帧草稿：create 目标一次分配视觉组与首帧事项。
    const seed = world.blobs.persist("local-owner", world.conversationId, makePng(90, 120, 140), "image/png", null);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿", scope: "首帧", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }), inputs: [{ kind: "blob", blobId: seed.id, digest: seed.digest }] }] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "出首帧草稿。");
    const firstRun = world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY created_seq DESC LIMIT 1").get() as { id: string };
    assert.equal((await drive(world, firstRun.id)).state, "succeeded");
    const visual = works(world).find(work => work.id === workId)!.reviewGroups.find(group => group.title === "画面")!;
    const visualItem = visual.items[0]!;

    // 无关对照组：另交付一个内容组，验证只有声明目标的组升版本。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("deliver_artifacts", { items: [
        { mode: "create", title: "旁白设定", kind: "script", content: { format: "markdown", text: "# 旁白\n清晨。" } }],
        reviewGroups: [{ workId, group: { mode: "create", key: "narration", title: "旁白组", nextIntent: null },
          items: [{ item: { mode: "create", key: "narration-item", label: "旁白", role: "content", required: true },
            itemIndex: 0, inputSources: [], reviewInputs: [], purpose: "draft" as const }] }] })]),
      fauxAssistantMessage("旁白已交付。"),
    ], "交付旁白设定。");
    const narration = works(world).find(work => work.id === workId)!.reviewGroups.find(group => group.title === "旁白组")!;
    const stateOf = () => works(world).find(work => work.id === workId)!;
    const workChangedVersion = () =>
      (world.runtime.database.prepare("SELECT entity_version AS v FROM events WHERE kind='work.changed' AND entity_id=? ORDER BY seq DESC LIMIT 1")
        .get(workId) as { v: number }).v;
    const visualRevisionBefore = stateOf().reviewGroups.find(group => group.id === visual.id)!.revision;

    // 元数据实际变化：组标题与事项 label 都改——受理即升组版本、更新呈现，work.changed 事件真实。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿v2", scope: "首帧", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }),
          inputs: [{ kind: "blob", blobId: seed.id, digest: seed.digest }],
          target: { group: { mode: "existing", groupId: visual.id, title: "画面方案" },
            item: { mode: "existing", itemId: visualItem.id, label: "首帧画面" } } }] })]),
      fauxAssistantMessage("已按新名目受理。"),
    ], "按新名目再渲染一版。");
    const afterChange = stateOf();
    const changedGroup = afterChange.reviewGroups.find(group => group.id === visual.id)!;
    assert.equal(changedGroup.revision, visualRevisionBefore + 1, "元数据实际变化升组版本");
    assert.equal(changedGroup.title, "画面方案", "组标题已更新");
    assert.equal(changedGroup.items[0]!.label, "首帧画面", "事项 label 已更新");
    assert.equal(afterChange.reviewGroups.find(group => group.id === narration.id)!.revision, narration.revision, "无关组版本不动");
    const workRowRevision = (world.runtime.database.prepare("SELECT revision FROM works WHERE id=?").get(workId) as { revision: number }).revision;
    assert.equal(workChangedVersion(), workRowRevision, "work.changed 事件版本与作品行版本一致（事件真实推进）");
    assert.equal(count(world, "FROM events WHERE kind='work.changed' AND entity_id=? AND entity_version=?", workId, workRowRevision), 1, "该版本事件唯一落账");

    // 无元数据变化：同一 existing 目标按原样再受理，组版本不再升。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "首帧草稿v3", scope: "首帧", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ ...draftImageOperation({ artifactId, revisionId }),
          inputs: [{ kind: "blob", blobId: seed.id, digest: seed.digest }],
          target: { group: { mode: "existing", groupId: visual.id }, item: { mode: "existing", itemId: visualItem.id } } }] })]),
      fauxAssistantMessage("原样再受理。"),
    ], "原样再渲染一版。");
    assert.equal(stateOf().reviewGroups.find(group => group.id === visual.id)!.revision, visualRevisionBefore + 1, "无元数据变化不升组版本");
  } finally { await world.close(); }
});
