import json
import hashlib
import io
import os
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import video_factory.voiceover as voiceover_module
from video_factory.voiceover import VoiceDoesNotFitError, synthesize_minimax_audio, synthesize_voiceover_plan


class _Response:
    def __init__(self, payload: dict):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class MiniMaxVoiceoverTest(unittest.TestCase):
    def test_natural_voice_reports_a_timing_conflict_without_speeding_or_truncating_raw_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "自然语速和必要停顿必须完整保留。",
                "duration": 8,
            }]}), encoding="utf-8")
            output_dir = root / "voice"
            raw_path = output_dir / "scene_01_raw.mp3"

            def synthesize_raw(**_kwargs):
                output_dir.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(b"materialized-natural-voice")
                return raw_path

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.synthesize_raw_audio", side_effect=synthesize_raw
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=8.2), patch(
                "video_factory.voiceover.subprocess.run"
            ) as ffmpeg:
                with self.assertRaises(RuntimeError) as caught:
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=output_dir,
                        provider="minimax",
                    )

            conflict = caught.exception
            self.assertEqual(getattr(conflict, "code", None), "VOICE_DOES_NOT_FIT")
            self.assertEqual(getattr(conflict, "scene_position", None), 1)
            self.assertEqual(getattr(conflict, "speech_seconds", None), 8.2)
            self.assertEqual(getattr(conflict, "required_seconds", None), 8.2)
            self.assertEqual(getattr(conflict, "raw_audio_path", None), raw_path.resolve())
            self.assertEqual(raw_path.read_bytes(), b"materialized-natural-voice")
            ffmpeg.assert_not_called()

    def test_natural_voice_that_fits_the_cut_is_padded_only_for_the_remaining_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "自然配音保留原速，并补齐镜头剩余时间。",
                "duration": 8,
            }]}), encoding="utf-8")
            output_dir = root / "voice"
            raw_path = output_dir / "scene_01_raw.mp3"

            def synthesize_raw(**_kwargs):
                output_dir.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(b"natural-voice-with-room")
                return raw_path

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.synthesize_raw_audio", side_effect=synthesize_raw
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=7.9), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ) as ffmpeg_run:
                plan_path = synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=output_dir,
                    provider="minimax",
                )

            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            normalize_command = ffmpeg_run.call_args_list[0].args[0]
            self.assertEqual(plan["scenes"][0]["source_speech_duration"], 7.9)
            self.assertEqual(plan["scenes"][0]["duration"], 8)
            self.assertEqual(plan["scenes"][0]["tempo"], 1.0)
            command_text = " ".join(normalize_command)
            self.assertIn("apad=pad_dur=8.000", command_text)
            self.assertNotIn("atempo", command_text)

    def test_timing_conflict_rounds_up_to_a_safe_30fps_cut_that_recovers_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            scene = {
                "position": 1,
                "narration": "边界外的自然配音必须扩到下一完整帧。",
                "duration": 8.2,
            }
            script_path.write_text(json.dumps({"scenes": [scene]}), encoding="utf-8")
            output_dir = root / "voice"
            raw_path = output_dir / "scene_01_raw.mp3"

            def synthesize_raw(**_kwargs):
                output_dir.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(b"frame-boundary-voice")
                return raw_path

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.synthesize_raw_audio", side_effect=synthesize_raw
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=8.20049), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ):
                with self.assertRaises(VoiceDoesNotFitError) as caught:
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=output_dir,
                        provider="minimax",
                    )

                conflict = caught.exception
                self.assertEqual(round(conflict.required_seconds * 30), 247)
                self.assertGreaterEqual(conflict.required_seconds, 8.20049)
                script_path.write_text(json.dumps({
                    "scenes": [{**scene, "duration": conflict.required_seconds}],
                }), encoding="utf-8")
                plan_path = synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=output_dir,
                    provider="minimax",
                )

            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            self.assertEqual(round(plan["scenes"][0]["duration"] * 30), 247)

    def test_writes_hex_audio_from_the_minimax_speech_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "voice.mp3"
            captured = {}

            def urlopen(request, timeout):
                captured["authorization"] = request.headers["Authorization"]
                captured["payload"] = json.loads(request.data.decode("utf-8"))
                captured["timeout"] = timeout
                return _Response({
                    "data": {"audio": b"ID3-test-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            with patch("video_factory.voiceover.urlopen", side_effect=urlopen):
                result = synthesize_minimax_audio(
                    text="先看证据，再谈结论。",
                    output_path=output_path,
                    voice="Chinese (Mandarin)_News_Anchor",
                    rate=190,
                    pause_scale=1.8,
                    api_key="test-key",
                    model="speech-2.8-turbo",
                    base_url="https://api.example/v1",
                )

            self.assertEqual(result, output_path)
            self.assertEqual(output_path.read_bytes(), b"ID3-test-audio")
            self.assertEqual(captured["authorization"], "Bearer test-key")
            self.assertEqual(captured["payload"]["voice_setting"]["voice_id"], "Chinese (Mandarin)_News_Anchor")
            self.assertEqual(captured["payload"]["audio_setting"]["format"], "mp3")
            self.assertIn("\n\n", captured["payload"]["text"])
            self.assertNotIn("test-key", json.dumps(captured["payload"]))

    def test_rejects_a_failed_minimax_response_without_writing_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "voice.mp3"
            with patch("video_factory.voiceover.urlopen", return_value=_Response({
                "data": {},
                "base_resp": {"status_code": 1004, "status_msg": "invalid request"},
            })):
                with self.assertRaisesRegex(RuntimeError, "MiniMax speech synthesis failed"):
                    synthesize_minimax_audio(
                        text="测试",
                        output_path=output_path,
                        voice="female-chengshu",
                        rate=185,
                        api_key="test-key",
                    )
            self.assertFalse(output_path.exists())

    def test_does_not_retry_a_connection_reset_with_an_unknown_provider_outcome(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "voice.mp3"
            with patch(
                "video_factory.voiceover.urlopen",
                side_effect=ConnectionResetError(104, "Connection reset by peer"),
            ) as request:
                with self.assertRaisesRegex(RuntimeError, "automatic retry is disabled"):
                    synthesize_minimax_audio(
                        text="连接中断后不能猜测服务商是否已经完成合成。",
                        output_path=output_path,
                        voice="female-chengshu",
                        rate=185,
                        api_key="test-key",
                    )

            self.assertEqual(request.call_count, 1)
            self.assertFalse(output_path.exists())

    def test_persists_a_minimax_scene_before_the_request_and_materializes_the_raw_audio(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {"position": 1, "narration": "先核对事实。", "duration": 2},
                {"position": 2, "narration": "再给出结论。", "duration": 2},
            ]}), encoding="utf-8")
            output_dir = root / "nodes" / "voice" / "attempt-1"
            operation_id = "voice-operation-1"
            ledger_path = output_dir.parent / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            state_during_request = []

            def urlopen(_request, timeout):
                self.assertEqual(timeout, 90)
                persisted = json.loads(ledger_path.read_text(encoding="utf-8"))
                state_during_request.append([item["state"] for item in persisted["items"]])
                return _Response({
                    "data": {"audio": b"ID3-paid-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                try:
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=output_dir,
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )
                except TypeError as error:
                    self.fail(f"MiniMax paid operations are not wired into voice synthesis: {error}")

            persisted = json.loads(ledger_path.read_text(encoding="utf-8"))
            item = persisted["items"][0]
            raw_path = Path(item["localPath"])
            self.assertEqual(state_during_request, [
                ["unknown", "prepared"],
                ["materialized", "unknown"],
            ])
            self.assertTrue(all(
                candidate["stateHistory"] == ["prepared", "unknown", "materialized"]
                for candidate in persisted["items"]
            ))
            self.assertTrue(all(candidate["state"] == "materialized" for candidate in persisted["items"]))
            self.assertEqual(raw_path.read_bytes(), b"ID3-paid-audio")
            self.assertEqual(item["sha256"], hashlib.sha256(b"ID3-paid-audio").hexdigest())
            self.assertEqual(item["sizeBytes"], len(b"ID3-paid-audio"))
            self.assertTrue(persisted["completed"])
            self.assertEqual(persisted["actualCostCny"], 0.5)
            self.assertEqual(persisted["actualCostSource"], "configured_rate")
            self.assertEqual(persisted["providerId"], "minimax-tts-v1")
            self.assertEqual(persisted["modelId"], "speech-test")
            self.assertNotIn("test-key", ledger_path.read_text(encoding="utf-8"))

    def test_records_only_the_materialized_share_when_a_later_minimax_scene_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [
                {"position": 1, "narration": "第一段生成成功。", "duration": 2},
                {"position": 2, "narration": "第二段被服务端拒绝。", "duration": 2},
            ]}), encoding="utf-8")
            operation_id = "voice-operation-partial-cost"
            responses = [
                _Response({
                    "data": {"audio": b"ID3-paid-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                }),
                _Response({
                    "data": {},
                    "base_resp": {"status_code": 1004, "status_msg": "invalid request"},
                }),
            ]

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=responses
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "MiniMax speech synthesis failed"):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            persisted = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertEqual([item["state"] for item in persisted["items"]], ["materialized", "terminal_failed"])
            self.assertFalse(persisted["completed"])
            self.assertEqual(persisted["actualCostCny"], 0.25)
            self.assertEqual(persisted["actualCostSource"], "configured_rate")

    def test_reuses_materialized_minimax_audio_after_normalization_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "原始音频只允许付费生成一次。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-resume"
            request_count = 0
            fail_normalization = True

            def urlopen(_request, timeout):
                nonlocal request_count
                self.assertEqual(timeout, 90)
                request_count += 1
                return _Response({
                    "data": {"audio": b"ID3-reusable-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            def ffmpeg(command, **_kwargs):
                if fail_normalization:
                    raise subprocess.CalledProcessError(1, command, stderr="normalization failed")
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaises(subprocess.CalledProcessError):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

                fail_normalization = False
                plan_path = synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=root / "nodes" / "voice" / "attempt-2",
                    provider="minimax",
                    operation_id=operation_id,
                    provider_id="minimax-tts-v1",
                    model_id="speech-test",
                    estimated_cost_cny=0.5,
                )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(request_count, 1)
            self.assertIn("attempt-1", item["localPath"])
            self.assertEqual(item["stateHistory"], ["prepared", "unknown", "materialized"])
            self.assertTrue(plan_path.is_file())

    def test_reuses_materialized_minimax_audio_after_an_explicit_timeline_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first_script_path = root / "script-8.0.json"
            second_script_path = root / "script-8.4.json"
            scene = {"position": 1, "narration": "自然旁白只生成一次。"}
            first_script_path.write_text(json.dumps({"scenes": [{**scene, "duration": 8}]}), encoding="utf-8")
            second_script_path.write_text(json.dumps({"scenes": [{**scene, "duration": 8.4}]}), encoding="utf-8")
            request_count = 0

            def urlopen(_request, timeout):
                nonlocal request_count
                self.assertEqual(timeout, 90)
                request_count += 1
                return _Response({
                    "data": {"audio": b"ID3-replanned-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=8.2), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaises(VoiceDoesNotFitError):
                    synthesize_voiceover_plan(
                        script_path=first_script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id="voice-before-replan",
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

                plan_path = synthesize_voiceover_plan(
                    script_path=second_script_path,
                    output_dir=root / "nodes" / "voice" / "attempt-2",
                    provider="minimax",
                    operation_id="voice-after-replan",
                    provider_id="minimax-tts-v1",
                    model_id="speech-test",
                    estimated_cost_cny=0.5,
                )

            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            second_ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(b"voice-after-replan").hexdigest() + ".json"
            )
            second_item = json.loads(second_ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(request_count, 1)
            self.assertEqual(plan["scenes"][0]["tempo"], 1.0)
            self.assertEqual(plan["scenes"][0]["duration"], 8.4)
            self.assertIn("attempt-1", second_item["localPath"])
            self.assertEqual(second_item["state"], "materialized")
            self.assertEqual(second_item["stateHistory"], ["prepared", "reused_materialized"])
            self.assertEqual(second_item["reusedFromOperationId"], "voice-before-replan")

    def test_refuses_to_repeat_a_minimax_request_with_an_unknown_outcome(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "超时并不等于没有扣费。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-unknown"
            request_count = 0

            def urlopen(_request, timeout):
                nonlocal request_count
                self.assertEqual(timeout, 90)
                request_count += 1
                raise TimeoutError("connection closed after upload")

            def run(attempt: int):
                return synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=root / "nodes" / "voice" / f"attempt-{attempt}",
                    provider="minimax",
                    operation_id=operation_id,
                    provider_id="minimax-tts-v1",
                    model_id="speech-test",
                    estimated_cost_cny=0.5,
                )

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "request failed"):
                    run(1)
                with self.assertRaisesRegex(RuntimeError, "manual reconciliation"):
                    run(2)

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(request_count, 1)
            self.assertEqual(item["state"], "unknown")
            self.assertEqual(item["stateHistory"], ["prepared", "unknown"])

    def test_records_an_explicit_minimax_rejection_as_terminal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "明确拒绝可以和未知结果区分。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-terminal"

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", return_value=_Response({
                    "data": {},
                    "base_resp": {"status_code": 1004, "status_msg": "invalid request"},
                })
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "MiniMax speech synthesis failed"):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(item["state"], "terminal_failed")
            self.assertEqual(item["stateHistory"], ["prepared", "unknown", "terminal_failed"])
            self.assertIn("invalid request", item["error"])

    def test_missing_minimax_credentials_leave_the_paid_item_prepared(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "配置错误发生在任何付费请求之前。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-preflight"

            with patch("video_factory.voiceover.require_ffmpeg"), patch.dict("os.environ", {}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "requires MINIMAX_API_KEY"):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(item["state"], "prepared")
            self.assertEqual(item["stateHistory"], ["prepared"])

    def test_invalid_minimax_endpoint_leaves_the_paid_item_prepared(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "请求对象也必须在未知状态之前构造完成。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-invalid-endpoint"

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen"
            ) as urlopen, patch.dict("os.environ", {
                "MINIMAX_API_KEY": "test-key",
                "MINIMAX_TTS_BASE_URL": "not-a-valid-url",
            }, clear=True):
                with self.assertRaises(ValueError):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            urlopen.assert_not_called()
            self.assertEqual(item["state"], "prepared")
            self.assertEqual(item["stateHistory"], ["prepared"])

    def test_durably_replaces_raw_audio_before_marking_the_item_materialized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "原始音频必须先于账本持久化。",
                "duration": 2,
            }]}), encoding="utf-8")
            output_dir = root / "nodes" / "voice" / "attempt-1"
            operation_id = "voice-operation-durable-raw"
            ledger_path = output_dir.parent / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            raw_path = output_dir / "scene_01_raw.mp3"
            replacements = []
            real_replace = os.replace

            def replace(source, destination):
                replacements.append(Path(destination))
                return real_replace(source, destination)

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", return_value=_Response({
                    "data": {"audio": b"ID3-durable-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch("video_factory.voiceover.os.replace", side_effect=replace), patch.dict(
                "os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False
            ):
                synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=output_dir,
                    provider="minimax",
                    operation_id=operation_id,
                    provider_id="minimax-tts-v1",
                    model_id="speech-test",
                    estimated_cost_cny=0.5,
                )

            self.assertIn(raw_path, replacements)
            self.assertLess(replacements.index(raw_path), len(replacements) - 1)
            self.assertEqual(replacements[-1], ledger_path)

    def test_records_an_http_client_rejection_as_terminal_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "HTTP 明确拒绝不是未知结果。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-http-rejection"
            rejection = HTTPError(
                "https://api.example/v1/t2a_v2",
                400,
                "Bad Request",
                {},
                io.BytesIO(json.dumps({"base_resp": {
                    "status_code": 1004,
                    "status_msg": "invalid voice",
                }}).encode("utf-8")),
            )

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=rejection
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "HTTP 400.*invalid voice"):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(item["state"], "terminal_failed")
            self.assertEqual(item["stateHistory"], ["prepared", "unknown", "terminal_failed"])

    def test_keeps_a_malformed_success_response_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "服务端声称成功但音频损坏时不能假定未扣费。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-malformed-success"

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", return_value=_Response({
                    "data": {"audio": "not-hex"},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "invalid hex audio"):
                    synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / "attempt-1",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )

            ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
            )
            item = json.loads(ledger_path.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(item["state"], "unknown")
            self.assertEqual(item["stateHistory"], ["prepared", "unknown"])

    def test_concurrent_workers_submit_the_same_paid_scene_only_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "同一个付费任务不能并发提交两次。",
                "duration": 2,
            }]}), encoding="utf-8")
            operation_id = "voice-operation-concurrent"
            start = threading.Barrier(2)
            first_request_entered = threading.Event()
            release_first_request = threading.Event()
            one_worker_finished = threading.Event()
            request_lock = threading.Lock()
            request_count = 0

            def urlopen(_request, timeout):
                nonlocal request_count
                self.assertEqual(timeout, 90)
                with request_lock:
                    request_count += 1
                    call_number = request_count
                if call_number == 1:
                    first_request_entered.set()
                    release_first_request.wait(2)
                return _Response({
                    "data": {"audio": b"ID3-concurrent-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            def run(attempt):
                start.wait()
                try:
                    path = synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / f"attempt-{attempt}",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )
                    return "succeeded", str(path)
                except RuntimeError as error:
                    return "failed", str(error)
                finally:
                    one_worker_finished.set()

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False), ThreadPoolExecutor(
                max_workers=2
            ) as executor:
                futures = [executor.submit(run, attempt) for attempt in (1, 2)]
                self.assertTrue(first_request_entered.wait(2))
                self.assertTrue(one_worker_finished.wait(2))
                release_first_request.set()
                results = [future.result(timeout=2) for future in futures]

            self.assertEqual(request_count, 1)
            self.assertEqual([status for status, _ in results].count("succeeded"), 1)
            self.assertTrue(any("manual reconciliation" in detail for status, detail in results if status == "failed"))

    def test_concurrent_operations_reuse_one_paid_voice_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script_path = root / "script.json"
            script_path.write_text(json.dumps({"scenes": [{
                "position": 1,
                "narration": "不同操作编号的相同配音输入也只能付费生成一次。",
                "duration": 2,
            }]}), encoding="utf-8")
            first_operation_id = "voice-operation-concurrent-a"
            second_operation_id = "voice-operation-concurrent-b"
            first_prepared = threading.Event()
            release_first_operation = threading.Event()
            request_lock = threading.Lock()
            request_count = 0
            original_prepare = voiceover_module._prepare_minimax_operation

            def coordinated_prepare(*args, **kwargs):
                operation = original_prepare(*args, **kwargs)
                if kwargs["operation_id"] == first_operation_id:
                    first_prepared.set()
                    release_first_operation.wait(2)
                return operation

            def urlopen(_request, timeout):
                nonlocal request_count
                self.assertEqual(timeout, 90)
                with request_lock:
                    request_count += 1
                return _Response({
                    "data": {"audio": b"ID3-shared-operation-audio".hex(), "status": 2},
                    "base_resp": {"status_code": 0, "status_msg": "success"},
                })

            def ffmpeg(command, **_kwargs):
                Path(command[-1]).write_bytes(b"normalized-audio")
                return subprocess.CompletedProcess(command, 0, "", "")

            def run(operation_id):
                try:
                    plan_path = synthesize_voiceover_plan(
                        script_path=script_path,
                        output_dir=root / "nodes" / "voice" / f"attempt-{operation_id[-1]}",
                        provider="minimax",
                        operation_id=operation_id,
                        provider_id="minimax-tts-v1",
                        model_id="speech-test",
                        estimated_cost_cny=0.5,
                    )
                    return operation_id, "succeeded", str(plan_path)
                except RuntimeError as error:
                    return operation_id, "failed", str(error)

            with patch("video_factory.voiceover.require_ffmpeg"), patch(
                "video_factory.voiceover.urlopen", side_effect=urlopen
            ), patch("video_factory.voiceover.probe_audio_duration", return_value=1.0), patch(
                "video_factory.voiceover.subprocess.run", side_effect=ffmpeg
            ), patch("video_factory.voiceover._prepare_minimax_operation", side_effect=coordinated_prepare), patch.dict(
                "os.environ", {"MINIMAX_API_KEY": "test-key"}, clear=False
            ), ThreadPoolExecutor(max_workers=2) as executor:
                first_future = executor.submit(run, first_operation_id)
                self.assertTrue(first_prepared.wait(2))
                first_ledger_path = root / "nodes" / "voice" / ".voice-operations" / (
                    hashlib.sha256(first_operation_id.encode("utf-8")).hexdigest() + ".json"
                )
                first_ledger = json.loads(first_ledger_path.read_text(encoding="utf-8"))
                self.assertEqual(first_ledger["items"][0]["state"], "prepared")

                second_result = executor.submit(run, second_operation_id).result(timeout=2)
                calls_before_first_continues = request_count
                release_first_operation.set()
                first_result = first_future.result(timeout=2)

                self.assertEqual(second_result[1], "failed")
                self.assertIn("not reached a reusable terminal state", second_result[2])
                self.assertEqual(calls_before_first_continues, 0)
                self.assertEqual(first_result[1], "succeeded")
                self.assertEqual(request_count, 1)
                recovery = synthesize_voiceover_plan(
                    script_path=script_path,
                    output_dir=root / "nodes" / "voice" / "attempt-recovery",
                    provider="minimax",
                    operation_id=second_operation_id,
                    provider_id="minimax-tts-v1",
                    model_id="speech-test",
                    estimated_cost_cny=0.5,
                )

            ledgers = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in (root / "nodes" / "voice" / ".voice-operations").glob("*.json")
            ]
            recovered_ledger = next(ledger for ledger in ledgers if ledger["operationId"] == second_operation_id)
            self.assertTrue(recovery.is_file())
            self.assertTrue(all(ledger["items"][0]["state"] == "materialized" for ledger in ledgers))
            self.assertEqual(recovered_ledger["items"][0]["reusedFromOperationId"], first_operation_id)


if __name__ == "__main__":
    unittest.main()
