import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundMusicControl } from "../src/client/components/BackgroundMusicControl.js";
import { NewRunDialog } from "../src/client/components/NewRunDialog.js";
import { studioApi } from "../src/client/api.js";
import type { StudioBackgroundMusic, StudioMusicUpload, StudioProvider } from "../src/shared/api.js";

const upload: StudioMusicUpload = { uploadId: "music-1", label: "一段音乐.mp3", licenseNote: "本人创作", durationSeconds: 35 };
const file = new File(["test-audio"], "一段音乐.mp3", { type: "audio/mpeg" });
const providers: StudioProvider[] = [
  { id: "codex-screenwriter-v1", capability: "script.draft", label: "编剧", available: true, kind: "local" },
  { id: "api-visual-director-v1", capability: "storyboard.plan", label: "导演", available: true, kind: "local" },
  { id: "ai-shot-router-v1", capability: "asset.prepare", label: "画面", available: true, kind: "local" },
  { id: "pexels-stock-v1", capability: "asset.prepare", label: "图库", available: true, kind: "external", billing: "free", deliveryTypes: ["stock_video"] },
  { id: "macos-say-v1", capability: "voice.synthesize", label: "配音", available: true, kind: "local" },
  { id: "python-ffmpeg-v1", capability: "video.render", label: "渲染", available: true, kind: "local" },
  { id: "python-technical-review-v1", capability: "quality.review", label: "技术检查", available: true, kind: "local" },
  { id: "deepseek-visual-review-v1", capability: "quality.review.visual", label: "审片", available: true, kind: "external", billing: "subscription" },
];
function Controls() {
  const [music, setMusic] = useState<StudioBackgroundMusic>();
  const [busy, setBusy] = useState(false);
  return <><BackgroundMusicControl value={music} onChange={setMusic} onBusyChange={setBusy} /><output aria-label="上传状态">{String(busy)}</output></>;
}
function chooseFileAndLicense() {
  fireEvent.click(screen.getByText("背景音乐（可选）"));
  fireEvent.change(screen.getByLabelText("音乐文件"), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText("音乐授权或来源说明"), { target: { value: "本人创作" } });
}
const initialValues = { title: "音乐成片", angle: "从日常场景展开", audience: "" };

beforeEach(() => {
  vi.spyOn(studioApi, "voices").mockResolvedValue([{ id: "macos:Tingting", providerId: "macos-say-v1", label: "Tingting", locale: "zh-CN", engine: "macos", curated: true }]);
  vi.spyOn(studioApi, "uploadBackgroundMusic").mockResolvedValue(upload);
});

describe("background music controls", () => {
  it("requires both a file and a nonblank rights note before upload", () => {
    render(<Controls />);
    fireEvent.click(screen.getByText("背景音乐（可选）"));
    const use = screen.getByRole("button", { name: "使用这首音乐" });
    expect(use).toBeDisabled();
    fireEvent.change(screen.getByLabelText("音乐文件"), { target: { files: [file] } });
    expect(use).toBeDisabled();
    fireEvent.change(screen.getByLabelText("音乐授权或来源说明"), { target: { value: "   " } });
    expect(use).toBeDisabled();
    fireEvent.click(use);
    expect(studioApi.uploadBackgroundMusic).not.toHaveBeenCalled();
  });

  it("offers the actual uploaded source for listening, retains editable mix settings and can turn music off", async () => {
    render(<Controls />);
    chooseFileAndLicense();
    fireEvent.click(screen.getByRole("button", { name: "使用这首音乐" }));
    expect(await screen.findByLabelText("试听背景音乐原曲")).toHaveAttribute("src", "/api/background-music/music-1");
    expect(studioApi.uploadBackgroundMusic).toHaveBeenCalledExactlyOnceWith(file, "本人创作");
    expect(screen.getByLabelText("音乐音量")).toHaveValue("0.25");
    fireEvent.change(screen.getByLabelText("音乐音量"), { target: { value: "0.1" } });
    expect(screen.getByLabelText("音乐音量")).toHaveValue("0.1");
    expect(screen.getByLabelText("人声出现时降低音乐音量")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "本片不加音乐" }));
    expect(screen.queryByLabelText("试听背景音乐原曲")).not.toBeInTheDocument();
    expect(screen.getByLabelText("音乐文件")).toBeInTheDocument();
    expect(studioApi.uploadBackgroundMusic).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed upload editable and never marks it as selected", async () => {
    vi.mocked(studioApi.uploadBackgroundMusic).mockRejectedValue(new Error("音乐文件无法解码"));
    render(<Controls />);
    chooseFileAndLicense();
    fireEvent.click(screen.getByRole("button", { name: "使用这首音乐" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("音乐文件无法解码");
    expect(screen.queryByLabelText("试听背景音乐原曲")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用这首音乐" })).toBeEnabled();
    expect(screen.getByLabelText("音乐授权或来源说明")).toHaveValue("本人创作");
  });

  it("blocks starting a production while uploading and includes only the accepted music in its brief", async () => {
    let resolve!: (value: StudioMusicUpload) => void;
    vi.mocked(studioApi.uploadBackgroundMusic).mockReturnValue(new Promise(done => { resolve = done; }));
    const submit = vi.fn(async () => {});
    render(<NewRunDialog open providers={providers} initialValues={initialValues} onClose={vi.fn()} onSubmit={submit} />);
    chooseFileAndLicense();
    fireEvent.click(screen.getByRole("button", { name: "使用这首音乐" }));
    expect(screen.getByRole("button", { name: "开始前期构思" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "开始前期构思" }));
    expect(submit).not.toHaveBeenCalled();
    await act(async () => { resolve(upload); });
    await waitFor(() => expect(screen.getByRole("button", { name: "开始前期构思" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "开始前期构思" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ backgroundMusic: { ...upload, volume: 0.25, fadeInSeconds: 1, fadeOutSeconds: 1.5, ducking: true } })));
  });

  it("does not apply a late upload response after switching to native audio and back", async () => {
    let resolve!: (value: StudioMusicUpload) => void;
    vi.mocked(studioApi.uploadBackgroundMusic).mockReturnValue(new Promise(done => { resolve = done; }));
    render(<NewRunDialog open providers={providers} initialValues={initialValues} onClose={vi.fn()} onSubmit={vi.fn(async () => {})} />);
    chooseFileAndLicense();
    fireEvent.click(screen.getByRole("button", { name: "使用这首音乐" }));
    fireEvent.change(screen.getByLabelText("声音来源"), { target: { value: "native_av" } });
    await act(async () => { resolve(upload); });
    fireEvent.change(screen.getByLabelText("声音来源"), { target: { value: "tts" } });
    expect(screen.queryByLabelText("试听背景音乐原曲")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始前期构思" })).toBeEnabled();
  });

  it("does not carry a prior upload into a dialog reopened before the close animation ends", async () => {
    let resolve!: (value: StudioMusicUpload) => void;
    vi.mocked(studioApi.uploadBackgroundMusic).mockReturnValue(new Promise(done => { resolve = done; }));
    const props = { providers, initialValues, onClose: vi.fn(), onSubmit: vi.fn(async () => {}) };
    const { rerender } = render(<NewRunDialog open {...props} />);
    chooseFileAndLicense();
    fireEvent.click(screen.getByRole("button", { name: "使用这首音乐" }));
    rerender(<NewRunDialog open={false} {...props} />);
    rerender(<NewRunDialog open {...props} />);
    await act(async () => { resolve(upload); });
    expect(screen.queryByLabelText("试听背景音乐原曲")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始前期构思" })).toBeEnabled();
  });
});
