import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { StudioMaintenanceError, type MaintenanceGate } from "./maintenance-gate.js";

export interface StudioLifecycleOptions {
  app: FastifyInstance;
  maintenanceGate: Pick<MaintenanceGate, "withAdmission" | "currentInflight">;
  recoverInterruptedRuns: () => Promise<unknown>;
  activeWork: () => Promise<unknown>;
  recoveryIntervalMs?: number;
}

export function installStudioLifecycle(options: StudioLifecycleOptions): void {
  const { app, maintenanceGate } = options;
  const recoveryWork = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const recoveryTimer = setInterval(() => {
    if (stopping) return;
    // 保留完整准入/恢复/持久释放链，停机时不能只等业务函数返回。
    const pending = maintenanceGate.withAdmission("recovery-cycle", () => {
      // 准入可能等待文件锁；信号到达后，尚未开始的恢复不能重新启动写入。
      if (stopping) return;
      return options.recoverInterruptedRuns();
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!(error instanceof StudioMaintenanceError)) {
          app.log.error("Interrupted production recovery failed; the next recovery cycle will retry.");
        }
      })
      .finally(() => recoveryWork.delete(pending));
    recoveryWork.add(pending);
  }, options.recoveryIntervalMs ?? 30_000);
  recoveryTimer.unref();

  const stopRecovery = (): void => {
    stopping = true;
    clearInterval(recoveryTimer);
  };
  app.addHook("preClose", async () => { stopRecovery(); });
  app.addHook("onClose", async () => {
    // Promise 与 unref 定时器本身不会维持进程；必须等落盘释放结束后才允许自然退出。
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await Promise.all([...recoveryWork]);
      await options.activeWork();
      // HTTP 已关闭：等待断连 handler 的后继、动态 hold 和 holders.json 的原子释放。
      // 释放失败会保留登记，停机继续等待，不能把失败伪装成成功排空。
      while (maintenanceGate.currentInflight().length > 0) await delay(25);
    } finally {
      clearInterval(keepAlive);
      process.off("SIGTERM", handleSignal);
      process.off("SIGINT", handleSignal);
    }
  });

  const handleSignal = (): void => {
    if (closing) return;
    stopRecovery();
    app.log.info("Studio shutdown requested; draining accepted work.");
    closing = app.close();
    void closing.then(() => {
      app.log.info("Studio shutdown complete.");
    }).catch(() => {
      process.exitCode = 1;
      app.log.error("Studio shutdown failed.");
    });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}
