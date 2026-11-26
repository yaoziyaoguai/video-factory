import type {
  MessageInput, AcceptProposal, RebindProposal, AcceptanceBlocker, ToolDelivery, DeliveryItem,
  InstallSkillPackage, RemoveSkillPackage, SkillPackagesView,
  ReviewConfirmation, ToolConfirmReview, CreationBinding,
  StandaloneArtifactConfirmation, AdoptPreviewConfirmation, ArtifactHead,
  ToolStartWork, ToolPublishProject, ToolRenderProject, CodeProjectParameters, RenderParameters,
  ProjectRenderRequestOperation, LocalRenderOperation,
  LocalCreationSpec, LibrarySelection, LibraryRunInputSource, LibraryMaterial, Run, Proposal,
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

export const approveStandaloneScript = {
  kind: "standalone_artifact", artifactId: "script_standalone", revisionId: "script_v1", action: "approve",
} satisfies StandaloneArtifactConfirmation;
export const recordStandaloneApproval: ToolConfirmReview = approveStandaloneScript;
export const standaloneApprovalMessage = {
  ...requestPrompts, commandId: "cmd_standalone", text: "认可这一版脚本",
  reviewConfirmation: approveStandaloneScript, librarySelections: [],
} satisfies MessageInput;
export const standaloneScriptHead = {
  id: "script_standalone", title: "独立脚本新版", kind: "script", workId: null,
  revisionId: "script_v2", revisionNumber: 2, updatedAt: "2026-11-14T08:01:00Z",
  standaloneApproval: { confirmationId: "confirmation_script_1", revisionId: "script_v1", approvedAt: "2026-11-14T08:00:00Z" },
} satisfies ArtifactHead;
export const startWorkWithoutContent = { title: "开始一件新视频" } satisfies ToolStartWork;
export const startWorkWithScript = {
  title: "从独立文稿开始视频",
  adoptContent: { kind: "artifact_revision", artifactId: "script_standalone", revisionId: "script_v1", digest: "a".repeat(64) },
} satisfies ToolStartWork;
export const startWorkWithMessage = {
  title: "从消息内容开始视频",
  adoptContent: { kind: "message_text", messageId: "message_content", text: "清晨沿着山路出发。" },
} satisfies ToolStartWork;
export const adoptPreview = {
  kind: "adopt_preview", workId: "work_1", groupId: "visual_1", itemId: "walk_preview",
  source: { artifactId: "preview_1", revisionId: "preview_v1" }, action: "finalize_video",
} satisfies AdoptPreviewConfirmation;
export const recordPreviewFinalization: ToolConfirmReview = adoptPreview;
export const adoptPreviewMessage = {
  ...requestPrompts, commandId: "cmd_adopt", text: "以这版定稿并入库",
  reviewConfirmation: adoptPreview, librarySelections: [],
} satisfies MessageInput;

export function confirmationTarget(input: ReviewConfirmation): string {
  if ("kind" in input) return input.kind === "standalone_artifact" ? input.artifactId : input.source.artifactId;
  return input.workId;
}

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

export const nativeMixedParameters = {
  assembly: "mixed_concat", format: "mp4", width: 1280, height: 720, fps: 24,
  segments: [{ kind: "video", inputSlot: 0, startMs: 0, durationMs: 3000, originalGain: 0.4 }],
  segmentIds: ["opening"],
  music: {
    inputSlot: 1, candidateId: "candidate_music", sourceStartMs: 0, sourceDurationMs: 3000,
    timelineStartMs: 0, playDurationMs: 3000, repeat: false, gain: 0.2,
    fadeInMs: 0, fadeOutMs: 0, duckUnderNarration: false,
  },
} satisfies RenderParameters;
export const nativeRenderOperation = {
  operationId: "concat", outputSlot: "video",
  inputs: [
    { kind: "blob", blobId: "blob_raw_video", digest: "a".repeat(64) },
    { kind: "blob", blobId: "blob_music", digest: "b".repeat(64) },
  ],
  parameters: nativeMixedParameters,
  target: { group: { mode: "existing", groupId: "visual_1" }, item: { mode: "existing", itemId: "video_item" } },
} satisfies ProjectRenderRequestOperation;
export const renderNativeConcat = {
  workId: "work_1", title: "已有片段混音", scope: "使用已有片段与音乐", purpose: "production",
  inputSources: [], reviewInputs: [], operations: [nativeRenderOperation],
} satisfies ToolRenderProject;
export const frozenNativeOperation = {
  ...nativeRenderOperation, kind: "render", model: null,
  target: { groupId: "visual_1", itemId: "video_item", baseRevisionId: null },
  musicSource: {
    provider: "freetouse", assetId: "music_1", sourceUrl: "https://example.invalid/music/1",
    creatorName: "Example Artist", creatorUrl: null, licenseUrl: "https://example.invalid/license",
    acquiredAt: "2026-11-14T08:00:00Z", attributionText: "Example music attribution",
  },
} satisfies LocalRenderOperation;

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
export const adoptedVideoBinding = {
  ...previewBinding, itemId: "video_item", purpose: "production",
  projectRevisions: [projectRevision], adoptedFrom: adoptPreview.source,
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
export const rawInputSource = {
  kind: "run_input", runId: "run_preview", operationId: "concat", inputIndex: 0, blobId: "blob_raw_video",
} satisfies LibraryRunInputSource;
export const rawLibraryMaterial = {
  source: rawInputSource, label: "原始片段", kind: "video", provenance: [],
} satisfies LibraryMaterial;
export const revisionLibraryMaterial = {
  source: { artifactId: "character_1", revisionId: "character_v1" }, label: "人物", kind: "image", provenance: [],
} satisfies LibraryMaterial;
export const reuseRawInput = {
  sourceVideo: { artifactId: "video_1", revisionId: "video_v1" }, source: rawInputSource,
} satisfies LibrarySelection;
export const reuseMessage = {
  ...requestPrompts, commandId: "cmd_reuse", text: "沿用这个人物工程和原始片段", librarySelections: [reuseProjectFile, reuseRawInput],
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
// 联合中旧 work 分支无 kind；混合 payload 的排他性由 examples.json 的运行时 oneOf 反例验证。
// @ts-expect-error 准确独立稿分支不能混入旧 work 目标。
const mixedApprovalBranches: StandaloneArtifactConfirmation = { ...approveStandaloneScript, workId: "work_1" };
// @ts-expect-error 独立稿只支持 approve。
const standaloneFinalization: ToolConfirmReview = { ...approveStandaloneScript, action: "finalize_video" };
// @ts-expect-error 预览采用必须明确 finalize_video。
const adoptAsApproval: ToolConfirmReview = { ...adoptPreview, action: "approve" };
// @ts-expect-error 预览来源是无 kind 的 RevisionRef。
const adoptContentSource: ToolConfirmReview = { ...adoptPreview, source: { kind: "artifact_revision", artifactId: "preview_1", revisionId: "preview_v1" } };
// @ts-expect-error 工具输入不能提交宿主冻结的 musicSource。
const requestWithMusicSource: ProjectRenderRequestOperation = { ...nativeRenderOperation, musicSource: frozenNativeOperation.musicSource };
// @ts-expect-error raw 坐标不能省略准确已定稿来源视频。
const rawWithoutVideo: LibrarySelection = { source: rawInputSource };
// @ts-expect-error 旧 LibraryMaterial.source 仍为无 kind 的 RevisionRef。
const taggedRevisionMaterial: LibraryMaterial = { ...revisionLibraryMaterial, source: { kind: "artifact_revision", artifactId: "character_1", revisionId: "character_v1" } };
void mixedApprovalBranches;
void standaloneFinalization;
void adoptAsApproval;
void adoptContentSource;
void requestWithMusicSource;
void rawWithoutVideo;
void taggedRevisionMaterial;
// @ts-expect-error 采用文稿需要包含 digest 的准确 ContentSourceInput。
const adoptWithoutDigest: ToolStartWork = { title: "采用文稿", adoptContent: { kind: "artifact_revision", artifactId: "script_standalone", revisionId: "script_v1" } };
// @ts-expect-error 独立稿认可 ID 不能作为新 work 的审批输入。
const startWithStandaloneConfirmation: ToolStartWork = { ...startWorkWithScript, confirmationId: "confirmation_script_1" };
void adoptWithoutDigest;
void startWithStandaloneConfirmation;

export const installSkillPackage = { source: "/srv/fixtures/creative-skills" } satisfies InstallSkillPackage;
export const removeSkillPackage = { packageId: "package_local" } satisfies RemoveSkillPackage;
export const emptySkillPackages = { packages: [], skills: [], mutation: null } satisfies SkillPackagesView;

// @ts-expect-error 包安装只接受来源，不补造命令回执身份。
const installWithCommand: InstallSkillPackage = { source: "npm:example-skills@1.0.0", commandId: "cmd_install" };
// @ts-expect-error 卸载只接受当前目录里的包标识。
const removeBySource: RemoveSkillPackage = { source: "/srv/fixtures/creative-skills" };
void installWithCommand;
void removeBySource;

export const rebindSingleShot = {
  commandId: "cmd_rebind_1",
  expectedDigest: "b".repeat(64),
  changes: [
    {
      operationId: "shot_2",
      model: {
        providerId: "colab",
        modelId: "Lightricks/LTX-2.5-distilled",
        connectionId: "conn_colab_1",
        configurationRevisionId: "cfg-colab0000000000000000001",
      },
    },
  ],
} satisfies RebindProposal;

export const modelSelectionRequiredBlocker = {
  code: "MODEL_SELECTION_REQUIRED",
  message: "请先选择本次使用的视频模型。",
  action: "select_model",
} satisfies AcceptanceBlocker;
