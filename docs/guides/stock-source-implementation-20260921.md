# 素材库扩展实施与验证 · 2026-09-21

## 阿里云实测补记

**最新状态：用户提供 JP-FREE#26 后，云端 VPN 与素材域名 DNS 分流已恢复，11 项真实素材搜索/下载/解码通过。** NASA 视频样本超限、Unsplash/Coverr 缺云端 Key、Flickr 未完成仍如实保留。未部署正式产品代码。见 [VPN 恢复报告](aliyun-vpn-recovery-20260921.md)；下文为修复前历史证据。

2026-09-21 经用户授权，通过 SSH 在现有容器独立临时目录验证最新素材模块，不部署或重启。8 家来源的 12 项图片/视频搜索检查全部连接失败；Unsplash、Coverr 缺云端 Key，未测试鉴权；额外的 Flickr 尚未完成接线且缺 Key。没有一项进入完整下载/解码，不能把下文本地成功记录视为云端通过。宿主机 Pexels/NASA/Met 对照也连接超时；具体出网阻断点仍需诊断。详见 [阿里云素材源实测](stock-source-aliyun-verification-20260921.md)。

后续 VPN 定向复查已定位：Proton OpenVPN 进程存活但上游 TCP 持续连接失败，持久 tun0 路由仍吸收宿主机及容器流量；不是简单缺代理环境变量。三个现有节点端口各一次 5 秒 TCP 探测均超时。宿主机 VPN DNS 分流也仅覆盖四个 OpenAI 相关域名，素材域名未覆盖。未修改或重启 VPN；具体证据和修复边界见上述报告的“VPN 定向复查”。

## 后续增量：Internet Archive 与 128MB 视频上限

用户明确确认后实施；保留现有工作树，不提交、推送、部署、注册账号或购买。

### 实现边界

- `stock_assets.py` 本地图库视频下载上限从 12,000,000 提高至 **128,000,000 bytes**，覆盖现有图库视频，不改变 AI 生成服务的单独限额。图片仍 64MB/80MP；Content-Length、流式累计、超时、残缺文件清理、IP 固定、TLS/SNI、跳转及 SSRF 校验均保留。
- 新 `archive_stock.py`，使用官方 `advancedsearch.php` 与 `/metadata/{identifier}`。只搜索 `stock_footage` 集合且详情二次验证 collection/mediatype/identifier；用户 query 加引号并转义，不能改变集合条件。最多 6 个不同条目详情，与搜索共享 30 秒预算；错误如实报出，无无限分页/自动重试。
- 逐条采用明确 CC0/PDM/BY/BY-SA/BY-NC/BY-NC-SA，保留作者/标题/原站/许可和非商业/同许可条件。排除 ND、缺作者、许可不明、旧 `licenses/publicdomain/`、私有/受限条目及文件。集合归属和上传者声明不等于版权担保，使用前仍核对文件页。
- 选 MP4/WebM、短边至少 720、声明体积在限额内且时长为正；同分辨率选较小文件，不拿低清预览凑数。稳定 `/download/{id}/{file}` 地址，安全编码文件名，拒绝路径穿越；不固化 Archive 临时机器地址。下载后正式 ffprobe 检测真实分辨率/时长，坏文件清理。
- 设置目录、导演来源、免费路由、Pipeline 参数、worker、CLI、共用来源/署名 UI 与真实验证脚本接线。目录依赖 Python+ffprobe；已配置不表示外站网络可用。

### 测试与真实证据

