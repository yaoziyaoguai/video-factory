#!/usr/bin/env bash
set -euo pipefail

case "${1:-status}" in
  start|setup)
    if docker container inspect vf-newsnow >/dev/null 2>&1; then
      docker start vf-newsnow
    else
      docker network inspect video-factory-trends >/dev/null 2>&1 || docker network create video-factory-trends >/dev/null
      docker run -d --name vf-newsnow --restart unless-stopped --network video-factory-trends \
        -p 127.0.0.1:4444:4444 -v vf-newsnow-data:/usr/app/.data \
        -e HOST=0.0.0.0 -e PORT=4444 -e NODE_ENV=production -e INIT_TABLE=true -e ENABLE_CACHE=true \
        ghcr.io/ourongxing/newsnow:latest
    fi
    ;;
  status)
    docker ps -a --filter 'name=^/vf-newsnow$' --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
    ;;
  stop)
    docker stop vf-newsnow
    ;;
  *)
    printf 'Usage: %s {setup|start|status|stop}\n' "$0" >&2
    exit 2
    ;;
esac
