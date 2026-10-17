# GitHub Actions 生产发布

## 发布路径

本地验证并提交后，普通推送到 `main`。主分支保护禁止强推与删除，单人维护不强制 PR 审批。`.github/workflows/ci-cd.yml` 的 `verify` 与 `security` 必须全部通过，才能执行 `deploy`；也可对 `main` 手动运行同一工作流，仍经过全部检查。

Actions 的 `production` 环境使用仓库 Secrets：`SERVER_HOST`、`SERVER_USER`、`SSH_PRIVATE_KEY`、`PROJECT_PATH`、`PUBLIC_HEALTH_URL`。不要把这些值写进公开文档或日志。

服务器获取本次提交的精确 SHA，在独立、干净的 `.release` 工作树构建；不覆盖开发工作树，不允许脏发布目录混入制品。

新项目明确不需要保留旧数据时，可在已授权的手动 `cold` 发布中将 `backup_existing_data` 设为 `false`。该选择只跳过本次历史数据备份，日志明确记录没有创建 full 备份；正常停写、入口排空、候选版本核验和失败回滚仍执行。它不删除历史记录，也不修改凭据或模型设置。普通 push 和未关闭该选项的发布仍默认备份；旧记录清理须按另行授权的范围完成。

## 发布前检查

1. 在 Node 22、Python 3.11 和 FFmpeg 环境运行完整 `make test`，确认退出码。只读健康检查或构建成功不能代替回归。
2. 检查提交范围，排除密钥、运行数据、个人路径、截图和现场日志。产品代码、测试与使用文档应可从一次干净 checkout 重现。
3. 检查生产是否有正在执行的制作或未知的在途请求。不要为部署盲目中断、重复生成或删数据；需要先让原请求落稳或协调发布时间。
4. 普通推送到 `main` 后记录完整提交 SHA 和 Actions run ID。不要从本机直接执行部署脚本来绕开 CI。

## 已有 ECS 的升级前提

- Docker Compose、共享 Node 22+、`vf-bridge` 组与现有 Studio 工作区已初始化。
- Docker Engine 避开已知有 BuildKit history 崩溃缺陷的 29.3.0 / 29.3.1；本项目已验证的修复版本为 29.4.3。旧版不要用 `docker buildx history` 查询构建进度，查看 Actions 输出或当前构建进程即可。
- `vf-deepseek-codex` 服务用户存在，能运行 `/opt/video-factory/codex-broker/bin/node`。
- `/etc/video-factory/deepseek-codex-broker.env` 为 `root:root`、权限 `0600`，包含有效的 `DEEPSEEK_API_KEY`；配置只能经受控通道写入，不能通过 Git 分发。
- Studio 使用项目目录下现有 `.env.docker.prod`，其登录配置和媒体服务配置不因发布被覆盖。Unsplash 可选变量为 `UNSPLASH_ACCESS_KEY`。
- 服务器有构建和工作区备份空间。不要为了腾空间删除用户媒体、数据库或其他项目文件。

从旧 OpenAI/智谱生产环境升级时，只预备 DeepSeek 用户与凭据；不要对旧 broker 制品提前启动 DeepSeek。真正的制品与 systemd unit 切换由部署脚本执行。

### Docker 29.3 的 history 崩溃

BuildKit 在有订阅者时软删除历史记录，会在待查询事件列表留下空条目。29.3 的排序代码未排除这些条目，查询历史可触发 `filterHistoryEvents` / `history.go:1074` 空指针并导致整个 daemon 退出；这不是应用镜像构建失败或机器内存不足的证据。

