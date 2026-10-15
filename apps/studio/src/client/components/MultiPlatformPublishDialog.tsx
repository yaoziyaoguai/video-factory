import { AlertCircle, Check, ExternalLink, LoaderCircle, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  StudioPublishBatch,
  StudioPublishConfirmations,
  StudioPublishInput,
  StudioPublishPlatformId,
  StudioPublishReadiness,
  StudioPublishSnapshot,
} from "../../shared/api.js";
import { StudioApiError, studioApi } from "../api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface MultiPlatformPublishDialogProps {
  runId: string;
  onClose: () => void;
}

const CONFIRMATIONS: Array<{ key: keyof StudioPublishConfirmations; label: string }> = [
  { key: "finalContent", label: "我已完整观看最终成片，标题、字幕和声音均为本次要发布的版本" },
  { key: "aigcDisclosure", label: "我会在每个目标平台主动声明 AI 生成或辅助生成内容，并保留文件标识" },
  { key: "rightsAndLikeness", label: "素材、音乐、字体、肖像和声音具备发布所需授权" },
  { key: "factualAccuracy", label: "事实来源与时效已复核，高风险专业内容已人工确认" },
  { key: "commercialDisclosure", label: "如含商品、服务或商业合作，已准备正确的广告或合作标识" },
];

const EMPTY_CONFIRMATIONS: StudioPublishConfirmations = {
  finalContent: false,
  aigcDisclosure: false,
  rightsAndLikeness: false,
  factualAccuracy: false,
  commercialDisclosure: false,
};

