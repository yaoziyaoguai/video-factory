import json
import copy
import unittest
from pathlib import Path

from video_factory.character_script import validate_character_script

FIXTURE = json.loads((Path(__file__).parent / "fixtures/character-drama-cases.json").read_text(encoding="utf-8"))

class CharacterScriptTest(unittest.TestCase):
    def test_shared_invalid_cases(self):
        for case in FIXTURE["invalid"]:
            with self.subTest(case=case["name"]):
                script = copy.deepcopy(FIXTURE["script"])
                target = script
                for key in case["path"][:-1]:
                    target = target[key]
                target[case["path"][-1]] = case["value"]
                with self.assertRaises(ValueError):
                    validate_character_script(script, duration_seconds=24)

    def test_one_three_four_six_stable_characters(self):
        for count in (1, 3, 4, 6):
            script = copy.deepcopy(FIXTURE["script"])
            script["characters"] = [{**script["characters"][i % 4], "id": f"cast_{i}", "name": "可重复显示名"} for i in range(count)]
            for i, scene in enumerate(script["scenes"]):
                scene["character_ids"] = [f"cast_{i % count}"]
                for j, turn in enumerate(scene["dialogue"]):
                    turn["speaker_id"] = f"cast_{(i * 2 + j) % count}"
            self.assertEqual(validate_character_script(script, duration_seconds=24), script)

    def test_offscreen_narrator_null_voice_and_silence(self):
        script = copy.deepcopy(FIXTURE["script"])
        script["characters"][0].update(kind="narrator", appearance="", voice_profile_id=None)
        for scene in script["scenes"]:
            scene["character_ids"] = [item for item in scene["character_ids"] if item != "shopkeeper"]
        script["scenes"][1]["dialogue"] = []
        self.assertEqual(validate_character_script(script, duration_seconds=24), script)
        for scene in script["scenes"]:
            scene["dialogue"] = []
        self.assertEqual(validate_character_script(script, duration_seconds=24), script)

    def test_four_characters_round_trip_without_narration(self):
        script = validate_character_script(FIXTURE["script"], duration_seconds=24)
        self.assertEqual(script, FIXTURE["script"])
        self.assertTrue(all("narration" not in scene for scene in script["scenes"]))
        self.assertEqual(validate_character_script(json.loads(json.dumps(script)), duration_seconds=24), script)
