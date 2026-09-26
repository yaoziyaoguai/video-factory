# 阿里云 VPN 恢复与素材复测 · 2026-09-21

## 2026-09-26 补充：国内服务误入 VPN

Wan 已生成的视频下载超过 60 秒。核实不是生成失败：同一 OSS 文件的 256KiB，经 VPN 用时 7.8–10.8 秒，国内直连只需 43–49 毫秒。修正分流后，正式容器同区间 39–53 毫秒；完整 7,959,313 字节只读传输 642 毫秒。后者 DNS 已切到另一个正常直连地址，不能将此数字视为同 IP 的固定吞吐承诺。

根因是现有 APNIC 国别表未覆盖部分国内服务地址。百炼和 MiniMax 国内接口的部分 DNS 地址也走了 tun0；不应按品牌把其国际域名一并改成直连，更不能关闭海外 VPN。

- `scripts/domestic-service-hosts.txt` 明确列出本次核实的国内模型/存储端点。
- `scripts/refresh-domestic-routes.py` 只解析这些域名的公网 IPv4，沿物理默认出口添加 `/32`、metric49 路由；不改变 default、SSH 保护、DNS 或海外规则。默认只读，`--apply` 才写路由。
- 云端安装为 `/usr/local/sbin/vf-refresh-domestic-routes.py`，域名表为 `/etc/proton-ovpn/vf-domestic-service-hosts.txt`；同名 service/timer 每五分钟刷新，并在开机后运行。原 ProtonVPN 服务未重启。
- DNS 失败保留已有路由并记录失败，后续周期再查；不删除旧地址，以免切断在途结果下载。新增国内来源/新 OSS 主机须核实后加入，国际端点不继承同品牌国内路由。
- 海外 OpenAI、Pexels、Pixabay、Wikimedia 仍经 tun0。前两者无凭据 HTTP 探针均返回预期 401，仅证明网络可达，不是模型/账号验收。

检查：`systemctl status vf-domestic-routes.timer`、`journalctl -u vf-domestic-routes.service`、对实际目标 IP 执行 `ip route get`。每条输出包含域名/地址，不含 Key、签名下载 URL 或请求正文。

回滚时先停止并禁用该 timer，按日志逐条删除本次添加的 `/32 metric49` 路由；不要 flush 主路由表，不改 ProtonVPN 和既有 metric50 中国网段。安装材料与变更证据留在 `/root/vf-domestic-route-fix-gcWbYi/` 及本地 `.local/dogfood-20260921/qa/cdf11-*`。

本次仅修国内误分流；历史海外图库的 45 秒超时不能据此宣称全部解决。没有降低媒体清晰度、扩大自动重试或绕过付费授权。

## 当前结论

用户提供 `jp-free-26.protonvpn.tcp.ovpn` 后，已从失联的旧节点切换到新节点。**2026-09-21 16:13:19（北京时间）VPN 初始化成功**，宿主机和 VideoFactory 容器的 OpenAI API 网络访问恢复，素材复测 11 项真实搜索/下载/解码通过。

不是完整产品 E2E 或模型推理验收；没有调用模型、TTS、付费生成服务。网站容器未重启、未部署、未 commit/push。

## 实际修改与安全措施

- 云端 `/etc/openvpn/client/proton.conf` 使用新 JP-FREE#26 配置（节点 212.102.51.110），保留服务器原有认证文件，不把密码或内嵌密钥带回本地日志。
- 保留现有 `/usr/local/sbin/proton-ovpn-updown`，不执行下载文件默认的 `/etc/openvpn/update-resolv-conf`；既有中国网段直连、宿主机源地址直连策略保持。
- 配置增加 `PROTON_OVPN_SPLIT_DNS_DOMAINS`，保留四个 OpenAI 域，并加入 pexels.com、pixabay.com、unsplash.com、coverr.co、wikimedia.org、metmuseum.org、nasa.gov、openverse.org、clevelandart.org、archive.org。未改变全局默认 DNS，没有将所有域名强制交给 VPN。
- Docker 既有内部 DNS 127.0.0.11 的上游是宿主机 127.0.0.53，因此能使用 systemd-resolved 分流；不需要改容器 DNS 或重启 Docker。
- 原配置备份 `/root/vf-vpn-repair-tsIAQq/proton.before.conf`，目录 root-only，配置文件 mode 600。用户上传原件和候选配置保留在该 root-only 目录，未提交到仓库。
- 切换前添加独立 SSH 临时保护表 10011/priority 10088，并预置 4 分钟自动回滚。原保护表 10010/priority 10090 恢复、独立 SSH 重连成功、宿主机和容器联网均验证后，移除本次临时规则/路由并取消回滚计时器。
- 最终 `ip rule` 恢复为原有 local、源地址直连 10090、main、default 四条。没有保留测试接口、测试 mark 规则或到期会再次改配置的活动回滚 timer。
- 仅重启 `openvpn-client@proton`；原网站容器运行时长不变，VideoFactory healthy，`http://127.0.0.1:4317/` 返回 200。

## 验证证据

### 新节点和网络

