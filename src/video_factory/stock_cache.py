"""Pixabay 要求跨任务缓存 API 响应 24 小时；只存元数据，不缓存媒体或凭据。"""

import fcntl
import hashlib
import json
import math
import os
import tempfile
import time
from pathlib import Path
from typing import Callable


def cached_pixabay_response(url: str, fetch: Callable[[], dict], cache_home: Path) -> dict:
    root = cache_home / "videofactory" / "stock" / "pixabay"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 完整请求含账号和所有查询参数；仅持久化摘要，Key 不出现在路径和内容里。
    digest = hashlib.sha256(url.encode()).hexdigest()
    target = root / f"{digest}.json"
    with os.fdopen(os.open(root / f"{digest}.lock", os.O_CREAT | os.O_RDWR, 0o600), "a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            cached = json.loads(target.read_text(encoding="utf-8"))
            age = time.time() - cached["fetched_at"]
            payload = cached["payload"]
            if math.isfinite(age) and 0 <= age < 86400 and valid_payload(payload):
                return payload
        except (OSError, ValueError, KeyError, TypeError):
            pass
        payload = fetch()
        if not valid_payload(payload):
            raise RuntimeError("Pixabay search returned an invalid response.")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root, delete=False) as output:
                temporary = Path(output.name)
                json.dump({"fetched_at": time.time(), "payload": payload}, output, ensure_ascii=False)
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return payload


def valid_payload(payload: object) -> bool:
    return isinstance(payload, dict) and isinstance(payload.get("hits"), list) and "error" not in payload
