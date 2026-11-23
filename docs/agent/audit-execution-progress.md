# 帧间审计执行台账

2026-11-22，起点 `74a4580eff12e3a62ad78f8613cfb8efa0f4ee83`。输入为用户提供的《帧间 Frame 全量代码深度审计与演进路线图》和同次提供的十批执行顺序。每批依次验证 `npm run contracts:check`、`npm run typecheck`、`npm test`、`npm run build`，前端性能批另验 `npm run perf:frame`。构造数据、真实本地操作、模拟供应商和外部联调分别记录。

| 批次 | 条目 | 进度 |
|---|---|---|
| 1.1 | ISS-01、02、09 | 通过四道门禁 |
| 1.2 | ISS-03、04、OPT-01 | 通过四道门禁与定向验收 |
| 1.3 | ISS-07、08、10（登录与登出）、11 | 通过四道门禁与定向验收 |
| 2.1 | ISS-12、13、15 | 通过四道门禁与工作台浏览器性能门禁 |
| 2.2 | ISS-14（服务端）、10（静态加密）、OPT-02、03、04、06 | 通过四道门禁及桌面清理实测 |
| 2.3 | ISS-14（前端）、16、OPT-05 | 通过四道门禁、Fast 4G 及长会话实测 |
| 3.1 | ISS-05、06、CAP-01 | 通过四道门禁、四路媒体导出与桌面审片实测 |
| 3.2 | CAP-04、02 | 通过四道门禁、真实素材上传和三路 I2V 协议验收 |
| 3.3 | CAP-03、05 | 通过四道门禁、真实语音与零费用 PC 重剪验收 |
| 3.4 | CAP-06、07 | 通过四道门禁、Fast 4G、工程复现、双账号和预算实测。商业账单与桌面剪辑软件导入待联调 |

## 1.1 旧稿认可、作品库分页与查询

现有修订与认可消息的因果顺序来自可裁剪事件。消息的公开 `createdSequence` 单独计数，不能直接和历史事件序号比较。迁移应保留消息分页的位置，并为消息与修订记录同一尺度的持久顺序。当前契约中交付通知值为 `new_output`。旧库阶段的翻页位置包含阶段偏移量。媒体清扫需要一次读取摘要集合，同时维持上一轮已修好的“刚保存的媒体不会被扫描删除”。

本批生产文件包括契约源与对应说明、数据库迁移、认可校验、作品库服务与分页工具、配音工具、媒体清理和 PC 作品库的翻页合并。测试覆盖事件裁剪后认可／采用／定稿、选材和配音的交付事件、60 条新旧定稿翻页、历史迁移、五个索引的真实查询计划，以及万行数据与五千文件的耗时。完整运行结果见本节末尾。

### 1.1 定向证据

- 对真实 SQLite 执行默认七天和每会话 2,000 条的裁剪。旧脚本认可、旧预览采用、旧成片定稿三个入口均通过。v26 的同毫秒用例验证了已裁剪的旧稿仍可由新消息认可，也验证了后到修订无法借之前的消息提前认可。
- 用本地 Pi 和媒体端口回放走完定稿、跨会话带入独立脚本、按钮认可和 `start_work`，核对准确修订与来源。新确认按现行 API 返回 202，消息已完成。交付事件遵循现行契约的 `new_output`。未使用商业媒体服务。
- 新旧定稿表各 30 条。每页 20 条，三页产生 60 个唯一修订，第三页已返回空游标。再请求最后记录之后的位置得到空列表和空游标。重叠的旧新确认也不重复。前端翻页用例通过。
- 在三个各 10,000 行的表、同一会话 100 个稿件和 5,000 个真实文件下，五条热查询均命中预期索引。初测快照出现 12.235 ms 的单次峰值。随后将快照中最多 50 次逐脚本查询合并为一次索引查询。相同基准的 10 次测量中，快照最慢 0.625 ms、助手消息提交最慢 0.358 ms、清扫 17.588 ms。原始样本保存在 `output/audits/roadmap-20261122/batch-1.1/db-indexes{,-batched}.log`。
- 在工作区根目录使用 Node 22.23.1。先前直接从工作区子目录启动的 shell 选择了 Node 26，与本机 SQLite 原生模块 ABI 不符；上面引用的结果来自重新使用 Node 22 的验证。定向服务器测试 31 项通过，真实 Edge TTS 另有一项依赖专用 Python 解释器及外部网络的既有门控；未把该调用计入通过数。全量门禁进行中。
- 首次全量门禁在 `agent-creative-host-pool.test.ts` 的卷保护断言前抛出 `Unexpected end of JSON input`。独立 Docker CLI 测试替身直接截断再写共享状态文件，测试进程正好读到空文件。将替身改为同目录写临时文件后原子替换，只对文件尚未创建返回空初态。原断言和生产宿主代码均保留；具名用例复测 1/1 通过。完整重跑的结果单独记录。
- 跨表重认回归额外核对首次定稿时间。旧阶段已定稿的版本在新表中再次确认，仍保留原时间及页位置。
- 设置导航测试曾在已切换页面、设置面板还在动态导入时触发查询超时。针对这一步等待 Vitest 观察到的真实动态导入完成，再断言可见界面、原草稿和请求次数；具名复验通过。

| 本批改动 | 文件 |
|---|---|
| 契约与生成输出 | `contracts/agent/v1/{contracts.schema.json,openapi.json,agreement.md,IMPORT.md}`、`apps/studio/src/shared/agent/generated/{contracts.ts,contracts-schema.ts}` |
| 服务器 | `apps/studio/src/server/agent/{db,creative-work,agent-service,paging,pi-tools,production-blobs}.ts` |
| PC 作品库 | `apps/studio/src/client/agent/WorkLibrary.tsx` |
| 审阅、分页、查询计划与耗时 | `apps/studio/test/agent-{history-trim,preview-adoption,library-selection,dub-free,domain,db-indexes}.test.ts`、`apps/studio/test/agent-work-library.test.tsx`、`apps/studio/test/helpers/creative-work-fixture.ts` |
| 门禁测试夹具 | `apps/studio/test/fixtures/creative-docker-shim.mjs`、`apps/studio/test/agent-workbench.test.tsx`、`apps/studio/test/agent-crash-recovery.test.ts`、`apps/studio/test/agent-creative-host-pool.test.ts` |
| 台账 | `.gitignore`、`docs/agent/audit-execution-progress.md` |

- 第三次完整运行的 Vitest 为 232/232。服务器的 `after-auto-compaction` 崩溃恢复测试到达其 60 秒限时，未计通过。之前同一条测试耗时 9.72 秒通过。这次相邻四次进程启动耗时分别为 19.68、24.53、7.57 和 5.77 秒，主机为 8 核，观测负载超过 50。继续用较低并发运行同一套门禁，保留超时与全部断言。
- 恢复测试的子进程仅在调用方显式设置时继承 Node 自身的编译缓存。单独复验同一 SIGKILL 场景耗时 7.999 秒，保留 60 秒上限。日志为 `crash-cache.log`。
- 第三次全量服务器测试最终为 429 通过、1 超时、6 个既有条件用例跳过。第四次上述 SIGKILL 用例已通过，但容器夹具的清理钩子遇到 `ENOTEMPTY`。现场目录中唯一的文件是两次延迟到达的 Docker `rm` 调用日志。原测试固定等待 50 ms；现按启动过的容器名称逐一等待真实的销毁命令记录。整套夹具的 10 个用例全部通过。证据为 `fixture-late-rm.log` 和 `fixture-teardown.log`。

### 1.1 完整门禁

- `npm run contracts:check` 退出码 0，耗时 6 秒。
- `npm run typecheck` 退出码 0，耗时 11 秒。
- `npm test` 退出码 0，耗时 892 秒。
- `npm run build` 退出码 0，耗时 8 秒。

前端 232/232，一般服务器 26/26。Agent 服务器 430 通过，0 失败、0 超时，6 个原有外部条件用例未运行（4 个真实 Docker 场景、1 个真实 Edge TTS、1 个远程 Skill 安装）。此轮完整运行中，万行库的快照和消息写入分别最慢 0.617 ms 和 0.394 ms，5,000 个文件的清扫耗时 13.162 ms。全部原始日志及时间戳位于 `output/audits/roadmap-20261122/batch-1.1/`。

## 1.2 工程下载、媒体传输与一次性渲染

已核对下载与封面路由、项目文件类型映射、媒体存储、标准合成、工程沙箱、图像和配音端口、素材下载与作品库输入。初始实现对 Blob 一律 inline/no-store；工程输入和成品跨进程传输整块 base64；编辑工程和一次性渲染共用宿主卷前缀。已有崩溃恢复依赖尝试目录里的成品，清理以持久收据为界。

涉及 `contracts/agent/v1/`、`routes.ts`、`pi-tools.ts`、`production-blobs.ts`、`local-render.ts`、`media-port-support.ts`、`image-generation.ts`、`openai-speech.ts`、`minimax-speech.ts`、`material-store.ts`、`library-inputs.ts`、`creative-runner.ts`、`artifact-store.ts`、`scripts/creative-runner-host.mjs` 及其运行配置、测试与指标。编辑工作区的卷包含原工程文件，必须保留。

### 1.2 定向验收

| 路径 | 证据与结果 |
|---|---|
| 发布工程，再下载 | 真实 Pi 工具与 Fastify。六个文件覆盖 JS 三种后缀、HTML、SVG、Makefile。七种允许内联的媒体核对鉴权、CSP、nosniff、ETag、304、206、416 和显式下载。5 项具名回归全部通过，见 `transfer-endpoints.log`。Nginx 发布配置在 `deploy/nginx/video.wangjinkun333.me.conf` 默认转发 Range 并设置了 `proxy_buffering off`。 |
| 审片台同时间码切版 | 现行生产组件、真实 Fastify 和 Chromium，在 0.5 秒处逐次读取画布的红／蓝像素确认正确版本已显示。仅改缓存后 5 次重切均为 0 B，耗时最高仍为 409.9 ms。改为在比较打开期间保留两个播放器后，同样的五次切换为 12.9、12.4、13.9、15.3、14.0 ms，服务器传回视频数据 0 B，冷访问实际返回两次 HTTP 206。`bench-review-cuts.mjs` 可复测，日志 `browser-cuts-{initial,pair}.log`。 |
| 512 MiB 视频导入及成片落库 | 独立供应商测试进程提供协议响应与可解码 MP4。通过 Pi 采用素材、FFprobe、内容寻址落库，再落库另一份 512 MiB 成片，二者摘要不同。真实 HTTP 的第一轮 RSS 增长 94.28 MiB。原生 HTTP 接收并按背压直通文件后，RSS 增长 49.11 MiB、事件循环延迟 P99 8.36 ms（408 个采样）。原始日志 `import-512-{http,pipe}.log`。 |
| 连续 10 次工程渲染 | 真实 Colima/Docker + FFmpeg，每次拼接五个 100 MiB 可解码 MP4，逐次确认生成 10 秒、320×180、4 fps 成片。用 dev、inode、blocks 核对输入硬链接，容器内校验挂载为只读。十次额外素材数据分配 0 B，准备最慢 6.93 ms。每次成品收据落库后均有 0 个尝试目录，最后 0 个执行卷。原编辑工程仍可读写。首次测试中的容器初始化已返回成功帧，但 Docker CLI 没有退出，超过 300 秒，未计通过。对初始化改用一次性非交互调用，保留原协议的可信 helper，再跑同一条用例通过。见 `real-docker-ten{,-once}.log`。 |
| 连续 10 次供应商视频下载 | MiniMax 协议本地 HTTP 服务、真实下载、FFprobe 与收据。每个成品均可解码，最后 0 个尝试目录。该测试使用本机协议替身，未调用商业 API。见 `transfer-endpoints.log`。 |

本节验证日志位于 `output/audits/roadmap-20261122/batch-1.2/`。新增量化夹具为 `apps/studio/test/helpers/sized-mp4.ts`、`apps/studio/test/bench-review-cuts.mjs`，另扩展素材完整 Pi 链、容器、下载和流式 Blob 的既有测试。完整门禁另记。

生产配置还有一条不同于本机 bind mount 的路径。使用单独创建的 Docker 数据卷、正式子目录挂载语法和应用 UID 1001 双向传递真实文件，回收后执行卷为零（`data-volume-smoke.log`）。原编辑沙箱的大型二进制 UDS 往返，以及工程恢复、镜像身份、两操作依赖链的另两项真实 Docker 测试各通过 1/1（`real-editor-transfer.log`、`real-code-recovery.log`）。

图像与配音原测试期望成功后保留重复的成品文件，与本批的回收要求冲突。现在成功路径直接解码持久成品，另在测试库构造“已有完整文件、还没有收据”的中断状态，执行启动扫描和 query，验证只补一份收据且随后归还目录。该套 21/21 通过（`openai-media-recovery.log`）。首次完整前端门禁检出一个测试读取了页面中的第一个隐藏播放器；审阅画面测试现在检查实际可见播放器、修订和制作记录，并断言再次切回的是同一个播放器实例。此前失败的门禁保存于 `before-visible-player/`。

全量复测还发现两处测试仍按旧 IPC 边界观察结果。宿主测试把 helper 必须是最后一个 argv 当作“卷初始化”的标志；现在同时检查一次性容器名、固定 helper、UID 和非交互参数，仍逐个断言每个工程卷／Skill 卷恰好初始化一次。全部 10 个宿主池测试通过。配音的交付测试与作品库测试现在复用同一协议替身。单独的 Python 驱动回归同时核对落盘音频原字节、五种代理配置和返回的时间边界。

