import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { assertCreativeWriteFits, CreativeRunner, CREATIVE_TOOL_NAMES, creativeWorkspaceId, type CreativeToolContext } from "../src/server/agent/creative-runner.js";
import { PiRuntimeHost } from "../src/server/agent/pi-runtime.js";
import { SkillPackages } from "../src/server/agent/skill-packages.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = process.env.FRAME_CREATIVE_TEST_EVIDENCE_DIR ?? path.join(root, ".local/skill-creation");
const dockerSocket = process.env.FRAME_CREATIVE_DOCKER_SOCKET;

const python = `from PIL import Image\nImage.new("RGB", (160, 90), "red").save("python.png")\n`;
const javascript = `const fs=require("fs"),z=require("zlib");
const crc=b=>{let c=-1;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^-1)>>>0};
const chunk=(t,d)=>{let h=Buffer.alloc(4),c=Buffer.alloc(4),b=Buffer.concat([Buffer.from(t),d]);h.writeUInt32BE(d.length);c.writeUInt32BE(crc(b));return Buffer.concat([h,b,c])};
const h=Buffer.alloc(13);h.writeUInt32BE(160,0);h.writeUInt32BE(90,4);h[8]=8;h[9]=2;
const rows=Buffer.alloc(90*(1+160*3));for(let y=0;y<90;y++)for(let x=0;x<160;x++){let p=y*481+1+x*3;rows[p]=40;rows[p+1]=180;rows[p+2]=240;}
fs.writeFileSync("javascript.png",Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",h),chunk("IDAT",z.deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]));
`;
const animation = `const fs=require("fs"),cp=require("child_process");
fs.mkdirSync("frames",{recursive:true});
for(let i=0;i<12;i++){
 fs.writeFileSync("frame.html",\`<!doctype html><style>body{margin:0;background:#15263c}div{position:absolute;top:70px;left:\${20+i*20}px;width:50px;height:50px;background:#f6ca65;border-radius:12px}</style><div></div>\`);
 cp.execFileSync("chromium",["--headless","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--no-zygote","--disable-crash-reporter","--disable-breakpad","--noerrdialogs","--hide-scrollbars","--window-size=320,180","--user-data-dir=/tmp/chromium-"+i,"--screenshot=/workspace/frames/"+String(i).padStart(3,"0")+".png","file:///workspace/frame.html"],{env:{PATH:process.env.PATH,HOME:"/tmp/chromium-home",XDG_CONFIG_HOME:"/tmp/chromium-config",XDG_CACHE_HOME:"/tmp/chromium-cache"},stdio:"ignore"});
}
`;

test("G2-2 Frame 业务工具继续拒绝隐式参数转换", async t => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "strict-"));
  const skillsRoot = path.join(directory, "skills"); await mkdir(skillsRoot);
  const host = new PiRuntimeHost({ dataDir: path.join(directory, "app"), skillsRoot, faux: { provider: "strict-local", modelIds: ["controlled"] } });
  await host.init(); t.after(() => host.dispose());
  const applied: number[] = [];
  const schema = Type.Object({ count: Type.Number() });
  const tool: ToolDefinition<typeof schema> = { name: "frame_contract", label: "Frame contract", description: "Strict business contract fixture",
    parameters: schema, execute: async (_id, args) => {
      applied.push(args.count); return { content: [{ type: "text", text: String(args.count) }], details: undefined };
    } };
  const selection = await host.modelForBinding({ providerId: "strict-local", modelId: "controlled", connectionId: "local", configurationRevisionId: "1" });
  const { session } = await host.openConversationSession("strict", "s1", [tool], [tool.name], selection);
  t.after(() => session.dispose());
  const errors: boolean[] = [];
  session.subscribe(event => { if (event.type === "tool_execution_end") errors.push(event.isError); });
  host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("frame_contract", { count: "2" })]),
    fauxAssistantMessage([fauxToolCall("frame_contract", { count: 2 })]), fauxAssistantMessage("合同检查结束")]);
  await session.prompt("业务参数保持严格类型。");
  assert.deepEqual(applied, [2]); assert.deepEqual(errors, [true, false]);
});

