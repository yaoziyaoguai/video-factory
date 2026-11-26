# 运行时基于稳定基础镜像（docker/base.Dockerfile）。本地构建请先执行：
#   docker build -t frame-base:local -f docker/base.Dockerfile .
# build 阶段同样复用基础镜像：make/g++/python3 等编译链已在基础层就绪，
# 应用镜像重建不再访问 Debian 源（UIUX-11：受限网络 0 次 apt-get 外网请求）。
ARG BASE_IMAGE=frame-base:local
FROM ${BASE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
COPY apps/studio/package.json apps/studio/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run studio:build && npm prune --omit=dev --no-audit --no-fund && mkdir -p apps/studio/node_modules

# google-colab-cli 要求 Python >=3.12（基础层 bookworm 系统 Python 为 3.11）；在独立构建阶段用 uv
# 安装固定提交 5cafdfaef456cfc7b3e218638c506df8f7088997 与 keyrings.alt 到 /opt/frame-colab，
# 只复制进应用镜像（不进入禁网创作镜像），并将 bin 追加在 PATH 末尾以保留 /opt/frame-tts 的默认 python3。
FROM ${BASE_IMAGE} AS colab-cli
COPY --from=ghcr.io/astral-sh/uv:0.7.8 /uv /usr/local/bin/uv
COPY docker/colab-cli-requirements.txt /tmp/colab-cli-requirements.txt
ENV UV_PYTHON_INSTALL_DIR=/opt/frame-colab/python UV_LINK_MODE=copy
RUN uv venv --python 3.12 /opt/frame-colab/venv \
    && uv pip install --python /opt/frame-colab/venv/bin/python --no-cache -r /tmp/colab-cli-requirements.txt \
    && find /opt/frame-colab -type d -name '__pycache__' -exec rm -rf {} + \
    && chmod -R a+rX /opt/frame-colab \
    && /opt/frame-colab/venv/bin/colab --help >/dev/null

FROM ${BASE_IMAGE}
# 应用专属身份与数据目录：只进应用运行时镜像。创作镜像继承基础层但不得携带 /data/factory
# （G2-1 隔离契约），其容器以数字 uid/gid 运行，无需命名用户。
RUN test -x /opt/frame-asr/bin/python && test -r /opt/frame-asr/model/model.bin \
    && groupadd -g 1001 frame && useradd -u 1001 -g frame -d /data/factory frame \
    && install -d -o frame -g frame /data/factory
ENV NODE_ENV=production STUDIO_HOST=0.0.0.0 STUDIO_PORT=4317 VIDEO_FACTORY_WORKSPACE=/data/factory HOME=/data/factory COLAB_CLI_BIN=/opt/frame-colab/venv/bin/colab PATH="${PATH}:/opt/frame-colab/venv/bin"
WORKDIR /app
COPY --from=colab-cli /opt/frame-colab /opt/frame-colab
COPY --from=build --chown=frame:frame /app/node_modules ./node_modules
COPY --from=build --chown=frame:frame /app/apps/studio/node_modules apps/studio/node_modules
COPY --chown=frame:frame package.json ./
COPY --chown=frame:frame apps/studio/package.json apps/studio/
COPY --from=build --chown=frame:frame /app/apps/studio/dist apps/studio/dist
COPY --chown=frame:frame apps/studio/skills apps/studio/skills
COPY --chown=frame:frame .agents/skills/colab-ltx-video .agents/skills/colab-ltx-video
COPY --chown=frame:frame scripts/ultra_media_common.py scripts/ultra_config.py scripts/
COPY --chown=frame:frame scripts/rotate-frame-credentials.mjs scripts/rotate-frame-credentials.mjs
USER frame
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(async r=>{if(!r.ok||(await r.json()).product!=='frame')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","apps/studio/dist/server/server/main.js"]
