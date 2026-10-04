import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDiscussionPanel } from "../src/client/components/CreativeDiscussionPanel.js";
import type { StudioCreativeReviewSnapshot } from "../src/shared/api.js";

const shaV1 = "a".repeat(64);
const shaV2 = "b".repeat(64);

function scriptReview(overrides: Partial<StudioCreativeReviewSnapshot> = {}): StudioCreativeReviewSnapshot {
  return {
    runId: "run-two-tabs",
    runRevision: 8,
    stage: "script",
    reviewRevision: 3,
    draftSha256: shaV1,
    draftArtifactId: "script-draft-9",
    draftVersionId: "script-draft-9#v1",
    phase: "waiting_user",
    allowedActions: ["discuss", "revise", "edit_draft", "confirm"],
    returnTargets: [],
    draft: {
      narrativeArc: "问题到答案",
      scenes: [{ id: "scene-1", position: 1, duration: 8, narration: "第一版旁白。", visual_prompt: "结果对照" }],
    },
    messages: [],
    proposals: [],
    effectiveUserInstructions: [],
    blockingIssues: [],
    ...overrides,
  };
}

function scriptReviewV2(overrides: Partial<StudioCreativeReviewSnapshot> = {}): StudioCreativeReviewSnapshot {
  return scriptReview({
    reviewRevision: 4,
    draftSha256: shaV2,
    draftVersionId: "script-draft-9#v2",
    draft: {
      narrativeArc: "问题到答案",
      scenes: [{ id: "scene-1", position: 1, duration: 8, narration: "B标签保存的新旁白。", visual_prompt: "结果对照" }],
    },
    ...overrides,
  });
}

// 双标签模拟：同一浏览器的两个标签共享 localStorage，但各自持有独立 sessionStorage。
// 交换 window.sessionStorage 即可模拟“另一个标签”的存储视图。
function tabStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

function installTabStorage(tab: ReturnType<typeof tabStorage>) {
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: tab });
}

let sharedLocalStorage: ReturnType<typeof tabStorage>;

beforeEach(() => {
  sharedLocalStorage = tabStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, value: sharedLocalStorage });
  installTabStorage(tabStorage());
});

// 编辑器在“有未保存修改”时默认展开；冷启动时收起，需要先点开摘要。
async function editorField(label = "分镜 1 · 旁白") {
  if (!screen.queryByLabelText(label)) await userEvent.click(screen.getByText("手动修订这份稿件"));
  return screen.getByLabelText(label);
}

