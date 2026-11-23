# 稳定的系统与媒体基础镜像：app 与 creative 共用 apt、Node、Edge 配音和离线转录环境。
# CI 哈希包含本文件及运行时安装输入，命中远端标签时直接拉取复用（保证层摘要
# 稳定），否则本地构建。应用镜像因此只运输业务层，ECS 按层增量拉取。应用专属的 UID 1001 身份与
# /data/factory 数据目录不放这里：创作镜像继承本基础层，不得携带应用数据目录（G2-1 隔离契约）；
# venv 留在共享层，创作容器入口以 env -i 重置 PATH，venv 在其中不可达。
FROM node:22.23.1-bookworm-slim
# DEBIAN_MIRROR 可选替换 Debian 官方源（如 mirrors.tuna.tsinghua.edu.cn），受限网络下加速基础层构建。
# 本镜像 bookworm 的主源与 security 源都在 deb.debian.org 域名下，替换一处即全覆盖。
ARG DEBIAN_MIRROR=
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
        sed -i "s|//deb.debian.org|//$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-cjk ca-certificates git python3 python3-venv python3-pil chromium make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY docker/edge-tts-requirements.txt /opt/frame/edge-tts-requirements.txt
# PIP_INDEX_URL 可选替换 PyPI 官方源（如 https://pypi.tuna.tsinghua.edu.cn/simple）；
# 空值时 pip 用默认源。venv 与 ASR 两处安装都受它控制。
ARG PIP_INDEX_URL=
RUN python3 -m venv /opt/frame-tts \
    && PIP_INDEX_URL="$PIP_INDEX_URL" /opt/frame-tts/bin/python3 -m pip install --no-cache-dir --timeout 60 -r /opt/frame/edge-tts-requirements.txt
ARG HF_ENDPOINT=https://huggingface.co
ARG FRAME_ASR_MODEL_ID=Systran/faster-whisper-base
ARG FRAME_ASR_MODEL_REVISION
ARG FRAME_ASR_MODEL_SHA256
COPY scripts/install-frame-asr.sh scripts/frame-transcribe.py /opt/frame-asr-install/
RUN PIP_INDEX_URL="$PIP_INDEX_URL" sh /opt/frame-asr-install/install-frame-asr.sh /opt/frame-asr && rm -r /opt/frame-asr-install
ENV PATH="/opt/frame-tts/bin:${PATH}"
