#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${VIDEO_FACTORY_ENV_FILE:-$repository_root/.env.docker.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
release_sha="${RELEASE_SHA:-}"
deployment_mode="${VIDEO_FACTORY_DEPLOYMENT_MODE:-release}"
container="video_factory_prod"
broker_service=vf-codex-broker
broker_unit=/etc/systemd/system/vf-codex-broker.service
zai_broker_service=vf-zai-codex-broker
zai_broker_unit=/etc/systemd/system/vf-zai-codex-broker.service
broker_root=/opt/video-factory/codex-broker
broker_user=vf-codex
broker_socket=/run/video-factory-codex/worker.sock
zai_broker_user=vf-zai-codex
zai_broker_state_root=/var/lib/video-factory-zai-codex
zai_broker_workspace="$zai_broker_state_root/workspace"
trend_network=video-factory-trends
compose=(docker compose --project-name video-factory --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")
# ECS 在中国大陆构建镜像时使用阿里云 Alpine 源；CI 直接 docker build 时保留全球官方源。
export ALPINE_MIRROR="${ALPINE_MIRROR:-http://mirrors.cloud.aliyuncs.com/alpine}"
zai_broker_enabled=0
if systemctl cat "$zai_broker_service" >/dev/null 2>&1 && [[ -s /etc/video-factory/zai-codex-broker.env ]]; then
  zai_broker_enabled=1
fi
zai_broker_configured="$zai_broker_enabled"

if [[ ! -f "$environment_file" ]]; then
  echo "Missing production environment file: $environment_file" >&2
  exit 1
fi

if [[ "$deployment_mode" == "release" ]]; then
  if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Production releases require the exact 40-character RELEASE_SHA supplied by GitHub Actions." >&2
    exit 1
  fi
  repository_sha="$(git -C "$repository_root" rev-parse HEAD)"
  if [[ "$repository_sha" != "$release_sha" ]]; then
    echo "Release checkout mismatch: expected $release_sha, found $repository_sha." >&2
    exit 1
  fi
  if ! repository_status="$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)"; then
    echo "Unable to verify release checkout cleanliness; refusing to build." >&2
    exit 1
  fi
  if [[ -n "$repository_status" ]]; then
    echo "Release checkout is not clean; refusing to build from mixed or untracked files." >&2
    printf '%s\n' "$repository_status" >&2
    exit 1
  fi
elif [[ "$deployment_mode" != "bootstrap" ]]; then
  echo "VIDEO_FACTORY_DEPLOYMENT_MODE must be 'release' or 'bootstrap'." >&2
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

ensure_zai_workspace() {
  local target
  for target in "$zai_broker_state_root" "$zai_broker_workspace"; do
    if [[ -L "$target" || -e "$target" && ! -d "$target" ]]; then
      echo "Refusing unsafe ZAI broker workspace path: $target" >&2
      return 1
    fi
  done
  install -d -o "$zai_broker_user" -g vf-bridge -m 0750 \
    "$zai_broker_state_root" "$zai_broker_workspace" || return 1
  for target in "$zai_broker_state_root" "$zai_broker_workspace"; do
    if [[ "$(stat -c %U:%G "$target")" != "$zai_broker_user:vf-bridge" \
      || "$(stat -c %a "$target")" != 750 ]]; then
      echo "ZAI broker workspace has unsafe ownership or mode: $target" >&2
      return 1
    fi
  done
  runuser -u "$zai_broker_user" -- test -w "$zai_broker_workspace"
}

check_codex_upstream() {
  local attempt
  for attempt in 1 2 3; do
    # ChatGPT 登录态只能证明凭据存在；401 也能证明 OpenAI TLS 出口真实可达。
    if runuser -u "$broker_user" -- curl --silent --show-error --output /dev/null \
      --connect-timeout 8 --max-time 15 https://api.openai.com/v1/models; then
      return 0
    fi
    sleep 3
  done
  echo "Codex upstream is unreachable from $broker_user; leaving the current production release untouched." >&2
  return 1
}

check_zai_upstream() {
  # 两个官方 models 端点都只读取目录，不提交 prompt、不创建模型任务，也不会
  # 产生内容生成费用；要求 200 可同时验证 TLS、API key 与普通/Code Plan 两条路由。
  "$broker_root/bin/node" --env-file=/etc/video-factory/zai-codex-broker.env --input-type=module --eval '
    const urls = [
      "https://open.bigmodel.cn/api/paas/v4/models",
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
    ];
    const key = process.env.ZAI_BIGMODEL_API_KEY?.trim();
    if (!key) process.exit(2);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      for (const url of urls) {
        const response = await fetch(url, {
          method: "GET",
          headers: { authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        await response.body?.cancel();
        if (response.status !== 200) process.exit(3);
      }
    } finally {
      clearTimeout(timeout);
    }
  '
}

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
else
  ensure_zai_workspace || exit 1
  check_zai_upstream || {
    echo "ZAI upstream readiness check failed; leaving the current production release untouched." >&2
    exit 1
  }
fi
check_codex_upstream || exit 1

# 应用与自托管热点容器只经内部网络通信；没有部署热点时保留空网络，应用会如实报告离线。
docker network inspect "$trend_network" >/dev/null 2>&1 \
  || docker network create --driver bridge "$trend_network" >/dev/null

# 不做“排空运行中制作”的等待：/api/runs 受登录会话保护，本脚本不持有凭据，
# 为部署开免认证端点会削弱认证边界。被中断的 run 由 recoverInterruptedRuns
# 显式标记失败（“应用重启中断了这次制作”），不会伪装成成功。

previous_image="$(docker inspect --format='{{.Image}}' "$container" 2>/dev/null || true)"
if [[ -n "$previous_image" ]]; then
  docker tag "$previous_image" video-factory:rollback
  "$repository_root/scripts/backup-production.sh"
fi

previous_broker_release="$(readlink "$broker_root/current" 2>/dev/null || true)"
previous_broker_unit_backup="$(mktemp)"
previous_zai_broker_unit_backup="$(mktemp)"
candidate_broker_release=""
if [[ -f "$broker_unit" ]]; then
  cp -a "$broker_unit" "$previous_broker_unit_backup"
fi
if [[ -f "$zai_broker_unit" ]]; then
  cp -a "$zai_broker_unit" "$previous_zai_broker_unit_backup"
fi

app_health() {
  local url="$1" timeout_seconds="${2:-5}" health_json
  health_json="$(curl --fail --silent --show-error --max-time "$timeout_seconds" "$url")" || return 1
  APP_HEALTH_JSON="$health_json" "$broker_root/bin/node" --eval '
    try {
      const health = JSON.parse(process.env.APP_HEALTH_JSON ?? "");
      process.exit(health?.status === "ok" ? 0 : 1);
    } catch {
      process.exit(1);
    }
  '
}

wait_for_health() {
  local attempts="$1" count
  for count in $(seq 1 "$attempts"); do
    if app_health http://127.0.0.1:4317/api/health; then
      return 0
    fi
    sleep 5
  done
  return 1
}

broker_health() {
  local socket="$1" expected_profile="$2" expected_provider="$3" expected_kinds="$4" allow_extra_kinds="${5:-0}" health_json
  health_json="$(curl --fail --silent --max-time 5 --unix-socket "$socket" http://localhost/health)" || return 1
  BROKER_HEALTH_JSON="$health_json" \
    EXPECTED_BROKER_PROFILE="$expected_profile" \
    EXPECTED_BROKER_PROVIDER="$expected_provider" \
    EXPECTED_BROKER_KINDS="$expected_kinds" \
    EXPECTED_BROKER_ALLOW_EXTRA_KINDS="$allow_extra_kinds" \
    "$broker_root/bin/node" --eval '
      try {
        const health = JSON.parse(process.env.BROKER_HEALTH_JSON ?? "");
        const expectedKinds = (process.env.EXPECTED_BROKER_KINDS ?? "").split(",").filter(Boolean);
        const actualKinds = Array.isArray(health.taskKinds) ? health.taskKinds : [];
        const allowExtraKinds = process.env.EXPECTED_BROKER_ALLOW_EXTRA_KINDS === "1";
        const taskModels = health.taskModels;
        const identityMatches = health.protocolVersion === "video-factory/codex-bridge-v2"
          && health.profileId === process.env.EXPECTED_BROKER_PROFILE
          && health.providerId === process.env.EXPECTED_BROKER_PROVIDER
          && typeof health.modelId === "string" && health.modelId.length > 0;
        const kindsMatch = expectedKinds.every((kind) => actualKinds.includes(kind))
          && (allowExtraKinds || expectedKinds.length === actualKinds.length);
        const modelsMatch = taskModels && typeof taskModels === "object" && !Array.isArray(taskModels)
          && expectedKinds.every((kind) => typeof taskModels[kind] === "string" && taskModels[kind].length > 0);
        const zaiModelsMatch = process.env.EXPECTED_BROKER_PROFILE !== "zai"
          || taskModels["director-plan"] === health.modelId
            && taskModels["script-draft"] === health.modelId;
        process.exit(identityMatches && kindsMatch && modelsMatch && zaiModelsMatch ? 0 : 1);
      } catch {
        process.exit(1);
      }
    '
}

wait_for_broker_health() {
  local socket="$1" attempts="$2" expected_profile="$3" expected_provider="$4" expected_kinds="$5" allow_extra_kinds="${6:-0}" count
  for count in $(seq 1 "$attempts"); do
    if broker_health "$socket" "$expected_profile" "$expected_provider" "$expected_kinds" "$allow_extra_kinds"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

install_broker_units_from_release() {
  local release="$1" source="$1/deploy/vf-codex-broker.service" zai_source="$1/deploy/vf-zai-codex-broker.service"
  if [[ ! -f "$source" ]]; then
    echo "Broker release is missing its systemd unit: $source" >&2
    return 1
  fi
  install -m 0644 "$source" "$broker_unit" || return 1
  if [[ "$zai_broker_configured" -eq 1 ]]; then
    if [[ ! -f "$zai_source" ]]; then
      echo "Broker release is missing its ZAI systemd unit: $zai_source" >&2
      return 1
    fi
    install -m 0644 "$zai_source" "$zai_broker_unit" || return 1
  fi
  systemctl daemon-reload || return 1
}

restart_brokers() {
  local zai_expected_kinds="${1:-topic-ideas,series-roadmap,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit}"
  local zai_allow_extra_kinds="${2:-0}" failed=0
  if ! systemctl restart "$broker_service" \
    || ! wait_for_broker_health "$broker_socket" 20 openai openai \
      topic-ideas,series-roadmap,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit; then
    failed=1
  fi
  if [[ "$zai_broker_enabled" -eq 1 ]]; then
    if ! systemctl restart "$zai_broker_service" \
      || ! wait_for_broker_health "$zai_broker_socket" 20 zai zai-bigmodel-api \
        "$zai_expected_kinds" "$zai_allow_extra_kinds"; then
      echo "Configured ZAI Code Plan broker is unavailable; refusing a partial deployment." >&2
      failed=1
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
  # 回滚必须恢复部署前实际运行的 unit。旧 release 可能早于 ZAI unit 纳入制品，
  # 只按 release 取文件会让应用已回滚、视觉审片服务却留在新版本。
  if [[ -s "$previous_broker_unit_backup" ]]; then
    install -m 0644 "$previous_broker_unit_backup" "$broker_unit" || return 1
    if [[ "$zai_broker_configured" -eq 1 ]]; then
      [[ -s "$previous_zai_broker_unit_backup" ]] || return 1
      install -m 0644 "$previous_zai_broker_unit_backup" "$zai_broker_unit" || return 1
    fi
    systemctl daemon-reload || return 1
  elif [[ -f "$previous_broker_release/deploy/vf-codex-broker.service" ]]; then
    install_broker_units_from_release "$previous_broker_release" || return 1
  else
    echo "No previous broker unit is available for rollback." >&2
    return 1
  fi
  restart_brokers director-plan,script-draft,visual-review 1
}

rollback() {
  local failed=0
  # 两个 broker 共享同一个 release 指针，先一起恢复并通过各自健康检查。
  # 应用只有在候选容器已开始切换时才重建，避免 Broker 前置失败打断运行中的制作。
  rollback_broker || failed=1
  if [[ "$app_mutated" -eq 1 ]]; then
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
  fi
  return "$failed"
}

deployment_mutated=0
deployment_committed=0
rollback_in_progress=0
app_mutated=0

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
  rm -f "$previous_broker_unit_backup" "$previous_zai_broker_unit_backup"
  exit "$status"
}

trap rollback_on_exit EXIT

# 从候选镜像原子提取 broker 制品：容器只创建、绝不启动；失败时显式清理临时容器与 staging。
stage_broker_release() {
  local image_id staging release_dir
  image_id="$(docker create video-factory:candidate)" || return 1
  if ! staging="$(mktemp -d)"; then
    docker rm "$image_id" >/dev/null 2>&1 || true
    return 1
  fi
  if ! docker cp "$image_id:/app/apps/codex-broker" "$staging/broker" >/dev/null; then
    docker rm "$image_id" >/dev/null 2>&1 || true
    rm -rf "$staging"
    return 1
  fi
  if ! docker rm "$image_id" >/dev/null; then
    rm -rf "$staging"
    return 1
  fi
  if [[ ! -f "$staging/broker/dist/main.js"
    || ! -f "$staging/broker/deploy/vf-codex-broker.service"
    || ! -f "$staging/broker/deploy/vf-zai-codex-broker.service" ]]; then
    echo "Candidate image does not contain a complete broker release." >&2
    rm -rf "$staging"
    return 1
  fi
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
  chown -R vf-codex:vf-bridge "$release_dir" || return 1
  chmod -R a+rX "$release_dir" || return 1
  candidate_broker_release="$release_dir"
}

"${compose[@]}" build app

if ! stage_broker_release; then
  echo "Failed to extract the codex broker release from the candidate image." >&2
  exit 1
fi
# 候选 release 已完整校验；只有从这里切换指针后，失败才需要回滚应用和 broker。
deployment_mutated=1
if ! ln -sfn "$candidate_broker_release" "$broker_root/current"; then
  exit 1
fi

if ! install_broker_units_from_release "$broker_root/current"; then
  exit 1
fi

if ! restart_brokers; then
  systemctl --no-pager --lines=60 status "$broker_service" || true
  if [[ "$zai_broker_enabled" -eq 1 ]]; then
    systemctl --no-pager --lines=60 status "$zai_broker_service" || true
  fi
  exit 1
fi

app_mutated=1
if ! "${compose[@]}" up --detach --remove-orphans --force-recreate app; then
  exit 1
fi

if ! wait_for_health 36; then
  "${compose[@]}" ps
  "${compose[@]}" logs --tail=160 app
  exit 1
fi

if ! broker_health "$broker_socket" openai openai \
  topic-ideas,series-roadmap,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit; then
  echo "Codex broker became unhealthy after the app deployment." >&2
  exit 1
fi
if [[ "$zai_broker_enabled" -eq 1 ]] && ! broker_health "$zai_broker_socket" zai zai-bigmodel-api \
  topic-ideas,series-roadmap,director-plan,script-draft,publish-copy,asset-rank,reference-grammar,visual-review,role-audit; then
  echo "ZAI Code Plan broker became unhealthy after the app deployment." >&2
  exit 1
fi

if [[ -n "$public_health_url" ]] && ! app_health "$public_health_url" 15; then
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
