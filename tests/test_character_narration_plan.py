import copy
import hashlib
import json
import unittest
from pathlib import Path
from video_factory.character_narration_plan import (
    allocate_character_turn_frames, build_character_narration_plan,
    validate_character_narration_plan, character_candidate_from_plan,
)
from video_factory.narration_relayout import parse_relayout_layout
from video_factory.narration_plan import canonical_json_v2

ROOT = Path(__file__).parent / "fixtures"
SCRIPT = json.loads((ROOT / "character-drama-cases.json").read_text())["script"]
CASES = json.loads((ROOT / "character-narration-cases.json").read_text())

def context():
    return {"script": copy.deepcopy(SCRIPT), "scriptSha256": "a" * 64,
            "visualSha256": "b" * 64, "sourceContextId": "ctx-four-characters"}

class CharacterNarrationPlanTests(unittest.TestCase):
    def test_time_only_layout_rejects_hidden_content_at_every_level(self):
        plan = build_character_narration_plan(context())
        layout = {"narrationPlanVersion": plan["version"], "groups": [
            {"groupId": g["id"], "window": g["window"], "placement": g["placement"]} for g in plan["groups"]],
            "userSilences": []}
        self.assertEqual(len(parse_relayout_layout(layout, plan)["groups"]), 8)
        for field in ("root", "group", "window", "placement", "silence"):
            changed = copy.deepcopy(layout)
            target = changed if field == "root" else changed["groups"][0] if field == "group" else changed["groups"][0].get(field)
            if field == "silence":
                target = {"startFrame": 0, "endFrame": 1}
                changed["userSilences"] = [target]
            target["text"] = "not allowed"
            with self.subTest(field=field), self.assertRaises(ValueError):
                parse_relayout_layout(changed, plan)

    def test_shared_frame_allocations(self):
        for case in CASES["allocations"]:
            with self.subTest(case=case["name"]):
                self.assertEqual(allocate_character_turn_frames(case["frames"], case["turns"]), case["expected"])

    def test_plan_identity_and_edit_validation(self):
        source = context()
        plan = build_character_narration_plan(source)
        self.assertEqual(plan["source"]["canonicalSourceSha256"], CASES["canonicalSourceSha256"])
        self.assertEqual(hashlib.sha256(canonical_json_v2(plan).encode()).hexdigest(), CASES["planSha256"])
        self.assertEqual(plan["version"], "video-factory/narration-plan-v3")
        self.assertEqual(len(plan["groups"]), 8)
        self.assertEqual(plan["visualPlan"]["totalFrames"], 720)
        self.assertEqual(validate_character_narration_plan(plan, source), plan)
        edited = copy.deepcopy(plan)
        edited["groups"][0]["voiceProfileId"] = "minimax:female-tianmei"
        with self.assertRaises(ValueError):
            validate_character_narration_plan(edited, source)
        candidate = character_candidate_from_plan(plan)
        candidate["groups"][0]["window"]["endFrame"] -= 5
        self.assertEqual(build_character_narration_plan(source, candidate)["groups"][0]["window"]["endFrame"], plan["groups"][0]["window"]["endFrame"] - 5)

    def test_silent_film_needs_no_voice(self):
        source = context()
        for scene in source["script"]["scenes"]:
            scene["dialogue"] = []
        for character in source["script"]["characters"]:
            character["voice_profile_id"] = None
        plan = build_character_narration_plan(source)
        self.assertEqual(plan["groups"], [])
        self.assertEqual(len(plan["silences"]), 4)
