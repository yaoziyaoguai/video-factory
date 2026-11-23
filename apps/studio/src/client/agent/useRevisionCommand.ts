import { useEffect, useRef, useState } from "react";
import { agentApi, AgentApiError } from "./api.js";

// 仅结果未知的同一修改复用原命令。收到回执以后再保存应使用当时的版本。
export function useRevisionCommand<R>() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState<R | null>(null);
  const inFlight = useRef(false), command = useRef<{ body: string; id: string; expectedRevision: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const submit = async <T extends { expectedRevision: number }>(input: T, send: (input: T & { commandId: string }) => Promise<R>) => {
    if (inFlight.current) return;
    const { expectedRevision, ...changes } = input;
    const body = JSON.stringify(changes);
    if (command.current?.body !== body) command.current = { body, id: agentApi.newCommandId(), expectedRevision };
    inFlight.current = true; setBusy(true); setError(""); setReceipt(null);
    try {
      const result = await send({ ...input, commandId: command.current.id, expectedRevision: command.current.expectedRevision });
      command.current = null;
      if (mounted.current) { setReceipt(result); return result; }
    } catch (failure) {
      if (failure instanceof AgentApiError && failure.payload.code === "STALE_REVISION") command.current = null;
      if (mounted.current) setError((failure as Error).message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, error, receipt, submit, clearReceipt: () => { setReceipt(null); setError(""); } };
}
