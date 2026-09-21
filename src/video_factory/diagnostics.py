"""阶段日志只输出白名单事实到 stderr，不污染 worker 的单行 JSON 协议。"""

import json
import re
import sys
import time
from contextlib import contextmanager
from contextvars import ContextVar


_context = ContextVar('diagnostic_context', default={})
_identifiers = {'runId', 'nodeRunId', 'commandId', 'capability', 'provider', 'mediaType', 'errorType'}
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
        _emit(event, 'failed', facts)
        raise
    else:
        facts['elapsedMs'] = round((time.monotonic() - started) * 1000, 3)
        _emit(event, 'succeeded', facts)
