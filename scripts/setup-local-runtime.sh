#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${VIDEO_FACTORY_PYTHON_RUNTIME:-$ROOT/.local/python}"
PYTHON="$RUNTIME_ROOT/.venv/bin/python"

command -v uv >/dev/null 2>&1 || { echo "uv is required" >&2; exit 1; }

mkdir -p "$RUNTIME_ROOT"
if [ ! -x "$PYTHON" ]; then
  uv venv --python 3.11 "$RUNTIME_ROOT/.venv"
fi

uv pip install --python "$PYTHON" --editable "$ROOT"
PYTHONPATH="$ROOT/src" "$PYTHON" - "$RUNTIME_ROOT/python.ready.json" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from video_factory.worker import handle_request

assert Image.__version__
assert callable(handle_request)
manifest = {
    "schemaVersion": "video-factory/local-python-v1",
    "python": sys.executable,
    "pillow": Image.__version__,
    "verifiedAt": datetime.now(timezone.utc).isoformat(),
}
Path(sys.argv[1]).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

echo "VideoFactory Python runtime ready: $PYTHON"
