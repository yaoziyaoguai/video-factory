#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runtime_root=${VIDEO_FACTORY_CODEX_LOCAL_RUNTIME_ROOT:-"$repository_root/.local/runtime/codex"}
socket_path=${VIDEO_FACTORY_CODEX_SOCKET_PATH:-"$runtime_root/worker.sock"}
workspace_root=${VIDEO_FACTORY_CODEX_WORKSPACE_ROOT:-"$runtime_root/tasks"}
codex_bin=${CODEX_BIN:-$(command -v codex || true)}

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
  wait "$broker_pid" 2>/dev/null || true
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

VIDEO_FACTORY_CODEX_SOCKET_PATH="$socket_path" npm run studio:dev
