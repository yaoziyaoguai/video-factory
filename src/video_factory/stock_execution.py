"""免费素材操作的有界执行与进度；不参与付费请求或素材采用判断。"""
import json
import math
import re
import time
from pathlib import Path
from threading import Lock
from typing import Optional


class StockPreparationStopped(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.plan_path: Optional[Path] = None


# 失败摘要只允许这些枚举与整数状态码；URL、headers、异常原文一律不落盘。
STOCK_STAGE_VALUES = {"dns", "connect", "tls", "http", "body", "media", "operation", "unknown"}
STOCK_REASON_VALUES = {
    "timeout", "dns_failure", "connection_failure", "tls_failure", "http_error",
    "incomplete", "too_large", "invalid_media", "unknown",
}


def sanitize_last_failure(value) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    provider = value.get("provider")
    stage = value.get("stage")
    reason = value.get("reason")
    if not isinstance(provider, str) or not re.fullmatch(r"[a-z_-]{1,40}", provider):
        return None
    safe = {
        "provider": provider,
        "stage": stage if stage in STOCK_STAGE_VALUES else "unknown",
        "reason": reason if reason in STOCK_REASON_VALUES else "unknown",
    }
    status = value.get("httpStatus")
    if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599:
        safe["httpStatus"] = status
    return safe


class StockExecution:
    def __init__(self, request: dict):
        expires = request.get("executionDeadlineUnixMs")
        self.deadline = None
        if isinstance(expires, (int, float)) and not isinstance(expires, bool) and math.isfinite(expires):
            self.deadline = time.monotonic() + max(0, (expires / 1000) - time.time() - 2)
        self.pause_path = Path(request["pauseRequestPath"]) if request.get("pauseRequestPath") else None
        self.progress_path = Path(request["stockProgressPath"]) if request.get("stockProgressPath") else None
        self.operation_id = request.get("operationId", request.get("commandId"))
        self.phase = "search" if request.get("capability") == "asset.search" else "download"
        self.scenes: dict[int, dict] = {}
        self._lock = Lock()

    def check(self):
        if self.pause_path is not None and self.pause_path.is_file():
            raise StockPreparationStopped("STOCK_PREPARATION_PAUSED", "已按你的要求停止获取免费素材。")
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise StockPreparationStopped("STOCK_PREPARATION_DEADLINE", "本次免费素材获取已到时间上限。")

    def progress(self, scene: int, total: int, state: str, provider: Optional[str] = None,
                 candidates: Optional[int] = None, last_failure: Optional[dict] = None):
        """记录一镜进度。None 表示未提供新值（沿用旧值），显式 0/"" 才覆盖。

        进度只是观察数据；写入失败不得改变下载和计费结果。只写受控字段，
        不写URL或异常原文。stopped/failed 默认保留 provider、候选数与最后失败；
        completed 清除失败摘要；provider 变化视为新尝试，旧失败不再当作本次原因。
        """
        if self.progress_path is None:
            return
        with self._lock:
            previous = self.scenes.get(scene, {})
            entry = {"scenePosition": scene, "state": state,
                     "provider": previous.get("provider", "") if provider is None else provider,
                     "candidateCount": previous.get("candidateCount", 0) if candidates is None else max(0, int(candidates)),
                     "failedAttempts": previous.get("failedAttempts", 0) + (1 if state == "retrying" else 0)}
            previous_failure = previous.get("lastFailure")
            if state == "completed":
                pass  # 成功后清除 active failure，不被旧错误污染。
            elif last_failure is not None:
                sanitized = sanitize_last_failure(last_failure)
                if sanitized is not None:
                    entry["lastFailure"] = sanitized
            elif provider is not None and provider != previous.get("provider"):
                pass  # 换图库即新尝试：不把旧图库的失败原因显示为本次原因。
            elif previous_failure is not None:
                entry["lastFailure"] = previous_failure
            self.scenes[scene] = entry
            value = {"version": "stock-progress-v1", "operationId": self.operation_id, "phase": self.phase,
                     "totalScenes": total, "updatedAt": time.time(), "scenes": list(self.scenes.values())}
            try:
                self.progress_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.progress_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(value), encoding="utf-8")
                temporary.replace(self.progress_path)
            except OSError:
                pass
