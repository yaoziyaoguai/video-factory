"""从已采用视频提取原声；不生成声音、不猜字幕、不修补缺失的媒体。"""
import hashlib
import io
import json
import math
import subprocess
import wave
from pathlib import Path

from .voiceover import _write_bytes_durably, _write_json_durably

VERSION = "video-factory/native-audio-plan-v1"
FPS, SAMPLE_RATE, CHANNELS = 30, 44100, 2
SAMPLES_PER_FRAME = SAMPLE_RATE // FPS


class NativeAudioError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def file_sha(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def verified_file(identity: dict, root: Path) -> Path:
    if not isinstance(identity, dict) or not isinstance(identity.get("uri"), str):
        raise NativeAudioError("invalid_binding", "原声来源缺少文件身份，请刷新当前素材后重试。")
    target = Path(identity["uri"]).resolve()
    if not target.is_relative_to(root.resolve()) or not target.is_file():
        raise NativeAudioError("invalid_binding", "原声来源文件缺失或不在制作目录内。请恢复原素材或返工。")
    if file_sha(target) != identity.get("sha256"):
        raise NativeAudioError("invalid_binding", "原声来源内容已变化，不能使用旧的采用记录。请重新确认素材。")
    return target


def verify_inputs(inputs: dict, root: Path) -> dict:
    identities = inputs.get("nativeInputIdentities")
    if not isinstance(identities, dict):
        raise NativeAudioError("invalid_binding", "当前规划和素材缺少身份记录。")
    for key in ("scriptPath", "executablePlanPath", "assetPlanPath"):
        identity = identities.get(key)
        target = verified_file(identity, root)
        if not isinstance(inputs.get(key), str) or target != Path(inputs[key]).resolve():
            raise NativeAudioError("invalid_binding", "原声输入不是当前采用的规划或素材。")
    return identities


def _probe(source: Path) -> tuple[dict, dict]:
    try:
        probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(source)],
            check=True, capture_output=True, text=True, timeout=60).stdout)
    except (subprocess.SubprocessError, ValueError) as error:
        raise NativeAudioError("audio_decode_failed", "无法读取原片媒体信息。请恢复原下载后重新准备原声。") from error
    videos = [s for s in probe.get("streams", []) if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")]
    audios = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    if not videos:
        raise NativeAudioError("source_range_insufficient", "原片没有可解码画面，请查看素材并返工。")
    if not audios:
        raise NativeAudioError("missing_audio", "这段视频没有音轨。原视频已保留；可以返工重做本镜，或切换为独立配音。")
    if len(audios) != 1 or len(videos) != 1:
        raise NativeAudioError("audio_stream_ambiguous", "原片包含多条音画流，无法确定要采用哪一条。请更换素材或切换独立配音。")
    return videos[0], audios[0]


def _time(stream: dict, key: str, default=None) -> float:
    try:
        value = float(stream.get(key, default))
    except (TypeError, ValueError) as error:
        raise NativeAudioError("audio_decode_failed", "原片缺少可核对的音画时间信息。") from error
    if not math.isfinite(value):
        raise NativeAudioError("audio_decode_failed", "原片音画时间信息无效。")
    return value


def _wav_bytes(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((CHANNELS, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        audio.writeframes(pcm)
    return output.getvalue()


def _assert_audio_timeline(source: Path, sample_rate: int) -> None:
    # 解码器会输出连续PCM，但可能隐去源流内部的时间戳跳跃；不能因此改变声画关系。
    try:
        frames = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_frames",
            "-show_entries", "frame=best_effort_timestamp_time,nb_samples", "-of", "json", str(source)],
            check=True, capture_output=True, text=True, timeout=120).stdout).get("frames", [])
        expected = None
        for frame in frames:
            start = float(frame["best_effort_timestamp_time"])
            samples = int(frame["nb_samples"])
            if not math.isfinite(start) or samples <= 0 or sample_rate <= 0:
                raise ValueError("invalid audio frame")
            if expected is not None and abs(start - expected) > 2 / sample_rate:
                raise NativeAudioError("audio_timeline_discontinuous", "原片音轨时间戳不连续，不能直接拼接；请更换素材或关联返工。原片保留，不会补静音或重新采购。")
            expected = start + samples / sample_rate
        if expected is None:
            raise ValueError("no decoded audio frames")
    except NativeAudioError:
        raise
    except (subprocess.SubprocessError, KeyError, TypeError, ValueError) as error:
        raise NativeAudioError("audio_decode_failed", "原片音轨缺少可核对的连续时间信息。请恢复原下载或关联返工。") from error


def prepare_native_audio(inputs: dict, root: Path, output_dir: Path, executable: dict, assets: dict) -> Path:
    identities = verify_inputs(inputs, root)
    source_identities = inputs.get("nativeSourceIdentities")
    if not isinstance(source_identities, list):
        raise NativeAudioError("invalid_binding", "原片缺少来源身份。")
    sources_by_path = {str(Path(item["uri"]).resolve()): item for item in source_identities
                       if isinstance(item, dict) and isinstance(item.get("uri"), str)}
    by_position = {asset["scene_position"]: asset for asset in assets["scene_assets"]}
    segments, sources, chunks = [], [], []
    for cut in executable["cuts"]:
        position = cut["scenePosition"]
        asset = by_position[position]
        if asset.get("media_type") != "video":
            raise NativeAudioError("invalid_binding", f"镜头 {position} 不是原生视频，请修改画面方案。")
        source = Path(str(asset.get("local_path", ""))).resolve()
        identity = sources_by_path.get(str(source))
        verified_file(identity, root)
        video, audio = _probe(source)
        _assert_audio_timeline(source, int(_time(audio, "sample_rate")))
        video_start, audio_start = _time(video, "start_time", 0), _time(audio, "start_time", 0)
        duration = _time(video, "duration")
        if not 0 < duration <= 180:
            raise NativeAudioError("source_range_insufficient", f"镜头 {position} 的原片时长无效。")
        source_start = cut["sourceInFrame"] / FPS
        source_end = (cut["sourceInFrame"] + cut["frameCount"]) / FPS
        if source_end > duration + 1e-6:
            raise NativeAudioError("source_range_insufficient", f"镜头 {position} 的画面不足以覆盖采用范围；请调整范围或返工，不会自动补帧。")
        # 解码后的PCM从音频自身起点开始；转换索引时保留它相对视频起点的偏移。
        offset = audio_start - video_start
        first_sample = round((source_start - offset) * SAMPLE_RATE)
        samples = cut["frameCount"] * SAMPLES_PER_FRAME
        if first_sample < 0:
            raise NativeAudioError("audio_range_insufficient", f"镜头 {position} 的声音晚于采用范围开始；请调整范围或返工，不会补静音。")
        try:
            subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(source), "-map", "0:v:0", "-an", "-f", "null", "-"],
                check=True, capture_output=True, timeout=120)
            pcm = subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(source), "-map", "0:a:0", "-vn",
                "-ac", str(CHANNELS), "-ar", str(SAMPLE_RATE), "-t", "180", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"],
                check=True, capture_output=True, timeout=120).stdout
        except subprocess.SubprocessError as error:
            raise NativeAudioError("audio_decode_failed", f"镜头 {position} 音画解码失败。原片保留，可恢复原下载后重试。") from error
        if (first_sample + samples) * 4 > len(pcm):
            raise NativeAudioError("audio_range_insufficient", f"镜头 {position} 的原声不足以覆盖采用范围；请缩短范围或返工，不会截尾补静音。")
        verified_file(identity, root)
        segment_pcm = pcm[first_sample * 4:(first_sample + samples) * 4]
        segment_path = output_dir / f"native-scene-{position}.wav"
        _write_bytes_durably(segment_path, _wav_bytes(segment_pcm))
        chunks.append(segment_pcm)
        sources.append({**identity, "videoStartSeconds": video_start, "audioStartSeconds": audio_start,
            "videoDurationSeconds": duration, "audioStreamIndex": audio["index"],
            "sourceSampleRate": audio.get("sample_rate"), "sourceChannels": audio.get("channels"),
            "decodedSamples": len(pcm) // 4})
        segments.append({**cut, "sourceUri": str(source), "sourceSha256": identity["sha256"],
            "sampleCount": samples, "outputStartSample": cut["startFrame"] * SAMPLES_PER_FRAME,
            "path": str(segment_path), "sha256": file_sha(segment_path),
            "partialSource": source_start > 0 or source_end < duration - 1 / FPS})
    verify_inputs(inputs, root)
    track = output_dir / "native-track.wav"
    _write_bytes_durably(track, _wav_bytes(b"".join(chunks)))
    plan = {"version": VERSION, "audioMode": "native_av", "inputIdentities": identities,
        "fps": FPS, "sampleRate": SAMPLE_RATE, "channels": CHANNELS, "totalFrames": executable["totalFrames"],
        "totalSamples": executable["totalFrames"] * SAMPLES_PER_FRAME, "sources": sources, "segments": segments,
        "trackPath": str(track), "trackSha256": file_sha(track), "preparationRecipe": "native-pcm-v1",
        "subtitles": {"status": "unavailable", "reason": "native_audio_has_no_verified_timing"}}
    plan_path = output_dir / "native_audio_plan.json"
    _write_json_durably(plan_path, plan)
    return plan_path


def validate_native_audio_plan(plan: dict, inputs: dict, root: Path, executable: dict, assets: dict) -> None:
    identities = verify_inputs(inputs, root)
    if plan.get("version") != VERSION or plan.get("audioMode") != "native_av" or plan.get("inputIdentities") != identities:
        raise NativeAudioError("invalid_binding", "原声计划不属于当前采用的稿件与素材。")
    if (plan.get("fps"), plan.get("sampleRate"), plan.get("channels"), plan.get("totalFrames"), plan.get("totalSamples")) != (
            FPS, SAMPLE_RATE, CHANNELS, executable["totalFrames"], executable["totalFrames"] * SAMPLES_PER_FRAME):
        raise NativeAudioError("invalid_binding", "原声计划时间身份不一致。")
    by_position = {asset["scene_position"]: asset for asset in assets["scene_assets"]}
    segments = plan.get("segments")
    if not isinstance(segments, list) or len(segments) != len(executable["cuts"]):
        raise NativeAudioError("invalid_binding", "原声计划缺少镜头。")
    for segment, cut in zip(segments, executable["cuts"]):
        if any(segment.get(key) != value for key, value in cut.items()) or segment.get("sourceUri") != str(Path(by_position[cut["scenePosition"]]["local_path"]).resolve()):
            raise NativeAudioError("invalid_binding", "原声音画剪辑范围不一致。")
        verified_file({"uri": segment.get("sourceUri"), "sha256": segment.get("sourceSha256")}, root)
    track = verified_file({"uri": plan.get("trackPath"), "sha256": plan.get("trackSha256")}, root)
    with wave.open(str(track), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()) != (
                SAMPLE_RATE, CHANNELS, 2, plan["totalSamples"]):
            raise NativeAudioError("invalid_binding", "原声音轨格式或样本数不匹配。")
