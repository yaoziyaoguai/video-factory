import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { promisify } from "node:util";
import { zipStream } from "../src/server/agent/export-bundle.js";

const run = promisify(execFile);

test("CAP-06 导出拒绝有歧义的归档名，客户端中途结束后可重新完整下载", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-zip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const names of [
    ["/absolute"],
    ["folder/../file"],
    ["case", "Case"],
    ["source", "source/component"],
    ["a\\b"],
  ]) {
    assert.throws(
      () => zipStream(names.map((name) => ({ name, text: "source" }))),
      { code: "INVALID_INPUT" },
    );
  }
  const source = path.join(directory, "original"),
    f = await open(source, "w");
  try {
    await f.truncate(32 * 1024 ** 2);
  } finally {
    await f.close();
  }
  const entries = [
    { name: "media/source.mov", file: source },
    { name: "源文件/说明.txt", text: "帧间" },
  ],
    first = zipStream(entries);
  let received = 0;
  for await (const block of first) {
    received += block.length;
    if (received > 0) break;
  }
  assert.ok(received < 32 * 1024 ** 2 && first.destroyed);
  // for-await break 会让流先 emit error(AbortError) 再 close，events.once 会被 error 拒绝；
  // 用手写等待只认 close，确认并发名额已归还。
  const closed = new Promise<void>((resolve) => first.once("close", () => resolve()));
  first.once("error", () => {});
  await closed;
  const zip = path.join(directory, "frame.zip");
  await pipeline(zipStream(entries), createWriteStream(zip));
  const verify = String.raw`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None
    assert z.getinfo('media/source.mov').file_size == 32*1024**2
    assert z.read('源文件/说明.txt').decode() == '帧间'
`;
  await run("python3", ["-I", "-c", verify, zip]);
  await run("unzip", ["-t", zip]);
  t.diagnostic(
    JSON.stringify({
      streamBytes: 32 * 1024 ** 2,
      firstDownloadBytes: received,
      completedAfterDisconnect: true,
    }),
  );
});

test("UIUX-12 并发导出上限 4 路：第 5 路 QUEUE_FULL，流关闭后名额归还", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-zip-limit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "payload.bin");
  const f = await open(source, "w");
  try {
    await f.truncate(4 * 1024 * 1024);
  } finally {
    await f.close();
  }
  const entries = [{ name: "payload.bin", file: source }];
  // 4 个已创建未消费的流占满名额：创建即计数，第 5 路在入口被拒。
  const held: ReturnType<typeof zipStream>[] = [];
  t.after(() => Promise.allSettled(held.map((stream) => stream.destroy())));
  for (let i = 0; i < 4; i += 1) held.push(zipStream(entries));
  assert.throws(() => zipStream(entries), { code: "QUEUE_FULL" });
  held[3]!.destroy();
  await once(held[3]!, "close");
  const complete = path.join(directory, "ok.zip");
  await pipeline(zipStream(entries), createWriteStream(complete));
  const check = await run("unzip", ["-t", complete]);
  assert.match(check.stdout, /No errors detected/);
});

test("B12-BUG-06 名额归还幂等：反复创建即毁的流不产生幽灵名额", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-zip-idempotent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "payload.bin");
  const f = await open(source, "w");
  try {
    await f.truncate(1024 * 1024);
  } finally {
    await f.close();
  }
  const entries = [{ name: "payload.bin", file: source }];
  // 创建后立即销毁 6 路：close、error 与生成器 finally 对同一路流可能都触发，只允许归还一次名额。
  for (let i = 0; i < 6; i += 1) {
    const stream = zipStream(entries);
    stream.destroy();
    await once(stream, "close");
  }
  // 名额未被超发：占满 4 路后第 5 路仍被拒，销毁一路后可继续完整导出。
  const held: ReturnType<typeof zipStream>[] = [];
  t.after(() => Promise.allSettled(held.map((stream) => stream.destroy())));
  for (let i = 0; i < 4; i += 1) held.push(zipStream(entries));
  assert.throws(() => zipStream(entries), { code: "QUEUE_FULL" });
  held[3]!.destroy();
  await once(held[3]!, "close");
  const complete = path.join(directory, "ok.zip");
  await pipeline(zipStream(entries), createWriteStream(complete));
  const check = await run("unzip", ["-t", complete]);
  assert.match(check.stdout, /No errors detected/);
});
