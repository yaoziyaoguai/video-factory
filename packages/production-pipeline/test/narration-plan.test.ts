import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNarrationPlan, validateNarrationPlan } from "../src/narration-plan.js";

it("joins adjacent speech across cuts, protects explicit silence and only allows confirmed placement edits", () => {
  const scenes = [{ position: 1, duration: 6, narration: "别急，" },
    { position: 2, duration: 6, narration: "先看看。" },
    { position: 3, duration: 2, narration: "……" },
    { position: 4, duration: 6, narration: "然后出发。" }];
  const plan = buildNarrationPlan(scenes, "a".repeat(64), "b".repeat(64));
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups[0]?.text, "别急， 先看看。");
  assert.deepEqual(plan.silences, [{ id: "silence-3", startFrame: 360, endFrame: 420, source: "legacy_silent_scene" }]);
  const edited = structuredClone(plan);
  edited.groups[1]!.placement = { anchor: "end", offsetFrames: 6 };
  assert.deepEqual(validateNarrationPlan(edited, plan), edited);
  edited.groups[0]!.text = "系统偷偷改了稿";
  assert.throws(() => validateNarrationPlan(edited, plan), /旁白|plan/);
  assert.throws(() => validateNarrationPlan(plan, { ...plan, script: { sha256: "c".repeat(64) } }), /旁白|plan/);
});

// ══ v2 显式分段合同（S1；共享 fixture 与 Python 同判） ══
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildNarrationPlanV2,
  deriveBaseGroupsV2,
  canonicalJsonV2,
  narrationPlanVersion,
  secondsToFramesV2,
  sentenceBoundaryCandidatesV2,
  trimV2,
  userSilencesV2,
  validateNarrationPlanV2,
  validateSlicesV2,
} from "../src/narration-plan.js";
import { isNarrationWordCodePoint, NARRATION_TEXT_TRIM_CODEPOINTS, NARRATION_WORD_INTERVALS } from "../src/narration-text-rules.js";

function applyMutation(root: any, spec: { path: string; value: unknown }): void {
  const parts = spec.path.split(".");
  let node: any = root;
  for (const part of parts.slice(0, -1)) node = node[part];
  node[parts.at(-1)!] = spec.value;
}

