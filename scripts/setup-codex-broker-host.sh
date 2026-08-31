#!/usr/bin/env bash
# 宿主机初始化（幂等）：vf-bridge 组、目录、systemd 单元、Node/Codex/login 校验。
# 只验证不假设；绝不复制、移动或挂载任何 Codex auth。
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
broker_root=/opt/video-factory/codex-broker
broker_user=vf-codex
broker_group=vf-bridge
broker_gid="${CODEX_BRIDGE_GID:-22002}"
broker_home=/home/vf-codex
broker_codex_home=/var/lib/video-factory-codex/codex-home
broker_socket=/run/video-factory-codex/worker.sock
env_file=/etc/video-factory/codex-broker.env
unit_source="$repository_root/apps/codex-broker/deploy/vf-codex-broker.service"
unit_target=/etc/systemd/system/vf-codex-broker.service
service=vf-codex-broker
default_codex_model=gpt-5.6-terra
default_codex_audit_model=gpt-5.6-sol
default_codex_effort=high
default_codex_audit_effort=max

fail() {
  echo "[setup-codex-broker] $1" >&2
  exit 1
}

if [[ "$(id -u)" -ne 0 ]]; then
  fail "必须以 root 运行。"
fi

id -u "$broker_user" >/dev/null 2>&1 || fail "缺少用户 $broker_user；请先 useradd -m -u 22001 $broker_user"
if [[ "$(id -u "$broker_user")" -ne 22001 ]]; then
  echo "提示：$broker_user 的 uid 是 $(id -u "$broker_user")（文档按 22001 编写）。" >&2
fi

if getent group "$broker_group" >/dev/null 2>&1; then
  [[ "$(getent group "$broker_group" | cut -d: -f3)" == "$broker_gid" ]] \
    || fail "组 $broker_group 已存在但 gid 不是 $broker_gid；用 CODEX_BRIDGE_GID 指定正确值或先清理。"
else
  groupadd --gid "$broker_gid" "$broker_group"
fi
if ! id -nG "$broker_user" | tr ' ' '\n' | grep -qx "$broker_group"; then
  usermod -aG "$broker_group" "$broker_user"
fi

install -d -m 0755 "$broker_root" "$broker_root/bin" "$broker_root/releases"
install -d -o "$broker_user" -g "$broker_group" -m 0750 /var/lib/video-factory-codex /var/lib/video-factory-codex/workspace
install -d -o "$broker_user" -g "$broker_group" -m 0750 "$broker_codex_home"
install -d -o "$broker_user" -g "$broker_user" -m 0700 "$broker_home/.codex" \
  "$broker_home/.codex/sessions" "$broker_home/.codex/log"

# Node 发现：vf-codex 自有路径优先，系统路径仅作回退；必须由 vf-codex 本人可执行。
node_bin=""
for candidate in "$broker_home/.local/node22/bin/node" "$broker_home/.local/bin/node" \
  "$broker_home/.local/node/bin/node" /usr/local/bin/node /usr/bin/node; do
  if [[ -x "$candidate" ]] && runuser -u "$broker_user" -- "$candidate" --version >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done
[[ -n "$node_bin" ]] || fail "未找到 $broker_user 可执行的 node；请为其安装 Node 22（预期位于 $broker_home/.local/node22 或 .local/bin）。"
node_version="$(runuser -u "$broker_user" -- "$node_bin" --version | sed 's/^v//')"
node_major="${node_version%%.*}"
[[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]] || fail "需要 Node >= 22，当前为 $node_version（$node_bin）。"

# codex 的 shebang 是 #!/usr/bin/env node：校验时必须带上与 unit 一致的 PATH。
codex_path="$(dirname "$node_bin"):$broker_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
codex_bin=""
for candidate in "$broker_home/.local/bin/codex" /usr/local/bin/codex /usr/bin/codex; do
  if [[ -x "$candidate" ]] \
    && runuser -u "$broker_user" -- env HOME="$broker_home" PATH="$codex_path" "$candidate" --version >/dev/null 2>&1; then
    codex_bin="$candidate"
    break
  fi
done
[[ -n "$codex_bin" ]] || fail "未找到 $broker_user 可执行的 codex CLI（预期位于 $broker_home/.local/bin）。"

if ! runuser -u "$broker_user" -- env HOME="$broker_home" PATH="$codex_path" "$codex_bin" login status >/dev/null 2>&1; then
  fail "Codex 未登录。请操作员手动执行：runuser -u $broker_user -- env HOME=$broker_home PATH=$codex_path $codex_bin login ，完成后重跑本脚本。本脚本不会自动复制任何 auth。"
fi

