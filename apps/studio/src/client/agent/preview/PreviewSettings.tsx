import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Cpu,
  FolderOpen,
  Image,
  KeyRound,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Volume2,
  Video,
  X,
} from "lucide-react";
import {
  modelDirectory,
  modelKinds,
  type ModelKind,
  type SampleSkill,
} from "./preview-content.js";

export type PreviewPage = "chat" | "models" | "skills" | "services" | "profile";
const kindIcons = { text: Cpu, image: Image, video: Video, speech: Volume2 };

export function PreviewSettings({
  page,
  skills,
  onSkillsChange,
  onPage,
}: {
  page: PreviewPage;
  skills: SampleSkill[];
  onSkillsChange: (skills: SampleSkill[]) => void;
  onPage: (page: PreviewPage) => void;
}) {
  const [kind, setKind] = useState<ModelKind>("text");
  const [choices, setChoices] = useState<Record<ModelKind, string[]>>({
    text: ["qwen", "deepseek"],
    image: ["seedream"],
    video: ["seedance", "wan-video"],
    speech: ["minimax"],
  });
  const [active, setActive] = useState<Record<ModelKind, string | null>>({
    text: "qwen",
    image: "seedream",
    video: "seedance",
    speech: "minimax",
  });
  const [selectedProvider, setSelectedProvider] = useState("阿里云百炼");
  const [selectedModelId, setSelectedModelId] = useState("qwen");
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState("");
  const [removingModel, setRemovingModel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    "install" | "connection" | SampleSkill | null
  >(null);
  const [source, setSource] = useState("");
  const [connectionProvider, setConnectionProvider] = useState("阿里云百炼");
  const [connectionDraft, setConnectionDraft] = useState({
    address: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    key: "demo-key-only-not-a-real-key",
  });
  const [connections, setConnections] = useState<
    Record<string, { address: string; key: string }>
  >({
    阿里云百炼: {
      address: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      key: "demo-key-only-not-a-real-key",
    },
    DeepSeek: {
      address: "https://api.deepseek.com",
      key: "demo-deepseek-not-a-real-key",
    },
    Anthropic: {
      address: "https://api.anthropic.com",
      key: "demo-anthropic-not-a-real-key",
    },
    火山方舟: {
      address: "https://ark.cn-beijing.volces.com/api/v3",
      key: "demo-ark-not-a-real-key",
    },
    MiniMax: {
      address: "https://api.minimax.chat/v1",
      key: "demo-minimax-not-a-real-key",
    },
  });
  const [thinking, setThinking] = useState("default");
  const [freeServices, setFreeServices] = useState({
    materials: true,
    trends: false,
  });
  const [displayName, setDisplayName] = useState("创作者");
  const modal = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (dialog) modal.current?.showModal();
    else if (modal.current?.open) {
      modal.current.close();
      opener.current?.focus();
    }
  }, [dialog]);
  const current = modelDirectory[kind].find((item) => item.id === active[kind]);
  const providers = [
    ...new Set(modelDirectory[kind].map((item) => item.provider)),
  ];
  const selectedModel = modelDirectory[kind].find(
    (item) => item.id === selectedModelId,
  );
  const KindIcon = kindIcons[kind];
  const removeModel = (id: string) => {
    if (active[kind] === id) {
      setRemovingModel(id);
      return;
    }
    setChoices({
      ...choices,
      [kind]: choices[kind].filter((item) => item !== id),
    });
    setNotice("已从备选移除，连接和历史记录保留。");
  };

  return (
    <section
      className="agent-settings-page preview-settings"
      hidden={page === "chat"}
    >
      {page === "models" ? (
        <>
          <div className="preview-settings-heading">
            <div>
              <h2>模型配置</h2>
              <p>每类一个当前使用，按需保留备选。</p>
            </div>
            <button
              className="preview-secondary"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setConnectionProvider(selectedProvider);
                setConnectionDraft({ ...connections[selectedProvider]! });
                setDialog("connection");
              }}
            >
              <KeyRound />
              连接配置
            </button>
          </div>
          <div
            className="preview-model-tabs"
            role="tablist"
            aria-label="模型用途"
          >
            {modelKinds.map((item) => {
              const Icon = kindIcons[item.id];
              return (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={kind === item.id}
                  onClick={() => {
                    const next = modelDirectory[item.id].find(
                      (model) => model.id === active[item.id],
                    );
                    setKind(item.id);
                    setSelectedProvider(
                      next?.provider ?? modelDirectory[item.id][0]!.provider,
                    );
                    setSelectedModelId(next?.id ?? "");
                    setNotice("");
                    setRemovingModel(null);
                  }}
                >
                  <Icon />
                  {item.name}
                </button>
              );
            })}
          </div>
          <div className="preview-current-model">
            <div className="preview-current-label">
              <span>
                <KindIcon />
                当前使用
              </span>
              {current ? (
                <span className="preview-status">
                  <Check />
                  用于新的请求和方案
                </span>
              ) : null}
            </div>
            {current ? (
              <>
                <h3>{current.name}</h3>
                <code className="preview-model-id">{current.modelId}</code>
                <p>
                  {current.provider} · {current.description}
                </p>
              </>
            ) : (
              <>
                <h3>还没有当前模型</h3>
                <p>选择供应商和具体型号后应用。</p>
              </>
            )}
            <form
              className="preview-model-picker"
              onSubmit={(event) => {
                event.preventDefault();
                if (!selectedModel?.supported) return;
                setActive({ ...active, [kind]: selectedModel.id });
                if (!choices[kind].includes(selectedModel.id)) {
                  setChoices({
                    ...choices,
                    [kind]: [...choices[kind], selectedModel.id],
                  });
                }
                setRemovingModel(null);
                setNotice(
                  `当前模型已切换到 ${selectedModel.name}。已有制作保持原方案。`,
                );
              }}
            >
              <label>
                供应商连接
                <select
                  value={selectedProvider}
                  onChange={(event) => {
                    setSelectedProvider(event.target.value);
                    setSelectedModelId("");
                    setNotice("");
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label>
                具体型号
                <select
                  required
                  value={selectedModelId}
                  onChange={(event) => {
                    setSelectedModelId(event.target.value);
                    setNotice("");
                  }}
                >
                  <option value="" disabled>
                    请选择具体型号
                  </option>
                  {modelDirectory[kind]
                    .filter((item) => item.provider === selectedProvider)
                    .map((item) => (
                      <option
                        key={item.id}
                        value={item.id}
                        disabled={!item.supported}
                      >
                        {item.name} · {item.modelId}
                        {item.supported ? "" : "（尚未接入）"}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="preview-primary"
                type="submit"
                disabled={
                  !selectedModel?.supported || selectedModel.id === active[kind]
                }
              >
                应用选择
              </button>
            </form>
            {kind === "text" && current ? (
              <label className="preview-reasoning">
                推理强度
                <select
                  value={thinking}
                  onChange={(event) => setThinking(event.target.value)}
                >
                  <option value="default">跟随模型默认</option>
                  <option value="low">低</option>
                  <option value="high">高</option>
                </select>
              </label>
            ) : null}
          </div>
          <div className="preview-section-heading">
            <h3>
              备选模型{" "}
              <span>
                {choices[kind].filter((id) => id !== active[kind]).length}
              </span>
            </h3>
            <button
              className="preview-secondary"
              aria-expanded={managing}
              onClick={() => setManaging(!managing)}
            >
              <Plus />
              管理备选
              <ChevronDown />
            </button>
          </div>
          <div className="preview-model-list">
            {modelDirectory[kind]
              .filter(
                (item) =>
                  choices[kind].includes(item.id) && item.id !== active[kind],
              )
              .map((item) => (
                <div className="preview-model-row" key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.provider}</span>
                    <code className="preview-model-id">{item.modelId}</code>
                    <p>{item.description}</p>
                  </div>
                  <div className="preview-row-actions">
                    {item.supported ? (
                      <button
                        className="preview-secondary"
                        onClick={() => {
                          setActive({ ...active, [kind]: item.id });
                          setSelectedProvider(item.provider);
                          setSelectedModelId(item.id);
                          setRemovingModel(null);
                          setNotice(
                            `已切换到 ${item.name}。已有制作保持原方案。`,
                          );
                        }}
                      >
                        设为当前
                      </button>
                    ) : (
                      <span className="preview-muted">尚未接入执行</span>
                    )}
                    <button
                      className="preview-icon"
                      aria-label={`移除 ${item.name}`}
                      onClick={() => removeModel(item.id)}
                    >
                      <Trash2 />
                    </button>
                  </div>
                </div>
              ))}
          </div>
          {removingModel ? (
            <div className="preview-inline-confirm" role="alert">
              <p>
                这是当前使用的模型。移除后，此类暂时不可用；不会自动换成其他模型。
              </p>
              <button
                className="preview-secondary"
                onClick={() => setRemovingModel(null)}
              >
                保留
              </button>
              <button
                className="preview-secondary"
                onClick={() => {
                  setChoices({
                    ...choices,
                    [kind]: choices[kind].filter(
                      (item) => item !== removingModel,
                    ),
                  });
                  setActive({ ...active, [kind]: null });
                  setSelectedModelId("");
                  setRemovingModel(null);
                  setNotice("已移除。此类当前未配置，其他类别和历史保留。");
                }}
              >
                移除并暂不配置
              </button>
            </div>
          ) : null}
          {managing ? (
            <fieldset className="preview-directory">
              <legend>从目录选择</legend>
              <div className="preview-directory-toolbar">
                <p>勾选保留，取消即可移除。以下为固定示例目录。</p>
                <button
                  className="preview-text-button"
                  onClick={() =>
                    setNotice(
                      "示例目录已刷新，当前模型与备选选择保持不变。实际同步将在后续接入。 ",
                    )
                  }
                >
                  <RefreshCw />
                  同步目录
                </button>
              </div>
              {providers.map((provider) => (
                <div className="preview-directory-provider" key={provider}>
                  <h4>{provider}</h4>
                  {modelDirectory[kind]
                    .filter((item) => item.provider === provider)
                    .map((item) => (
                      <label className="preview-directory-option" key={item.id}>
                        <input
                          type="checkbox"
                          checked={choices[kind].includes(item.id)}
                          onChange={(event) => {
                            if (event.target.checked)
                              setChoices({
                                ...choices,
                                [kind]: [...choices[kind], item.id],
                              });
                            else removeModel(item.id);
                          }}
                        />
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.modelId} ·{" "}
                            {item.supported
                              ? "可用于演示当前选择"
                              : "目录候选，尚未接入执行"}
                          </small>
                        </span>
                      </label>
                    ))}
                </div>
              ))}
            </fieldset>
          ) : null}
          <p className="preview-config-footnote">
            连接共用 Key。切换当前模型只影响新的请求与方案，正在制作的版本不变。
          </p>
        </>
      ) : null}

      {page === "skills" ? (
        <>
          <div className="preview-settings-heading">
            <div>
              <h2>Skill 管理</h2>
              <p>安装专业技能，聊天时按需调用或指定。</p>
            </div>
            <button
              className="preview-primary"
              onClick={(event) => {
                opener.current = event.currentTarget;
                setDialog("install");
              }}
            >
              <Plus />
              安装 Skill
            </button>
          </div>
          <div className="preview-section-heading">
            <h3>
              已安装 <span>{skills.length}</span>
            </h3>
          </div>
          <div className="preview-skill-list">
            {skills.map((skill) => (
              <article className="preview-skill-row" key={skill.id}>
                <Sparkles />
                <div>
                  <h3>{skill.name}</h3>
                  <p>{skill.description}</p>
                  <small>{skill.source}</small>
                </div>
                <span className="preview-status">可用</span>
                {skill.builtin ? (
                  <span className="preview-muted">内置</span>
                ) : (
                  <button
                    className="preview-secondary"
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setDialog(skill);
                    }}
                  >
                    卸载
                  </button>
                )}
              </article>
            ))}
          </div>
          <p className="preview-config-footnote">
            安装与卸载不改变已有作品。回到对话后，可在输入框选择本次使用的
            Skill。
          </p>
          <button
            className="preview-text-button"
            onClick={() => onPage("chat")}
          >
            回到对话，选择 Skill
          </button>
        </>
      ) : null}

      {page === "services" ? (
        <>
          <div className="preview-settings-heading">
            <div>
              <h2>免费服务</h2>
              <p>配置素材和资讯来源。</p>
            </div>
          </div>
          <div className="preview-service-row">
            <FolderOpen />
            <div>
              <h3>免费素材</h3>
              <p>Pexels · 图片与视频检索</p>
            </div>
            <label>
              <input
                type="checkbox"
                checked={freeServices.materials}
                onChange={(event) =>
                  setFreeServices({
                    ...freeServices,
                    materials: event.target.checked,
                  })
                }
              />
              启用
            </label>
          </div>
          <div className="preview-service-row">
            <FolderOpen />
            <div>
              <h3>热点资讯</h3>
              <p>NewsNow · 按已配置来源查看话题</p>
            </div>
            <label>
              <input
                type="checkbox"
                checked={freeServices.trends}
                onChange={(event) =>
                  setFreeServices({
                    ...freeServices,
                    trends: event.target.checked,
                  })
                }
              />
              启用
            </label>
          </div>
          <p className="preview-config-footnote">
            这里管理信息来源。专业技能的安装与卸载请进入独立的 Skill 管理页。
          </p>
        </>
      ) : null}
      {page === "profile" ? (
        <>
          <div className="preview-settings-heading">
            <div>
              <h2>用户页</h2>
            </div>
          </div>
          <form
            className="preview-profile"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice("示例资料已保存。");
            }}
          >
            <label>
              显示名称
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <button className="preview-primary">保存</button>
          </form>
        </>
      ) : null}
      {notice ? (
        <p className="preview-settings-notice" role="status">
          {notice}
        </p>
      ) : null}

      <dialog
        ref={modal}
        className="preview-dialog"
        onCancel={() => setDialog(null)}
        aria-label={
          dialog === "install"
            ? "安装 Skill"
            : dialog === "connection"
              ? "连接配置"
              : "卸载 Skill"
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (dialog === "install") {
              onSkillsChange([
                ...skills,
                {
                  id: crypto.randomUUID(),
                  name: source.includes("storyboard")
                    ? "分镜整理"
                    : "新安装的 Skill",
                  description: "安装完成后，可在原对话指定使用。",
                  source,
                  builtin: false,
                },
              ]);
              setSource("");
              setNotice(
                "演示安装完成，输入框的 Skill 列表已更新。没有下载或执行外部包。",
              );
            } else if (dialog === "connection") {
              setConnections({
                ...connections,
                [connectionProvider]: { ...connectionDraft },
              });
              setNotice("示例连接已保存；没有连接真实供应商。");
            } else if (dialog) {
              onSkillsChange(skills.filter((item) => item.id !== dialog.id));
              setNotice("示例包已卸载，对话与作品保留。");
            }
            setDialog(null);
          }}
        >
          <header>
            <h3>
              {dialog === "install"
                ? "安装 Skill"
                : dialog === "connection"
                  ? "连接配置"
                  : "卸载 Skill"}
            </h3>
            <button
              type="button"
              className="preview-icon"
              aria-label="关闭面板"
              onClick={() => setDialog(null)}
            >
              <X />
            </button>
          </header>
          {dialog === "install" ? (
            <>
              <label>
                安装来源
                <input
                  autoFocus
                  required
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="npm 包、Git 地址或服务器目录"
                />
              </label>
              <button
                className="preview-text-button"
                type="button"
                onClick={() => setSource("npm:frame-storyboard-demo")}
              >
                填入示例来源
              </button>
              <p className="preview-muted">
                此处只演示安装交互，不会下载或执行任何包。
              </p>
            </>
          ) : dialog === "connection" ? (
            <>
              <label>
                服务商
                <select
                  value={connectionProvider}
                  onChange={(event) => {
                    setConnectionProvider(event.target.value);
                    setConnectionDraft({ ...connections[event.target.value]! });
                  }}
                >
                  {Object.keys(connections).map((provider) => (
                    <option key={provider}>{provider}</option>
                  ))}
                </select>
              </label>
              <label>
                接口地址
                <input
                  value={connectionDraft.address}
                  onChange={(event) =>
                    setConnectionDraft({
                      ...connectionDraft,
                      address: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                API Key
                <input
                  value={connectionDraft.key}
                  onChange={(event) =>
                    setConnectionDraft({
                      ...connectionDraft,
                      key: event.target.value,
                    })
                  }
                />
              </label>
              <p className="preview-muted">
                全部为合成示例配置；同一连接供多个型号共用。
              </p>
            </>
          ) : dialog ? (
            <>
              <p>
                卸载“{dialog.name}
                ”？它将从后续可选技能中移除，已有聊天和作品保留。
              </p>
              <p className="preview-muted">本次是交互演示，不删除本地文件。</p>
            </>
          ) : null}
          <footer>
            <button
              type="button"
              className="preview-secondary"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button className="preview-primary" type="submit">
              {dialog === "install"
                ? "安装"
                : dialog === "connection"
                  ? "保存连接"
                  : "确认卸载"}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}
