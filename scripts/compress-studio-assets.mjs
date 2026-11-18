import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = path.resolve(process.argv[2] ?? "apps/studio/dist/client");
const files = (await readdir(root, { recursive: true })).filter(file => /\.(?:html|js|css)$/.test(file));
let originalBytes = 0, brotliBytes = 0, gzipBytes = 0;
for (const file of files) {
  const target = path.join(root, file);
  const source = await readFile(target);
  const brotli = brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
  const gzip = gzipSync(source, { level: 9 });
  // 保留原文件供不支持压缩的客户端使用；woff2和媒体已有压缩，不重复处理。
  if (brotli.length < source.length) await writeFile(`${target}.br`, brotli);
  if (gzip.length < source.length) await writeFile(`${target}.gz`, gzip);
  originalBytes += source.length;
  brotliBytes += Math.min(brotli.length, source.length);
  gzipBytes += Math.min(gzip.length, source.length);
}
console.log(JSON.stringify({ event: "studio-assets-compressed", files: files.length, originalBytes, brotliBytes, gzipBytes }));
