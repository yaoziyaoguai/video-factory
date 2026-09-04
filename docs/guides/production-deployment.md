# VideoFactory 生产部署

## 目标架构

```text
GitHub main
    │ push
    ▼
GitHub Actions ── test / build / audit / Docker build
    │ SSH
    ▼
Alibaba ECS
    ├── systemd: vf-codex-broker（vf-codex 用户，/opt/video-factory/codex-broker）
    │     ├── CODEX_HOME=/var/lib/video-factory-codex/codex-home（可变运行状态）
    │     ├── auth.json -> /home/vf-codex/.codex/auth.json（只读链接）
    │     └── /run/video-factory-codex/worker.sock 0660 vf-codex:vf-bridge
    ├── systemd: vf-zai-codex-broker（vf-zai-codex 用户，同一版本的 broker 制品）
    │     ├── glm-5.3 文本任务 -> Coding Plan endpoint
    │     ├── glm-5.3-flash 带图任务 -> 通用 Chat Completion endpoint
    │     ├── /var/lib/video-factory-zai-codex/workspace（任务幂等记录）
    │     └── /run/video-factory-zai-codex/worker.sock 0660 vf-zai-codex:vf-bridge
    ├── Nginx :80/:443
    │     └── video.wangjinkun333.me -> 127.0.0.1:4317
    └── Docker
          ├── video_factory_prod -> named volume /data/factory
          │     └── 只读挂载 /run/video-factory-codex，经 Unix socket 调用 Codex（不挂载 ~/.codex）
          └── video-factory-trends 内部网络 -> TrendRadar / NewsNow / DailyHot / RSSHub
```

应用端口只绑定服务器 `127.0.0.1`，公网只能通过 Nginx 和 HTTPS 访问。生产模式强制启用单用户登录；密码只保存 scrypt 哈希，会话 Cookie 使用 `HttpOnly`、`SameSite=Strict` 和 `Secure`。

## 1. 准备生产环境文件

首次部署先在服务器建立一个由 Git 管理的干净工作区：

```bash
mkdir -p /root/work_space
git clone https://github.com/yaoziyaoguai/video-factory.git /root/work_space/video-factory
cd /root/work_space/video-factory
```

在本地生成密码哈希，避免明文密码进入命令历史：

```bash
read -s VIDEO_FACTORY_PASSWORD
printf '%s' "$VIDEO_FACTORY_PASSWORD" | npm run --silent auth:hash
unset VIDEO_FACTORY_PASSWORD
openssl rand -hex 32
```

在服务器仓库根目录创建 `.env.docker.prod`，以 [.env.docker.prod.example](../../.env.docker.prod.example) 为模板填写：

- `VIDEO_FACTORY_AUTH_USERNAME`
- `VIDEO_FACTORY_AUTH_PASSWORD_HASH`：第一条命令输出的完整 scrypt 字符串
- `VIDEO_FACTORY_AUTH_SESSION_SECRET`：`openssl` 输出，至少 32 个字符
- 准备启用的素材、热点 Provider 配置（Codex socket 的 gid 由部署脚本自动派生，见第 2 节）

生产文件权限应为 `600`，不得提交到 Git。自托管热点按示例使用 `vf-*` 容器 DNS；这些地址只在 `video-factory-trends` 内部网络可见。

## 2. 宿主机 Codex bridge（首次部署前）

语义层由宿主机 `vf-codex` 用户下的 `apps/codex-broker` 提供。选题总编、系列主理人、编剧、视觉导演、语义选片、参考语法、视觉审片、发行编辑等角色按实际流程启用；其中需要质量判断的角色最多进行 3 轮“生产者修订 + 独立审计”，因此模型调用数取决于入口、启用节点和审计轮次，不能按每条视频固定估算。系列与自定义入口不会运行热点转译，发行编辑仅在人工终审通过后执行。应用容器只读挂载 `/run/video-factory-codex` 并经 Unix socket 调用，从不挂载 `~/.codex`，也不接收任何模型 API key。

首次初始化（root，幂等，只验证不假设）：

```bash
runuser -u vf-codex -- env HOME=/home/vf-codex /home/vf-codex/.local/bin/codex login   # 操作员手动完成
bash scripts/setup-codex-broker-host.sh
```

