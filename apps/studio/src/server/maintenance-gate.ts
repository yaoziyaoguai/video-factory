import { MaintenanceCoordinator } from "@video-factory/production-pipeline/maintenance";

// Studio 与本机部署、broker 共用锁和持久登记；业务层仅保留原入口名称。
export {
  MAINTENANCE_ADMISSION_PROTOCOL,
  MaintenancePausedError as StudioMaintenanceError,
  type MaintenanceAdmission as Admission,
  type MaintenanceAdmissionReport,
  type MaintenanceGateSnapshot,
  type AdmissionEntry,
} from "@video-factory/production-pipeline/maintenance";

export class MaintenanceGate extends MaintenanceCoordinator {
  currentGate() { return this.readGate(); }
}