- TDD 已重现新来源不支持、旧 12MB 限制、正式 worker 未注册；修复后通过。
- 新增 Archive 测试涵盖高清版本选择、NC 许可、ND/受限拒绝、路径安全、搜索词隔离、有界详情和共享预算、真实 FFmpeg 生成的测试视频经正式 worker/ffprobe 及来源持久化。测试视频是离线夹具，不是外站实证。
- 更新旧 Wikimedia 测试夹具：原片 30MB 在新上限下合法，会被作为有效备选；将测试所需“超限原片/超限码率”改为 300MB/200Mbps，继续验证无合法候选时拒绝，没有弱化安全断言。大图测试移除已失效的“视频仍 12MB”合同，由独立视频测试验证 128MB、头部与流式限额。Python 首次全量因此出现 8 个子用例失败，调整正确夹具后 **189/189，exit 0**。
- `npm run typecheck`、`npm run studio:build` exit 0；构建仍有原有 bundle 大小警告，未做无关拆包。TS/组件最终结果见后续补记。
- 最终补记：Studio worker/Pipeline 聚焦 **129/129**；相关三个 UI 测试文件 **66/66**，均 exit 0；全仓 TS/Broker 全量与浏览器完整制作链未运行，不扩大验收结论。
- 正式真实验证命令：`PYTHONPATH=src .venv/bin/python scripts/verify-wikimedia-stock.py --provider archive --media-type video --query 'Cumulus Clouds' --render --output-dir .local/stock-verification-20260921-archive`。
- **真实检索成功、下载失败，exit 1**：CumulusClouds（1920×1080 WebM，32,375,175 bytes，CC BY 3.0）在代理隧道阶段超时；既有两次尝试后总计 23.253 秒停止，没有解码/渲染。证据 `.local/stock-verification-20260921-archive/evidence.json`。不计为入片验收通过。
- 有界网络诊断：本机解析 archive.org 得到 `108.160.166.253`；以域名交给现有代理的普通 urllib Range 请求返回 206、读取 1024 bytes，最终官方主机 `dn800302.us.archive.org`。正式 IP 固定下载失败；对元数据声明的该官方主机也只做一次 15 秒 Range 诊断，同样代理隧道超时。另两次公共 DNS 查询返回 `31.13.95.48` / `185.60.219.41`，两个 DoH 诊断均 URLError。证据指向本机 DNS/代理解析路径异常，但没有获得可独立确认的权威解析，不武断声明已定位到某个代理产品或配置项。
- 未修改系统 DNS/代理、写 hosts、换用不固定 IP 的生产下载、增加镜像重试或改大超时。网络修复属于剩余事项；不要重新反复下载来掩盖。普通 1KB 对照请求不是正式下载成功。
- 新费用 ¥0；未调用模型/TTS，未启动完整视频生产任务，未重启正在运行的 Studio。当前构建文件已更新，不声称运行中页面加载了新目录。

## 前一轮增量：Cleveland 馆藏图片（2026-09-21，以下为当时记录）

- 根据用户“尽量接入”的要求，新增 `cleveland-stock-v1`，无需 Key，免费。通过官方 `/api/artworks/` 的 `q/cc0/has_image/limit` 检索，逐条检查 `share_license_status=CC0`，仅选官方 CDN 的 print JPEG，至少短边 720px，不使用 TIFF/低清预览；原站、标题、年代、作者与许可保留。
- 复用统一安全下载、图片体积与解码校验、缩放和渲染，无新基础设施。正式目录、导演能力、免费计费识别、Pipeline 参数、worker 产物、CLI 和共用署名组件均接线。未改变收费授权、讨论停点、其他来源路由。
- TDD 失败证据：检索报 Unsupported asset provider；接线前 worker 同样拒绝，Studio 导演能力返回 undefined。完成后检索与正式 worker 测试通过。覆盖许可缺失/受版权保护、畸形数据、伪造 CDN、无效尺寸、TIFF、小图、重复记录与真实下载尺寸覆盖 API 声明值。
- 首次使用系统 python3 缺 Pillow，属于解释器环境不匹配；改用项目 `.venv/bin/python` 后运行，未安装新依赖。
- **真实素材验证通过**：`PYTHONPATH=src .venv/bin/python scripts/verify-wikimedia-stock.py --provider cleveland --media-type image --query China --render --output-dir .local/stock-verification-20260921-cleveland`，exit 0。样本 `130939`（牛首玉人），2302×3400，3,304,291 bytes，完整链 8.431 秒。
- 证据：`.local/stock-verification-20260921-cleveland/evidence.json`；样片：同目录 `renders/1/final.mp4`；抽帧 `frame.png` 已检查。正式原件保留，渲染副本 1950×2880，最终视频 1080×1920、4 秒。
- **确定性验证**：Python 全量 182/182；三个相关 UI 文件 66/66；`npm run typecheck`、`npm run studio:build` exit 0。仍有已有 bundle 大小警告，未做无关拆包。Worker/Pipeline 最终检查见下方补记。
- 最终补记：`node --test --import tsx apps/studio/test/production-worker.test.ts packages/production-pipeline/test/generative-asset-worker.test.ts` **128/128，exit 0**；`git diff --check` 和 `graphify update .` exit 0。Graphify 因图大小跳过 HTML，未继续折腾工具。
- 本轮没有读取 Key、注册账号、购买、模型调用、TTS、提交、推送、部署或重启现有 Studio。费用 ¥0；静音素材样片不是全产品 E2E。运行中服务未证明已经加载新构建。
- **尚未接入**：Internet Archive 高清片段受现有 12MB 上限限制（CC BY 1080p 样本 32.4MB/86.3MB/182MB，容量小的 SF118 只有 320×240，不能降质采用）；Chicago 官方 IIIF 图片 403；Flickr/Europeana 等待 API 权限；国内商务库及付费国际库等待正式合同/接口。具体顺序与官方依据见 `stock-sources.md`，不将这些算入已可用数量。

