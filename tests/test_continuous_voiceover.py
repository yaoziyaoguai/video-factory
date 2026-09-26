import hashlib
import io
import json
import math
import tempfile
import unittest
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

from video_factory.continuous_voiceover import NarrationGroupDoesNotFitError, assemble_narration_track
from video_factory.narration_plan import build_narration_plan, SAMPLE_RATE
from video_factory.group_voiceover import synthesize_minimax_groups
from video_factory.narration_subtitles import capture_subtitle_evidence
import video_factory.group_voiceover as group_voiceover_module


def tone(path: Path, seconds: float) -> None:
    samples = array("h", (round(6000 * math.sin(2 * math.pi * 440 * index / SAMPLE_RATE))
                         for index in range(round(seconds * SAMPLE_RATE))))
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(samples.tobytes())


class ContinuousVoiceoverTest(unittest.TestCase):
    def test_reusing_reused_audio_keeps_original_subtitle_response_binding(self):
        plan = build_narration_plan([{"position": 1, "duration": 3, "narration": "让声音连起来。"}],
                                    script_sha256="a" * 64, visual_sha256="b" * 64)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            # 第二份复用账本排在原账本之前，第三次必须正确处理 A→B→C 来源链。
            operations = sorted(["original", "reuse-one", "reuse-two"], key=lambda value: hashlib.sha256(value.encode()).hexdigest())
            def synthesize(request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size,
                    "subtitle_file": "https://public.example/subtitles.json"}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(b'{"unverified_vendor_shape":[]}')) as download, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                results = []
                for operation in (operations[2], operations[0], operations[1]):
                    response = synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                        voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=0.5)
                    results.append(capture_subtitle_evidence(Path(response["ledgerPath"]), root))
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(download.call_count, 1)
                self.assertEqual([result["evidence"][0]["status"] for result in results], ["captured_unverified"] * 3)

    def test_unresolved_group_and_budget_limit_never_trigger_another_request(self):
        scenes = [{"position": 1, "duration": 3, "narration": "先停一下。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def run(operation, budget=0.5):
                return synthesize_minimax_groups(plan, root / "voice" / operation, operation_id=operation,
                                                  voice="female-chengshu", rate=190, pause_scale=1,
                                                  model_id="speech-2.8-turbo", authorization_cny=budget)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=TimeoutError) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with self.assertRaisesRegex(RuntimeError, "authorized amount"):
                    run("no-budget", 0)
                provider.assert_not_called()
                with self.assertRaises(TimeoutError):
                    run("original")
                with self.assertRaisesRegex(RuntimeError, "unsettled"):
                    run("original")
                with self.assertRaisesRegex(RuntimeError, "unsettled"):
                    run("different-id")
                self.assertEqual(provider.call_count, 1)

    def test_local_ledger_failure_after_response_recovers_audio_without_rebuying(self):
        scenes = [{"position": 1, "duration": 3, "narration": "原声音必须保留。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def run():
                return synthesize_minimax_groups(plan, root / "voice" / "first", operation_id="first",
                                                  voice="female-chengshu", rate=190, pause_scale=1,
                                                  model_id="speech-2.8-turbo", authorization_cny=0.5)
            def synthesize(request, output_path, metadata_path=None, response_binding=None):
                tone(output_path, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                    "audio_size_bytes": output_path.stat().st_size, "extra_info": {"usage_characters": 16}}))
                return output_path
            real_write = group_voiceover_module._write_json_durably
            def disk_failure(path, value):
                if value.get("completed"):
                    raise OSError("simulated final journal fsync failure")
                real_write(path, value)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with patch("video_factory.group_voiceover._write_json_durably", side_effect=disk_failure), self.assertRaises(OSError):
                    run()
                recovered = run()
                self.assertEqual(provider.call_count, 1)
                self.assertTrue(recovered["rawAudio"]["narration-1"].is_file())

    def test_group_synthesis_reuses_unchanged_audio_after_a_local_text_or_layout_change(self):
        scenes = [{"position": 1, "duration": 3, "narration": "先停一下。"},
                  {"position": 2, "duration": 1, "narration": "……"},
                  {"position": 3, "duration": 3, "narration": "再走一步。"}]
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def synthesize(request, output_path, metadata_path=None, response_binding=None):
                payload = json.loads(request.data)
                calls.append(payload)
                tone(output_path, 0.5)
                if metadata_path:
                    metadata_path.write_text(json.dumps({"request": response_binding,
                        "audio_sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
                        "audio_size_bytes": output_path.stat().st_size, "extra_info": {"usage_characters": 12}}))
                return output_path
            def run(operation, script_hash, visual_hash):
                plan = build_narration_plan(scenes, script_sha256=script_hash * 64, visual_sha256=visual_hash * 64)
                return synthesize_minimax_groups(plan, root / "voice" / operation, operation_id=operation,
                                                  voice="female-chengshu", rate=190, pause_scale=1,
                                                  model_id="speech-2.8-turbo", authorization_cny=0.5)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = run("first", "a", "b")
                self.assertEqual(len(calls), 2)
                scenes[2]["narration"] = "慢一点，也能到达。"
                quoted_plan = build_narration_plan(scenes, script_sha256="c" * 64, visual_sha256="b" * 64)
                before_quote = {item.name: item.read_bytes() for item in (root / "voice" / ".voice-operations").glob("*.json")}
                quote = group_voiceover_module.forecast_minimax_groups(quoted_plan, root / "voice",
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                self.assertEqual([item["reused"] for item in quote["items"]], [True, False])
                self.assertEqual(quote["estimatedCostCny"], quote["items"][1]["maxCostCny"])
                self.assertEqual(len(calls), 2, "报价不能合成")
                self.assertEqual(before_quote, {item.name: item.read_bytes() for item in (root / "voice" / ".voice-operations").glob("*.json")})
                second = run("changed-text", "c", "b")
                self.assertEqual(len(calls), 3, "只修改第二组，不应重新购买第一组")
                self.assertEqual(first["rawAudio"]["narration-1"], second["rawAudio"]["narration-1"])
                scenes[2]["duration"] = 4
                third = run("changed-layout", "c", "d")
                self.assertEqual(len(calls), 3, "改变画面时间不能使合成缓存失效")
                self.assertEqual(second["rawAudio"], third["rawAudio"])
            self.assertTrue(all(call["subtitle_enable"] and call["subtitle_type"] == "sentence" for call in calls))
            ledger = json.loads(Path(second["ledgerPath"]).read_text())
            self.assertEqual(ledger["version"], "video-factory/voice-operation-v3")
            self.assertNotIn("scenePosition", ledger["items"][0], "组级费用不能伪装成逐镜费用")
            self.assertEqual(ledger["items"][0]["reusedFromOperationId"], "first")
            self.assertEqual(ledger["items"][0]["actualCostCny"], 0)
            self.assertEqual(ledger["actualCostCny"], ledger["items"][1]["actualCostCny"])

    def test_one_continuous_source_crosses_visual_cuts_without_inserted_silence(self):
        scenes = [{"position": index + 1, "duration": duration, "narration": text}
                  for index, (duration, text) in enumerate(zip([6, 6, 8], ["先看见，", "再停下，", "然后出发。"] ))]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "continuous.wav"
            tone(raw, 17)
            result = assemble_narration_track(plan, {plan["groups"][0]["id"]: raw}, root / "assembled")
            with wave.open(result["pcm_path"], "rb") as audio:
                self.assertEqual(audio.getnframes(), 20 * SAMPLE_RATE)
                samples = array("h", audio.readframes(audio.getnframes()))
            for cut in (6, 12):
                self.assertTrue(any(abs(sample) > 1000 for sample in samples[
                    cut * SAMPLE_RATE - 100: cut * SAMPLE_RATE + 100]))
            self.assertFalse(any(samples[17 * SAMPLE_RATE:]))
            self.assertEqual(result["groups"][0]["sourceAudioSamples"], 17 * SAMPLE_RATE)
            self.assertEqual(result["groups"][0]["unfilledWindowSamples"], 3 * SAMPLE_RATE)
            self.assertEqual(result["duration"], 20)

    def test_silence_and_end_anchor_remain_exact_and_extra_blank_time_is_reported(self):
        scenes = [{"position": 1, "duration": 10, "narration": "停一下。"},
                  {"position": 2, "duration": 4, "narration": "……"},
                  {"position": 3, "duration": 6, "narration": "再出发。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        plan["groups"][1]["placement"]["anchor"] = "end"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first, second = root / "first.wav", root / "second.wav"
            tone(first, 2)
            tone(second, 3)
            result = assemble_narration_track(plan, {plan["groups"][0]["id"]: first,
                                                     plan["groups"][1]["id"]: second}, root / "assembled")
            with wave.open(result["pcm_path"], "rb") as audio:
                samples = array("h", audio.readframes(audio.getnframes()))
            self.assertFalse(any(samples[10 * SAMPLE_RATE:14 * SAMPLE_RATE]))
            self.assertEqual(result["groups"][1]["startSample"], 17 * SAMPLE_RATE)
            self.assertEqual([group["unfilledWindowSamples"] for group in result["groups"]],
                             [8 * SAMPLE_RATE, 3 * SAMPLE_RATE])
            self.assertTrue(any(samples[-1000:]))

    def test_long_group_keeps_paid_raw_audio_and_reports_a_group_conflict_without_truncation(self):
        scenes = [{"position": 1, "duration": 1, "narration": "长声音不能被截断。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            raw = root / "already-paid.wav"
            tone(raw, 1.2)
            before = hashlib.sha256(raw.read_bytes()).hexdigest()
            with self.assertRaises(NarrationGroupDoesNotFitError) as caught:
                assemble_narration_track(plan, {plan["groups"][0]["id"]: raw}, root / "assembled")
            self.assertEqual(caught.exception.group_id, plan["groups"][0]["id"])
            self.assertEqual(caught.exception.required_frames, 36)
            self.assertEqual(caught.exception.source_scene_positions, [1])
            self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(), before)
            self.assertFalse((root / "assembled" / "narration.m4a").exists())
