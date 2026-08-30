import { LoaderCircle, Mic2, Play, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { StudioVoiceDirection, StudioVoiceProfile } from "../../shared/api.js";
import { studioApi } from "../api.js";

interface VoiceStudioProps {
  value: StudioVoiceDirection;
  onChange: (value: StudioVoiceDirection, providerId: string) => void;
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

export function VoiceStudio({ value, onChange, title = "声音导演", sectionLabel = "04" }: VoiceStudioProps) {
  const [voices, setVoices] = useState<StudioVoiceProfile[]>([]);
  const [direction, setDirection] = useState(value);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [previewing, setPreviewing] = useState<string>();
  const [audioUrl, setAudioUrl] = useState<string>();
  const [filter, setFilter] = useState<VoiceFilter>("recommended");
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

  useEffect(() => setDirection(value), [value]);
  useEffect(() => {
    let active = true;
    void studioApi.voices().then((items) => {
      if (!active) return;
      setVoices(items);
      setLoading(false);
      if (!items.some((voice) => voice.id === direction.profileId) && items[0]) {
        update({ ...direction, profileId: items[0].id }, items[0]);
      }
    }).catch((caught) => {
      if (!active) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  function update(next: StudioVoiceDirection, profile = voices.find((voice) => voice.id === next.profileId)) {
    setDirection(next);
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
            <label className="voice-slider">
              <span><strong>语速</strong><output>{direction.rate} 字/分</output></span>
              <input aria-label="语速" type="range" min="120" max="260" step="5" value={direction.rate} onChange={(event) => update({ ...direction, rate: Number(event.target.value) }, selected)} />
            </label>
            <label className="voice-slider">
              <span><strong>停顿</strong><output>{direction.pauseScale.toFixed(1)}×</output></span>
              <input aria-label="停顿" type="range" min="0.5" max="2" step="0.1" value={direction.pauseScale} onChange={(event) => update({ ...direction, pauseScale: Number(event.target.value) }, selected)} />
            </label>
            <fieldset className="segmented-control mastering-control">
              <legend>声音质感</legend>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "natural"} onChange={() => update({ ...direction, masteringPreset: "natural" }, selected)} /><span>自然</span></label>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "intimate"} onChange={() => update({ ...direction, masteringPreset: "intimate" }, selected)} /><span>贴近人声</span></label>
              <label><input type="radio" name="mastering" checked={direction.masteringPreset === "social"} onChange={() => update({ ...direction, masteringPreset: "social" }, selected)} /><span>社交清晰</span></label>
            </fieldset>
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
            <span>云服务器未接入 TTS API，测试音轨不会用于成片。</span>
          </div>
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
