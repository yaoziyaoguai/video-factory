# Loop 3: Review Package Metrics

## Objective

建立手动数据录入和复盘基础，让发布后的播放、互动和涨粉数据反过来影响选题。

## Completed Capability

- `record-metric` 可以记录平台、播放、点赞、评论、转粉、分享、收藏、完播率和平均观看时长。
- `metrics-report` 可以导出 JSON 复盘，包含互动率和转粉率。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory record-metric --platform douyin --views 1000
PYTHONPATH=src python3 -m video_factory metrics-report --platform douyin
```
