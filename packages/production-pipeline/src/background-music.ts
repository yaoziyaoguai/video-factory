export interface BackgroundMusicMix {
  volume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  ducking: boolean;
}

export interface ProductionBackgroundMusic extends BackgroundMusicMix {
  uploadId: string;
  label: string;
  licenseNote: string;
  durationSeconds: number;
  path: string;
  sha256: string;
}

export function parseBackgroundMusicMix(value: unknown): BackgroundMusicMix {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("背景音乐设置不正确。");
  const input = value as Record<string, unknown>;
  const number = (key: string, maximum: number): number => {
    const result = input[key];
    if (typeof result !== "number" || !Number.isFinite(result) || result < 0 || result > maximum) {
      throw new Error(`背景音乐 ${key} 必须在 0 到 ${maximum} 之间。`);
    }
    return result;
  };
  if (typeof input.ducking !== "boolean") throw new Error("背景音乐需明确是否在人声出现时降低音量。");
  return { volume: number("volume", 0.5), fadeInSeconds: number("fadeInSeconds", 5),
    fadeOutSeconds: number("fadeOutSeconds", 5), ducking: input.ducking };
}

export function parseBackgroundMusic(value: unknown): ProductionBackgroundMusic | undefined {
  if (value === undefined) return undefined;
  const mix = parseBackgroundMusicMix(value);
  const input = value as Record<string, unknown>;
  for (const key of ["uploadId", "label", "licenseNote", "path", "sha256"]) {
    if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`背景音乐缺少 ${key}。`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(input.uploadId)) || input.uploadId !== input.sha256) throw new Error("背景音乐内容身份不正确。");
  if (String(input.label).length > 160 || String(input.licenseNote).length > 500) throw new Error("背景音乐名称或授权说明过长。");
  if (typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 600) throw new Error("背景音乐时长无效。");
  return { ...mix, durationSeconds: input.durationSeconds, uploadId: String(input.uploadId), label: String(input.label), licenseNote: String(input.licenseNote),
    path: String(input.path), sha256: String(input.sha256) };
}
