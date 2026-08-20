import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Optional

from .stock_assets import default_asset_plan_path, load_asset_plan


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
        "visual_quality": "preview",
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


def attach_asset_plan(manifest_path: Path, asset_plan: Optional[dict]) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if asset_plan is not None:
        manifest["asset_plan"] = asset_plan
        manifest["visual_quality"] = "stock_asset_pending"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


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
    manifest["visual_quality"] = manifest.get("visual_quality", "preview")
    manifest["frames_dir"] = str(frames_dir)
    manifest["concat_file"] = str(concat_path)
    manifest["ffmpeg_command"] = command
    manifest["probe"] = probe_video(output_file)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output_file


def render_asset_video(
    manifest_path: Path,
    output_dir: Path,
    asset_plan: dict,
    resolution: str = "1080x1920",
) -> Path:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    width, height = parse_resolution(resolution)
    captions_dir = output_dir / "captions"
    clips_dir = output_dir / "clips"
    captions_dir.mkdir(parents=True, exist_ok=True)
    clips_dir.mkdir(parents=True, exist_ok=True)

    scene_assets = {
        int(asset["scene_position"]): asset
        for asset in asset_plan.get("scene_assets", [])
    }
    clips = []
    scene_commands = []
    for scene in manifest["slides"]:
        asset = scene_assets[int(scene["position"])]
        caption_path = write_caption_overlay(manifest, scene, captions_dir, width, height)
        clip_path, command = render_scene_clip(scene, asset, caption_path, clips_dir, width, height)
        clips.append(clip_path)
        scene_commands.append(command)

    clips_concat_path = write_clip_concat_file(output_dir / "clips.txt", clips)
    output_file = Path(str(manifest["output_file"]))
    final_command = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(clips_concat_path),
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-shortest",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(output_file),
    ]
    subprocess.run(final_command, check=True, capture_output=True, text=True)

    manifest["rendered"] = True
    manifest["visual_quality"] = "stock_asset"
    manifest["asset_plan"] = asset_plan
    manifest["captions_dir"] = str(captions_dir)
    manifest["clips_dir"] = str(clips_dir)
    manifest["clips_concat_file"] = str(clips_concat_path)
    manifest["ffmpeg_scene_commands"] = scene_commands
    manifest["ffmpeg_command"] = final_command
    manifest["probe"] = probe_video(output_file)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output_file


