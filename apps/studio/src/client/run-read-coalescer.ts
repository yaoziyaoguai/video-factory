/** 本页只读资源的单在途通道。事件/操作完成的新需求合并成下一次读取，不接管写操作。 */
export function createRunRead<T>(
  read: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown, surfaceError: boolean) => void,
) {
  let inFlight: Promise<T | undefined> | undefined;
  let queued = false;
  let surfaceQueued = false;
  let active = true;
  let epoch = 0;
  let failures = 0;
  let settledAt = Date.now();
  return {
    activate() { active = true; },
    dispose() { active = false; queued = false; epoch += 1; },
    due(intervalMs: number) { return !inFlight && Date.now() - settledAt >= intervalMs; },
    retryDelay() { return failures === 0 ? 2_000 : Math.min(10_000, 2_000 * 2 ** Math.min(failures - 1, 3)); },
    request(surfaceError = false): Promise<T | undefined> {
      if (!active) return Promise.resolve(undefined);
      queued = true;
      surfaceQueued ||= surfaceError;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let lastValue: T | undefined;
        do {
          queued = false;
          const requestEpoch = epoch;
          const surface = surfaceQueued;
          surfaceQueued = false;
          try {
            const value = await read();
            if (active && epoch === requestEpoch) {
              lastValue = value;
              failures = 0;
              onValue(value);
            }
          } catch (error) {
            lastValue = undefined;
            if (active && epoch === requestEpoch) {
              failures += 1;
              onError(error, surface);
            }
          } finally {
            settledAt = Date.now();
          }
        } while (queued && active);
        return lastValue;
      })().finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
