---
name: flow-video
description: >-
  Generate MP4 video clips on Google Flow using StudioWright across two signed-in Google AI
  Ultra Chrome profiles on a local or SSH-connected Mac (keeping browser login state on the Mac),
  recover timed-out clips by media_id without re-spending credits, and ingest MP4s into Frame.
---

# Google Flow 视频生成技能（StudioWright 双账号调度 + Mac 远程网页执行）

本技能由 Coding Agent 发起，通过 [flow_video.py](./scripts/flow_video.py) 把任务派发给持有 Google 登录态的 Mac（或本机），调用 **StudioWright (`sw`)** 在独立 Chrome Profile（`ultra-1`、`ultra-2`）中驱动 Google Flow 生成 MP4，拉回服务器校验后调用 Frame 现成的 `/api/agent/v1/conversations/:id/uploads` 入库。

## 双份会员积分机制说明

- StudioWright **不侵入日常默认 Chrome Profile**（Chrome 136+ 禁止在默认用户目录开启 `--remote-debugging-port`），而是为每个 `--profile` 创建独立 Chrome 用户目录（`~/Library/Application Support/studiowright/profiles/<profile>`）与独立本地回环 CDP 端口（`ultra-1` → `9377`，`ultra-2` → `9314`，互不冲突）。
- 在 Mac 上分别用两个 Google AI Ultra 账号登录 `ultra-1` 与 `ultra-2` 后，脚本自动按冷却状态、积分余量与历史负载择优派单，并将 `sw_profile`、`job_id`、`project_id`、`media_ids` 写入本地 `workspace/ultra-media/tasks.db`。登录 Cookie 全程留在 Mac。

## 输入（Inputs）

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--prompt` | 是 | — | 镜头动作与画面提示词 |
| `--start-frame` / `--frame-blob-id` | 否 | — | 首帧图路径，或直接传 Frame 会话中的 `blobId` |
| `--end-frame` / `--ref` | 否 | — | 尾帧图（`frames` 模式）或多张参考图（自动切 `ingredients` 模式） |
| `--model` | 否 | `omni-flash-1.2` | `omni-flash-1.2`（支持 3–15 秒任意整秒，含 5 秒）、`omni-flash`、`veo-lite`、`veo-fast`、`veo-quality` |
| `--duration` / `--resolution` | 否 | `5` / `720p` | Omni 系列支持时长与 `360p`/`720p`；可通过 `--size 1080p` 下载 Flow 超分版 |
| `--dry-run` / `--max-credits` | 否 | `false` / `25` | `--dry-run` 零消耗查询当前账号报价；`--max-credits` 超限拒单 |
| `--profile` / `--profiles` | 否 | `auto` / `ultra-1,ultra-2` | 自动在两份会员积分间路由，也可固定指定单个账号 |
| `--mac-host` / `FLOW_MAC_HOST` | 否 | `local` | Mac 的 SSH 目标（如 `mac-studio` 或 `user@100.x.y.z`） |
| `--conversation-id` | 否 | — | 传入后自动入库 Frame 会话 |

## 输出（Outputs）

输出 JSON 包含：
- `task_id`、`external_id`（StudioWright `job_id`）、`external_meta.sw_profile`、`external_meta.project_id`、`external_meta.media_ids`
- `external_meta.credits_spent`、`external_meta.credits_left`
- `local_file`（本地已校验 `.mp4` 路径）、`file_sha256`、`frame_receipt`（若开启入库）

## 用法（Usage）

### 1. 云端单账号零积分预检与草稿回退（Linux `cloud-1` 默认）

```bash
# 零积分检查 Chrome、StudioWright、Xvfb 与单账号 cloud-1 登录态（附带第三方自动化条款边界说明）
python3 .agents/skills/flow-video/scripts/flow_video.py preflight --init-profile-dir --profiles cloud-1

# 若自动通路尚未就绪，先保存零积分提示词草稿，由用户手动生成后导回（积分单位固定为 flow_video_credits）
python3 .agents/skills/flow-video/scripts/flow_video.py draft --prompt "..." --conversation-id conv_xxx
python3 .agents/skills/flow-video/scripts/flow_video.py ingest-manual --task-id fvid-xxx --file /path/to/clip.mp4
```

### 2. 验证 Mac 双账号登录态、CDP 端口隔离与页面选择器（可选 SSH 模式，零积分消耗）

```bash
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-video/scripts/flow_video.py verify --doctor
```

### 2. 先零成本询价，再生成 5 秒 MP4 并入库 Frame

```bash
# 1) 零消耗查询积分价格
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-video/scripts/flow_video.py run \
  --prompt "Slow push-in on a lighthouse keeper turning toward the misty sea at dawn" \
  --model omni-flash-1.2 --duration 5 --resolution 720p --dry-run

# 2) 首帧图生视频并自动入库 Frame
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-video/scripts/flow_video.py run \
  --start-frame /path/to/keyframe.png \
  --prompt "The lighthouse keeper turns toward the misty sea as wind moves his coat" \
  --model omni-flash-1.2 --duration 5 --resolution 720p --max-credits 20 \
  --conversation-id conv_xxx
```

### 3. 超时恢复（零积分重拉，严禁直接 `--force-new`）

```bash
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-video/scripts/flow_video.py recover --task-id fvid-xxxxxxxxxxxx
```

> StudioWright 在 Flow 受理瞬间即把 `media_ids` 写入 Mac 端 `studiowright.db`；`recover` 依次检查 Mac 输出目录、`studiowright.db` 与 `sw media list`，直接调用 `sw download <media_id>` 零积分取回 MP4。Mac 端初始化指南见 `flow-music` 技能的参考手册或 StudioWright MCP 配置。
