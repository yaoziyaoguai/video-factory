import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StudioCreativeReviewSnapshot } from "../../shared/api.js";

type CreativeStage = StudioCreativeReviewSnapshot["stage"];

function draftSegments(stage: CreativeStage, value: Record<string, unknown>) {
  const field = stage === "treatment" ? "progression" : stage === "script" ? "scenes" : "shots";
  const items = value[field];
  if (!Array.isArray(items) || items.length === 0 || !items.every(isRecord)) return undefined;
  const idField = stage === "treatment" ? "beatId" : "id";
  const hasIds = stage !== "director" && items.every((item) => typeof item[idField] === "string" && String(item[idField]).trim());
  const positionField = stage === "director" ? "scenePosition" : "position";
  const hasPositions = stage !== "treatment" && items.every((item) => Number.isInteger(item[positionField]) && Number(item[positionField]) > 0);
  if (!hasIds && !hasPositions) return undefined;
  const segments = items.map((item, index) => ({
    key: hasIds ? `id:${String(item[idField])}` : `position:${Number(item[positionField])}`,
    label: stage === "treatment" ? `内容推进 ${index + 1}` : stage === "script" ? `第 ${Number(item.position ?? index + 1)} 段` : `镜头 ${Number(item.scenePosition)}`,
    // 缺 position 的旧脚本仍沿用它在整篇中的显示序号，阅读切段不改源文档。
    item: stage === "script" ? { ...item, position: item.position ?? index + 1 } : item,
  }));
  if (new Set(segments.map((segment) => segment.key)).size !== segments.length) return undefined;
  return { field, segments };
}

export function CreativeDraftReader({ stage, value }: { stage: CreativeStage; value: unknown }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [showWholeDraft, setShowWholeDraft] = useState(false);
  const structured = isRecord(value) ? draftSegments(stage, value) : undefined;
  const selected = structured?.segments.find((segment) => segment.key === selectedId) ?? structured?.segments[0];
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const indicatorAnimationRef = useRef<Animation | null>(null);
  const indicatorPositionedRef = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) {
      indicatorAnimationRef.current?.cancel();
      indicatorAnimationRef.current = null;
      indicatorPositionedRef.current = false;
      return;
    }
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    function align(animate: boolean, force = false) {
      const button = nav!.querySelector<HTMLElement>('[aria-current="true"]');
      const visible = button && button.getClientRects().length > 0;
      const target = visible ? { transform: `translate(${button.offsetLeft}px, ${button.offsetTop}px)`, width: `${button.offsetWidth}px`, height: `${button.offsetHeight}px` } : undefined;
      // ResizeObserver 初次回报尺寸时不打断正在进行的选择过渡。
      if (!animate && !force && target && !indicator!.hidden && Object.entries(target).every(([property, next]) => indicator!.style[property as "transform" | "width" | "height"] === next)) return;
      const from = animate && indicatorPositionedRef.current && !preference?.matches
        ? window.getComputedStyle(indicator!) : null;
      const start = from ? { transform: from.transform, width: from.width, height: from.height } : null;
      indicatorAnimationRef.current?.cancel();
      indicatorAnimationRef.current = null;
      indicator!.hidden = !visible;
      if (!target) {
        indicatorPositionedRef.current = false;
        return;
      }
      Object.assign(indicator!.style, target);
      indicatorPositionedRef.current = true;
      if (start && typeof indicator!.animate === "function") {
        const animation = indicator!.animate([start, target], { duration: 180, easing: "ease-out" });
        indicatorAnimationRef.current = animation;
        animation.onfinish = () => {
          if (indicatorAnimationRef.current === animation) indicatorAnimationRef.current = null;
        };
      }
    }
    align(true);
    const realign = () => align(false);
    const motionChanged = () => align(false, true);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(realign);
    observer?.observe(nav);
    window.addEventListener("resize", realign);
    preference?.addEventListener?.("change", motionChanged);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", realign);
      preference?.removeEventListener?.("change", motionChanged);
    };
  }, [selected?.key, showWholeDraft]);
  useEffect(() => () => indicatorAnimationRef.current?.cancel(), []);
  if (!structured || !isRecord(value)) return <CreativeDraft stage={stage} value={value} />;
  const { field, segments } = structured;
  if (!selected) return <CreativeDraft stage={stage} value={value} />;
  return <section className="creative-draft-reader" aria-label="稿件阅读">
    <div className="creative-reader-toolbar"><span>{segments.length} {stage === "director" ? "镜头" : "段"}</span>
      <button type="button" className="button button-ghost" onClick={() => setShowWholeDraft((current) => !current)}>{showWholeDraft ? "返回分段阅读" : "查看整篇"}</button>
    </div>
    {!showWholeDraft ? <nav ref={navRef} className="creative-segment-nav" aria-label="稿件段落"><span ref={indicatorRef} className="creative-segment-indicator" aria-hidden="true" />{segments.map((segment, index) => <button
      type="button" key={segment.key} className="creative-segment-button" aria-label={`阅读${segment.label}`}
      aria-current={segment.key === selected.key ? "true" : undefined} onClick={() => setSelectedId(segment.key)}>
      <span className="creative-segment-number">{String(index + 1).padStart(2, "0")}</span><span className="creative-segment-title">{segment.label}</span>
    </button>)}</nav> : null}
    <div className="creative-reader-content" aria-live="polite"><CreativeDraft stage={stage} value={showWholeDraft ? value : { ...value, [field]: [selected.item] }} /></div>
  </section>;
}

