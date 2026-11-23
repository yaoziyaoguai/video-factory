import { copyFile, open } from "node:fs/promises";

/** 在可解码 MP4 末尾追加 ISO BMFF free box。用稀疏文件构造精确字节数，各样本摘要独立。 */
export async function sizedMp4(source: string, output: string, bytes: number, marker: number): Promise<void> {
  await copyFile(source, output);
  const handle = await open(output, "r+");
  try {
    const before = (await handle.stat()).size;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(bytes - before);
    header.write("free", 4);
    await handle.write(header, 0, header.length, before);
    await handle.write(Buffer.from([marker]), 0, 1, bytes - 1);
  } finally { await handle.close(); }
}
