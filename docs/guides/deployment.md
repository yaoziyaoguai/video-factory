# 发布 Frame 到服务器

`main` 是 Frame 的正式分支。[旧版](https://github.com/yaoziyaoguai/video-factory/tree/legacy/pre-video-agent)保留原工作台及其完整部署方式。个人会话、模型 Key、媒体文件及本地执行报告都不随 Git 发布。

## 从 main 到线上

[CI/CD 工作流](../../.github/workflows/ci-cd.yml)在功能分支手动触发或面向 main 的 PR 中验证完整候选，合入 main 后对最终 SHA 再验证并部署。原有契约、测试、依赖检查保留；系统与字体依赖收敛为按内容哈希标签的[稳定基础镜像](../../docker/base.Dockerfile)，CI 命中远端标签时直接拉取复用，保证层摘要稳定。同一 SHA 在其上构建 `video-factory:release-<SHA>` 和 `frame-creative:release-<SHA>` 两个 Linux amd64 镜像，记录实际 image ID，运行正式应用、原生 UDS 和恢复预演。

配置 `ACR_REGISTRY`、`ACR_NAMESPACE`、`ACR_USERNAME`、`ACR_PASSWORD` 四个 secret 后启用[阿里云 ACR](https://www.alibabacloud.com/product/container-registry) 分层运输：验证通过即推送基础（仅新哈希时）、app 与 creative 镜像，ECS 用[拉取脚本](../../scripts/acr-pull-frame.sh)从同区域 ACR 按层增量拉取并还原本地发布标签，常规发布只传输业务层；随后照旧执行发布脚本完成原子切换，镜像 ID 仍对照 `frame-release.json` 清单核对。密码不进部署命令行：CI 以 0600 文件经 scp 送达 ECS，拉取脚本从文件读取并在结束时清理。四个 secret 缺任一个时自动退回原路径：双镜像 tar 与清单、同 SHA Git bundle 经 scp 传至 ECS 后 `docker load`。两种运输都不在 ECS 重新安装 npm 或构建；运输内容只含两个明确的 release 标签，不携带创作固定别名，避免提前影响运行中的 runner。

GitHub 的 `production` 环境使用既有 `SERVER_HOST`、`SERVER_USER`、`SSH_PRIVATE_KEY`、`PROJECT_PATH` 和 `PUBLIC_HEALTH_URL`。健康地址应为站点的公开 HTTPS 地址，例如 `https://video.example.com/api/health`。服务器已有 Git 工作副本、Docker Compose、反向代理和站点证书；首次安装另需创建 `video-factory_video_factory_workspace` 卷和 `video-factory-trends` 外部网络，卷根应可由 uid/gid 1001 写入。外部只暴露反向代理，应用端口绑定 127.0.0.1:4317。代理需要对 SSE 禁用响应缓冲。

服务器的 `$PROJECT_PATH/.env.docker.prod`（权限 0600）保存登录配置；变量名见 [环境示例](../../.env.docker.prod.example)。模型与免费服务在已登录的设置页配置，数据持久化在卷内 `/data/factory/agent`。不要把本机 loopback、真实服务 Key 或工作站数据库提交进 Git。

国内选题榜单按需使用 NewsNow。可复用已有实例；如需同机运行，用 `make setup-local-trends` 启动，生产容器在同一 Docker 网络时填写 `http://vf-newsnow:4444`。宿主机运行的 Frame 可填 `http://127.0.0.1:4444`，独立服务器则填它自己的可达地址。在「免费服务 → 视频选题」选择榜单并允许 Agent 使用。该命令只管理 NewsNow，不会拉起旧抓取服务；正式发布不会自动开启、替换或覆盖这个配置。

NewsNow 出网默认拒绝环回、内网与云元数据地址。同网（`http://vf-newsnow:4444`）或宿主机（`http://127.0.0.1:4444`）这类私网 origin 需运维在 Web 进程环境显式授权：`.env.docker.prod` 设置 `NEWSNOW_ALLOWED_ORIGINS=http://vf-newsnow:4444`（多个用逗号分隔，条目必须是纯 http(s) origin）。保存配置与实际请求共用这份授权目标；未列出的地址维持原有私网限制。本机联调也可用 `STUDIO_DEV=1` 整体放行。

## 切换、验证与恢复

[发布脚本](../../scripts/deploy-frame.sh)在既有远端 release lock 内核对清单的 SHA、架构、双 image ID 和标签，检查宿主与 Compose 配置。每次部署使用包含 `DEPLOY_RUN` 的独立 Compose 项目名；即使 SHA 相同，也不会由旧项目标签接管被保留的原容器。

切换前只在本应用 Nginx `location /` 中临时加载[维护 include](../../docker/frame-maintenance.nginx.conf)，拒绝外部修改请求，保留真实健康和只读访问。脚本核实 POST 被隔离、没有 queued/running 请求与制作，再正常停止旧应用，并用只读挂载原卷的短进程复核：将停机后的 `agent.db` 与现存 WAL 复制到该容器的私有 tmpfs，再读取队列。SQLite 可以在副本旁重建 WAL 辅助文件，原卷始终只读，尚在 WAL 中的排队记录仍参与检查。活动任务不会被部署脚本取消。无写入后才备份持久卷、保存原 runner 配置、实际运行 image ID、固定别名和成功标记；创作卷记录完整清单，本轮仅新探针工程会写入，不复制无关历史工程。

随后安装同 SHA host runner/服务、受控切换创作别名、加载生产 Compose 与 creative overlay，启动候选并按现有迁移升级数据。恢复 trap 仍生效时，从**正在运行的正式 app**调用编译后的 `CreativeRunner` 和 Pi Operations，核实真实写读、PNG、两秒 MP4 解码及隔离；不启动第二个 main，不调用模型或媒体供应商，也不写正式对话库。只有正式 app 的镜像、UID、真实 socket 配置与只读挂载、runner image ID、数据库版本与候选镜像迁移定义一致（本版为24）、本地/公开 health、匿名设置401和工作台静态入口全部通过，才提交成功标记并恢复外部写入。探针新卷按本次准确清单清理。登录后 UI、模型配置与实际供应商效果分别验证，不能用健康200代替。

```sh
curl -fsS https://video.example.com/api/health
docker ps --filter name=video_factory_prod
```

发布失败会保留私有备份在 `/var/backups/video-factory/frame-<run>-<attempt>/`。恢复时先停候选，移走失败的 Agent 目录后从完整快照还原本次实际写入的 `agent` 范围；保留的旧容器以原 ID 和原 health 条件重开。runner 脚本、unit、active/enabled 和固定别名分别恢复：若原运行 ID 与原别名不同，先按原运行 ID 启动并核对回执，再还原别名；原本没有 runner 则撤销本次新增服务和别名。备份尚未完成不覆盖数据，恢复任一步失败保留入口隔离并明确报错。成功标记提交后的入口恢复故障只修入口，不再用旧快照覆盖新版数据。SSH 排查先核对 Actions 失败步骤和私有备份；不公开环境文件或用户内容。

CI 在独占可销毁 Linux VM 中调用同一个发布脚本，经真实 HTTPS 转发验证成功切换和单次验收失败后的恢复。旧发布源码镜像真实建立 schema18，再迁移到候选定义的最新版本后恢复旧快照，证明对应旧源码的数据兼容性；这不代表重建镜像与原线上镜像逐字节相同。同 SHA 补线和已有 runner 恢复另有场景，不能用同一镜像改标签充当跨版本证明。

若在运行一段时间后决定手动回退，先停新写入并另作一次备份，再选择要恢复的版本与数据时间点；直接恢复旧数据库会丢掉上线后的新创作。仅重新启动旧代码不能撤销数据迁移。

## 创作宿主服务与稳定工作卷

主应用始终以 uid/gid1001 运行，仅通过 `/run/frame-creative/runner.sock` 访问窄创作接口，没有 Docker socket。宿主的 [frame-creative.service](../../docker/frame-creative.service) 只管理既有 [creative-runner-host.mjs](../../scripts/creative-runner-host.mjs)，采用已核实的1001服务身份和 Docker socket 组，使用 Node22、Docker CLI 的实际绝对路径。生产缺少 Node22 时先独立安装受支持版本，不替换无关系统运行时；1001被无关账号占用时停止切换，不改账号、不放宽权限。

默认安装脚本为 `/opt/frame-creative/creative-runner-host.mjs`，工程根为 `/var/lib/frame-creative`，宿主 socket 父目录为 `/var/lib/frame-creative/runtime`（1001:1001、0700），socket为0600。该父目录持久保留，由部署安装准备，systemd 不创建或删除它；重启 runner 后原应用 bind mount 仍可连接。Compose 使用 [creative overlay](../../docker/creative.compose.yml)，只读挂载已存在的父目录，`create_host_path: false`。

原 runner 存在时沿用其真实 `workspaceRoot`；卷 namespace 始终为 `frame-creative-<sha256(realpath(workspaceRoot))前12位>`，不能随发布 SHA 或临时目录变动。runner 在启动时捕获固定创作别名 `frame-creative:pi-1.5-v1` 的实际 ID，后续容器按该 ID 执行；改标签本身不代表 runner 已升级。创作容器仍禁网、只读根、非 root，且没有模型 Key、应用数据或 Docker socket。

如实际路径不同，可在部署进程中显式指定 `FRAME_CREATIVE_NODE`、`FRAME_CREATIVE_WORKSPACE_ROOT`、`FRAME_CREATIVE_SOCKET_DIRECTORY`、`FRAME_CREATIVE_DOCKER_SOCKET`；`FRAME_NGINX_SITE` 指向本应用现有 Nginx 配置。默认 User/Group 为 `frame-creative`；`FRAME_CREATIVE_USER/GROUP` 仅用于已核实合适的1001服务身份，CI 显式复用其临时 VM 的1001身份，不修改 Actions runner 账号。以上是宿主安装参数，不把完整应用环境传给创作 runner。

## 免费配音运行环境

正式镜像在构建时依据 [edge-tts-requirements.txt](../../docker/edge-tts-requirements.txt) 安装维护版 `edge-tts==7.3.1` 到 `/opt/frame-tts`，镜像 PATH 中的 `python3` 指向该 venv。运行时仍为 uid/gid 1001、只读根文件系统；客户端不在运行时安装。在线配音在可信应用宿主执行，不将网络、密钥或 Docker socket 交给 Skill 的创作容器。

本地使用同一安装定义，在仓库根目录建立独立环境：

```sh
python3 -m venv .local/edge-tts
.local/edge-tts/bin/python3 -m pip install -r docker/edge-tts-requirements.txt
.local/edge-tts/bin/python3 -I -c 'import edge_tts; import importlib.metadata; print(importlib.metadata.version("edge-tts"))'
```

在「免费服务 → 配音 → 配置 → 运行设置」填写该解释器的绝对路径，或由管理员将其 venv 的 `bin` 加入应用 PATH 后保留 `python3`。这里是可执行文件名/路径，不是带参数的 shell 命令；实际启动为 `pythonCommand -I -c <内嵌驱动>`，不能依赖用户 site-packages。不要迁移开发机绝对路径。保存与启用只登记配置，不会联网合成；缺依赖或调用失败会明确报错，不转用付费配音。

驱动通过客户端公开 `proxy` 参数沿 `HTTPS_PROXY → https_proxy → HTTP_PROXY → http_proxy` 选路，`NO_PROXY` 优先于 `no_proxy`，命中客户端实际目标主机时直连。只设 `HTTPS_PROXY` 也适用于语音 WebSocket；不能仅凭客户端的 `trust_env` 推断这一点。未配置代理变量时走宿主默认路由，此状态不证明服务器 VPN 出口可用。客户端依赖与隔离启动、代理参数消费、真实外部合成和试听效果应分别验证；免费在线服务没有官方 SLA。

## 阿里云出口：按真实目标分流

现有 ECS 的 OpenVPN 隧道在宿主机，容器使用宿主路由。生产环境的 `FRAME_HTTP_PROXY`、`FRAME_HTTPS_PROXY` 默认留空，不把所有请求交给同一个 HTTP 代理。

应用在加载 Pi SDK 后按 `HTTP_PROXY` / `HTTPS_PROXY`（兼容小写）初始化 HTTP 代理，并遵循 `NO_PROXY`。只设置 `NODE_USE_ENV_PROXY=1` 不足以保留代理，因为 Pi 的网络依赖会替换 Node 的初始 dispatcher。代理变量留空时仍由宿主路由出网，无需为 ECS 填入开发电脑的代理地址。

| 实际目的地 | 路径 |
| --- | --- |
| OpenAI API（文本、图片、语音、Web Search）、Pexels、Wikimedia、FreeToUse、Incompetech | 境外出口。OpenAI 的流式请求及语音 WebSocket 使用同一 API 域名。 |
| 火山方舟北京、百炼大陆、MiniMax 中国站，以及已核实的国内媒体下载域名 | 阿里云物理出口直连。不要把同一品牌的国际站一起归为国内。 |
| 同机 NewsNow 等热点服务 | `video-factory-trends` 内网，用配置的服务地址。 |
| 抖音与 TikTok 榜单 | 按实际榜源路由：Frame 访问 DataXAPI 和 Kabo；中文榜单不表示请求一定发往国内平台服务器。 |

接口和媒体下载可能使用不同 CDN。现有国内域名清单在 [domestic-service-hosts.txt](../../scripts/domestic-service-hosts.txt)，宿主定时用 [刷新脚本](../../scripts/refresh-domestic-routes.py)补充解析结果。对新下载域名，先从容器确认域名、由宿主按容器来源核实出口，再决定是否加入清单；不要将所有阿里云 OSS、国际 CDN 或整个供应商品牌硬编码成一条线路。VPN 配置、节点、凭据不进入仓库。未带 Key 的探测能证实连通性，不能证实模型额度或一次真实生成。
