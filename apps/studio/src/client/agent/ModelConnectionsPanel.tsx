import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AudioLines, Check, ChevronDown, Cpu, Film, Image, KeyRound, Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import type { AvailableProviderModels, ConnectionModel, ProviderConnection, ProviderConnectionSettings, SaveProviderConnection, ThinkingLevel } from "../../shared/agent/generated/contracts.js";
import { agentApi, AgentApiError } from "./api.js";

// S3-01 模型页：按已认可 PreviewSettings 结构——每类一个“当前连接+具体型号”，
// 选择器先连接再型号、应用才写库；备选管理与目录同步独立，同步只更新可选目录。
// 全部事实来自 ProviderConnectionSettings；能力/适配状态如实展示，不自动选第一个。

const kinds = [{ id: "text", label: "文本大模型", icon: Cpu }, { id: "image", label: "图片模型", icon: Image }, { id: "video", label: "视频模型", icon: Film }, { id: "speech", label: "配音模型", icon: AudioLines }] as const;
const protocols = { openai: "OpenAI", "openai-chat-completions": "OpenAI 兼容", "anthropic-messages": "Anthropic", ark: "火山方舟", minimax: "MiniMax", wan: "万相" } as const;
// 新建连接提供活入口：OpenAI 承载文本/图片/配音（配音另可配 MiniMax），视频走 Ark/MiniMax/万相；旧协议值仅供历史行显示。
const NEW_CONNECTION_PROTOCOLS: ProviderConnection["protocol"][] = ["openai", "ark", "minimax", "wan"];
// OpenAI 文本/图片/配音的工程初始输出上限（A2）；保存边界按该型号实际上限核对。
const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const thinkingLabels: Record<ThinkingLevel, string> = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
const NEW_CONNECTION = "__new__";

interface DirectoryState { models: AvailableProviderModels | null; loading: boolean; error: string }

// 列表与切换用途共用承载事实；切 tab 只更新阅读选择，不写当前模型。
function connectionSupportsKind(connection: ProviderConnection, kind: ConnectionModel["kind"]): boolean {
  return kind === "video" ? connection.protocol !== "openai"
    : connection.protocol === "openai" || (kind === "image" && connection.protocol === "ark") || (kind === "speech" && connection.protocol === "minimax");
}