describe("narration-plan-v2 共享用例（与 Python 同判）", () => {
  const fixtureDir = path.join(import.meta.dirname ?? process.cwd(), "../../../tests/fixtures");
  const load = (name: string) => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));

  it("共享 v2 正反例全部同判", () => {
    const cases = load("narration-plan-v2-cases.json").cases as Array<Record<string, any>>;
    let ran = 0;
    for (const testCase of cases) {
      const id = testCase.case_id as string;
      const expect = testCase.expect as Record<string, any>;
      const expectError = (call: () => unknown) => {
        assert.throws(call, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (expect.error_contains && !message.includes(expect.error_contains)) {
            assert.fail(`${id}: 错误信息缺少 ${expect.error_contains}：${message}`);
          }
          return true;
        }, `${id}: 应当报错`);
      };
      if (testCase.kind === "build") {
        const groups = deriveBaseGroupsV2(testCase.scenes);
        ran += 1;
        for (const expectedBase of expect.base_groups ?? []) {
          const match = groups.find((g) => JSON.stringify(g.sourceScenePositions) === JSON.stringify(expectedBase.source_scene_positions));
          assert.ok(match, id);
          assert.equal(match.canonicalText, expectedBase.canonical_text, id);
          // 完整规范文字区间与画面帧区间逐一对照，不接受只比末端。
          assert.deepEqual(
            match.sceneTextRanges.map((r) => [r.position, r.start, r.end]),
            expectedBase.scene_text_ranges.map((r: Array<number>, index: number) => [index + 1, r[0], r[1]]),
            id,
          );
        }
        if (expect.frame_ranges !== undefined) {
          assert.deepEqual(
            groups.map((g) => g.frameRange ? [g.frameRange.startFrame, g.frameRange.endFrame] : null),
            expect.frame_ranges, id,
          );
        }
        if (expect.total_frames !== undefined) {
          const plan = buildNarrationPlan(testCase.scenes, testCase.script_sha256, testCase.visual_sha256);
          assert.equal(plan.visualPlan.totalFrames, expect.total_frames, id);
        }
        if (expect.base_group_id_prefix) {
          for (const group of groups) {
            assert.ok(group.baseGroupId.startsWith(expect.base_group_id_prefix), id);
            assert.equal(Array.from(group.baseGroupId).length, expect.base_group_id_len, id);
          }
        }
      } else if (testCase.kind === "validate_slices") {
        const groups = deriveBaseGroupsV2(testCase.scenes);
        if (expect.mode === "ok") {
          const slices = validateSlicesV2(groups[0]!, testCase.slices);
          if (testCase.expect_scenes) {
            assert.deepEqual(slices.map((s) => s.sourceScenePositions), testCase.expect_scenes, id);
          }
          if (testCase.expect_texts !== undefined) {
            assert.deepEqual(slices.map((s) => s.text), testCase.expect_texts, id);
          }
        } else {
          expectError(() => validateSlicesV2(groups[0]!, testCase.slices));
        }
        ran += 1;
      } else if (testCase.kind === "trim_reject") {
        expectError(() => trimV2(testCase.text));
        ran += 1;
      } else if (testCase.kind === "trim") {
        assert.equal(trimV2(testCase.text), expect.trimmed, id);
        ran += 1;
      } else if (testCase.kind === "frames") {
        if (expect.mode === "error") expectError(() => secondsToFramesV2(testCase.seconds));
        else assert.equal(secondsToFramesV2(testCase.seconds), expect.frames, id);
        ran += 1;
      } else if (testCase.kind === "sentence_boundaries") {
        for (const item of testCase.cases as Array<{ text: string; boundaries: number[] }>) {
          assert.deepEqual(sentenceBoundaryCandidatesV2(item.text), item.boundaries, `${id}:${item.text}`);
        }
        ran += 1;
      } else if (testCase.kind === "canonical_json") {
        for (const item of testCase.cases as Array<Record<string, any>>) {
          if (item.error) {
            assert.throws(() => canonicalJsonV2(item.value), (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              return !item.error_contains || message.includes(item.error_contains);
            }, `${id}: canonical JSON 应当拒绝`);
          } else {
            assert.equal(canonicalJsonV2(item.value), item.canonical, `${id}: canonical 字节`);
          }
        }
        ran += 1;
      } else if (testCase.kind === "full_plan") {
        const input = structuredClone(testCase.build_input);
        if (testCase.mutate_input) applyMutation(input, testCase.mutate_input);
        if (expect.mode === "ok") {
          const plan = buildNarrationPlanV2(input);
          assert.equal(narrationPlanVersion(plan), "video-factory/narration-plan-v2", id);
          assert.equal(narrationPlanVersion(buildNarrationPlan(
            [{ position: 1, duration: 2, narration: "甲。" }], "a".repeat(64), "b".repeat(64),
          )), "video-factory/narration-plan-v1", id);
          assert.equal(narrationPlanVersion({ version: "video-factory/narration-plan-v3" }), "video-factory/narration-plan-v3", id);
          assert.throws(() => narrationPlanVersion({ version: "video-factory/narration-plan-v99" }), /版本/, id);
          assert.equal(plan.version, expect.version, id);
          assert.equal(plan.mode, "continuous_groups", id);
          assert.equal(plan.edgeTrim, "none", id);
          assert.equal(plan.subtitleMode, "provider_sentence", id);
          assert.deepEqual(plan.script, { sha256: input.scriptSha256 }, id);
          assert.deepEqual(plan.visualPlan, { sha256: input.visualSha256, fps: 30, totalFrames: expect.total_frames }, id);
          assert.equal(plan.source.normalization, "narration-text-v1", id);
          assert.equal(plan.source.sourceContextId, input.sourceContextId, id);
          assert.equal(plan.source.canonicalSourceSha256, expect.canonical_source_sha256, id);
          assert.deepEqual(plan.groups, expect.groups, id);
          assert.deepEqual(plan.silences, expect.silences, id);
          assert.deepEqual(validateNarrationPlanV2(plan, input), plan, id);
        } else {
          expectError(() => {
            const plan = buildNarrationPlanV2(input);
            if (testCase.mutate_plan) applyMutation(plan, testCase.mutate_plan);
            return validateNarrationPlanV2(plan, input);
          });
        }
        ran += 1;
      } else if (testCase.kind === "user_silences") {
        const legacy = (testCase.legacy_silences as Array<{ start: number; end: number }>)
          .map((s) => ({ startFrame: s.start, endFrame: s.end }));
        expectError(() => userSilencesV2(testCase.total_frames, legacy, testCase.silences));
        ran += 1;
      }
    }
    assert.ok(ran >= 14, `共享用例实际执行数不足：${ran}`);
  });

  it("规则冻结常量与 fixture 一致", () => {
    const fixture = load("narration-text-rules-v1.json");
    assert.deepEqual(NARRATION_TEXT_TRIM_CODEPOINTS.map((c) => c.toString(16).toUpperCase().padStart(4, "0")), fixture.trim_codepoints);
    assert.deepEqual(NARRATION_WORD_INTERVALS.map((i) => [i[0], i[1]]), fixture.word_intervals);
    assert.ok(isNarrationWordCodePoint(0x41) && isNarrationWordCodePoint(0x4e00) && !isNarrationWordCodePoint(0x20));
  });

  it("句界候选按码点归左（拼接空格属于左段）且剔除末尾", () => {
    const candidates = sentenceBoundaryCandidatesV2("甲。 乙。 3.14 是数。");
    assert.deepEqual(candidates, [3, 6]);
  });

  it("秒转换只接受十进制字符串；HTTP 帧数不走本函数", () => {
    for (const bad of ["-1", "1.2345671", "1e3", "abc", "", true, false, null, undefined, 2, -1, 15, 1.5]) {
      assert.throws(() => secondsToFramesV2(bad as unknown as string), `${String(bad)} 必须被拒绝`);
    }
    assert.equal(secondsToFramesV2("0.5"), 15);
    assert.equal(secondsToFramesV2("2"), 60);
    assert.equal(secondsToFramesV2("0.050000"), 2);
    // HTTP 计划只送整数帧（如 v1 placement 校验中的安全整数检查），不再调用秒转换重载。
  });

  it("正式入口导出 v2 合同符号，消费者按 SupportedNarrationPlan 显式分派", async () => {
    const entry = await import("../src/index.js") as unknown as Record<string, unknown>;
    for (const name of ["buildNarrationPlanV2", "validateNarrationPlanV2", "narrationPlanVersion", "deriveBaseGroupsV2",
      "deriveV2SourceFacts", "canonicalSourceSha256V2", "canonicalJsonV2", "secondsToFramesV2", "trimV2",
      "validateSlicesV2", "userSilencesV2", "sentenceBoundaryCandidatesV2"]) {
      assert.equal(typeof entry[name], "function", `${name} 必须从正式入口导出`);
    }
    // 规则常量经正式入口可达且被 trim/word 判定真实消费（非死常量）。
    const deriveFacts = entry.deriveV2SourceFacts as typeof import("../src/narration-plan.js").deriveV2SourceFacts;
    const trim = entry.trimV2 as typeof import("../src/narration-plan.js").trimV2;
    const facts = deriveFacts([{ position: 1, duration: 2, narration: "  甲。 " }]);
    assert.equal(facts.baseGroups[0]?.canonicalText, "甲。");
    assert.equal(trim("　甲。　"), "甲。");
  });

  it("构建后真实 dist 消费：builder/validator/冻结规则及 bool 冒充反例（§4.2.1）", async () => {
    // 原导出测试 import 的是 src；本用例要求先跑 npm run build:pipeline 再验证实际 dist。
    const dist = await import("../dist/index.js") as unknown as Record<string, unknown>;
    for (const name of ["buildNarrationPlanV2", "validateNarrationPlanV2", "trimV2", "deriveV2SourceFacts"]) {
      assert.equal(typeof dist[name], "function", `${name} 必须从 dist 正式入口导出`);
    }
    const distBuild = dist.buildNarrationPlanV2 as typeof import("../src/narration-plan.js").buildNarrationPlanV2;
    const distValidate = dist.validateNarrationPlanV2 as typeof import("../src/narration-plan.js").validateNarrationPlanV2;
    const distTrim = dist.trimV2 as typeof import("../src/narration-plan.js").trimV2;
    const distFacts = dist.deriveV2SourceFacts as typeof import("../src/narration-plan.js").deriveV2SourceFacts;
    // 冻结规则在构建产物内真实消费（trim 依规则表、有词判定经 derive 派生，非死常量）。
    assert.equal(distTrim("　甲。　"), "甲。");
    const distDerived = distFacts([{ position: 1, duration: 2, narration: "　" }]);
    assert.equal(distDerived.legacySilences.length, 1, "全空白镜头经 dist 规则判定为 legacy 静默");
    // 完整 round trip + bool 冒充整数反例：拒绝消息含"整数"即证明 dist 含 §4.2.1 结构校验
    //（isDeepStrictEqual 一直拒绝 bool，但旧 dist 无此显式语义消息，借此排除陈旧 dist）。
    const cases = load("narration-plan-v2-cases.json").cases as Array<Record<string, any>>;
    const masquerades = cases.filter((c) => c.bool_masquerade);
    assert.ok(masquerades.length >= 5, "共享 fixture bool 反例组必须存在");
    for (const testCase of masquerades) {
      const plan = distBuild(structuredClone(testCase.build_input));
      // validator 返回深拷贝（与 Python deepcopy 同语义），校验语义一致用 deepEqual。
      assert.deepEqual(distValidate(plan, testCase.build_input), plan, testCase.case_id);
      const mutated = structuredClone(plan);
      applyMutation(mutated, testCase.mutate_plan);
      assert.throws(() => distValidate(mutated, testCase.build_input), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes("整数");
      }, `${testCase.case_id}: dist 必须按整数语义显式拒绝 bool 冒充`);
    }
  });
});
