import type { StudioCreativeReviewHistory } from "../../shared/api.js";
import { CreativeDraft } from "./CreativeDiscussionPanel.js";

const STAGE_LABEL = { treatment: "前期构思", script: "脚本", director: "导演方案" } as const;

export function CreativeReviewHistoryPanel({ history }: { history: StudioCreativeReviewHistory }) {
  if (history.entries.length === 0 && !history.legacyIncomplete) return null;
  return <section id="creative-review-history" className="creative-review-history" aria-label="创作版本记录">
    <h2>创作版本记录</h2>
    <p>这里只供回看。历史稿件和审计意见不会自动成为当前版本，也不能在这里确认或授权费用。</p>
    {history.legacyIncomplete ? <p role="note">早期制作记录没有保存完整版本历史，以下仅显示可核实的记录，不补造旧审计。</p> : null}
    {history.entries.map((entry, index) => <details key={`${entry.stage}:${entry.versionId}`}>
      <summary>{STAGE_LABEL[entry.stage]} · 第 {history.entries.slice(0, index + 1).filter((item) => item.stage === entry.stage).length} 版 · {entry.confirmation ? entry.confirmation.unauditedAdoption ? "未审采用" : "已采用" : entry.audits.length > 0 ? "已审计" : "未审计"}</summary>
      <CreativeDraft stage={entry.stage} value={entry.document} />
      {entry.audits.map((audit) => <section key={audit.auditId} className="creative-check-result">
        <strong>{audit.status === "incomplete" ? "审计未取得结论" : audit.status === "pass" ? "审计通过" : "审计有建议"}</strong>
        <p>{audit.summary}</p>
        {audit.suggestions.length > 0 ? <ul>{audit.suggestions.map((suggestion, suggestionIndex) => <li key={suggestionIndex}>{suggestion}</li>)}</ul> : null}
      </section>)}
      {entry.confirmation ? <p>{entry.confirmation.unauditedAdoption ? "未审采用" : "已采用"} · {new Date(entry.confirmation.confirmedAt).toLocaleString("zh-CN")}</p> : null}
    </details>)}
  </section>;
}
