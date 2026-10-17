import { Dialog } from "@base-ui/react/dialog";
import { Command } from "cmdk";
import { ChartNoAxesCombined, Clapperboard, Images, Layers3, Radar, Search, Settings2, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import type { StudioOpportunity, StudioRunSummary } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { statusLabel } from "./StatusBadge.js";

type Props = {
  open: boolean;
  onClose(): void;
  returnFocus: RefObject<HTMLElement | null>;
  content: RefObject<HTMLDivElement | null>;
};

export function StudioSearchDialog({ open, onClose, returnFocus, content }: Props) {
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [opportunities, setOpportunities] = useState<StudioOpportunity[]>([]);
  const loaded = useRef(false);
  const navigating = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    // 保留既有只读搜索范围；打开搜索不发起生成或采用。
    void Promise.all([
      studioApi.runs().then(setRuns).catch(() => undefined),
      studioApi.opportunities().then(setOpportunities).catch(() => undefined),
    ]);
  }, [open]);
  useEffect(() => { if (open) navigating.current = false; }, [open]);

  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const destinations = useMemo(() => SEARCH_DESTINATIONS.filter((item) => !normalized
    || `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase("zh-CN").includes(normalized)), [normalized]);
  const matchingRuns = useMemo(() => runs.filter((run) => normalized
    && run.title.toLocaleLowerCase("zh-CN").includes(normalized)).slice(0, 6), [normalized, runs]);
  const matchingOpportunities = useMemo(() => opportunities
    .filter((item) => (item.status === "draft" || item.status === "shortlisted")
      && !runs.some((run) => run.opportunityId === item.id))
    .filter((item) => normalized
      && `${item.title} ${item.hook} ${item.audience}`.toLocaleLowerCase("zh-CN").includes(normalized))
    .slice(0, 5), [normalized, opportunities, runs]);


  function close() { onClose(); setQuery(""); }
  function choose(to: string) { navigating.current = true; navigate(to); close(); }
  function restoreFocus() {
    if (navigating.current) {
      // 弹层关闭后聚焦新的正文，避免默认策略选中正文内第一个操作。
      queueMicrotask(() => content.current?.focus({ preventScroll: true }));
      return false;
    }
    return returnFocus.current;
  }
  function result(to: string, value: string, children: ReactNode) {
    return <Command.Item key={value} value={value} onSelect={() => choose(to)} asChild>
      <a href={to} tabIndex={-1} onClick={(event) => event.preventDefault()}>{children}</a>
    </Command.Item>;
  }

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close(); }}>
    <Dialog.Portal className="studio-overlay-root">
      <Dialog.Backdrop className="studio-search-backdrop" />
      <Dialog.Popup className="studio-search-dialog" initialFocus={input} finalFocus={restoreFocus}>
        <Dialog.Title className="sr-only">搜索项目、选题或功能</Dialog.Title>
        <Dialog.Description className="sr-only">输入关键词，使用上下方向键选择，回车打开，Escape关闭。</Dialog.Description>
        <Command label="搜索项目、选题或功能" shouldFilter={false} loop>
          <div className="studio-search-field">
            <Search aria-hidden="true" size={20} />
            <Command.Input ref={input} value={query} onValueChange={setQuery} placeholder="搜索制作记录、选题或功能" />
            <Dialog.Close className="icon-button" aria-label="关闭搜索"><X aria-hidden="true" size={19} /></Dialog.Close>
          </div>
          <Command.List className="studio-search-results" label="搜索结果">
            {matchingRuns.length ? <Command.Group heading="制作记录">{matchingRuns.map((run) => result(`/projects/${run.id}`, `run:${run.id}`, <>
              <span><Clapperboard aria-hidden="true" size={18} /></span>
              <div className="studio-search-result-copy"><strong>{run.title}</strong><small>{formatSearchRunTime(run.startedAt)}</small></div>
              <small>{statusLabel(run.status)}</small>
            </>))}</Command.Group> : null}
            {matchingOpportunities.length ? <Command.Group heading="选题机会">{matchingOpportunities.map((item) => result(opportunitySearchTarget(item), `opportunity:${item.id}`, <>
              <span><Sparkles aria-hidden="true" size={18} /></span>
              <div className="studio-search-result-copy"><strong>{item.title}</strong><small>{item.origin === "series" ? "系列" : item.origin === "manual" ? "自有想法" : "热点"} · 待制作</small></div>
              <small>去继续</small>
            </>))}</Command.Group> : null}
            {destinations.length ? <Command.Group heading="功能">{destinations.map((item) => result(item.to, `destination:${item.to}`, <>
              <span><item.icon aria-hidden="true" size={18} /></span>
              <div className="studio-search-result-copy"><strong>{item.label}</strong><small>{item.description}</small></div>
            </>))}</Command.Group> : null}
            {!matchingRuns.length && !matchingOpportunities.length && !destinations.length ? <div className="studio-search-empty">没有匹配的制作记录、选题机会或功能。换一个更短的关键词试试。</div> : null}
          </Command.List>
          <div className="studio-search-hints"><span>↑ ↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></div>
        </Command>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function formatSearchRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function opportunitySearchTarget(opportunity: StudioOpportunity): string {
  if (opportunity.origin === "series") return `/topics?mode=series&opportunity=${encodeURIComponent(opportunity.id)}`;
  if (opportunity.origin === "manual") return `/topics?mode=custom&opportunity=${encodeURIComponent(opportunity.id)}`;
  return `/topics?opportunity=${encodeURIComponent(opportunity.id)}`;
}

const SEARCH_DESTINATIONS = [
  { to: "/resources#voice-casting", label: "声音演员与配音设置", description: "选择声音演员，调整语速、停顿与音色", keywords: "声音 配音 音色 演员 语速 停顿", icon: Settings2 },
  { to: "/", label: "创作台", description: "继续作品或开始新视频", keywords: "首页 工作台", icon: Radar },
  { to: "/topics", label: "选题中心", description: "热点、系列与自主选题", keywords: "新闻 趋势 灵感", icon: Sparkles },
  { to: "/projects", label: "制作记录", description: "查看、继续、归档或恢复制作", keywords: "项目 视频 成片", icon: Layers3 },
  { to: "/assets", label: "素材库", description: "检索画面、声音与授权记录", keywords: "媒体 资产 来源", icon: Images },
  { to: "/resources", label: "创作设置", description: "模型、素材、费用与发布平台", keywords: "总配置 API 方舟 MiniMax Codex", icon: Settings2 },
  { to: "/experiments", label: "制作复盘", description: "查看质量与费用表现", keywords: "数据 统计", icon: ChartNoAxesCombined },
] as const;
