import { useEffect, useRef, useState } from "react";
import type { StudioRunDetail, StudioSubtitleRecoveryInput } from "../../shared/api.js";
import { studioApi } from "../api.js";

interface Props {
  run: StudioRunDetail;
  busy: boolean;
  onRecover: (input: StudioSubtitleRecoveryInput) => Promise<void>;
}

/** 用正式产物读取恢复依据；只读失败不影响用户采用现有成片。 */
export function SubtitleRecoveryPanel({ run, busy, onRecover }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [binding, setBinding] = useState<Pick<StudioSubtitleRecoveryInput,
    "expectedLayoutKey" | "expectedAudioSha256" | "expectedNarrationPlanSha256">>();
  const [error, setError] = useState<string>();
  const [refetch, setRefetch] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [requestId] = useState(() => `subtitles-${crypto.randomUUID()}`);
  const live = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const voice = run.nodes.find(node => node.id === "voice");
  const version = voice?.outputState?.versions.find(item => item.id === voice.outputState?.effectiveVersionId);
  const artifact = run.artifacts.find(item => version?.artifactIds.includes(item.id) && item.kind === "voiceover_plan");
  if (!artifact?.contentUrl || !version || voice?.outputState?.stale) return null;
  // 已知不产生同次TTS同步字幕的本地声音不提供无法执行的恢复入口；
  // 旧数据缺provider时仍允许只读检查原文件，不误封旧有效v3记录。
  if (["macos-say-v1", "ffmpeg-tone-test-v1"].includes(artifact.providerId ?? "")) return null;

  async function show() {
    setOpen(true);
    setLoading(true);
    setError(undefined);
    try {
      const document = await studioApi.resourceJson(artifact!.contentUrl!);
      if (!live.current) return;
      const plan = record(document);
      const subtitles = record(plan?.subtitles);
      if (!plan || !["video-factory/voiceover-plan-v3", "video-factory/voiceover-plan-v4"].includes(String(plan.version))
        || !digest(plan.layoutKey) || !digest(plan.trackSha256) || !digest(subtitles?.acceptedNarrationPlanSha256)) {
        setError("这版声音没有完整的同步字幕记录，暂不能单独恢复。你仍可查看、采用现有成片。");
        return;
      }
      setBinding({ expectedLayoutKey: plan.layoutKey, expectedAudioSha256: plan.trackSha256,
        expectedNarrationPlanSha256: subtitles.acceptedNarrationPlanSha256 });
    } catch {
      if (live.current) setError("字幕记录暂时无法读取，原声音和成片没有改变。可稍后再试，也可继续确认现有版本。");
    } finally { if (live.current) setLoading(false); }
  }

  async function recover() {
    if (!binding || !version || busy || inFlight.current || refetch && !reason.trim()) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onRecover({ action: "recover_subtitles", requestId, expectedRunRevision: run.revision,
        expectedVoiceVersionId: version.id, ...binding, note: "保留原声音，仅恢复同步字幕并生成新版成片。",
        ...(refetch ? { refetchReason: reason.trim() } : {}) });
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : "字幕恢复没有完成，原声音与成片保留。");
    } finally {
      inFlight.current = false;
      if (live.current) setPending(false);
    }
  }

  return <section className="independent-review-panel" aria-label="同步字幕恢复">
    <button className="button button-secondary" type="button" aria-expanded={open} disabled={busy || pending || loading}
      onClick={() => open ? setOpen(false) : void show()}>恢复同步字幕</button>
    {open ? <div>
      <p>保留原声音，不重新合成、不重买画面。先恢复已有字幕记录，再生成新版成片；原版保留，你仍可选择采用无字幕版本。</p>
      {loading ? <p role="status">正在读取本版字幕记录…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {binding ? <>
        <label><input type="checkbox" checked={refetch} disabled={busy || pending}
          onChange={event => setRefetch(event.target.checked)} />有新依据，重取一次原字幕</label>
        {refetch ? <label>重取依据<input value={reason} maxLength={500} disabled={busy || pending}
          onChange={event => setReason(event.target.value)} placeholder="例如：已修复字幕下载的网络连接" /></label> : null}
        <p>默认只重解析已保存的记录。同一原字幕有新依据时最多重取一次；不会自动重试或重新配音。新版成片的后续审片仍按阶段确认。</p>
        <button type="button" className="button button-primary" disabled={busy || pending || refetch && !reason.trim()}
          onClick={() => void recover()}>{pending ? "正在恢复字幕…" : "仅恢复字幕并生成新版成片"}</button>
      </> : null}
    </div> : null}
  </section>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
