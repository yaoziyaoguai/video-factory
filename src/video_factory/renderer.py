import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Optional


FONT_CANDIDATES = [
    Path("/Library/Fonts/Arial Unicode.ttf"),
    Path("/System/Library/Fonts/STHeiti Light.ttc"),
    Path("/System/Library/Fonts/PingFang.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]


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


def render_script_video(
    manifest_path: Path,
    output_dir: Path,
    resolution: str = "1080x1920",
) -> Path:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    width, height = parse_resolution(resolution)
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    frames = write_scene_frames(manifest, frames_dir, width, height)
    concat_path = write_concat_file(output_dir / "concat.txt", frames)
    output_file = Path(str(manifest["output_file"]))

    command = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_path),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-vf",
        f"fps=30,format=yuv420p,scale={width}:{height}",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(output_file),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)

    manifest["rendered"] = True
    manifest["frames_dir"] = str(frames_dir)
    manifest["concat_file"] = str(concat_path)
    manifest["ffmpeg_command"] = command
    manifest["probe"] = probe_video(output_file)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output_file


def write_scene_frames(manifest: dict, frames_dir: Path, width: int, height: int) -> list[tuple[Path, float]]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required for MP4 rendering. Install project dependencies first.") from error

    title_font = load_font(ImageFont, max(42, width // 20))
    body_font = load_font(ImageFont, max(52, width // 17))
    note_font = load_font(ImageFont, max(28, width // 38))
    palette = [
        ("#111827", "#f9fafb", "#60a5fa"),
        ("#172554", "#eff6ff", "#facc15"),
        ("#14532d", "#f0fdf4", "#fb7185"),
        ("#3b0764", "#faf5ff", "#34d399"),
        ("#431407", "#fff7ed", "#93c5fd"),
    ]
    frames: list[tuple[Path, float]] = []
    scenes = manifest["slides"]

    for index, scene in enumerate(scenes):
        background, text_color, accent = palette[index % len(palette)]
        image = Image.new("RGB", (width, height), background)
        draw = ImageDraw.Draw(image)
        margin = max(64, width // 11)

        draw.text((margin, margin), f"Scene {scene['position']}", font=note_font, fill=accent)
        draw_multiline(
            draw,
            manifest["title"],
            (margin, margin + 72),
            title_font,
            text_color,
            width - margin * 2,
            line_spacing=16,
        )
        body_y = height // 3
        draw_multiline(
            draw,
            scene["text"],
            (margin, body_y),
            body_font,
            text_color,
            width - margin * 2,
            line_spacing=24,
        )
        footer = f"{scene['visual_strategy']} | {scene['visual_prompt']}"
        draw_multiline(
            draw,
            footer,
            (margin, height - margin * 3),
            note_font,
            accent,
            width - margin * 2,
            line_spacing=12,
        )

        frame_path = frames_dir / f"scene_{scene['position']:02d}.png"
        image.save(frame_path)
        frames.append((frame_path, float(scene["duration"])))

    return frames


def draw_multiline(draw, text: str, position: tuple[int, int], font, fill: str, max_width: int, line_spacing: int) -> None:
    x, y = position
    for line in wrap_text_by_pixels(draw, text, font, max_width):
        draw.text((x, y), line, font=font, fill=fill)
        box = draw.textbbox((x, y), line, font=font)
        y += box[3] - box[1] + line_spacing


def wrap_text_by_pixels(draw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for raw_line in textwrap.wrap(text, width=28) or [text]:
        current = ""
        for char in raw_line:
            candidate = current + char
            box = draw.textbbox((0, 0), candidate, font=font)
            if current and box[2] - box[0] > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def write_concat_file(path: Path, frames: list[tuple[Path, float]]) -> Path:
    lines: list[str] = []
    for frame_path, duration in frames:
        lines.append(f"file '{escape_concat_path(frame_path)}'")
        lines.append(f"duration {duration:.3f}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def probe_video(output_file: Path) -> dict:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=width,height,codec_type,codec_name",
            "-of",
            "json",
            str(output_file),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def parse_resolution(resolution: str) -> tuple[int, int]:
    try:
        width_text, height_text = resolution.lower().split("x", 1)
        width = int(width_text)
        height = int(height_text)
    except ValueError as error:
        raise ValueError(f"Invalid resolution: {resolution}") from error
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid resolution: {resolution}")
    return width, height


def load_font(ImageFont, size: int):
    font_path = find_font_file()
    if font_path is None:
        return ImageFont.load_default()
    return ImageFont.truetype(str(font_path), size)


def find_font_file() -> Optional[Path]:
    for candidate in FONT_CANDIDATES:
        if candidate.exists():
            return candidate
    return None


def escape_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "\\'")


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
    render_script_video(manifest_path, output_dir)
    return manifest_path
