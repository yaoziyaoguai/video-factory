# Loop 4: Low Cost Render

## Objective

准备从审核包到 1080x1920 MP4 的确定性渲染链路。

## Completed Capability

- `render-job <job_id> --dry-run` 可以生成 `render_manifest.json`。
- manifest 包含分辨率、目标时长、分镜文本、画面策略和输出文件路径。
- 当前环境缺少 `ffmpeg` 和 `ffprobe`，真实 MP4 输出被明确标记为 blocked。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory render-job 3 --dry-run
```

## Blocker

Install `ffmpeg` and `ffprobe` before enabling real MP4 rendering.
