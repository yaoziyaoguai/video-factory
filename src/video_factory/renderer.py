import json
import shutil
from pathlib import Path
from typing import Optional


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def write_render_manifest(
    job_id: int,
    script_path: Path,
    output_dir: Path,
    resolution: str = "1080x1920",
) -> Path:
    script = json.loads(script_path.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "render_manifest.json"
    payload = {
        "job_id": job_id,
        "resolution": resolution,
        "duration_target": script["duration_target"],
        "niche_slug": script.get("niche_slug", "general"),
        "title": script["title"],
        "requires_ffmpeg": True,
        "ffmpeg_available": ffmpeg_available(),
        "output_file": str(output_dir / "final.mp4"),
        "slides": [
            {
                "position": scene["position"],
                "duration": scene["duration"],
                "text": scene["narration"],
                "visual_strategy": scene["visual_strategy"],
                "visual_prompt": scene["visual_prompt"],
            }
            for scene in script["scenes"]
        ],
    }
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def render_job_manifest(
    job_id: int,
    script_path: Path,
    workspace: Path,
    dry_run: bool = False,
) -> Path:
    output_dir = workspace / "renders" / str(job_id)
    manifest_path = write_render_manifest(job_id, script_path, output_dir)
    if dry_run:
        return manifest_path
    if not ffmpeg_available():
        raise RuntimeError("FFmpeg and ffprobe are required for MP4 rendering. Install them, then rerun render-job.")
    return manifest_path
