import copy
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
