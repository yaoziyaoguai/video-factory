#!/usr/bin/env bash
set -euo pipefail

container="${VIDEO_FACTORY_CONTAINER:-video_factory_prod}"
backup_root="${VIDEO_FACTORY_BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/backups/video-factory}"
retention="${VIDEO_FACTORY_BACKUP_RETENTION:-7}"

if ! docker inspect "$container" >/dev/null 2>&1; then
  echo "No existing VideoFactory container; skipping metadata backup."
  exit 0
fi

mkdir -p "$backup_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_root/video-factory-metadata-$timestamp.tar.gz"
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

# 视频、音频和缓存可重新生成；自动备份只保留轻量工作流状态。
docker exec "$container" tar -C /data/factory -czf - \
  --exclude='*.mp4' \
  --exclude='*.mov' \
  --exclude='*.m4a' \
  --exclude='*.wav' \
  --exclude='*.png' \
  --exclude='*.jpg' \
  --exclude='*.jpeg' \
  --exclude='*.webp' \
  . >"$partial"
mv "$partial" "$target"
trap - EXIT

find "$backup_root" -type f -name 'video-factory-metadata-*.tar.gz' -mtime "+$retention" -delete
echo "Metadata backup written to $target"
