import type {
  MessageInput, AcceptProposal, ToolDelivery, DeliveryItem,
  InstallSkillPackage, RemoveSkillPackage, SkillPackagesView,
} from "../../../apps/studio/src/shared/agent/generated/contracts.js";

export const requestPrompts = {
  commandId: "cmd_1", text: "先给三条旅行视频 Prompt，别生成视频。",
  target: null, skillId: null, proposalRef: null, mode: "new", steerRequestId: null,
} satisfies MessageInput;

export const acceptSelectedProposal = {
  commandId: "cmd_2", proposalDigest: "a".repeat(64),
} satisfies AcceptProposal;

function promptItem(title: string): DeliveryItem {
  return { mode: "create", title, kind: "prompt", content: { format: "markdown", text: title } };
}
export const batchDelivery = {
  items: [promptItem("雨后出发"), promptItem("留在山风里"), promptItem("傍晚归途")],
} satisfies ToolDelivery;

// 编译期反例只证明消费方类型约束；费用授权仍需服务端运行时与数据库验证。
// @ts-expect-error 命令标识必须是字符串，不能发生数值精度损失。
const invalidId: AcceptProposal = { commandId: 9007199254740993, proposalDigest: "a".repeat(64) };
// @ts-expect-error 接口没有客户端自报用户身份的字段。
const forgedActor: AcceptProposal = { commandId: "cmd_3", proposalDigest: "a".repeat(64), actorId: "owner_2" };
void invalidId;
void forgedActor;

export const installSkillPackage = { source: "/srv/fixtures/creative-skills" } satisfies InstallSkillPackage;
export const removeSkillPackage = { packageId: "package_local" } satisfies RemoveSkillPackage;
export const emptySkillPackages = { packages: [], skills: [], mutation: null } satisfies SkillPackagesView;

// @ts-expect-error 包安装只接受来源，不补造命令回执身份。
const installWithCommand: InstallSkillPackage = { source: "npm:example-skills@1.0.0", commandId: "cmd_install" };
// @ts-expect-error 卸载只接受当前目录里的包标识，不能提交文件路径字段。
const removeBySource: RemoveSkillPackage = { source: "/srv/fixtures/creative-skills" };
void installWithCommand;
void removeBySource;
