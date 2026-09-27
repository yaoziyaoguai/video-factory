import hashlib
import json
import shutil
import subprocess
import textwrap
from pathlib import Path
from typing import Optional

from .stock_assets import default_asset_plan_path, load_asset_plan
from .stock_images import prepare_render_image
from .narration_subtitles import cues_to_ass
from .voiceover import _write_bytes_durably


FONT_CANDIDATES = [
    Path("/Library/Fonts/Arial Unicode.ttf"),
    Path("/System/Library/Fonts/STHeiti Light.ttc"),
    Path("/System/Library/Fonts/PingFang.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]
RENDER_FPS = 30


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
    font_path = find_font_file()
    payload = {
        "job_id": job_id,
        "resolution": resolution,
        "duration_target": script["duration_target"],
        "niche_slug": script.get("niche_slug", "general"),
        "title": script["title"],
        "requires_ffmpeg": True,
        "ffmpeg_available": ffmpeg_available(),
        "visual_quality": "preview",
        "aigc": {
            "explicit_label": "AI 辅助创作",
            "visible_from_seconds": 0,
            "visible_scene_position": 1,
            "implicit_metadata": "AI-generated or AI-assisted content; creator=VideoFactory",
            "platform_declaration_required": True,
        },
        "font_resource": font_resource(font_path),
        "output_file": str(output_dir / "final.mp4"),
        "slides": [
            {
                "position": scene["position"],
                "duration": scene["duration"],
                # 与配音一致：纯标点代表留白，不把它印成悬空的字幕。
                "text": scene["narration"] if any(character.isalnum() for character in scene["narration"]) else "",
                "on_screen_text": scene.get("on_screen_text") if isinstance(scene.get("on_screen_text"), str) else "",
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


def font_resource(font_path: Optional[Path]) -> dict:
    if font_path is None:
        return {"family": "Pillow default", "license_verified": False, "license_note": "Fallback font; verify the Pillow distribution terms before publishing."}
    name = font_path.name
    if "NotoSansCJK" in name:
        return {"family": "Noto Sans CJK", "license_verified": False, "license_note": "SIL Open Font License 1.1; verify attribution and redistribution requirements."}
    if "DejaVuSans" in name:
        return {"family": "DejaVu Sans", "license_verified": False, "license_note": "DejaVu Fonts license; verify redistribution requirements."}
    return {"family": name, "license_verified": False, "license_note": "System font used for rendering; verify platform and redistribution rights."}


def attach_asset_plan(manifest_path: Path, asset_plan: Optional[dict]) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if asset_plan is not None:
        manifest["asset_plan"] = asset_plan
        manifest["visual_quality"] = "stock_asset_pending"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def attach_voiceover_plan(manifest_path: Path, voiceover_plan: Optional[dict]) -> None:
    if voiceover_plan is None:
        return
    track_path = Path(str(voiceover_plan.get("track_path", "")))
    if not track_path.is_file():
        raise RuntimeError(f"Voiceover plan track does not exist: {track_path}")
    durations = {
        int(scene["position"]): float(scene["duration"])
        for scene in voiceover_plan.get("scenes", [])
    }
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    positions = {int(slide["position"]) for slide in manifest["slides"]}
    if set(durations) != positions:
        raise RuntimeError("Voiceover plan scene positions do not match the render manifest.")
    for slide in manifest["slides"]:
        position = int(slide["position"])
        if abs(float(slide["duration"]) - durations[position]) > 1e-6:
            raise RuntimeError(
                f"Voiceover scene {position} does not match the accepted render timeline."
            )
    if voiceover_plan.get("version") == "video-factory/voiceover-plan-v3":
        expected_samples = sum(timeline_frame_counts(manifest["slides"])) * 1470
        if voiceover_plan.get("sampleRate") != 44100 or voiceover_plan.get("totalSamples") != expected_samples:
            raise RuntimeError("Continuous narration must match the exact accepted render timeline.")
        # 原来的逐镜长驻文字不是同步字幕。v3 只从全片的真实 cue 绘制，不退回旧字幕。
        for slide in manifest["slides"]:
            slide["text"] = slide.get("on_screen_text", "")
    manifest["voiceover_plan"] = voiceover_plan
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
    frame_count = sum(timeline_frame_counts(manifest["slides"]))

    audio_input = render_audio_input(manifest)
    temporary_output = output_file.with_name(f"{output_file.stem}.partial{output_file.suffix}")
    burned_clip, subtitle_burn = burn_verified_subtitles(manifest, output_dir, concat_path, output_file)
    picture_input = ["-i", str(burned_clip)] if burned_clip else ["-f", "concat", "-safe", "0", "-i", str(concat_path)]
    picture_output = ["-c:v", "copy"] if burned_clip else [
        "-vf", f"fps=30,format=yuv420p,scale={width}:{height}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
    command = [
        "ffmpeg",
        "-y",
        *picture_input,
        *audio_input,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        *picture_output,
        *render_audio_duration_options(manifest),
        "-frames:v",
        str(frame_count),
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-metadata",
        "comment=AI-generated or AI-assisted content; creator=VideoFactory",
        "-movflags",
        "+faststart",
        str(temporary_output),
    ]
    run_atomic_ffmpeg(command, temporary_output, output_file)

    manifest["rendered"] = True
    manifest["visual_quality"] = manifest.get("visual_quality", "preview")
    manifest["frames_dir"] = str(frames_dir)
    manifest["concat_file"] = str(concat_path)
    if subtitle_burn is not None:
        manifest["subtitle_burn"] = subtitle_burn
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
    director_routes = {
        int(route["scene_position"]): route
        for route in asset_plan.get("director_routing", [])
        if isinstance(route, dict) and isinstance(route.get("scene_position"), int)
    }
    clips = []
    scene_commands = []
    image_processing = []
    frame_counts = timeline_frame_counts(manifest["slides"])
    for scene, frame_count in zip(manifest["slides"], frame_counts):
        asset = scene_assets[int(scene["position"])]
        caption_style = "editorial" if asset.get("provider") == "local" else "subtitle"
        caption_path = write_caption_overlay(
            manifest,
            scene,
            captions_dir,
            width,
            height,
            style=caption_style,
            director_route=director_routes.get(int(scene["position"])),
        )
        clip_path, command = render_scene_clip(
            scene,
            asset,
            caption_path,
            clips_dir,
            width,
            height,
            frame_count=frame_count,
        )
        clips.append(clip_path)
        scene_commands.append(command)
        derived_image = clips_dir / f"scene_{scene['position']:02d}.render.png"
        if str(derived_image) in command:
            image_processing.append({
                'scene_position': scene['position'],
                **json.loads(derived_image.with_suffix('.json').read_text(encoding='utf-8')),
            })

    clips_concat_path = write_clip_concat_file(output_dir / "clips.txt", clips)
    output_file = Path(str(manifest["output_file"]))
    audio_input = render_audio_input(manifest)
    temporary_output = output_file.with_name(f"{output_file.stem}.partial{output_file.suffix}")
    # T05：同步字幕的唯一烧录路径——已有画面结果 → 一次本地 ASS 烧录中间视频 →
    # 现有最终音画封装。-c:v copy 的最终封装不承担字幕滤镜；滤镜或旁挂缺失时
    # 如实记录 blocked，不回退到逐镜文字冒充同步字幕。
    burned_clip, subtitle_burn = burn_verified_subtitles(manifest, output_dir, clips_concat_path, output_file)
    if burned_clip is not None:
        concat_input = ["-i", str(burned_clip)]
    else:
        concat_input = ["-f", "concat", "-safe", "0", "-i", str(clips_concat_path)]
    final_command = [
        "ffmpeg",
        "-y",
        *concat_input,
        *audio_input,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        *render_audio_duration_options(manifest),
        "-frames:v",
        str(sum(frame_counts)),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-metadata",
        "comment=AI-generated or AI-assisted content; creator=VideoFactory",
        "-movflags",
        "+faststart",
        str(temporary_output),
    ]
    run_atomic_ffmpeg(final_command, temporary_output, output_file)

    manifest["rendered"] = True
    providers = {str(asset.get("provider", "unknown")) for asset in asset_plan.get("scene_assets", [])}
    manifest["visual_quality"] = "local_editorial" if providers == {"local"} else "stock_asset"
    manifest["asset_plan"] = asset_plan
    manifest["captions_dir"] = str(captions_dir)
    manifest["clips_dir"] = str(clips_dir)
    manifest["clips_concat_file"] = str(clips_concat_path)
    if subtitle_burn is not None:
        manifest["subtitle_burn"] = subtitle_burn
    manifest["ffmpeg_scene_commands"] = scene_commands
    manifest['image_processing'] = image_processing
    manifest["ffmpeg_command"] = final_command
    manifest["probe"] = probe_video(output_file)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return output_file


def write_caption_overlay(
    manifest: dict,
    scene: dict,
    captions_dir: Path,
    width: int,
    height: int,
    style: str = "subtitle",
    director_route: Optional[dict] = None,
) -> Path:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required for MP4 rendering. Install project dependencies first.") from error

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    caption_path = captions_dir / f"scene_{scene['position']:02d}.png"
    draw = ImageDraw.Draw(image)
    margin = max(56, width // 13)
    if style == "editorial":
        body_font, body_lines = fit_multiline(
            draw,
            scene["text"],
            ImageFont,
            max(40, width // 24),
            30,
            width - margin * 2,
            int(height * 0.19),
            line_spacing=12,
        )
        body_height = multiline_height(draw, body_lines, body_font, 12)
        body_y = height - max(116, height // 16) - body_height
        panel_top = max(int(height * 0.69), body_y - 42)
        draw.rectangle((0, panel_top, width, height), fill=(7, 12, 23, 248))
        draw_stroked_multiline(
            draw,
            body_lines,
            (margin, body_y),
            body_font,
            "#ffffff",
            line_spacing=12,
            stroke_width=2,
            stroke_fill=(0, 0, 0, 180),
        )
        draw_aigc_badge(draw, ImageFont, width, scene)
        image.save(caption_path)
        return caption_path

    body_font, body_lines = fit_multiline(
        draw,
        scene["text"],
        ImageFont,
        max(54, width // 20),
        34,
        width - margin * 2,
        int(height * 0.25),
        line_spacing=12,
    )
    body_height = multiline_height(draw, body_lines, body_font, 12)
    body_y = height - max(96, height // 20) - body_height

    draw_bottom_scrim(draw, width, height, max(0, body_y - 96), height)
    draw_stroked_multiline(
        draw,
        body_lines,
        (margin, body_y),
        body_font,
        "#ffffff",
        line_spacing=12,
        stroke_width=4,
        stroke_fill=(2, 6, 23, 210),
    )
    draw_aigc_badge(draw, ImageFont, width, scene)
    image.save(caption_path)
    return caption_path


def render_scene_clip(
    scene: dict,
    asset: dict,
    caption_path: Path,
    clips_dir: Path,
    width: int,
    height: int,
    frame_count: Optional[int] = None,
) -> tuple[Path, list[str]]:
    if "duration_frames" in asset:
        requested_frame_count = asset["duration_frames"]
        if (
            not isinstance(requested_frame_count, int)
            or isinstance(requested_frame_count, bool)
            or requested_frame_count <= 0
        ):
            raise RuntimeError(f"Scene {scene['position']} has an invalid compiled frame count.")
    else:
        requested_frame_count = frame_count if frame_count is not None else round(float(scene["duration"]) * RENDER_FPS)
        if (
            not isinstance(requested_frame_count, int)
            or isinstance(requested_frame_count, bool)
            or requested_frame_count <= 0
        ):
            raise RuntimeError(f"Scene {scene['position']} has an invalid render frame count.")
    if frame_count is not None and asset.get("duration_frames") is not None and requested_frame_count != frame_count:
        raise RuntimeError(f"Scene {scene['position']} compiled frame count does not match the render timeline.")
    resolved_frame_count = requested_frame_count
    duration = resolved_frame_count / RENDER_FPS
    source_in_frame = asset.get("source_in_frame", 0)
    if not isinstance(source_in_frame, int) or isinstance(source_in_frame, bool) or source_in_frame < 0:
        raise RuntimeError(f"Scene {scene['position']} has an invalid source frame offset.")
    asset_path = Path(str(asset["local_path"]))
    clip_path = clips_dir / f"scene_{scene['position']:02d}.mp4"
    if asset["media_type"] == "video":
        source_start = source_in_frame / RENDER_FPS
        source_end = (source_in_frame + resolved_frame_count) / RENDER_FPS
        source_duration = probe_media_duration(asset_path)
        if source_end > source_duration + 1e-6:
            raise RuntimeError(
                f"Scene {scene['position']} requires source frames through {source_end:.3f}s, "
                f"but the selected video ends at {source_duration:.3f}s."
            )
        input_args = ["-i", str(asset_path)]
        background_filter = (
            f"trim=start={source_start:.9f}:end={source_end:.9f},"
            "setpts=PTS-STARTPTS,fps=30,"
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},setsar=1"
        )
    elif asset["media_type"] == "image":
        if source_in_frame != 0:
            raise RuntimeError(f"Scene {scene['position']} cannot apply a source frame offset to an image.")
        asset_path = prepare_render_image(
            asset_path, clips_dir / f"scene_{scene['position']:02d}.render.png", width, height,
        )
        input_args = [
            "-framerate",
            "30",
            "-loop",
            "1",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(asset_path),
        ]
        background_filter = (
            f"scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},"
            "zoompan=z='min(zoom+0.00045,1.065)':"
            "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:s={width}x{height}:fps=30,setsar=1"
        )
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
            f"[0:v]{background_filter}[bg];"
            f"[bg][1:v]overlay=0:0,"
            f"drawbox=x=0:y={height - 10}:w='min(iw,iw*t/{duration:.3f})':h=10:"
            "color=white@0.72:t=fill,"
            "format=yuv420p[v]"
        ),
        "-map",
        "[v]",
        "-r",
        str(RENDER_FPS),
        "-frames:v",
        str(resolved_frame_count),
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
    if clip_path.is_file():
        actual_frame_count = probe_media_frame_count(clip_path)
        if actual_frame_count != resolved_frame_count:
            clip_path.unlink(missing_ok=True)
            raise RuntimeError(
                f"Scene {scene['position']} rendered {actual_frame_count} frames; expected {resolved_frame_count}."
            )
    return clip_path, command


def timeline_frame_counts(scenes: list[dict]) -> list[int]:
    # 按累计时间切分帧边界，避免每个镜头独立取整后让整片多帧或少帧。
    elapsed_seconds = 0.0
    previous_boundary = 0
    frame_counts: list[int] = []
    for scene in scenes:
        elapsed_seconds += float(scene["duration"])
        boundary = round(elapsed_seconds * RENDER_FPS)
        frame_counts.append(boundary - previous_boundary)
        previous_boundary = boundary
    return frame_counts


def probe_media_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    duration = float(result.stdout.strip())
    if duration <= 0:
        raise RuntimeError(f"Video has an invalid duration: {path}")
    return duration


def probe_media_frame_count(path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        frame_count = int(result.stdout.strip())
    except ValueError as error:
        raise RuntimeError(f"Video has no readable frame count: {path}") from error
    if frame_count <= 0:
        raise RuntimeError(f"Video has no readable frames: {path}")
    return frame_count


def write_scene_frames(manifest: dict, frames_dir: Path, width: int, height: int) -> list[tuple[Path, float]]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as error:
        raise RuntimeError("Pillow is required for MP4 rendering. Install project dependencies first.") from error

    body_font = load_font(ImageFont, max(52, width // 17))
    palette = [
        ("#111827", "#f9fafb"),
        ("#172554", "#eff6ff"),
        ("#14532d", "#f0fdf4"),
        ("#3b0764", "#faf5ff"),
        ("#431407", "#fff7ed"),
    ]
    frames: list[tuple[Path, float]] = []
    scenes = manifest["slides"]

    for index, scene in enumerate(scenes):
        background, text_color = palette[index % len(palette)]
        image = Image.new("RGB", (width, height), background)
        draw = ImageDraw.Draw(image)
        margin = max(64, width // 11)

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
        draw_aigc_badge(draw, ImageFont, width, scene)

        frame_path = frames_dir / f"scene_{scene['position']:02d}.png"
        image.save(frame_path)
        frames.append((frame_path, float(scene["duration"])))

    return frames


def draw_aigc_badge(draw, ImageFont, width: int, scene: dict) -> None:
    if int(scene["position"]) != 1:
        return
    text = "AI 辅助创作"
    font = load_font(ImageFont, max(22, width // 44))
    box = draw.textbbox((0, 0), text, font=font)
    padding_x = max(11, width // 90)
    padding_y = max(7, width // 150)
    x = max(34, width // 28)
    y = max(34, width // 28)
    badge_width = box[2] - box[0] + padding_x * 2
    badge_height = box[3] - box[1] + padding_y * 2
    draw.rounded_rectangle(
        (x, y, x + badge_width, y + badge_height),
        radius=max(4, width // 180),
        fill=(12, 17, 24, 218),
        outline=(255, 255, 255, 90),
        width=max(1, width // 540),
    )
    draw.text((x + padding_x, y + padding_y - box[1]), text, font=font, fill=(255, 255, 255, 245))


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


def fit_multiline(
    draw,
    text: str,
    ImageFont,
    initial_size: int,
    min_size: int,
    max_width: int,
    max_height: int,
    line_spacing: int,
):
    font = load_font(ImageFont, initial_size)
    lines = wrap_text_by_pixels(draw, text, font, max_width)
    for size in range(initial_size, min_size - 1, -2):
        font = load_font(ImageFont, size)
        lines = wrap_text_by_pixels(draw, text, font, max_width)
        if multiline_height(draw, lines, font, line_spacing) <= max_height:
            break
    return font, lines


def draw_stroked_multiline(
    draw,
    lines: list[str],
    position: tuple[int, int],
    font,
    fill: str,
    line_spacing: int,
    stroke_width: int,
    stroke_fill,
) -> None:
    x, y = position
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill, stroke_width=stroke_width, stroke_fill=stroke_fill)
        box = draw.textbbox((x, y), line, font=font, stroke_width=stroke_width)
        y += box[3] - box[1] + line_spacing


def draw_bottom_scrim(draw, width: int, height: int, start_y: int, end_y: int) -> None:
    span = max(1, end_y - start_y)
    for y in range(start_y, end_y, 6):
        ratio = (y - start_y) / span
        alpha = int(24 + 170 * ratio)
        draw.rectangle((0, y, width, y + 6), fill=(2, 6, 23, alpha))


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
                if char in "，。！？；：、）】》」』…,.!?;:":
                    lines.append(candidate)
                    current = ""
                else:
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
    # concat demuxer 需要末尾哨兵帧才会兑现最后一张图片的 duration；输出仍由正式帧数封顶。
    if frames:
        lines.append(f"file '{escape_concat_path(frames[-1][0])}'")
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


def render_audio_input(manifest: dict) -> list[str]:
    voiceover_plan = manifest.get("voiceover_plan")
    if voiceover_plan:
        return ["-i", str(voiceover_plan["track_path"])]
    return [
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=44100",
    ]


def render_audio_duration_options(manifest: dict) -> list[str]:
    if manifest.get("voiceover_plan", {}).get("version") == "video-factory/voiceover-plan-v3":
        # v3 音轨已经按样本校验为完整片长，不以最短输入决定输出结束点。
        return ["-t", f"{sum(timeline_frame_counts(manifest['slides'])) / RENDER_FPS:.9f}"]
    return ["-shortest"]


def run_atomic_ffmpeg(command: list[str], temporary_output: Path, output_file: Path) -> None:
    temporary_output.unlink(missing_ok=True)
    try:
        subprocess.run(command, check=True, capture_output=True, text=True)
        temporary_output.replace(output_file)
    except Exception:
        temporary_output.unlink(missing_ok=True)
        raise


def render_job_manifest(
    job_id: int,
    script_path: Path,
    workspace: Path,
    dry_run: bool = False,
    require_assets: bool = False,
    asset_plan_path: Optional[Path] = None,
    voiceover_plan_path: Optional[Path] = None,
    resolution: str = "1080x1920",
) -> Path:
    output_dir = workspace / "renders" / str(job_id)
    manifest_path = write_render_manifest(job_id, script_path, output_dir, resolution=resolution)
    resolved_asset_plan_path = asset_plan_path or default_asset_plan_path(workspace, job_id)
    asset_plan = load_asset_plan(resolved_asset_plan_path) if resolved_asset_plan_path.exists() else None
    voiceover_plan = (
        json.loads(voiceover_plan_path.read_text(encoding="utf-8"))
        if voiceover_plan_path is not None and voiceover_plan_path.exists()
        else None
    )
    attach_asset_plan(manifest_path, asset_plan)
    attach_voiceover_plan(manifest_path, voiceover_plan)
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
        render_asset_video(manifest_path, output_dir, asset_plan, resolution=resolution)
        return manifest_path
    render_script_video(manifest_path, output_dir, resolution=resolution)
    return manifest_path


def burn_verified_subtitles(
    manifest: dict,
    output_dir: Path,
    clips_concat_path: Path,
    output_file: Path,
) -> tuple[Optional[Path], Optional[dict]]:
    """只有 verified 的同次字幕才烧录；校验 plan 绑定，滤镜缺失如实 blocked。

    返回 (烧录后的中间视频路径或 None, 记录到 manifest 的烧录状态或 None)。
    """
    voiceover_plan = manifest.get("voiceover_plan")
    if not isinstance(voiceover_plan, dict):
        return None, None
    subtitles = voiceover_plan.get("subtitles")
    if not isinstance(subtitles, dict):
        return None, None
    if subtitles.get("status") != "verified":
        return None, None
    if not subtitles.get("layoutKey") or subtitles.get("layoutKey") != voiceover_plan.get("layoutKey"):
        return None, {"status": "blocked", "reason": "subtitle_layout_binding_mismatch"}
    track_path = voiceover_plan.get("track_path")
    ass_path = None
    sidecar = subtitles.get("sidecar")
    if isinstance(sidecar, dict) and isinstance(sidecar.get("ass"), str):
        candidate = (Path(str(track_path)).parent / sidecar["ass"]).resolve() if track_path else None
        if candidate and candidate.parent != Path(str(track_path)).resolve().parent:
            return None, {"status": "blocked", "reason": "subtitle_path_binding_mismatch"}
        ass_path = candidate if candidate and candidate.is_file() else None
    if ass_path is None:
        return None, {"status": "blocked", "reason": "ass_sidecar_missing"}
    if (hashlib.sha256(ass_path.read_bytes()).hexdigest() != subtitles.get("sidecarSha256", {}).get("ass")
            or hashlib.sha256(Path(str(track_path)).read_bytes()).hexdigest() != voiceover_plan.get("trackSha256")):
        return None, {"status": "blocked", "reason": "subtitle_content_binding_mismatch"}
    if not ffmpeg_filter_available("ass"):
        # 本机 FFmpeg 无 libass：不回退逐镜文字冒充同步字幕，如实 blocked。
        return None, {"status": "blocked", "reason": "ffmpeg_missing_libass"}
    burned = output_file.with_name(f"{output_file.stem}.subtitled{output_file.suffix}")
    burned_temporary = burned.with_name(f"{burned.stem}.partial{burned.suffix}")
    frame_count = sum(timeline_frame_counts(manifest["slides"]))
    width, height = parse_resolution(str(manifest.get("resolution", "1080x1920")))
    font_path = find_font_file()
    if font_path is None:
        return None, {"status": "blocked", "reason": "subtitle_font_unavailable"}
    from PIL import ImageFont
    font_name = ImageFont.truetype(str(font_path), 16).getname()[0]
    # 原旁挂文件是不可变证据；按当前成片尺寸派生本次烧录用ASS，不覆盖已批准的文件。
    ass_path = output_dir / "narration-render.ass"
    _write_bytes_durably(ass_path, cues_to_ass(subtitles.get("cues", []), width=width, height=height,
        font_name=font_name, font_size=max(12, round(56 * height / 1920))).encode("utf-8"))
    burn_command = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(clips_concat_path),
        "-vf",
        f"fps=30,scale={width}:{height},ass={_ass_filter_path(ass_path)}:fontsdir={_ass_filter_path(font_path.parent)},format=yuv420p",
        "-an",
        "-frames:v",
        str(frame_count),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        str(burned_temporary),
    ]
    run_atomic_ffmpeg(burn_command, burned_temporary, burned)
    return burned, {
        "status": "burned",
        "assPath": str(ass_path),
        "cueCount": len(subtitles.get("cues", [])),
        "contractVersion": subtitles.get("version"),
    }


def _ass_filter_path(ass_path: Path) -> str:
    # subtitles/ass 滤镜参数里的路径要转义滤镜转义层；单引号包裹并转义内部引号与冒号。
    text = str(ass_path.resolve()).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return f"'{text}'"


_FFmpegFilterAvailability: dict[str, bool] = {}


def ffmpeg_filter_available(name: str) -> bool:
    cached = _FFmpegFilterAvailability.get(name)
    if cached is not None:
        return cached
    try:
        listing = subprocess.run(
            ["ffmpeg", "-hide_banner", "-filters"],
            check=True, capture_output=True, text=True, timeout=20,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        _FFmpegFilterAvailability[name] = False
        return False
    available = any(
        line.split()[-1:] == [name] or line.rstrip().endswith(f" {name}")
        for line in listing.splitlines()
    )
    _FFmpegFilterAvailability[name] = available
    return available


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
