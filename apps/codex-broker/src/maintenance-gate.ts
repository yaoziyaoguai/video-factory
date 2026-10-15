import type { IncomingHttpHeaders } from "node:http";
import {
  MAINTENANCE_ADMISSION_HEADER,
  MaintenanceCoordinator,
} from "@video-factory/production-pipeline/maintenance";

export {
  MAINTENANCE_ADMISSION_HEADER,
  MAINTENANCE_ADMISSION_PROTOCOL,
  MaintenanceCoordinator,
  MaintenancePausedError,
  maintenanceRequestHeaders,
  runWithMaintenanceAdmission,
} from "@video-factory/production-pipeline/maintenance";

export type BrokerAdmission = Awaited<ReturnType<MaintenanceCoordinator["admit"]>>;

export interface BrokerMaintenanceStatus {
  protocol: string;
  serviceId: string;
  updatedAt: string;
  gate: { state: string; owner: string; updatedAt: string; generation: number } | null;
  gateView: { state: string; owner: string; updatedAt: string; generation: number } | null;
  inflightCount: number;
  holderCount: number;
  integrity: { complete: boolean; issueCount: number };
  quiescent: boolean;
  detail: Record<string, unknown>;
}

/** socket 的归属声明只作为查找键；共享目录内真实登记才是准入依据。 */
export function requestAdmissionId(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[MAINTENANCE_ADMISSION_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error("Invalid maintenance admission header.");
  }
  return value;
}

/** 健康响应只给出计数；内部 holder 身份不能从 HTTP 观察面流出。 */
export function publicMaintenanceReport(
  report: Awaited<ReturnType<MaintenanceCoordinator["report"]>>,
): Omit<BrokerMaintenanceStatus, "detail"> {
  const gate = report.gateView ? { ...report.gateView } : null;
  return {
    protocol: report.protocol,
    serviceId: report.serviceId,
    updatedAt: report.updatedAt,
    gate,
    gateView: gate,
    inflightCount: report.inflight.length,
    holderCount: report.holders.length,
    integrity: { ...report.integrity },
    quiescent: report.quiescent,
  };
}
