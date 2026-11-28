---
name: flow-music
description: >-
  Generate WAV (48kHz) or MP3 soundtrack/songs on Google Flow Music (Lyria 3.5 / Lyria 3 Pro)
  using StudioWright across two signed-in Google AI Ultra Chrome profiles on a local or
  SSH-connected Mac, recover timed-out tracks without re-spending credits, and ingest audio
  into Frame for video mixing.
---

# Google Flow Music 配乐生成技能（StudioWright 双账号调度 + Frame 入库）

本技能由 Coding Agent 发起，通过 [flow_music.py](./scripts/flow_music.py) 在持有登录态的 Mac 上驱动 **StudioWright (`sw music`)** 生成纯音乐（Instrumental）或人声配乐（Lyria 3.5 / Lyria 3 Pro，每次生成 5 积分），取回 `48kHz WAV` 或 `MP3` 至服务器，并通过 Frame 现成的 `/api/agent/v1/conversations/:id/uploads` 入库（入库后可直接作为 Frame `mixed_concat` 音乐槽素材合成成片）。

## 输入（Inputs）

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--sound` | 是 | — | 曲风、情绪、配器描述（英文效果最佳，如 `"warm indie acoustic underscore, soft cello, calm pacing"`） |
| `--lyrics` / `--lyrics-file` | 否 | — | 歌词文本或文件；省略则自动生成纯音乐（Instrumental） |
| `--format` | 否 | `wav` | `wav`（48kHz 无损，Frame 原生支持直接混音）或 `mp3` |
| `--length` | 否 | `1:00` | 时长 `1:00`–`3:00`（如 `1:30` 或 `90`） |
| `--bpm` / `--seed` | 否 | — | 可选速度与随机种子 |
| `--model` | 否 | `lyria-3.5` | `lyria-3.5` 或 `lyria-3-pro` |
| `--profile` / `--profiles` | 否 | `auto` / `ultra-1,ultra-2` | 自动在两份 Google AI Ultra 账号间选择未冷却账号执行 |
| `--mac-host` / `FLOW_MAC_HOST` | 否 | `local` | Mac 的 SSH 地址（登录态留在 Mac） |
| `--conversation-id` | 否 | — | 传入后自动上传至对应 Frame 会话 |

## 输出（Outputs）

输出 JSON 包含：
- `task_id`、`external_id`（StudioWright `job_id`）、`external_meta.sw_profile`、`external_meta.song_ids`
- `external_meta.credits_remaining_before`、`external_meta.plan`
- `local_file`（本地已校验 `.wav` / `.mp3`）、`file_sha256`、`frame_receipt`（含 `artifactId`、`revisionId`、`blobId`）

## 用法（Usage）

### 1. 云端单账号零积分预检与草稿回退（Linux `cloud-1` 默认）

```bash
# 零积分检查 Chrome、StudioWright、Xvfb、cloud-1 登录态与 Flow Music 页面额外授权状态
python3 .agents/skills/flow-music/scripts/flow_music.py preflight --init-profile-dir --profiles cloud-1

# 若自动通路未就绪，先存零积分曲风/歌词草稿，手动导出 WAV/MP3 后校验混音可用性并导回（积分固定为 flow_music_credits）
python3 .agents/skills/flow-music/scripts/flow_music.py draft --sound "Warm acoustic piano" --format wav --conversation-id conv_xxx
python3 .agents/skills/flow-music/scripts/flow_music.py ingest-manual --task-id fmus-xxx --file /path/to/track.wav
```

### 2. 核对 Mac 双账号登录态与 Flow Music 实时积分余额（可选 SSH 模式，零消耗）

```bash
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-music/scripts/flow_music.py verify
```

### 2. 生成纯音乐 BGM（WAV）并直接入库 Frame 会话

```bash
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-music/scripts/flow_music.py run \
  --sound "Cinematic travel documentary underscore, warm felt piano, light acoustic guitar, uplifting gentle strings" \
  --bpm 88 \
  --length 1:15 \
  --format wav \
  --conversation-id conv_xxx
```

### 3. 超时先查曲库恢复（零积分下载已出炉曲目）

```bash
FLOW_MAC_HOST=your-mac-ssh-alias \
  python3 .agents/skills/flow-music/scripts/flow_music.py recover --task-id fmus-xxxxxxxxxxxx
```

> 脚本在提交时自动写入可追踪曲名 `vf-<task_id>`（或用户指定的 `--title`）。若网络或等待超时，`recover` 会先检查 Mac 输出目录、`studiowright.db` 与 `sw music list --json`，命中已生成的 `song_id` 后直接调 `sw music download`（0 积分）取回音频。Mac 双账号与远程 SSH 配置细节见 [mac-dual-ultra-setup.md](./references/mac-dual-ultra-setup.md)。
