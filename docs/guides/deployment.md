# 发布 Frame 到服务器

`main` 是 Frame 的正式分支。[旧版](https://github.com/yaoziyaoguai/video-factory/tree/legacy/pre-video-agent)保留原工作台及其完整部署方式。个人会话、模型 Key、媒体文件及本地执行报告都不随 Git 发布。

## 从 main 到线上

[CI/CD 工作流](../../.github/workflows/ci-cd.yml)在合入 main 和手动触发时先运行契约、测试与依赖检查，构建 Linux 镜像，再断网以非 root 用户启动正式程序，检查登录、内置 Skill 与工作台。通过后，将**同一个镜像**与该提交的 Git bundle 传至 ECS；服务器不需要联网克隆 GitHub 或重新安装 npm 包。

GitHub 的 `production` 环境使用既有 `SERVER_HOST`、`SERVER_USER`、`SSH_PRIVATE_KEY`、`PROJECT_PATH` 和 `PUBLIC_HEALTH_URL`。健康地址应为站点的公开 HTTPS 地址，例如 `https://video.example.com/api/health`。服务器已有 Git 工作副本、Docker Compose、反向代理和站点证书；首次安装另需创建 `video-factory_video_factory_workspace` 卷和 `video-factory-trends` 外部网络，卷根应可由 uid/gid 1001 写入。外部只暴露反向代理，应用端口绑定 127.0.0.1:4317。代理需要对 SSE 禁用响应缓冲。

服务器的 `$PROJECT_PATH/.env.docker.prod`（权限 0600）保存登录配置；变量名见 [环境示例](../../.env.docker.prod.example)。模型与免费服务在已登录的设置页配置，数据持久化在卷内 `/data/factory/agent`。热点服务的地址按服务器上的实际部署填写。不要把本机 loopback、真实服务 Key 或工作站数据库提交进 Git。

## 切换、验证与恢复

[发布脚本](../../scripts/deploy-frame.sh)先检查候选镜像标记和当前服务是否空闲。它正常停止旧容器、将其保留在服务器，完整备份持久卷并校验压缩文件，然后启动新版。不会为校验发起付费生成。

发布成功需同时满足：容器本地和公开 `/api/health` 返回 `product=frame` 与目标 commit；公开 `/agent` 返回工作台，匿名访问模型设置为 HTTP 401。登录后的实际生成还取决于服务器自己的模型连接、网络和额度。

```sh
curl -fsS https://video.example.com/api/health
docker ps --filter name=video_factory_prod
```

发布失败会保留私有备份在 `/var/backups/video-factory/frame-<run>-<attempt>/`，自动尝试恢复原容器。新版本若已修改 Agent 数据，会先保留失败现场，再取回升级前的 Agent 数据。SSH 排查先核对 Actions 的失败步骤、健康接口的版本与容器状态；原始服务器环境文件和含用户内容的日志不应贴到公开 issue。

若在运行一段时间后决定手动回退，先停新写入并另作一次备份，再选择要恢复的版本与数据时间点；直接恢复旧数据库会丢掉上线后的新创作。仅重新启动旧代码不能撤销数据迁移。
