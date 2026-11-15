#!/usr/bin/env bash
# 仅供独占、可销毁 GitHub Ubuntu VM；所有正式资源名仍由原 deploy-frame.sh 管理。
set -Eeuo pipefail
umask 077
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] || {
  printf '%s\n' 'This driver requires an exclusive disposable GitHub-hosted CI VM.' >&2; exit 1;
}
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
: "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${RUNNER_TEMP:?}"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ && "$RUNNER_TEMP" == /* ]]
repo="$(realpath "$(dirname "${BASH_SOURCE[0]}")/..")"
node="$(realpath "${FRAME_CREATIVE_NODE:-$(command -v node)}")"
[[ "$node" == /* && -x "$node" && "$("$node" -p 'process.versions.node.split(".")[0]')" == 22 ]]
if ((EUID != 0)); then
  sudo -n true
  exec sudo -n env CI=true GITHUB_ACTIONS=true RUNNER_ENVIRONMENT=github-hosted \
    GITHUB_SHA="$GITHUB_SHA" GITHUB_RUN_ID="$GITHUB_RUN_ID" GITHUB_RUN_ATTEMPT="$GITHUB_RUN_ATTEMPT" \
    RUNNER_TEMP="$RUNNER_TEMP" FRAME_CREATIVE_NODE="$node" PATH="$PATH" \
    bash "$repo/scripts/smoke-frame-release.sh"
fi
[[ "$(ps -p 1 -o comm=)" == systemd ]]
export RELEASE_SHA="$GITHUB_SHA" FRAME_CREATIVE_NODE="$node"
export PROJECT_PATH=/tmp/frame-release-fixture
export RELEASE_MANIFEST="$repo/frame-release.json"
export PUBLIC_HEALTH_URL=https://frame-ci.example/api/health
export AGENT_UI_ORIGIN=https://frame-ci.example
export FRAME_NGINX_SITE=/etc/nginx/sites-available/frame-release-ci
export FRAME_CREATIVE_SOCKET_DIRECTORY=/var/lib/frame-creative/runtime
export FRAME_CREATIVE_WORKSPACE_ROOT=/var/lib/frame-creative
export FRAME_CREATIVE_DOCKER_SOCKET=/var/run/docker.sock
export FRAME_CREATIVE_USER="$(getent passwd 1001 | cut -d: -f1 || true)"
export FRAME_CREATIVE_GROUP="$(getent group 1001 | cut -d: -f1 || true)"
FRAME_CREATIVE_USER="${FRAME_CREATIVE_USER:-frame-creative}"
FRAME_CREATIVE_GROUP="${FRAME_CREATIVE_GROUP:-frame-creative}"
# Compose 的 shell 环境优先于 env-file；本驱动只允许自己生成的无敏感 fixture。
unset VIDEO_FACTORY_AUTH_USERNAME VIDEO_FACTORY_AUTH_PASSWORD_HASH VIDEO_FACTORY_AUTH_SESSION_SECRET VIDEO_FACTORY_AUTH_SESSION_TTL_SECONDS
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export FRAME_HTTP_PROXY= FRAME_HTTPS_PROXY= FRAME_NO_PROXY=localhost,127.0.0.1,vf-newsnow
old_sha=c1b54c68f3fb7336496d8748d33171c67c062660
container=video_factory_prod
volume=video-factory_video_factory_workspace
alias=frame-creative:pi-1.4-v1
unit=/etc/systemd/system/frame-creative.service
host_script=/opt/frame-creative/creative-runner-host.mjs
maintenance=/etc/nginx/snippets/frame-release-maintenance.conf
health=http://127.0.0.1:4317/api/health
evidence="$RUNNER_TEMP/frame-release-evidence"
[[ ! -e "$evidence" ]]
mkdir -m 700 "$evidence"
exec > >(tee -a "$evidence/driver.log") 2>&1
stage=preflight
proxy_pid=
deploy_runs=()
started="$(date +%s)"
report() {
  python3 -I - "$stage" "$@" <<'PY' | tee -a "$evidence/results.jsonl"
import json,sys,time
row={'stage':sys.argv[1], 'time':int(time.time())}
row.update(item.split('=',1) for item in sys.argv[2:])
print(json.dumps(row,sort_keys=True))
PY
}
collect() {
  local rc=$? run name
  trap - EXIT
  set +e
  for run in "${deploy_runs[@]}"; do
    if [[ -d "/var/backups/video-factory/frame-$run" ]]; then
      cp -a "/var/backups/video-factory/frame-$run" "$evidence/backup-$run"
    fi
    for name in "video_factory_before_${run//-/_}" "video_factory_failed_${run//-/_}"; do
      if docker inspect "$name" >/dev/null 2>&1; then
        docker logs "$name" > "$evidence/$name.log" 2>&1
        docker inspect --format '{{json .Id}} {{json .Image}} {{json .State}} {{json .Mounts}} {{json .Config.Labels}}' "$name" > "$evidence/$name.inspect.txt"
      fi
    done
  done
  docker logs "$container" > "$evidence/final-app.log" 2>&1
  docker inspect --format '{{json .Id}} {{json .Image}} {{json .State}} {{json .Mounts}} {{json .Config.Labels}}' "$container" > "$evidence/final-app.inspect.txt"
  journalctl --no-pager --since "@$started" -u frame-creative.service -u nginx.service > "$evidence/systemd.log" 2>&1
  [[ ! -f /var/log/nginx/access.log ]] || cp /var/log/nginx/access.log "$evidence/nginx-access.log"
  [[ ! -f /var/log/nginx/error.log ]] || cp /var/log/nginx/error.log "$evidence/nginx-error.log"
  systemctl show frame-creative.service --property=ActiveState,UnitFileState,MainPID,ExecStart > "$evidence/final-runner.txt" 2>&1
  [[ -z "$proxy_pid" ]] || kill "$proxy_pid"
  report "status=$([[ $rc == 0 ]] && printf passed || printf failed)" "exitCode=$rc" "evidence=$evidence"
  # upload-artifact 仍由原 runner 执行，私有证据不需要开放给其他用户。
  chown -R --reference="$RUNNER_TEMP" "$evidence"
  exit "$rc"
}
trap collect EXIT
[[ -f "$RELEASE_MANIFEST" && -f "$repo/scripts/deploy-frame.sh" && -f "$repo/scripts/smoke-creative-container.mjs" ]]
[[ ! -e "$PROJECT_PATH" && ! -e "${PROJECT_PATH}.release" && ! -L "${PROJECT_PATH}.release" ]]
[[ ! -e "$FRAME_CREATIVE_WORKSPACE_ROOT" && ! -e /opt/frame-creative && ! -e "$unit" && ! -e "$FRAME_NGINX_SITE" && ! -e "$maintenance" ]]
if systemctl is-active --quiet frame-creative.service \
  || docker inspect "$container" >/dev/null 2>&1 \
  || docker volume inspect "$volume" >/dev/null 2>&1 \
  || docker network inspect video-factory-trends >/dev/null 2>&1 \
  || docker image inspect "$alias" >/dev/null 2>&1; then
  printf '%s\n' 'The fixed release resources must be unused on this disposable VM.' >&2
  exit 1
fi
[[ -z "$(ss -H -ltn 'sport = :4317 or sport = :443')" ]]
docker compose version
docker info --format '{{.OSType}}/{{.Architecture}}'
[[ "$(git -C "$repo" rev-parse "$old_sha^{commit}")" == "$old_sha" ]]
ids="$(python3 -I - "$RELEASE_MANIFEST" "$RELEASE_SHA" <<'PY'
import json,subprocess,sys
m=json.load(open(sys.argv[1])); sha=sys.argv[2]
assert m['sha']==sha and m['platform']=='linux/amd64'
for key,prefix in [('app','video-factory'),('creative','frame-creative')]:
    assert m[key]['tag']==f'{prefix}:release-{sha}'
    i=json.loads(subprocess.check_output(['docker','image','inspect',m[key]['tag']]))[0]
    assert i['Id']==m[key]['id'] and i['Os']+'/'+i['Architecture']=='linux/amd64'
    assert i['Config']['Labels']['org.opencontainers.image.revision']==sha
    print(i['Id'])
PY
)"
mapfile -t candidate_ids <<< "$ids"
[[ ${#candidate_ids[@]} == 2 ]]
app_id="${candidate_ids[0]}"; creative_id="${candidate_ids[1]}"
candidate_schema="$(docker run --rm --read-only --network none --entrypoint node "$app_id" --input-type=module -e '
  import {MIGRATIONS} from "/app/apps/studio/dist/server/server/agent/db.js";
  console.log(MIGRATIONS.at(-1).version);')"
cp "$RELEASE_MANIFEST" "$evidence/release.json"
work="$(mktemp -d /tmp/frame-release-ci.XXXXXX)"
legacy_source="$(mktemp -d /tmp/frame-release-old-source.XXXXXX)"
token="ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$(openssl rand -hex 4)"
run1="$token-s1"; run2="$token-s2"; run3="$token-s3"
exec 9>/var/lock/video-factory-deploy.lock
flock -n 9
report status=passed "candidateSha=$RELEASE_SHA" "oldSourceSha=$old_sha" "appId=$app_id" "creativeId=$creative_id" "serviceUser=$FRAME_CREATIVE_USER" "serviceGroup=$FRAME_CREATIVE_GROUP"

stage=real-linux-fixture
apt-get -o Acquire::Retries=2 update
apt-get install -y --no-install-recommends nginx ca-certificates openssl
mkdir -m 700 "$PROJECT_PATH"
ln -s "$repo" "${PROJECT_PATH}.release"
"$node" - "$PROJECT_PATH/.env.docker.prod" <<'JS'
const fs=require('node:fs'),crypto=require('node:crypto');
const salt=crypto.randomBytes(16);
const hash=`scrypt:v1:${salt.toString('base64url')}:${crypto.scryptSync('synthetic-ci-password',salt,32).toString('base64url')}`;
fs.writeFileSync(process.argv[2],[
  'AGENT_UI_ORIGIN=https://frame-ci.example', 'VIDEO_FACTORY_AUTH_USERNAME=frame-ci',
  `VIDEO_FACTORY_AUTH_PASSWORD_HASH=${hash}`, `VIDEO_FACTORY_AUTH_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
  'FRAME_HTTP_PROXY=', 'FRAME_HTTPS_PROXY=', 'FRAME_NO_PROXY=localhost,127.0.0.1,vf-newsnow', '',
].join('\n'),{mode:0o600});
JS
docker network create video-factory-trends >/dev/null
docker volume create "$volume" >/dev/null
mount="$(docker volume inspect --format '{{.Mountpoint}}' "$volume")"
chown 1001:1001 "$mount"

# 原 SHA 的 archive 不包含当前工作树改动；用它自己的 Dockerfile 独立重建。
git -C "$repo" archive "$old_sha" | tar xf - -C "$legacy_source"
docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$old_sha" \
  -f "$legacy_source/docker/Dockerfile" -t "video-factory:release-$old_sha" "$legacy_source" 2>&1 | tee "$evidence/old-image-build.log"
old_image_id="$(docker image inspect --format '{{.Id}}' "video-factory:release-$old_sha")"
[[ "$old_image_id" != "$app_id" ]]
report status=passed "oldImageId=$old_image_id" "sourceDirectory=$legacy_source" proof=rebuilt-old-source

# TLS、信任和 hosts 只安装在这台一次性 VM；nginx 的每个正常响应都来自真实 app。
cert_dir=/etc/nginx/frame-release-ci
install -d -m 700 "$cert_dir"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=Frame-CI-Temporary-CA \
  -keyout "$work/ca.key" -out "$work/ca.crt" > "$evidence/tls-setup.log" 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj /CN=frame-ci.example \
  -keyout "$cert_dir/server.key" -out "$work/server.csr" >> "$evidence/tls-setup.log" 2>&1
printf '%s\n' 'subjectAltName=DNS:frame-ci.example' 'extendedKeyUsage=serverAuth' 'keyUsage=digitalSignature,keyEncipherment' > "$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$work/server.ext" -out "$cert_dir/server.crt" >> "$evidence/tls-setup.log" 2>&1
install -m 644 "$work/ca.crt" /usr/local/share/ca-certificates/frame-release-ci.crt
update-ca-certificates >> "$evidence/tls-setup.log" 2>&1
if getent hosts frame-ci.example >/dev/null; then
  printf '%s\n' 'frame-ci.example already resolves; refusing to replace this VM fixture.' >&2
  exit 1
fi
printf '\n127.0.0.1 frame-ci.example\n' >> /etc/hosts

python3 -I -u - "$work" "$evidence" "$RELEASE_SHA" "$app_id" "$candidate_schema" <<'PY' > "$evidence/https-proxy.jsonl" 2>&1 &
import http.client,http.server,json,pathlib,subprocess,sys,threading,time,urllib.error,urllib.request
work,evidence=map(pathlib.Path,sys.argv[1:3]); sha,app_id=sys.argv[3:5]
candidate_schema=int(sys.argv[5])
lock=threading.Lock()
hop={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'}
metadata="const D=require('better-sqlite3'),d=new D('/data/factory/agent/agent.db',{readonly:true});console.log(d.prepare('SELECT MAX(version) AS version FROM agent_schema_migrations').get().version);d.close()"
mutate="const f=require('node:fs'),r=process.argv[1];f.writeFileSync('/data/factory/agent/frame-release-ci-sentinel.txt','candidate-'+r+'\\n');f.writeFileSync('/data/factory/agent/frame-release-ci-candidate-only-'+r+'.txt','synthetic candidate file\\n')"
class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args): pass
    def forward(self):
        upstream=None
        try:
            body=self.rfile.read(int(self.headers.get('Content-Length','0')))
            headers={k:v for k,v in self.headers.items() if k.lower() not in hop}
            upstream=http.client.HTTPConnection('127.0.0.1',4317,timeout=30)
            upstream.request(self.command,self.path,body,headers)
            response=upstream.getresponse(); data=response.read(); status=response.status
            marker=work/'fault-armed.json'
            if self.command=='GET' and self.path=='/api/health' and status==200 and marker.exists():
                with lock:
                    if marker.exists():
                        fault=json.loads(marker.read_text()); health=json.loads(data)
                        info=json.loads(subprocess.check_output(['docker','inspect','video_factory_prod'],timeout=10))[0]
                        if info['Id']!=fault['oldContainerId'] and info['State']['Running'] and info['Image']==app_id and (health.get('status'),health.get('product'),health.get('release'))==('ok','frame',sha):
                            schema=int(subprocess.check_output(['docker','exec','video_factory_prod','node','-e',metadata],timeout=15))
                            if schema==candidate_schema:
                                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                                request=urllib.request.Request('https://frame-ci.example/api/auth/login',data=b'{}',headers={'Content-Type':'application/json'},method='POST')
                                try:
                                    with opener.open(request,timeout=10) as check: write_status=check.status
                                except urllib.error.HTTPError as error: write_status=error.code
                                assert write_status==503, f'Write ingress was not isolated: {write_status}'
                                # 只改本驱动刚创建的合成标志；回滚后验证旧字节与新文件清除。
                                subprocess.check_call(['docker','exec','video_factory_prod','node','-e',mutate,fault['run']],timeout=10)
                                observed={**fault,'candidateContainerId':info['Id'],'candidateImageId':info['Image'],'schema':schema,
                                    'upstreamHealth':health,'injectedStatus':503,'maintenanceLoginStatus':write_status,'fixtureMutated':True}
                                target=evidence/(fault['scenario']+'-fault.json')
                                with target.open('x') as output: json.dump(observed,output,sort_keys=True); output.write('\n')
                                marker.unlink()
                                print(json.dumps({'event':'fault','time':time.time(),**observed}),flush=True)
                                self.send_response(503); self.send_header('Content-Length','0'); self.end_headers(); return
            self.send_response(status)
            for key,value in response.getheaders():
                if key.lower() not in hop and key.lower()!='content-length': self.send_header(key,value)
            self.send_header('Content-Length',str(len(data))); self.end_headers()
            if self.command!='HEAD': self.wfile.write(data)
            print(json.dumps({'event':'forward','method':self.command,'path':self.path,'status':status}),flush=True)
        except Exception as error:
            print(json.dumps({'event':'proxy-error','type':type(error).__name__}),flush=True)
            self.close_connection=True
            self.send_error(502,'CI upstream forwarding failed')
        finally:
            if upstream: upstream.close()
    do_GET=do_HEAD=do_OPTIONS=do_POST=do_PUT=do_PATCH=do_DELETE=forward
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy)
server.daemon_threads=True
(work/'proxy-port').write_text(str(server.server_port))
server.serve_forever()
PY
proxy_pid=$!
for ((i=0;i<30;i++)); do [[ ! -s "$work/proxy-port" ]] || break; kill -0 "$proxy_pid"; sleep 1; done
[[ -s "$work/proxy-port" ]]
proxy_port="$(<"$work/proxy-port")"
[[ "$proxy_port" =~ ^[0-9]+$ ]]
cat > "$FRAME_NGINX_SITE" <<NGINX
server {
    listen 443 ssl;
    server_name frame-ci.example;
    ssl_certificate $cert_dir/server.crt;
    ssl_certificate_key $cert_dir/server.key;
    location / {
        proxy_pass http://127.0.0.1:$proxy_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
    }
}
NGINX
chmod 644 "$FRAME_NGINX_SITE"
ln -s "$FRAME_NGINX_SITE" /etc/nginx/sites-enabled/frame-release-ci
cp "$FRAME_NGINX_SITE" "$evidence/original-nginx-site"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

check_health() {
  curl --noproxy '*' -fsS --max-time 10 "$1" | python3 -I -c 'import json,sys; h=json.load(sys.stdin); assert (h.get("status"),h.get("product"),h.get("release"))==("ok","frame",sys.argv[1]); print(json.dumps(h,sort_keys=True))' "$2"
}
schema() {
  docker exec "$container" node -e 'const D=require("better-sqlite3"),d=new D("/data/factory/agent/agent.db",{readonly:true});console.log(d.prepare("SELECT MAX(version) AS version FROM agent_schema_migrations").get().version);d.close()'
}
start_fixture() {
  local sha=$1 source=$2 project=$3 expected=$4 sentinel=$5
  RELEASE_SHA="$sha" docker compose --project-name "$project" --env-file "$PROJECT_PATH/.env.docker.prod" \
    -f "$source/docker/docker-compose.prod.yml" up -d --no-build app
  for ((i=0;i<60;i++)); do if check_health "$health" "$sha" >/dev/null 2>&1; then break; fi; sleep 2; done
  check_health "$health" "$sha"
  check_health "$PUBLIC_HEALTH_URL" "$sha"
  [[ "$(schema)" == "$expected" ]]
  docker exec "$container" node -e 'require("node:fs").writeFileSync("/data/factory/agent/frame-release-ci-sentinel.txt",process.argv[1]+"\n")' "$sentinel"
  docker inspect --format '{{json .Mounts}}' "$container" | python3 -I -c 'import json,sys; assert not any(m["Destination"]=="/run/frame-creative" for m in json.load(sys.stdin))'
  docker exec "$container" node -e 'require("node:assert/strict").equal(process.env.AGENT_CREATIVE_RUNNER_SOCKET,undefined)'
  printf '%s\n' "$sha" > "$PROJECT_PATH/.last-successful-release"
}
arm_fault() {
  python3 -I - "$work/fault-armed.json" "$1" "$2" "$3" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); assert not p.exists()
p.write_text(json.dumps({'scenario':sys.argv[2],'run':sys.argv[3],'oldContainerId':sys.argv[4]}))
PY
}
run_deploy() {
  local scenario=$1 run=$2 expected=$3 statuses rc
  deploy_runs+=("$run")
  report status=running "scenario=$scenario" "deployRun=$run" "command=bash $repo/scripts/deploy-frame.sh"
  set +e
  DEPLOY_RUN="$run" bash "$repo/scripts/deploy-frame.sh" 2>&1 | tee "$evidence/$scenario-deploy.log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  rc="${statuses[0]}"
  printf '%s\n' "$rc" > "$evidence/$scenario-deploy.exit-code"
  [[ "${statuses[1]}" == 0 ]]
  if [[ "$expected" == success ]]; then [[ "$rc" == 0 ]]; else [[ "$rc" != 0 ]]; fi
  report status=observed "scenario=$scenario" "deployExitCode=$rc"
}
full_smoke_passed() {
  python3 -I - "/var/backups/video-factory/frame-$1/creative-smoke.jsonl" "$creative_id" <<'PY'
import json,sys
rows=[json.loads(line) for line in open(sys.argv[1]) if line.strip()]
assert any(r.get('event')=='passed' and r.get('mode')=='full' and r.get('imageId')==sys.argv[2] for r in rows)
print(json.dumps({'event':'full-smoke-verified','imageId':sys.argv[2]}))
PY
}
entry_restored() {
  cmp "$evidence/original-nginx-site" "$FRAME_NGINX_SITE"
  [[ ! -e "$maintenance" ]]
  [[ "$(curl --noproxy '*' -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$AGENT_UI_ORIGIN/api/auth/login")" == 400 ]]
  [[ "$(curl --noproxy '*' -sS --max-time 10 -o /dev/null -w '%{http_code}' "$AGENT_UI_ORIGIN/api/agent/v1/settings/model-connections")" == 401 ]]
}
assert_failed_release() {
  local scenario=$1 run=$2 original_id=$3 expected_schema=$4 sentinel=$5 release=$6
  python3 -I - "$evidence/$scenario-fault.json" "$original_id" "$app_id" "$candidate_schema" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
assert r['oldContainerId']==sys.argv[2] and r['candidateContainerId']!=sys.argv[2] and r['candidateImageId']==sys.argv[3]
assert r['schema']==int(sys.argv[4]) and r['injectedStatus']==503 and r['maintenanceLoginStatus']==503 and r['fixtureMutated'] is True
PY
  [[ ! -e "$work/fault-armed.json" ]]
  [[ "$(docker inspect --format '{{.Id}}' "$container")" == "$original_id" ]]
  [[ "$(schema)" == "$expected_schema" ]]
  docker exec "$container" node -e 'const f=require("node:fs"),a=require("node:assert/strict");a.equal(f.readFileSync("/data/factory/agent/frame-release-ci-sentinel.txt","utf8"),process.argv[1]+"\n");a.equal(f.existsSync("/data/factory/agent/frame-release-ci-candidate-only-"+process.argv[2]+".txt"),false)' "$sentinel" "$run"
  cmp "$evidence/$scenario-success-marker-before" "$PROJECT_PATH/.last-successful-release"
  if docker inspect "video_factory_before_${run//-/_}" >/dev/null 2>&1; then
    printf '%s\n' 'The original container was not renamed back after failure.' >&2
    return 1
  fi
  [[ "$(docker inspect --format '{{.State.Running}}' "video_factory_failed_${run//-/_}")" == false ]]
  python3 -I - "$evidence/$scenario-fault.json" "$(docker inspect --format '{{.Id}}' "video_factory_failed_${run//-/_}")" "/var/backups/video-factory/frame-$run/failed-agent" "$candidate_schema" <<'PY'
import json,pathlib,sqlite3,sys
r=json.load(open(sys.argv[1])); assert r['candidateContainerId']==sys.argv[2]
p=pathlib.Path(sys.argv[3]); assert p.is_dir()
db=sqlite3.connect((p/'agent.db').as_uri()+'?mode=ro',uri=True)
assert db.execute('SELECT MAX(version) FROM agent_schema_migrations').fetchone()[0]==int(sys.argv[4])
db.close()
assert (p/('frame-release-ci-candidate-only-'+r['run']+'.txt')).is_file()
PY
  full_smoke_passed "$run"
  check_health "$health" "$release"
  check_health "$PUBLIC_HEALTH_URL" "$release"
  entry_restored
  report status=passed "scenario=$scenario" "restoredContainerId=$original_id" "restoredSchema=$expected_schema" "candidateObservedSchema=$candidate_schema" failureInjectionCount=1 agentFixture=restored failedCandidate=preserved successMarker=restored
}
image_probe() {
  docker exec -i -e FRAME_CREATIVE_EXPECT_IMAGE="$creative_id" -e FRAME_CREATIVE_SMOKE_ID="$1" \
    -e FRAME_CREATIVE_SMOKE_MODE=image "$container" node --input-type=module < "$repo/scripts/smoke-creative-container.mjs"
}

stage=s1-schema18-no-runner-rollback
old_active="$(systemctl is-active frame-creative.service 2>/dev/null || true)"
old_enabled="$(systemctl is-enabled frame-creative.service 2>/dev/null || true)"
start_fixture "$old_sha" "$legacy_source" "frame-ci-schema18-$token" 18 "$token-schema18"
original1="$(docker inspect --format '{{.Id}}' "$container")"
[[ "$(docker inspect --format '{{.Image}}' "$container")" == "$old_image_id" ]]
cp "$PROJECT_PATH/.last-successful-release" "$evidence/s1-success-marker-before"
report status=ready "originalContainerId=$original1" actualSchema=18 runner=absent alias=absent "sourceSha=$old_sha" "rebuiltImageId=$old_image_id"
arm_fault s1 "$run1" "$original1"
run_deploy s1 "$run1" failure
assert_failed_release s1 "$run1" "$original1" 18 "$token-schema18" "$old_sha"
[[ ! -e "$unit" && ! -e "$host_script" ]]
[[ "$(systemctl is-active frame-creative.service 2>/dev/null || true)" == "$old_active" ]]
[[ "$(systemctl is-enabled frame-creative.service 2>/dev/null || true)" == "$old_enabled" ]]
if docker image inspect "$alias" >/dev/null 2>&1; then
  printf '%s\n' 'The originally absent creative alias was not removed.' >&2
  exit 1
fi
docker logs "$container" > "$evidence/s1-restored-app.log" 2>&1
docker inspect --format '{{json .Id}} {{json .Image}} {{json .State}} {{json .Mounts}} {{json .Config.Labels}}' "$container" > "$evidence/s1-restored-app.inspect.txt"
report status=passed runner=absent alias=absent activeState=restored enabledState=restored proof=old-source-and-schema-compatibility

# S2 重新以空 agent 建立明确基线；S1 的容器和完整恢复数据另存，失败备份不删除。
docker stop --time 45 "$container" >/dev/null
docker rename "$container" "frame_ci_schema18_restored_${token//-/_}"
mv "$mount/agent" "$evidence/s1-restored-agent"
stage=s2-same-sha-add-wiring
baseline_project="frame-${RELEASE_SHA:0:12}-$token-baseline"
start_fixture "$RELEASE_SHA" "$repo" "$baseline_project" "$candidate_schema" "$token-same-sha"
original2="$(docker inspect --format '{{.Id}}' "$container")"
[[ "$(docker inspect --format '{{.Image}}' "$container")" == "$app_id" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" == "$baseline_project" ]]
[[ ! -e "$unit" && ! -e "$host_script" ]]
run_deploy s2 "$run2" success
current2="$(docker inspect --format '{{.Id}}' "$container")"
[[ "$current2" != "$original2" ]]
[[ "$(docker inspect --format '{{.Id}}' "video_factory_before_${run2//-/_}")" == "$original2" ]]
[[ "$(docker inspect --format '{{.State.Running}}' "video_factory_before_${run2//-/_}")" == false ]]
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "video_factory_before_${run2//-/_}")" == "$baseline_project" ]]
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")" == "frame-${RELEASE_SHA:0:12}-$run2" ]]
[[ "$(schema)" == "$candidate_schema" && "$(<"$PROJECT_PATH/.last-successful-release")" == "$RELEASE_SHA" ]]
[[ "$(docker exec "$container" printenv AGENT_CREATIVE_RUNNER_SOCKET)" == /run/frame-creative/runner.sock ]]
docker inspect --format '{{json .Mounts}}' "$container" > "$evidence/s2-app-mounts-before-restart.json"
python3 -I - "$evidence/s2-app-mounts-before-restart.json" "$FRAME_CREATIVE_SOCKET_DIRECTORY" <<'PY'
import json,sys
mounts=[m for m in json.load(open(sys.argv[1])) if m['Destination']=='/run/frame-creative']
assert len(mounts)==1 and mounts[0]['Source']==sys.argv[2] and mounts[0]['RW'] is False
PY
full_smoke_passed "$run2"
entry_restored
report status=passed "originalContainerId=$original2" "candidateContainerId=$current2" "oldComposeProject=$baseline_project" "newComposeProject=frame-${RELEASE_SHA:0:12}-$run2" sameSha=true fullCreativeSmoke=passed

stage=v3-original-app-runner-restart
systemctl restart frame-creative.service
probe_ok=0
for ((i=0;i<30;i++)); do
  if image_probe "$token-restart" > "$evidence/v3-restart-image.jsonl" 2> "$evidence/v3-restart-image.stderr"; then probe_ok=1; break; fi
  sleep 1
done
[[ "$probe_ok" == 1 && "$(docker inspect --format '{{.Id}}' "$container")" == "$current2" ]]
docker inspect --format '{{json .Mounts}}' "$container" > "$evidence/s2-app-mounts-after-restart.json"
python3 -I - "$evidence/s2-app-mounts-before-restart.json" "$evidence/s2-app-mounts-after-restart.json" <<'PY'
import json,sys
before=json.load(open(sys.argv[1])); after=json.load(open(sys.argv[2]))
# Docker不保证Mounts数组顺序；按目标比较完整挂载对象，Source、RW等字段仍须逐项相同。
assert sorted(before,key=lambda m:m['Destination'])==sorted(after,key=lambda m:m['Destination'])
PY
report status=passed "containerId=$current2" "runnerImageId=$creative_id" unchangedAppMounts=true

stage=s3-existing-runner-distinct-alias-rollback
# 别名故意指向另一个已存在的 image；它不会启动，也不作为版本兼容证据。
docker tag "$old_image_id" "$alias"
[[ "$(docker image inspect --format '{{.Id}}' "$alias")" == "$old_image_id" && "$old_image_id" != "$creative_id" ]]
image_probe "$token-before-s3" | tee "$evidence/s3-original-running-image.jsonl"
runner_active="$(systemctl is-active frame-creative.service)"
runner_enabled="$(systemctl is-enabled frame-creative.service)"
[[ "$runner_active" == active && "$runner_enabled" == enabled ]]
cp -a "$unit" "$evidence/s3-original-runner-unit"
cp -a "$host_script" "$evidence/s3-original-runner-script"
cp "$PROJECT_PATH/.last-successful-release" "$evidence/s3-success-marker-before"
docker exec "$container" node -e 'require("node:fs").writeFileSync("/data/factory/agent/frame-release-ci-sentinel.txt",process.argv[1]+"\n")' "$token-existing-runner"
report status=ready "originalContainerId=$current2" "originalRunnerImageId=$creative_id" "originalAliasImageId=$old_image_id" "active=$runner_active" "enabled=$runner_enabled"
arm_fault s3 "$run3" "$current2"
run_deploy s3 "$run3" failure
assert_failed_release s3 "$run3" "$current2" "$candidate_schema" "$token-existing-runner" "$RELEASE_SHA"
cmp "$evidence/s3-original-runner-unit" "$unit"
cmp "$evidence/s3-original-runner-script" "$host_script"
[[ "$(systemctl is-active frame-creative.service)" == "$runner_active" ]]
[[ "$(systemctl is-enabled frame-creative.service)" == "$runner_enabled" ]]
[[ "$(docker image inspect --format '{{.Id}}' "$alias")" == "$old_image_id" ]]
image_probe "$token-after-s3" | tee "$evidence/s3-restored-running-image.jsonl"
report status=passed "restoredRunnerImageId=$creative_id" "restoredAliasImageId=$old_image_id" activeState=restored enabledState=restored originalApp=restored
stage=complete
report status=passed scenarios=3 "candidateSha=$RELEASE_SHA" "oldSourceSha=$old_sha" "appId=$app_id" "creativeId=$creative_id" "evidence=$evidence"