脚本创建显式数字 gid 的 `vf-bridge` 组（默认 22002，可用 `CODEX_BRIDGE_GID` 覆盖）、目录与 systemd 单元，按 vf-codex 自有路径优先的顺序校验 Node 22 与 `codex login status`（校验时的 PATH 与 unit 一致，因为 Codex CLI 的 shebang 依赖 `env node`）；未登录时直接失败并给出操作指引，绝不自动复制 auth。部署脚本会从 `getent group vf-bridge` 派生 gid 并导出 `VIDEO_FACTORY_CODEX_SOCKET_GID`——compose 插值中 shell 环境优先于 env-file，因此无需手改生产 env 文件。

`scripts/deploy-production.sh` 会从候选镜像原子提取 broker 制品到 `/opt/video-factory/codex-broker/releases/<时间戳>` 并翻转 `current` 符号链接，同时安装该版本的 OpenAI 与 ZAI systemd unit，再分别重启和检查两个 socket。两个 unit 都在切换前单独备份；应用、任一已配置 broker 或公共健康检查失败时，会拒绝部分可用的发布，并恢复部署前真实运行的两个 unit、broker release 与应用镜像。不能只从旧 release 取 unit，因为早期 release 尚未包含 ZAI unit。

超时与重放策略：broker 单次模型任务默认 deadline 为 300s，可由 `VIDEO_FACTORY_CODEX_TIMEOUT_MS` 显式配置；Studio 客户端 deadline 为 1260s，用于覆盖单并发队列等待和同一角色最多 3 轮的多次任务。每个已受理的 `requestId` 不会因执行期失败或超时被客户端重放；仅连接层 ENOENT/ECONNREFUSED 与 503（队列满或停机、尚未受理）会做有界重试。Agent loop 的下一轮使用新的确定性 `requestId`，并在检查点中记录候选、审计和会话，基础设施失败不会静默消耗语义审计轮次。

模型切换发生在 Studio 的角色候选池，而不是 Broker 内部暗换模型。用户为节点选择一个首选模型，其余健康且合同兼容的模型按质量、稳定性与耗时形成候选顺序；只有连接、超时、限流、容量或模型不可用才继续下一个候选。输出结构错误、业务校验失败和审计返修必须停在当前模型。每个候选使用独立请求与会话边界，最终 trace 记录尝试顺序、失败原因和实际采用模型。

systemd 加固说明：真实 `~/.codex` 整体只读；OpenAI Broker 使用 `/var/lib/video-factory-codex/codex-home` 保存 CLI 可变状态，其中 `auth.json` 只是指向真实登录凭据的只读链接。ZAI Broker 的 `ProtectSystem=strict` 保持不变，但必须允许写入 `/var/lib/video-factory-zai-codex` 与 `/run/video-factory-zai-codex`，否则模型结果虽已返回，幂等提交仍会因无法创建 `.video-factory/codex-idempotency` 而失败。应用容器只挂载两个 `/run` socket 目录，无法读取任何 Broker 状态目录或密钥。首次真实任务后仍需用 `journalctl -u vf-codex-broker -u vf-zai-codex-broker` 确认运行状态。

`codex login status` 只验证登录凭据存在，不能证明 ECS 真的能连接 OpenAI。生产部署会在切换 release 前，以 `vf-codex` 用户请求 `https://api.openai.com/v1/models`；收到任意 HTTP 响应（通常是未带 API key 的 401）即代表 TLS 出口可达，连接超时则保持旧版本不动。若 ECS 的 OpenAI 出口依赖已有 systemd 隧道，并且该隧道会在临时 `AUTH_FAILED` 后以成功状态退出，应给对应实例安装仓库内的重连策略：

```bash
sudo install -d /etc/systemd/system/openvpn-client@proton.service.d
sudo install -m 0644 deploy/systemd/vf-openai-egress-restart.conf \
  /etc/systemd/system/openvpn-client@proton.service.d/restart.conf
sudo systemctl daemon-reload
sudo systemctl restart openvpn-client@proton.service
runuser -u vf-codex -- curl -sS -o /dev/null -w '%{http_code}\n' \
  --connect-timeout 8 --max-time 15 https://api.openai.com/v1/models
```

