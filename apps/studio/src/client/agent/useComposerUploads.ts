import { useEffect, useRef, useState } from "react";
import type { Conversation, UploadReceipt } from "../../shared/agent/generated/contracts.js";
import { agentApi, AgentApiError } from "./api.js";

export interface PendingUpload {
  id: string;
  owner: string;
  file: File;
  phase: "selected" | "queued" | "uploading" | "failed";
  progress: number | null;
  error?: string;
  expectedRevision?: number | undefined;
  controller: AbortController;
}

// 本地 File 只在工作台内存里，只有服务端探测并返回的准确修订才进入可恢复草稿。
export function useComposerUploads() {
  const jobs = useRef(new Map<string, PendingUpload>());
  const [entries, setEntries] = useState<PendingUpload[]>([]);
  const publish = () => setEntries([...jobs.current.values()]);
  const update = (id: string, patch: Partial<PendingUpload>) => {
    const job = jobs.current.get(id);
    if (job) { jobs.current.set(id, { ...job, ...patch }); publish(); }
  };
  useEffect(() => {
    const tasks = jobs.current;
    return () => { for (const job of tasks.values()) job.controller.abort(); tasks.clear(); };
  }, []);
  const remove = (id: string) => {
    jobs.current.get(id)?.controller.abort();
    jobs.current.delete(id);
    publish();
  };
  const stage = (owner: string, files: File[]) => {
    for (const file of files) {
      const id = agentApi.newCommandId();
      jobs.current.set(id, { id, owner, file, phase: "selected", progress: null, controller: new AbortController() });
    }
    publish();
  };
  const upload = async (owner: string, getConversation: () => Promise<Conversation>, onReceipt: (receipt: UploadReceipt) => void) => {
    const selection = [...jobs.current.values()].filter(job => job.owner === owner);
    if (!selection.length || selection.some(job => job.phase === "queued" || job.phase === "uploading")) return;
    for (const job of selection) update(job.id, { phase: "queued", progress: null });
    let conversation: Conversation;
    try {
      conversation = await getConversation();
    } catch (error) {
      for (const job of selection) update(job.id, { phase: "failed", error: (error as Error).message });
      return;
    }
    if (owner === "new") {
      for (const job of jobs.current.values()) if (job.owner === owner) update(job.id, { owner: conversation.id });
    }
    for (const job of selection) {
      if (job.controller.signal.aborted) continue;
      // 连接中断后回执可能已提交。重送相同命令须保留原版本；只有明确的过期拒绝才重新绑定。
      const expectedRevision = job.expectedRevision ?? conversation.revision;
      update(job.id, { phase: "uploading", expectedRevision });
      try {
        const receipt = await agentApi.uploadFile(conversation.id, {
          commandId: job.id, expectedRevision, rights: "owned_or_licensed", file: job.file,
        }, job.controller.signal, progress => update(job.id, { progress }));
        if (receipt.conversation.revision > conversation.revision) conversation = receipt.conversation;
        if (job.controller.signal.aborted) continue;
        onReceipt(receipt);
        jobs.current.delete(job.id);
        publish();
      } catch (error) {
        if (!job.controller.signal.aborted) update(job.id, { phase: "failed", error: (error as Error).message,
          ...(error instanceof AgentApiError && error.payload.code === "STALE_REVISION" ? { expectedRevision: undefined } : {}) });
      }
    }
  };
  return { entries, stage, remove, upload };
}
