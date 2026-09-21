# 免费素材接入：实施与验证记录

日期：2026-09-20。基线：`main` / `86ebd37`，已有大量未提交修改。本轮保留已有修改，没有 commit、push、云端部署、账号注册、付费调用，也没有使用 Oracle Web。

## 结果

代码实现与离线回归已完成；**Wikimedia 真实下载未通过，尚不能宣称该来源在本机完整可用**。没有重新验证 Coverr / Pixabay / Unsplash / Pexels 的账号或额度，也没有做真实成片 E2E。

### Coverr

- 修复鉴权搜索自动跟随跨域跳转的问题：301/302/307/308 的离线 HTTP 传输测试均确认只访问原始目标。
- 签名缩略图不进入公开候选；安全 poster 可代替，否则显示没有缩略图。公开投影也处理既有私有候选中的不安全预览。
- 最多两页、每页最多 50 条；过滤、去重后补齐，不无限重试；保留官方 `mp4_download`，不重复上报下载。
- 真实官方 logo 放在 `apps/studio/public/media/coverr-logo.svg`，取自 `https://storage.googleapis.com/coverr-public/logos/logo-dark.svg`（官方文档所列对象的公共地址）。未修改图形。
- 候选、已采用素材工作区、素材库、授权待办共四个入口展示可点击来源。修复候选 UI 没有放行 Coverr 预览/来源的遗漏。
- 补齐正式 Python worker 和 CLI 的 Coverr 允许列表；此前单独选择它会在下载前被拒绝。
- 将未实现的“竖屏筛选”声明改为“横竖屏候选”。字段存在但非布尔 false 的 AI/premium 标记不会被当成免费实拍；旧协议缺失这两个字段时仍沿用已有处理。

### Wikimedia Commons

- 新增 `wikimedia-stock-v1`，无需凭据，只声明 `stock_video`；接入 Studio 目录、导演可选来源、运行元数据、pipeline 路由/免费允许列表、Python 调度及产物来源映射。
- 新 `src/video_factory/wikimedia.py` 仅负责元数据归一化；继续使用原下载器，不另造媒体获取路径。
- 两页有界查询、pageid 去重、只收视频、有限正数元数据、作者 HTML 转纯文本、精确许可名/URL 配对。
- CC BY、CC BY-SA、CC0、可核实的 Public domain 各自保留使用条件。未知/缺失许可与待审/争议条目排除；BY-SA 明确提示同许可分享，不偷加新的制作状态机。
- 选可解码格式的原片或转码：至少短边 720p，估算体积不超过 12,000,000 bytes，符合条件时优先较高分辨率。真实下载仍使用 Content-Length/流式体积保护，估算不是担保。
- 支持真实 API 的许可 URL 无末尾斜杠、Wikimedia UTM 参数、`thumb.wikimedia.org` 缩略图、WebM/OGV 扩展名。无凭据/签名查询参数进入公共预览。
- 来源、作者、许可沿 worker 产物、asset plan、现有发布/资源清单链保存；没有新增存储服务。

### Pixabay

- 小型本地文件缓存，完整 URL 的 SHA-256 区分账号和查询参数，缓存内容不写请求 URL/Key。
- 24 小时有效期、跨进程文件锁、原子替换、失败/无效响应不缓存。默认遵循 XDG 缓存目录；不静默跳过缓存去重复请求。
- 缓存目录必须可写；不支持共享缓存的机器间全局合并。本次没有新加清理调度器。

## 测试与构建证据

测试按 TDD 先重现关键失败再修复：鉴权跳转、签名预览、过滤后候选不足、Commons 不受支持、WebM 被命名为 MP4、worker 拒绝来源、UI 不显示署名、重复 Pixabay 请求。没有为测试加入题材、runId 或模型特判。