上游 [BuildKit #6614](https://github.com/moby/buildkit/pull/6614) 清除空事件并加入软删除记录的集成回归。[Docker 29.4.0](https://docs.docker.com/engine/release-notes/29/#2940) 升级至包含修复的 BuildKit 0.29.0。只升级 Buildx CLI 插件不能修复内置于 Engine 的 BuildKit。

宿主 Engine 升级会影响同机其他容器，须协调维护窗口。先按现有门禁排空、冻结并正常停止 app/broker，完成完整备份与隔离回读；再正常停止其他容器，升级明确指定的 Engine 和 CLI 包。不要顺带升级 containerd、清理历史记录、删除卷或重建业务容器。升级前保留原版包、容器 ID/镜像/状态与非秘密配置，候选二进制先用独立 socket、数据目录及 containerd namespace 验证启动、构建和历史查询，禁止用旧生产 daemon 重演崩溃。

升级后恢复原容器和 broker，核对 Engine 版本、全部原容器身份与健康、app/broker 原 release 和零在途，再由本轮 owner 恢复门禁。若正常停止不能完成或状态不明，保留现场并停止升级，不强杀或清理维护登记；若软件包切换失败，保留维护窗口，核清停止状态后使用原版包回滚。`live-restore` 可减少部分 daemon 故障的影响，但不能代替本次缺陷修复，也不能当作跨版本升级无中断的保证。

## 验证与回滚

部署复用 CI 的 `/var/lock/video-factory-deploy.lock`，按以下顺序执行维护事务（R3）：

1. 构建并静态校验候选 app/broker，确认正在运行的全部入口支持 `video-factory/maintenance-admission-v2` 并报告准确 release SHA。旧版或无法证明退出的服务在停止、切换前被拒绝。
2. 以本轮唯一 owner 进入 DRAINING。关闭新顶层工作；已受理链路的后继任务可凭内部有效 holder 继续。HTTP 返回不代表完成。
3. 同锁确认 holder 集合为空，锁外主动刷新实际 app/broker 健康报告，再同锁复核 owner、generation、服务实例身份和完整持久状态，进入 FROZEN。排空默认最多 3600 秒，可用 `VIDEO_FACTORY_DRAIN_TIMEOUT_SECONDS` 配置。
4. 正常停止已排空的全部写者。Compose 使用无限正常停止等待，broker unit 禁止超时强杀；同时检查 Docker 的 Running/Pid/Restarting/Dead/Status 与 systemd 的 ActiveState/SubState/MainPID/ControlPID，未知状态不能算退出。
5. 默认在冻结且写者已退出的窗口执行完整归档和隔离恢复校验（R2）；成功后才切制品和 unit。恢复副本不能替换实际工作区。显式授权的 `cold` 发布可用 `backup_existing_data=false` 跳过此项，其余阶段保持。
6. 保持 FROZEN 启动候选，核对 app/broker 的准确 SHA、完整性、零活动和当前服务报告后提交新版本。仅本轮 owner 能开门；门禁坏读、残留 holder 或版本不符均保持关闭。

Studio 对 `SIGTERM`、`SIGINT` 使用同一幂等关闭流程：停止安排恢复周期，关闭 SSE 订阅与 HTTP 入口，等待已开始的恢复、后台后继和持久 admission 释放后自然退出。请求断开时仍在等待共享锁的准入也必须完成释放，不能在关门后继续开工。退出等待保持事件循环存活，不使用 `process.exit()` 截断落盘；持久释放失败则保持等待，不能把 HTTP 已关闭当作全部工作完成。Docker 正常停止须由 `docker stop`/Compose 发起，使 `restart: unless-stopped` 识别手动停止，单独向宿主 PID 发信号不能保证容器保持停止。

共享目录默认 `/opt/video-factory/codex-broker/deployment/maintenance`，可用 `VIDEO_FACTORY_MAINTENANCE_DIR` 覆盖，unit 与 Compose 必须指向同一目录。父目录 `deployment` 为 `root:vf-bridge 0710`，只给共享组穿越权限，回滚配置文件仍由 `umask 077` 保持私有。冷升级入口事务及其锁单独写入 `deployment/ingress/`（`root:root 0700`），满足入口控制器的私有父目录要求；已有事务保留在原路径，不自动迁移。维护目录为 `root:vf-bridge 2770`，保留 setgid。broker 的 `RestrictSUIDSGID=true` 保持启用，运行时新建子目录从预设父目录继承 setgid，不在 `mkdir` 中请求该位，也不重复设置已经正确的模式。自定义路径的所有父目录也须允许服务用户穿越。脚本在关闭入口与停服务前以真实 broker 身份检查维护目录可访问、可读写。其中 `gate.json`、`holders.json`、`services/` 通过同一个 `.admission.lock` 短锁协调。不要手写这些文件，也不要依据时间删除 holder 或锁。

首次安装没有可备份的旧部署时，脚本显式报告“完整备份不适用”，不写 full 成功标记。已有部署默认必须通过备份验证，只有上述显式 `cold` 选项可以关闭本次备份；容器查询失败或已有数据无法定位不能当作首次安装。

排空超时发生在停服务之前；取消维护也须核实原部署记录、原服务实例和版本，不能无条件开门。冻结后，只有实际退出已证实，才可闭门拉起原写者；停止状态不明则保留 FROZEN。切换失败恢复旧 broker 制品、unit、Compose 配置及应用镜像，原 app 即使尚未切换也须恢复。回滚不完整时保持关闭并报告阻塞；提交新版本后的收尾只核候选，不再启动旧写者。旧 OpenAI/智谱配置和产物保持原样；旧服务退役在候选已验证后进行。

健康检查通过只证明发布与服务就绪，不等同于真实成片验收。生成视频、配音和付费素材测试需要另外的用户授权。

发布后核对这四层事实：GitHub main 的 SHA、Actions 三作业结果、服务器最后成功 release 与容器健康、公网健康和实际前端静态文件。必要时比较线上静态文件与本地同提交构建的摘要，不能只看到首页就宣称版本一致。

Actions 的 SSH 命令超时不证明宿主部署控制进程或 Docker 停止请求已经结束。恢复前须核实该次事务的精确进程身份、部署锁、原容器和维护阶段；只终止已确认的遗留控制进程，不能按进程名批量结束，也不能由此推断应用已退出。停写未完全证实时保持入口关闭；重新证明原制品和本地闲置后，才可用原入口事务恢复访问。

## 完整备份与隔离回读

`scripts/backup-production.sh` 调用 Python 离线引擎。单独运行也必须提供有效的 `VIDEO_FACTORY_MAINTENANCE_OWNER`，核对同一共享目录中的 FROZEN owner/generation、空 holder，以及 Docker/systemd 的实际退出状态。描述持久根不代替停写证明。

默认从 app 容器挂载、全部相关 broker 的 systemd 配置、实际用户与组解析源目录。broker归属由本项目服务名、实际工作区配置、制品路径或显式 `VIDEO_FACTORY_BROKER_UNITS` 认定，同机其它项目的broker不纳入本次停止和备份。解析不完整时可以设置 `VIDEO_FACTORY_BACKUP_SOURCE_DESCRIPTOR`，指向只含路径和数字身份的 JSON 描述文件：顶层 `version: 1`、可选 `app: {uid, gid, groups}`、`brokers` 数组。每个 broker 声明 `unit`、`workspaceRoot`、`uid/gid/groups`、`profile`（`openai/deepseek/zai`）、非空 `envFiles`；可选 `logicalRoot`、`codexHome`、`codexHomeLogical`。`envFiles` 元素可为绝对路径，或 `{source, logical}`。源和逻辑路径映射不得重叠；描述文件不包含密钥值，也不豁免对其他实际 broker unit 的枚举和退出核验。

`VIDEO_FACTORY_BACKUP_DIR` 指定归档目录，默认仓库上级的 `backups/video-factory`；`VIDEO_FACTORY_BACKUP_VERIFY_IMAGE` 指定含当前验证器及依赖的本地镜像，默认源容器镜像；`VIDEO_FACTORY_BACKUP_RETENTION` 默认7天。`VIDEO_FACTORY_BACKUP_ID` 可固定本次名称，已存在即拒绝覆盖。源 release SHA 从源容器配置读取，不使用候选版本环境变量冒充备份版本。部署显式设置 `VIDEO_FACTORY_BACKUP_ALLOW_LEGACY=1`，允许读取已退役broker中原生v1/v2记录和未曾存在的store-id；只验证并保全原格式，旧记录不能满足v3应用请求的binding关联。单独备份默认仍要求当前格式，可按同样证据显式启用兼容。

备份覆盖 app 原始/上传媒体、付费产物、成片、run/版本/审批/费用/发布记录、规划检查点与 SQLite，以及默认、注册和停用 broker 的原请求、会话、store-id和受限配置。停写窗口中的 DB/WAL/SHM先复制到临时目录，用 SQLite backup API生成独立数据库；不修改源数据库，恢复副本不带旧 WAL/SHM。缓存、socket和明确的运行时 owner/lease不恢复成活执行者，业务原请求与store-id保持。

发布 full 成功标记前，必须完成 partial归档校验、新空目录解包、同逻辑路径容器回读，以及源与副本报告一致性检查。恢复容器只挂恢复目录，按 app/broker 的实际 UID/GID/组读取业务文件，禁网且不运行业务 main、恢复 timer 或 provider；受限配置单独按原权限和字节摘要核验。验证器通过正式读取逻辑核媒体/响应、审批与账本、规划SQLite、模型请求关联、设置和机会库格式。任何缺源、缺媒体、身份不符、读取错误、空间不足或 owner/generation变化都失败；已存在的恢复目标（即使空目录）也拒绝使用。仅成功发布新的 full 后才执行保留期清理。

验证容器失败时，宿主只报告业务 `role`、其在解析角色列表中的零起始 `index`、退出码，以及固定 Node/系统错误代码或 `reason-sha256`。摘要对应验证器固定错误原因的 UTF-8 SHA-256，可与同提交 `scripts/verify-production-backup.mjs` 中的 `fail(...)` 字面量或错误代码对照；未识别输出显示 `diagnostic=unclassified`。不把原 stderr、业务内容、配置路径或 provider 消息复制到 Actions 日志。诊断信息不改变完整性、闲置或失败保全规则。

manifest标识 `video-factory/full-backup-v1`，记录源镜像/SHA、owner/generation、逻辑根映射、每个文件的hash和字节数，以及文件与目录的权限和UID/GID。旧 metadata 归档不具备完整媒体恢复能力。隔离回读证明归档完整和离线可读；不证明真实秘密、线上续作或异地灾备可用。

## 维护门禁与冷维护

- **首次维护协议升级**：普通 push 和默认手动发布使用 `online`，旧 app/broker 缺少 v2 协议或准确版本时仍在停写前拒绝。已授权发布需要升级旧版时，在同一 Actions 工作流选择 `upgrade_mode=cold`，并提供 `expected_previous_release`（40位最后成功生产 SHA）；仍先完成 verify/security，再持有同一宿主 flock。该选择会临时关闭本站入口。候选构建完成后核原镜像、容器、broker制品、持久根与业务身份；Nginx 只修改匹配本站的 server，保留精确 GET/HEAD `/api/health`，其他请求503，等待旧 worker 正常结束后才算入口排空。严格核默认、注册和停用模型及 app 的本地写入已结束；未完成的本地任务、无结束证明的unknown、残留lease或不可读状态均拒绝冷升级，不修改记录。v3未知结果仅在原记录已有有效 `localExecutionEndedAt` 时保留；没有v3身份的旧记录只对原本已停用且PID/cgroup退出得到证明的服务使用显式只读兼容，保留未知结果与原字节，不补造store-id、binding或成功事实。正常停 app 后复查 broker；为旧 broker 安装本次 runtime stop保护（无限等待、禁止SIGKILL）并读回，再正常停止并核PID/cgroup。controller用正式锁和transition记录 `kind=cold-upgrade, bootstrap=false` 并进入FROZEN，随后按上述备份选项执行完整备份与隔离回读，再进行候选闭门核验和同owner开放。最后恢复原Nginx字节并复核公网版本。
- **旧 Node PID1 的一次性正常停止**：`stop-app` 先发起无限期限的 Docker 正常停止；宿主只等待至多30秒以决定本次发布能否继续，不升级为SIGKILL。若两秒后仍存活，仅旧release `e2602eb7c80708382b41380ac94d65adfb5ecccb` 与代码中固定的完整镜像摘要允许协作退出。须再次证明入口已排空、实际根闲置、runs为空、Node为独立namespace的PID1、无子进程或工作区文件描述符，且唯一应用监听为4317。固定辅助脚本只在容器loopback临时启用inspector；拒绝已有调试器、额外应用监听和未知进程。它核boot/start/cgroup后安装15秒内有效的一次性SIGTERM回调，实际信号到达时重新检查闲置才关闭HTTP server；原有JS信号处理器保持不变。调试口实际消失后宿主才经pidfd向原进程发送SIGTERM，最终必须证明exit0、无OOM、无重启、Docker stop成功。该兼容路径不适用于任意旧版本，也不关闭有业务工作的应用；新版本直接使用正常生命周期。任何身份、闲置、调试清理或退出证明失败都保留入口屏障。
- **冷升级失败恢复**：入口关闭前失败不触碰写者；严格闲置检查失败、尚未停写时恢复原入口。停写未完全证实时保留入口关闭，不restart或强杀。已证实全部停止后的备份/切换失败，先正常停止候选，再恢复原镜像、broker制品和原配置；核对原身份、全部持久任务与空holder后，由 `cold-abort` 留记录并开放原服务。普通 `recover` 不接受冷升级记录。新候选提交后的失败只能继续检查该候选，不能再复活旧写者。遗留frozen/draining、其他owner或被改写的入口/制品均拒绝自动接管；私有事务证据保存在 deployment 目录，不删除用户数据。
- **崩溃 owner 的恢复路径**：部署留下 `draining`/`frozen` 后，新部署拒绝接管。使用保留的候选制品中的共享维护模块和 `scripts/production-maintenance.mjs`，在同一个 CI flock 下执行受限本机 `recover`。参数依次为共享模块绝对路径、维护目录、`recover`、原 owner；owner 取自本轮 `deployment-<owner>.json` 并与 gate 核对。DRAINING 恢复要求原服务实例及版本仍在；FROZEN 恢复要求原版本已在闭门下恢复、实际健康报告完整且全局无 holder。首次安装失败没有原服务可核时保持关闭。`status` 可只读查看 owner、generation 和 holderCount。不得删除/改写 gate、替换 owner 或按 TTL 放行；残留短锁、持久 holder 和服务重启造成的归属疑问须先查清，`recover` 不会清理它们。
- **本地 CLI 直写工作区**：当前生产 workspace 由单实例 app、其受控 worker/broker 与部署操作写入，宿主不直接用 CLI 操作该目录。这是冻结语义的前提；引入新的写者必须先接入同一准入协议。
- **排空口径**：app 覆盖路由、后台制作、规划/审计、热点、上传清理与启动/周期恢复；broker 覆盖队列、任务、会话尾部、最终持久化，以及注册表中所有模型（含停用实例）。规划/制作读取不完整或请求归属不明会阻断冻结。已稳定等待人工且原请求身份完整的 unknown 可作为静止数据保留，仍有本地执行或身份无法证明的 unknown 不可冻结。公开健康报告只给计数与完整性，不暴露内部续作 holder。
- **选题修订的只产稿停点**：用户修订选题时，已知 `deferAudit` 合同只产稿，不自动审计；模型循环正常返回后，v9检查点仍保留 `running` 与未审候选。维护读取器及 `--require-locally-idle true` 通过与恢复路径共享的结构校验、准确合同摘要、topic/revise归属、合法候选、候选回执与原请求的逐一绑定、全部请求的明确终态识别此停点，不改写检查点。prepare前已确证未受理的连接失败可以没有broker回执；若保存了请求摘要，仍须匹配，已受理请求不能使用这一例外。普通产稿到审计之间的 `running`、未知合同、在途/缺失/冲突的执行事实仍拒绝；`--require-idle true` 仍要求原严格终态。该判断只证明模型循环停点，不能代替HTTP和缓存落盘尾部排空、维护holder清零及实际写者退出证明。

工作区与私有环境配置保留，发布不自动清理旧制作。新版 v2 声音计划和原声时间调整由配套 Studio、工作流和 Python worker 一起发布；旧 v1 与无计划路径继续保留，不做批量数据迁移。

回滚恢复的是应用、模型服务和配置，不应删除用户产物。真实配音韵律、服务商账单和用户听感仍按实际试用单独验收。
