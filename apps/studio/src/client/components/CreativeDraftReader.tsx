import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { StudioCreativeReviewSnapshot } from "../../shared/api.js";
import { CharacterScriptReader, isCharacterDocument } from "./CharacterScriptEditor.js";

type CreativeStage = StudioCreativeReviewSnapshot["stage"];

function deliveryTypeLabel(value: unknown): string {
  switch (value) {
    case "generated_video": return "AI 视频";
    case "generated_image": return "AI 图片";
    case "stock_video": return "素材库视频";
    case "stock_image": return "素材库图片";
    case "editorial_card": return "图文说明卡";
    default: return "待确认获取方式";
  }
}

function draftSegments(stage: CreativeStage, value: Record<string, unknown>) {
  if (stage === "treatment") return undefined;
  const field = stage === "script" ? "scenes" : "shots";
  const items = value[field];
  if (!Array.isArray(items) || items.length === 0 || !items.every(isRecord)) return undefined;
  const idField = "id";
  const hasIds = stage !== "director" && items.every((item) => typeof item[idField] === "string" && String(item[idField]).trim());
  const positionField = stage === "director" ? "scenePosition" : "position";
  const hasPositions = items.every((item) => Number.isInteger(item[positionField]) && Number(item[positionField]) > 0);
  if (!hasIds && !hasPositions) return undefined;
  const segments = items.map((item, index) => ({
    key: hasIds ? `id:${String(item[idField])}` : `position:${Number(item[positionField])}`,
    label: stage === "script" ? `第 ${Number(item.position ?? index + 1)} 段` : `镜头 ${Number(item.scenePosition)}`,
    number: stage === "script" ? Number(item.position ?? index + 1) : index + 1,
    summary: stage === "script" && typeof item.narration === "string" ? item.narration.trim() : undefined,
    duration: stage === "script" && typeof item.duration === "number" && Number.isFinite(item.duration) ? item.duration : undefined,
    // 缺 position 的旧脚本仍沿用它在整篇中的显示序号，阅读切段不改源文档。
    item: stage === "script" ? { ...item, position: item.position ?? index + 1 } : item,
  }));
  if (new Set(segments.map((segment) => segment.key)).size !== segments.length) return undefined;
  return { field, segments };
}

export function CreativeDraftReader({ stage, value, nativeAudio = false }: { stage: CreativeStage; value: unknown; nativeAudio?: boolean }) {
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
  if (!structured || !isRecord(value)) return <CreativeDraft stage={stage} value={value} nativeAudio={nativeAudio} />;
  const { field, segments } = structured;
  if (!selected) return <CreativeDraft stage={stage} value={value} nativeAudio={nativeAudio} />;
  return <section className={`creative-draft-reader${stage === "script" ? " creative-draft-reader--script" : ""}`} aria-label="稿件阅读">
    {!showWholeDraft ? <nav ref={navRef} className={`creative-segment-nav${stage === "script" ? " creative-segment-nav--script" : ""}`} aria-label="稿件段落">
      {stage === "script" ? <div className="creative-segment-heading"><strong>脚本段落</strong><span>{segments.length} 段</span></div> : null}
      <span ref={indicatorRef} className="creative-segment-indicator" aria-hidden="true" />{segments.map((segment) => <button
      type="button" key={segment.key} className="creative-segment-button" aria-label={`阅读${segment.label}`}
      aria-current={segment.key === selected.key ? "true" : undefined} onClick={() => setSelectedId(segment.key)}>
      <span className="creative-segment-number" aria-hidden="true">{String(segment.number).padStart(2, "0")}</span>
      {segment.summary ? <span className="creative-segment-copy">{segment.summary}</span> : null}
      {segment.duration !== undefined ? <span className="creative-segment-duration">{segment.duration} 秒</span> : null}
    </button>)}</nav> : null}
    <div className="creative-reader-toolbar"><span>{segments.length} {stage === "director" ? "镜头" : "段"}</span>
      <button type="button" className="button button-ghost" onClick={() => setShowWholeDraft((current) => !current)}>{showWholeDraft ? "返回分段阅读" : "查看整篇"}</button>
    </div>
    <div className="creative-reader-content" role="region" aria-label="稿件正文" aria-live="polite"><CreativeDraft stage={stage} value={showWholeDraft ? value : { ...value, [field]: [selected.item] }} nativeAudio={nativeAudio} /></div>
  </section>;
}

export function CreativeDraft({ stage, value, nativeAudio = false }: { stage: CreativeStage; value: unknown; nativeAudio?: boolean }) {
  if (stage === "script" && isCharacterDocument(value)) return <CharacterScriptReader value={value} nativeAudio={nativeAudio} />;
  if (!isRecord(value)) return <p>当前方案暂时无法读取，请刷新后重试。</p>;
  if (stage === "treatment") return <div className="creative-readable-draft">
    <DraftField label="构思正文" value={value.concept} />
  </div>;
  if (stage === "script") return <div className="creative-readable-draft">{Array.isArray(value.scenes) ? value.scenes.map((scene, index) => isRecord(scene) ? <section className="creative-scene" key={`${String(scene.id ?? "scene")}:${index}`}><strong>第 {Number(scene.position ?? index + 1)} 段 · {Number(scene.duration ?? 0)} 秒</strong><div className="creative-audience-copy"><small>旁白 · 观众听到的内容</small><p>{String(scene.narration ?? "")}</p></div><div className="creative-production-note"><small>画面描述 · 制作参考，尚未生成</small><p>{String(scene.visual_prompt ?? "")}</p></div></section> : null) : null}</div>;
  return <div className="creative-readable-draft">{isRecord(value.visualBible) ? <DraftField label="全片视觉规则" value={`${String(value.visualBible.narrativeApproach ?? "")} · ${String(value.visualBible.pacing ?? "")} · ${String(value.visualBible.continuity ?? "")}`} /> : null}{Array.isArray(value.shots) ? value.shots.map((shot, index) => isRecord(shot) ? <section className="creative-scene" key={`${String(shot.scenePosition ?? "shot")}:${index}`}><strong>镜头 {Number(shot.scenePosition ?? index + 1)} · {deliveryTypeLabel(shot.deliveryType)}</strong><p>{String(shot.visibleAction ?? shot.generationPrompt ?? shot.query ?? "")}</p><small>预计时长与获取路线将在当前方案确认后进入报价；画面尚未生成。</small></section> : null) : null}</div>;
}

function DraftField({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return <section><strong>{label}</strong><p>{String(value)}</p></section>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
