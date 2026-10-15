"""真实 worker CLI；仅替换 MiniMax 请求边界，断网并记录实际发送。"""

import hashlib
import io
import json
import math
import os
import sys
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

source_root, calls_file, events_file, mode = sys.argv[1:]
if mode not in {"ok", "reject-second", "local-interruption"}:
    raise ValueError("Invalid R4 worker fixture mode")
sys.path.insert(0, source_root)
os.environ["MINIMAX_API_KEY"] = "r4-isolated-provider-stub"
os.environ["MINIMAX_TTS_BASE_URL"] = "https://r4-provider.invalid/v1"

from video_factory import group_voiceover as group
from video_factory import voiceover as voice
from video_factory import worker

calls_path = Path(calls_file)
events_path = Path(events_file)
prepare_count = 0
send_count = 0
real_prepare = group._prepare_minimax_audio_request


def record(target, value):
    with target.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"pid": os.getpid(), "mode": mode, **value}, ensure_ascii=False) + "\n")


def prepare(*args, **kwargs):
    global prepare_count
    prepare_count += 1
    interrupted = mode == "local-interruption" and prepare_count == 2
    record(events_path, {"kind": "prepare", "index": prepare_count, "interrupted": interrupted})
    if interrupted:
        raise OSError("R4 fixture: local interruption before second group preparation")
    return real_prepare(*args, **kwargs)


def send(request, audio, metadata_path=None, response_binding=None):
    global send_count
    send_count += 1
    payload = json.loads(request.data)
    rejected = mode == "reject-second" and send_count == 2
    record(calls_path, {"text": payload["text"], "itemRequestId": (response_binding or {}).get("itemRequestId"),
                        "audio": str(audio), "rejected": rejected})
    if rejected:
        raise voice._MiniMaxTerminalError("R4 fixture: explicit provider rejection")
    # 可测音调经过真实媒体处理；账本、响应校验和费用仍由正式 worker 生成。
    samples = array("h", (round(6000 * math.sin(2 * math.pi * 440 * n / 44100)) for n in range(22050)))
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(samples.tobytes())
    content = audio.read_bytes()
    if metadata_path:
        metadata_path.write_text(json.dumps({"request": response_binding,
            "audio_sha256": hashlib.sha256(content).hexdigest(), "audio_size_bytes": len(content),
            "extra_info": {"usage_characters": 10}}), encoding="utf-8")
    return audio


def no_network(*args, **kwargs):
    record(events_path, {"kind": "network-denied"})
    raise RuntimeError("Network is disabled in the R4 worker fixture")


payload = sys.stdin.read()
request = json.loads(payload)
record(events_path, {"kind": "worker-cli", "capability": request.get("capability")})
sys.stdin = io.StringIO(payload)
with patch("video_factory.group_voiceover._prepare_minimax_audio_request", side_effect=prepare), \
     patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
     patch("video_factory.voiceover._execute_minimax_audio_request", side_effect=send), \
     patch("socket.socket.connect", side_effect=no_network), \
     patch("socket.socket.connect_ex", side_effect=no_network):
    raise SystemExit(worker.main())
