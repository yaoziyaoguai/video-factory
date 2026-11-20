# 运行时基于稳定基础镜像（docker/base.Dockerfile）。本地构建请先执行：
#   docker build -t frame-base:local -f docker/base.Dockerfile .
ARG BASE_IMAGE=frame-base:local
FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/studio/package.json apps/studio/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run studio:build && npm prune --omit=dev --no-audit --no-fund && mkdir -p apps/studio/node_modules

FROM ${BASE_IMAGE}
ENV NODE_ENV=production STUDIO_HOST=0.0.0.0 STUDIO_PORT=4317 VIDEO_FACTORY_WORKSPACE=/data/factory HOME=/data/factory
WORKDIR /app
COPY --from=build --chown=frame:frame /app/node_modules ./node_modules
COPY --from=build --chown=frame:frame /app/apps/studio/node_modules apps/studio/node_modules
COPY --chown=frame:frame package.json ./
COPY --chown=frame:frame apps/studio/package.json apps/studio/
COPY --from=build --chown=frame:frame /app/apps/studio/dist apps/studio/dist
COPY --chown=frame:frame apps/studio/skills apps/studio/skills
USER frame
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(async r=>{if(!r.ok||(await r.json()).product!=='frame')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","apps/studio/dist/server/server/main.js"]