describe("creative draft two-tab recovery", () => {
  it("recovers tab A's unsaved edit and message after tab B saves a new version", async () => {
    const tabA = tabStorage();
    installTabStorage(tabA);
    const onCommand = vi.fn(async () => undefined);
    const viewA = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const fieldA = await editorField();
    await userEvent.clear(fieldA);
    await userEvent.type(fieldA, "A-未保存旁白");
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "A的意见文字" } });
    viewA.unmount();

    // 标签 B：独立会话存储、同一共享 localStorage；保存形成服务端 V2。
    const tabB = tabStorage();
    installTabStorage(tabB);
    const viewB = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const fieldB = await editorField();
    await userEvent.clear(fieldB);
    await userEvent.type(fieldB, "B保存的旁白");
    await userEvent.click(screen.getByRole("button", { name: "保存修订" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "edit_draft" })));
    viewB.rerender(<CreativeDiscussionPanel review={scriptReviewV2()} busy={false} onCommand={onCommand} />);
    viewB.unmount();

    // 标签 A 重新打开时服务端已是 V2：A 的两段文字都要能找回，且不能冒充当前稿保存。
    installTabStorage(tabA);
    render(<CreativeDiscussionPanel review={scriptReviewV2()} busy={false} onCommand={onCommand} />);
    const recovered = await editorField();
    expect(recovered).toHaveValue("A-未保存旁白");
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("A的意见文字");
    expect(screen.getByRole("button", { name: "采用本版（未审计）" })).toBeDisabled();
  });

  it("keeps tab A's words when tab B abandons its own local edit", async () => {
    const tabA = tabStorage();
    installTabStorage(tabA);
    const onCommand = vi.fn(async () => undefined);
    const viewA = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const fieldA = await editorField();
    await userEvent.clear(fieldA);
    await userEvent.type(fieldA, "A不想丢的字");
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "A未发送的意见" } });
    viewA.unmount();

    const tabB = tabStorage();
    installTabStorage(tabB);
    const viewB = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const fieldB = await editorField();
    await userEvent.type(fieldB, "B临时打的字");
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    viewB.unmount();

    installTabStorage(tabA);
    render(<CreativeDiscussionPanel review={scriptReviewV2()} busy={false} onCommand={onCommand} />);
    const recovered = await editorField();
    expect(recovered).toHaveValue("A不想丢的字");
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("A未发送的意见");
  });

  it("keeps the unsent message for explicit reuse when the server version changes in place", async () => {
    const onCommand = vi.fn(async () => undefined);
    const { rerender } = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "针对旧版的意见" } });
    rerender(<CreativeDiscussionPanel review={scriptReviewV2()} busy={false} onCommand={onCommand} />);
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("针对旧版的意见");
    expect(screen.getByRole("button", { name: "只讨论" })).toBeEnabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("still treats a returned same-content draft as a different version for stale edits", async () => {
    const onCommand = vi.fn(async () => undefined);
    const { rerender } = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const field = await editorField();
    await userEvent.clear(field);
    await userEvent.type(field, "基于v1的编辑");
    rerender(<CreativeDiscussionPanel review={scriptReviewV2()} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    // A→B→A：内容与 v1 完全一致、只是 versionId 不同，仍不能当作当前可保存的编辑基础。
    rerender(<CreativeDiscussionPanel review={scriptReview({ reviewRevision: 5, draftVersionId: "script-draft-9#v3" })} busy={false} onCommand={onCommand} />);
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存修订" })).toBeDisabled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("keeps typing in memory and warns when the per-tab draft storage is unavailable", async () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: {
        getItem: () => { throw new Error("session unavailable"); },
        setItem: () => { throw new Error("session unavailable"); },
        removeItem: () => { throw new Error("session unavailable"); },
      },
    });
    const onCommand = vi.fn(async () => undefined);
    render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    const field = await editorField();
    await userEvent.clear(field);
    await userEvent.type(field, "内存里的字");
    expect(field).toHaveValue("内存里的字");
    expect(screen.getByText(/手工修订无法在本机保存/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "意见也在内存里" } });
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue("意见也在内存里");
    expect(screen.getByText(/本机草稿无法保存/)).toBeInTheDocument();
  });
});

// C3（收尾包 2026-10-04）：legacy 共享旧 key 只读导入。
// 导入/放弃/保存都不删共享旧 key；本标签已处理标记防复活但不影响他标签；
// 无 versionId 的旧稿保持 legacy 身份，同内容不升级为当前 base。