这次全量的万行库基准出现一次 11.64 ms 的快照，超过 5 ms，其余九次为 0.48–2.11 ms。查询计划仍命中同一批索引。独立加测了每个分页步骤的墙钟与线程 CPU，相同数据的十次快照为 0.45–0.77 ms，五千文件扫描 14.27 ms（`db-index-scheduler.log`）。单独复验不能替代本批的完整重跑，原阈值和取样数均保留。

上述完整运行前端 232/232、一般服务器 26/26。Agent 服务器 429 通过，6 失败，6 个原有条件用例未运行。6 项分别是两条旧宿主初始化观察、一条跨会话配音替身、一条 Python 代理驱动替身、一条 Ark 测试读取旧尝试文件，以及前述快照读时延。Ark 现在按正式收据读取并探测真实 blob，同时断言目录已回收，单独复验通过。所有失败和复测日志都保留于本批证据目录。完整门禁从契约开始重新执行。

| 1.2 改动位置 | 文件 |
|---|---|
| 下载契约 | `contracts/agent/v1/{contracts.schema.json,openapi.json,agreement.md,IMPORT.md}`、两份生成的 TypeScript 文件 |
| 内容与传输 | `apps/studio/src/server/agent/{routes,pi-tools,production-blobs,artifact-store,material-store,library-inputs,stock-http,stock-providers,pexels-client}.ts` |
| 媒体执行与运行配置 | `apps/studio/src/server/agent/{creative-runner,local-render,media-port-support,image-generation,openai-speech,minimax-speech}.ts`、`apps/studio/src/server/main.ts`、`scripts/creative-runner-host.mjs`、`docker/frame-creative.service` |
| 审片 | `apps/studio/src/client/agent/WorkStagePanel.tsx`、`apps/studio/test/agent-work-stage.test.tsx`、`apps/studio/test/bench-review-cuts.mjs` |
| 媒体与宿主验证 | `apps/studio/test/agent-{additional-video-ports,closeout-runtime,creative-host-pool,dub-free,free-services,library-selection,local-creation,local-creation-real,local-render,materials-pi-chain,network,openai-media,production-blobs,real-media}.test.ts`、`test/fixtures/creative-docker-shim.mjs`、`test/helpers/{sized-mp4,edge-tts-fixture}.ts`（后两条相对于 `apps/studio/`） |

### 1.2 完整门禁

契约 2 秒、类型检查 11 秒、全量测试 914 秒、构建 8 秒，四个退出码均为 0。前端 232/232，一般服务器 26/26，Agent 服务器 435 通过，0 失败、0 超时，6 个既有条件测试默认未运行。三个真实 Docker 条件测试已另行显式通过，另外三项是外部 Skill 安装、Edge TTS 与另一项综合沙箱场景。该次全量中的 512 MiB 导入及成片落库 RSS 增量为 59.53 MiB，事件循环 P99 为 7.86 ms。万行库十次快照最慢 0.696 ms，助手写入最慢 0.348 ms，五千文件扫描 18.03 ms。见同目录的 `gates.tsv`、`test.log` 及 `build.log`。

## 1.3 安装边界、创作热池、登录与发布挡板

已核对 SDK 的来源解析、安装和持久化、宿主进程的卷与池生命周期、实际登录入口，以及 HTTPS 发布脚本和既有只读健康检查。改动位置为契约源与生成物、`skill-packages.ts`、`network-policy.ts`、`assembly.ts`、`creative-runner.ts`、`creative-runner-host.mjs`、`creative-operations.py`、`SkillPackagesPanel.tsx`、`app.ts`、`routes.ts`、`AuthGate.tsx`、Nginx 模板、发布与冒烟脚本、部署说明及相应的既有测试。版本门禁包含两份说明的当前修订、Schema 标题和 OpenAPI 版本。

### 1.3 定向证据

契约当前修订为 0.1.50。生成与检查均通过，另在临时副本分别改错 agreement、IMPORT 和 Schema 的当前修订，三次均以退出码 1 拒绝（`document-drift.log`）。本批证据目录为 `output/audits/roadmap-20261122/batch-1.3/`。

| 条目 | 取证结果 |
|---|---|
| ISS-07 安装边界 | 7 个输入覆盖根目录、数据目录及其祖先、缺失目录、两个 HTTP 地址和私网 HTTPS。拒绝发生于 Pi 安装前，配置逐字节相同。另通过 SDK 实际启动的 Git 命令观察协议限制和重定向参数，进程替身在联网前退出。正常本地目录安装、根 SKILL.md、卸载及回读继续走 Pi。见 `boundaries-final.log`。 |
| ISS-07 依赖状态 | 真实 Docker UDS 与固定创作镜像发现 FFmpeg、PIL，返回 ready。缺少指定顶层模块时返回 unavailable 和准确模块名。两种状态均经过真实工作台组件渲染（`real-runtime-final.log`、`ui-boundaries.log`）。对格式错误的依赖声明另有回归，首次观察到它会妨碍整个目录重启，现在仅该条 Skill 产生诊断，其他包仍可用（`invalid-package-before.log`、`invalid-package-fixed.log`）。 |
| ISS-08 名称与归属 | 使用本次独立构建的创作镜像、真实 Pi/SQLite、Docker 和 FFmpeg。工程内链接按词法名称列出，Skill 区与系统文件链接均跳过。publish_project 封存源码和别名，两项字节摘要相同，外部文件数为 0（`real-project-links.log`）。第一次用 macOS /tmp 作为传递目录，Colima 无法挂载；复验改用共享工作树内独立测试目录。 |
| ISS-08 宿主 | 12 个并发工作区、上限 4。Docker CLI 协议测试观察到热池峰值 4。模拟 daemon 删除卷后，工程及 Skill 卷各重新初始化一次，Skill 内容同步两次（初次、恢复各一次）。 |
| ISS-10 登录与登出 | Fastify 真实路由验证缺 Origin、缺工作台头、不同 Origin，在登录与登出均返回 403 FORBIDDEN。合法会话与限流额度未受拒绝请求影响。React 工作台验证成功、401、500、断线四种登出结果，草稿和待发送命令残留 0，其他本地键保留。500 和断线时登录页提示服务端未确认退出。 |
| ISS-11 发布开关 | 隔离容器内实际运行 Nginx、HTTP、TLS，并执行正式发布脚本所用的同一个维护开关。三次关闭与恢复，两个入口均从 200 到 503 再到 200，公开健康保持 200；六次切换（含 shell 进程和两个请求）为 11.85、7.97、7.21、4.06、9.56、9.48 ms（`dual-nginx-final.log`）。生产首次采用前，两个 server 需按部署指南预装固定 include。独占 GitHub VM 的完整镜像发布与回滚流程保留在原冒烟脚本中；本轮没有触发 GitHub 或 ECS 发布。 |

既有缺失本地来源测试原先断言调用 Pi 之后返回 503。本批要求在安装前返回输入错误，更新为 400、INVALID_INPUT、retryAction=none，原有模拟持久化故障的 503 与操作后回读断言保留。见 `missing-source.log`。定向测试发现上述无效依赖声明后，中止旧输入的门禁并留存日志于 `before-invalid-metadata/`。

真实 daemon 的事件订阅记录到 36 次容器启动（24 次卷初始化与 12 个热容器），全程同时存活峰值 4，12 个请求全部返回，关闭后残留 0。第一次采用事后读取 Docker 事件历史漏失部分事件，改为请求前订阅并核对关闭后的实际容器列表；以 `real-pool-events.log` 为准。额外执行公开固定 ref 的原生 Git 安装与卸载，1/1 通过（`real-pi-git.log`）。依赖清单通过标准输入送入真实沙箱，实测 2,000 个命令名、174,891 字节均得到逐项结果（`real-runtime-batch.log`）。

正式登录与登出还核验 Host。跨 Host 但 Origin 正确的请求同样在身份认证或撤销前拒绝（`host-origin.log`）。Nginx 维护响应使用纯文本，登出页面增加真实 503 响应测试，连同 204、401、500 和断网场景共覆盖五种结果。AuthGate 文件全量 9/9 通过（`logout-final.log`）。部署指南使用的 FRAME_EDGE_TTS_PYTHON 与进程读取的 AGENT_EDGE_TTS_PYTHON 原本不同。Compose 现明确映射两者，使用 `docker-compose config` 的隔离示例实测目标路径完全一致（`compose-tts.log`）。

### 1.3 完整门禁

契约 2 秒，类型 11 秒，全量测试 837 秒，构建 8 秒，均退出 0。前端 236/236，一般服务端 26/26，Agent 服务端 442 通过、0 失败、0 取消，6 项既有外部条件测试默认未运行。本批另外显式跑通其中的公开 Git 固定版本安装，以及 Pi 在真实容器内制作、封存和复用工程。见本批 `gates.tsv` 和各门禁日志。发布脚本还通过 Bash 语法检查，入口开关通过 POSIX sh 检查，宿主与双入口烟测通过 Node 语法检查。

本批文件还包括 `network-policy.ts`、`client/auth-api.ts`、`.env.docker.prod.example`、`docker/docker-compose.prod.yml`、`docker/frame-maintenance.nginx.conf`、`scripts/{frame-release-entry.sh,smoke-frame-maintenance.mjs,smoke-frame-release.sh,smoke-studio-container.mjs}` 以及 `test/{auth-gate,agent-workbench,agent-skill-packages,agent-closeout-runtime,agent-creative-runner,agent-creative-host-pool,agent-local-creation-real}.test.*`。正式入口现以标记与实际响应判定，无须指定 Nginx 站点文件路径。

## 2.1 消息引用、帧率验收与旧维护入口

已核对三个报告条目。先更新当前契约与 v28 迁移，再修改 agent 的 conversation-store、artifact-store、agent-service、executor、pi-tools、production-worker、production-blobs、material-store、preview-adoption、media-probe 与 local-render。移除 main、agent/app 上的退役维护钩子及相应测试，核对性能基准的现役入口与历史文档归档。对应验收覆盖三项选材、流式干预竞态、事务失败后的物理文件、随机毫秒配音合成以及工作台性能基准。

### 2.1 定向验收

- ISS-12，v28 对历史来源区分库克隆、工程封存、内部配音、正式交付及制作输出。同字节的配音按交付回执区分。迁移只从已有助手引用中摘除已证实的输入和中间产物，保留顺序、文本和其它引用。迁移夹具以及真实沟通竞态见 `batch-2.1/admission-migration.log`。并发重放同一干预只生成一条消息；失去运行窗口和再次重放拒绝请求均返回 409。
- ISS-12，沿用 Pi 原生队列，将 SQLite 受理写入移至原生消费或队列接受时，并在写事务复核运行状态。三个选材通过正式发送进入新会话，在接收方重新交付音频、重新交付脚本两条旅程分别验证。脚本旅程的用户消息显示三项来源，助手消息只显示一项「正式脚本」。轻量装配、跨作品封存前的零次导出、停止后零下载及零临时目录也已核对。见 `references-and-preflight.log` 和 `three-input-script.log`。
- ISS-12，媒体登记与关联写入共用 SQLite 事务。定向测试实际触发 SQLite 中断，核对本次新建的物理链接被移除、其他所有者的同摘要文件仍可读，暂存区剩余 0 项，数据库仅保留原有的一行。
- ISS-13，50 组可复现的 287–1073 ms 毫秒配音输入，各走一次真实旁白合成和一次混音合成，100/100 成功。音频为本地 FFmpeg 合成的 24 kHz 单声道 MP3，语音元数据符合配音通道契约。另生成六个真实 MP4，经 ffprobe 实测 23.98、23.999、24.001、24.02 fps 全部通过，15、30 fps 两个错配全部拒绝。详见 `fps-pairs-final.log` 与 `fractional-rate-media.json`。第一次样本中配音长过混音画面，制作入口正确拒绝，修订了混音夹具的实际片长；业务时长校验保留。
- ISS-15，在本批开始时仓库并未注册 `perf:frame`。新命令复用离线工作台、现役采样器与原有棘轮，沿用同一份构建在原始字节与生产预压缩两个入口的对照。预跑中打开和发送两条旅程各侧 10/10 有效，1440 和 960 两档共 8 组交互护栏全部通过。正式门禁单独计时。
- ISS-15，归档 13 份历史文档，共 1,875 行。随旧接口下线的 `trend-topic-pipeline.test.ts` 依赖的七个旧服务文件均已在提交 `403853a` 退役，该测试也已被原有测试命令排除。其原文及旧文档分别逐字核对归档。退役的运行时、测试与基准文件合计 1,531 行（含这一条旧候选收件箱测试），详见 `retirement.json`；新浏览器入口单列。正式生产入口继续使用 1.3 已验证的 Nginx 维护标记。

### 2.1 完整门禁

依序通过契约 1 秒、类型 11 秒、全量测试 902 秒、构建 8 秒、浏览器性能门禁 205 秒。前端 236/236，一般服务端 5/5，Agent 服务端 446 通过、0 失败、0 取消，6 项既有条件测试默认未运行。压缩构建可交互 P75 494.6 ms、字体就绪 2338.4 ms、实际输入读回 542.8 ms，离线发送首反馈 2.7 ms、回合终态 1009.2 ms。两档宽度的工作台及设置页同一构建像素差均为 0。原始日志、逐样本 JSON 与截图在 `output/audits/roadmap-20261122/batch-2.1/`。

除本节开头列出的实现外，本批改动涉及根与 Studio 的 package.json、tsconfig.server.json、README、退休前部署哨兵、perf/bench/frame-gate.mjs、frame-measure.mjs，以及 agent-audit、agent-ark-video-settings、agent-domain、agent-db-indexes、agent-production-blobs、agent-dub-free、agent-local-creation、agent-local-render、agent-narrated-render、agent-library-selection、agent-materials-pi-chain 与 bench-review-cuts 的相关用例。