def write_caption_overlay(manifest: dict, scene: dict, captions_dir: Path, width: int, height: int) -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required for MP4 rendering. Install project dependencies first.") from error

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    title_font = load_font(ImageFont, max(26, width // 36))
    note_font = load_font(ImageFont, max(24, width // 45))
    margin = max(56, width // 13)
    panel_top = int(height * 0.64)
    panel_bottom = height - margin

    draw.rounded_rectangle(
        (margin, panel_top, width - margin, panel_bottom),
        radius=24,
        fill=(5, 10, 22, 218),
    )
    draw.text((margin + 34, panel_top + 24), manifest["title"], font=title_font, fill="#bfdbfe")
    draw_fitting_multiline(
        draw,
        scene["text"],
        (margin + 34, panel_top + 82),
        ImageFont,
        max(42, width // 24),
        30,
        "#f8fafc",
        width - margin * 2 - 68,
        panel_bottom - panel_top - 148,
        line_spacing=14,
    )
    draw.text(
        (margin + 34, panel_bottom - 48),
        f"Scene {scene['position']} / {len(manifest['slides'])}",
        font=note_font,
        fill="#93c5fd",
    )
    caption_path = captions_dir / f"scene_{scene['position']:02d}.png"
    image.save(caption_path)
    return caption_path


def render_scene_clip(
    scene: dict,
    asset: dict,
    caption_path: Path,
    clips_dir: Path,
    width: int,
    height: int,
) -> tuple[Path, list[str]]:
    duration = float(scene["duration"])
    asset_path = Path(str(asset["local_path"]))
    clip_path = clips_dir / f"scene_{scene['position']:02d}.mp4"
    if asset["media_type"] == "video":
        input_args = ["-stream_loop", "-1", "-t", f"{duration:.3f}", "-i", str(asset_path)]
    elif asset["media_type"] == "image":
        input_args = ["-loop", "1", "-t", f"{duration:.3f}", "-i", str(asset_path)]
    else:
        raise RuntimeError(f"Unsupported scene asset media type: {asset['media_type']}")

    command = [
        "ffmpeg",
        "-y",
        *input_args,
        "-i",
        str(caption_path),
        "-filter_complex",
        (
            f"[0:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1[bg];"
            "[bg][1:v]overlay=0:0,format=yuv420p[v]"
        ),
        "-map",
        "[v]",
        "-t",
        f"{duration:.3f}",
        "-r",
        "30",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        str(clip_path),
    ]
    subprocess.run(command, check=True, capture_output=True, text=True)
    return clip_path, command


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


def draw_fitting_multiline(
    draw,
    text: str,
    position: tuple[int, int],
    ImageFont,
    initial_size: int,
    min_size: int,
    fill: str,
    max_width: int,
    max_height: int,
    line_spacing: int,
) -> None:
    font = load_font(ImageFont, initial_size)
    lines = wrap_text_by_pixels(draw, text, font, max_width)
    for size in range(initial_size, min_size - 1, -2):
        font = load_font(ImageFont, size)
        lines = wrap_text_by_pixels(draw, text, font, max_width)
        if multiline_height(draw, lines, font, line_spacing) <= max_height:
            break
    x, y = position
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        box = draw.textbbox((x, y), line, font=font)
        y += box[3] - box[1] + line_spacing


def multiline_height(draw, lines: list[str], font, line_spacing: int) -> int:
    total = 0
    for line in lines:
        box = draw.textbbox((0, 0), line, font=font)
        total += box[3] - box[1] + line_spacing
    return max(0, total - line_spacing)


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


def write_clip_concat_file(path: Path, clips: list[Path]) -> Path:
    lines = [f"file '{escape_concat_path(clip)}'" for clip in clips]
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
    require_assets: bool = False,
    asset_plan_path: Optional[Path] = None,
) -> Path:
    output_dir = workspace / "renders" / str(job_id)
    manifest_path = write_render_manifest(job_id, script_path, output_dir)
    resolved_asset_plan_path = asset_plan_path or default_asset_plan_path(workspace, job_id)
    asset_plan = load_asset_plan(resolved_asset_plan_path) if resolved_asset_plan_path.exists() else None
    attach_asset_plan(manifest_path, asset_plan)
    if dry_run:
        return manifest_path
    if require_assets and asset_plan is None:
        raise RuntimeError(
            f"render-job --require-assets requires an asset plan at {resolved_asset_plan_path}. "
            "Run prepare-assets first."
        )
    if asset_plan is not None:
        validate_asset_plan(asset_plan, resolved_asset_plan_path)
    if not ffmpeg_available():
        raise RuntimeError("FFmpeg and ffprobe are required for MP4 rendering. Install them, then rerun render-job.")
    if asset_plan is not None:
        render_asset_video(manifest_path, output_dir, asset_plan)
        return manifest_path
    render_script_video(manifest_path, output_dir)
    return manifest_path


def validate_asset_plan(asset_plan: dict, path: Path) -> None:
    scene_assets = asset_plan.get("scene_assets", [])
    if not scene_assets:
        raise RuntimeError(f"Asset plan has no scene assets: {path}")
    missing = [
        asset
        for asset in scene_assets
        if not Path(str(asset.get("local_path", ""))).exists()
    ]
    if missing:
        positions = ", ".join(str(asset.get("scene_position")) for asset in missing)
        raise RuntimeError(f"Asset plan is missing local files for scenes: {positions}")
