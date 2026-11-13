import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentRuntime, type AgentRuntime } from "../src/server/agent/assembly.js";
import { CreativeRunner, editingWorkspace } from "../src/server/agent/creative-runner.js";
import { LocalRenderPort } from "../src/server/agent/local-render.js";
import { probeImageFile, probeVideoFile } from "../src/server/agent/media-probe.js";
import type { ProductionService } from "../src/server/agent/production-service.js";
import { systemClock } from "../src/server/agent/util.js";
import { FAUX_PROVIDER, FAUX_TEXT_MODEL } from "../src/server/agent/offline.js";
import type { CreativeProjectContent, ModelEntry, Work } from "../src/shared/agent/generated/contracts.js";

// G2-3 阶段退出（真实容器）：一个真实安装的 Skill 在 Frame 隔离会话产出实际代码动画草稿；
// 从草稿修改可见变化；后台渲染期间可聊其他事；每次执行的容器结束后文件仍在。
// 与 agent-local-creation.test.ts 的区别只有一处：CreativeRunner 连接真实容器宿主
// （scripts/creative-runner-host.mjs + 固定镜像），其余装配与产品完全一致。
// 必须显式指定已运行 daemon（FRAME_CREATIVE_DOCKER_SOCKET）；缺失时跳过，不用替身冒充。

const root = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = path.join(root, ".local/skill-creation");
const dockerSocket = process.env.FRAME_CREATIVE_DOCKER_SOCKET;

const SKILL_NAME = "frame-anim-recipe";

// Skill 参考：逐帧动画配方。BACKGROUND 与 SQUARE 是每次制作替换的配色，其余固定。
const recipe = `# 逐帧动画配方

anim.py 固定结构：PIL 逐帧绘制 8 张 320x180 PNG（圆角方块从左向右移动），
再用 ffmpeg 合成 output.mp4（libx264、yuv420p、4fps、时长 2 秒）。

BACKGROUND 与 SQUARE 按本次需求替换配色，其余保持不变：

    import os
    from PIL import Image, ImageDraw
    import subprocess
    os.makedirs("frames", exist_ok=True)
    for i in range(8):
        image = Image.new("RGB", (320, 180), BACKGROUND)
        draw = ImageDraw.Draw(image)
        x = 16 + i * 32
        draw.rounded_rectangle([x, 65, x + 50, 115], radius=12, fill=SQUARE)
        image.save(f"frames/{i:03d}.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "4", "-i", "frames/%03d.png",
        "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "output.mp4"], check=True)
`;

// 首版动画：按配方落定深蓝底、暖黄方块。
const animFirst = `import os
from PIL import Image, ImageDraw
import subprocess
os.makedirs("frames", exist_ok=True)
for i in range(8):
    image = Image.new("RGB", (320, 180), "#15263c")
    draw = ImageDraw.Draw(image)
    x = 16 + i * 32
    draw.rounded_rectangle([x, 65, x + 50, 115], radius=12, fill="#f6ca65")
    image.save(f"frames/{i:03d}.png")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "4", "-i", "frames/%03d.png",
    "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "output.mp4"], check=True)
`;

const FAUX_TEXT_ENTRY: ModelEntry = {
  binding: { providerId: FAUX_PROVIDER, modelId: FAUX_TEXT_MODEL, connectionId: "local-fixture", configurationRevisionId: "g23-real" },
  name: "Faux 文本模型（真实容器）", kind: "text", features: ["chat", "tools", "offline-fixture"], availability: "configured",
  verificationNote: "测试 Faux 模型，仅驱动流程。", isDefault: true,
};

let sequence = 0;
const cmd = () => `g23r-${++sequence}`;
const chatInput = (text: string, extra: Record<string, unknown> = {}) => ({
  commandId: cmd(), text, target: null, skillId: null, proposalRef: null, mode: "new" as const, steerRequestId: null, ...extra,
});

interface World {
  runtime: AgentRuntime;
  conversationId: string;
  runner: CreativeRunner;
  blobs: ProductionService["blobs"];
  directory: string;
  close(): Promise<void>;
}