## 结论与边界

在当前工作树接入无需 Key 的 Met 图片、NASA 图片/视频、Openverse 图片，Wikimedia 增加图片。正式目录、导演可选来源、Pipeline 参数、Python worker、免费来源识别和署名 UI 均已接线，不是只加配置入口。

**实现完成不等于每家已在本机可用。** Met、NASA 图片真实下载与素材渲染通过；Wikimedia、Openverse 有网络阻断；NASA 视频本轮样本过大，未完成真实视频下载。未重启现有 Studio，因此本次构建不表示正在运行的服务已加载新 TS/前端代码。

依据：用户提供的 `/Users/jinkun.wang/Downloads/AI视频素材库调研与接入决策_2026-09-21.md`。本轮只实现已明确的免费接入与检索/传输基础，不购买、注册账号、读取凭据、调用付费模型或媒体服务；未 commit、push、云部署。保留工作树其他改动。

## 实现内容

1. `src/video_factory/asset_transport.py`：已有系统/环境 HTTP CONNECT 代理支持；目标 DNS 公网校验、连接已校验数字 IP、原域名 SNI 与证书验证、每跳重校验、禁止 HTTPS 降级。代理凭据只发往代理。DNS/连接/握手有界等待，媒体请求总体 90 秒预算，最多两次下载尝试，慢速响应受 watchdog 约束；超时或截断不留半文件。不支持的代理类型明确失败，不静默直连。
2. `src/video_factory/open_stock.py`：Met 使用 v1.1 分页搜索，详情只采用 `isPublicDomain=true` 的原图；NASA 用 asset manifest 选择真实媒体，不把缩略图当正式素材，处理官方 URL 未编码空格；Openverse 保留 CC0、PDM、BY、BY-SA、BY-NC、BY-NC-SA 及具体许可 URL，排除 ND、显式敏感内容、缺作者/原站等候选。
3. Wikimedia 图像使用原始 JPEG/PNG/WebP，不使用缩略图伪装原片；保留逐文件许可和作者。
4. Met/NASA/Openverse 下载后检测实际图像尺寸或视频尺寸/时长；低于短边 720px、损坏文件不采用。未知元数据使用 0 表示未知，界面显示“尺寸待下载后核验”，不伪造 1080p。
5. 导演明确 query 不再被旧题材关键词规则覆盖；最多使用原 query 加两条已有 `search_terms`，无额外模型翻译。新源单次搜索/详情共享 30 秒预算、每请求最多 10 秒且不重试，响应最多 2MB。urllib 元数据请求的系统 DNS 仍不能承诺绝对墙钟硬截止；不把此预算描述为全节点的硬时限。
6. 同镜头候选的完全相同原站 URL 跨库去重；原站/作者/许可在共用署名组件展示。原站链接仅供点击，任意站点不作为自动加载缩略图白名单。

主要模块：`stock_assets.py`、`wikimedia.py`、`worker.py`、`cli.py`；Studio 的 `provider-catalog.ts`、`production-worker.ts`、`StockAttribution.tsx`、`NodeDeliveryPreview.tsx`、`presentation.ts`；Pipeline 的 `generative-asset-worker.ts`、`production-pipeline.ts`。未引入额外数据库/Redis/通用插件框架。

## 确定性验证

先建立失败证据再修复：新来源未注册、Wikimedia 不支持图片、代理未使用、未知尺寸没有写入真实尺寸、导演查询被题材规则覆盖、详情请求没有共用预算、重复原站没有去重、截断下载被当成功、NASA 空格路径无效。没有修改测试来接受失败行为。

