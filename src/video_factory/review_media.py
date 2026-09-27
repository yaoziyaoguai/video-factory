"""Prepare bounded local media inputs for visual review."""

import hashlib
import argparse
import fcntl
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Callable, Iterable, List, Optional

from PIL import Image, ImageDraw, ImageOps


MANIFEST_VERSION = "video-factory/review-media-v1"
CACHE_SCHEMA = "video-factory/review-media-cache-v2"
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


class SourceRangeTooShortError(ValueError):
    def __init__(self, scene_positions: List[int]):
        self.scene_positions = scene_positions
        super().__init__(f"asset plan scene {scene_positions} source does not cover the planned source range")


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _dependency_identity(root: Path, files: dict) -> dict:
    # 先核边界，再读字节；哈希时也不能碰到 run 以外的输入。
    resolved = {name: _resolve_run_file(filename, root, "asset local_path" if name.startswith("asset local_path ") else name) if filename is not None else None
                for name, filename in files.items()}
    digests = {filename: _file_sha256(filename) for filename in set(resolved.values()) if filename is not None}
    return {name: {"path": filename.relative_to(root).as_posix(), "sha256": digests[filename]}
            if filename is not None else None for name, filename in resolved.items()}


def _cache_identity(root: Path, mode: str, files: dict, max_frames: int,
                    scene_positions: Optional[List[int]] = None) -> dict:
    return {"schema": CACHE_SCHEMA, "runRoot": str(root), "mode": mode,
            "files": _dependency_identity(root, files), "maxFrames": max_frames,
            "scenePositions": sorted(scene_positions) if scene_positions is not None else None,
            "sampling": [MAX_SCENE_CHANGE_FRAMES, SCENE_CHANGE_THRESHOLD, SAMPLE_END_MARGIN_MS,
                         FRAME_MAX_WIDTH, FRAME_MAX_HEIGHT, MAX_FRAME_BYTES, MAX_TOTAL_FRAME_BYTES]}


def _cache_entry(root: Path, key: str) -> Path:
    return root / ".media-review-cache" / key


def _cache_directory(root: Path) -> Path:
    directory = root / ".media-review-cache"
    _assert_confined(directory, root, "review cache")
    if directory.is_symlink():
        raise ValueError("review cache must not be a symbolic link")
    directory.mkdir(exist_ok=True)
    return directory


