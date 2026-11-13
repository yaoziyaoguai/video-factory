import type {
  MessageInput, AcceptProposal, ToolDelivery, DeliveryItem,
  InstallSkillPackage, RemoveSkillPackage, SkillPackagesView,
  ReviewConfirmation, ToolConfirmReview, CreationBinding,
  ToolPublishProject, ToolRenderProject, CodeProjectParameters,
  LocalCreationSpec, LibrarySelection, Run, Proposal,
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

const character = {
  kind: "artifact_revision" as const, artifactId: "character_1", revisionId: "character_v1", digest: "a".repeat(64),
};
export const approveCharacter = {
  workId: "work_1", groupId: "visual_1", action: "approve",
  items: [{ itemId: "character_item", source: character }],
} satisfies ReviewConfirmation;
export const recordCurrentUserApproval: ToolConfirmReview = approveCharacter;
export const approvalMessage = {
  ...requestPrompts, commandId: "cmd_review", text: "人物可以，背景再改",
  reviewConfirmation: approveCharacter, librarySelections: [],
} satisfies MessageInput;

const projectRevision = { artifactId: "project_1", revisionId: "project_v1" };
export const freezeProject = {
  workId: "work_1", title: "人物步行动画", files: ["src/walk.py", "requirements.lock"],
  entrypoint: { argv: ["python", "src/walk.py"] }, dependencyLocks: ["requirements.lock"],
  timelineFiles: [], sourceRevisions: [{ artifactId: character.artifactId, revisionId: character.revisionId }],
} satisfies ToolPublishProject;

export const codeImage = {
  assembly: "code_project", projectRevision, entrypoint: freezeProject.entrypoint,
  outputPath: "outputs/character.png", expectedMediaKind: "image", format: "png", width: 640, height: 360,
} satisfies CodeProjectParameters;
export const codeAudio = {
  assembly: "code_project", projectRevision, entrypoint: freezeProject.entrypoint,
  outputPath: "outputs/music.wav", expectedMediaKind: "audio", format: "wav", sampleRate: 48000, channels: 2,
} satisfies CodeProjectParameters;
export const codeVideo = {
  assembly: "code_project", projectRevision, entrypoint: freezeProject.entrypoint,
  outputPath: "outputs/walk.mp4", expectedMediaKind: "video", format: "mp4", width: 640, height: 360, fps: 24,
} satisfies CodeProjectParameters;

export const renderInitialSample = {
  workId: "work_1", title: "人物样张", scope: "只制作人物样张", purpose: "draft", inputSources: [], reviewInputs: [],
  operations: [{
    operationId: "portrait", outputSlot: "image", inputs: [], parameters: codeImage,
    target: {
      group: { mode: "create", key: "visual", title: "视觉方向", nextIntent: "看过样张后再讨论场景" },
      item: { mode: "create", key: "character", label: "人物", role: "character", required: true },
    },
  }],
} satisfies ToolRenderProject;

export const localSnapshot = {
  type: "local_creation", workId: "work_1", title: "人物样张", requestSource: { requestId: "request_1", messageId: "message_1" },
  scope: "只制作人物样张", purpose: "draft", inputSources: [], reviewInputs: [],
  operations: [{
    operationId: "portrait", outputSlot: "image", inputs: [], kind: "render", model: null, parameters: codeImage,
    target: { groupId: "visual_1", itemId: "character_item", baseRevisionId: null },
  }],
  finalOutput: { operationId: "portrait", outputSlot: "image" },
} satisfies LocalCreationSpec;

export const localRun = {
  id: "run_local", conversationId: "conversation_1", workId: "work_1", snapshotId: "snapshot_1",
  origin: { kind: "local_request", requestId: "request_1" }, revision: 1, state: "queued", finance: null,
  inputRevisions: [], outputRevisions: [], operations: [], segments: [],
  createdAt: "2026-11-07T08:00:00.000Z", updatedAt: "2026-11-07T08:00:00.000Z", issue: null, title: "人物样张",
} satisfies Run;

export const previewBinding = {
  workId: "work_1", groupId: "visual_1", itemId: "walk_preview", purpose: "preview",
  inputSources: [character], reviewInputs: [], projectRevision, runId: "run_preview",
} satisfies CreationBinding;
export const reviewDelivery = {
  items: [{
    mode: "revise", artifactId: "character_1", baseRevisionId: "character_v1", title: "人物新版", kind: "image",
    content: { format: "local_output", source: { kind: "run_output", runId: "run_local", operationId: "portrait", outputSlot: "image" } },
  }],
  reviewGroups: [{
    workId: "work_1", group: { mode: "existing", groupId: "visual_1" },
    items: [{ item: { mode: "existing", itemId: "character_item" }, itemIndex: 0, inputSources: [character], reviewInputs: [], purpose: "draft", projectRevision }],
  }],
} satisfies ToolDelivery;

export const reuseProjectFile = {
  sourceVideo: { artifactId: "video_1", revisionId: "video_v1" },
  source: { kind: "project_file", project: projectRevision, relativePath: "src/walk.py" },
} satisfies LibrarySelection;
export const reuseMessage = {
  ...requestPrompts, commandId: "cmd_reuse", text: "沿用这个人物工程做新片段", librarySelections: [reuseProjectFile],
} satisfies MessageInput;

export function canAccept(proposal: Proposal): boolean {
  return proposal.state === "ready" && proposal.acceptanceBlocker === null;
}

// 编译期反例只证明消费方类型；来源与认可真实性仍在宿主状态边界核实。
// @ts-expect-error 命令标识保持字符串。
const invalidId: AcceptProposal = { commandId: 9007199254740993, proposalDigest: "a".repeat(64) };
// @ts-expect-error 入口不接受客户端自报用户身份。
const forgedActor: AcceptProposal = { commandId: "cmd_3", proposalDigest: "a".repeat(64), actorId: "owner_2" };
// @ts-expect-error 工具不能自报当前认可来源消息。
const forgedApproval: ToolConfirmReview = { ...approveCharacter, sourceMessageId: "message_forged" };
// @ts-expect-error 工程图片分支没有 fps。
const imageWithFps: CodeProjectParameters = { ...codeImage, fps: 24 };
// @ts-expect-error 本地快照没有预算或虚假零报价。
const localWithBudget: LocalCreationSpec = { ...localSnapshot, maxSpend: { currency: "CNY", amountMinor: 0 } };
// @ts-expect-error Run 只通过 origin 表达来源。
const doubleRunOrigin: Run = { ...localRun, proposalId: "proposal_fake" };
void invalidId;
void forgedActor;
void forgedApproval;
void imageWithFps;
void localWithBudget;
void doubleRunOrigin;

export const installSkillPackage = { source: "/srv/fixtures/creative-skills" } satisfies InstallSkillPackage;
export const removeSkillPackage = { packageId: "package_local" } satisfies RemoveSkillPackage;
export const emptySkillPackages = { packages: [], skills: [], mutation: null } satisfies SkillPackagesView;

// @ts-expect-error 包安装只接受来源，不补造命令回执身份。
const installWithCommand: InstallSkillPackage = { source: "npm:example-skills@1.0.0", commandId: "cmd_install" };
// @ts-expect-error 卸载只接受当前目录里的包标识。
const removeBySource: RemoveSkillPackage = { source: "/srv/fixtures/creative-skills" };
void installWithCommand;
void removeBySource;
