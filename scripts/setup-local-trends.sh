#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="${ROOT_DIR}/.local/trends"
TREND_RADAR_DIR="${LOCAL_DIR}/trendradar"
SMOKE_DIR="${LOCAL_DIR}/smoke"

readonly TREND_RADAR_IMAGE="wantcat/trendradar:latest"
readonly TREND_RADAR_MCP_IMAGE="wantcat/trendradar-mcp:latest"
readonly NEWSNOW_IMAGE="ghcr.io/ourongxing/newsnow:latest"
readonly DAILYHOT_IMAGE="imsyy/dailyhot-api:latest"
readonly RSSHUB_IMAGE="diygod/rsshub:latest"

pull_image() {
  local image="$1"
  local attempt
  for attempt in 1 2 3; do
    if docker pull "${image}"; then
      return 0
    fi
    printf '镜像拉取失败，准备重试 (%s/3): %s\n' "${attempt}" "${image}" >&2
    sleep $((attempt * 3))
  done
  return 1
}

replace_container() {
  local name="$1"
  shift
  if docker container inspect "${name}" >/dev/null 2>&1; then
    docker rm -f "${name}" >/dev/null
  fi
  docker run -d --name "${name}" --restart unless-stopped "$@" >/dev/null
}

wait_for_url() {
  local name="$1"
  local url="$2"
  local output="$3"
  local attempt
  for attempt in $(seq 1 36); do
    if curl --fail --silent --show-error --max-time 8 "${url}" -o "${output}"; then
      printf '%-18s ready  %s\n' "${name}" "${url}"
      return 0
    fi
    sleep 5
  done
  printf '%-18s failed %s\n' "${name}" "${url}" >&2
  docker logs --tail 80 "${name}" >&2 || true
  return 1
}

mkdir -p "${LOCAL_DIR}" "${SMOKE_DIR}"

if [[ ! -d "${TREND_RADAR_DIR}/.git" ]]; then
  git clone --depth 1 https://github.com/sansan0/TrendRadar.git "${TREND_RADAR_DIR}"
fi
mkdir -p "${TREND_RADAR_DIR}/output"

for image in \
  "${TREND_RADAR_IMAGE}" \
  "${TREND_RADAR_MCP_IMAGE}" \
  "${NEWSNOW_IMAGE}" \
  "${DAILYHOT_IMAGE}" \
  "${RSSHUB_IMAGE}"; do
  pull_image "${image}"
done

replace_container vf-trendradar \
  -p 127.0.0.1:8080:8080 \
  -v "${TREND_RADAR_DIR}/config:/app/config:ro" \
  -v "${TREND_RADAR_DIR}/output:/app/output" \
  -e TZ=Asia/Shanghai \
  -e WEBSERVER_PORT=8080 \
  -e RUN_MODE=cron \
  -e IMMEDIATE_RUN=true \
  -e AI_ANALYSIS_ENABLED=false \
  -e AI_TRANSLATION_ENABLED=false \
  -e AI_FILTER_ENABLED=false \
  "${TREND_RADAR_IMAGE}"

replace_container vf-trendradar-mcp \
  -p 127.0.0.1:3333:3333 \
  -v "${TREND_RADAR_DIR}/config:/app/config:ro" \
  -v "${TREND_RADAR_DIR}/output:/app/output:ro" \
  -e TZ=Asia/Shanghai \
  -e MCP_PORT=3333 \
  "${TREND_RADAR_MCP_IMAGE}"

replace_container vf-newsnow \
  -p 127.0.0.1:4444:4444 \
  -v vf-newsnow-data:/usr/app/.data \
  -e HOST=0.0.0.0 \
  -e PORT=4444 \
  -e NODE_ENV=production \
  -e INIT_TABLE=true \
  -e ENABLE_CACHE=true \
  "${NEWSNOW_IMAGE}"

replace_container vf-dailyhot \
  -p 127.0.0.1:6688:6688 \
  "${DAILYHOT_IMAGE}"

replace_container vf-rsshub \
  -p 127.0.0.1:1200:1200 \
  -e NODE_ENV=production \
  -e CACHE_TYPE=memory \
  "${RSSHUB_IMAGE}"

wait_for_url vf-trendradar http://127.0.0.1:8080/ "${SMOKE_DIR}/trendradar.html"
wait_for_url vf-newsnow 'http://127.0.0.1:4444/api/s?id=weibo' "${SMOKE_DIR}/newsnow-weibo.json"
wait_for_url vf-dailyhot http://127.0.0.1:6688/douyin "${SMOKE_DIR}/dailyhot-douyin.json"
wait_for_url vf-rsshub http://127.0.0.1:1200/ "${SMOKE_DIR}/rsshub.html"

curl --fail --silent --show-error --max-time 8 \
  -H 'accept: application/json, text/event-stream' \
  http://127.0.0.1:3333/mcp \
  -o "${SMOKE_DIR}/trendradar-mcp.txt" || {
    printf 'TrendRadar MCP 端口已启动，但 GET /mcp 未返回普通健康响应；保留容器供 MCP 客户端握手。\n' >&2
  }

docker ps --filter 'name=vf-' --format 'table {{.Names}}\t{{.Ports}}\t{{.Status}}'
