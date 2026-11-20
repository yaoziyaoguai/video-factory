# 稳定的系统与字体基础镜像：app 与 creative 两镜像共有的 apt 系统栈、Node 运行时、edge-tts venv
# 与 UID 1001 身份。内容哈希输入 = 本文件 + docker/edge-tts-requirements.txt；CI 命中远端标签时
# 直接拉取复用（保证层摘要稳定），否则本地构建。应用镜像因此只运输业务层，ECS 按层增量拉取。
FROM node:22.23.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk ca-certificates git python3 python3-venv python3-pil chromium \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 frame && useradd -u 1001 -g frame -d /data/factory frame \
    && install -d -o frame -g frame /data/factory
COPY docker/edge-tts-requirements.txt /opt/frame/edge-tts-requirements.txt
RUN python3 -m venv /opt/frame-tts \
    && /opt/frame-tts/bin/python3 -m pip install --no-cache-dir -r /opt/frame/edge-tts-requirements.txt
ENV PATH="/opt/frame-tts/bin:${PATH}"
