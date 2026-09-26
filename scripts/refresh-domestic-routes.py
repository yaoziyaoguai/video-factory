#!/usr/bin/env python3
"""补齐 APNIC 国别表遗漏的国内服务地址；只添加明确域名的公网 /32 直连路由。"""

import argparse
import ipaddress
import json
import subprocess
from pathlib import Path


def direct_route() -> list[str]:
    routes = json.loads(subprocess.check_output(
        ["ip", "-j", "-4", "route", "show", "table", "main", "default"], text=True,
    ))
    # 不读取 VPN 的两个 /1，也不修改 default、SSH 源地址保护或海外路由。
    candidates = [route for route in routes if route.get("gateway")
                  and route.get("prefsrc") and not route.get("dev", "").startswith(("tun", "wg", "tap"))]
    if len(candidates) != 1:
        raise ValueError("Expected one physical default route; refusing to guess")
    route = candidates[0]
    return ["via", str(ipaddress.IPv4Address(route["gateway"])), "dev", route["dev"],
            "src", str(ipaddress.IPv4Address(route["prefsrc"])), "metric", "49"]


def public_addresses(host: str) -> list[str]:
    if not host or any(char not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for char in host):
        raise ValueError("Expected a hostname, not a URL or command")
    output = subprocess.check_output(["getent", "ahostsv4", host], text=True, timeout=5)
    addresses = sorted({line.split()[0] for line in output.splitlines() if line.strip()})
    if not addresses or len(addresses) > 32:
        raise ValueError("Empty or unexpectedly large DNS response")
    if any(not ipaddress.IPv4Address(address).is_global for address in addresses):
        raise ValueError("Refusing non-public domestic service address")
    return addresses


def refresh(hosts: list[str], *, apply: bool = False) -> int:
    route = direct_route()
    failures = 0
    for host in hosts:
        try:
            addresses = public_addresses(host)
            for address in addresses:
                command = ["ip", "-4", "route", "replace", f"{address}/32", *route]
                if apply:
                    subprocess.run(command, check=True, capture_output=True, timeout=5)
            print(json.dumps({"host": host, "addresses": addresses, "applied": apply}))
        except (ValueError, subprocess.SubprocessError) as error:
            # 一家 DNS 暂时失败不影响其余来源；保留旧 /32，避免切断在途下载。
            failures += 1
            print(json.dumps({"host": host, "error": type(error).__name__, "retainedExisting": True}))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hosts", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="默认只读检查；显式授权安装时才应用")
    args = parser.parse_args()
    hosts = list(dict.fromkeys(line.split("#", 1)[0].strip().lower()
                              for line in args.hosts.read_text().splitlines()))
    return refresh([host for host in hosts if host], apply=args.apply)


if __name__ == "__main__":
    raise SystemExit(main())