| 检查 | 结果 |
|---|---|
| `PYTHONPATH=src .local/python/.venv/bin/python -m unittest discover -s tests` | 157/157，exit 0 |
| `node --test --import tsx apps/studio/test/production-worker.test.ts packages/production-pipeline/test/generative-asset-worker.test.ts` | 126/126，exit 0；含免费来源与现有付费授权/重试/SSRF 回归 |
| Studio 中 `npx vitest run test/assets-page.test.tsx test/node-delivery-preview.test.tsx test/unsplash-attribution.test.tsx test/resources-manifest-page.test.tsx test/node-workspace.test.tsx` | 80/80，exit 0 |
| `npm run typecheck` | 最终代码重跑 exit 0，含 pipeline、Studio 与 Broker 类型检查 |
| `npm run studio:build` | 最终代码重跑 exit 0；Vite 提示现有主 bundle 超过 500kB，本轮未做无关拆包 |
| `git diff --check` | 交付前复查 exit 0 |
| `graphify update .` | exit 0；6251 节点，按工具上限未生成 HTML，没有尝试修 Graphify |

测试内容包括：跨进程缓存复用、并发查询合并、到期、账号/查询/媒体/数量隔离、失败不缓存；Commons 缺许可/作者、ShareAlike、超大原片合适转码、所有变体超大、低清、不安全 URL、NaN/Infinity、无结果、429 不重试、图片/音频拒绝；正式 worker 下载边界替身下的来源持久化；四个 UI 入口的实际呈现。

运行纠正：最初用系统 Python 3.14 跑宽回归，4 项因该解释器没有 Pillow 失败；切换项目正式 `.local/python/.venv/bin/python` 后全量通过，未修改产品逻辑掩盖环境问题。一次在仓库根执行 Studio Vitest 因错误工作目录未发现测试，随后在 `apps/studio` 正确运行通过。

## 真实验证：已通过与阻断分开

### 通过：真实公共查询

正式 `search_stock_assets("wikimedia", "Shanghai", limit=3)` 无 Key 返回两条合格候选：

1. pageid `179149132`：上海火车站5号站台，1920×1080，10.333 秒，作者 Zicheng zic，CC BY 4.0，选择 1080p VP9 WebM 转码（估算约 5.38MB），未选 29.8MB 原片。
2. pageid `81525976`：台风期间上海暴雨，1920×1080，8.163 秒，作者 SSYoung，CC BY-SA 4.0，同许可分享条件已保留。

这些只是验证样本，不写入产品条件。

### 失败：真实 worker 下载

执行：

```sh
PYTHONPATH=src .local/python/.venv/bin/python scripts/verify-wikimedia-stock.py \
  --query Shanghai --output-dir .local/stock-verification-20260920
```

进程按现有重试策略退出 1，错误：

```text
No downloadable wikimedia video asset found for scene 1: Shanghai.
Last error: Asset download failed after 2 attempts for wikimedia:179149132: URLError
```

独立诊断：同一 `upload.wikimedia.org` 媒体 URL 的 `curl -I --max-time 20` 和媒体域名根地址 `curl -I --max-time 15` 均为退出码 28 / 连接超时，未收到 HTTP 响应。公共搜索域名 `commons.wikimedia.org` 正常。现有证据定位为本机到媒体域名的连接问题，不证明是账号、许可、解析或服务器返回 403；不能据此武断断言哪段网络在拦截。

约四分钟等待来自现有下载器按地址尝试、每次 60 秒连接/读取超时与两次重试叠加；45 秒限制从响应体读取阶段开始，并非整次操作总时限。本次没有放宽 SSRF/证书/DNS 检查，也没有偷偷更换下载通道。此限制已在实施前资料包说明。

没有下载成功的媒体文件，所以 **ffprobe、真实解码、浏览器媒体播放、真实成片均未验证**。没有使用假文件冒充真实素材，也没有自动改走付费生成。

恢复验证需要当前运行环境可正常访问 `upload.wikimedia.org:443`。连通后用新的输出目录重跑同一脚本；成功才会产出 `evidence.json`、真实 worker 产物、ffprobe 结果和解码证明。不要无条件循环重试。

## 本轮边界

- 没有读取/输出账号密钥，没有产生现金消费。
- 付费 Freepik/Magnific、国内合作型 API、Flickr 视频下载权限仍待真实凭据/商务合同，本轮未实现。
- 不新增“必须允许商用”的筛选；未知许可并不等于已获得个人剪辑/公开发布授权。
- 当前运行中的 Studio 服务未主动重启；本轮构建产物不代表已替换常驻进程。
- 本记录只覆盖免费素材接入，不是全产品 QA 或完整安全审计。
