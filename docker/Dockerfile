ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/codex-broker/package.json apps/codex-broker/package.json
COPY apps/studio/package.json apps/studio/package.json
COPY packages/production-pipeline/package.json packages/production-pipeline/package.json
COPY packages/template-core/package.json packages/template-core/package.json
COPY packages/workflow-core/package.json packages/workflow-core/package.json
RUN npm ci

FROM dependencies AS builder

COPY . .
RUN npm run build

FROM dependencies AS production-dependencies

RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

ARG ALPINE_MIRROR

ENV NODE_ENV=production \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=4317 \
    VIDEO_FACTORY_WORKSPACE=/data/factory \
    PYTHONUNBUFFERED=1

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${ALPINE_MIRROR%/}|g" /etc/apk/repositories; \
    fi \
    && apk add --no-cache \
      ca-certificates \
      ffmpeg \
      font-noto-cjk \
      py3-pillow \
      python3 \
      tar

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
COPY examples ./examples

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/codex-broker/package.json apps/codex-broker/package.json
COPY packages/production-pipeline/package.json packages/production-pipeline/package.json
COPY packages/template-core/package.json packages/template-core/package.json
COPY packages/workflow-core/package.json packages/workflow-core/package.json
COPY --from=builder /app/packages/production-pipeline/dist packages/production-pipeline/dist
COPY --from=builder /app/packages/template-core/dist packages/template-core/dist
COPY --from=builder /app/packages/workflow-core/dist packages/workflow-core/dist
COPY apps/studio/package.json apps/studio/package.json
COPY --from=builder /app/apps/studio/dist apps/studio/dist
# 仅供宿主机部署脚本 docker cp 提取到 systemd 服务；容器内的 app 不启动 broker。
COPY apps/codex-broker/package.json apps/codex-broker/package.json
COPY --from=builder /app/apps/codex-broker/dist apps/codex-broker/dist
COPY apps/codex-broker/deploy apps/codex-broker/deploy

RUN addgroup --system --gid 1001 video-factory \
    && adduser --system --uid 1001 --ingroup video-factory --home /app video-factory \
    && mkdir -p /data/factory \
    && chown -R video-factory:video-factory /data

USER video-factory

EXPOSE 4317
VOLUME ["/data/factory"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4317/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/studio/dist/server/server/main.js"]
