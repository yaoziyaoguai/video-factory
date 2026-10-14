import { Focus, PanelRightOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

type WorkspacePane = "draft" | "discussion";
type WorkspaceLayout = "split" | "stacked" | "mobile";

interface CreativeWorkspacePanelsProps {
  draft: ReactNode;
  discussion: ReactNode;
  activePane: WorkspacePane;
  onPaneChange(pane: WorkspacePane): void;
  discussionOpen: boolean;
  onDiscussionOpenChange(open: boolean): void;
  messageCount: number;
}

function readLayout(): WorkspaceLayout {
  if (window.matchMedia("(max-width: 700px)").matches) return "mobile";
  return window.matchMedia("(max-width: 1000px)").matches ? "stacked" : "split";
}

export function CreativeWorkspacePanels({ draft, discussion, activePane, onPaneChange, discussionOpen, onDiscussionOpenChange, messageCount }: CreativeWorkspacePanelsProps) {
  const [layout, setLayout] = useState(readLayout);
  const draftRef = useRef<HTMLDivElement>(null);
  const discussionRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const draftTabRef = useRef<HTMLButtonElement>(null);
  const discussionTabRef = useRef<HTMLButtonElement>(null);
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const mobile = layout === "mobile";
  const visiblePane = discussionOpen ? activePane : "draft";
  const draftHidden = mobile && visiblePane !== "draft";
  const discussionHidden = !discussionOpen || mobile && visiblePane !== "discussion";
  const resizable = layout === "split" && discussionOpen;

  useEffect(() => {
    const queries = [window.matchMedia("(max-width: 700px)"), window.matchMedia("(max-width: 1000px)")];
    const update = () => setLayout(readLayout());
    queries.forEach(query => query.addEventListener("change", update));
    update();
    return () => queries.forEach(query => query.removeEventListener("change", update));
  }, []);

  useLayoutEffect(() => {
    const active = document.activeElement;
    const focusWasHidden = draftHidden && draftRef.current?.contains(active)
      || discussionHidden && discussionRef.current?.contains(active)
      || !resizable && separatorRef.current?.contains(active)
      || !mobile && tabsRef.current?.contains(active)
      || mobile && active === focusButtonRef.current;
    if (!focusWasHidden) return;
    const target = mobile ? visiblePane === "draft" ? draftTabRef.current : discussionTabRef.current : focusButtonRef.current;
    target?.focus({ preventScroll: true });
  }, [draftHidden, discussionHidden, mobile, resizable, visiblePane]);

  return <div className="creative-workspace">
    <div className="creative-workspace-tools">
      <div ref={tabsRef} className="creative-mobile-tabs" role="group" aria-label="方案与讨论" aria-hidden={!mobile || undefined} inert={!mobile}>
        <button ref={draftTabRef} type="button" aria-pressed={visiblePane === "draft"} aria-controls="creative-draft" onClick={() => onPaneChange("draft")}>当前方案</button>
        <button ref={discussionTabRef} type="button" aria-pressed={visiblePane === "discussion"} aria-controls="creative-chat" onClick={() => {
          onDiscussionOpenChange(true);
          onPaneChange("discussion");
        }}>建议与讨论{messageCount > 0 ? ` · ${messageCount}` : ""}</button>
      </div>
      <button ref={focusButtonRef} type="button" className="button button-secondary creative-reading-focus" aria-controls="creative-chat"
        aria-expanded={discussionOpen} aria-hidden={mobile || undefined} inert={mobile} onClick={() => onDiscussionOpenChange(!discussionOpen)}>
        {discussionOpen ? <Focus aria-hidden="true" size={17} /> : <PanelRightOpen aria-hidden="true" size={17} />}
        {discussionOpen ? "专注读稿" : "展开建议与讨论"}
      </button>
    </div>
    {/* 始终保留同一棵分栏树；断点和收起只影响布局，不卸载输入、选区或中文组合输入。 */}
    <Group className="creative-discussion-layout" orientation="horizontal" disabled={!resizable} style={{ height: "auto", overflow: "visible" }}
      data-workspace-layout={layout} data-discussion-open={discussionOpen}>
      <Panel id="creative-manuscript-panel" defaultSize="69%" minSize="48%" elementRef={draftRef} style={{ overflow: "visible" }}
        data-workspace-pane="draft" hidden={draftHidden} aria-hidden={draftHidden || undefined} inert={draftHidden}>
        {draft}
      </Panel>
      <Separator elementRef={separatorRef} className="creative-workspace-separator" disabled={!resizable} aria-hidden={!resizable || undefined} inert={!resizable}
        aria-label="调整稿件与讨论的宽度" title="拖动或用左右方向键调整，双击恢复默认宽度">
        <span aria-hidden="true" />
      </Separator>
      <Panel id="creative-conversation-panel" defaultSize="31%" minSize={270} maxSize="48%" elementRef={discussionRef} style={{ overflow: "visible" }}
        data-workspace-pane="discussion" hidden={discussionHidden} aria-hidden={discussionHidden || undefined} inert={discussionHidden}>
        {discussion}
      </Panel>
    </Group>
  </div>;
}
