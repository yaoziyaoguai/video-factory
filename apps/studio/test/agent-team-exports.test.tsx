import { act, render, renderHook, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactRevision, StudioAccounts } from "../src/shared/agent/generated/contracts.js";
import { useRevisionCommand } from "../src/client/agent/useRevisionCommand.js";
import { TeamSettings } from "../src/client/agent/TeamSettings.js";
import { agentApi } from "../src/client/agent/api.js";
import { RevisionExports } from "../src/client/agent/RevisionExports.js";

const project = { artifactId:"project", revisionId:"project-old" };
const historical: ArtifactRevision = { artifactId:"video",revisionId:"video-v2",revisionNumber:2,baseRevisionId:"video-v1",runId:"render-two",requestId:null,
  digest:"d".repeat(64),createdAt:"2026-11-22T08:00:00Z",content:{format:"media",mimeType:"video/mp4",blobId:"frozen-c2",durationMs:30000,subtitles:{mode:"soft",track:{artifactId:"captions",revisionId:"cap-v1"}}},
  creationBinding:{workId:"work",groupId:"g",itemId:"i",purpose:"production",inputSources:[],reviewInputs:[],projectRevision:project,projectRevisions:[project,{artifactId:"other-p",revisionId:"source-frozen"}]} };
const team: StudioAccounts={revision:1,accounts:[{id:"local-owner",username:"studio",role:"admin",disabledAt:null},{id:"usr-ann",username:"ann",role:"creator",disabledAt:null}]};
afterEach(()=>vi.restoreAllMocks());