- `PYTHONPATH=src .local/python/.venv/bin/python -m unittest discover -s tests`：174/174，exit 0。
- 网络聚焦 8 例包含本地真实代理、代理鉴权隔离、SNI/证书失败、私网跳转、HTTPS 降级、DNS 超时、截断清理及慢速 body 总时限。测试代理不访问外部服务。
- 新来源聚焦 8 例包含正式 worker 元数据落盘、非商业许可、重复原站、请求预算、NASA 原文件与 URL 编码、异常响应。
- Studio 五组组件测试：81/81，exit 0。
- `npm run typecheck && npm run studio:build`：exit 0；构建有既有大 chunk 警告，未展开无关拆包。
- worker / generative worker 聚焦回归结果见本文件末尾最终检查。
- 全仓 TypeScript/Broker 全量与浏览器完整生产链本轮未运行；不能以聚焦通过宣称产品全验收。

## 真实免费素材测试

复用脚本 `scripts/verify-wikimedia-stock.py`，新增 provider/media-type/render 参数，失败同样写 evidence.json 且 exit 1。每次使用新目录，不覆盖历史。真实链路：搜索 → 正式 `asset.prepare` worker → 本地素材与来源 → ffprobe → FFmpeg 解码 → 可选正式 renderer 渲染。无模型、无付费、无 TTS，样片使用静音。

| 本机样本 | 结果 | 证据目录（仓库根目录下） |
|---|---|---|
| Met：Chinese painting | 3,873,091 bytes；下载/解码/4 秒竖屏渲染通过，13.551 秒；抽帧检查正常 | `.local/stock-verification-20260921-met/` |
| NASA：PIA12235 图片 | 254,636 bytes；下载/解码/4 秒竖屏渲染通过，4.447 秒 | `.local/stock-verification-20260921-nasa-small/` |
| NASA：earth blue marble 图片 | 17,224,423 bytes 超过 12MB，拒绝，4.614 秒 | `.local/stock-verification-20260921-nasa/` |
| Wikimedia：Shanghai skyline 图片 | 搜索成功；媒体 TLS 握手通过代理超时，两次有界尝试后失败，22.302 秒 | `.local/stock-verification-20260921-wikimedia-image/` |
| Openverse：landscape | 搜索 URLError，10.090 秒；没有下载，没有重复请求 | `.local/stock-verification-20260921-openverse/` |
| NASA：Mars helicopter first flight 视频 | 首次发现官方路径空格导致 InvalidURL；补确定性测试并修复编码 | `.local/stock-verification-20260921-nasa-video/` |
| 同一 NASA 视频修复后复验 | 正确收到媒体响应，但 3,405,523,317 bytes 超过上限，拒绝，2.364 秒；未大量下载 | `.local/stock-verification-20260921-nasa-video-fixed/` |

成功样片路径分别为上述成功目录的 `renders/1/final.mp4`。全部目录保存 `evidence.json`，含耗时、错误阶段或 worker 产物、来源、尺寸和解码结果。不能把真实下载与静音素材样片说成“完整产品 E2E/专业审片通过”。

## 已知限制与后续顺序

1. **大图优化**：在初次收口时尚未实现；用户随后批准继续，现已完成，见下文“大图处理增量”。初次 12MB 拒绝记录作为修复前证据保留。
2. Wikimedia 当前本机解析 IP 经代理 CONNECT 后 TLS 超时，而域名代理路径曾成功；不能为追求成功绕过 IP 固定/私网检查。需后续处理网络解析/代理兼容性，不将此源报为已真实可用。
3. Openverse 本机连接未通。其许可是聚合索引，本轮保存原站链接与许可条件，**没有实现对任意原站授权的独立自动验证**。NASA 也不是无条件公版；只跳过显式 copyright 条目，发布前仍应核对原始作者/第三方权利。
4. NASA 视频有实现与合同测试，但真实测试仅证明大文件正确拒绝；需要合适体积的真实视频完成下载/解码/渲染验证。不得把图片入片代替视频验证。
5. 720px 短边门槛不等于裁剪后的 1080×1920 质量保证；裁剪分辨率、横图保构图策略、Pexels/Pixabay orientation/locale 与更全面跨库视觉去重没有在本轮全面实现。当前去重只覆盖同镜头完全相同原站 URL，不做昂贵感知哈希。
6. Flickr、Vecteezy、Magnific、摄图网/海洛等国内商务 API 等待正式接口合同、账号权益或凭据；未放空壳开关，未自动采购。国内图库业务合作与免费公共 API 接入分开推进。

本轮没有改变用户预算确认、收费生成授权、导演讨论与人工推进权。素材源失败不会在这些新增 adapter 内偷偷改为收费生成。

## 最终检查

