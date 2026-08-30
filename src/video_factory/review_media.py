"""Prepare bounded local media inputs for visual review."""

import hashlib
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional

from PIL import Image, ImageDraw, ImageOps


MANIFEST_VERSION = "video-factory/review-media-v1"
MAX_FRAMES = 24
MAX_SCENE_CHANGE_FRAMES = 12
MAX_FRAME_BYTES = 256 * 1024
MAX_TOTAL_FRAME_BYTES = 5 * 1024 * 1024
FRAME_MAX_WIDTH = 640
FRAME_MAX_HEIGHT = 1280
SCENE_CHANGE_THRESHOLD = 0.30
SAMPLE_END_MARGIN_MS = 250
PROBE_TIMEOUT_SECONDS = 30
SCENE_SCAN_TIMEOUT_SECONDS = 180
FRAME_TIMEOUT_SECONDS = 30


def prepare_review_media(
    video_path: Path,
    run_root: Path,
    max_frames: int = MAX_FRAMES,
    render_manifest_path: Optional[Path] = None,
) -> Path:
    """Create deterministic keyframes, a contact sheet, and a safe manifest."""
    root = Path(run_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("run_root must be a directory")
    if not isinstance(max_frames, int) or isinstance(max_frames, bool) or not 1 <= max_frames <= MAX_FRAMES:
        raise ValueError(f"max_frames must be an integer between 1 and {MAX_FRAMES}")

    video = _resolve_run_file(video_path, root)
    if video.suffix.lower() != ".mp4":
        raise ValueError("video_path must point to an MP4 file")
    _require_media_tools()

    probe = _probe_video(video)
    duration_ms = max(1, int(round(float(probe["duration"]) * 1000)))
    scene_count = None
    if render_manifest_path is not None:
        render_manifest = _resolve_run_file(render_manifest_path, root)
        slide_durations = _read_slide_durations(render_manifest)
        scene_count = len(slide_durations)
        samples = _select_render_timeline_samples(
            duration_ms,
            slide_durations,
            max_frames,
        )
    else:
        scene_changes = _detect_scene_changes(video, duration_ms)
        timestamps = _select_timestamps(
            duration_ms,
            scene_changes,
            min(max_frames, MAX_SCENE_CHANGE_FRAMES),
        )
        samples = [
            {"timestampMs": timestamp, "phase": "keyframe"}
            for timestamp in timestamps
        ]
    timestamps = [sample["timestampMs"] for sample in samples]

    output_dir = root / "review_media"
    _assert_confined(output_dir, root, "review media output")
    if output_dir.is_symlink() or (output_dir.exists() and not output_dir.is_dir()):
        raise ValueError("review media output must be a real directory within run_root")
    stage = Path(tempfile.mkdtemp(prefix=".review-media-", dir=str(root)))
    try:
        frames_dir = stage / "frames"
        frames_dir.mkdir()
        frame_entries = []
        total_frame_bytes = 0
        frame_paths = []
        for index, sample in enumerate(samples):
            timestamp_ms = sample["timestampMs"]
            filename = f"frame-{index:02d}-{timestamp_ms:09d}ms.jpg"
            frame_path = frames_dir / filename
            _extract_frame(video, timestamp_ms, frame_path)
            _bound_jpeg(frame_path, MAX_FRAME_BYTES)
            frame_size = frame_path.stat().st_size
            if frame_size > MAX_FRAME_BYTES:
                raise RuntimeError(f"review frame exceeds {MAX_FRAME_BYTES} bytes: {filename}")
            total_frame_bytes += frame_size
            if total_frame_bytes > MAX_TOTAL_FRAME_BYTES:
                raise RuntimeError(f"review frames exceed {MAX_TOTAL_FRAME_BYTES} bytes in total")
            frame_paths.append(frame_path)
            entry = _image_entry(
                frame_path,
                f"review_media/frames/{filename}",
                timestamp_ms=timestamp_ms,
            )
            entry.update({key: value for key, value in sample.items() if key != "timestampMs"})
            frame_entries.append(entry)

        contact_sheet_path = stage / "contact_sheet.jpg"
        _write_contact_sheet(frame_paths, timestamps, contact_sheet_path)
        sampling = _sampling_metadata(samples, scene_count, render_manifest_path is not None)
        manifest = {
            "version": MANIFEST_VERSION,
            "durationMs": duration_ms,
            "sampling": sampling,
            "frames": frame_entries,
            "contactSheet": _image_entry(
                contact_sheet_path,
                "review_media/contact_sheet.jpg",
            ),
        }
        manifest_path = stage / "review_media_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        _publish_directory(stage, output_dir)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return output_dir / "review_media_manifest.json"


def _sampling_metadata(samples: List[dict], scene_count: Optional[int], has_render_manifest: bool) -> dict:
    if not has_render_manifest:
        return {"mode": "scene_change_keyframes"}
    covered = sorted({sample["scenePosition"] for sample in samples if isinstance(sample.get("scenePosition"), int)})
    missing = [position for position in range(1, (scene_count or 0) + 1) if position not in covered]
    phases_by_scene = {
        position: {sample.get("phase") for sample in samples if sample.get("scenePosition") == position}
        for position in range(1, (scene_count or 0) + 1)
    }
    complete_triplets = bool(scene_count) and all(
        phases_by_scene[position] == {"opening", "middle", "closing"}
        and sum(1 for sample in samples if sample.get("scenePosition") == position) == 3
        for position in range(1, scene_count + 1)
    )
    return {
        "mode": "scene_triplets" if complete_triplets else "hook_and_scene_midpoints",
        "sceneCount": scene_count,
        "coveredScenePositions": covered,
        "missingScenePositions": missing,
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare bounded visual-review frames for one VideoFactory run.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--max-frames", type=int, default=MAX_FRAMES)
    parser.add_argument("--render-manifest")
    args = parser.parse_args(argv)
    manifest = prepare_review_media(
        Path(args.video),
        Path(args.run_root),
        args.max_frames,
        Path(args.render_manifest) if args.render_manifest else None,
    )
    print(json.dumps({"manifestPath": str(manifest)}, ensure_ascii=False))
    return 0


def _resolve_run_file(path: Path, root: Path) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=True)
    _assert_confined(resolved, root, "video_path")
    if not resolved.is_file():
        raise ValueError("video_path must be a file")
    return resolved


def _assert_confined(path: Path, root: Path, field: str) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{field} must stay within run_root") from error


def _require_media_tools() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("FFmpeg and ffprobe are required for review media preprocessing")


def _probe_video(video_path: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=width,height",
            "-of",
            "json",
            str(video_path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=PROBE_TIMEOUT_SECONDS,
    )
    payload = json.loads(result.stdout)
    streams = payload.get("streams", [])
    duration = float(payload.get("format", {}).get("duration") or 0)
    if not streams or duration <= 0:
        raise ValueError("video_path must contain a positive-duration video stream")
    return {"duration": duration}


def _detect_scene_changes(video_path: Path, duration_ms: int) -> List[int]:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "info",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(video_path),
            "-an",
            "-vf",
            f"select='gt(scene,{SCENE_CHANGE_THRESHOLD})',showinfo",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=SCENE_SCAN_TIMEOUT_SECONDS,
    )
    timestamps = []
    for value in re.findall(r"pts_time:([0-9]+(?:\.[0-9]+)?)", result.stderr):
        timestamp_ms = int(round(float(value) * 1000))
        if 0 <= timestamp_ms < duration_ms:
            timestamps.append(timestamp_ms)
    return sorted(set(timestamps))


def _select_timestamps(duration_ms: int, scene_changes: Iterable[int], max_frames: int) -> List[int]:
    desired_count = min(max_frames, duration_ms)
    scene_timestamps = sorted(
        {timestamp for timestamp in scene_changes if 0 <= timestamp < duration_ms}
    )
    if len(scene_timestamps) >= desired_count:
        return [
            scene_timestamps[
                min(
                    len(scene_timestamps) - 1,
                    int((index + 0.5) * len(scene_timestamps) / desired_count),
                )
            ]
            for index in range(desired_count)
        ]

    selected = list(scene_timestamps)
    remaining = desired_count - len(selected)
    uniform_end = max(0, duration_ms - min(SAMPLE_END_MARGIN_MS, max(1, duration_ms // 2)))
    for index in range(remaining):
        target = int((index + 0.5) * uniform_end / remaining)
        selected.append(_nearest_available_timestamp(target, selected, duration_ms))
    return sorted(selected)


def _read_slide_durations(render_manifest_path: Path) -> List[float]:
    if render_manifest_path.stat().st_size > 512 * 1024:
        raise ValueError("render manifest exceeds 524288 bytes")
    try:
        payload = json.loads(render_manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("render manifest must be valid UTF-8 JSON") from error
    slides = payload.get("slides") if isinstance(payload, dict) else None
    if not isinstance(slides, list) or not slides:
        raise ValueError("render manifest slides must be a non-empty array")
    durations = []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            raise ValueError(f"render manifest slide {index + 1} must be an object")
        raw_duration = slide.get("duration")
        if isinstance(raw_duration, bool) or not isinstance(raw_duration, (int, float)):
            raise ValueError(f"render manifest slide {index + 1} duration is invalid")
        duration = float(raw_duration)
        if duration <= 0 or not duration < float("inf"):
            raise ValueError(f"render manifest slide {index + 1} duration is invalid")
        durations.append(duration)
    return durations


def _select_render_timeline_timestamps(
    duration_ms: int,
    slide_durations: Iterable[float],
    max_frames: int,
) -> List[int]:
    return [
        sample["timestampMs"]
        for sample in _select_render_timeline_samples(duration_ms, slide_durations, max_frames)
    ]


def _select_render_timeline_samples(
    duration_ms: int,
    slide_durations: Iterable[float],
    max_frames: int,
) -> List[dict]:
    """Sample stable scene interiors instead of transition boundaries."""
    durations_ms = [float(duration) * 1000 for duration in slide_durations]
    total_timeline_ms = sum(durations_ms)
    if total_timeline_ms <= 0:
        raise ValueError("render manifest does not contain reviewable slides")
    timeline_scale = duration_ms / total_timeline_ms
    end_margin_ms = min(SAMPLE_END_MARGIN_MS, max(1, duration_ms // 2))
    last_reviewable_ms = max(0, duration_ms - end_margin_ms)
    cursor_ms = 0.0
    scene_ranges = []
    for source_slide_ms in durations_ms:
        slide_ms = source_slide_ms * timeline_scale
        scene_ranges.append((cursor_ms, slide_ms))
        cursor_ms += slide_ms

    # 每镜头三帧是可审计的状态证据：起始、中段、结束。只有预算不足时才退回
    # 首屏 + 镜头中点，避免为了凑三帧而完全丢掉后续镜头。
    if max_frames >= len(scene_ranges) * 3:
        samples = [
            {
                "timestampMs": min(last_reviewable_ms, max(0, int(round(start_ms + slide_ms * phase)))),
                "scenePosition": scene_index + 1,
                "phase": phase_name,
            }
            for scene_index, (start_ms, slide_ms) in enumerate(scene_ranges)
            for phase, phase_name in ((0.15, "opening"), (0.5, "middle"), (0.85, "closing"))
        ]
        return _unique_samples(samples)

    midpoints = [
        {
            "timestampMs": min(last_reviewable_ms, max(0, int(round(start_ms + slide_ms / 2)))),
            "scenePosition": scene_index + 1,
            "phase": "midpoint",
        }
        for scene_index, (start_ms, slide_ms) in enumerate(scene_ranges)
    ]

    first_screen = min(last_reviewable_ms, 250)
    if max_frames == 1:
        return [{"timestampMs": first_screen, "scenePosition": 1, "phase": "hook"}]
    desired_midpoints = min(len(midpoints), max_frames - 1)
    if len(midpoints) > desired_midpoints:
        if desired_midpoints == 1:
            midpoints = [midpoints[len(midpoints) // 2]]
        else:
            midpoints = [
                midpoints[round(index * (len(midpoints) - 1) / (desired_midpoints - 1))]
                for index in range(desired_midpoints)
            ]

    selected = [
        {"timestampMs": first_screen, "scenePosition": 1, "phase": "hook"},
        *[midpoint for midpoint in midpoints if midpoint["timestampMs"] != first_screen],
    ]
    return _unique_samples(selected)


def _unique_samples(samples: Iterable[dict]) -> List[dict]:
    by_timestamp = {}
    for sample in samples:
        by_timestamp.setdefault(sample["timestampMs"], sample)
    return [by_timestamp[timestamp] for timestamp in sorted(by_timestamp)]


def _nearest_available_timestamp(target: int, selected: List[int], duration_ms: int) -> int:
    occupied = set(selected)
    for distance in range(duration_ms):
        later = target + distance
        if later < duration_ms and later not in occupied:
            return later
        earlier = target - distance
        if earlier >= 0 and earlier not in occupied:
            return earlier
    raise RuntimeError("video duration does not contain enough unique millisecond timestamps")


def _extract_frame(video_path: Path, timestamp_ms: int, output_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{timestamp_ms / 1000:.3f}",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(video_path),
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            (
                f"scale=w='min({FRAME_MAX_WIDTH},iw)':h='min({FRAME_MAX_HEIGHT},ih)':"
                "force_original_aspect_ratio=decrease:flags=lanczos"
            ),
            "-q:v",
            "4",
            "-map_metadata",
            "-1",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        timeout=FRAME_TIMEOUT_SECONDS,
    )
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise RuntimeError(f"FFmpeg did not produce a frame at {timestamp_ms}ms")


def _bound_jpeg(path: Path, max_bytes: int) -> None:
    with Image.open(path) as source:
        original_size = source.size
        image = ImageOps.contain(
            source.convert("RGB"),
            (FRAME_MAX_WIDTH, FRAME_MAX_HEIGHT),
            Image.Resampling.LANCZOS,
        )
    if path.stat().st_size <= max_bytes and image.size == original_size:
        return

    while True:
        for quality in (82, 70, 58, 46, 34, 24):
            buffer = io.BytesIO()
            image.save(
                buffer,
                format="JPEG",
                quality=quality,
                optimize=False,
                progressive=False,
                subsampling=2,
            )
            content = buffer.getvalue()
            if len(content) <= max_bytes:
                path.write_bytes(content)
                return
        if image.width == 1 and image.height == 1:
            break
        image = image.resize(
            (max(1, image.width * 3 // 4), max(1, image.height * 3 // 4)),
            Image.Resampling.LANCZOS,
        )
    raise RuntimeError(f"review frame cannot be reduced below {max_bytes} bytes")


def _write_contact_sheet(frame_paths: List[Path], timestamps: List[int], output_path: Path) -> None:
    columns = min(4, len(frame_paths))
    rows = (len(frame_paths) + columns - 1) // columns
    tile_width = 320
    tile_height = 220
    label_height = 24
    sheet = Image.new("RGB", (columns * tile_width, rows * (tile_height + label_height)), "#111111")
    draw = ImageDraw.Draw(sheet)
    for index, (frame_path, timestamp_ms) in enumerate(zip(frame_paths, timestamps)):
        with Image.open(frame_path) as source:
            image = ImageOps.contain(source.convert("RGB"), (tile_width, tile_height), Image.Resampling.LANCZOS)
        column = index % columns
        row = index // columns
        left = column * tile_width + (tile_width - image.width) // 2
        top = row * (tile_height + label_height) + (tile_height - image.height) // 2
        sheet.paste(image, (left, top))
        draw.text(
            (column * tile_width + 8, row * (tile_height + label_height) + tile_height + 5),
            _format_timestamp(timestamp_ms),
            fill="#ffffff",
        )
    sheet.save(output_path, format="JPEG", quality=85, optimize=False, progressive=False, subsampling=2)


def _format_timestamp(timestamp_ms: int) -> str:
    minutes, remainder = divmod(timestamp_ms, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def _image_entry(path: Path, relative_path: str, timestamp_ms: Optional[int] = None) -> dict:
    content = path.read_bytes()
    with Image.open(path) as image:
        entry = {
            "path": relative_path,
            "sha256": hashlib.sha256(content).hexdigest(),
            "width": image.width,
            "height": image.height,
        }
    if timestamp_ms is not None:
        entry["timestampMs"] = timestamp_ms
    return entry


def _publish_directory(stage: Path, output_dir: Path) -> None:
    backup = output_dir.parent / f".{output_dir.name}.backup-{os.getpid()}"
    if backup.exists():
        shutil.rmtree(backup)
    had_output = output_dir.exists()
    if had_output:
        os.replace(output_dir, backup)
    try:
        os.replace(stage, output_dir)
    except Exception:
        if had_output and backup.exists():
            os.replace(backup, output_dir)
        raise
    if backup.exists():
        shutil.rmtree(backup)


if __name__ == "__main__":
    raise SystemExit(main())
