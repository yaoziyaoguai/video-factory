FROM node:22.23.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pil ffmpeg chromium fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY docker/creative-operations.py /opt/frame/creative-operations.py
RUN chmod 0555 /opt/frame/creative-operations.py && mkdir /workspace /skills
WORKDIR /workspace
# 宿主入口固定覆盖 UID/GID、env、资源和网络；镜像不含应用、数据库或凭据。
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "/bin/bash", "--noprofile", "--norc"]