- `node --test --import tsx apps/studio/test/production-worker.test.ts packages/production-pipeline/test/generative-asset-worker.test.ts`：127/127，exit 0。
- `git diff --check`：exit 0。
- `graphify update .`：exit 0，AST 增量更新完成；图超过可视化阈值，工具跳过 HTML，没有继续调整图谱工具。
- 分支 `main`，HEAD `86ebd37`；工作树原有多项修改均保留。本轮没有提交或推送。

## 大图处理增量（用户批准后实施）

### 合同与实现

- `stock_assets.py`：图片单独使用 64,000,000 bytes 下载上限，Content-Length 和流式读取均校验；视频仍为 12,000,000 bytes。Wikimedia 图片候选筛选同步新上限。坏图/超像素下载文件删除，不保留半成品。代理、SSRF、超时与重试上限没有放宽。
- `stock_images.py`：下载后的静态 JPEG/PNG/WebP 核验，最大 80,000,000 像素。渲染时再次读取真实尺寸和 EXIF 朝向；以 `min(1, max(1.5*输出宽/原宽, 1.5*输出高/原高))` 等比例缩放，不裁原图、不放大，不以限制长边的方式破坏横图裁竖屏的像素余量。
- 原件及原有媒体产物 SHA/许可不变。实际渲染分辨率明确后才生成 PNG 副本，避免用 1080p 的预压缩图影响后续更高分辨率输出。副本保持透明通道和 ICC；CMYK/其他不直接转换的模式使用原图，避免猜测颜色转换。
- `renderer.py`：图片输入复用上述预处理；每镜头处理记录写入 `*.render.json` 并汇入最终 `render_manifest.json.image_processing`，含源路径、源 SHA-256、原始字节/尺寸、定向尺寸、输出尺寸和目标分辨率。视频渲染与时间轴逻辑没有变更。
- 这不是保证所有画质完全无损的压缩：多余分辨率经 Lanczos 缩减，PNG 编码不再额外有损。不会压低原本不足输出需求的图片；80MP 是解码输入约束，不是操作系统级硬内存配额；极端长宽比可能不缩小。保留原件与副本会增加本地总磁盘占用，优化的是反复渲染的输入像素，不承诺总存储节省。

### 验证

- 首个失败测试证明约 14.5MB 的真实 PNG 原先被拒绝，修复后图片成功、同体积视频仍拒绝。
- 新增 5 项聚焦测试：大图下载/视频不变；裁剪余量/原件 SHA/4K 不复用低清副本；EXIF/透明通道/不放大；超像素/损坏图与临时文件清理；头部/无长度流式下载上限。
- 原有 Unsplash 测试将字符串 `image-bytes` 改为真实编码 JPEG，仍验证原字节和鉴权行为；旧渲染命令测试补建实际图片，不再引用不存在的图片。这些是测试夹具真实化，没有弱化行为断言。
- Python 全量 **179/179，exit 0**；`npm run typecheck`、`npm run studio:build` **exit 0**，仍有原有 bundle 大小警告。
- Studio worker 测试首次与构建清理 dist 冲突，出现 `ERR_MODULE_NOT_FOUND`，不计为通过；待构建完成独立重跑，结果见末尾。

### 真实免费证据

- 原失败图片：NASA `GSFC_20171208_Archive_e001386`，17,224,423 bytes，8000×8000。现在搜索→正式 worker 下载→解码→4 秒 1080×1920 静音样片通过，9.280 秒。
- 证据：`.local/stock-verification-20260921-nasa-large-image/evidence.json`。
- 原文件 SHA-256：`55924f1759c591b72cf8849d345e5a1ea410302df1050c21beb3dd793ccba27c`。
- 副本：2880×2880，9,924,849 bytes；处理像素从 6400 万降为约 829 万，原件不覆盖。
- 完成最终清单接线后复用同一已下载素材离线重渲染，未再次下载。最终产物：`.local/stock-verification-20260921-nasa-large-image/renders/2/final.mp4`，对应 `render_manifest.json` 已验证包含原件→副本记录。抽帧人工视觉检查通过，未发现旋转或解码异常。
- 新费用 ¥0；未调用模型/TTS，未重启现有 Studio，未提交/推送/部署。本次不改变先前 Wikimedia/Openverse 网络阻断结论，也不是完整产品端到端验收。
- 构建完成后独立重跑 Studio worker 测试：**21/21，exit 0**；`git diff --check` exit 0。按项目 Graphify 技能要求执行一次 `graphify update .`，exit 0；没有修复或扩展图谱工具。