describe("legacy shared-key read-only import (C3)", () => {
  const legacyMessageKey = "vf:creative-draft:run-legacy:script:draft:legacy-art#v1";
  const legacyEditKey = `${legacyMessageKey}:edit`;

  function installSharedLegacy(message: string, edit: unknown, messageKey = legacyMessageKey) {
    const values = new Map<string, string>([
      [messageKey, message],
      [`${messageKey}:edit`, JSON.stringify(edit)],
    ]);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
    return values;
  }

  it("keeps the shared legacy keys byte-identical after import and does not resurrect processed entries in this tab", async () => {
    const originalMessage = "旧版未发送意见-C3";
    const originalEdit = { baseKey: JSON.stringify({ stage: "script", draftIdentity: "legacy-art:no-sha", draft: { scenes: [{ narration: "旧版旁白" }] } }), document: { scenes: [{ narration: "旧版旁白" }] } };
    const shared = installSharedLegacy(originalMessage, originalEdit);
    const sessionA = tabStorage();
    installTabStorage(sessionA);
    const first = render(<CreativeDiscussionPanel review={scriptReview({ runId: "run-legacy", draftVersionId: "legacy-art#v1" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    // 导入成功：意见与编辑稿进入本标签会话，但共享旧 key 字节不变
    expect(await screen.findByPlaceholderText(/为什么这样开场/)).toHaveValue(originalMessage);
    await screen.findByText(/手动修订这份稿件/);
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("旧版旁白");
    expect(shared.get(legacyMessageKey)).toBe(originalMessage);
    expect(shared.get(legacyEditKey)).toBe(JSON.stringify(originalEdit));
    // 本标签明确放弃后重挂载：不反复复活已处理内容（本标签会话标记）
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    first.unmount();
    const second = render(<CreativeDiscussionPanel review={scriptReview({ runId: "run-legacy", draftVersionId: "legacy-art#v1" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    await screen.findByText(/手动修订这份稿件/);
    // 放弃的是编辑稿：重挂后 legacy 编辑稿不复活（编辑器默认收起），意见仍在。
    const summary = screen.getByText(/手动修订这份稿件/);
    await userEvent.click(summary);
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue((scriptReview().draft as { scenes: Array<{ narration: string }> }).scenes[0]!.narration);
    expect(screen.getByPlaceholderText(/为什么这样开场/)).toHaveValue(originalMessage);
    expect(shared.get(legacyMessageKey)).toBe(originalMessage);
    expect(shared.get(legacyEditKey)).toBe(JSON.stringify(originalEdit));
    second.unmount();

    // 另一标签（独立 sessionStorage）仍能从共享旧 key 导入：不被 A 的处理标记吞掉
    const sessionB = tabStorage();
    installTabStorage(sessionB);
    const third = render(<CreativeDiscussionPanel review={scriptReview({ runId: "run-legacy", draftVersionId: "legacy-art#v1" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findByPlaceholderText(/为什么这样开场/)).toHaveValue(originalMessage);
    expect(shared.get(legacyMessageKey)).toBe(originalMessage);
    third.unmount();
  });

  it("keeps legacy identity when content matches the current draft; import write failure keeps shared values", async () => {
    const current = scriptReview({ runId: "run-legacy-2", draftVersionId: "cur#v1" });
    // 旧稿内容与当前稿完全一致，但没有可核 versionId → 不得绑定为当前 base
    const sameContentEdit = {
      baseKey: JSON.stringify({ stage: "script", draftIdentity: "unknown-legacy:no-sha", draft: current.draft }),
      document: current.draft,
    };
    const legacyKey2 = "vf:creative-draft:run-legacy-2:script:draft:cur#v1";
    const shared = installSharedLegacy("同内容旧意见", sameContentEdit, legacyKey2);
    const sessionA = tabStorage();
    installTabStorage(sessionA);
    const view = render(<CreativeDiscussionPanel review={current} busy={false} onCommand={vi.fn(async () => undefined)} />);
    await screen.findByText(/手动修订这份稿件/);
    const field = screen.getByLabelText("分镜 1 · 旁白");
    expect(field).toHaveValue((current.draft as { scenes: Array<{ narration: string }> }).scenes[0]!.narration);
    // 旧身份未核 → 不能直接保存这份"同内容旧稿"为新稿
    expect(screen.getByText(/旧稿不能覆盖新稿|不能确认这份旧稿来自当前版本/)).toBeInTheDocument();
    expect(screen.getByText(/旧稿不能覆盖新稿/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(shared.get(`${legacyKey2}:edit`)).toBe(JSON.stringify(sameContentEdit));
    view.unmount();

    // 导入写失败（sessionStorage setItem 抛错）：共享旧值保留，不谎报持久导入成功
    const broken = tabStorage();
    const originalSet = broken.setItem;
    broken.setItem = (key: string, value: string) => {
      if (key.startsWith("vf:creative-session:")) throw new Error("session write failed");
      originalSet(key, value);
    };
    installTabStorage(broken);
    const fourth = render(<CreativeDiscussionPanel review={scriptReview({ runId: "run-legacy-2", draftVersionId: "cur#v1" })} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findAllByText(/本机草稿无法保存|手工修订无法在本机保存/).then(found => found.length > 0)).toBe(true);
    expect(shared.get(legacyKey2)).toBe("同内容旧意见");
    fourth.unmount();
  });
});

// C5（收尾包 2026-10-04）：会话存储部分失败仍保本页输入。
// setItem 抛错后内存保留且卸载重挂可恢复；getItem 返回旧持久值不倒灌较新内存；
// clear 失败有本页清理标记，重挂不从旧持久值复活已放弃字段。

describe("session storage partial failure keeps in-page input (C5)", () => {
  it.each([
    { stage: "treatment" as const, draft: { viewerPromise: "原承诺" }, label: "观众看完能得到什么" },
    { stage: "script" as const, draft: scriptReview().draft, label: "分镜 1 · 旁白" },
    { stage: "director" as const, draft: { visualBible: { viewerPromise: "原承诺" } }, label: "全片视觉规则 · 观众承诺" },
  ])("RF2 keeps both $stage fields and a truthful warning across remounts during a read outage", async ({ stage, draft, label }) => {
    const session = tabStorage();
    let broken = false;
    const get = session.getItem;
    session.getItem = key => { if (broken) throw new Error("all reads unavailable"); return get(key); };
    installTabStorage(session);
    const snapshot = scriptReview({ stage, draft });
    const onCommand = vi.fn(async () => undefined);
    let view = render(<CreativeDiscussionPanel review={snapshot} busy={false} onCommand={onCommand} />);
    fireEvent.change(await editorField(label), { target: { value: "正常旁白A" } });
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "正常意见A" } });
    view.unmount();
    broken = true;
    view = render(<CreativeDiscussionPanel review={snapshot} busy={false} onCommand={onCommand} />);
    expect(await editorField(label)).toHaveValue("正常旁白A");
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("正常意见A");
    expect(screen.getByText(/本机草稿无法保存/)).toHaveTextContent(/刷新或关闭可能丢失/);
    fireEvent.change(screen.getByLabelText(label), { target: { value: "故障中较新旁白B" } });
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "故障中较新意见B" } });
    view.unmount();
    broken = false;
    view = render(<CreativeDiscussionPanel review={snapshot} busy={false} onCommand={onCommand} />);
    expect(await editorField(label)).toHaveValue("故障中较新旁白B");
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("故障中较新意见B");
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    view.unmount();
    view = render(<CreativeDiscussionPanel review={snapshot} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("故障中较新意见B");
    expect(await editorField(label)).not.toHaveValue("故障中较新旁白B");
    expect(onCommand).not.toHaveBeenCalled();
    view.unmount();
  });

  it("RF2 reports a failed legacy marker without resurrecting abandoned component input", async () => {
    const session = tabStorage();
    const set = session.setItem;
    session.setItem = (key, value) => { if (key.startsWith("vf:creative-legacy-done:")) throw new Error("marker unavailable"); set(key, value); };
    installTabStorage(session);
    const key = "vf:creative-draft:run-two-tabs:script:draft:script-draft-9#v1";
    sharedLocalStorage.setItem(key, "旧版意见");
    const payload = JSON.stringify({ baseKey: "unknown-old-version", document: { ...scriptReview().draft as Record<string, unknown>, scenes: [{ id: "scene-1", narration: "旧版旁白" }] } });
    sharedLocalStorage.setItem(`${key}:edit`, payload);
    const onCommand = vi.fn(async () => undefined);
    let view = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    expect(await editorField()).toHaveValue("旧版旁白");
    await screen.findByText(/本机草稿无法保存/);
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    fireEvent.change(screen.getByRole("textbox", { name: /聊聊你的想法/ }), { target: { value: "" } });
    view.unmount();
    view = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={onCommand} />);
    expect(screen.getByRole("textbox", { name: /聊聊你的想法/ })).toHaveValue("");
    expect(await editorField()).toHaveValue("第一版旁白。");
    expect(sharedLocalStorage.getItem(key)).toBe("旧版意见");
    expect(sharedLocalStorage.getItem(`${key}:edit`)).toBe(payload);
    expect(onCommand).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each(["message", "document"] as const)("RF2 does not revive abandoned legacy %s if only its marker cannot persist", async field => {
    const { creativeSessionStorage, importLegacyCreativeMessage, importLegacyCreativeEdit, clearCreativeSessionFields, readCreativeSessionSlot, writeCreativeSessionFields } = await import("../src/client/creative-draft-session.js");
    const session = tabStorage();
    const set = session.setItem;
    session.setItem = (key, value) => { if (key.startsWith("vf:creative-legacy-done:")) throw new Error("marker unavailable"); set(key, value); };
    installTabStorage(session);
    const base = { runId: "run-legacy-marker", stage: "script", purposeKey: "draft" };
    const key = "vf:creative-session:run-legacy-marker:script:draft";
    const legacyKey = `vf:creative-draft:run-legacy-marker:script:draft${field === "document" ? ":edit" : ""}`;
    const oldEdit = { baseKey: "unknown-old-base", document: { narration: "旧旁白" } };
    const payload = field === "message" ? "旧意见" : JSON.stringify(oldEdit);
    sharedLocalStorage.setItem(legacyKey, payload);
    const imported = () => field === "message"
      ? importLegacyCreativeMessage({ session: creativeSessionStorage().storage, legacy: sharedLocalStorage, sessionKey: key, base, legacyKey })
      : importLegacyCreativeEdit({ session: creativeSessionStorage().storage, legacy: sharedLocalStorage, sessionKey: key, base, legacyEditKey: legacyKey, currentBaseKey: "current-base", currentDraft: {} });
    const firstResult = imported();
    clearCreativeSessionFields(creativeSessionStorage().storage, key, [field]);
    imported();
    expect(readCreativeSessionSlot(creativeSessionStorage().storage, key)?.[field]).toBeUndefined();
    expect(firstResult).toBe("failed");
    expect(sharedLocalStorage.getItem(legacyKey)).toBe(payload);
    const otherTab = tabStorage();
    installTabStorage(otherTab);
    expect(imported()).toBe("imported");
    expect(readCreativeSessionSlot(creativeSessionStorage().storage, key)?.[field]).toBeDefined();
    installTabStorage(session);
    const newer = field === "message" ? "更新旧payload" : JSON.stringify({ ...oldEdit, document: { narration: "更新旁白" } });
    sharedLocalStorage.setItem(legacyKey, newer);
    imported();
    expect(readCreativeSessionSlot(creativeSessionStorage().storage, key)?.[field]).toEqual(field === "message" ? newer : { ...oldEdit, document: { narration: "更新旁白" } });
    writeCreativeSessionFields(creativeSessionStorage().storage, key, base, field === "message" ? { message: "更晚本页输入" } : { document: { ...oldEdit, document: { narration: "更晚本页输入" } } });
    sharedLocalStorage.setItem(legacyKey, field === "message" ? "再一份旧payload" : JSON.stringify({ ...oldEdit, document: { narration: "再一份旧payload" } }));
    expect(imported()).toBe("skipped");
    expect(JSON.stringify(readCreativeSessionSlot(creativeSessionStorage().storage, key)?.[field])).toContain("更晚本页输入");
  });

  it.each(["getItem", "getter"])("RF2 keeps one recovery domain when %s fails and recovers", async failure => {
    const { creativeSessionStorage, writeCreativeSessionFields, clearCreativeSessionFields, readCreativeSessionSlot } = await import("../src/client/creative-draft-session.js");
    const session = tabStorage();
    let broken = false;
    const get = session.getItem;
    session.getItem = key => { if (broken && failure === "getItem") throw new Error("read unavailable"); return get(key); };
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => {
      if (broken && failure === "getter") throw new Error("access unavailable"); return session;
    } });
    const key = "vf:creative-session:run-two-tabs:script:draft";
    const base = { runId: "run-two-tabs", stage: "script", purposeKey: "draft", versionId: "v1" };
    const first = creativeSessionStorage();
    const docA = { baseKey: "A", document: { narration: "旁白A" } };
    expect(writeCreativeSessionFields(first.storage, key, base, { document: docA, message: "意见A" })).toBe(true);
    broken = true;
    const failing = creativeSessionStorage();
    expect(failing.durable).toBe(false);
    expect(readCreativeSessionSlot(failing.storage, key)?.message).toBe("意见A");
    expect(readCreativeSessionSlot(failing.storage, key)?.document).toEqual(docA);
    const docB = { baseKey: "旧base不能被升级", document: { narration: "旁白B" } };
    writeCreativeSessionFields(failing.storage, key, base, { document: docB, message: "意见B" });
    clearCreativeSessionFields(failing.storage, key, ["message"]);
    broken = false;
    const recovered = creativeSessionStorage();
    expect(readCreativeSessionSlot(recovered.storage, key)?.document).toEqual(docB);
    expect(readCreativeSessionSlot(recovered.storage, key)?.message).toBeUndefined();
    writeCreativeSessionFields(recovered.storage, key, base, { message: "恢复后意见C" });
    expect(readCreativeSessionSlot(recovered.storage, key)?.document).toEqual(docB);
    const other = tabStorage();
    installTabStorage(other);
    expect(readCreativeSessionSlot(creativeSessionStorage().storage, key)).toBeNull();
    installTabStorage(session);
    expect(readCreativeSessionSlot(creativeSessionStorage().storage, key)?.document).toEqual(docB);
  });

  it("flushes both in-memory fields after storage recovers instead of reviving the old persisted document", async () => {
    const { writeCreativeSessionFields, clearCreativeSessionFields, readCreativeSessionRecord } = await import("../src/client/creative-draft-session.js");
    const session = tabStorage();
    const key = "vf:creative-session:run-two-tabs:script:draft";
    const base = { runId: "run-two-tabs", stage: "script", purposeKey: "draft", versionId: "v1" };
    const document = { baseKey: "original-base", document: { narration: "本页最新旁白" } };
    let broken = true;
    const normalSet = session.setItem;
    session.setItem = (key, value) => { if (broken) throw new Error("QuotaExceeded"); normalSet(key, value); };
    expect(writeCreativeSessionFields(session, key, base, { document, message: "本页意见" })).toBe(false);
    broken = false;
    expect(writeCreativeSessionFields(session, key, base, { message: "恢复后新意见" })).toBe(true);
    expect(readCreativeSessionRecord(session, key)?.document).toEqual(document);
    expect(clearCreativeSessionFields(session, key, ["message"])).toBe(true);
    expect(readCreativeSessionRecord(session, key)?.document).toEqual(document);
    expect(readCreativeSessionRecord(session, key)?.message).toBeUndefined();
  });
  it("recovers unsaved words from memory after remount when setItem throws", async () => {
    const session = tabStorage();
    const originalSet = session.setItem;
    session.setItem = (key: string, value: string) => {
      if (key.startsWith("vf:creative-session:")) throw new Error("QuotaExceeded");
      originalSet(key, value);
    };
    installTabStorage(session);
    const first = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    fireEvent.change(composer, { target: { value: "C5 写失败后的意见" } });
    await editorField();
    const field = screen.getByLabelText("分镜 1 · 旁白");
    await userEvent.clear(field);
    await userEvent.type(field, "C5 写失败后的旁白");
    expect(screen.getByText(/本机草稿无法保存/)).toBeInTheDocument();
    await screen.findByText(/手工修订无法在本机保存/);
    first.unmount();
    // 卸载重挂：同一页面仍可从模块内存副本恢复（不承诺刷新后仍在）
    const second = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findByPlaceholderText(/为什么这样开场/)).toHaveValue("C5 写失败后的意见");
    await screen.findByText(/手动修订这份稿件/);
    expect(screen.getByLabelText("分镜 1 · 旁白")).toHaveValue("C5 写失败后的旁白");
    second.unmount();
  });

  it("does not let a stale persisted value overwrite newer memory, and a failed clear does not resurrect abandoned fields", async () => {
    // 先正常持久化一份旧值
    const healthy = tabStorage();
    installTabStorage(healthy);
    const seed = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    const seedComposer = screen.getByPlaceholderText(/为什么这样开场/);
    fireEvent.change(seedComposer, { target: { value: "旧的持久意见" } });
    await waitFor(() => expect(healthy.values.get("vf:creative-session:run-two-tabs:script:draft")).toBeTruthy());
    seed.unmount();

    // 之后本页 setItem 失败：内存较新值不被旧持久值倒灌
    const failing = tabStorage();
    // 复制旧持久值模拟“能读不能写”
    for (const [key, value] of healthy.values) failing.values.set(key, value);
    const originalSet = failing.setItem;
    failing.setItem = (key: string, value: string) => {
      if (key.startsWith("vf:creative-session:")) throw new Error("QuotaExceeded");
      originalSet(key, value);
    };
    installTabStorage(failing);
    const first = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    const composer = screen.getByPlaceholderText(/为什么这样开场/);
    expect(composer).toHaveValue("旧的持久意见");
    fireEvent.change(composer, { target: { value: "更新后的内存意见" } });
    expect(composer).toHaveValue("更新后的内存意见");
    first.unmount();
    const second = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findByPlaceholderText(/为什么这样开场/)).toHaveValue("更新后的内存意见");
    second.unmount();

    // clear 失败：用户明确放弃后，重挂不得从旧持久值复活
    const clearFailing = tabStorage();
    for (const [key, value] of healthy.values) clearFailing.values.set(key, value);
    const originalRemove = clearFailing.removeItem;
    clearFailing.removeItem = (key: string) => {
      if (key.startsWith("vf:creative-session:")) throw new Error("remove failed");
      originalRemove(key);
    };
    installTabStorage(clearFailing);
    const third = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findByPlaceholderText(/为什么这样开场/)).toHaveValue("旧的持久意见");
    fireEvent.change(screen.getByPlaceholderText(/为什么这样开场/), { target: { value: "将被放弃的意见" } });
    await editorField();
    await userEvent.clear(screen.getByLabelText("分镜 1 · 旁白"));
    await userEvent.type(screen.getByLabelText("分镜 1 · 旁白"), "将被放弃的旁白");
    await userEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    // 放弃后重挂：编辑器不复活已放弃稿（本页清理标记生效）
    third.unmount();
    const fourth = render(<CreativeDiscussionPanel review={scriptReview()} busy={false} onCommand={vi.fn(async () => undefined)} />);
    await screen.findByText(/手动修订这份稿件/);
    const reopened = screen.queryByLabelText("分镜 1 · 旁白");
    if (reopened) expect(reopened).toHaveValue((scriptReview().draft as { scenes: Array<{ narration: string }> }).scenes[0]!.narration);
    fourth.unmount();
  });
});
