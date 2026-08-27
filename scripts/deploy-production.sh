#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${VIDEO_FACTORY_ENV_FILE:-$repository_root/.env.docker.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
container="video_factory_prod"
broker_service=vf-codex-broker
zai_broker_service=vf-zai-codex-broker
broker_root=/opt/video-factory/codex-broker
broker_socket=/run/video-factory-codex/worker.sock
trend_network=video-factory-trends
compose=(docker compose --project-name video-factory --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")
# ECS 在中国大陆构建镜像时使用阿里云 Alpine 源；CI 直接 docker build 时保留全球官方源。
export ALPINE_MIRROR="${ALPINE_MIRROR:-http://mirrors.cloud.aliyuncs.com/alpine}"
zai_broker_enabled=0
if systemctl cat "$zai_broker_service" >/dev/null 2>&1 && [[ -s /etc/video-factory/zai-codex-broker.env ]]; then
  zai_broker_enabled=1
fi

if [[ ! -f "$environment_file" ]]; then
  echo "Missing production environment file: $environment_file" >&2
  exit 1
fi

zai_broker_runtime_dir="${VIDEO_FACTORY_ZAI_CODEX_RUNTIME_DIR:-}"
if [[ -z "$zai_broker_runtime_dir" ]]; then
  zai_broker_runtime_dir="$(awk -F= '$1 == "VIDEO_FACTORY_ZAI_CODEX_RUNTIME_DIR" { sub(/^[^=]*=/, ""); print; exit }' "$environment_file")"
fi
zai_broker_runtime_dir="${zai_broker_runtime_dir:-/run/video-factory-zai-codex}"
zai_broker_socket="$zai_broker_runtime_dir/worker.sock"

ensure_zai_runtime_mount() {
  if [[ ! -e "$zai_broker_runtime_dir" ]]; then
    install -d -o root -g vf-bridge -m 0750 "$zai_broker_runtime_dir"
  elif [[ ! -d "$zai_broker_runtime_dir" ]]; then
    echo "$zai_broker_runtime_dir exists but is not a directory." >&2
    return 1
  fi
}

# 应用与自托管热点容器只经内部网络通信；没有部署热点时保留空网络，应用会如实报告离线。
docker network inspect "$trend_network" >/dev/null 2>&1 \
  || docker network create --driver bridge "$trend_network" >/dev/null

bridge_gid="$(getent group vf-bridge | cut -d: -f3 || true)"
if [[ -z "$bridge_gid" ]]; then
  echo "Host is not initialized. Run scripts/setup-codex-broker-host.sh first." >&2
  exit 1
fi
# compose 变量插值中 shell 环境优先于 env-file：此导出以宿主机实际组为准，
# 覆盖 env-file 里可能残留的旧值；不解析、也不改写任何含密文件。
export VIDEO_FACTORY_CODEX_SOCKET_GID="$bridge_gid"
if [[ "$zai_broker_enabled" -eq 0 ]]; then
  ensure_zai_runtime_mount || exit 1
fi

# 不做“排空运行中制作”的等待：/api/runs 受登录会话保护，本脚本不持有凭据，
# 为部署开免认证端点会削弱认证边界。被中断的 run 由 recoverInterruptedRuns
# 显式标记失败（“应用重启中断了这次制作”），不会伪装成成功。

previous_image="$(docker inspect --format='{{.Image}}' "$container" 2>/dev/null || true)"
if [[ -n "$previous_image" ]]; then
  docker tag "$previous_image" video-factory:rollback
  "$repository_root/scripts/backup-production.sh"
fi

previous_broker_release="$(readlink "$broker_root/current" 2>/dev/null || true)"

wait_for_health() {
  local attempts="$1" count
  for count in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4317/api/health >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

broker_health() {
  local socket="$1"
  curl --fail --silent --max-time 5 --unix-socket "$socket" http://localhost/health >/dev/null
}

wait_for_broker_health() {
  local socket="$1" attempts="$2" count
  for count in $(seq 1 "$attempts"); do
    if broker_health "$socket"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

restart_brokers() {
  local failed=0
  if ! systemctl restart "$broker_service" || ! wait_for_broker_health "$broker_socket" 20; then
    failed=1
  fi
  if [[ "$zai_broker_enabled" -eq 1 ]]; then
    if ! systemctl restart "$zai_broker_service" || ! wait_for_broker_health "$zai_broker_socket" 20; then
      echo "Optional ZAI visual-review broker is unavailable; continuing with the primary Codex broker." >&2
      zai_broker_enabled=0
      systemctl stop "$zai_broker_service" || true
      ensure_zai_runtime_mount || failed=1
    fi
  fi
  return "$failed"
}

rollback_broker() {
  if [[ -z "$previous_broker_release" ]] || [[ ! -d "$previous_broker_release" ]]; then
    echo "No previous broker release is available for rollback." >&2
    return 1
  fi
  case "$previous_broker_release" in
    "$broker_root/releases/"*) ;;
    *)
      echo "Refusing to roll back unvalidated path: $previous_broker_release" >&2
      return 1
      ;;
  esac
  echo "Restoring the previous codex broker release."
  if ! ln -sfn "$previous_broker_release" "$broker_root/current"; then
    return 1
  fi
  restart_brokers
}

rollback() {
  local failed=0
  # 两个 broker 共享同一个 release 指针，先一起恢复并通过各自健康检查，
  # 再恢复应用镜像，避免最终留下新旧版本混跑。
  rollback_broker || failed=1
  if [[ -z "$previous_image" ]] || ! docker image inspect video-factory:rollback >/dev/null 2>&1; then
    echo "No previous VideoFactory image is available for rollback." >&2
    failed=1
  else
    echo "Restoring the previous VideoFactory image."
    if ! docker tag video-factory:rollback video-factory:candidate \
      || ! "${compose[@]}" up --detach --no-deps --force-recreate app \
      || ! wait_for_health 24; then
      failed=1
    fi
  fi
  return "$failed"
}

deployment_mutated=0
deployment_committed=0
rollback_in_progress=0

rollback_on_exit() {
  local status="$?" rollback_status=0
  trap - EXIT
  if [[ "$status" -ne 0 && "$deployment_mutated" -eq 1 && "$deployment_committed" -eq 0 && "$rollback_in_progress" -eq 0 ]]; then
    rollback_in_progress=1
    echo "Deployment failed; restoring the application and all configured brokers." >&2
    set +e
    rollback
    rollback_status="$?"
    set -e
    if [[ "$rollback_status" -ne 0 ]]; then
      echo "Rollback did not fully recover every component; operator intervention is required." >&2
    fi
  fi
  exit "$status"
}

trap rollback_on_exit EXIT

# 从候选镜像原子提取 broker 制品：容器只创建、绝不启动；失败时显式清理临时容器与 staging。
install_broker_release() {
  local image_id staging release_dir
  image_id="$(docker create video-factory:candidate)"
  staging="$(mktemp -d)"
  if ! docker cp "$image_id:/app/apps/codex-broker" "$staging/broker" >/dev/null; then
    docker rm "$image_id" >/dev/null 2>&1 || true
    rm -rf "$staging"
    return 1
  fi
  docker rm "$image_id" >/dev/null
  release_dir="$broker_root/releases/$(date -u +%Y%m%dT%H%M%SZ)"
  case "$release_dir" in
    "$broker_root/releases/"*) rm -rf "$release_dir" ;;
    *)
      rm -rf "$staging"
      return 1
      ;;
  esac
  if ! mv "$staging/broker" "$release_dir"; then
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
  chown -R vf-codex:vf-bridge "$release_dir"
  chmod -R a+rX "$release_dir"
  ln -sfn "$release_dir" "$broker_root/current"
}