## 2.2 服务端性能、存储与凭据

已检查运行时、执行上下文、三类配置版本、供应商连接、免费服务、后台 worker、媒体来源查询、生命周期与发布备份。当前工作组和审阅事项以 works.creation_state_json 保存。定稿留存材料来自实际制作关系，并无报告假定的 library_materials 表。沿用现有作品投影和定稿来源解析。先更新空间、归档状态及健康契约，再迁移数据库。

本批涉及 db、credential-cipher、artifact-drafts、image-projection、pi-runtime、executor、creative-work、event-log、conversation-store、production-store/index/service/worker/blobs、stock-cache/providers、newsnow-client、历史清理与媒体可达性、五处凭据读写、健康与空间路由、个人设置、媒体预览、部署环境和备份脚本。按真实 SQL 次数、解码次数、调度延迟、素材并发、物理字节与隔离备份验收。

### 2.2 定向验收

| 能力 | 测量与结果 | 原始证据（均位于本批目录） |
| --- | --- | --- |
| 流式脚本 | 8,000 字、2,022 个增量，完整解析 10 次，每相邻两次间隔 200 ms，次数下降 99.51%。完稿和撤销也有单独断言。 | `runtime-performance.log` |
| 多步上下文 | 用 Pi 原生会话加入 10 张不同图片、20 件作品、50 个有摘要的稿件。依次执行 10 次 read_work，包含最终回答共 11 次模型上下文。用同一夹具从起点提交 74a4580 的原版源码实测每步 95 条 SQLite 读取，当前每步 3 条，减少 96.84%。真实全高清图片通过相同的 Pi 缩放入口测量，十轮 CPU 总量从 56,343 ms 降至 5,655 ms，下降 89.96%。供应商文本由 Pi Faux 回放。 | `long-before-74a4580.log`、`50-head-context.log`、`runtime-performance.log`、`image-lru.log` |
| 跨会话声音证据 | 作品库把原配音带入新会话时保留原媒体。定向对照中，批量查询附加的会话过滤让原台词、音色变为空。现保留用户所有权约束，沿输入媒体找到原制作快照。相同冻结提案在完整读取与批量读取中的声音摘要逐字段一致。 | `cross-context-before.log`、`cross-context-after.log` |
| 空闲调度 | 用受控时钟推进一天，实际执行 SQLite 查询 2,880 次。使用真实受理事务、事件通知和隔离媒体端口，从确认返回到端口开始执行为 4.28 ms。 | `runtime-performance.log` |
| 素材二次检索 | 在同一适配器、同一限速网络替身上，各跑 7 次串行和 7 次并行。NASA、Met、Archive 的 P95 分别从 181.0／172.8／179.7 ms 降至 56.7／56.2／56.2 ms，并发峰值均为 4。Incompetech 3,500 首目录热查 0.44 ms，另测到期协商、磁盘复用和中止。公网服务商时延未计入。 | `stock-performance.log` |
| 过期媒体回收 | 八类受保护的真实文件全部留存。12 个超过保留期的中间稿共 98,304 字节，实际释放 98,304 字节。覆盖他人同摘要文件、回执重放、事务失败恢复、重启时隔离文件恢复及相同原始字节重新导入。旧稿返回 HTTP 410 和 MEDIA_ARCHIVED。 | `media-roots.log` |
| 桌面清理与归档 | Chromium 分别在 1440×820、960×820 打开真实旧 MP4，键盘提交清理，再回原消息。相同 v1 阅读位置显示归档提示，v2 仍可读。两个宽度均无横向溢出、无页面脚本异常。个人资料和存储同时读取失败时各有独立的重试操作。 | `storage-{1440,960}.json`、`storage-{before,archived}-{1440,960}.png`、`settings-ui.log` |
| 凭据与健康 | v28 旧库五张表的合成凭据均加密，并经解密读回和离线轮换。旧明文未出现在数据库、WAL 或备份中。错误主密钥、缺失生产主密钥、修改认证标签均拒绝使用。实际 SQLite 写锁与断开的 Unix socket 分别用 1.28 ms、0.48 ms 使公开健康接口返回 503，进程层仍报告存活。 | `protection.log`、`test.log` 中的凭据迁移和健康用例 |
| 备份与恢复 | OpenSSL CMS 及 age 两种加密流均经过解密与还原比对。第二种使用 Debian 签名索引核对后的 age 1.1.1，在无网络的一次性容器还原 200,000 字节，备份权限 0600。全程使用隔离测试身份。 | `age-roundtrip.log`、`agent-credential-readiness.test.ts` |

本批加入 `test/agent-{runtime-performance,stock-performance,media-retention,credential-readiness}.test.ts`，并扩充现有的 agent-production、agent-settings-dialog、agent-db-indexes 和 agent-free-services 用例。v14 迁移夹具改用当年的表结构写入历史文件和行，升级后继续用当前实现读取。验证中已分别保留两个同名重试按钮的失败日志与跨会话旁白丢失的对照结果。

补做免密公网抽样。Met 在 1.26 秒返回一条真实馆藏记录。NASA 首次请求遇到网络问题，逐请求复测时当前版与起点版均从官方搜索和素材详情拿到结果。Internet Archive 的两版在第一条搜索请求都记录到 UND_ERR_CONNECT_TIMEOUT，此时还没有进入并发详情读取。公网抽样只核对连通与真实响应形状，不用这三个单样本推断 P95。详见 `public-catalog.jsonl` 和 `public-catalog-trace.jsonl`。

### 2.2 完整门禁

契约 3 秒、类型检查 10 秒、全量测试 909 秒、生产构建 8 秒，均退出 0。前端 237/237，一般服务端 5/5，Agent 服务端 460 项通过、0 失败、0 取消，6 项既有外部条件用例默认未运行。最终全量测得图像缩放 CPU 减少 90.10%，每步数据库读取 3 次，确认到启动 4.10 ms。见 `batch-2.2/gates.tsv` 与四份对应日志。

## 2.3 工作台事件、文本协议与长列表

已核对单实体读取、消息引用水合、断线恢复、缓存、连接设置、Pi 不可变绑定与 Markdown 解析。计划变更现有 AgentWorkbench、workspace-state、references、ModelConnectionsPanel、markdown、main.tsx、frame-base.css 与审阅样式；服务端范围为 provider-connections、provider-directory、text-model、text-model-settings、pi-runtime、agent-service、routes。复用现有能力目录与 Pi 原生传输。增加按 ID 读取会话、手动检查已保存连接的只读契约。目标验证一轮密集工具调用只取一次快照、跨会话缓存边界、两种协议的多轮原生工具请求、Markdown 节点、Fast4G 首屏、200 条历史消息的真实按键耗时。

修订 `0.1.53` 先通过生成与漂移检查。SQLite v30 把新连接签发的原生文本绑定与已退役历史绑定分开，v29 实库迁移同时验证旧 Responses 仍可执行、已退役协议不会在升级时复活。两种新增 GET 分别读取单个会话及主动探活已保存的账户目录。客户端和服务端共用适配器的用途声明，原生文本传输由 Pi 处理。MiniMax 和万相本地静态目录不会报告账户探活成功。Anthropic、OpenAI 兼容、方舟三组隔离协议桩均实际经过设置、HTTP 消息入口、Pi、两次 `list_production` 及最终答复。每组产生三次网络请求，保存连接时请求数均为零。文件为 `provider-capabilities.ts`、`provider-connections.ts`、`provider-directory.ts`、`text-model*.ts`、`pi-runtime.ts`、模型设置面板及两个实体读取入口。

工作台按单个对象补读事件、消息引用和未知素材批次，恢复快照继续负责断线及实体读取失败。阅读缓存保留最近十个视图、当前会话全部修订及最近两百个非当前会话修订。工作台保留原生中文字体栈，登录品牌按需加载拉丁衬线子集。分镜审阅、会话及设置的回归覆盖了 Markdown 语义节点及安全链接、退役绑定、保存与探活分离、缓存容量及正在审阅的版本。真实浏览器在两份构建分别加载 200 条历史消息，底层为实际 HTTP、SSE、SQLite 和 Pi，模型输出以明确的离线替身提供。

| 2.3 定向实测 | 修改前 | 修改后 | 凭据 |
| --- | ---: | ---: | --- |
| 同一真实工作台旅程收到 12 个独立作品事件，含首屏的快照 GET 数 | 15 | 1 | `dense-before.json`、`dense-after.json`，两次均核对 12 个作品行与 12 个事件目标 |
| 76 次真实键盘输入的脚本耗时 P95 | 1.921 ms | 0.957 ms | `typing-before.json`、`typing-after.json`，保留逐键和逐帧采样 |
| 最慢单键 / 实测帧率 | 2.844 ms / 60.00 FPS | 1.555 ms / 60.00 FPS | Chrome DevTools Performance.getMetrics 与 requestAnimationFrame，1440×900 |
| 新文本协议真实 Pi 工具往返 | 原版配置不支持 | 三个端点均 2 次工具、3 次模型协议请求 | `native-tool-loop.log`，隔离协议桩，未使用商业账户 |

第一次全量回归发现旧 OpenAI Responses 自定义端点丢失已有网关兼容参数。保留 `M4` 原断言，恢复旧绑定向 Pi 传递的参数，两种新协议仍按各自原生字段传输。定向复测 12/12。第二次从契约开始按序运行，契约 3 秒、类型检查 15 秒、全量测试 976 秒、构建 8 秒，均退出 0。前端 241/241、基础服务端 5/5、Agent 服务端 465 项通过，0 失败、0 取消，6 项既有专用环境用例默认未运行。详见 `first-full-regression.log`、`responses-compat.log`、`gates.tsv` 与本批对应日志。

第五道门禁 `npm run perf:frame` 用时 123 秒，退出 0。Fast 4G 的压缩构建 10/10 有效，进入工作台、字体就绪、输入可用的 P75 分别为 410.1、410.1、447.8 ms，字体较 2.1 基线减少 82.46%。首屏 CSS 原始 87,664 字节，压缩传输 15,079 字节。两种桌面宽度的审片与设置视觉对照均无差异。200 条消息、12 件作品、12 个作品事件、1 次快照，60.00 FPS，最慢单键 1.641 ms。见 `frame-browser.json`、`frame-browser.json.history.json`、`perf.log`。

## 3.1 多画幅成片、候选采用与工程文件预览

已定位四条 FFmpeg 管线、准备与本地受理共用的输入解析、上游画幅和探测事实，以及强制 16:9 的审片 CSS。选材批次公开的缩略图与服务端的下载地址用途不同。工程修订的旧清单有准确 blobId 与路径，作品库从同一归属的媒体记录可取得类型和字节数。改动范围为契约源及生成物、artifact-store、production-service、media-config、render-inputs、local-render、pi-tools、素材读取及 routes、agent-service、工作台、审片台、工程/作品库预览、样式及 travel-prompt-kit。用既有合成与素材用例扩充四路分辨率、时序、采用与安全文件预览实测。此批复用现有数据库结构。

0.1.54 先生成契约，再实现四条 FFmpeg 管线共用的画幅适配。Pi 的工具参数展开只支持具名定义。第一次定向回归暴露了嵌套 JSON Pointer 与它不兼容；把字段提为同一事实源中的具名定义后，Pi 素材和旁白链 35/35 通过。已明确指定的规格直接冻结，省略尺寸时从实际探测、上游生成声明或已冻结工程取得主画幅。混合媒体保留自己的适配及音轨参数。

| 3.1 定向验收 | 实际结果 | 本批证据 |
| --- | --- | --- |
| 四类合成、两种 9:16 输出 | 8 个 MP4 全部符合 720×1280 或 1080×1920、30 FPS；解码抽检两角无多余黑边。10 个尺寸预设各验 4 种帧率。 | `portrait-first.log`、`public-samples.log` |
| 30 秒混剪 | 仓库样片 5.373 秒，公开素材 3.847 秒，均含三种适配。两次成片均为 1080×1920、30 FPS，音视频结束时间差均为 0 ms。另逐个解码不动、推近、拉远、平移的方形 60 FPS 成片，首尾帧平均色值差分别为 0.06、7.58、7.59、15.70。 | `public-samples.log`、`public-sample-digests.txt` |
| 桌面审片 | Chrome 实际播放竖片，1440 与 960 窗口的水平中心误差均小于 0.01 像素，切到横屏旧稿仍保持 0.6 秒，页面均无横向溢出。 | `ui-browser.json`、`pc-portrait-1440.png`、`pc-portrait-960.png` |
| 三类素材与工程源码 | 候选播放前 0 次媒体传输、点击后 1 次，未登记采用或启动制作；HTTP 接口核实实际 MP4、归属及批次。500,027 字节工程文件仅请求 262,145 字节（含一字节判尾），跨 UTF-8 字符时展示 262,143 字节。单文件下载与原件逐字节相同，作品库与审片台复用同一预览。三组前端回归 176/176。 | `ui-browser.json`、`ui-suites.log`、`source-and-render.log`、`pc-project-preview.png`、`pc-material-video.png` |

