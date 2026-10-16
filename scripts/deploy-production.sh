#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${VIDEO_FACTORY_ENV_FILE:-$repository_root/.env.docker.prod}"
public_health_url="${PUBLIC_HEALTH_URL:-}"
release_sha="${RELEASE_SHA:-}"
deployment_mode="${VIDEO_FACTORY_DEPLOYMENT_MODE:-release}"
upgrade_mode="${VIDEO_FACTORY_UPGRADE_MODE:-online}"
expected_previous_release="${VIDEO_FACTORY_EXPECTED_PREVIOUS_RELEASE:-}"
last_release_file="${VIDEO_FACTORY_LAST_RELEASE_FILE:-}"
backup_existing_data="${VIDEO_FACTORY_BACKUP_EXISTING_DATA:-true}"
if [[ "$backup_existing_data" != "true" && "$backup_existing_data" != "false" ]]; then
  echo "VIDEO_FACTORY_BACKUP_EXISTING_DATA must be true or false." >&2
  exit 1
fi
if [[ "$backup_existing_data" == "false" && ( "$upgrade_mode" != "cold" || "$deployment_mode" != "release" ) ]]; then
  echo "Skipping historical backup requires an explicit cold release." >&2
  exit 1
fi
if [[ "$upgrade_mode" != "online" && "$upgrade_mode" != "cold" ]]; then
  echo "VIDEO_FACTORY_UPGRADE_MODE must be online or cold." >&2
  exit 1
fi
if [[ "$upgrade_mode" == "cold" ]] && { [[ "$deployment_mode" != "release" ]] \
  || [[ ! "$expected_previous_release" =~ ^[0-9a-f]{40}$ ]] || [[ -z "$last_release_file" || -z "$public_health_url" ]]; }; then
  echo "Cold upgrades require an Actions release, exact previous SHA, last release record and public health URL." >&2
  exit 1
fi
container="video_factory_prod"
broker_service=vf-codex-broker
broker_unit=/etc/systemd/system/vf-codex-broker.service
deepseek_broker_service=vf-deepseek-codex-broker
deepseek_broker_unit=/etc/systemd/system/vf-deepseek-codex-broker.service
broker_root=/opt/video-factory/codex-broker
broker_socket=/run/video-factory-codex/worker.sock
deepseek_broker_user=vf-deepseek-codex
deepseek_broker_state_root=/var/lib/video-factory-deepseek-codex
deepseek_broker_workspace="$deepseek_broker_state_root/workspace"
trend_network=video-factory-trends
compose=(docker compose --project-name video-factory --env-file "$environment_file" -f "$repository_root/docker/docker-compose.prod.yml")
# ECS 在中国大陆构建镜像时使用阿里云 Alpine 源；CI 直接 docker build 时保留全球官方源。
export ALPINE_MIRROR="${ALPINE_MIRROR:-http://mirrors.cloud.aliyuncs.com/alpine}"
# ECS 无法稳定访问 npm 官方源；只影响服务器内候选镜像构建，CI 安全审计仍使用官方源。
export NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
export NODE_DIST_URL="${NODE_DIST_URL:-https://npmmirror.com/mirrors/node}"
deepseek_broker_enabled=0
if [[ -s /etc/video-factory/deepseek-codex-broker.env ]]; then
  deepseek_broker_enabled=1
