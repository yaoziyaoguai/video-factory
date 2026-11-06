import { useEffect, useRef, useState } from "react";
import { agentApi, feedbackInput } from "./api.js";
import { loadStageFeedbackDrafts, saveStageFeedbackDrafts } from "./workspace-state.js";
import type { FeedbackInput, Target } from "../../shared/agent/generated/contracts.js";

// 工作台唯一的意见草稿所有者；查看入口只提供准确对象，不各自处理提交回执。
export function useFeedbackDrafts(conversationId: string | null, onSaved: (id: string) => Promise<void>, onError: (text: string) => void) {
  const [commands, setCommands] = useState<Record<string, FeedbackInput>>({});
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const active = useRef(conversationId);
  active.current = conversationId;
  // 键不含片段维度：换段或取消针对时意见文字保留（B2“保留输入文字”）；
  // 命令的目标与提交目标不一致时在 edit/submit 重建，不提交陈旧的 segment 引用。
  const keyFor = (target: Target, id = conversationId) => `${id}:${target.workId ?? "independent"}:${target.artifactId}:${target.revisionId}`;
  const sameTarget = (a: Target, b: Target) => a.artifactId === b.artifactId && a.revisionId === b.revisionId
    && (a.workId ?? null) === (b.workId ?? null)
    && a.segment?.runId === b.segment?.runId && a.segment?.segmentId === b.segment?.segmentId;
  useEffect(() => {
    if (!conversationId) return;
    const restored: Record<string, FeedbackInput> = {};
    try {
      // 兼容已经实际写入的两种旧意见存储；统一成按准确目标保存的命令。
      for (const entry of Object.values(loadStageFeedbackDrafts(conversationId))) {
        const key = keyFor(entry.command.target);
        localStorage.setItem(`vf:agent-feedback:${key}`, JSON.stringify(entry.command));
      }
      saveStageFeedbackDrafts(conversationId, {});
      const prefix = `vf:agent-feedback:${conversationId}:`;
      for (const storageKey of Object.keys(localStorage).filter(key => key.startsWith(prefix))) {
        const command = JSON.parse(localStorage.getItem(storageKey)!) as FeedbackInput;
        if (typeof command.commandId !== "string" || typeof command.text !== "string"
          || typeof command.target?.artifactId !== "string" || typeof command.target.revisionId !== "string") continue;
        const key = keyFor(command.target);
        restored[key] = command;
        localStorage.setItem(`vf:agent-feedback:${key}`, JSON.stringify(command));
        if (storageKey !== `vf:agent-feedback:${key}`) localStorage.removeItem(storageKey);
      }
    } catch { /* 存储不可用时仍可在本页讨论，业务记录不受影响。 */ }
    setCommands(current => ({ ...current, ...restored }));
  }, [conversationId]);

  return {
    forTarget(target: Target | null) {
      const key = target ? keyFor(target) : "";
      return { text: commands[key]?.text ?? "", saved: receipts[key] ?? "", busy: busy[key] ?? false };
    },
    edit(target: Target, text: string) {
      const key = keyFor(target);
      const stored = commands[key];
      const command = stored?.text === text && sameTarget(stored.target, target) ? stored : feedbackInput(target, text);
      setCommands(current => ({ ...current, [key]: command }));
      setReceipts(current => ({ ...current, [key]: "" }));
      try { localStorage.setItem(`vf:agent-feedback:${key}`, JSON.stringify(command)); }
      catch { /* 本页草稿仍保留。 */ }
    },
    // 同一事项、同一片段的意见在方案草稿前进时（E1）：旧键里未发送的文字带到新方案键，
    // 新键已有文字不覆盖；不跨事项、不迁移整稿意见。
    carryForward(from: Target, to: Target) {
      const fromKey = keyFor(from), toKey = keyFor(to);
      if (fromKey === toKey || from.workId !== to.workId
        || from.segment?.runId !== to.segment?.runId || from.segment?.segmentId !== to.segment?.segmentId) return;
      const source = commands[fromKey];
      if (!source?.text.trim() || commands[toKey]) return;
      const command = feedbackInput(to, source.text);
      setCommands(current => current[toKey] ? current : ({ ...current, [toKey]: command }));
      try { localStorage.setItem(`vf:agent-feedback:${toKey}`, JSON.stringify(command)); }
      catch { /* 本页草稿仍保留。 */ }
    },
    async submit(target: Target) {
      const id = conversationId, key = keyFor(target), stored = commands[key];
      if (!id || !stored?.text.trim() || busy[key]) return;
      // 目标一致时沿用原命令（含 commandId，重试保持幂等）；针对变化则按当前目标重建。
      const command = sameTarget(stored.target, target) ? stored : feedbackInput(target, stored.text);
      setBusy(current => ({ ...current, [key]: true }));
      try {
        const receipt = await agentApi.addFeedback(id, command);
        // 回执按存储中的命令清理；提交期间新输入的文字是另一条命令，不能被清掉。
        setCommands(current => {
          if (current[key]?.commandId !== stored.commandId) return current;
          const next = { ...current }; delete next[key];
          return next;
        });
        const persisted = localStorage.getItem(`vf:agent-feedback:${key}`);
        if (persisted === JSON.stringify(stored)) localStorage.removeItem(`vf:agent-feedback:${key}`);
        setReceipts(current => ({ ...current, [key]: receipt.disposition === "next_version"
          ? "已留作下一版意见，本次制作不变。" : "意见已记录。" }));
        await onSaved(id);
      } catch (error) {
        if (active.current === id) onError(error instanceof Error ? error.message : "保存结果未确认，保留意见后可重试。");
      } finally { setBusy(current => ({ ...current, [key]: false })); }
    },
  };
}

export type FeedbackDrafts = ReturnType<typeof useFeedbackDrafts>;
