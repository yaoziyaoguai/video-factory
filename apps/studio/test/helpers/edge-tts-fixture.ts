import { writeFile } from "node:fs/promises";
import path from "node:path";

// 与 Python 客户端同形：stdin 读取请求，音频写到指定文件，边界走 stdout。
// 并把收到的请求原样写到 requestFile 供断言 voice/rate 透传。
export async function writeStubInterpreter(
  directory: string, requestFile: string,
  payload: { audioB64: string; boundaries: unknown[] } | { failStderr: string; failCode: number },
): Promise<string> {
  const file = path.join(directory, `stub-${path.basename(requestFile, ".json")}.mjs`);
  const action = "failStderr" in payload
    ? `process.stderr.write(${JSON.stringify(payload.failStderr)}); process.exit(${payload.failCode});`
    : `fs.writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(payload.audioB64)}, "base64")); process.stdout.write(JSON.stringify({ boundaries: ${JSON.stringify(payload.boundaries)} }));`;
  await writeFile(file, `#!/usr/bin/env node
const fs = await import("node:fs");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(requestFile)}, Buffer.concat(chunks));
  ${action}
});
`, { mode: 0o755 });
  return file;
}
