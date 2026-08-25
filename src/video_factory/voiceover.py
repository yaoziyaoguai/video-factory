import json
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from .kokoro_voice import synthesize_kokoro_audio


def synthesize_voiceover_plan(
    script_path: Path,
    output_dir: Path,
    provider: str,
    voice: Optional[str] = None,
    rate: int = 190,
    profile_id: Optional[str] = None,
    pause_scale: float = 1.0,
    mastering_preset: str = "natural",
) -> Path:
    require_ffmpeg()
    mastering = mastering_settings(mastering_preset)
    script = json.loads(script_path.read_text(encoding="utf-8"))
    scenes = script.get("scenes", [])
    if not scenes:
        raise RuntimeError("Voice synthesis requires a script with scenes.")

    output_dir.mkdir(parents=True, exist_ok=True)
    normalized_tracks = []
    scene_entries = []
    for scene in scenes:
        position = int(scene["position"])
        raw_path = synthesize_raw_audio(
            text=str(scene["narration"]),
            output_dir=output_dir,
            position=position,
            provider=provider,
            voice=voice,
            rate=rate,
            pause_scale=pause_scale,
        )
        source_speech_duration = probe_audio_duration(raw_path)
        scene_duration = float(scene["duration"])
        available_speech_duration = max(scene_duration - 0.2, 0.5)
        tempo = min(max(source_speech_duration / available_speech_duration, 1.0), 1.35)
        speech_duration = source_speech_duration / tempo
        target_duration = max(scene_duration, speech_duration + 0.2)
        normalized_path = output_dir / f"scene_{position:02d}.m4a"
        audio_filter = mastering["filter"]
        if tempo > 1.001:
            audio_filter = f"atempo={tempo:.5f},{audio_filter}"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(raw_path),
                "-af",
                f"{audio_filter},apad=pad_dur={target_duration:.3f}",
                "-t",
                f"{target_duration:.3f}",
                "-ar",
                "44100",
                "-ac",
                "1",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                str(normalized_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        normalized_tracks.append(normalized_path)
        scene_entries.append(
            {
                "position": position,
                "audio_path": str(normalized_path.resolve()),
                "source_speech_duration": round(source_speech_duration, 3),
                "speech_duration": round(speech_duration, 3),
                "tempo": round(tempo, 3),
                "duration": round(target_duration, 3),
                "narration": str(scene["narration"]),
            }
        )

    concat_path = output_dir / "voice_clips.txt"
    concat_path.write_text(
        "\n".join(f"file '{escape_concat_path(path)}'" for path in normalized_tracks) + "\n",
        encoding="utf-8",
    )
    track_path = output_dir / "narration.m4a"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            str(track_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    plan = {
        "version": "video-factory/voiceover-plan-v2",
        "provider": provider,
        "voice": voice or default_voice(provider),
        "rate": rate,
        "direction": {
            "profile_id": profile_id or default_profile(provider, voice),
            "rate": rate,
            "pause_scale": pause_scale,
            "mastering_preset": mastering_preset,
        },
        "mastering": {
            "preset": mastering_preset,
            "target_lufs": mastering["target_lufs"],
            "true_peak_db": mastering["true_peak_db"],
            "filter": mastering["filter"],
        },
        "track_path": str(track_path.resolve()),
        "duration": round(sum(scene["duration"] for scene in scene_entries), 3),
        "scenes": scene_entries,
    }
    plan_path = output_dir / "voiceover_plan.json"
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return plan_path


def synthesize_raw_audio(
    text: str,
    output_dir: Path,
    position: int,
    provider: str,
    voice: Optional[str],
    rate: int,
    pause_scale: float,
) -> Path:
    if provider == "macos-say":
        say = shutil.which("say")
        if say is None:
            raise RuntimeError("The macos-say provider requires the macOS 'say' command.")
        raw_path = output_dir / f"scene_{position:02d}_raw.aiff"
        subprocess.run(
            [say, "-v", voice or "Tingting", "-r", str(rate), "-o", str(raw_path), directed_text(text, pause_scale)],
            check=True,
            capture_output=True,
            text=True,
        )
        return raw_path

    if provider == "tone":
        raw_path = output_dir / f"scene_{position:02d}_raw.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={420 + position * 35}:duration=0.8:sample_rate=44100",
                "-c:a",
                "pcm_s16le",
                str(raw_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return raw_path

    if provider == "kokoro":
        raw_path = output_dir / f"scene_{position:02d}_raw.wav"
        return synthesize_kokoro_audio(
            text=text,
            output_path=raw_path,
            voice=voice or "zf_001",
            rate=rate,
        )

    raise RuntimeError(f"Unsupported voice provider: {provider}")


def probe_audio_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def default_voice(provider: str) -> str:
    if provider == "macos-say":
        return "Tingting"
    if provider == "kokoro":
        return "zf_001"
    return "test-tone"


def default_profile(provider: str, voice: Optional[str]) -> str:
    if provider == "macos-say":
        return f"macos:{voice or 'Tingting'}"
    if provider == "kokoro":
        return f"kokoro:{voice or 'zf_001'}"
    return "tone:test-tone"


def directed_text(text: str, pause_scale: float) -> str:
    comma_pause = round(90 * pause_scale)
    sentence_pause = round(220 * pause_scale)
    directed = text
    for punctuation in "，、；：":
        directed = directed.replace(punctuation, f"{punctuation} [[slnc {comma_pause}]] ")
    for punctuation in "。！？!?":
        directed = directed.replace(punctuation, f"{punctuation} [[slnc {sentence_pause}]] ")
    return directed


def mastering_settings(preset: str) -> dict:
    settings = {
        "natural": {
            "target_lufs": -16,
            "true_peak_db": -1.5,
            "filter": "highpass=f=75,acompressor=threshold=-18dB:ratio=2:attack=20:release=200,loudnorm=I=-16:TP=-1.5:LRA=11",
        },
        "intimate": {
            "target_lufs": -17,
            "true_peak_db": -1.5,
            "filter": "highpass=f=65,lowpass=f=14500,equalizer=f=180:t=q:w=1:g=1.2,acompressor=threshold=-22dB:ratio=2.5:attack=18:release=220,loudnorm=I=-17:TP=-1.5:LRA=9",
        },
        "social": {
            "target_lufs": -14,
            "true_peak_db": -1.0,
            "filter": "highpass=f=90,equalizer=f=2800:t=q:w=1.2:g=1.5,acompressor=threshold=-20dB:ratio=3:attack=12:release=160,loudnorm=I=-14:TP=-1:LRA=7",
        },
    }
    if preset not in settings:
        raise RuntimeError(f"Unsupported mastering preset: {preset}")
    return settings[preset]


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("FFmpeg and ffprobe are required for voice synthesis.")


def escape_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("'", "\\'")
