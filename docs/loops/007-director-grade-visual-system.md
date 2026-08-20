# Loop 7: Director-Grade Visual System

## Objective

把视觉输出从“可运行的素材拼接”提高到“可被导演审片的栏目样片”，减少随机图库素材对作品质感的破坏。

## Decisions

- `life-avoidance` 采用明确镜头分工：第一幕真实 B-roll，后四幕自有栏目卡。
- `local` 场景由系统生成 1080x1920 设计卡，不再调用 Pexels/Pixabay 碰运气。
- stock 场景保留轻字幕层；local 场景不叠字幕，避免重复和廉价感。
- 下载媒体使用专门的 `Accept: video/mp4,image/*,*/*` 请求头，并设置 12MB 上限。
- Pexels 首选候选下载失败或超限时，自动尝试下一个候选。

## Result

生成了 `job-6` 样片：

- 输出：`workspace/renders/6/final.mp4`
- 规格：1080x1920，45 秒，H.264 + AAC
- 素材结构：1 条 Pexels 真人视频 + 4 张本地设计卡
- 本地预览帧：`workspace/renders/6/preview_scene_01.png` 到 `preview_scene_05.png`

## Director Review

合格点：

- 第一幕有真实人物和情绪，能承担 hook。
- 栏目卡统一了视觉秩序，不再出现错误 B-roll。
- 清单、反直觉、行动、结尾都有独立画面职责。
- 生成速度稳定，避免了单个图库素材下载卡死的问题。

仍需提高：

- 卡片目前是静态图，缺少节奏性运动。
- 没有配音、音乐和音效，完整观看体验还不成立。
- 字幕字体和字号还偏“工具默认”，后续需要建立账号级字体系统。

## Verification

```bash
make test
python3 -m compileall src tests
git diff --check
PYTHONPATH=src python3 -m video_factory draft-candidate 13
PYTHONPATH=src python3 -m video_factory asset-search 6 --provider pexels --media-type video
PYTHONPATH=src python3 -m video_factory prepare-assets 6 --provider pexels --media-type video --limit 5
PYTHONPATH=src python3 -m video_factory render-job 6 --require-assets
ffprobe -v error -show_entries format=duration,size:stream=width,height,codec_type,codec_name -of json workspace/renders/6/final.mp4
```
