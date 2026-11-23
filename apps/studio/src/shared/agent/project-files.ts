// 工程文件的描述性类型；执行时按字节写回工作区，不依赖这里的 MIME。
const PROJECT_FILE_MIME: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
  ".ts": "text/typescript", ".tsx": "text/typescript", ".jsx": "text/javascript", ".css": "text/css",
  ".html": "text/html", ".svg": "image/svg+xml", ".xml": "text/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".toml": "text/plain", ".srt": "text/plain", ".vtt": "text/vtt",
  ".py": "text/x-python", ".sh": "text/x-shellscript",
  // 媒体工程文件按扩展名登记准确 MIME：作品库选材据此区分共享 blob 与文本副本（G4-2）。
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
};
export function projectFileMime(file: string): string {
  const name = file.split("/").at(-1)!;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return projectMimeForExtension(extension);
}

export function projectMimeForExtension(extension: string): string {
  return PROJECT_FILE_MIME[extension.toLowerCase()] ?? "application/octet-stream";
}
