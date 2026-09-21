"""Pixabay 要求跨任务缓存 API 响应 24 小时；只存元数据，不缓存媒体或凭据。

正常启用前提（R4-09）：部署必须为 worker 用户提供可写、可跨任务、跨重启复用的缓存
位置（生产经 XDG_CACHE_HOME 指向持久卷）。运行期降级是异常保护而非长期运行形态：
缓存目录/锁不可用时退化为直接检索并记录诊断，避免宿主文件系统故障把 Pixabay 检索
整体拖垮（DF-03）；部署验收以缓存真实生效为准，不以降级可用为准。
"""

import fcntl
import hashlib
import json
import math
import os
import tempfile
import time
from pathlib import Path
from typing import Callable

from .diagnostics import diagnostic_event


def cached_pixabay_response(url: str, fetch: Callable[[], dict], cache_home: Path) -> dict:
    root = _prepare_cache_root(cache_home)
    if root is None:
        return _validated_payload(fetch())
    # 完整请求含账号和所有查询参数；仅持久化摘要，Key 不出现在路径和内容里。
    digest = hashlib.sha256(url.encode()).hexdigest()
    target = root / f"{digest}.json"
    lock = None
    try:
        try:
            lock = os.fdopen(os.open(root / f"{digest}.lock", os.O_CREAT | os.O_RDWR, 0o600), "a+")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        except OSError as error:
            # 缓存机制自身故障（锁文件不可写等）：跳过缓存直接检索，不让故障改变检索语义。
            diagnostic_event('stock.cache', 'skipped', errorType=type(error).__name__)
            _close_quietly(lock)
            lock = None
        try:
            cached = json.loads(target.read_text(encoding="utf-8"))
            age = time.time() - cached["fetched_at"]
            payload = cached["payload"]
            if math.isfinite(age) and 0 <= age < 86400 and valid_payload(payload):
                return payload
        except OSError as error:
            diagnostic_event('stock.cache', 'read_skipped', errorType=type(error).__name__)
        except (ValueError, KeyError, TypeError):
            pass
        payload = _validated_payload(fetch())
        if lock is not None:
            _store_payload(target, payload, root)
        return payload
    finally:
        _close_quietly(lock)


def _prepare_cache_root(cache_home: Path) -> Path | None:
    root = cache_home / "videofactory" / "stock" / "pixabay"
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError as error:
        diagnostic_event('stock.cache', 'unavailable', errorType=type(error).__name__)
        return None
    return root


def _validated_payload(payload: dict) -> dict:
    if not valid_payload(payload):
        raise RuntimeError("Pixabay search returned an invalid response.")
    return payload


def _close_quietly(lock) -> None:
    if lock is None:
        return
    try:
        lock.close()
    except OSError as error:
        # 清理出口同样不能让缓存故障覆盖已经取得的检索结果。
        diagnostic_event('stock.cache', 'close_skipped', errorType=type(error).__name__)


def _store_payload(target: Path, payload: dict, root: Path) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root, delete=False) as output:
            temporary = Path(output.name)
            json.dump({"fetched_at": time.time(), "payload": payload}, output, ensure_ascii=False)
        os.replace(temporary, target)
    except OSError as error:
        diagnostic_event('stock.cache', 'store_skipped', errorType=type(error).__name__)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError as error:
                diagnostic_event('stock.cache', 'cleanup_skipped', errorType=type(error).__name__)


def valid_payload(payload: object) -> bool:
    return isinstance(payload, dict) and isinstance(payload.get("hits"), list) and "error" not in payload
