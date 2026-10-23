"""将创作者选择的一条音乐与已确认旁白混合，不改动旁白原件或画面时间轴。"""
import hashlib
import math
import subprocess
from pathlib import Path


def mix_background_music(music: dict, voice_path: Path | None, duration: float, output: Path) -> dict:
    if not isinstance(music, dict):
        raise ValueError("Background music settings must be an object.")
    source = Path(str(music.get("path", "")))
    if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != music.get("sha256"):
        raise ValueError("Background music content binding changed.")
    for key, maximum in (("volume", 0.5), ("fadeInSeconds", 5), ("fadeOutSeconds", 5)):
        value = music.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError(f"Invalid background music {key}.")
    if not isinstance(music.get("ducking"), bool) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid background music timeline.")
    voice_input = ["-i", str(voice_path)] if voice_path else ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
    fade_in = min(float(music["fadeInSeconds"]), duration)
    fade_out = min(float(music["fadeOutSeconds"]), duration)
    narration = f"[0:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration={duration},asetpts=PTS-STARTPTS"
    background = (f"[1:a]atrim=duration={duration},asetpts=PTS-STARTPTS,loudnorm=I=-18:TP=-2:LRA=11,"
                  f"aresample=44100,aformat=channel_layouts=stereo,volume={music['volume']}")
    if fade_in:
        background += f",afade=t=in:d={fade_in}"
    if fade_out:
        background += f",afade=t=out:st={duration - fade_out}:d={fade_out}"
    if music["ducking"] and voice_path:
        filters = (narration + ",asplit=2[voice][control];" + background + "[music];"
                   "[music][control]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=300[bed];")
    else:
        filters = narration + "[voice];" + background + "[bed];"
    filters += "[voice][bed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[mixed]"
    temporary = output.with_name(output.stem + ".partial.wav")
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", *voice_input, "-stream_loop", "-1", "-protocol_whitelist", "file,pipe",
                        "-i", str(source), "-filter_complex", filters, "-map", "[mixed]", "-t", str(duration),
                        "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(temporary)],
                       check=True, capture_output=True, timeout=max(60, duration * 2))
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return {**music, "trackPath": str(output), "trackSha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            "durationSeconds": duration}