公开素材复验使用 NASA 国际空间站实拍的 10 秒镜头，以及万相官方公开生成样片中截出的 10 秒，后者在进入合成前从原横片实际居中裁为 9:16。本次未向生成供应商申请新片。隔离图库用例的回源为协议替身。来源见 [NASA 画面库](https://images.nasa.gov/details/Earth%20Views%20from%20the%20International%20Space%20Station) 与 [万相官方样片](https://github.com/Wan-Video/Wan2.2#video-demos)。

首次全量回归记录到四项失败后停止。三项冻结工程测试对清单做全字段比较，期望值缺少本版新增的 blobId 和字节数。现按各自冻结修订和磁盘原件构建期望值，继续逐项比较路径、类型、版本、归属、顺序，并能检出错指同名文件。DD-10 的文件大小对照采用了新契约范围外的 160×90，改用 640×360，原有超限拒绝、逐文件额度与无副作用断言均保留。三项清单回归及一项大小受理回归分别通过 3/3、1/1。证据在 `first-full-regressions/`、`frozen-manifest.log` 和 `input-size-admission.log`。

3.1 最终完整门禁依次耗时 2、14、1048、9 秒，四项退出码均为 0。桌面端 248/248，基础服务端 5/5，Agent 服务端 467 项通过、0 失败、0 取消，6 项既有专用环境用例默认未运行。对应 batch-3.1/gates.tsv 与各门禁日志。

## 3.2 用户素材与视频参考图

现有素材登记、修订、强引用、命令回执和 Pi 原生图片输入足以承接上传。视频接口目前只读取第一个文字槽，模型目录与供应商适配分别限制输入。计划改动契约与样例、db、routes、agent-service、conversation-store、executor、assembly、media-probe、material-store、artifact-store、media-config、production-worker、三个视频端口、媒体请求序列化和 Nginx 上传位置；前端改动现有输入框、api、ProposalCard、来源详情及对应样式和测试。定向验收覆盖七种文件、实拍混剪和视频首帧、归属/版本/中断、Pi 真实图片投影、三个隔离 HTTP 端口及未经认可的精确画稿无扣费。沿用工作台现有审阅与授权入口。

契约 0.1.55 新增上传命令、准确修订附件和参考图槽位。SQLite v31 保留既有修订来源，区分用户授权的上传原件。服务端在同一登记事务内冻结原件和视频首帧，Pi 视觉输入和三路视频协议使用确切的文件与版本。上传专用 Nginx location 关闭请求缓冲，配置在隔离容器中通过 nginx -t。各适配器采用对应模型文档声明的请求字段与参考图数量限制。[火山方舟](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) · [MiniMax V2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) · [万相 3.0](https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-api-reference/)

| 3.2 定向验收 | 测得结果 | 本批证据 |
| --- | --- | --- |
| 上传、发送与清理 | 七种格式的原件逐字节一致。图片、音频、视频各自超限一字节均被拒，临时目录为空。并发重放只写一次。真实 Pi 消息含一张可解码图片与所选视音频的真实元数据。 | `uploads-review.log`，7/7 |
| 素材用于制作 | 上传原片、WebP 标识和 WAV 完成本地 1.6 秒有声混剪；从实拍抽取的首帧可进入图生视频提案。冻结代码工程以两个输入槽读取实拍与 WebP，输出视频与原件逐字节相同。 | `uploads-review.log`、`code-project-upload.log`，后者 1/1 |
| 参考图与认可 | 三家真实适配器向本机 HTTP 协议桩完成 9 次提交、查询和媒体交付，核对每个 Data URL 解码后的 96,453 字节、图片角色及自适应画幅。认可 v1 后 v2 草稿、另行登记为分镜草稿的上传图、共享同一 blob 的未确认图均阻断受理。 | `i2v-wire.log` 2/2、`uploads-review.log` |
| PC 操作 | Chrome 实际完成选择、粘贴、拖放七类原件、仅附件发送及历史回看。限速取消没有产生登记，伪文件返回 HTTP 400。1440 和 960 桌面宽度，旧版缩略图和点击后的审阅均指向 v1。三组前端回归 181/181。 | `ui-evidence.md`、`ui-browser.json`、六张截图 |

第一次类型检查发现测试读取 Pi 多种消息内容时未按内容块收窄类型，以及 Node 事件监听测试的导入声明不匹配。测试改为逐块识别 image 并等待 HTTP listen 回调，保留原字节断言。第一次全量测试还找出旁白槽仅凭 WAV 标签放行了未解码的输入。现在正常受理使用真实音频探测确认 WAV 格式，保留原有“仅凭标签不能用作旁白”的拒绝断言。旧用例 1/1、完整上传和干声混剪 7/7 通过。中止的门禁日志在 `first-full-regression/`，类型检查首轮在 `initial-types.log`。

第二次全量测试完成，Agent 服务端 476 项通过、1 项失败。20 件作品、10 张历史图片的定向复现确定，新增输入说明使 64k 隔离模型首次用量达到 48,083，越过 Pi 原生 48,000 整理阈值。SDK 把一轮供应商请求用于摘要，摘要后该会话的历史图像块数从 10 降为 0；不能把摘要调用计作第十次业务工具调用。工具契约内联现在对同名字段的相同说明只展开一次，所有校验关键字继续逐分支展开。保留原模型窗口、整理策略、历史图片和查询上限，另断言实际完成十次业务读取。复测首步 47,213，连续 11 次业务推理均为 3 次 SQL 读取，十次工具调用中的图片数均为 10。证据见 `long-context-regression/`、`context-first-call.log`、`context-usage.log`、`context-final.log`。

另用两份公开原件替换自动化测试的图案和纯音输入。NASA 国际空间站实拍分别经真实上传、混剪、视频首帧抽取及冻结代码工程；LibriSpeech 的真人朗读 1272-128104-0000 作为干声上传。实际摄影片段抽出的 807,874 字节 PNG 在三路协议桩中逐字节核对。对应 7+1+1 项全部通过，采样段、字节指纹和复跑命令在 `verify-camera.py`、`camera-assets.jsonl` 与三个 `camera-*.log`。来源为 [NASA Earth Views](https://images.nasa.gov/details/Earth%20Views%20from%20the%20International%20Space%20Station)、[OpenSLR LibriSpeech CC BY 4.0](https://www.openslr.org/12/) 及其[验证子集](https://huggingface.co/datasets/hf-internal-testing/librispeech_asr_dummy)。

按当前型号文档补核协议后，Seedance 2.5 的首帧及首尾帧任务发送 adaptive 并核对首帧画幅。模型支持 30 张角色参考图，视频操作单独扩至 31 个槽，MiniMax H3 和万相分别限制 9、10 张。冻结方舟 720p 成片的横、竖、正方形像素规格分别为 1280×720、720×1280、960×960。契约重新生成并检查通过，`i2v-wire.log` 三项通过。另用两个实际上传并认可的角色、场景图核实自动冻结到槽 1、2，全程受理计费运行数 0。见 `ark-profile-schema.log` 与 `role-links.log`。[方舟生成参数](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) · [MiniMax H3](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)

3.2 最终按序门禁退出码均为 0。契约 4 秒、类型 17 秒、全量 1055 秒、构建 11 秒。桌面端 253/253，基础服务端 5/5，Agent 服务端 478 项通过、0 失败、0 取消，6 项既有专用环境用例默认未运行。

## 3.3 字幕与本地时间线微调

已核对 Pi 免费配音边界、作品修订/认可、冻结操作输入、两条 FFmpeg 滤镜、现有本地受理和 worker 交付。改动位置为契约源与生成物、db、字幕生成与导出、pi-tools、agent-service、routes、production-service/store/worker、local-render、Docker 应用运行时及现有审片组件。验收使用实录语音、真实编码、版本校对、同项重合成，以及两种桌面画幅的字幕阅读。


字幕轨成为可校对、可认可的不可变修订。Edge 自带词边界时沿用原稿与已认可旁白的文字及标点；上传原声和其他配音使用本地 faster-whisper。冻结单一字幕修订后，裁切、镜头重排和旁白入点都参与映射。微调请求直通原本的本地受理与 worker，同一事项按原修订建立后继草稿。SQLite v32 记录微调来源运行。

在 30 秒实拍与真人干声上，通过实际 HTTP 端点重排两段、修改三个增益、打开旁白压低音乐后，软字幕从提交到 HTTP 206 可以播放用时 2425 ms，硬字幕 2773 ms。ffprobe 分别读到 H.264/AAC/mov_text 和 H.264/AAC。原运行、原修订仍可读，两条路径均未新建文本工具调用、付费提案或授权。五段真人朗读的声学起止用独立 FFmpeg silencedetect 作参照，最大偏差 2.25 ms。测试样本是同一段公开朗读分五次播放，此数字只代表该样本。见 `real-{soft,hard}.log`、`voice-acoustic-reference.log`、`voice-timing.json`。

Linux 生产基础镜像的 libass 实际渲染三套字幕样式、两种画幅。六张解码图均在安全区内，实际字体 Noto Sans CJK SC，未出现缺字记录。见 `glyphs.json`、`glyph-proof.py` 与六张 `caption-*.png`。Mac 的默认 FFmpeg 缺少 libass，硬字幕端到端另用支持该滤镜的 FFmpeg 9 完成。

首轮全量捕获到字幕创建响应丢失后更换命令 ID，导致操作可能重复。前端以最初修订和操作内容固定重试，仅在服务端明确返回版次冲突后重新绑定。初轮失败日志保存在 `initial-gate/`。另保留 20 件作品、10 张历史图、10 次工具读取的原长会话断言：规范化 Pi 内联工具契约的冗余标量类型后，首次模型用量 46,909，11 次业务推理分别进行 3 次 SQL 读取。见 `long-context.log`。

桌面实测使用事件唤醒的真实队列。1440×820 与 960×720 下，浏览器从点击到实际播放分别为 2466 ms（软字幕）和 2057 ms（硬字幕）；对应 HTTP 回执 258/247 ms、worker 完成 2239/1858 ms。鼠标拖动确实改变冻结顺序，v3→v2→v3 三次均保留 0.9 秒。源稿首句 200 ms，成片旁白延后 500 ms，原生字幕、SRT 与 VTT 的首句均为 700 ms。输入为测试样片、合成音与明确给定的词边界。桌面与真人语音两套证据各自独立。见 `ui-evidence.md`、`ui-browser.json`、六张截图与本批 `ui-*` 复现脚本。

在隔离解释器安装与生产版本一致的 edge-tts 7.3.1 后，实际 Edge 免费配音测试 1/1 通过，返回真实音频及递增边界，未调用付费语音端口。Linux arm64 生产基础镜像在断网、只读根、非 root 的容器内，使用相同固定模型成功识别 30 秒真人录音的 85 个词、五段明确的声学起止。证据为 `edge-native.log`、`asr-linux-offline-wheel.json`。

3.3 最终门禁依序为契约 3 秒、类型 12 秒、全量测试 985 秒、生产构建 9 秒，退出码均为 0。前端 259/259，基础服务端 5/5，Agent 服务端 480 项通过、0 失败，6 项既有显式环境门控。Linux 的附加在线镜像拉包测试因容器出口仅约 16 KiB/s 主动结束；相同 Linux 包与锁定权重已通过断网非 root 运行验证。

## 3.4 工程交付、空间与账务

已核对冻结工程文件、代码执行槽、成片运行与声音轨、项目/作品库预览、单用户认证及既有按 owner 过滤、受理事务、供应商观测、账单合并与 worker 生命周期。本批涉及契约、v33 迁移、auth/app/routes、导出、预算和账单处理、媒体端口、PC 导出菜单及管理员设置。交付物以原件与冻结输入完整性、时间线真实读回、双账号隔离、受理前预算和逐笔账单为验收依据。
### 3.4 已验证的交付

契约为 0.1.57，SQLite 为 v33。`agent/routes.ts` 和 `agent-service.ts` 继续使用具体修订与用户身份。`export-bundle.ts`、`edit-timeline.ts` 负责工程及剪辑格式。`studio-accounts.ts`、`billing-statements.ts` 与原有生产受理事务和费用台账共同处理账号、配额与逐笔结算。UI 在审片、工程和作品库使用同一个导出入口，管理员在「我的 → 成员与预算」管理团队。

新增的定向用例位于 `apps/studio/test/agent-team-billing.test.ts`（账号、预算及对账）、`agent-export-stream.test.ts`（归档路径及中断下载）和 `agent-team-exports.test.tsx`（PC 成员设置与具体稿件导出）。既有 `agent-db-indexes.test.ts`、`agent-local-creation-real.test.ts`、`agent-narrated-render.test.ts`、`agent-subtitle-remix.test.ts` 分别覆盖旧库迁移、按说明重现工程、长旁白尾帧、三种独立时间线读回。涉及修订选择的页面复用 `RevisionExports.tsx`，设置页复用 `TeamSettings.tsx`。

| 验收 | 实测结果 | 本批证据 |
|---|---|---|
| 按工程说明复现 | 两个不同工程，一个从源码生成，一个依赖前序作品。解压后执行记录的真实 Docker 命令，2/2 成片 SHA-256 与应用发布的原件相同。导出命令对齐了创作宿主的 PATH、语言及只读输入挂载。 | `docker-zip-digest.log`、`agent-local-creation-real.test.ts` |
| 三种时间线 | 在 30 秒 NASA 实拍与真人旁白的混剪中核对 2 段画面、1 段旁白、15 段循环配乐和 3 份完整源媒体摘要。Apple FCPXML 1.10 DTD 校验通过，OpenTimelineIO 和 pyJianYingDraft 分别成功读回；切点、源入点、音轨起止的最大误差分别为 0.4、0.4、0 帧。每条连接音频锚在覆盖其开始时间的画面上。 | `native-exports-30s.log`、`test/helpers/inspect-edit-archive.py` |
| PC 导出与账号 | 在 1440×820 及 960×720 核对实际菜单与登录态。旧工程 v1、定稿视频 v2、最新 v3 的六个下载各自指向正确修订；归档返回 410，编辑草稿和播放位置仍可恢复。创作者访问成员及预算设置返回 403，另一账号的私有对象、库游标与导出返回 404。 | `ui-evidence.md`、`ui-browser.json`、`owner-library.log` |
| 预算与免费操作 | 三轮独立 Node 进程、两条 SQLite 连接同时申请共享空间最后 1,200 分。每轮只写出一份运行、一份授权、一项用户操作。单会话、当日、当月及跨期在途预留均已验证；零额度下两个创作者可完成文本回合，真实本地字幕重剪可播放。 | `budget-race.mts`、`budget-race.json`、`owner-library.log`、`native-exports-30s.log` |
| 账单与迁移 | 合成的逐笔账单将待结算运行计入 75 分，供应商更正后为 40 分。重复明细不再记账，其他连接及不匹配身份不会结算该笔。v32 旧库迁移只回填未核尝试，三个新增索引都有 SQLite SEARCH 计划。60 个协议回归通过，包括视频帧尺寸、时长、方舟输出 token、图像 token、实时配音 token 及 MiniMax 字符数。 | `owner-library.log`、`v32-ledger-migration.log`、`provider-wire.log` |

桌面软件验收尚有环境条件。本机没有安装 Final Cut Pro、DaVinci Resolve 或剪映，格式读回与 DTD 审核的结果只覆盖工程数据。编辑器如何还原自动压低音乐等效果仍需在相应桌面版本试听。真实逐笔账单也需要可关联到任务的权威明细，支持的数据源及其字段见 `docs/guides/deployment.md`。本轮未使用商业账单账号或发出付费媒体请求。

第一次整套运行遇到审片测试的异步时序问题。作品标题来自快照，准确的修订徽标要等独立请求返回。用受控的修订响应使原断言稳定失败，再保留原有标题、版本和可访问名称断言，等待实际徽标到达。审片单文件 86/86 通过，零重试。见 `before-library-and-layout/`、`ui-stage-r4-delayed-red.log`、`ui-stage-full.log`。

另用两个已有制作模式复验。3.2 秒旁白配 2 秒画面时，导出保留原镜头并引用冻结成片的末帧延长段；两个不同修订使用相同原视频时，时间线保留两个镜头，包中媒体只占一份。两例通过，见 `narrated-hold.log`。同机可供桌面编辑器继续复验的三个真实工程位于 `.local/b34-export-fixtures/`。30 秒样片的两个目标切点为 0 秒和 15 秒，源入点分别为 15.1 秒和 0.1 秒；旁白贯穿全片，音乐每两秒衔接一次。

线上联调需要核对 `AGENT_UI_ORIGIN`、`VIDEO_FACTORY_AUTH_USERNAME`、`VIDEO_FACTORY_AUTH_PASSWORD_HASH`、`VIDEO_FACTORY_AUTH_SESSION_SECRET` 和 `FRAME_CREDENTIAL_SECRET`。使用创作容器时核对 `AGENT_CREATIVE_RUNNER_SOCKET`；使用外部账单源时核对 `FRAME_BILLING_STATEMENT_SOURCE`。方舟、万相、MiniMax 和 OpenAI 的商业凭据由管理员在模型连接中配置。裸机转录和 Edge 配音可以分别指定 `FRAME_ASR_HOME` 和 `AGENT_EDGE_TTS_PYTHON`，Compose 的配音解释器变量为 `FRAME_EDGE_TTS_PYTHON`。纯本地开发实例未配置凭据主密钥时沿用路线图规定的兼容模式，写入的开发凭据可能为明文；生产入口在缺少主密钥时停止启动。

### 3.4 最后一次首屏修订前的复验记录

契约、类型、测试与构建依次耗时 2、12、998、8 秒。随后 Chrome 报出三个未达标的读数。主样式文件 89,893 字节，按浏览器 `transferSize` 计入响应开销后为 90,193 字节，超过 89,999 字节上限。发送后的首次反馈 p75 为 2.8 ms，对照为 2.7 ms；本轮完成 p75 为 258.5 ms，对照为 247.5 ms。两端使用同一份应用和 Pi 离线场景，分别以原始字节和预压缩字节提供静态资源。这组数据没有显示一个可单独归因于模型或服务器的延迟。完整样本与失败的门禁保存在 `before-startup-css/`。

设置页原本就按需加载，其页面框架、个人资料与管理员目录的样式仍由初始入口加载。将这些规则放进已有的 `frame-settings.css` 后，初始样式文件减至 84,633 字节。Chrome 在 1440×820 和 960×720 两档窗口实测首屏 CSS 传输均为 84,933 字节。六页代表控件的计算样式逐项相同，成员页两档截图均与修改前逐像素一致，返回对话后草稿仍在。设置组件 32/32 通过，见 `ui-css-browser.{mts,json,log}` 与 `ui-css-settings-tests.log`。首屏字节上限、发送配对容差及可访问性断言均沿用原值。

标准测试命令按仓库约定跳过六条需要明确环境的用例，另用相应环境逐条验证。公开固定版本的 Huashu 包安装和卸载、Edge 在线免费配音见 `supplement-live.log`。真实 Docker 的二进制传递、Skill 创作和工程重现见 `supplement-docker-candidate.log`。其中 Pi 调度 Chromium/FFmpeg 的综合场景与全量检查并跑时超过原 15 秒操作期限，单独在同一候选镜像运行用时 12.66 秒，通过全部断言，见 `candidate-g21-isolated.log` 与 `candidate-g21-trace.jsonl`。Mac 的 Colima 共享目录不支持 Linux 应用容器直连宿主 Unix socket，测试通过真实宿主代理与 Docker 执行创作。另一轮并行转码时，五千文件扫描实测 59.99 ms，超过 50 ms 上限；保留原始日志 `team-export-index-concurrent.log`。

### 三份脚本交付时的重复读取

调整样式后的四道门禁依次耗时 3、12、903、8 秒，全部通过。随后第二轮 Fast 4G 首屏 p75 为 471.9 ms，输入可用 529.2 ms，首次反馈 2.8 ms，共 40 条交互均成功。回合完成 p75 仍比配对对照慢 8.0 ms（238.2 与 230.2 ms），超过 2% 容差，这一轮性能门禁失败。原始记录在 `after-css-first-send/`。

在相同构建与网络设置下另采 5 对 HTTP 瀑布。10 次真实页面操作均出现同一条助手消息读取 3 次、每件作品 head 各读 4 次的现象。请求开始和返回时间表明，多条变更事件同时读取同一条已更新消息，每次响应都会再读取消息所引用的同一组作品。唯一额外捕获的快照 GET 来自测速器在终态后核对三份持久稿件。见 `send-trace-before.json` 和 `send-trace-tool/`。

`AgentWorkbench.tsx` 现在在当前事件订阅内用服务端实际返回的消息版本判断读取是否满足后续事件。高于已读版本的事件会继续补读；引用处理复用同会话内已经发出的产物读取。独立认可仍刷新可变的认可状态，准确修订继续由既有 `agentApi.readRevision` 合并读取。两个新回归先在旧代码稳定失败，再以真实版本和请求次数通过。两份完整的工作台和审片测试共 182/182，见 `ui-send-{before,focus,regression}.log`。

用优化前后两个不同的生产构建，各做了 10 次同条件的真实 Chrome 发送。两侧均开启生产预压缩，Fast 4G、相同的离线 Pi 三稿场景和真实持久化。三个交付引用在每次优化后的操作里均精确指向 v1。

| 一次发送 | 修改前 | 修改后 |
|---|---:|---:|
| 读取同一条助手消息 | 3 次 | 1 次 |
| 读取三件作品的最新信息，合计 | 12 次 | 3 次 |
| API 请求总数 p75，包含测试器终态读回 | 28 | 16 |
| 首次反馈 / 临时交付 / 回合完成 p75 | 2.8 / 120.4 / 228.2 ms | 2.6 / 120.1 / 221.2 ms |

两份生产入口的内容标识分别为 `6b7cad14bda0` 和 `221b57cdf84f`。完整时间点及逐请求记录见 `send-build-comparison.json`、`send-build-comparison-summary.json` 和 `send-trace-tool/compare-sends.mjs`。这组对照测的是当前程序的发送成本，外部模型延迟需要线上独立测量。

### 性能对照的服务和样本

消息合并后的四道门禁为 3、11、871、8 秒，工作台 269 项、基础服务端 5 项、Agent 服务端 485 项通过。使用两个独立后台进程各测 10 次时，发送到终态的 p75 为原始侧 224.0 ms、压缩侧 233.3 ms，仍超过 2% 配对容差，见 `after-message-same-build/`。

随后固定做两组每侧 40 次的 Fast 4G 发送，对照使用同一份构建。两进程时回合终态 p75 差 1.06%，首次反馈 p75 为 2.63 / 3.12 ms。换成同一服务进程、端口和 SQLite 后，仅切换实际提供的静态文件。80 次浏览器操作均核实了响应编码。首次反馈 p75 为 3.13 / 3.00 ms，同一回合完成 p75 为 220.4 / 223.65 ms（+1.47%）。分组数据有波动，同一服务观测期间 8 核宿主一分钟负载为 10.46 到 29.41。这些数据支持在测量中固定后台并增加发送样本，无法据此认定任何特定生产供应商变慢。原始结果为 `send-independent-backends.json`、`send-encoding-control.json` 及 `encoding-control/host-load.jsonl`。

`perf:frame` 现在用一套真实后台，每次开启全新的浏览器上下文。只在两次访问之间切换临时静态目录的符号链接，原始资源和生产 Brotli 资源均由同一个 Fastify 静态插件提供。首屏每侧 10 次，发送每侧 40 次，首次反馈与完成的 2% 容差、字节上限、视觉检查和长会话阈值保持原值。采样器记录入口样式的实际响应编码，两侧截图独立落盘。15 个负向自检包括样本不足、编码不符和共用截图三个新用例。独立重放 200 条旧消息、12 件作品取得 1 次快照、60.00 FPS，最慢单键 1.834 ms，见 `final-history-direct.json`。

### 3.4 最终门禁与整轮交付

最终一轮按序完成契约检查 4 秒、类型检查 18 秒、全量测试 1,053 秒、生产构建 9 秒、桌面浏览器性能验收 234 秒。五条命令退出码均为 0。全量测试中，前端通过 269 项，基础服务端通过 5 项，Agent 服务端通过 485 项。6 项既有条件用例在上文记录的专用环境中另行通过。十批共 40 次标准门禁、3 次额外浏览器门禁均有通过记录。逐批日志与浏览器样本的最终交叉核对见 [final-verification.log](../../output/audits/roadmap-20261122/batch-3.4/final-verification.log)。

| 本地 Fast 4G，p75 | 原始静态资源 | 生产 Brotli 静态资源 |
|---|---:|---:|
| 冷启动，工作台可见 / 输入可用 | 1,268.5 / 1,334.0 ms | 475.4 / 540.8 ms |
| 首屏 CSS 实际传输 | 84,933 字节 | 14,737 字节 |
| 发送后首次反馈 / 首份临时交付 / 三稿完成 | 2.9 / 126.3 / 227.4 ms | 2.8 / 127.8 / 228.4 ms |

冷启动 20/20 次、发送 80/80 次有效。每次发送都从真实 SQLite 读回三份准确的 v1 稿件。两档桌面宽度的 8 组操作通过，12 个截图文件各自独立保存，首屏和模型页的 4 组像素比较均为零差异。200 条历史消息、12 件作品与 12 个作品事件共读取 1 次全量快照，实测 60.01 FPS，最慢单键 2.696 ms。使用真实浏览器、HTTP、SSE、Pi 与离线测试模型。生产文本供应商及阿里云负载不在这些耗时的测量范围内。逐次样本、截图路径及长会话时间序列分别见 [浏览器报告](../../output/audits/roadmap-20261122/batch-3.4/frame-browser.json)、[视觉比对](../../output/audits/roadmap-20261122/batch-3.4/frame-browser.json.guards.json) 和 [长会话报告](../../output/audits/roadmap-20261122/batch-3.4/frame-browser.json.history.json)。

## Batch 11 复审收尾

输入为《帧间 Frame 修复快照二次深度审计、收尾评估与高价值演进方案》，起点为上一份 ZIP 的 Git tree `3cd4be0ddb594b302d5574ff1c7d80b34ea5dc30`。本批处理 `NEW-01` 至 `NEW-06`，先生成并核对契约 `0.1.58`，再实现 SQLite `v34` 和业务读写。复审中建议评估的流式 ZIP 替换属于后续演进。现有 ZIP 中断后重新下载的回归继续参与门禁。

| 条目 | 根因与实现 | 定向验收 |
|---|---|---|
| NEW-01 | `billing-statements.ts` 按账单身份与版本入账，`due_at` 只保留下次处理时间。HTTPS 复用既有公网解析校验，并把已检查的 DNS 地址用于直连和原域名 TLS 验证。 | 先推迟 15 分钟，推进 60 秒后导入账单，结算立即从待核变为 75 分，重复导入匹配 0，权威更正为 40 分。4 个私网目标全部在发起请求前拒绝。 |
| NEW-02 | AuthGate 在 401、注销与账号变更时清除浏览器旧缓存。草稿、阅读位置和待重放命令使用当前 ownerId。个人及共享预算共用按时区计算的 UTC 区间。 | 北京时间 12 月 1 日 00:05 的 40 分同时记入新日、新月。次日该笔日用量归零，月用量仍为 40 分。纽约夏令时的 23 小时及 25 小时自然日均通过。 |
| NEW-03 | FCPXML 素材时长采用源帧率；静帧声明可读时长。在可见片段结束后而序列尚未结束的范围，用序列空段承接仍需播放的音轨。 | 用真实 31 帧／30 fps MP4、PNG 和既有 24 fps 成片构造旧时间线。DTD 与源帧率检查通过，片尾的 1 段旁白和 2 段循环音乐全部读回，淡出仍在最后一段。 |
| NEW-04 | 基础镜像安装固定 Systran base 权重与转录环境。转录按第一段语音锁定语言，中文提供简体提示词；VAD 以样片验证后的 160 ms 补边保留词缘。 | 用 PaddleSpeech 官方普通话样片构造跨 30 秒、有轻背景音和静音尾段的输入。首次 400 ms 默认补边在第二段末多识别一个「我」，160 ms 对照中两段均匹配原句，安静尾段输出 0 词。 |
| NEW-05 | Agent HTTP 和劫持的 SSE 响应都设置 `nosniff`；字幕和工程附件使用私有禁缓存。生产 80/443 模板与维护 location 共享安全响应头。 | 真实 Nginx 1.26 加临时证书运行，正常／维护／恢复分别为 HTTP 301/503/301、HTTPS 200/503/200，健康探针始终 200。五条安全头完整保留，维护 POST 同样返回 503。 |
| NEW-06 | 持久账号目录修订和会话版本。成员可启停、调整角色和重置密码。预算摘要按拥有的会话返回，其权限与团队配置分离。 | 停用、重新启用和重置后，旧 Cookie 仍是 401。最后一个活跃管理员的停用与降级均被拒绝。v33 升级保留旧账号 ID 与原创建回执。两种 PC 宽度实测完成换号和预算查看。 |

本批把初始化环境密码摘要限定为创建首个管理员时使用，网页重置随后持续有效。升级以前无法归属账号的浏览器缓存会在首次确认账号时清理。同一账号刷新保留已经隔离的草稿。已打开的 SSE 会话沿现有 5 秒授权巡检断开，新的请求立即按当前账号版本鉴权。完整的部署配置变更见 [部署说明](../guides/deployment.md)。

定向证据位于 `output/audits/roadmap-20261122/batch-11/`。包括 `billing-r3.log`、`focused-server-r2.log`、`focused-ui.log`、`browser-accounts.json`、`isolated-nginx-r2.log`、`openapi-pinned.log`。普通话源为 [PaddleSpeech 官方示例](https://github.com/PaddlePaddle/PaddleSpeech/blob/develop/demos/speech_server/README.md)。FCPXML 的连接音频以父元素时间为锚点。[Apple 时间属性参考](https://developer.apple.com/documentation/professional-video-applications/timing-attributes)

### Batch 11 最终验收

五道门禁按序通过，退出码均为 0。契约检查 3 秒、类型检查 10 秒、全量测试 1,014 秒、单独生产构建 7 秒、浏览器性能验收 232 秒。前端 272 项、基础认证 5 项、Agent 服务端 489 项通过，0 失败。Agent 测试另有 6 项原有专用环境门控。OpenAPI 也通过锁定版 jsonschema 校验。[门禁记录](../../output/audits/roadmap-20261122/batch-11/gates.tsv)

Fast 4G Brotli 组，工作台可见与输入可用 p75 分别为 474.4 和 531.2 ms，首屏 CSS 传输 14,737 字节。两组冷启动 20/20、发送 80/80。离线模型发送组首次反馈 p75 3.3 ms，三稿完成 p75 219.5 ms。200 条历史消息和 12 件作品只读取一次全量快照，约 60 FPS，最慢单键 1.515 ms。1440 和 960 两种宽度的四组首屏和模型页截图比较均为零像素差异。[逐次浏览器数据](../../output/audits/roadmap-20261122/batch-11/frame-browser.json) · [长会话](../../output/audits/roadmap-20261122/batch-11/frame-browser.json.history.json)

额外验证了尚无对账调度行时仍能直接结算，单笔 83 分立即入账。真实附件接口返回 ZIP、SRT 和时间线，均带 `nosniff` 与 `private, no-store`，冻结工程通过 `unzip -t`。[无调度行账单](../../output/audits/roadmap-20261122/batch-11/billing-no-schedule.log) · [工程附件头](../../output/audits/roadmap-20261122/batch-11/archive-headers.log)

使用最终构建在 1440×820 和 960×820 重新验证成员表、可用额度、401 后换号及角色变更。两种宽度均无横向溢出。创作者升为管理员后旧 Cookie 返回 401，重新登录才出现管理入口。定向旅程未产生付费媒体请求。[账号浏览器验收](../../output/audits/roadmap-20261122/batch-11/browser-accounts.json)

转录安装层用本次安装脚本、Linux wheelhouse 和固定权重断网构建，在只读根、UID 1001、禁网的 Linux arm64 容器中运行。自动识别和明确指定 `zh` 的两个语音段都符合公开参考句，词数为 16/16/0，末词结束时间 34,260 ms。两份实际 Dockerfile 均通过 BuildKit 静态检查。应用镜像全量重建停在既有 Debian 开发依赖下载步骤，禁网复现缺少 apt 索引，联网复验到 420 秒超时。真实商业账单和剪辑软件桌面导入为外部联调项。[离线转写结果](../../output/audits/roadmap-20261122/batch-11/mandarin-offline-proof.json) · [应用镜像构建日志](../../output/audits/roadmap-20261122/batch-11/app-build.log)

## Batch 12 修复（UIUX-01～12，已完成 2026-11-23）

输入为《帧间 Frame 全量 UI/UX 审计与修复方案》第 4 节 UIUX-01～12，基线为 Batch 11 工作区（未提交）。截至当前：UIUX-01（输入框遮挡，锚定滚动容器）、UIUX-02、UIUX-04（真实时长与版本对比）、UIUX-05（行级渲染收窄，新增 `test/agent-message-row.test.tsx`）、UIUX-06（切换热区）、UIUX-07（字体栈）、UIUX-08、UIUX-09 已完成并通过对应定向测试。UIUX-03 本批完成冷绿清场：`agent.css`/`frame-settings.css` 全量换算到 `--frame-*` 暖色 token，`frame-base.css` 独立入口保留字面量并对齐同一组值；语义琥珀按真实背景加深到 ≥4.5:1（`#8a6a52→#84644e` 等）；免费服务图标 `FolderOpen→PlugZap`。样式契约测试集中到 `test/agent-static-contracts.test.ts`（node 侧工程），新增冷绿 denylist、WCAG 对比度表驱动断言（文本 ≥4.5、图形 ≥3，token 解析自样式表并断言两处同名单值一致）与图标替换断言，9/9 通过；vitest 290/290、typecheck 退出码 0。

UIUX-10 已完成，三条措施：

- **设置目录快照（契约先行）**：契约升至 0.1.59，新增 `GET /api/agent/v1/settings/services` 一条响应返回全部 15 项免费服务当前配置（`FreeServiceSettingsDirectory` 定长元组，顺序与 `FREE_SERVICE_DIRECTORY` 常量一致）；`contracts:check` 退出码 0，agreement/IMPORT changelog 已补。`FrameSettings.tsx` 挂载只发一次目录请求，整体失败不逐项兜底，单服务 GET 保留给行级重试与 `STALE_REVISION` 回读；`agent-services-dialog.test.tsx` 断言挂载期间目录请求恰 1 次、单服务请求 0 次，503 后行级重试恢复单行，17/17 通过。
- **预算读取依赖收窄**：`AgentWorkbench.tsx` 预算 effect 依赖从 `view.runs`（每轮快照新引用）改为 `runsFinanceKey`（run 财务终态摘要串），`agent-static-contracts.test.ts` 增加源码契约断言防回退。
- **离线多作品演示口令**：`offline-scenario.ts` 新增第 4 条确定性口令「演示多作品总览与审片工作台」：种 4 条 20 秒本机样片（user_upload 上传路径、SOURCES.md 记录来源）→ `start_work`×3 → 一次 `deliver_artifacts` 交付 3 份脚本 + 2 条样片成片 + 3 组审阅组；绑定成片后修订口令交付静音孪生 v2（字节不同、时长一致）。`FrameWelcome` 离线装配把口令放进首屏示例。未装配媒体替身/缺宿主帧/重复口令/无对应样片均如实降级。测试：`agent-offline-scenario.test.ts` 8/8（状态机+降级+视频修订）、`agent-offline-demo.test.ts` 1/1（真实隔离库全链路：作品、审阅组、blob 共享、HTTP 可播放、静音 v2）。

定向验证：`contracts:check` 0、typecheck（server+client）0、`node --import tsx --test`（ark-video-settings/static-contracts/offline-scenario/offline-demo）23/23、vitest（services-dialog+workbench）115/115。

UIUX-11 已完成编码（构建验证进行中）：`docker/base.Dockerfile` 编译链入基础层（apt 列表补 `make g++`），新增 `ARG DEBIAN_MIRROR`（可选把 `/etc/apt/sources.list.d/debian.sources` 的 `deb.debian.org`/`security.debian.org` 替换为镜像站；受限网络下用 `--build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn` 实测基础层 apt 从 970 秒未完成提速到正常完成）；`docker/Dockerfile` build 阶段改 `FROM ${BASE_IMAGE} AS build` 并删除 `apt-get update` 行，应用镜像重建不再触碰 Debian 源。creative 容器继承基础层不受影响（入口 `env -i` 重置 PATH，G2-1 数据隔离不涉及工具链）。CI 哈希按 base.Dockerfile 内容计算，变更后自动触发基础层重建，无需改 workflow。

UIUX-12 已完成：`export-bundle.ts` 重写为纯 TypeScript 流式 ZIP_STORED 归档器——本地头按规范顺序（固定 30 字节 + 文件名 + ZIP64 扩展），全条目带数据描述符（0x0008）与 UTF-8 名标志（0x0800），`zlib.crc32` 进程内增量计算，文件按 1MB 块读取并在交给下游前复制（防流预取覆写共享缓冲），客户端中断由生成器 `finally` 即刻释放文件描述符；中央目录尺寸/偏移越过 32 位时逐字段降级 ZIP64 扩展，末尾常发 EOCD64 + locator + EOCD。删除内嵌 Python 脚本与 `spawn("python3")`（静态契约测试断言无 `child_process`/`spawn(`）。新增模块级并发流上限 4 路：`zipStream` 创建时计数、`close` 时归还，超限抛 `QUEUE_FULL`(429)。`apps/studio/package.json` 补 `engines.node >=22.2.0`（`zlib.crc32` 引入版本）。测试：`agent-export-stream.test.ts` 2/2（歧义归档名拒绝、中断后完整重下、python zipfile 逐项校验 + `unzip -t`、并发上限 QUEUE_FULL 与名额归还）；`agent-static-contracts.test.ts` 11/11；走导出路由的四个集成套件（local-creation-real/narrated-render/subtitle-remix/team-billing）34 过 0 挂 2 既有 docker 条件跳过。调试记录：首版本地头把 ZIP64 扩展写在文件名之前，python/unzip 把扩展字节当文件名读出 `b'\x01\x00\x10\x00...'`——中央目录侧顺序一直正确，故 `-lv`（只读中央目录）不暴露；按规范改为文件名在前、扩展在后后 `unzip -t` 与 `zipfile.testzip()` 全过。另确认 Node for-await break 会先 emit `error(Abort_ERR)` 再 `close`，`events.once("close")` 会被拒——测试改用手写 close 等待（生产行为不受影响）。

全量门禁结果（2026-11-23）：

- `contracts:check`（仓库根）退出码 0（契约 0.1.59）。
- `typecheck`（server+client 双工程）退出码 0。
- `npm test`（typecheck → studio:test → build 全链）退出码 1：3 个失败均为负载敏感的计时/清理类测试（详见下），typecheck 与 build 阶段本身通过；vitest 115/115。
- 失败分析：`agent-stock-performance.test.ts` OPT-03 nasa/met p95 阈值（>60% 缩短）在系统负载 20–37 下按设计失真——同机当时并行 Docker 基础层构建、外部进程（Virtualization.framework ×2、CodexCLI、data-agent-api）；复测两次失败者在不同 run 间轮换（nasa 69%→过 / archive 49.9%→挂 / 负载升高时全体 p95 抬升），且 `before` 基线同步抬升说明是资源竞争而非代码回退；本批改动不触碰素材抓取路径。`agent-creative-host-pool.test.ts` 命名卷 GC 用例为 temp 目录 `ENOTEMPTY` hook 清理竞争，同类资源竞争。**安静复跑（后台负载守望，1 分钟负载 <8 触发，实测 7.78）：`node --import tsx --test --test-concurrency=1 test/agent-stock-performance.test.ts test/agent-creative-host-pool.test.ts` 17/17 全过、退出码 0**——证实失败为资源竞争而非代码回退。
- Docker 复验（UIUX-11）：基础镜像带 `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple` 重建成功（ASR 阶段 55.6s，`frame-base:local` 3.01GB）；期间定位并修复第二个受限网络问题——hf-mirror 对 python-urllib 默认 UA 返回 403，`scripts/install-frame-asr.sh` 模型下载改带自定义 User-Agent（容器内复现：裸 urlopen 403、带 UA 200）。应用镜像全量构建（APP1）退出码 0、全程 0 次 apt-get（冷构建 `npm ci` 163.4s、`studio:build` 16.1s）。**`--network=none` 字面断网构建不可作为层复用证据**：BuildKit 的 RUN 层缓存键含网络模式，断网构建不命中联网构建的 `npm ci` 层（日志实证：`COPY apps/studio/package.json` CACHED 而 `RUN npm ci` 重新执行，以 "Exit handler never called!" 失败——容器内无 npm 缓存可离线安装）。据此改用等价验证：对 `FramePresentation.tsx` 做真实内容变更后热重建（APP3），`RUN npm ci` 层 **CACHED**（零注册表下载、apt-get 计数 0）、`COPY . .` 与 `studio:build` 如期重跑，总时长 42s（当时负载 ~14，`studio:build` 32.2s 对比 APP1 冷构建基线 16.1s，瓶颈为本机负载而非网络）；「30 秒内」判据**安静复测（APP4，负载 7.78/5 分钟 11.08）：38s、apt=0、`npm ci` CACHED、源文件已还原（3746 字节）**——耗时全在 `studio:build` 编译（26.1s，APP1 冷构建参考 16.1s）加构建上下文与导出层；本机 8 核常驻外部负载（data-agent-api 峰值 95% CPU、Virtualization.framework），30 秒判据在本机不可复现地达到，判**部分达成**：结构性目标（零 Debian 源依赖、依赖层零下载）已完全证实，打包耗时为纯 CPU 编译且随机器空闲度改善。变更探测注释已按原始字节精确还原（3746 字节）。
- `perf:frame` 首轮 validate 失败：`firstFeedbackMs` 配对 p75 B=2.8ms > A=2.5ms×1.02——0.3ms 微差在负载 20–37（Docker 构建 + 外部进程）下属调度抖动；负载降至 8 以下后重跑。**第二轮退出码 0 全绿**：selftest 15 项 PASS；配对指标 open.B（压缩构建）ready 475.6ms / fontReady 475.7ms / inputReady 535.6ms / cssBytes 14335（A 侧 1281/1281.1/1339.7/88335），send 配对 firstFeedbackMs A=4.3ms B=4.1ms、turnDoneMs 251.8/243.8ms；A/B 像素对比 1440 与 960 宽下 changed=0；frame-history 旅程断言全过——200 条历史消息、works=12、workEvents=12、全程 1 次 /snapshot、fps 60.0、最大按键响应 3.622ms。

### ZIP 交付（2026-11-23）

`~/Desktop/frame-batch12-audit-20261123.zip`（28MB，unzip -t 无错）：`code/`（工作区快照，排除 .git/node_modules/dist/.local/output/workspace 等本地目录）、`screenshots/`（14 张真实浏览器截图：欢迎屏、交付预览、聚焦审片、单作品工作台、三作品总览、修订链 v1→v2 静音版、版本选择器、设置三页、1280×720 与 960×480 视口）、`UIUX-BRIEF.md`（给外部视觉评审代理的简报：产品不变量、设计语言、7 个批评方向）、`AUDIT-PLAN.md`（审计计划原件）。截图会话同时验证了离线演示口令全链路：示例短语→三作品建立→总览未确认 5 项→绑定山径成片→修订口令→v2 静音样片交付并在预览打开（新 blob、静音按钮禁用、历史版本只读提示）。

### 浏览器验收收口（2026-11-23）

- **150% 缩放**：CDP 合成按键触发不了浏览器进程级缩放快捷键（Meta++ 下 devicePixelRatio 不变），改用逐像素等价模拟——CSS 视口 1440→960、DPR 2→3，与原生 150% 缩放的栅格一致。聊天+审片工作台（含视频播放器、四张资产卡、输入区）与作品库空状态两屏截图：`screenshots/15-chat-zoom150-equiv-960x569.png`、`16-works-overview-zoom150-equiv-960x569.png`；`scrollWidth=960=innerWidth` 无横向滚动，布局完整无重叠。作品库空状态语义正确：演示旅程未执行过定稿（定稿是独立显式操作），故定稿库为空。
- **真实浏览器对比度核验**：在 4399 验收服务上用 `getComputedStyle` 实测三个视图共 **138 个可见文本元素**的前景/背景色（前景含 alpha 时合成到最近不透明祖先背景，WCAG 相对亮度公式逐元素计算）：**0 个低于 AA 4.5:1**。聊天+工作台 65 项最小 4.74（「针对：」目标芯片，11px 墨灰 on 米纸）；聚焦审片 45 项最小 5.01；模型设置 28 项最小 5.01。原始采样：`.local/browser-artifacts/contrast-{chat,work,models}.json`。与 `agent-static-contracts.test.ts` 的表驱动 token 断言互为印证（token 层 + 真实渲染层）。

### 收口（2026-11-23）

逐项终报（根因/位置/复现/证据/验证等级/门禁汇总/自查声明）见 [`output/audits/roadmap-20261122/batch-12/FINAL-REPORT.md`](../../output/audits/roadmap-20261122/batch-12/FINAL-REPORT.md)。验证等级分布：本地真实链路 8 项（01/02/03/05/06/07/09/10，其中 04 部分真实链路）、夹具通过 3 项（04/08/12）、UIUX-11 构建实测但 30s 时长判据部分达成（38s，瓶颈为本机常驻负载下 `studio:build` 纯 CPU 编译；零 apt-get 与依赖层零下载完全证实）。全量 diff 防御式扫描干净（详见终报自查声明）；探测注释已按原始字节还原；零提交/推送/部署，商业媒体调用与原线上会话未触碰，等待用户授权。

## Batch 13 修复（B12-BUG-01～07 + AESTH-01～07，已完成 2026-11-23）


输入：《帧间 Frame 全量 UI/UX 审计与修复方案》遗留 7 项缺陷（B12-BUG-01～07）+ 7 项审美升级（AESTH-01～07）。

### 完成项

- B12-BUG-01（P0 焦点劫持）：种子样片不再以顶层产物出现，演示旅程首轮进入总览，4 条样片只经 SOURCES.md 记录；紧凑工作台焦点回到舞台。
- B12-BUG-02（P0 舞台裁切）：`--stage-video-height` 四档预算重列（54/90/98/132px），经 `:has(.agent-media-sources)` 计提 `--stage-source-budget`。四视口几何断言溢出为 0：1440×900（642≤664）、1280×800（593≤610）、1280×720（524≤530）、960×480（429≤436，认可按钮完整）。**对抗审查后结构性收口**：初版预算 63px 只按「单图来源」旧标记实测，未覆盖音乐 rows=3 署名（162.6px）与含适用范围（192.4/206.2px）的真实托盘，欠计 100–187px 仍会把工具条推出折叠线。改为把托盘收拢成 `<details>` 单行摘要（与既有 `agent-audio-original` 折叠模式同构，完整署名/适用范围折叠其内、展开由舞台滚动承接），预算按收拢占位实测 37px（margin 6 + 摘要行 30.8，1440/960 两档一致）计提；960 档视频高 254.1→249.1（恰为预算增量 5px），工具条上移且全在视口内、零溢出。
- B12-BUG-03（P1 矮窄裁切）：输入框第二行、欢迎示例卡、产物页签在 960×480/1280×720 无腰斩（截图 07–14）。
- B12-BUG-04（P1 新消息胶囊压线）：无任务条时胶囊与输入框保持可分辨间距。
- B12-BUG-05（P1 导航语义）：聚焦审片空态入口收敛，返回按钮命名统一。
- B12-BUG-06（P2 导出名额）：未消费流名额归还幂等；FrameSettings 目录错误如实透传（3/3 测试）。
- B12-BUG-07（P2 仓库卫生）：根目录 1.2MB `frame_video_factory.html` 与未跟踪的 `apps/codex-broker`、`packages/*` 清除（package-lock 同步）；未配置免费服务不再渲染空详情行。
- AESTH-01～07：欢迎态接触印相画桌、总览编辑部卷宗行、舞台放映暗场托盘与四级决策栏、78/14/5/3 色彩配比定案、三处有分量反馈+三处克制、三档视口标尺、设置页融入编辑部语言。

### 门禁

- `contracts:check`（仓库根，契约 0.1.59）退出码 0。
- `typecheck`（server+client）退出码 0。
- `node --import tsx --test --test-concurrency=1 --test-timeout=300000 test/agent-*.test.ts`：**通过**——512 项测试 506 通过、0 失败、6 跳过（超时类按设计跳过），退出码 0（2026-11-23 02:43）。
- `npx vitest run`：**通过**——11 个文件 291 项全过（2026-11-23 02:48）。首轮 3 项失败，归因与修复：
  1. `agent-workbench.test.tsx` R3-5 与 S1-13/14：本批 BUG-01 客户端守卫 `!next.activeRequestId` 写得过宽，把「进入进行中的会话仍直接展示最近产出」（S1-13「不抢旧阅读」契约）一并抑制。收窄为 `arrivalMidTurn = changed.length && activeRequestId`——只在**已观看会话**内回合未落定时不抢选，进入会话的首载照常直达（两用例恢复，且无任何测试依赖原宽条件；对 HEAD 版本单跑对照确认归因）。
  2. S1-13/14 第二断言（停止本轮按钮）：jsdom 默认视口 1024px 在 B12-BUG-03 抽屉化后属窄屏档，单产物视图收起聊天列、停止入口移入抽屉，宽屏契约不再成立于默认视口。用例改为 `vi.stubGlobal("innerWidth", 1440)` + finally 恢复（与 agent-work-stage.test.tsx 同法，避免泄漏影响后续 UIUX-06 窄窗用例）。
  3. `agent-work-stage.test.tsx` 比较版本用例：断言旧按钮名「返回聊天与作品」，B12-BUG-05 已按审计要求统一命名为「展开对话」（与「展开作品区」对称）。测试跟进新契约。
- 收窄守卫后 `npm run typecheck`（server+client）退出码 0；perf:frame 于最终代码重跑见下。
- `npm run perf:frame`（最终代码复测）：**首轮仅末段 frame-history 失败**——`maxKeyMs 8.20ms ≥ 4`（1 分钟负载 ~7.4 下单次按键调度抖动；同指标安静过窗 2.0–2.3ms），其余全绿：open A ready p75 1285.6 / cssBytes 89,990（上限 89,999）/ jsBytes 470,182；open B ready 471.5 / cssBytes 14,817；send 40/40 双侧 firstFeedback p75 A=2.4ms B=2.3ms（配对成立）、firstDelivery 145.2/145.6、turnDone 231.1/228.2；护栏 status=PASS。**安静窗口复跑（负载 7.90 入窗）退出码 0 全绿**，证据 `perf/.local/frame-1795374489854.json`：selftest 15/15；open A ready p75 1286.8 / fontReady 1371.7 / input 1344.5 / lcp 1252 / cssBytes 89,990 / jsBytes 470,182；open B ready 481.2 / fontReady 549.6 / input 537.2 / lcp 440 / cssBytes 14,817 / jsBytes 123,416；send 40/40 双侧 firstFeedback p75 2.4/2.3ms、firstDelivery 141.0/142.8ms、turnDone 228.0/227.8ms；护栏四组 status=PASS；frame-history 200 消息、works=12、workEvents=12、snapshots=1、fps 60.004、maxKeyMs 2.075。
- `npm run build` ×2（CSS 修正前后）退出码 0。
- `npm run perf:frame`（修复前基线，证据 `perf/.local/frame-1795371889558.json`，2026-11-23 凌晨安静窗口，1 分钟负载 4.53）：selftest 15/15 PASS。open A（identity）ready p75 1311.2ms / fontReady 1378.6 / input 1374.5 / lcp 1278 / cssBytes 89,961 / jsBytes 470,026；open B（brotli）ready 499 / fontReady 569.5 / input 561.3 / lcp 463 / cssBytes 14,821。send 40/40：firstFeedback p75 A=4.2ms B=4.0ms、firstDelivery 152.6/151.1、turnDone 251.2/247.7；护栏四组 ok=true；history works=12、workEvents=12、snapshots=1、fps=60.003、maxKeyMs=2.294。对抗审查修复后的最终复测见上。

### perf:frame 首轮失败与修复（2026-11-23）

1. `route open 原始 CSS p75=94702 超过上限 89999`（OPT-05 Fast4G 验收上限）。本批审美升级使入口 CSS 增至 94,402 字节（压缩分块 FrameSettings 19,133 已在懒加载侧）。修复：删除 `agent.css` 中 46+5 条死规则（`agent-work-heading`/`agent-chat-title`/`agent-delivery-*`/`agent-stage-tabs`/`agent-stage-actions`/`agent-profile-link`/`agent-item-nav` 等旧工作台残留，全部经「src/**/*.ts* 零引用 + 后缀防模板拼接」双检，测试仅 agent-work-center.test.tsx 自建 DOM 使用 `.agent-work-heading`（jsdom 不加载 CSS，无断言依赖）），入口 CSS 94,402→89,661 字节（余量 338）。`frame-settings.css` 内 12 条同类死规则位于懒加载分块、不影响入口指标，本批不扩大范围，留作后续卫生项。
2. `route send 护栏 960: 聊天引用必须各有一张准确绑定 v1 的脚本卡`。B12-BUG-01 修复后旅程终点为工作台（正确行为），960 紧凑模式聊天收进抽屉、引用卡不可见，护栏选择器过时而非产品回退（1440 侧通过、卡片数据正确）。修复：`frame-measure.mjs` 在无可见引用卡时先点「展开对话」抽屉再取卡（数据驱动，不硬编码宽度）。
3. 第二轮仅剩 `firstFeedbackMs B=4.0 > A=3.9×1.02`（0.1ms 调度抖动，Batch 12 已有同型先例）。安静窗口（负载 4.53）重跑全绿，A/B 配对恢复 4.2/4.0ms。

### 浏览器验收（14 张截图，`.local/browser-artifacts/b13/`）

01-welcome-1440x900、02-overview-1440x900、03-stage-1440x900、04-revision-v2-compare-1440x900、05-settings-services-1440x900、06-settings-models-1440x900、07-welcome-1280x720、08-overview-1280x720、09-stage-1280x720、10-revision-compare-1280x720、11-welcome-960x480、12-overview-drawer-960x480、13-stage-960x480、14-settings-services-960x480；复核追补 stage-sources-tray-1440.png、stage-sources-tray-960.png（托盘收拢 + 37px 预算后的舞台终态，几何断言两档零溢出）。

验收旅程（fresh data dir → 示例口令 01 → WORK_DEMO → 三作品 → 总览未确认 5 项 → 山径舞台 v1 → API 绑定修订 → v2 静音版）：v1→blob-oE4XfOMp54YKGXgn、v2→blob-TEoYMLsmK1C1PZS5（字节不同）；SSE 推送后 v1 自动转「历史版本 · 只读」（只读备注 textarea + 查看最新稿按钮），v2 舞台静音按钮禁用；比较版本展开「同一时间码 | 上一版 v1 (0:20) | 当前版 v2 (0:20)」。

### 对抗审查（Ultracode 终审，2026-11-23）

Workflow 13 个子代理（5 维度发现 → 每发现 2 名独立反驳者投票，≥2 票判实；共 755,544 tokens）：

- **判实 1（stage-geometry，important）**：来源托盘纵向预算 63px 与真实托盘高度不匹配（见 BUG-02 收口）——修复：托盘收拢 `<details>` + 预算 37px 实测。
- **判实 2（css-dead-removal）**：`agent.css` 死规则清理残留 `.agent-stage-actions .agent-stage-muted`（基类 `.agent-stage-muted` 已有同值 font-size）——已删。
- **判实 3（guard-fix）**：`WorkStagePanel.tsx` 工具条渲染条件尾部冗余 `&& (kind === "video" || kind === "audio")`（包装层已按 kind 门控）——已删。
- **驳回 1**：`agent-work-center.test.tsx:317` 引用 `.agent-work-heading` 判为孤儿子符串——实为先前已提交的测试自建 DOM 夹具，jsdom 不加载 CSS、与本批改动无关。

三处判实修复后全链回归：vitest 291/291、typecheck 0、build 0，960/1440 舞台截图复核。

### 绑定路径产品发现

聊天草稿的修订目标（`draft.targetArtifactId`）只能经 standalone paper 头部「提意见」按钮 → `discussArtifact` → `bindTarget` 设置；作品挂载产物始终重定向到舞台（selectedReview 匹配后 useEffect 清除选择），作品模式没有绑定修订目标的 UI 入口——舞台「记录意见」只产生反馈消息（红线设计）。Batch 12 截图使用了修复前泄漏页签路径；本批验收的修订绑定改走消息契约 API（`POST /conversations/:id/messages` 带 `origin` + `x-video-factory-request: studio` 双信任头，与 `agent-offline-demo.test.ts` 服务端测试同路径），其下游全部 UI（只读转换、v2 舞台、比较栏、静音禁用）在浏览器逐项核验。

### 环境备注（复现需要）

- `demoSeeds` 是 offline.ts 进程内 `Map`：重启验收服务即丢失 WORK_DEMO 种子，twinSeedOf 找不到样片会如实拒绝（「当前绑定目标没有对应样片」）；旅程中断后需清空数据目录重走。
- `npm run build` 后必须 TaskStop + 重启验收服务：fastifyStatic 对新哈希资源回退旧 SPA。
- perf:frame 需要 `PLAYWRIGHT_MODULE_PATH=/Users/jinkun.wang/work_space/data_agent/node_modules/playwright` + `PLAYWRIGHT_EXECUTABLE_PATH=$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`。

### 偏差与遗留

- **docs/过期文档（SKIPPED）**：审计前提不成立——13 个文件均为 git 跟踪的刻意归档（「过期文档」目录名即归档语义），非空目录垃圾。且该目录在工作树中的删除状态早于本会话开始（目录 mtime 2026-11-22 10:40 本地，会话始于 21:15），属先前遗留的未提交变更，本批未恢复也未扩大删除，保持原状待用户裁决。
- 工作树含多批次未提交变更（Batch 11+12+13 叠加）；`git status` 中 maintenance 三源文件+三测试与 `docs/过期文档` 13 文件的未暂存删除均为先前批次/会话遗留，非本批所为。
- 零提交/推送/部署，商业媒体调用与原线上会话未触碰，等待用户授权。

## Batch 14 收官（DECISION-01~06 + B13-POLISH-01~07，2026-11-23）

输入：《frame_batch13_audit_decisions_and_closeout_plan.md》6 项裁决 + 7 项精修 + 全门禁复验 + 三段本地原子提交（DECISION-06，用户已裁决执行；全程零 push/零部署）。

### 裁决执行

- DECISION-01（绑定修订对话入口）：舞台 ReviewItemCard 工具条新增「↗ 在对话中改这版」次级胶囊（对此时刻提意见 与 记录意见 之间），经 onBindChatTarget prop 线（WorkStagePanel → ReviewItemCard）只预填草稿不发送；随后的消息携带 target（artifactId/revisionId/workId/segment）以 mode:new 发出，输入框出现「针对：作品 · 产物」chip 并聚焦，草稿关闭只清目标不清文本。新增 agent-work-stage.test.tsx DECISION-01 用例：断言点击后零 POST、chip 出现、composer 空且聚焦、发送后消息契约完整、chip 消失。
- DECISION-02/03（仓库卫生）：.gitignore 移除 docs/过期文档 两条例外并新增 .codex-attachments/；删除未跟踪 .codex-attachments/ 目录与 apps/studio/tsconfig.{client,server}.tsbuildinfo（可再生构建副产物）。
- DECISION-04（入口 CSS ≤85,500B，**门禁 transferSize 口径**）：三阶段收敛——①审计文档指定的懒加载侧类族迁出（约 5.1KB）；②共享弹窗/按钮基元迁至 work-library.css（FrameSettings 静态 import 该块，保证先于两个懒入口 DOM 就位），设置面板专属字段族迁至 frame-settings.css，agent.css 原地只留同步入口所需的表单反馈（.agent-field-error/.agent-config-note，消费方含同步的 WorkStagePanel/AgentWorkbench）；③门禁实测暴露口径差：cssBytes 为所有 .css 响应 transferSize 之和（含 ~300B 响应头，与 B13 磁盘 89,661→门禁 89,990 的 +329B 差值同源），磁盘 85,476 折门禁 85,776 仍超线，追加同体合并四组：muted-11px 五选择器组、muted-10px 四选择器组（组位必须早于 agent.css 的 .agent-work-pane-title>span 12px 复 skin，否则反杀）、省略号三元组（.agent-task-heading strong/.agent-execution-summary/.agent-center-tools .agent-task-heading strong）、agent-soft-reveal≡agent-fade-in keyframes 去重（引用改指 agent-fade-in）。入口 index-*.css 磁盘终值 **85,020B**，门禁口径 **85,320 ≤ 85,500 ✓**（Batch 13 门禁终值 89,990）。
- DECISION-05（测试视口基线 1440×900）：test/setup.ts 重写——模块加载即设 innerWidth/innerHeight 1440×900，matchMedia mock 补齐 min/max-height 复合 AND 逻辑，afterEach 统一 cleanup+resetViewport；删除 agent-workbench（S1-13/14）与 agent-work-stage（比较版本）两处显式 1440 stub 与 finally 恢复；UIUX-06 显式 stubGlobal 960 落窄窗档（置于 renderAt 之前——窄态在挂载时读 matchMedia）。292 项客户端测试在新基线全绿（291+新增 DECISION-01）。
- DECISION-06：五道门禁全绿后三段本地原子提交（见文末），零 push/零部署。

### 精修项（B13-POLISH-01~07）

01 总览无缩略图卡「左文右章」双列栅格 + 胶囊 inline-flex/fit-content/grid-column -2/-1 右对齐垂直居中 + 空槽文案 #8a8d86 退后；02 放映底栏托条（模拟媒体连接/下载文件/素材来源同条带 --frame-shelf 底、去虚线分割、下载文件改次级操作标签）+ 满载展开面板内嵌白卡；03 即 DECISION-01 入口；04 舞台字幕/工具面板字号层级；05 窄窗抽屉 scrim（.agent-main>[id=agent-preview]::after rgba(36,37,34,0.18)，纯视觉层 pointer-events:none）+ 切焦描边 rgb(152,68,45) 2px 替代持续 focus-within 绿框；06 输入区上传播放进度保持；07 认可底栏状态语言（v2 已认可 pill + 以 v2 定稿并入库主按钮 + 审阅下一项）。

### 门禁（全部退出码 0，2026-11-23）

- `npm run contracts:check`（仓库根，契约 0.1.59）：退出码 0。
- `npm run typecheck`（server+client）：退出码 0。
- `npx vitest run`：11 个文件 **292/292 全过**（45.96s）。
- `npm run build`：退出码 0（entry index-*.css 85,020B；FrameSettings 懒块 18.7KB、WorkLibrary 懒块 5.6KB）。
- `npm run perf:frame`（证据 perf/.local/frame-1795407171769.json，1 分钟负载 ~4.6 入窗）：selftest 15/15；open A ready p75 1299.5 / inputReady 1359.5 / lcp 1269 / **cssBytes 85,320 ≤ 85,500（DECISION-04 达标）** / jsBytes 471,935；open B ready 487.3 / inputReady 548.7 / lcp 460 / cssBytes 14,317 / jsBytes 123,822；send 40/40 双侧 firstFeedback p75 A=4.4 B=4.0（配对成立）、firstDelivery 151.2/149.6、turnDone 238.5/237.8；护栏四组 PASS；frame-history 200 消息、works=12、workEvents=12、snapshots=1、fps 60.003、maxKeyMs 2.46 < 4。
  - 过程波动（均已定案）：①两轮因环境问题未跑（Playwright 执行体目录名应为 chrome-headless-shell-mac-arm64；一次 cwd 不在仓库根 Missing script）；②一轮 inputReadyMs B 615.7 > 588.5（负载衰减尾巴）；③两轮 send 配对 0.1~0.2ms 抖动（turnDone 240.4 > 235.6×1.02、firstFeedback 3.7 > 3.4×1.02）——分布核验为中位数几乎重合（firstFeedback p50 2.45/2.5、turnDone p50 B 反快 7ms）的尾部调度噪声，A 侧整体提速后 ±2% 配对守卫绝对容差仅 0.07ms，B12/B13 已有同型先例，安静窗重跑即绿。
- 服务端全量 `node --import tsx --test --test-concurrency=1 --test-timeout=300000 test/agent-*.test.ts`：**512 项测试 506 通过、0 失败、6 跳过（超时类按设计），退出码 0**；`test/auth.test.ts` 5/5 退出码 0（安静窗口清洁复跑，OPT-03 未复发）。此前两轮并发负载下的 505/1（OPT-03 stock 归档 P95 降幅 0.595 贴近 0.6 阈值；隔离重跑 5/5 过、降幅 0.645）确认为 CPU 负载敏感型抖动，本批零服务端文件改动。

### 浏览器验收（.local/b14-delivery/screenshots/，8 张）

02-overview-1440x900（右胶囊紧凑、无满宽黄条）、05-settings-services-1440x900（Pexels 单行）、11-welcome-960x480（标题完整 y=113-168）、15-settings-skills-1440x900（config-note 落款内边距）、16-stage-fullload-1440x900（一体托条）、18-revision-journey-v2-1440x900（真实点击「↗ 在对话中改这版」→ 输入「保留意思，语气安静一点」→ v2 静音版送达，chip 针对：山径晨光 · 成片 · 静音版、composer 聚焦零自动发送）、17-approve-finalize-state-1440x900（v2 已认可 plate + 以 v2 定稿并入库主按钮 + 审阅下一项）、19-narrow-drawer-scrim-960x480（POLISH-05.02：舞台态 960×480 开抽屉，::after 计算样式 rgba(36,37,34,0.18)/pointer-events none；同帧含修订旅程与【离线测试回放】前缀）。

几何复测：1440×801 视频 379px/托条收拢占位 40px/溢出 0；960×480 视频 244px/托条 40px/stageClipped 0（42px 预算两档成立）。

CSS 合并复核（重启离线服务实测计算样式）：approval-plate animation-name=agent-fade-in ✓；.agent-stage-muted 11px/rgb(92,96,89) ✓；.agent-execution-summary overflow hidden+ellipsis+nowrap ✓；muted-11 族 11px/rgb(92,96,89) ✓；.agent-work-pane-title>span 级联等价由源规则顺序静态证明（10px+muted 组在 agent.css:159、12px 同特异复 skin 在 :546 恒胜，与合并前一致；该类在演示视图不挂载故无活体样本）。

### 提交（本地三段，零 push）

- Commit 1 `chore(repo): remove retired legacy docs, maintenance modules, and obsolete bench scripts`：23 个历史退役删除（docs/过期文档 13 + maintenance 三源三测 6 + perf 旧 bench 4）+ .gitignore。
- Commit 2 `feat(agent-server): contract 0.1.59, sqlite v34, streaming zip64, and deterministic offline build/demo`：src/server/** + src/shared/** + contracts/** + docker/** + deploy/** + scripts/** + CI + skills + tsconfig.server.json + package.json(studio)/package-lock + 30 个 M 与 10 个新增服务端测试 + 4 个测试 helper/fixture。
- Commit 3 `feat(studio-ui): editorial studio craft overhaul, render memoization, and frame perf harness`：src/client/** + 8 个 M 前端测试与 setup.ts + 3 个新增 tsx 测试 + agent-static-contracts + bench-review-cuts.mjs + perf/bench/** + 根 package.json(perf:frame) + DESIGN.md + README.md + 本文档。
