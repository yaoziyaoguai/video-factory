export function formatBytes(bytes: number) {
  const index = bytes === 0 ? 0 : Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Number((bytes / 1024 ** index).toFixed(1))} ${["B", "KiB", "MiB", "GiB"][index]}`;
}
