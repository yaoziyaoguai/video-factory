// 四个并发窗口按来源排名消费。后排先返回也不能挤掉前排，达到数量或取消后释放剩余请求。
export async function orderedResults<T, R>(items: readonly T[], limit: number, signal: AbortSignal | undefined,
  read: (item: T, signal: AbortSignal) => Promise<R | null>): Promise<R[]> {
  const local = new AbortController();
  const active = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const queue: Promise<{ value: R | null } | { error: unknown }>[] = [];
  const results: R[] = [];
  let next = 0;
  try {
    while (results.length < limit && (next < items.length || queue.length)) {
      active.throwIfAborted();
      while (next < items.length && queue.length < 4) {
        queue.push(read(items[next++]!, active).then(value => ({ value }), (error: unknown) => ({ error })));
      }
      const result = await queue.shift()!;
      active.throwIfAborted();
      if ("error" in result) throw result.error;
      if (result.value !== null) results.push(result.value);
    }
    return results;
  } finally { local.abort(); }
}