- 新节点 TCP 443/7770/8443 均可连接，分别约 1.204/0.195/0.174 秒。
- 隔离实例使用独立 mark 与直连表，`--route-noexec --ifconfig-noexec`，up/down 指向 `/bin/true`，不改变业务路由/DNS；最终收到 `Initialization Sequence Completed` 后清理，说明现有认证凭据和新节点 TLS 均可用。
- 正式切换后，宿主机 OpenAI `/v1/models` 无 Key 请求 HTTP **401**，约 1.450 秒；容器同请求 **401**，约 1.858 秒。401 在此只证明网络/TLS/HTTP 恢复，未验证账号权限或模型调用。
- NASA 搜索：宿主机 **200**，约 1.732 秒；容器 **200**，约 1.584 秒。
- ChatGPT 首页：HTTP **403**，TLS 成功，约 1.236 秒。只证明可到达网站并收到拒绝响应，**不代表 ChatGPT 网页可正常登录或对话**，本轮没有绕过站点限制。
- `resolvectl query archive.org` 返回 `207.241.224.2`，走 tun0；Openverse 返回 `104.20.17.1/172.66.153.86` 等，走 tun0。此前可疑解析不再出现在这两次检查中。

### 素材正式适配器复测

复用先前独立测试目录中的同一份 Python 源码，没有为通过测试改源码、放宽 TLS/SSRF、下载大小或超时上限。

| 来源/类型 | 结果 | 总耗时 |
|---|---|---|
| Pexels 图片 | 下载 135,569 bytes，867×1300，解码通过 | 4.838 秒 |
| Pexels 视频 | 下载 1,887,276 bytes，720×1280，解码通过 | 6.903 秒 |
| Pixabay 图片 | 下载 266,659 bytes，960×1280，解码通过 | 4.980 秒 |
| Pixabay 视频 | 下载 12,241,022 bytes，1280×720，解码通过 | 8.281 秒 |
| Wikimedia 图片 | 下载 3,413,462 bytes，3648×2736，解码通过 | 8.771 秒 |
| Wikimedia 视频 | 下载 8,500,625 bytes，1920×1080，解码通过 | 17.595 秒 |
| Met 图片 | 下载 3,873,091 bytes，3152×2534，解码通过 | 12.335 秒 |
| NASA 图片 | 下载 254,636 bytes，2000×1400，解码通过 | 6.495 秒 |
| Openverse 图片 | 下载 203,270 bytes，1024×768，解码通过 | 7.511 秒 |
| Cleveland 图片 | 下载 3,304,291 bytes，2302×3400，解码通过 | 14.640 秒 |
| Archive 视频 | 下载 32,375,175 bytes，1920×1080，解码通过 | 16.621 秒 |
| NASA 视频 | 搜索和媒体响应成功，但样本 3,405,523,317 bytes 超限，未完整下载 | 4.921 秒 |
| Unsplash / Coverr | 云端测试进程缺相应 Key，未测试鉴权 | — |
| Flickr（接入中） | 缺 Key，且既有接线尚未完成，不能算已接通 | — |

所有采用样本保留来源/作者/许可，没有把个人非商业许可一概排除。搜索/下载/解码不等于内容适合题目、裁剪后画质保证或全片制作验收。

整轮脚本 exit **1**，因为 NASA 视频样本超限及三项未配置；不能报告“全绿”。对 12 项实际联网检查，11 项全链到解码通过，1 项因文件限额未通过，不再是此前 12 项搜索连接失败。

本地证据：`.local/stock-verification-20260921-aliyun-vpn26/results-vpn26/summary.json` 和各来源 `evidence.json`。
远端证据及素材：容器内 `/tmp/vf-stock-check-aNMdKi/results-vpn26/`。
本轮测试命令：

```sh
ssh aliyun 'docker exec -e PYTHONPATH=/tmp/vf-stock-check-aNMdKi/src -e PYTHONDONTWRITEBYTECODE=1 video_factory_prod python3 /tmp/vf-stock-check-aNMdKi/scripts/verify-cloud-stock.py --output-dir /tmp/vf-stock-check-aNMdKi/results-vpn26'
```

## 过程中的失败，如实保留

- 初次本地 awk 参数摘要命令语法错误，未用于判断配置。
- 初次隔离 OpenVPN 同时指定 `--bind` 与文件中的 `nobind`，启动前失败；改用独立 fwmark，不绑定冲突参数。
- 后续隔离接口自定义名字没有指定 `--dev-type tun`，认证后报 tun/tap 类型错误；已补类型。一次旧日志检查竞争又错误停止探针，改为每次独立日志后隔离验证成功。上述均非节点不可达证据。
- 正式配置首次 DNS 域列表超过 OpenVPN 256 字节行限制，启动失败；删去尚未接通的 Flickr 域后满足限制，并在准备脚本加入行长度验证。随后正式连接成功。SSH 临时保护和回滚 timer 在此期间有效，未失去服务器管理连接。

## 剩余边界

1. 这次修复的是云端 VPN/选定域名 DNS，不是 Mac 的 DNS/代理；本机 Wikimedia 等既有问题不能据此标已修复。
2. 云端部署代码仍是旧版；新增素材 Python 模块只在隔离目录验证，不表示正式网站已经部署全部新来源。
3. Unsplash、Coverr 配置同步，Flickr 接线和 Key，NASA 合适大小的视频样本仍需后续处理。
4. 没有添加新的自动监控或节点切换系统；未来 VPN 节点再次失联时，`systemctl active` 仍不等于隧道健康。应查看最近握手/连接日志和真实 HTTP 检查，不盲目反复调用付费服务。
5. 原配置与回滚脚本在 `/root/vf-vpn-repair-tsIAQq/`，未删除；原节点已失联，手动回滚不保证恢复外网，仅恢复旧配置。网络变更应继续保留 SSH 直连保护。
