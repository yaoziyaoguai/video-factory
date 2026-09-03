import { AlertCircle, Check, Copy, LayoutTemplate, Plus, RefreshCw, Save, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StudioProvider, StudioTemplate, StudioTemplateExperimentScorecard } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { providerModelLabel } from "../presentation.js";
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
  const [experiments, setExperiments] = useState<StudioTemplateExperimentScorecard[]>([]);
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [providerError, setProviderError] = useState<string>();
  const [experimentError, setExperimentError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);

  const dirty = useMemo(() => Boolean(draft?.status === "draft" && savedDraft !== JSON.stringify(draft)), [draft, savedDraft]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [catalog, scorecards, providerCatalog] = await Promise.all([studioApi.templates(), studioApi.templateExperiments().catch((caught) => {
        setExperimentError(errorMessage(caught));
        return [];
      }), studioApi.providers().catch((caught) => {
        setProviderError(errorMessage(caught));
        return [];
      })]);
      setTemplates(catalog.templates);
      setExperiments(scorecards);
      setProviders(providerCatalog);
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

  async function createTemplate() {
    if (!createName.trim()) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const result = await studioApi.createTemplate({
        id: `custom-${crypto.randomUUID().slice(0, 12)}`,
        name: createName.trim(),
        ...(createDescription.trim() ? { description: createDescription.trim() } : {}),
        expectedRevision: revision,
      });
      setRevision(result.storeRevision);
      setTemplates((current) => [result.template, ...current]);
      setSelectedId(result.template.id);
      setDraft(result.template);
      setSavedDraft(JSON.stringify(result.template));
      setCreateName("");
      setCreateDescription("");
      setCreateOpen(false);
      setNotice("空白模板已经建立。先调整故事结构与视听方向，再保存或发布。");
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

  function setTemplateModel(providerId: string, modelId: string) {
    if (!draft || draft.status !== "draft") return;
    const modelDefaults = { ...(draft.modelDefaults ?? {}) };
    if (modelId) modelDefaults[providerId] = modelId;
    else delete modelDefaults[providerId];
    setDraft({ ...draft, modelDefaults });
  }

  const modelProviders = providers.filter((provider) => provider.modelProfiles?.length);

  return (
    <main className="page template-studio-page">
      <header className="page-header template-page-header">
        <div><p className="eyebrow">成片方法</p><h1>模板工坊</h1><p className="page-summary">把经过验证的讲述方式、镜头安排与质量规则保存成下一次可以直接使用的视频模板。</p></div>
        <div className="template-header-actions">
          <button className="icon-button" type="button" onClick={refreshTemplates} disabled={loading} title="刷新模板"><RefreshCw size={18} aria-hidden="true" /></button>
          <button className="button button-primary" type="button" onClick={() => { if (confirmDiscard()) setCreateOpen(true); }}><Plus size={17} aria-hidden="true" />新建空白模板</button>
        </div>
      </header>

      {error ? <div className="page-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></div> : null}
      {loading && templates.length === 0 ? <div className="queue-placeholder">正在读取模板目录...</div> : null}
      {templates.length > 0 ? <TemplateGallery templates={templates} selectedId={selectedId} onSelect={select} /> : null}
      {providerError ? <p className="template-editor-notice is-warning" role="status">模型目录暂时不可用：{providerError}。模板内容仍可查看和编辑。</p> : null}

      <section className="template-experiments" aria-label="模板实验评分">
        <div className="section-heading"><div><p className="eyebrow">运行证据</p><h2>模板实验评分</h2></div><span>只统计运行证据，不改写已发布模板</span></div>
        {experimentError ? <p className="template-editor-notice is-warning">评分读取失败：{experimentError}</p> : null}
        <div className="template-scorecard-grid">{experiments.map((scorecard) => <article key={scorecard.templateId}>
          <header><div><strong>{scorecard.templateName}</strong><small>{scorecard.sampleSize} 条样本</small></div><span>{scorecard.metrics.finalApprovalRate === null ? "待样本" : `${scorecard.metrics.finalApprovalRate}% 通过`}</span></header>
          <dl>
            <div><dt>叙事完整</dt><dd>{metricLabel(scorecard.metrics.narrativeCompleteness)}</dd></div>
            <div><dt>视觉匹配</dt><dd>{metricLabel(scorecard.metrics.visualMatch)}</dd></div>
            <div><dt>声音质量</dt><dd>{metricLabel(scorecard.metrics.soundQuality)}</dd></div>
            <div><dt>成本效率</dt><dd>{metricLabel(scorecard.metrics.costEfficiency)}</dd></div>
            <div><dt>人工修订</dt><dd>{scorecard.metrics.manualEditCount} 次</dd></div>
            <div><dt>钩子清晰</dt><dd>{metricLabel(scorecard.metrics.hookClarity)}</dd></div>
          </dl>
          <p>{scorecard.note}</p>
        </article>)}</div>
      </section>

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
              {modelProviders.length ? <section className="template-model-strategy" aria-label="模板模型策略">
                <div className="section-heading"><div><h3>模型策略</h3><p>只覆盖本模板需要固定的模型，其余继承创作设置。</p></div><span>{Object.keys(draft.modelDefaults ?? {}).length} 项覆盖</span></div>
                <div>{modelProviders.map((provider) => {
                  const selectedModelId = draft.modelDefaults?.[provider.id] ?? "";
                  const selected = provider.modelProfiles?.find((model) => model.id === selectedModelId);
                  return <label className="template-model-field" key={provider.id}>
                    <span><strong>{provider.label}</strong><small>{selected ? "模板覆盖" : "继承创作设置"}</small></span>
                    <select aria-label={`${provider.label} 模板模型`} value={selectedModelId} disabled={draft.status !== "draft"} onChange={(event) => setTemplateModel(provider.id, event.target.value)}>
                      <option value="">继承创作设置 · {providerModelLabel(provider, provider.defaultModelId)}</option>
                      {provider.modelProfiles?.map((model) => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{model.recommended ? " · 推荐" : ""}{model.available ? "" : " · 当前不可用"}</option>)}
                    </select>
                    <small>{selected?.description ?? "创建任务时仍可对本次制作单独覆盖。"}</small>
                  </label>;
                })}</div>
              </section> : null}
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
                <button className="button button-primary" type="button" disabled={saving} onClick={() => setPublishConfirmOpen(true)}><Send size={16} aria-hidden="true" />发布新版本</button>
              </>
            ) : (
              <button className="button button-primary" type="button" disabled={saving} onClick={() => void cloneSelected()}><Copy size={16} aria-hidden="true" />创建可编辑副本</button>
            )}
            <span><Check size={14} aria-hidden="true" />预演只展示结构，不会产生费用</span>
          </footer>
        </section>
      ) : null}
      {createOpen ? <div className="dialog-backdrop" role="presentation">
        <section className="reject-dialog create-template-dialog" role="dialog" aria-modal="true" aria-labelledby="create-template-title">
          <header className="dialog-header"><div><p className="eyebrow">新视频模板</p><h2 id="create-template-title">创建空白模板</h2></div><button className="icon-button" type="button" aria-label="关闭" disabled={saving} onClick={() => setCreateOpen(false)}><X size={18} aria-hidden="true" /></button></header>
          <div className="create-template-fields">
            <label className="field"><span>模板名称</span><input autoFocus value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="例如：城市人物微纪录" /></label>
            <label className="field"><span>适用说明</span><textarea rows={3} value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="适合什么题材、观众和表达目标" /></label>
            <p>系统只创建一份可运行的三段式草稿，不调用模型，也不会产生费用。</p>
          </div>
          <footer className="dialog-actions"><button className="button button-secondary" type="button" disabled={saving} onClick={() => setCreateOpen(false)}>取消</button><button className="button button-primary" type="button" disabled={saving || !createName.trim()} onClick={() => void createTemplate()}>{saving ? "正在创建..." : "创建并编辑"}</button></footer>
        </section>
      </div> : null}
      {publishConfirmOpen && draft?.status === "draft" ? <div className="dialog-backdrop" role="presentation">
        <section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-template-title">
          <header className="dialog-header"><div><p className="eyebrow">模板发布</p><h2 id="publish-template-title">确认发布“{draft.name}”</h2></div><button className="icon-button" type="button" aria-label="关闭" disabled={saving} onClick={() => setPublishConfirmOpen(false)}><X size={18} aria-hidden="true" /></button></header>
          <p>发布后，这一版会出现在新制作的模板选择中；已有项目仍使用各自保存的运行快照。{dirty ? "当前未保存修改会先保存，再一起发布。" : ""}</p>
          <footer className="dialog-actions"><button className="button button-secondary" type="button" disabled={saving} onClick={() => setPublishConfirmOpen(false)}>返回检查</button><button className="button button-primary" type="button" disabled={saving} onClick={() => { setPublishConfirmOpen(false); void publishDraft(); }}><Send size={16} aria-hidden="true" />确认发布</button></footer>
        </section>
      </div> : null}
    </main>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function metricLabel(value: number | null): string {
  return value === null ? "待采集" : `${value} 分`;
}
