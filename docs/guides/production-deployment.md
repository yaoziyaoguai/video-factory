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
    ├── Nginx :80/:443
    │     └── video.wangjinkun333.me -> 127.0.0.1:4317
    └── Docker
          └── video_factory_prod -> named volume /data/factory
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
- 准备启用的素材、热点或模型 Provider 配置

生产文件权限应为 `600`，不得提交到 Git。容器内的 `127.0.0.1` 指容器自身；访问宿主机服务时使用 `host.docker.internal`。

## 2. 首次启动与健康检查

```bash
bash scripts/deploy-production.sh
curl --fail http://127.0.0.1:4317/api/health
docker inspect --format '{{.State.Health.Status}}' video_factory_prod
```

部署脚本会在旧容器继续服务时构建候选镜像，切换后轮询健康端点；失败时恢复上一镜像。再次部署前会备份轻量 JSON 工作流状态，视频与音频不重复备份。

## 3. 接入子域名和 TLS

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

## 4. GitHub Actions Secrets

仓库 `Settings -> Secrets and variables -> Actions` 需要：

| Secret | 值 |
| --- | --- |
| `SERVER_HOST` | ECS 公网 IP |
| `SERVER_USER` | SSH 用户 |
| `SSH_PRIVATE_KEY` | 可登录 ECS 的私钥 |
| `PROJECT_PATH` | 服务器仓库绝对路径，例如 `/root/work_space/video-factory` |
| `PUBLIC_HEALTH_URL` | TLS 完成后填写 `https://video.wangjinkun333.me/api/health` |

Pull Request 只执行验证；`main` 推送通过测试和依赖审计后才会自动部署。建议为 GitHub `production` Environment 增加保护规则。

## 5. 数据、能力与已知边界

- 工作区保存在 Docker named volume `video_factory_workspace`，重建容器不会丢失。
- 自动备份只覆盖工作流 JSON 状态；正式生产需要再把成片和素材同步到 OSS，并配置生命周期策略。
- 镜像内置 Python、Pillow、FFmpeg、ffprobe 和 Noto CJK 字体。
- Linux 镜像没有 macOS `say`。未安装 Kokoro 或配置外部 TTS 时只有测试音轨，不应当作正式配音交付。
- 热点服务、Ollama 和 Kokoro 适合独立容器或独立进程，不与 Web 镜像耦合；它们可以通过统一 Provider 配置逐步接入。
