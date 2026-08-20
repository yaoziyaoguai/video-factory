# Loop 6: Visual Quality Assets

## Objective

把视频输出从文字卡片预览升级为真实素材驱动的短视频渲染链路，并保留素材来源和授权记录。

## Provider Notes

- Pexels 是第一优先级，适合竖屏 stock video。API key 通过 `PEXELS_API_KEY` 提供。官方入口：https://www.pexels.com/api/
- Pixabay 是第二来源，支持图片和视频 API。API key 通过 `PIXABAY_API_KEY` 提供。官方文档：https://pixabay.com/api/docs/
- Mixkit 适合人工补素材，但当前不作为自动 provider，因为没有稳定公开搜索 API。授权入口：https://mixkit.co/license/

## Completed Capability

- `asset-search <job_id>` 可以按分镜搜索候选素材并导出 `asset_candidates.json`。
- `prepare-assets <job_id>` 可以写出包含 provider、source URL、creator、license note、尺寸和本地路径的 `asset_plan.json`。
- `render-job <job_id> --require-assets` 在没有素材计划时失败，防止把 preview 当成 publish 级输出。
- 有 asset plan 时，renderer 会生成透明字幕层、scene clips，并合成 1080x1920 MP4。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory prepare-assets 3 --provider mock --media-type image
PYTHONPATH=src python3 -m video_factory render-job 3 --require-assets
ffprobe -v error -show_entries format=duration:stream=width,height,codec_type -of json workspace/renders/3/final.mp4
```

## Browser/API Key Status

Chrome browser control connected, but provider pages timed out during automated navigation. Pexels also returned Cloudflare challenge content to direct HTTP fetch. Continue with local engineering and ask the user to finish provider login/API-key creation if browser automation remains blocked.
