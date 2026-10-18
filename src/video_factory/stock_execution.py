"""免费素材操作的有界执行与进度；不参与付费请求或素材采用判断。"""
import json
import math
import time
from pathlib import Path
from threading import Lock
from typing import Optional


class StockPreparationStopped(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.plan_path: Optional[Path] = None


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

    def progress(self, scene: int, total: int, state: str, provider: str = "", candidates: int = 0):
        # 进度只是观察数据；写入失败不得改变下载和计费结果。只写受控字段，不写URL或异常原文。
        if self.progress_path is None:
            return
        with self._lock:
            previous = self.scenes.get(scene, {})
            self.scenes[scene] = {"scenePosition": scene, "state": state, "provider": provider,
                                  "candidateCount": candidates,
                                  "failedAttempts": previous.get("failedAttempts", 0) + (1 if state == "retrying" else 0)}
            value = {"version": "stock-progress-v1", "operationId": self.operation_id, "phase": self.phase,
                     "totalScenes": total, "updatedAt": time.time(), "scenes": list(self.scenes.values())}
            try:
                self.progress_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.progress_path.with_suffix(".tmp")
                temporary.write_text(json.dumps(value), encoding="utf-8")
                temporary.replace(self.progress_path)
            except OSError:
                pass
