"""旧逐镜配音的时间调整必须复用已结清原声，不伪造新 TTS 或句级字幕。"""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_continuous_voiceover import tone
from test_continuous_voice_worker import voice_request
from video_factory.worker import handle_request
from video_factory.legacy_narration_relayout import perform_legacy_relayout


class LegacyNarrationRelayoutTest(unittest.TestCase):
    def test_unknown_changed_or_foreign_sources_are_rejected_without_synthesis(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request = voice_request(root, "legacy-negative")
            request["input"].pop("narrationPlanPath")
            def synthesize(request, output_path):
                tone(output_path, 0.5)
                return output_path
            with patch("video_factory.voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = handle_request(request)
            self.assertEqual(first["status"], "succeeded", first)
            plan_path = Path(first["output"]["voiceoverPlanPath"])
            track_path = Path(first["output"]["trackPath"])
            ledger_path = root / "voice" / ".voice-operations" / (hashlib.sha256(b"legacy-negative").hexdigest() + ".json")
            ledger_bytes = ledger_path.read_bytes()
            ledger = json.loads(ledger_bytes)
            raw_path = Path(ledger["items"][0]["localPath"])
            raw_bytes = raw_path.read_bytes()
            source = {"voicePlanPath": str(plan_path), "voicePlanSha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
                      "trackSha256": hashlib.sha256(track_path.read_bytes()).hexdigest(), "ledgerPath": str(ledger_path)}
            scenes = json.loads(Path(request["input"]["scriptPath"]).read_bytes())["scenes"]
            for failure in ("unknown", "raw_changed", "foreign_raw", "fingerprint", "source_text"):
                with self.subTest(failure=failure):
                    changed = json.loads(ledger_bytes)
                    current_scenes = json.loads(json.dumps(scenes))
                    if failure == "unknown":
                        changed["completed"] = False
                        changed["items"][0]["state"] = "unknown"
                    elif failure == "raw_changed":
                        raw_path.write_bytes(b"changed")
                    elif failure == "foreign_raw":
                        outside = root / "outside.mp3"
                        outside.write_bytes(raw_bytes)
                        changed["items"][0]["localPath"] = str(outside)
                    elif failure == "fingerprint":
                        changed["items"][0]["inputFingerprint"] = "e" * 64
                    else:
                        current_scenes[0]["narration"] = "别的内容。"
                    ledger_path.write_text(json.dumps(changed))
                    bound_source = {**source, "ledgerSha256": hashlib.sha256(ledger_path.read_bytes()).hexdigest()}
                    with patch("video_factory.voiceover._execute_minimax_audio_request") as paid, \
                            self.assertRaises(ValueError):
                        perform_legacy_relayout(source=bound_source, layout={}, scenes=current_scenes,
                            script_sha256=hashlib.sha256(Path(request["input"]["scriptPath"]).read_bytes()).hexdigest(),
                            visual_sha256=hashlib.sha256(Path(request["input"]["executablePlanPath"]).read_bytes()).hexdigest(),
                            node_root=root / "voice", output_dir=root / "voice" / "rejected",
                            source_operation_id="legacy-negative", layout_operation_id="rejected")
                    paid.assert_not_called()
                    self.assertFalse((root / "voice" / "rejected").exists())
                    ledger_path.write_bytes(ledger_bytes)
                    raw_path.write_bytes(raw_bytes)

    def test_unplanned_voice_can_move_then_move_back_without_synthesis_or_original_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = voice_request(root, "legacy-original")
            original["input"].pop("narrationPlanPath")
            def synthesize(request, output_path):
                tone(output_path, 0.5)
                return output_path
            with patch("video_factory.voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = handle_request(original)
            self.assertEqual(first["status"], "succeeded", first)
            self.assertEqual(provider.call_count, 3)
            plan_path = Path(first["output"]["voiceoverPlanPath"])
            track_path = Path(first["output"]["trackPath"])
            ledger_path = root / "voice" / ".voice-operations" / (hashlib.sha256(b"legacy-original").hexdigest() + ".json")
            snapshot = {p: p.read_bytes() for p in (plan_path, track_path, ledger_path)}
            source = {"voicePlanPath": str(plan_path), "voicePlanSha256": hashlib.sha256(snapshot[plan_path]).hexdigest(),
                      "trackSha256": hashlib.sha256(snapshot[track_path]).hexdigest(),
                      "ledgerPath": str(ledger_path), "ledgerSha256": hashlib.sha256(snapshot[ledger_path]).hexdigest(),
                      "origin": {"sourceVoiceOperationId": "legacy-original"}}
            previous = None
            for attempt, offset in ((2, 45), (3, 0)):
                command = f"legacy-layout-{attempt}"
                groups = [{"groupId": f"legacy-scene-{i+1}", "window": {"startFrame": s, "endFrame": e},
                           "placement": {"anchor": "start", "offsetFrames": offset if i == 0 else 0}}
                          for i, (s, e) in enumerate(((0, 180), (180, 360), (360, 600)))]
                request = {**original, "commandId": command, "attempt": attempt, "outputDir": str(root / "voice" / f"attempt-{attempt}"),
                    "input": {"relayout": True, "legacyVoiceSource": {**source, **({"currentPlan": previous["narrationPlan"]} if previous else {})},
                        "sourceOperationId": "legacy-original", "relayoutSource": "legacy_voice_version", "sourceIdentity": {},
                        "sourceLegacyIdentity": {"sha256": source["voicePlanSha256"], "ledgerSha256": source["ledgerSha256"]},
                        "scriptPath": original["input"]["scriptPath"], "executablePlanPath": original["input"]["executablePlanPath"],
                        "layout": {"narrationPlanVersion": "video-factory/narration-plan-v1", "groups": groups, "userSilences": []},
                        "relayoutReservation": {"requestDigest": "d"*64, "commandId": command, "layoutOperationId": f"relayout-{command}",
                            "reservedInputVersionId": f"input-{attempt}", "reservedOutputVersionId": f"output-{attempt}",
                            "workerExecutionToken": f"token-{attempt}", "attempt": attempt}},
                    "parameters": {"maxCostCny": 0, "maxAttempts": 0}}
                with patch("video_factory.voiceover._execute_minimax_audio_request") as paid, \
                        patch("video_factory.group_voiceover._execute_minimax_audio_request") as grouped:
                    result = handle_request(request)
                paid.assert_not_called()
                grouped.assert_not_called()
                self.assertEqual(result["status"], "succeeded", result)
                previous = json.loads(Path(result["output"]["voiceoverPlanPath"]).read_text())
                self.assertEqual(previous["groups"][0]["startSample"], offset * 1470)
                self.assertEqual(previous["version"], "video-factory/voiceover-plan-v2", "保留旧逐镜字幕语义，不冒充供应商同步字幕")
                self.assertEqual(result["output"]["externalSendCount"], 0)
                self.assertEqual({p: p.read_bytes() for p in snapshot}, snapshot)
