#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${VIDEO_FACTORY_ENV_FILE:-$repository_root/.env.docker.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
container="video_factory_prod"
broker_service=vf-codex-broker
broker_root=/opt/video-factory/codex-broker
broker_socket=/run/video-factory-codex/worker.sock
compose=(docker compose --project-name video-factory --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")

if [[ ! -f "$environment_file" ]]; then
  echo "Missing production environment file: $environment_file" >&2
  exit 1
fi

bridge_gid="$(getent group vf-bridge | cut -d: -f3 || true)"
if [[ -z "$bridge_gid" ]]; then
  echo "Host is not initialized. Run scripts/setup-codex-broker-host.sh first." >&2
  exit 1
fi
# compose 变量插值中 shell 环境优先于 env-file：此导出以宿主机实际组为准，
# 覆盖 env-file 里可能残留的旧值；不解析、也不改写任何含密文件。
export VIDEO_FACTORY_CODEX_SOCKET_GID="$bridge_gid"

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
  curl --fail --silent --max-time 5 --unix-socket "$broker_socket" http://localhost/health >/dev/null
}

wait_for_broker_health() {
  local attempts="$1" count
  for count in $(seq 1 "$attempts"); do
    if broker_health; then
      return 0
    fi
    sleep 2
  done
  return 1
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
  ln -sfn "$previous_broker_release" "$broker_root/current"
  systemctl restart "$broker_service"
  wait_for_broker_health 20
}

rollback() {
  local failed=0
  if [[ -z "$previous_image" ]] || ! docker image inspect video-factory:rollback >/dev/null 2>&1; then
    echo "No previous VideoFactory image is available for rollback." >&2
    failed=1
  else
    echo "Restoring the previous VideoFactory image."
    docker tag video-factory:rollback video-factory:candidate
    if ! "${compose[@]}" up --detach --no-deps --force-recreate app || ! wait_for_health 24; then
      failed=1
    fi
  fi
  rollback_broker || failed=1
  return "$failed"
}

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
  rollback_broker || true
  exit 1
fi

systemctl restart "$broker_service"
if ! wait_for_broker_health 20; then
  systemctl --no-pager --lines=60 status "$broker_service" || true
  rollback_broker || true
  exit 1
fi

if ! "${compose[@]}" up --detach --remove-orphans --force-recreate app; then
  rollback || true
  exit 1
fi

if ! wait_for_health 36; then
  "${compose[@]}" ps
  "${compose[@]}" logs --tail=160 app
  rollback || true
  exit 1
fi

if ! broker_health; then
  echo "Codex broker became unhealthy after the app deployment." >&2
  rollback || true
  exit 1
fi

if [[ -n "$public_health_url" ]] && ! curl --fail --silent --show-error --max-time 15 "$public_health_url" >/dev/null; then
  echo "Public health check failed: $public_health_url" >&2
  rollback || true
  exit 1
fi

"${compose[@]}" ps
docker image prune --force

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
    done

echo "VideoFactory deployment completed."