export function MultiPlatformPublishDialog({ runId, onClose }: MultiPlatformPublishDialogProps) {
  const [readiness, setReadiness] = useState<StudioPublishReadiness>();
  const [selected, setSelected] = useState<StudioPublishPlatformId[]>([]);
  const [confirmations, setConfirmations] = useState(EMPTY_CONFIRMATIONS);
  // 请求一旦发出就保留其完整身份；只有重新读取并确认后，才允许建立不同意图。
  const [intent, setIntent] = useState<StudioPublishInput>();
  const [unresolvedIntents, setUnresolvedIntents] = useState<StudioPublishInput[]>([]);
  const [needsReadiness, setNeedsReadiness] = useState(false);
  const [checking, setChecking] = useState(false);
  const [snapshotNotice, setSnapshotNotice] = useState<string>();
  const [batch, setBatch] = useState<StudioPublishBatch>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const appliedSnapshot = useRef<StudioPublishSnapshot | undefined>(undefined);
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose, pending);
  const allConfirmed = CONFIRMATIONS.every((item) => confirmations[item.key]);
  const selectedTargets = readiness?.targets.filter((target) => selected.includes(target.id)) ?? [];
  const submitCount = selectedTargets.filter((target) => target.status === "ready").length;
  const exportCount = selectedTargets.filter((target) => target.status === "manual_only").length;

  async function refreshReadiness() {
    setError(undefined);
    setChecking(true);
    try {
      const value = await studioApi.publishReadiness(runId);
      const previous = appliedSnapshot.current;
      const available = value.targets.filter((target) => target.status === "ready" || target.status === "manual_only").map((target) => target.id);
      const selectedUnavailable = selected.some((id) => !available.includes(id));
      if (previous && !batch && (!isSameSnapshot(previous, value.snapshot) || selectedUnavailable)) {
        setConfirmations(EMPTY_CONFIRMATIONS);
        setIntent(undefined);
        setSnapshotNotice(selectedUnavailable
          ? "部分已选平台当前不可用，请核对剩余平台并重新勾选确认。此前结果不确定的请求仍保留供你核对。"
          : "这条制作的发布条件已更新，请重新核对后再勾选确认。此前结果不确定的请求仍保留供你核对。");
      }
      appliedSnapshot.current = value.snapshot;
      setReadiness(value);
      setSelected((current) => previous ? current.filter((id) => available.includes(id)) : available);
      setNeedsReadiness(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setNeedsReadiness(true);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    appliedSnapshot.current = undefined;
    setReadiness(undefined);
    setSelected([]);
    setConfirmations(EMPTY_CONFIRMATIONS);
    setIntent(undefined);
    setUnresolvedIntents([]);
    setNeedsReadiness(false);
    setBatch(undefined);
    setSnapshotNotice(undefined);
    void refreshReadiness();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  function reviseIntent() {
    if (!intent) return false;
    setIntent(undefined);
    setConfirmations(EMPTY_CONFIRMATIONS);
    setNeedsReadiness(true);
    setSnapshotNotice("你已修改发布选择，请重新检查发布条件，再逐项确认新请求；旧请求结果仍待核对。");
    return true;
  }

  function togglePlatform(platformId: StudioPublishPlatformId) {
    reviseIntent();
    setSelected((current) => current.includes(platformId)
      ? current.filter((id) => id !== platformId)
      : [...current, platformId]);
  }

  function toggleConfirmation(key: keyof StudioPublishConfirmations, checked: boolean) {
    if (reviseIntent()) return;
    setConfirmations((current) => ({ ...current, [key]: checked }));
  }

  async function publish() {
    if (!readiness || checking || needsReadiness || pending || !allConfirmed || !selected.length) return;
    const samePayload = intent
      && isSameSnapshot(intent.expected, readiness.snapshot)
      && intent.platformIds.length === selected.length
      && intent.platformIds.every((id) => selected.includes(id))
      && CONFIRMATIONS.every((item) => intent.confirmations[item.key] === confirmations[item.key]);
    const next: StudioPublishInput = samePayload && intent
      ? intent
      : {
        requestId: publishRequestId(),
        platformIds: [...selected],
        confirmations: { ...confirmations },
        expected: { ...readiness.snapshot },
      };
    setIntent(next);
    setPending(true);
    setError(undefined);
    try {
      setBatch(await studioApi.publish(runId, next));
      setUnresolvedIntents((current) => current.filter((item) => item.requestId !== next.requestId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setUnresolvedIntents((current) => current.some((item) => item.requestId === next.requestId) ? current : [...current, next]);
      if (caught instanceof StudioApiError && caught.status === 409) {
        // 409 也可能只是租约占用；只有实际读到新快照才作废旧确认，编号不能据状态码轮换。
        await refreshReadiness();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title" tabIndex={-1}>
        <header className="dialog-header">
          <div><p className="eyebrow">发行制片</p><h2 id="publish-title">{!readiness ? "检查可用的发布方式" : !selected.length ? "选择发布平台" : submitCount && exportCount ? "提交与导出发布材料" : submitCount ? "提交到已授权平台" : "准备各平台发布包"}</h2><p>{!readiness || !selected.length ? "确认各平台的实际处理方式后再继续。" : submitCount && exportCount ? `${submitCount} 个平台将提交，${exportCount} 个平台仅生成发布包。` : submitCount ? "提交后仍需等待各平台处理或审核。" : "下载后，由你到目标平台上传和确认发布。"}</p></div>
          <button className="icon-button" type="button" onClick={() => void refreshReadiness()} disabled={pending || checking} title="重新检查发布条件"><RefreshCw aria-hidden="true" size={17} /></button>
          <button className="icon-button" type="button" onClick={onClose} disabled={pending} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>

        {!readiness && !error ? <div className="publish-loading"><LoaderCircle aria-hidden="true" size={18} />正在检查发布条件...</div> : null}
        {readiness && !batch ? (
          <div className="publish-dialog-body">
            <section aria-labelledby="publish-target-title">
              <div className="publish-section-heading"><h3 id="publish-target-title">目标平台</h3><span>{selected.length} 个已选择</span></div>
              <div className="publish-target-list">
                {readiness.targets.map((target, index) => {
                  const selectable = target.status === "ready" || target.status === "manual_only";
                  return <label key={target.id} className={selectable ? "publish-target" : "publish-target is-unavailable"}>
                    <input
                      type="checkbox"
                      checked={selected.includes(target.id)}
                      disabled={!selectable || pending || checking}
                      onChange={() => togglePlatform(target.id)}
                      {...(index === 0 ? { "data-dialog-initial-focus": true } : {})}
                    />
                    <span><strong>{target.label}</strong><small>{target.requirement ?? targetModeLabel(target.status)}</small></span>
                    <em>{targetModeLabel(target.status)}</em>
                    {target.docsUrl ? <a href={target.docsUrl} target="_blank" rel="noreferrer" title={`查看${target.label}官方接入文档`}><ExternalLink aria-hidden="true" size={14} /></a> : null}
                  </label>;
                })}
              </div>
            </section>

            <section aria-labelledby="publish-check-title">
              <div className="publish-section-heading"><h3 id="publish-check-title">发布前检查</h3><ShieldCheck aria-hidden="true" size={17} /></div>
              <div className="publish-check-list">
                {readiness.checks.map((check) => <div key={check.id} className={`publish-check check-${check.status}`}>
                  {check.status === "passed" ? <Check aria-hidden="true" size={14} /> : <AlertCircle aria-hidden="true" size={14} />}
                  <span><strong>{check.label}</strong><small>{check.detail}</small></span>
                </div>)}
              </div>
            </section>

            <fieldset className="publish-confirmations">
              <legend>我的最终确认</legend>
              {CONFIRMATIONS.map((item) => <label key={item.key}>
                <input type="checkbox" checked={confirmations[item.key]} disabled={pending || checking || needsReadiness} onChange={(event) => toggleConfirmation(item.key, event.target.checked)} />
                <span>{item.label}</span>
              </label>)}
            </fieldset>
          </div>
        ) : null}

        {batch ? <div className={`publish-result is-${batch.status}`} role="status">
          <div className="publish-result-heading">
            {batch.status === "succeeded" ? <Check aria-hidden="true" size={20} /> : <AlertCircle aria-hidden="true" size={20} />}
            <span><strong>{batchStatusLabel(batch)}</strong><small>每个平台的结果已独立留存。提交审核不等于已公开发布；导出发布包不等于已上传。</small></span>
          </div>
          <div className="publish-delivery-list">{batch.deliveries.map((delivery) => <div key={delivery.platformId}><strong>{readiness?.targets.find((target) => target.id === delivery.platformId)?.label ?? delivery.platformId}</strong><span>{deliveryStatusLabel(delivery.status)}</span><small>{delivery.detail ?? delivery.externalId ?? "等待平台审核"}</small></div>)}</div>
        </div> : null}

        {snapshotNotice && !error ? <p className="publish-snapshot-notice"><AlertCircle aria-hidden="true" size={16} />{snapshotNotice}</p> : null}
        {error ? <div className="publish-error-context" role="alert">
          <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{error}</p>
        </div> : null}
        {unresolvedIntents.length ? <div className="publish-error-context" aria-label="待核对的发布请求">
          {unresolvedIntents.map((previous) => <p key={previous.requestId}>
            请求编号 {previous.requestId} 的结果仍待核对（制作版本 {previous.expected.revision}；平台 {previous.platformIds.map((id) => readiness?.targets.find((target) => target.id === id)?.label ?? id).join("、")}）。
            {intent?.requestId === previous.requestId && !batch
              ? "再次确认提交会沿用同一编号与同一内容，不会自动创建新请求。"
              : "这是此前的请求；请核对原结果，当前选择不会重发或替换它。"}
          </p>)}
        </div> : null}
        <footer className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={pending}>{batch ? "完成" : "取消"}</button>
          {!batch ? <button className="button button-primary" type="button" disabled={!readiness?.ready || selected.length === 0 || !allConfirmed || pending || checking || needsReadiness} onClick={() => void publish()}>
            <Send aria-hidden="true" size={16} />{pending ? "正在处理..." : `确认并执行 ${selected.length} 个平台`}
          </button> : null}
        </footer>
      </section>
    </div>
  );
}

function publishRequestId(): string {
  return `publish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isSameSnapshot(a: StudioPublishSnapshot, b: StudioPublishSnapshot): boolean {
  return a.revision === b.revision
    && a.videoArtifactId === b.videoArtifactId
    && a.publishPackageArtifactId === b.publishPackageArtifactId;
}

function targetModeLabel(status: StudioPublishReadiness["targets"][number]["status"]): string {
  return ({ ready: "官方 API 可用", needs_config: "需要配置", manual_only: "导出后人工上传", planned: "等待官方接入" })[status];
}

function deliveryStatusLabel(status: StudioPublishBatch["deliveries"][number]["status"]): string {
  return ({ submitted: "已提交审核", export_ready: "发布包已准备", needs_config: "需要配置", failed: "发送失败" })[status];
}

function batchStatusLabel(batch: StudioPublishBatch): string {
  if (batch.status === "failed") return "本次提交或导出未完成";
  const submitted = batch.deliveries.filter((delivery) => delivery.status === "submitted").length;
  const exported = batch.deliveries.filter((delivery) => delivery.status === "export_ready").length;
  const summary = [submitted ? `${submitted} 个平台已提交审核` : "", exported ? `${exported} 个平台发布包已准备` : ""].filter(Boolean).join("；");
  return batch.status === "partial" ? `${summary}；部分平台仍需处理` : summary || "本次处理已完成，请查看各平台结果";
}
