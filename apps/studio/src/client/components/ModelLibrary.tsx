import { useEffect, useMemo, useState } from "react";
import type { ModelConnection, ModelConnectionInput, ModelUnderstandingCapability } from "@video-factory/production-pipeline";
import type { StudioProvider } from "../../shared/api.js";
import { studioApi } from "../api.js";

type Group = "text" | "generate" | "understand";
interface ModelItem { id: string; label: string; modelId: string; protocol: string; capabilities: string[]; groups: Group[]; available: boolean; custom?: ModelConnection }
const GROUPS: Array<{ id: Group; label: string }> = [
  { id: "text", label: "文本生成" }, { id: "generate", label: "内容生成" }, { id: "understand", label: "内容理解" },
];
const CAPABILITIES = { text: "文本生成", image: "图像理解 / 视频抽帧", audio: "真实音频理解" };

export function modelLibraryItems(providers: StudioProvider[], connections: ModelConnection[]): ModelItem[] {
  const items = new Map<string, ModelItem>();
  for (const provider of providers) {
    if (provider.kind === "test") continue;
    for (const model of provider.modelProfiles ?? []) {
      if (model.id === "codex-default") continue;
      if (connections.some((item) => item.id === model.id)) continue;
      const group: Group = provider.capability === "voice.synthesize" || model.taskTypes.some((type) => ["text-to-image", "text-to-video", "image-to-video", "digital-human"].includes(type)) ? "generate"
        : ["quality.review.visual", "reference.grammar", "asset.rank.semantic"].includes(provider.capability) || model.taskTypes.includes("visual-review") ? "understand" : "text";
      const capability = group === "text" ? "文本生成" : group === "understand" ? "图像理解 / 视频抽帧"
        : provider.capability === "voice.synthesize" ? "语音生成" : model.taskTypes.includes("text-to-image") ? "图片生成" : "视频生成";
      const id = `${model.providerFamily}:${model.id}`;
      const existing = items.get(id);
      if (existing) {
        existing.available ||= model.available;
        existing.groups = [...new Set([...existing.groups, group])];
        existing.capabilities = [...new Set([...existing.capabilities, capability])];
      } else items.set(id, {
        id, label: model.label, modelId: model.id, available: model.available, groups: [group], capabilities: [capability],
        protocol: model.providerFamily === "deepseek" ? "OpenAI Chat Completions（DeepSeek 参数）" : model.providerFamily === "openai" ? "Codex CLI（旧接入）" : "专用供应商接口 / 本地引擎",
      });
    }
  }
  for (const model of connections) items.set(model.id, {
    id: model.id, label: model.label, modelId: model.modelId, available: model.enabled, custom: model,
    protocol: model.protocol === "anthropic-messages" ? "Anthropic Messages" : "OpenAI Chat Completions",
    groups: [...(model.capabilities.includes("text") ? ["text" as const] : []), ...(model.capabilities.some((capability) => capability !== "text") ? ["understand" as const] : [])],
    capabilities: model.capabilities.map((capability) => CAPABILITIES[capability]),
  });
  return [...items.values()];
}

export function ModelLibrary({ providers, onChanged }: { providers: StudioProvider[]; onChanged: () => Promise<void> }) {
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [group, setGroup] = useState<Group>("text");
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    studioApi.models().then(({ models }) => { if (active) { setConnections(models); setReady(true); } })
      .catch(() => { if (active) setError("模型接入管理暂不可用；以下保留当前运行时的模型目录。请更新并启动模型服务后再添加。"); });
    return () => { active = false; };
  }, []);
  const items = useMemo(() => modelLibraryItems(providers, connections), [providers, connections]);
  return <div className="model-library">
    <div className="model-defaults-intro"><div><strong>先接入模型，再让角色选用</strong><p>同一接入可用于多个角色；模型能力与接入协议分别管理。角色默认不锁定本条视频的选择。</p><a href="#production-roles">去设置角色默认</a></div>
      <button type="button" className="button button-primary" disabled={!ready || busy} onClick={() => setFormOpen(!formOpen)}>{formOpen ? "收起添加表单" : "添加模型"}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {formOpen ? <ModelConnectionForm busy={busy} onSave={async (input) => {
      setBusy(true); setError(""); setNotice("");
      try {
        const result = await studioApi.addModel(input);
        setConnections(result.models); setFormOpen(false);
        await onChanged();
        setNotice("模型接入已保存，未发起付费测试。现在可在角色默认或制作中选择；实际能力以执行结果为准。");
      } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败，请重试。"); }
      finally { setBusy(false); }
    }} /> : null}
    <div className="segmented-control" role="group" aria-label="模型能力分类">{GROUPS.map((item) => <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.label}</button>)}</div>
    <h3>{GROUPS.find((item) => item.id === group)!.label}</h3>
    {group === "generate" ? <p>图片、视频、配音沿用已接入的供应商接口。新协议需要适配，不能把文本接口冒充生成接口。</p> : null}
    {group === "understand" ? <p>视频抽帧不等于连续视频理解；真实声音审片必须发送音轨，转写文字不能代替审听。</p> : null}
    <div className="model-default-cards" aria-label="全局模型目录">{items.filter((item) => item.groups.includes(group)).map((item) => <article className="model-default-card" key={item.id}>
      <div><strong>{item.label}</strong><small>{item.modelId}</small></div>
      <p>{item.capabilities.join(" · ")}</p><small>协议：{item.protocol}</small>
      {item.custom ? <small>接口：{item.custom.baseUrl} · 密钥已保存，不回显</small> : null}
      <footer><span>{item.available ? item.custom ? "已配置，未代表实测通过" : "运行时已配置" : "未启用"}</span><span>费用以供应商账号为准</span></footer>
      {item.custom ? <button className="button button-secondary" type="button" disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try {
          setConnections((await (item.custom!.enabled ? studioApi.disableModel(item.id) : studioApi.enableModel(item.id))).models);
          await onChanged(); setNotice("接入状态已更新，原请求记录保留。恢复始终查询原请求，不会改用其他身份重复消费。");
        } catch { setError("更新失败，请刷新后重试。"); } finally { setBusy(false); }
      }}>{item.custom.enabled ? "停用此接入" : "重新启用"}</button> : null}
    </article>)}</div>
    {!items.some((item) => item.groups.includes(group)) ? <p className="model-default-empty">尚未接入这一类模型。</p> : null}
  </div>;
}