test("DD-10 写入上限与真实序列化的 Unicode、JSON 转义和 base64 分组一致", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "fw-"));
  let body: Buffer | undefined;
  const socketPath = path.join(directory, "s");
  const listener = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    body = Buffer.concat(chunks);
    response.end("{}\n");
  });
  t.after(async () => {
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => listener.listen(socketPath, resolve));

  const workspace = { conversationId: "dd10-conversation", workId: "dd10-work", executionId: "dd10-run" };
  const inputPath = '资料//./引号"文件.bin';
  const normalizedPath = '/workspace/资料/引号"文件.bin';
  const content = "甲Z";
  await new CreativeRunner({ socketPath }).writeFile(workspace, inputPath, content);
  assert.ok(body);
  const observed = JSON.parse(body.toString());
  const base64 = Buffer.from(content).toString("base64");
  assert.deepEqual(observed, { workspaceId: creativeWorkspaceId(workspace), action: "write", path: normalizedPath, data: base64 });
  const envelopeBytes = body.length - base64.length;
  const limit = 128 * 1024 * 1024;
  const maxRawBytes = Math.floor((limit - envelopeBytes) / 4) * 3;
  assert.equal(assertCreativeWriteFits(inputPath, maxRawBytes, "边界夹具："), normalizedPath);
  const rejectedSize = envelopeBytes + 4 * Math.ceil((maxRawBytes + 1) / 3);
  assert.ok(rejectedSize > limit);
  assert.throws(() => assertCreativeWriteFits(inputPath, maxRawBytes + 1, "边界夹具："), {
    code: "INVALID_INPUT",
    message: new RegExp(`原文件 ${maxRawBytes + 1} B.*写入请求 ${rejectedSize} B`),
  });
});

// 必须显式选择已运行 daemon；缺失时跳过，不以宿主 shell 或假容器代替。
test("G2 大型二进制资源经真实 UDS 完整往返，坏 base64 在入口拒绝", { skip: !dockerSocket, timeout: 120_000 }, async t => {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "g2-bin-"));
  const { createCreativeRunnerHost } = await import(new URL("../../../scripts/creative-runner-host.mjs", import.meta.url).href);
  const broker = await createCreativeRunnerHost({ socketPath: path.join(directory, "s"), workspaceRoot: path.join(directory, "workspaces"), dockerSocket });
  t.after(() => broker.close());
  const workspace = { conversationId: "g2-binary", workId: "font", executionId: "project" };
  for (const data of ["AAA", "AA=A"]) {
    const response = await new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const request = http.request({ socketPath: broker.socketPath, path: "/", method: "POST" }, reply => {
        let text = "";
        reply.setEncoding("utf8");
        reply.on("data", chunk => { text += chunk; });
        reply.on("end", () => resolve({ status: reply.statusCode, text }));
        reply.on("error", reject);
      });
      request.on("error", reject);
      request.end(JSON.stringify({ workspaceId: creativeWorkspaceId(workspace), action: "write", path: "/workspace/invalid.bin", data }));
    });
    assert.equal(response.status, 400);
    assert.match(response.text, /base64/);
  }
  // 实际19MB字体恢复触发过嵌套正则爆栈；按同一规模验证字节，而非只测正则返回值。
  const bytes = Buffer.alloc(20 * 1024 * 1024 + 1, 0x6d);
  const runner = new CreativeRunner({ socketPath: broker.socketPath });
  await runner.writeFile(workspace, "binary-resource.bin", bytes);
  assert.deepEqual(await runner.readFile(workspace, "binary-resource.bin"), bytes);
});

