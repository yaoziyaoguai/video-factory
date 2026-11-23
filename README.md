# 帧间 Frame · Video Agent

帧间是一个用对话做视频的桌面 Web 工作台。你可以先聊选题、问提示词、找素材，在同一段对话里做几条不同的视频。你明确开始创作后，Frame 才会引导你把一个想法做成作品。

1. 给出目标，和 Agent 讨论内容。每一步产生的脚本、画面与声音方案、片段或视频先放在草稿区。
2. 看稿、提意见、选定具体版本。只有你认可的内容进入确认区；认可方案可以暂不制作。
3. 免费本地制作按你明确提出的范围执行；付费制作先展示提案、估价与范围，确认本次预算后执行。制作冻结输入版本，换型号、继续聊天都不会改写这次任务。
4. 生成的视频先供预览。比较版本时，可以打开正在播放的版本对应的制作记录。满意后明确“定稿并入库”，可找到视频、对应文稿、实际采用的素材与制作工程，并回到原对话。满意的短预览也可以直接采用原文件定稿。

以仍为当前稿的同类产物为基准，再次本地制作会在同一事项中接续版本。旧稿、认可和定稿记录仍可查看。作品库标明素材的实际来源版本，带回历史素材时会引用那一版。代码工程的已知输入文件过大时，会在开工前提示换用较小文件。

## 本地运行

需要 **Node.js 22.23.1**（或兼容的 22 LTS）、npm；媒体处理使用 `ffmpeg` 和 `ffprobe`。首次安装原生依赖时可能需要 Python 3 与 C++ 构建工具。

```sh
npm ci
npm run studio:build
STUDIO_DEV=1 STUDIO_HOST=127.0.0.1 STUDIO_PORT=4478 npm run studio:start
```

浏览器打开 [本机工作台](http://127.0.0.1:4478/agent)。首次在「模型配置」填写你自己的连接，按文本、图片、视频、配音选择当前型号。可在「免费服务」启用素材、音乐和选题来源，在「Skill 管理」安装或移除扩展。聊天需要已配置的文本模型；付费媒体需要相应型号与本次制作授权。空数据库不会带入任何人的密钥、会话或素材。

想看最近适合拍什么，在「免费服务 → 视频选题」配置国内平台榜单：填入可访问的 NewsNow 地址，选用抖音、快手和 B 站预设并保存。想在本机运行榜单服务时，先启动 Docker，再运行 `make setup-local-trends`，宿主机上的 Frame 可以使用 `http://127.0.0.1:4444`（本机地址属私网边界，需要 `STUDIO_DEV=1` 或 `NEWSNOW_ALLOW_PRIVATE_NETWORK=1` 显式放行）。然后可以在聊天里问：“看下抖音和 B 站，给我三个能在家拍的选题，附上参考视频或话题链接。”只聊选题不会开始制作。

默认数据目录是 `workspace/factory/agent/`。设置 `AGENT_DATA_DIR` 可将数据库、Pi 会话和媒体放在其他持久目录。开发模式仅在本机使用；服务器部署使用登录和 HTTPS。

服务端可用的相关环境变量：

- `AGENT_EDGE_TTS_PYTHON`：免费配音（edge-tts 维护版客户端）的 Python 解释器命令，默认 `python3`；容器镜像内已指向专用虚拟环境。命令只来自服务端环境，设置页不再提供可写的解释器入口。
- `NEWSNOW_ALLOW_PRIVATE_NETWORK=1`：允许 NewsNow 地址指向环回、内网或链路本地段（保存与请求前都会校验，含云元数据地址）。仅本机联调使用。
- `STUDIO_DEV=1`：开发模式，同样放行上述私网地址，并启用本地开发用的入口行为。
- `STUDIO_TRUST_PROXY`：受信任的反向代理地址（IP 或 CIDR，逗号分隔），决定是否采信 `X-Forwarded-For` 以取真实客户端 IP（登录限流按它计数）。默认 `127.0.0.1`，适配裸机/systemd 直反代；Docker Compose 发布端口时容器内对端是网桥网关，生产编排已默认放行 `172.16.0.0/12`。

## 发布到阿里云

面向 `main` 的 PR 由 [GitHub Actions](.github/workflows/ci-cd.yml) 验证。合入后，Actions 对最终提交运行测试、构建应用和创作镜像，并完成 Linux 容器预演，再把该提交对应的镜像部署到阿里云 ECS。部署完成后，可通过站点 `/api/health` 的 `release` 字段核对上线提交。生产配置、备份和回滚方法见[部署手册](docs/guides/deployment.md)。

## 文档与验证

| 我想了解 | 入口 |
| --- | --- |
| 对话、草稿、确认与作品库如何配合 | [产品与交互设计](docs/agent/product-design.md) · [界面规范](DESIGN.md) |
| Pi 与业务服务的职责、存储和制作流程 | [架构设计](docs/agent/architecture.md) |
| HTTP、事件流、类型和工具边界 | [接口索引](contracts/agent/v1/IMPORT.md) · [OpenAPI](contracts/agent/v1/openapi.json) · [JSON Schema](contracts/agent/v1/contracts.schema.json) |
| GitHub Actions、生产配置、备份与回滚 | [部署手册](docs/guides/deployment.md) |
| 查询已退役的 Video Factory 架构 | [历史架构存档](https://github.com/yaoziyaoguai/video-factory/tree/74a4580eff12e3a62ad78f8613cfb8efa0f4ee83/docs/过期文档) |

`npm run contracts:check` 离线检查接口、样例与生成类型。`npm test` 运行仓库测试；只验工作台可在构建后运行 `npm run test:agent --workspace @video-factory/studio`。这些测试不需要真实模型凭据。

构建后运行 `npm run perf:frame`。同一台环回离线服务交替提供原始和 Brotli 静态资源，浏览器每次使用独立上下文并记录实际响应编码。首屏采样 10 对，发送采样 40 对。原始数据和两侧的截图在 `perf/.local/`。使用现有 Playwright 环境时，通过 `PLAYWRIGHT_MODULE_PATH` 指定模块目录，通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定 Chrome 或 Chromium 可执行文件。