function ModelConnectionForm({ busy, onSave }: { busy: boolean; onSave: (input: ModelConnectionInput) => Promise<void> }) {
  const [protocol, setProtocol] = useState<ModelConnectionInput["protocol"]>("openai-chat-completions");
  const [capabilities, setCapabilities] = useState<ModelUnderstandingCapability[]>(["text"]);
  return <form className="configuration-sheet" aria-label="添加模型接入" onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const effort = String(form.get("reasoningEffort") ?? "");
    const budget = String(form.get("thinkingBudget") ?? "");
    void onSave({
      label: String(form.get("label")), protocol, baseUrl: String(form.get("baseUrl")), modelId: String(form.get("modelId")), apiKey: String(form.get("apiKey")),
      capabilities, maxOutputTokens: Number(form.get("maxOutputTokens")),
      ...(effort ? { reasoningEffort: effort as ModelConnectionInput["reasoningEffort"] & string } : {}),
      ...(budget ? { thinkingBudget: Number(budget) } : {}),
    });
  }}><div className="configuration-fields">
    <label className="field"><span>接入名称</span><input name="label" required maxLength={100} placeholder="例如：我的视觉模型" /></label>
    <label className="field"><span>接口协议</span><select value={protocol} onChange={(event) => {
      const next = event.target.value as ModelConnectionInput["protocol"]; setProtocol(next);
      if (next === "anthropic-messages") setCapabilities((current) => current.filter((item) => item !== "audio"));
    }}><option value="openai-chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
    <label className="field"><span>接口根地址（含版本路径）</span><input type="url" name="baseUrl" required placeholder="https://api.example.com/v1" /></label>
    <label className="field"><span>模型 ID（供应商原名）</span><input name="modelId" required maxLength={160} /></label>
    <label className="field"><span>API Key</span><input type="password" name="apiKey" required autoComplete="new-password" maxLength={4096} /></label>
    <label className="field"><span>最大输出长度（token，按模型文档填写）</span><input type="number" name="maxOutputTokens" required min={1} max={262144} /></label>
    {protocol === "openai-chat-completions" ? <label className="field"><span>推理强度（仅填写该接口支持的值）</span><select name="reasoningEffort"><option value="">服务商默认，不发送此参数</option>{["low", "medium", "high", "xhigh", "max"].map((item) => <option key={item}>{item}</option>)}</select></label>
      : <label className="field"><span>推理预算（Thinking budget，留空使用服务商默认）</span><input type="number" name="thinkingBudget" min={1024} /></label>}
  </div><fieldset><legend>模型实际支持的能力</legend>{(Object.keys(CAPABILITIES) as ModelUnderstandingCapability[]).map((capability) => <label key={capability}>
    <input type="checkbox" checked={capabilities.includes(capability)} disabled={capability === "audio" && protocol === "anthropic-messages"} onChange={(event) => setCapabilities((current) => event.target.checked ? [...current, capability] : current.filter((item) => item !== capability))} />{CAPABILITIES[capability]}
  </label>)}</fieldset><p>勾选是你的能力声明，不等于已实测。成片声音审片需同时支持音频与图像输入，以便判断音画配合；Anthropic 此适配器不提供音频输入。保存不会调用模型。</p>
    <button className="button button-primary" disabled={busy || !capabilities.length} type="submit">{busy ? "保存中…" : "保存模型接入"}</button>
  </form>;
}
