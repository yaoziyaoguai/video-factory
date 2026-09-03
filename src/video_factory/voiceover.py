import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .kokoro_voice import synthesize_kokoro_audio


MAX_SCENE_TEMPO = 1.35


class _MiniMaxTerminalError(RuntimeError):
    pass


def synthesize_voiceover_plan(
    script_path: Path,
    output_dir: Path,
    provider: str,
    voice: Optional[str] = None,
    rate: int = 190,
    profile_id: Optional[str] = None,
    pause_scale: float = 1.0,
    mastering_preset: str = "natural",
    operation_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    model_id: Optional[str] = None,
    estimated_cost_cny: Optional[float] = None,
) -> Path:
    require_ffmpeg()
    mastering = mastering_settings(mastering_preset)
    script = json.loads(script_path.read_text(encoding="utf-8"))
    scenes = script.get("scenes", [])
    if not scenes:
        raise RuntimeError("Voice synthesis requires a script with scenes.")

    output_dir.mkdir(parents=True, exist_ok=True)
    minimax_operation = None
    if provider == "minimax" and operation_id:
        minimax_operation = _prepare_minimax_operation(
            script_path=script_path,
            output_dir=output_dir,
            operation_id=operation_id,
            provider_id=provider_id or "minimax-tts-v1",
            model_id=model_id or os.environ.get("MINIMAX_TTS_MODEL_ID") or "speech-2.8-turbo",
            estimated_cost_cny=estimated_cost_cny,
            scenes=scenes,
            voice=voice or "female-chengshu",
            rate=rate,
            pause_scale=pause_scale,
        )
    normalized_tracks = []
    scene_entries = []
    for scene in scenes:
        position = int(scene["position"])
        if minimax_operation is not None:
            raw_path = _synthesize_minimax_operation_item(
                operation=minimax_operation,
                output_dir=output_dir,
                position=position,
                text=str(scene["narration"]),
                voice=voice or "female-chengshu",
                rate=rate,
                pause_scale=pause_scale,
            )
        else:
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
        tempo = scene_tempo(source_speech_duration, available_speech_duration)
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


