import { Check, Clock3, Film, Gauge, LayoutTemplate, WalletCards } from "lucide-react";
import { useEffect, useRef } from "react";
import type { StudioTemplate } from "../../shared/api.js";

interface TemplateGalleryProps {
  templates: StudioTemplate[];
  selectedId: string;
  onSelect: (template: StudioTemplate) => void;
}

export function TemplateGallery({ templates, selectedId, onSelect }: TemplateGalleryProps) {
  const selectedCard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!window.matchMedia?.("(max-width: 700px)").matches) return;
    selectedCard.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [selectedId]);

  return (
    <div className="template-gallery" role="radiogroup" aria-label="视频模板">
      {templates.map((template) => {
        const selected = template.id === selectedId;
        return (
          <button
            className={selected ? "template-card is-selected" : "template-card"}
            key={`${template.id}-${template.version}`}
            type="button"
            role="radio"
            aria-checked={selected}
            ref={selected ? selectedCard : undefined}
            onClick={() => onSelect(template)}
          >
            <span className={`template-art template-art-${template.category}`} aria-hidden="true">
              <img alt="" src={templateFrame(template.category)} />
              <span><Film size={15} /><i>{String(template.storyStructure.length).padStart(2, "0")}</i></span>
            </span>
            <span className="template-card-copy">
              <span className="template-card-title"><strong>{template.name}</strong>{selected ? <Check size={15} aria-hidden="true" /> : null}</span>
              <small>{template.description}</small>
              <span className="template-card-meta">
                <span><LayoutTemplate size={13} aria-hidden="true" />{templateCategoryLabel(template.category)}</span>
                <span><Clock3 size={13} aria-hidden="true" />{template.durationSeconds} 秒</span>
                <span><Gauge size={13} aria-hidden="true" />记录模式：{automationLabel(template.automationLevel)}</span>
                <span><WalletCards size={13} aria-hidden="true" />模板资料，当前不影响制作</span>
              </span>
              <span className="template-beat-line">{template.storyStructure.map((beat) => beat.label).join(" / ")}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  trend: "热点事实",
  knowledge: "知识讲解",
  "evidence-story": "证据叙事",
  demonstration: "实操演示",
  documentary: "人物纪录",
  comparison: "对比评测",
  photo: "照片叙事",
  custom: "自定义创作",
};

export function templateCategoryLabel(category: string): string {
  return TEMPLATE_CATEGORY_LABELS[category] ?? "其他创作类型";
}

function templateFrame(category: StudioTemplate["category"]): string {
  if (category === "photo" || category === "knowledge") return "/media/studio-frame-1.jpg";
  if (category === "trend" || category === "comparison") return "/media/studio-frame-2.jpg";
  return "/media/studio-frame-3.jpg";
}

function automationLabel(value: StudioTemplate["automationLevel"]): string {
  if (value === "automatic") return "自动优先";
  if (value === "manual") return "人工主导";
  return "人机协作";
}