最后一条命令预期快速返回 `401`；`000` 或超时表示 Codex 仍无法联网。重连策略只改变服务退出后的 systemd 行为，不包含账号、证书或隧道配置。

## 3. 自托管热点（推荐）

热点服务不运行语义模型，可以在同一台 ECS 上以轻量容器部署：

```bash
make setup-local-trends
```

脚本幂等创建 `video-factory-trends` 内部网络，并启动 TrendRadar、NewsNow、DailyHotApi 与 RSSHub；服务端口只发布到宿主机 `127.0.0.1`。应用通过容器 DNS 访问，浏览器不会拿到不可访问的内部跳转链接。统一信号网关当前消费 NewsNow 与 DailyHotApi，TrendRadar 和 RSSHub 提供健康与后续扩展边界。

## 4. 首次启动与健康检查

完成第 2 节的宿主机初始化后再执行部署。下面的手工命令只允许首次 bootstrap；后续正式发布必须由 GitHub Actions 传入精确 `RELEASE_SHA`，部署脚本会核对当前 detached worktree 的提交，不能从服务器工作区直接绕过发布流程。部署脚本也会拒绝在缺少 `vf-bridge` 组时启动。

```bash
VIDEO_FACTORY_DEPLOYMENT_MODE=bootstrap bash scripts/deploy-production.sh
curl --fail http://127.0.0.1:4317/api/health
docker inspect --format '{{.State.Health.Status}}' video_factory_prod
```

部署脚本会在旧容器继续服务时构建候选镜像，切换后轮询健康端点；失败时恢复上一镜像并回滚上一个 broker release。再次部署前会备份轻量 JSON 工作流状态，视频与音频不重复备份。脚本不做“排空运行中制作”的等待：`/api/runs` 受登录会话保护而部署不持有凭据；被中断的 run 会显式标记失败并可重新发起。

## 5. 接入子域名和 TLS

在阿里云 DNS 为 `video.wangjinkun333.me` 添加 `A` 记录，指向 ECS 公网 IP。该记录复用现有域名，不产生新的域名购买费用。

DNS 生效后在服务器执行：

```bash
sudo cp deploy/nginx/video.wangjinkun333.me.conf /etc/nginx/sites-available/video.wangjinkun333.me
sudo ln -s /etc/nginx/sites-available/video.wangjinkun333.me /etc/nginx/sites-enabled/video.wangjinkun333.me
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d video.wangjinkun333.me
```

中国大陆 ECS 的域名必须先完成有效 ICP 备案。若 HTTP 返回 `Server: Beaver` 和 `Non-compliance ICP Filing`，这是阿里云在实例外层的合规拦截，Nginx 与 Certbot 都无法绕过；完成备案后再签发证书。

最后验证：

```bash
curl --fail https://video.wangjinkun333.me/api/health
```

## 6. GitHub Actions Secrets

仓库 `Settings -> Secrets and variables -> Actions` 需要：

| Secret | 值 |
| --- | --- |
| `SERVER_HOST` | ECS 公网 IP |
| `SERVER_USER` | SSH 用户 |
| `SSH_PRIVATE_KEY` | 可登录 ECS 的私钥 |
| `PROJECT_PATH` | 服务器仓库绝对路径，例如 `/root/work_space/video-factory` |
| `PUBLIC_HEALTH_URL` | TLS 完成后填写 `https://video.wangjinkun333.me/api/health` |

Pull Request 只执行验证；`main` 推送通过测试和依赖审计后才会自动部署。建议为 GitHub `production` Environment 增加保护规则。

## 7. 数据、能力与已知边界

- 工作区保存在 Docker named volume `video_factory_workspace`，重建容器不会丢失。
- 自动备份只覆盖工作流 JSON 状态；正式生产需要再把成片和素材同步到 OSS，并配置生命周期策略。
- 镜像内置 Python、Pillow、FFmpeg、ffprobe 和 Noto CJK 字体。
- Linux 镜像没有 macOS `say`；配置 `MINIMAX_API_KEY` 后使用 MiniMax 云端声音演员，未配置时测试音轨不应作为正式配音交付。
- 热点服务适合独立容器或独立进程；Codex 语义层以宿主机 systemd 服务运行（见第 2 节），与 Web 镜像解耦。
