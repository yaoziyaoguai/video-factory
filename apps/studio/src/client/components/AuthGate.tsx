import { ArrowRight, Clapperboard, LoaderCircle, LockKeyhole } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { studioApi, type StudioAuthSession } from "../api.js";

interface AuthenticatedStudio {
  username?: string;
  logout?(): Promise<void>;
}

export function AuthGate({ children }: { children: (studio: AuthenticatedStudio) => ReactNode }) {
  const [session, setSession] = useState<StudioAuthSession>();
  const [loadError, setLoadError] = useState("");

  const load = async () => {
    setLoadError("");
    try {
      setSession(await studioApi.authSession());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "无法检查登录状态。");
    }
  };
  useEffect(() => { void load(); }, []);

  if (loadError) {
    return (
      <main className="auth-stage">
        <section className="auth-panel auth-error-panel">
          <span className="auth-mark"><Clapperboard aria-hidden="true" size={20} /></span>
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
    return <LoginPanel onAuthenticated={setSession} />;
  }
  if (!session.enabled) return children({});
  return children({
    username: session.username,
    logout: async () => {
      await studioApi.logout();
      setSession({ enabled: true, authenticated: false });
    },
  });
}

function LoginPanel({ onAuthenticated }: { onAuthenticated(session: StudioAuthSession): void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      onAuthenticated(await studioApi.login(String(form.get("username") ?? ""), String(form.get("password") ?? "")));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败，请重试。");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-stage">
      <div className="auth-atmosphere" aria-hidden="true">
        <span>SCENE 01</span><i /><span>DAILY CUT</span>
      </div>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-brand"><span className="auth-mark"><Clapperboard aria-hidden="true" size={20} /></span><strong>VideoFactory</strong></div>
        <div className="auth-copy">
          <span className="auth-eyebrow">PRIVATE CREATOR STUDIO</span>
          <h1 id="auth-title">回到创作现场</h1>
          <p>你的选题、分镜与制作记录都在这里。</p>
        </div>
        <form className="auth-form" onSubmit={(event) => void submit(event)}>
          <label><span>用户名</span><input name="username" autoComplete="username" required autoFocus /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete="current-password" required /></label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <button className="auth-submit" type="submit" disabled={pending}>
            {pending ? <LoaderCircle className="auth-spinner-inline" aria-hidden="true" size={18} /> : <LockKeyhole aria-hidden="true" size={18} />}
            <span>{pending ? "正在进入" : "进入 VideoFactory"}</span>
            {!pending ? <ArrowRight aria-hidden="true" size={18} /> : null}
          </button>
        </form>
      </section>
    </main>
  );
}
