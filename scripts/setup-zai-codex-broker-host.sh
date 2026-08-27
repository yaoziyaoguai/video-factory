#!/usr/bin/env bash
# ZAI 视觉审片 broker 的一次性宿主机初始化。密钥只从既有 0600 文件读取。
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
broker_root=/opt/video-factory/codex-broker
broker_user=vf-zai-codex
broker_group=vf-bridge
broker_uid="${ZAI_CODEX_UID:-22003}"
broker_home=/home/vf-zai-codex
broker_state=/var/lib/video-factory-zai-codex
broker_socket=/run/video-factory-zai-codex/worker.sock
env_file=/etc/video-factory/zai-codex-broker.env
unit_source="$repository_root/apps/codex-broker/deploy/vf-zai-codex-broker.service"
unit_target=/etc/systemd/system/vf-zai-codex-broker.service
service=vf-zai-codex-broker
catalog_source="$repository_root/apps/codex-broker/deploy/zai-models.json"
catalog_target="$broker_state/codex-home/models.json"

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

[[ -f "$env_file" ]] || fail "缺少 $env_file；请先以 root:root 0600 写入 ZAI_API_KEY。"
[[ "$(stat -c %U:%G "$env_file")" == "root:root" ]] || fail "$env_file 必须属于 root:root。"
[[ "$(stat -c %a "$env_file")" == "600" ]] || fail "$env_file 权限必须是 600。"
grep -qE '^ZAI_API_KEY=.+$' "$env_file" || fail "$env_file 缺少非空 ZAI_API_KEY。"

install -d -m 0755 "$broker_root" "$broker_root/bin" "$broker_root/releases"
install -d -o "$broker_user" -g "$broker_group" -m 0750 "$broker_state" "$broker_state/workspace"
install -d -o "$broker_user" -g "$broker_user" -m 0700 "$broker_home" "$broker_state/codex-home"

node_bin="$broker_root/bin/node"
[[ -x "$node_bin" ]] || fail "缺少共享 Node 运行时；请先运行 setup-codex-broker-host.sh。"
node_major="$($node_bin --version | sed -E 's/^v([0-9]+).*/\1/')"
[[ "$node_major" -ge 22 ]] || fail "需要 Node >= 22。"
[[ -f "$catalog_source" ]] || fail "缺少 GLM 模型目录：$catalog_source"
"$node_bin" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$catalog_source" \
  || fail "GLM 模型目录不是有效 JSON。"
install -o "$broker_user" -g "$broker_user" -m 0600 "$catalog_source" "$catalog_target"

# ZAI profile 不读取 OpenAI 登录态，但仍复用同一版本的 Codex CLI 程序。
codex_bin="$broker_root/bin/codex"
if [[ ! -x "$codex_bin" ]]; then
  openai_codex=/home/vf-codex/.local/bin/codex
  [[ -x "$openai_codex" ]] || fail "未找到已验证的宿主机 Codex CLI。"
  codex_version="$(runuser -u vf-codex -- env HOME=/home/vf-codex PATH=/home/vf-codex/.local/node22/bin:/home/vf-codex/.local/bin:/usr/local/bin:/usr/bin:/bin "$openai_codex" --version | awk '{print $2}')"
  npm_bin=/home/vf-codex/.local/node22/bin/npm
  [[ -x "$npm_bin" ]] || fail "未找到与共享 Node 匹配的 npm。"
  env PATH="$broker_root/bin:/home/vf-codex/.local/node22/bin:/usr/local/bin:/usr/bin:/bin" \
    "$npm_bin" install --prefix "$broker_root/codex-cli" --omit=dev "@openai/codex@$codex_version"
  ln -sfn "$broker_root/codex-cli/node_modules/.bin/codex" "$codex_bin"
fi
runuser -u "$broker_user" -- env HOME="$broker_home" CODEX_HOME="$broker_state/codex-home" PATH="$broker_root/bin:/usr/local/bin:/usr/bin:/bin" "$codex_bin" --version >/dev/null \
  || fail "$broker_user 无法执行共享 Codex CLI。"
runuser -u "$broker_user" -- env HOME="$broker_home" CODEX_HOME="$broker_state/codex-home" PATH="$broker_root/bin:/usr/local/bin:/usr/bin:/bin" "$codex_bin" exec --help \
  | grep -q -- '--image' || fail "当前 Codex CLI 不支持视觉审片所需的 --image 参数。"

[[ -f "$unit_source" ]] || fail "缺少 unit 文件：$unit_source"
install -m 0644 "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable "$service" >/dev/null

if [[ -f "$broker_root/current/dist/main.js" ]]; then
  systemctl restart "$service"
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 5 --unix-socket "$broker_socket" http://localhost/health >/dev/null; then
      echo "ZAI visual-review broker 已就绪。"
      exit 0
    fi
    sleep 1
  done
  systemctl --no-pager --lines=40 status "$service" || true
  fail "$service 未在健康检查内就绪。"
fi

echo "宿主机初始化完成；下一次部署会安装并启动 ZAI broker 制品。"
