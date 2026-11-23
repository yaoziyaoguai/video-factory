import { useEffect, useState } from "react";
import type { BudgetPolicies, BudgetPolicy, StudioAccount, StudioAccounts, StudioRole } from "../../shared/agent/generated/contracts.js";
import { agentApi } from "./api.js";
import { useRevisionCommand } from "./useRevisionCommand.js";

const roleName: Record<StudioRole, string> = { admin: "管理员", creator: "创作者" };
const limitFields = [
  ["conversationLimitMinor", "每个会话"], ["dayLimitMinor", "每天"], ["monthLimitMinor", "每月"],
] as const;
type LimitField = typeof limitFields[number][0];

function AccountForm({ accounts, onSaved, onCancel, onRefresh }: { accounts: StudioAccounts; onRefresh: () => void; onSaved: (accounts: StudioAccounts) => void; onCancel: () => void }) {
  const [name, setName] = useState(""), [password, setPassword] = useState(""), [role, setRole] = useState<StudioRole>("creator");
  const command = useRevisionCommand<StudioAccounts>();
  return <form className="frame-admin-form" onSubmit={async event => {
    event.preventDefault();
    const next = await command.submit({ username: name, password, role, expectedRevision: accounts.revision }, body => agentApi.createStudioAccount(body));
    if (next) onSaved(next);
  }}><fieldset disabled={command.busy}>
    <label>登录账号<input autoFocus required maxLength={96} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,95}" value={name} onChange={e => setName(e.target.value)} autoComplete="off" title="字母或数字开头，可使用点、下划线和短横线" /></label>
    <label>初始密码<input required type="password" minLength={8} maxLength={512} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="至少 8 个字符" /></label>
    <label>角色<select aria-label="角色" value={role} onChange={e => setRole(e.target.value as StudioRole)}><option value="creator">创作者</option><option value="admin">管理员</option></select></label>
    <div className="agent-modal-actions"><button type="button" className="agent-secondary-button" onClick={onCancel}>取消</button><button type="submit" className="agent-primary-button">{command.busy ? "正在创建…" : "创建账号"}</button></div>
  </fieldset>{command.error ? <p role="alert" className="agent-field-error">{command.error} <button type="button" onClick={onRefresh}>重新读取最新设置</button></p> : null}</form>;
}

function MemberForm({ member, revision, onSaved, onCancel, onRefresh }: {
  member: StudioAccount; revision: number; onSaved: (accounts: StudioAccounts) => void;
  onCancel: () => void; onRefresh: () => void;
}) {
  const [role, setRole] = useState(member.role), [disabled, setDisabled] = useState(member.disabledAt !== null);
  const [password, setPassword] = useState("");
  const command = useRevisionCommand<StudioAccounts>();
  const changed = role !== member.role || disabled !== (member.disabledAt !== null) || password.length > 0;
  return <form className="frame-admin-form frame-member-form" onSubmit={async event => {
    event.preventDefault();
    const next = await command.submit({ expectedRevision: revision, role, disabled, ...(password ? { password } : {}) },
      body => agentApi.updateStudioAccount(member.username, body));
    if (next) onSaved(next);
  }}>
    <fieldset disabled={command.busy}>
      <label>成员角色<select autoFocus value={role} onChange={event => setRole(event.target.value as StudioRole)}>
        <option value="creator">创作者</option><option value="admin">管理员</option>
      </select></label>
      <label>账号状态<select value={disabled ? "disabled" : "enabled"} onChange={event => setDisabled(event.target.value === "disabled")}>
        <option value="enabled">启用</option><option value="disabled">停用</option>
      </select></label>
      <label>重置密码<input type="password" minLength={8} maxLength={512} autoComplete="new-password" value={password}
        aria-describedby="frame-member-password-help" onChange={event => setPassword(event.target.value)} /></label>
      <p className="agent-stage-muted" id="frame-member-password-help">留空保留原密码。</p>
      <div className="agent-modal-actions">
        <button type="button" className="agent-secondary-button" onClick={onCancel}>取消</button>
        <button type="submit" className="agent-primary-button" disabled={!changed}>{command.busy ? "正在保存…" : "保存成员"}</button>
      </div>
    </fieldset>
    {command.error ? <p role="alert" className="agent-field-error">{command.error} <button type="button" onClick={onRefresh}>重新读取最新设置</button></p> : null}
  </form>;
}