async function setupReal(directory: string): Promise<{ world: World; broker: { close(): Promise<void>; imageId: string; socketPath: string } }> {
  const { createCreativeRunnerHost } = await import(new URL("../../../scripts/creative-runner-host.mjs", import.meta.url).href);
  const broker = await createCreativeRunnerHost({ socketPath: path.join(directory, "runtime", "s"),
    workspaceRoot: path.join(directory, "workspaces"), dockerSocket });
  const runner = new CreativeRunner({ socketPath: broker.socketPath });
  await mkdir(path.join(directory, "skills"), { recursive: true });
  const runtime = await createAgentRuntime({
    dataDir: path.join(directory, "app"), skillsRoot: path.join(directory, "skills"),
    host: { faux: { provider: FAUX_PROVIDER, modelIds: [FAUX_TEXT_MODEL] } },
    models: [FAUX_TEXT_ENTRY], defaultModelId: FAUX_TEXT_MODEL, catalog: () => ({}),
    creative: { runner },
    media: { autoStart: false, factory: (db, blobs) => ({
      port: new LocalRenderPort(db, blobs, systemClock, { workRoot: path.join(directory, "media-work") }, runner),
      catalog: () => ({}), models: () => [],
    }) },
  });
  const conversationId = runtime.service.createConversation("local-owner", { commandId: cmd(), title: "代码动画" }).conversation.id;
  return {
    broker,
    world: {
      runtime, conversationId, runner, blobs: runtime.production!.blobs, directory,
      // 证据目录保留（.local/skill-creation），不做清理。
      close: async () => { await runtime.close(); await broker.close(); },
    },
  };
}

