import json
from pathlib import Path
from typing import Iterable, List, Optional

from .domain import PublishingMetric


def metric_summary(metrics: Iterable[PublishingMetric]) -> dict:
    items = [metric_to_dict(metric) for metric in metrics]
    if not items:
        return {"count": 0, "items": [], "top_by_views": None, "top_by_follow_rate": None}

    return {
        "count": len(items),
        "items": items,
        "top_by_views": max(items, key=lambda item: item["views"]),
        "top_by_follow_rate": max(items, key=lambda item: item["follow_rate"]),
        "totals": {
            "views": sum(item["views"] for item in items),
            "likes": sum(item["likes"] for item in items),
            "comments": sum(item["comments"] for item in items),
            "follows": sum(item["follows"] for item in items),
            "shares": sum(item["shares"] for item in items),
            "saves": sum(item["saves"] for item in items),
        },
    }


def metric_to_dict(metric: PublishingMetric) -> dict:
    views = max(metric.views, 1)
    return {
        "id": metric.id,
        "job_id": metric.job_id,
        "candidate_id": metric.candidate_id,
        "platform": metric.platform,
        "views": metric.views,
        "likes": metric.likes,
        "comments": metric.comments,
        "follows": metric.follows,
        "shares": metric.shares,
        "saves": metric.saves,
        "like_rate": round(metric.likes / views, 4),
        "comment_rate": round(metric.comments / views, 4),
        "follow_rate": round(metric.follows / views, 4),
        "share_rate": round(metric.shares / views, 4),
        "save_rate": round(metric.saves / views, 4),
        "completion_rate": metric.completion_rate,
        "avg_watch_seconds": metric.avg_watch_seconds,
        "published_at": metric.published_at,
        "recorded_at": metric.recorded_at,
    }


def write_metrics_report(path: Path, metrics: Iterable[PublishingMetric]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(metric_summary(metrics), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def default_metrics_report_path(workspace: Path, platform: Optional[str]) -> Path:
    suffix = platform or "all"
    return workspace / "reports" / f"metrics-{suffix}.json"
