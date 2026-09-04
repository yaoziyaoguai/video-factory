#!/usr/bin/env bash
# ZAI Code Plan broker 的一次性宿主机初始化。密钥只从既有 0600 文件读取。
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
broker_root=/opt/video-factory/codex-broker
broker_user=vf-zai-codex
broker_group=vf-bridge
broker_uid="${ZAI_CODEX_UID:-22003}"
broker_home=/home/vf-zai-codex
broker_state_root=/var/lib/video-factory-zai-codex
broker_workspace="$broker_state_root/workspace"
broker_socket=/run/video-factory-zai-codex/worker.sock
env_file=/etc/video-factory/zai-codex-broker.env
unit_source="$repository_root/apps/codex-broker/deploy/vf-zai-codex-broker.service"
unit_target=/etc/systemd/system/vf-zai-codex-broker.service
service=vf-zai-codex-broker

fail() {
  echo "[setup-zai-codex-broker] $1" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || fail "必须以 root 运行。"
getent group "$broker_group" >/dev/null 2>&1 || fail "缺少 $broker_group；请先运行 setup-codex-broker-host.sh。"

if ! id -u "$broker_user" >/dev/null 2>&1; then
  useradd --create-home --uid "$broker_uid" --shell /usr/sbin/nologin "$broker_user"
fi
if ! id -nG "$broker_user" | tr ' ' '\n' | grep -qx "$broker_group"; then
  usermod -aG "$broker_group" "$broker_user"
fi
install -d -o "$broker_user" -g "$broker_group" -m 0750 "$broker_state_root" "$broker_workspace"

[[ -f "$env_file" ]] || fail "缺少 $env_file；请先以 root:root 0600 写入 ZAI_BIGMODEL_API_KEY。"
[[ "$(stat -c %U:%G "$env_file")" == "root:root" ]] || fail "$env_file 必须属于 root:root。"
[[ "$(stat -c %a "$env_file")" == "600" ]] || fail "$env_file 权限必须是 600。"
grep -qE '^ZAI_BIGMODEL_API_KEY=.+$' "$env_file" || fail "$env_file 缺少非空 ZAI_BIGMODEL_API_KEY。"
if grep -qE '^ZAI_API_KEY=' "$env_file"; then
  fail "$env_file 仍包含旧 ZAI_API_KEY；请删除后只保留 ZAI_BIGMODEL_API_KEY。"
fi

node_bin="$broker_root/bin/node"
[[ -x "$node_bin" ]] || fail "缺少共享 Node 运行时；请先运行 setup-codex-broker-host.sh。"
node_major="$($node_bin --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" -ge 22 ]] || fail "需要 Node >= 22。"
runuser -u "$broker_user" -- env HOME="$broker_home" PATH="$broker_root/bin:/usr/local/bin:/usr/bin:/bin" "$node_bin" --version >/dev/null \
  || fail "$broker_user 无法执行共享 Node 运行时。"

[[ -f "$unit_source" ]] || fail "缺少 unit 文件：$unit_source"
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable "$service" >/dev/null

if [[ -f "$broker_root/current/dist/main.js" ]]; then
  systemctl restart "$service"
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --unix-socket "$broker_socket" http://localhost/health >/dev/null; then
      echo "ZAI Code Plan broker 已就绪。"
      exit 0
    fi
    sleep 1
  done
  systemctl --no-pager --lines=40 status "$service" || true
  fail "$service 未在健康检查内就绪。"
fi

echo "宿主机初始化完成；下一次部署会安装并启动 ZAI broker 制品。"
