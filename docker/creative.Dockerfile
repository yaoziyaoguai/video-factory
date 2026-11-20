# 创作容器同样基于稳定基础镜像；chromium、python3-pil、ffmpeg 与字体等系统依赖见 docker/base.Dockerfile。
# 本地构建请先执行：docker build -t frame-base:local -f docker/base.Dockerfile .
ARG BASE_IMAGE=frame-base:local
FROM ${BASE_IMAGE}
COPY docker/creative-operations.py /opt/frame/creative-operations.py
RUN chmod 0555 /opt/frame/creative-operations.py && mkdir /workspace /skills
WORKDIR /workspace
# 宿主入口固定覆盖 UID/GID、env、资源和网络；镜像不含应用、数据库或凭据。
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "/bin/bash", "--noprofile", "--norc"]
