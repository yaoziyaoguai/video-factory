import { ArrowRight, CircleHelp, Play, Sparkles, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface GuideDockProps {
  open: boolean;
  pathname: string;
  onOpenChange: (open: boolean) => void;
  onStartFullTour: () => void;
  onStartPageTour: () => void;
}

const WORKFLOW_STEPS = ["选选题", "定方案", "跑制作", "做审片", "多端发布", "看复盘"];

export function GuideDock({ open, pathname, onOpenChange, onStartFullTour, onStartPageTour }: GuideDockProps) {
  const panelRef = useRef<HTMLElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.requestAnimationFrame(() => primaryActionRef.current?.focus());
    } else if (!open && wasOpenRef.current) {
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    }
    wasOpenRef.current = open;
  }, [onOpenChange, open]);

  const context = guideContext(pathname);
  const start = (callback: () => void) => {
    onOpenChange(false);
    callback();
  };
  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`guide-dock ${open ? "is-open" : ""}`} data-tour="creator-guide">
      {open ? (
        <section ref={panelRef} id="creator-guide-panel" className="guide-dock-panel" role="dialog" aria-modal="true" aria-label="创作向导" onKeyDown={handleDialogKeyDown}>
          <header>
            <span><Sparkles aria-hidden="true" size={15} />创作路线</span>
            <button type="button" onClick={() => onOpenChange(false)} aria-label="收起创作向导" title="收起">
              <X aria-hidden="true" size={18} />
            </button>
          </header>
          <div className="guide-dock-copy">
            <h2>{context.title}</h2>
            <p>{context.description}</p>
          </div>
          <ol className="guide-workflow" aria-label="完整制作流程">
            {WORKFLOW_STEPS.map((step, index) => (
              <li className={index === context.step ? "is-current" : ""} key={step}><span>{step}</span></li>
            ))}
          </ol>
          <div className="guide-dock-actions">
            <button ref={primaryActionRef} className="guide-action-primary" type="button" onClick={() => start(onStartFullTour)}>
              <Play aria-hidden="true" size={16} />完整带我做一条
            </button>
            <button type="button" onClick={() => start(onStartPageTour)}>
              讲解当前页面<ArrowRight aria-hidden="true" size={16} />
            </button>
          </div>
          <p className="guide-dock-note">导览中可随时提前结束，也可以从页面上的问号入口再次打开。</p>
        </section>
      ) : null}
      <button
        className="guide-dock-trigger"
        type="button"
        aria-controls="creator-guide-panel"
        aria-expanded={open}
        aria-label={open ? "关闭创作向导" : "打开创作向导"}
        title={open ? "关闭创作向导" : "打开创作向导"}
        onClick={() => onOpenChange(!open)}
      >
        <CircleHelp aria-hidden="true" size={20} />
        <span>创作向导</span>
      </button>
    </div>
  );
}

function guideContext(pathname: string): { title: string; description: string; step: number } {
  if (pathname === "/projects") {
    return { title: "到了制作记录，接下来这样做", description: "看制作状态，打开具体记录；只有“等你审片”时才需要操作。", step: 2 };
  }
  if (pathname.startsWith("/projects/")) {
    return { title: "生产现场，先判断要不要动手", description: "看节点进度和成片；出现人工判断时审片，批准后可下载发布包或进入多平台发布。", step: 3 };
  }
  if (pathname === "/resources") {
    return { title: "先把创作习惯和能力配好", description: "保存新建制作的默认值，再检查热点、声音、画面、模型和发布出口。", step: 1 };
  }
  if (pathname === "/experiments") {
    return { title: "查看当前可验证结果", description: "这里先汇总制作结果；平台表现要等导出或授权连接器接入后再复盘。", step: 5 };
  }
  return { title: "先选择内容从哪里来", description: "热点、系列和自己的观察都能开始；采用后核对证据与镜头方向，再创建成本可控的制作配方。", step: 0 };
}