function yuan(minor: number | null) {
  if (minor === null) return "";
  const cents = BigInt(minor);
  return (cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0");
}
function BudgetForm({ policy, onSaved, onRefresh }: { policy: BudgetPolicy; onRefresh: () => void; onSaved: (p: BudgetPolicy) => void }) {
  const initial = { conversationLimitMinor: yuan(policy.conversationLimitMinor), dayLimitMinor: yuan(policy.dayLimitMinor), monthLimitMinor: yuan(policy.monthLimitMinor) };
  const [limits, setLimits] = useState(initial), [validation, setValidation] = useState("");
  const command = useRevisionCommand<BudgetPolicy>();
  const changed = limitFields.some(([field]) => limits[field] !== initial[field]);
  const save = async () => {
    const amounts = {} as Record<LimitField, number | null>;
    for (const [field, label] of limitFields) {
      const raw = limits[field].trim();
      if (raw === "") { amounts[field] = null; continue; }
      const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
      if (!parts) { setValidation(label + "预算需填写非负金额，最多两位小数。"); return; }
      const minor = Number(BigInt(parts[1]!) * 100n + BigInt((parts[2] ?? "").padEnd(2, "0")));
      if (!Number.isSafeInteger(minor)) { setValidation(label + "预算超出可保存的金额。"); return; }
      amounts[field] = minor;
    }
    const saved = await command.submit({ ...amounts, scope: policy.scope, subjectId: policy.subjectId, expectedRevision: policy.revision }, body => agentApi.saveBudgetPolicy(body));
    if (saved) {
      setLimits({ conversationLimitMinor: yuan(saved.conversationLimitMinor), dayLimitMinor: yuan(saved.dayLimitMinor), monthLimitMinor: yuan(saved.monthLimitMinor) }); onSaved(saved);
    }
  };
  return <form className="frame-admin-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={command.busy}><p id="frame-budget-unit" className="agent-stage-muted">单位为人民币元。留空表示不限额，0 表示停止新增付费制作。</p>
      <div className="frame-budget-limits">{limitFields.map(([key, name]) => <label key={key}>{name}<input inputMode="decimal" maxLength={20} aria-describedby="frame-budget-unit" value={limits[key]} placeholder="不限额" onChange={e => {
        setValidation(""); command.clearReceipt(); setLimits({ ...limits, [key]: e.target.value });
      }} /></label>)}</div>
      <button className="agent-primary-button" type="submit" disabled={!changed}>{command.busy ? "正在保存…" : "保存预算"}</button>
    </fieldset>{validation || command.error ? <p className="agent-field-error" role="alert">{validation || command.error}{command.error ? <> <button type="button" onClick={onRefresh}>重新读取最新设置</button></> : null}</p> : null}
    {command.receipt ? <p className="agent-stage-muted" role="status">预算已保存。</p> : null}
  </form>;
}

export function TeamSettings() {
  const [accounts, setAccounts] = useState<StudioAccounts | null>(null), [budgets, setBudgets] = useState<BudgetPolicies | null>(null);
  const [error, setError] = useState(""), [attempt, setAttempt] = useState(0), [creating, setCreating] = useState(false), [notice, setNotice] = useState("");
  const [target, setTarget] = useState("workspace");
  const [editing, setEditing] = useState<string | null>(null);
  const applyAccounts = (next: StudioAccounts) => setAccounts(current =>
    current && current.revision > next.revision ? current : next);
  const refresh = () => setAttempt(n => n + 1);
  useEffect(() => {
    let current = true; setError("");
    Promise.all([agentApi.studioAccounts(), agentApi.budgetPolicies()]).then(([team, limits]) => { if (current) { applyAccounts(team); setBudgets(limits); } },
      (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [attempt]);
  if (error) return <p className="agent-config-note" role="alert">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>重新读取</button></p>;
  if (!accounts || !budgets) return <p className="agent-stage-muted">正在读取成员与预算…</p>;
  const scope = target === "workspace" ? "workspace" : "user", subjectId = scope === "workspace" ? "default" : target.slice(5);
  const policy = budgets.policies.find(p => p.scope === scope && p.subjectId === subjectId) ?? { scope, subjectId, revision: 0, conversationLimitMinor: null, dayLimitMinor: null, monthLimitMinor: null };
  const savePolicy = (next: BudgetPolicy) => setBudgets({ ...budgets, policies: [...budgets.policies.filter(p => p.scope !== next.scope || p.subjectId !== next.subjectId), next] });
  return <div className="frame-team-settings">
    <section className="agent-profile-card"><header><h2>成员</h2>{!creating ? <button type="button" className="agent-secondary-button" onClick={() => { setCreating(true); setEditing(null); setNotice(""); }}>新建账号</button> : null}</header>
      {creating ? <AccountForm onRefresh={refresh} accounts={accounts} onSaved={next => { applyAccounts(next); setCreating(false); setNotice("账号已创建。"); }} onCancel={() => setCreating(false)} /> : null}
      {notice ? <p className="agent-stage-muted" role="status">{notice}</p> : null}
      <ul className="frame-team-members">{accounts.accounts.map(account => <li key={account.id}>
        <div className="frame-member-row">
          <strong>{account.username}</strong><span>{roleName[account.role]}{account.disabledAt !== null ? " · 已停用" : ""}</span>
          <button type="button" className="agent-text-link" aria-label={"管理 " + account.username} aria-expanded={editing === account.id}
            onClick={() => { setEditing(editing === account.id ? null : account.id); setCreating(false); setNotice(""); }}>管理</button>
        </div>
        {editing === account.id ? <MemberForm member={account} revision={accounts.revision} onRefresh={refresh}
          onSaved={next => { applyAccounts(next); setEditing(null); setNotice("成员设置已保存。"); }} onCancel={() => setEditing(null)} /> : null}
      </li>)}</ul>
    </section>
    <section className="agent-profile-card"><header><h2>制作预算</h2></header>
      <label className="frame-budget-scope">适用范围<select aria-label="预算适用范围" value={target} onChange={e => setTarget(e.target.value)}><option value="workspace">全体成员共用</option>{accounts.accounts.map(account => <option key={account.id} value={"user:" + account.id}>{account.username}</option>)}</select></label>
      <BudgetForm onRefresh={refresh} key={target} policy={policy} onSaved={savePolicy} />
    </section>
  </div>;
}
