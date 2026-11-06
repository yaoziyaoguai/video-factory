import { MUSIC_CHART_URLS } from "../../shared/agent/music-charts.js";
import { VIDEO_TOPIC_CHARTS, TIKTOK_CREATIVE_CENTER, GOOGLE_TRENDS } from "../../shared/agent/video-topics.js";
import { ModelConnectionsPanel } from "./ModelConnectionsPanel.js";
import { SkillPackagesPanel } from "./SkillPackagesPanel.js";
import { WorkLibrary } from "./WorkLibrary.js";
import type { SkillPackageMutation } from "../../shared/agent/generated/contracts.js";
import { SavedConfigurationDetails } from "./SavedConfigurationDetails.js";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronRight, Cpu, Film, FolderOpen, Image, Music2, Search, Sparkles, TrendingUp, X } from "lucide-react";
import { agentApi, AgentApiError, type UserProfile, type PexelsSettings, type NewsNowSettings, type KeyedMaterialSettings, type SavePexelsSettings, type SaveNewsNowSettings, type FreeServiceSettings, type SaveFreeServiceSettingsInput } from "./api.js";
import type { Bootstrap, Conversation, SaveUserProfile } from "./api.js";

export type FramePage = "chat" | "models" | "services" | "skills" | "library" | "profile";
export const framePageTitle = { chat: "对话", models: "模型配置", services: "免费服务", skills: "Skill 管理", library: "作品库", profile: "用户页" };
export function FrameSettings({ page, bootstrap, conversations, onConversation, onPage, onLogout, onCatalogRefresh, onSkillMutationChange }: {
  page: FramePage; bootstrap: Bootstrap | null; conversations: Conversation[];
  onConversation: (id: string) => void; onPage: (page: FramePage) => void; onLogout?: (() => Promise<void>) | undefined;
  onCatalogRefresh: () => Promise<void>; onSkillMutationChange?: ((mutation: SkillPackageMutation | null) => void) | undefined;
}) {
  const [skillsVisited, setSkillsVisited] = useState(page === "skills");
  useEffect(() => { if (page === "skills") setSkillsVisited(true); }, [page]);
  return <section className="agent-settings-page" aria-label={framePageTitle[page]} hidden={page === "chat"}><div className="agent-settings-content">
    <header className="agent-settings-heading"><h2>{framePageTitle[page]}</h2>{page === "models" ? <button type="button" className="agent-text-link" onClick={() => onPage("chat")}>返回对话</button> : null}</header>
    {page === "models" ? <ModelConnectionsPanel onCatalogRefresh={onCatalogRefresh} /> : page === "services" ? <ServicesDirectory />
      : page === "library" ? <WorkLibrary /> : page === "profile" ? <ProfileEditor bootstrap={bootstrap} conversations={conversations} onConversation={onConversation} onPage={onPage} onLogout={onLogout} onCatalogRefresh={onCatalogRefresh} /> : null}
    {skillsVisited || page === "skills" ? <div hidden={page !== "skills"}><SkillPackagesPanel visible={page === "skills"} onCatalogRefresh={onCatalogRefresh} onMutationChange={onSkillMutationChange} /></div> : null}
  </div></section>;
}

