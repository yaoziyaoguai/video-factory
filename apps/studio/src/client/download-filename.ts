// DG-UX-06：成片下载文件名 = <安全作品标题>__<真实产物 id>.mp4。
// 产物身份必须是服务端路由认可的完整 id（见 server/app.ts 的 SAFE_ROUTE_ID），
// 不能取数组最后一个或按文件名猜版本；非法身份不产出文件名，调用方应改为提示。

// 与服务端 SAFE_ROUTE_ID 同一合同（apps/studio/src/server/app.ts）；产物 id 越界
// 意味着资源身份不可核对，宁可不给下载名也不能截短到可能碰撞的序号。
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TITLE_CODE_POINTS = 80;
const MAX_TOTAL_UTF8_BYTES = 240;
const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);
const encoder = new TextEncoder();

export function safeVideoDownloadTitle(rawTitle: string): string {
  const cleaned = rawTitle
    // 路径分隔符、控制字符和 Windows/POSIX 非法字符统一替换为连字符；保留中文与 emoji。
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
    .trim()
    .replace(/[. ]+$/, "")
    .trim();
  // 清理后空名、或只剩替换连字符/点/空格的无意义名（如标题全是斜杠）都用安全名。
  // emoji 是合法标题内容，不因此回退。
  if (!cleaned || /^[-. ]+$/.test(cleaned)) return "视频作品";
  const capped = Array.from(cleaned).slice(0, MAX_TITLE_CODE_POINTS).join("");
  return RESERVED_WINDOWS_NAMES.has(capped.split(".")[0]!.toUpperCase())
    ? `视频-${capped}`
    : capped;
}

/**
 * 完整文件名 UTF-8 不超过 240 字节（常见文件系统 255 上界留余量）：先保留完整
 * `__<artifact.id>.mp4` 后缀，再按剩余字节预算逐码点截断标题，不截半个码点。
 * 返回 undefined 表示产物身份不合法，调用方不得提供可点击下载。
 */
export function videoDownloadFilename(rawTitle: string, artifactId: string): string | undefined {
  return artifactDownloadFilename(rawTitle, artifactId, "mp4");
}

export function publishPackageDownloadFilename(rawTitle: string, artifactId: string): string | undefined {
  return artifactDownloadFilename(rawTitle, artifactId, "json");
}

function artifactDownloadFilename(rawTitle: string, artifactId: string, extension: "mp4" | "json"): string | undefined {
  if (!SAFE_ARTIFACT_ID.test(artifactId)) return undefined;
  const title = safeVideoDownloadTitle(rawTitle);
  const suffix = `__${artifactId}.${extension}`;
  let budget = MAX_TOTAL_UTF8_BYTES - encoder.encode(suffix).length;
  const chars: string[] = [];
  for (const character of Array.from(title)) {
    const size = encoder.encode(character).length;
    if (size > budget) break;
    budget -= size;
    chars.push(character);
  }
  const truncated = chars.join("").replace(/[. ]+$/, "").trim();
  return `${truncated || "视频作品"}${suffix}`;
}
