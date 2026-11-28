# Mac 端 StudioWright 双会员积分与远程派发配置说明

## 1. 为什么用独立 Profile 而不是接管日常默认 Chrome

1. **安全与登录反风控**：Chrome 136+ 禁止在默认用户数据目录上直接打开 `--remote-debugging-port`；同时 Google 登录页面会拦截带有自动化特征（`navigator.webdriver`）的浏览器。
2. **`sw auth login` 的做法**：先以无调试端口的纯净方式拉起你 Mac 上的 `/Applications/Google Chrome.app`，使用独立目录 `~/Library/Application Support/studiowright/profiles/<profile>` 完成手动登录；关闭窗口后，后续自动化才挂上专属回环 CDP 端口（`9300 + crc32(profile) % 90`）与防后台节流参数。
3. **两份 Google AI Ultra 积分池完全隔离**：
   - `ultra-1` → CDP 端口 `9377`、独立文件锁 `ultra-1.lock` / `ultra-1-music.lock`、独立配速器与积分统计
   - `ultra-2` → CDP 端口 `9314`、独立文件锁 `ultra-2.lock` / `ultra-2-music.lock`、独立配速器与积分统计
   两个账号可在同一台 Mac 上并行保活或自动轮转，登录态与 Cookie 始终留在 Mac 本机。

## 2. Mac 端一次性准备命令

在你的 Mac 终端执行：

```bash
# 1) 安装 StudioWright CLI (sw)
uv tool install git+https://github.com/umutkocak/studiowright

# 2) 登录第 1 个 Google AI Ultra 账号（打开 Flow 与 Flow Music 各确认一次后关闭窗口）
sw --profile ultra-1 auth login
sw --profile ultra-1 auth login --url https://www.flowmusic.app/

# 3) 登录第 2 个 Google AI Ultra 账号
sw --profile ultra-2 auth login
sw --profile ultra-2 auth login --url https://www.flowmusic.app/

# 4) 核对两个账号均已识别，并将自动化窗口移到屏幕外（切勿最小化窗口，最小化会暂停页面渲染轮询）
sw auth list
sw --profile ultra-1 doctor --music
sw --profile ultra-2 doctor --music
sw --profile ultra-1 window hide
sw --profile ultra-2 window hide
```

## 3. 服务器派发给 Mac 的连通方式

推荐通过 **Tailscale** 或反向 SSH 隧道让服务器免密访问 Mac（例如在服务器 `~/.ssh/config` 配置别名 `Host mac-studio`），然后设置环境变量：

```bash
export FLOW_MAC_HOST=mac-studio
export FLOW_PROFILES=ultra-1,ultra-2
```

若希望在 Antigravity 中直接以 MCP 工具方式调用某一个固定账号，也可在 `~/.gemini/config/mcp_config.json` 配置 SSH Stdio 桥接：

```json
{
  "mcpServers": {
    "studiowright-ultra-1": {
      "command": "ssh",
      "args": ["-o", "BatchMode=yes", "mac-studio", "$HOME/.local/bin/sw", "--profile", "ultra-1", "mcp"]
    }
  }
}
```
