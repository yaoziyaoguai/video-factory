import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.STUDIO_WEB_PORT ?? 4317);
const apiPort = Number(process.env.STUDIO_PORT ?? 4318);

// 预览页媒体字节：真实工作台的 <video>/<img> 直连 /api/agent/v1/blobs/{id}/(content|poster)，
// 不经 fetch，内存 Mock 接管不到。开发服务器按固定 blobId 提供示例素材；未知 id 一律放行给
// /api 代理，不影响真实后端开发（后端 blob id 不会与 preview- 前缀 collide）。
const previewAssetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/client/agent/preview/assets");
const PREVIEW_BLOBS: Record<string, { content: string; poster?: string; type: string }> = {
  "preview-blob-trail-video": { content: "trail-preview.mp4", poster: "trail-1.png", type: "video/mp4" },
  "preview-blob-trail-voice": { content: "narration.mp3", type: "audio/mpeg" },
  "preview-blob-coffee-video": { content: "coffee-preview.mp4", poster: "coffee-home.png", type: "video/mp4" },
  "preview-blob-coffee-voice": { content: "coffee-narration.mp3", type: "audio/mpeg" },
};
const previewBlobPlugin: Plugin = {
  name: "frame-preview-blobs",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const match = /^\/api\/agent\/v1\/blobs\/([^/]+)\/(content|poster)$/.exec(req.url ?? "");
      const blob = match ? PREVIEW_BLOBS[match[1]!] : undefined;
      const file = blob !== undefined && match !== null ? blob[match[2] as "content" | "poster"] : undefined;
      if (!match || !blob || !file) return next();
      void readFile(path.join(previewAssetsDir, file)).then(bytes => {
        res.statusCode = 200;
        res.setHeader("content-type", file.endsWith(".png") ? "image/png" : blob.type);
        // 预览素材不可变，直接长缓存。
        res.setHeader("cache-control", "public, max-age=86400");
        res.end(bytes);
      }).catch(() => {
        res.statusCode = 404;
        res.end("preview asset missing");
      });
    });
  },
};

export default defineConfig({
  plugins: [react(), previewBlobPlugin],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
