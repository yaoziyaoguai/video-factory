import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApi } from "../src/client/agent/api.js";
import { ReviewMediaTools } from "../src/client/agent/ReviewMediaTools.js";
import { SubtitleTrackPanel } from "../src/client/agent/SubtitleTrackPanel.js";
import { RevisionBody } from "../src/client/agent/ProductionCards.js";
import type { ArtifactRevision, LocalCreationReceipt, RemixTimeline, SubtitleTrack, Work } from "../src/shared/agent/generated/contracts.js";

const source = { artifactId: "src-voice", revisionId: "voice-v1" };
const captions = { artifactId: "src-captions", revisionId: "sub-v1" };
const approved = { kind: "artifact_revision" as const, ...captions, digest: "a".repeat(64) };
const track: SubtitleTrack = { format: "subtitles", source, alignment: "tts_word", stylePreset: "clean_bottom",
  cues: [{ id: "a", startMs: 120, endMs: 920, text: "晨风吹过" }, { id: "b", startMs: 1000, endMs: 1500, text: "Hello world" }] };
const revision: ArtifactRevision = { ...captions, revisionNumber: 1, baseRevisionId: null, digest: "a".repeat(64), content: track,
  requestId: null, runId: null, createdAt: "2026-11-20T00:00:00Z" };
const work: Work = { id: "w", title: "山路剪辑", revision: 8, createdAt: revision.createdAt, updatedAt: revision.createdAt,
  reviewGroups: [{ id:"g", title:"字幕", revision:3, nextIntent:null, items:[
    { id:"i", label:"山路字幕", role:"subtitle", required:false, draft:{...approved,revisionId:"sub-v2"}, approved, approvedAt:revision.createdAt, confirmationId:"confirm", finalizedSource:null },
    { id:"draft-only", label:"另一份待审字幕", role:"subtitle", required:false, draft:{...approved,artifactId:"other"}, approved:null, approvedAt:null, confirmationId:null, finalizedSource:null },
  ] }] };
const base = { artifactId:"cut", revisionId:"cut-v3" };
const timeline: Extract<RemixTimeline, {available:true}> = { available:true, revision:6, base,
  segments:[{ id:"opening",label:"开场",kind:"video",startMs:1000,durationMs:1000,sourceDurationMs:5000,originalGain:.25 },
    { id:"end",label:"结尾",kind:"video",startMs:0,durationMs:2500,sourceDurationMs:2800,originalGain:.75 }],
  narrationGain:.8,musicGain:.35,duckUnderNarration:true,subtitles:null };
const local: LocalCreationReceipt = {
  run: { id:"new-run", conversationId:"c", workId:work.id, snapshotId:"snapshot",
    revision:1, state:"queued", finance:null, inputRevisions:[], outputRevisions:[], operations:[], segments:[],
    createdAt:revision.createdAt, updatedAt:revision.createdAt, issue:null, title:"本地重合成",
    origin:{kind:"local_request",requestId:"request"} },
  reviewTargets:[{operationId:"render",groupId:"g",itemId:"cut"}],
};
beforeEach(() => { vi.spyOn(agentApi,"remixTimeline").mockResolvedValue(timeline); });
afterEach(() => vi.restoreAllMocks());
function tools() {
  return <ReviewMediaTools work={work} source={base} runId="run-a" buffers={new Map()} onOpen={vi.fn()} onRun={vi.fn()} revisions={{"src-captions:sub-v1":revision}} />;
}