fi
deepseek_broker_configured="$deepseek_broker_enabled"
deepseek_broker_was_active=0
legacy_broker_was_active=0
legacy_broker_rollback_kinds=""
deepseek_broker_rollback_kinds=""
candidate_broker_task_kinds=""
systemctl is-active --quiet "$deepseek_broker_service" && deepseek_broker_was_active=1
systemctl is-active --quiet "$broker_service" && legacy_broker_was_active=1

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
else
  release_sha="$(git -C "$repository_root" rev-parse HEAD)"
  [[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
fi

if [[ "$deepseek_broker_configured" -ne 1 ]]; then
  echo "DeepSeek broker credentials are not configured; leaving the current production release untouched." >&2
  exit 1
fi

deepseek_broker_runtime_dir="${VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR:-}"
if [[ -z "$deepseek_broker_runtime_dir" ]]; then
  deepseek_broker_runtime_dir="$(awk -F= '$1 == "VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR" { sub(/^[^=]*=/, ""); print; exit }' "$environment_file")"
fi
deepseek_broker_runtime_dir="${deepseek_broker_runtime_dir:-/run/video-factory-deepseek-codex}"
deepseek_broker_socket="$deepseek_broker_runtime_dir/worker.sock"
export VIDEO_FACTORY_DEEPSEEK_CODEX_RUNTIME_DIR="$deepseek_broker_runtime_dir"
# compose 用它注入运行时 VIDEO_FACTORY_RELEASE_SHA，健康端点回显供版本核对（R3b）。
export RELEASE_SHA="$release_sha"

ensure_deepseek_workspace() {
  local target
  for target in "$deepseek_broker_state_root" "$deepseek_broker_workspace"; do
    if [[ -L "$target" || -e "$target" && ! -d "$target" ]]; then
      echo "Refusing unsafe DeepSeek broker workspace path: $target" >&2
      return 1
    fi
  done
  install -d -o "$deepseek_broker_user" -g vf-bridge -m 0750 \
    "$deepseek_broker_state_root" "$deepseek_broker_workspace" || return 1
  for target in "$deepseek_broker_state_root" "$deepseek_broker_workspace"; do
    if [[ "$(stat -c %U:%G "$target")" != "$deepseek_broker_user:vf-bridge" \
      || "$(stat -c %a "$target")" != 750 ]]; then
      echo "DeepSeek broker workspace has unsafe ownership or mode: $target" >&2
      return 1
    fi
  done
  runuser -u "$deepseek_broker_user" -- test -w "$deepseek_broker_workspace"
}

check_deepseek_upstream() {
  # 这里只读模型目录，不提交 prompt、不创建模型任务，也不会产生内容生成费用。
  "$broker_root/bin/node" --env-file=/etc/video-factory/deepseek-codex-broker.env --input-type=module --eval '
    const urls = [
      "https://api.deepseek.com/models",
    ];
    const key = process.env.DEEPSEEK_API_KEY?.trim();
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
ensure_deepseek_workspace || exit 1
check_deepseek_upstream || {
  echo "DeepSeek upstream readiness check failed; leaving the current production release untouched." >&2
  exit 1
}

# 应用与自托管热点容器只经内部网络通信；没有部署热点时保留空网络，应用会如实报告离线。
docker network inspect "$trend_network" >/dev/null 2>&1 \
  || docker network create --driver bridge "$trend_network" >/dev/null

# 不把 Docker 查询失败伪装成首次安装；仅明确不存在目标容器时无源镜像。
container_names="$(docker container ls --all --format '{{.Names}}')" || exit 1
previous_image=""
while IFS= read -r name; do
  if [[ "$name" == "$container" ]]; then
    previous_image="$(docker inspect --format='{{.Image}}' "$container")" || exit 1
    [[ -n "$previous_image" ]] || exit 1
  fi
done <<< "$container_names"
deployment_state="$broker_root/deployment"
# broker 只需穿越父目录；回滚配置仍由 umask 077 保持私有。
install -d -o root -g vf-bridge -m 0710 "$deployment_state"
cold_ingress_directory="$deployment_state/ingress"
if [[ "$upgrade_mode" == "cold" ]]; then
  # 入口事务要求私有父目录，与 broker 可穿越的共享维护父目录分开。
  if [[ -L "$cold_ingress_directory" || -e "$cold_ingress_directory" && ! -d "$cold_ingress_directory" ]]; then
    echo "Refusing unsafe cold ingress transaction directory." >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 "$cold_ingress_directory"
fi
previous_compose="${VIDEO_FACTORY_ROLLBACK_COMPOSE_FILE:-$deployment_state/current.compose.json}"
rollback_compose=(docker compose --project-name video-factory -f "$previous_compose")
if [[ -n "$previous_image" ]]; then
  if [[ ! -s "$previous_compose" ]]; then
    echo "Missing pre-deploy resolved Compose configuration; refusing unsafe image-only rollback." >&2
    exit 1
  fi
  "${rollback_compose[@]}" config --quiet
  docker tag "$previous_image" video-factory:rollback
fi

previous_broker_release="$(readlink "$broker_root/current" 2>/dev/null || true)"
previous_broker_unit_backup="$(mktemp "$deployment_state/legacy-unit.XXXXXX")"
previous_deepseek_broker_unit_backup="$(mktemp "$deployment_state/deepseek-unit.XXXXXX")"
candidate_broker_release=""
if [[ -f "$broker_unit" ]]; then
  cp -a "$broker_unit" "$previous_broker_unit_backup"
fi
if [[ -f "$deepseek_broker_unit" ]]; then
  cp -a "$deepseek_broker_unit" "$previous_deepseek_broker_unit_backup"
fi

app_health() {
  local url="$1" timeout_seconds="${2:-5}" expected_release="${3:-}" health_json
  health_json="$(curl --noproxy '*' --fail --silent --show-error --max-time "$timeout_seconds" "$url")" || return 1
  APP_HEALTH_JSON="$health_json" EXPECTED_RELEASE="$expected_release" "$broker_root/bin/node" --eval '
    try {
      const health = JSON.parse(process.env.APP_HEALTH_JSON ?? "");
      // 期望版本为空（bootstrap/旧应用）时只看状态；否则必须精确回显候选 RELEASE_SHA。
      const releaseMatches = (process.env.EXPECTED_RELEASE ?? "") === ""
        || health?.release === process.env.EXPECTED_RELEASE;
      process.exit(health?.status === "ok" && releaseMatches ? 0 : 1);
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
  health_json="$(curl --noproxy '*' --fail --silent --max-time 5 --unix-socket "$socket" http://localhost/health)" || return 1
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
        const deepseekModelsMatch = process.env.EXPECTED_BROKER_PROFILE !== "deepseek"
          || taskModels["director-plan"] === health.modelId
            && taskModels["script-draft"] === health.modelId;
        process.exit(identityMatches && kindsMatch && modelsMatch && deepseekModelsMatch ? 0 : 1);
      } catch {
        process.exit(1);
      }
    '
}

broker_contract_kinds() {
  local socket="$1" expected_profile="$2" expected_provider="$3" health_json
  health_json="$(curl --noproxy '*' --fail --silent --max-time 5 --unix-socket "$socket" http://localhost/health)" || return 1
  BROKER_HEALTH_JSON="$health_json" \
    EXPECTED_BROKER_PROFILE="$expected_profile" \
    EXPECTED_BROKER_PROVIDER="$expected_provider" \
    "$broker_root/bin/node" --eval '
      try {
        const health = JSON.parse(process.env.BROKER_HEALTH_JSON ?? "");
        const taskKinds = Array.isArray(health.taskKinds) ? health.taskKinds : [];
        const taskModels = health.taskModels;
        const valid = health.protocolVersion === "video-factory/codex-bridge-v2"
          && health.profileId === process.env.EXPECTED_BROKER_PROFILE
          && health.providerId === process.env.EXPECTED_BROKER_PROVIDER
          && taskKinds.length > 0
          && new Set(taskKinds).size === taskKinds.length
          && taskKinds.every((kind) => typeof kind === "string" && /^[a-z0-9-]+$/.test(kind))
          && taskModels && typeof taskModels === "object" && !Array.isArray(taskModels)
          && taskKinds.every((kind) => typeof taskModels[kind] === "string" && taskModels[kind].length > 0);
        if (!valid) process.exit(1);
        process.stdout.write(taskKinds.join(","));
      } catch {
        process.exit(1);
      }
    '
}

task_kinds_from_release() {
  local release="$1" definitions="$1/dist/task-definitions.js"
  [[ -f "$definitions" ]] || return 1
  BROKER_TASK_DEFINITIONS="$definitions" "$broker_root/bin/node" --input-type=module --eval '
    import { pathToFileURL } from "node:url";
    try {
      const definitions = await import(pathToFileURL(process.env.BROKER_TASK_DEFINITIONS).href);
      const taskKinds = definitions.REQUIRED_BROKER_TASK_KINDS ?? definitions.BROKER_TASK_KINDS;
      const valid = Array.isArray(taskKinds)
        && taskKinds.length > 0
        && new Set(taskKinds).size === taskKinds.length
        && taskKinds.every((kind) => typeof kind === "string" && /^[a-z0-9-]+$/.test(kind));
      if (!valid) process.exit(1);
      process.stdout.write(taskKinds.join(","));
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
  local deepseek_source="$1/deploy/vf-deepseek-codex-broker.service"
  if [[ "$deepseek_broker_configured" -eq 1 ]]; then
    if [[ ! -f "$deepseek_source" ]]; then
      echo "Broker release is missing its DeepSeek systemd unit: $deepseek_source" >&2
      return 1
    fi
    install -m 0644 "$deepseek_source" "$deepseek_broker_unit" || return 1
    # 本次解析出的共享目录必须同时供 unit 与 compose 使用；只改本轮已安装的 unit。
    python3 - "$deepseek_broker_unit" "$maintenance_directory" <<'PY' || return 1
from pathlib import Path
import sys
unit = Path(sys.argv[1])
root = sys.argv[2]
if not root.startswith('/') or any(character.isspace() for character in root) or '%' in root:
    raise SystemExit('Maintenance directory is not a supported systemd path')
text = unit.read_text()
text = text.replace('/opt/video-factory/codex-broker/deployment/maintenance', root)
unit.write_text(text)
PY
  fi
  systemctl daemon-reload || return 1
}

restart_brokers() {
  local deepseek_expected_kinds="$1"
  local deepseek_allow_extra_kinds="${2:-0}" restore_previous="${3:-0}" failed=0
  # 旧服务仅用于恢复部署前的版本；新版本不能再依赖退役的 OpenAI 链路。
  if [[ "$restore_previous" -eq 1 && "$legacy_broker_was_active" -eq 1 ]]; then
    if ! systemctl restart "$broker_service" \
      || ! wait_for_broker_health "$broker_socket" 20 openai openai \
        "$legacy_broker_rollback_kinds"; then
      failed=1
    fi
  fi
  if [[ "$restore_previous" -eq 0 || "$deepseek_broker_was_active" -eq 1 ]]; then
    if [[ -z "$deepseek_expected_kinds" ]] \
      || ! systemctl restart "$deepseek_broker_service" \
      || ! wait_for_broker_health "$deepseek_broker_socket" 20 deepseek deepseek \
        "$deepseek_expected_kinds" "$deepseek_allow_extra_kinds"; then
      echo "Configured DeepSeek broker is unavailable; refusing a partial deployment." >&2
      failed=1
    fi
  else
    systemctl stop "$deepseek_broker_service" || failed=1
    # 首次迁移回滚时 systemd 会移除运行目录；旧镜像仍按本次 compose 重建，保留空挂载点。
    if [[ ! -e "$deepseek_broker_runtime_dir" ]]; then
      install -d -o root -g vf-bridge -m 0750 "$deepseek_broker_runtime_dir" || failed=1
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
  # 回滚必须恢复部署前实际运行的 unit。旧 release 可能早于 DeepSeek unit 纳入制品，
  # 只按 release 取文件会让应用已回滚、视觉审片服务却留在新版本。
  if [[ "$legacy_broker_was_active" -eq 1 ]]; then
    if [[ ! -s "$previous_broker_unit_backup" && -f "$previous_broker_release/deploy/vf-codex-broker.service" ]]; then
      cp "$previous_broker_release/deploy/vf-codex-broker.service" "$previous_broker_unit_backup" || return 1
    fi
    [[ -s "$previous_broker_unit_backup" ]] || return 1
    install -m 0644 "$previous_broker_unit_backup" "$broker_unit" || return 1
  fi
  if [[ "$deepseek_broker_was_active" -eq 1 ]]; then
    [[ -s "$previous_deepseek_broker_unit_backup" ]] || return 1
    install -m 0644 "$previous_deepseek_broker_unit_backup" "$deepseek_broker_unit" || return 1
  fi
  systemctl daemon-reload || return 1
  restart_brokers "$deepseek_broker_rollback_kinds" 0 1
}

rollback() {
  local failed=0
  # 两个 broker 共享同一个 release 指针，先一起恢复并通过各自健康检查。
  # 已在冻结窗口停止的原 app 也必须恢复，即使 broker 切换先失败。
  rollback_broker || failed=1
  if [[ "$app_mutated" -eq 1 ]]; then
    if [[ -z "$previous_image" ]] || ! docker image inspect video-factory:rollback >/dev/null 2>&1; then
      echo "No previous VideoFactory image is available for rollback." >&2
      failed=1
    else
      echo "Restoring the previous VideoFactory image."
      if ! docker tag video-factory:rollback video-factory:candidate \
        || ! "${rollback_compose[@]}" up --detach --no-deps --force-recreate app \
        || ! wait_for_health 24; then
        failed=1
      fi
    fi
  elif [[ "$app_was_running" -eq 1 ]]; then
    "${rollback_compose[@]}" up --detach --no-deps app || failed=1
    wait_for_health 24 || failed=1
  fi
  return "$failed"
}

deployment_mutated=0
deployment_committed=0
rollback_in_progress=0
app_mutated=0

# —— 维护门禁（R3）：与 app/broker 的准入共用同一短锁和持久登记。 ——
maintenance_directory="${VIDEO_FACTORY_MAINTENANCE_DIR:-$deployment_state/maintenance}"
maintenance_owner="deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
maintenance_module=""
maintenance_phase=""   # frozen 表示禁止新增写者；仍须另行核实实际进程退出。
maintenance_recovery_allowed=0
maintenance_endpoints=()
drain_timeout_seconds="${VIDEO_FACTORY_DRAIN_TIMEOUT_SECONDS:-3600}"
app_was_running=0
active_broker_sockets=()
cold_state="$deployment_state/cold-$maintenance_owner.json"
cold_ingress_state="$cold_ingress_directory/ingress-$maintenance_owner.json"
cold_evidence="$deployment_state/cold-proof-$maintenance_owner.json"
cold_ingress_started=0
cold_writers_touched=0
cold_writers_stopped=0

cold_control() {
  python3 -I -B "$repository_root/scripts/production-cold-upgrade.py" "$1" "$cold_state" "${@:2}"
}

cold_ingress() {
  "$broker_root/bin/node" "$repository_root/scripts/production-cold-ingress.mjs" "$1" "$cold_ingress_state" "${@:2}"
}

maintenance_control() {
  "$broker_root/bin/node" "$repository_root/scripts/production-maintenance.mjs" \
    "$maintenance_module" "$maintenance_directory" "$1" "$maintenance_owner" "${@:2}"
}

# 失败只按原部署记录恢复；新版本则核准确版本及完整静止后再开放。
reopen_gate() {
  [[ -n "$maintenance_phase" ]] || return 0
  if [[ "$deployment_committed" -eq 1 ]]; then
    maintenance_control reopen "$release_sha" "http://127.0.0.1:4317/api/health" "unix:$deepseek_broker_socket" || return 1
  else
    [[ "$maintenance_recovery_allowed" -eq 1 ]] || return 1
    maintenance_control recover || return 1
  fi
  maintenance_phase=""
  echo "Maintenance gate reopened (owner=$maintenance_owner)." >&2
  return 0
}

app_container_running() {
  [[ "$(docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null || true)" == "true" ]]
}

service_stopped() {
  local state
  state="$(systemctl show "$1" --property=LoadState,ActiveState,SubState,MainPID,ControlPID --no-pager)" || return 1
  WRITER_STATE="$state" "$broker_root/bin/node" --eval '
    const s = Object.fromEntries((process.env.WRITER_STATE ?? "").trim().split("\n").map(line => {
      const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
    }));
    process.exit(["loaded", "not-found"].includes(s.LoadState)
      && s.ActiveState === "inactive" && s.SubState === "dead"
      && s.MainPID === "0" && s.ControlPID === "0" ? 0 : 1);
  '
}

app_stopped() {
  local state
  state="$(docker inspect --format='{{json .State}}' "$container")" || return 1
  APP_STATE="$state" "$broker_root/bin/node" --eval '
    try {
      const s = JSON.parse(process.env.APP_STATE);
      process.exit(s.Running === false && s.Pid === 0 && s.Restarting === false
        && s.Dead === false && ["exited", "created"].includes(s.Status) ? 0 : 1);
    } catch { process.exit(1); }
  '
}

refuse_legacy_online_switch() {
  echo "拒绝在线切换：$1 不支持维护门禁协议（无法安全排空/停写）。" >&2
  echo "本次未停止任何服务、未切换任何制品。冷维护须先阻止新入口、确认原任务落稳，" >&2
  echo "再正常停止全部写者 → 备份与隔离恢复验证 → 升级 → 闭门复验；不能确认落稳时停止操作。" >&2
  exit 1
}

wait_for_quiescence() {
  local deadline=$((SECONDS + drain_timeout_seconds))
  while :; do
    # helper 同锁核空集合→锁外刷新 live health→同锁核 generation/本机报告并冻结。
    if maintenance_control freeze ${maintenance_endpoints[@]+"${maintenance_endpoints[@]}"}; then
      maintenance_phase="frozen"
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "Drain timed out after ${drain_timeout_seconds}s; verifying the original services before reopening." >&2
      return 1
    fi
    sleep 5
  done
}

stop_writers() {
  # 只在已冻结且完整排空后正常停止；未知/过渡状态不能证明退出。
  maintenance_recovery_allowed=0
  if [[ "$legacy_broker_was_active" -eq 1 ]]; then
    systemctl stop "$broker_service" || return 1
  fi
  if [[ "$deepseek_broker_was_active" -eq 1 ]]; then
    systemctl stop "$deepseek_broker_service" || return 1
  fi
  service_stopped "$broker_service" || return 1
  service_stopped "$deepseek_broker_service" || return 1
  service_stopped vf-zai-codex-broker || return 1
  if [[ "$app_was_running" -eq 1 ]]; then
    "${rollback_compose[@]}" stop --timeout -1 app >/dev/null || return 1
  fi
  if [[ -n "$previous_image" ]]; then app_stopped || return 1; fi
  maintenance_recovery_allowed=1
  return 0
}

resume_previous_writers() {
  # 冻结后、切换制品前的失败：原制品未动，闭门拉起原有写者并等健康。
  local failed=0
  echo "Restoring the previous writers under the closed maintenance gate." >&2
  restart_brokers "$deepseek_broker_rollback_kinds" 0 1 || failed=1
  if [[ "$app_was_running" -eq 1 ]]; then
    "${rollback_compose[@]}" up --detach --no-deps app || failed=1
    wait_for_health 24 || failed=1
  fi
  return "$failed"
}

cold_finish() {
  local status="$1"
  if [[ "$deployment_committed" -eq 1 ]]; then
    # 提交后只能继续开放已核验的候选，不能复活旧写者。
    reopen_gate || return 1
    cold_control cleanup || return 1
    cold_ingress restore || return 1
    cold_ingress_started=0
    rm -f "$previous_broker_unit_backup" "$previous_deepseek_broker_unit_backup"
    return 0
  fi
  [[ "$cold_ingress_started" -eq 1 ]] || return 0
  if [[ "$cold_writers_touched" -eq 0 ]]; then
    cold_ingress restore || return 1
    cold_control cleanup || return 1
    return 0
  fi
  if [[ "$cold_writers_stopped" -ne 1 ]]; then
    echo "Cold stop was not fully verified; ingress remains closed, no writer is restarted." >&2
    return 1
  fi
  if [[ "$deployment_mutated" -eq 1 ]]; then
    # 候选尚未开放，无新工作；先正常停候选再恢复原制品，保留两边停止保护。
    "${compose[@]}" stop --timeout -1 app >/dev/null || return 1
    systemctl stop "$deepseek_broker_service" || return 1
    if [[ "$legacy_broker_was_active" -eq 1 ]]; then systemctl stop "$broker_service" || return 1; fi
    cold_control rollback-stopped || return 1
    rollback || return 1
  else
    cold_control rollback-stopped || return 1
    resume_previous_writers || return 1
  fi
  cold_control restored --output "$cold_evidence.abort" || return 1
  # 若 cold-enter 已产生门禁，只能以记录的原 owner/原制品完成显式 abort。
  if [[ -e "$maintenance_directory/gate.json" ]]; then
    maintenance_control cold-abort "$cold_evidence.abort" || return 1
  fi
  maintenance_phase=""
  cold_control cleanup || return 1
  cold_ingress restore || return 1
  cold_ingress_started=0
}

rollback_on_exit() {
  local status="$?" recovery_status=0
  trap - EXIT
  if [[ "$upgrade_mode" == "cold" ]]; then
    if ! cold_finish "$status"; then
      echo "Cold upgrade recovery is incomplete; site ingress restoration is unverified (owner=$maintenance_owner)." >&2
      [[ "$status" -ne 0 ]] || status=1
    fi
    exit "$status"
  fi
  if [[ "$status" -ne 0 ]]; then
    if [[ "$deployment_mutated" -eq 1 && "$deployment_committed" -eq 0 && "$rollback_in_progress" -eq 0 ]]; then
      rollback_in_progress=1
      echo "Deployment failed; restoring the application and all configured brokers under the closed maintenance gate." >&2
      set +e
      rollback
      recovery_status="$?"
      set -e
    elif [[ "$deployment_committed" -eq 0 && "$maintenance_phase" == "frozen" && "$maintenance_recovery_allowed" -eq 1 ]]; then
      # 已确认停写、未切制品的失败可以闭门恢复原写者。
      set +e
      resume_previous_writers
      recovery_status="$?"
      set -e
    elif [[ "$deployment_committed" -eq 0 && "$maintenance_phase" == "frozen" ]]; then
      # 停止失败时进程状态未证实，不以 restart/强杀把它变成可恢复状态。
      recovery_status=1
    fi
    if [[ "$recovery_status" -ne 0 ]]; then
      # 恢复未完全成功：门禁保持 FROZEN 阻塞新工作并显式说明，不冒充恢复完成。
      echo "Recovery did not fully restore every writer; the maintenance gate stays FROZEN (owner=$maintenance_owner). Operator intervention is required." >&2
      exit "$status"
    fi
  fi
  if ! reopen_gate; then
    echo "Maintenance recovery verification failed; gate remains closed (owner=$maintenance_owner)." >&2
    [[ "$status" -ne 0 ]] || status=1
  elif [[ "$deployment_committed" -eq 1 ]]; then
    rm -f "$previous_broker_unit_backup" "$previous_deepseek_broker_unit_backup"
  fi
  exit "$status"
}

trap rollback_on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

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
    || ! -f "$staging/broker/dist/task-definitions.js"
    || ! -f "$staging/broker/node_modules/undici/package.json"
    || ! -f "$staging/broker/deploy/vf-deepseek-codex-broker.service" ]]; then
    echo "Candidate image does not contain a complete broker release." >&2
    rm -rf "$staging"
    return 1
  fi
  release_dir="$(mktemp -d "$broker_root/releases/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")" || return 1
  if ! cp -a "$staging/broker/." "$release_dir/"; then
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
  printf '%s\n' "$release_sha" > "$release_dir/release-sha" || return 1
  chown -R root:vf-bridge "$release_dir" || return 1
  chmod -R a+rX "$release_dir" || return 1
  candidate_broker_release="$release_dir"
}

# 回滚验收必须使用部署前实际运行的合同。旧版本可能少于新版本的任务类型，
# 用新合同检查旧进程会把已经恢复的站点误报成回滚失败。
if [[ "$legacy_broker_was_active" -eq 1 ]]; then
  legacy_broker_rollback_kinds="$(broker_contract_kinds "$broker_socket" openai openai)" || {
    echo "Unable to capture the running OpenAI broker contract before deployment." >&2
    exit 1
  }
fi
if [[ "$deepseek_broker_was_active" -eq 1 ]]; then
  deepseek_broker_rollback_kinds="$(broker_contract_kinds "$deepseek_broker_socket" deepseek deepseek)" || {
    echo "Unable to capture the running DeepSeek broker contract before deployment." >&2
    exit 1
  }
fi

"${compose[@]}" build app

if ! stage_broker_release; then
  echo "Failed to extract the codex broker release from the candidate image." >&2
  exit 1
fi
candidate_broker_task_kinds="$(task_kinds_from_release "$candidate_broker_release")" || {
  echo "Candidate broker release does not publish a valid task contract." >&2
  exit 1
}
# —— 维护事务（R3b 固定顺序）：拒绝旧协议 → 关新工作 → 排空 → 冻结 → 停写者
# → 离线完整备份+隔离恢复校验 → 切换 → 闭门启动核验 → 同 owner 开门。 ——
maintenance_module="$candidate_broker_release/node_modules/@video-factory/production-pipeline/dist/maintenance.js"
[[ -f "$maintenance_module" ]] || { echo "Candidate is missing the shared maintenance protocol." >&2; exit 1; }
export VIDEO_FACTORY_MAINTENANCE_DIR="$maintenance_directory"
if [[ ! -e "$maintenance_directory" ]]; then
  # setgid 让 app(1001) 与 broker(vf-bridge) 创建的锁/登记持续共享组。
  install -d -m 2770 "$maintenance_directory"
  if [[ "$(id -u)" -eq 0 ]]; then chown root:vf-bridge "$maintenance_directory"; fi
  chmod 2770 "$maintenance_directory"
fi
# 在关闭入口和停止服务前，按真实服务身份核对整条路径及共享目录权限。
if ! runuser -u "$deepseek_broker_user" -g vf-bridge -- \
  sh -c 'test -x "$1" && test -r "$1" && test -w "$1"' sh "$maintenance_directory"; then
  echo "DeepSeek broker cannot access the shared maintenance directory; leaving running writers untouched." >&2
  rm -f "$previous_broker_unit_backup" "$previous_deepseek_broker_unit_backup"
  exit 1
fi

if [[ "$upgrade_mode" == "cold" ]]; then
  [[ -n "$previous_image" ]] || { echo "Cold upgrade requires an existing deployment." >&2; exit 1; }
  cold_control prepare --container "$container" --image video-factory:candidate \
    --previous-release "$expected_previous_release" --candidate-release "$release_sha" \
    --last-release "$last_release_file" --broker-current "$broker_root/current" \
    --maintenance-directory "$maintenance_directory" --ingress "$cold_ingress_state" \
    --node "$broker_root/bin/node" || exit 1
  maintenance_control cold-preflight "$cold_state" || exit 1
  app_was_running=1
  if [[ "$legacy_broker_was_active" -eq 1 ]]; then active_broker_sockets+=("$broker_socket"); fi
  if [[ "$deepseek_broker_was_active" -eq 1 ]]; then active_broker_sockets+=("$deepseek_broker_socket"); fi
  cold_ingress_started=1
  cold_ingress enter "$public_health_url" || exit 1
  cold_control idle || exit 1
  # 旧版不能读取维护门禁：先关闭并排空外部入口，再正常停 app，复核全部 broker。
  cold_writers_touched=1
  cold_control stop-app || exit 1
  "${rollback_compose[@]}" stop --timeout -1 app >/dev/null || exit 1
  app_stopped || exit 1
  cold_control stop-brokers || exit 1
  cold_control stopped --output "$cold_evidence" || exit 1
  cold_writers_stopped=1
  maintenance_control cold-enter "$cold_evidence" || exit 1
  maintenance_phase="frozen"
  maintenance_recovery_allowed=1
else
# 普通在线路径拒绝未启用当前协议的原服务，显式冷升级独立核入口与停写。
service_stopped vf-zai-codex-broker || refuse_legacy_online_switch "vf-zai-codex-broker 或其未证实退出状态"
if [[ -n "$previous_image" ]]; then
  if app_container_running; then
    app_was_running=1
    maintenance_control preflight "http://127.0.0.1:4317/api/health" || refuse_legacy_online_switch "当前运行中的 app"
    maintenance_endpoints+=("http://127.0.0.1:4317/api/health")
  else
    app_stopped || { echo "App writer state is unknown; refusing deployment." >&2; exit 1; }
  fi
fi
if [[ "$legacy_broker_was_active" -eq 1 ]]; then
  maintenance_control preflight "unix:$broker_socket" || refuse_legacy_online_switch "旧版 $broker_service"
  active_broker_sockets+=("$broker_socket")
  maintenance_endpoints+=("unix:$broker_socket")
else
  service_stopped "$broker_service" || { echo "Legacy broker exit is unverified." >&2; exit 1; }
fi
if [[ "$deepseek_broker_was_active" -eq 1 ]]; then
  maintenance_control preflight "unix:$deepseek_broker_socket" || refuse_legacy_online_switch "旧版 $deepseek_broker_service"
  active_broker_sockets+=("$deepseek_broker_socket")
  maintenance_endpoints+=("unix:$deepseek_broker_socket")
else
  service_stopped "$deepseek_broker_service" || { echo "DeepSeek broker exit is unverified." >&2; exit 1; }
fi
if [[ ! -e "$maintenance_directory/gate.json" ]]; then
  if [[ -n "$previous_image" || "${#active_broker_sockets[@]}" -gt 0 ]]; then
    refuse_legacy_online_switch "现有部署缺少持久维护门禁"
  fi
  maintenance_control initialize || exit 1
fi
# 关闭状态不能自动换 owner；受限 recover 命令核原部署记录、版本、进程与同锁证明。
maintenance_control drain ${maintenance_endpoints[@]+"${maintenance_endpoints[@]}"} || exit 1
maintenance_phase="draining"
maintenance_recovery_allowed=1
echo "Maintenance gate closed for draining (owner=$maintenance_owner)."
if ! wait_for_quiescence; then exit 1; fi

echo "Writers frozen; stopping the drained app and all brokers."
if ! stop_writers; then
  echo "Failed to stop writers cleanly; gate remains closed for operator verification." >&2
  exit 1
fi
fi

if [[ "$backup_existing_data" == "false" ]]; then
  echo "Historical data backup explicitly disabled for this cold release; no full backup was created."
elif [[ -n "$previous_image" || "${#active_broker_sockets[@]}" -gt 0 ]]; then
  echo "Running the offline full backup with isolated restore verification."
  if ! env \
    VIDEO_FACTORY_MAINTENANCE_DIR="$maintenance_directory" \
    VIDEO_FACTORY_MAINTENANCE_OWNER="$maintenance_owner" \
    VIDEO_FACTORY_CONTAINER="$container" \
    VIDEO_FACTORY_BACKUP_DIR="${VIDEO_FACTORY_BACKUP_DIR:-$broker_root/backups}" \
    VIDEO_FACTORY_BACKUP_VERIFY_IMAGE=video-factory:candidate \
    VIDEO_FACTORY_BACKUP_ALLOW_LEGACY=1 \
    "$repository_root/scripts/backup-production.sh"; then
    echo "Full backup or its restore verification failed; not switching artifacts." >&2
    exit 1
  fi
else
  # 首次安装由部署外层显式判定“不适用”；绝不写 full 成功标记（R2）。
  echo "首次安装：没有旧部署可备份，离线完整备份不适用（不写 full 成功标记）。"
fi

# 候选 release 已完整校验；只有从这里切换指针后，失败才需要回滚应用和 broker。
deployment_mutated=1
if ! ln -sfn "$candidate_broker_release" "$broker_root/current"; then
  exit 1
fi

if ! install_broker_units_from_release "$broker_root/current"; then
  exit 1
fi

if ! restart_brokers "$candidate_broker_task_kinds"; then
  echo "Broker readiness failed; raw diagnostics remain in the private host journal." >&2
  exit 1
fi

app_mutated=1
if ! "${compose[@]}" up --detach --remove-orphans --force-recreate app; then
  exit 1
fi

if ! wait_for_health 36; then
  "${compose[@]}" ps
  echo "App readiness failed; inspect private host logs with credential-safe tooling." >&2
  exit 1
fi

# 闭门状态下核对健康与准确版本：回显的 RELEASE_SHA 必须等于候选（R3b 第 5 步）。
if [[ -n "$release_sha" ]] && ! app_health http://127.0.0.1:4317/api/health 15 "$release_sha"; then
  echo "App is healthy but does not report the candidate release $release_sha." >&2
  exit 1
fi

if [[ "$deepseek_broker_enabled" -eq 1 ]] && ! broker_health "$deepseek_broker_socket" deepseek deepseek \
  "$candidate_broker_task_kinds"; then
  echo "DeepSeek broker became unhealthy after the app deployment." >&2
  exit 1
fi

if [[ -n "$public_health_url" ]] && ! app_health "$public_health_url" 15 "$release_sha"; then
  echo "Public health check failed: $public_health_url" >&2
  exit 1
fi

maintenance_control verify "$release_sha" "http://127.0.0.1:4317/api/health" "unix:$deepseek_broker_socket" || exit 1
systemctl enable "$deepseek_broker_service" >/dev/null
"${compose[@]}" config --format json | python3 -c 'import sys; print(sys.stdin.read().replace("$", "$$"))' \
  > "$deployment_state/current.compose.json.partial"
mv "$deployment_state/current.compose.json.partial" "$deployment_state/current.compose.json"
deployment_committed=1

# 新版本已健康且无需回滚后，才退役旧生产服务；不删除旧制品和凭据。
for retired_service in vf-codex-broker vf-zai-codex-broker; do
  if systemctl cat "$retired_service" >/dev/null 2>&1; then
    systemctl disable --now "$retired_service" || echo "Could not disable retired service $retired_service." >&2
  fi
done

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

# —— 同 owner 重开门禁：新版本已在闭门状态通过健康与版本核验（R3b 第 5 步）。 ——
reopen_gate
if [[ "$upgrade_mode" == "cold" ]]; then
  cold_control cleanup || exit 1
  cold_ingress restore || exit 1
  cold_ingress_started=0
  app_health "$public_health_url" 15 "$release_sha" || exit 1
fi

echo "VideoFactory deployment completed."
