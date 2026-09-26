import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.narration_plan import build_narration_plan
from video_factory.worker import handle_request
import video_factory.worker as worker_module
from test_continuous_voiceover import tone


def voice_request(root: Path, operation: str = "group-operation") -> dict:
    scenes = [{"position": position, "duration": duration, "narration": text}
              for position, duration, text in ((1, 6, "先看见，"), (2, 6, "再停下，"), (3, 8, "然后出发。"))]
    script = root / "script.json"
    visual = root / "visual.json"
    script.write_text(json.dumps({"duration_target": 20, "scenes": scenes}, ensure_ascii=False))
    visual.write_text(json.dumps({"version": "video-factory/executable-plan-v1", "fps": 30,
        "totalFrames": 600, "durationRange": {"minSeconds": 20, "maxSeconds": 20},
        "cuts": [{"scenePosition": index + 1, "startFrame": start, "frameCount": count,
                  "sourceInFrame": 0, "assetKey": f"scene-{index + 1}"}
                 for index, (start, count) in enumerate(((0, 180), (180, 180), (360, 240)))]}))
    narration = root / "narration.json"
    narration.write_text(json.dumps(build_narration_plan(scenes,
        script_sha256=hashlib.sha256(script.read_bytes()).hexdigest(),
        visual_sha256=hashlib.sha256(visual.read_bytes()).hexdigest())))
    return {"protocolVersion": "video-factory/worker-v1", "commandId": operation,
            "runId": "test-run", "nodeRunId": "voice", "attempt": 1,
            "capability": "voice.synthesize", "outputDir": str(root / "voice" / operation),
            "input": {"scriptPath": str(script), "executablePlanPath": str(visual),
                      "narrationPlanPath": str(narration), "voice": "female-chengshu", "rate": 190,
                      "pause_scale": 1, "mastering_preset": "natural"},
            "parameters": {"provider": "minimax", "providerId": "minimax-tts-v1",
                           "modelId": "speech-2.8-turbo", "estimatedCostCny": 0.5, "maxCostCny": 0.5}}


class ContinuousVoiceWorkerTest(unittest.TestCase):
    def test_completed_audio_with_missing_cost_evidence_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size}))
            actual_synthesis = worker_module.synthesize_continuous_voice
            def lose_ledger(*args):
                result = actual_synthesis(*args)
                ledger = root / "voice" / ".voice-operations" / (hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
                ledger.unlink()
                return result
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.worker.synthesize_continuous_voice", side_effect=lose_ledger), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(response["status"], "failed", response)
                self.assertFalse(response["diagnostics"]["providerOutcomeKnown"])
                self.assertNotIn("actualCostCny", response["diagnostics"])
                self.assertEqual({item["kind"] for item in response["artifacts"]}, {"voiceover", "voiceover_plan"})
                self.assertTrue(all(Path(item["uri"]).is_file() for item in response["artifacts"]))

    def test_stale_source_or_unpriced_voice_is_rejected_before_any_paid_request(self):
        for changed in ("script", "visual", "voice", "budget"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = voice_request(root)
                if changed in ("script", "visual"):
                    target = root / f"{changed}.json"
                    target.write_text(target.read_text() + "\n")
                elif changed == "voice":
                    request["input"]["voice"] = "custom-cloned-voice"
                else:
                    request["parameters"]["maxCostCny"] = 0
                with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                    response = handle_request(request)
                self.assertEqual(response["status"], "failed")
                provider.assert_not_called()

    def test_group_overflow_reports_group_scope_and_reuses_paid_audio_when_observed_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 20.2)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(response["status"], "rejected", response)
                conflict = response["output"]["conflict"]
                self.assertEqual(conflict["groupId"], "narration-1")
                self.assertEqual(conflict["sourceScenePositions"], [1, 2, 3])
                self.assertEqual(conflict["requiredFrames"], 606)
                self.assertNotIn("scenePosition", conflict)
                self.assertTrue(Path(conflict["audioArtifact"]["uri"]).is_file())
                first_hash = conflict["audioArtifact"]["sha256"]
                second = handle_request({**request, "attempt": 2, "outputDir": str(root / "voice" / "recovery")})
                self.assertEqual(second["status"], "rejected", second)
                self.assertEqual(second["output"]["conflict"]["audioArtifact"]["sha256"], first_hash)
                self.assertTrue(Path(second["artifacts"][0]["uri"]).is_relative_to((root / "voice" / "recovery").resolve()))
                self.assertEqual(provider.call_count, 1)

    def test_worker_consumes_confirmed_plan_once_and_retains_visual_index_without_fake_scene_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 17)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size, "extra_info": {"usage_characters": 20}}))
                return audio
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.voiceover._execute_minimax_audio_request", side_effect=AssertionError("must not use per-scene TTS")), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(response["status"], "succeeded", response)
                self.assertEqual(provider.call_count, 1)
                restored = handle_request({**request, "attempt": 2, "outputDir": str(root / "voice" / "recovery")})
                self.assertEqual(restored["status"], "succeeded", restored)
                self.assertEqual(provider.call_count, 1)
            plan = json.loads(Path(response["output"]["voiceoverPlanPath"]).read_text())
            self.assertEqual(plan["version"], "video-factory/voiceover-plan-v3")
            self.assertEqual([scene["duration"] for scene in plan["scenes"]], [6, 6, 8])
            self.assertTrue(all("speech_duration" not in scene and "audio_path" not in scene for scene in plan["scenes"]))
            self.assertEqual(plan["subtitles"]["status"], "unavailable")
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 1)
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0.01)


if __name__ == "__main__":
    unittest.main()
