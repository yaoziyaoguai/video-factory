import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentError } from "../src/server/agent/errors.js";
import {
  assertPublicEndpointLiteral,
  assertPublicResolvedHost,
  isPrivateIpAddress,
  privateNetworkAllowed,
  type HostResolver,
} from "../src/server/agent/network-policy.js";

// P1 SSRF 边界（NewsNow 自托管实例）的判定单元：
// 保存时同步拦截私网 IP 字面量，请求前异步核对 DNS 全部记录；
// STUDIO_DEV=1 / NEWSNOW_ALLOW_PRIVATE_NETWORK=1 是显式联调逃生门。
// 这里只测判定本身；保存链路（INVALID_INPUT）与客户端链路（FORBIDDEN）在 agent-free-services 里集成覆盖。

test("isPrivateIpAddress：v4/v6 私网段判定与边界值", () => {
  const privateHosts = [
    "0.0.0.0", "0.1.2.3",                    // 0/8 未指定
    "10.0.0.1", "10.255.255.255",             // 10/8
    "100.64.0.1", "100.100.100.200", "100.127.255.255", // 100.64/10 CGNAT 与云元数据
    "127.0.0.1", "127.255.255.254",           // 环回
    "169.254.169.254", "169.254.0.1",         // 链路本地与云元数据
    "172.16.0.1", "172.31.255.255",           // 172.16/12
    "192.168.1.1", "192.168.0.0",             // 192.168/16
    "255.255.255.255",                        // 255/8 保留
    "::", "::1",                              // v6 未指定与环回
    "::ffff:10.0.0.1", "::ffff:127.0.0.1",    // v4 映射
    "::ffff:169.254.169.254",
    "fd00::1", "fd12:3456:789a:bcde:f012:3456:789a:bcde", // fc00::/7 ULA
    "fc00::", "fe80::1", "fe80::1%eth0", "febf:ffff::1",  // 链路本地（含 zone id）
  ];
  for (const host of privateHosts) assert.equal(isPrivateIpAddress(host), true, `应判定为私网：${host}`);

  const publicHosts = [
    "8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", // CGNAT 边界外侧
    "172.15.255.255", "172.32.0.1", "192.169.0.1", "126.255.255.255",
    "::ffff:8.8.8.8", "2001:db8::1", "2606:4700::1111", "fec0::1", "fb00::1",
  ];
  for (const host of publicHosts) assert.equal(isPrivateIpAddress(host), false, `应判定为公网：${host}`);

  // 非 IP 字面量交给 DNS 校验，不在这一层拦截
  for (const host of ["news.example.dev", "localhost", "not-an-ip"]) assert.equal(isPrivateIpAddress(host), false);
});

test("assertPublicEndpointLiteral：保存时拦截私网字面量（含方括号 v6），公网与域名放行", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "100.100.100.200", "[::1]", "[fd00::1]"]) {
    assert.throws(() => assertPublicEndpointLiteral(host), (error: unknown) =>
      error instanceof AgentError && error.code === "INVALID_INPUT", `应拒绝：${host}`);
  }
  for (const host of ["news.example.dev", "8.8.8.8", "[2001:db8::1]"]) assertPublicEndpointLiteral(host);
});

test("assertPublicResolvedHost：字面量直接判定；多值 DNS 任一私网即拒绝", async () => {
  await assert.rejects(assertPublicResolvedHost("192.168.1.10"), (error: unknown) =>
    error instanceof AgentError && error.code === "FORBIDDEN");
  await assert.rejects(assertPublicResolvedHost("[fe80::1]"), (error: unknown) =>
    error instanceof AgentError && error.code === "FORBIDDEN");

  const resolverCalls: string[] = [];
  const resolver: HostResolver = async host => {
    resolverCalls.push(host);
    return [{ address: "93.184.216.34" }];
  };
  await assertPublicResolvedHost("news.example.dev", resolver);
  assert.deepEqual(resolverCalls, ["news.example.dev"], "公网域名按解析结果放行");

  // rebinding / 多值记录：一条公网一条私网也要拒绝
  await assert.rejects(
    assertPublicResolvedHost("news.example.dev", async () => [{ address: "93.184.216.34" }, { address: "10.0.0.8" }]),
    (error: unknown) => error instanceof AgentError && error.code === "FORBIDDEN",
  );
});

test("逃生门：STUDIO_DEV=1 或 NEWSNOW_ALLOW_PRIVATE_NETWORK=1 显式放行，不做解析", async t => {
  assert.equal(privateNetworkAllowed({}), false);
  assert.equal(privateNetworkAllowed({ STUDIO_DEV: "1" }), true);
  assert.equal(privateNetworkAllowed({ NEWSNOW_ALLOW_PRIVATE_NETWORK: "1" }), true);
  assert.equal(privateNetworkAllowed({ NEWSNOW_ALLOW_PRIVATE_NETWORK: "0" }), false);

  const previous = process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK;
  process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK;
    else process.env.NEWSNOW_ALLOW_PRIVATE_NETWORK = previous;
  });
  const failIfResolved: HostResolver = async () => {
    throw new Error("放行时不应再解析");
  };
  await assertPublicResolvedHost("169.254.169.254", failIfResolved);
  assertPublicEndpointLiteral("127.0.0.1");
});
