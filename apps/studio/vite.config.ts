import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.STUDIO_WEB_PORT ?? 4317);
const apiPort = Number(process.env.STUDIO_PORT ?? 4318);

export default defineConfig({
  plugins: [react()],
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