// 真实容器执行以秒计：回合轮询给足真实时间，不拿超时截断冒充回合结束。
async function send(world: World, steps: (ReturnType<typeof fauxAssistantMessage> | ((context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>))[], text = "请处理", extra: Record<string, unknown> = {}) {
  world.runtime.host.faux!.setResponses(steps);
  const sent = await world.runtime.service.sendMessage("local-owner", world.conversationId, chatInput(text, extra));
  for (let i = 0; i < 900 && world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(world.runtime.service.snapshot("local-owner", world.conversationId).activeRequestId, null, "回合应已结束");
  return sent.receipt;
}

async function drive(world: World, runId: string) {
  for (let i = 0; i < 50; i++) {
    await world.runtime.worker!.pollOnce();
    const state = world.runtime.service.getRun("local-owner", runId).state;
    if (state === "succeeded" || state === "failed" || state === "cancelled") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return world.runtime.service.getRun("local-owner", runId);
}

const jsonField = (world: World, sql: string, field: string, ...args: unknown[]) =>
  JSON.parse(String((world.runtime.database.prepare(sql).get(...args) as Record<string, unknown>)[field]));

const count = (world: World, sql: string) =>
  (world.runtime.database.prepare(`SELECT COUNT(*) AS n ${sql}`).get() as { n: number }).n;

const works = (world: World): Work[] => world.runtime.service.snapshot("local-owner", world.conversationId).works;

function itemOf(world: World, groupId: string, itemId: string) {
  const group = works(world).flatMap(work => work.reviewGroups).find(group => group.id === groupId);
  assert.ok(group, `应能读到组 ${groupId}`);
  const item = group.items.find(item => item.id === itemId);
  assert.ok(item, `应能读到事项 ${itemId}`);
  return item;
}

const lastToolText = (context: TranscriptContext): { isError: boolean; text: string } => {
  const result = context.messages.filter(message => message.role === "toolResult").at(-1)!;
  return { isError: result.isError, text: result.content.filter(part => part.type === "text").map(part => part.text).join("") };
};

it("G2-3 阶段退出：真实 Skill 经隔离容器产出动画草稿，修改可见、在途可聊、文件留存", { skip: !dockerSocket, timeout: 300_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "g23-real-"));
  const sourceSkill = path.join(directory, "source-skill");
  await mkdir(path.join(sourceSkill, "references"), { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), `---\nname: ${SKILL_NAME}\ndescription: 逐帧代码动画配方（PIL 帧 + ffmpeg 合成 MP4）\n---\n按 references/recipe.md 的固定配方生成 320x180、4fps 的代码动画。\n`);
  await writeFile(path.join(sourceSkill, "references/recipe.md"), recipe);
  const { world, broker } = await setupReal(directory);
  try {
    // 真实安装路径：走运行中 runtime 的安装服务（与 UI 同一入口），不是测试侧直接写目录。
    await world.runtime.service.installSkillPackage({ source: sourceSkill });
    const skills = (await world.runtime.service.readSkillPackages()).skills;
    assert.ok(skills.some(skill => skill.id === SKILL_NAME), `应发现已安装 Skill：${JSON.stringify(skills)}`);

    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "城市代码动画" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;

    // 隔离会话内真实读取 Skill 参考，再按配方写工程、试跑、封存。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("read", { path: `/skills/${SKILL_NAME}/references/recipe.md` })]),
      context => {
        const read = lastToolText(context);
        assert.equal(read.isError, false, read.text);
        assert.match(read.text, /逐帧动画配方/, "读到的是 Skill 参考内容");
        return fauxAssistantMessage([fauxToolCall("write", { path: "anim.py", content: animFirst })]);
      },
      fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I anim.py", timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "动画工程", files: ["anim.py"],
        entrypoint: { argv: ["python3", "-I", "anim.py"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "按 Skill 配方做首版动画。", { skillId: SKILL_NAME });
    const firstProject = jsonField(world,
      "SELECT content_json FROM artifact_revisions WHERE rowid=(SELECT MAX(r.rowid) FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.kind='project')",
      "content_json") as CreativeProjectContent;
    assert.equal((firstProject as { runtimeImage: string }).runtimeImage, broker.imageId, "工程冻结真实容器镜像标识");
    assert.deepEqual((firstProject as { files: { relativePath: string }[] }).files.map(file => file.relativePath), ["anim.py"], "S3：封存清单只收源码，输出由本次执行产生");
    const firstProjectRef = (world.runtime.database.prepare(
      "SELECT artifact_id AS artifactId, id AS revisionId FROM artifact_revisions WHERE rowid=(SELECT MAX(r.rowid) FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.kind='project')",
    ).get()) as { artifactId: string; revisionId: string };

    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "动画草稿", scope: "首版动画", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "anim-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: firstProjectRef,
            entrypoint: { argv: ["python3", "-I", "anim.py"] }, outputPath: "output.mp4",
            expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "create", key: "visual", title: "画面", nextIntent: null },
            item: { mode: "create", key: "animation", label: "代码动画", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("渲染已受理。"),
    ], "生成首版动画草稿。");
    const runRow = world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string };

    // 后台渲染期间可聊其他事：受理后立刻发起普通对话，不等运行结束；
    // 以消息创建时序证明聊天回合落在渲染完成通知之前（本地 run 无 running 中间态）。
    const done = drive(world, runRow.id);
    await send(world, [fauxAssistantMessage("在途也可以聊其他话题。")], "渲染期间聊聊别的。");
    const first = await done;
    assert.equal(first.state, "succeeded");
    const chatAt = (world.runtime.database.prepare(
      "SELECT created_at AS at FROM messages WHERE role='assistant' AND text LIKE '在途也可以聊其他话题%' ORDER BY rowid DESC LIMIT 1",
    ).get() as { at: string }).at;
    const noticeAt = (world.runtime.database.prepare(
      "SELECT created_at AS at FROM messages WHERE role='system_notice' AND text LIKE '%已完成%' ORDER BY rowid DESC LIMIT 1",
    ).get() as { at: string }).at;
    assert.ok(chatAt < noticeAt, `聊天(${chatAt})应发生在渲染完成通知(${noticeAt})之前`);

    const firstSpec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", first.snapshotId);
    const target = (firstSpec as { operations: { target: { groupId: string; itemId: string } }[] }).operations[0]!.target;
    const item = itemOf(world, target.groupId, target.itemId);
    assert.ok(item.draft?.kind === "artifact_revision", "容器产出落为事项主稿");
    assert.equal(item.draft.revisionId, first.outputRevisions[0]!.revisionId);
    const firstMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", item.draft.revisionId) as { mimeType: string; durationMs: number | null; blobId: string };
    assert.equal(firstMedia.mimeType, "video/mp4");
    assert.ok(firstMedia.durationMs! > 1500 && firstMedia.durationMs! < 2500, `时长应约 2 秒：${firstMedia.durationMs}`);
    const firstBlob = world.blobs.get("local-owner", firstMedia.blobId);
    const firstFacts = await probeVideoFile(world.blobs.filePath(firstBlob.digest));
    assert.equal(firstFacts.width, 320); assert.equal(firstFacts.height, 180); assert.equal(firstFacts.frameRate, 4);
    await writeFile(path.join(directory, "animation-draft.mp4"), readFileSync(world.blobs.filePath(firstBlob.digest)));

    // 从草稿修改可见变化：换配色重封存、重渲染，事项主稿推进为新修订，旧稿文件保留。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("edit", { path: "anim.py", edits: [
        { oldText: '"#15263c"', newText: '"#efe8db"' }, { oldText: '"#f6ca65"', newText: '"#b85638"' }] })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I anim.py", timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "动画工程", files: ["anim.py"],
        entrypoint: { argv: ["python3", "-I", "anim.py"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("新配色已封存。"),
    ], "换成暖色底。");
    const secondProjectRef = (world.runtime.database.prepare(
      "SELECT artifact_id AS artifactId, id AS revisionId FROM artifact_revisions WHERE rowid=(SELECT MAX(r.rowid) FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.kind='project')",
    ).get()) as { artifactId: string; revisionId: string };
    assert.notEqual(secondProjectRef.revisionId, firstProjectRef.revisionId, "封存产生新工程修订");

    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "动画草稿", scope: "暖色版", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "anim-2", outputSlot: "video-1", inputs: [], baseRevisionId: item.draft.revisionId,
          parameters: { assembly: "code_project", projectRevision: secondProjectRef,
            entrypoint: { argv: ["python3", "-I", "anim.py"] }, outputPath: "output.mp4",
            expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "existing", groupId: target.groupId }, item: { mode: "existing", itemId: target.itemId } } }] })]),
      fauxAssistantMessage("重渲染已受理。"),
    ], "按新配色重渲染。");
    const secondRunRow = world.runtime.database.prepare("SELECT * FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    assert.notEqual(secondRunRow.id, runRow.id, "第二次受理应创建新 run");
    const second = await drive(world, secondRunRow.id);
    assert.equal(second.state, "succeeded");
    const after = itemOf(world, target.groupId, target.itemId);
    assert.ok(after.draft?.kind === "artifact_revision" && after.draft.revisionId !== item.draft.revisionId, "草稿推进到新修订");
    const secondMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", after.draft.revisionId) as { mimeType: string; blobId: string };
    const secondBlob = world.blobs.get("local-owner", secondMedia.blobId);
    assert.notEqual(secondBlob.digest, firstBlob.digest, "修改后产出字节不同");
    await writeFile(path.join(directory, "animation-revised.mp4"), readFileSync(world.blobs.filePath(secondBlob.digest)));

    // 容器结束后文件仍在：每次执行都是独立 docker run --rm，成品与工作区文件落在宿主持久位置。
    world.blobs.verify(firstBlob); world.blobs.verify(secondBlob);
    const runOutput = await world.runner
      .readFile({ conversationId: world.conversationId, workId, executionId: `${runRow.id}:anim-1` }, "output.mp4");
    assert.ok(runOutput.length > 1000, "run+operation 工作区的成品文件在容器退出后仍可读");
    const editingAnim = await world.runner.readFile(editingWorkspace(world.conversationId, workId), "anim.py");
    assert.match(editingAnim.toString(), /#efe8db/, "修改保留在编辑工作区");

    await writeFile(path.join(directory, "evidence.json"), JSON.stringify({
      imageId: broker.imageId, socketPath: broker.socketPath, skill: SKILL_NAME,
      runs: [{ runId: runRow.id, state: first.state, digest: firstBlob.digest, durationMs: firstMedia.durationMs },
        { runId: secondRunRow.id, state: second.state, digest: secondBlob.digest }],
      media: ["animation-draft.mp4", "animation-revised.mp4"],
    }, null, 2));
  } finally { await world.close(); }
});

