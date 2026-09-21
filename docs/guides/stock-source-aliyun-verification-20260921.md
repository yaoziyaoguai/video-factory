# 阿里云素材源实测 · 2026-09-21

**最新状态：已用用户提供的 JP-FREE#26 恢复 VPN，11 项素材搜索/下载/解码通过。** 本文下方保留修复前的失败证据及排查过程，不再代表当前连接状态。当前结果见 [VPN 恢复与素材复测](aliyun-vpn-recovery-20260921.md)。

## 结论

当前这台阿里云服务器不能直接视为“素材源已可用”。10 家已接入来源中，8 家的 12 项真实搜索检查均连接失败；Unsplash、Coverr 在测试进程中缺 Key，未发鉴权请求。额外列出的 Flickr 仍在接入中且缺 Key，不计入已接通来源。

所有失败发生在搜索阶段，**没有验证任何云端素材完整下载、解码或渲染**。不能将本地 Met、NASA、Cleveland 先前的成功证据移用到阿里云。

## VPN 定向复查（用户补充已有 VPN 后）

### OpenAI 对照与历史时间线（2026-09-21 15:55，北京时间）

- 用户“以前能用”有日志支持：2026-09-02 19:08:02 最后一次记录 `Initialization Sequence Completed`；2026-09-10 16:26:52 出现 `Inactivity timeout (--ping-restart)`，16:28:57 起对既有节点连接超时，此后查询到的日志没有再次成功初始化。本次排查前问题已经存在。
- 9 月 1 日历史中有 AUTH_FAILED，但随后 23:32:57 成功连接；不能把这一历史鉴权失败误当作当前 TCP 超时的原因。
- 宿主机分别请求 `https://api.openai.com/v1/models`、`https://chatgpt.com`，不携带凭据、不生成内容。curl 两项均 exit 28，`Resolving timed out after 5000 milliseconds`，实际约 6.009/6.007 秒；HTTP 000，尚未建立 TCP/TLS。
- 容器内没有 curl，因此改用现有 Node fetch，单项 AbortSignal 8 秒、命令外层 timeout 15 秒；两项分别 2.539/2.021 秒报 `TypeError`、cause `EAI_AGAIN`。诊断脚本正常结束不等于连通成功。
- **当前这台云服务器的 OpenAI API 与 ChatGPT 均未连通**；不是测得 401/403 后误判，也不是已验证模型/账号不可用。OpenAI 域名 DNS 指向已失联的隧道解析器，与当前 DNS 失败相符。未调用模型、未产生费用、未修改服务器配置。
- 仍不能仅凭超时区分 VPN 节点停用与途中线路阻断；已有证据支持“过去确实连通，9 月 10 日掉线后未恢复”，不支持“用户从未配好 VPN”。

本节更新此前“出网阻断点未定位”的判断。采用 diagnosing-bugs 的日志与路由对照，仅只读检查和有界 TCP 探测，未执行修复。

**已定位主要阻断：OpenVPN 上游连接失败，但持久隧道及路由仍在；不是只缺 `HTTPS_PROXY`。**

