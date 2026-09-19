# GitHub Actions 生产发布

## 发布路径

本地验证并提交后，普通推送到 `main`。主分支保护禁止强推与删除，单人维护不强制 PR 审批。`.github/workflows/ci-cd.yml` 的 `verify` 与 `security` 必须全部通过，才能执行 `deploy`；也可对 `main` 手动运行同一工作流，仍经过全部检查。

Actions 的 `production` 环境使用仓库 Secrets：`SERVER_HOST`、`SERVER_USER`、`SSH_PRIVATE_KEY`、`PROJECT_PATH`、`PUBLIC_HEALTH_URL`。不要把这些值写进公开文档或日志。

服务器获取本次提交的精确 SHA，在独立、干净的 `.release` 工作树构建；不覆盖开发工作树，不允许脏发布目录混入制品。

## 已有 ECS 的升级前提

- Docker Compose、共享 Node 22+、`vf-bridge` 组与现有 Studio 工作区已初始化。
- `vf-deepseek-codex` 服务用户存在，能运行 `/opt/video-factory/codex-broker/bin/node`。
- `/etc/video-factory/deepseek-codex-broker.env` 为 `root:root`、权限 `0600`，包含有效的 `DEEPSEEK_API_KEY`；配置只能经受控通道写入，不能通过 Git 分发。
- Studio 使用项目目录下现有 `.env.docker.prod`，其登录配置和媒体服务配置不因发布被覆盖。Unsplash 可选变量为 `UNSPLASH_ACCESS_KEY`。
- 服务器有构建和工作区备份空间。不要为了腾空间删除用户媒体、数据库或其他项目文件。

从旧 OpenAI/智谱生产环境升级时，只预备 DeepSeek 用户与凭据；不要对旧 broker 制品提前启动 DeepSeek。真正的制品与 systemd unit 切换由部署脚本执行。

## 验证与回滚

部署先验证 DeepSeek 鉴权可达（只读模型目录，不生成内容），备份既有工作区，再构建候选镜像及同版本 broker。依次检查 DeepSeek 协议、身份、任务能力、Studio 本地健康和公开健康地址。

切换失败时恢复旧 broker 制品、服务配置及应用镜像。第一次迁移失败不要求旧制品支持 DeepSeek。旧 OpenAI/智谱 socket 挂载仅为旧镜像回滚保留；新版 Studio 不装配这些生产角色。新版本通过健康检查后，才停用旧服务，不删除其凭据和旧制品。

健康检查通过只证明发布与服务就绪，不等同于真实成片验收。生成视频、配音和付费素材测试需要另外的用户授权。
