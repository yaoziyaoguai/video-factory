import { Check, ExternalLink, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { StudioCandidateInboxItem } from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface CandidateVerificationDialogProps {
  candidate?: StudioCandidateInboxItem;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function CandidateVerificationDialog({ candidate, pending, onClose, onConfirm }: CandidateVerificationDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { setConfirmed(false); }, [candidate?.id]);
  const dialogRef = useDialogFocus<HTMLElement>(Boolean(candidate), onClose, pending);
  if (!candidate) return null;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="verification-dialog" role="dialog" aria-modal="true" aria-labelledby="verification-title" tabIndex={-1}>
        <header className="dialog-header">
          <div><p className="eyebrow">证据门禁</p><h2 id="verification-title">采用前核验证据</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={pending} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <div className="verification-dialog-body">
          <div className="verification-intro"><ShieldCheck aria-hidden="true" size={21} /><div><strong>{candidate.title}</strong><span>{candidate.verification.reasons[0]}</span></div></div>
          <div className="verification-sources" aria-label="待核验原始来源">
            {candidate.evidence.map((evidence, index) => (
              <article key={`${evidence.source}-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{evidence.keyword}</strong><small>{evidence.source} · 信号强度 {evidence.strength}</small></div>
                {evidence.evidenceUrl ? <a href={evidence.evidenceUrl} target="_blank" rel="noreferrer" aria-label={`打开来源 ${evidence.source}`}><ExternalLink aria-hidden="true" size={15} /></a> : <small>无链接</small>}
              </article>
            ))}
          </div>
          <label className="verification-confirm">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>我已打开原始来源，并确认标题与开场没有超出当前证据。</span>
          </label>
        </div>
        <footer className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={pending}>暂不采用</button>
          <button className="button button-primary" type="button" disabled={!confirmed || pending} onClick={() => void onConfirm()}><Check aria-hidden="true" size={17} />{pending ? "正在采用..." : "确认核验并采用"}</button>
        </footer>
      </section>
    </div>
  );
}
