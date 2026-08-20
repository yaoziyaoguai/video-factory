# Loop 5: Asset Automation

## Objective

建立本地素材库和分镜匹配建议，不依赖外部素材 API。

## Completed Capability

- `add-local-asset` 可以登记本地素材路径、媒体类型、标签、来源和授权说明。
- `match-assets <job_id>` 可以根据 scene search terms 输出素材匹配建议。
- 匹配结果导出到 `workspace/asset-matches/job-<id>.json`。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory add-local-asset workspace/assets/decision-checklist.png --media-type image --tag checklist
PYTHONPATH=src python3 -m video_factory match-assets 3
```
