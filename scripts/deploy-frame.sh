#!/usr/bin/env bash
# CI 验证并运输同一 SHA 的双镜像；仅在外部写入隔离的验收窗口内恢复旧数据。
set -Eeuo pipefail
trap 'printf "Frame release stopped at line %s (exit %s).\n" "$LINENO" "$?" >&2' ERR
umask 077
: "${PROJECT_PATH:?}" "${RELEASE_SHA:?}" "${PUBLIC_HEALTH_URL:?}" "${DEPLOY_RUN:?}" "${RELEASE_MANIFEST:?}"
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ && "$DEPLOY_RUN" =~ ^[A-Za-z0-9_-]+$ ]]
repo="${PROJECT_PATH}.release"
backup="/var/backups/video-factory/frame-$DEPLOY_RUN"
container=video_factory_prod
previous="video_factory_before_${DEPLOY_RUN//-/_}"
failed="video_factory_failed_${DEPLOY_RUN//-/_}"
volume=video-factory_video_factory_workspace
image="video-factory:release-$RELEASE_SHA"
creative="frame-creative:release-$RELEASE_SHA"
alias=frame-creative:pi-1.4-v1
unit=/etc/systemd/system/frame-creative.service
host_script=/opt/frame-creative/creative-runner-host.mjs
maintenance=/etc/nginx/snippets/frame-release-maintenance.conf
health=http://127.0.0.1:4317/api/health
export AGENT_UI_ORIGIN="$(python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); assert p.scheme=="https" and p.hostname and not p.username; print("https://"+p.netloc)' "$PUBLIC_HEALTH_URL")"
hostname="$(python3 -c 'import sys,urllib.parse as u; print(u.urlsplit(sys.argv[1]).hostname)' "$PUBLIC_HEALTH_URL")"
site="${FRAME_NGINX_SITE:-/etc/nginx/sites-available/$hostname}"
node="${FRAME_CREATIVE_NODE:-/usr/local/bin/node}"
workspace_root="${FRAME_CREATIVE_WORKSPACE_ROOT:-/var/lib/frame-creative}"
socket_directory="${FRAME_CREATIVE_SOCKET_DIRECTORY:-/var/lib/frame-creative/runtime}"
docker_socket="${FRAME_CREATIVE_DOCKER_SOCKET:-/var/run/docker.sock}"
service_user="${FRAME_CREATIVE_USER:-frame-creative}"
service_group="${FRAME_CREATIVE_GROUP:-frame-creative}"