# 可变 CLI 状态与真实登录目录分离。只链接 auth，不复制凭据，也不向容器暴露该目录。
codex_auth="$broker_home/.codex/auth.json"
[[ -f "$codex_auth" ]] || fail "Codex 登录状态存在但未找到 $codex_auth；请重新登录后重试。"
if [[ -e "$broker_codex_home/auth.json" && ! -L "$broker_codex_home/auth.json" ]]; then
  fail "$broker_codex_home/auth.json 已存在且不是符号链接；拒绝覆盖。"
fi
ln -sfn "$codex_auth" "$broker_codex_home/auth.json"
chown -h "$broker_user:$broker_group" "$broker_codex_home/auth.json"
if ! runuser -u "$broker_user" -- env HOME="$broker_home" CODEX_HOME="$broker_codex_home" PATH="$codex_path" "$codex_bin" login status >/dev/null 2>&1; then
  fail "隔离 CODEX_HOME 无法读取登录状态；请检查 $broker_codex_home/auth.json。"
fi

shared_node_tmp="$(mktemp "$broker_root/bin/.node.XXXXXX")"
trap 'rm -f "$shared_node_tmp"' EXIT
install -o root -g root -m 0755 "$node_bin" "$shared_node_tmp"
mv -f "$shared_node_tmp" "$broker_root/bin/node"
trap - EXIT
install -d -m 0755 "$(dirname "$env_file")"
existing_codex_model="$(awk -F= '$1 == "VIDEO_FACTORY_CODEX_MODEL" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
existing_codex_audit_model="$(awk -F= '$1 == "VIDEO_FACTORY_CODEX_AUDIT_MODEL" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
existing_codex_effort="$(awk -F= '$1 == "VIDEO_FACTORY_CODEX_EFFORT" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
existing_codex_audit_effort="$(awk -F= '$1 == "VIDEO_FACTORY_CODEX_AUDIT_EFFORT" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
codex_model="${VIDEO_FACTORY_CODEX_MODEL:-$existing_codex_model}"
codex_audit_model="${VIDEO_FACTORY_CODEX_AUDIT_MODEL:-$existing_codex_audit_model}"
codex_effort="${VIDEO_FACTORY_CODEX_EFFORT:-$existing_codex_effort}"
codex_audit_effort="${VIDEO_FACTORY_CODEX_AUDIT_EFFORT:-$existing_codex_audit_effort}"
codex_model="${codex_model:-$default_codex_model}"
codex_audit_model="${codex_audit_model:-$default_codex_audit_model}"
codex_effort="${codex_effort:-$default_codex_effort}"
codex_audit_effort="${codex_audit_effort:-$default_codex_audit_effort}"
env_tmp="$(mktemp)"
{
  grep -Ev '^(CODEX_BIN|VIDEO_FACTORY_CODEX_MODEL|VIDEO_FACTORY_CODEX_AUDIT_MODEL|VIDEO_FACTORY_CODEX_EFFORT|VIDEO_FACTORY_CODEX_AUDIT_EFFORT)=' "$env_file" 2>/dev/null || true
  printf 'CODEX_BIN=%s\n' "$codex_bin"
  printf 'VIDEO_FACTORY_CODEX_MODEL=%s\n' "$codex_model"
  printf 'VIDEO_FACTORY_CODEX_AUDIT_MODEL=%s\n' "$codex_audit_model"
  printf 'VIDEO_FACTORY_CODEX_EFFORT=%s\n' "$codex_effort"
  printf 'VIDEO_FACTORY_CODEX_AUDIT_EFFORT=%s\n' "$codex_audit_effort"
} >"$env_tmp"
install -m 0644 "$env_tmp" "$env_file"
rm -f "$env_tmp"

[[ -f "$unit_source" ]] || fail "缺少 unit 文件：$unit_source"
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable "$service" >/dev/null

if [[ -f "$broker_root/current/dist/main.js" ]]; then
  systemctl restart "$service"
  healthy=1
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --unix-socket "$broker_socket" http://localhost/health >/dev/null; then
      healthy=0
      break
    fi
    sleep 1
  done
  if [[ "$healthy" -ne 0 ]]; then
    systemctl --no-pager --lines=40 status "$service" || true
    fail "$service 未在健康检查内就绪，请查看 journalctl -u $service。"
  fi
else
  echo "尚未部署 broker 制品；请运行 bash scripts/deploy-production.sh 完成提取与启动。" >&2
fi

echo "vf-bridge gid = $broker_gid（deploy 脚本会从 getent 派生并导出 VIDEO_FACTORY_CODEX_SOCKET_GID）。"
echo "setup 完成。"
