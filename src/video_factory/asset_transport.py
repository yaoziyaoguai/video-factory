"""素材联网：可信代理只负责传输，目标 IP、TLS 和跳转仍由应用校验。"""

import base64
import http.client
import ipaddress
import queue
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError


CONNECT_TIMEOUT = 10
REDIRECT_LIMIT = 5
UNSAFE_IPV6_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "64:ff9b::/96", "64:ff9b:1::/48", "fec0::/10",
))


class AssetNetworkError(URLError):
    """仅携带阶段与错误类别，不泄漏带签名的 URL 或代理密码。"""


def remaining(deadline: float) -> float:
    value = deadline - time.monotonic()
    if value <= 0:
        raise AssetNetworkError("素材下载总时限已耗尽")
    return value


def resolve_addresses(host: str, port: int, deadline: float):
    # getaddrinfo 不接受 timeout；守护线程只做解析，不执行后续下载或文件写入。
    results = queue.Queue(maxsize=1)

    def resolve():
        try:
            results.put(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM))
        except OSError as error:
            results.put(error)

    threading.Thread(target=resolve, daemon=True).start()
    try:
        result = results.get(timeout=min(CONNECT_TIMEOUT, remaining(deadline)))
    except queue.Empty as error:
        raise AssetNetworkError("DNS 解析超时") from error
    if isinstance(result, OSError):
        raise AssetNetworkError("DNS 解析失败") from result
    return result


def is_public_ip_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if isinstance(address, ipaddress.IPv6Address) and any(address in network for network in UNSAFE_IPV6_NETWORKS):
        return False
    return address.is_global


def resolve_asset_download_target(value: str, timeout: float = CONNECT_TIMEOUT):
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as error:
        raise RuntimeError("Asset download URL is invalid.") from error
    if parsed.scheme.lower() not in {"http", "https"}:
        raise RuntimeError("Asset download URL must use HTTP or HTTPS.")
    if parsed.username or parsed.password or not parsed.hostname:
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    resolved = resolve_addresses(host, port, time.monotonic() + timeout)
    addresses = {str(entry[4][0]).split("%", 1)[0] for entry in resolved if entry[4]}
    if not addresses or any(not is_public_ip_address(address) for address in addresses):
        raise RuntimeError("Asset download URL points to a private or unsafe network destination.")
    return parsed.geturl(), tuple(sorted(addresses))


def validate_asset_download_url(value: str, timeout: float = CONNECT_TIMEOUT) -> str:
    return resolve_asset_download_target(value, timeout)[0]


def _connect_ip(address: str, port: int, timeout: float):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect((address, port))
        return sock
    except OSError:
        sock.close()
        raise


