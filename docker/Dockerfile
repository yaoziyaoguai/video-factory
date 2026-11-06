FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/codex-broker/package.json apps/codex-broker/
COPY apps/studio/package.json apps/studio/
COPY packages/production-pipeline/package.json packages/production-pipeline/
COPY packages/template-core/package.json packages/template-core/
COPY packages/workflow-core/package.json packages/workflow-core/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run studio:build && npm prune --omit=dev --no-audit --no-fund && mkdir -p apps/studio/node_modules

FROM node:22-bookworm-slim
ENV NODE_ENV=production STUDIO_HOST=0.0.0.0 STUDIO_PORT=4317 VIDEO_FACTORY_WORKSPACE=/data/factory HOME=/data/factory
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates git && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 frame && useradd -u 1001 -g frame -d /data/factory frame && install -d -o frame -g frame /data/factory
WORKDIR /app
COPY --from=build --chown=frame:frame /app/node_modules ./node_modules
COPY --from=build --chown=frame:frame /app/apps/studio/node_modules apps/studio/node_modules
COPY --chown=frame:frame package.json ./
COPY --chown=frame:frame apps/studio/package.json apps/studio/
COPY --from=build --chown=frame:frame /app/apps/studio/dist apps/studio/dist
COPY --chown=frame:frame apps/studio/skills apps/studio/skills
COPY --chown=frame:frame packages/production-pipeline/package.json packages/production-pipeline/
COPY --chown=frame:frame packages/template-core/package.json packages/template-core/
COPY --chown=frame:frame packages/workflow-core/package.json packages/workflow-core/
COPY --from=build --chown=frame:frame /app/packages/production-pipeline/dist packages/production-pipeline/dist
COPY --from=build --chown=frame:frame /app/packages/template-core/dist packages/template-core/dist
COPY --from=build --chown=frame:frame /app/packages/workflow-core/dist packages/workflow-core/dist
USER frame
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(async r=>{if(!r.ok||(await r.json()).product!=='frame')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","apps/studio/dist/server/server/main.js"]
