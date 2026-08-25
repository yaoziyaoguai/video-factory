#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${VIDEO_FACTORY_VOICE_RUNTIME:-$ROOT/.local/voice}"
PYTHON="$RUNTIME_ROOT/.venv/bin/python"
SMOKE_DIR="$RUNTIME_ROOT/smoke"
SMOKE_AUDIO="$SMOKE_DIR/kokoro-zf-001.wav"

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe is required" >&2; exit 1; }

mkdir -p "$RUNTIME_ROOT" "$SMOKE_DIR"
if [ ! -x "$PYTHON" ]; then
  uv venv --python 3.11 "$RUNTIME_ROOT/.venv"
fi

uv pip install --python "$PYTHON" \
  'kokoro>=0.8.2,<0.10' \
  'misaki[zh]>=0.8.2,<0.10' \
  'soundfile>=0.12,<1'

rm -f "$RUNTIME_ROOT/kokoro.ready.json"
HF_HOME="$RUNTIME_ROOT/cache/huggingface" "$PYTHON" "$ROOT/src/video_factory/kokoro_voice.py" \
  --text "今天先听声音，再决定它是否适合这条视频。" \
  --voice zf_001 \
  --speed 1 \
  --output "$SMOKE_AUDIO" \
  --runtime-root "$RUNTIME_ROOT"

ffprobe -v error -show_entries stream=codec_type,sample_rate,channels -of json "$SMOKE_AUDIO" >/dev/null
"$PYTHON" - "$RUNTIME_ROOT/kokoro.ready.json" "$SMOKE_AUDIO" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

manifest = {
    "schemaVersion": "video-factory/local-voice-v1",
    "providerId": "kokoro-local-v1",
    "model": "hexgrad/Kokoro-82M-v1.1-zh",
    "smokeVoice": "zf_001",
    "smokeAudio": str(Path(sys.argv[2]).resolve()),
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
}
Path(sys.argv[1]).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

echo "Kokoro local voice ready: $SMOKE_AUDIO"
