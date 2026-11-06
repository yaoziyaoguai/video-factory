import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Plus, RefreshCw, Sparkles, X } from "lucide-react";
import type { SkillPackage, SkillPackageMutation, SkillPackagesView } from "../../shared/agent/generated/contracts.js";
import { agentApi, AgentApiError } from "./api.js";

export function SkillPackagesPanel({ visible, onCatalogRefresh, onMutationChange }: {
  visible: boolean; onCatalogRefresh: () => Promise<void>; onMutationChange?: ((mutation: SkillPackageMutation | null) => void) | undefined;
}) {
  const [view, setView] = useState<SkillPackagesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [localMutation, setLocalMutation] = useState<SkillPackageMutation | null>(null);
  const [dialog, setDialog] = useState<"install" | SkillPackage | null>(null);
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState("");
  const modal = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const active = useRef(true);
  const readSequence = useRef(0);
  const mutationInFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const mutation = localMutation ?? view?.mutation ?? null;
  useEffect(() => { onMutationChange?.(mutation); }, [mutation, onMutationChange]);
  const blocked = !view || loading || Boolean(loadError || catalogError || mutation || needsRefresh);
  const refreshCatalog = useCallback(async () => {
    try { await onCatalogRefresh(); if (active.current) setCatalogError(""); }
    catch { if (active.current) setCatalogError("目录已读取，但对话 Skill 列表刷新失败。请刷新列表后再使用。"); }
  }, [onCatalogRefresh]);
  const load = useCallback(async () => {
    const sequence = ++readSequence.current;
    setLoading(true); setLoadError("");
    try {
      const value = await agentApi.readSkillPackages();
      if (!active.current || sequence !== readSequence.current) return;
      setView(value); setNeedsRefresh(false); setOperationError("");
      setNotice("");
      await refreshCatalog();
    } catch (error) {
      if (active.current && sequence === readSequence.current) setLoadError(error instanceof Error ? error.message : "Skill 列表读取失败。");
    } finally { if (active.current && sequence === readSequence.current) setLoading(false); }
  }, [refreshCatalog]);
  useEffect(() => { if (visible) void load(); }, [visible, load]);

  // 页面往返保留来源草稿和在途操作；关闭弹窗不取消服务端安装或卸载。
  useEffect(() => {
    if (!visible) { setDialog(null); wasOpen.current = false; return; }
    if (dialog) modal.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    else if (wasOpen.current) {
      const button = trigger.current;
      (button?.isConnected && !button.disabled ? button : refreshButton.current)?.focus();
    }
    wasOpen.current = dialog !== null;
  }, [dialog, visible]);

  const open = (next: "install" | SkillPackage, button: HTMLButtonElement) => {
    trigger.current = button; setDialog(next); setSourceError("");
    if (!needsRefresh) { setOperationError(""); setNotice(""); }
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDialog(null); return; }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(":is(button,input):not(:disabled)")];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const submit = async () => {
    if (!dialog || blocked || mutationInFlight.current) return;
    const target = dialog;
    const trimmedSource = source.trim();
    if (target === "install" && !trimmedSource) { setSourceError("请填写 npm、Git 或服务器本机包目录来源。"); return; }
    const operation: SkillPackageMutation = { action: target === "install" ? "install" : "remove", source: target === "install" ? trimmedSource : target.source };
    mutationInFlight.current = true;
    readSequence.current++; setLoading(false);
    setLocalMutation(operation); setOperationError(""); setNotice("");
    modal.current?.querySelector<HTMLButtonElement>('[aria-label="关闭 Skill 面板"]')?.focus();
    try {
      const value = target === "install" ? await agentApi.installSkillPackage({ source: trimmedSource }) : await agentApi.removeSkillPackage({ packageId: target.id });
      if (!active.current) return;
      // 在途只读刷新可能早于管理完成；完成响应代表较新的目录。
      readSequence.current++; setLoading(false);
      setView(value); setNeedsRefresh(false); setDialog(null);
      if (target === "install") setSource("");
      setNotice(target === "install" ? "安装结果已返回，请查看各来源的实际 Skill 状态。" : "卸载结果已返回，当前列表已更新。");
      await refreshCatalog();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AgentApiError) {
        setOperationError(error.message + (error.payload.status >= 500 ? " 目录可能已有变化，请先刷新列表核对。" : error.payload.code === "RUN_BUSY" && error.payload.retryAction === "wait" ? " 请等待完成后再操作。" : ""));
        setNeedsRefresh(error.payload.status >= 500);
      } else {
        setNeedsRefresh(true);
        setOperationError("结果待确认。后台操作可能仍在进行，请只读刷新列表核对后再决定；不会自动重发。");
      }
    } finally {
      mutationInFlight.current = false;
      if (active.current) setLocalMutation(null);
    }
  };

  const removal = dialog && dialog !== "install" ? dialog : null;
  const feedback = <>
    {mutation ? <p className="agent-config-summary" role="status">正在{mutation.action === "install" ? "安装" : "卸载"} Skill 包：<span className="agent-skill-source">{mutation.source}</span>关闭面板不会取消操作；可刷新列表查看当前状态。</p> : null}
    {operationError ? <p className="agent-field-error" role="alert">{operationError}</p> : null}
    {catalogError ? <p className="agent-field-error" role="alert">{catalogError}</p> : null}
  </>;
  return <>
    <div className="agent-settings-toolbar agent-skills-toolbar">
      <p className="agent-config-note">安装后即可在原对话选择 Skill，默认仍为自动选择。</p>
      <div className="agent-inline-actions">
        <button type="button" className="agent-model-config-button" ref={refreshButton} disabled={loading} onClick={() => void load()}><RefreshCw aria-hidden="true" />{loading ? "读取中…" : "刷新列表"}</button>
        <button type="button" className="agent-primary-button" disabled={blocked} onClick={event => open("install", event.currentTarget)}><Plus aria-hidden="true" />安装 Skill</button>
      </div>
    </div>
    {!dialog ? feedback : null}
    {notice ? <p className="agent-config-note agent-skill-notice" role="status">{notice}</p> : null}
    {loadError ? <p className="agent-field-error agent-skill-notice" role="alert">{loadError} {view ? "当前仍显示上次读取的列表。" : "请刷新列表重试。"}</p> : null}
    {!view && loading ? <p className="agent-config-note agent-skill-notice" role="status">正在读取 Skill 列表…</p> : null}
    <div className="agent-skill-packages">{view?.packages.map(item => <article className="agent-skill-package" key={item.id} aria-label={item.name}>
      <header><div><h3>{item.name}{item.origin === "builtin" ? <span className="agent-skill-origin">内置 · 只读</span> : null}</h3><p className="agent-skill-source">{item.source}</p></div>
        <span className={`agent-skill-status ${item.status}`}>{{ ready: "可用", no_skills: "未发现 Skill", invalid: "不可用" }[item.status]}</span>
        {item.origin === "installed" ? <button type="button" className="agent-model-config-button" disabled={blocked} aria-label={`卸载 ${item.name}`} onClick={event => open(item, event.currentTarget)}>卸载</button> : null}</header>
      {item.skillIds.length ? <ul className="agent-package-skills">{item.skillIds.map(id => {
        const skill = view.skills.find(entry => entry.id === id);
        return <li key={id}><strong>{skill?.name ?? id}</strong><p>{skill?.description ?? "当前目录未发现此 Skill。"}</p></li>;
      })}</ul> : <p className="agent-skill-empty">{item.status === "invalid" ? "来源或 Skill 解析不可用，请查看诊断。" : "此来源未发现可用 Skill。"}</p>}
      {item.diagnostics.length ? <ul className="agent-skill-diagnostics" aria-label={`${item.name} 诊断`}>{item.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul> : null}
    </article>)}</div>
    {view?.packages.length === 0 ? <div className="agent-settings-empty"><Sparkles aria-hidden="true" /><h3>还没有 Skill 包</h3><p>从 npm、Git 仓库或服务器本机包目录安装。</p><button type="button" className="agent-model-config-button" disabled={blocked} onClick={event => open("install", event.currentTarget)}>安装第一个 Skill</button></div> : null}
    {dialog ? <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}><div className="agent-modal agent-skill-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-package-dialog-title" ref={modal} onKeyDown={keys}>
      <header className="agent-modal-header"><div><h3 id="skill-package-dialog-title">{dialog === "install" ? "安装 Skill" : "卸载 Skill 包"}</h3></div><button type="button" className="agent-icon-button" aria-label="关闭 Skill 面板" onClick={() => setDialog(null)}><X aria-hidden="true" /></button></header>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        {dialog === "install" ? <>
          <label className="agent-config-field" htmlFor="skill-package-source">包来源<input id="skill-package-source" data-initial-focus value={source} disabled={Boolean(mutation || needsRefresh)} onChange={event => { setSource(event.target.value); setSourceError(""); setOperationError(""); }} maxLength={2048} autoComplete="off" spellCheck={false} placeholder="npm:包名、Git URL 或服务端包目录" aria-invalid={Boolean(sourceError)} aria-describedby="skill-package-source-help" /></label>
          {sourceError ? <p className="agent-field-error" role="alert">{sourceError}</p> : null}
          <p className="agent-config-note" id="skill-package-source-help">支持 Pi 原生 npm 包、Git 仓库 URL、服务器本机包目录。本机路径指服务端已有的目录，不会从浏览器上传文件。</p>
        </> : <>
          <p className="agent-config-note">将卸载 {removal!.name}，并从后续发现、显式选择和文件读取中移除同包 Skill：</p>
          <ul className="agent-package-skills">{removal!.skillIds.length ? removal!.skillIds.map(id => <li key={id}><strong>{view?.skills.find(skill => skill.id === id)?.name ?? id}</strong></li>) : <li>此包未发现可用 Skill。</li>}</ul>
          <p className="agent-config-summary">服务器本机目录来源仅解除注册，不删除源文件。已有聊天、作品与生成记录会保留；模型此前读过的 Skill 内容不会从历史中清除。</p>
        </>}
        {feedback}
        {loadError ? <p className="agent-field-error" role="alert">{loadError}</p> : null}
        {mutation || needsRefresh || catalogError || loadError ? <button type="button" className="agent-model-config-button" disabled={loading} onClick={() => void load()}>{loading ? "读取中…" : "刷新列表"}</button> : null}
        <footer className="agent-modal-actions"><button type="button" className="agent-secondary-button" data-initial-focus={removal ? true : undefined} onClick={() => setDialog(null)}>关闭</button>
          <button type="submit" className="agent-primary-button" disabled={blocked}>{localMutation ? localMutation.action === "install" ? "安装中…" : "卸载中…" : dialog === "install" ? "安装" : "确认卸载"}</button></footer>
      </form>
    </div></div> : null}
  </>;
}
