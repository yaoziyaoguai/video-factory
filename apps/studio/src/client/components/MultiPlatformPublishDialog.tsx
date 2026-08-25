import { AlertCircle, Check, ExternalLink, LoaderCircle, Send, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  StudioPublishBatch,
  StudioPublishConfirmations,
  StudioPublishPlatformId,
  StudioPublishReadiness,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
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
  const [batch, setBatch] = useState<StudioPublishBatch>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose, pending);
  const allConfirmed = useMemo(() => Object.values(confirmations).every(Boolean), [confirmations]);

  useEffect(() => {
    let active = true;
    setError(undefined);
    void studioApi.publishReadiness(runId)
      .then((value) => {
        if (!active) return;
        setReadiness(value);
        setSelected(value.targets.filter((target) => target.status === "ready" || target.status === "manual_only").map((target) => target.id));
      })
      .catch((caught: unknown) => active && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => { active = false; };
  }, [runId]);

  function togglePlatform(platformId: StudioPublishPlatformId) {
    setSelected((current) => current.includes(platformId)
      ? current.filter((id) => id !== platformId)
      : [...current, platformId]);
  }

  async function publish() {
    setPending(true);
    setError(undefined);
    try {
      setBatch(await studioApi.publish(runId, {
        requestId: publishRequestId(),
        platformIds: selected,
        confirmations,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title" tabIndex={-1}>
        <header className="dialog-header">
          <div><p className="eyebrow">发行制片</p><h2 id="publish-title">发布到多个平台</h2><p>一次确认，各平台独立发送与审核；失败平台单独留档。</p></div>
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
                      disabled={!selectable}
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
                <input type="checkbox" checked={confirmations[item.key]} onChange={(event) => setConfirmations((current) => ({ ...current, [item.key]: event.target.checked }))} />
                <span>{item.label}</span>
              </label>)}
            </fieldset>
          </div>
        ) : null}

        {batch ? <div className={`publish-result is-${batch.status}`} role="status">
          <div className="publish-result-heading">
            {batch.status === "succeeded" ? <Check aria-hidden="true" size={20} /> : <AlertCircle aria-hidden="true" size={20} />}
            <span><strong>{batchStatusLabel(batch.status)}</strong><small>每个平台的结果已独立留存；相同请求不会重复发送。</small></span>
          </div>
          <div className="publish-delivery-list">{batch.deliveries.map((delivery) => <div key={delivery.platformId}><strong>{readiness?.targets.find((target) => target.id === delivery.platformId)?.label ?? delivery.platformId}</strong><span>{deliveryStatusLabel(delivery.status)}</span><small>{delivery.detail ?? delivery.externalId ?? "等待平台审核"}</small></div>)}</div>
        </div> : null}

        {error ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
        <footer className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onClose} disabled={pending}>{batch ? "完成" : "取消"}</button>
          {!batch ? <button className="button button-primary" type="button" disabled={!readiness?.ready || selected.length === 0 || !allConfirmed || pending} onClick={() => void publish()}>
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

function targetModeLabel(status: StudioPublishReadiness["targets"][number]["status"]): string {
  return ({ ready: "官方 API 可用", needs_config: "需要配置", manual_only: "导出后人工上传", planned: "等待官方接入" })[status];
}

function deliveryStatusLabel(status: StudioPublishBatch["deliveries"][number]["status"]): string {
  return ({ submitted: "已提交审核", export_ready: "发布包已准备", needs_config: "需要配置", failed: "发送失败" })[status];
}

function batchStatusLabel(status: StudioPublishBatch["status"]): string {
  return ({ succeeded: "发布任务已处理", partial: "部分平台需要处理", failed: "发布任务未发送" })[status];
}
