import { useEffect, useState } from "react";
import type { CharacterScript, CharacterScriptScene, ScriptCharacter } from "@video-factory/production-pipeline";
import type { StudioVoiceProfile } from "../../shared/api.js";
import { studioApi } from "../api.js";

export function isCharacterDocument(value: unknown): value is CharacterScript {
  if (!value || typeof value !== "object") return false;
  const document = value as Record<string, unknown>;
  return document.version === "video-factory/character-script-v1" && Array.isArray(document.characters) && Array.isArray(document.scenes);
}

/** 使用父编辑器的版本、草稿恢复及保存事务；这里不发送制作命令。 */
export function CharacterScriptEditor({ value, disabled = false, onChange }: {
  value: CharacterScript; disabled?: boolean; onChange(value: CharacterScript): void;
}) {
  const [voices, setVoices] = useState<StudioVoiceProfile[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  useEffect(() => {
    let active = true;
    void studioApi.voices().then((items) => { if (active) setVoices(items.filter((item) => item.engine === "minimax" && item.providerId === "minimax-tts-v1")); })
      .catch(() => { if (active) setCatalogError(true); });
    return () => { active = false; };
  }, []);
  const changeCharacter = (id: string, patch: Partial<ScriptCharacter>) =>
    onChange({ ...value, characters: value.characters.map((c) => c.id === id ? { ...c, ...patch } : c) });
  const changeScene = (position: number, patch: Partial<CharacterScriptScene>) =>
    onChange({ ...value, scenes: value.scenes.map((s) => s.position === position ? { ...s, ...patch } : s) });
  const addCharacter = () => onChange({ ...value, characters: [...value.characters, {
    id: "character_" + crypto.randomUUID().replaceAll("-", ""), name: "新角色", kind: "character",
    appearance: "", personality: "", voice_intent: "", voice_profile_id: null,
  }] });
  return <fieldset className="character-script-editor" disabled={disabled}>
    <legend>角色与台词</legend>
    <p>按角色分别配音，不包含口型同步。音色可以稍后选择；有台词的角色需在配音前选好。保存不会开始生成或付费。</p>
    {catalogError ? <p role="status">音色目录暂时无法读取。当前选择和稿件保留，可稍后重新打开编辑器。</p> : null}
    <section aria-label="角色列表" className="character-editor-list">
      {value.characters.map((character, index) => {
        const sceneRefs = value.scenes.filter((s) => s.character_ids.includes(character.id)).map((s) => s.position);
        const turnRefs = value.scenes.flatMap((s) => s.dialogue.filter((t) => t.speaker_id === character.id));
        const prefix = `角色 ${index + 1}`;
        return <fieldset key={character.id} className="character-editor-card">
          <legend>{prefix} · {character.name || "未命名"}</legend>
          <label className="field"><span>名称</span><input aria-label={prefix + " · 名称"} value={character.name} onChange={(e) => changeCharacter(character.id, { name: e.target.value })} /></label>
          <label className="field"><span>类型</span><select aria-label={prefix + " · 类型"} value={character.kind} onChange={(e) => changeCharacter(character.id, { kind: e.target.value === "narrator" ? "narrator" : "character" })}>
            <option value="character">出镜人物</option><option value="narrator" disabled={sceneRefs.length > 0}>场外旁白（不出镜）</option>
          </select></label>
          {([["appearance", "外观"], ["personality", "性格"], ["voice_intent", "声音要求"]] as const).map(([field, label]) =>
            <label className="field" key={field}><span>{label}</span><textarea rows={2} aria-label={prefix + " · " + label} value={character[field]} onChange={(e) => changeCharacter(character.id, { [field]: e.target.value })} /></label>)}
          <label className="field"><span>配音音色</span><select aria-label={prefix + " · 音色"} value={character.voice_profile_id ?? ""} onChange={(e) => changeCharacter(character.id, { voice_profile_id: e.target.value || null })}>
            <option value="">暂未选择</option>
            {character.voice_profile_id && !voices.some((v) => v.id === character.voice_profile_id) ? <option value={character.voice_profile_id}>原音色（目录暂未确认）</option> : null}
            {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
          </select></label>
          <p className="muted">{sceneRefs.length ? `出场：镜头 ${sceneRefs.join("、")}；` : "不在画面中出场；"}{turnRefs.length} 句台词。</p>
          {sceneRefs.length || turnRefs.length ? <p className="muted">删除前请先取消出场、重新指派或删除对应台词；已有内容不会自动丢弃。</p> : null}
          <button type="button" className="button button-ghost" aria-label={"删除" + prefix} disabled={sceneRefs.length > 0 || turnRefs.length > 0}
            onClick={() => onChange({ ...value, characters: value.characters.filter((c) => c.id !== character.id) })}>删除角色</button>
        </fieldset>;
      })}
    </section>
    <button type="button" className="button button-secondary" onClick={addCharacter}>添加角色</button>
    <p className="muted">声音要求与表演提示供创作参考，当前配音服务不保证逐句情绪表演。</p>
    {value.scenes.map((scene) => <fieldset key={scene.position} className="character-editor-scene">
      <legend>镜头 {scene.position} · {scene.duration} 秒</legend>
      <label className="field"><span>画面描述</span><textarea aria-label={`镜头 ${scene.position} · 画面描述`} value={scene.visual_prompt}
        onChange={(e) => changeScene(scene.position, { visual_prompt: e.target.value })} /></label>
      <label className="field"><span>可见动作</span><textarea aria-label={`镜头 ${scene.position} · 可见动作`} value={scene.visible_action ?? ""}
        onChange={(e) => changeScene(scene.position, { visible_action: e.target.value })} /></label>
      <fieldset className="character-cast"><legend>画面中出场的人物</legend>
        {value.characters.filter((c) => c.kind === "character").map((c) => <label key={c.id}><input type="checkbox"
          aria-label={`镜头 ${scene.position} · 出场 · ${c.name}`} checked={scene.character_ids.includes(c.id)}
          onChange={(e) => changeScene(scene.position, { character_ids: e.target.checked ? [...scene.character_ids, c.id] : scene.character_ids.filter((id) => id !== c.id) })} />{c.name}</label>)}
      </fieldset>
      {!scene.dialogue.length ? <p>本镜头无台词，保留动作与静默。</p> : null}
      {scene.dialogue.map((turn, index) => {
        const prefix = `镜头 ${scene.position} · 台词 ${index + 1}`;
        const update = (patch: Partial<typeof turn>) => changeScene(scene.position, { dialogue: scene.dialogue.map((t) => t.id === turn.id ? { ...t, ...patch } : t) });
        return <fieldset key={turn.id} className="character-turn-editor"><legend>台词 {index + 1}</legend>
          <label className="field"><span>说话角色（可以在画面外）</span><select aria-label={prefix + " · 说话角色"} value={turn.speaker_id} onChange={(e) => update({ speaker_id: e.target.value })}>
            {value.characters.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}
          </select></label>
          <label className="field"><span>实际朗读的文字</span><textarea aria-label={prefix + " · 正文"} value={turn.text} onChange={(e) => update({ text: e.target.value })} /></label>
          <label className="field"><span>表演提示（不会朗读）</span><input aria-label={prefix + " · 表演提示"} value={turn.delivery} onChange={(e) => update({ delivery: e.target.value })} /></label>
          <label className="field"><span>句后停顿（帧，30 帧为 1 秒）</span><input type="number" min="0" step="1" aria-label={prefix + " · 停顿"} value={turn.after_pause_frames}
            onChange={(e) => { const frames = Number(e.target.value); if (Number.isSafeInteger(frames) && frames >= 0) update({ after_pause_frames: frames }); }} /></label>
          <button type="button" className="button button-ghost" aria-label={"删除" + prefix}
            onClick={() => changeScene(scene.position, { dialogue: scene.dialogue.filter((t) => t.id !== turn.id) })}>删除这句</button>
        </fieldset>;
      })}
      <button type="button" className="button button-secondary" aria-label={`镜头 ${scene.position} · 添加台词`} disabled={!value.characters.length}
        onClick={() => changeScene(scene.position, { dialogue: [...scene.dialogue, {
          id: "turn_" + crypto.randomUUID().replaceAll("-", ""), speaker_id: value.characters[0]!.id,
          text: "", delivery: "", after_pause_frames: 0,
        }] })}>添加台词</button>
    </fieldset>)}
  </fieldset>;
}

export function CharacterScriptReader({ value }: { value: CharacterScript }) {
  const names = new Map(value.characters.map((c) => [c.id, c.name]));
  return <div className="creative-readable-draft character-script-reader">
    <section aria-label="角色设定"><h4>角色设定</h4><div className="character-reader-list">
      {value.characters.map((c) => <article key={c.id}><strong>{c.name}</strong><p>{c.kind === "narrator" ? "场外旁白" : c.appearance}</p>
        {c.personality ? <p>{c.personality}</p> : null}<small>{c.voice_profile_id ? "已选配音音色" : "尚未选择音色"}</small></article>)}
    </div></section>
    {value.scenes.map((s) => <section key={s.position} className="creative-scene"><strong>镜头 {s.position} · {s.duration} 秒</strong>
      <p className="creative-production-note">出场：{s.character_ids.map((id) => names.get(id) ?? "未找到角色").join("、") || "无人出场"}。{s.visual_prompt}</p>
      {s.dialogue.length ? <ol className="character-dialogue">{s.dialogue.map((t) => <li key={t.id}><b>{names.get(t.speaker_id) ?? "未找到角色"}{s.character_ids.includes(t.speaker_id) ? "" : "（画外）"}</b><p>{t.text}</p>
        {t.delivery ? <small>表演提示：{t.delivery}（不朗读）</small> : null}{t.after_pause_frames ? <small> · 句后留白 {(t.after_pause_frames / 30).toFixed(2)} 秒</small> : null}</li>)}</ol> : <p>无台词，保留静默。</p>}
    </section>)}
  </div>;
}