describe("3.3 字幕与重剪", () => {
  it("字幕生成绑定原作品与精确来源，成功后由用户主动审阅",async()=>{
    const create=vi.spyOn(agentApi,"createSubtitleTrack").mockResolvedValue({artifact:captions,revisionNumber:1,workId:work.id}), open=vi.fn();
    render(<ReviewMediaTools work={work} source={source} runId={null} buffers={new Map()} onOpen={open} onRun={vi.fn()} revisions={{}} />);
    await userEvent.click(screen.getByText("生成字幕",{exact:true}));
    await userEvent.selectOptions(screen.getByLabelText("字幕样式"),"cinema_bilingual");
    await userEvent.click(screen.getByRole("button",{name:"生成字幕初稿"}));
    expect(create).toHaveBeenCalledWith("w",expect.objectContaining({expectedRevision:8,source,stylePreset:"cinema_bilingual"}));
    expect(agentApi.remixTimeline).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button",{name:"审阅字幕 v1"}));expect(open).toHaveBeenCalledWith(captions);
  });
  it("字幕生成的响应丢失后，实时更新不改变重试的命令与原版本",async()=>{
    const create=vi.spyOn(agentApi,"createSubtitleTrack").mockRejectedValueOnce(new Error("连接中断")).mockResolvedValue({artifact:captions,revisionNumber:1,workId:work.id});
    const props={source,runId:null,buffers:new Map(),onOpen:vi.fn(),onRun:vi.fn(),revisions:{}};
    const view=render(<ReviewMediaTools {...props} work={work} />);
    await userEvent.click(screen.getByText("生成字幕",{exact:true}));
    await userEvent.click(screen.getByRole("button",{name:"生成字幕初稿"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("连接中断");
    view.rerender(<ReviewMediaTools {...props} work={{...work,revision:9}} />);
    await userEvent.click(screen.getByRole("button",{name:"生成字幕初稿"}));
    await screen.findByRole("button",{name:"审阅字幕 v1"});
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(create.mock.calls[1]![1].expectedRevision).toEqual(8);
  });
  it("起止与断句可校对，保留原稿，关闭重开保留编辑并保存同一字幕的新修订",async()=>{
    const save=vi.spyOn(agentApi,"saveSubtitleRevision").mockResolvedValue({artifact:{...captions,revisionId:"sub-v2"},revisionNumber:2,workId:"w"});
    const buffers=new Map(), open=vi.fn(), props={revision,track,editor:{buffers,onSaved:open}};
    const first=render(<SubtitleTrackPanel {...props} />);
    expect(screen.getByRole("link",{name:"下载 SRT"})).toHaveAttribute("href","/api/agent/v1/artifacts/src-captions/revisions/sub-v1/subtitles?format=srt");
    await userEvent.click(screen.getByRole("button",{name:"校对字幕"}));
    const text=screen.getByRole("textbox",{name:"第 1 句字幕"}) as HTMLTextAreaElement;
    text.focus();text.setSelectionRange(2,2);
    await userEvent.click(screen.getAllByRole("button",{name:"在光标处断句"})[0]!);
    expect(screen.getByRole("textbox",{name:"第 2 句字幕"})).toHaveValue("吹过");
    expect(screen.getByLabelText("第 2 句开始毫秒")).toHaveValue(520);
    await userEvent.click(screen.getAllByRole("button",{name:"合并下一句"})[0]!);
    fireEvent.change(screen.getByLabelText("第 1 句开始毫秒"),{target:{value:"150"}});
    fireEvent.change(screen.getByRole("textbox",{name:"第 1 句字幕"}),{target:{value:"晨风吹过山路"}});
    await userEvent.selectOptions(screen.getByLabelText("字幕样式"),"social_pop_center");
    first.unmount();
    render(<SubtitleTrackPanel {...props} />);
    await userEvent.click(screen.getByRole("button",{name:"继续校对字幕"}));
    expect(screen.getByLabelText("第 1 句开始毫秒")).toHaveValue(150);
    fireEvent.change(screen.getByLabelText("第 2 句开始毫秒"),{target:{value:"800"}});
    await userEvent.click(screen.getByRole("button",{name:"保存为新版本"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("第 2 句");expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("第 2 句开始毫秒"),{target:{value:"1000"}});
    await userEvent.click(screen.getByRole("button",{name:"保存为新版本"}));
    expect(save).toHaveBeenCalledWith(captions.artifactId,expect.objectContaining({expectedRevision:1,baseRevisionId:"sub-v1",stylePreset:"social_pop_center",cues:[{id:"a",startMs:150,endMs:920,text:"晨风吹过山路"},track.cues[1]]}));
    expect(open).toHaveBeenCalledWith({...captions,revisionId:"sub-v2"});expect(track.cues[0].text).toBe("晨风吹过");
  });
  it("剪辑顺序、毫秒进点、三路音量、duck 和已认可字幕直发本地重合成",async()=>{
    const send=vi.spyOn(agentApi,"remixRun").mockResolvedValue(local);
    render(tools());await userEvent.click(await screen.findByText("微调时间线与混音"));
    expect(agentApi.remixTimeline).toHaveBeenCalledWith("run-a","cut-v3");
    await userEvent.click(screen.getByRole("button",{name:"上移 结尾"}));
    fireEvent.change(screen.getByLabelText("镜头 2 进点毫秒"),{target:{value:"800"}});
    fireEvent.change(screen.getByRole("slider",{name:"镜头 1 时长滑块"}),{target:{value:"1200"}});
    await userEvent.click(screen.getByLabelText("统一调整各镜头原声"));
    for(const [label,n] of [["原声音量",40],["配音音量",90],["音乐音量",18]] as const)
      fireEvent.change(screen.getByRole("slider",{name:label}),{target:{value:String(n)}});
    await userEvent.click(screen.getByLabelText("配音时降低音乐"));
    expect(screen.queryByRole("option",{name:/另一份待审字幕/})).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("字幕轨"),"sub-v1");
    await userEvent.selectOptions(screen.getByLabelText("呈现方式"),"burn_in");
    await userEvent.click(screen.getByRole("button",{name:"重新合成预览"}));
    expect(send).toHaveBeenCalledWith("run-a",expect.objectContaining({expectedRevision:6,baseRevisionId:"cut-v3",segments:[{id:"end",startMs:0,durationMs:1200},{id:"opening",startMs:800,durationMs:1000}],originalGain:.4,narrationGain:.9,musicGain:.18,
      duckUnderNarration:false,subtitles:{mode:"burn_in",track:captions}}));
    expect(screen.getByText("供应商费用 ¥0.00")).toBeVisible();await screen.findByRole("button",{name:"查看制作记录"});
  });
  it("仅调音乐保留不同片段原声及字幕；不可重剪的版本没有微调入口",async()=>{
    const send=vi.spyOn(agentApi,"remixRun").mockResolvedValue(local);
    const ui=render(tools());await userEvent.click(await screen.findByText("微调时间线与混音"));
    fireEvent.change(screen.getByLabelText("音乐音量"),{target:{value:"18"}});
    await userEvent.click(screen.getByRole("button",{name:"重新合成预览"}));
    const body=send.mock.calls[0]![1];expect(body.musicGain).toBe(.18);expect(body.originalGain).toBeUndefined();expect(body.subtitles).toBeUndefined();
    ui.unmount();vi.mocked(agentApi.remixTimeline).mockResolvedValue({available:false});await act(async()=>{render(tools());});
    expect(screen.queryByText("微调时间线与混音")).toBeNull();expect(screen.getByText("生成字幕",{exact:true})).toBeVisible();
  });
  it("带字幕的成片按此成片修订下载，历史字幕保持只读",async()=>{
    const output: ArtifactRevision={...revision,...base,content:{format:"media",blobId:"movie",durationMs:1500,mimeType:"video/mp4",subtitles:{mode:"soft",track:captions}}};
    const ui=render(<RevisionBody revision={output} simulated={false} />);
    await userEvent.click(screen.getByText("导出",{exact:true}));
    expect(screen.getByRole("link",{name:"下载 VTT"})).toHaveAttribute("href","/api/agent/v1/artifacts/cut/revisions/cut-v3/subtitles?format=vtt");
    expect(ui.container.querySelector("track")).toHaveAttribute("src","/api/agent/v1/artifacts/cut/revisions/cut-v3/subtitles?format=vtt");
    ui.rerender(<RevisionBody revision={revision} simulated={false} />);
    const region=await screen.findByRole("region",{name:"字幕轨道"});
    expect(within(region).queryByRole("button",{name:"校对字幕"})).toBeNull();
    await waitFor(()=>expect(within(region).getByText("晨风吹过")).toBeVisible());
  });
});