def _prepare_minimax_operation(
    script_path: Path,
    output_dir: Path,
    operation_id: str,
    provider_id: str,
    model_id: str,
    estimated_cost_cny: Optional[float],
    scenes: list[dict[str, Any]],
    voice: str,
    rate: int,
    pause_scale: float,
) -> dict[str, Any]:
    ledger_path = output_dir.parent / ".voice-operations" / (
        hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
    )
    source_fingerprint = hashlib.sha256(script_path.read_bytes()).hexdigest()
    items = []
    for scene in scenes:
        position = int(scene["position"])
        parameters = {
            "voice": voice,
            "rate": rate,
            "pauseScale": pause_scale,
        }
        input_fingerprint = hashlib.sha256(json.dumps({
            "scenePosition": position,
            "narration": str(scene["narration"]),
            "providerId": provider_id,
            "modelId": model_id,
            "sourceFingerprint": source_fingerprint,
            "parameters": parameters,
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        item_request_id = "paid-item-" + hashlib.sha256(
            f"{operation_id}\0{input_fingerprint}".encode("utf-8")
        ).hexdigest()[:24]
        items.append({
            "itemRequestId": item_request_id,
            "quoteItemId": f"scene-{position}",
            "inputFingerprint": input_fingerprint,
            "sourceFingerprint": source_fingerprint,
            "scenePosition": position,
            "executorProviderId": provider_id,
            "providerId": provider_id,
            "modelId": model_id,
            "parameters": parameters,
            "state": "prepared",
            "stateHistory": ["prepared"],
        })
    ledger = {
        "version": "video-factory/paid-operation-v2",
        "operationId": operation_id,
        "completed": False,
        "providerId": provider_id,
        "modelId": model_id,
        "estimatedCostCny": round(float(estimated_cost_cny or 0), 2),
        "items": items,
    }
    with _minimax_operation_lock(ledger_path):
        if ledger_path.is_file():
            return _read_minimax_operation(ledger_path, ledger)
        ledger["ledgerPath"] = str(ledger_path)
        _write_json_durably(ledger_path, _ledger_without_private_fields(ledger))
        return ledger


def _synthesize_minimax_operation_item(
    operation: dict[str, Any],
    output_dir: Path,
    position: int,
    text: str,
    voice: str,
    rate: int,
    pause_scale: float,
) -> Path:
    ledger_path = Path(operation["ledgerPath"])
    with _minimax_operation_lock(ledger_path):
        persisted = _read_minimax_operation(ledger_path, operation)
        operation.clear()
        operation.update(persisted)
        item = next(item for item in operation["items"] if item["scenePosition"] == position)
        if item["state"] == "materialized":
            raw_path = Path(str(item.get("localPath", ""))).resolve()
            node_directory = ledger_path.parent.parent.resolve()
            if not raw_path.is_relative_to(node_directory) or not raw_path.is_file():
                raise RuntimeError(
                    f"MiniMax paid item '{item['itemRequestId']}' lost its materialized raw audio; refusing a duplicate request."
                )
            content = raw_path.read_bytes()
            if (
                hashlib.sha256(content).hexdigest() != item.get("sha256")
                or len(content) != item.get("sizeBytes")
            ):
                raise RuntimeError(
                    f"MiniMax paid item '{item['itemRequestId']}' raw audio no longer matches its ledger identity; "
                    "refusing a duplicate request."
                )
            return raw_path
        if item["state"] == "unknown":
            raise RuntimeError(
                f"MiniMax paid item '{item['itemRequestId']}' has an unknown provider outcome and requires "
                "manual reconciliation; refusing to submit it again."
            )
        if item["state"] != "prepared":
            raise RuntimeError(
                f"MiniMax paid item '{item['itemRequestId']}' is in state '{item['state']}' and cannot be submitted again."
            )
        raw_path = output_dir / f"scene_{position:02d}_raw.mp3"
        request = _prepare_minimax_audio_request(
            text=text,
            voice=voice,
            rate=rate,
            pause_scale=pause_scale,
            model=str(operation["modelId"]),
        )
        item["state"] = "unknown"
        item["stateHistory"].append("unknown")
        _write_json_durably(ledger_path, _ledger_without_private_fields(operation))
    try:
        result = _execute_minimax_audio_request(
            request=request,
            output_path=raw_path,
        )
    except _MiniMaxTerminalError as error:
        item["state"] = "terminal_failed"
        item["stateHistory"].append("terminal_failed")
        item["error"] = str(error)
        _write_json_durably(ledger_path, _ledger_without_private_fields(operation))
        raise
    except Exception as error:
        item["error"] = str(error)
        _write_json_durably(ledger_path, _ledger_without_private_fields(operation))
        raise
    content = result.read_bytes()
    item.update({
        "state": "materialized",
        "localPath": str(result.resolve()),
        "sha256": hashlib.sha256(content).hexdigest(),
        "sizeBytes": len(content),
    })
    item.pop("error", None)
    item["stateHistory"].append("materialized")
    operation["completed"] = all(candidate["state"] == "materialized" for candidate in operation["items"])
    materialized_count = sum(candidate["state"] == "materialized" for candidate in operation["items"])
    operation["actualCostCny"] = round(
        operation["estimatedCostCny"] * materialized_count / len(operation["items"]),
        2,
    )
    operation["actualCostSource"] = "configured_rate"
    _write_json_durably(ledger_path, _ledger_without_private_fields(operation))
    return result


def _ledger_without_private_fields(ledger: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in ledger.items() if key != "ledgerPath"}


def _minimax_operation_inputs_match(persisted: Any, prepared: dict[str, Any]) -> bool:
    if not isinstance(persisted, dict):
        return False
    if (
        persisted.get("version") != "video-factory/paid-operation-v2"
        or persisted.get("operationId") != prepared["operationId"]
        or persisted.get("providerId") != prepared["providerId"]
        or persisted.get("modelId") != prepared["modelId"]
        or persisted.get("estimatedCostCny") != prepared["estimatedCostCny"]
    ):
        return False
    persisted_items = persisted.get("items")
    prepared_items = prepared["items"]
    if not isinstance(persisted_items, list) or len(persisted_items) != len(prepared_items):
        return False
    return all(
        isinstance(candidate, dict)
        and candidate.get("itemRequestId") == expected["itemRequestId"]
        and candidate.get("inputFingerprint") == expected["inputFingerprint"]
        and candidate.get("scenePosition") == expected["scenePosition"]
        and candidate.get("executorProviderId") == expected["executorProviderId"]
        and candidate.get("providerId") == expected["providerId"]
        and candidate.get("modelId") == expected["modelId"]
        and candidate.get("sourceFingerprint") == expected["sourceFingerprint"]
        for candidate, expected in zip(persisted_items, prepared_items)
    )


def _read_minimax_operation(ledger_path: Path, expected: dict[str, Any]) -> dict[str, Any]:
    persisted = json.loads(ledger_path.read_text(encoding="utf-8"))
    if not _minimax_operation_inputs_match(persisted, expected):
        raise RuntimeError("This MiniMax paid operation no longer matches its persisted scene inputs.")
    persisted["ledgerPath"] = str(ledger_path)
    return persisted


@contextmanager
def _minimax_operation_lock(ledger_path: Path):
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger_path.with_suffix(ledger_path.suffix + ".lock")
    with lock_path.open("a+b") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _write_json_durably(path: Path, value: dict[str, Any]) -> None:
    content = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _write_bytes_durably(path, content)


def _write_bytes_durably(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".partial",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)


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

    if provider == "minimax":
        raw_path = output_dir / f"scene_{position:02d}_raw.mp3"
        return synthesize_minimax_audio(
            text=text,
            output_path=raw_path,
            voice=voice or "female-chengshu",
            rate=rate,
            pause_scale=pause_scale,
        )

    raise RuntimeError(f"Unsupported voice provider: {provider}")


def synthesize_minimax_audio(
    text: str,
    output_path: Path,
    voice: str,
    rate: int,
    pause_scale: float = 1.0,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Path:
    request = _prepare_minimax_audio_request(
        text=text,
        voice=voice,
        rate=rate,
        pause_scale=pause_scale,
        api_key=api_key,
        model=model,
        base_url=base_url,
    )
    return _execute_minimax_audio_request(request=request, output_path=output_path)


def _prepare_minimax_audio_request(
    text: str,
    voice: str,
    rate: int,
    pause_scale: float,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
) -> Request:
    key = api_key or os.environ.get("MINIMAX_API_KEY")
    if not key:
        raise RuntimeError("The minimax voice provider requires MINIMAX_API_KEY.")
    endpoint = (base_url or os.environ.get("MINIMAX_TTS_BASE_URL") or "https://api.minimaxi.com/v1").rstrip("/")
    payload = {
        "model": model or os.environ.get("MINIMAX_TTS_MODEL_ID") or "speech-2.8-turbo",
        "text": minimax_directed_text(text, pause_scale),
        "stream": False,
        "voice_setting": {
            "voice_id": voice,
            "speed": round(min(max(rate / 190, 0.5), 2.0), 2),
            "vol": 1,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
            "channel": 1,
        },
        "language_boost": "Chinese",
        "output_format": "hex",
        "subtitle_enable": False,
    }
    return Request(
        f"{endpoint}/t2a_v2",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )


def _execute_minimax_audio_request(request: Request, output_path: Path) -> Path:
    try:
        with urlopen(request, timeout=90) as response:
            response_bytes = response.read()
    except HTTPError as error:
        if 400 <= error.code < 500 and error.code not in {408, 409, 425, 429, 499}:
            message = error.reason
            try:
                body = json.loads(error.read(65536).decode("utf-8"))
                message = (body.get("base_resp") or {}).get("status_msg") or message
            except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            raise _MiniMaxTerminalError(
                f"MiniMax speech synthesis HTTP {error.code} rejected: {message}"
            ) from error
        raise RuntimeError(
            "MiniMax speech synthesis request failed with an unknown provider outcome; "
            "automatic retry is disabled to prevent duplicate billing."
        ) from error
    except (ConnectionResetError, TimeoutError, URLError, OSError) as error:
        raise RuntimeError(
            "MiniMax speech synthesis request failed with an unknown provider outcome; "
            "automatic retry is disabled to prevent duplicate billing."
        ) from error
    try:
        result = json.loads(response_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("MiniMax speech synthesis returned an ambiguous response.") from error

    if not isinstance(result, dict):
        raise RuntimeError("MiniMax speech synthesis returned an ambiguous response.")
    base_response = result.get("base_resp") or {}
    status_code = base_response.get("status_code")
    audio_hex = (result.get("data") or {}).get("audio")
    if isinstance(status_code, int) and status_code != 0:
        message = str(base_response.get("status_msg") or "no audio returned")
        raise _MiniMaxTerminalError(f"MiniMax speech synthesis failed: {message}")
    if status_code != 0 or not isinstance(audio_hex, str) or not audio_hex:
        raise RuntimeError("MiniMax speech synthesis returned an ambiguous response without audio.")
    try:
        audio = bytes.fromhex(audio_hex)
    except ValueError as error:
        raise RuntimeError("MiniMax speech synthesis returned invalid hex audio.") from error
    _write_bytes_durably(output_path, audio)
    return output_path


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


def scene_tempo(source_duration: float, available_duration: float) -> float:
    """在可懂度上限内压缩旁白，优先兑现分镜时长。"""
    if available_duration <= 0:
        raise ValueError("available_duration must be positive")
    return min(max(source_duration / available_duration, 1.0), MAX_SCENE_TEMPO)


def default_voice(provider: str) -> str:
    if provider == "macos-say":
        return "Tingting"
    if provider == "kokoro":
        return "zf_001"
    if provider == "minimax":
        return "female-chengshu"
    return "test-tone"


def default_profile(provider: str, voice: Optional[str]) -> str:
    if provider == "macos-say":
        return f"macos:{voice or 'Tingting'}"
    if provider == "kokoro":
        return f"kokoro:{voice or 'zf_001'}"
    if provider == "minimax":
        return f"minimax:{voice or 'female-chengshu'}"
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


def minimax_directed_text(text: str, pause_scale: float) -> str:
    """用自然换行提示云端 TTS 停顿，避免发送可能被朗读的私有控制标记。"""
    scale = min(max(float(pause_scale), 0.5), 2.0)
    comma_breaks = max(0, round(scale - 0.5))
    sentence_breaks = max(1, round(scale * 1.5))
    directed = text.strip()
    for punctuation in "，、；：":
        directed = directed.replace(punctuation, punctuation + "\n" * comma_breaks)
    for punctuation in "。！？!?":
        directed = directed.replace(punctuation, punctuation + "\n" * sentence_breaks)
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
