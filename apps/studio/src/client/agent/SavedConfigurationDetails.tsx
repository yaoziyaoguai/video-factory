export function SavedConfigurationDetails({ name, endpoint, modelId, apiKey }: {
  name: string; endpoint?: string | null; modelId?: string | null; apiKey?: string | null | undefined;
}) {
  return <dl className="agent-saved-configuration">
    {endpoint ? <><dt>服务地址</dt><dd>{endpoint}</dd></> : null}
    {modelId ? <><dt>模型 ID</dt><dd>{modelId}</dd></> : null}
    {apiKey !== undefined ? <><dt>API Key</dt><dd>{apiKey
      ? <input aria-label={`${name} API Key`} type="text" value={apiKey} readOnly spellCheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()} />
      : <span>未配置</span>}</dd></> : null}
  </dl>;
}