def _validated_cached_manifest(root: Path, version: Path, identity: dict) -> Optional[Path]:
    try:
        _assert_confined(version, root, "cached evidence")
        if version.is_symlink() or not version.is_dir():
            return None

        def confined_file(filename: Path) -> Path:
            resolved = _resolve_run_file(filename, root, "cached evidence")
            resolved.relative_to(version.resolve())
            return resolved

        binding_file = confined_file(version / "binding.json")
        manifest_path = confined_file(version / "review_media_manifest.json")
        if binding_file.stat().st_size > 512 * 1024 or manifest_path.stat().st_size > 512 * 1024:
            return None
        binding = json.loads(binding_file.read_text(encoding="utf-8"))
        if binding.get("identity") != identity or binding.get("manifestSha256") != _file_sha256(manifest_path):
            return None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        duration = manifest.get("durationMs")
        frames, sheet = manifest.get("frames"), manifest.get("contactSheet")
        if (manifest.get("version") != MANIFEST_VERSION or not isinstance(duration, int)
                or isinstance(duration, bool) or duration <= 0 or not isinstance(frames, list)
                or not 1 <= len(frames) <= identity["maxFrames"] or not isinstance(sheet, dict)):
            return None
        total, previous = 0, -1
        for index, descriptor in enumerate([*frames, sheet]):
            relative = descriptor.get("path")
            if not isinstance(relative, str) or Path(relative).is_absolute():
                return None
            filename = confined_file(root / relative)
            if filename.stat().st_size > (MAX_FRAME_BYTES if index < len(frames) else MAX_TOTAL_FRAME_BYTES):
                return None
            content = filename.read_bytes()
            if hashlib.sha256(content).hexdigest() != descriptor.get("sha256"):
                return None
            with Image.open(filename) as image:
                if image.format != "JPEG" or list(image.size) != [descriptor.get("width"), descriptor.get("height")]:
                    return None
                if index < len(frames) and (image.width > FRAME_MAX_WIDTH or image.height > FRAME_MAX_HEIGHT):
                    return None
                image.verify()
            if index < len(frames):
                timestamp = descriptor.get("timestampMs")
                if (not isinstance(timestamp, int) or isinstance(timestamp, bool)
                        or not previous < timestamp < duration or len(content) > MAX_FRAME_BYTES):
                    return None
                previous = timestamp
                total += len(content)
                if total > MAX_TOTAL_FRAME_BYTES:
                    return None
                if "sourceTimecodeMs" in descriptor and (not isinstance(descriptor["sourceTimecodeMs"], int)
                        or isinstance(descriptor["sourceTimecodeMs"], bool) or descriptor["sourceTimecodeMs"] < 0):
                    return None
        sampling = manifest.get("sampling")
        if not isinstance(sampling, dict):
            return None
        if "sceneCount" in sampling:
            count = sampling["sceneCount"]
            covered = sorted({frame["scenePosition"] for frame in frames})
            if (not isinstance(count, int) or isinstance(count, bool) or count < 1
                    or any(not isinstance(p, int) or isinstance(p, bool) or not 1 <= p <= count for p in covered)
                    or sampling.get("coveredScenePositions") != covered
                    or sampling.get("missingScenePositions") != [p for p in range(1, count + 1) if p not in covered]):
                return None
        return manifest_path
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def _cache_lookup(root: Path, key: str, identity: dict) -> Optional[Path]:
    try:
        entry = _cache_entry(root, key)
        _assert_confined(entry, root, "cached evidence")
        if entry.is_symlink() or not entry.is_dir():
            return None
        # v1 的可变目录不改写；v2 每次只发布全新的证据版本，损坏版本也保留给旧诊断。
        for version in sorted(entry.glob("v-*"), reverse=True):
            manifest = _validated_cached_manifest(root, version, identity)
            if manifest is not None:
                return manifest
    except (OSError, ValueError):
        pass
    return None


class _KeyLock:
    """缓存不可写/不可信只取消复用；不取消原本安全的本地预处理。"""

    def __init__(self, root: Path, key: str):
        self.root, self.key = root, key
        self._handle = None

    def __enter__(self):
        try:
            filename = _cache_directory(self.root) / f"{self.key}.lock"
            fd = os.open(filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            self._handle = os.fdopen(fd, "a+")
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_EX)
        except (OSError, ValueError):
            if self._handle is not None:
                self._handle.close()
                self._handle = None
        return self

    def __exit__(self, *_args):
        if self._handle is not None:
            try:
                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            finally:
                self._handle.close()
        return False


def _prepare_cached(root: Path, identity_for: Callable[[], dict],
                    build: Callable[[Path, dict, Callable[[], None]], Path]) -> Path:
    identity = identity_for()
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    def verify_source():
        if identity_for() != identity:
            raise ValueError("review media source or dependencies changed during preprocessing; retry with the current source")

    with _KeyLock(root, key) as lock:
        verify_source()
        if lock._handle is not None:
            hit = _cache_lookup(root, key, identity)
            if hit is not None:
                verify_source()
                return hit
        output_dir = root / f"prepared-review-{uuid.uuid4().hex}"
        if lock._handle is not None:
            try:
                entry = _cache_entry(root, key)
                _assert_confined(entry, root, "cached evidence")
                if entry.is_symlink():
                    raise ValueError("cache entry is a symbolic link")
                entry.mkdir(exist_ok=True)
                output_dir = entry / f"v-{uuid.uuid4().hex}"
            except (OSError, ValueError):
                pass
        return build(output_dir, identity, verify_source)