def open_pinned_asset_response(value: str, addresses: tuple[str, ...], headers: dict, timeout: float):
    deadline = time.monotonic() + timeout
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    proxies = urllib.request.getproxies()
    proxy_value = None if urllib.request.proxy_bypass(host) else proxies.get(parsed.scheme, proxies.get("all"))
    proxy = None
    proxy_addresses = []
    proxy_headers = {}
    if proxy_value:
        try:
            proxy = urllib.parse.urlsplit(proxy_value if "://" in proxy_value else "http://" + proxy_value)
            if proxy.scheme != "http" or not proxy.hostname or proxy.path not in {"", "/"} or proxy.query or proxy.fragment:
                raise ValueError()
            proxy_port = proxy.port or 80
        except ValueError as error:
            raise AssetNetworkError("素材下载代理配置不受支持：需要 HTTP CONNECT 代理；不会静默绕过代理") from error
        proxy_addresses = resolve_addresses(proxy.hostname, proxy_port, deadline)
        if proxy.username is not None:
            credentials = urllib.parse.unquote(proxy.username) + ":" + urllib.parse.unquote(proxy.password or "")
            proxy_headers["Proxy-Authorization"] = "Basic " + base64.b64encode(credentials.encode()).decode()
    last_error = None
    stage = "连接"
    for address in addresses:
        connection = http.client.HTTPConnection(host, port)
        watchdog = None
        response = None
        try:
            phase_timeout = min(CONNECT_TIMEOUT, remaining(deadline))
            if proxy:
                stage = "代理连接"
                connection.set_tunnel(address, port, headers=proxy_headers)
                for entry in proxy_addresses:
                    try:
                        connection.sock = _connect_ip(entry[4][0], proxy_port, min(phase_timeout, remaining(deadline)))
                        break
                    except OSError as error:
                        last_error = error
                if connection.sock is None:
                    raise last_error or OSError("proxy unavailable")
            else:
                stage = "直连"
                connection.sock = _connect_ip(address, port, phase_timeout)

            socket_holder = [connection.sock]

            def abort_connection(holder=socket_holder):
                if holder[0] is not None:
                    try:
                        holder[0].shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            # 头部慢速响应与连续小块传输也必须受同一个总时限约束。
            watchdog = threading.Timer(remaining(deadline), abort_connection)
            watchdog.daemon = True
            watchdog.start()
            if proxy:
                stage = "代理隧道"
                connection._tunnel()
            if parsed.scheme == "https":
                stage = "TLS 握手"
                raw_socket = connection.sock
                try:
                    connection.sock = ssl.create_default_context().wrap_socket(
                        raw_socket, server_hostname=host, do_handshake_on_connect=False,
                    )
                    socket_holder[0] = connection.sock
                    connection.sock.settimeout(min(CONNECT_TIMEOUT, remaining(deadline)))
                    connection.sock.do_handshake()
                except Exception:
                    raw_socket.close()
                    raise
            stage = "HTTP 响应"
            connection.sock.settimeout(remaining(deadline))
            origin_headers = {key: item for key, item in headers.items() if key.lower() not in {
                "host", "authorization", "cookie", "proxy-authorization",
            }}
            origin_headers["Host"] = parsed.netloc
            connection.request("GET", path, headers=origin_headers)
            response = connection.getresponse()
            remaining(deadline)
            return PinnedAssetResponse(connection, response, watchdog, deadline)
        except (OSError, http.client.HTTPException) as error:
            last_error = error
            if watchdog:
                watchdog.cancel()
            if response is not None:
                response.close()
            connection.close()
            if isinstance(error, ssl.SSLCertVerificationError):
                break
    category = "超时" if isinstance(last_error, TimeoutError) else type(last_error).__name__
    raise AssetNetworkError(f"{stage}失败（{category}，{'通过代理' if proxy else '直连'}）") from last_error


def open_asset_request(request: urllib.request.Request, timeout: float):
    deadline = time.monotonic() + timeout
    current_url = request.full_url
    headers = dict(request.header_items())
    for redirect_count in range(REDIRECT_LIMIT + 1):
        validated_url, addresses = resolve_asset_download_target(current_url, remaining(deadline))
        response = open_pinned_asset_response(validated_url, addresses, headers, remaining(deadline))
        if response.status not in {301, 302, 303, 307, 308}:
            if response.status >= 400:
                status, reason, response_headers = response.status, response.reason, response.headers
                response.close()
                raise HTTPError(validated_url, status, reason, response_headers, None)
            return response
        location = response.headers.get("Location")
        response.close()
        if not location or redirect_count == REDIRECT_LIMIT:
            raise RuntimeError("Asset redirect is missing a location or exceeded the redirect limit.")
        next_url = urllib.parse.urljoin(validated_url, location)
        if urllib.parse.urlsplit(validated_url).scheme == "https" and urllib.parse.urlsplit(next_url).scheme != "https":
            raise RuntimeError("Asset download refuses an HTTPS downgrade.")
        current_url = next_url
    raise AssertionError("Asset redirect loop exited unexpectedly")


class PinnedAssetResponse:
    def __init__(self, connection, response, watchdog, deadline):
        self._connection, self._response = connection, response
        self._watchdog, self._deadline = watchdog, deadline
        self.status, self.reason, self.headers = response.status, response.reason, response.headers

    def read(self, *args):
        remaining(self._deadline)
        result = self._response.read(*args)
        remaining(self._deadline)
        return result

    def read1(self, *args):
        remaining(self._deadline)
        result = self._response.read1(*args)
        remaining(self._deadline)
        return result

    def close(self):
        self._watchdog.cancel()
        try:
            self._response.close()
        finally:
            self._connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
