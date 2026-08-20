# Loop 4: Low Cost Render

## Objective

准备从审核包到 1080x1920 MP4 的确定性渲染链路。

## Completed Capability

- `render-job <job_id> --dry-run` 可以生成 `render_manifest.json`。
- `render-job <job_id>` 会把分镜渲染成 PNG 卡片，并调用 `ffmpeg` 合成 1080x1920 MP4。
- manifest 包含分辨率、目标时长、分镜文本、画面策略、输出文件路径、帧目录、concat 文件和 ffprobe 结果。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory render-job 3 --dry-run
PYTHONPATH=src python3 -m video_factory render-job 3
ffprobe -v error -show_entries format=duration:stream=width,height,codec_type -of json workspace/renders/3/final.mp4
```