export function ModelConnectionsPanel({ onCatalogRefresh }: { onCatalogRefresh: () => Promise<void> }) {
  const [settings, setSettings] = useState<ProviderConnectionSettings | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<ConnectionModel["kind"]>("text");
  const [pickConnectionId, setPickConnectionId] = useState("");
  const [pickModelId, setPickModelId] = useState("");
  const [managing, setManaging] = useState(false);
  const [directoryConnectionId, setDirectoryConnectionId] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [removing, setRemoving] = useState<ConnectionModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ body: SaveProviderConnection; note: string } | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [editing, setEditing] = useState<{ mode: "connection" | "model"; connectionId: string | null; modelId: string | null } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const load = async () => { setError(""); try { setSettings(await agentApi.readProviderConnections()); } catch { setError("配置读取失败，请重试。"); } };
  useEffect(() => { void load(); }, []);

  const modelsOfKind = (connection: ProviderConnection): ConnectionModel[] => connection.models.filter(model => model.kind === kind);
  // 承载矩阵（§11.2）：文本用 OpenAI，图片用 OpenAI 或火山方舟；配音 OpenAI 或 MiniMax；视频 Ark/MiniMax/万相（不含 OpenAI）。
  const kindConnections = (settings?.connections ?? []).filter(item => item.enabled && item.apiKey && connectionSupportsKind(item, kind));
  const current = kindConnections.flatMap(connection => modelsOfKind(connection).map(model => ({ connection, model }))).find(item => item.model.isDefault) ?? null;
  const backups = kindConnections.flatMap(connection => modelsOfKind(connection).map(model => ({ connection, model }))).filter(item => !item.model.isDefault) ?? [];
  const statusOf = (modelId: string): string | null => settings?.modelStatuses.find(item => item.modelEntryId === modelId)?.unavailableReason ?? null;

  // 连接/型号在重读后可能消失：选择器回落到当前模型及其所在连接（与已认可 preview 的初始态一致）。
  const pickConnection = kindConnections.find(item => item.id === pickConnectionId)
    ?? kindConnections.find(item => modelsOfKind(item).some(model => model.isDefault))
    ?? kindConnections[0] ?? null;
  const currentOfKind = kindConnections.flatMap(connection => modelsOfKind(connection)).find(model => model.isDefault) ?? null;
  const pickModel = pickConnection?.models.find(item => item.id === pickModelId && item.kind === kind)
    ?? (currentOfKind && pickConnection?.models.includes(currentOfKind) ? currentOfKind : null);

  const switchKind = (next: ConnectionModel["kind"]) => {
    setKind(next); setPickModelId(""); setNotice(""); setRemoving(null); setManaging(false); setModelSearch("");
    const scoped = (settings?.connections ?? []).filter(item => item.enabled && item.apiKey && connectionSupportsKind(item, next));
    setPickConnectionId((scoped.find(item => item.models.some(model => model.kind === next && model.isDefault)) ?? scoped[0])?.id ?? "");
  };

  // 所有变更走同一 saveProviderConnection 事务：跨连接设新当前由服务端在同一事务清原默认，
  // 不前后两次请求；保存未知沿 command/revision 机制原命令重试。
  const commit = async (draft: ProviderConnection, note: string, retry?: SaveProviderConnection) => {
    if (!settings || busy) return;
    const body = retry ?? { commandId: agentApi.newCommandId(), expectedRevision: settings.revision, connection: draft };
    setBusy(true); setNotice("");
    try {
      await agentApi.saveProviderConnection(body);
      if (!active.current) return;
      setPending(null);
      setSettings(await agentApi.readProviderConnections());
      setNotice(note);
      try { await onCatalogRefresh(); } catch { setError("配置已保存，但工作台状态刷新失败，请刷新页面。"); }
    } catch (fault) {
      if (!active.current) return;
      if (fault instanceof AgentApiError) {
        setPending(null);
        if (fault.payload.code === "STALE_REVISION") {
          setSettings(await agentApi.readProviderConnections());
          setNotice("配置已被其他页面修改，已重新读取最新状态；请再次操作。");
        } else setNotice(fault.payload.message);
      } else {
        setPending({ body, note });
        setNotice("保存结果未知，请重试同一命令。");
      }
    } finally { if (active.current) setBusy(false); }
  };

  const setCurrent = async (connection: ProviderConnection, model: ConnectionModel) => {
    const draft = { ...connection, models: connection.models.map(item => item.kind === kind ? { ...item, isDefault: item.id === model.id } : item) };
    setPickConnectionId(connection.id); setPickModelId(model.id);
    await commit(draft, `当前模型已切换到 ${model.name}。已有制作保持原方案。`);
  };

  const removeModel = (connection: ProviderConnection, model: ConnectionModel) => {
    void commit({ ...connection, models: connection.models.filter(item => item.id !== model.id) }, `已从备选移除，连接和历史记录保留。`);
  };

  const confirmRemoving = async () => {
    if (!removing || !settings) return;
    const owner = settings.connections.find(item => item.models.some(model => model.id === removing.id));
    if (!owner) { setRemoving(null); return; }
    setPickModelId("");
    await commit({ ...owner, models: owner.models.filter(item => item.id !== removing.id) }, "已移除。此类当前未配置，其他类别和历史保留。");
    setRemoving(null);
  };

  const changeThinking = async (level: ThinkingLevel | "default") => {
    if (!current) return;
    const draft = { ...current.connection, models: current.connection.models.map(item => item.id === current.model.id ? { ...item, thinkingLevel: level } : item) };
    await commit(draft, `推理档位已保存为“${level === "default" ? "跟随模型默认" : thinkingLabels[level]}”。`);
  };

  const syncDirectory = async (connectionId: string) => {
    setDirectories(state => ({ ...state, [connectionId]: { models: state[connectionId]?.models ?? null, loading: true, error: "" } }));
    try {
      const models = await agentApi.listAvailableProviderModels(connectionId);
      if (!active.current) return;
      setDirectories(state => ({ ...state, [connectionId]: { models, loading: false, error: "" } }));
      const protocol = settings?.connections.find(item => item.id === connectionId)?.protocol;
      setNotice(protocol === "minimax" || protocol === "wan"
        ? "本地适配目录已刷新，账户可用性尚未验证；当前模型与备选保持不变。"
        : "目录已刷新，当前模型与备选保持不变。");
    } catch (fault) {
      if (!active.current) return;
      setDirectories(state => ({ ...state, [connectionId]: { models: state[connectionId]?.models ?? null, loading: false, error: fault instanceof AgentApiError ? fault.payload.message : "同步失败，请检查地址与 Key；已选型号未改动。" } }));
    }
  };

  // 从目录勾选只保留备选，是否切换当前由用户另行决定。
  const directoryModelOf = (entry: AvailableProviderModels["models"][number]): ConnectionModel => ({
    id: `model-${crypto.randomUUID()}`, kind, name: entry.name || entry.id, modelId: entry.id, features: [],
    contextWindowTokens: kind === "text" ? entry.contextWindowTokens ?? null : null,
    maxOutputTokens: kind === "text" ? Math.min(OPENAI_DEFAULT_MAX_OUTPUT_TOKENS, entry.maxOutputTokens ?? OPENAI_DEFAULT_MAX_OUTPUT_TOKENS) : null,
    enabled: true, isDefault: false,
  });
  const checkDirectoryModel = (connection: ProviderConnection, entry: AvailableProviderModels["models"][number]) => {
    const created = directoryModelOf(entry);
    void commit({ ...connection, models: [...connection.models, created] }, `${created.name} 已加入备选。`);
  };

  const openEditor = (button: HTMLButtonElement, target: { mode: "connection" | "model"; connectionId: string | null; modelId: string | null }) => {
    trigger.current = button; setNotice(""); setEditing(target);
  };

  const capability = current ? settings?.modelStatuses.find(item => item.modelEntryId === current.model.id)?.thinking ?? null : null;
  const kindLabel = kinds.find(item => item.id === kind)!.label;
  const pickChoices = pickConnection ? modelsOfKind(pickConnection) : [];
  const applyDisabled = !pickModel || Boolean(statusOf(pickModel.id)) || pickModel.id === current?.model.id;
  const actionsDisabled = busy || pending !== null;
  const directoryConnection = kindConnections.find(item => item.id === directoryConnectionId) ?? pickConnection;
  const showDirectory = (connection: ProviderConnection) => {
    setDirectoryConnectionId(connection.id);
    setModelSearch("");
    if (!directories[connection.id]?.models && !directories[connection.id]?.loading) void syncDirectory(connection.id);
  };

  return <>
    <div className="agent-models-heading">
      <p>每类一个当前使用，按需保留备选。</p>
      {settings?.connections.length
        ? <button className="agent-model-config-button" disabled={actionsDisabled}
          onClick={event => openEditor(event.currentTarget, { mode: "connection", connectionId: current?.connection.id ?? settings.connections[0]!.id, modelId: null })}>
          <KeyRound aria-hidden="true" />连接配置
        </button>
        : null}
    </div>
    <div className="agent-settings-tabs agent-model-tabs" role="tablist" aria-label="模型用途">
      {kinds.map(item => <button key={item.id} type="button" role="tab" aria-selected={kind === item.id} onClick={() => switchKind(item.id)}>
        <item.icon aria-hidden="true" />{item.label}
      </button>)}
    </div>
    {error ? <p role="alert" className="agent-field-error">{error}<button onClick={() => void load()}>重新读取</button></p> : null}
    {!settings && !error ? <p className="agent-settings-note">正在读取模型配置…</p> : null}
    {notice ? <p role="status" className="agent-settings-note">{notice}
      {pending ? <button type="button" disabled={busy} onClick={() => void commit(pending.body.connection, pending.note, pending.body)}>重试保存</button> : null}
    </p> : null}
    {settings ? <>
      <article className="agent-current-model" aria-label={`当前${kindLabel}`}>
        <div className="agent-current-label">
          <span>{(() => { const Icon = kinds.find(item => item.id === kind)!.icon; return <Icon aria-hidden="true" />; })()}当前使用</span>
          {current ? (statusOf(current.model.id)
            ? <span className="agent-connection-unavailable">{statusOf(current.model.id)}</span>
            : <span className="agent-current-status"><Check aria-hidden="true" />用于新的请求和方案</span>) : null}
        </div>
        {current ? <>
          <h3>{current.model.name}
            <button type="button" className="agent-text-link" disabled={actionsDisabled}
              onClick={event => openEditor(event.currentTarget, { mode: "model", connectionId: current.connection.id, modelId: current.model.id })}>编辑型号</button>
          </h3>
          {!current.model.name.includes(current.model.modelId) && <code>{current.model.modelId}</code>}
          <p>{current.connection.name}{current.model.features.length ? ` · ${current.model.features.join(" · ")}` : ""}</p>
        </> : <>
          <h3>还没有当前模型</h3>
          <p>选择供应商和具体型号后应用。</p>
        </>}
        <form className="agent-model-picker" onSubmit={event => { event.preventDefault(); if (pickConnection && pickModel) void setCurrent(pickConnection, pickModel); }}>
          <label>{kind === "text" ? "OpenAI 连接" : "供应商连接"}
            <select value={pickConnection?.id ?? ""} disabled={actionsDisabled || !kindConnections.length}
              onChange={event => { setPickConnectionId(event.target.value); setPickModelId(""); setNotice(""); }}>
              {kindConnections.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? "" : "（已停用）"}</option>)}
            </select>
          </label>
          <label>具体型号
            <select required value={pickModel?.id ?? ""} disabled={actionsDisabled || !settings.connections.length}
              onChange={event => { setPickModelId(event.target.value); setNotice(""); }}>
              <option value="" disabled>请选择具体型号</option>
              {pickChoices.map(item => {
                const reason = statusOf(item.id);
                return <option key={item.id} value={item.id} disabled={Boolean(reason)}>
                  {item.name}{item.name.includes(item.modelId) ? "" : ` · ${item.modelId}`}{reason ? `（${reason}）` : item.isDefault ? "（当前）" : ""}
                </option>;
              })}
            </select>
          </label>
          <button type="submit" className="agent-primary-button" disabled={actionsDisabled || applyDisabled}>应用选择</button>
        </form>
        {pickConnection && pickChoices.length === 0 ? <p className="agent-config-note">此连接还没有可选的{kindLabel}；打开“管理备选”选择具体型号。</p> : null}
        {kind === "text" && current ? (
          capability
            ? capability.levels.length > 1
              ? <label className="agent-current-reasoning">推理强度
                <select value={current.model.thinkingLevel ?? "default"} disabled={actionsDisabled} onChange={event => void changeThinking(event.target.value as ThinkingLevel | "default")}>
                  <option value="default">跟随模型默认（{thinkingLabels[capability.defaultLevel]}）</option>
                  {capability.levels.map(level => <option key={level} value={level}>{thinkingLabels[level]}</option>)}
                </select>
              </label>
              : <p className="agent-config-note">此型号原生不支持推理，按关闭执行。</p>
            : <p className="agent-config-note">推理能力未核实，使用默认档位。</p>
        ) : null}
      </article>
      <div className="agent-backup-heading">
        <h3>备选模型 <span>{backups.length}</span></h3>
        <button type="button" className="agent-model-config-button" aria-expanded={managing} disabled={!kindConnections.length} onClick={() => {
          if (!managing && pickConnection) showDirectory(pickConnection);
          setManaging(!managing); setNotice(""); setRemoving(null);
        }}>
          管理备选<ChevronDown aria-hidden="true" />
        </button>
      </div>
      {!managing && <div className="agent-backup-list">
        {backups.length ? backups.map(({ connection, model }) => {
          const reason = statusOf(model.id);
          return <div className="agent-backup-row" key={model.id}>
            <div>
              <strong>{model.name}</strong>
              <span>{connection.name}</span>
              {!model.name.includes(model.modelId) && <code>{model.modelId}</code>}
              {model.features.length ? <p>{model.features.join(" · ")}</p> : null}
            </div>
            <div className="agent-backup-actions">
              {reason ? <span className="agent-connection-unavailable">{reason}</span>
                : <button type="button" className="agent-model-config-button" disabled={actionsDisabled} onClick={() => void setCurrent(connection, model)}>设为当前</button>}
              <button type="button" className="agent-icon-button" aria-label={`编辑型号 ${model.name}`} disabled={actionsDisabled}
                onClick={event => openEditor(event.currentTarget, { mode: "model", connectionId: connection.id, modelId: model.id })}><Settings2 aria-hidden="true" /></button>
              <button type="button" className="agent-icon-button" aria-label={`移除 ${model.name}`} disabled={actionsDisabled} onClick={() => removeModel(connection, model)}><Trash2 aria-hidden="true" /></button>
            </div>
          </div>;
        }) : <p className="agent-settings-note">还没有备选；可在“管理备选”里从目录勾选保留。</p>}
      </div>}
      {removing ? <div className="agent-inline-confirm" role="alert">
        <p>这是当前使用的模型。移除后，此类暂时不可用；不会自动换成其他模型。</p>
        <div className="agent-inline-actions">
          <button type="button" className="agent-model-config-button" disabled={busy} onClick={() => setRemoving(null)}>保留</button>
          <button type="button" className="agent-model-config-button" disabled={busy} onClick={() => void confirmRemoving()}>移除并暂不配置</button>
        </div>
      </div> : null}
      {managing ? <fieldset className="agent-directory">
        <legend>选择备选型号</legend>
        <div className="agent-directory-filters">
          {kindConnections.length > 1 && <label>目录连接
            <select value={directoryConnection?.id ?? ""} onChange={event => showDirectory(kindConnections.find(item => item.id === event.target.value)!)}>
              {kindConnections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>}
          <label>搜索型号<input type="search" value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="输入型号名称或 ID" /></label>
        </div>
        <p className="agent-directory-note">勾选加入备选，取消勾选即可移除。更改即时保存。</p>
        {directoryConnection && (() => {
          const connection = directoryConnection;
          const directory = directories[connection.id];
          const localDirectory = connection.protocol === "minimax" || connection.protocol === "wan";
          const listing = directory?.models ?? null;
          const registered = modelsOfKind(connection);
          const entryOf = (id: string) => listing?.models.find(item => item.id === id) ?? null;
          const choices = [...new Map([
            ...registered.map(item => [item.modelId, item] as const),
            ...(listing?.models ?? []).filter(item => item.kinds.includes(kind) && item.status !== "retired").map(item => [item.id, null] as const),
          ]).keys()];
          const query = modelSearch.trim().toLowerCase();
          const matches = choices.filter(id => [id, registered.find(item => item.modelId === id)?.name, entryOf(id)?.name].some(value => value?.toLowerCase().includes(query)));
          return <div className="agent-directory-provider" key={connection.id}>
            <h4>{connection.name}
              <button type="button" className="agent-model-config-button" disabled={directory?.loading}
                onClick={() => void syncDirectory(connection.id)}>
                <RefreshCw aria-hidden="true" />{directory?.loading ? "同步中…" : "同步目录"}
              </button>
            </h4>
            <p className="agent-config-note">{localDirectory ? "本地已适配型号，账户可用性尚未验证。" : "目录来自供应商接口，账户可用性以实际调用为准。"}</p>
            {directory?.error ? <p className="agent-field-error" role="alert">{directory.error}{listing ? " 当前仍显示上次同步的目录。" : ""}</p> : null}
            <div className="agent-directory-choices">
            {matches.length ? matches.map(id => {
              const registeredModel = registered.find(item => item.modelId === id) ?? null;
              const entry = entryOf(id);
              const status = !listing ? null : !entry ? "未在本次目录中列出" : entry.status === "retired" ? "厂商已标记下线" : entry.status === "retiring" ? "厂商标记即将下线" : !entry.kinds.includes(kind) ? "目录未确认此用途" : null;
              const name = registeredModel?.name ?? entry?.name ?? id;
              return <div key={id} className="agent-directory-row"><label className="agent-directory-option">
                <input type="checkbox" checked={Boolean(registeredModel)} disabled={actionsDisabled || Boolean(registeredModel?.isDefault)} onChange={event => {
                  if (event.target.checked) { if (entry) checkDirectoryModel(connection, entry); }
                  else if (registeredModel) removeModel(connection, registeredModel);
                }} />
                <span>
                  <strong>{name}</strong>
                  {registeredModel?.isDefault && <span className="agent-directory-current">当前使用</span>}
                  {!name.includes(id) && <small>{id}</small>}
                  {status && <small>{status}</small>}
                  {registeredModel && statusOf(registeredModel.id) ? <small className="agent-connection-unavailable">{statusOf(registeredModel.id)}</small> : null}
                </span>
              </label>
                {registeredModel && !registeredModel.isDefault && !statusOf(registeredModel.id) &&
                  <button type="button" className="agent-text-link" disabled={actionsDisabled} aria-label={`将 ${name} 设为当前`}
                    onClick={() => void setCurrent(connection, registeredModel)}>设为当前</button>}
              </div>;
            }) : <p className="agent-config-note">{directory?.loading ? "正在读取型号…" : query ? "没有匹配的型号，试试更短的名称或 ID。" : `还没有可选${kindLabel}，可重新同步目录。`}</p>}
            </div>
            {listing ? <p className="agent-config-note" role="status">
              {listing.models.filter(item => item.kinds.includes(kind) && item.status !== "retired").length} 个{kindLabel}目录条目 · {new Date(listing.syncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} {localDirectory ? "已读取本地列表" : "已同步"}{listing.hasMore ? " · 厂商目录还有后续分页" : ""}
            </p> : null}
          </div>;
        })()}
      </fieldset> : null}
      {settings.connections.length === 0 ? <div className="agent-settings-empty">
        <Cpu aria-hidden="true" /><h3>添加你的第一个模型连接</h3>
        <p>文本使用 OpenAI，图片可选 OpenAI 或火山方舟，配音可选 OpenAI 或 MiniMax，视频可选火山方舟、MiniMax 或万相。</p>
        <button type="button" className="agent-model-config-button" onClick={event => openEditor(event.currentTarget, { mode: "connection", connectionId: null, modelId: null })}><Plus aria-hidden="true" />添加连接</button>
      </div> : null}
      {settings.connections.length > 0 && kindConnections.length === 0 ? <div className="agent-settings-empty">
        <Cpu aria-hidden="true" /><h3>{kind === "video" ? "还没有视频供应商连接" : kind === "speech" ? "还没有配音供应商连接" : kind === "image" ? "还没有图片供应商连接" : "还没有 OpenAI 连接"}</h3>
        <p>{kind === "video" ? "添加火山方舟、MiniMax 或万相连接。" : kind === "speech" ? "添加 OpenAI 或 MiniMax 连接。" : kind === "image" ? "配置 OpenAI 或火山方舟连接。" : "配置 OpenAI 连接。"}</p>
        <button type="button" className="agent-model-config-button" onClick={event => openEditor(event.currentTarget, { mode: "connection", connectionId: null, modelId: null })}><Plus aria-hidden="true" />添加连接</button>
      </div> : null}
      <p className="agent-service-footnote">连接共用 Key。切换当前模型只影响新的请求与方案，正在制作的版本不变。</p>
    </> : null}
    {editing && settings ? <ConnectionEditor mode={editing.mode} connectionId={editing.connectionId} modelId={editing.modelId}
      onRemoveCurrent={current && editing.modelId === current.model.id ? () => { setEditing(null); trigger.current?.focus(); setRemoving(current.model); } : undefined}
      settings={settings} onSaved={async () => { setEditing(null); trigger.current?.focus(); setNotice("配置已保存，未发起生成调用。"); await load(); try { await onCatalogRefresh(); } catch { setError("配置已保存，但工作台状态刷新失败，请刷新页面。"); } }}
      onClose={() => { setEditing(null); trigger.current?.focus(); void load(); }} /> : null}
  </>;
}

