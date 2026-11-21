# 稳定的系统与字体基础镜像：app 与 creative 两镜像共有的 apt 系统栈、Node 运行时与 edge-tts venv。
# 内容哈希输入 = 本文件 + docker/edge-tts-requirements.txt；CI 命中远端标签时直接拉取复用（保证层摘要
# 稳定），否则本地构建。应用镜像因此只运输业务层，ECS 按层增量拉取。应用专属的 UID 1001 身份与
# /data/factory 数据目录不放这里：创作镜像继承本基础层，不得携带应用数据目录（G2-1 隔离契约）；
# venv 留在共享层，创作容器入口以 env -i 重置 PATH，venv 在其中不可达。
FROM node:22.23.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk ca-certificates git python3 python3-venv python3-pil chromium \
    && rm -rf /var/lib/apt/lists/*
COPY docker/edge-tts-requirements.txt /opt/frame/edge-tts-requirements.txt
RUN python3 -m venv /opt/frame-tts \
    && /opt/frame-tts/bin/python3 -m pip install --no-cache-dir --timeout 60 -r /opt/frame/edge-tts-requirements.txt
ENV PATH="/opt/frame-tts/bin:${PATH}"