export function CreativeDraft({ stage, value }: { stage: CreativeStage; value: unknown }) {
  if (!isRecord(value)) return <p>当前方案暂时无法读取，请刷新后重试。</p>;
  if (stage === "treatment") return <div className="creative-readable-draft">
    <DraftField label="观众看完能得到什么" value={value.viewerPromise} />
    <DraftField label="开头" value={isRecord(value.hook) ? `${String(value.hook.narrationIntent ?? "")} ${String(value.hook.visualIntent ?? "")}` : value.hook} />
    <DraftList label="内容推进" value={Array.isArray(value.progression) ? value.progression.map((beat) => isRecord(beat) ? `${String(beat.purpose ?? "")}：${String(beat.viewerGain ?? "")}` : String(beat)) : []} />
    <DraftField label="结尾兑现" value={value.payoff} />
    <DraftList label="视觉方向" value={value.visualPrinciples} />
    <DraftList label="声音方向" value={value.soundPrinciples} />
  </div>;
  if (stage === "script") return <div className="creative-readable-draft"><DraftField label="叙事推进（制作参考）" value={value.narrativeArc} />{Array.isArray(value.scenes) ? value.scenes.map((scene, index) => isRecord(scene) ? <section className="creative-scene" key={`${String(scene.id ?? "scene")}:${index}`}><strong>第 {Number(scene.position ?? index + 1)} 段 · {Number(scene.duration ?? 0)} 秒</strong><div className="creative-audience-copy"><small>旁白 · 观众听到的内容</small><p>{String(scene.narration ?? "")}</p></div><div className="creative-production-note"><small>画面描述 · 制作参考，尚未生成</small><p>{String(scene.visual_prompt ?? "")}</p></div></section> : null) : null}</div>;
  return <div className="creative-readable-draft">{isRecord(value.visualBible) ? <DraftField label="全片视觉规则" value={`${String(value.visualBible.narrativeApproach ?? "")} · ${String(value.visualBible.pacing ?? "")} · ${String(value.visualBible.continuity ?? "")}`} /> : null}{Array.isArray(value.shots) ? value.shots.map((shot, index) => isRecord(shot) ? <section className="creative-scene" key={`${String(shot.scenePosition ?? "shot")}:${index}`}><strong>镜头 {Number(shot.scenePosition ?? index + 1)} · {String(shot.deliveryType ?? "待定路线")}</strong><p>{String(shot.visibleAction ?? shot.generationPrompt ?? shot.query ?? "")}</p><small>预计时长与获取路线将在当前方案确认后进入报价；画面尚未生成。</small></section> : null) : null}</div>;
}

function DraftField({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return <section><strong>{label}</strong><p>{String(value)}</p></section>;
}

function DraftList({ label, value }: { label: string; value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return null;
  return <section><strong>{label}</strong><ul>{value.map((item, index) => <li key={index}>{String(item)}</li>)}</ul></section>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
