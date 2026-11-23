import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import type {
  InputRef,
  MediaContent,
  MediaProvenance,
  RevisionRef,
} from "../../shared/agent/generated/contracts.js";
import {
  getArtifactRow,
  getRevisionRow,
  rowToArtifactRevision,
} from "./artifact-store.js";
import { codeProjectInputPath } from "./creative-runner.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { blobSources, mergeSources } from "./material-store.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { runRow, snapshotFor } from "./production-store.js";
import { validatorFor } from "./validate.js";

export type ArchiveEntry =
  { name: string; file: string } | { name: string; text: string };

// 导出流按文件句柄和背压内存计价，超限直接 429，不排队堆积（UIUX-12 并发保护）。
const MAX_ARCHIVE_STREAMS = 4;
let activeArchiveStreams = 0;

/** ZIP 时间戳是 DOS 格式；秒粒度 2 秒，年份夹在 1980..2107。 */
function dosStamp(at: Date) {
  const year = Math.min(2107, Math.max(1980, at.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}

/** 中央目录记录；尺寸或偏移越过 32 位时按规范逐字段降级到 ZIP64 扩展。 */
function centralRecord(
  name: Buffer,
  checksum: number,
  size: bigint,
  offset: bigint,
  stamp: { date: number; time: number },
): Buffer {
  const sizeZip64 = size > 0xffffffffn;
  const offsetZip64 = offset > 0xffffffffn;
  const zip64Values: bigint[] = [];
  if (sizeZip64) zip64Values.push(size, size);
  if (offsetZip64) zip64Values.push(offset);
  const extraLength = zip64Values.length ? 4 + zip64Values.length * 8 : 0;
  const record = Buffer.alloc(46 + name.length + extraLength);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE((3 << 8) | 45, 4);
  record.writeUInt16LE(45, 6);
  record.writeUInt16LE(0x0808, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(stamp.time, 12);
  record.writeUInt16LE(stamp.date, 14);
  record.writeUInt32LE(checksum, 16);
  record.writeUInt32LE(sizeZip64 ? 0xffffffff : Number(size), 20);
  record.writeUInt32LE(sizeZip64 ? 0xffffffff : Number(size), 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(extraLength, 30);
  record.writeUInt32LE((0o644 << 16) >>> 0, 38);
  record.writeUInt32LE(offsetZip64 ? 0xffffffff : Number(offset), 42);
  name.copy(record, 46);
  let cursor = 46 + name.length;
  if (zip64Values.length) {
    record.writeUInt16LE(0x0001, cursor);
    record.writeUInt16LE(zip64Values.length * 8, cursor + 2);
    cursor += 4;
    for (const value of zip64Values) {
      record.writeBigUInt64LE(value, cursor);
      cursor += 8;
    }
  }
  return record;
}

/**
 * 纯 TypeScript 的 ZIP_STORED 流式归档：本地头一律带 ZIP64 扩展与数据描述符
 * （总尺寸流式产生，不回写已输出的字节），中央目录与 EOCD64 在末尾一次输出。
 */
async function* archiveChunks(
  entries: ArchiveEntry[],
  stamp: { date: number; time: number },
): AsyncGenerator<Buffer> {
  const directory: Buffer[] = [];
  let offset = 0n;
  let directorySize = 0n;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    // 本地头字段顺序是 固定 30 字节 + 文件名 + 扩展字段；ZIP64 尺寸占位在文件名之后。
    const local = Buffer.alloc(50 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    // CRC 与尺寸在数据描述符中给出，本地头留零。
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(20, 28);
    name.copy(local, 30);
    local.writeUInt16LE(0x0001, 30 + name.length);
    local.writeUInt16LE(16, 32 + name.length);
    yield local;
    let checksum = 0;
    let size = 0n;
    if ("text" in entry) {
      const data = Buffer.from(entry.text, "utf8");
      checksum = crc32(data) >>> 0;
      size = BigInt(data.length);
      yield data;
    } else {
      // 逐块读原字节，不整体载入内存；客户端中断时 finally 立即释放描述符。
      const handle = await open(entry.file, "r");
      try {
        const chunk = Buffer.alloc(1024 * 1024);
        for (;;) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          checksum = crc32(chunk.subarray(0, bytesRead), checksum) >>> 0;
          size += BigInt(bytesRead);
          // 流可能预取下一块覆写共享缓冲，交给下游前必须复制。
          yield Buffer.from(chunk.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
    }
    const descriptor = Buffer.alloc(24);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(checksum, 4);
    descriptor.writeBigUInt64LE(size, 8);
    descriptor.writeBigUInt64LE(size, 16);
    yield descriptor;
    const record = centralRecord(name, checksum, size, offset, stamp);
    directory.push(record);
    directorySize += BigInt(record.length);
    offset += BigInt(50 + name.length) + size + 24n;
  }
  const directoryOffset = offset;
  yield* directory;
  const eocd64 = Buffer.alloc(56);
  eocd64.writeUInt32LE(0x06064b50, 0);
  eocd64.writeBigUInt64LE(44n, 4);
  eocd64.writeUInt16LE((3 << 8) | 45, 12);
  eocd64.writeUInt16LE(45, 14);
  eocd64.writeUInt32LE(0, 16);
  eocd64.writeUInt32LE(0, 20);
  eocd64.writeBigUInt64LE(BigInt(directory.length), 24);
  eocd64.writeBigUInt64LE(BigInt(directory.length), 32);
  eocd64.writeBigUInt64LE(directorySize, 40);
  eocd64.writeBigUInt64LE(directoryOffset, 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(directoryOffset + directorySize, 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(
    Math.min(directory.length, 0xffff),
    8,
  );
  eocd.writeUInt16LE(Math.min(directory.length, 0xffff), 10);
  eocd.writeUInt32LE(
    directorySize > 0xffffffffn ? 0xffffffff : Number(directorySize),
    12,
  );
  eocd.writeUInt32LE(
    directoryOffset > 0xffffffffn ? 0xffffffff : Number(directoryOffset),
    16,
  );
  yield eocd64;
  yield locator;
  yield eocd;
}

export function zipStream(entries: ArchiveEntry[]): Readable {
  const paths = new Set<string>();
  for (const { name } of entries) {
    const parts = name.split("/");
    if (
      name.includes("\\") ||
      /[\u0000-\u001f:]|^\//.test(name) ||
      parts.some((p) => !p || p === "." || p === "..")
    )
      throw new AgentError(
        "INVALID_INPUT",
        "归档中的文件名不是安全的相对路径。",
      );
    const key = name.normalize("NFC").toLowerCase();
    if (paths.has(key))
      throw new AgentError("INVALID_INPUT", "归档出现重名文件。");
    paths.add(key);
  }
  for (const name of paths) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/")))
        throw new AgentError("INVALID_INPUT", "归档文件和目录重名。");
      parts.pop();
    }
  }
  if (activeArchiveStreams >= MAX_ARCHIVE_STREAMS)
    throw new AgentError(
      "QUEUE_FULL",
      "导出并发已达上限，请等待进行中的下载完成后再试。",
    );
  activeArchiveStreams += 1;
  // 并发名额归还必须幂等：正常结束、迭代出错、客户端中断、生成器提前退出各走不同路径，重复扣减会让上限越数越少。
  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    activeArchiveStreams -= 1;
  };
  const stream = Readable.from(
    (async function* () {
      try {
        yield* archiveChunks(entries, dosStamp(new Date()));
      } finally {
        releaseSlot();
      }
    })(),
    { objectMode: false },
  );
  stream.once("close", releaseSlot);
  stream.once("error", releaseSlot);
  return stream;
}

export function archiveBlob(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  owner: string,
  cnv: string,
  input: InputRef,
  runId: string,
) {
  let id: string;
  if (input.kind === "blob") id = input.blobId;
  else if (input.kind === "artifact_revision") {
    const a = getArtifactRow(db, owner, input.artifactId),
      r =
        a?.conversation_id === cnv
          ? getRevisionRow(db, a.id, input.revisionId)
          : undefined;
    if (!r || r.digest !== input.digest)
      throw new AgentError("NOT_FOUND", "冻结输入修订不存在。");
    const content = rowToArtifactRevision(r).content;
    if (content.format !== "media")
      throw new AgentError("INVALID_INPUT", "冻结输入不是媒体。");
    id = content.blobId;
  } else if (input.kind === "operation_output") {
    const found = db
      .prepare(
        "SELECT output_blob_id FROM production_operations WHERE run_id=? AND id=? AND state='succeeded'",
      )
      .pluck()
      .get(runId, input.producerOperationId) as string | undefined;
    if (!found) throw new AgentError("NOT_FOUND", "冻结的上游输出尚未就绪。");
    id = found;
  } else
    throw new AgentError("INVALID_INPUT", "工程导出不能把文稿当作媒体文件。");
  const blob = blobs.get(owner, id);
  if (
    blob.conversation_id !== cnv ||
    (input.kind === "blob" && input.digest !== blob.digest)
  )
    throw new AgentError("NOT_FOUND", "冻结媒体不属于这次制作。");
  blobs.verify(blob);
  return blob;
}

export function attribution(groups: MediaProvenance[][]) {
  const sources = mergeSources(groups);
  return (
    "Frame · 素材署名\n\n" +
    (sources.length
      ? sources
          .map((s) =>
            [
              s.title,
              s.attributionText,
              s.licenseName,
              s.licenseUrl,
              s.sourceUrl,
              s.usageScope,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n")
      : "本次冻结工程没有登记第三方素材署名。") +
    "\n"
  );
}
const shellArg = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
export function frozenArchive(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  owner: string,
  ref: RevisionRef,
  selectedRun?: string,
) {
  const artifact = getArtifactRow(db, owner, ref.artifactId),
    r = artifact ? getRevisionRow(db, artifact.id, ref.revisionId) : undefined;
  if (!artifact || !r)
    throw new AgentError("NOT_FOUND", "没有找到这个工程修订。");
  const project = rowToArtifactRevision(r).content;
  if (project.format !== "project")
    throw new AgentError("INVALID_INPUT", "只有封存的代码工程可以下载工程包。");
  const entries: ArchiveEntry[] = [],
    sources: MediaProvenance[][] = [];
  const files = new Map<string, string>();
  const include = (name: string, id: string) => {
    const blob = blobs.get(owner, id);
    if (blob.conversation_id !== artifact.conversation_id)
      throw new AgentError("NOT_FOUND", "没有找到这个工程文件。");
    blobs.verify(blob);
    if (files.get(name) === blob.digest) return;
    entries.push({ name, file: blobs.filePath(blob.digest) });
    files.set(name, blob.digest);
    sources.push(blobSources(db, id));
  };
  for (const file of project.files) {
    if (!validatorFor("RelativeProjectPath")(file.relativePath).ok)
      throw new AgentError("INVALID_INPUT", "冻结工程中有无效相对路径。");
    const blob = blobs.get(owner, file.blobId);
    if (
      blob.digest !== file.digest ||
      (file.sizeBytes !== undefined && blob.size_bytes !== file.sizeBytes)
    )
      throw new AgentError("INVALID_INPUT", "冻结清单与登记的原件不一致。");
    include("project/" + file.relativePath, blob.id);
  }
  for (const [i, source] of project.sourceRevisions.entries()) {
    const sourceArtifact = getArtifactRow(db, owner, source.artifactId),
      row =
        sourceArtifact?.conversation_id === artifact.conversation_id
          ? getRevisionRow(db, source.artifactId, source.revisionId)
          : undefined;
    if (!row) throw new AgentError("NOT_FOUND", "没有找到工程引用的来源修订。");
    const doc = rowToArtifactRevision(row);
    if (doc.content.format === "media")
      include(
        "sources/" + codeProjectInputPath(i, doc.content.mimeType),
        doc.content.blobId,
      );
    else
      entries.push({
        name: "sources/" + String(i) + ".json",
        text: JSON.stringify(doc, null, 2),
      });
  }
  const candidates = db
    .prepare(
      "SELECT o.run_id,o.id FROM production_operations o JOIN production_runs r ON r.id=o.run_id WHERE r.owner_id=? AND r.conversation_id=? AND o.state='succeeded' AND json_extract(o.spec_json,'$.parameters.projectRevision.revisionId')=? AND json_extract(o.spec_json,'$.parameters.projectRevision.artifactId')=?" +
        (selectedRun ? " AND r.id=?" : "") +
        " ORDER BY r.rowid DESC,o.rowid DESC LIMIT 1",
    )
    .get(
      owner,
      artifact.conversation_id,
      ref.revisionId,
      ref.artifactId,
      ...(selectedRun ? [selectedRun] : []),
    ) as { run_id: string; id: string } | undefined;
  if (selectedRun && !candidates)
    throw new AgentError("NOT_FOUND", "所选制作没有执行这版工程。");
  if (candidates) {
    const run = runRow(db, candidates.run_id),
      op = snapshotFor(db, run).spec.operations.find(
        (op) => op.operationId === candidates.id,
      )!;
    op.inputs.forEach((input, i) => {
      const blob = archiveBlob(
        db,
        blobs,
        owner,
        artifact.conversation_id,
        input,
        run.id,
      );
      include(
        "project/" +
          codeProjectInputPath(i, blob.mime_type as MediaContent["mimeType"]),
        blob.id,
      );
    });
  }
  const inputMount = entries.some((entry) =>
    entry.name.startsWith("project/inputs/"),
  )
    ? ' --mount "type=bind,src=$PWD/project/inputs,dst=/inputs,readonly" --mount "type=bind,src=$PWD/project/inputs,dst=/workspace/inputs,readonly"'
    : "";
  const command = `docker run --rm --pull=never --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" --mount "type=bind,src=$PWD/project,dst=/workspace"${inputMount} --workdir /workspace --entrypoint /usr/bin/env ${shellArg(project.runtimeImage)} -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${project.entrypoint.argv.map(shellArg).join(" ")}`;
  const readme = `# ${artifact.title}\n\n工程修订 ${ref.revisionId}。${candidates ? "已打包制作 " + candidates.run_id + " 使用的冻结输入。" : "这版工程尚无成功执行记录。"}\n\n在装有同一运行镜像的主机上解压并进入本目录，执行以下命令。生成的输出写入 project/。\n\n\`\`\`sh\n${command}\n\`\`\`\n\n工程文件和素材已按原字节保存，第三方素材许可见 ATTRIBUTION.txt。\n`;
  entries.push(
    { name: "README-RUN.md", text: readme },
    { name: "ATTRIBUTION.txt", text: attribution(sources) },
  );
  return zipStream(entries);
}
