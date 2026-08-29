import { Check, Clock3, Film, Gauge, WalletCards } from "lucide-react";
import type { StudioTemplate } from "../../shared/api.js";

interface TemplateGalleryProps {
  templates: StudioTemplate[];
  selectedId: string;
  onSelect: (template: StudioTemplate) => void;
}

export function TemplateGallery({ templates, selectedId, onSelect }: TemplateGalleryProps) {
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
                <span><Clock3 size={13} aria-hidden="true" />{template.durationSeconds} 秒</span>
                <span><Gauge size={13} aria-hidden="true" />{automationLabel(template.automationLevel)}</span>
                <span><WalletCards size={13} aria-hidden="true" />上限 ¥{template.costPolicy.maxCost}</span>
              </span>
              <span className="template-beat-line">{template.storyStructure.map((beat) => beat.label).join(" / ")}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
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
