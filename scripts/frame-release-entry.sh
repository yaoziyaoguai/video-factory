#!/bin/sh
# 正式发布和双端口演练共用这一开关，由调用方负责已有维护窗口的归属。
set -eu
marker=/run/video-factory/frame.maintenance
case "$1" in
  close)
    install -d -m 755 /run/video-factory
    (set -C; : > "$marker")
    ;;
  open) rm -f "$marker" ;;
  *) exit 2 ;;
esac
