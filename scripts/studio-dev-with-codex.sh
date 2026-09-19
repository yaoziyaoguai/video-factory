#!/usr/bin/env bash
# ChatGPT/Codex 套餐已退役（用户指令 2026-09-18）：本脚本只拉起 DeepSeek broker 与 Studio。
# 文件名保留（package.json 与重启脚本的既有引用），内容已不含 codex broker。
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deepseek_runtime_root=${VIDEO_FACTORY_DEEPSEEK_CODEX_LOCAL_RUNTIME_ROOT:-"$repository_root/.local/runtime/deepseek-codex"}
deepseek_socket_path=${VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH:-"$deepseek_runtime_root/worker.sock"}
deepseek_workspace_root=${VIDEO_FACTORY_DEEPSEEK_CODEX_WORKSPACE_ROOT:-"$deepseek_runtime_root/tasks"}
deepseek_env_file=${DEEPSEEK_ENV_FILE:-"$repository_root/.local/secrets/deepseek.env"}
# 本地与生产 unit 统一 1200s（20 分钟）deadline；xhigh/max 强推理候选在旧 300s/600s 默认下无法完成。
codex_timeout_ms=${VIDEO_FACTORY_CODEX_TIMEOUT_MS:-1200000}
# 已审核的模型候选表：界面上能按节点指定的模型只能是这张表里的（首个即 broker 默认模型）。
# 留空则完全禁止按请求换模型——所以这里是启用的地方，不是可选的装饰。
deepseek_model_candidates=${VIDEO_FACTORY_DEEPSEEK_MODEL_CANDIDATES:-deepseek-flash,deepseek-v4-pro}
deepseek_broker_pid=""

cd "$repository_root"
npm run build:broker

if [[ -f "$deepseek_env_file" ]] \
  && env -u DEEPSEEK_API_KEY node --env-file="$deepseek_env_file" -e 'process.exit(process.env.DEEPSEEK_API_KEY?.trim() ? 0 : 1)'; then
  mkdir -p "$deepseek_runtime_root" "$deepseek_workspace_root"
  env -u DEEPSEEK_API_KEY \
    VIDEO_FACTORY_CODEX_PROFILE=deepseek \
    VIDEO_FACTORY_CODEX_EFFORT=xhigh \
    VIDEO_FACTORY_CODEX_AUDIT_EFFORT=xhigh \
    VIDEO_FACTORY_CODEX_TIMEOUT_MS="$codex_timeout_ms" \
    VIDEO_FACTORY_CODEX_SOCKET_PATH="$deepseek_socket_path" \
    VIDEO_FACTORY_CODEX_WORKSPACE_ROOT="$deepseek_workspace_root" \
    VIDEO_FACTORY_CODEX_MODEL_CANDIDATES="$deepseek_model_candidates" \
    node --env-file="$deepseek_env_file" apps/codex-broker/dist/main.js &
  deepseek_broker_pid=$!
  for _ in $(seq 1 50); do
    if curl --fail --silent --unix-socket "$deepseek_socket_path" http://localhost/health >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$deepseek_broker_pid" 2>/dev/null; then
      wait "$deepseek_broker_pid"
      exit 1
    fi
    sleep 0.1
  done
  if ! curl --fail --silent --unix-socket "$deepseek_socket_path" http://localhost/health >/dev/null; then
    echo "DeepSeek bridge did not become healthy at $deepseek_socket_path." >&2
    exit 1
  fi
else
  echo "DeepSeek env file is unavailable at $deepseek_env_file; the broker cannot start without its key." >&2
  exit 1
fi

VIDEO_FACTORY_DEEPSEEK_CODEX_SOCKET_PATH="$deepseek_socket_path" \
npm run studio:dev
