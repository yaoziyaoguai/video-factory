#!/usr/bin/env bash
# ECS 端 ACR 分层拉取：按层增量拉取同 SHA 发布镜像，还原 deploy-frame.sh 使用的本地标签。
# 基础镜像层此前已在本地或随首拉抵达，常规发布只传输业务层；镜像 ID 仍由 deploy-frame.sh
# 对照 frame-release.json 清单核对，ACR 传输不改变既有的完整性校验与原子切换流程。
set -Eeuo pipefail
# 密码经 0600 文件传入（部署端由 CI scp 落盘），绝不作为环境值出现在命令行或远端 argv。
: "${ACR_REGISTRY:?}" "${ACR_NAMESPACE:?}" "${ACR_USERNAME:?}" "${ACR_PASSWORD_FILE:?}" "${RELEASE_SHA:?}"
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$ACR_REGISTRY" =~ ^[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+$ ]]
[[ "$ACR_NAMESPACE" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
password_file="$ACR_PASSWORD_FILE"
if [[ "$(stat -c '%a' "$password_file" 2>/dev/null || stat -f '%Lp' "$password_file")" != 600 ]]; then
  echo "ACR 密码文件权限必须是 0600：$password_file" >&2; exit 1
fi
docker login --username "$ACR_USERNAME" --password-stdin "$ACR_REGISTRY" < "$password_file"
trap 'docker logout "$ACR_REGISTRY" >/dev/null 2>&1 || true' EXIT
pull_started="$(date +%s)"
for name in video-factory frame-creative; do
  remote="$ACR_REGISTRY/$ACR_NAMESPACE/$name:release-$RELEASE_SHA"
  docker pull "$remote"
  docker tag "$remote" "$name:release-$RELEASE_SHA"
  # 只保留 deploy-frame.sh 使用的本地发布标签，长名标签解除引用。
  docker image rm "$remote" >/dev/null
done
printf 'ACR layered pull of release %s finished in %s seconds.\n' "$RELEASE_SHA" "$(( $(date +%s) - pull_started ))"
