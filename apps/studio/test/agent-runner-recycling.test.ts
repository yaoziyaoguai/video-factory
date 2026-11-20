import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ConversationRunnerRegistry, type ExecutorOptions } from "../src/server/agent/executor.js";
import { EventHub } from "../src/server/agent/event-log.js";
import { openAgentDatabase } from "../src/server/agent/db.js";
import type { PiRuntimeHost } from "../src/server/agent/pi-runtime.js";

const staticClock = () => "2026-11-20T00:00:00.000Z";

function registryOptions(db: ReturnType<typeof openAgentDatabase>): ExecutorOptions {
  return {
    db,
    clock: staticClock,
    hub: new EventHub(),
    // 本测试不执行回合，宿主仅满足类型缝隙；会话一旦被意外打开立即失败。
    host: {
      applySessionModel: async () => {},
      openConversationSession: async () => { throw new Error("unexpected session open"); },
    } as unknown as PiRuntimeHost,
    toolFactory: () => [],
  };
}

// 审计第二阶段：ConversationRunnerRegistry 曾对所有历史会话永久保留 Pi AgentSession
// 内存句柄。闲置超过阈值的 Runner 必须被回收；忙碌（本轮执行中）的 Runner 永不回收，
// 且活跃时间以观察到忙碌为基准刷新，长任务结束后不会立刻被判闲置。
test("sweepIdle：闲置超时的 Runner 被回收重建，忙碌中的 Runner 被保留", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-runner-recycle-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let now = 10_000;
  const options = registryOptions(openAgentDatabase(directory));
  const registry = new ConversationRunnerRegistry(options, { idleMs: 600_000, sweepIntervalMs: 2_147_000_000, nowMs: () => now });
  t.after(() => registry.close());

  const idle = registry.for("conv-idle");
  const busy = registry.for("conv-busy");
  busy.current = { requestId: "req-1" } as never; // 直接置忙：领取循环与 current 均视为执行中。
  now += 601_000;
  assert.equal(registry.sweepIdle(), 1, "只有闲置 Runner 被回收");
  assert.notEqual(registry.for("conv-idle"), idle, "回收后再访问得到新实例");
  assert.equal(registry.for("conv-busy"), busy, "忙碌 Runner 保持原实例");
  busy.current = null;
  now += 599_000;
  assert.equal(registry.sweepIdle(), 0, "观察到忙碌后活跃时间已刷新，未到阈值不回收");
  registry.kick("conv-busy");
  now += 2_000;
  assert.equal(registry.sweepIdle(), 1, "同刻创建的闲置 Runner 过阈值回收，刚 kick 的不回收");
  assert.equal(registry.for("conv-busy"), busy, "刚活跃的 Runner 仍是原实例");
  await registry.close();
});

test("sweepIdle：kick 刷新活跃时间，回收后的旧实例进入关闭态不再接受新回合", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "frame-runner-kick-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let now = 0;
  const options = registryOptions(openAgentDatabase(directory));
  const registry = new ConversationRunnerRegistry(options, { idleMs: 600_000, sweepIntervalMs: 2_147_000_000, nowMs: () => now });
  t.after(() => registry.close());

  const runner = registry.for("conv-kick");
  now += 500_000;
  registry.kick("conv-kick"); // 空库上领取循环立即退出，但活跃时间以 kick 为准刷新。
  await new Promise(resolve => setImmediate(resolve)); // 等领取循环退出，避免误判忙碌。
  now += 500_000;
  assert.equal(registry.sweepIdle(), 0, "kick 后未满阈值不回收");
  assert.equal(registry.for("conv-kick"), runner);
  now += 101_000;
  assert.equal(registry.sweepIdle(), 1);
  assert.equal(runner.busy, false);
  // 已回收实例进入关闭态：closing 使 kick() 不再启动领取循环（不抛错、不复活）。
  runner.kick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.busy, false);
  await registry.close();
});
