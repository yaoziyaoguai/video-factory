#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runtime_root=${VIDEO_FACTORY_CODEX_LOCAL_RUNTIME_ROOT:-"$repository_root/.local/runtime/codex"}
socket_path=${VIDEO_FACTORY_CODEX_SOCKET_PATH:-"$runtime_root/worker.sock"}
workspace_root=${VIDEO_FACTORY_CODEX_WORKSPACE_ROOT:-"$runtime_root/tasks"}
codex_bin=${CODEX_BIN:-$(command -v codex || true)}
zai_runtime_root=${VIDEO_FACTORY_ZAI_CODEX_LOCAL_RUNTIME_ROOT:-"$repository_root/.local/runtime/zai-codex"}
zai_socket_path=${VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH:-"$zai_runtime_root/worker.sock"}
zai_workspace_root=${VIDEO_FACTORY_ZAI_CODEX_WORKSPACE_ROOT:-"$zai_runtime_root/tasks"}
zai_env_file=${ZAI_BIGMODEL_ENV_FILE:-"$repository_root/.local/secrets/zai-bigmodel.env"}
zai_broker_pid=""

if [[ -z "$codex_bin" ]]; then
  echo "Codex CLI is unavailable. Install or expose codex before starting the full Studio." >&2
  exit 1
fi
if ! "$codex_bin" login status >/dev/null 2>&1; then
  echo "Codex is not logged in. Run 'codex login' before starting the full Studio." >&2
  exit 1
fi

mkdir -p "$runtime_root" "$workspace_root"
cd "$repository_root"
npm run build:broker

VIDEO_FACTORY_CODEX_SOCKET_PATH="$socket_path" \
VIDEO_FACTORY_CODEX_WORKSPACE_ROOT="$workspace_root" \
CODEX_BIN="$codex_bin" \
npm run start --workspace @video-factory/codex-broker &
broker_pid=$!

cleanup() {
  kill "$broker_pid" 2>/dev/null || true
  if [[ -n "$zai_broker_pid" ]]; then
    kill "$zai_broker_pid" 2>/dev/null || true
  fi
  wait "$broker_pid" 2>/dev/null || true
  if [[ -n "$zai_broker_pid" ]]; then
    wait "$zai_broker_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  if curl --fail --silent --unix-socket "$socket_path" http://localhost/health >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$broker_pid" 2>/dev/null; then
    wait "$broker_pid"
    exit 1
  fi
  sleep 0.1
done

if ! curl --fail --silent --unix-socket "$socket_path" http://localhost/health >/dev/null; then
  echo "Codex bridge did not become healthy at $socket_path." >&2
  exit 1
fi

if [[ -f "$zai_env_file" ]] && grep -qE '^ZAI_API_KEY=' "$zai_env_file"; then
  echo "$zai_env_file still contains legacy ZAI_API_KEY; remove it and keep only ZAI_BIGMODEL_API_KEY." >&2
  exit 1
fi

if [[ -f "$zai_env_file" ]] \
  && env -u ZAI_BIGMODEL_API_KEY -u ZAI_API_KEY node --env-file="$zai_env_file" -e 'process.exit(process.env.ZAI_BIGMODEL_API_KEY?.trim() ? 0 : 1)'; then
  mkdir -p "$zai_runtime_root" "$zai_workspace_root"
  env -u ZAI_BIGMODEL_API_KEY -u ZAI_API_KEY \
    VIDEO_FACTORY_CODEX_PROFILE=zai \
    VIDEO_FACTORY_CODEX_EFFORT=high \
    VIDEO_FACTORY_CODEX_SOCKET_PATH="$zai_socket_path" \
    VIDEO_FACTORY_CODEX_WORKSPACE_ROOT="$zai_workspace_root" \
    node --env-file="$zai_env_file" apps/codex-broker/dist/main.js &
  zai_broker_pid=$!
  for _ in $(seq 1 50); do
    if curl --fail --silent --unix-socket "$zai_socket_path" http://localhost/health >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$zai_broker_pid" 2>/dev/null; then
      wait "$zai_broker_pid"
      exit 1
    fi
    sleep 0.1
  done
  if ! curl --fail --silent --unix-socket "$zai_socket_path" http://localhost/health >/dev/null; then
    echo "ZAI Code Plan bridge did not become healthy at $zai_socket_path." >&2
    exit 1
  fi
fi

VIDEO_FACTORY_CODEX_SOCKET_PATH="$socket_path" \
VIDEO_FACTORY_ZAI_CODEX_SOCKET_PATH="$zai_socket_path" \
npm run studio:dev