- `openvpn-client@proton.service` 为 active/running；`tun0` 存在，地址 `10.98.0.9`。进程存活不等于 VPN 已连通。
- 日志在本次素材检查期间持续出现 `TCP: connect ... failed: Connection timed out` 和 `SIGUSR1[connection failed(soft),init_instance]`，约每 7 分钟重复。查询 2026-09-18 以来保留日志，没有返回 `Initialization Sequence Completed`；不据此推断更早历史或日志保留范围外状态。
- 配置只读提取的非敏感指令显示：TCP，三个 remote 均为同一个 IP `149.88.103.48`，端口为 8443、443、7770；启用 `persist-tun`。未读取 `proton.auth`、私钥、证书内容或账号密码。
- `ip route get 149.88.103.48` 指向 eth0/原网关，排除此次 VPN 节点连接被错误送回自己的 tun0。对三个已配置端口各做一次 5 秒 TCP 探测，分别 5.011/5.018/5.005 秒 `TimeoutError`，未进入 TLS/账号认证。因此不能认定账号或密码错误，也不能区分对端失效与中间线路阻断。
- 主路由表保留 `0.0.0.0/1`、`128.0.0.0/1` 经 `10.98.0.1 dev tun0`。Pexels、NASA 的宿主机目标路由均走 tun0。
- `video_factory_prod` 有 `172.21.0.2`、`172.19.0.2` 两个容器地址；对两个来源地址及对应 bridge 的 Pexels 转发路由查询均走 tun0。Docker FORWARD 链有相应 bridge 的出站 ACCEPT 和返回流量规则，POSTROUTING 有对应网段 MASQUERADE。证据不支持“容器完全没有接入 VPN”这一初始猜测。
- DNS 还存在另一项配置缺口：tun0 DNS `10.98.0.1` 仅负责 `~chatgpt.com/~oaistatic.com/~oaiusercontent.com/~openai.com`；eth0 默认 DNS 为 `100.100.2.136/100.100.2.138`。素材域名不在这组宿主机 DNS 分流域中。此前 Archive/Openverse 可疑解析需要在隧道恢复后复核，不能仅恢复 TCP 就宣称整个素材链通过。

修复顺序应为：先恢复现有 VPN 上游连接（必要时由用户提供可用节点配置），再调整符合用户预期的 DNS 分流，最后复测素材搜索/下载。不能为此逐家修改 adapter、关闭 TLS/SSRF 或盲目添加 HTTP 代理变量。修改或重启全机 VPN 会影响其他应用和 SSH，应在明确授权、保留现有 SSH 路由及备份/回滚方案后执行；此次未执行。

本轮新增唯一探测脚本首次因临时 Python 缩进错误 exit 1，没有产生探测结果；修正命令后才得到上述三个 TCP 超时结果。没有把失败命令算作有效证据。

## 执行范围与隔离

### 用户授权修复后的有界恢复尝试

- 核查现有备用配置：`/etc/wireguard/proton.conf` 与 `.before-port-tests` 均指向同一个 `149.50.211.159:51820`；OpenVPN 配置注释为 JP-FREE#18，现有 OpenVPN 三个端口也只有同一个节点 IP。`/etc/openvpn/client/backups` 为空，没有找到可直接复用的其他 OpenVPN 节点配置。
- 未直接切换全机 VPN。使用临时 `vf-vpn-probe` WireGuard 接口、独立 `fwmark=0x5646`、priority 10089 规则，仅让该测试接口的握手经现有直连表 10010 发送；不分配业务地址、不添加默认路由、不改变现有 tun0 或 DNS。
- 执行前用 systemd transient timer 安排 90 秒后清理，脚本 EXIT trap 同样清理。现有私钥只经服务器内部 `wg-quick strip | wg setconf` 管道传递，没有打印、复制到 Mac 或写进报告。
- 35 秒内 `successful_peer_handshakes=0`、`received_bytes=0`、`sent_bytes=1036`，测试 exit 2。证据只说明当前配置未取得握手，无法区分网络阻断、节点不可用或密钥已失效。
- 临时接口和唯一 fwmark 规则已删除，自动清理 timer 已停止；`ip rule show` 恢复到原有四条规则，SSH 新连接正常，VideoFactory 容器仍 healthy。没有改动两个正式 VPN 配置或重启任何业务服务。
- 有界查询 Proton 官方节点 API：首次提示缺 `x-pm-appversion`；提供客户端版本头后返回 `Code:401, Invalid access token`，没有取得节点清单。未尝试猜账号、复用 OpenVPN 密码登录账号 API、绕过认证、扫描陌生服务器或购买新服务。
- **当前未修复，等待可用节点配置**：需要用户从自己的 Proton 账号导出新的 OpenVPN TCP `.ovpn` 文件（或新的 WireGuard 配置）。现有 OpenVPN 用户凭据保留在服务器，无需在聊天中重发密码。拿到有效配置后，再做备份/自动回滚保护、隔离验证、切换、DNS 分流及素材重测；本次没有贸然修改尚无法验证的 DNS 方案。

