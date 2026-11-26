---
name: colab-ltx-video
description: >-
  Use Google Colab GPU runtimes (via official google-colab-cli or Colab MCP) and Lightricks
  LTX-2.5 Distilled to generate ~5s 720p/1080p MP4 storyboard clips from a first-frame image
  and motion prompt, automatically release the GPU runtime on completion or failure, recover
  in-flight sessions before re-running, and ingest the MP4 into Frame (video-factory).
---

# Colab LTX-2.5 开源分镜视频生成技能

本技能由 Coding Agent 发起，使用 Google AI Ultra 的 Colab 计算单元（月度 2,000 CU）在云端 GPU 运行 **Lightricks/LTX-2.5 蒸馏版（Distilled）** 图生视频流水线，产出带原生音轨的 ~5 秒 MP4（默认 `121` 帧 @ `24fps` = `5.04s`），校验文件落盘后立即释放 GPU，并可直接调用 Frame 已有上传接口入库。

## 输入（Inputs）

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--first-frame` / `--frame-blob-id` | 二选一 | — | 本地首帧图路径（PNG/JPG/WebP），或 Frame 会话中的首帧 `blobId` |
| `--prompt` | 是 | — | 英文/中文镜头动作提示词（建议直接以主体动作开头，含运镜与环境声描述） |
| `--preset` | 否 | `720p` | `720p`（MVP：`1280x704` 生成并裁切为 `1280x720`，默认 `L4`）或 `1080p`（目标：`1920x1088` 生成并裁切为 `1920x1080`，默认 `A100`） |
| `--aspect` | 否 | `16:9` | `16:9` 或 `9:16` |
| `--duration-sec` | 否 | `5.0` | 自动对齐 LTX `8k+1` 因果帧网格（`5.0s` @ `24fps` → `121` 帧） |
| `--mount-drive` | 否 | `false` | 挂载 Google Drive 缓存 ~64 GiB 权重，避免每次新建运行时重复拉取 HuggingFace |
| `--conversation-id` | 否 | — | 传入后自动调用 Frame `POST /api/agent/v1/conversations/:id/uploads` 幂等入库 |
| `--hf-token` / `HF_TOKEN` | 首次下载 | 环境变量 | `Lightricks/LTX-2.5` 为受门控仓库，需同意协议并提供 Read Token |

## 输出（Outputs）

脚本向 `stdout` 输出结构化 JSON：
- `task_id` / `idempotency_key`：本地防重任务 ID（持久化在 `workspace/ultra-media/tasks.db`）
- `external_id` & `external_meta.colab_endpoint`：外部 Colab 会话名与后端运行时 Endpoint
- `local_file` & `file_sha256` & `external_meta.media_facts`：已校验的本地 `.mp4` 路径、哈希、分辨率、时长
- `external_meta.runtime_cleaned`：布尔值，确认 `colab stop -s <session>` 已释放 GPU 且 `colab sessions` 无残留
- `frame_receipt`（若传入 `--conversation-id`）：Frame 返回的 `UploadReceipt`（含 `artifactId`、`revisionId`、`blobId`）

## 首次配置入口（服务器持久化，Mac 授权后即可关机）

统一经 [ultra_config.py](../../../scripts/ultra_config.py)（或命令行 `ultra-config`）配置，凭据保存在仓库外的 `~/.config/ultra-media/credentials.env`（`0600`）和 `~/.local/share/python_keyring/keyring_pass.cfg`（`0600`），切换任意新 SSH 会话执行 `colab usage` 均无需再次登录：

```bash
# 方式 A：SSH 内交互式一步引导（含 HF_TOKEN 门控校验、Frame 登录校验、Google 远程授权码写入）
ultra-config setup

# 方式 B：分步配置并查看非交互就绪状态（google-auth-code 省略 --code 时使用隐藏输入读取）
ultra-config google-auth-url
ultra-config google-auth-code
ultra-config set-hf
ultra-config set-frame --url https://video.wangjinkun333.me --username '<USER>'
ultra-config status
```

## 用法（Usage）

统一通过可执行脚本 [colab_ltx.py](./scripts/colab_ltx.py)（远程内核执行脚本为 [ltx25_remote_worker.py](./scripts/ltx25_remote_worker.py)）运行：

### 1. 跑通单条分镜（720p MVP，取回后释放 GPU 并入库 Frame）

```bash
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py run \
  --first-frame /path/to/shot01_first_frame.png \
  --prompt "Medium tracking shot, the hiker steps onto the sunlit ridge as wind ripples her jacket, subtle camera push-in, crisp mountain wind ambience." \
  --preset 720p \
  --mount-drive \
  --conversation-id conv_xxx
```

### 2. 1080p 正式画质生成（A100）

```bash
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py run \
  --frame-blob-id blob_xxx \
  --prompt "Slow dolly in on steaming pour-over coffee on a wooden desk, morning sunlight, gentle pouring sound." \
  --preset 1080p \
  --gpu A100 \
  --mount-drive \
  --conversation-id conv_xxx
```

### 3. 超时先查原任务 / 兜底清理残留运行时 / 月度 2,000 CU 测算

```bash
# 超时或中断后先查原会话是否已生成 output.mp4，取回并释放 GPU，绝不盲目重跑
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py recover --task-id ltx-xxxxxxxxxxxx

# 检查并停止本机隔离配置下已追踪的会话（绝不盲停匿名 [?] 会话）
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py cleanup --session vf-ltx-xxxxxxxx

# 查看每月 2,000 CU 在 720p / 1080p 下的单条耗时与月度镜头容量（加 --query-live 同时查实时余额）
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py plan-cu --query-live

# 零 CU 消耗对比 T4 与候选卡（L4/A100）及同批热复用测算
python3 .agents/skills/colab-ltx-video/scripts/colab_ltx.py benchmark-compare
```

### 4. Frame 网页原生通道生命周期（由服务端 `ColabLtxVideoPort` 受控调用）

网页原生通道使用独立 `colab-sessions.json` 状态库与 `submit / query / cancel / release-batch / preflight` 子命令，先落盘本地 `attemptId` 再申请 GPU，按 `.safetensors` 头部与精确字节长度 + `cache_manifest.json` 核验全部 5 个权重文件，并支持同一 `runId` 多镜头驻留内存热复用（`warm_memory`）。

## 防重与 GPU 释放守则

1. **禁止手写裸 `colab new` 而不包 `stop`**：一律经 `colab_ltx.py` 执行；脚本在 `try ... finally` 中确保无论成功、校验失败还是异常中断都执行 `colab stop -s <session>` 并复核 `colab sessions`。
2. **相同输入自动幂等复用**：相同首图 SHA-256 + Prompt + 参数命中 `tasks.db` 已完成记录时直接复用本地文件（零 CU 消耗）；若上次处于 `submitted`/`timeout_unknown`，优先向原会话拉取 `/content/jobs/<task_id>/output.mp4`。
3. **Colab MCP 协同与 2,000 CU 规划详情**：参见 [colab-mcp-and-cu-plan.md](./references/colab-mcp-and-cu-plan.md)。
