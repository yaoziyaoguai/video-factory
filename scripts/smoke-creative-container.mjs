import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// 在正式 app 中用 node --input-type=module < script 或 node /tmp/script.mjs 运行。
// 必填 socket、期望镜像 sha256 ID、唯一 SMOKE_ID；MODE=image 只核对镜像，不创建卷。
// stdout 为白名单 NDJSON；宿主按 workspace 记录及 skillsRevisions 精确清理本次卷。
let stage = "configuration";
let workspaceId;

async function smoke() {
  const socketPath = process.env.AGENT_CREATIVE_RUNNER_SOCKET;
  const expectedImage = process.env.FRAME_CREATIVE_EXPECT_IMAGE;
  const smokeId = process.env.FRAME_CREATIVE_SMOKE_ID;
  const mode = process.env.FRAME_CREATIVE_SMOKE_MODE ?? "full";
  assert.ok(typeof socketPath === "string" && path.isAbsolute(socketPath));
  assert.match(expectedImage ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.match(smokeId ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
  assert.ok(mode === "full" || mode === "image");
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 1001);
  assert.equal(existsSync("/var/run/docker.sock") || existsSync("/run/docker.sock"), false);

  stage = "compiled-runner";
  const { CreativeRunner, creativeWorkspaceId } = await import("/app/apps/studio/dist/server/server/agent/creative-runner.js");
  const workspace = {
    conversationId: `creative-smoke-conversation-${smokeId}`,
    workId: `creative-smoke-work-${smokeId}`,
    executionId: `creative-smoke-execution-${smokeId}`,
  };
  workspaceId = creativeWorkspaceId(workspace);
  // 必须早于任何可能创建卷的调用；即使后续失败也能清理，不触及用户会话或数据库。
  console.log(JSON.stringify({ event: "workspace", mode, ...workspace, creativeWorkspaceId: workspaceId }));
  const runner = new CreativeRunner({ socketPath });
  stage = "image-id";
  const imageId = await runner.imageId(workspace);
  assert.equal(imageId, expectedImage);
  if (mode === "image") {
    console.log(JSON.stringify({ event: "passed", mode, creativeWorkspaceId: workspaceId, imageId }));
    return;
  }

  const skillId = "frame-creative-smoke";
  const skillText = "---\nname: frame-creative-smoke\ndescription: Synthetic container smoke fixture\n---\nRead-only smoke resource.\n";
  // 与现有快照规则相同，只计算清理所需摘要；所有生产请求仍由 CreativeRunner 发出。
  const skillsRevision = createHash("sha256").update(JSON.stringify([
    { path: `${skillId}/SKILL.md`, data: Buffer.from(skillText).toString("base64") },
  ])).digest("hex");
  console.log(JSON.stringify({ event: "volumes", creativeWorkspaceId: workspaceId, skillsRevisions: ["empty", skillsRevision] }));

  stage = "runner-write-read";
  const roundtrip = "synthetic creative runner roundtrip\n";
  await runner.writeFile(workspace, "roundtrip.txt", roundtrip);
  assert.equal((await runner.readFile(workspace, "roundtrip.txt")).toString("utf8"), roundtrip);
  console.log(JSON.stringify({ event: "runner-write-read", bytes: Buffer.byteLength(roundtrip), matched: true }));

  stage = "runner-media";
  // 沿用真实创作用例的 PIL 八帧、320x180、4fps 配方；不接触媒体供应商。
  await runner.writeFile(workspace, "render.py", `import hashlib, json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw
frames = Path("frames")
frames.mkdir(exist_ok=True)
for i in range(8):
    image = Image.new("RGB", (320, 180), "#15263c")
    draw = ImageDraw.Draw(image)
    x = 16 + i * 32
    draw.rounded_rectangle([x, 65, x + 50, 115], radius=12, fill="#f6ca65")
    image.save(frames / f"{i:03d}.png")
assert (frames / "000.png").read_bytes() != (frames / "007.png").read_bytes()
with Image.open(frames / "000.png") as image:
    image.load()
    assert image.format == "PNG" and image.size == (320, 180)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "4", "-i", "frames/%03d.png",
    "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "output.mp4"], check=True, capture_output=True)
probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=duration", "-of", "json", "output.mp4"]))
stream = probe["streams"][0]
duration = float(probe["format"]["duration"])
assert stream["codec_name"] == "h264" and (stream["width"], stream["height"]) == (320, 180)
assert int(stream["nb_read_frames"]) == 8 and abs(duration - 2) < 0.05
subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", "output.mp4", "-map", "0:v:0", "-f", "null", "-"],
    check=True, capture_output=True)
png = (frames / "000.png").read_bytes()
mp4 = Path("output.mp4").read_bytes()
print(json.dumps({"pngBytes": len(png), "mp4Bytes": len(mp4), "pngSha256": hashlib.sha256(png).hexdigest(),
    "mp4Sha256": hashlib.sha256(mp4).hexdigest(), "durationSeconds": duration, "frames": int(stream["nb_read_frames"])}))
`);
  const mediaOutput = [];
  const execution = await runner.execute(workspace, "python3 -I render.py", { timeout: 90, onData: chunk => mediaOutput.push(chunk) });
  assert.equal(execution.exitCode, 0);
  const media = JSON.parse(Buffer.concat(mediaOutput).toString("utf8"));
  const png = await runner.readFile(workspace, "frames/000.png");
  const mp4 = await runner.readFile(workspace, "output.mp4");
  assert.ok(png.length > 0 && mp4.length > 0);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(mp4.subarray(4, 8).toString("ascii"), "ftyp");
  assert.equal(png.length, media.pngBytes);
  assert.equal(mp4.length, media.mp4Bytes);
  assert.equal(createHash("sha256").update(png).digest("hex"), media.pngSha256);
  assert.equal(createHash("sha256").update(mp4).digest("hex"), media.mp4Sha256);
  assert.ok(Math.abs(media.durationSeconds - 2) < 0.05);
  assert.equal(media.frames, 8);
  console.log(JSON.stringify({ event: "media", pngBytes: png.length, mp4Bytes: mp4.length,
    pngSha256: media.pngSha256, mp4Sha256: media.mp4Sha256, durationSeconds: media.durationSeconds, decodedFrames: media.frames }));

  stage = "synthetic-skill";
  const temporary = await mkdtemp("/tmp/frame-creative-smoke-");
  try {
    const skillDirectory = `${temporary}/skill`;
    await mkdir(skillDirectory);
    await writeFile(`${skillDirectory}/SKILL.md`, skillText);
    await writeFile(`${temporary}/outside.txt`, "synthetic app-only sentinel\n");
    const context = { ...workspace, deliveryClosed: false, skills: [{ id: skillId, directory: skillDirectory }] };
    const tools = Object.fromEntries(runner.tools(() => context).map(tool => [tool.name, tool]));

    stage = "pi-write";
    const written = await tools.write.execute("smoke-write", { path: "pi.txt", content: "pi before\n" });
    assert.notEqual(written.isError, true);
    assert.equal(written.content[0].text, "Successfully wrote to /workspace/pi.txt");
    assert.equal((await runner.readFile(workspace, "pi.txt")).toString("utf8"), "pi before\n");
    console.log(JSON.stringify({ event: "pi-tool", name: "write", result: written.content[0].text }));

    stage = "pi-read";
    const read = await tools.read.execute("smoke-read", { path: "pi.txt" });
    assert.notEqual(read.isError, true);
    assert.equal(read.content[0].text, "pi before\n");
    console.log(JSON.stringify({ event: "pi-tool", name: "read", result: read.content[0].text }));

    stage = "pi-edit";
    const edited = await tools.edit.execute("smoke-edit", { path: "pi.txt", edits: [{ oldText: "pi before", newText: "pi after" }] });
    assert.notEqual(edited.isError, true);
    assert.equal(edited.content[0].text, "Successfully replaced 1 block(s) in /workspace/pi.txt.");
    const after = (await runner.readFile(workspace, "pi.txt")).toString("utf8");
    assert.equal(after, "pi after\n");
    console.log(JSON.stringify({ event: "pi-tool", name: "edit", result: edited.content[0].text, fileAfter: after }));

    stage = "pi-bash-isolation";
    const bash = await tools.bash.execute("smoke-bash", { timeout: 30, command: `python3 -I - <<'PY'
import errno, json, os, socket
from pathlib import Path
assert os.getuid() == 1001 and os.getgid() == 1001
assert set(os.environ) <= {"PATH", "LANG", "LC_CTYPE", "PWD", "SHLVL", "_"}
assert not any(Path(p).exists() for p in ["/var/run/docker.sock", "/run/docker.sock", "/app", "/data/factory", ${JSON.stringify(temporary)}])
assert Path("/skills/${skillId}/SKILL.md").read_text() == ${JSON.stringify(skillText)}
mounts = {line.split()[1]: set(line.split()[3].split(",")) for line in Path("/proc/mounts").read_text().splitlines()}
assert "ro" in mounts["/"] and "ro" in mounts["/skills"] and "rw" in mounts["/workspace"]
for target in ["/frame-creative-smoke-write", "/skills/${skillId}/blocked.txt"]:
    try:
        Path(target).write_text("synthetic smoke write")
    except OSError as error:
        assert error.errno == errno.EROFS
    else:
        raise AssertionError("read-only mount accepted a write")
with socket.socket() as connection:
    connection.settimeout(0.2)
    try:
        connection.connect(("1.1.1.1", 443))
    except OSError:
        pass
    else:
        raise AssertionError("network available")
assert Path("/sys/fs/cgroup/memory.max").read_text().strip() == "1073741824"
assert Path("/sys/fs/cgroup/pids.max").read_text().strip() == "128"
assert Path("/sys/fs/cgroup/cpu.max").read_text().strip() == "200000 100000"
assert Path("pi.txt").read_text() == "pi after\\n"
Path("bash.txt").write_text("pi bash visible\\n")
print(json.dumps({"uid": os.getuid(), "gid": os.getgid(), "dockerSocket": False, "appData": False,
    "credentials": False, "network": "blocked", "rootReadOnly": True, "skillsReadOnly": True, "limits": "1g/2cpu/128pids"}))
PY` });
    assert.notEqual(bash.isError, true);
    const isolation = JSON.parse(bash.content[0].text);
    assert.deepEqual(isolation, { uid: 1001, gid: 1001, dockerSocket: false, appData: false, credentials: false,
      network: "blocked", rootReadOnly: true, skillsReadOnly: true, limits: "1g/2cpu/128pids" });
    assert.equal((await runner.readFile(workspace, "bash.txt")).toString("utf8"), "pi bash visible\n");
    console.log(JSON.stringify({ event: "pi-tool", name: "bash", result: isolation, fileAfter: "pi bash visible\n" }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ event: "passed", mode, creativeWorkspaceId: workspaceId, imageId,
    tools: ["write", "read", "edit", "bash"], appUid: process.getuid(), appDockerSocket: false }));
}

try {
  await smoke();
} catch (error) {
  // 原始异常可能带容器 stderr、路径或环境值；仅公开固定阶段与白名单系统错误码。
  const code = ["ENOENT", "EACCES", "ECONNREFUSED", "ECONNRESET", "ENOTSOCK", "ENOTSUP", "ERR_ASSERTION"].includes(error?.code)
    ? error.code : "PROBE_FAILED";
  console.error(JSON.stringify({ event: "failed", stage, creativeWorkspaceId: workspaceId ?? null, code }));
  process.exitCode = 1;
}
