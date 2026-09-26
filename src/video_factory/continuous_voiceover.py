"""把已物化的连续旁白放到全片时间线上，不在镜头边界补静音。"""

import hashlib
import json
import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any

from .narration_plan import SAMPLE_RATE, SAMPLES_PER_FRAME


class NarrationGroupDoesNotFitError(RuntimeError):
    code = "NARRATION_GROUP_DOES_NOT_FIT"

    def __init__(self, group: dict[str, Any], samples: int, raw_audio_path: Path):
        self.group_id = group["id"]
        self.source_scene_positions = list(group["sourceScenePositions"])
        self.window = dict(group["window"])
        self.source_audio_samples = samples
        self.required_frames = math.ceil(samples / SAMPLES_PER_FRAME) + group["placement"]["offsetFrames"]
        self.raw_audio_path = raw_audio_path
        super().__init__(f"{self.code}: {self.group_id} needs {self.required_frames} frames; "
                         "original audio retained without truncation or automatic synthesis retry.")


def assemble_narration_track(
    plan: dict[str, Any], raw_audio: dict[str, Path], output_dir: Path,
    *, mastering_filter: str = "anull",
) -> dict[str, Any]:
    """调用方必须先校验计划与正式脚本/视觉 SHA 的绑定；这里只处理已确认排轨。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    total_samples = plan["visualPlan"]["totalFrames"] * SAMPLES_PER_FRAME
    track = bytearray(total_samples * 2)
    groups = []
    with tempfile.TemporaryDirectory(prefix="narration-", dir=output_dir) as temporary:
        temporary_root = Path(temporary)
        for index, group in enumerate(plan["groups"]):
            raw_path = raw_audio[group["id"]].resolve()
            decoded_path = temporary_root / f"group-{index}.wav"
            subprocess.run([
                "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(raw_path),
                "-map", "0:a:0", "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(decoded_path),
            ], check=True, capture_output=True, timeout=120)
            with wave.open(str(decoded_path), "rb") as decoded:
                samples = decoded.getnframes()
                window_start = group["window"]["startFrame"] * SAMPLES_PER_FRAME
                window_end = group["window"]["endFrame"] * SAMPLES_PER_FRAME
                offset = group["placement"]["offsetFrames"] * SAMPLES_PER_FRAME
                start = (window_start + offset if group["placement"]["anchor"] == "start"
                         else window_end - offset - samples)
                if samples <= 0:
                    raise RuntimeError(f"Narration group {group['id']} has no decoded audio samples.")
                if start < window_start or start + samples > window_end:
                    raise NarrationGroupDoesNotFitError(group, samples, raw_path)
                track[start * 2:(start + samples) * 2] = decoded.readframes(samples)
            groups.append({
                **group, "rawAudioPath": str(raw_path),
                "rawAudioSha256": hashlib.sha256(raw_path.read_bytes()).hexdigest(),
                "sourceAudioSamples": samples, "startSample": start, "endSample": start + samples,
                "unfilledWindowSamples": window_end - window_start - samples,
            })
        temporary_pcm = temporary_root / "narration.wav"
        with wave.open(str(temporary_pcm), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(SAMPLE_RATE)
            audio.writeframes(track)
        pcm_path = output_dir / "narration.wav"
        os.replace(temporary_pcm, pcm_path)
        temporary_track = temporary_root / "narration.m4a"
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(pcm_path),
            "-af", mastering_filter, "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "aac", "-b:a", "160k",
            str(temporary_track),
        ], check=True, capture_output=True, timeout=120)
        track_path = output_dir / "narration.m4a"
        os.replace(temporary_track, track_path)
    layout = {"plan": plan, "audio": [group["rawAudioSha256"] for group in groups], "mastering": mastering_filter}
    return {
        "version": "video-factory/voiceover-plan-v3", "narrationPlan": plan,
        "sampleRate": SAMPLE_RATE, "totalSamples": total_samples,
        "duration": total_samples / SAMPLE_RATE, "groups": groups,
        "layoutKey": hashlib.sha256(json.dumps(layout, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        "pcm_path": str(pcm_path.resolve()), "track_path": str(track_path.resolve()),
    }