const SERVICE_CATALOG = [
  { id: "douyin-music", kind: "keyless", name: "抖音热歌榜", description: "看 DataXAPI 热歌排名，按曲名去抖音找同款", kinds: ["audio"], access: "无需密钥", chart: MUSIC_CHART_URLS["douyin-music"] },
  { id: "tiktok-sounds", kind: "keyless", name: "TikTok 热门原声", description: "看 Kabo 公开榜前五首，打开对应的 TikTok 原声", kinds: ["audio"], access: "无需密钥", chart: MUSIC_CHART_URLS["tiktok-sounds"] },
  { id: "pexels", kind: "keyed", name: "Pexels", description: "人物、生活、城市与自然实拍", kinds: ["image", "video"], access: "API Key" },
  { id: "pixabay", kind: "keyed", name: "Pixabay", description: "补充图库画面与创意素材", kinds: ["image", "video"], access: "API Key" },
  { id: "unsplash", kind: "keyed", name: "Unsplash", description: "摄影图片、氛围参考与封面", kinds: ["image"], access: "Access Key" },
  { id: "coverr", kind: "keyed", name: "Coverr", description: "实拍镜头与环境补画面", kinds: ["video"], access: "API Key" },
  { id: "incompetech", kind: "keyless", name: "Incompetech", description: "按曲名、乐器或氛围找配乐，使用时署名 Kevin MacLeod", kinds: ["audio"], access: "无需密钥" },
  { id: "wikimedia", kind: "keyless", name: "Wikimedia Commons", description: "开放影像、乐曲与演唱录音", kinds: ["image", "video", "audio"], access: "无需密钥" },
  { id: "nasa", kind: "keyless", name: "NASA", description: "航天、科学与地球观测", kinds: ["image", "video"], access: "无需密钥" },
  { id: "met", kind: "keyless", name: "The Met", description: "绘画、器物与开放馆藏", kinds: ["image"], access: "无需密钥" },
  { id: "cleveland", kind: "keyless", name: "Cleveland", description: "克里夫兰艺术博物馆 CC0 馆藏", kinds: ["image"], access: "无需密钥" },
  { id: "archive", kind: "keyless", name: "Internet Archive", description: "公有领域与开放许可的历史影像", kinds: ["video"], access: "无需密钥" },
  { id: "freetouse", kind: "keyless", name: "FreeToUse", description: "个人社交平台自制视频的音乐与歌曲，采用前需确认用途并署名", kinds: ["audio"], access: "无需密钥" },
  { id: "newsnow", kind: "newsnow", name: "国内平台榜单", description: "通过 NewsNow 按需查抖音、快手和 B 站，也可自选来源", kinds: ["trend"], access: "实例地址" },
] as const;
const SERVICE_GROUPS = [
  { id: "trend", label: "视频选题", icon: TrendingUp, purpose: "找选题时看平台榜单；核实背景时再联网搜索。", footnote: "" },
  { id: "image", label: "图片素材", icon: Image, purpose: "查找已有图片，补充画面与创作参考。", footnote: "免费来源也有许可和调用限制，采用素材时保留作者与来源；同一来源在各页签共用一份配置。" },
  { id: "video", label: "视频素材", icon: Film, purpose: "查找已有视频，补充镜头与参考。", footnote: "免费来源也有许可和调用限制，采用素材时保留作者与来源；同一来源在各页签共用一份配置。" },
  { id: "audio", label: "音乐素材", icon: Music2, purpose: "查平台热歌，或找有许可、可混入视频的配乐。", footnote: "热歌榜仅提供平台链接。采用曲库音乐时，会保留曲目、作者与许可。" },
] as const;
type ServiceGroup = (typeof SERVICE_GROUPS)[number]["id"];
const SERVICE_KIND_LABELS: Record<ServiceGroup, string> = { trend: "热点", image: "图片", video: "视频", audio: "音乐" };
type ServiceRow = (typeof SERVICE_CATALOG)[number];
type ServiceId = ServiceRow["id"];
type KeyedRow = Extract<ServiceRow, { kind: "keyed" }>;
// Keyed 来源的读写形状：Pexels 与三个新增图库共用 Key + 启停结构，endpoint 只有 Pexels 有。
type KeyedServiceSettings = PexelsSettings | KeyedMaterialSettings;

interface ServiceLoad { phase: "loading" | "ready" | "loadFailed"; settings: FreeServiceSettings | null }