"${compose[@]}" build app

if ! install_broker_release; then
  echo "Failed to extract the codex broker release from the candidate image." >&2
  exit 1
fi
# release 指针已切换；从这里开始失败才需要回滚应用和 broker。
deployment_mutated=1

if ! restart_brokers; then
  systemctl --no-pager --lines=60 status "$broker_service" || true
  if [[ "$zai_broker_enabled" -eq 1 ]]; then
    systemctl --no-pager --lines=60 status "$zai_broker_service" || true
  fi
  exit 1
fi

if ! "${compose[@]}" up --detach --remove-orphans --force-recreate app; then
  exit 1
fi

if ! wait_for_health 36; then
  "${compose[@]}" ps
  "${compose[@]}" logs --tail=160 app
  exit 1
fi

if ! broker_health "$broker_socket"; then
  echo "Codex broker became unhealthy after the app deployment." >&2
  exit 1
fi
if [[ "$zai_broker_enabled" -eq 1 ]] && ! broker_health "$zai_broker_socket"; then
  echo "ZAI visual-review broker became unhealthy after the app deployment." >&2
  exit 1
fi

if [[ -n "$public_health_url" ]] && ! curl --fail --silent --show-error --max-time 15 "$public_health_url" >/dev/null; then
  echo "Public health check failed: $public_health_url" >&2
  exit 1
fi

deployment_committed=1

# 以下仅为可观测性与空间回收，不再把一次健康的发布判为失败。
"${compose[@]}" ps || true
docker image prune --force || true

# 只保留最近 3 个 broker release；当前与回滚目标不动，且仅删除受控前缀下的路径。
current_release="$(readlink "$broker_root/current")"
find "$broker_root/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | tail -n +4 | cut -d' ' -f2- \
  | while read -r stale; do
      case "$stale" in
        "$broker_root/releases/"*) ;;
        *) continue ;;
      esac
      if [[ "$stale" != "$current_release" && "$stale" != "$previous_broker_release" ]]; then
        rm -rf "$stale"
      fi
    done || echo "Broker release cleanup was incomplete; deployment remains healthy." >&2

echo "VideoFactory deployment completed."
