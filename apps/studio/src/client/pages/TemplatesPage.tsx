import { AlertCircle, Check, Copy, LayoutTemplate, RefreshCw, Save, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StudioTemplate } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { TemplateGallery } from "../templates/TemplateGallery.js";

export function TemplatesPage() {
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState("knowledge-explainer");
  const [draft, setDraft] = useState<StudioTemplate>();
  const [savedDraft, setSavedDraft] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const dirty = useMemo(() => Boolean(draft?.status === "draft" && savedDraft !== JSON.stringify(draft)), [draft, savedDraft]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const catalog = await studioApi.templates();
      setTemplates(catalog.templates);
      setRevision(catalog.storeRevision);
      const selected = catalog.templates.find((template) => template.id === selectedId) ?? catalog.templates[0];
      if (selected) {
        setSelectedId(selected.id);
        const nextDraft = structuredClone(selected);
        setDraft(nextDraft);
        setSavedDraft(JSON.stringify(nextDraft));
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("当前模板还有未保存修改。放弃修改并继续吗？");
  }

  function refreshTemplates() {
    if (confirmDiscard()) void load();
  }

  function select(template: StudioTemplate) {
    if (template.id !== selectedId && !confirmDiscard()) return;
    setSelectedId(template.id);
    const nextDraft = structuredClone(template);
    setDraft(nextDraft);
    setSavedDraft(JSON.stringify(nextDraft));
    setNotice(undefined);
  }

  async function cloneSelected() {
    if (!draft) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const suffix = crypto.randomUUID().slice(0, 8);
      const result = await studioApi.cloneTemplate({
        sourceId: draft.id,
        newId: `${draft.id}-copy-${suffix}`,
        name: `${draft.name} 副本`,
        expectedRevision: revision,
      });
      setRevision(result.storeRevision);
      setTemplates((current) => [result.template, ...current]);
      setSelectedId(result.template.id);
      setDraft(result.template);
      setSavedDraft(JSON.stringify(result.template));
      setNotice("副本已创建，可以开始调整。原模板不会被修改。");
    } catch (caught) {
      setNotice(`创建失败：${errorMessage(caught)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (!draft || draft.status !== "draft") return;
    setSaving(true);
    setNotice(undefined);
    try {
      const result = await studioApi.saveTemplateDraft(draft, revision);
      setRevision(result.storeRevision);
      setDraft(result.template);
      setSavedDraft(JSON.stringify(result.template));
      setTemplates((current) => current.map((template) => template.id === result.template.id ? result.template : template));
      setNotice("模板草稿已保存。");
    } catch (caught) {
      setNotice(`保存失败：${errorMessage(caught)}`);
    } finally {
      setSaving(false);
    }
  }

  async function publishDraft() {
    if (!draft || draft.status !== "draft") return;
    setSaving(true);
    setNotice(undefined);
    try {
      let publishRevision = revision;
      if (dirty) {
        const saved = await studioApi.saveTemplateDraft(draft, publishRevision);
        publishRevision = saved.storeRevision;
      }
      const result = await studioApi.publishTemplate(draft.id, publishRevision);
      setRevision(result.storeRevision);
      setDraft(result.template);
      setSavedDraft(JSON.stringify(result.template));
      setTemplates((current) => current.map((template) => template.id === result.template.id ? result.template : template));
      setNotice("新版本已发布；已有项目继续使用自己的运行快照。");
    } catch (caught) {
      setNotice(`发布失败：${errorMessage(caught)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page template-studio-page">
      <header className="page-header template-page-header">
        <div><p className="eyebrow">Production grammar</p><h1>模板工坊</h1><p className="page-summary">把经过验证的叙事、镜头与质量规则沉淀成下一次可以直接使用的制作语法。</p></div>
        <button className="icon-button" type="button" onClick={refreshTemplates} disabled={loading} title="刷新模板"><RefreshCw size={18} aria-hidden="true" /></button>
      </header>

      {error ? <div className="page-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></div> : null}
      {loading && templates.length === 0 ? <div className="queue-placeholder">正在读取模板目录...</div> : null}
      {templates.length > 0 ? <TemplateGallery templates={templates} selectedId={selectedId} onSelect={select} /> : null}

      {draft ? (
        <section className="template-editor" aria-label="模板编辑器">
          <header className="template-editor-heading">
            <span><LayoutTemplate size={19} aria-hidden="true" /></span>
            <div><p>{draft.category} · v{draft.version}</p><h2>{draft.name}</h2></div>
            <strong>{draft.status === "draft" ? "草稿" : draft.builtIn ? "内置模板" : "已发布"}</strong>
          </header>
          <div className="template-editor-grid">
            <section className="template-editor-copy">
              <label className="field"><span>模板名称</span><input value={draft.name} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
              <label className="field"><span>适用说明</span><textarea rows={3} value={draft.description} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <div className="template-system-fields">
                <label className="field"><span>视觉构图</span><textarea rows={3} value={draft.visualSystem.composition} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, visualSystem: { ...draft.visualSystem, composition: event.target.value } })} /></label>
                <label className="field"><span>色彩意图</span><textarea rows={3} value={draft.visualSystem.colorIntent} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, visualSystem: { ...draft.visualSystem, colorIntent: event.target.value } })} /></label>
                <label className="field"><span>声音角色</span><textarea rows={3} value={draft.soundSystem.voiceIntent} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, soundSystem: { ...draft.soundSystem, voiceIntent: event.target.value } })} /></label>
                <label className="field"><span>音乐策略</span><textarea rows={3} value={draft.soundSystem.musicIntent} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, soundSystem: { ...draft.soundSystem, musicIntent: event.target.value } })} /></label>
              </div>
            </section>
            <section className="template-story-editor">
              <div className="section-heading"><h3>故事结构</h3><span>{draft.storyStructure.length} 个节拍</span></div>
              {draft.storyStructure.map((beat, index) => (
                <div className="template-beat-editor" key={beat.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <label><small>节拍名称</small><input value={beat.label} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, storyStructure: draft.storyStructure.map((item) => item.id === beat.id ? { ...item, label: event.target.value } : item) })} /></label>
                  <label><small>叙事目的</small><textarea rows={2} value={beat.purpose} disabled={draft.status !== "draft"} onChange={(event) => setDraft({ ...draft, storyStructure: draft.storyStructure.map((item) => item.id === beat.id ? { ...item, purpose: event.target.value } : item) })} /></label>
                </div>
              ))}
            </section>
          </div>
          {dirty ? <p className="template-editor-notice is-warning" role="status">有未保存修改</p> : null}
          {notice ? <p className="template-editor-notice" role="status">{notice}</p> : null}
          <footer className="template-editor-actions">
            {draft.status === "draft" ? (
              <>
                <button className="button button-secondary" type="button" disabled={saving} onClick={() => void saveDraft()}><Save size={16} aria-hidden="true" />保存草稿</button>
                <button className="button button-primary" type="button" disabled={saving} onClick={() => void publishDraft()}><Send size={16} aria-hidden="true" />发布新版本</button>
              </>
            ) : (
              <button className="button button-primary" type="button" disabled={saving} onClick={() => void cloneSelected()}><Copy size={16} aria-hidden="true" />创建可编辑副本</button>
            )}
            <span><Check size={14} aria-hidden="true" />预演只展示结构，不调用计费 API</span>
          </footer>
        </section>
      ) : null}
    </main>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
