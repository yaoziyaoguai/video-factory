# 帧间 Frame · Video Agent

帧间是一个用对话做视频的桌面 Web 工作台。你可以先聊选题、问提示词、找素材，在同一段对话里做几条不同的视频。你明确开始创作后，Frame 才会引导你把一个想法做成作品。

1. 给出目标，和 Agent 讨论内容。每一步产生的脚本、画面与声音方案、片段或视频先放在草稿区。
2. 看稿、提意见、选定具体版本。只有你认可的内容进入确认区；认可方案可以暂不制作。
3. 要制作时查看提案、估价与范围，确认本次预算后后台执行。制作使用已确认版本，换型号、继续聊天都不会改写这次任务。
4. 生成的视频先供预览。你确认成片后，可从作品库找到视频、对应文稿与原对话。

## 本地运行

需要 **Node.js 22.23.1**（或兼容的 22 LTS）、npm；媒体处理使用 `ffmpeg` 和 `ffprobe`。首次安装原生依赖时可能需要 Python 3 与 C++ 构建工具。

```sh
npm ci
npm run studio:build
STUDIO_DEV=1 STUDIO_HOST=127.0.0.1 STUDIO_PORT=4478 npm run studio:start
```

浏览器打开 [本机工作台](http://127.0.0.1:4478/agent)。首次在「模型配置」填写你自己的连接，按文本、图片、视频、配音选择当前型号。可在「免费服务」启用素材、音乐和资讯来源，在「Skill 管理」安装或移除扩展。聊天需要已配置的文本模型；付费媒体需要相应型号与本次制作授权。空数据库不会带入任何人的密钥、会话或素材。

默认数据目录是 `workspace/factory/agent/`。设置 `AGENT_DATA_DIR` 可将数据库、Pi 会话和媒体放在其他持久目录。开发模式仅在本机使用；服务器部署使用登录和 HTTPS。

## 文档与验证

| 我想了解 | 入口 |
| --- | --- |
| 对话、草稿、确认与作品库如何配合 | [产品与交互设计](docs/agent/product-design.md) · [界面规范](DESIGN.md) |
| Pi 与业务服务的职责、存储和制作流程 | [架构设计](docs/agent/architecture.md) |
| HTTP、事件流、类型和工具边界 | [接口索引](contracts/agent/v1/IMPORT.md) · [OpenAPI](contracts/agent/v1/openapi.json) · [JSON Schema](contracts/agent/v1/contracts.schema.json) |
| GitHub Actions、生产配置、备份与回滚 | [部署手册](docs/guides/deployment.md) |
| 查询已退役的 Video Factory 架构 | [过期文档](docs/过期文档/README.md) |

`npm run contracts:check` 离线检查接口、样例与生成类型。`npm test` 运行仓库测试；只验工作台可在构建后运行 `npm run test:agent --workspace @video-factory/studio`。这些测试不需要真实模型凭据。
