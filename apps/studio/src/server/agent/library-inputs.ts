import { readFileSync } from "node:fs";
import type { AgentDatabase } from "./db.js";
import type { AgentClock } from "./util.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { MEDIA_INPUT_EXTENSION, type CreativeRunner, type CreativeWorkspace } from "./creative-runner.js";
import { getRevisionRow } from "./artifact-store.js";
import type { CreativeProjectContent, LibrarySelection, MediaContent } from "../../shared/agent/generated/contracts.js";

// §11.7 来源6/7：把会话里已发送、入口已验证的作品库选材按原字节放进当前作品的输入位置，
// 再由 Pi 原生 read/bash 使用。文本稿素材已是会话产物（可直接 read_artifact），不重复落盘。
// 落位按来源身份隔离：封存工程文件进 inputs/library/<工程修订>/<原相对路径>，
// 媒体素材进 inputs/library/<素材修订>.<扩展名>；library_input_preparations 保证每个
// （作品, 来源）只准备一次——不覆盖用户已编辑文件，后续回合/刷新按已发送消息重新解析补齐。
export async function ensureLibraryInputs(
  db: AgentDatabase, blobs: ProductionBlobs, clock: AgentClock,
  creative: { runner: CreativeRunner; workspace: (conversationId: string, workId: string) => CreativeWorkspace },
  ownerId: string, conversationId: string, workId: string,
): Promise<void> {
  const selections = db.prepare(
    "SELECT library_selections_json FROM messages WHERE conversation_id=? AND owner_id=? AND library_selections_json IS NOT NULL ORDER BY created_seq",
  ).all(conversationId, ownerId) as { library_selections_json: string }[];
  const prepared = new Set((db.prepare("SELECT source_key FROM library_input_preparations WHERE work_id=?")
    .all(workId) as { source_key: string }[]).map(row => row.source_key));
  const workspace = creative.workspace(conversationId, workId);
  for (const row of selections) {
    for (const selection of JSON.parse(row.library_selections_json) as LibrarySelection[]) {
      const item = libraryInputItem(db, selection);
      if (!item || prepared.has(item.sourceKey)) continue;
      // 先落文件再记行：中途崩溃只会让下个回合重写同样字节，不会出现“已记录却没文件”。
      const blob = blobs.get(ownerId, item.blobId);
      await creative.runner.writeFile(workspace, item.path, readFileSync(blobs.filePath(blob.digest)));
      db.prepare("INSERT INTO library_input_preparations(work_id, source_key, path, prepared_at) VALUES(?,?,?,?)")
        .run(workId, item.sourceKey, item.path, clock());
      prepared.add(item.sourceKey);
    }
  }
}

// 发送时 planLibrarySelections 已验证选材落在定稿留存清单里；这里只按冻结修订重新解析
// 输入位置。修订行不存在（历史数据被外部清理）就没有可准备的原字节，跳过该来源。
function libraryInputItem(db: AgentDatabase, selection: LibrarySelection): { sourceKey: string; path: string; blobId: string } | null {
  const source = selection.source;
  if (source.kind === "run_input") {
    const blob = db.prepare("SELECT mime_type FROM production_blobs WHERE id=?").get(source.blobId) as { mime_type: MediaContent["mimeType"] } | undefined;
    const extension = blob ? MEDIA_INPUT_EXTENSION[blob.mime_type] : undefined;
    if (!extension) return null;
    return { sourceKey: `run-input:${source.runId}:${source.operationId}:${source.inputIndex}:${source.blobId}`,
      path: `inputs/library/${source.runId}/${source.operationId}/${source.inputIndex}${extension}`, blobId: source.blobId };
  }
  if (source.kind === "project_file") {
    const revision = getRevisionRow(db, source.project.artifactId, source.project.revisionId);
    if (!revision) return null;
    const content = JSON.parse(revision.content_json) as CreativeProjectContent;
    const file = content.format === "project" ? content.files.find(item => item.relativePath === source.relativePath) : undefined;
    if (!file) return null;
    return {
      sourceKey: `project:${source.project.artifactId}:${source.project.revisionId}:${source.relativePath}`,
      path: `inputs/library/${source.project.revisionId}/${source.relativePath}`,
      blobId: file.blobId,
    };
  }
  const revision = getRevisionRow(db, source.artifactId, source.revisionId);
  if (!revision) return null;
  const content = JSON.parse(revision.content_json) as { format?: string; blobId?: string; mimeType?: MediaContent["mimeType"] };
  const extension = content.format === "media" && content.mimeType ? MEDIA_INPUT_EXTENSION[content.mimeType] : undefined;
  if (content.format !== "media" || !content.blobId || !extension) return null;
  return {
    sourceKey: `material:${source.artifactId}:${source.revisionId}`,
    path: `inputs/library/${source.revisionId}${extension}`,
    blobId: content.blobId,
  };
}