function ServicesDirectory() {
  const [group, setGroup] = useState<ServiceGroup>("image");
  const [query, setQuery] = useState("");
  const [loads, setLoads] = useState<Partial<Record<ServiceId, ServiceLoad>>>({});
  const [configTarget, setConfigTarget] = useState<ServiceRow | null>(null);
  const [notice, setNotice] = useState("");
  const configTrigger = useRef<HTMLButtonElement | null>(null);
  const [toggleSaving, setToggleSaving] = useState(false);
  const [togglePending, setTogglePending] = useState<{ row: ServiceRow; body: SaveFreeServiceSettingsInput } | null>(null);

  const loadService = useCallback(async (id: ServiceId): Promise<boolean> => {
    setLoads(prev => ({ ...prev, [id]: { phase: "loading", settings: null } }));
    try {
      const settings = await agentApi.readFreeServiceSettings(id);
      setLoads(prev => ({ ...prev, [id]: { phase: "ready", settings } }));
      return true;
    } catch {
      setLoads(prev => ({ ...prev, [id]: { phase: "loadFailed", settings: null } }));
      return false;
    }
  }, []);
  useEffect(() => { for (const row of SERVICE_CATALOG) void loadService(row.id); }, [loadService]);

  const loadOf = (id: ServiceId): ServiceLoad => loads[id] ?? { phase: "loading", settings: null };

  const statusOf = (row: ServiceRow): string => {
    const load = loadOf(row.id);
    if (load.phase === "loadFailed") return "读取失败";
    if (load.phase === "loading") return "读取中…";
    return load.settings!.enabled ? "已选用 · 未验证" : load.settings!.revision > 0 ? "已停用" : row.kind === "keyless" ? "未选用" : "未配置";
  };

  // 行开关与配置表单共用既有命令语义：结果未知时保留原体，明确冲突才重读。
  const toggle = async (row: ServiceRow, retry: typeof togglePending = null) => {
    if (toggleSaving) return;
    let request = retry;
    if (!request) {
      const current = loadOf(row.id).settings;
      if (!current) return;
      const enabled = !current.enabled;
      if ("credentialConfigured" in current) {
        if (!current.enabled && !current.credentialConfigured) { setNotice(`首次启用 ${row.name} 需要先在配置里填写 ${row.access}。`); return; }
        request = { row, body: { commandId: agentApi.newCommandId(), expectedRevision: current.revision, enabled, apiKey: null } };
      } else if (current.serviceId === "newsnow") {
        if (!current.enabled && (!current.endpoint || current.sourceIds.length === 0)) { setNotice("启用 NewsNow 需要先在配置里填写实例地址和来源。"); return; }
        request = { row, body: { commandId: agentApi.newCommandId(), expectedRevision: current.revision, enabled, endpoint: current.endpoint, sourceIds: current.sourceIds, topics: current.topics } };
      } else {
        request = { row, body: { commandId: agentApi.newCommandId(), expectedRevision: current.revision, enabled } };
      }
    }
    setToggleSaving(true);
    try {
      const receipt = await agentApi.saveFreeServiceSettings(request.row.id, request.body);
      // 开关回执不带 Key；已读到的 Key 保留给行内展示。
      setLoads(prev => {
        const prior = prev[request.row.id]?.settings ?? null;
        const settings = prior !== null && "apiKey" in prior && prior.apiKey !== undefined && "credentialConfigured" in receipt.settings
          ? { ...receipt.settings, apiKey: prior.apiKey } : receipt.settings;
        return { ...prev, [request.row.id]: { phase: "ready", settings } };
      });
      setTogglePending(null); setNotice("");
    } catch (error) {
      if (error instanceof AgentApiError) {
        setTogglePending(null);
        if (error.payload.code === "STALE_REVISION") {
          const loaded = await loadService(row.id);
          setNotice(loaded ? "设置已被其他页面修改，已重新读取最新状态；请再次操作。" : "设置已被其他页面修改，最新状态读取失败，请重试读取。");
        } else setNotice(error.payload.message);
      } else {
        setTogglePending(request);
        setNotice("保存结果未知，请重试同一命令或读取当前状态。");
      }
    } finally { setToggleSaving(false); }
  };

  const openConfig = (row: ServiceRow, trigger: HTMLButtonElement) => {
    configTrigger.current = trigger;
    setNotice("");
    setConfigTarget(row);
  };
  const closeConfig = () => {
    setConfigTarget(null);
    configTrigger.current?.focus();
  };

  const inGroup = (row: ServiceRow) => row.kinds.some(kind => kind === group);
  const rows = SERVICE_CATALOG.filter(row => inGroup(row)
    && `${row.name} ${row.description} ${row.kinds.map(kind => SERVICE_KIND_LABELS[kind]).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const enabledCount = SERVICE_CATALOG.filter(row => inGroup(row) && loadOf(row.id).settings?.enabled).length;
  const catalog = SERVICE_GROUPS.find(item => item.id === group)!;

  const savedDetails = (row: ServiceRow) => {
    const settings = loadOf(row.id).settings;
    if (!settings) return null;
    if (settings.serviceId === "pexels") return <SavedConfigurationDetails name={row.name} endpoint={settings.endpoint} apiKey={settings.apiKey} />;
    if (settings.serviceId === "newsnow") return settings.endpoint ? <SavedConfigurationDetails name={row.name} endpoint={settings.endpoint} /> : null;
    if ("credentialConfigured" in settings) return <SavedConfigurationDetails name={row.name} apiKey={settings.apiKey ?? null} />;
    return null;
  };

  return <>
    <div className="agent-settings-toolbar agent-services-toolbar">
      <div className="agent-settings-tabs" role="tablist" aria-label="服务类型">{SERVICE_GROUPS.map(item => <button type="button" role="tab" aria-selected={group === item.id} key={item.id} onClick={() => { setGroup(item.id); setQuery(""); }}><item.icon aria-hidden="true" />{item.label}</button>)}</div>
      <label className="agent-settings-search"><Search aria-hidden="true" /><input aria-label="搜索服务" placeholder="搜索名称或用途" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <p className="agent-category-context">{catalog.purpose}<span>{enabledCount} 个来源已选用</span></p>
    {notice ? <p className="agent-field-error" role="alert">{notice}</p> : null}
    {togglePending ? <div className="agent-inline-actions"><button type="button" disabled={toggleSaving} onClick={() => void toggle(togglePending.row, togglePending)}>重试保存</button><button type="button" disabled={toggleSaving} onClick={async () => {
      const loaded = await loadService(togglePending.row.id);
      if (loaded) { setTogglePending(null); setNotice(""); }
    }}>读取当前状态</button></div> : null}
    <div className="agent-service-list">
      <div className="agent-service-heading" aria-hidden="true"><span>服务与用途</span><span>内容</span><span>接入方式</span><span>允许 Agent 使用</span><span></span></div>
      {rows.map(row => { const load = loadOf(row.id); return <article className="agent-service-row" key={row.id} data-service-id={row.id}>
        <div className="agent-service-identity"><catalog.icon aria-hidden="true" />
          <div><h3>{row.name}</h3><p>{row.description}</p></div></div>
        <div className="agent-service-types">{row.kinds.map(kind => <span key={kind}>{"chart" in row ? "热歌榜" : SERVICE_KIND_LABELS[kind]}</span>)}</div>
        <span className="agent-service-access">{row.access}</span>
        <div className="agent-service-toggle"><button type="button" role="switch" aria-checked={load.settings?.enabled ?? false} aria-label={`允许 Agent 使用 ${row.name}`} disabled={toggleSaving || Boolean(togglePending) || load.phase !== "ready"} onClick={() => void toggle(row)}><span></span></button></div>
        <div className="agent-service-actions">
          {row.kind !== "keyless" ? <button type="button" className="agent-model-config-button" aria-label={`配置 ${row.name}`} disabled={toggleSaving || Boolean(togglePending)} onClick={event => openConfig(row, event.currentTarget)}>配置<ChevronRight aria-hidden="true" /></button> : null}
          {"chart" in row ? <a className="agent-text-link" href={row.chart} target="_blank" rel="noreferrer" aria-label={`查看${row.name}`}>查看榜单 ↗</a> : null}
          <small>{statusOf(row)}</small>
          {load.phase === "loadFailed" ? <button type="button" className="agent-text-link" onClick={() => void loadService(row.id)}>重试读取</button> : null}
        </div>
        {savedDetails(row)}
      </article>; })}
    </div>
    {!rows.length ? <div className="agent-settings-empty"><Search aria-hidden="true" /><h3>没有匹配的服务</h3><button type="button" onClick={() => setQuery("")}>清除搜索</button></div> : null}
    <p className="agent-service-footnote">{group === "trend" ? <>海外选题参考：<a href={TIKTOK_CREATIVE_CENTER} target="_blank" rel="noreferrer">TikTok 热门标签与视频 ↗</a>{" · "}<a href={GOOGLE_TRENDS} target="_blank" rel="noreferrer">Google 地区搜索热度 ↗</a></> : catalog.footnote}</p>
    {configTarget?.kind === "newsnow" ? <NewsNowConfigDialog onClose={closeConfig} onSaved={settings => setLoads(prev => ({ ...prev, newsnow: { phase: "ready", settings } }))} /> : null}
    {configTarget?.kind === "keyed" ? <KeyedServiceConfigDialog row={configTarget} onClose={closeConfig} onSaved={() => void loadService(configTarget.id)} /> : null}
  </>;
}

// Keyed 素材来源配置面板：只编辑启用与 Key；endpoint 仅 Pexels 且固定只读。读取失败不出表单；
// 冲突重读不覆盖输入；响应不明同命令重试；关闭清 Key。
function KeyedServiceConfigDialog({ row, onClose, onSaved }: { row: KeyedRow; onClose: () => void; onSaved: () => void }) {
  const [phase, setPhase] = useState<"loading" | "loadFailed" | "editing">("loading");
  const [settings, setSettings] = useState<KeyedServiceSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<SavePexelsSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictReadFailed, setConflictReadFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const keyInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setPhase("loading"); setNotice(""); setPending(null);
    try {
      const value = await agentApi.readFreeServiceSettings(row.id) as KeyedServiceSettings;
      setSettings(value); setEnabled(value.enabled); setApiKey(value.apiKey ?? ""); setKeyError("");
      setPhase("editing");
    } catch { setPhase("loadFailed"); }
  }, [row.id]);
  useEffect(() => { void load(); }, [load]);
  // 编辑表单挂载后聚焦首字段；microtask 会在 React 提交前执行而取不到 ref。
  useEffect(() => { if (phase === "editing") keyInput.current?.focus(); }, [phase]);

  const close = () => { active.current = false; setApiKey(""); setPending(null); onClose(); };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const focusables = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])');
    if (!focusables?.length) return;
    const first = focusables[0]!, last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const editKey = (value: string) => { setApiKey(value); setPending(null); setNotice(""); setKeyError(""); };
  const readConflict = async () => {
    setConflict(true);
    try {
      setSettings(await agentApi.readFreeServiceSettings(row.id) as KeyedServiceSettings); setConflictReadFailed(false);
      setNotice("设置已被其他页面修改；你的输入已保留，请对照当前配置后再次保存。");
    } catch { setConflictReadFailed(true); setNotice("设置已被其他页面修改，但最新状态读取失败。"); }
  };

  const submit = async (retry: typeof pending) => {
    if (!settings || saving || conflictReadFailed) return;
    if (enabled && !settings.credentialConfigured && !apiKey.trim()) { setKeyError(`首次启用 ${row.name} 必须填写 ${row.access}。`); return; }
    const body = retry ?? { commandId: agentApi.newCommandId(), expectedRevision: settings.revision, enabled, apiKey: apiKey.trim() || null };
    setSaving(true);
    dialog.current?.querySelector<HTMLButtonElement>('button[aria-label="关闭配置"]')?.focus();
    try {
      await agentApi.saveFreeServiceSettings(row.id, body);
      if (!active.current) return;
      setPending(null); setApiKey("");
      onSaved();
      onClose();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AgentApiError) {
        setPending(null);
        if (error.payload.code === "STALE_REVISION") await readConflict();
        else setNotice(error.payload.message);
      } else {
        setPending(body);
        setNotice("保存结果未知，可重试同一命令；修改表单将生成新命令。");
      }
    } finally { setSaving(false); }
  };

  return <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="agent-modal agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby={`${row.id}-config-title`} ref={dialog} onKeyDown={onKeyDown}>
      <header className="agent-modal-header">
        <div><h3 id={`${row.id}-config-title`}>配置 {row.name}</h3><p>Key 保存在本机，可在此查看与编辑 · 保存不发起调用</p></div>
        <button type="button" className="agent-icon-button" aria-label="关闭配置" onClick={close}><X aria-hidden="true" /></button>
      </header>
      {phase === "loading" ? <p className="agent-config-note">正在读取配置…</p> : phase === "loadFailed" ? <div className="agent-config-note">
        <p>配置读取失败，无法编辑。</p><button type="button" onClick={() => void load()}>重试读取</button>
      </div> : <form onSubmit={event => { event.preventDefault(); void submit(pending); }}>
        <label className="agent-config-check"><input disabled={saving} type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setPending(null); setNotice(""); }} /><span>允许 Agent 使用这个来源</span></label>
        <div className="agent-config-field">
          <label htmlFor={`${row.id}-config-key`}>{row.access}</label>
          <input disabled={saving} id={`${row.id}-config-key`} type="text" value={apiKey} onChange={event => editKey(event.target.value)} autoComplete="off" spellCheck={false} ref={keyInput}
            placeholder={settings?.credentialConfigured ? "已保存，留空保持不变" : "必填"} aria-invalid={Boolean(keyError)} aria-describedby={keyError ? `${row.id}-config-key-error` : undefined} />
          {keyError ? <span className="agent-field-error" id={`${row.id}-config-key-error`} role="alert">{keyError}</span> : null}
        </div>
        {settings?.serviceId === "pexels" ? <div className="agent-config-field">
          <label htmlFor={`${row.id}-config-endpoint`}>服务地址（固定）</label>
          <input disabled={saving} id={`${row.id}-config-endpoint`} value={settings.endpoint ?? "https://api.pexels.com/v1"} readOnly aria-readonly="true" />
        </div> : null}
        <p className="agent-config-summary">停用只阻止新的检索与采用，历史产物仍可查看；保存不搜索、不测试连接。采用素材时保留作者与来源。</p>
        {notice ? <p className="agent-field-error" role="alert">{notice}</p> : null}
        {conflict && !conflictReadFailed ? <aside className="agent-config-note" aria-label={`当前已保存 ${row.name} 配置`}><strong>当前已保存</strong><p>{settings?.enabled ? "已选用" : "已停用"} · {settings?.credentialConfigured ? "Key 已保存" : "未配置 Key"}</p></aside> : null}
        {conflictReadFailed ? <button type="button" onClick={() => void readConflict()}>重试读取最新配置</button> : null}
        <footer className="agent-modal-actions">
          <button type="button" className="agent-secondary-button" onClick={close}>取消</button>
          <button type="submit" className="agent-primary-button" disabled={saving || conflictReadFailed}>{pending ? "重试保存" : saving ? "保存中…" : "保存"}</button>
        </footer>
      </form>}
    </div>
  </div>;
}

// NewsNow 配置面板：实例地址 + 已配置来源 + 关注主题 + 启用。停用可保留配置；
// 启用必须有实例和 1–5 个来源；地址是用户明确填写的 http(s) 自托管实例。
function NewsNowConfigDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (settings: NewsNowSettings) => void }) {
  const [phase, setPhase] = useState<"loading" | "loadFailed" | "editing">("loading");
  const [settings, setSettings] = useState<NewsNowSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [sourceIds, setSourceIds] = useState("");
  const [topics, setTopics] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<SaveNewsNowSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictReadFailed, setConflictReadFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const endpointInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setPhase("loading"); setNotice(""); setPending(null);
    try {
      const value = await agentApi.readFreeServiceSettings("newsnow") as NewsNowSettings;
      setSettings(value); setEnabled(value.enabled);
      setEndpoint(value.endpoint ?? ""); setSourceIds(value.sourceIds.join("、")); setTopics(value.topics.join("、")); setErrors({});
      setPhase("editing");
    } catch { setPhase("loadFailed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // 编辑表单挂载后聚焦首字段；microtask 会在 React 提交前执行而取不到 ref。
  useEffect(() => { if (phase === "editing") endpointInput.current?.focus(); }, [phase]);

  const close = () => { active.current = false; setPending(null); onClose(); };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const focusables = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])');
    if (!focusables?.length) return;
    const first = focusables[0]!, last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const edit = (setter: (value: string) => void) => (value: string) => { setter(value); setPending(null); setNotice(""); };
  const readConflict = async () => {
    setConflict(true);
    try {
      setSettings(await agentApi.readFreeServiceSettings("newsnow") as NewsNowSettings); setConflictReadFailed(false);
      setNotice("设置已被其他页面修改；你的输入已保留，请对照当前配置后再次保存。");
    } catch { setConflictReadFailed(true); setNotice("设置已被其他页面修改，但最新状态读取失败。"); }
  };

  const submit = async (retry: typeof pending) => {
    if (!settings || saving || conflictReadFailed) return;
    const parsedSources = sourceIds.split(/[、,，\s]+/).map(item => item.trim()).filter(Boolean);
    const parsedTopics: string[] = [];
    for (const item of topics.split(/[、,，]/)) {
      const topic = item.trim();
      if (topic && !parsedTopics.includes(topic)) parsedTopics.push(topic);
    }
    const fieldErrors: Record<string, string> = {};
    if (parsedSources.length > 5) fieldErrors.sourceIds = "来源 ID 最多 5 个。";
    if (parsedSources.some(item => item.length > 80 || !/^[A-Za-z0-9_-]+$/.test(item))) fieldErrors.sourceIds = "来源 ID 只能是字母、数字、下划线或连字符，最长 80。";
    if (parsedTopics.length > 10) fieldErrors.topics = "关注主题最多 10 个。";
    if (parsedTopics.some(item => item.length > 80)) fieldErrors.topics = "每个主题最多 80 个字符。";
    const trimmedEndpoint = endpoint.trim() || null;
    if (trimmedEndpoint) {
      try {
        const url = new URL(trimmedEndpoint);
        if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
          fieldErrors.endpoint = "实例地址必须是不带用户名、查询参数或锚点的 http(s) 地址。";
        }
      } catch { fieldErrors.endpoint = "实例地址不是有效的 URL。"; }
    }
    if (enabled && (!trimmedEndpoint || parsedSources.length === 0)) fieldErrors.enabled = "启用 NewsNow 需要实例地址和 1–5 个来源 ID。";
    if (!enabled && trimmedEndpoint === null && parsedSources.length > 0) fieldErrors.sourceIds = "未填写实例地址时不能保留来源列表。";
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;
    const body = retry ?? { commandId: agentApi.newCommandId(), expectedRevision: settings.revision, enabled, endpoint: trimmedEndpoint, sourceIds: parsedSources, topics: parsedTopics };
    setSaving(true);
    dialog.current?.querySelector<HTMLButtonElement>('button[aria-label="关闭配置"]')?.focus();
    try {
      const receipt = await agentApi.saveFreeServiceSettings("newsnow", body);
      if (!active.current) return;
      setPending(null);
      onSaved(receipt.settings as NewsNowSettings);
      onClose();
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AgentApiError) {
        setPending(null);
        if (error.payload.code === "STALE_REVISION") await readConflict();
        else setNotice(error.payload.message);
      } else {
        setPending(body);
        setNotice("保存结果未知，可重试同一命令；修改表单将生成新命令。");
      }
    } finally { setSaving(false); }
  };

  return <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="agent-modal agent-config-dialog" role="dialog" aria-modal="true" aria-labelledby="newsnow-config-title" ref={dialog} onKeyDown={onKeyDown}>
      <header className="agent-modal-header">
        <div><h3 id="newsnow-config-title">配置 国内平台榜单</h3><p>通过 NewsNow 读取所选榜单，保存时不会抓取。</p></div>
        <button type="button" className="agent-icon-button" aria-label="关闭配置" onClick={close}><X aria-hidden="true" /></button>
      </header>
      {phase === "loading" ? <p className="agent-config-note">正在读取配置…</p> : phase === "loadFailed" ? <div className="agent-config-note">
        <p>配置读取失败，无法编辑。</p><button type="button" onClick={() => void load()}>重试读取</button>
      </div> : <form onSubmit={event => { event.preventDefault(); void submit(pending); }}>
        <label className="agent-config-check"><input disabled={saving} type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setPending(null); setNotice(""); }} /><span>允许 Agent 使用这个来源</span></label>
        {errors.enabled ? <span className="agent-field-error" role="alert">{errors.enabled}</span> : null}
        <div className="agent-config-field">
          <label htmlFor="newsnow-config-endpoint">实例地址</label>
          <input disabled={saving} id="newsnow-config-endpoint" value={endpoint} onChange={event => edit(setEndpoint)(event.target.value)} ref={endpointInput} autoComplete="off" placeholder="https://your-newsnow.example" aria-invalid={Boolean(errors.endpoint)} aria-describedby={errors.endpoint ? "newsnow-config-endpoint-error" : undefined} />
          {errors.endpoint ? <span className="agent-field-error" id="newsnow-config-endpoint-error" role="alert">{errors.endpoint}</span> : null}
        </div>
        <div className="agent-config-field">
          <label htmlFor="newsnow-config-sources">已配置来源 ID（顿号分隔，1–5 个）</label>
          <input disabled={saving} id="newsnow-config-sources" value={sourceIds} onChange={event => edit(setSourceIds)(event.target.value)} autoComplete="off" placeholder="例如 douyin" aria-invalid={Boolean(errors.sourceIds)} aria-describedby={errors.sourceIds ? "newsnow-config-sources-error" : undefined} />
          <button type="button" className="agent-text-link" disabled={saving} onClick={() => edit(setSourceIds)(Object.keys(VIDEO_TOPIC_CHARTS).join("、"))}>填入抖音、快手和 B 站榜单</button>
          {errors.sourceIds ? <span className="agent-field-error" id="newsnow-config-sources-error" role="alert">{errors.sourceIds}</span> : null}
        </div>
        <div className="agent-config-field">
          <label htmlFor="newsnow-config-topics">关注主题（顿号分隔，最多 10 个）</label>
          <input disabled={saving} id="newsnow-config-topics" value={topics} onChange={event => edit(setTopics)(event.target.value)} autoComplete="off" placeholder="人工智能、科技、生活方式" aria-invalid={Boolean(errors.topics)} aria-describedby={errors.topics ? "newsnow-config-topics-error" : undefined} />
          {errors.topics ? <span className="agent-field-error" id="newsnow-config-topics-error" role="alert">{errors.topics}</span> : null}
        </div>
        <p className="agent-config-summary">只有你想看趋势时才会读取。榜单保留来源和链接，不能当作已核实的新闻。</p>
        {notice ? <p className="agent-field-error" role="alert">{notice}</p> : null}
        {conflict && !conflictReadFailed ? <aside className="agent-config-note" aria-label="当前已保存 NewsNow 配置"><strong>当前已保存</strong><p>{settings?.enabled ? "已选用" : "已停用"} · {settings?.endpoint ?? "未配置地址"}</p><p>来源：{settings?.sourceIds.join("、") || "未配置"}</p><p>主题：{settings?.topics.join("、") || "未设置"}</p></aside> : null}
        {conflictReadFailed ? <button type="button" onClick={() => void readConflict()}>重试读取最新配置</button> : null}
        <footer className="agent-modal-actions">
          <button type="button" className="agent-secondary-button" onClick={close}>取消</button>
          <button type="submit" className="agent-primary-button" disabled={saving || conflictReadFailed}>{pending ? "重试保存" : saving ? "保存中…" : "保存"}</button>
        </footer>
      </form>}
    </div>
  </div>;
}

// T2 用户页：资料保存在服务端（owner 一张），保存后 Bootstrap 展示名同步；不重建聊天。
function ProfileEditor({ bootstrap, conversations, onConversation, onPage, onLogout, onCatalogRefresh }: {
  bootstrap: Bootstrap | null; conversations: Conversation[]; onConversation: (id: string) => void;
  onPage: (page: FramePage) => void; onLogout?: (() => Promise<void>) | undefined; onCatalogRefresh: () => Promise<void>;
}) {
  const [phase, setPhase] = useState<"loading" | "loadFailed" | "editing">("loading");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [nameError, setNameError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<SaveUserProfile | null>(null);
  const [conflict, setConflict] = useState(false);
  const [conflictReadFailed, setConflictReadFailed] = useState(false);
  const [catalogRefreshFailed, setCatalogRefreshFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setPhase("loading"); setNotice(""); setPending(null);
    try {
      const value = await agentApi.readUserProfile();
      setProfile(value); setName(value.displayName); setBio(value.bio); setNameError("");
      setPhase("editing");
    } catch { setPhase("loadFailed"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // 编辑表单挂载后聚焦首字段；microtask 会在 React 提交前执行而取不到 ref。
  useEffect(() => { if (phase === "editing") nameInput.current?.focus(); }, [phase]);

  const readConflict = async () => {
    try {
      setProfile(await agentApi.readUserProfile()); setConflictReadFailed(false);
      setNotice("资料已被其他页面修改；你的输入已保留，请对照当前资料后再次保存。");
    } catch { setConflictReadFailed(true); setNotice("资料已被其他页面修改，但最新状态读取失败。"); }
  };
  const refreshProfileDisplay = async () => {
    try { await onCatalogRefresh(); setCatalogRefreshFailed(false); }
    catch { setCatalogRefreshFailed(true); }
  };

  const editName = (value: string) => { setName(value); setPending(null); setNotice(""); };
  const editBio = (value: string) => { setBio(value); setPending(null); setNotice(""); };

  const submit = async (retry: SaveUserProfile | null) => {
    if (!profile || saving || conflictReadFailed || catalogRefreshFailed) return;
    const trimmedName = name.trim();
    if (!trimmedName) { setNameError("请填写显示名称。"); return; }
    if (trimmedName.length > 80) { setNameError("显示名称最多 80 个字符。"); return; }
    if (bio.length > 500) { setNotice("个人简介最多 500 个字符。"); return; }
    const body = retry ?? { commandId: agentApi.newCommandId(), expectedRevision: profile.revision, displayName: trimmedName, bio };
    setSaving(true);
    try {
      const receipt = await agentApi.saveUserProfile(body);
      setProfile(receipt.profile); setPending(null); setConflict(false);
      setNotice("个人资料已保存。");
      await refreshProfileDisplay();
    } catch (error) {
      if (error instanceof AgentApiError) {
        setPending(null);
        if (error.payload.code === "STALE_REVISION") {
          setConflict(true);
          await readConflict();
        } else setNotice(error.payload.message);
      } else {
        setPending(body);
        setNotice("保存结果未知，可重试同一命令；修改表单将生成新命令。");
      }
    } finally { setSaving(false); }
  };

  return <div className="agent-profile-layout">
    <article className="agent-profile-card">
      <div className="agent-profile-heading"><span className="agent-profile-avatar">{(name.trim() || bootstrap?.displayName || "创").slice(0, 1)}</span><div><h3>{name.trim() || bootstrap?.displayName || "创作者"}</h3><p>你的创作空间</p></div></div>
      {phase === "loading" ? <p className="agent-settings-note">正在读取资料…</p> : phase === "loadFailed" ? <div className="agent-config-note"><p>资料读取失败，无法编辑。</p><button type="button" onClick={() => void load()}>重试读取</button></div>
        : <form onSubmit={event => { event.preventDefault(); void submit(pending); }}>
          <label htmlFor="profile-name">显示名称<input disabled={saving} id="profile-name" value={name} onChange={event => editName(event.target.value)} ref={nameInput} maxLength={80} autoComplete="off" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "profile-name-error" : undefined} /></label>
          {nameError ? <span className="agent-field-error" id="profile-name-error" role="alert">{nameError}</span> : null}
          <label htmlFor="profile-bio">个人简介<textarea disabled={saving} id="profile-bio" value={bio} onChange={event => editBio(event.target.value)} rows={4} maxLength={500} placeholder="一句话介绍你自己，只显示在用户页" /></label>
          <p className="agent-category-context">显示名称同步到侧栏；简介只在用户页，不进入模型上下文。</p>
          {notice ? <p className="agent-field-error" role="alert">{notice}</p> : null}
          {conflict && !conflictReadFailed ? <aside className="agent-config-note" aria-label="当前已保存资料"><strong>当前已保存</strong><p>{profile?.displayName}</p><p>{profile?.bio || "未填写简介"}</p></aside> : null}
          {conflictReadFailed ? <button type="button" onClick={() => void readConflict()}>重试读取最新资料</button> : null}
          {catalogRefreshFailed ? <p className="agent-config-note" role="status">资料已保存，侧栏刷新失败。<button type="button" onClick={() => void refreshProfileDisplay()}>重试读取</button></p> : null}
          <footer className="agent-modal-actions">
            <button type="submit" className="agent-primary-button" disabled={saving || conflictReadFailed || catalogRefreshFailed}>{pending ? "重试保存" : saving ? "保存中…" : "保存"}</button>
          </footer>
        </form>}
      {onLogout ? <button className="agent-secondary-button" type="button" onClick={() => void onLogout()}>退出登录</button> : null}
    </article>
    <div className="agent-profile-overview"><h3>接着聊</h3>{conversations.slice(0, 3).map(conversation => <button type="button" key={conversation.id} onClick={() => onConversation(conversation.id)}>{conversation.title}<ChevronRight aria-hidden="true" /></button>)}<button type="button" onClick={() => onPage("models")}><Cpu aria-hidden="true" />模型配置<ChevronRight aria-hidden="true" /></button><button type="button" onClick={() => onPage("services")}><FolderOpen aria-hidden="true" />免费服务<ChevronRight aria-hidden="true" /></button><button type="button" onClick={() => onPage("skills")}><Sparkles aria-hidden="true" />Skill 管理<ChevronRight aria-hidden="true" /></button></div>
  </div>;
}
