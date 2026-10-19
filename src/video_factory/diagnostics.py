"""阶段日志只输出白名单事实到 stderr，不污染 worker 的单行 JSON 协议。"""

import json
import re
import sys
import time
from contextlib import contextmanager
from contextvars import ContextVar

from .asset_transport import classify_network_failure


_context = ContextVar('diagnostic_context', default={})
_identifiers = {'runId', 'nodeRunId', 'commandId', 'capability', 'provider', 'mediaType', 'errorType',
                'errorStage', 'errorReason'}
_numbers = {'attempt', 'candidateCount', 'bytes', 'elapsedMs', 'httpStatus'}


def _safe_facts(values):
    return {key: value for key, value in values.items()
            if (key in _identifiers and isinstance(value, str)
                and re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value) and not value.startswith('sk-'))
            or (key in _numbers and isinstance(value, (int, float)) and not isinstance(value, bool)
                and 0 <= value < 1e15)}


@contextmanager
def diagnostic_context(request):
    token = _context.set(_safe_facts(request))
    try:
        yield
    finally:
        _context.reset(token)


def _emit(event, state, facts):
    try:
        sys.stderr.write(json.dumps({'component': 'media-worker', 'event': event, 'state': state,
            'timestampMs': int(time.time() * 1000), **_context.get(), **_safe_facts(facts)}) + '\n')
        sys.stderr.flush()
    except (OSError, ValueError):
        # 日志管道失效不能改变素材操作或收费语义。
        pass


@contextmanager
def diagnostic_span(event, **facts):
    started = time.monotonic()
    _emit(event, 'started', facts)
    try:
        yield facts
    except Exception as error:
        facts.update(errorType=type(error).__name__, elapsedMs=round((time.monotonic() - started) * 1000, 3))
        if isinstance(getattr(error, 'code', None), int):
            facts['httpStatus'] = error.code
        # 网络失败的安全枚举分类（D 批次）：类型/cause 链提取，非 unknown 才记录。
        stage, reason, http_status = classify_network_failure(error)
        if stage != 'unknown' or reason != 'unknown':
            facts['errorStage'] = stage
            facts['errorReason'] = reason
            if http_status is not None and 'httpStatus' not in facts:
                facts['httpStatus'] = http_status
        _emit(event, 'failed', facts)
        raise
    else:
        facts['elapsedMs'] = round((time.monotonic() - started) * 1000, 3)
        _emit(event, 'succeeded', facts)


def diagnostic_event(event, state, **facts):
    """跨度之外的 单条白名单事实（如“缓存已跳过”），与阶段日志走同一脱敏通道。"""
    _emit(event, state, facts)