def _publish_evidence(stage: Path, output_dir: Path, manifest: dict, identity: dict,
                      verify_source: Callable[[], None]) -> Path:
    root = Path(identity["runRoot"])

    def publish(target: Path):
        _assert_confined(target, root, "review evidence")
        for parent in [target, *target.parents]:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError("review evidence must not traverse a symbolic link")
        verify_source()
        _publish_directory(stage, target)

    manifest_path = stage / "review_media_manifest.json"
    def write_manifest():
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (stage / "binding.json").write_text(json.dumps({
            "identity": identity, "manifestSha256": _file_sha256(manifest_path),
        }, sort_keys=True) + "\n", encoding="utf-8")

    write_manifest()
    try:
        publish(output_dir)
    except OSError:
        if not output_dir.is_relative_to(root / ".media-review-cache") or not stage.is_dir():
            raise
        # 缓存发布失败只换本地存放位置，不重抽帧、不覆盖旧证据。源变化仍由 publish 拒绝。
        fallback = root / f"prepared-review-{uuid.uuid4().hex}"
        for descriptor in [*manifest["frames"], manifest["contactSheet"]]:
            relative = (root / descriptor["path"]).relative_to(output_dir)
            descriptor["path"] = (fallback.relative_to(root) / relative).as_posix()
        write_manifest()
        publish(fallback)
        output_dir = fallback
    return output_dir / "review_media_manifest.json"


def prepare_review_media(
    video_path: Path,
    run_root: Path,
    max_frames: int = MAX_FRAMES,
    render_manifest_path: Optional[Path] = None,
    script_path: Optional[Path] = None,
    executable_plan_path: Optional[Path] = None,
    scene_positions: Optional[List[int]] = None,
) -> Path:
    """内容绑定的不可变审片证据；缓存不可用时仍执行一次原预处理。"""
    root = Path(run_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("run_root must be a directory")
    if not isinstance(max_frames, int) or isinstance(max_frames, bool) or not 1 <= max_frames <= MAX_FRAMES:
        raise ValueError(f"max_frames must be an integer between 1 and {MAX_FRAMES}")
    video = _resolve_run_file(video_path, root)
    if video.suffix.lower() != ".mp4":
        raise ValueError("video_path must point to an MP4 file")
    files = {"video": video_path, "renderManifest": render_manifest_path,
             "script": script_path, "executablePlan": executable_plan_path}
    return _prepare_cached(root, lambda: _cache_identity(root, "video", files, max_frames, scene_positions),
                           lambda output, identity, verify: _prepare_review_media_uncached(
                               video, root, max_frames, render_manifest_path, output, identity, verify))


def _prepare_review_media_uncached(
    video: Path,
    root: Path,
    max_frames: int,
    render_manifest_path: Optional[Path],
    output_dir: Path,
    identity: dict,
    verify_source: Callable[[], None],
) -> Path:
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
                f"{output_dir.relative_to(root).as_posix()}/frames/{filename}",
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
                f"{output_dir.relative_to(root).as_posix()}/contact_sheet.jpg",
            ),
        }
        manifest_path = _publish_evidence(stage, output_dir, manifest, identity, verify_source)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return manifest_path