// V3（§11.6）：真实容器执行边界判别，一个连贯样例。从零生成可解码图片/短动画；
// 合法封存、确实执行、正常退出却不生成声明输出时不能交付旧文件（不能用 entrypoint 不一致代替）；
// 不匹配镜像不能默默运行；含空格参数按原 argv 直传；同源码重渲产出同样字节合法；两操作各自输出且依赖有效。
it("S3/V3 真实容器执行边界：未来输出、无输出不交付、镜像核对、argv 直传、同摘要重渲、两操作依赖链", { skip: !dockerSocket, timeout: 300_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "s3-real-"));
  const { world, broker } = await setupReal(directory);
  const latestProjectRef = () => (world.runtime.database.prepare(
    "SELECT artifact_id AS artifactId, id AS revisionId FROM artifact_revisions WHERE rowid=(SELECT MAX(r.rowid) FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.kind='project')",
  ).get()) as { artifactId: string; revisionId: string };
  const runOf = () => (world.runtime.database.prepare("SELECT id FROM production_runs ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
  const digestOf = (revisionId: string): string => {
    const media = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", revisionId) as { blobId: string };
    return world.blobs.get("local-owner", media.blobId).digest;
  };
  try {
    await send(world, [
      fauxAssistantMessage([fauxToolCall("start_work", { title: "V3 执行边界" })]),
      fauxAssistantMessage("已开始。"),
    ]);
    const workId = works(world)[0]!.id;

    // 确定性动画工程：从零生成可解码短动画（输出不进封存清单，由本次执行产生）。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "anim.py", content: animFirst })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I anim.py", timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "动画工程", files: ["anim.py"],
        entrypoint: { argv: ["python3", "-I", "anim.py"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("工程已冻结。"),
    ], "按配方封存动画工程。");
    const animRef = latestProjectRef();
    const animEntrypoint = { argv: ["python3", "-I", "anim.py"] };

    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 首渲", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "v3-anim-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: animRef, entrypoint: animEntrypoint,
            outputPath: "output.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "create", key: "v3", title: "V3", nextIntent: null },
            item: { mode: "create", key: "anim", label: "动画", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "生成首版动画。");
    const firstRunId = runOf();
    const first = await drive(world, firstRunId);
    assert.equal(first.state, "succeeded");
    const firstDigest = digestOf(first.outputRevisions[0]!.revisionId);
    const firstMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", first.outputRevisions[0]!.revisionId) as { blobId: string };
    const firstFacts = await probeVideoFile(world.blobs.filePath(world.blobs.get("local-owner", firstMedia.blobId).digest));
    assert.equal(firstFacts.width, 320); assert.equal(firstFacts.height, 180); assert.equal(firstFacts.frameRate, 4);

    // 同源码确定性重渲：产出同样字节合法（不因摘要相同而拒绝）。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 重渲", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "v3-anim-2", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: animRef, entrypoint: animEntrypoint,
            outputPath: "output.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "create", key: "v3", title: "V3", nextIntent: null },
            item: { mode: "create", key: "anim-rerender", label: "重渲", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "原样重渲。");
    const rerun = await drive(world, runOf());
    assert.equal(rerun.state, "succeeded");
    assert.equal(digestOf(rerun.outputRevisions[0]!.revisionId), firstDigest, "同源码重渲产出同样字节");

    // 合法封存 + 确实执行 + 正常退出但不写声明输出：不能交付旧文件。
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "silent.py", content: "import sys\nsys.exit(0)\n" })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I silent.py", timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "静默工程", files: ["silent.py"],
        entrypoint: { argv: ["python3", "-I", "silent.py"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("静默工程已冻结。"),
    ], "封存不产出的工程。");
    const silentRef = latestProjectRef();
    const videosBefore = count(world, "FROM artifacts WHERE kind='video'");
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 静默", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "v3-silent-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: silentRef,
            entrypoint: { argv: ["python3", "-I", "silent.py"] },
            outputPath: "output.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "create", key: "v3-silent", title: "静默", nextIntent: null },
            item: { mode: "create", key: "silent-anim", label: "静默动画", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "渲染静默工程。");
    const silentRun = await drive(world, runOf());
    assert.equal(silentRun.state, "failed", "正常退出但没有声明输出必须失败");
    assert.match(silentRun.issue?.message ?? "", /没有产生声明的输出 output\.mp4/);
    assert.equal(silentRun.outputRevisions.length, 0);
    assert.equal(count(world, "FROM artifacts WHERE kind='video'"), videosBefore, "不交付旧文件，也不新增产物");
    const silentSpec = jsonField(world, "SELECT spec_json FROM production_snapshots WHERE id=?", "spec_json", silentRun.snapshotId) as { operations: { target: { groupId: string; itemId: string } }[] };
    assert.equal(itemOf(world, silentSpec.operations[0]!.target.groupId, silentSpec.operations[0]!.target.itemId).draft, null, "目标事项保持无主稿");

    // 不匹配镜像：清楚失败，不默默换镜像运行。
    const animContent = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?", "content_json", animRef.artifactId, animRef.revisionId) as CreativeProjectContent;
    const restore = world.runtime.database.prepare("UPDATE artifact_revisions SET content_json=? WHERE id=?");
    restore.run(JSON.stringify({ ...animContent, runtimeImage: `sha256:${"0".repeat(64)}` }), animRef.revisionId);
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 镜像", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "v3-mismatch-1", outputSlot: "video-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: animRef, entrypoint: animEntrypoint,
            outputPath: "output.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
          target: { group: { mode: "create", key: "v3-mismatch", title: "镜像", nextIntent: null },
            item: { mode: "create", key: "mismatch-anim", label: "镜像动画", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "渲染镜像不一致的工程。");
    const mismatchRun = await drive(world, runOf());
    assert.equal(mismatchRun.state, "failed");
    assert.match(mismatchRun.issue?.message ?? "", /环境不匹配/);
    restore.run(JSON.stringify(animContent), animRef.revisionId);

    // 含空格参数按原 argv 逐项直传：脚本只在收到原样单一参数时产出可解码图片。
    const spacedScript = `import sys
from PIL import Image
if sys.argv[1:] != ["参数 含 空格"]:
    sys.exit(4)
Image.new("RGB", (320, 180), "#243447").save("spaced.png")
`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "spaced.py", content: spacedScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: 'python3 -I spaced.py "参数 含 空格"', timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "参数工程", files: ["spaced.py"],
        entrypoint: { argv: ["python3", "-I", "spaced.py", "参数 含 空格"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("参数工程已冻结。"),
    ], "封存带空格参数的工程。");
    const spacedRef = latestProjectRef();
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 参数", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [{ operationId: "v3-spaced-1", outputSlot: "image-1", inputs: [],
          parameters: { assembly: "code_project", projectRevision: spacedRef,
            entrypoint: { argv: ["python3", "-I", "spaced.py", "参数 含 空格"] },
            outputPath: "spaced.png", expectedMediaKind: "image", format: "png", width: 320, height: 180 },
          target: { group: { mode: "create", key: "v3-spaced", title: "参数", nextIntent: null },
            item: { mode: "create", key: "spaced-image", label: "参数图片", role: "storyboard", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "渲染带空格参数的工程。");
    const spacedRun = await drive(world, runOf());
    assert.equal(spacedRun.state, "succeeded", "参数原样直达才产出（守卫判别）");
    const spacedMedia = jsonField(world, "SELECT content_json FROM artifact_revisions WHERE id=?", "content_json", spacedRun.outputRevisions[0]!.revisionId) as { blobId: string };
    const spacedFacts = await probeImageFile(world.blobs.filePath(world.blobs.get("local-owner", spacedMedia.blobId).digest));
    assert.equal(spacedFacts.width, 320); assert.equal(spacedFacts.height, 180);

    // 两操作各自输出且依赖有效：第二操作物化消费第一操作产物，字节一致。
    const passthroughScript = `import os, shutil
if os.path.exists("inputs/0.mp4"):
    if os.path.getsize("inputs/0.mp4") <= 1000:
        raise SystemExit(3)
    shutil.copyfile("inputs/0.mp4", "out2.mp4")
else:
    open("out2.mp4", "wb").close()
`;
    await send(world, [
      fauxAssistantMessage([fauxToolCall("write", { path: "passthrough.py", content: passthroughScript })]),
      fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I passthrough.py", timeout: 90 })]),
      fauxAssistantMessage([fauxToolCall("publish_project", { workId, title: "复用工程", files: ["passthrough.py"],
        entrypoint: { argv: ["python3", "-I", "passthrough.py"] }, dependencyLocks: [], timelineFiles: [], sourceRevisions: [] })]),
      fauxAssistantMessage("复用工程已冻结。"),
    ], "封存复用工程。");
    const passRef = latestProjectRef();
    await send(world, [
      fauxAssistantMessage([fauxToolCall("render_project", { workId, title: "V3 依赖链", scope: "判别", purpose: "draft",
        inputSources: [], reviewInputs: [],
        operations: [
          { operationId: "v3-chain-1", outputSlot: "video-1", inputs: [],
            parameters: { assembly: "code_project", projectRevision: animRef, entrypoint: animEntrypoint,
              outputPath: "output.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
            target: { group: { mode: "create", key: "v3-chain", title: "依赖链", nextIntent: null },
              item: { mode: "create", key: "chain-source", label: "链源", role: "clip", required: true } } },
          { operationId: "v3-chain-2", outputSlot: "video-2",
            inputs: [{ kind: "operation_output", producerOperationId: "v3-chain-1", outputSlot: "video-1" }],
            parameters: { assembly: "code_project", projectRevision: passRef,
              entrypoint: { argv: ["python3", "-I", "passthrough.py"] },
              outputPath: "out2.mp4", expectedMediaKind: "video", format: "mp4", width: 320, height: 180, fps: 4 },
            target: { group: { mode: "create", key: "v3-derived", title: "派生", nextIntent: null },
              item: { mode: "create", key: "chain-derived", label: "链产物", role: "clip", required: true } } }] })]),
      fauxAssistantMessage("已受理。"),
    ], "两步链式渲染。");
    const chained = await drive(world, runOf());
    assert.equal(chained.state, "succeeded");
    assert.equal(chained.outputRevisions.length, 2, "两操作各自产出");
    assert.equal(digestOf(chained.outputRevisions[0]!.revisionId), firstDigest, "链源产出与首渲同字节");
    assert.equal(digestOf(chained.outputRevisions[1]!.revisionId), firstDigest, "第二操作真实消费了第一操作的物化产物");

    await writeFile(path.join(directory, "evidence.json"), JSON.stringify({
      imageId: broker.imageId, socketPath: broker.socketPath,
      runs: [
        { purpose: "首渲（可解码短动画）", runId: firstRunId, state: first.state, digest: firstDigest },
        { purpose: "同源码重渲（同字节）", runId: rerun.id, state: rerun.state, digest: digestOf(rerun.outputRevisions[0]!.revisionId) },
        { purpose: "静默无输出（拒交旧文件）", runId: silentRun.id, state: silentRun.state, issue: silentRun.issue?.message ?? null },
        { purpose: "镜像不匹配（拒执行）", runId: mismatchRun.id, state: mismatchRun.state, issue: mismatchRun.issue?.message ?? null },
        { purpose: "含空格 argv（可解码图片）", runId: spacedRun.id, state: spacedRun.state },
        { purpose: "两操作依赖链", runId: chained.id, state: chained.state },
      ],
    }, null, 2));
  } finally { await world.close(); }
});
