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
    │     └── /run/video-factory-codex/worker.sock 0660 vf-codex:vf-bridge
    ├── Nginx :80/:443
    │     └── video.wangjinkun333.me -> 127.0.0.1:4317
    └── Docker
          └── video_factory_prod -> named volume /data/factory
                └── 只读挂载 /run/video-factory-codex，经 Unix socket 调用 Codex（不挂载 ~/.codex）
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

生产文件权限应为 `600`，不得提交到 Git。容器内的 `127.0.0.1` 指容器自身；访问宿主机服务时使用 `host.docker.internal`。

## 2. 宿主机 Codex bridge（首次部署前）

语义层由宿主机 `vf-codex` 用户下的 `apps/codex-broker` 提供，覆盖选题总编、编剧、视觉导演与发行编辑四个角色——一条热点视频最多四次 Codex 调用（系列与自定义入口跳过选题总编；发行编辑仅在人工终审通过后执行；任务受理后至多执行一次，受订阅配额约束）；应用容器只读挂载 `/run/video-factory-codex` 并经 Unix socket 调用，从不挂载 `~/.codex`，也不接收任何模型 API key。

首次初始化（root，幂等，只验证不假设）：

```bash
runuser -u vf-codex -- env HOME=/home/vf-codex /home/vf-codex/.local/bin/codex login   # 操作员手动完成
bash scripts/setup-codex-broker-host.sh
```

脚本创建显式数字 gid 的 `vf-bridge` 组（默认 22002，可用 `CODEX_BRIDGE_GID` 覆盖）、目录与 systemd 单元，按 vf-codex 自有路径优先的顺序校验 Node 22 与 `codex login status`（校验时的 PATH 与 unit 一致，因为 Codex CLI 的 shebang 依赖 `env node`）；未登录时直接失败并给出操作指引，绝不自动复制 auth。部署脚本会从 `getent group vf-bridge` 派生 gid 并导出 `VIDEO_FACTORY_CODEX_SOCKET_GID`——compose 插值中 shell 环境优先于 env-file，因此无需手改生产 env 文件。

`scripts/deploy-production.sh` 会从候选镜像原子提取 broker 制品到 `/opt/video-factory/codex-broker/releases/<时间戳>` 并翻转 `current` 符号链接，随后重启 `vf-codex-broker` 并做 socket 健康检查；应用或公共健康检查失败时同时回滚应用镜像与上一个 broker release。

超时与重放策略：broker 任务 deadline 为 285s，先于容器侧统一的 330s 客户端 deadline；任务一旦被受理，任何执行期失败（含超时）都返回 422 且客户端不重放——任务至多执行一次。仅连接层 ENOENT/ECONNREFUSED 与 503（队列满/停机，未受理）会做有界重试。已知边界：排队等待计入客户端 330s deadline，饱和时客户端可能放弃仍在排队的任务（同样不重放）。

systemd 加固说明：`~/.codex` 只读，仅 `sessions`、`log` 两个子目录可写（配合 `--ephemeral`）。这是未在本仓库证实的妥协——首次真实任务后用 `journalctl -u vf-codex-broker` 确认；若 CLI 触及其他 home 写入，unit 会以 EPERM 响亮失败而非静默降级。

## 3. 首次启动与健康检查

完成第 2 节的宿主机初始化后再执行部署；部署脚本会拒绝在缺少 `vf-bridge` 组时启动。

```bash
bash scripts/deploy-production.sh
curl --fail http://127.0.0.1:4317/api/health
docker inspect --format '{{.State.Health.Status}}' video_factory_prod
```

部署脚本会在旧容器继续服务时构建候选镜像，切换后轮询健康端点；失败时恢复上一镜像并回滚上一个 broker release。再次部署前会备份轻量 JSON 工作流状态，视频与音频不重复备份。脚本不做“排空运行中制作”的等待：`/api/runs` 受登录会话保护而部署不持有凭据；被中断的 run 会显式标记失败并可重新发起。

## 4. 接入子域名和 TLS

在阿里云 DNS 为 `video.wangjinkun333.me` 添加 `A` 记录，指向 ECS 公网 IP。该记录复用现有域名，不产生新的域名购买费用。

DNS 生效后在服务器执行：

```bash
sudo cp deploy/nginx/video.wangjinkun333.me.conf /etc/nginx/sites-available/video.wangjinkun333.me
sudo ln -s /etc/nginx/sites-available/video.wangjinkun333.me /etc/nginx/sites-enabled/video.wangjinkun333.me
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d video.wangjinkun333.me
```

最后验证：

```bash
curl --fail https://video.wangjinkun333.me/api/health
```

## 5. GitHub Actions Secrets

仓库 `Settings -> Secrets and variables -> Actions` 需要：

| Secret | 值 |
| --- | --- |
| `SERVER_HOST` | ECS 公网 IP |
| `SERVER_USER` | SSH 用户 |
| `SSH_PRIVATE_KEY` | 可登录 ECS 的私钥 |
| `PROJECT_PATH` | 服务器仓库绝对路径，例如 `/root/work_space/video-factory` |
| `PUBLIC_HEALTH_URL` | TLS 完成后填写 `https://video.wangjinkun333.me/api/health` |

Pull Request 只执行验证；`main` 推送通过测试和依赖审计后才会自动部署。建议为 GitHub `production` Environment 增加保护规则。

## 6. 数据、能力与已知边界

- 工作区保存在 Docker named volume `video_factory_workspace`，重建容器不会丢失。
- 自动备份只覆盖工作流 JSON 状态；正式生产需要再把成片和素材同步到 OSS，并配置生命周期策略。
- 镜像内置 Python、Pillow、FFmpeg、ffprobe 和 Noto CJK 字体。
- Linux 镜像没有 macOS `say`；生产环境正式配音需接入外部 TTS Provider，测试音轨不应作为正式配音交付。
- 热点服务适合独立容器或独立进程；Codex 语义层以宿主机 systemd 服务运行（见第 2 节），与 Web 镜像解耦。
