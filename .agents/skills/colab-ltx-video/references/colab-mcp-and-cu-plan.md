# Colab MCP 接入与每月 2,000 CU 容量规划

## 1. Colab CLI 与官方 Hosted Colab MCP 配合方式

- **主力批处理通道（`google-colab-cli`）**：`colab_ltx.py` 通过 `colab new / upload / exec / download / stop / usage` 完成无头文件传输、长耗时心跳保活与确定性 `unassign` 释放（Colab Hosted MCP 目前提供 `execute_code`，不含大体积二进制 MP4 流式传输原语，因此 MP4 取回走 CLI Contents API 最稳妥）。
- **交互诊断通道（Colab MCP）**：若需要在 Antigravity 中直接用 MCP 工具查看订阅档位（`get_subscription`）、核对可用机型（`list_runtime_specs`）或检查活跃运行时（`list_runtimes` / `delete_runtime`），可在 `~/.gemini/config/mcp_config.json` 中添加：

```json
{
  "mcpServers": {
    "google-colab": {
      "url": "https://colaboratory.googleapis.com/mcp"
    }
  }
}
```

## 2. LTX-2.5 蒸馏版 720p → 1080p 与月度 2,000 CU 规划

按 Google AI Ultra 每月 **2,000 CU**（预留 10% = 200 CU 机动，实际排产 **1,800 CU/月**）测算：

| 档位 | 分辨率（2-Stage 64px 对齐 → 成片） | 推荐 GPU | 小时费率（约） | Drive 缓存单镜独立起停 | 同会话连跑 8 镜均摊 | 1,800 CU 月产出（独立 / 批跑） |
| --- | --- | --- | --- | --- | --- | --- |
| **720p 分镜试片** | `1280x704` → `1280x720`（5s, 121帧） | `L4` (24GB, `fp8-cast` + `cpu` offload) | ~4.2 CU/h | ~3.2 min（**0.22 CU**） | ~2.05 min（**0.14 CU**） | **~8,100 镜** / **~12,500 镜** |
| **1080p 省流方案** | `1920x1088` → `1920x1080`（5s, 121帧） | `L4` (24GB, `fp8-cast` + `cpu` offload) | ~4.2 CU/h | ~5.5 min（**0.39 CU**） | ~3.85 min（**0.27 CU**） | **~4,600 镜** / **~6,600 镜** |
| **1080p 高速主力** | `1920x1088` → `1920x1080`（5s, 121帧） | `A100` (40/80GB) | ~11.8 CU/h | ~2.4 min（**0.47 CU**） | ~1.35 min（**0.27 CU**） | **~3,800 镜** / **~6,700 镜** |

> **关键省额结论**：若不挂载 Google Drive 缓存 ~64 GiB 权重，每次冷启动下载权重需额外耗时 8–12 分钟（A100 单次白烧 ~2.0 CU）。开启 `--mount-drive` 将权重固定在 `/content/drive/MyDrive/video-factory-cache/ltx-2.5` 后，单镜成本下降约 75%，2,000 CU/月足以支撑数千条 1080p 5 秒镜头的日常生产。
