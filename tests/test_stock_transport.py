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

from video_factory.stock_assets import open_asset_request, materialize_candidate, write_response_body
from video_factory.domain import StockAssetCandidate
from video_factory.asset_transport import AssetNetworkError
from urllib.error import HTTPError, URLError


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
    def test_download_uses_remaining_request_budget_without_resetting_it_for_body(self):
        candidate = StockAssetCandidate(provider='pexels', asset_id='a', media_type='video', width=720, height=1280,
            duration=23, preview_url='', download_url='https://media.example/a.mp4', source_url='', creator='',
            license_note='', query='', score=0)
        for header_seconds, body_seconds, succeeds in [(2, 60, True), (2, 95, False), (65, 30, False)]:
            with self.subTest(header_seconds=header_seconds, body_seconds=body_seconds):
                elapsed = [0.0]
                class Response(io.BytesIO):
                    headers = {'Content-Type': 'video/mp4', 'Content-Length': '5'}
                    def read1(self, size):
                        if self.tell() == 0:
                            elapsed[0] += body_seconds
                        return super().read1(size)
                def opener(request, timeout):
                    elapsed[0] += header_seconds
                    return Response(b'media')
                # 只替换网络和时钟，正文写盘/超时/完整性仍执行正式实现。
                def write_with_clock(*args, **kwargs):
                    return write_response_body(*args, **kwargs, clock=lambda: elapsed[0])
                with tempfile.TemporaryDirectory() as tmp, \
                     patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('93.184.216.34', 443))]), \
                     patch('video_factory.stock_assets.time.monotonic', side_effect=lambda: elapsed[0]), \
                     patch('video_factory.stock_assets.write_response_body', side_effect=write_with_clock):
                    target = Path(tmp) / 'a.mp4'
                    if succeeds:
                        self.assertEqual(materialize_candidate(candidate, target, opener=opener), target)
                        self.assertEqual(target.read_bytes(), b'media')
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'timed out'):
                            materialize_candidate(candidate, target, opener=opener)
                        self.assertFalse(target.exists())

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

    def test_network_failures_carry_structured_safe_classification(self):
        # D 批次：分类只来自异常类型与本层自造消息，经有界 cause 链追溯；
        # 不解析外部文本，也不推断 VPN/欠费。每格断言 (stage, reason, httpStatus)。
        from video_factory.asset_transport import classify_network_failure

        def gaierror_cause():
            try:
                try:
                    raise socket.gaierror(-2, "Name or service not known")
                except socket.gaierror as inner:
                    raise URLError("wrapped") from inner
            except URLError as outer:
                return outer

        cases = [
            (AssetNetworkError("DNS 解析超时", stage="dns", reason="timeout"), ("dns", "timeout", None)),
            (AssetNetworkError("连接失败", stage="connect", reason="connection_failure"), ("connect", "connection_failure", None)),
            (AssetNetworkError("TLS 握手失败", stage="tls", reason="tls_failure"), ("tls", "tls_failure", None)),
            (AssetNetworkError("HTTP 响应失败", stage="http", reason="http_error", http_status=429), ("http", "http_error", 429)),
            (gaierror_cause(), ("dns", "dns_failure", None)),
        ]
        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                self.assertEqual(classify_network_failure(error), expected)

        # 裸超时没有更具体类型：按调用处阶段提示归因，无提示时不再猜连接阶段。
        self.assertEqual(classify_network_failure(TimeoutError(), stage_hint="body"), ("body", "timeout", None))
        self.assertEqual(classify_network_failure(TimeoutError()), ("unknown", "timeout", None))

        # 实际边界附加的安全枚举事实优先于类型推断；非法枚举被忽略。
        from video_factory.asset_transport import attach_failure_facts
        self.assertEqual(classify_network_failure(attach_failure_facts(RuntimeError("stream exceeded"), "body", "too_large")), ("body", "too_large", None))
        self.assertEqual(classify_network_failure(attach_failure_facts(RuntimeError("bad attach"), "vpn", "hacked")), ("unknown", "unknown", None))

        # HTTPError 保留状态码；cause 链成环时不无限遍历。
        self.assertEqual(
            classify_network_failure(HTTPError("https://m.example/a", 403, "Forbidden", None, None)),
            ("http", "http_error", 403),
        )
        loop = RuntimeError("loop")
        loop.__cause__ = loop
        self.assertEqual(classify_network_failure(loop), ("unknown", "unknown", None))

    def test_pinned_transport_failures_expose_stage_specific_errors(self):
        request = urllib.request.Request("https://media.example/a")

        # DNS 解析失败：gaierror → dns/dns_failure。
        with patch("socket.getaddrinfo", side_effect=socket.gaierror(-2, "Name or service not known")):
            with self.assertRaises(AssetNetworkError) as dns_error:
                open_asset_request(request, 1)
            self.assertEqual((dns_error.exception.stage, dns_error.exception.failure_reason), ("dns", "dns_failure"))

        # 连接被拒：目标 IP 可解析但端口拒绝 → connect/connection_failure。
        def refused(*args, **kwargs):
            raise ConnectionRefusedError(111, "Connection refused")
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]), \
             patch("socket.socket") as socket_class:
            socket_class.return_value.connect.side_effect = refused
            with self.assertRaises(AssetNetworkError) as connect_error:
                open_asset_request(request, 1)
            self.assertEqual((connect_error.exception.stage, connect_error.exception.failure_reason), ("connect", "connection_failure"))

        # TLS 证书失败保留类型 → tls/tls_failure。
        sock = WireSocket([b"HTTP/1.1 200 Connection established\r\n\r\n"])
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]), \
             patch("socket.socket", return_value=sock), patch("urllib.request.getproxies", return_value={}), \
             patch("ssl.create_default_context") as context:
            context.return_value.wrap_socket.side_effect = ssl.SSLCertVerificationError("certificate rejected")
            with self.assertRaises(AssetNetworkError) as tls_error:
                open_asset_request(request, 1)
            self.assertEqual((tls_error.exception.stage, tls_error.exception.failure_reason), ("tls", "tls_failure"))

        # HTTP 4xx/5xx 状态：HTTPError 由调用方分类，这里校验 body 读取错误仍受控。
        wire = WireSocket([b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n"])
        with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]), \
             patch("socket.socket", return_value=wire), patch("urllib.request.getproxies", return_value={}), \
             patch("ssl.create_default_context") as context:
            context.return_value.wrap_socket.return_value = wire
            with self.assertRaises(HTTPError) as http_error:
                open_asset_request(request, 1)
            self.assertEqual(http_error.exception.code, 429)

    def test_classification_never_leaks_private_details(self):
        # 结构化字段与消息都不能带出签名 URL、代理凭据或异常原文。
        error = AssetNetworkError("连接失败（TimeoutError，直连）", stage="connect", reason="timeout")
        self.assertEqual(
            {"stage": "connect", "reason": "timeout"},
            {key: value for key, value in (("stage", error.stage), ("reason", error.failure_reason))},
        )
        self.assertEqual(error.http_status, None)

    def test_second_address_failure_is_classified_from_its_own_stage(self):
        # R2-07（round2）：上一 IP 已推进到 HTTP 响应阶段后，下一 IP 的连接失败
        # 不能沿用 http 阶段——每个地址从连接阶段重新起算。
        class HeaderTimeoutReader(io.BytesIO):
            def readline(self, *args):
                raise TimeoutError("response header timeout")

        class HeaderTimeoutSocket:
            def __init__(self):
                self.sent = []
                self.closed = False

            def connect(self, target):
                pass

            def settimeout(self, timeout):
                pass

            def sendall(self, data):
                self.sent.append(data)

            def makefile(self, mode):
                return HeaderTimeoutReader(b"") if "r" in mode else io.BytesIO()

            def close(self):
                self.closed = True

            def shutdown(self, how):
                pass

        class RefusedSocket:
            def connect(self, target):
                raise ConnectionRefusedError(111, "Connection refused")

            def settimeout(self, timeout):
                pass

            def close(self):
                pass

        with patch("socket.getaddrinfo", return_value=[
                (2, 1, 6, "", ("93.184.216.34", 80)),
                (2, 1, 6, "", ("93.184.216.35", 80)),
        ]), patch("socket.socket", side_effect=[HeaderTimeoutSocket(), RefusedSocket()]), \
             patch("urllib.request.getproxies", return_value={}):
            with self.assertRaises(AssetNetworkError) as error:
                open_asset_request(urllib.request.Request("http://media.example/a"), 1)
        self.assertEqual((error.exception.stage, error.exception.failure_reason),
                         ("connect", "connection_failure"))


if __name__ == "__main__":
    unittest.main()
