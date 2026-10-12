import type { ModelExecutionFact } from "@video-factory/production-pipeline";

/** 请求身份与逐次用量共用一处展示，查询重放不叠加为新调用。 */
export function ModelExecutionDetails({ facts }: { facts: ModelExecutionFact[] }) {
  return <details className="model-execution-details">
    <summary>原请求与逐次用量（{facts.length} 个请求）</summary>
    <p>用量不是实付金额；未有账单的调用仍待核费。缺失记录不按零计算。</p>
    {facts.length ? facts.map((fact) => <article key={fact.executionKey}>
      <strong>{fact.purpose === "produce" ? "生成" : fact.purpose === "audit" ? "审计" : "模型操作"} · {requestStateLabel(fact)}</strong>
      <p>{fact.providerId} · {fact.modelId} · {fact.modelAttemptCount ?? "未核定"} 次模型尝试</p>
      <p>原请求：<code>{fact.requestId}</code></p>
      {fact.conflict ? <p role="status">同请求证据存在矛盾，次数和用量待核。</p> : null}
      <p>用量记录：{fact.usageComplete ? "完整" : "不完整"} · 已返回合计 {fact.usage?.totalTokens ?? "未知"} token</p>
      {fact.modelAttempts?.length ? <ol>{fact.modelAttempts.map((attempt) => <li key={attempt.attempt}>
        第 {attempt.attempt} 次：{attempt.usage
          ? `输入 ${attempt.usage.promptTokens ?? "缺失"} · 输出 ${attempt.usage.completionTokens ?? "缺失"} · 合计 ${attempt.usage.totalTokens ?? "缺失"} token${attempt.usage.reasoningTokens !== undefined ? `（推理 ${attempt.usage.reasoningTokens}）` : ""}`
          : "usage 未返回"}
      </li>)}</ol> : <p>未保存逐次用量，无法重建历史缺失值。</p>}
    </article>) : <p>尚无可核对的原请求证据。</p>}
  </details>;
}

function requestStateLabel(fact: ModelExecutionFact): string {
  return {
    prepared: "已准备，受理未确认", not_accepted: "未受理", accepted_unknown: "已受理，结果待核",
    completed: "已完成", completed_failure: "已结束，失败", unknown: "结果待核",
  }[fact.state];
}
