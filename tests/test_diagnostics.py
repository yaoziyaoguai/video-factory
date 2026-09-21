import contextlib
import io
import json
import unittest
from unittest.mock import patch

from video_factory.diagnostics import diagnostic_context, diagnostic_span
from video_factory.worker import main


class DiagnosticsTest(unittest.TestCase):
    def test_worker_failure_protocol_and_stderr_exclude_exception_content(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('sys.stdin', io.StringIO('{"commandId":"cmd-private"}')), \
             patch('video_factory.worker.handle_request', side_effect=RuntimeError('Bearer SECRET cookie=PRIVATE https://invalid/?sig=HIDDEN')), \
             contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(main(), 0)
        response = json.loads(stdout.getvalue())
        self.assertEqual(response['status'], 'failed')
        self.assertIn('RuntimeError', response['error']['message'])
        for secret in ('SECRET', 'PRIVATE', 'HIDDEN'):
            self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())

    def test_stages_are_correlated_without_logging_private_content(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), diagnostic_context({'runId': 'run-1', 'commandId': 'cmd-1', 'input': 'private'}):
            with diagnostic_span('stock.search', provider='flickr', query='private') as facts:
                facts['candidateCount'] = 2
        events = [json.loads(line) for line in stderr.getvalue().splitlines()]
        self.assertEqual([e['state'] for e in events], ['started', 'succeeded'])
        self.assertEqual(events[1]['candidateCount'], 2)
        self.assertEqual(events[1]['runId'], 'run-1')
        self.assertGreaterEqual(events[1]['elapsedMs'], 0)
        self.assertNotIn('private', stderr.getvalue())

    def test_failure_keeps_exception_but_does_not_log_its_secret_message(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaisesRegex(RuntimeError, 'secret'):
            with diagnostic_span('stock.download', provider='nasa'):
                raise RuntimeError('https://example.org?token=secret')
        event = json.loads(stderr.getvalue().splitlines()[-1])
        self.assertEqual(event['errorType'], 'RuntimeError')
        self.assertEqual(event['state'], 'failed')
        self.assertNotIn('secret', stderr.getvalue())

    def test_logging_failure_does_not_break_work(self):
        with patch('sys.stderr.write', side_effect=OSError('disk full')):
            with diagnostic_span('stock.search'):
                pass
