#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${VIDEO_FACTORY_AGENT_RUNTIME:-${ROOT_DIR}/.local/agent}"
TOPIC_MODEL="${VIDEO_FACTORY_TOPIC_MODEL:-qwen3:4b}"
DIRECTOR_MODEL="${VIDEO_FACTORY_DIRECTOR_MODEL:-qwen3:8b}"
ENDPOINT="${VIDEO_FACTORY_OLLAMA_URL:-http://127.0.0.1:11434}"

mkdir -p "${RUNTIME_DIR}"

if ! command -v ollama >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { printf '需要 Homebrew 安装 Ollama。\n' >&2; exit 1; }
  brew install ollama
fi

if ! curl --fail --silent --max-time 2 "${ENDPOINT}/api/tags" >/dev/null 2>&1; then
  brew services start ollama >/dev/null
fi

for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 "${ENDPOINT}/api/tags" >/dev/null; then
    break
  fi
  if [[ "${attempt}" == "30" ]]; then
    printf 'Ollama 服务未能在 %s 启动。\n' "${ENDPOINT}" >&2
    exit 1
  fi
  sleep 2
done

ollama pull "${TOPIC_MODEL}"
if [[ "${DIRECTOR_MODEL}" != "${TOPIC_MODEL}" ]]; then
  ollama pull "${DIRECTOR_MODEL}"
fi

smoke_test() {
  local role="$1"
  local model="$2"
  local response="${RUNTIME_DIR}/${role}-smoke.json"
  curl --fail --silent --show-error --max-time 240 \
    -H 'content-type: application/json' \
    "${ENDPOINT}/api/chat" \
    -d "$(printf '{\"model\":\"%s\",\"stream\":false,\"think\":false,\"format\":\"json\",\"messages\":[{\"role\":\"user\",\"content\":\"只输出 JSON：{\\\"status\\\":\\\"ready\\\"}\"}]}' "${model}")" \
    -o "${response}"
  jq -e '.message.content | fromjson | .status == "ready"' "${response}" >/dev/null
}

smoke_test "topic" "${TOPIC_MODEL}"
smoke_test "director" "${DIRECTOR_MODEL}"

printf '{\n  "topicModel": "%s",\n  "directorModel": "%s",\n  "endpoint": "%s",\n  "verifiedAt": "%s"\n}\n' \
  "${TOPIC_MODEL}" "${DIRECTOR_MODEL}" "${ENDPOINT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${RUNTIME_DIR}/qwen3.ready.json"

printf '本地选题 Agent 已就绪：%s\n' "${TOPIC_MODEL}"
printf '本地视觉导演已就绪：%s (%s)\n' "${DIRECTOR_MODEL}" "${ENDPOINT}"