// 连接编辑（含新建）与型号能力编辑：Key 共用一份，型号级字段按身份校验推理档位。
// 不再承担“选择型号”或设默认——当前/备选由面板主视图管理。
function ConnectionEditor({ mode, connectionId, modelId, settings, onSaved, onClose, onRemoveCurrent }: {
  mode: "connection" | "model"; connectionId: string | null; modelId: string | null;
  settings: ProviderConnectionSettings; onSaved: () => Promise<void>; onClose: () => void; onRemoveCurrent?: (() => void) | undefined;
}) {
  const blank = (): ProviderConnection => ({ id: `provider-${crypto.randomUUID()}`, name: "", protocol: "openai", baseUrl: "", apiKey: null, enabled: true, models: [] });
  const [connection, setConnection] = useState<ProviderConnection>(() => settings.connections.find(item => item.id === connectionId) ?? blank());
  const [creating, setCreating] = useState(!connectionId);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<SaveProviderConnection | null>(null);
  const [switchRequest, setSwitchRequest] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; dialog.current?.querySelector<HTMLInputElement>("input")?.focus(); return () => { active.current = false; }; }, []);
  const model = mode === "model" ? connection.models.find(item => item.id === modelId) ?? null : null;
  const savedConnection = settings.connections.find(item => item.id === connection.id) ?? null;
  const dirty = savedConnection !== null && JSON.stringify(connection) !== JSON.stringify(savedConnection);
  // 身份（协议 + 型号级有效地址）改动后，旧 GET 能力不能继续冒充新接口已核实能力；
  // 保存仍按新身份校验，成功后由 onSaved 重读。未保存的新型号同样按未核实处理。
  const savedModel = savedConnection?.models.find(item => item.id === modelId);
  const identityChanged = mode !== "model" ? false : !savedConnection || !savedModel || connection.protocol !== savedConnection.protocol
    || (model?.baseUrl ?? connection.baseUrl) !== (savedModel.baseUrl ?? savedConnection.baseUrl);
  const capability = identityChanged || !modelId ? null : settings.modelStatuses.find(item => item.modelEntryId === modelId)?.thinking ?? null;
  const thinkingLevel = model?.thinkingLevel ?? "default";
  const change = (patch: Partial<ProviderConnection>) => { setConnection(value => ({ ...value, ...patch })); setPending(null); setNotice(""); };
  const changeModel = (patch: Partial<ConnectionModel>) => {
    if (!model) return;
    change({ models: connection.models.map(item => item.id === model.id ? { ...item, ...patch } : item) });
  };
  const switchTo = (id: string) => {
    const next = settings.connections.find(item => item.id === id);
    if (!next) return;
    setSwitchRequest(null); setNotice(""); setCreating(false);
    setConnection(next);
  };
  const requestSwitch = (id: string) => {
    if (id === connection.id && !creating) return;
    if (id === NEW_CONNECTION) {
      if (dirty || creating) { setSwitchRequest(id); setNotice(""); return; }
      setCreating(true); setConnection(blank()); setNotice("");
      return;
    }
    if (creating || dirty) { setSwitchRequest(id); setNotice(""); return; }
    switchTo(id);
  };
  const close = () => { if (!busy) onClose(); };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(':is(button, input, select, textarea):not(:disabled)')];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const submit = async () => {
    if (busy || conflict) return;
    const body = pending ?? { commandId: agentApi.newCommandId(), expectedRevision: settings.revision, connection };
    setBusy(true); setNotice("");
    try { await agentApi.saveProviderConnection(body); if (active.current) await onSaved(); }
    catch (fault) {
      if (!active.current) return;
      if (fault instanceof AgentApiError) { setPending(null); setConflict(fault.payload.code === "STALE_REVISION"); setNotice(fault.message); }
      else { setPending(body); setNotice("保存结果未知，请重试同一命令。"); }
    } finally { if (active.current) setBusy(false); }
  };
  return <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div className="agent-modal agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-editor-title" ref={dialog} onKeyDown={keys}>
    <header className="agent-modal-header"><div><h3 id="connection-editor-title">{mode === "model" ? "配置型号" : creating ? "添加连接" : "连接配置"}</h3>
      {mode === "model" ? <p>共用 {connection.name} 的 Key</p> : <p>同一连接的型号共用 Key · 保存不发起调用</p>}</div>
      <button className="agent-icon-button" aria-label="关闭配置" disabled={busy} onClick={close}><X aria-hidden="true" /></button></header>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}><fieldset disabled={busy || conflict || pending !== null} className="agent-connection-fields">
      {mode === "model" && model ? <>
        <label className="agent-config-field">型号名称<input required maxLength={100} value={model.name} onChange={event => changeModel({ name: event.target.value })} /></label>
        <label className="agent-config-field">型号 ID<input value={model.modelId} readOnly /></label>
        {model.kind === "text" ? <div className="agent-connection-capacity"><label className="agent-config-field">上下文窗口（tokens）<input type="number" min={1} value={model.contextWindowTokens ?? ""} readOnly onChange={event => changeModel({ contextWindowTokens: event.target.value ? Number(event.target.value) : null })} /></label><label className="agent-config-field">最大输出（tokens）<input type="number" min={1} value={model.maxOutputTokens ?? ""} onChange={event => changeModel({ maxOutputTokens: event.target.value ? Number(event.target.value) : null })} /></label></div> : <p className="agent-config-note">尚未接入执行参数与报价的型号可以保留为备选，暂不能设为当前。</p>}
        {model.kind === "text" ? <p className="agent-config-note">上下文窗口来自 Pi 精确目录（同步目录勾选时自动带入），只读；最大输出可在该型号上限内调整。</p> : null}
        {model.kind === "text" ? (capability
          ? (capability.levels.length > 1
            ? <label className="agent-config-field">推理<select value={thinkingLevel} onChange={event => changeModel({ thinkingLevel: event.target.value as ThinkingLevel | "default" })}><option value="default">默认（{thinkingLabels[capability.defaultLevel]}）</option>{capability.levels.map(item => <option key={item} value={item}>{thinkingLabels[item]}</option>)}</select></label>
            : null)
          : thinkingLevel !== "default"
            ? <><label className="agent-config-field">推理<select value={thinkingLevel} onChange={event => changeModel({ thinkingLevel: event.target.value as ThinkingLevel | "default" })}><option value="default">默认</option><option value={thinkingLevel}>{thinkingLabels[thinkingLevel]}</option></select></label><p className="agent-config-note">接口或协议已修改，推理能力未核实；保存时按新接口校验。</p></>
            : <p className="agent-config-note">推理能力未核实</p>) : null}
        <label className="agent-config-field">此型号接口地址（可选）<input type="url" value={model.baseUrl ?? ""} placeholder={connection.baseUrl} onChange={event => changeModel({ baseUrl: event.target.value || null })} /></label>
        <label className="agent-config-field">特点与用途<textarea rows={2} value={model.features.join("\n")} onChange={event => changeModel({ features: event.target.value.split("\n") })} placeholder="例如：适合长文、支持工具调用" /></label>
        <label className="agent-config-check"><input type="checkbox" checked={model.enabled} onChange={event => changeModel({ enabled: event.target.checked })} />启用此型号</label>
      </> : <>
        <label className="agent-config-field">使用连接<select value={creating ? NEW_CONNECTION : connection.id} onChange={event => requestSwitch(event.target.value)}>
          {settings.connections.map(item => <option key={item.id} value={item.id}>{item.name}{item.enabled ? "" : "（已停用）"}</option>)}
          <option value={NEW_CONNECTION}>新建连接…</option>
        </select></label>
        <label className="agent-config-field">连接名称<input required maxLength={100} value={connection.name} onChange={event => change({ name: event.target.value })} placeholder="例如：通义千问、我的中转服务" /></label>
        <label className="agent-config-field">接口协议<select value={connection.protocol} onChange={event => change({ protocol: event.target.value as ProviderConnection["protocol"] })}>{[...new Set([connection.protocol, ...NEW_CONNECTION_PROTOCOLS])].map(id => <option key={id} value={id}>{protocols[id]}</option>)}</select></label>
        <label className="agent-config-field">接口地址<input required type="url" value={connection.baseUrl} onChange={event => change({ baseUrl: event.target.value })} placeholder={connection.protocol === "openai" ? "https://api.openai.com/v1" : connection.protocol === "ark" ? "https://ark.cn-beijing.volces.com/api/v3" : connection.protocol === "minimax" ? "https://api.minimax.cn" : connection.protocol === "wan" ? "https://ws.cn-beijing.maas.aliyuncs.com" : "https://供应商地址"} /></label>
        <label className="agent-config-field">API Key<input type="text" value={connection.apiKey ?? ""} onChange={event => change({ apiKey: event.target.value || null })} autoComplete="off" spellCheck={false} placeholder="填写一次，所有已选型号共用" /></label>
        {connection.protocol === "openai" ? <p className="agent-config-note">OpenAI 连接承载文本、图片、配音，三类共用这一份 Key；视频不在此连接。文本容量与推理档位来自 Pi 精确目录，不需要手填。</p> : null}
        <label className="agent-config-check"><input type="checkbox" checked={connection.enabled} onChange={event => change({ enabled: event.target.checked })} />启用此连接</label>
        {connection.models.length ? <p className="agent-config-note">关联 {connection.models.length} 个型号。修改影响后续调用，已开始的制作保留原版本。</p> : null}
      </>}
    </fieldset>
    {notice ? <p role="alert" className="agent-field-error">{notice}</p> : null}
    {switchRequest ? <p role="status" className="agent-config-note">当前连接有未保存的更改。先保存当前编辑，或放弃后切换。
      <button type="button" disabled={busy || conflict || pending !== null} onClick={() => { if (switchRequest === NEW_CONNECTION) { setCreating(true); setConnection(blank()); } else switchTo(switchRequest); setSwitchRequest(null); }}>放弃更改并切换</button>
      <button type="button" disabled={busy || conflict || pending !== null} onClick={() => setSwitchRequest(null)}>继续编辑</button>
    </p> : null}
    {conflict ? <p className="agent-config-note">输入已保留。关闭面板会重新读取配置，再编辑即可，避免覆盖其他页面的改动。</p> : null}
    <footer className="agent-modal-actions">
      {onRemoveCurrent && <button type="button" className="agent-text-link" disabled={busy || conflict || pending !== null} onClick={onRemoveCurrent}>移除当前型号</button>}
      <button type="button" className="agent-secondary-button" disabled={busy} onClick={close}>取消</button><button type="submit" className="agent-primary-button" disabled={busy || conflict}>{busy ? "保存中…" : pending ? "重试保存" : "保存"}</button></footer>
    </form>
  </div></div>;
}
