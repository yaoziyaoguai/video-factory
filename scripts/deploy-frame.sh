#!/usr/bin/env bash
# CI 已对同一镜像运行正式入口。保留原容器，换版失败可用原镜像和挂载恢复。
set -Eeuo pipefail
umask 077
: "${PROJECT_PATH:?}" "${RELEASE_SHA:?}" "${PUBLIC_HEALTH_URL:?}" "${DEPLOY_RUN:?}"
repo="${PROJECT_PATH}.release"
backup="/var/backups/video-factory/frame-$DEPLOY_RUN"
container=video_factory_prod
previous="video_factory_before_${DEPLOY_RUN//-/_}"
volume=video-factory_video_factory_workspace
image="video-factory:release-$RELEASE_SHA"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$RELEASE_SHA"
export AGENT_UI_ORIGIN="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); assert p.hostname; print("https://"+p.netloc)' "$PUBLIC_HEALTH_URL")"
compose=(docker compose --project-name "frame-${RELEASE_SHA:0:12}" --env-file "$PROJECT_PATH/.env.docker.prod" -f "$repo/docker/docker-compose.prod.yml")
"${compose[@]}" config --quiet
docker network inspect video-factory-trends >/dev/null
mount="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
test -d "$mount"
if [[ -f "$PROJECT_PATH/.dogfood-maintenance.json" ]]; then echo "A separate maintenance window is active; leaving the site unchanged." >&2; exit 1; fi

health=http://127.0.0.1:4317/api/health
expected_release() {
  curl -fsS --max-time 8 "$1" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert (r.get("status"),r.get("product"),r.get("release"))==("ok","frame",sys.argv[1])' "$RELEASE_SHA"
}
if docker inspect "$container" >/dev/null 2>&1; then
  product="$(curl -fsS --max-time 5 "$health" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok"; print(r.get("product","legacy"))')"
  if [[ "$product" == frame ]]; then
    if expected_release "$health" 2>/dev/null; then expected_release "$PUBLIC_HEALTH_URL"; exit 0; fi
    docker exec "$container" node -e 'const D=require("better-sqlite3"),d=new D("/data/factory/agent/agent.db",{readonly:true});if(d.prepare("SELECT 1 FROM requests WHERE state IN (\x27queued\x27,\x27running\x27) LIMIT 1").get()||d.prepare("SELECT 1 FROM production_runs WHERE state IN (\x27queued\x27,\x27running\x27,\x27cancel_requested\x27) LIMIT 1").get()){console.error("Active Frame work; deploy after it finishes.");process.exit(1)}'
  else
    curl -fsS "$health" | python3 -c 'import json,sys; m=json.load(sys.stdin)["maintenance"]; assert m["quiescent"] and m["integrity"]["complete"]'
  fi
fi

mkdir -m 700 -p "$backup"
stopped=0; renamed=0; switched=0; broker_stopped=0
restore() {
  local rc=$?
  trap - EXIT
  if ((rc == 0)); then return; fi
  set -e
  if ((switched)); then
    if docker inspect "$container" >/dev/null 2>&1; then docker rm -f "$container" >/dev/null; fi
    # 新版可能已迁移 SQLite；保留失败现场，旧容器只重开升级前的数据。
    if [[ -d "$mount/agent" ]]; then mv "$mount/agent" "$backup/failed-agent"; fi
    if [[ -e "$backup/had-agent" ]]; then tar xzf "$backup/workspace.tar.gz" -C "$mount" ./agent; fi
  fi
  if ((renamed)); then docker rename "$previous" "$container"; fi
  if ((broker_stopped)); then systemctl start vf-deepseek-codex-broker; fi
  if ((stopped)); then docker start "$container" >/dev/null; fi
  echo "Release failed; previous service restored. Backup: $backup" >&2
  exit "$rc"
}
trap restore EXIT
if [[ "${product:-}" == legacy ]] && systemctl is-active --quiet vf-deepseek-codex-broker; then
  curl --unix-socket /run/video-factory-deepseek-codex/worker.sock -fsS http://localhost/health | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["maintenance"]["quiescent"] and not r["active"] and not r["queued"]'
  systemctl stop vf-deepseek-codex-broker; broker_stopped=1
fi
if [[ -n "${product:-}" ]]; then
  docker stop --time 45 "$container" >/dev/null; stopped=1
  docker rename "$container" "$previous"; renamed=1
fi
[[ ! -d "$mount/agent" ]] || touch "$backup/had-agent"
tar czf "$backup/workspace.tar.gz" -C "$mount" .
gzip -t "$backup/workspace.tar.gz"
switched=1
"${compose[@]}" up -d --no-build app
for ((i=0;i<45;i++)); do if expected_release "$health" 2>/dev/null; then break; fi; sleep 2; done
expected_release "$health"; expected_release "$PUBLIC_HEALTH_URL"
test "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$AGENT_UI_ORIGIN/api/agent/v1/settings/model-connections")" = 401
curl -fsS --max-time 10 "$AGENT_UI_ORIGIN/agent" | grep -q '帧间 Frame'
if ((broker_stopped)); then systemctl disable vf-deepseek-codex-broker >/dev/null; fi
printf '%s\n' "$RELEASE_SHA" > "$PROJECT_PATH/.last-successful-release.partial"
mv "$PROJECT_PATH/.last-successful-release.partial" "$PROJECT_PATH/.last-successful-release"
echo "Frame $RELEASE_SHA verified locally and publicly; backup: $backup; previous container: $previous."
