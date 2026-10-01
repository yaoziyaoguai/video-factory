"""受控崩溃测试 worker：进入正式 relayout 后暂停，直到测试释放。

网络、来源核验、排轨和完成收据仍由生产 worker 执行；这里只在 perform_relayout
接缝阻塞，用来证明父进程消失时 detached worker 的 attempt 归属仍可见。
"""

import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import patch

import video_factory.worker as worker


def main() -> int:
    request = json.loads(sys.stdin.read())
    entered = Path(os.environ["VF_RELAYOUT_HOLD_ENTERED"])
    release = Path(os.environ["VF_RELAYOUT_HOLD_RELEASE"])
    original = worker.perform_relayout

    def hold_then_relayout(*args, **kwargs):
        entered.write_text(json.dumps({"pid": os.getpid(), "commandId": request.get("commandId")}) + "\n",
                           encoding="utf-8")
        deadline = time.monotonic() + 60
        while not release.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("controlled relayout hold was not released")
            time.sleep(0.02)
        return original(*args, **kwargs)

    try:
        with patch("video_factory.worker.perform_relayout", side_effect=hold_then_relayout):
            response = worker.handle_request(request)
    except Exception as error:
        response = {
            "protocolVersion": worker.WORKER_PROTOCOL_VERSION,
            "commandId": request.get("commandId"),
            "status": "failed",
            "error": {"code": "WORKER_REQUEST_FAILED", "message": worker.safe_worker_failure(error)},
            "artifacts": [],
        }
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
