import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.character_narration_plan import build_character_narration_plan
from video_factory.group_voiceover import forecast_minimax_groups, synthesize_minimax_groups
from video_factory.voiceover import _MiniMaxTerminalError
from test_continuous_voiceover import tone

SCRIPT = json.loads((Path(__file__).parent / "fixtures/character-drama-cases.json").read_text())["script"]


def plan_for(script):
    return build_character_narration_plan({"script": script, "scriptSha256": hashlib.sha256(json.dumps(script).encode()).hexdigest(),
        "visualSha256": "b" * 64, "sourceContextId": "character-voice-test"})


def materialize(audio, metadata_path, response_binding):
    tone(audio, 0.35)
    metadata_path.write_text(json.dumps({"request": response_binding,
        "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size,
        "extra_info": {"usage_characters": 10}}))


class CharacterVoiceoverTests(unittest.TestCase):
    def test_each_turn_uses_its_voice_and_reuses_only_equal_payloads(self):
        script = copy.deepcopy(SCRIPT)
        # 同文异人仍是不同声音，名字与动作不进入朗读正文。
        script["scenes"][0]["dialogue"][1]["text"] = script["scenes"][0]["dialogue"][0]["text"]
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                materialize(audio, metadata_path, response_binding)
            def run(operation):
                return synthesize_minimax_groups(plan_for(script), root / operation, operation_id=operation,
                    voice="female-tianmei", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = run("first")
                plan = plan_for(script)
                self.assertEqual([c["voice_setting"]["voice_id"] for c in calls],
                    [g["voiceProfileId"].removeprefix("minimax:") for g in plan["groups"]])
                # 沿用旧 pauseScale 的标点换行；不添加角色标签或表演指令。
                self.assertEqual([c["text"].strip() for c in calls], [g["text"] for g in plan["groups"]])
                ledger = json.loads(Path(first["ledgerPath"]).read_text())
                self.assertNotEqual(ledger["items"][0]["synthesisKey"], ledger["items"][1]["synthesisKey"])
                for item, group in zip(ledger["items"], plan["groups"]):
                    for key in ("turnId", "speakerId", "voiceProfileId"):
                        self.assertEqual(item[key], group[key])
                script["characters"][0]["name"] = "店长改名"
                renamed = run("renamed")
                self.assertEqual(first["rawAudio"], renamed["rawAudio"])
                self.assertEqual(len(calls), 8)
                script["scenes"][2]["dialogue"][0]["text"] = "原来在这里，谢谢你。"
                quote = forecast_minimax_groups(plan_for(script), root, voice="female-tianmei", rate=190,
                    pause_scale=1, model_id="speech-2.8-turbo")
                self.assertEqual([i["reused"] for i in quote["items"]], [True, True, True, True, False, True, True, True])
                self.assertEqual(len(calls), 8, "预览不能发送")
                run("one-line-change")
                self.assertEqual(len(calls), 9)

    def test_third_unknown_recovers_original_response_without_resending_completed_turns(self):
        plan = plan_for(copy.deepcopy(SCRIPT))
        calls, pending = [], []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                if len(calls) == 3:
                    pending.append((audio, metadata_path, response_binding))
                    raise TimeoutError("accepted-without-response")
                materialize(audio, metadata_path, response_binding)
            def run(operation, budget=1):
                return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                    voice="female-tianmei", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=budget)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with self.assertRaisesRegex(RuntimeError, "authorized amount"):
                    run("no-budget", 0)
                self.assertEqual(calls, [])
                with self.assertRaises(TimeoutError):
                    run("original")
                ledger_path = next((root / ".voice-operations").glob("*.json"))
                saved = json.loads(ledger_path.read_text())
                self.assertEqual([i["state"] for i in saved["items"]][:3], ["materialized", "materialized", "unknown"])
                for operation in ("original", "different-id"):
                    with self.assertRaisesRegex(RuntimeError, "unsettled"):
                        run(operation)
                self.assertEqual(len(calls), 3)
                materialize(*pending[0])
                recovered = run("original")
                self.assertEqual(len(calls), 8, "只发送尚未受理的后五句")
                self.assertEqual(len(recovered["rawAudio"]), 8)
                self.assertEqual(saved["items"][:2], json.loads(ledger_path.read_text())["items"][:2])

    def test_explicit_new_operation_can_retry_terminal_failure_but_preserves_completed_audio(self):
        plan = plan_for(copy.deepcopy(SCRIPT))
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                if len(calls) == 3:
                    raise _MiniMaxTerminalError("definitively rejected")
                materialize(audio, metadata_path, response_binding)
            def run(operation):
                return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                    voice="female-tianmei", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with self.assertRaises(_MiniMaxTerminalError):
                    run("original")
                with self.assertRaisesRegex(RuntimeError, "unsettled or failed"):
                    run("original")
                self.assertEqual(len(calls), 3)
                retried = run("user-confirmed-retry")
                self.assertEqual(len(calls), 9)
                self.assertEqual(len(retried["rawAudio"]), 8)
                ledger = json.loads(Path(retried["ledgerPath"]).read_text())
                self.assertTrue(all(i.get("reusedFromOperationId") == "original" for i in ledger["items"][:2]))

    def test_silent_character_film_requires_no_selected_voice_or_provider_send(self):
        script = copy.deepcopy(SCRIPT)
        for scene in script["scenes"]:
            scene["dialogue"] = []
        for character in script["characters"]:
            character["voice_profile_id"] = None
        with tempfile.TemporaryDirectory() as temporary, \
                patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
            result = synthesize_minimax_groups(plan_for(script), Path(temporary) / "voice" / "silent", operation_id="silent",
                voice="", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=0)
            provider.assert_not_called()
            self.assertEqual(result["rawAudio"], {})
            self.assertTrue(json.loads(Path(result["ledgerPath"]).read_text())["completed"])
