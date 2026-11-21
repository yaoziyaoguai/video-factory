import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CreativeRunner } from "../src/server/agent/creative-runner.js";
import type { CreativeSkill } from "../src/server/agent/creative-runner.js";

// R11 相同 Skill 修订只发一次文件正文：Pi 工具每次调用前先以“工作区身份+修订”探测，
// 宿主按现有成功集合答复是否需要正文，仅未命中才传整份内容。
// 这里 socket 传输、包遍历、快照缓存全真；仅宿主端点按真实协议模拟
//（探测→needed；携带正文的 skills→确认并入集合，可单测清除以模拟宿主丢失）。

interface RecordedRequest { action: string; carriesFiles: boolean; bodyBytes: number; revision?: string | undefined }

test("R11：同一修订两次读取只传一次正文；宿主丢失后按需重传", async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), "frame-skill-transfer-"));
  t.after(async () => { await rm(scratch, { recursive: true, force: true }); });
  const requests: RecordedRequest[] = [];
  const synced = new Set<string>();
  const sink = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const message = JSON.parse(body.toString("utf8")) as { action: string; revision?: string; files?: unknown[]; probe?: boolean };
    requests.push({ action: message.action, carriesFiles: message.action === "skills" && message.files !== undefined, bodyBytes: body.length, revision: message.revision });
    const reply = message.action === "read"
      ? { data: Buffer.from("test text").toString("base64") }
      : message.action === "skills" && message.probe === true
        ? { needed: !synced.has(message.revision!) }
        : {};
    if (message.action === "skills" && message.files !== undefined) synced.add(message.revision!);
    response.end(JSON.stringify(reply) + "\n");
  });
  t.after(async () => { await new Promise(resolve => sink.close(resolve)); });
  await new Promise<void>((resolve, reject) => { sink.once("error", reject); sink.listen(path.join(scratch, "s"), resolve); });

  const sample = path.join(scratch, "sample");
  await mkdir(sample);
  await writeFile(path.join(sample, "SKILL.md"), "One offline fixture.\n");
  await writeFile(path.join(sample, "reference.bin"), Buffer.alloc(1024 * 1024, 46));
  const skills: CreativeSkill[] = [{ id: "sample", directory: sample }];
  const runner = new CreativeRunner({ socketPath: path.join(scratch, "s") });
  const context = { conversationId: "offline", workId: "work", executionId: "project", deliveryClosed: false, skills };

  const read = async () => {
    const tool = runner.tools(() => context).find(definition => definition.name === "read")!;
    // 第五参是 Pi 会话上下文；独立调用不使用，注入空占位满足签名。
    const withoutSession = undefined as unknown as Parameters<typeof tool.execute>[4];
    const result = await tool.execute("r", { path: "test.txt" }, undefined, undefined, withoutSession);
    assert.equal((result as { structuredContent?: string }).structuredContent, "test text", "读取结果应来自宿主返回");
  };

  requests.length = 0;
  await read();
  const first = requests.filter(row => row.action === "skills");
  assert.equal(first.filter(row => row.carriesFiles).length, 1, "首次读取应完整传输一次正文");
  assert.ok(first.some(row => !row.carriesFiles && row.bodyBytes < 4096), "首次先探测，探测请求不携带正文");

  requests.length = 0;
  await read();
  const second = requests.filter(row => row.action === "skills");
  assert.equal(second.length, 1, "第二次读取只有探测请求");
  assert.equal(second.filter(row => row.carriesFiles).length, 0, "第二次整包正文传输为 0 次");
  assert.equal(second[0]!.bodyBytes, first.find(row => !row.carriesFiles)!.bodyBytes, "探测请求字节量一致且很小");

  // 宿主丢失该修订（集合清空，等效宿主重启或卷被回收）：按需重新发送并正确读取。
  synced.clear();
  requests.length = 0;
  await read();
  const third = requests.filter(row => row.action === "skills");
  assert.equal(third.filter(row => row.carriesFiles).length, 1, "缓存失效后应重新完整传输一次");
  assert.ok(third.some(row => !row.carriesFiles), "重传前仍先探测");
});
