import { lookup } from "node:dns/promises";
import { AgentError } from "./errors.js";

// 对外 HTTP 出网（目前是 NewsNow 自托管实例）的私网边界：
// 保存配置时同步拦截 IP 字面量，发起请求前异步核对 DNS 解析结果，
// 防止 Web 进程被配置成探针去访问内网服务或云元数据端点（如 169.254.169.254、100.100.100.200）。
// 本机联调（README 的 127.0.0.1:4444 榜单服务）用 STUDIO_DEV=1 或 NEWSNOW_ALLOW_PRIVATE_NETWORK=1 显式放行。

export function privateNetworkAllowed(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.STUDIO_DEV === "1" || environment.NEWSNOW_ALLOW_PRIVATE_NETWORK === "1";
}

function ipv4ToBytes(host: string): Uint8Array | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index]!;
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    bytes[index] = Number(part);
  }
  return bytes;
}

function ipv6PartToBytes(part: string): Uint8Array | null {
  if (!part) return new Uint8Array(0);
  const bytes: number[] = [];
  for (const piece of part.split(":")) {
    if (piece.includes(".")) {
      const v4 = ipv4ToBytes(piece);
      if (!v4) return null;
      bytes.push(v4[0]!, v4[1]!, v4[2]!, v4[3]!);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      const value = Number.parseInt(piece, 16);
      bytes.push(value >> 8, value & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function ipv6ToBytes(host: string): Uint8Array | null {
  const bare = host.replace(/%.*$/, ""); // 去掉 zone id（fe80::1%eth0）
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = ipv6PartToBytes(halves[0]!);
  const tail = halves.length === 2 ? ipv6PartToBytes(halves[1]!) : null;
  if (!head || (halves.length === 2 && !tail)) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;
  const missing = 16 - head.length - tail!.length;
  if (missing < 0) return null;
  return Uint8Array.from([...head, ...new Array<number>(missing).fill(0), ...tail!]);
}

/** host 是 IP 字面量且属于环回、内网、链路本地、CGNAT/云元数据或未指定地址时为真；非 IP 字面量返回 false，交由 DNS 校验。 */
export function isPrivateIpAddress(host: string): boolean {
  const v4 = ipv4ToBytes(host);
  if (v4) {
    const [a, b] = [v4[0]!, v4[1]!];
    return a === 0                    // 0.0.0.0/8 未指定
      || a === 10                     // 10/8 内网
      || a === 127                    // 环回
      || (a === 100 && b >= 64 && b <= 127) // 100.64/10 CGNAT 与云元数据（100.100.100.200）
      || (a === 169 && b === 254)     // 链路本地与云元数据（169.254.169.254）
      || (a === 172 && b >= 16 && b <= 31) // 172.16/12 内网
      || (a === 192 && b === 168)     // 192.168/16 内网
      || a === 255;                   // 255/8 保留
  }
  const v6 = ipv6ToBytes(host);
  if (!v6) return false;
  if (v6.every(byte => byte === 0)) return true; // :: 未指定
  if (v6[15] === 1 && v6.slice(0, 15).every(byte => byte === 0)) return true; // ::1 环回
  if (v6.slice(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) {
    return isPrivateIpAddress(`${v6[12]}.${v6[13]}.${v6[14]}.${v6[15]}`); // ::ffff:v4 映射
  }
  if ((v6[0]! & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  return v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80; // fe80::/10 链路本地
}

/** 保存 NewsNow 地址时同步校验：host 部分是私网 IP 字面量则拒绝；域名留待请求前的 DNS 核对。 */
export function assertPublicEndpointLiteral(host: string): void {
  if (privateNetworkAllowed()) return;
  if (isPrivateIpAddress(host.replace(/^\[|\]$/g, ""))) {
    throw new AgentError("INVALID_INPUT", "NewsNow 服务地址不能是环回、内网、链路本地或云元数据 IP。");
  }
}

export type HostResolver = (host: string) => Promise<{ address: string }[]>;

const defaultResolveHost: HostResolver = host => lookup(host, { all: true, verbatim: true });

/** 请求前解析目标主机并核对全部记录；任一记录落在私网即拒绝，覆盖多值 DNS 与 rebinding 到内网的常见形态。 */
export async function assertPublicResolvedHost(host: string, resolveHost: HostResolver = defaultResolveHost): Promise<void> {
  if (privateNetworkAllowed()) return;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isPrivateIpAddress(bare)) throw new AgentError("FORBIDDEN", "NewsNow 请求目标解析到内网地址，已拒绝。");
  const records = await resolveHost(bare);
  for (const record of records) {
    if (isPrivateIpAddress(record.address)) {
      throw new AgentError("FORBIDDEN", `NewsNow 地址解析到内网 IP（${record.address}），已拒绝请求。`);
    }
  }
}