诊断脚本留在本地 `.local/vpn-repair-20260921/probe-wireguard.sh`（不含凭据），`bash -n` exit 0；脚本的远端实际运行 exit 2，与未取得握手一致。未因测试脚本语法通过而声称 VPN 修复成功。

- 用户本轮授权通过 `ssh aliyun` 验证素材库，不是部署请求。
- 服务器：`iZ2zegpbz8w45hoyc1xau7Z`；现有容器：`video_factory_prod`。
- 现有容器中缺少新素材模块；把当前本地 Python 模块和验证脚本放入容器独立目录 `/tmp/vf-stock-check-aNMdKi`，通过该次命令的 `PYTHONPATH` 使用，不覆盖 `/app`，不改变服务进程环境或配置。
- 运行环境 Python 3.14.7、Pillow 12.2.0、已安装 ffprobe/ffmpeg。
- 使用容器已有 Pexels/Pixabay 环境变量鉴权，只报告配置是否存在，不打印 Key，不读取 `.env`，不从 Mac 传送凭据。
- 测试搜索词为公开通用词，不发送用户剧本、历史视频或其他私有数据。
- 脚本最多 2 项并行，每项独立进程最多 180 秒；每种来源/媒体类型只运行一轮，不另加重试。正式适配器已有的 1 或 3 次搜索尝试保留，未为测试放宽超时、安全或许可限制。
- 正式素材 adapter、正式安全下载器、真实 ffprobe/FFmpeg 路径；不是 HTTP 首页或 fake 结果。此次未走 Studio/导演选材界面，也不是产品 E2E。
- Pixabay 缓存限制在该临时目录；没有写入业务 workspace、数据库或历史 run。

## 逐项结果

| 来源 | 检查 | 结果 | 实测耗时 |
|---|---|---|---|
| Pexels | 图片 / 视频 | 搜索 URLError，已有 3 次尝试耗尽 | 121.246 / 121.317 秒 |
| Pixabay | 图片 / 视频 | 搜索 URLError，已有 3 次尝试耗尽 | 120.971 / 121.117 秒 |
| Wikimedia | 图片 / 视频 | 搜索 URLError，已有 3 次尝试耗尽 | 61.157 / 61.020 秒 |
| Met | 图片 | 搜索 URLError，1 次尝试 | 10.390 秒 |
| NASA | 图片 / 视频 | 搜索 URLError，1 次尝试 | 40.480 / 40.081 秒 |
| Openverse | 图片 | 搜索 URLError，1 次尝试 | 10.043 秒 |
| Cleveland | 图片 | 搜索 URLError，1 次尝试 | 20.631 秒 |
| Internet Archive | 视频 | 搜索 URLError，1 次尝试 | 10.179 秒 |
| Unsplash | 图片 | 测试环境缺 `UNSPLASH_ACCESS_KEY`，未联网 | — |
| Coverr | 视频 | 测试环境缺 `COVERR_API_KEY`，未联网 | — |
| Flickr（接入中） | 图片 | 测试环境缺 `FLICKR_API_KEY`，未联网 | — |

这些失败不是“没有匹配素材”，也不是已证实 Key 无效：没有收到可供判断的 API 成功/鉴权响应。缺 Key 指此次运行环境，不代表用户从未提供、未申请或其他环境中也不存在。

## 网络对照与原因边界

为区分 Mac 代理、Docker 环境、上游 API 和主机网络，仅进行了一轮宿主机对照：

| 宿主机 curl 对照（无 Key） | HTTP | TCP/TLS | 结果 |
|---|---|---|---|
| `https://api.pexels.com/v1/search` | 000 | connect=0，TLS=0 | 9.121 秒连接超时 |
| NASA `/search?q=PIA12235&media_type=image` | 000 | connect=0，TLS=0 | 11.320 秒连接超时 |
| Met v1.1 搜索 `Chinese painting` | 000 | connect=0，TLS=0 | 10 秒连接超时 |
| `https://www.aliyun.com`（出网对照） | 403 | TCP 0.024 秒，TLS 0.138 秒 | 0.158 秒收到响应；仅证明此地址能建连，不代表素材 API 可用 |

