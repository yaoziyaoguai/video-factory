import copy
import json
import unittest

from video_factory.narration_plan import build_narration_plan, validate_narration_plan


class NarrationPlanTest(unittest.TestCase):
    def test_adjacent_narrations_share_one_window_without_changing_the_visual_cuts(self):
        scenes = [
            {"position": 1, "duration": 6, "narration": "我们总是急着赶路，"},
            {"position": 2, "duration": 6, "narration": "直到有一天抬起头，"},
            {"position": 3, "duration": 8, "narration": "才发现城市一直亮着。"},
        ]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(plan["version"], "video-factory/narration-plan-v1")
        self.assertEqual(plan["visualPlan"]["totalFrames"], 600)
        self.assertEqual(len(plan["groups"]), 1)
        group = plan["groups"][0]
        self.assertEqual(group["sourceScenePositions"], [1, 2, 3])
        self.assertEqual(group["text"], " ".join(scene["narration"] for scene in scenes))
        self.assertEqual(group["window"], {"startFrame": 0, "endFrame": 600})
        self.assertEqual(group["placement"], {"anchor": "start", "offsetFrames": 0})
        self.assertEqual(plan["silences"], [])
        self.assertEqual([scene["duration"] for scene in scenes], [6, 6, 8])

    def test_explicit_silence_splits_groups_and_never_becomes_paid_narration(self):
        scenes = [
            {"position": 1, "duration": 10, "narration": "把今天放慢一点。"},
            {"position": 2, "duration": 4, "narration": "……"},
            {"position": 3, "duration": 6, "narration": "给自己留一格空白。"},
        ]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual([group["sourceScenePositions"] for group in plan["groups"]], [[1], [3]])
        self.assertEqual([group["window"] for group in plan["groups"]], [
            {"startFrame": 0, "endFrame": 300}, {"startFrame": 420, "endFrame": 600},
        ])
        self.assertEqual(plan["silences"], [{"id": "silence-2", "startFrame": 300,
                                            "endFrame": 420, "source": "legacy_silent_scene"}])
        silent = build_narration_plan([scenes[1] | {"position": 1}],
                                      script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(silent["groups"], [])

    def test_confirmed_plan_rejects_changed_sources_and_silence_or_text_bypasses(self):
        scenes = [{"position": 1, "duration": 10, "narration": "第一句。"},
                  {"position": 2, "duration": 4, "narration": "……"},
                  {"position": 3, "duration": 6, "narration": "第二句。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        def validate(value):
            return validate_narration_plan(value, scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(validate(plan), plan)
        for change in ("source", "silence", "window", "text", "duplicate", "offset"):
            invalid = copy.deepcopy(plan)
            if change == "source": invalid["script"]["sha256"] = "c" * 64
            elif change == "silence": invalid["silences"] = []
            elif change == "window": invalid["groups"][0]["window"]["endFrame"] = 420
            elif change == "text": invalid["groups"][0]["text"] = "偷偷改了已经确认的旁白。"
            elif change == "duplicate": invalid["groups"].append(copy.deepcopy(invalid["groups"][0]))
            elif change == "offset": invalid["groups"][0]["placement"]["offsetFrames"] = 600
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate(invalid)


# ══ v2 显式分段合同（S1；共享 fixture 与 TS 同判） ══
import os
import unittest

_FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _apply_mutation(root, spec):
    parts = spec["path"].split(".")
    node = root
    for part in parts[:-1]:
        node = node[int(part)] if isinstance(node, list) else node[part]
    last = parts[-1]
    if isinstance(node, list):
        node[int(last)] = spec["value"]
    else:
        node[last] = spec["value"]


class NarrationPlanV2Test(unittest.TestCase):
    def _load(self, name):
        with open(os.path.join(_FIXTURE_DIR, name), encoding="utf-8") as handle:
            return json.load(handle)

    def test_shared_v2_cases(self):
        from video_factory.narration_plan import (
            build_narration_plan_v2,
            canonical_json_v2,
            derive_base_groups_v2,
            seconds_to_frames_v2,
            sentence_boundary_candidates_v2,
            trim_v2,
            user_silences_v2,
            validate_narration_plan_v2,
            validate_slices_v2,
        )
        cases = self._load("narration-plan-v2-cases.json")["cases"]
        ran = 0
        for case in cases:
            cid = case["case_id"]
            expect = case.get("expect", {})

            def expect_error(callable_):
                try:
                    callable_()
                except ValueError as error:
                    if expect.get("error_contains") and expect["error_contains"] not in str(error):
                        self.fail(f"{cid}: 错误信息缺少 {expect['error_contains']}：{error}")
                    return
                self.fail(f"{cid}: 应当报错：{expect.get('error_contains', 'any ValueError')}")

            if case["kind"] == "build":
                groups = derive_base_groups_v2(case["scenes"])
                ran += 1
                for expected_base in expect.get("base_groups", []):
                    match = [g for g in groups if g["source_scene_positions"] == expected_base["source_scene_positions"]]
                    self.assertTrue(match, cid)
                    self.assertEqual(match[0]["canonical_text"], expected_base["canonical_text"], cid)
                    actual_ranges = [(r["position"], r["start"], r["end"]) for r in match[0]["scene_text_ranges"]]
                    expected_ranges = [(i + 1, r[0], r[1]) for i, r in enumerate(expected_base["scene_text_ranges"])]
                    self.assertEqual(actual_ranges, expected_ranges, cid)
                if "frame_ranges" in expect:
                    self.assertEqual(
                        [(g["frame_range"]["startFrame"], g["frame_range"]["endFrame"])
                         if "frame_range" in g else None for g in groups],
                        [tuple(pair) for pair in expect["frame_ranges"]], cid)
                if "total_frames" in expect:
                    from video_factory.narration_plan import build_narration_plan
                    plan = build_narration_plan(case["scenes"], script_sha256=case["script_sha256"], visual_sha256=case["visual_sha256"])
                    self.assertEqual(plan["visualPlan"]["totalFrames"], expect["total_frames"], cid)
                if expect.get("base_group_id_prefix"):
                    self.assertTrue(all(g["base_group_id"].startswith(expect["base_group_id_prefix"]) for g in groups), cid)
                    self.assertTrue(all(len(g["base_group_id"]) == expect["base_group_id_len"] for g in groups), cid)
            elif case["kind"] == "validate_slices":
                groups = derive_base_groups_v2(case["scenes"])
                # POS 用例逐切片核对场景归属；NEG 用例必须报错
                if expect["mode"] == "ok":
                    slices = validate_slices_v2(groups[0], case["slices"])
                    if "expect_scenes" in case:
                        self.assertEqual([s["sourceScenePositions"] for s in slices], case["expect_scenes"], cid)
                else:
                    expect_error(lambda: validate_slices_v2(groups[0], case["slices"]))
                ran += 1
            elif case["kind"] == "trim_reject":
                expect_error(lambda: trim_v2(case["text"]))
                ran += 1
            elif case["kind"] == "trim":
                self.assertEqual(trim_v2(case["text"]), expect["trimmed"], cid)
                ran += 1
            elif case["kind"] == "frames":
                if expect["mode"] == "error":
                    expect_error(lambda: seconds_to_frames_v2(case["seconds"]))
                else:
                    self.assertEqual(seconds_to_frames_v2(case["seconds"]), expect["frames"], cid)
                ran += 1
            elif case["kind"] == "sentence_boundaries":
                for item in case["cases"]:
                    self.assertEqual(sentence_boundary_candidates_v2(item["text"]), item["boundaries"], f"{cid}:{item['text']}")
                ran += 1
            elif case["kind"] == "canonical_json":
                for item in case["cases"]:
                    if item.get("error"):
                        with self.assertRaises(ValueError, msg=cid):
                            canonical_json_v2(item["value"])
                    else:
                        self.assertEqual(canonical_json_v2(item["value"]), item["canonical"], f"{cid}: canonical 字节")
                ran += 1
            elif case["kind"] == "full_plan":
                build_input = copy.deepcopy(case["build_input"])
                if "mutate_input" in case:
                    _apply_mutation(build_input, case["mutate_input"])

                def run_full_plan():
                    plan = build_narration_plan_v2(build_input)
                    if expect["mode"] != "ok":
                        if "mutate_plan" in case:
                            _apply_mutation(plan, case["mutate_plan"])
                        return validate_narration_plan_v2(plan, build_input)
                    from video_factory.narration_plan import narration_plan_version, build_narration_plan
                    self.assertEqual(narration_plan_version(plan), "video-factory/narration-plan-v2", cid)
                    self.assertEqual(narration_plan_version(build_narration_plan(
                        [{"position": 1, "duration": 2, "narration": "甲。"}],
                        script_sha256="a" * 64, visual_sha256="b" * 64)), "video-factory/narration-plan-v1", cid)
                    with self.assertRaises(ValueError):
                        narration_plan_version({"version": "video-factory/narration-plan-v3"})
                    self.assertEqual(plan["version"], expect["version"], cid)
                    self.assertEqual(plan["mode"], "continuous_groups", cid)
                    self.assertEqual(plan["edgeTrim"], "none", cid)
                    self.assertEqual(plan["subtitleMode"], "provider_sentence", cid)
                    self.assertEqual(plan["script"], {"sha256": build_input["scriptSha256"]}, cid)
                    self.assertEqual(plan["visualPlan"], {
                        "sha256": build_input["visualSha256"], "fps": 30,
                        "totalFrames": expect["total_frames"]}, cid)
                    self.assertEqual(plan["source"]["normalization"], "narration-text-v1", cid)
                    self.assertEqual(plan["source"]["sourceContextId"], build_input["sourceContextId"], cid)
                    self.assertEqual(plan["source"]["canonicalSourceSha256"], expect["canonical_source_sha256"], cid)
                    self.assertEqual(plan["groups"], expect["groups"], cid)
                    self.assertEqual(plan["silences"], expect["silences"], cid)
                    self.assertEqual(validate_narration_plan_v2(plan, build_input), plan, cid)
                    return plan

                if expect["mode"] == "ok":
                    run_full_plan()
                else:
                    expect_error(run_full_plan)
                ran += 1
            elif case["kind"] == "user_silences":
                legacy = [{"startFrame": s["start"], "endFrame": s["end"]} for s in case["legacy_silences"]]
                expect_error(lambda: user_silences_v2(case["total_frames"], legacy, case["silences"]))
                ran += 1
        self.assertGreaterEqual(ran, 14, f"共享用例实际执行数不足：{ran}")

    def test_rules_fixture_matches_frozen_constants(self):
        import json
        from video_factory import narration_text_rules as rules
        fixture = self._load("narration-text-rules-v1.json")
        self.assertEqual(rules.NARRATION_TEXT_RULE_NAME, fixture["rule_name"])
        self.assertEqual(rules.NARRATION_TEXT_TRIM_CODEPOINTS, [int(c, 16) for c in fixture["trim_codepoints"]])
        self.assertEqual([list(i) for i in rules.NARRATION_WORD_INTERVALS], fixture["word_intervals"])

    def test_sentence_boundary_candidates_and_dedupe(self):
        from video_factory.narration_plan import sentence_boundary_candidates_v2
        text = "甲。 乙。 3.14 是数。"
        candidates = sentence_boundary_candidates_v2(text)
        self.assertEqual(candidates, sorted(set(candidates)))
        self.assertEqual(candidates, [3, 6], "拼接空格归左段，边界在空格后")
        self.assertNotIn(len(text), candidates, "末尾候选按合同剔除")

    def test_seconds_rejects_bad_input(self):
        from video_factory.narration_plan import seconds_to_frames_v2
        for bad in ("-1", "1.2345671", "1e3", "abc", None, True, False, 2, -1, 15, 1.5):
            with self.assertRaises(ValueError):
                seconds_to_frames_v2(bad)
        self.assertEqual(seconds_to_frames_v2("2"), 60)
        self.assertEqual(seconds_to_frames_v2("0.050000"), 2)

    def test_bool_masquerade_rejected_at_both_v2_entries(self):
        """§4.2.1：bool 冒充整数必须在整体 validator 与 standalone 两个实际入口都被拒绝。

        Python 的 `!=`/`==` 会把 True==1、False==0 判等，逐字段对照不能只依赖比较；
        红例即本测试当前在这些入口实际接受变异计划。
        """
        from video_factory.narration_plan import (
            build_narration_plan_v2,
            validate_narration_plan_v2,
            validate_narration_plan_v2_standalone,
        )
        cases = self._load("narration-plan-v2-cases.json")["cases"]
        masquerades = [case for case in cases if case.get("bool_masquerade")]
        self.assertGreaterEqual(len(masquerades), 5, "共享 fixture 必须保留 bool 冒充整数的反例组")
        for case in masquerades:
            cid = case["case_id"]
            build_input = case["build_input"]
            plan = build_narration_plan_v2(build_input)
            _apply_mutation(plan, case["mutate_plan"])
            for entry_name, entry in (
                ("overall", lambda: validate_narration_plan_v2(plan, build_input)),
                ("standalone", lambda: validate_narration_plan_v2_standalone(
                    plan, build_input["scenes"], script_sha256=build_input["scriptSha256"],
                    visual_sha256=build_input["visualSha256"],
                    source_context_id=build_input["sourceContextId"])),
            ):
                with self.subTest(case=cid, entry=entry_name):
                    try:
                        entry()
                    except ValueError as error:
                        self.assertIn("整数", str(error), f"{cid}/{entry_name}: 拒绝理由必须是整数语义：{error}")
                    else:
                        self.fail(f"{cid}/{entry_name}: bool 冒充整数被接受（行为红例未转绿）")
