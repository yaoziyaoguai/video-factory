import { useEffect, useReducer, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Clock3,
  Cpu,
  FileText,
  Film,
  FolderOpen,
  Maximize2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { MarkdownText } from "../markdown.js";
import {
  candidates,
  initialSkills,
  sampleFiles,
  sampleVideo,
  sampleVoice,
  type SampleSkill,
} from "./preview-content.js";
import {
  createPreviewState,
  currentConversation,
  currentWork,
  hasReusableVoice,
  previewReducer,
  topics,
  type PreviewStage,
} from "./preview-state.js";
import { PreviewSettings, type PreviewPage } from "./PreviewSettings.js";

const stageNames = {
  script: "内容草稿",
  plan: "画面与声音",
  video: "视频初稿",
};
const pageNames = {
  chat: "对话",
  models: "模型配置",
  services: "免费服务",
  skills: "Skill 管理",
  profile: "用户页",
};

export function PreviewWorkbench() {
  const [state, dispatch] = useReducer(
    previewReducer,
    undefined,
    createPreviewState,
  );
  const [page, setPage] = useState<PreviewPage>("chat");
  const [sideHidden, setSideHidden] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [skills, setSkills] = useState<SampleSkill[]>(initialSkills);
  const [skillId, setSkillId] = useState("");
  const [shownStages, setShownStages] = useState<Record<string, PreviewStage>>(
    {},
  );
  const [shownVersions, setShownVersions] = useState<Record<string, number>>(
    {},
  );
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<string | null>(null);
  const [focusPreview, setFocusPreview] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(850);
  const [notice, setNotice] = useState("");
  const [help, setHelp] = useState(false);
  const [unseenWork, setUnseenWork] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const conversation = currentConversation(state);
  const work = currentWork(state);
  const currentScript = work?.scripts.at(-1);
  const shownStage: PreviewStage = work
    ? (shownStages[work.id] ??
      (work.phase === "script"
        ? "script"
        : work.phase === "plan"
          ? "plan"
          : "video"))
    : "script";
  const script =
    work?.scripts.find((item) => item.version === shownVersions[work.id]) ??
    currentScript;
  const run = work?.runs.at(-1);
  const reusesVoice = work ? hasReusableVoice(work) : false;
  const voiceCharge = Boolean(work?.plan?.voice && !reusesVoice);
  const outputVideo =
    work?.topic === "coffee"
      ? run?.voice === false
        ? sampleFiles.coffeeSilent
        : sampleFiles.coffeeOutput
      : run?.voice === false
        ? sampleFiles.trailSilent
        : sampleVideo;
  const outputPoster =
    work?.topic === "coffee" ? sampleFiles.coffeeHome : sampleFiles.trailOne;
  const voiceSample =
    work?.topic === "coffee" ? sampleFiles.coffeeVoice : sampleVoice;
  const planIsCurrent = work?.plan?.scriptVersion === currentScript?.version;
  const selectedCandidate =
    candidates.find((item) => item.id === previewId) ??
    candidates.find((item) => item.id === work?.plan?.choices[0]);

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]!.contentRect.width;
      if (width > 0) setWorkspaceWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (atBottom && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [conversation.messages.length, state.active, atBottom]);
  useEffect(() => {
    if (help) helpDialog.current?.showModal();
    else helpDialog.current?.close();
  }, [help]);
  // 只模拟结果返回。定时器不确认草稿、不推进阶段，也不会访问制作服务。
  const runningKey = state.conversations
    .flatMap((item) =>
      item.works
        .filter((entry) => entry.phase === "running")
        .map((entry) => `${item.id}/${entry.id}`),
    )
    .join(",");
  useEffect(() => {
    const timers = state.conversations.flatMap((item) =>
      item.works
        .filter((entry) => entry.phase === "running")
        .map((entry) =>
          window.setTimeout(() => {
            dispatch({
              type: "complete",
              workId: entry.id,
              conversationId: item.id,
            });
            setUnseenWork(entry.id);
          }, 8000),
        ),
    );
    return () => timers.forEach(window.clearTimeout);
    // 仅当运行集合变化时计时，不因聊天、翻页或查看素材重新计时。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);

  const send = (text: string) => {
    if (!text.trim()) return;
    const previous = work;
    const selectedSkill = skills.find((item) => item.id === skillId);
    dispatch({
      type: "send",
      text,
      ...(selectedSkill ? { skillName: selectedSkill.name } : {}),
    });
    setSkillId("");
    setAtBottom(true);
    setFeedbackTarget(null);
    if (previous && /改|短|安静|确认|继续.*分镜|开始制作/.test(text)) {
      setShownStages((current) => {
        const next = { ...current };
        delete next[previous.id];
        return next;
      });
      setShownVersions((current) => {
        const next = { ...current };
        delete next[previous.id];
        return next;
      });
    }
  };
  const selectWork = (id: string) => {
    dispatch({ type: "select", workId: id });
    setPreviewId(null);
    setUnseenWork((current) => (current === id ? null : current));
    setFeedbackTarget(null);
  };
  const askFeedback = () => {
    if (!work) return;
    const target = `${work.title} · ${stageNames[shownStage]}${shownStage === "script" ? ` v${script!.version}` : ""}`;
    setFeedbackTarget(target);
    composer.current?.focus();
  };
  const phaseText = work
    ? (
        {
          script: "脚本等你看",
          plan: work.plan?.approved ? "方案已认可，尚未制作" : "方案等你看",
          running: "按已确认版本制作中",
          video: "视频初稿等你看",
          done: "已定稿",
        } as const
      )[work.phase]
    : "随时开始，也可以先聊想法";
  const quickActions = !work
    ? []
    : work.phase === "running"
      ? ["结尾再安静一点，记给下一版", "我们先聊点别的", "再做一条咖啡短片"]
      : work?.phase === "plan"
        ? ["这版方案认可，先别制作", "用原列表里的第二个", "我们先聊点别的"]
        : [
            "把开头改短一点",
            "结尾再安静一点",
            "再做一条咖啡短片",
            "先给我 Prompt",
          ];

  return (
    <div
      className={`agent-root preview-root${sideHidden ? " sidebar-hidden" : ""}`}
    >
      <aside className="agent-side">
        <div className="agent-brand">
          <span className="agent-brand-mark">f.</span>
          <div>
            <span className="agent-brand-name">
              帧间 <em>Frame</em>
            </span>
          </div>
        </div>
        <button
          className="agent-new-chat"
          onClick={() => {
            dispatch({ type: "new-conversation" });
            setPage("chat");
            setFeedbackTarget(null);
          }}
        >
          <Plus />
          新对话
        </button>
        <span className="agent-nav-label">对话</span>
        <nav className="agent-conversation-list" aria-label="会话列表">
          {state.conversations.map((item) => (
            <div
              className={`agent-conversation${state.active === item.id && page === "chat" ? " active" : ""}`}
              key={item.id}
            >
              <button
                className="agent-conversation-open"
                onClick={() => {
                  dispatch({ type: "conversation", id: item.id });
                  setPage("chat");
                  setFeedbackTarget(null);
                  setAtBottom(true);
                }}
              >
                <MessageSquare />
                <span className="agent-conversation-title">{item.title}</span>
              </button>
              <button
                className="agent-conversation-rename"
                aria-label={`重命名 ${item.title}`}
                onClick={() => {
                  dispatch({ type: "conversation", id: item.id });
                  setName(item.title);
                  setRenaming(true);
                }}
              >
                <Pencil />
              </button>
            </div>
          ))}
        </nav>
        <nav className="agent-module-nav" aria-label="模块导航">
          <button
            className={page === "models" ? "active" : ""}
            onClick={() => setPage("models")}
          >
            <Cpu />
            模型配置
          </button>
          <button
            className={page === "services" ? "active" : ""}
            onClick={() => setPage("services")}
          >
            <FolderOpen />
            免费服务
          </button>
          <button
            className={page === "skills" ? "active" : ""}
            onClick={() => setPage("skills")}
          >
            <Sparkles />
            Skill 管理
          </button>
          <button
            className="agent-profile-link"
            onClick={() => setPage("profile")}
          >
            <span className="agent-user-avatar">创</span>
            <span>
              <strong>创作者</strong>
              <small>用户页</small>
            </span>
            <ChevronRight />
          </button>
        </nav>
      </aside>
      <main className="agent-frame">
        <header className="agent-topbar preview-topbar">
          <button
            className="agent-icon-button"
            aria-label="切换侧栏"
            onClick={() => setSideHidden(!sideHidden)}
          >
            <PanelLeft />
          </button>
          {renaming ? (
            <form
              className="preview-rename"
              onSubmit={(event) => {
                event.preventDefault();
                dispatch({ type: "rename", title: name });
                setRenaming(false);
              }}
            >
              <input
                autoFocus
                aria-label="会话名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenaming(false);
                }}
              />
              <button type="submit" aria-label="保存名称">
                <Check />
              </button>
            </form>
          ) : (
            <h1>{page === "chat" ? conversation.title : pageNames[page]}</h1>
          )}
          {!renaming && page === "chat" ? (
            <button
              className="preview-icon"
              aria-label="重命名当前对话"
              onClick={() => {
                setName(conversation.title);
                setRenaming(true);
              }}
            >
              <Pencil />
            </button>
          ) : null}
          {sideHidden ? (
            <select
              aria-label="打开模块"
              className="preview-compact-nav"
              value={page}
              onChange={(event) => setPage(event.target.value as PreviewPage)}
            >
              {Object.entries(pageNames).map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          ) : null}
          <span className="preview-prototype-mark">
            <span />
            交互样稿 · 无模型 · 不计费
          </span>
          <button
            className="preview-icon"
            aria-label="样稿体验说明"
            onClick={() => setHelp(true)}
          >
            <MoreHorizontal />
          </button>
        </header>
        <div className="preview-chat-shell" hidden={page !== "chat"}>
          <Group
            orientation="horizontal"
            id="preview-conversation-layout"
            className="preview-outer-group"
          >
            {!focusPreview ? (
              <>
                <Panel
                  id="preview-chat"
                  defaultSize="350px"
                  minSize="300px"
                  maxSize="50%"
                  groupResizeBehavior="preserve-pixel-size"
                >
                  <section className="agent-chat">
                    <div
                      className="agent-messages"
                      ref={messages}
                      onScroll={(event) => {
                        const element = event.currentTarget;
                        setAtBottom(
                          element.scrollHeight -
                            element.scrollTop -
                            element.clientHeight <
                            70,
                        );
                      }}
                    >
                      {conversation.messages.length ? (
                        conversation.messages.map((message, index) => (
                          <article
                            className={`agent-message ${message.role}`}
                            key={index}
                          >
                            {message.role === "assistant" ? (
                              <span className="agent-assistant-avatar">f·</span>
                            ) : null}
                            <div className="agent-message-content">
                              {message.role === "assistant" ? (
                                <span className="agent-author">Frame</span>
                              ) : null}
                              {message.selectedSkill ? (
                                <small className="preview-selected-skill">
                                  <Sparkles />
                                  本次指定 · {message.selectedSkill}
                                </small>
                              ) : null}
                              <MarkdownText text={message.text} />
                              {message.card ? (
                                <div className="agent-references">
                                  <button
                                    onClick={() => {
                                      selectWork(message.card!.workId);
                                      setShownStages((current) => ({
                                        ...current,
                                        [message.card!.workId]:
                                          message.card!.stage,
                                      }));
                                      if (message.card!.stage === "script")
                                        setShownVersions((current) => ({
                                          ...current,
                                          [message.card!.workId]:
                                            message.card!.version,
                                        }));
                                    }}
                                  >
                                    <FileText />
                                    <span>
                                      <strong>
                                        {
                                          conversation.works.find(
                                            (item) =>
                                              item.id === message.card!.workId,
                                          )?.title
                                        }
                                      </strong>
                                      <small>
                                        {stageNames[message.card.stage]} · v
                                        {message.card.version}
                                      </small>
                                    </span>
                                    <ChevronRight />
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </article>
                        ))
                      ) : (
                        <div className="preview-chat-welcome">
                          <span className="agent-assistant-avatar">f·</span>
                          <h2>今天想做点什么？</h2>
                          <p>先聊想法、要一段 Prompt，或从一条视频开始。</p>
                          <button
                            onClick={() =>
                              send("开始做一条徒步短片，先给我脚本")
                            }
                          >
                            开始一条徒步短片
                            <ChevronRight />
                          </button>
                          <button
                            onClick={() => send("我想做视频，先给我 Prompt")}
                          >
                            先给我一个 Prompt
                            <ChevronRight />
                          </button>
                        </div>
                      )}
                    </div>
                    {!atBottom ? (
                      <button
                        className="preview-latest"
                        onClick={() => setAtBottom(true)}
                      >
                        回到最新消息 ↓
                      </button>
                    ) : null}
                    <div className="agent-composer">
                      <div className="preview-quick-actions">
                        {quickActions.map((text) => (
                          <button key={text} onClick={() => send(text)}>
                            {text}
                          </button>
                        ))}
                      </div>
                      {feedbackTarget ? (
                        <div className="agent-target-chip">
                          <span>针对：{feedbackTarget}</span>
                          <button
                            aria-label="取消反馈对象"
                            onClick={() => setFeedbackTarget(null)}
                          >
                            <X />
                          </button>
                        </div>
                      ) : null}
                      <form
                        className="agent-composer-card"
                        onSubmit={(event) => {
                          event.preventDefault();
                          send(conversation.draft);
                        }}
                      >
                        <textarea
                          ref={composer}
                          aria-label="聊天输入"
                          value={conversation.draft}
                          onChange={(event) =>
                            dispatch({
                              type: "draft",
                              text: event.target.value,
                            })
                          }
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              send(conversation.draft);
                            }
                          }}
                          placeholder="说说想法，改改作品，或换件事聊…"
                        />
                        <div className="agent-composer-tools">
                          <label className="agent-skill-selector">
                            <Sparkles />
                            <select
                              aria-label="指定 Skill"
                              value={
                                skills.some((item) => item.id === skillId)
                                  ? skillId
                                  : ""
                              }
                              onChange={(event) =>
                                setSkillId(event.target.value)
                              }
                            >
                              <option value="">Skill · 自动选择</option>
                              {skills.map((skill) => (
                                <option key={skill.id} value={skill.id}>
                                  {skill.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="preview-manage-skills"
                            type="button"
                            onClick={() => setPage("skills")}
                          >
                            管理
                          </button>
                          <button
                            type="submit"
                            className="agent-send"
                            disabled={!conversation.draft.trim()}
                            aria-label="发送"
                          >
                            <ArrowUp />
                          </button>
                        </div>
                      </form>
                      <span className="agent-composer-hint">
                        Enter 发送 · Shift + Enter 换行
                      </span>
                    </div>
                  </section>
                </Panel>
                <Separator
                  className="agent-resizer"
                  aria-label="调整聊天与展示区大小"
                />
              </>
            ) : null}
            <Panel id="preview-display" minSize="400px">
              <div className="preview-display" ref={workspace}>
                <div className="preview-display-toolbar">
                  <span>
                    <Clock3 />
                    {work?.phase === "running"
                      ? "制作期间也可以继续聊"
                      : "慢慢看，不限时"}
                  </span>
                  <button
                    className="preview-icon"
                    aria-label={focusPreview ? "返回聊天与作品" : "展开作品区"}
                    title={focusPreview ? "返回聊天与作品" : "展开作品区"}
                    onClick={() => setFocusPreview(!focusPreview)}
                  >
                    {focusPreview ? <ArrowLeft /> : <Maximize2 />}
                  </button>
                </div>
                {conversation.works.length ? (
                  <div
                    className="preview-work-tabs"
                    role="tablist"
                    aria-label="当前对话中的创作"
                  >
                    {conversation.works.map((item) => (
                      <button
                        key={item.id}
                        role="tab"
                        aria-selected={work?.id === item.id}
                        onClick={() => selectWork(item.id)}
                      >
                        <Film />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {
                              (
                                {
                                  script: "脚本待确认",
                                  plan: item.plan?.approved
                                    ? "方案已认可"
                                    : "方案待确认",
                                  running: "制作中",
                                  video: "初稿可看",
                                  done: "已定稿",
                                } as const
                              )[item.phase]
                            }
                          </small>
                        </span>
                        {unseenWork === item.id && work?.id !== item.id ? (
                          <span
                            className="preview-new-dot"
                            aria-label="有新产出"
                          />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {work && script ? (
                  <>
                    <div className="preview-work-heading">
                      <div>
                        <h2>{work.title}</h2>
                        <span className="preview-phase-status">
                          {phaseText}
                        </span>
                      </div>
                      <button
                        className="preview-secondary"
                        onClick={askFeedback}
                      >
                        <Pencil />
                        提意见
                      </button>
                    </div>
                    <div
                      className="preview-stage-tabs"
                      role="tablist"
                      aria-label="查看创作阶段"
                    >
                      {(["script", "plan", "video"] as const).map(
                        (stage, index) => (
                          <button
                            role="tab"
                            key={stage}
                            aria-selected={shownStage === stage}
                            disabled={
                              stage === "plan"
                                ? !work.plan
                                : stage === "video"
                                  ? !run
                                  : false
                            }
                            onClick={() =>
                              setShownStages({
                                ...shownStages,
                                [work.id]: stage,
                              })
                            }
                          >
                            <span>{index + 1}</span>
                            {stageNames[stage]}
                            {(stage === "script" &&
                              work.confirmedScript ===
                                currentScript?.version) ||
                            (stage === "plan" && work.plan?.approved) ||
                            (stage === "video" && work.phase === "done") ? (
                              <Check />
                            ) : null}
                          </button>
                        ),
                      )}
                    </div>
                    <Group
                      key={workspaceWidth < 640 ? "stacked" : "side-by-side"}
                      orientation={
                        workspaceWidth < 640 ? "vertical" : "horizontal"
                      }
                      className="preview-inner-group"
                      id="preview-draft-layout"
                    >
                      <Panel
                        id="preview-draft"
                        defaultSize="55%"
                        minSize={workspaceWidth < 640 ? "210px" : "300px"}
                      >
                        <section
                          className="preview-draft-pane"
                          aria-label="草稿与修改"
                        >
                          <div className="preview-pane-title">
                            <h3>草稿与修改</h3>
                            <span>{stageNames[shownStage]}</span>
                          </div>
                          <div className="preview-draft-scroll">
                            {shownStage === "script" ? (
                              <>
                                <div className="preview-draft-meta">
                                  <span>20 秒 · 横屏 · 轻旁白</span>
                                  <label className="preview-version">
                                    <select
                                      aria-label="查看脚本版本"
                                      value={script.version}
                                      onChange={(event) =>
                                        setShownVersions({
                                          ...shownVersions,
                                          [work.id]: Number(event.target.value),
                                        })
                                      }
                                    >
                                      {work.scripts.map((item) => (
                                        <option
                                          key={item.version}
                                          value={item.version}
                                        >
                                          脚本 v{item.version}
                                          {item.version ===
                                          currentScript!.version
                                            ? " · 最新"
                                            : ""}
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                </div>
                                {script.version > 1 ? (
                                  <p className="preview-change-note">
                                    {script.change}
                                  </p>
                                ) : null}
                                <div className="preview-script">
                                  <p className="preview-script-intent">
                                    {work.topic === "trail"
                                      ? "留住周末的呼吸感，不追求打卡和距离。"
                                      : "用一杯咖啡的时间，把普通早晨拍得有感觉。"}
                                  </p>
                                  <h4>开场</h4>
                                  <p>{script.opening}</p>
                                  <p className="preview-screen-direction">
                                    {work.topic === "trail"
                                      ? "远景起，小路和背影进入画面。镜头缓慢向前，保留脚步声，不急着出现标题。"
                                      : "窗边的光、手和杯子进入画面。先听见细小的水声，再看见咖啡。"}
                                  </p>
                                  <h4>中段</h4>
                                  <p>{topics[work.topic].middle}</p>
                                  <p className="preview-screen-direction">
                                    两个画面之间自然切换。画面承担情绪，旁白只留一句，不逐镜头解释。
                                  </p>
                                  <h4>结尾</h4>
                                  <p>{script.ending}</p>
                                  <p className="preview-screen-direction">
                                    画面停留，最后淡出。片名在结尾出现，留一点余味。
                                  </p>
                                </div>
                                {work.plan && !planIsCurrent ? (
                                  <div className="preview-inline-note">
                                    已有画面方案仍基于脚本 v
                                    {work.plan.scriptVersion}
                                    。这版确认后再更新，暂不制作。
                                  </div>
                                ) : null}
                              </>
                            ) : shownStage === "plan" && work.plan ? (
                              <>
                                <div className="preview-draft-meta">
                                  <span>
                                    方案 v{work.plan.version} · 依据脚本 v
                                    {work.plan.scriptVersion}
                                  </span>
                                  <span className="preview-status">
                                    {work.plan.approved ? "已认可" : "待你确认"}
                                  </span>
                                </div>
                                {!planIsCurrent ? (
                                  <div className="preview-inline-note">
                                    脚本已有新稿，这份方案尚未更新。请先确认最新脚本。
                                  </div>
                                ) : null}
                                <div className="preview-shot-list">
                                  {work.plan.choices.map((id, index) => {
                                    const candidate = candidates.find(
                                      (item) => item.id === id,
                                    )!;
                                    return (
                                      <article
                                        key={index}
                                        className="preview-shot"
                                      >
                                        <button
                                          className="preview-shot-image"
                                          aria-label={`预览镜头 ${index + 1}`}
                                          onClick={() => setPreviewId(id)}
                                        >
                                          <img
                                            alt={candidate.name}
                                            src={candidate.image}
                                          />
                                          <span>{index + 1}</span>
                                        </button>
                                        <div>
                                          <strong>{candidate.name}</strong>
                                          <small>
                                            {index < 2
                                              ? `${index * 6}–${index * 6 + 6} 秒 · 视频`
                                              : "12–20 秒 · 静态图"}
                                          </small>
                                          <p>
                                            {index === 0
                                              ? "先让人进入环境"
                                              : index === 1
                                                ? "拉近到细节，保持呼吸感"
                                                : "留白，不再增加信息"}
                                          </p>
                                        </div>
                                      </article>
                                    );
                                  })}
                                </div>
                                {run?.notes.length &&
                                work.plan.version > run.planVersion ? (
                                  <div className="preview-next-notes">
                                    <h4>下一版要调整</h4>
                                    <ul>
                                      {run.notes.map((note, index) => (
                                        <li key={index}>{note}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                                <div className="preview-sound-plan">
                                  <h4>声音</h4>
                                  <label>
                                    <input
                                      type="checkbox"
                                      checked={work.plan.voice}
                                      disabled={work.phase !== "plan"}
                                      onChange={(event) =>
                                        dispatch({
                                          type: "voice",
                                          workId: work.id,
                                          enabled: event.target.checked,
                                        })
                                      }
                                    />
                                    {reusesVoice
                                      ? "沿用已有旁白"
                                      : "加入轻旁白"}
                                  </label>
                                  <p>
                                    {reusesVoice && work.plan.voice
                                      ? "旁白文字没有改变，继续使用已有声音，不重新生成。"
                                      : work.plan.voice
                                        ? "压低素材原声，以旁白串起画面；不额外生成背景音乐。"
                                        : "不加付费旁白；使用无声示例，先判断画面节奏。"}
                                  </p>
                                </div>
                                <div className="preview-production-scope">
                                  <h4>这次制作</h4>
                                  <dl>
                                    <div>
                                      <dt>画面</dt>
                                      <dd>两段已有视频 + 一张图片</dd>
                                    </div>
                                    <div>
                                      <dt>声音</dt>
                                      <dd>
                                        {reusesVoice && work.plan.voice
                                          ? "沿用已有配音"
                                          : work.plan.voice
                                            ? "MiniMax 配音（示例选型）"
                                            : "不使用付费配音"}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>剪辑</dt>
                                      <dd>裁切、拼接，20 秒横屏短片</dd>
                                    </div>
                                    <div>
                                      <dt>生成图片 / 视频</dt>
                                      <dd>不调用</dd>
                                    </div>
                                  </dl>
                                  <div className="preview-cost">
                                    <span>示例估价</span>
                                    <strong>
                                      {voiceCharge ? "¥0.40" : "¥0.00"}
                                    </strong>
                                  </div>
                                  <p>样稿仅回放交互，不会实际计费。</p>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="preview-draft-meta">
                                  <span>
                                    {run
                                      ? `视频 v${run.version} · 脚本 v${run.scriptVersion} / 方案 v${run.planVersion}`
                                      : "视频初稿"}
                                  </span>
                                </div>
                                {work.phase === "running" ? (
                                  <div className="preview-run-state">
                                    <Film />
                                    <h3>按确认的版本制作中</h3>
                                    <p>
                                      你可以切去聊别的。结果回来会提示，不会自动切走你正在看的内容。
                                    </p>
                                    <button
                                      className="preview-secondary"
                                      onClick={() => {
                                        dispatch({
                                          type: "complete",
                                          workId: work.id,
                                          conversationId: conversation.id,
                                        });
                                        setUnseenWork(work.id);
                                      }}
                                    >
                                      查看示例结果
                                    </button>
                                  </div>
                                ) : (
                                  <div className="preview-run-state">
                                    <Check />
                                    <h3>
                                      {work.phase === "done"
                                        ? "这一版已定稿"
                                        : "先看这一版的整体感觉"}
                                    </h3>
                                    <p>
                                      右边可以直接播放。节奏、画面或声音哪里不对，直接提意见；认可后保留同一份视频。
                                    </p>
                                  </div>
                                )}
                                {run?.notes.length ? (
                                  <div className="preview-next-notes">
                                    <h4>给下一版的意见</h4>
                                    <ul>
                                      {run.notes.map((note, index) => (
                                        <li key={index}>{note}</li>
                                      ))}
                                    </ul>
                                  </div>
                                ) : null}
                                <p className="preview-config-footnote">
                                  播放器使用本地样例，帮助体验审阅与修改位置；不会随任意文字意见真实重剪。
                                </p>
                              </>
                            )}
                          </div>
                          <div className="preview-review-actions">
                            {shownStage === "script" ? (
                              work.phase === "running" ? (
                                <span className="preview-muted">
                                  制作使用已确认版本，新意见留给下一版。
                                </span>
                              ) : script.version !== currentScript!.version ? (
                                <button
                                  className="preview-secondary"
                                  onClick={() =>
                                    setShownVersions({
                                      ...shownVersions,
                                      [work.id]: currentScript!.version,
                                    })
                                  }
                                >
                                  查看最新脚本
                                </button>
                              ) : (
                                <>
                                  <span>
                                    {work.confirmedScript === script.version
                                      ? "已确认，已有画面方案"
                                      : "确认后，我再整理画面与声音"}
                                  </span>
                                  <button
                                    className="preview-primary"
                                    onClick={() => {
                                      dispatch({
                                        type: "confirm-script",
                                        workId: work.id,
                                        version: script.version,
                                      });
                                      setShownStages({
                                        ...shownStages,
                                        [work.id]: "plan",
                                      });
                                      setPreviewId(
                                        topics[work.topic].choices[0]!,
                                      );
                                      setAtBottom(true);
                                    }}
                                  >
                                    {work.confirmedScript === script.version &&
                                    planIsCurrent
                                      ? "查看画面方案"
                                      : "确认脚本，继续"}
                                    <ChevronRight />
                                  </button>
                                </>
                              )
                            ) : shownStage === "plan" && work.plan ? (
                              work.phase === "plan" && planIsCurrent ? (
                                <>
                                  <button
                                    className="preview-text-button"
                                    onClick={() => {
                                      dispatch({
                                        type: "approve-plan",
                                        workId: work.id,
                                      });
                                      setAtBottom(true);
                                    }}
                                  >
                                    认可方案，先不制作
                                  </button>
                                  <span className="preview-action-cost">
                                    {voiceCharge
                                      ? "仅配音 · 约 ¥0.40"
                                      : "本地剪辑 · ¥0.00"}
                                  </span>
                                  <button
                                    className="preview-primary"
                                    onClick={() => {
                                      dispatch({
                                        type: "start",
                                        workId: work.id,
                                      });
                                      setShownStages({
                                        ...shownStages,
                                        [work.id]: "video",
                                      });
                                      setAtBottom(true);
                                    }}
                                  >
                                    按本方案制作
                                    <ChevronRight />
                                  </button>
                                </>
                              ) : (
                                <span className="preview-muted">
                                  {!planIsCurrent
                                    ? "先确认最新脚本，再更新这份方案"
                                    : "这份方案已用于制作，版本保持不变"}
                                </span>
                              )
                            ) : work.phase === "video" ? (
                              <>
                                {run?.notes.length ? (
                                  <button
                                    className="preview-secondary"
                                    onClick={() => {
                                      dispatch({
                                        type: "next-version",
                                        workId: work.id,
                                      });
                                      setShownStages({
                                        ...shownStages,
                                        [work.id]: "plan",
                                      });
                                      setAtBottom(true);
                                    }}
                                  >
                                    准备下一版方案
                                  </button>
                                ) : (
                                  <button
                                    className="preview-secondary"
                                    onClick={askFeedback}
                                  >
                                    <Pencil />
                                    提意见
                                  </button>
                                )}
                                <button
                                  className="preview-primary"
                                  onClick={() => {
                                    dispatch({
                                      type: "finalize",
                                      workId: work.id,
                                    });
                                    setAtBottom(true);
                                  }}
                                >
                                  <Check />
                                  以这版定稿
                                </button>
                              </>
                            ) : work.phase === "done" ? (
                              <>
                                <button
                                  className="preview-secondary"
                                  onClick={() => {
                                    dispatch({
                                      type: "next-version",
                                      workId: work.id,
                                    });
                                    setShownStages({
                                      ...shownStages,
                                      [work.id]: run?.notes.length
                                        ? "plan"
                                        : "script",
                                    });
                                    setAtBottom(true);
                                  }}
                                >
                                  准备下一版
                                </button>
                                <a
                                  className="preview-download"
                                  href={outputVideo}
                                  download="帧间-本地样例.mp4"
                                >
                                  下载示例视频
                                </a>
                              </>
                            ) : (
                              <span className="preview-muted">
                                制作已开始，可继续聊天或记下意见
                              </span>
                            )}
                          </div>
                        </section>
                      </Panel>
                      <Separator
                        className={`preview-inner-separator${workspaceWidth < 640 ? " vertical" : ""}`}
                        aria-label="调整草稿与预览大小"
                      />
                      <Panel
                        id="preview-media"
                        minSize={workspaceWidth < 640 ? "170px" : "260px"}
                      >
                        <section
                          className="preview-media-pane"
                          aria-label="素材与视频预览"
                        >
                          <div className="preview-pane-title">
                            <h3>素材与视频预览</h3>
                            <span>
                              {shownStage === "video" &&
                              run?.status === "completed"
                                ? "本地视频样例"
                                : "已有素材"}
                            </span>
                          </div>
                          <div className="preview-media-scroll">
                            {shownStage === "video" &&
                            run?.status === "completed" ? (
                              <>
                                <video
                                  key={`${work.id}-${run.version}`}
                                  controls
                                  playsInline
                                  preload="metadata"
                                  poster={outputPoster}
                                  src={outputVideo}
                                />
                                <div className="preview-media-caption">
                                  <strong>视频初稿 · v{run.version}</strong>
                                  <span>
                                    20 秒 · 本地样例 ·{" "}
                                    {work.phase === "done"
                                      ? "已定稿"
                                      : "待你审阅"}
                                  </span>
                                </div>
                              </>
                            ) : selectedCandidate && work.plan ? (
                              <>
                                <div className="preview-media-frame">
                                  {selectedCandidate.kind === "video" ? (
                                    <video
                                      key={selectedCandidate.id}
                                      controls
                                      playsInline
                                      preload="metadata"
                                      poster={selectedCandidate.image}
                                      src={selectedCandidate.video}
                                    />
                                  ) : (
                                    <img
                                      src={selectedCandidate.image}
                                      alt={selectedCandidate.name}
                                    />
                                  )}
                                </div>
                                <div className="preview-media-caption">
                                  <strong>{selectedCandidate.name}</strong>
                                  <span>
                                    {selectedCandidate.duration} · 参考素材
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="preview-no-media">
                                <Film />
                                <h3>先把内容想清楚</h3>
                                <p>
                                  脚本确认后，素材、试听和画面会在这里展开。
                                </p>
                              </div>
                            )}
                            {work.plan ? (
                              <>
                                <div className="preview-section-heading preview-material-heading">
                                  <h4>这条短片的素材</h4>
                                  <span>看完再选，不急</span>
                                </div>
                                <div className="preview-candidate-list">
                                  {candidates
                                    .filter((item) =>
                                      topics[work.topic].choices.includes(
                                        item.id,
                                      ),
                                    )
                                    .map((candidate, index) => (
                                      <article
                                        className={
                                          selectedCandidate?.id === candidate.id
                                            ? "selected"
                                            : ""
                                        }
                                        key={candidate.id}
                                      >
                                        <button
                                          className="preview-candidate-open"
                                          onClick={() =>
                                            setPreviewId(candidate.id)
                                          }
                                          aria-label={`查看候选 ${index + 1}：${candidate.name}`}
                                        >
                                          <img src={candidate.image} alt="" />
                                          <span>
                                            <strong>{candidate.name}</strong>
                                            <small>
                                              {candidate.kind === "video"
                                                ? "视频"
                                                : "图片"}{" "}
                                              · 第 {index + 1} 项
                                            </small>
                                          </span>
                                          <Play />
                                        </button>
                                        <button
                                          className="preview-candidate-use"
                                          disabled={work.phase !== "plan"}
                                          onClick={() => {
                                            dispatch({
                                              type: "choose",
                                              workId: work.id,
                                              slot:
                                                candidate.kind === "image"
                                                  ? 2
                                                  : 0,
                                              candidate: candidate.id,
                                            });
                                            setPreviewId(candidate.id);
                                            setNotice(
                                              `“${candidate.name}”已放进方案，尚未开始制作。`,
                                            );
                                          }}
                                        >
                                          {work.plan!.choices[
                                            candidate.kind === "image" ? 2 : 0
                                          ] === candidate.id
                                            ? "已选用"
                                            : "选用"}
                                        </button>
                                      </article>
                                    ))}
                                </div>
                                <div className="preview-voice-sample">
                                  <h4>
                                    <Volume2 />
                                    旁白试听
                                  </h4>
                                  <audio
                                    controls
                                    preload="metadata"
                                    src={voiceSample}
                                  />
                                  <small>
                                    本地系统语音示例，不代表实际供应商音色。
                                  </small>
                                </div>
                              </>
                            ) : null}
                          </div>
                        </section>
                      </Panel>
                    </Group>
                  </>
                ) : (
                  <div className="preview-empty-workspace">
                    <Film />
                    <h2>先聊聊，再开始创作</h2>
                    <p>
                      普通聊天和 Prompt
                      留在对话里。正式开始后，每一步草稿会在这里等你看。
                    </p>
                    <button
                      className="preview-secondary"
                      onClick={() => send("开始做一条徒步短片，先给我脚本")}
                    >
                      开始一条短片
                    </button>
                  </div>
                )}
              </div>
            </Panel>
          </Group>
        </div>
        <PreviewSettings
          page={page}
          skills={skills}
          onSkillsChange={(value) => {
            setSkills(value);
            if (!value.some((item) => item.id === skillId)) setSkillId("");
          }}
          onPage={setPage}
        />
        {notice ? (
          <div className="preview-toast" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        ) : null}
      </main>
      <dialog
        ref={helpDialog}
        className="preview-dialog"
        onCancel={() => setHelp(false)}
        aria-label="样稿体验说明"
      >
        <header>
          <h3>第一阶段 · 交互样稿</h3>
          <button
            className="preview-icon"
            aria-label="关闭说明"
            onClick={() => setHelp(false)}
          >
            <X />
          </button>
        </header>
        <p>
          你正在体验创作交互，未连接真实模型、制作服务或日常数据。素材与声音为本地样例。
        </p>
        <p>
          可体验徒步与咖啡两条短片、开头缩短/结尾留白、草稿确认、跨话题、模型与
          Skill 管理。自由输入仅支持这些有限回放，不模拟通用理解。
        </p>
        <p>刷新会恢复初始示例；全部安装、卸载和模型切换仅作用于这份样稿。</p>
        <footer>
          <button
            className="preview-secondary"
            onClick={() => window.location.reload()}
          >
            <RotateCcw />
            重置样稿
          </button>
          <button className="preview-primary" onClick={() => setHelp(false)}>
            继续体验
          </button>
        </footer>
      </dialog>
    </div>
  );
}
