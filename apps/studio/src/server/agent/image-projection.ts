import { resizeImage } from "@earendil-works/pi-coding-agent";
import { AgentToolError } from "./errors.js";

// read_artifact 与发送时的历史投影共用；Pi 的 maxBytes 约束的是 base64 长度。
export async function resizeImageForModel(bytes: Uint8Array, mimeType: string) {
  const resized = await resizeImage(bytes, mimeType, {
    maxWidth: 1280, maxHeight: 1280, maxBytes: 256 * 1024, jpegQuality: 75,
  });
  if (!resized) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "图像无法缩放到模型可接受的大小。");
  return resized;
}
