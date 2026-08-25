#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${VIDEO_FACTORY_ENV_FILE:-$repository_root/.env.docker.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
container="video_factory_prod"
compose=(docker compose --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")

if [[ ! -f "$environment_file" ]]; then
  echo "Missing production environment file: $environment_file" >&2
  exit 1
fi

previous_image="$(docker inspect --format='{{.Image}}' "$container" 2>/dev/null || true)"
if [[ -n "$previous_image" ]]; then
  docker tag "$previous_image" video-factory:rollback
  "$repository_root/scripts/backup-production.sh"
fi

rollback() {
  if [[ -z "$previous_image" ]] || ! docker image inspect video-factory:rollback >/dev/null 2>&1; then
    echo "No previous VideoFactory image is available for rollback." >&2
    return 1
  fi
  echo "Restoring the previous VideoFactory image."
  docker tag video-factory:rollback video-factory:candidate
  "${compose[@]}" up --detach --no-deps --force-recreate app
  wait_for_health 24
}

wait_for_health() {
  local attempts="$1"
  local count
  for count in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4317/api/health >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

"${compose[@]}" build app
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

if [[ -n "$public_health_url" ]] && ! curl --fail --silent --show-error --max-time 15 "$public_health_url" >/dev/null; then
  echo "Public health check failed: $public_health_url" >&2
  rollback || true
  exit 1
fi

"${compose[@]}" ps
docker image prune --force
echo "VideoFactory deployment completed."
