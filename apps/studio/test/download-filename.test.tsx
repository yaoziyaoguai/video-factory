import { describe, expect, it } from "vitest";
import { videoDownloadFilename } from "../src/client/download-filename.js";

// DG-UX-06（新前端 Dogfood 修复执行包 R6）：下载文件名的纯函数合同。
describe("video download filename (DG-UX-06)", () => {
  it("sanitizes illegal characters, keeps unicode, bounds bytes, and stays stable per artifact", () => {
    // 斜杠/引号/星号/半角问号替换为连字符；全角冒号、问号是合法文件名字符，保留。
    expect(videoDownloadFilename('窗边/三分钟："找回"*注意力?', "artifact-1")).toBe("窗边-三分钟：-找回--注意力-__artifact-1.mp4");
    // 空标题与纯非法字符标题都退到安全名。
    expect(videoDownloadFilename("   ", "artifact-1")).toBe("视频作品__artifact-1.mp4");
    expect(videoDownloadFilename("///", "artifact-1")).toBe("视频作品__artifact-1.mp4");
    // emoji 不被截成半个码点；完整名 UTF-8 ≤240 字节，且真的用满预算而不是提前砍光。
    const longName = videoDownloadFilename("🎬".repeat(80), "artifact-8ece27e2-a93b-41d1-8fac-79768988896e");
    const bytes = new TextEncoder().encode(longName!).length;
    expect(bytes).toBeLessThanOrEqual(240);
    expect(bytes).toBeGreaterThan(230);
    expect(/[\uD800-\uDFFF]/u.test(longName!)).toBe(false); // 没有孤立代理半码点
    // 长中文标题同样受 240 字节约束（80 个三字节字符 = 240B 后缀放不下 → 必须截断标题）。
    const longChinese = videoDownloadFilename("长".repeat(80), "artifact-1");
    expect(new TextEncoder().encode(longChinese!).length).toBeLessThanOrEqual(240);
    // 同标题不同产物 → 不同文件名；同产物稳定；不伪造业务版本号。
    expect(videoDownloadFilename("同一标题", "artifact-a")).not.toBe(videoDownloadFilename("同一标题", "artifact-b"));
    expect(videoDownloadFilename("同一标题", "artifact-a")).toBe(videoDownloadFilename("同一标题", "artifact-a"));
    expect(videoDownloadFilename("同一标题", "artifact-a")).not.toMatch(/v\d|终稿|最新/);
    // Windows 保留名加安全前缀。
    expect(videoDownloadFilename("CON", "artifact-1")).toBe("视频-CON__artifact-1.mp4");
    // 非法产物身份不产出文件名（不猜、不从文件名截身份）。
    expect(videoDownloadFilename("标题", "../evil")).toBeUndefined();
    expect(videoDownloadFilename("标题", "")).toBeUndefined();
  });
});
