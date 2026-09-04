import { ChevronDown, LoaderCircle, Mic2, Minus, Play, Plus, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StudioVoiceDirection, StudioVoiceProfile } from "../../shared/api.js";
import { VOICE_PRESETS } from "../../shared/template-voice-recommendation.js";
import { studioApi } from "../api.js";

interface VoiceStudioProps {
  value: StudioVoiceDirection;
  onChange: (value: StudioVoiceDirection, providerId: string) => void;
  onUserChange?: () => void;
  preserveUnavailableSelection?: boolean;
  onSelectionAvailabilityChange?: (available: boolean) => void;
  title?: string;
  sectionLabel?: string;
}

const PREVIEW_TEXT = "真正让人停下来的，不是更响的声音，而是恰到好处的节奏。";
const RECOMMENDED_VOICES = new Set([
  "macos:Tingting",
  "macos:Meijia",
  "macos:Sinji",
  "minimax:Chinese (Mandarin)_News_Anchor",
  "minimax:Chinese (Mandarin)_Reliable_Executive",
  "minimax:male-qn-jingying",
  "minimax:female-chengshu",
]);
type VoiceFilter = "recommended" | "female" | "male" | "cloud" | "system";

export function VoiceStudio({
  value,
  onChange,
  onUserChange,
  preserveUnavailableSelection = false,
  onSelectionAvailabilityChange,
  title = "声音导演",
  sectionLabel = "04",
}: VoiceStudioProps) {
  const [voices, setVoices] = useState<StudioVoiceProfile[]>([]);
  const [direction, setDirection] = useState(value);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [previewing, setPreviewing] = useState<string>();
  const [audioUrl, setAudioUrl] = useState<string>();
  const [filter, setFilter] = useState<VoiceFilter>("recommended");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const selected = useMemo(
    () => voices.find((voice) => voice.id === direction.profileId),
    [direction.profileId, voices],
  );
  const filteredVoices = useMemo(() => voices.filter((voice) => {
    if (filter === "female") return voice.gender === "female";
    if (filter === "male") return voice.gender === "male";
    if (filter === "cloud") return voice.engine === "minimax";
    if (filter === "system") return voice.engine === "macos";
    return RECOMMENDED_VOICES.has(voice.id) || voice.id === direction.profileId;
  }), [direction.profileId, filter, voices]);
  const filterCounts = useMemo(() => ({
    recommended: voices.filter((voice) => RECOMMENDED_VOICES.has(voice.id) || voice.id === direction.profileId).length,
    female: voices.filter((voice) => voice.gender === "female").length,
    male: voices.filter((voice) => voice.gender === "male").length,
    cloud: voices.filter((voice) => voice.engine === "minimax").length,
    system: voices.filter((voice) => voice.engine === "macos").length,
  }), [direction.profileId, voices]);
  const selectedPreset = VOICE_PRESETS.find((preset) => preset.rate === direction.rate
    && preset.pauseScale === direction.pauseScale
    && preset.masteringPreset === direction.masteringPreset);

  useEffect(() => setDirection(value), [value]);
  useEffect(() => {
    let active = true;
    void studioApi.voices().then((items) => {
      if (!active) return;
      setVoices(items);
      setLoading(false);
    }).catch((caught) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoading(false);
      onSelectionAvailabilityChange?.(false);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (loading) return;
    const selectionAvailable = voices.some((voice) => voice.id === direction.profileId);
    onSelectionAvailabilityChange?.(selectionAvailable);
    if (!selectionAvailable && voices[0] && !preserveUnavailableSelection) {
      update({ ...direction, profileId: voices[0].id }, voices[0], false);
    }
  }, [direction.profileId, loading, preserveUnavailableSelection, voices]);

  function update(next: StudioVoiceDirection, profile = voices.find((voice) => voice.id === next.profileId), userInitiated = true) {
    if (userInitiated) onUserChange?.();
    setDirection(next);
    onSelectionAvailabilityChange?.(Boolean(profile));
    onChange(next, profile?.providerId ?? "macos-say-v1");
  }

  async function preview(profile: StudioVoiceProfile) {
    const next = { ...direction, profileId: profile.id };
    if (next.profileId !== direction.profileId) update(next, profile);
    setPreviewing(profile.id);
    setError(undefined);
    try {
      const nextUrl = await studioApi.voicePreview({ ...next, text: PREVIEW_TEXT });
      if (audioUrl?.startsWith("blob:")) URL.revokeObjectURL(audioUrl);
      setAudioUrl(nextUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreviewing(undefined);
    }
  }

  return (
    <section className="voice-studio" aria-labelledby="voice-studio-title">
      <div className="compact-section-heading">
        <div><span>{sectionLabel}</span><h3 id="voice-studio-title">{title}</h3></div>
        <small>{loading ? "正在读取音色" : `${voices.length} 种可用中文音色`}</small>
      </div>

      {loading ? <div className="region-loading">正在整理声音演员表...</div> : null}
      {!loading && voices.length > 0 ? (
        <div className="voice-studio-layout">
          <div className="voice-selection">
            <div className="voice-filters" role="tablist" aria-label="音色分类">
              {([
                ["recommended", "推荐"],
                ["female", "女声"],
                ["male", "男声"],
                ["cloud", "云端演员"],
                ["system", "系统音色"],
              ] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}>
                  {label}<span>{filterCounts[id]}</span>
                </button>
              ))}
            </div>
            <fieldset className="voice-cast">
              <legend className="sr-only">旁白音色</legend>
              {filteredVoices.map((voice) => (
                <div key={voice.id} className={direction.profileId === voice.id ? "voice-card is-selected" : "voice-card"}>
                  <label className="voice-card-choice">
                    <input
                      type="radio"
                      name="voice-profile"
                      value={voice.id}
                      checked={direction.profileId === voice.id}
                      onChange={() => update({ ...direction, profileId: voice.id }, voice)}
                    />
                    <span className="voice-card-mark"><Mic2 aria-hidden="true" size={17} /></span>
                    <span className="voice-card-copy">
                      <strong>{voice.label}</strong>
                      <small>{voice.description ?? (voice.engine === "macos" ? voice.locale : "云端声音演员")}</small>
                    </span>
                  </label>
                  <button
                    className="icon-button voice-preview-button"
                    type="button"
                    title={`试听 ${voice.label}`}
                    aria-label={`试听 ${voice.label}`}
                    disabled={previewing !== undefined}
                    onClick={() => void preview(voice)}
                  >
                    {previewing === voice.id ? <LoaderCircle className="spin" aria-hidden="true" size={16} /> : <Play aria-hidden="true" size={16} />}
                  </button>
                </div>
              ))}
            </fieldset>
          </div>

          <div className="voice-direction">
            <div className="voice-preset-picker" aria-label="内容声音方案">
              <header><strong>内容声音方案</strong><small>已按常见短视频内容校准语速、停顿与响度</small></header>
              <div>{VOICE_PRESETS.map((preset) => <button
                key={preset.id}
                type="button"
                aria-pressed={selectedPreset?.id === preset.id}
                onClick={() => {
                  const recommendedVoice = preset.preferredProfileIds
                    .map((profileId) => voices.find((voice) => voice.id === profileId))
                    .find((voice) => voice !== undefined) ?? selected;
                  update({
                    ...direction,
                    profileId: recommendedVoice?.id ?? direction.profileId,
                    rate: preset.rate,
                    pauseScale: preset.pauseScale,
                    masteringPreset: preset.masteringPreset,
                  }, recommendedVoice);
                }}
              ><strong>{preset.label}</strong><small>{preset.description}</small></button>)}</div>
            </div>
            <button className="voice-advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
              <span>高级微调</span><small>{direction.rate} 字/分 · 停顿 {direction.pauseScale.toFixed(1)}× · {masteringPresetLabel(direction.masteringPreset)}</small><ChevronDown aria-hidden="true" size={16} />
            </button>
            {advancedOpen ? <div className="voice-advanced-controls">
            <div className="voice-slider">
              <span><strong>语速</strong><output>{direction.rate} 字/分</output></span>
              <div className="voice-slider-control">
                <button type="button" aria-label="降低语速" disabled={direction.rate <= 120} onClick={() => update({ ...direction, rate: Math.max(120, direction.rate - 5) }, selected)}><Minus aria-hidden="true" size={14} /></button>
                <input aria-label="语速" type="range" min="120" max="260" step="5" value={direction.rate} onChange={(event) => update({ ...direction, rate: Number(event.target.value) }, selected)} />
                <button type="button" aria-label="增加语速" disabled={direction.rate >= 260} onClick={() => update({ ...direction, rate: Math.min(260, direction.rate + 5) }, selected)}><Plus aria-hidden="true" size={14} /></button>
              </div>
            </div>
            <div className="voice-slider">
              <span><strong>停顿</strong><output>{direction.pauseScale.toFixed(1)}×</output></span>
              <div className="voice-slider-control">
                <button type="button" aria-label="减少停顿" disabled={direction.pauseScale <= 0.5} onClick={() => update({ ...direction, pauseScale: Math.max(0.5, Number((direction.pauseScale - 0.1).toFixed(1))) }, selected)}><Minus aria-hidden="true" size={14} /></button>
                <input aria-label="停顿" type="range" min="0.5" max="2" step="0.1" value={direction.pauseScale} onChange={(event) => update({ ...direction, pauseScale: Number(event.target.value) }, selected)} />
                <button type="button" aria-label="增加停顿" disabled={direction.pauseScale >= 2} onClick={() => update({ ...direction, pauseScale: Math.min(2, Number((direction.pauseScale + 0.1).toFixed(1))) }, selected)}><Plus aria-hidden="true" size={14} /></button>
              </div>
            </div>
            <fieldset className="segmented-control mastering-control">
              <legend>声音质感</legend>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "natural"} onChange={() => update({ ...direction, masteringPreset: "natural" }, selected)} /><span>自然</span></label>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "intimate"} onChange={() => update({ ...direction, masteringPreset: "intimate" }, selected)} /><span>贴近人声</span></label>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "social"} onChange={() => update({ ...direction, masteringPreset: "social" }, selected)} /><span>社交清晰</span></label>
            </fieldset>
            </div> : null}
            {audioUrl ? <audio className="voice-audio" aria-label="声音试听" controls autoPlay src={audioUrl}><track kind="captions" /></audio> : (
              <div className="voice-audio-placeholder"><Volume2 aria-hidden="true" size={17} /><span>{selected?.label ?? "选择一个音色"}</span></div>
            )}
          </div>
        </div>
      ) : null}
      {!loading && voices.length === 0 && !error ? (
        <div className="voice-empty" role="status">
          <Mic2 aria-hidden="true" size={19} />
          <div>
            <strong>当前没有正式配音演员</strong>
            <span>云服务器尚未接入正式配音服务，测试音轨不会用于成片。</span>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}

function masteringPresetLabel(preset: StudioVoiceDirection["masteringPreset"]): string {
  return preset === "intimate" ? "贴近人声" : preset === "social" ? "社交清晰" : "自然";
}