- 容器 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 均未设置。
- 宿主机 IPv4/IPv6 `iptables -S OUTPUT` 均为 `-P OUTPUT ACCEPT`；UFW inactive。只能排除这两项，未检查阿里云控制台安全组、云防火墙或上游路由。
- `archive.org` 系统解析为 `31.13.85.169` 和 `2a03:2880:f136:83:face:b00c:0:25de`；`api.openverse.org` 为 `108.160.163.116` 和 `2a03:2880:f130:83:face:b00c:0:25de`。与此前解析对照不一致，属于可疑解析证据；本轮未取得云端独立权威解析，不把具体 DNS 服务或网络产品认定为最终根因。
- Pexels 解析两个 IPv4 地址（104.18.66.220/104.18.67.220），NASA 四个 IPv4 地址；失败耗时与 urllib 按地址连接、单连接超时及已有重试叠加相符。特别是 NASA 声明的 30 秒检索预算未能中断正在执行的同步连接，实际约 40 秒。**每请求 10 秒不能宣传为整轮墙钟硬上限**；本轮脚本另设进程级 180 秒上限。

因此已能确认：失败不是只发生在 Mac，也不是只发生在 Docker，更不是已证实的素材返回格式问题。当前阻断集中在这台服务器的外网解析/连接路径；具体是解析、云侧出网策略还是上游线路，尚未定位完毕。没有修改 DNS、hosts、代理、防火墙，没有更换目标 IP 绕过，也没有关闭 TLS/SSRF 校验。

## 证据与复现

本地证据：`.local/stock-verification-20260921-aliyun/results/summary.json`，每项子目录的 `evidence.json` 保留失败阶段、错误、耗时、查询与媒体类型。远端对应 `/tmp/vf-stock-check-aNMdKi/results/`。

执行命令（再次执行必须换新 output-dir；不要直接重试以期碰巧成功）：

```sh
ssh aliyun 'docker exec -e PYTHONPATH=/tmp/vf-stock-check-aNMdKi/src -e PYTHONDONTWRITEBYTECODE=1 video_factory_prod python3 /tmp/vf-stock-check-aNMdKi/scripts/verify-cloud-stock.py --output-dir /tmp/vf-stock-check-aNMdKi/results'
```

运行完整结束，exit **1**，表示存在失败/未配置，不是全绿。

验证本地与临时目录代码 SHA-256 相同：

- `stock_assets.py`: `e4fd22c2bacf622ae9053712786a31151b9de7aaa34dc309ff672b9568ff2e25`
- `asset_transport.py`: `d68ac37d0b26df819778e307fd3b998fc9ae8a46b69d660f38665f764fee0712`
- `scripts/verify-cloud-stock.py`: `b8cfb3937826cfe6a0ed98e8298bc4176ae5ee8dcd46fd2f5922111ee0abe9bb`

额外检查：脚本 `py_compile`、`--help`、`git diff --check` 均 exit 0；Graphify AST 增量更新 exit 0。无产品代码修改，因此没有重跑产品全量测试。既有 Flickr 未完成接线/失败测试没有被此次联网检查解决，不能宣称工作树全绿。

## 下一步建议

1. 先诊断并确认这台服务器可用的合规出网路径；在此之前不靠继续增加国外来源数量来改善可用性，不把“已有 adapter/已有 Key”标成真实可用。
2. 配置确认后只重测失败层：公开搜索成功再下载一份合规素材、核验解码，最后测试 Studio 正式选材链。不要现在反复调用模型或付费生成。
3. Unsplash/Coverr 部署时核对并安全同步既有配置，不要求用户重复申请；Flickr 需先完成接线并取得用户自己的 API Key。
4. 国内库继续按官方 API 商务权限接入，不能以抓取、滑块绕过或盗用页面 Key 代替正式接口。

未 commit、push、部署、重启服务或修改用户数据；没有购买、付费媒体、模型或 TTS 调用。末次 `docker ps` 为 `video_factory_prod Up 31 hours (healthy)`，这只是容器健康，不是素材链路通过。
