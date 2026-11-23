import { ArrowRight, LoaderCircle, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authApi, AuthRequestError, subscribeToAuthenticationLoss, type StudioAuthSession } from "../auth-api.js";

interface AuthenticatedStudio {
  username?: string;
  ownerId?: string;
  logout?(): Promise<void>;
}

const LAST_AUTH_OWNER = "vf:last-auth-user";

function clearStudioLocalCache() {
  const storage = window.localStorage;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith("vf:agent-") || key?.startsWith("vf:agent:")) storage.removeItem(key);
  }
  storage.removeItem(LAST_AUTH_OWNER);
}

export function AuthGate({ children }: { children: (studio: AuthenticatedStudio) => ReactNode }) {
  const [session, setSession] = useState<StudioAuthSession>();
  const [loadError, setLoadError] = useState("");
  const [logoutNotice, setLogoutNotice] = useState("");

  const acceptSession = (next: StudioAuthSession) => {
    if (next.enabled) {
      if (!next.authenticated) clearStudioLocalCache();
      else if (window.localStorage.getItem(LAST_AUTH_OWNER) !== next.ownerId) {
        clearStudioLocalCache();
        window.localStorage.setItem(LAST_AUTH_OWNER, next.ownerId);
      }
    }
    setSession(next);
  };
  const load = async () => {
    setLoadError("");
    try {
      acceptSession(await authApi.authSession());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法检查登录状态。");
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => subscribeToAuthenticationLoss(() => {
    setLoadError("");
    acceptSession({ enabled: true, authenticated: false });
  }), []);

  if (loadError) {
    return (
      <main className="auth-stage">
        <section className="auth-panel auth-error-panel">
          <span className="auth-mark">f.</span>
          <h1>暂时无法进入创作台</h1>
          <p>{loadError}</p>
          <button className="button button-primary" type="button" onClick={() => void load()}>重新连接</button>
        </section>
      </main>
    );
  }
  if (!session) {
    return <main className="auth-stage"><LoaderCircle className="auth-spinner" aria-label="正在检查登录状态" /></main>;
  }
  if (session.enabled && !session.authenticated) {
    return <LoginPanel notice={logoutNotice} onAuthenticated={authenticated => { setLogoutNotice(""); acceptSession(authenticated); }} />;
  }
  if (!session.enabled) return children({});
  return children({
    username: session.username,
    ownerId: session.ownerId,
    logout: async () => {
      try {
        await authApi.logout();
      } catch (error) {
        if (!(error instanceof AuthRequestError || error instanceof TypeError)) throw error;
        if (!(error instanceof AuthRequestError && error.status === 401)) setLogoutNotice("此设备的草稿已清除。服务器未确认退出。恢复连接后，请刷新页面核对登录状态。");
      } finally {
        acceptSession({ enabled: true, authenticated: false });
      }
    },
  });
}

function LoginPanel({ onAuthenticated, notice }: { notice: string; onAuthenticated(session: StudioAuthSession): void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      onAuthenticated(await authApi.login(String(form.get("username") ?? ""), String(form.get("password") ?? "")));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败，请重试。");
    } finally {
      setPending(false);
    }
  };

  return <main className="auth-stage">
    <div className="auth-layout">
      <LoginFilm />
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title">回到创作现场</h1>
        {notice && <p className="auth-error" role="status">{notice}</p>}
        <form className="auth-form" onSubmit={event => void submit(event)}>
          <label><span>用户名</span><input name="username" autoComplete="username" required autoFocus /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete="current-password" required /></label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <button className="auth-submit" type="submit" disabled={pending}>
            <span>{pending ? "正在进入" : "进入工作台"}</span>
            {pending ? <LoaderCircle className="auth-spinner-inline" aria-hidden="true" size={18} /> : <ArrowRight aria-hidden="true" size={18} />}
          </button>
        </form>
      </section>
    </div>
  </main>;
}

function LoginFilm() {
  const [paused, setPaused] = useState(false);
  const [ended, setEnded] = useState(false);
  const [take, setTake] = useState(0);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const label = ended ? "重播片头" : paused ? "继续播放片头" : "暂停片头";
  return <aside className="auth-filmboard" aria-label="帧间 Frame">
    <figure className="auth-frame">
      <img key={take} src="/media/atelier/projector.webp" alt="暗房里投影机映出的光束" width={1400} height={933}
        style={{ animationPlayState: paused || hidden ? "paused" : "running" }} onAnimationEnd={() => setEnded(true)} />
      <div className="auth-brand"><span aria-hidden="true">f.</span> 帧间 Frame</div>
      <figcaption><div><strong>放映之前</strong><small>00:04 · 无声片头</small></div>
        <button type="button" aria-label={label} title={label} onClick={() => {
          if (ended) { setTake(n => n + 1); setEnded(false); setPaused(false); }
          else setPaused(value => !value);
        }}>{ended ? <RotateCcw /> : paused ? <Play /> : <Pause />}</button>
      </figcaption>
    </figure>
  </aside>;
}