it("媒体、字幕、三种时间线、主工程与来源工程指向当前准确修订",async()=>{
  const view=render(<RevisionExports revision={historical} />);
  await userEvent.click(screen.getByText("导出"));
  expect(screen.getByRole("link",{name:"下载 MP4 成片"})).toHaveAttribute("href","/api/agent/v1/blobs/frozen-c2/content");
  expect(screen.getByRole("link",{name:"下载 SRT"})).toHaveAttribute("href","/api/agent/v1/artifacts/video/revisions/video-v2/subtitles?format=srt");
  for(const [name,format] of [["Final Cut Pro XML","fcpxml"],["剪映草稿","jianying"],["OpenTimelineIO","otio"]]){
    expect(screen.getByRole("link",{name:name+" 工程包"})).toHaveAttribute("href","/api/agent/v1/runs/render-two/export?format="+format+"&revisionId=video-v2");
  }
  expect(screen.getByRole("link",{name:"主工程 ZIP（含署名）"})).toHaveAttribute("href","/api/agent/v1/artifacts/project/revisions/project-old/archive.zip?runId=render-two");
  expect(screen.getByRole("link",{name:"来源工程 1 ZIP（含署名）"})).toHaveAttribute("href","/api/agent/v1/artifacts/other-p/revisions/source-frozen/archive.zip");
  view.rerender(<RevisionExports revision={{...historical,runId:null,creationBinding:null,content:{format:"media",mimeType:"video/mp4",durationMs:100,blobId:"old-file"}}} finalized />);
  expect(screen.queryByRole("link",{name:/Final Cut/})).toBeNull();expect(screen.getByText(/未记录这版成片/)).toBeInTheDocument();
});
it("管理员新增创作者使用团队 revision 并在回执写回后关闭密码表单",async()=>{
  vi.spyOn(agentApi,"studioAccounts").mockResolvedValue(team);
  vi.spyOn(agentApi,"budgetPolicies").mockResolvedValue({currency:"CNY",policies:[]});
  const created=vi.spyOn(agentApi,"createStudioAccount").mockResolvedValue({...team,revision:2,accounts:[...team.accounts,{id:"usr-lin",username:"lin",role:"creator",disabledAt:null}]});
  render(<TeamSettings />);
  await userEvent.click(await screen.findByRole("button",{name:"新建账号"}));
  await userEvent.type(screen.getByLabelText("登录账号"),"lin");
  await userEvent.type(screen.getByLabelText("初始密码"),"fixture_only_password");
  await userEvent.click(screen.getByRole("button",{name:"创建账号"}));
  await screen.findByText("账号已创建。");expect(created).toHaveBeenCalledWith(expect.objectContaining({expectedRevision:1,username:"lin",role:"creator"}));
  expect(screen.queryByLabelText("初始密码")).toBeNull();expect(screen.getByRole("option",{name:"lin"})).toBeInTheDocument();
});
it("NEW-06 在成员列表原位停用账号并重置密码", async () => {
  vi.spyOn(agentApi, "studioAccounts").mockResolvedValue(team);
  vi.spyOn(agentApi, "budgetPolicies").mockResolvedValue({ currency: "CNY", policies: [] });
  const apply = vi.spyOn(agentApi, "updateStudioAccount").mockResolvedValue({
    ...team, revision: 2, accounts: team.accounts.map(account => account.username === "ann"
      ? { ...account, disabledAt: "2026-11-22T12:00:00Z" } : account),
  });
  render(<TeamSettings />);
  await userEvent.click(await screen.findByRole("button", { name: "管理 ann" }));
  await userEvent.selectOptions(screen.getByLabelText("账号状态"), "disabled");
  await userEvent.type(screen.getByLabelText("重置密码"), "fixture-rotation");
  await userEvent.click(screen.getByRole("button", { name: "保存成员" }));
  expect(await screen.findByText("创作者 · 已停用")).toBeInTheDocument();
  expect(apply).toHaveBeenCalledWith("ann", expect.objectContaining({ expectedRevision: 1, disabled: true, password: "fixture-rotation" }));
  expect(screen.queryByLabelText("重置密码")).toBeNull();
});
it("人民币精确分、0 和不限额写回用户/共享的不同版本",async()=>{
  vi.spyOn(agentApi,"studioAccounts").mockResolvedValue(team);
  vi.spyOn(agentApi,"budgetPolicies").mockResolvedValue({currency:"CNY",policies:[{scope:"user",subjectId:"usr-ann",revision:3,conversationLimitMinor:16,dayLimitMinor:null,monthLimitMinor:0}]});
  const save=vi.spyOn(agentApi,"saveBudgetPolicy").mockImplementation(async ({commandId:_id,expectedRevision,...p})=>({...p,revision:expectedRevision+1}));
  render(<TeamSettings />); await screen.findByRole("heading",{name:"制作预算"});
  const day=screen.getByLabelText("每天");
  fireEvent.change(day,{target:{value:"3.141"}});await userEvent.click(screen.getByRole("button",{name:"保存预算"}));
  expect(screen.getByRole("alert")).toHaveTextContent("最多两位小数");expect(save).not.toHaveBeenCalled();
  fireEvent.change(day,{target:{value:"0.29"}});fireEvent.change(screen.getByLabelText("每个会话"),{target:{value:"0"}});
  await userEvent.click(screen.getByRole("button",{name:"保存预算"}));await screen.findByText("预算已保存。");
  expect(save).toHaveBeenCalledWith(expect.objectContaining({scope:"workspace",subjectId:"default",expectedRevision:0,dayLimitMinor:29,conversationLimitMinor:0,monthLimitMinor:null}));
  await userEvent.selectOptions(screen.getByLabelText("预算适用范围"),"user:usr-ann");
  expect(screen.getByLabelText("每个会话")).toHaveValue("0.16");expect(screen.getByLabelText("每月")).toHaveValue("0.00");
  fireEvent.change(screen.getByLabelText("每月"),{target:{value:""}});await userEvent.click(screen.getByRole("button",{name:"保存预算"}));
  await waitFor(()=>expect(save).toHaveBeenLastCalledWith(expect.objectContaining({scope:"user",subjectId:"usr-ann",expectedRevision:3,conversationLimitMinor:16,dayLimitMinor:null,monthLimitMinor:null})));
});


it("已收到回执后再次保存相同金额会以当前修订重新提交", async () => {
  const { result } = renderHook(() => useRevisionCommand<number>());
  const save = vi.fn(async (input: { expectedRevision: number; commandId: string; dayLimitMinor: number }) => input.expectedRevision + 1);
  await act(async () => { await result.current.submit({ expectedRevision: 1, dayLimitMinor: 99 }, save); });
  await act(async () => { await result.current.submit({ expectedRevision: 3, dayLimitMinor: 99 }, save); });
  expect(save.mock.calls.map(([body]) => body.expectedRevision)).toEqual([1, 3]);
  expect(save.mock.calls[0]![0].commandId).not.toBe(save.mock.calls[1]![0].commandId);
});
