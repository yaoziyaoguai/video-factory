import io
import socket
import ssl
import threading
import time
import tempfile
import unittest
import urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from video_factory.stock_assets import open_asset_request, materialize_candidate
from video_factory.domain import StockAssetCandidate
from video_factory.asset_transport import AssetNetworkError


class WireSocket:
    def __init__(self, replies):
        self.replies = list(replies)
        self.sent = []
        self.connected = []
        self.closed = False

    def connect(self, target):
        self.connected.append(target)

    def settimeout(self, timeout):
        pass

    def do_handshake(self):
        pass

    def sendall(self, data):
        self.sent.append(data)

    def makefile(self, mode):
        return io.BytesIO(self.replies.pop(0))

    def close(self):
        self.closed = True

    def shutdown(self, how):
        pass


class StockTransportTest(unittest.TestCase):
    def test_slow_proxy_body_respects_total_deadline_and_removes_partial_file(self):
        class Proxy(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def do_CONNECT(self):
                self.send_response(200)
                self.end_headers()
                self.close_connection = False
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp4')
                self.send_header('Content-Length', '100')
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b'x')
                        self.wfile.flush()
                        time.sleep(.02)
                except OSError:
                    pass
                finally:
                    self.close_connection = True
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_resolve = socket.getaddrinfo
        def resolve(host, port, *args, **kwargs):
            if host == 'media.example':
                return [(2, 1, 6, '', ('93.184.216.34', port))]
            return original_resolve(host, port, *args, **kwargs)
        candidate = StockAssetCandidate(provider='nasa', asset_id='a', media_type='video', width=0, height=0,
            duration=0, preview_url='', download_url='http://media.example/a.mp4', source_url='', creator='',
            license_note='', query='', score=0)
        try:
            with tempfile.TemporaryDirectory() as tmp, patch('socket.getaddrinfo', side_effect=resolve), \
                 patch('urllib.request.getproxies', return_value={'http': f'http://127.0.0.1:{server.server_port}'}), \
                 patch('urllib.request.proxy_bypass', return_value=False), \
                 patch('video_factory.stock_assets.MAX_ASSET_REQUEST_SECONDS', .15):
                target = Path(tmp) / 'a.mp4'
                started = time.monotonic()
                with self.assertRaises(RuntimeError):
                    materialize_candidate(candidate, target)
                self.assertLess(time.monotonic() - started, .7)
                self.assertFalse(target.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_truncated_download_is_not_accepted_or_left_on_disk(self):
        candidate = StockAssetCandidate(provider='nasa', asset_id='a', media_type='video', width=0, height=0,
            duration=0, preview_url='', download_url='https://media.example/a.mp4', source_url='', creator='',
            license_note='', query='', score=0)
        def opener(request, timeout):
            result = io.BytesIO(b'partial')
            result.headers = {'Content-Type': 'video/mp4', 'Content-Length': '100'}
            return result
        with tempfile.TemporaryDirectory() as tmp, \
             patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]):
            target = Path(tmp) / 'a.mp4'
            with self.assertRaisesRegex(RuntimeError, 'incomplete'):
                materialize_candidate(candidate, target, opener=opener)
            self.assertFalse(target.exists())

    def test_https_redirect_refuses_downgrade(self):
        sock = WireSocket([b'HTTP/1.1 302 Found\r\nLocation: http://media.example/a\r\nContent-Length: 0\r\n\r\n'])
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), \
             patch('socket.socket', return_value=sock), patch('urllib.request.getproxies', return_value={}), \
             patch('ssl.create_default_context') as context:
            context.return_value.wrap_socket.return_value = sock
            with self.assertRaisesRegex(RuntimeError, 'downgrade'):
                open_asset_request(urllib.request.Request('https://media.example/a'), 1)
        self.assertTrue(sock.closed)

    def test_no_proxy_connects_only_to_validated_ip(self):
        sock = WireSocket([b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'])
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 80))]), \
             patch('socket.socket', return_value=sock), \
             patch('urllib.request.getproxies', return_value={'http': 'http://proxy.example:80'}), \
             patch('urllib.request.proxy_bypass', return_value=True):
            with open_asset_request(urllib.request.Request('http://media.example/a'), 1) as response:
                self.assertEqual(response.read(), b'ok')
        self.assertEqual(sock.connected, [('93.184.216.34', 80)])
        self.assertNotIn(b'CONNECT', b''.join(sock.sent))
        self.assertTrue(sock.closed)

    def test_https_keeps_origin_sni_and_never_ignores_certificate_failure(self):
        sock = WireSocket([b'HTTP/1.1 200 Connection established\r\n\r\n'])
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), \
             patch('socket.socket', return_value=sock), \
             patch('urllib.request.getproxies', return_value={'https': 'http://user:secret@proxy.example:8080'}), \
             patch('urllib.request.proxy_bypass', return_value=False), \
             patch('ssl.create_default_context') as context:
            context.return_value.wrap_socket.side_effect = ssl.SSLCertVerificationError('certificate rejected')
            with self.assertRaises(AssetNetworkError) as error:
                open_asset_request(urllib.request.Request('https://media.example/a?token=private'), 1)
            self.assertEqual(context.return_value.wrap_socket.call_args.kwargs['server_hostname'], 'media.example')
            self.assertIn('SSLCertVerificationError', str(error.exception))
            self.assertNotIn('secret', str(error.exception))
            self.assertNotIn('private', str(error.exception))
        self.assertTrue(sock.closed)

    def test_redirect_cannot_reach_private_ip_even_with_proxy(self):
        sock = WireSocket([b'HTTP/1.1 200 Connection established\r\n\r\n',
                           b'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n'])
        def resolve(host, port, **kwargs):
            return [(2, 1, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '93.184.216.34', port))]
        with patch('socket.getaddrinfo', side_effect=resolve), patch('socket.socket', return_value=sock), \
             patch('urllib.request.getproxies', return_value={'http': 'http://proxy.example:80'}), \
             patch('urllib.request.proxy_bypass', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'private or unsafe'):
                open_asset_request(urllib.request.Request('http://media.example/a'), 1)
        self.assertEqual(len(sock.connected), 1)

    def test_dns_wait_is_bounded_without_starting_a_late_download(self):
        def slow_dns(*args, **kwargs):
            time.sleep(.2)
            return [(2, 1, 6, '', ('93.184.216.34', 80))]
        with patch('socket.getaddrinfo', side_effect=slow_dns), patch('socket.socket') as connect:
            started = time.monotonic()
            with self.assertRaisesRegex(AssetNetworkError, 'DNS'):
                open_asset_request(urllib.request.Request('http://media.example/a'), .03)
            self.assertLess(time.monotonic() - started, .15)
            time.sleep(.22)
            connect.assert_not_called()

    def test_configured_proxy_tunnels_to_public_ip_and_preserves_origin_host(self):
        calls = []

        class Proxy(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_CONNECT(self):
                calls.append((self.command, self.path, dict(self.headers)))
                self.send_response(200)
                self.end_headers()
                self.close_connection = False

            def do_GET(self):
                calls.append((self.command, self.path, dict(self.headers)))
                self.send_response(200)
                self.send_header("Content-Length", "5")
                self.end_headers()
                self.wfile.write(b"media")

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        original_resolve = socket.getaddrinfo

        def resolve(host, port, *args, **kwargs):
            if host == "media.example":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]
            return original_resolve(host, port, *args, **kwargs)

        try:
            with patch("urllib.request.getproxies", return_value={"http": f"http://user:password@127.0.0.1:{server.server_port}"}), \
                 patch("urllib.request.proxy_bypass", return_value=False), \
                 patch("socket.getaddrinfo", side_effect=resolve):
                with open_asset_request(urllib.request.Request("http://media.example/clip"), timeout=1) as response:
                    self.assertEqual(response.read(), b"media")
            self.assertEqual(calls[0][1], "93.184.216.34:80")
            self.assertIn("Proxy-Authorization", calls[0][2])
            self.assertEqual(calls[1][2]["Host"], "media.example")
            self.assertNotIn("Proxy-Authorization", calls[1][2])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
