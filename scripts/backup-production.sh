#!/usr/bin/env bash
# VideoFactory 离线完整备份（R2）入口。实际逻辑在 production-backup.py：
# 只在维护门禁 FROZEN、全部写者已退出的窗口产出可验证的 full 归档。
set -euo pipefail
umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -I -B "${repository_root}/scripts/production-backup.py" --repository-root "$repository_root" "$@"