# 清单是运输边界：标签、实际 ID、revision 和目标架构在第一次停机前一次核对。
mapfile -t ids < <(python3 - "$RELEASE_MANIFEST" "$RELEASE_SHA" <<'PY'
import json,subprocess,sys
m=json.load(open(sys.argv[1])); sha=sys.argv[2]
assert m['sha']==sha and m['platform']=='linux/amd64'
for key,prefix in [('app','video-factory'),('creative','frame-creative')]:
    assert m[key]['tag']==f'{prefix}:release-{sha}'
    i=json.loads(subprocess.check_output(['docker','image','inspect',m[key]['tag']]))[0]
    assert i['Id']==m[key]['id'] and i['Os']+'/'+i['Architecture']==m['platform']
    assert i['Config']['Labels']['org.opencontainers.image.revision']==sha
    print(i['Id'])
PY
)
[[ ${#ids[@]} == 2 ]]
app_id="${ids[0]}"; creative_id="${ids[1]}"
[[ "$(uname -m)" == x86_64 ]]
[[ -f "$repo/scripts/smoke-creative-container.mjs" && -f "$repo/docker/frame-creative.service" && -f "$site" ]]
[[ ! -e "$PROJECT_PATH/.dogfood-maintenance.json" ]] || { printf '%s\n' 'A separate maintenance window is active; leaving the site unchanged.' >&2; exit 1; }
[[ ! -e "$backup" ]]
! docker inspect "$previous" >/dev/null 2>&1
! docker inspect "$failed" >/dev/null 2>&1
docker network inspect video-factory-trends >/dev/null
mount="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
[[ -d "$mount" && -S "$docker_socket" ]]
command -v nginx >/dev/null
command -v systemctl >/dev/null
[[ "$node" = /* && -x "$node" ]]
[[ "$("$node" -p 'process.versions.node.split(".")[0]')" == 22 ]]

old_active="$(systemctl is-active frame-creative.service 2>/dev/null || true)"
old_enabled="$(systemctl is-enabled frame-creative.service 2>/dev/null || true)"
old_exec="$(systemctl show frame-creative.service --property=ExecStart --value 2>/dev/null || true)"
if [[ -n "$old_exec" ]]; then
  # 沿用原工程真实路径，避免同一工作身份改用另一组卷；未知服务参数不盲接管。
  mapfile -t original_paths < <(python3 - "$old_exec" <<'PY'
import re,sys
for key in ['workspace-root','socket']:
    m=re.search(r'--'+key+r'=([^\s;]+)',sys.argv[1]); assert m, 'Unknown creative service arguments'
    print(m[1])
PY
  )
  [[ ${#original_paths[@]} == 2 ]]
  workspace_root="${FRAME_CREATIVE_WORKSPACE_ROOT:-${original_paths[0]}}"
  socket_directory="${FRAME_CREATIVE_SOCKET_DIRECTORY:-$(dirname "${original_paths[1]}")}"
  [[ "$(realpath -m "$workspace_root")" == "$(realpath -m "${original_paths[0]}")" && "$socket_directory/runner.sock" == "${original_paths[1]}" ]]
fi
runner_pid="$(systemctl show frame-creative.service --property=MainPID --value 2>/dev/null || true)"
while read -r pid; do
  [[ "$pid" == "$runner_pid" ]] || { printf '%s\n' 'An unmanaged creative runner exists; inspect its start/restore commands before switching.' >&2; exit 1; }
done < <(pgrep -f '^(/[^ ]*/node|node) .*/creative-runner-host\.mjs( |$)' || true)

# 数值1001是app与UDS共有身份，不调整无关账号或放宽socket权限。
if getent group 1001 >/dev/null; then [[ "$(getent group 1001 | cut -d: -f1)" == "$service_group" ]]; else groupadd --gid 1001 "$service_group"; fi
if getent passwd 1001 >/dev/null; then
  [[ "$(getent passwd 1001 | cut -d: -f1)" == "$service_user" ]]
else
  ! getent passwd "$service_user" >/dev/null
  useradd --uid 1001 --gid 1001 --home-dir "$workspace_root" --no-create-home --shell /usr/sbin/nologin "$service_user"
fi
docker_gid="$(stat -c %g "$docker_socket")"
docker_group="$(getent group "$docker_gid" | cut -d: -f1)"
[[ -n "$docker_group" ]]
usermod --append --groups "$docker_group" "$service_user"
install -d -m 700 -o 1001 -g 1001 "$workspace_root" "$socket_directory"
workspace_root="$(realpath "$workspace_root")"
socket_directory="$(realpath "$socket_directory")"
namespace="$(python3 -c 'import hashlib,sys; print("frame-creative-"+hashlib.sha256(sys.argv[1].encode()).hexdigest()[:12])' "$workspace_root")"
export FRAME_CREATIVE_SOCKET_DIRECTORY="$socket_directory"
compose=(docker compose --project-name "frame-${RELEASE_SHA:0:12}-${DEPLOY_RUN}" --env-file "$PROJECT_PATH/.env.docker.prod" -f "$repo/docker/docker-compose.prod.yml" -f "$repo/docker/creative.compose.yml")
"${compose[@]}" config --quiet

check_health() {
  curl --noproxy '*' -fsS --max-time 10 "$1" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert (r.get("status"),r.get("product"),r.get("release"))==("ok",sys.argv[1],sys.argv[2])' "$2" "$3"
}
# reload只投递HUP，不能据其退出码认定新worker已接管；入口开关以实际HTTP响应为准。
wait_entry_status() {
  local expected=$1 attempt
  for ((attempt=0;attempt<30;attempt++)); do
    if [[ "$(curl --noproxy '*' -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$AGENT_UI_ORIGIN/api/auth/login")" == "$expected" ]]; then return 0; fi
    sleep 1
  done
  printf 'Frame entry did not reach HTTP %s after nginx reload.\n' "$expected" >&2
  return 1
}
runner_image() {
  docker run --rm --read-only --network none --tmpfs /tmp:rw,mode=1777 \
    --mount "type=bind,src=$socket_directory,dst=/run/frame-creative,readonly" \
    -e AGENT_CREATIVE_RUNNER_SOCKET=/run/frame-creative/runner.sock --entrypoint node "$image" --input-type=module -e '
      import {CreativeRunner} from "/app/apps/studio/dist/server/server/agent/creative-runner.js";
      const r=new CreativeRunner({socketPath:process.env.AGENT_CREATIVE_RUNNER_SOCKET});
      console.log(await r.imageId({conversationId:"release-ready",workId:"release-ready",executionId:"project"}));'
}
queue_check='const D=require("better-sqlite3"),d=new D(process.argv[1] ?? "/data/factory/agent/agent.db",{readonly:true});if(d.prepare("SELECT 1 FROM requests WHERE state IN (\x27queued\x27,\x27running\x27) LIMIT 1").get()||d.prepare("SELECT 1 FROM production_runs WHERE state IN (\x27queued\x27,\x27running\x27,\x27cancel_requested\x27) LIMIT 1").get()){console.error("Active Frame work; deploy after it finishes.");process.exit(1)}'
old_container="$(docker inspect --format '{{.Id}}' "$container")"
old_image="$(docker inspect --format '{{.Image}}' "$container")"
old_product="$(curl --noproxy '*' -fsS --max-time 10 "$health" | python3 -c 'import json,sys; r=json.load(sys.stdin); assert r["status"]=="ok"; print(r["product"])')"
old_release="$(curl --noproxy '*' -fsS --max-time 10 "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["release"])')"
old_write_status="$(curl --noproxy '*' -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST "$AGENT_UI_ORIGIN/api/auth/login")"
[[ "$old_product" == frame ]]
old_alias="$(docker image inspect --format '{{.Id}}' "$alias" 2>/dev/null || true)"
old_runner=''
if [[ "$old_active" == active ]]; then old_runner="$(runner_image)"; [[ "$old_runner" =~ ^sha256:[a-f0-9]{64}$ ]]; fi

docker volume ls --format '{{.Name}}' --filter "name=$namespace-" | sort > /dev/null
mkdir -m 700 -p "$backup"
cp "$RELEASE_MANIFEST" "$backup/release.json"
cp -a "$site" "$backup/nginx-site"
[[ ! -e "$maintenance" ]] || cp -a "$maintenance" "$backup/nginx-maintenance"
[[ ! -e "$unit" ]] || cp -a "$unit" "$backup/runner-unit"
[[ ! -e "$host_script" ]] || cp -a "$host_script" "$backup/runner-script"
[[ ! -e "$PROJECT_PATH/.last-successful-release" ]] || cp -a "$PROJECT_PATH/.last-successful-release" "$backup/success-marker"
docker volume ls --format '{{.Name}}' --filter "name=$namespace-" | sort > "$backup/original-creative-volumes.txt"
printf '%s\n' "old_container=$old_container" "old_image=$old_image" "old_release=$old_release" "old_runner=$old_runner" "old_alias=$old_alias" "old_active=$old_active" "old_enabled=$old_enabled" "old_write_status=$old_write_status" "workspace_root=$workspace_root" "namespace=$namespace" > "$backup/original-state.txt"
entry_changed=0; stopped=0; renamed=0; backed_up=0; runner_stopped=0; runner_changed=0; candidate_started=0; committed=0
restore_entry() {
  cp -a "$backup/nginx-site" "$site"
  if [[ -e "$backup/nginx-maintenance" ]]; then cp -a "$backup/nginx-maintenance" "$maintenance"; else rm -f "$maintenance"; fi
  nginx -t
  systemctl reload nginx
  wait_entry_status "$old_write_status"
}
record_probe_volumes() {
  [[ -e "$backup/before-probe-volumes.txt" ]] || return 0
  docker volume ls --format '{{.Name}}' --filter "name=$namespace-" | sort > "$backup/after-probe-volumes.txt"
  comm -13 "$backup/before-probe-volumes.txt" "$backup/after-probe-volumes.txt" > "$backup/probe-volumes.txt"
}
clean_probe_volumes() {
  [[ -e "$backup/probe-volumes.txt" ]] || return 0
  while IFS= read -r probe_volume; do [[ -z "$probe_volume" ]] || docker volume rm "$probe_volume"; done < "$backup/probe-volumes.txt"
}
restore() {
  local rc=$?
  trap - EXIT
  ((rc != 0)) || return 0
  if ((committed)); then
    printf 'Release committed; entry restoration failed. Keep new data and repair the entry. Backup: %s\n' "$backup" >&2
    exit "$rc"
  fi
  # 恢复步骤任一失败就保留受控入口；不能吞掉错误后声称restored。
  set +e
  (
    set -e
    if ((candidate_started)) && docker inspect "$container" >/dev/null 2>&1; then
      docker stop --time 45 "$container" >/dev/null
      docker rename "$container" "$failed"
    fi
    if ((runner_changed)); then systemctl stop frame-creative.service; fi
    if ((backed_up && candidate_started)); then
      if [[ -d "$mount/agent" ]]; then mv "$mount/agent" "$backup/failed-agent"; fi
      if [[ -e "$backup/had-agent" ]]; then tar xzf "$backup/workspace.tar.gz" -C "$mount" ./agent; fi
    fi
    if ((runner_changed)); then
      if [[ -e "$backup/runner-script" ]]; then cp -a "$backup/runner-script" "$host_script"; else rm -f "$host_script"; fi
      if [[ -e "$backup/runner-unit" ]]; then cp -a "$backup/runner-unit" "$unit"; else rm -f "$unit"; fi
      systemctl daemon-reload
    fi
    if ((runner_changed || runner_stopped)); then
      if [[ "$old_active" == active ]]; then
        docker tag "$old_runner" "$alias"
        systemctl start frame-creative.service
        for ((i=0;i<30;i++)); do if [[ "$(runner_image 2>/dev/null || true)" == "$old_runner" ]]; then break; fi; sleep 1; done
        [[ "$(runner_image)" == "$old_runner" ]]
      fi
      if [[ -n "$old_alias" ]]; then docker tag "$old_alias" "$alias"; else docker image rm "$alias" >/dev/null; fi
      if [[ "$old_enabled" == enabled ]]; then systemctl enable frame-creative.service >/dev/null; else systemctl disable frame-creative.service >/dev/null 2>&1 || [[ ! -e "$unit" ]]; fi
      if [[ "$old_active" != active ]]; then ! systemctl is-active --quiet frame-creative.service; fi
    fi
    if ((renamed)); then docker rename "$previous" "$container"; fi
    if ((stopped)); then docker start "$container" >/dev/null; fi
    for ((i=0;i<45;i++)); do if check_health "$health" "$old_product" "$old_release" 2>/dev/null; then break; fi; sleep 2; done
    check_health "$health" "$old_product" "$old_release"
    check_health "$PUBLIC_HEALTH_URL" "$old_product" "$old_release"
    [[ "$(docker inspect --format '{{.Id}}' "$container")" == "$old_container" ]]
    if [[ -e "$backup/success-marker" ]]; then cp -a "$backup/success-marker" "$PROJECT_PATH/.last-successful-release"; else rm -f "$PROJECT_PATH/.last-successful-release"; fi
    record_probe_volumes
    clean_probe_volumes
    if ((entry_changed)); then restore_entry; fi
  )
  local restored=$?
  if ((restored == 0)); then printf 'Release failed; original app, data, runner and entry restored. Backup: %s\n' "$backup" >&2
  else printf 'Release and restoration failed; keep the entry restricted and inspect backup: %s\n' "$backup" >&2; fi
  exit "$rc"
}
trap restore EXIT

# 第一次入口修改前已安装trap；只作用于本站location，保留真实GET健康与SSE。
entry_changed=1
install -m 600 "$repo/docker/frame-maintenance.nginx.conf" "$maintenance"
python3 - "$site" "$maintenance" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); text=p.read_text(); include='include '+sys.argv[2]+';'
if include not in text:
    text,n=re.subn(r'(location\s+/\s*\{)',lambda m:m[1]+'\n        '+include,text,count=1)
    assert n==1, 'Frame location not found'
    p.write_text(text)
PY
nginx -t
systemctl reload nginx
wait_entry_status 503
docker exec "$container" node -e "$queue_check"
stopped=1
docker stop --time 45 "$container" >/dev/null
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$container")" == 0 ]]
# 只读WAL库在辅助文件已删除时也需重建索引；停机后复制db与可能的WAL到私有tmpfs，原卷仍只读。
docker run --rm --read-only --network none --tmpfs /tmp:rw,mode=1777 --mount "type=volume,src=$volume,dst=/data/factory,readonly" --entrypoint node "$old_image" -e '
  const fs=require("node:fs"),path=require("node:path"),scratch=fs.mkdtempSync("/tmp/frame-queue-");
  for (const name of ["agent.db","agent.db-wal"]) {
    const source=path.join("/data/factory/agent",name);
    if (name==="agent.db" || fs.existsSync(source)) fs.copyFileSync(source,path.join(scratch,name));
  }
  process.argv[1]=path.join(scratch,"agent.db");
'"$queue_check"
docker rename "$container" "$previous"; renamed=1
if [[ "$old_active" == active ]]; then runner_stopped=1; systemctl stop frame-creative.service; fi
[[ ! -d "$mount/agent" ]] || touch "$backup/had-agent"
tar czf "$backup/workspace.tar.gz" -C "$mount" .
gzip -t "$backup/workspace.tar.gz"
tar tzf "$backup/workspace.tar.gz" > "$backup/workspace-files.txt"
backed_up=1
# 写入口已隔离、队列已空，本轮仅新探针work写创作卷；原卷清单保留，不复制无关用户工程。
runner_changed=1
install -d -m 755 /opt/frame-creative
install -m 644 "$repo/scripts/creative-runner-host.mjs" "$host_script"
python3 - "$repo/docker/frame-creative.service" "$unit" "$node" "$socket_directory" "$workspace_root" "$docker_socket" "$docker_group" "$(dirname "$(command -v docker)")" "$service_user" "$service_group" <<'PY'
import pathlib,sys
text=pathlib.Path(sys.argv[1]).read_text()
for key,value in zip(['NODE','SOCKET_DIRECTORY','WORKSPACE_ROOT','DOCKER_SOCKET','DOCKER_GROUP','DOCKER_PATH','USER','GROUP'],sys.argv[3:]):
    assert '\n' not in value and ' ' not in value
    text=text.replace('@'+key+'@',value)
pathlib.Path(sys.argv[2]).write_text(text)
PY
chmod 644 "$unit"
systemctl daemon-reload
docker tag "$creative_id" "$alias"
systemctl enable --now frame-creative.service
for ((i=0;i<30;i++)); do if [[ "$(runner_image 2>/dev/null || true)" == "$creative_id" ]]; then break; fi; sleep 1; done
[[ "$(runner_image)" == "$creative_id" ]]
[[ "$(stat -c '%u:%g:%a' "$socket_directory/runner.sock")" == 1001:1001:600 ]]
[[ "$(stat -c '%u:%g:%a' "$socket_directory")" == 1001:1001:700 ]]
candidate_started=1
"${compose[@]}" up -d --no-build app
for ((i=0;i<45;i++)); do if check_health "$health" frame "$RELEASE_SHA" 2>/dev/null; then break; fi; sleep 2; done
check_health "$health" frame "$RELEASE_SHA"
[[ "$(docker inspect --format '{{.Image}}' "$container")" == "$app_id" ]]
[[ "$(docker exec "$container" id -u)" == 1001 ]]
[[ "$(docker exec "$container" printenv AGENT_CREATIVE_RUNNER_SOCKET)" == /run/frame-creative/runner.sock ]]
docker inspect --format '{{json .Mounts}}' "$container" | python3 -c 'import json,sys; m=[x for x in json.load(sys.stdin) if x["Destination"]=="/run/frame-creative"]; assert len(m)==1 and m[0]["Source"]==sys.argv[1] and not m[0]["RW"]' "$socket_directory"
# 迁移定义随候选镜像发布；不在部署脚本维护第二份版本号。
schema="$(docker exec "$container" node --input-type=module -e '
  import Database from "better-sqlite3";
  import {MIGRATIONS} from "/app/apps/studio/dist/server/server/agent/db.js";
  const db=new Database("/data/factory/agent/agent.db",{readonly:true});
  const version=db.prepare("SELECT MAX(version) AS version FROM agent_schema_migrations").get().version;
  db.close();
  if(version!==MIGRATIONS.at(-1).version)throw new Error("Database migration does not match the release");
  console.log(version);')"

# 正式app的原socket配置，执行编译后的CreativeRunner；不启动第二个main、不写正式会话库。
docker volume ls --format '{{.Name}}' --filter "name=$namespace-" | sort > "$backup/before-probe-volumes.txt"
docker exec -i -e FRAME_CREATIVE_EXPECT_IMAGE="$creative_id" -e FRAME_CREATIVE_SMOKE_ID="release-$DEPLOY_RUN" "$container" node --input-type=module < "$repo/scripts/smoke-creative-container.mjs" | tee "$backup/creative-smoke.jsonl"
record_probe_volumes
check_health "$PUBLIC_HEALTH_URL" frame "$RELEASE_SHA"
[[ "$(curl --noproxy '*' -sS --max-time 10 -o /dev/null -w '%{http_code}' "$AGENT_UI_ORIGIN/api/agent/v1/settings/model-connections")" == 401 ]]
curl --noproxy '*' -fsS --max-time 10 "$AGENT_UI_ORIGIN/agent" | grep -q '帧间 Frame'
cmp "$repo/scripts/creative-runner-host.mjs" "$host_script"
[[ "$(runner_image)" == "$creative_id" ]]
clean_probe_volumes
printf '%s\n' "$RELEASE_SHA" > "$PROJECT_PATH/.last-successful-release.partial"
mv "$PROJECT_PATH/.last-successful-release.partial" "$PROJECT_PATH/.last-successful-release"
committed=1
restore_entry
trap - EXIT
printf 'Frame %s verified with app=%s creative=%s; schema=%s; backup=%s; previous=%s.\n' "$RELEASE_SHA" "$app_id" "$creative_id" "$schema" "$backup" "$previous"
