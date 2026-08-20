# Loop 2: Script Quality

## Objective

把通用脚本模板升级为按赛道生成的脚本和分镜。

## Completed Capability

- `draft-candidate <candidate_id>` 可以把候选题生成 topic、job、script 和 review package。
- `script.json` 包含 `niche_slug`、`structure`、`quality_checks` 和 `platform_notes`。
- 不同赛道有不同旁白节奏、画面策略和风险检查。

## Verification

```bash
make test
PYTHONPATH=src python3 -m video_factory draft-candidate 43
```
