import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, XCircle } from "lucide-react";
import type { StudioRunStatus } from "../../shared/api.js";

const STATUS_LABELS: Record<StudioRunStatus, string> = {
  pending: "排队中",
  running: "制作中",
  succeeded: "已完成",
  failed: "失败",
  needs_human: "等你审片",
  rejected: "已打回",
};

export function StatusBadge({ status }: { status: StudioRunStatus }) {
  const Icon = status === "running"
    ? LoaderCircle
    : status === "succeeded"
      ? CircleCheck
      : status === "needs_human"
        ? CircleAlert
        : status === "failed" || status === "rejected"
          ? XCircle
          : CircleDashed;
  return (
    <span className={`status-badge status-${status}`}>
      <Icon aria-hidden="true" size={14} strokeWidth={2} />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function statusLabel(status: StudioRunStatus): string {
  return STATUS_LABELS[status];
}
