#!/bin/sh
set -eu
asr_home="$1"
source_dir="$(cd "$(dirname "$0")" && pwd)"
python3 -m venv "$asr_home"
"$asr_home/bin/python" -m pip install --disable-pip-version-check --no-cache-dir 'faster-whisper==1.2.1'
install -m 644 "$source_dir/frame-transcribe.py" "$asr_home/transcribe.py"
"$asr_home/bin/python" -I - "$asr_home/model" <<'PY'
import hashlib
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory
import urllib.request

model = Path(sys.argv[1])
model.mkdir(exist_ok=True)
default_model = "Systran/faster-whisper-base"
model_id = os.environ.get("FRAME_ASR_MODEL_ID", default_model)
revision = os.environ.get("FRAME_ASR_MODEL_REVISION")
expected = os.environ.get("FRAME_ASR_MODEL_SHA256")
offline = os.environ.get("FRAME_ASR_MODEL_DIR")
if model_id == default_model and revision is None:
    revision = "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
    if expected is None:
        expected = "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"
if not offline and (not revision or not expected):
    raise ValueError("从镜像站下载自定义模型时需要 FRAME_ASR_MODEL_REVISION 和 FRAME_ASR_MODEL_SHA256")
endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
files = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
with TemporaryDirectory(dir=model.parent, prefix=".asr-model-") as staging:
    stage = Path(staging)
    for name in files:
        target = stage / name
        if offline:
            shutil.copyfile(Path(offline) / name, target)
        else:
            url = f"{endpoint}/{model_id}/resolve/{revision}/{name}?download=true"
            # hf-mirror 等镜像站会对 python-urllib 默认 UA 返回 403，必须带自定义 UA。
            request = urllib.request.Request(url, headers={"User-Agent": "frame-base-build"})
            with urllib.request.urlopen(request, timeout=90) as response, target.open("wb") as dest:
                shutil.copyfileobj(response, dest)
    with (stage / "model.bin").open("rb") as weights:
        hasher = hashlib.sha256()
        for block in iter(lambda: weights.read(1024 * 1024), b""):
            hasher.update(block)
        if expected and hasher.hexdigest() != expected:
            raise ValueError("本地语音模型摘要不符")
    for name in files:
        (stage / name).replace(model / name)
PY
