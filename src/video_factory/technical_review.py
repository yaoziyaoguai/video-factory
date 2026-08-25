import json
import re
import subprocess
from pathlib import Path
from typing import Optional


def review_video(
    video_path: Path,
    script_path: Path,
    asset_plan_path: Path,
    output_path: Path,
    expected_width: int,
    expected_height: int,
    production: bool,
) -> Path:
    probe = probe_media(video_path)
    streams = probe.get("streams", [])
    video_stream = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio_stream = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    script = json.loads(script_path.read_text(encoding="utf-8"))
    asset_plan = json.loads(asset_plan_path.read_text(encoding="utf-8"))
    expected_positions = {int(scene["position"]) for scene in script.get("scenes", [])}
    assets = asset_plan.get("scene_assets", [])
    actual_positions = [int(asset["scene_position"]) for asset in assets]
    local_files_exist = all(Path(str(asset.get("local_path", ""))).is_file() for asset in assets)
    mock_present = any(asset.get("provider") == "mock" for asset in assets)
    max_volume = detect_max_volume(video_path)
    duration = float(probe.get("format", {}).get("duration") or 0)
    duration_target = float(script.get("duration_target") or 0)
    duration_tolerance = max(2.0, duration_target * 0.15)

    checks = [
        check("video_stream", video_stream is not None, "Video stream is decodable."),
        check(
            "resolution",
            bool(video_stream)
            and int(video_stream.get("width") or 0) == expected_width
            and int(video_stream.get("height") or 0) == expected_height,
            f"Expected {expected_width}x{expected_height}.",
        ),
        check("video_codec", bool(video_stream) and video_stream.get("codec_name") == "h264", "Expected H.264 video."),
        check("audio_stream", audio_stream is not None, "Audio stream is required."),
        check("audio_codec", bool(audio_stream) and audio_stream.get("codec_name") == "aac", "Expected AAC audio."),
        check(
            "audible_audio",
            max_volume is not None and max_volume > -60,
            "Maximum audio volume must be above -60 dB.",
        ),
        check("duration", duration >= 5, "Video must be at least 5 seconds long."),
        check(
            "target_duration",
            duration_target > 0 and abs(duration - duration_target) <= duration_tolerance,
            f"Video duration must stay within {duration_tolerance:.2f}s of the {duration_target:.2f}s target.",
        ),
        check(
            "scene_coverage",
            set(actual_positions) == expected_positions and len(actual_positions) == len(set(actual_positions)),
            "Every script scene needs exactly one asset.",
        ),
        check("asset_files", local_files_exist, "Every asset must exist locally at review time."),
        check("production_assets", not production or not mock_present, "Mock assets are forbidden in production mode."),
    ]
    report = {
        "version": "video-factory/technical-review-v1",
        "status": "passed" if all(item["passed"] for item in checks) else "failed",
        "video_path": str(video_path.resolve()),
        "probe": probe,
        "audio": {"max_volume_db": max_volume},
        "checks": checks,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return output_path


def probe_media(video_path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height",
            "-of",
            "json",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def detect_max_volume(video_path: Path) -> Optional[float]:
    result = subprocess.run(
        ["ffmpeg", "-i", str(video_path), "-vn", "-af", "volumedetect", "-f", "null", "-"],
        check=False,
        capture_output=True,
        text=True,
    )
    match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", result.stderr)
    return float(match.group(1)) if match else None


def check(check_id: str, passed: bool, detail: str) -> dict:
    return {"id": check_id, "passed": bool(passed), "detail": detail}
