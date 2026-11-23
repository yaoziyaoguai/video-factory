import type { RenderFitMode, RenderFrameRate, StillMotion } from "../../shared/agent/generated/contracts.js";

type Target = { width: number; height: number; fps: RenderFrameRate; fitMode?: RenderFitMode };
type SegmentStyle = { fitMode?: RenderFitMode; kenBurns?: StillMotion; durationMs?: number };

// 使用方传入内部 FFmpeg 流标签和已经冻结的毫秒裁切。外部输入的样式仅能选择契约枚举。
export function buildVisualNormalizeFilter(input: string, output: string, trim: string, target: Target, segment: SegmentStyle = {}): string {
  const { width, height, fps } = target;
  const fit = segment.fitMode ?? target.fitMode ?? "contain_pad";
  const base = `[${input}]${trim},fps=${fps},scale=w='max(2,trunc(iw*if(gt(sar,0),sar,1)/2)*2)':h=ih,setsar=1`;
  const scale = (w: number, h: number, how: "increase" | "decrease") =>
    `scale=${w}:${h}:force_original_aspect_ratio=${how}:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`;
  const front = scale(width, height, "decrease");
  let graph: string;
  if (fit === "blur_backdrop") {
    // 模糊层无高频细节，先在小画布模糊再放大，前景保留成片清晰度。
    const w = Math.max(2, Math.round(width / 16) * 2), h = Math.max(2, Math.round(height / 16) * 2);
    graph = `${base},split[${output}bg][${output}fg];[${output}bg]${scale(w, h, "increase")},crop=${w}:${h},boxblur=5:2,scale=${width}:${height},setsar=1[${output}back];[${output}fg]${front},setsar=1[${output}front];[${output}back][${output}front]overlay=(W-w)/2:(H-h)/2`;
  } else {
    graph = fit === "cover_crop" ? `${base},${scale(width, height, "increase")},crop=${width}:${height}`
      : `${base},${front},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  }
  if (segment.kenBurns && segment.kenBurns !== "none") {
    const lastFrame = Math.max(1, Math.round(segment.durationMs! * fps / 1000) - 1);
    const progress = `min(on/${lastFrame},1)`;
    const z = segment.kenBurns === "zoom_in" ? `1+0.12*${progress}` : segment.kenBurns === "zoom_out" ? `1.12-0.12*${progress}` : "1.12";
    const x = segment.kenBurns === "pan" ? `(iw-iw/zoom)*${progress}` : "(iw-iw/zoom)/2";
    graph += `,zoompan=z='${z}':x='${x}':y='(ih-ih/zoom)/2':d=1:s=${width}x${height}:fps=${fps}`;
  }
  return `${graph},setsar=1,format=yuv420p[${output}]`;
}