test("G2-1 真实 Pi Operations / PNG / Chromium-FFmpeg / 缓存会话 A-B / 隔离与交付暂停", { skip: !dockerSocket, timeout: 240_000 }, async t => {
  await mkdir(evidence, { recursive: true });
  // 安装器按真实路径加载 Skill，测试绝对路径映射时也使用同一真实路径。
  const directory = await realpath(await mkdtemp(path.join(evidence, "g2-")));
  const skill = path.join(directory, "source-skill");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: native-fixture\ndescription: Operations fixture\n---\nRead references/notes.txt.\n");
  await writeFile(path.join(skill, "references/notes.txt"), "read-only skill reference\n");
  const sentinel = path.join(directory, "outside-sentinel.txt");
  await writeFile(sentinel, "synthetic outside sentinel\n");
  const hostModule = new URL("../../../scripts/creative-runner-host.mjs", import.meta.url).href;
  const { createCreativeRunnerHost } = await import(hostModule);
  const broker = await createCreativeRunnerHost({ socketPath: path.join(directory, "runtime", "s"), workspaceRoot: path.join(directory, "workspaces"), dockerSocket });
  t.after(() => broker.close());
  const runner = new CreativeRunner({ socketPath: broker.socketPath });
  const builtin = path.join(directory, "empty-skills"); await mkdir(builtin);
  const packages = new SkillPackages(path.join(directory, "app"), builtin);
  await packages.initialize(); await packages.install(skill);
  const upstream = process.env.FRAME_CREATIVE_UPSTREAM_PATH;
  if (upstream) await packages.install(upstream);
  await packages.refresh();
  let nativeToolCalls = 0;
  let context: CreativeToolContext | null = { conversationId: "g2-conversation", workId: "A", executionId: "project", deliveryClosed: false,
    skills: packages.resources().skills.map(skill => ({ id: skill.name, directory: skill.baseDir })), onToolCall: () => { nativeToolCalls++; } };
  const workspaceA = { ...context, workId: "A" };
  const host = new PiRuntimeHost({ dataDir: path.join(directory, "app"), skillsRoot: builtin, skillPackages: packages, creativeRunner: runner,
    faux: { provider: "g2-local", modelIds: ["controlled"] } });
  await host.init();
  t.after(() => host.dispose());
  const selection = await host.modelForBinding({ providerId: "g2-local", modelId: "controlled", connectionId: "local", configurationRevisionId: "1" });
  const { session } = await host.openConversationSession("g2-conversation", "s1", undefined, [], selection, undefined, () => null, () => context);
  assert.ok(CREATIVE_TOOL_NAMES.every(name => session.getActiveToolNames().includes(name)));
  t.after(() => session.dispose());
  const results: { name: string; error: boolean; image: boolean; text: string }[] = [];
  session.subscribe(event => {
    if (event.type === "tool_execution_end") results.push({ name: event.toolName, error: event.isError,
      image: event.result.content.some((block: { type: string }) => block.type === "image"),
      text: event.result.content.filter((block: { type: string }) => block.type === "text").map((block: { text: string }) => block.text).join("\n") });
  });
  const responses = [
    (ctx: TranscriptContext) => {
      assert.match(JSON.stringify(ctx.messages), /References are relative to \/skills\/native-fixture/);
      const projected = JSON.stringify(ctx.messages);
      const hostPath = projected.indexOf(skill + path.sep);
      assert.equal(hostPath, -1, projected.slice(Math.max(0, hostPath - 80), hostPath + skill.length + 100));
      return fauxAssistantMessage([fauxToolCall("read", { path: path.join(skill, "references/notes.txt"), limit: "1", offset: null })]);
    },
    fauxAssistantMessage([fauxToolCall("write", { path: "render.py", content: python })]),
    fauxAssistantMessage([fauxToolCall("edit", { path: "render.py", edits: [{ oldText: '"red"', newText: '"blue"' }] })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "python3 -I render.py", timeout: 15 })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "python.png" })]),
    fauxAssistantMessage([fauxToolCall("write", { path: "render.cjs", content: javascript })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "node render.cjs", timeout: 15 })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "javascript.png" })]),
    fauxAssistantMessage([fauxToolCall("write", { path: "animation.cjs", content: animation })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "node animation.cjs && python3 -I -c 'from PIL import Image; from pathlib import Path; assert Image.open(\"python.png\").getpixel((0,0)) == (0,0,255); assert Image.open(\"javascript.png\").getpixel((0,0)) == (40,180,240); assert Path(\"frames/000.png\").read_bytes() != Path(\"frames/011.png\").read_bytes()' && ffmpeg -v error -y -framerate 4 -i frames/%03d.png -c:v libx264 -threads 2 -pix_fmt yuv420p -t 3 animation.mp4 && ffprobe -v error -show_entries format=duration -of json animation.mp4", timeout: 120 })]),
    fauxAssistantMessage("完成本地受控响应小样"),
  ];
  host.faux!.setResponses(responses);
  await session.prompt("/skill:native-fixture 读取 Skill 后创建、修改并执行 Python/JS；输出 PNG 与 3 秒动画。");
  assert.ok(results.length > 0, JSON.stringify(session.agent.state.messages.at(-1)));
  assert.equal(results.some(result => result.error), false, JSON.stringify(results));
  assert.equal(results.filter(result => result.image).length, 2);
  assert.match(results.find(result => result.name === "read")!.text, /read-only skill reference/);
  assert.match(results.at(-1)!.text, /3\.000000/);
  await writeFile(path.join(directory, "python.png"), await runner.readFile(workspaceA, "python.png"));
  await writeFile(path.join(directory, "javascript.png"), await runner.readFile(workspaceA, "javascript.png"));
  await writeFile(path.join(directory, "animation.mp4"), await runner.readFile(workspaceA, "animation.mp4"));
  assert.ok((await runner.listFiles(workspaceA)).some(file => file.path === "animation.mp4" && file.size > 0));

  context = { ...workspaceA, workId: "B" };
  const workspaceB = { ...context, workId: "B" };
  host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "identity.txt", content: "work B" })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "identity.txt" })]), fauxAssistantMessage("B complete"),
  ]);
  await session.prompt("在同一缓存会话切换到明确工作 B。");
  assert.equal((await runner.readFile(workspaceB, "identity.txt")).toString(), "work B");
  context = { ...workspaceA };
  host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "render.py" })]), fauxAssistantMessage("A retained")]);
  await session.prompt("明确回到工作 A，读取原工程。");
  assert.match(results.at(-1)!.text, /blue/);
  await assert.rejects(runner.readFile(workspaceA, "identity.txt"), /No such file/);

  const isolation = `import os,socket,json\nfrom pathlib import Path\nassert 'HOME' not in os.environ\nassert 'FRAME_CREATIVE_APP_SENTINEL' not in os.environ\nassert not Path(${JSON.stringify(sentinel)}).exists()\nassert not Path('/var/run/docker.sock').exists()\nassert not Path('/data/factory').exists()\ns=socket.socket();s.settimeout(.2)\ntry:\n s.connect(('1.1.1.1',443));raise AssertionError('network available')\nexcept OSError: pass\nprint(json.dumps({'uid':os.getuid(),'gid':os.getgid(),'env':sorted(os.environ),'network':'blocked','memory':Path('/sys/fs/cgroup/memory.max').read_text().strip(),'pids':Path('/sys/fs/cgroup/pids.max').read_text().strip(),'cpu':Path('/sys/fs/cgroup/cpu.max').read_text().strip()}))\n`;
  await runner.writeFile(workspaceA, "isolation.py", isolation);
  const data: Buffer[] = [];
  const checked = await runner.execute(workspaceA, "python3 -I isolation.py", { timeout: 15, onData: chunk => data.push(chunk) });
  assert.equal(checked.exitCode, 0, Buffer.concat(data).toString());
  const environment = JSON.parse(Buffer.concat(data).toString());
  assert.equal(environment.memory, "1073741824"); assert.equal(environment.pids, "128");
  assert.equal(environment.cpu, "200000 100000");
  host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: sentinel })]),
    fauxAssistantMessage([fauxToolCall("write", { path: "/skills/native-fixture/references/notes.txt", content: "mutate" })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "ln -s /etc/passwd escape", timeout: 15 })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "escape" })]), fauxAssistantMessage("边界已检查"),
  ]);
  const boundaryStart = results.length;
  await session.prompt("验证合成外部哨兵和只读资源边界。");
  assert.deepEqual(results.slice(boundaryStart).map(result => result.error), [true, true, false, true]);
  assert.equal(await readFile(sentinel, "utf8"), "synthetic outside sentinel\n");
  context = { ...workspaceA, deliveryClosed: true };
  host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "after-delivery", content: "no" })]),
    fauxAssistantMessage([fauxToolCall("edit", { path: "render.py", edits: [{ oldText: '"blue"', newText: '"red"' }] })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "touch after-delivery", timeout: 15 })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "render.py" })]), fauxAssistantMessage("交付后仅说明"),
  ]);
  const closedStart = results.length;
  await session.prompt("已交付边界。");
  assert.deepEqual(results.slice(closedStart).map(result => result.error), [true, true, true, false]);
  assert.ok(results.slice(closedStart, closedStart + 3).every(result => /DELIVERY_CLOSED|本请求已交付/.test(result.text)));
  assert.match((await runner.readFile(workspaceA, "render.py")).toString(), /blue/);

  // 取消只作用于本次容器，另一个明确工作仍能独立完成。
  const abort = new AbortController();
  const stopped = runner.execute(workspaceA, "printf started; sleep 10", { timeout: 20, signal: abort.signal, onData: () => abort.abort() });
  const other = runner.execute(workspaceB, "printf retained > retained.txt", { timeout: 15 });
  await assert.rejects(stopped, /aborted/);
  assert.equal((await other).exitCode, 0);
  assert.equal((await runner.readFile(workspaceB, "retained.txt")).toString(), "retained");
  context = { ...workspaceA, workId: null, readOnly: true };
  host.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall("read", { path: "/skills/native-fixture/references/notes.txt" })]),
    fauxAssistantMessage([fauxToolCall("read", { path: "/workspace/render.py" })]),
    fauxAssistantMessage([fauxToolCall("bash", { command: "touch forbidden", timeout: 15 })]), fauxAssistantMessage("无作品时只读 Skill"),
  ]);
  const readOnlyStart = results.length;
  await session.prompt("无明确作品时只读参考。");
  assert.deepEqual(results.slice(readOnlyStart).map(result => result.error), [false, true, true]);
  if (upstream) {
    context = { ...workspaceA };
    host.faux!.setResponses([
      ctx => { assert.match(JSON.stringify(ctx.messages), /<skill name=.*huashu-art-motion/); return fauxAssistantMessage([fauxToolCall("read", { path: "/skills/huashu-art-motion/references/04-纯代码绘制.md" })]); },
      ctx => { assert.match(JSON.stringify(ctx.messages), /Canvas/); return fauxAssistantMessage([fauxToolCall("edit", { path: "animation.cjs", edits: [
        { oldText: "background:#15263c", newText: "background:#efe8db" }, { oldText: "background:#f6ca65", newText: "background:#b85638" },
      ] })]); },
      fauxAssistantMessage([fauxToolCall("bash", { command: "node animation.cjs && ffmpeg -v error -y -framerate 4 -i frames/%03d.png -c:v libx264 -threads 2 -pix_fmt yuv420p -t 3 huashu.mp4 && ffprobe -v error -show_entries format=duration -of json huashu.mp4", timeout: 120 })]),
      fauxAssistantMessage("已按所读参考的逐帧 Chromium/FFmpeg 路径产出暖色动画。"),
    ]);
    await session.prompt("/skill:huashu-art-motion 只读取纯代码绘制参考，使用当前已保存的动画工程；不调用宿主专有工具、联网或更新包。");
    assert.equal(results.at(-1)!.error, false);
    assert.match(results.at(-1)!.text, /3\.000000/);
    await writeFile(path.join(directory, "huashu.mp4"), await runner.readFile(workspaceA, "huashu.mp4"));
    await runner.writeFile(workspaceA, "retained-reference.md", await readFile(path.join(upstream, "references/04-纯代码绘制.md")));
    const pkg = packages.read().packages.find(pkg => pkg.skillIds.includes("huashu-art-motion"))!;
    await packages.remove(pkg.id); await packages.refresh(); await session.reload();
    context = { ...workspaceA, skills: packages.resources().skills.map(skill => ({ id: skill.name, directory: skill.baseDir })) };
    host.faux!.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "/skills/huashu-art-motion/SKILL.md" })]), fauxAssistantMessage("卸载后不可发现或读取，工程保留")]);
    await session.prompt("卸载后的资源边界。");
    assert.equal(results.at(-1)!.error, true);
    assert.match((await runner.readFile(workspaceA, "retained-reference.md")).toString(), /Canvas/);
    assert.equal((await runner.execute(workspaceA, "node animation.cjs && ffmpeg -v error -y -framerate 4 -i frames/%03d.png -c:v libx264 -threads 2 -pix_fmt yuv420p -t 3 retained.mp4", { timeout: 120 })).exitCode, 0);
  }

  const appProbe = `const http=require("http"),fs=require("fs");if(fs.existsSync("/var/run/docker.sock"))throw Error("unexpected Docker socket");const call=input=>new Promise((resolve,reject)=>{const req=http.request({socketPath:"/run/frame-creative/s",method:"POST",path:"/"},res=>{let body="";res.on("data",d=>body+=d);res.on("end",()=>resolve({status:res.statusCode,body}))});req.on("error",reject);req.end(JSON.stringify(input))});(async()=>{const base={workspaceId:${JSON.stringify(creativeWorkspaceId(workspaceA))},action:"execute",command:"python3 -I isolation.py",timeout:15};const denied=await call({...base,image:"arbitrary"});if(denied.status!==400)throw Error(JSON.stringify(denied));const result=await call(base);if(!result.body.includes('"exitCode":0'))throw Error(JSON.stringify(result));console.log(JSON.stringify({dockerSocket:false,extraConfigurationDenied:denied.status,result}))})().catch(e=>{console.error(e);process.exitCode=1});`;
  let appSocketProbe: string;
  let linuxSocketProbe: { status: "verified" | "blocked"; reason?: string } = { status: "verified" };
  try {
    ({ stdout: appSocketProbe } = await promisify(execFile)("docker", ["--host", `unix://${dockerSocket}`, "run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user", `${broker.uid}:${broker.gid}`,
    "--env", "FRAME_CREATIVE_APP_SENTINEL=must-not-reach-creation", "--mount", `type=bind,src=${path.dirname(broker.socketPath)},dst=/run/frame-creative,readonly`,
    "--entrypoint", "node", broker.imageId, "-e", appProbe], { timeout: 30_000,
    env: { PATH: process.env.PATH, DOCKER_CONFIG: path.join(path.dirname(broker.socketPath), "docker-client") } }));
  } catch (error) {
    // 两种失败都是 Colima 环境的结构性限制，不是产品缺陷：VM 看不到共享目录（bind source 不存在），
    // 或共享经 virtiofs、VM 内容器连不上共享目录上的 Unix socket（connect ENOTSUP；真实 Linux 宿主
    // 是原生文件系统可直连）。两者都降级记录 blocked+实际原因，UDS 行为仍由宿主 Node 客户端真实验证。
    const message = error instanceof Error ? error.message : "";
    if (process.platform !== "darwin" || !(/bind source path does not exist/.test(message) || /ENOTSUP/.test(message))) throw error;
    linuxSocketProbe = /ENOTSUP/.test(message)
      ? { status: "blocked", reason: "Colima 的 /Users 共享是 virtiofs，VM 内容器连接共享目录上的 Unix socket 返回 ENOTSUP；真实 Linux 宿主为原生文件系统，直连预演在此环境无法进行，不改 daemon。" }
      : { status: "blocked", reason: "当前 Colima 未共享 Mac socket 目录，VM 无现成 Node；Linux 宿主直连预演未验证，不改 daemon 或安装工具。" };
    t.diagnostic(linuxSocketProbe.reason!);
    // Mac 日常 app 与入口同在宿主，用独立可信 Node 客户端验证实际 UDS；创作命令仍只进容器。
    ({ stdout: appSocketProbe } = await promisify(execFile)(process.execPath, ["-e", appProbe.replace('"/run/frame-creative/s"', JSON.stringify(broker.socketPath))],
      { timeout: 30_000, env: { PATH: process.env.PATH, FRAME_CREATIVE_APP_SENTINEL: "must-not-reach-creation" } }));
  }
  assert.match(appSocketProbe, /extraConfigurationDenied/);
  const socket = await stat(broker.socketPath);
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal(nativeToolCalls, results.length, "每次原生工具入口只计一次，不按内部 Operations 重复计数");
  await writeFile(path.join(directory, "evidence.json"), JSON.stringify({ imageId: broker.imageId, socketPath: broker.socketPath,
    uid: broker.uid, gid: broker.gid, socketMode: (socket.mode & 0o777).toString(8), limits: broker.limits,
    environment, appSocketProbe: JSON.parse(appSocketProbe), linuxSocketProbe, volumeNamespace: broker.volumeNamespace, upstreamResourceCopy: upstream ?? null,
    pngImageBlocks: 2, nativeToolCalls, durationSeconds: 3, workspaceSwitch: "A-B-A same AgentSession", results }, null, 2));
  t.diagnostic(`真实容器证据 ${directory}`);
});
