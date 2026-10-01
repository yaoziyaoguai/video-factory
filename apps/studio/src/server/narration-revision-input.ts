// 服务端旁白字幕返修请求校验：parseNarrationRelayoutRequest 依赖包内 Node 模块，
// 只在服务端导入，客户端 bundle 不因此引入 @video-factory/production-pipeline 包根。
import { parseNarrationRelayoutRequest } from "@video-factory/production-pipeline";
import { positiveInteger, requiredObject, requiredTrimmedString, StudioInputError, type StudioNarrationRevisionInput } from "../shared/api.js";

export function parseStudioNarrationRevisionInput(value: unknown): StudioNarrationRevisionInput {
  const input = requiredObject(value, "旁白字幕返修请求");
  if (!Number.isSafeInteger(input.expectedRunRevision) || Number(input.expectedRunRevision) < 0) {
    throw new StudioInputError("制作版本必须是非负整数。");
  }
  if (input.action === "recover_subtitles") {
    const requestId = requiredTrimmedString(input.requestId, "字幕恢复操作编号");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new StudioInputError("字幕恢复操作编号无效。");
    const digest = (key: string) => {
      const value = requiredTrimmedString(input[key], "当前声音与字幕版本");
      if (!/^[a-f0-9]{64}$/.test(value)) throw new StudioInputError("当前声音与字幕版本无法核对，请刷新后再试。");
      return value;
    };
    const note = requiredTrimmedString(input.note, "恢复说明");
    if (note.length > 2_000) throw new StudioInputError("恢复说明不能超过 2000 个字符。");
    const refetchReason = input.refetchReason === undefined ? undefined : requiredTrimmedString(input.refetchReason, "重取原字幕的新依据");
    if (refetchReason && refetchReason.length > 500) throw new StudioInputError("重取依据不能超过 500 个字符。");
    return { action: "recover_subtitles", requestId, expectedRunRevision: Number(input.expectedRunRevision),
      expectedVoiceVersionId: requiredTrimmedString(input.expectedVoiceVersionId, "当前声音版本"),
      expectedNarrationPlanSha256: digest("expectedNarrationPlanSha256"), expectedLayoutKey: digest("expectedLayoutKey"),
      expectedAudioSha256: digest("expectedAudioSha256"), note, ...(refetchReason ? { refetchReason } : {}) };
  }
  if (input.action === "relayout_narration") {
    // actor 只能由 HTTP 会话层注入；客户端同名字段即使存在也不进 DTO。
    return parseNarrationRelayoutRequest(input);
  }
  if (input.action !== undefined && input.action !== "revise_narration") throw new StudioInputError("不支持的旁白字幕操作。");
  const narration = requiredTrimmedString(input.narration, "旁白字幕");
  // 上限按"一句话"来定：放宽会让操作员把整篇稿子塞进一镜，收紧了拦不住真正要改的长句。
  if (narration.length > 600) throw new StudioInputError("单镜旁白字幕不能超过 600 个字符。");
  // 旁白是一句口播、字幕是一行字：换行在成片里没有对应语义，配音会把它读成两段，
  // 与其让它在渲染时才显出怪样子，不如在这里就说清它只能是一行。
  if (/[\r\n\u2028\u2029]/.test(narration)) {
    throw new StudioInputError("单镜旁白字幕只能是一行，不能包含换行。");
  }
  const note = requiredTrimmedString(input.note, "修改说明");
  if (note.length > 2_000) throw new StudioInputError("修改说明不能超过 2000 个字符。");
  return {
    expectedRunRevision: Number(input.expectedRunRevision),
    scenePosition: positiveInteger(input.scenePosition, "镜头位置"),
    narration,
    note,
  };
}
