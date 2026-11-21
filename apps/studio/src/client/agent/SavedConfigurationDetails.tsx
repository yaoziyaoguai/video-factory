// 已保存配置的行内摘要：Key 不回传，只显示是否已配置。
export function SavedConfigurationDetails({ name, endpoint, modelId, credentialConfigured }: {
  name: string; endpoint?: string | null; modelId?: string | null; credentialConfigured?: boolean;
}) {
  return <dl className="agent-saved-configuration">
    {endpoint ? <><dt>服务地址</dt><dd>{endpoint}</dd></> : null}
    {modelId ? <><dt>模型 ID</dt><dd>{modelId}</dd></> : null}
    {credentialConfigured !== undefined ? <><dt>API Key</dt><dd aria-label={`${name} API Key`}>{credentialConfigured ? "已保存（不回显）" : <span>未配置</span>}</dd></> : null}
  </dl>;
}