def prepare_asset_review_media(
    asset_plan_path: Path,
    run_root: Path,
    max_frames: int = MAX_FRAMES,
    scene_positions: Optional[List[int]] = None,
    script_path: Optional[Path] = None,
    executable_plan_path: Optional[Path] = None,
) -> Path:
    root = Path(run_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("run_root must be a directory")
    if not isinstance(max_frames, int) or isinstance(max_frames, bool) or not 1 <= max_frames <= MAX_FRAMES:
        raise ValueError(f"max_frames must be an integer between 1 and {MAX_FRAMES}")

    def identity_for():
        plan_path = _resolve_run_file(asset_plan_path, root, "asset_plan_path")
        if plan_path.stat().st_size > 512 * 1024:
            raise ValueError("asset plan exceeds 524288 bytes")
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        assets = plan.get("scene_assets") if isinstance(plan, dict) else None
        if not isinstance(assets, list) or not assets or len(assets) > max_frames:
            raise ValueError("asset plan must contain one reviewable asset per scene within the frame limit")
        files = {"assetPlan": asset_plan_path, "script": script_path, "executablePlan": executable_plan_path}
        for index, asset in enumerate(assets):
            if not isinstance(asset, dict):
                raise ValueError(f"asset plan scene {index + 1} must be an object")
            if scene_positions is None or asset.get("scene_position") in scene_positions:
                files[f"asset local_path {index + 1}"] = Path(str(asset.get("local_path") or ""))
        return _cache_identity(root, "assets", files, max_frames, scene_positions)

    return _prepare_cached(root, identity_for, lambda output, identity, verify:
                           _prepare_asset_review_media_uncached(
                               asset_plan_path, root, max_frames, scene_positions, script_path,
                               executable_plan_path, output_dir=output, identity=identity, verify_source=verify))


def _prepare_asset_review_media_uncached(
    asset_plan_path: Path,
    run_root: Path,
    max_frames: int,
    scene_positions: Optional[List[int]],
    script_path: Optional[Path],
    executable_plan_path: Optional[Path],
    *, output_dir: Path, identity: dict, verify_source: Callable[[], None],
) -> Path:
    """Create bounded evidence frames from every materialized source asset."""
    root = Path(run_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("run_root must be a directory")
    if not isinstance(max_frames, int) or isinstance(max_frames, bool) or not 1 <= max_frames <= MAX_FRAMES:
        raise ValueError(f"max_frames must be an integer between 1 and {MAX_FRAMES}")

    plan_path = _resolve_run_file(asset_plan_path, root, "asset_plan_path")
    if plan_path.stat().st_size > 512 * 1024:
        raise ValueError("asset plan exceeds 524288 bytes")
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("asset plan must be valid UTF-8 JSON") from error
    assets = plan.get("scene_assets") if isinstance(plan, dict) else None
    if not isinstance(assets, list) or not assets or len(assets) > max_frames:
        raise ValueError("asset plan must contain one reviewable asset per scene within the frame limit")
    if executable_plan_path is not None:
        executable_plan_file = _resolve_run_file(
            executable_plan_path, root, "executable_plan_path"
        )
        if executable_plan_file.stat().st_size > 512 * 1024:
            raise ValueError("executable plan exceeds 524288 bytes")
        try:
            executable_plan = json.loads(executable_plan_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("executable plan must be valid UTF-8 JSON") from error
        # 复用 worker 的唯一可执行计划校验，审片只验证绑定，不建立第二套时间规则。
        from .worker import assert_asset_plan_matches_executable_plan
        assert_asset_plan_matches_executable_plan(plan, executable_plan)

    scene_count = len(assets)
    planned_durations = {}
    if script_path is not None:
        script_file = _resolve_run_file(script_path, root, "script_path")
        if script_file.stat().st_size > 512 * 1024:
            raise ValueError("script exceeds 524288 bytes")
        script = json.loads(script_file.read_text(encoding="utf-8"))
        for scene in script["scenes"]:
            position, duration = scene["position"], scene["duration"]
            if (isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration <= 0
                    or isinstance(position, bool) or not isinstance(position, int) or position in planned_durations):
                raise ValueError("script scene duration or position is invalid")
            planned_durations[position] = duration
        if set(planned_durations) != set(range(1, scene_count + 1)):
            raise ValueError("script must cover every source asset scene")
    pilot_review = scene_positions is not None
    if pilot_review:
        if (not scene_positions or len(set(scene_positions)) != len(scene_positions)
                or any(isinstance(p, bool) or not isinstance(p, int) or p < 1 or p > scene_count for p in scene_positions)):
            raise ValueError("pilot scene positions are invalid")
        # 试片保留真实镜号，其余尚未生成的素材不在本次检查范围内。
        assets = [asset for asset in assets if isinstance(asset, dict) and asset.get("scene_position") in scene_positions]
        if len(assets) != len(scene_positions):
            raise ValueError("pilot scenes are missing from the asset plan")

    normalized_assets = []
    seen_positions = set()
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            raise ValueError(f"asset plan scene {index + 1} must be an object")
        scene_position = asset.get("scene_position")
        if isinstance(scene_position, bool) or not isinstance(scene_position, int) or scene_position < 1:
            raise ValueError(f"asset plan scene {index + 1} position is invalid")
        if scene_position in seen_positions:
            raise ValueError(f"asset plan scene position {scene_position} is duplicated")
        seen_positions.add(scene_position)
        if "duration_frames" in asset:
            duration_frames = asset["duration_frames"]
            if (not isinstance(duration_frames, int) or isinstance(duration_frames, bool)
                    or duration_frames <= 0):
                raise ValueError(f"asset plan scene {scene_position} duration_frames is invalid")
            duration_ms = max(1, int(round(duration_frames * 1000 / 30)))
        else:
            duration_frames = None
            duration = planned_durations.get(scene_position, asset.get("duration"))
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration <= 0:
                raise ValueError(f"asset plan scene {scene_position} duration is invalid")
            duration_ms = max(1, int(round(float(duration) * 1000)))
        source_in_frame = asset.get("source_in_frame", 0)
        if (not isinstance(source_in_frame, int) or isinstance(source_in_frame, bool)
                or source_in_frame < 0):
            raise ValueError(f"asset plan scene {scene_position} source_in_frame is invalid")
        media_path = _resolve_run_file(Path(str(asset.get("local_path") or "")), root, "asset local_path")
        media_type = str(asset.get("media_type") or "").strip().lower()
        if media_type not in {"image", "video"}:
            raise ValueError(f"asset plan scene {scene_position} media_type is invalid")
        if media_type == "image" and source_in_frame != 0:
            raise ValueError(f"asset plan scene {scene_position} has an invalid image source offset")
        normalized_assets.append({
            "scenePosition": scene_position,
            "durationMs": duration_ms,
            "durationFrames": duration_frames,
            "sourceInFrame": source_in_frame,
            "sourceStartSeconds": source_in_frame / 30,
            "sourceEndSeconds": (
                (source_in_frame + duration_frames) / 30
                if duration_frames is not None
                else source_in_frame / 30 + duration_ms / 1000
            ),
            "mediaPath": media_path,
            "mediaType": media_type,
        })

    _require_media_tools()
    short_positions = []
    probes = {}
    for asset in normalized_assets:
        if asset["mediaType"] != "video":
            continue
        if asset["mediaPath"] not in probes:
            probes[asset["mediaPath"]] = _probe_video(asset["mediaPath"])
        source_duration_seconds = float(probes[asset["mediaPath"]]["duration"])
        source_end_seconds = asset["sourceEndSeconds"]
        source_start_ms = int(round(asset["sourceInFrame"] * 1000 / 30))
        if source_end_seconds > source_duration_seconds + 1e-6:
            short_positions.append(asset["scenePosition"])
        asset["sourceStartMs"] = source_start_ms
    if short_positions:
        raise SourceRangeTooShortError(short_positions)
    sample_counts = [1] * len(normalized_assets)
    remaining = max_frames - len(normalized_assets)
    video_indexes = [index for index, asset in enumerate(normalized_assets) if asset["mediaType"] == "video"]
    # 全片预检与试片花的是同一笔帧预算，合同也一样：只要还有额度就逐场轮转补齐。
    # 之前全片预检固定只加两轮（每场 3 帧），场内的动作窗口一个采样点都落不到，
    # 审片只能如实报 not_observed，预检就会在配音与渲染前停住整条主片。
    while remaining > 0 and video_indexes:
        for index in video_indexes:
            if remaining == 0:
                break
            sample_counts[index] += 1
            remaining -= 1

    sequence_sampling = any(count > 3 for count in sample_counts)

    total_duration_ms = sum(asset["durationMs"] for asset in normalized_assets)
    _assert_confined(output_dir, root, "asset review media output")
    if output_dir.is_symlink() or (output_dir.exists() and not output_dir.is_dir()):
        raise ValueError("asset review media output must be a real directory within run_root")
    stage = Path(tempfile.mkdtemp(prefix=".asset-review-media-", dir=str(root)))
    try:
        frames_dir = stage / "frames"
        frames_dir.mkdir()
        frame_entries = []
        frame_paths = []
        timeline_timestamps = []
        total_frame_bytes = 0
        cursor_ms = 0
        for asset_index, asset in enumerate(normalized_assets):
            count = sample_counts[asset_index]
            if count == 1:
                phases = [(0.5, "midpoint")]
            elif count == 2:
                phases = [(0.15, "opening"), (0.85, "closing")]
            elif count == 3:
                phases = [(0.15, "opening"), (0.5, "middle"), (0.85, "closing")]
            else:
                phases = [
                    (
                        (phase_index + 0.5) / count,
                        "opening" if phase_index == 0 else "closing" if phase_index == count - 1 else "middle",
                    )
                    for phase_index in range(count)
                ]
            source_start_ms = asset.get("sourceStartMs")
            for phase_index, (fraction, phase) in enumerate(phases):
                timestamp_ms = min(total_duration_ms - 1, cursor_ms + int(round(asset["durationMs"] * fraction)))
                filename = f"scene-{asset['scenePosition']:02d}-{phase_index:02d}.jpg"
                frame_path = frames_dir / filename
                if source_start_ms is None:
                    source_timestamp_ms = 0
                    _copy_image_frame(asset["mediaPath"], frame_path)
                else:
                    source_timestamp_ms = min(
                        source_start_ms + asset["durationMs"] - 1,
                        source_start_ms + int(round(asset["durationMs"] * fraction)),
                    )
                    extracted_timecode = _extract_frame_from_range(
                        asset["mediaPath"],
                        asset["sourceStartSeconds"],
                        asset["sourceEndSeconds"],
                        source_timestamp_ms,
                        frame_path,
                    )
                    if extracted_timecode is not None:
                        source_timestamp_ms = extracted_timecode
                _bound_jpeg(frame_path, MAX_FRAME_BYTES)
                frame_size = frame_path.stat().st_size
                total_frame_bytes += frame_size
                if frame_size > MAX_FRAME_BYTES or total_frame_bytes > MAX_TOTAL_FRAME_BYTES:
                    raise RuntimeError("asset review frames exceed the safe visual-review boundary")
                frame_paths.append(frame_path)
                timeline_timestamps.append(timestamp_ms)
                entry = _image_entry(
                    frame_path,
                    f"{output_dir.relative_to(root).as_posix()}/frames/{filename}",
                    timestamp_ms=timestamp_ms,
                )
                entry.update({
                    "scenePosition": asset["scenePosition"],
                    "phase": phase,
                    "sourceTimecodeMs": source_timestamp_ms,
                })
                frame_entries.append(entry)
            cursor_ms += asset["durationMs"]

        contact_sheet_path = stage / "contact_sheet.jpg"
        _write_contact_sheet(frame_paths, timeline_timestamps, contact_sheet_path)
        manifest = {
            "version": MANIFEST_VERSION,
            "durationMs": total_duration_ms,
            "sampling": {
                "mode": "scene_sequence" if sequence_sampling else "hook_and_scene_midpoints",
                "sceneCount": scene_count,
                "coveredScenePositions": sorted(seen_positions),
                "missingScenePositions": [p for p in range(1, scene_count + 1) if p not in seen_positions],
            },
            "frames": frame_entries,
            "contactSheet": _image_entry(contact_sheet_path, f"{output_dir.relative_to(root).as_posix()}/contact_sheet.jpg"),
        }
        manifest_path = _publish_evidence(stage, output_dir, manifest, identity, verify_source)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return manifest_path


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
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--video")
    source.add_argument("--asset-plan")
    parser.add_argument("--run-root", required=True)
    parser.add_argument("--max-frames", type=int, default=MAX_FRAMES)
    parser.add_argument("--render-manifest")
    parser.add_argument("--scene-positions", type=int, nargs="+")
    parser.add_argument("--script")
    parser.add_argument("--executable-plan")
    args = parser.parse_args(argv)
    try:
        manifest = (
            prepare_asset_review_media(
                Path(args.asset_plan), Path(args.run_root), args.max_frames,
                args.scene_positions, Path(args.script) if args.script else None,
                Path(args.executable_plan) if args.executable_plan else None,
            )
            if args.asset_plan
            else prepare_review_media(
                Path(args.video), Path(args.run_root), args.max_frames,
                Path(args.render_manifest) if args.render_manifest else None,
                Path(args.script) if args.script else None,
                Path(args.executable_plan) if args.executable_plan else None,
                args.scene_positions,
            )
        )
    except SourceRangeTooShortError as error:
        print(json.dumps({"version": "video-factory/review-media-error-v1", "code": "SOURCE_RANGE_TOO_SHORT",
                          "scenePositions": error.scene_positions}))
        return 2
    print(json.dumps({"manifestPath": str(manifest)}, ensure_ascii=False))
    return 0


def _resolve_run_file(path: Path, root: Path, field: str = "video_path") -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=True)
    _assert_confined(resolved, root, field)
    if not resolved.is_file():
        raise ValueError(f"{field} must be a file")
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
            "stream=width,height,duration",
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
    duration = float(streams[0].get("duration") or 0) if streams else 0
    if duration <= 0:
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


def _extract_frame_from_range(
    video_path: Path,
    source_start_seconds: float,
    source_end_seconds: float,
    timestamp_ms: int,
    output_path: Path,
) -> int:
    target_seconds = timestamp_ms / 1000
    if (source_start_seconds < 0 or source_end_seconds <= source_start_seconds
            or target_seconds < source_start_seconds or target_seconds >= source_end_seconds):
        raise ValueError("source review timestamp must stay inside the selected source range")
    command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
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
                f"trim=start={source_start_seconds:.9f}:end={source_end_seconds:.9f},"
                f"select='gte(t,{target_seconds:.9f})',setpts=PTS-STARTPTS,"
                f"scale=w='min({FRAME_MAX_WIDTH},iw)':h='min({FRAME_MAX_HEIGHT},ih)':"
                "force_original_aspect_ratio=decrease:flags=lanczos"
            ),
            "-q:v",
            "4",
            "-map_metadata",
            "-1",
            str(output_path),
        ]
    failure = None
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=FRAME_TIMEOUT_SECONDS)
    except subprocess.CalledProcessError as error:
        failure = error
    if not output_path.is_file() or output_path.stat().st_size == 0:
        # 低帧率/VFR素材末帧的显示区间可跨过采样点。仅在确实没有后续源帧时
        # 取区间内最后一张真实帧；不越过剪辑边界，不复制/合成新帧或隐瞒时间码。
        probe = subprocess.run([
            "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
            "-select_streams", "v:0", "-read_intervals",
            f"{source_start_seconds:.9f}%{source_end_seconds:.9f}",
            "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(video_path),
        ], check=True, capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS)
        frame_times = [float(frame["best_effort_timestamp_time"])
                       for frame in json.loads(probe.stdout).get("frames", [])
                       if "best_effort_timestamp_time" in frame]
        inside = [value for value in frame_times if source_start_seconds <= value < source_end_seconds]
        if inside and max(inside) < target_seconds:
            actual_seconds = max(inside)
            filters_index = command.index("-vf") + 1
            command[filters_index] = command[filters_index].replace(
                f"gte(t,{target_seconds:.9f})", f"gte(t,{actual_seconds - 0.000001:.9f})")
            subprocess.run(command, check=True, capture_output=True, timeout=FRAME_TIMEOUT_SECONDS)
            if output_path.is_file() and output_path.stat().st_size > 0:
                return int(round(actual_seconds * 1000))
        if failure is not None:
            raise failure
        raise RuntimeError(f"FFmpeg did not produce a frame at {timestamp_ms}ms inside the selected source range")
    if failure is not None:
        raise failure
    return timestamp_ms


def _copy_image_frame(source_path: Path, output_path: Path) -> None:
    try:
        with Image.open(source_path) as source:
            image = ImageOps.contain(
                source.convert("RGB"),
                (FRAME_MAX_WIDTH, FRAME_MAX_HEIGHT),
                Image.Resampling.LANCZOS,
            )
            image.save(output_path, format="JPEG", quality=82, optimize=False, progressive=False, subsampling=2)
    except (OSError, ValueError) as error:
        raise ValueError(f"asset image is not reviewable: {source_path.name}") from error


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
    # 新证据永远写新版本；缓存损坏不能覆盖旧报告仍引用的帧。
    if output_dir.exists() or output_dir.is_symlink():
        raise ValueError("review evidence version already exists")
    os.replace(stage, output_dir)


if __name__ == "__main__":
    raise SystemExit(main())
