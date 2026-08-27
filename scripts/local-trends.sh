#!/usr/bin/env bash
set -euo pipefail

case "${1:-status}" in
  start|setup)
    exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-local-trends.sh"
    ;;
  status)
    docker ps -a --filter 'name=vf-' --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
    ;;
  stop)
    docker stop vf-trendradar vf-trendradar-mcp vf-newsnow vf-dailyhot vf-rsshub
    ;;
  *)
    printf 'Usage: %s {setup|start|status|stop}\n' "$0" >&2
    exit 2
    ;;
esac
